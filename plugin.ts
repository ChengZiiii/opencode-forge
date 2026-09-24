import type { Plugin, ToolDefinition } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join, relative } from "node:path"
import {
  PlanError,
  closeCheckFailures,
  isTerminal,
  localDate,
  parsePlan,
  parsePlanLoose,
  planFileName,
  progressOf,
  rankActivePlans,
  renderPlan,
  slugify,
  tickTask,
  transitionStatus,
  type CloseCheck,
  type PlanDoc,
} from "./src/plan-file.ts"

// Resolve the skill dir (the skills.paths entry pointing at SKILL.md) relative
// to the bundle, same triple-form fallback as opencode-vision-bridge: run from
// source (plugin.ts), from dist/index.js (package root one level up), or a
// lone dist/index.js single-file install (falls back harmlessly; the README
// documents the manual SKILL.md copy for that mode).
const bundleDir = dirname(fileURLToPath(import.meta.url))
const candidateDirs = [bundleDir, join(bundleDir, "..")]
const dataDir = candidateDirs.find((d) => existsSync(join(d, "SKILL.md"))) ?? bundleDir

const FORGE_AGENT = "forge"

const FORGE_PROMPT = `You are forge — the single general-purpose coding agent. You handle every task directly: exploration, planning, implementation, and verification. There is no agent switching; phases change through commands (/plan) and tools.

Plan discipline (the tooling enforces the hard parts; you supply the judgment):
- When the user invokes /plan with a goal, or asks to plan first, load the forge-plan skill and follow it: read-only reconnaissance, clarifying questions when the goal is ambiguous, then plan_write. It creates .opencode/plan/<date>-<slug>.md with status draft.
- While the session's plan is in draft, every write tool is denied at the permission layer. Do not attempt write/edit/bash/task during planning; do not ask the user to bypass it. The only exits are plan_approve and /plan discard.
- After plan_write, present the goal, chosen approach, and numbered task list briefly, then call plan_approve. The user approves it in a confirmation dialog — that dialog is the approval gate.
- After approval, execute tasks one by one and call plan_tick with the task number immediately after each completion. Never batch ticks at the end; never tick before the work is actually done.
- When all tasks are ticked, self-check every acceptance criterion with concrete evidence, then call plan_close with a per-criterion pass/evidence array. The user confirms closure in a dialog.
- If the system prompt carries a [forge:plan-notice] line and the user has not mentioned the plan, relay its path and progress in one short line at the start of your reply.
- Work that is expected to span sessions, touch many files over days, or need multi-round requirement review belongs to a spec workflow (e.g. OpenSpec), not a plan. Say so once and let the user choose; if they still want a plan, plan it.

Outside planning you are a normal full-capability coding agent.`

// The single /plan command routes on its argument: empty = list, resume =
// continue latest non-terminal plan, discard = abandon, anything else = start
// planning with that text as the goal. The `!` backtick block injects live
// shell output (opencode command template syntax); $ARGUMENTS is the argument
// string opencode substitutes.
const PLAN_COMMAND_TEMPLATE = [
  '(forge plan harness routing. Argument: "$ARGUMENTS")',
  "",
  "Current .opencode/plan/ directory:",
  "!`ls -1 .opencode/plan 2>/dev/null || echo '(empty)'`",
  "",
  "Route on the argument above (decide silently; do not recite this routing text to the user):",
  '- Argument empty: for every non-terminal plan (status draft or approved) in the directory above, read its frontmatter and task checkboxes, then report to the user: path, status, progress (x/y ticked). Ask whether to resume one or start something new.',
  '- Argument "resume": pick the most recently updated non-terminal plan, summarize its remaining unticked tasks to the user in one short list, then continue executing it — tick each task the moment it is done (plan_tick). If none exists, say so.',
  '- Argument "discard": call the plan_discard tool, then tell the user the plan was abandoned and writes are restored.',
  "- Any other argument: treat it as the task goal. Load the forge-plan skill (skill tool), then follow its planning discipline for this goal.",
  "",
].join("\n")

type SessionState = {
  worktree: string
  planPath?: string
}

// sessionID -> state. Seeded by the session.created event and refined by
// every tool call (worktree from ToolContext). In-memory only: a process
// restart forgets bindings, which soft-disables the draft write-ban by
// design (specs/plan-harness: "进程重启后软降级"); /plan resume re-binds
// implicitly on the next plan_* tool call via the directory fallback.
const sessions = new Map<string, SessionState>()

// Captured in the config hook; flips the tool getter and skips every config
// injection when the user sets agent["forge"].disable = true (one-knob
// return-to-native, forge-agent spec).
let forgeDisabled = false

const WRITE_TOOLS = new Set(["write", "edit", "bash", "task", "apply", "applypatch", "patch", "multiedit"])

function isWriteTool(name: string): boolean {
  const n = name.toLowerCase()
  return WRITE_TOOLS.has(n) || n.includes("patch")
}

function nowIso(): string {
  return new Date().toISOString()
}

function planDirOf(worktree: string): string {
  return join(worktree, ".opencode", "plan")
}

function readPlanDir(worktree: string): Array<{ name: string; text: string }> {
  const dir = planDirOf(worktree)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((name) => ({ name, text: readFileSync(join(dir, name), "utf8") }))
}

function ensureSession(sessionID: string, worktree: string): SessionState {
  const existing = sessions.get(sessionID)
  if (existing) {
    existing.worktree = worktree
    return existing
  }
  const state: SessionState = { worktree }
  sessions.set(sessionID, state)
  return state
}

type ActivePlan = { path: string; doc: PlanDoc }

// Session binding first; falls back to the newest non-terminal plan in the
// worktree's .opencode/plan/ (crash recovery — effectively re-binds after a
// restart, which is also how /plan resume works without its own tool).
function resolveActivePlan(state: SessionState): ActivePlan | null {
  if (state.planPath && existsSync(state.planPath)) {
    const doc = parsePlanLoose(readFileSync(state.planPath, "utf8"))
    if (doc && !isTerminal(doc.status)) return { path: state.planPath, doc }
    state.planPath = undefined
  }
  const ranked = rankActivePlans(readPlanDir(state.worktree))
  if (ranked.length === 0) return null
  const path = join(planDirOf(state.worktree), ranked[0].name)
  state.planPath = path
  return { path, doc: ranked[0].doc }
}

function relFrom(worktree: string, path: string): string {
  const rel = relative(worktree, path)
  return rel && !rel.startsWith("..") ? rel.replaceAll("\\", "/") : path
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const planWriteTool = tool({
  description:
    "Create or revise the session's plan (structured planning document, written to .opencode/plan/<date>-<slug>.md, status draft). The only sanctioned write while planning. Takes structured fields; the tool renders and validates the fixed sections — you cannot produce a malformed plan file.",
  args: {
    goal: tool.schema.string().describe("One-line task goal (used for the filename slug and the 目标 section)"),
    context: tool.schema.string().describe("上下文发现: what the reconnaissance actually found, with file:line evidence references"),
    approach: tool.schema.string().describe("方案与备选: chosen approach AND rejected alternatives with reasons"),
    tasks: tool.schema.array(tool.schema.string()).describe("Ordered task list; the tool numbers them 1..N as checkboxes"),
    risks: tool.schema.string().describe("风险: known risks and mitigations"),
    acceptance: tool.schema.array(tool.schema.string()).describe("验收标准: verifiable acceptance criteria, checked one by one at plan_close"),
    nonGoals: tool.schema.array(tool.schema.string()).optional().describe("非目标: explicit out-of-scope items"),
  },
  execute: async (args, context) => {
    const state = ensureSession(context.sessionID, context.worktree)
    const active = resolveActivePlan(state)
    const now = nowIso()
    let path: string
    let created: string | undefined
    let mode: "created" | "revised"
    if (active && active.doc.status === "draft") {
      path = active.path
      created = active.doc.created || undefined
      mode = "revised"
    } else if (active) {
      throw new PlanError(
        `已有 ${active.doc.status} 状态的 plan 在执行中（${relFrom(state.worktree, active.path)}）。请先完成并 plan_close，或 /plan discard 放弃后再重新规划。`,
      )
    } else {
      const dir = planDirOf(context.worktree)
      mkdirSync(dir, { recursive: true })
      path = join(dir, planFileName(localDate(), slugify(args.goal), readdirSync(dir).filter((f) => f.endsWith(".md"))))
      mode = "created"
    }
    const text = renderPlan(args, now, created)
    writeFileSync(path, text)
    state.planPath = path
    const doc = parsePlan(text)
    context.metadata({ title: `${mode === "created" ? "Create" : "Revise"} plan: ${doc.goal}` })
    return {
      title: `plan ${mode}: ${doc.goal}`,
      output: [
        `plan 已${mode === "created" ? "创建" : "修订"}：${relFrom(state.worktree, path)}`,
        `状态：draft（${doc.tasks.length} 项任务，${doc.acceptance.length} 条验收标准）。`,
        "下一步：向用户简要呈报目标、选定方案与任务清单，然后调用 plan_approve 请求批准（将弹出用户确认框）。批准前所有写操作处于禁用状态。",
      ].join("\n"),
    }
  },
})

const planTickTool = tool({
  description:
    "Mark plan task number n as done: sets its checkbox to [x] and stamps a completion timestamp. Call it IMMEDIATELY after finishing each numbered task — never batch ticks, never tick before the work is done. Only valid while the plan is approved.",
  args: {
    n: tool.schema.number().int().positive().describe("Task number exactly as it appears in the plan's 任务清单"),
  },
  execute: async (args, context) => {
    const state = sessions.get(context.sessionID)
    if (!state) throw new PlanError("会话尚未绑定 plan。请用户执行 /plan resume 后重试。")
    const active = resolveActivePlan(state)
    if (!active) throw new PlanError("工作区没有可用的 plan（.opencode/plan/ 无非终态 plan）。")
    if (active.doc.status !== "approved") {
      throw new PlanError(`plan 当前状态为 ${active.doc.status}，只有 approved 状态的 plan 才能打勾。先经 plan_approve 批准。`)
    }
    const next = tickTask(readFileSync(active.path, "utf8"), args.n, nowIso())
    writeFileSync(active.path, next)
    const doc = parsePlan(next)
    const p = progressOf(doc)
    context.metadata({ title: `Tick task ${args.n} (${p.done}/${p.total})` })
    return {
      title: `task ${args.n} done (${p.done}/${p.total})`,
      output:
        p.done === p.total
          ? `任务 ${args.n} 已完成（${p.done}/${p.total}，全部完成）。请逐条对照验收标准自检并给出证据，然后调用 plan_close（将弹出用户确认框）。`
          : `任务 ${args.n} 已完成并打勾（${p.done}/${p.total}）。继续下一项任务。`,
    }
  },
})

const planApproveTool = tool({
  description:
    "Ask the user to approve the session's draft plan (draft -> approved). The permission layer pins this call to a confirmation dialog — the user's Allow IS the approval. After approval the draft-phase write ban is lifted. Optionally pass a one-line summary of what changed since the last revision.",
  args: {
    summary: tool.schema.string().optional().describe("One-line summary presented alongside the approval request"),
  },
  execute: async (_args, context) => {
    const state = ensureSession(context.sessionID, context.worktree)
    const active = resolveActivePlan(state)
    if (!active) throw new PlanError("没有待批准的 plan。先调用 plan_write 创建。")
    if (active.doc.status !== "draft") {
      throw new PlanError(`plan 当前状态为 ${active.doc.status}，只有 draft 状态可以批准。`)
    }
    writeFileSync(active.path, transitionStatus(readFileSync(active.path, "utf8"), "approved", nowIso()))
    context.metadata({ title: `Plan approved: ${active.doc.goal}` })
    return {
      title: "plan approved",
      output: `plan 已获用户批准（approved）：${relFrom(state.worktree, active.path)}。草稿期写禁已解除。逐任务执行，每完成一项立即 plan_tick；全部完成后自检并 plan_close。`,
    }
  },
})

const planCloseTool = tool({
  description:
    "Close the session's plan (approved -> done) after self-checking EVERY acceptance criterion. Requires: all tasks ticked, and one check per acceptance criterion with pass and concrete evidence. The permission layer pins this call to a confirmation dialog — the user confirms closure.",
  args: {
    checks: tool.schema
      .array(
        tool.schema.object({
          criterion: tool.schema.string().describe("The acceptance criterion text, copied verbatim from the plan"),
          pass: tool.schema.boolean().describe("Whether the criterion is met"),
          evidence: tool.schema.string().describe("Concrete evidence: file:line, command output, test result"),
        }),
      )
      .describe("One entry per acceptance criterion, in plan order"),
  },
  execute: async (args, context) => {
    const state = ensureSession(context.sessionID, context.worktree)
    const active = resolveActivePlan(state)
    if (!active) throw new PlanError("没有可关闭的 plan。")
    if (active.doc.status !== "approved") {
      throw new PlanError(`plan 当前状态为 ${active.doc.status}，只有 approved 状态（全部任务完成后）可以关闭。`)
    }
    const failures = closeCheckFailures(active.doc, args.checks as CloseCheck[])
    if (failures.length > 0) {
      throw new PlanError(`完成门校验未通过：\n- ${failures.join("\n- ")}\n请修正实现后重试，或先修订 plan。`)
    }
    writeFileSync(active.path, transitionStatus(readFileSync(active.path, "utf8"), "done", nowIso()))
    context.metadata({ title: `Plan done: ${active.doc.goal}` })
    return {
      title: "plan done",
      output: `plan 已完成并关闭（done）：${relFrom(state.worktree, active.path)}。自检 ${args.checks.length} 条全部通过。`,
    }
  },
})

const planDiscardTool = tool({
  description:
    "Abandon the session's active plan (draft/approved -> abandoned) and lift the draft write ban. Terminal: the file stays in .opencode/plan/ as history. Invoke via /plan discard or directly when the user cancels the task.",
  args: {
    reason: tool.schema.string().optional().describe("Short reason recorded in the reply"),
  },
  execute: async (_args, context) => {
    const state = sessions.get(context.sessionID)
    if (!state) throw new PlanError("会话尚未绑定 plan；无 plan 可放弃。")
    const active = resolveActivePlan(state)
    if (!active) throw new PlanError("工作区没有可放弃的 plan。")
    writeFileSync(active.path, transitionStatus(readFileSync(active.path, "utf8"), "abandoned", nowIso()))
    state.planPath = undefined
    context.metadata({ title: `Plan abandoned: ${active.doc.goal}` })
    return { title: "plan abandoned", output: `plan 已放弃（abandoned）：${relFrom(state.worktree, active.path)}。写操作已恢复。` }
  },
})

function forgeTools(): Record<string, ToolDefinition> {
  return {
    plan_write: planWriteTool,
    plan_tick: planTickTool,
    plan_approve: planApproveTool,
    plan_close: planCloseTool,
    plan_discard: planDiscardTool,
  }
}

// ---------------------------------------------------------------------------
// v1 server entry (the loader used by `opencode plugin` installs reads this)
// ---------------------------------------------------------------------------

export const server: Plugin = async () => {
  return {
    dispose: async () => {
      sessions.clear()
    },

    config: async (cfg) => {
      const agentSection = cfg.agent ?? (cfg.agent = {})
      const forgeUserCfg = agentSection[FORGE_AGENT] as { disable?: boolean } | undefined
      forgeDisabled = forgeUserCfg?.disable === true
      if (forgeDisabled) return

      // Hide the native build/plan agents for the lifetime of the plugin
      // (runtime injection only — nothing is written to the user's config
      // file, so uninstall self-heals). Other user fields on those entries
      // are preserved.
      for (const native of ["build", "plan"] as const) {
        agentSection[native] = { ...(agentSection[native] ?? {}), disable: true }
      }

      // Register forge without clobbering user-set fields (model, temperature,
      // permission overrides stay theirs; prompt/description/mode only when
      // absent).
      const existing = agentSection[FORGE_AGENT] as Record<string, unknown> | undefined
      agentSection[FORGE_AGENT] = {
        ...(existing ?? {}),
        description:
          (existing?.description as string | undefined) ??
          "forge — 单一通用编码主体：直接承接实现任务；规划经 /plan 进入 plan harness（.opencode/plan/ 落盘，批准/完成双确认门与打勾纪律由工具与权限层强制）。",
        mode: (existing?.mode as "primary" | "subagent" | "all" | undefined) ?? "primary",
        prompt: (existing?.prompt as string | undefined) ?? FORGE_PROMPT,
      }

      // Skill discovery, single channel: push the package data dir (contains
      // SKILL.md) onto config.skills.paths. No mirror copies, ever.
      const cfgAny = cfg as { skills?: { paths?: string[] } }
      cfgAny.skills ??= {}
      cfgAny.skills.paths ??= []
      if (!cfgAny.skills.paths.includes(dataDir)) {
        cfgAny.skills.paths.push(dataDir)
      }

      // /plan command — created only when the user has no command named
      // "plan" of their own.
      cfg.command ??= {}
      cfg.command["plan"] ??= {
        template: PLAN_COMMAND_TEMPLATE,
        description: "forge plan harness：无参列出进行中 plan；resume 恢复；discard 放弃；带目标进入规划纪律",
      }
    },

    // Registry getter keeps the disable knob honest: forge disabled -> no
    // harness tools at all.
    get tool(): Record<string, ToolDefinition> {
      return forgeDisabled ? {} : forgeTools()
    },

    // Draft write-ban + ask-pinned gates. Tool-name resolution follows the
    // cross-version priority chain (metadata.tool -> permission -> id ->
    // type); unknown sessions or fields resolve conservative (no ban) — the
    // skill's soft discipline covers the gap.
    "permission.ask": async (input, output) => {
      const meta = (input.metadata ?? {}) as Record<string, unknown>
      const permissionField = (input as unknown as { permission?: unknown }).permission
      const name =
        (typeof meta.tool === "string" ? meta.tool : undefined) ??
        (typeof permissionField === "string" ? permissionField : undefined) ??
        input.id ??
        input.type
      if (name === "plan_approve" || name === "plan_close") {
        // The gates: never auto-allowed, immune to allow config; an explicit
        // user deny stays denied.
        if (output.status !== "deny") output.status = "ask"
        return
      }
      if (name === "plan_write" || name === "plan_tick" || name === "plan_discard") {
        // Harness-internal tools (the sanctioned writes while planning):
        // upgrade ask -> allow, never overriding an explicit user deny.
        if (output.status === "ask") output.status = "allow"
        return
      }
      const state = sessions.get(input.sessionID)
      if (state && typeof name === "string" && isWriteTool(name)) {
        const active = resolveActivePlan(state)
        if (active && active.doc.status === "draft") {
          output.status = "deny"
        }
      }
    },

    // Seed the session map so the write-ban works from the first tool call.
    event: async ({ event }) => {
      if (event.type === "session.created") {
        const info = (event as unknown as {
          properties: { info: { id: string; directory?: string; worktree?: string } }
        }).properties.info
        const worktree = info.worktree ?? info.directory
        if (typeof worktree === "string" && worktree) {
          ensureSession(info.id, worktree)
        }
      }
    },

    // Session-start notice + standing reminder: injected into the system
    // prompt whenever the session has a non-terminal plan. The relay clause
    // makes the first reply surface it to the user (the "会话启动提示"
    // requirement — no native banner API exists for plugins).
    "experimental.chat.system.transform": async (input, output) => {
      if (!input.sessionID) return
      const state = sessions.get(input.sessionID)
      if (!state) return
      const active = resolveActivePlan(state)
      if (!active) return
      const p = progressOf(active.doc)
      const rel = relFrom(state.worktree, active.path)
      const rule =
        active.doc.status === "draft"
          ? "draft 期间写操作被工具层拒绝；呈报要点后调用 plan_approve 请求批准，或 /plan discard 放弃"
          : "完成一项任务立即 plan_tick；全部完成后逐条对照验收标准自检并调用 plan_close"
      output.system.push(
        `[forge:plan-notice] 当前会话绑定 plan：${rel}（status: ${active.doc.status}，${p.done}/${p.total} 已完成）。规则：${rule}。若用户尚未提及此 plan，请在回复开头用一句话向用户转达其路径与进度。`,
      )
    },
  }
}

// ---------------------------------------------------------------------------
// v2 setup (forward compatibility only — the npm/github installs above load
// the v1 entry; this keeps the package loadable the day a v2 host is the
// default). Tools and permission gates have no v2 domain at 1.18 and stay
// v1-only. Structurally typed + guarded so host-shape drift degrades to a
// no-op instead of throwing (same contract as opencode-vision-bridge).
// ---------------------------------------------------------------------------

type V2AgentDraft = {
  list(): Array<{ id: string }>
  get(id: string): unknown
  update(id: string, update: (agent: Record<string, unknown>) => void): void
  remove(id: string): void
}
type V2SkillDraft = {
  source(source: { type: "directory"; path: string }): void
  list(): unknown[]
}
type V2PluginContext = {
  agent?: {
    transform(cb: (draft: V2AgentDraft) => void | Promise<void>): Promise<unknown>
  }
  skill?: {
    transform(cb: (draft: V2SkillDraft) => void | Promise<void>): Promise<unknown>
  }
}

async function v2Setup(ctx: V2PluginContext): Promise<void> {
  if (typeof ctx.agent?.transform === "function") {
    await ctx.agent.transform(async (draft) => {
      if (typeof draft.get !== "function" || typeof draft.update !== "function") return
      if (draft.get(FORGE_AGENT) !== undefined) return
      draft.update(FORGE_AGENT, (agent) => {
        agent.description =
          "forge — 单一通用编码主体：直接承接实现任务；规划经 /plan 进入 plan harness（.opencode/plan/ 落盘，批准/完成双确认门与打勾纪律由工具与权限层强制）。"
        agent.system = FORGE_PROMPT
        agent.mode = "primary"
      })
    })
  }
  if (typeof ctx.skill?.transform === "function") {
    await ctx.skill.transform(async (draft) => {
      if (typeof draft.source !== "function") return
      draft.source({ type: "directory", path: dataDir })
    })
  }
}

export default { id: "forge", server, setup: v2Setup }
