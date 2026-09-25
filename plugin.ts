import type { Plugin, ToolDefinition } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { execFileSync } from "node:child_process"
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { isAbsolute, join, relative } from "node:path"
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
import {
  GoalError,
  NO_PROGRESS_LIMIT,
  TRANSPORT_FAILURE_LIMIT,
  appendCheckLog,
  appendLedger,
  atomicWrite,
  budgetState,
  bumpBudget,
  carryHistory,
  completeCheckFailures,
  goalFileName,
  incTurns,
  isGoalTerminal,
  localDateNow,
  parseGoal,
  parseGoalLoose,
  rankLiveGoals,
  rankQueuedGoals,
  renderGoal,
  slugifyGoal,
  transitionGoal,
  type CheckItem,
  type GoalDoc,
  type GoalInput,
  type StopReason,
} from "./src/goal-file.ts"
import { formatOutcomes, outcomesAllOk, runChecks } from "./src/run-check.ts"
import { killTree } from "./src/proc.ts"
import { createJobManager, type Job } from "./src/job-manager.ts"
import { HARD_MAX_WAIT_MS, POLL_WAIT_MAX_MS, jobsLogDir, pollJob, readJobLog, startJob } from "./src/job-runner.ts"
import {
  WATCHDOG_ENV_MARK,
  clampStallMs,
  createFileLedger,
  createWatchdog,
  parseMode,
  watchdogLogDir,
  type LedgerEntry,
  type Watchdog,
} from "./src/watchdog.ts"
import { createLocator, commandNeedle, markerValue, parseWindowsProcs } from "./src/proc-locate.ts"

const FORGE_AGENT = "forge"

const FORGE_PROMPT = `You are forge — the single general-purpose coding agent. You handle every task directly: exploration, planning, implementation, and verification. There is no agent switching.

Workflow modes are strictly user-initiated. Never enter plan or goal mode — and never call a plan_* or goal_* tool — unless the user ran /plan or /goal, unmistakably asked for that mode (e.g. "plan first", "set a goal"), or the session already carries a [forge:plan-notice] / [forge:goal-notice] for a mode they started. Ordinary task requests are normal work. Mode-specific rules arrive with those commands and notices; when a notice is present, follow it.`

// The single /plan command routes on its argument: empty = list, resume =
// continue latest non-terminal plan, discard = abandon, anything else = start
// planning with that text as the goal — the full plan discipline rides the
// entry turn itself (hermes-style: the command turn is the rulebook; the
// system prompt carries none of it). The `!` backtick block injects live
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
  "- Any other argument: treat it as the task goal — you are now in planning mode for this goal. Follow the plan discipline below end to end.",
  "",
  "## Plan discipline",
  "",
  "Plans are short-horizon, single-task-goal documents (.opencode/plan/<date>-<slug>.md). The harness enforces the hard parts (draft write-ban, approval/close dialogs); you supply the engineering judgment. Never edit or create plan files by hand — every change goes through the plan_* tools.",
  "",
  "1. Reconnaissance and alignment (read-only): explore with read/grep/glob only — all write tools, bash, and subagents are DENIED while a draft exists; do not attempt them, do not ask the user to bypass. Gather concrete evidence with file:line references (verified findings, not guesses). If the goal is ambiguous or leaves meaningful choices open (scope, approach, acceptance), settle them with the user FIRST — 1-3 focused questions — and only write the draft once the shape is agreed; never plan against assumptions the user could settle in one line.",
  "2. Draft (plan_write): call plan_write with structured fields; the tool renders and validates the fixed sections, so a malformed plan cannot exist. Quality bar: goal = one line, the outcome not the activity; context = verified findings with file:line evidence, including what you ruled out and why; approach = the chosen approach AND at least one rejected alternative with the reason (a plan with no considered alternative is a guess); tasks = 3-8 concrete, independently verifiable steps, each doable in one sitting ('improve the code' is invalid; 'extract the timeout constant into config.ts and default it to 3000' is valid); risks = what could break, blast radius, rollback path; acceptance = criteria verifiable by a command, a file, or an observable behavior (vague criteria will fail the close); nonGoals = explicit out-of-scope items. To revise after feedback, call plan_write again — while in draft it overwrites the same file.",
  "3. User review, then approval (plan_approve): after plan_write, present the plan in chat — goal, chosen approach with one line why, the numbered task list, the acceptance criteria — then STOP: end your turn and wait. The user owns the review, at their own pace: feedback → revise with plan_write, re-present, and wait again; rejection → /plan discard (or re-plan together); explicit go-ahead (e.g. \"execute\", \"批准\", \"looks good\") → call plan_approve — its confirmation dialog is the final hard gate, and the user's Allow starts execution. Never call plan_approve in the same turn that presents a draft, and never implement before approval succeeds.",
  "4. Execution (tick as you go): work tasks in order; call plan_tick with the task number immediately after EACH task's work is actually done — never batch ticks, never tick ahead of reality (tick timestamps are an audit trail). If the plan turns out wrong mid-execution, do not silently improvise: tell the user what changed and either finish the affected task or ask about revising (/plan with the same goal re-enters planning).",
  "5. Completion (plan_close): when all tasks are ticked, self-check EVERY acceptance criterion with concrete evidence (file:line, command output, test result), then call plan_close with one check per criterion, pass/fail honest — a failing check refuses the close, and that is the design working, not an inconvenience. The user confirms closure in a dialog.",
  "",
  "Boundaries: /plan discard abandons the plan (terminal, file kept as history, writes restored); /plan resume continues an unfinished plan from its remaining tasks. Work expected to span multiple sessions or days of multi-file change is spec work (e.g. OpenSpec), not plan work — say so once and let the user choose.",
  "",
].join("\n")

// /goal routes the same way: empty = status listing, pause/resume/next/discard
// subcommands, "add ..." queues an inert goal, anything else is a new goal
// statement whose contract markers (--check/--contains/--success/...) become
// structured goal_write fields.
const GOAL_COMMAND_TEMPLATE = [
  '(forge goal harness routing. Argument: "$ARGUMENTS")',
  "",
  "Current .opencode/goal/ directory:",
  "!`ls -1 .opencode/goal 2>/dev/null || echo '(empty)'`",
  "",
  "Route on the argument above (decide silently; do not recite this routing text to the user):",
  "- Argument empty: for every non-terminal goal in the directory above, read its frontmatter and report to the user: path, status (queued/active/paused + stop_reason), revision, turns_used/max_turns budget. Mention queued goals and the /goal next promotion option. Ask whether to resume/promote one or arm something new.",
  '- Argument "pause": call the goal_pause tool (with the blocker text as `blocker` when there is one), then tell the user the loop is stopped and how to resume.',
  '- Argument "resume": call the goal_resume tool for the session\'s paused goal (optionally with addTurns if the user asked for more budget). If no live goal exists but queued goals do, promote the oldest via goal_resume instead. The user confirms in a dialog.',
  '- Argument "next": promote the oldest queued goal via the goal_resume tool (no live goal must remain). The user confirms in a dialog.',
  '- Argument "discard" (also "stop"/"cancel"/"off"): call the goal_discard tool. The user confirms in a dialog.',
  '- Argument starting with "add " (or the user clearly wants to queue without arming): create a NEW contract from the rest of the argument and call goal_write with arm=false — never revise an existing goal for an add, never omit arm. It becomes a queued, inert goal (no dialog).',
  "- Any other argument: treat it as a goal statement. Extract contract markers into the structured goal_write fields: --check \"cmd\" becomes a shell verification item, --contains \"file::text\" a file-contract item, --success \"...\" an extra success criterion, --constraint \"...\" goes into constraints, --non-goal \"...\" into nonGoals, --max-turns N and --max-minutes N set budgets. Draft a complete contract (goal, criteria, checks, constraints, non-goals), SHOW the verification items verbatim to the user, then call goal_write with arm=true — a confirmation dialog arms the autonomous loop. If this session already has a live goal, say so and offer revise/queue/discard instead.",
  "",
  "Goal files are host-managed: never edit or create anything under .opencode/goal/ by hand — contract changes go through goal_write (each revision bump invalidates evidence collected under earlier revisions), state changes through the goal_* tools. Likewise never enter the goal loop or call any goal_* tool unless the user ran /goal or explicitly asked for a goal loop.",
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
  sessionID: string
  worktree: string
  planPath?: string
  goalPath?: string
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

// ---------------------------------------------------------------------------
// Job supervisor (forge_shell / forge_jobs): non-blocking shell execution
// with a four-condition completion race, session-owned jobs, and a
// completion wake. See openspec job-supervisor spec + design.
// ---------------------------------------------------------------------------

// Plugin options (second server argument), captured at load.
let jobsMode: "auto" | "forge" | "native" = "auto"
let jobsKeepBuiltinShell = false

// Capability probe: set when the native shell tool presents a
// run_in_background parameter (tool.definition hook) or an experimental
// background flag shows up in the host config.
let nativeBackgroundSeen = false

// Stage matrix (design D10): 0 = no native capability (full forge path,
// builtin shell hidden on the plugin-created forge agent); 1 = native
// run_in_background detected (stop hiding the builtin shell; forge_shell
// remains the additive layer); 2 = manual-only confirmation that native
// backgrounding is complete (forge_shell retires). Stage 2 is NEVER
// auto-detected — "complete" is a semantic judgment only the user can make.
function jobStage(): 0 | 1 | 2 {
  if (jobsMode === "native") return 2
  if (jobsMode === "forge") return 0
  return nativeBackgroundSeen ? 1 : 0
}

const jobLogDir = jobsLogDir()
const jobLedgerPath = join(jobLogDir, "ledger.jsonl")

// Diagnostics ledger sink: bounded in memory by the manager; on disk a
// JSONL file that resets once it passes 1MB.
function jobLedgerSink(entry: Record<string, unknown>): void {
  try {
    mkdirSync(jobLogDir, { recursive: true })
    if (existsSync(jobLedgerPath) && statSync(jobLedgerPath).size > 1_000_000) writeFileSync(jobLedgerPath, "")
    appendFileSync(jobLedgerPath, `${JSON.stringify(entry)}\n`)
  } catch {
    // A broken ledger write must never take the supervisor down.
  }
}

const jobManager = createJobManager({ sink: jobLedgerSink })

// Message-send client for completion wakes (promptAsync: fire-and-forget,
// does not block the plugin fiber) and session lookups for handoff roots.
type JobClient = {
  session: {
    promptAsync?: (opts: unknown) => Promise<unknown>
    get?: (opts: unknown) => Promise<unknown>
  }
}
let jobClient: JobClient | null = null

function jobWakeText(job: Job): string {
  return [
    `[forge:job-complete] Background job ${job.id} finished (${job.state}${job.exitCode !== null ? `, exit ${job.exitCode}` : ""}).`,
    `Command: ${job.cmd}`,
    `Recent output:\n${job.tail.slice(-1500) || "(none)"}`,
    "Details via forge_jobs (poll/log); the job stays in the registry until cleared.",
  ].join("\n")
}

// Deliver queued completion wakes to a session that just went idle. A send
// failure re-queues the wake (bounded by the manager's delivery window,
// which abandons it to the ledger instead of looping forever).
async function deliverJobWakes(sessionID: string): Promise<void> {
  if (forgeDisabled || jobStage() >= 2) return
  if (!jobClient || typeof jobClient.session.promptAsync !== "function") return
  for (const job of jobManager.deliverWakesFor(sessionID)) {
    try {
      await jobClient.session.promptAsync({ path: { id: sessionID }, body: { parts: [{ type: "text", text: jobWakeText(job) }] } })
    } catch {
      job.wakeState = "queued"
    }
  }
}

// Root ancestor of a session for handoff rebinding, best-effort through the
// host API; undefined when unresolvable (handoff then stays plugin-global).
async function handoffTarget(sessionID: string): Promise<string | undefined> {
  if (!jobClient || typeof jobClient.session.get !== "function") return undefined
  let current = sessionID
  for (let depth = 0; depth < 10; depth++) {
    try {
      const info = (await jobClient.session.get({ path: { id: current } })) as { parentID?: string } | undefined
      if (!info?.parentID) return current === sessionID ? undefined : current
      current = info.parentID
    } catch {
      return undefined
    }
  }
  return current === sessionID ? undefined : current
}

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
  const state: SessionState = { sessionID, worktree }
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
    "Only used inside the /plan flow (the user ran /plan, asked to plan first, or a [forge:plan-notice] is present) — never self-initiate planning. Create or revise the session's plan (structured planning document, written to .opencode/plan/<date>-<slug>.md, status draft). The only sanctioned write while planning. Takes structured fields; the tool renders and validates the fixed sections — you cannot produce a malformed plan file.",
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
    "Approve the session's draft plan (draft -> approved). Call it ONLY after presenting the plan and receiving the user's explicit go-ahead in chat — never in the same turn that presents the draft. The permission layer pins this call to a confirmation dialog — the user's Allow is the final hard gate and lifts the draft-phase write ban. Optionally pass a one-line summary of what changed since the last revision.",
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

// ---------------------------------------------------------------------------
// Goal harness (orthogonal to plans: no plan state is read, no binding
// exists; the only intersection is the draft write-ban as an environmental
// safety constraint)
// ---------------------------------------------------------------------------

function goalDirOf(worktree: string): string {
  return join(worktree, ".opencode", "goal")
}

function readGoalDir(worktree: string): Array<{ name: string; text: string }> {
  const dir = goalDirOf(worktree)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((name) => ({ name, text: readFileSync(join(dir, name), "utf8") }))
}

type ActiveGoal = { path: string; doc: GoalDoc }

// The session's goal: the bound file if non-terminal, else the freshest
// live goal in the workspace (goals are workspace-visible like plans — a
// fresh session sees, checks, and can gate the active goal; the CONTINUATION
// engine alone is owner-restricted, enforced separately in the idle guard).
// Queued goals are workspace queue entries — they bind only via the explicit
// path set at creation or promotion; creating another queued goal never
// trips over an unrelated one.
function resolveSessionGoal(state: SessionState): ActiveGoal | null {
  if (state.goalPath && existsSync(state.goalPath)) {
    const doc = parseGoalLoose(readFileSync(state.goalPath, "utf8"))
    if (doc && !isGoalTerminal(doc.status)) return { path: state.goalPath, doc }
    state.goalPath = undefined
  }
  const live = rankLiveGoals(readGoalDir(state.worktree))[0]
  if (live) {
    const path = join(goalDirOf(state.worktree), live.name)
    state.goalPath = path
    return { path, doc: live.doc }
  }
  return null
}

// Live (active/paused) goal only — what the notice and continuation use.
function resolveLiveGoal(state: SessionState): ActiveGoal | null {
  const g = resolveSessionGoal(state)
  return g && (g.doc.status === "active" || g.doc.status === "paused") ? g : null
}

// zod-permissive check rows -> typed CheckItem[]
function coerceChecks(rows: Array<{ shell?: string; containsFile?: string; containsText?: string; timeoutSec?: number }>): CheckItem[] {
  const items: CheckItem[] = []
  for (const c of rows) {
    // Backticks would break the check-line round trip (the rendered
    // document delimits commands/paths/text with them) — refuse at the door.
    if ([c.shell, c.containsFile, c.containsText].some((v) => typeof v === "string" && v.includes("`"))) {
      throw new GoalError("Verification items must not contain backticks (they break the goal file format)")
    }
    if (typeof c.shell === "string" && c.shell.trim()) {
      items.push({ kind: "shell", cmd: c.shell.trim(), ...(c.timeoutSec ? { timeoutSec: Math.min(Math.max(1, c.timeoutSec), 600) } : {}) })
    } else if (typeof c.containsFile === "string" && c.containsFile.trim() && typeof c.containsText === "string" && c.containsText.trim()) {
      items.push({ kind: "contains", file: c.containsFile.trim(), text: c.containsText })
    } else {
      throw new GoalError("Each verification item needs either `shell` or both `containsFile` and `containsText`")
    }
  }
  return items
}

const goalWriteTool = tool({
  description:
    "Only used inside the /goal flow (the user ran /goal or explicitly asked for a goal loop) — never self-initiate. Create or revise the session's goal contract (written to .opencode/goal/<date>-<slug>.md). Creating with arm=true arms the autonomous continuation loop — a user confirmation dialog IS the arm action; arm=false only queues an inert goal (/goal add). While this session already has a live goal, creating another is refused — pass revise=true to edit the current contract instead (bumps the revision; evidence from earlier revisions no longer counts; budgets carry over unless explicitly changed). Orthogonal to plans: never reads plan state.",
  args: {
    goal: tool.schema.string().describe("One-line goal statement (the semantic completion requirement)"),
    criteria: tool.schema.array(tool.schema.string()).describe("Success Criteria: numbered, verifiable outcomes"),
    checks: tool.schema
      .array(
        tool.schema.object({
          shell: tool.schema.string().optional().describe("Shell command the plugin itself executes on the host"),
          containsFile: tool.schema.string().optional().describe("File contract: workspace-relative file path"),
          containsText: tool.schema.string().optional().describe("File contract: required literal text in that file"),
          timeoutSec: tool.schema.number().int().positive().optional().describe("Shell timeout in seconds (default 120, max 600)"),
        }),
      )
      .describe("Verification Checks: at least one; each item is a shell command or a file::text contract"),
    constraints: tool.schema.string().describe("Constraints: boundaries the work must respect"),
    nonGoals: tool.schema.array(tool.schema.string()).optional().describe("Non-Goals: explicit out-of-scope items"),
    maxTurns: tool.schema.number().int().positive().optional().describe("Turn budget (default 25, hard max 200)"),
    maxMinutes: tool.schema.number().int().positive().optional().describe("Wall-clock budget in minutes (default 60, hard max 480)"),
    arm: tool.schema.boolean().optional().describe("true = arm the loop now (user dialog); false = queue inert (/goal add)"),
    revise: tool.schema.boolean().optional().describe("true = edit the existing goal's contract instead of refusing (revision bump)"),
  },
  execute: async (args, context) => {
    const state = ensureSession(context.sessionID, worktreeFor(context))
    const now = nowIso()
    const checks = coerceChecks(args.checks)
    const input: GoalInput = {
      goal: args.goal,
      criteria: args.criteria,
      checks,
      constraints: args.constraints,
      ...(args.nonGoals ? { nonGoals: args.nonGoals } : {}),
      ...(args.maxTurns ? { maxTurns: args.maxTurns } : {}),
      ...(args.maxMinutes ? { maxMinutes: args.maxMinutes } : {}),
    }
    const existing = resolveSessionGoal(state)
    if (existing && args.revise !== true) {
      throw new GoalError(
        `This session already has a goal: ${relFrom(state.worktree, existing.path)} (status: ${existing.doc.status}). Re-run goal_write with revise=true to edit its contract, /goal add to queue a new one, or goal_discard to abandon it first.`,
      )
    }
    if (existing) {
      const text = carryHistory(
        renderGoal(
          {
            ...input,
            // A revision must not silently change the budgets: keep the old
            // ones unless the caller passes new values (budget laundering via
            // edit would defeat the hard ceilings).
            ...(input.maxTurns === undefined ? { maxTurns: existing.doc.maxTurns } : {}),
            ...(input.maxMinutes === undefined ? { maxMinutes: existing.doc.maxMinutes } : {}),
          },
          {
            now,
            status: existing.doc.status,
            created: existing.doc.created,
            revision: existing.doc.revision + 1,
            ...(existing.doc.session ? { session: existing.doc.session } : {}),
            turnsUsed: existing.doc.turnsUsed,
            // The wall-clock window keeps running across a contract edit
            // (revising is not re-arming; budgets carry over by contract).
            ...(existing.doc.armedAt ? { armedAt: existing.doc.armedAt } : {}),
            // A paused goal keeps its stop_reason across a revision: the
            // pause reason is why the loop stopped, not part of the contract
            // being edited.
            ...(existing.doc.status === "paused" && existing.doc.stopReason ? { stopReason: existing.doc.stopReason } : {}),
          },
        ),
        existing.doc,
      )
      atomicWrite(existing.path, text)
      const doc = parseGoal(text)
      context.metadata({ title: `Revise goal (rev ${doc.revision}): ${doc.goal}` })
      return {
        title: `goal revised (rev ${doc.revision})`,
        output: [
          `Goal contract revised: ${relFrom(state.worktree, existing.path)} (revision ${doc.revision}).`,
          `Evidence recorded under earlier revisions no longer counts. Status stays ${doc.status}; budget stays ${doc.turnsUsed}/${doc.maxTurns} turns.`,
        ].join("\n"),
      }
    }
    const arm = args.arm !== false
    if (arm) {
      const plan = resolveActivePlan(state)
      if (plan && plan.doc.status === "draft") {
        throw new GoalError(
          `This session has a plan in draft (${relFrom(state.worktree, plan.path)}); autonomous execution cannot arm against the planning-phase write ban. Approve the plan (plan_approve) or discard it (/plan discard) first.`,
        )
      }
      await gate(context.ask, "goal_write", `Arm goal: ${args.goal}`)
    }
    const dir = goalDirOf(state.worktree)
    mkdirSync(dir, { recursive: true })
    const name = goalFileName(localDateNow(), slugifyGoal(args.goal), readdirSync(dir).filter((f) => f.endsWith(".md")))
    const path = join(dir, name)
    const text = renderGoal(input, {
      now,
      status: arm ? "active" : "queued",
      ...(arm ? { session: context.sessionID, armedAt: now } : {}),
    })
    atomicWrite(path, text)
    state.goalPath = path
    const doc = parseGoal(text)
    context.metadata({ title: `${arm ? "Arm" : "Queue"} goal: ${doc.goal}` })
    return {
      title: `goal ${arm ? "armed" : "queued"}: ${doc.goal}`,
      output: arm
        ? [
            `Goal armed: ${relFrom(state.worktree, path)} (revision 1, ${doc.criteria.length} criteria, ${doc.checks.length} verification items, budget ${doc.maxTurns} turns / ${doc.maxMinutes} min).`,
            "The loop continues this session on idle until the goal completes, pauses, or the budget runs out. Work the criteria; call goal_check whenever you believe they hold; goal_complete re-runs every check itself and asks the user. If blocked, goal_pause with the blocker.",
          ].join("\n")
        : `Goal queued (inert): ${relFrom(state.worktree, path)}. It never runs until promoted via /goal next or goal_resume (user dialog).`,
    }
  },
})

const goalCheckTool = tool({
  description:
    "Run the goal's verification items on the host (shell commands executed by the plugin in the workspace, file contracts re-read from disk) and append the dated, revision-stamped results to the goal's Check Log. Advisory feedback — only goal_complete has gating authority.",
  args: {
    items: tool.schema.array(tool.schema.number().int().positive()).optional().describe("Optional subset of verification item numbers; omit to run all"),
  },
  execute: async (args, context) => {
    const state = ensureSession(context.sessionID, worktreeFor(context))
    const goal = resolveSessionGoal(state)
    if (!goal || (goal.doc.status !== "active" && goal.doc.status !== "paused")) {
      throw new GoalError("No live goal in this workspace (active or paused). Arm one with /goal <objective> first.")
    }
    const wanted = args.items ? new Set(args.items) : null
    const selected = goal.doc.checks.map((c, i) => ({ c, n: i + 1 })).filter((x) => !wanted || wanted.has(x.n))
    if (selected.length === 0) throw new GoalError("None of the given item numbers exist in this goal's Verification Checks.")
    const outcomes = await runChecks(
      selected.map((x) => x.c),
      state.worktree,
    )
    outcomes.forEach((o, i) => {
      o.index = selected[i].n
    })
    const runId = `${nowIso()}-${Math.random().toString(36).slice(2, 8)}`
    const next = appendCheckLog(readFileSync(goal.path, "utf8"), runId, outcomes, nowIso())
    atomicWrite(goal.path, next)
    const ok = outcomesAllOk(outcomes)
    context.metadata({ title: `goal_check: ${outcomes.filter((o) => o.ok).length}/${outcomes.length} pass` })
    return {
      title: `goal_check ${ok ? "all pass" : "failing"}`,
      output: [
        `Host verification run (revision ${goal.doc.revision}), recorded in the Check Log:`,
        formatOutcomes(outcomes),
        ok ? "All selected items pass. Proceed to goal_complete (it re-runs everything itself at the gate)." : "Failing items remain — fix the work, then re-run goal_check.",
      ].join("\n"),
    }
  },
})

const goalCompleteTool = tool({
  description:
    "Close the goal (active -> completed). Re-executes EVERY verification item itself on the host right now (fail-closed: any failing shell command, timeout, missing file, or absent contract text refuses completion) and requires a per-criterion attestation array (pass + concrete evidence). Only then does the user confirmation dialog appear — the user's Allow closes the goal.",
  args: {
    attestations: tool.schema
      .array(
        tool.schema.object({
          criterion: tool.schema.string().describe("The success criterion text, copied verbatim from the goal"),
          pass: tool.schema.boolean().describe("Whether the criterion is met"),
          evidence: tool.schema.string().describe("Concrete evidence: file:line, command output, test result"),
        }),
      )
      .describe("One entry per success criterion of the current revision, in goal order"),
  },
  execute: async (args, context) => {
    const state = ensureSession(context.sessionID, worktreeFor(context))
    const goal = resolveSessionGoal(state)
    if (!goal || goal.doc.status !== "active") {
      throw new GoalError(`No active goal to complete (status: ${goal?.doc.status ?? "none"}). goal_resume an active loop first.`)
    }
    const outcomes = await runChecks(goal.doc.checks, state.worktree)
    const failures = outcomes.filter((o) => !o.ok)
    if (failures.length > 0) {
      const runId = `${nowIso()}-${Math.random().toString(36).slice(2, 8)}`
      atomicWrite(goal.path, appendCheckLog(readFileSync(goal.path, "utf8"), runId, outcomes, nowIso()))
      throw new GoalError(
        `Completion gate: verification re-run failed (fail-closed). The goal stays active.\n${formatOutcomes(failures)}\nFix the work and retry; recorded results never substitute for the gate's own re-run.`,
      )
    }
    const attestationFailures = completeCheckFailures(goal.doc, args.attestations)
    if (attestationFailures.length > 0) {
      throw new GoalError(`Completion gate: self-attestation failed (revision ${goal.doc.revision}).\n- ${attestationFailures.join("\n- ")}`)
    }
    await gate(context.ask, "goal_complete", `Complete goal: ${goal.doc.goal}`)
    const runId = `${nowIso()}-${Math.random().toString(36).slice(2, 8)}`
    let text = appendCheckLog(readFileSync(goal.path, "utf8"), runId, outcomes, nowIso())
    text = transitionGoal(text, "completed", nowIso())
    atomicWrite(goal.path, text)
    context.metadata({ title: `Goal completed: ${goal.doc.goal}` })
    return {
      title: "goal completed",
      output: `Goal completed and closed: ${relFrom(state.worktree, goal.path)}. All ${outcomes.length} verification items re-run passing at the gate; ${args.attestations.length} attestations recorded.`,
    }
  },
})

const goalPauseTool = tool({
  description:
    "Pause the session's live goal (active -> paused); the continuation loop stops immediately. Always safe, no confirmation needed. Pass the blocker text when pausing because you are stuck (stop_reason blocker); omit it for a user-requested pause.",
  args: {
    blocker: tool.schema.string().optional().describe("Specific blocker that prevents progress (recorded as stop_reason blocker)"),
  },
  execute: async (args, context) => {
    const state = ensureSession(context.sessionID, worktreeFor(context))
    const goal = resolveSessionGoal(state)
    if (!goal || goal.doc.status !== "active") {
      throw new GoalError(`No active goal to pause (status: ${goal?.doc.status ?? "none"}).`)
    }
    const stopReason: StopReason = args.blocker ? "blocker" : "user"
    atomicWrite(goal.path, transitionGoal(readFileSync(goal.path, "utf8"), "paused", nowIso(), { stopReason }))
    engineForgetSession(context.sessionID)
    context.metadata({ title: `Goal paused (${stopReason}): ${goal.doc.goal}` })
    return {
      title: `goal paused (${stopReason})`,
      output: `Goal paused: ${relFrom(state.worktree, goal.path)} (stop_reason: ${stopReason}${args.blocker ? ` — ${args.blocker}` : ""}). Continuation is stopped; /goal resume or an explicit "continue" from the user re-arms it through a confirmation dialog.`,
    }
  },
})

const goalResumeTool = tool({
  description:
    "Re-arm a paused goal, or promote the oldest queued goal (/goal next). A user confirmation dialog IS the re-arm action. Optionally tops up the turn budget (hard-capped). Ownership rebinds to this session. When the goal is paused and the user explicitly says continue/resume, this is the tool to call; ordinary chat must never reactivate a goal.",
  args: {
    addTurns: tool.schema.number().int().positive().optional().describe("Extra turns to add to the budget (capped by the hard ceiling)"),
  },
  execute: async (args, context) => {
    const state = ensureSession(context.sessionID, worktreeFor(context))
    let goal = resolveSessionGoal(state)
    // Promotion (/goal next) takes the OLDEST queued goal in the workspace,
    // not whichever the generic resolver happened to bind.
    if (!goal || goal.doc.status === "queued") {
      const oldest = rankQueuedGoals(readGoalDir(state.worktree))[0]
      if (oldest) {
        const path = join(goalDirOf(state.worktree), oldest.name)
        state.goalPath = path
        goal = { path, doc: oldest.doc }
      }
    }
    if (!goal || (goal.doc.status !== "paused" && goal.doc.status !== "queued")) {
      throw new GoalError(`No paused or queued goal to resume (status: ${goal?.doc.status ?? "none"}).`)
    }
    const promoting = goal.doc.status === "queued"
    await gate(context.ask, "goal_resume", `${promoting ? "Promote" : "Resume"} goal: ${goal.doc.goal}`)
    let text = readFileSync(goal.path, "utf8")
    if (args.addTurns) text = bumpBudget(text, args.addTurns, nowIso())
    text = transitionGoal(text, "active", nowIso(), { session: context.sessionID })
    atomicWrite(goal.path, text)
    state.goalPath = goal.path
    engineForgetSession(context.sessionID)
    const doc = parseGoal(text)
    context.metadata({ title: `${promoting ? "Goal promoted" : "Goal resumed"}: ${doc.goal}` })
    return {
      title: promoting ? "goal promoted" : "goal resumed",
      output: `Goal ${promoting ? "promoted from the queue and armed" : "resumed"}: ${relFrom(state.worktree, goal.path)} (budget ${doc.turnsUsed}/${doc.maxTurns} turns, owned by this session). The loop continues on the next idle.`,
    }
  },
})

const goalDiscardTool = tool({
  description:
    "Abandon the session's goal (live or queued -> abandoned) and stop the loop. A user confirmation dialog IS the discard action — abandoning the user's objective is the user's decision. The file stays in .opencode/goal/ as history.",
  args: {
    reason: tool.schema.string().optional().describe("Short reason recorded in the reply"),
  },
  execute: async (_args, context) => {
    const state = ensureSession(context.sessionID, worktreeFor(context))
    const goal = resolveSessionGoal(state)
    if (!goal) throw new GoalError("No goal to discard in this workspace.")
    await gate(context.ask, "goal_discard", `Discard goal: ${goal.doc.goal}`)
    atomicWrite(goal.path, transitionGoal(readFileSync(goal.path, "utf8"), "abandoned", nowIso()))
    state.goalPath = undefined
    engineForgetSession(context.sessionID)
    context.metadata({ title: `Goal abandoned: ${goal.doc.goal}` })
    return {
      title: "goal abandoned",
      output: `Goal abandoned: ${relFrom(state.worktree, goal.path)}${_args.reason ? ` (${_args.reason})` : ""}. The file remains as history; the loop is stopped.`,
    }
  },
})

// ---------------------------------------------------------------------------
// Job supervisor tools
// ---------------------------------------------------------------------------

const FORGE_SHELL_DESCRIPTION = [
  "Run a shell command without ever blocking the session indefinitely. The call completes on the FIRST of: process exit (bound to the exit event — a detached grandchild holding the stdio pipes cannot suspend the call); success_pattern matching new output (opt-in regex); idle_ms with no new output (default 60000); max_wait_ms hard cap (default 120000, max 600000 — returns still-running, never kills).",
  "Idle/max-wait return `still-running` with a jobId — the process stays alive; keep watching with forge_jobs poll / log, stop it with forge_jobs kill. run_in_background returns {jobId, logPath} immediately.",
  "success_pattern semantics: a match completes the call as success; the process is kept alive by default (server semantics — the thing you just verified keeps running); pass keep_alive=false to kill its tree on match. Common patterns: dev servers `listening on|ready in|Local:`, builds `Compiled successfully|Done in`, test suites `passed|all tests`.",
  "Long-running or possibly non-exiting commands (dev servers, watchers, installers, anything spawning detached children) MUST use this tool instead of the builtin shell.",
].join("\n")

// D10 stage-1 action: once the native run_in_background parameter exists,
// forge_shell stays only as the supervision layer (idle/success/wake).
const STAGE1_NOTE =
  "Stage note: this host's builtin shell already offers a native run_in_background parameter — prefer that for plain backgrounding; keep using forge_shell when you need idle/success_pattern early return or exit wake messages."

const forgeShellTool = tool({
  description: FORGE_SHELL_DESCRIPTION,
  args: {
    command: tool.schema.string().describe("The shell command to run"),
    workdir: tool.schema.string().optional().describe("Working directory (workspace-relative, or absolute)"),
    run_in_background: tool.schema.boolean().optional().describe("Return {jobId, logPath} immediately, without waiting for any output or exit"),
    idle_ms: tool.schema.number().int().nonnegative().optional().describe("No-new-output early-return threshold in ms (default 60000)"),
    max_wait_ms: tool.schema.number().int().nonnegative().optional().describe("Hard cap on this call's wait in ms (default 120000, clamped to 600000); returns still-running, never kills"),
    success_pattern: tool.schema.string().optional().describe("Regex; a match against new output completes the call as success immediately"),
    keep_alive: tool.schema.boolean().optional().describe("After a success match: keep the process alive (default) or kill its tree (false)"),
    notify: tool.schema.boolean().optional().describe("Send a [forge:job-complete] message into this session when the job exits (default true)"),
  },
  execute: async (args, context) => {
    if (jobStage() >= 2) {
      throw new Error("[forge] The job supervisor is retired on this host (native backgrounding confirmed complete) — use the shell tool's run_in_background parameter.")
    }
    const state = ensureSession(context.sessionID, worktreeFor(context))
    // Permission two-piece (pitfalls §4.5): plugin tools bypass permission
    // evaluation, so context.ask() IS the posture; the config hook injects
    // the matching "ask" rule so the request resolves to a real dialog. An
    // explicit user deny always wins (the ask then rejects).
    await gate(context.ask, "forge_shell", `forge_shell: ${args.command.slice(0, 100)}`)
    let successPattern: RegExp | null = null
    if (args.success_pattern) {
      try {
        successPattern = new RegExp(args.success_pattern)
      } catch (err) {
        throw new Error(`Invalid success_pattern: ${(err as Error).message}`)
      }
    }
    const cwd = args.workdir ? (isAbsolute(args.workdir) ? args.workdir : join(state.worktree, args.workdir)) : state.worktree
    const started = startJob(jobManager, {
      cmd: args.command,
      cwd,
      ownerSession: context.sessionID,
      worktree: state.worktree,
      logDir: jobLogDir,
      runInBackground: args.run_in_background === true,
      ...(args.idle_ms !== undefined ? { idleMs: args.idle_ms } : {}),
      ...(args.max_wait_ms !== undefined ? { maxWaitMs: args.max_wait_ms } : {}),
      successPattern,
      ...(args.keep_alive !== undefined ? { keepAlive: args.keep_alive } : {}),
      ...(args.notify !== undefined ? { notify: args.notify } : {}),
    })
    context.metadata({ title: `forge_shell: ${args.command.slice(0, 60)}` })
    if (args.run_in_background === true) {
      return {
        title: `job started: ${started.job.id}`,
        output: [`[forge:job] Started in background.`, `jobId: ${started.job.id}`, `logPath: ${started.job.logPath}`, "Track with forge_jobs poll; a [forge:job-complete] message arrives on exit."].join("\n"),
      }
    }
    const r = await started.settle
    if (r.status === "exited") {
      return {
        title: `exit ${r.exitCode ?? "?"}`,
        output: [
          `[forge:job] Command finished (exit=${r.exitCode ?? "none"}).`,
          ...(r.spawnError ? [`spawn error: ${r.spawnError}`] : []),
          `output:\n${r.outputTail || "(none)"}`,
        ].join("\n"),
      }
    }
    if (r.status === "succeeded") {
      return {
        title: `success: ${r.matched}`,
        output: [
          `[forge:job] Success pattern matched: "${r.matched}".`,
          r.keptAlive ? `The process was kept alive as job ${started.job.id} (stop it with forge_jobs kill when done).` : "The process tree was terminated (keep_alive=false).",
          `output:\n${r.outputTail}`,
        ].join("\n"),
      }
    }
    return {
      title: `still running (${Math.round(r.idleForMs / 1000)}s idle)`,
      output: [
        `[forge:job] Still running — ${Math.round(r.idleForMs / 1000)}s without new output (or the wait budget ran out). The process is alive as job ${started.job.id}.`,
        `logPath: ${started.job.logPath}`,
        `recent output:\n${r.outputTail || "(none yet)"}`,
        "Next: forge_jobs poll to keep waiting, forge_jobs log for history, forge_jobs kill to stop.",
      ].join("\n"),
    }
  },
})

const FORGE_JOBS_ACTIONS = ["list", "poll", "log", "kill", "clear", "handoff"]

const forgeJobsTool = tool({
  description:
    "Manage forge_shell jobs. Actions: list (all jobs, newest first); poll {jobId, waitMs<=30000} — bounded wait for NEW output or exit, drains it; log {jobId, offset?, limit?} — line paging over the on-disk log (omitted offset = tail window, default 200 lines); kill {jobId} — terminate the job's whole process tree; clear {jobId} — drop a finished job from the registry; handoff {jobId} — rebind ownership to the root session so the job survives this (sub)session's end. A delegated agent MUST poll its jobs before yielding its conclusion.",
  args: {
    action: tool.schema.string().describe(`One of: ${FORGE_JOBS_ACTIONS.join(", ")}`),
    jobId: tool.schema.string().optional().describe("Job id from forge_shell (required for every action except list)"),
    waitMs: tool.schema.number().int().nonnegative().optional().describe("poll: bounded in-call wait (clamped to 30000)"),
    offset: tool.schema.number().int().nonnegative().optional().describe("log: first line index; omitted = tail window"),
    limit: tool.schema.number().int().positive().optional().describe("log: max lines (default 200)"),
  },
  execute: async (args, context) => {
    if (jobStage() >= 2) throw new Error("[forge] The job supervisor is retired on this host.")
    const action = String(args.action ?? "")
    if (!FORGE_JOBS_ACTIONS.includes(action)) {
      throw new Error(`Unknown action "${action}" — use one of: ${FORGE_JOBS_ACTIONS.join(", ")}.`)
    }
    if (action === "list") {
      const rows = jobManager.list().map((j) => `${j.id}  ${j.state}${j.exitCode !== null ? `(${j.exitCode})` : ""}${j.succeededAt ? "*" : ""}  ${j.scope}  ${j.cmd.slice(0, 60)}`)
      return { title: `jobs (${rows.length})`, output: rows.length > 0 ? rows.join("\n") : "(no jobs)" }
    }
    if (!args.jobId) throw new Error(`Action "${action}" requires jobId.`)
    const job = jobManager.get(args.jobId)
    if (!job) throw new Error(`No job ${args.jobId} in the registry (finished jobs age out; the on-disk log may still exist).`)
    if (action === "poll") {
      const p = await pollJob(jobManager, args.jobId, args.waitMs ?? 0)
      if (!p) throw new Error(`No job ${args.jobId}.`)
      return {
        title: `${job.id}: ${p.state}`,
        output: [
          `[forge:job] ${job.id}: ${p.state}${p.exitCode !== null ? ` exit=${p.exitCode}` : ""}${p.succeeded ? " (success pattern matched)" : ""}`,
          `new output:\n${p.newOutput || "(none in this window)"}`,
          `logPath: ${p.logPath}`,
        ].join("\n"),
      }
    }
    if (action === "log") {
      const page = readJobLog(job.logPath, {
        ...(args.offset !== undefined ? { offset: args.offset } : {}),
        ...(args.limit !== undefined ? { limit: args.limit } : {}),
      })
      return {
        title: `${job.id} log ${page.offset}-${page.offset + page.lines.length}/${page.total}`,
        output: page.lines.length > 0 ? page.lines.join("\n") : "(empty)",
      }
    }
    if (action === "kill") {
      jobManager.kill(job)
      return { title: `${job.id} killed`, output: `[forge:job] ${job.id}: tree kill issued (state: killed).` }
    }
    if (action === "clear") {
      const ok = jobManager.clear(args.jobId)
      return ok
        ? { title: `${job.id} cleared`, output: `[forge:job] ${job.id} removed from the registry (log file untouched).` }
        : { title: `${job.id} not cleared`, output: `[forge:job] ${job.id} is still running — kill it first.` }
    }
    // handoff
    const target = await handoffTarget(context.sessionID)
    jobManager.handoff(args.jobId, target)
    return {
      title: `${job.id} handed off`,
      output: `[forge:job] ${job.id} promoted to plugin-global scope${target ? ` and rebound to root session ${target}` : ""}; it now survives this session's end.`,
    }
  },
})

function forgeTools(): Record<string, ToolDefinition> {
  const tools: Record<string, ToolDefinition> = {
    plan_write: planWriteTool,
    plan_tick: planTickTool,
    plan_approve: planApproveTool,
    plan_close: planCloseTool,
    plan_discard: planDiscardTool,
    goal_write: goalWriteTool,
    goal_check: goalCheckTool,
    goal_complete: goalCompleteTool,
    goal_pause: goalPauseTool,
    goal_resume: goalResumeTool,
    goal_discard: goalDiscardTool,
  }
  if (jobStage() < 2) {
    tools.forge_shell = forgeShellTool
    tools.forge_jobs = forgeJobsTool
  }
  return tools
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
// Goal continuation engine state (module-level so tools can reset it)
// ---------------------------------------------------------------------------

// Debounce between a session.idle event and the continuation send.
const IDLE_DEBOUNCE_MS = Number(process.env.FORGE_GOAL_DEBOUNCE_MS ?? 2000)

const idleTimers = new Map<string, ReturnType<typeof setTimeout>>()
const continuationInFlight = new Set<string>()
const transportFails = new Map<string, number>()
const noProgressStreak = new Map<string, number>()
// Per-continuation-turn activity counters, read by tool.execute.after and
// evaluated at the next idle for the no-progress detector.
const turnActivity = new Map<string, { writes: number; checks: number }>()
const pendingContinuationTurn = new Set<string>()

function goalProbe(line: string): void {
  if (process.env.FORGE_GOAL_PROBE) {
    try {
      appendFileSync(join(tmpdir(), "forge-goal-probe.log"), `${new Date().toISOString()} ${line}\n`)
    } catch {}
  }
}

function engineForgetSession(sessionID: string): void {
  const t = idleTimers.get(sessionID)
  if (t) clearTimeout(t)
  idleTimers.delete(sessionID)
  continuationInFlight.delete(sessionID)
  transportFails.delete(sessionID)
  noProgressStreak.delete(sessionID)
  turnActivity.delete(sessionID)
  pendingContinuationTurn.delete(sessionID)
}

function engineForgetAll(): void {
  for (const id of [...idleTimers.keys()]) engineForgetSession(id)
}

function goalBriefText(state: SessionState, goal: ActiveGoal): string {
  const d = goal.doc
  return [
    `[forge:goal-continue] Continue the active goal (revision ${d.revision}): ${d.goal}`,
    `Success criteria:\n${d.criteria.map((c, i) => `${i + 1}. ${c}`).join("\n")}`,
    `Verification items (the plugin runs these itself; never fake their output):\n${d.checks
      .map((c, i) => `${i + 1}. ${c.kind === "shell" ? `shell \`${c.cmd}\`` : `contains \`${c.file}\` :: \`${c.text}\``}`)
      .join("\n")}`,
    d.constraints.trim() ? `Constraints: ${d.constraints.trim()}` : "",
    `Budget: ${d.turnsUsed}/${d.maxTurns} turns used. Work the criteria now; call goal_check when you believe they hold, then goal_complete (it re-runs every check itself and asks the user). If genuinely blocked, call goal_pause with the blocker — do not spin.`,
    `Goal file: ${relFrom(state.worktree, goal.path)}`,
  ]
    .filter((s) => s.length > 0)
    .join("\n")
}

function wrapupBriefText(goal: ActiveGoal, reason: StopReason): string {
  return [
    `[forge:goal-wrapup] The goal loop is stopping (stop_reason: ${reason}); the goal is now PAUSED.`,
    `Goal (revision ${goal.doc.revision}): ${goal.doc.goal}`,
    "Produce a concise handoff summary and nothing else: what is done, what remains, the single next concrete step. Do not continue working the goal in this turn.",
  ].join("\n")
}

type GoalClient = {
  session: {
    prompt: (opts: unknown) => Promise<unknown>
    get: (opts: unknown) => Promise<unknown>
    status?: (opts: unknown) => Promise<unknown>
  }
}

// Auto-pause with an optional final wrap-up continuation. Pause happens
// first (atomic, no race with another idle); the wrap-up prompt is
// best-effort and does not count against the turn budget.
async function autoPauseGoal(client: GoalClient, state: SessionState, goal: ActiveGoal, reason: StopReason, wrapup: boolean): Promise<void> {
  goalProbe(`auto-pause session=${state.sessionID} reason=${reason} wrapup=${wrapup}`)
  atomicWrite(goal.path, transitionGoal(readFileSync(goal.path, "utf8"), "paused", nowIso(), { stopReason: reason }))
  engineForgetSession(state.sessionID)
  if (wrapup && goal.doc.session) {
    try {
      await client.session.prompt({
        path: { id: goal.doc.session },
        body: { parts: [{ type: "text", text: wrapupBriefText(goal, reason) }] },
      })
    } catch (err) {
      goalProbe(`wrapup delivery failed session=${state.sessionID} err=${String(err)}`)
    }
  }
}

// Full guard chain, then send one continuation. Any unexpected error inside
// degrades to "skip this round" — the loop never fights the host.
async function continueIfEligible(client: GoalClient, sessionID: string): Promise<void> {
  // The disable knob must gate the autonomous loop hardest of all: with the
  // goal tools removed the user could not even discard a leftover goal, so
  // the engine must never inject continuation prompts while disabled.
  if (forgeDisabled) {
    goalProbe(`skip: forge disabled session=${sessionID}`)
    return
  }
  if (continuationInFlight.has(sessionID)) return
  // Claim the in-flight slot BEFORE any await: two idles racing through the
  // lazy-seed path must not both send a continuation (double-briefing and
  // double turn accounting).
  continuationInFlight.add(sessionID)
  try {
    let state = sessions.get(sessionID)
    if (!state) {
      try {
        const info = (await client.session.get({ path: { id: sessionID } })) as { directory?: string; worktree?: string } | undefined
        const wt = effectiveWorktree(info?.worktree, info?.directory)
        if (!wt) {
          goalProbe(`skip: no worktree for lazy seed session=${sessionID}`)
          return
        }
        state = ensureSession(sessionID, wt)
        goalProbe(`lazy-seeded session=${sessionID} worktree=${wt}`)
      } catch (err) {
        goalProbe(`lazy-seed failed session=${sessionID} err=${String(err)}`)
        return
      }
    }
    // Turn accounting FIRST, before the live-goal check: the previous
    // continuation turn may have COMPLETED or paused the goal (that is the
    // gate turn — exactly the one the ledger must not lose). The file is
    // addressed directly via state.goalPath, which the engine sets when it
    // sends a continuation, because a terminal goal is no longer discoverable
    // through live-goal ranking.
    let accountedContinuationTurn = false
    let turnHadActivity = false
    if (pendingContinuationTurn.has(sessionID)) {
      accountedContinuationTurn = true
      pendingContinuationTurn.delete(sessionID)
      const act = turnActivity.get(sessionID)
      turnHadActivity = !!act && (act.writes > 0 || act.checks > 0)
      turnActivity.set(sessionID, { writes: 0, checks: 0 })
      const ledgerPath = state.goalPath
      if (ledgerPath && existsSync(ledgerPath)) {
        try {
          const fresh = parseGoalLoose(readFileSync(ledgerPath, "utf8"))
          if (fresh && fresh.turnsUsed > 0) {
            atomicWrite(
              ledgerPath,
              appendLedger(
                readFileSync(ledgerPath, "utf8"),
                { turn: fresh.turnsUsed, revision: fresh.revision, at: nowIso(), activity: turnHadActivity, writes: act?.writes ?? 0, checks: act?.checks ?? 0 },
                nowIso(),
              ),
            )
          }
        } catch (err) {
          goalProbe(`ledger append failed session=${sessionID} err=${String(err)}`)
        }
      }
    }
    const goal = resolveLiveGoal(state)
    if (!goal || goal.doc.status !== "active") {
      goalProbe(`skip: no live active goal session=${sessionID}`)
      return
    }
    // An active goal without an owner session is anomalous (hand-edited or
    // corrupted frontmatter): no session may claim its loop.
    if (!goal.doc.session || goal.doc.session !== sessionID) {
      goalProbe(`skip: not goal owner session=${sessionID} owner=${goal.doc.session || "(none)"}`)
      return
    }
    // No-progress accounting, only for turns the engine itself started. The
    // finished turn's activity is also recorded in the goal's Turn Ledger
    // (auditable anti-batching evidence, visible at the completion gate).
    if (accountedContinuationTurn) {
      if (turnHadActivity) {
        noProgressStreak.delete(sessionID)
      } else {
        const n = (noProgressStreak.get(sessionID) ?? 0) + 1
        noProgressStreak.set(sessionID, n)
        goalProbe(`no-progress session=${sessionID} streak=${n}`)
        if (n >= NO_PROGRESS_LIMIT) {
          await autoPauseGoal(client, state, goal, "no-progress", true)
          return
        }
      }
    }
    // Safety interop (not semantic coupling): a live draft plan's write ban
    // would wall the loop off — pause instead of burning turns against it.
    const plan = resolveActivePlan(state)
    if (plan && plan.doc.status === "draft") {
      await autoPauseGoal(client, state, goal, "draft-conflict", false)
      return
    }
    const bs = budgetState(goal.doc)
    if (bs !== "ok") {
      await autoPauseGoal(client, state, goal, bs, true)
      return
    }
    // Idle re-check: the user may have resumed the conversation first.
    if (typeof client.session.status === "function") {
      try {
        const st = (await client.session.status({ path: { id: sessionID } })) as Record<string, { type?: string }> | undefined
        const t = st?.[sessionID]?.type
        if (t && t !== "idle") {
          goalProbe(`skip: session busy again session=${sessionID} status=${t}`)
          return
        }
      } catch (err) {
        goalProbe(`skip: status check failed session=${sessionID} err=${String(err)}`)
        return
      }
    }
    try {
      await client.session.prompt({
        path: { id: sessionID },
        body: { parts: [{ type: "text", text: goalBriefText(state, goal) }] },
      })
      transportFails.delete(sessionID)
      pendingContinuationTurn.add(sessionID)
      turnActivity.set(sessionID, { writes: 0, checks: 0 })
      // Remember which file this session's loop drives so the NEXT idle can
      // ledger the turn even after the goal goes terminal.
      state.goalPath = goal.path
      atomicWrite(goal.path, incTurns(readFileSync(goal.path, "utf8"), nowIso()))
      goalProbe(`continued session=${sessionID} turn=${goal.doc.turnsUsed + 1}/${goal.doc.maxTurns}`)
    } catch (err) {
      const n = (transportFails.get(sessionID) ?? 0) + 1
      transportFails.set(sessionID, n)
      goalProbe(`transport failure session=${sessionID} count=${n} err=${String(err)}`)
      if (n >= TRANSPORT_FAILURE_LIMIT) {
        await autoPauseGoal(client, state, goal, "transport-failures", false)
      }
    }
  } catch (err) {
    goalProbe(`continuation aborted session=${sessionID} err=${String(err)}`)
  } finally {
    continuationInFlight.delete(sessionID)
  }
}

function scheduleIdleContinuation(client: GoalClient, sessionID: string): void {
  // Belt for the engine guard: a disabled plugin must not even arm a timer.
  if (forgeDisabled) return
  const existing = idleTimers.get(sessionID)
  if (existing) clearTimeout(existing)
  idleTimers.set(
    sessionID,
    setTimeout(() => {
      idleTimers.delete(sessionID)
      void continueIfEligible(client, sessionID)
    }, IDLE_DEBOUNCE_MS),
  )
}

// ---------------------------------------------------------------------------
// v1 server entry (the loader used by `opencode plugin` installs reads this)
// ---------------------------------------------------------------------------

export const server: Plugin = async (input, options) => {
  hostWorktree = effectiveWorktree(input.worktree, input.directory) || input.directory || ""
  const client = input.client as unknown as GoalClient
  jobClient = input.client as unknown as JobClient
  const jobsOpts = (options as { jobs?: { mode?: unknown; keepBuiltinShell?: unknown } } | undefined)?.jobs
  if (jobsOpts?.mode === "auto" || jobsOpts?.mode === "forge" || jobsOpts?.mode === "native") jobsMode = jobsOpts.mode
  jobsKeepBuiltinShell = jobsOpts?.keepBuiltinShell === true

  // hang-watchdog: invalid option values fall back to defaults and the
  // fallback itself is ledgered (auditable misconfig, never a crash).
  const wdOpts = (options as { watchdog?: { mode?: unknown; stallMs?: unknown } } | undefined)?.watchdog
  const wdFallbacks: string[] = []
  const wdMode = parseMode(wdOpts?.mode)
  if (wdOpts?.mode !== undefined && wdOpts.mode !== wdMode) {
    wdFallbacks.push(`invalid watchdog.mode ${JSON.stringify(String(wdOpts.mode))} — fell back to "${wdMode}"`)
  }
  const wdStallRaw = wdOpts?.stallMs
  const wdStall = clampStallMs(typeof wdStallRaw === "number" ? wdStallRaw : undefined)
  if (wdStallRaw !== undefined && wdStallRaw !== wdStall) {
    wdFallbacks.push(`watchdog.stallMs ${JSON.stringify(String(wdStallRaw))} adjusted to ${wdStall} (floor/default applied)`)
  }
  const watchdogLedger = createFileLedger(join(watchdogLogDir(), "log.jsonl"))
  const rawLocator = createLocator()
  const probing = () => process.env.FORGE_WATCHDOG_PROBE === "1"
  const probeLine = (text: string) => {
    if (!probing()) return
    try {
      appendFileSync(join(tmpdir(), "forge-watchdog-probe.log"), `${new Date().toISOString()} ${text}\n`)
    } catch {}
  }
  const diagnosticLocate = async (callID: string, t0: number, cmdNeedle?: string, phase2?: boolean) => {
    const started = Date.now()
    const hits = await rawLocator(callID, t0, cmdNeedle, phase2)
    probeLine(`locate dur=${Date.now() - started}ms hits=${hits.length} phase2=${phase2 === true} needle=${JSON.stringify(cmdNeedle ?? null)}`)
    if (hits.length === 0 && cmdNeedle) {
      // Post-mortem aid: does the raw table even contain needle carriers,
      // and where do they fall relative to the window?
      try {
        const raw = execFileSync("powershell", ["-NoProfile", "-Command", "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine,CreationDate | ConvertTo-Json -Compress"], { encoding: "utf8", windowsHide: true, timeout: 15_000 })
        const all = parseWindowsProcs(raw)
        probeLine(`diag rawLen=${raw.length} procs=${all.length} windowStart=${new Date(t0 - 2000).toISOString()}`)
        for (const p of all) {
          if (p.cmd.includes(cmdNeedle)) probeLine(`diag needle-carrier pid=${p.pid} ppid=${p.ppid} created=${new Date(p.createdMs).toISOString()} cmd=${p.cmd.slice(0, 120)}`)
        }
      } catch (err) {
        probeLine(`diag failed: ${String(err).slice(0, 150)}`)
      }
    }
    return hits
  }
  const watchdog: Watchdog = createWatchdog({
    mode: wdMode,
    stallMs: wdStall,
    sink: (entry) => watchdogLedger.append(entry),
    locate: diagnosticLocate,
    killTree: (pid) => killTree({ pid, kill: (sig) => process.kill(pid, sig as NodeJS.Signals) }),
  })
  for (const reason of wdFallbacks) {
    const entry: LedgerEntry = {
      ts: new Date().toISOString(),
      event: "config-fallback",
      callID: "-",
      tool: "config",
      t0: Date.now(),
      mode: watchdog.mode,
      reason,
    }
    watchdogLedger.append(entry)
  }
  return {
    dispose: async () => {
      engineForgetAll()
      jobManager.disposeAll()
      watchdog.dispose()
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
      const userDefinedForge = existing !== undefined
      agentSection[FORGE_AGENT] = {
        ...(existing ?? {}),
        description:
          (existing?.description as string | undefined) ??
          "forge — the single general-purpose coding agent: takes implementation tasks directly; planning goes through /plan into the plan harness (plans land in .opencode/plan/, with approve/close confirmation gates and tick discipline enforced by tools and the permission layer).",
        mode: (existing?.mode as "primary" | "subagent" | "all" | undefined) ?? "primary",
        prompt: (existing?.prompt as string | undefined) ?? FORGE_PROMPT,
      }

      // Capability probe source 1: an experimental background flag in the
      // host config (the upstream PRs gate behind such flags).
      try {
        const exp = JSON.stringify((cfg as { experimental?: unknown }).experimental ?? "")
        if (/background/i.test(exp)) nativeBackgroundSeen = true
      } catch {
        // Unreadable experimental section — probe source 2 still exists.
      }

      // Job supervisor stage 0 ONLY (D10): hide the builtin shell on the
      // PLUGIN-CREATED forge entry (runtime injection, nothing written to the
      // user's config file) — the exec surface becomes forge_shell. Stage 1
      // (native run_in_background detected) withdraws the hide and keeps
      // forge_shell as the additive layer; a user-defined forge entry,
      // jobs.keepBuiltinShell, or stage 2 also keep the builtin shell.
      if (!userDefinedForge && !jobsKeepBuiltinShell && jobStage() < 1) {
        const entry = agentSection[FORGE_AGENT] as { tools?: Record<string, boolean> }
        entry.tools = { ...(entry.tools ?? {}), shell: false, bash: false }
      }

      // /plan command — created only when the user has no command named
      // "plan" of their own. The template carries the full plan discipline
      // (the entry turn is the rulebook; no bundled skill).
      cfg.command ??= {}
      cfg.command["plan"] ??= {
        template: PLAN_COMMAND_TEMPLATE,
        description: "forge plan harness: no argument lists in-progress plans; resume continues the latest; discard abandons it; a goal enters planning discipline",
      }

      // /goal command — same no-clobber rule.
      cfg.command["goal"] ??= {
        template: GOAL_COMMAND_TEMPLATE,
        description:
          "forge goal harness (autonomous, host-verified): no argument lists goals; pause/resume/discard drive the loop; add queues; next promotes; an objective drafts a contract and arms it (--check/--contains markers become verification items)",
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
      for (const gateKey of ["plan_approve", "plan_close", "goal_write", "goal_complete", "goal_resume", "goal_discard", "forge_shell"]) {
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
    "tool.execute.before": async (input, output) => {
      if (process.env.FORGE_PERM_PROBE) {
        try {
          appendFileSync(join(tmpdir(), "forge-perm-probe.log"), `${new Date().toISOString()} before tool=${JSON.stringify(input.tool)} session=${input.sessionID}\n`)
        } catch {}
      }
      // hang-watchdog timing start (both builtin shell names count). The
      // command text feeds the Windows locator's needle branch (CIM ppid is
      // unreliable there — see src/proc-locate.ts).
      if (watchdog.mode !== "off" && (input.tool === "shell" || input.tool === "bash")) {
        const a = (output?.args ?? {}) as { command?: unknown; cmd?: unknown }
        const cmdText = typeof a.command === "string" ? a.command : typeof a.cmd === "string" ? a.cmd : undefined
        watchdog.track(input.callID, input.sessionID, input.tool, undefined, cmdText !== undefined ? commandNeedle(cmdText) : undefined)
        if (process.env.FORGE_WATCHDOG_PROBE) {
          try {
            appendFileSync(join(tmpdir(), "forge-watchdog-probe.log"), `${new Date().toISOString()} track ${input.callID} needle=${JSON.stringify(cmdText !== undefined ? commandNeedle(cmdText) : undefined)} rawArgs=${JSON.stringify(output?.args ?? null).slice(0, 200)}\n`)
          } catch {}
        }
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
      if (name === "plan_approve" || name === "plan_close" || name === "goal_write" || name === "goal_complete" || name === "goal_resume" || name === "goal_discard" || name === "forge_shell") {
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

    // Seed the session map so the write-ban works from the first tool call,
    // and drive the goal continuation loop on idle.
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
      if (event.type === "session.idle") {
        const sessionID = (event as unknown as { properties: { sessionID: string } }).properties.sessionID
        if (typeof sessionID === "string" && sessionID) {
          goalProbe(`idle event session=${sessionID}`)
          scheduleIdleContinuation(client, sessionID)
          // Completion wakes ride the same idle signal: inject only while
          // the owning session is free (never mid-turn).
          void deliverJobWakes(sessionID)
        }
      }
      if (event.type === "session.deleted") {
        const info = (event as unknown as { properties: { info: { id?: string } } }).properties.info
        if (typeof info?.id === "string" && info.id) {
          // Owner session ended: live session-scoped jobs are killed,
          // unread completions ledgered (job-supervisor spec).
          jobManager.onSessionEnd(info.id)
        }
      }
    },

    // Per-turn activity ledger for the goal no-progress detector: writes,
    // plan ticks, and goal_check count as activity; only continuation turns
    // are evaluated (turnActivity exists solely between a continuation send
    // and the following idle).
    // hang-watchdog hooks — an independent backstop for the BUILTIN shell in
    // any session (primary or delegated). forge_shell jobs carry no marker
    // and are never governed here (their own idle/maxwait/kill system owns
    // the lifecycle).
    "shell.env": async (input, output) => {
      if (watchdog.mode === "off") return
      // No callID → no marker and no timing for this call (a table keyed on
      // undefined would mis-track); the command runs, just ungoverned.
      if (!input.callID) return
      output.env[WATCHDOG_ENV_MARK] = markerValue(input.callID)
      watchdog.markSeen(input.callID)
      if (process.env.FORGE_WATCHDOG_PROBE) {
        try {
          appendFileSync(join(tmpdir(), "forge-watchdog-probe.log"), `${new Date().toISOString()} mark ${input.callID} hostpid=${process.pid}\n`)
        } catch {}
      }
    },
    "tool.execute.after": async (input) => {
      if ((input.tool === "shell" || input.tool === "bash") && watchdog.has(input.callID)) {
        watchdog.untrack(input.callID)
        if (process.env.FORGE_WATCHDOG_PROBE) {
          try {
            appendFileSync(join(tmpdir(), "forge-watchdog-probe.log"), `${new Date().toISOString()} untrack ${input.callID}\n`)
          } catch {}
        }
      }
      if (typeof input.tool !== "string") return
      const act = turnActivity.get(input.sessionID)
      if (!act) return
      if (isWriteTool(input.tool) || input.tool === "plan_tick") act.writes++
      if (input.tool === "goal_check") act.checks++
    },

    // Capability probe source 2 (read-only on the native tool): the native
    // shell tool presenting a run_in_background parameter is stage-1
    // evidence. On our own forge_shell, stage 1 prepends the native-first
    // note (the probe has latched by the time this definition ships).
    "tool.definition": async (input, output) => {
      if (input.toolID === "shell" || input.toolID === "bash") {
        const props = (output.parameters as { properties?: Record<string, unknown> } | undefined)?.properties
        if (props && "run_in_background" in props) nativeBackgroundSeen = true
      } else if (input.toolID === "forge_shell" && jobStage() === 1) {
        if (!output.description.startsWith(STAGE1_NOTE)) {
          output.description = `${STAGE1_NOTE}\n${output.description}`
        }
      }
    },

    // Session-start notices + standing reminders: injected into the system
    // prompt whenever the session has a non-terminal plan or a live goal
    // (both coexist). The relay clause makes the first reply surface them to
    // the user (no native banner API exists for plugins).
    "experimental.chat.system.transform": async (input, output) => {
      if (!input.sessionID) return
      // Job-supervisor guidance reaches EVERY session including delegated
      // ones (subagents are not in the `sessions` map — that is why this
      // push happens before the state lookup).
      if (!forgeDisabled && jobStage() < 2 && !output.system.some((s) => s.startsWith("[forge:job-guidance]"))) {
        output.system.push(
          "[forge:job-guidance] Long-running or possibly non-exiting shell commands (dev servers, watchers, installers, anything spawning detached children) go through forge_shell, never the builtin shell: it returns on idle/success/exit with a jobId instead of blocking indefinitely; manage jobs with forge_jobs. Delegated agents: collect your job results with forge_jobs poll before yielding your conclusion.",
        )
      }
      const state = sessions.get(input.sessionID)
      if (!state) return
      const active = resolveActivePlan(state)
      if (active) {
        const p = progressOf(active.doc)
        const rel = relFrom(state.worktree, active.path)
        const rule =
          active.doc.status === "draft"
            ? "while in draft, write operations are denied at the tool layer; present the plan then end your turn to await the user's review — on feedback revise via plan_write and re-present; call plan_approve only after the user explicitly approves in chat (their confirmation dialog is the final gate); /plan discard to abandon"
            : "call plan_tick immediately after each completed task; when all are done, self-check every acceptance criterion and call plan_close"
        output.system.push(
          `[forge:plan-notice] This session is bound to a plan: ${rel} (status: ${active.doc.status}, ${p.done}/${p.total} tasks done). Rule: ${rule}. If the user has not mentioned this plan yet, relay its path and progress to them in one short line at the start of your reply.`,
        )
      }
      if (forgeDisabled) return
      const goal = resolveLiveGoal(state)
      if (goal) {
        const rel = relFrom(state.worktree, goal.path)
        const d = goal.doc
        const rule =
          d.status === "active"
            ? "continue working the success criteria; call goal_check for host-run feedback and goal_complete at the gate (it re-runs every check itself); if genuinely blocked call goal_pause with the blocker"
            : "the goal is paused; if the user clearly asks to continue (e.g. 'continue'/'resume'), call goal_resume — the user confirms in a dialog; ordinary chat never reactivates it"
        output.system.push(
          `[forge:goal-notice] This session is bound to a goal: ${rel} (status: ${d.status}${d.stopReason ? `, stopped: ${d.stopReason}` : ""}, revision ${d.revision}, ${d.turnsUsed}/${d.maxTurns} turns used). Rule: ${rule}. If the user has not mentioned the goal yet, relay its path and status to them in one short line at the start of your reply.`,
        )
      }
    },

    // Goal facts survive compaction: the brief rides along in the compaction
    // prompt so post-compaction turns still follow the goal.
    "experimental.session.compacting": async (input, output) => {
      if (forgeDisabled) return
      if (!input.sessionID) return
      const state = sessions.get(input.sessionID)
      if (!state) return
      const goal = resolveLiveGoal(state)
      if (!goal) return
      const d = goal.doc
      output.context.push(
        `[forge:goal-brief] A live goal governs this session: ${relFrom(state.worktree, goal.path)} (status: ${d.status}, revision ${d.revision}, ${d.turnsUsed}/${d.maxTurns} turns used). Goal: ${d.goal}. Success criteria:\n${d.criteria
          .map((c, i) => `${i + 1}. ${c}`)
          .join("\n")}\nPost-compaction turns must keep following this goal and its constraints.`,
      )
    },

    // While the goal loop owns this session's continuation, suppress the
    // host's synthetic compaction auto-continue (no double continuation).
    // Scoped to live goals (active OR paused): a paused goal's loop is merely
    // parked, not resigned — a compaction must not hand the wheel back to the
    // host's synthetic continue behind the resume gate.
    "experimental.compaction.autocontinue": async (input, output) => {
      if (forgeDisabled) return
      if (!input.sessionID) return
      const state = sessions.get(input.sessionID)
      if (!state) return
      const goal = resolveLiveGoal(state)
      if (goal) output.enabled = false
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
type V2PluginContext = {
  agent?: {
    transform(cb: (draft: V2AgentDraft) => void | Promise<void>): Promise<unknown>
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
}

export default { id: "forge", server, setup: v2Setup }
