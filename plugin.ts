import type { Plugin, ToolDefinition } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join, relative } from "node:path"
import { tmpdir } from "node:os"
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
- When the user invokes /plan with a goal, or asks to plan first, load the plan skill and follow it: read-only reconnaissance, clarifying questions when the goal is ambiguous, then plan_write. It creates .opencode/plan/<date>-<slug>.md with status draft.
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
  "- Any other argument: treat it as the task goal. Load the plan skill (skill tool), then follow its planning discipline for this goal.",
  "",
].join("\n")

// ---------------------------------------------------------------------------
// Worktree resolution
// ---------------------------------------------------------------------------
// opencode assigns sessions in non-git directories to its built-in "global"
// project, whose worktree is "/" — on Windows that resolves to the current
// drive root, and join("/", ".opencode", "plan") would silently write plans
// to C:\.opencode\plan\ (verified in the wild: a real user session landed
// there). The launch directory (PluginInput.directory / session directory)
// is always the real workspace, so whenever the reported worktree is a
// degenerate root (or empty) we fall back to it.
export function isRootish(p: string | undefined): boolean {
  if (!p) return true
  return p === "/" || p === "\\" || /^[A-Za-z]:[\\/]?$/.test(p)
}

export function effectiveWorktree(worktree: string | undefined, fallback: string | undefined): string {
  const wt = (worktree ?? "").trim()
  if (!isRootish(wt)) return wt
  return (fallback ?? "").trim()
}

type SessionState = {
  worktree: string
  planPath?: string
}

// sessionID -> state. Seeded by the session.created event and refined by
// every tool call (worktree from ToolContext). In-memory only: a process
// restart forgets bindings, which soft-disables the draft write-ban by
// design (specs/plan-harness: graceful degradation after process restart);
// /plan resume re-binds
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

// Where a plan_* tool call for this context should anchor: the session's real
// worktree, with the launch directory as the global-project ("/") fallback.
function worktreeFor(context: { sessionID: string; worktree: string }): string {
  return effectiveWorktree(context.worktree, hostWorktree) || context.worktree
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
    goal: tool.schema.string().describe("One-line task goal (used for the filename slug and the Goal section)"),
    context: tool.schema.string().describe("Context Findings: what the reconnaissance actually found, with file:line evidence references"),
    approach: tool.schema.string().describe("Approach and Alternatives: chosen approach AND rejected alternatives with reasons"),
    tasks: tool.schema.array(tool.schema.string()).describe("Ordered task list; the tool numbers them 1..N as checkboxes"),
    risks: tool.schema.string().describe("Risks: known risks and mitigations"),
    acceptance: tool.schema.array(tool.schema.string()).describe("Acceptance Criteria: verifiable criteria, checked one by one at plan_close"),
    nonGoals: tool.schema.array(tool.schema.string()).optional().describe("Non-Goals: explicit out-of-scope items"),
  },
  execute: async (args, context) => {
    const state = ensureSession(context.sessionID, worktreeFor(context))
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
        `A plan in ${active.doc.status} state is already active (${relFrom(state.worktree, active.path)}). Finish it with plan_close, or /plan discard it before planning something new.`,
      )
    } else {
      const dir = planDirOf(state.worktree)
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
        `Plan ${mode === "created" ? "created" : "revised"}: ${relFrom(state.worktree, path)}`,
        `Status: draft (${doc.tasks.length} tasks, ${doc.acceptance.length} acceptance criteria).`,
        "Next: briefly present the goal, chosen approach, and task list to the user, then call plan_approve to request approval (a user confirmation dialog appears). Until approval, all write operations are denied.",
      ].join("\n"),
    }
  },
})

const planTickTool = tool({
  description:
    "Mark plan task number n as done: sets its checkbox to [x] and stamps a completion timestamp. Call it IMMEDIATELY after finishing each numbered task — never batch ticks, never tick before the work is done. Only valid while the plan is approved.",
  args: {
    n: tool.schema.number().int().positive().describe("Task number exactly as it appears in the plan's Task List"),
  },
  execute: async (args, context) => {
    const state = ensureSession(context.sessionID, worktreeFor(context))
    const active = resolveActivePlan(state)
    if (!active) throw new PlanError("No usable plan in this workspace (.opencode/plan/ has no non-terminal plan).")
    if (active.doc.status !== "approved") {
      throw new PlanError(`Plan status is ${active.doc.status}; only an approved plan can be ticked. Get user approval via plan_approve first.`)
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
          ? `Task ${args.n} done (${p.done}/${p.total}, all complete). Self-check every acceptance criterion with concrete evidence, then call plan_close (a user confirmation dialog appears).`
          : `Task ${args.n} done and ticked (${p.done}/${p.total}). Continue with the next task.`,
    }
  },
})

// Gates are implemented with ToolContext.ask(), NOT the permission config:
// on opencode 1.18.32 plugin-registered tools bypass permission evaluation
// entirely (verified: config "ask" rules on plan_* never produce a request),
// while context.ask() creates a real user confirmation (TUI dialog; run mode
// auto-rejects; --auto approves). The user's answer IS the gate.
type AskFn = (input: {
  permission: string
  patterns: string[]
  always: string[]
  metadata: Record<string, unknown>
}) => Promise<void>

async function gate(ask: AskFn, permission: string, title: string): Promise<void> {
  await ask({ permission, patterns: ["*"], always: [], metadata: { title } })
}

const planApproveTool = tool({
  description:
    "Ask the user to approve the session's draft plan (draft -> approved). The permission layer pins this call to a confirmation dialog — the user's Allow IS the approval. After approval the draft-phase write ban is lifted. Optionally pass a one-line summary of what changed since the last revision.",
  args: {
    summary: tool.schema.string().optional().describe("One-line summary presented alongside the approval request"),
  },
  execute: async (_args, context) => {
    const state = ensureSession(context.sessionID, worktreeFor(context))
    const active = resolveActivePlan(state)
    if (!active) throw new PlanError("No plan awaiting approval. Create one with plan_write first.")
    if (active.doc.status !== "draft") {
      throw new PlanError(`Plan status is ${active.doc.status}; only a draft plan can be approved.`)
    }
    // The approval gate: user confirms in the dialog this creates. A rejected
    // or auto-rejected ask throws and the plan stays in draft.
    await gate(context.ask, "plan_approve", `Approve plan: ${active.doc.goal}`)
    writeFileSync(active.path, transitionStatus(readFileSync(active.path, "utf8"), "approved", nowIso()))
    context.metadata({ title: `Plan approved: ${active.doc.goal}` })
    return {
      title: "plan approved",
      output: `Plan approved by the user (approved): ${relFrom(state.worktree, active.path)}. The draft-phase write ban is lifted. Execute tasks one by one, calling plan_tick immediately after each; when all are done, self-check and plan_close.`,
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
    const state = ensureSession(context.sessionID, worktreeFor(context))
    const active = resolveActivePlan(state)
    if (!active) throw new PlanError("No plan to close.")
    if (active.doc.status !== "approved") {
      throw new PlanError(`Plan status is ${active.doc.status}; only an approved plan (all tasks complete) can be closed.`)
    }
    const failures = closeCheckFailures(active.doc, args.checks as CloseCheck[])
    if (failures.length > 0) {
      throw new PlanError(`Completion gate check failed:\n- ${failures.join("\n- ")}\nFix the implementation and retry, or revise the plan first.`)
    }
    // The completion gate: user confirms closure in the dialog this creates.
    await gate(context.ask, "plan_close", `Close plan: ${active.doc.goal}`)
    writeFileSync(active.path, transitionStatus(readFileSync(active.path, "utf8"), "done", nowIso()))
    context.metadata({ title: `Plan done: ${active.doc.goal}` })
    return {
      title: "plan done",
      output: `Plan completed and closed (done): ${relFrom(state.worktree, active.path)}. All ${args.checks.length} self-checks passed.`,
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
    const state = ensureSession(context.sessionID, worktreeFor(context))
    const active = resolveActivePlan(state)
    if (!active) throw new PlanError("No plan to abandon in this workspace.")
    writeFileSync(active.path, transitionStatus(readFileSync(active.path, "utf8"), "abandoned", nowIso()))
    state.planPath = undefined
    context.metadata({ title: `Plan abandoned: ${active.doc.goal}` })
    return { title: "plan abandoned", output: `Plan abandoned: ${relFrom(state.worktree, active.path)}. Write operations are restored.` }
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

// Launch-directory seed from PluginInput: continued sessions (-c / --session)
// do NOT re-fire session.created in a new process, so a fresh process would
// start with an empty session map and the draft write-ban would miss. The
// plugin's launch worktree (already global-project-corrected) covers the
// single-project case (opencode run / TUI); tool contexts re-bind the
// authoritative worktree on every plan_* call. Empty when the host provides
// neither field (harmless: belt only).
let hostWorktree = ""

// Bind a session for ban lookups: known state, or seeded from the launch
// worktree. Returns null only when nothing is known about the session.
function stateForBan(sessionID: string | undefined): SessionState | null {
  if (!sessionID) return null
  const existing = sessions.get(sessionID)
  if (existing) return existing
  if (!hostWorktree) return null
  return ensureSession(sessionID, hostWorktree)
}

// ---------------------------------------------------------------------------
// v1 server entry (the loader used by `opencode plugin` installs reads this)
// ---------------------------------------------------------------------------

export const server: Plugin = async (input) => {
  hostWorktree = effectiveWorktree(input.worktree, input.directory) || input.directory || ""
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
          "forge — the single general-purpose coding agent: takes implementation tasks directly; planning goes through /plan into the plan harness (plans land in .opencode/plan/, with approve/close confirmation gates and tick discipline enforced by tools and the permission layer).",
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
        description: "forge plan harness: no argument lists in-progress plans; resume continues the latest; discard abandons it; a goal enters planning discipline",
      }

      // Gate permission rules: plugin-registered tools bypass automatic
      // permission evaluation (verified 1.18.32), but the context.ask()
      // requests the gate tools create ARE resolved against these rules —
      // with no explicit rule a broad "*": allow default would resolve the
      // gate ask to allow. "ask" makes the gate a real user confirmation
      // (TUI dialog / run-mode reject / --auto approve). An explicit user
      // "deny" is respected. No other permission key is touched: the draft
      // write-ban lives in tool.execute.before (phase-aware, no global
      // tightening), so stock behavior outside planning is unchanged.
      const perm = (cfg as { permission?: Record<string, unknown> }).permission
      const permSection = perm ?? ((cfg as { permission?: Record<string, unknown> }).permission = {})
      for (const gateKey of ["plan_approve", "plan_close"]) {
        if (permSection[gateKey] !== "deny") permSection[gateKey] = "ask"
      }
    },

    // Registry getter keeps the disable knob honest: forge disabled -> no
    // harness tools at all.
    get tool(): Record<string, ToolDefinition> {
      return forgeDisabled ? {} : forgeTools()
    },

    // Draft write-ban, primary enforcement: tool.execute.before fires for
    // every tool call (run mode included — unlike permission.ask, which never
    // fires headless, verified 1.18.32). Throwing here aborts the call with
    // the guidance message. Phase-aware, so no global permission tightening
    // is needed and stock behavior is untouched outside the draft phase.
    "tool.execute.before": async (input) => {
      if (process.env.FORGE_PERM_PROBE) {
        try {
          appendFileSync(join(tmpdir(), "forge-perm-probe.log"), `${new Date().toISOString()} before tool=${JSON.stringify(input.tool)} session=${input.sessionID}\n`)
        } catch {}
      }
      if (typeof input.tool === "string" && isWriteTool(input.tool)) {
        const state = stateForBan(input.sessionID)
        const active = state ? resolveActivePlan(state) : null
        if (active && active.doc.status === "draft") {
          throw new Error(
            `[forge] A plan is in draft; write operations are denied (${input.tool}). Present the plan summary and call plan_approve for user approval, or /plan discard to abandon it.`,
          )
        }
      }
    },

    // permission.ask belt: on hosts/sessions where permission requests ARE
    // created for write tools (e.g. the user configured edit:"ask"), deny
    // them during draft. The permission.ask hook itself never fires in
    // `opencode run` mode (verified 1.18.32) — tool.execute.before above is
    // the primary enforcement. Tool-name resolution follows the cross-version
    // priority chain (metadata.tool -> permission -> id -> type).
    "permission.ask": async (input, output) => {
      const meta = (input.metadata ?? {}) as Record<string, unknown>
      const permissionField = (input as unknown as { permission?: unknown }).permission
      const name =
        (typeof meta.tool === "string" ? meta.tool : undefined) ??
        (typeof permissionField === "string" ? permissionField : undefined) ??
        input.id ??
        input.type
      if (process.env.FORGE_PERM_PROBE) {
        try {
          appendFileSync(
            join(tmpdir(), "forge-perm-probe.log"),
            `${new Date().toISOString()} ask name=${JSON.stringify(name)} in_status=${output.status} id=${JSON.stringify(input.id)} type=${JSON.stringify(input.type)} meta=${JSON.stringify(input.metadata)}\n`,
          )
        } catch {}
      }
      if (name === "plan_approve" || name === "plan_close") {
        // Belt for the gates: if a permission request ever surfaces for them
        // (host starts evaluating plugin tools), keep it a real ask unless
        // explicitly denied.
        if (output.status !== "deny") output.status = "ask"
        return
      }
      if (typeof name === "string" && isWriteTool(name)) {
        const state = stateForBan(input.sessionID)
        const active = state ? resolveActivePlan(state) : null
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
        const worktree = effectiveWorktree(info.worktree, info.directory)
        if (typeof worktree === "string" && worktree) {
          ensureSession(info.id, worktree)
        }
      }
    },

    // Session-start notice + standing reminder: injected into the system
    // prompt whenever the session has a non-terminal plan. The relay clause
    // makes the first reply surface it to the user (the session-start
    // notice requirement — no native banner API exists for plugins).
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
          ? "while in draft, write operations are denied at the tool layer; present the summary then call plan_approve for approval, or /plan discard to abandon"
          : "call plan_tick immediately after each completed task; when all are done, self-check every acceptance criterion and call plan_close"
      output.system.push(
        `[forge:plan-notice] This session is bound to a plan: ${rel} (status: ${active.doc.status}, ${p.done}/${p.total} tasks done). Rule: ${rule}. If the user has not mentioned this plan yet, relay its path and progress to them in one short line at the start of your reply.`,
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

export async function v2Setup(ctx: V2PluginContext): Promise<void> {
  if (typeof ctx.agent?.transform === "function") {
    await ctx.agent.transform(async (draft) => {
      if (typeof draft.get !== "function" || typeof draft.update !== "function") return
      if (draft.get(FORGE_AGENT) !== undefined) return
      draft.update(FORGE_AGENT, (agent) => {
        agent.description =
          "forge — the single general-purpose coding agent: takes implementation tasks directly; planning goes through /plan into the plan harness (plans land in .opencode/plan/, with approve/close confirmation gates and tick discipline enforced by tools and the permission layer)."
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
