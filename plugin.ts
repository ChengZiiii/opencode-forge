import type { Plugin, ToolDefinition } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { execFileSync } from "node:child_process"
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs"
import { isAbsolute, join, relative } from "node:path"
import { tmpdir, homedir } from "node:os"
import {
  PlanError,
  appendTerminalSection,
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
import { killTree, pidAlive } from "./src/proc.ts"
import { setHostShell } from "./src/shell-select.ts"
import { createJobManager, type Job } from "./src/job-manager.ts"
import { HARD_MAX_WAIT_MS, POLL_WAIT_MAX_MS, adoptSurvivor, jobsLogDir, pollJob, readJobLog, startJob } from "./src/job-runner.ts"
import { createJobFence, type JobFence } from "./src/job-fence.ts"
import { createJobRegistry, registryPathFor, structuralRelocate, structuralRelocateAsync, type JobRegistry } from "./src/job-registry.ts"
import { createExitCleanup, type ExitCleanup } from "./src/host-exit.ts"
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
import { nativeLadder, loadModelsDevSnapshot, type CatalogSnapshot } from "./src/models-dev.ts"
import { validateCrewReport, type CrewSubtask, type CrewSubtaskReport, type CrewSession } from "./src/crew-gate.ts"
import { forgeAgentDef } from "./src/dispatch-tiers.ts"
import { applyDepthTranslation, resolvePinnedDepth, type DepthTranslation } from "./src/dispatch-depth.ts"
import { createForgeConfigLoader, createPoolResolver, forgeConfigPaths, type ForgeAgentDef, type LoadedForgeConfig, type PoolResolution } from "./src/forge-config.ts"

const FORGE_AGENT = "forge"

// Tool-partition vocabulary (spec: tool-partition). Harness STATE tools are
// primary-only; the exec/supervision pair rides with forge-* workers; the
// full set is hidden from every non-forge agent.
const FORGE_STATE_TOOLS = [
  "plan_write",
  "plan_tick",
  "plan_approve",
  "plan_close",
  "plan_discard",
  "goal_write",
  "goal_check",
  "goal_complete",
  "goal_pause",
  "goal_resume",
  "goal_discard",
  "crew_begin",
  "crew_close",
] as const
const FORGE_EXEC_TOOLS = ["forge_shell", "forge_jobs"] as const
const FORGE_ALL_TOOLS: readonly string[] = [...FORGE_STATE_TOOLS, ...FORGE_EXEC_TOOLS]
const FORGE_TOOL_SET = new Set<string>(FORGE_ALL_TOOLS)
const FORGE_STATE_TOOL_SET = new Set<string>(FORGE_STATE_TOOLS)
// Native agents the partition must cover even when absent from the user's
// config (materialized as minimal tools-only entries; hidden utility agents
// summary/title/compaction have no tool surface and are not touched).
const NATIVE_PARTITION_FALLBACKS = ["build", "plan", "general", "explore"] as const

const FORGE_PROMPT = `You are forge — the single general-purpose coding agent. You handle every task directly: exploration, planning, implementation, and verification. There is no agent switching.

Workflow modes are strictly user-initiated. Never enter plan or goal mode — and never call a plan_* or goal_* tool — unless the user ran /plan or /goal, unmistakably asked for that mode (e.g. "plan first", "set a goal"), or the session already carries a [forge:plan-notice] / [forge:goal-notice] for a mode they started. Ordinary task requests are normal work. Mode-specific rules arrive with those commands and notices; when a notice is present, follow it.

Subagent dispatch (task tool): when the work suits a scoped worker, prefer a configured \`forge-*\` subagent whose description matches the job. If none matches, say so plainly to the user and dispatch through the native task channel instead.`

// Channel mandate (forge-shell-mandate): the exec-surface paragraph is
// composed per config because its refusal claim is only TRUE while the exec
// partition holds. Hard wording when the forge-family builtin shell is
// hidden — on hosts that ignore injected tools maps (paseo) the tool stays
// VISIBLE but every call is belt-refused, so the prompt must say so up
// front instead of teaching it one wasted round-trip at a time. Preference
// wording under the keepBuiltinShell escape hatch (the builtin tool is
// legitimately present there). No paragraph at all under supervisor
// retirement, and the bare FORGE_PROMPT under v2 (no tool domain — the
// claim would be false there).
function forgePromptText(opts: { hardRefusal: boolean }): string {
  const mandate = opts.hardRefusal
    ? "Exec surface: every shell command — quick ones included — runs through the forge_shell tool. The builtin shell/bash tools are refused on this agent; never try them first, not even for trivial commands."
    : "Exec surface: prefer the forge_shell tool for every shell command — quick ones included; it is this agent's exec surface, and the builtin shell exists only as an explicit escape hatch."
  return `${FORGE_PROMPT}\n\n${mandate} Long-running or non-exiting commands: forge_shell with run_in_background, then collect results via forge_jobs.`
}

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
  "FAMILY GUARD (step 0, before anything else): if you do not have the plan_write tool in your available tools, you are not in a forge session — STOP now: execute nothing below (including the directory listing), and tell the user that /plan belongs to the forge agent, who should switch to forge (Tab) and rerun it there.",
  "",
  "Current .opencode/plan/ directory:",
  "!`ls -1 .opencode/plan 2>/dev/null || echo '(empty)'`",
  "",
  "Route on the argument above (decide silently; do not recite this routing text to the user):",
  '- Argument empty: for every non-terminal plan (status draft or approved) in the directory above, read its frontmatter and task checkboxes, then report to the user: path, status, progress (x/y ticked). Ask whether to resume one or start something new.',
  '- Argument "resume": pick the most recently updated non-terminal plan, summarize its remaining unticked tasks to the user in one short list, then continue executing it — tick each task the moment it is done (plan_tick). If none exists, say so.',
  '- Argument "discard": call the plan_discard tool with a short reason, then tell the user the plan was abandoned and writes are restored. If the work is NOT ending but moving to another harness — crew orchestration (/crew) or a goal contract (/goal) — pass supersede with the successor artifact path (e.g. ".opencode/crew/2026-10-01-....md") so the plan is marked superseded instead, with the successor recorded in the plan file.',
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
  "Boundaries: /plan discard abandons the plan (terminal, file kept as history, writes restored) — pass supersede (the successor artifact path) when the work moves to crew/goal rather than ends, marking it superseded; /plan resume continues an unfinished plan from its remaining tasks. Work expected to span multiple sessions or days of multi-file change is spec work (e.g. OpenSpec), not plan work — say so once and let the user choose.",
  "",
].join("\n")

// /goal routes the same way: empty = status listing, pause/resume/next/discard
// subcommands, "add ..." queues an inert goal, anything else is a new goal
// statement whose contract markers (--check/--contains/--success/...) become
// structured goal_write fields.
const GOAL_COMMAND_TEMPLATE = [
  '(forge goal harness routing. Argument: "$ARGUMENTS")',
  "",
  "FAMILY GUARD (step 0, before anything else): if you do not have the goal_write tool in your available tools, you are not in a forge session — STOP now: execute nothing below (including the directory listing), and tell the user that /goal belongs to the forge agent, who should switch to forge (Tab) and rerun it there.",
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

// sessionID -> current agent name (tool-partition family gate). Primary
// source: chat.message (earliest per-turn signal); belt: chat.params (always
// carries the agent, fires for task-spawned sessions too). Bounded by
// session.deleted eviction. Unknown = no gate behavior (fail-open for refusal
// belts, no injection for push paths).
const sessionAgents = new Map<string, string>()

function isForgeFamilyAgent(name: unknown): boolean {
  if (typeof name !== "string") return false
  const n = name.toLowerCase()
  return n === FORGE_AGENT || n.startsWith("forge-")
}

function sessionIsForgeFamily(sessionID: string | undefined): boolean {
  if (!sessionID) return false
  return isForgeFamilyAgent(sessionAgents.get(sessionID))
}

// Third map source (strongest): every plugin-tool execution context carries
// the calling session's agent verbatim. Harness tools are forge-family-only
// post-partition, so a tool call is an authoritative speaker statement.
function noteToolAgent(context: { sessionID?: string; agent?: unknown } | undefined): void {
  if (context && typeof context.sessionID === "string" && context.sessionID && typeof context.agent === "string" && context.agent) {
    sessionAgents.set(context.sessionID, context.agent)
  }
}

// Captured in the config hook; flips the tool getter and skips every config
// injection when the user sets agent["forge"].disable = true (one-knob
// return-to-native, forge-agent spec).
let forgeDisabled = false

// ---------------------------------------------------------------------------
// Forge subagents + depth injection (spec: forge-subagents; change
// simplify-dispatch-to-static-agents). Module-level state mirrors the job
// supervisor's style.
// ---------------------------------------------------------------------------

// Hierarchical pool materialization (change hierarchical-pool-materialization,
// spec: forge-subagents — "Hierarchical pool materialization on shared
// hosts"). The old last-init-wins loader singleton was the tear source: a
// shared host re-initializes plugins with different directories, flipping the
// anchor mid-host (roster promised by the /crew template, then refused by the
// crew_begin gate). The replacement is an APPEND-ONLY anchor set: every
// server() initialization appends its effective directory (deduped by
// normalized form); [0] is the primary anchor and nothing is ever removed.
// Anchor flips can only ADD pools; file truth (edits/creations/deletions)
// still hot-applies through the resolver's mtime caches on every resolve.
const hostAnchors: string[] = []
let poolResolver: ReturnType<typeof createPoolResolver> | null = null
// Last config-hook resolution snapshot (roster surfaces + test seam); chat
// params and the crew gate resolve FRESH per call (hot-apply parity).
let poolResolution: PoolResolution | null = null

// Anchor normalization: resolved real path, backslashes + case-folding on
// win32 — "C:/Temp1" and "c:\temp1\" cannot double-add.
function normalizeAnchorDir(dir: string): string {
  let p = (dir ?? "").trim()
  if (!p) return ""
  try {
    p = realpathSync(p)
  } catch {
    // Missing/unresolvable (e.g. tests with fake fs): keep the trimmed input.
  }
  if (process.platform === "win32") return p.replace(/\//g, "\\").toLowerCase()
  return p
}

function rememberHostAnchor(dir: string): void {
  const normalized = normalizeAnchorDir(dir)
  if (!normalized) return
  if (!hostAnchors.includes(normalized)) hostAnchors.push(normalized)
  if (!poolResolver) {
    poolResolver = createPoolResolver({ homeDir: process.env.FORGE_TEST_FORGE_HOME ?? homedir() })
  }
}

// Union resolve over the anchor set (fresh every call — the resolver's
// caches make repeat resolves cheap). Null only before the first server()
// initialization (tests calling tools directly).
function resolvePools(): PoolResolution | null {
  if (!poolResolver || hostAnchors.length === 0) return null
  return poolResolver.resolve(hostAnchors)
}
// Session-anchored loaders (crew guidance + workspace-mismatch discovery):
// bounded cache keyed on the session anchor; the host loader above stays the
// materialization source of truth.
const sessionAnchorLoaders = new Map<string, ReturnType<typeof createForgeConfigLoader>>()
function loaderForAnchor(anchor: string): ReturnType<typeof createForgeConfigLoader> {
  const key = anchor || "-"
  let l = sessionAnchorLoaders.get(key)
  if (!l) {
    l = createForgeConfigLoader({ projectDir: anchor, homeDir: process.env.FORGE_TEST_FORGE_HOME ?? homedir() })
    sessionAnchorLoaders.set(key, l)
    while (sessionAnchorLoaders.size > 8) {
      const oldest = sessionAnchorLoaders.keys().next().value
      if (oldest === undefined) break
      sessionAnchorLoaders.delete(oldest)
    }
  }
  return l
}
// Crew orchestration state (spec: crew-harness, change
// add-crew-execution-mode-gate): in-memory and session-bound — a host restart
// kills it honestly and a new /crew starts fresh. A registered crew starts
// PENDING (the execution-mode choice is the user's) and is armed to EXECUTING
// by an explicit {execution} call — or born armed in one call when a live
// active goal governs the session (contract-delegated orchestration). The map
// holds ACTIVE crews only: converted / abandoned / closed crews are deleted
// (their record file is the history). The declared subtask plan (registered at
// crew_begin) is the crew_close gate's source of truth.
type CrewMode = "pending" | "executing"
type CrewEntry = { objective: string; startedAt: string; subtasks: CrewSubtask[]; mode: CrewMode; recordPath: string | null }
const crews = new Map<string, CrewEntry>()

// Crew record file (change add-crew-execution-mode-gate, D7): an
// inspectable, compaction-recovery HISTORY artifact under the session
// workspace's .opencode/crew/ — the same sessionAnchor chain as plan/goal
// artifacts. Record-only: it never resumes a dead crew (host restart still
// ends the crew honestly; a stale record is inert). All appends are
// fail-soft — the record is history, never a gate.
function crewRecordPathFor(worktree: string, objective: string): string {
  const dir = join(worktree, ".opencode", "crew")
  const date = localDateNow()
  const slug = slugifyGoal(objective) || "crew"
  let name = `${date}-${slug}.md`
  let n = 2
  while (existsSync(join(dir, name))) name = `${date}-${slug}-${n++}.md`
  return join(dir, name)
}

// lineage (change plan-supersession-and-lineage, 4.3): an EXPLICIT free-text
// origin (e.g. the plan artifact path this crew descends from) is recorded as
// a first-class header line; the plugin never infers lineage by linking a
// recently-terminal plan.
function writeCrewRecord(path: string, objective: string, anchor: string, subtasks: CrewSubtask[], lineage?: string): void {
  mkdirSync(join(path, ".."), { recursive: true })
  writeFileSync(
    path,
    [
      `# Crew Record: ${objective}`,
      "",
      `- registered: ${nowIso()}`,
      `- anchor: ${anchor}`,
      ...(lineage ? [`- lineage: ${lineage}`] : []),
      "",
      `## Declared plan (${subtasks.length})`,
      ...subtasks.map((s, i) => `${i + 1}. ${s.title}${s.agent ? ` → ${s.agent}` : ""}`),
      "",
    ].join("\n") + "\n",
    "utf8",
  )
}

function appendCrewRecord(path: string | null, heading: string, lines: string[]): void {
  if (!path) return
  try {
    appendFileSync(path, [`## ${nowIso()} — ${heading}`, ...lines, ""].join("\n") + "\n", "utf8")
  } catch {
    // fail-soft by design
  }
}

// A live ACTIVE goal owned by this session governs it: the goal contract's
// arming dialog already authorized autonomous orchestration, so crew gates
// (the pending pause and the close/abandon asks) go internal (D9).
function governingGoalFor(sessionID: string | undefined): boolean {
  if (!sessionID) return false
  const state = stateForBan(sessionID)
  if (!state) return false
  const goal = resolveLiveGoal(state)
  return Boolean(goal && goal.doc.status === "active" && goal.doc.session === sessionID)
}

function crewPendingChoiceLines(): string[] {
  return [
    "[forge:crew] The crew is PENDING — execution has NOT started. Present the execution-mode choice to the user and END YOUR TURN (every task dispatch is refused while the crew pends):",
    `RELAY FIRST: tell the user the crew record path (it leads this output) alongside this choice — the record is on disk from the registration moment, and the user must hear it.`,
    `  1. supervised waves NOW — when the user says go, call crew_begin {execution: "waves"} and run the wave discipline;`,
    `  2. convert to a goal contract — call crew_begin {execution: "goal"} (the crew ends as a conversion record; no extra dialog here), then draft goal_write with arm=true folding the declared subtasks into criteria/checks — the arm dialog is the user's gate;`,
    `  3. standby — no call; the crew waits until armed or abandoned.`,
  ]
}

// models.dev snapshot (optional ladder verification for depth injection):
// loaded in the config hook, null when unavailable (verbatim pass-through).
let modelsDevCatalog: CatalogSnapshot | null = null
// Bounded once-per-agent diagnostics for untranslatable depth words
// (spec: inject nothing + record a finding; never break the session).
const depthFindingNotes = new Map<string, string>()
// Last config-hook result snapshots (test seam only — no behavior reads them).
let crewCommandSnapshot: { template: string; description: string } | null = null
let materializedSnapshot: Record<string, Record<string, unknown>> = {}

// sessionID -> frozen translation: the chat.params injection table. The FIRST
// request of a forge-agent session freezes the translation (D3 stability:
// never rewritten mid-session even if forge.json changes under it); later
// requests of the same session re-apply it verbatim.
const sessionDepths = new Map<string, { translation: DepthTranslation }>()

// Provider option-shape families (inherited from the dispatch era). Explicit
// and conservative: an unknown provider id injects NOTHING — never guessed.
const OPENAI_FAMILY = new Set(["openai", "opencode", "openrouter", "groq", "xai", "azure", "github-copilot", "deepseek", "together", "vercel", "opus"])
const ANTHROPIC_FAMILY = new Set(["anthropic"])
const ZAI_FAMILY = new Set(["zai", "zai-coding-plan"])

function dispatchProviderFamily(providerID: string): "openai" | "anthropic" | "zai" | null {
  if (OPENAI_FAMILY.has(providerID)) return "openai"
  if (ANTHROPIC_FAMILY.has(providerID)) return "anthropic"
  if (ZAI_FAMILY.has(providerID)) return "zai"
  return null
}


// ---------------------------------------------------------------------------
// Job supervisor (forge_shell / forge_jobs): non-blocking shell execution
// with a four-condition completion race, session-owned jobs, and a
// completion wake. See openspec job-supervisor spec + design.
// ---------------------------------------------------------------------------

// Plugin options (second server argument), captured at load.
let jobsMode: "auto" | "forge" | "native" = "auto"
let jobsKeepBuiltinShell = false
// jobs.survive: "never" (default — param may still opt a job in), "always"
// (param may still opt a job out), "deny" (survive is off and cannot be
// enabled per-call — the explicit user deny wins over everything).
let jobsSurviveMode: "never" | "always" | "deny" = "never"

// Resolve config + per-call flag. Throws on the one forbidden combination.
export function effectiveSurvive(config: "never" | "always" | "deny", param: boolean | undefined): boolean {
  if (config === "deny") {
    if (param === true) throw new Error("[forge] jobs.survive is explicitly denied in config; a per-call survive=true cannot override it.")
    return false
  }
  if (param !== undefined) return param
  return config === "always"
}

// Lazy lifecycle wiring (started with the first job of this host process):
// persistent survivor registry, the Windows job-object fence, the exit-matrix
// cleanup, and adoption of survivors from PREVIOUS host runs. Lazy so merely
// importing the plugin (tests, disabled installs) spawns nothing.
let jobFence: JobFence | null = null
let jobRegistry: JobRegistry | null = null
let exitCleanup: ExitCleanup | null = null
let jobsLifecycleStarted = false

function ensureJobLifecycle(): { registry: JobRegistry | null; fence: JobFence | null } {
  if (jobsLifecycleStarted) return { registry: jobRegistry, fence: jobFence }
  jobsLifecycleStarted = true
  const registry = createJobRegistry(registryPathFor(jobLogDir))
  jobRegistry = registry
  // Previous-run survivors: adopt the alive, ledger the dead (POSIX orphan
  // detection rides the same scan — there is no kernel fence there).
  const { adopted, dead } = registry.rescan(pidAlive, structuralRelocate)
  for (const entry of adopted) {
    adoptSurvivor(jobManager, entry, { registry, logDir: jobLogDir, relocate: structuralRelocate })
  }
  for (const entry of dead) {
    jobLedgerSink({ at: new Date().toISOString(), kind: "orphan-job", jobId: entry.id, session: entry.ownerSession, detail: `previous-run survivor pid ${entry.pid} is dead (cmd: ${entry.cmd.slice(0, 120)})` })
  }
  jobFence = process.env.FORGE_TEST_NO_FENCE === "1"
    ? null // wiring tests run without a real watcher (its stdin pipe would
      // hold the test process's event loop open; fence behavior is covered
      // by job-fence.test.mjs fakes + the live 4.1b check)
    : createJobFence({
        onDegrade: (reason) => {
          jobLedgerSink({ at: new Date().toISOString(), kind: "fence-degraded", jobId: "-", session: "-", detail: reason })
        },
      })
  exitCleanup = createExitCleanup(jobManager, {
    graceMs: 3_000,
    after: () => {
      jobFence?.dispose()
    },
  })
  return { registry, fence: jobFence }
}

// Stage matrix (partition era, tool-partition spec): the forge-side exec
// partition holds regardless of any host background capability, so `auto` and
// `forge` are equivalent. Only the manual `native` mode retires the
// supervisor — tools unregistered and the builtin-shell hide withdrawn in the
// same stroke, so the forge agent is never left without an exec surface.
function jobStage(): 0 | 2 {
  if (jobsMode === "native") return 2
  return 0
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

const jobManager = createJobManager({
  sink: jobLedgerSink,
  // Wake push at queue time (job-read-consumption D6): a completion that
  // arrives while the owning session is ALREADY idle has no future idle
  // edge to ride — the old idle-transition-only sweep would let it sit
  // until the delivery window abandoned it. When the session is known-idle,
  // deliver now; busy sessions stay on the idle-edge path.
  onWakeQueued: (job) => {
    if (idleJobSessions.has(job.ownerSession)) void deliverJobWakes(job.ownerSession)
  },
})

// Message-send client for completion wakes (promptAsync: fire-and-forget,
// does not block the plugin fiber) and session lookups for handoff roots.
type JobClient = {
  session: {
    promptAsync?: (opts: unknown) => Promise<unknown>
    get?: (opts: unknown) => Promise<unknown>
  }
}
let jobClient: JobClient | null = null

// Sessions believed idle (job-read-consumption D6): chat.message marks a
// turn in flight (busy), session.idle marks it over. Unknown sessions are
// treated as busy — they keep the conservative idle-edge delivery path.
const idleJobSessions = new Set<string>()

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

// Unified session anchor (change align-forge-config-discovery): the
// session's real worktree, then the session's OWN directory
// (ToolContext.directory / session record — a degenerate global-project
// worktree never shadows it), then the host launch directory. Sessions in
// other directories anchor their plan/goal state and crew guidance here
// instead of inheriting the frozen launch anchor.
function sessionAnchor(context: { worktree?: string; directory?: string }): string {
  const viaDir = effectiveWorktree(context.worktree, context.directory)
  if (viaDir && !isRootish(viaDir)) return viaDir
  return hostWorktree || (context.worktree ?? "").trim() || (context.directory ?? "").trim()
}

// Where a plan_* tool call for this context should anchor: the session's real
// worktree, with the session directory and launch directory as fallbacks.
function worktreeFor(context: { sessionID: string; worktree: string; directory?: string; agent?: unknown }): string {
  noteToolAgent(context)
  return sessionAnchor(context) || context.worktree
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
    // Terminal lifecycle narrative (spec): the dated close section carrying
    // the per-criterion pass/evidence summary the model already submitted
    // lands in the SAME write as the done flip — one atomic writeFileSync.
    const closedAt = nowIso()
    const closed = appendTerminalSection(
      transitionStatus(readFileSync(active.path, "utf8"), "done", closedAt),
      "closed",
      { reason: "completion gate passed (user confirmed)", checks: args.checks as CloseCheck[] },
      closedAt,
    )
    writeFileSync(active.path, closed)
    context.metadata({ title: `Plan done: ${active.doc.goal}` })
    return {
      title: "plan done",
      output: `Plan completed and closed (done): ${relFrom(state.worktree, active.path)}. All ${args.checks.length} self-checks passed. Terminal section "## ${closedAt} — closed" appended with the per-criterion verdicts.`,
    }
  },
})

const planDiscardTool = tool({
  description:
    "Abandon the session's active plan (draft/approved -> abandoned) and lift the draft write ban. Pass `supersede` (the successor artifact's path or identifier, e.g. a .opencode/crew/ or .opencode/goal/ file) when the work is not ending but moving to another harness (crew orchestration, a goal contract): the plan then becomes superseded instead of abandoned, with the successor recorded. Either way a dated terminal section carrying the reason verbatim (a missing reason lands as `reason: (none given)`) is appended to the file in the SAME write as the status flip, and the file stays in .opencode/plan/ as history. Invoke via /plan discard or directly when the user cancels the task.",
  args: {
    reason: tool.schema.string().optional().describe("Short reason recorded in the reply and in the appended terminal section, verbatim"),
    supersede: tool.schema
      .string()
      .optional()
      .describe(
        "Successor artifact's path or identifier (crew record, goal contract, ...); when present the plan becomes superseded instead of abandoned and this value is persisted as the successor reference"
      ),
  },
  execute: async (args, context) => {
    const state = ensureSession(context.sessionID, worktreeFor(context))
    const active = resolveActivePlan(state)
    if (!active) throw new PlanError("No plan to abandon in this workspace.")
    // Supersession is opt-in and never inferred (spec "Discard exit"): an
    // absent/blank supersede argument is a plain abandonment. The dated
    // narrative and the frontmatter status flip land in ONE atomic write.
    const successor = (args.supersede ?? "").trim()
    const superseding = successor.length > 0
    const target = superseding ? "superseded" : "abandoned"
    const exitedAt = nowIso()
    const next = appendTerminalSection(
      transitionStatus(readFileSync(active.path, "utf8"), target, exitedAt),
      superseding ? "superseded" : "abandoned",
      { reason: args.reason, ...(superseding ? { successor } : {}) },
      exitedAt,
    )
    writeFileSync(active.path, next)
    state.planPath = undefined
    const section = `## ${exitedAt} — ${target}`
    context.metadata({ title: superseding ? `Plan superseded: ${active.doc.goal}` : `Plan abandoned: ${active.doc.goal}` })
    return {
      title: superseding ? "plan superseded" : "plan abandoned",
      output: superseding
        ? `Plan superseded (not abandoned): ${relFrom(state.worktree, active.path)}. Terminal section "${section}" appended (successor: ${successor}). Write operations are restored.`
        : `Plan abandoned: ${relFrom(state.worktree, active.path)}. Terminal section "${section}" appended. Write operations are restored.`,
    }
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
  "This tool is the forge agent's exec surface for every shell command — quick ones included. Long-running or possibly non-exiting commands (dev servers, watchers, installers, anything spawning detached children) should start with run_in_background and collect results via forge_jobs.",
  "Interpreter: commands run under the host-preferred shell — the PowerShell family on Windows (git-bash only on machines without PowerShell), the login shell with bash preferred on POSIX — the same interpreter the host's builtin shell tool uses.",
].join("\n")

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
    survive: tool.schema.boolean().optional().describe("Opt this job OUT of dying with the host: it keeps running after opencode exits, recorded in the persistent registry so the next run can poll/kill it (config jobs.survive sets the default; an explicit config deny cannot be overridden)"),
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
    const survive = effectiveSurvive(jobsSurviveMode, args.survive)
    let successPattern: RegExp | null = null
    if (args.success_pattern) {
      try {
        successPattern = new RegExp(args.success_pattern)
      } catch (err) {
        throw new Error(`Invalid success_pattern: ${(err as Error).message}`)
      }
    }
    const { registry, fence } = ensureJobLifecycle()
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
      ...(survive ? { survive: true, registry: registry ?? undefined } : { fence, relocate: structuralRelocate, relocateAsync: structuralRelocateAsync }),
    })
    if (survive) {
      return {
        title: `job started (survives host exit): ${started.job.id}`,
        output: [
          `[forge:job] Started in background — SURVIVES host exit (no fence, no exit kill).`,
          `jobId: ${started.job.id}`,
          `logPath: ${started.job.logPath}`,
          "Recorded in the persistent registry: the next opencode run can poll/log/kill it via forge_jobs. Stop it explicitly when done.",
        ].join("\n"),
      }
    }
    context.metadata({ title: `forge_shell: ${args.command.slice(0, 60)}` })
    if (args.run_in_background === true) {
      return {
        title: `job started: ${started.job.id}`,
        output: [`[forge:job] Started in background.`, `cwd: ${cwd}`, `jobId: ${started.job.id}`, `logPath: ${started.job.logPath}`, "Track with forge_jobs poll; a [forge:job-complete] message arrives on exit."].join("\n"),
      }
    }
    const r = await started.settle
    if (r.status === "exited") {
      return {
        title: `exit ${r.exitCode ?? "?"}`,
        output: [
          `[forge:job] Command finished (exit=${r.exitCode ?? "none"}).`,
          `cwd: ${cwd}`,
          `jobId: ${started.job.id}`,
          `Output was delivered in full above — terminal evidence: the job self-cleared from the registry (no wake fires, no forge_jobs clear needed).`,
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
          `cwd: ${cwd}`,
          r.keptAlive
            ? `The process was kept alive as job ${started.job.id} (stop it with forge_jobs kill when done).`
            : `The process tree was terminated (keep_alive=false) — terminal evidence: job ${started.job.id} self-cleared from the registry (no wake, no clear needed).`,
          `output:\n${r.outputTail}`,
        ].join("\n"),
      }
    }
    return {
      title: `still running (${Math.round(r.idleForMs / 1000)}s idle)`,
      output: [
        `[forge:job] Still running — ${Math.round(r.idleForMs / 1000)}s without new output (or the wait budget ran out). The process is alive as job ${started.job.id}.`,
        `cwd: ${cwd}`,
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
    "Manage forge_shell jobs. Actions: list (all jobs, newest first); poll {jobId, waitMs<=30000} — bounded wait for NEW output or exit, drains it (polling a finished job consumes it: the entry self-clears and no wake fires); log {jobId, offset?, limit?} — line paging over the on-disk log (omitted offset = tail window, default 200 lines); kill {jobId} — terminate the job's whole process tree; clear {jobId} — drop a finished job from the registry (only un-polled early-returned/background jobs need this — synchronously consumed jobs self-clear at completion, and a terminal poll consumes the entry); handoff {jobId} — rebind ownership to the root session so the job survives this (sub)session's end. A delegated agent MUST poll its jobs before yielding its conclusion.",
  args: {
    action: tool.schema.string().describe(`One of: ${FORGE_JOBS_ACTIONS.join(", ")}`),
    jobId: tool.schema.string().optional().describe("Job id from forge_shell (required for every action except list)"),
    waitMs: tool.schema.number().int().nonnegative().optional().describe("poll: bounded in-call wait (clamped to 30000)"),
    offset: tool.schema.number().int().nonnegative().optional().describe("log: first line index; omitted = tail window"),
    limit: tool.schema.number().int().positive().optional().describe("log: max lines (default 200)"),
  },
  execute: async (args, context) => {
    if (jobStage() >= 2) throw new Error("[forge] The job supervisor is retired on this host.")
    noteToolAgent(context)
    const action = String(args.action ?? "")
    if (!FORGE_JOBS_ACTIONS.includes(action)) {
      throw new Error(`Unknown action "${action}" — use one of: ${FORGE_JOBS_ACTIONS.join(", ")}.`)
    }
    if (action === "list") {
      ensureJobLifecycle()
      const rows = jobManager.list().map((j) => `${j.id}  ${j.state}${j.exitCode !== null ? `(${j.exitCode})` : ""}${j.succeededAt ? "*" : ""}  ${j.previousRun ? "previous-run" : j.survive ? "survive" : j.scope}  ${j.cmd.slice(0, 60)}`)
      return { title: `jobs (${rows.length})`, output: rows.length > 0 ? rows.join("\n") : "(no jobs)" }
    }
    if (!args.jobId) throw new Error(`Action "${action}" requires jobId.`)
    const job = jobManager.get(args.jobId)
    if (!job) {
      throw new Error(
        jobManager.consumed(args.jobId)
          ? `Job ${args.jobId} was already consumed: a terminal-evidence foreground return delivered its complete output inline, so it self-cleared from the registry — no wake fires and no clear is needed.`
          : `No job ${args.jobId} in the registry (finished jobs age out; the on-disk log may still exist).`,
      )
    }
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
        output: [
          ...(page.windowed ? [`(log exceeds ${8}MB — showing the most recent window; read the file directly for full history: ${job.logPath})`] : []),
          page.lines.length > 0 ? page.lines.join("\n") : "(empty)",
        ].join("\n"),
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
      output: `[forge:job] ${job.id}: promoted to plugin-global scope${target ? ` and rebound to root session ${target}` : ""}; it now survives this session's end.`,
    }
  },
})




// /crew discipline (spec: crew-harness, change simplify-dispatch-to-static-agents):
// a template rulebook + an in-memory registry. Waves are batches of parallel
// native `task` calls (results return in-turn); the declared subtask plan
// registered at crew_begin is the crew_close gate's source of truth. The
// template is COMPOSED PER CONFIG at the config hook: with configured agents
// it carries the orchestration rulebook plus the live agent roster; with an
// empty agent set it becomes the initialization guidance (hard gate, D10) —
// the only configuration invitation in the plugin.
const CREW_INIT_TEMPLATE = [
  "(forge crew orchestration. Argument: \"$ARGUMENTS\")",
  "",
  "FAMILY GUARD (step 0, before anything else): if you do not have the crew_begin tool in your available tools, you are not in a forge session — STOP now and tell the user that /crew belongs to the forge agent, who should switch to forge (Tab) and rerun it there.",
  "",
  "CREW IS NOT INITIALIZED: no forge subagents are materialized across the whole host anchor set (zero pools). Refuse to enter orchestration and tell the user this feature needs a one-time setup, offering BOTH options:",
  "",
  "1. The user configures it themselves: create either layer — MERGED, the project layer overrides the global one per agent id (the project file is the nearest .opencode/forge.json walking up from the workspace root; a .opencode/forge.json in any anchor subdirectory additionally forms a namespaced sub-pool family, its ids materializing as forge-<ns>-<id>):",
  "{paths}",
  "",
  "Two axes, distinct: POOLS follow host directories (the host's anchor set); SESSION ARTIFACTS (plan/goal/crew records) follow the session. A forge.json in a directory no host anchor covers is not dispatchable on this host.",
  "",
  "2. Or, ONLY if the user explicitly asks you to configure it in this conversation, you may write the file yourself through the normal write path. NEVER write forge.json without that explicit go-ahead. When you configure it: name ids as PLAIN role words WITHOUT the `forge-` prefix — the plugin materializes every id as `forge-<id>` automatically (a `forge-`-prefixed id doubles up as `forge-forge-coder` and is auto-stripped with a warning). Give EVERY agent a SHORT prompt derived from the role the user asked for — one or two sentences describing its job (the user trims or extends from there); write a long prompt ONLY when the user explicitly asks for that agent. For sub-pool files, ALSO include a proposed short stable `pool` namespace (a [a-z0-9-] word up to 24 chars — e.g. \"aa\" for a devAa specialist pool) so the materialized ids survive directory renames.",
  "",
  "Template (JSONC — comments allowed): ids are plain role words (research, coder, ...) — the plugin adds the `forge-` prefix at materialization; `model` + `thoughtLevel` are an ATOMIC PAIR — set BOTH to pin the brain and depth (model = exact provider/model identity; thoughtLevel = none/low/medium/high/max or a native level name), or NEITHER for an Auto worker that inherits the parent session's model; exactly one of the two is rejected. Optional per agent: `prompt` — a short role description; an explicit prompt FULLY overrides the built-in role (only the ids `research` and `review` carry built-ins; any other id without a prompt gets a generic one-liner and will not know its job). Optional top level: `pool` — the file's namespace.",
  "{template}",
  "",
  "After the file is saved: file edits, creations, and deletions apply at the next config hook — NO host restart is needed. Only the anchor set itself is fixed at host start: host re-initializations add anchors and pools, they never remove them.",
].join("\n")

function crewOrchestrationTemplate(resolution: PoolResolution | null): string {
  const families = resolution?.families ?? []
  const familyLines = families.map((f) => {
    const label = f.primary ? "root pool (PRIMARY, plain ids)" : `pool ${f.ns} (forge-${f.ns}-*)`
    return `  - ${label}: ${f.file} — ${f.materializedIds.map((id) => `forge-${id}`).join(", ") || "no agents"}`
  })
  return [
    "(forge crew orchestration. Argument: \"$ARGUMENTS\")",
    "",
    "FAMILY GUARD (step 0, before anything else): if you do not have the crew_begin tool in your available tools, you are not in a forge session — STOP now and tell the user that /crew belongs to the forge agent, who should switch to forge (Tab) and rerun it there.",
    "",
    "Configured forge subagents (task-tool vocabulary), grouped by pool:",
    ...(familyLines.length > 0 ? familyLines : ["  (none)"]),
    "",
    "You are entering CREW ORCHESTRATION discipline for this session (single subject: do not switch agents). The macro contract above the crew may come from an approved plan, a spec change, or inline text — the discipline is identical in all three cases and never requires a plan. Follow it exactly:",
    "",
    "1. REGISTER: call `crew_begin` with the objective AND the declared subtask plan (subtasks[]: one {title} per subtask, optionally naming the intended forge-* agent). When the macro contract descends from a plan artifact, pass its path as the optional `lineage` argument (e.g. lineage: \".opencode/plan/2026-10-01-my-plan.md\") — the descent is recorded as a first-class line in the crew record header; lineage is never inferred. Reconnaissance BEFORE registration is free (task calls included). If crew_begin refuses (a crew is already active here, or a plan draft is active), STOP and tell the user why — never start a second crew. A wrong plan is fixed by abandoning and re-crewing (crew_close {abandon: true, reason}), never by improvising outside the declared plan.",
    '2. THE PAUSE: registration enters a PENDING crew — execution has NOT started. STOP and present the user the three execution-mode choices (supervised waves now / convert to a goal contract / standby), then END YOUR TURN. Arm per the user\'s choice: waves → crew_begin {execution: "waves"}; conversion → crew_begin {execution: "goal"} followed by goal_write (arm=true — its dialog is the user\'s gate) folding the declared subtasks into criteria/checks; standby → no call. EXCEPTION: while a live active goal governs this session, register with execution: "waves" in the SAME call — the crew is born armed (the goal contract already authorized orchestration) and crew_close / abandon stay ask-free under that goal.',
    "3. WAVES, NEVER FLOODS (armed crews only): execute subtasks in waves of parallel native `task` calls (subagent_type = the matching forge-* agent; a wave's results return within the calling turn). Launch the next wave ONLY after the previous wave's results are in. GUI / computer-use subtasks are mutually exclusive within a wave (the desktop is a singleton resource — at most ONE in flight; non-GUI subtasks still parallelize freely), and GUI walkthroughs use the `computer` tool rather than DIY shell screenshot pipelines.",
    "4. MISSING ROLE: when a subtask needs a role no configured forge-* agent matches, run that subtask through a native task call anyway AND tell the user about the gap — suggest configuring the missing role in forge.json.",
    "5. VERIFY: judge each subtask strictly against its acceptance-evidence statement from the task result text. A result that does not meet the statement is a failure even if the worker sounded confident.",
    "6. RETRY AT MOST ONCE: a failed subtask may be retried once with an adjusted prompt or agent. If the retry also fails, record the subtask as FAIL with BOTH failure reports visible (attempts[]). Do not retry twice, do not paper over a failure.",
    "7. CLOSE: when every declared subtask has a verdict, call `crew_close` with the full report (title/verdict/evidence per subtask; attempts[] for FAILs). The gate cross-checks the report against the declared plan — a declared subtask missing from the report refuses the close, and so does an undeclared one. The user confirms the closing dialog (ask-free while a goal governs the session).",
  ].join("\n")
}

const crewBeginTool = tool({
  description:
    'Register this session\'s crew (from /crew) with its DECLARED subtask plan — the crew starts PENDING: the execution-mode choice (waves / convert to goal / standby) is the user\'s. Dual-purpose: called with {execution} ONLY (no objective/subtasks) it ARMS the pending crew — "waves" lifts the dispatch belt, "goal" ends the crew as a conversion record (the following goal_write arm dialog is the user\'s gate). One-call register+arm ({objective, subtasks, execution:"waves"}) is legal ONLY while a live active goal governs the session (born armed, never pends). Refuses: active crew, plan draft, missing/duplicated subtasks. Crew state is in-memory: a host restart ends it honestly.',
  args: {
    objective: tool.schema.string().optional().describe("One-line crew objective (from /crew) — required on registration, ABSENT on the arm call"),
    execution: tool.schema.string().optional().describe('Arm action: "waves" (supervised waves — lifts the belt) or "goal" (convert to a goal contract). Alone = arm the pending crew; with objective+subtasks = one-call born-armed registration, legal only under a governing active goal.'),
    subtasks: tool.schema.array(tool.schema.object({
      title: tool.schema.string().describe("Short unique subtask title — the crew_close report must use these exact titles"),
      agent: tool.schema.string().optional().describe("Intended forge-* agent id for this subtask, when one matches"),
    })).describe("The declared subtask plan — decompose the objective into these before any execution; crew_close cross-checks the report against exactly this list"),
    lineage: tool.schema.string().optional().describe("Free-text origin of the macro contract — e.g. the plan artifact path this crew descends from (.opencode/plan/<date>-<slug>.md). Recorded as a first-class lineage: line in the crew record header and disclosed in the registration output. Explicit argument only — never inferred from recently-terminal plans."),
  },
  execute: async (args, context) => {
    noteToolAgent(context)
    const state = stateForBan(context.sessionID)
    const active = state ? resolveActivePlan(state) : null
    if (active && active.doc.status === "draft") {
      throw new Error(
        "[forge:crew] A plan is in draft; crew orchestration is denied during planning. Three exits: " +
          "plan_approve puts the plan to user approval (an APPROVED plan does not block /crew — only a draft does); " +
          "/plan discard abandons the plan outright; " +
          '/plan discard {supersede: "<successor path or id>"} moves the work into this crew (the plan becomes superseded, the successor recorded).',
      )
    }
    // Hard initialization gate (spec: crew-harness — "Unconfigured crew
    // initialization gate"): keyed on the POOL-RESOLVED set across the whole
    // anchor set — that is what the native task tool can dispatch (the union
    // never flips: re-initializations only add pools). Session-anchored
    // discovery drives the RESIDUAL mismatch disclosure: a workspace file no
    // host anchor covers is named with the anchor guidance, never masked as
    // plain "unconfigured".
    const resolution = resolvePools()
    const hostIds = resolution ? Object.keys(resolution.agents) : []
    const anchor = sessionAnchor(context)
    const sessionLoaded = anchor ? loaderForAnchor(anchor).load() : null
    const sessionProject = sessionLoaded?.projectPath ?? null
    // Coverage comparison is case-folded on win32 (family files derive from
    // the normalized anchor, session discovery from the raw path).
    const foldPath = (p: string) => (process.platform === "win32" ? p.replace(/\//g, "\\").toLowerCase() : p)
    const sessionCovered =
      sessionProject === null ||
      (resolution?.families.some((f) => foldPath(f.file) === foldPath(sessionProject)) ?? false)
    if (hostIds.length === 0) {
      const primaryAnchorDir = hostAnchors[0] ?? hostWorktree
      const anchorNote = hostAnchors.length > 1 ? `host anchors: ${hostAnchors.join(", ")}` : `launched from ${primaryAnchorDir || "an unresolvable directory"}`
      const paths = forgeConfigPaths({ projectDir: primaryAnchorDir || undefined, homeDir: process.env.FORGE_TEST_FORGE_HOME ?? homedir() })
      const lines = [
        `[forge:crew] CREW IS NOT INITIALIZED on this host: no forge subagents are materialized across the whole anchor set (${anchorNote}). Crew orchestration is unavailable until the user sets it up.`,
        `Two layers, MERGED (the project layer overrides the global one per agent id): ${paths.project} (nearest .opencode/forge.json walking up from the workspace) OR ${paths.global}. Sub-pool files (.opencode/forge.json in an anchor's subdirectories) contribute additional namespaced families.`,
        'Two axes, distinct: POOLS follow host directories (the anchor set above); SESSION ARTIFACTS (plan/goal/crew records) follow the session. A forge.json in an unanchored directory is not dispatchable on this host.',
        'Template (JSONC): top-level optional "pool" names this file\'s namespace (short stable [a-z0-9-] up to 24 chars — sub-pool ids materialize as forge-<ns>-<id>); {"agents": {"research": {"model": "provider/model", "thoughtLevel": "low", "prompt": "short role description"}}}',
        "Agent ids are plain role words WITHOUT the `forge-` prefix — the plugin materializes each id as `forge-<id>` (namespaced pools: `forge-<ns>-<id>`); a prefixed id is auto-stripped with a warning.",
        "The user may configure it themselves, or ask you to write the file — only on their explicit go-ahead. When you write it: give every agent a SHORT prompt from the role the user asked for (one or two sentences; long only on explicit request), and INCLUDE a proposed short stable `pool` namespace for sub-pool files so ids survive directory renames. File edits, creations, and deletions apply at the next config hook — no host restart; only the anchor set itself is fixed at host start (re-initializations add pools, never remove).",
      ]
      if (sessionLoaded && Object.keys(sessionLoaded.agents).length > 0 && sessionProject && !sessionCovered) {
        lines.push(
          `NOTE: this session's workspace DOES have a forge.json (${sessionProject}) with usable agents — but NO host anchor covers it (${anchorNote}). A host initialization in that workspace adds its pools; or fold the agents into the global layer.`,
        )
      }
      throw new Error(lines.join("\n"))
    }
    const execution = typeof args.execution === "string" ? args.execution.trim().toLowerCase() : ""
    if (execution && execution !== "waves" && execution !== "goal") {
      throw new Error('[forge:crew] execution must be "waves" or "goal".')
    }
    const objectiveText = String(args.objective ?? "").trim()
    const raw = Array.isArray(args.subtasks) ? args.subtasks : []
    // ---- ARM PATH ({execution} only — shape-disjoint from registration) ----
    if (execution && !objectiveText && raw.length === 0) {
      const crew = crews.get(context.sessionID)
      if (!crew) {
        throw new Error("[forge:crew] No active crew to arm (crew state is in-memory and dies on host restart). Register one first: crew_begin {objective, subtasks}.")
      }
      if (crew.mode !== "pending") {
        throw new Error(`[forge:crew] This crew is already armed (${crew.mode}) — execute "${crew.objective}" instead of re-arming.`)
      }
      // D9: a goal-governed session is already autonomous — conversion to a
      // second goal contract is for standalone crews only.
      if (execution === "goal" && governingGoalFor(context.sessionID)) {
        throw new Error('[forge:crew] execution:"goal" is refused under a governing goal — this session already runs inside an active goal contract. Run supervised waves (arm or one-call register), or pause/discard the goal first if conversion is truly intended.')
      }
      if (execution === "goal") {
        crews.delete(context.sessionID)
        appendCrewRecord(crew.recordPath, "converted to goal", [
          "The crew ends here as a conversion record; the objective moves to a goal contract.",
          ...crew.subtasks.map((s, i) => `${i + 1}. ${s.title}${s.agent ? ` → ${s.agent}` : ""}`),
        ])
        return {
          title: `crew converted: ${crew.objective.slice(0, 60)}`,
          output: [
            `[forge:crew] Crew ended as a CONVERSION record: ${crew.objective}`,
            "Now draft the goal contract: goal_write with arm=true, folding the declared subtasks below into its criteria and verification checks. The arm confirmation dialog is the user's gate for the whole autonomous path — do not ask again here.",
            `Declared subtasks to fold in (${crew.subtasks.length}):`,
            ...crew.subtasks.map((s, i) => `  ${i + 1}. ${s.title}${s.agent ? ` → ${s.agent}` : ""}`),
          ].join("\n"),
        }
      }
      crew.mode = "executing"
      appendCrewRecord(crew.recordPath, "armed (waves)", ["The user chose supervised waves; the dispatch belt is lifted."])
      return {
        title: `crew armed: ${crew.objective.slice(0, 60)}`,
        output: [
          `[forge:crew] Crew ARMED for supervised waves: ${crew.objective}`,
          `Declared plan (${crew.subtasks.length}):`,
          ...crew.subtasks.map((s, i) => `  ${i + 1}. ${s.title}${s.agent ? ` → ${s.agent}` : ""}`),
          "Proceed with the wave discipline: waves of parallel native task calls (next wave after the previous results) → per-subtask evidence verdicts → at most one retry → crew_close with the full report covering every declared subtask.",
        ].join("\n"),
      }
    }
    // ---- REGISTRATION PATH ----
    if (!objectiveText) throw new Error("crew_begin requires a non-empty objective (from /crew <objective>).")
    if (raw.length === 0) throw new Error("[forge:crew] crew_begin requires subtasks[] — declare the plan before executing (decompose the objective into titled subtasks).")
    const seen = new Set<string>()
    const subtasks: CrewSubtask[] = []
    for (const s of raw) {
      const title = String((s as { title?: unknown })?.title ?? "").trim()
      if (!title) throw new Error("[forge:crew] every subtask needs a non-empty title.")
      const key = title.toLowerCase()
      if (seen.has(key)) throw new Error(`[forge:crew] duplicate subtask title "${title}" — titles must be unique (they are the crew_close matching key).`)
      seen.add(key)
      const agent = String((s as { agent?: unknown })?.agent ?? "").trim()
      subtasks.push(agent ? { title, agent } : { title })
    }
    const existing = crews.get(context.sessionID)
    if (existing) {
      throw new Error(`[forge:crew] This session already has an active crew: "${existing.objective}" (started ${existing.startedAt}). Finish and close it with crew_close before starting another.`)
    }
    // One-call register+arm is goal-governed ONLY (D9); conversion-at-register
    // is meaningless (nothing to convert yet) — refuse both precisely.
    if (execution === "waves" && !governingGoalFor(context.sessionID)) {
      throw new Error('[forge:crew] crew_begin cannot self-arm outside a governing goal: register with {objective, subtasks} only — the pause is the user\'s decision point, armed by a follow-up crew_begin {execution} call per their choice.')
    }
    if (execution === "goal") {
      throw new Error('[forge:crew] execution:"goal" converts an already-registered PENDING crew — register the plan first (no execution), then convert. Under a governing goal, only "waves" one-call arming is legal (the loop already owns the goal).')
    }
    const governed = execution === "waves"
    // lineage (plan-supersession-and-lineage 4.3): recorded ONLY when the
    // caller explicitly passed it — never inferred from a recently-terminal
    // plan.
    const lineage = String(args.lineage ?? "").trim()
    // Crew record (D7): fail-soft — its absence never blocks the crew. Shares
    // the sessionAnchor chain with plan/goal artifacts; record-only, never a
    // resume mechanism.
    const anchorDir = anchor || hostWorktree
    let recordPath: string | null = null
    let recordNote = ""
    if (anchorDir) {
      try {
        recordPath = crewRecordPathFor(anchorDir, objectiveText)
        writeCrewRecord(recordPath, objectiveText, anchorDir, subtasks, lineage || undefined)
        recordNote = `Crew record (inspectable history; NOT a resume mechanism): ${relFrom(anchorDir, recordPath)}`
      } catch {
        recordPath = null
        recordNote = "Crew record could not be written (fail-soft; the crew still runs)."
      }
    }
    crews.set(context.sessionID, { objective: objectiveText, startedAt: nowIso(), subtasks, mode: governed ? "executing" : "pending", recordPath })
    appendCrewRecord(recordPath, governed ? "registered (born armed under a governing goal)" : "registered (pending)", subtasks.map((s, i) => `${i + 1}. ${s.title}${s.agent ? ` → ${s.agent}` : ""}`))
    // Residual workspace-mismatch disclosure: the session's own discovery
    // found a forge.json NO host anchor covers — its roles are NOT
    // dispatchable here; say so instead of letting the crew discover it by
    // failure.
    let disclosure = ""
    if (sessionProject && !sessionCovered) {
      const localOnly = Object.keys(sessionLoaded?.agents ?? {})
      if (localOnly.length > 0) {
        disclosure = `\n[forge:crew] NOTE: this session's workspace has its own forge.json (${sessionProject}) defining ${localOnly.map((id) => `forge-<ns>-${id} (namespaced by its pool)`).join(", ")} — NOT dispatchable on this host (no anchor covers it; anchors: ${hostAnchors.join(", ") || "none"}). A host initialization in that workspace adds its pools, or fold the agents into the global layer.`
      }
    }
    // Origin disclosure (generalized D8): always name WHERE the dispatchable
    // roster came from, grouped by pool with the primary marked — never let
    // the model narrate the launch-anchor pool as "global". Bounded at 8
    // pools; the remainder are counted, not listed.
    const familyLines: string[] = []
    const families = resolution?.families ?? []
    for (const f of families.slice(0, 8)) {
      const label = f.primary ? "root pool (PRIMARY, plain ids)" : `pool ${f.ns} (forge-${f.ns}-*)`
      familyLines.push(`   - ${label}: ${f.file} — ${f.materializedIds.map((id) => `forge-${id}`).join(", ") || "no agents"}`)
    }
    if (families.length > 8) familyLines.push(`   - …and ${families.length - 8} more pools`)
    // plan-supersession-and-lineage 4.1: the crew record path LEADS the
    // output — first block, before the objective summary and the declared
    // plan (the plan tools' "Plan created:" prominence); the roster-origin
    // disclosure follows the declared plan.
    const lines = [
      ...(recordNote ? [recordNote] : []),
      ...(lineage ? [`Lineage: ${lineage}`] : []),
      governed
        ? `[forge:crew] Crew registered UNDER THE GOVERNING GOAL — born armed, never pends. Objective: ${objectiveText}`
        : `[forge:crew] Crew registered PENDING for this session (execution has NOT started). Objective: ${objectiveText}`,
      `Declared plan (${subtasks.length}):`,
      ...subtasks.map((s, i) => `  ${i + 1}. ${s.title}${s.agent ? ` → ${s.agent}` : ""}`),
      `Dispatchable roster origin — ${families.length} pool${families.length === 1 ? "" : "s"} across the host anchor set${hostAnchors.length > 0 ? ` (anchors: ${hostAnchors.join(", ")})` : ""}:`,
      ...familyLines,
      ...(disclosure ? [disclosure] : []),
    ]
    if (governed) {
      lines.push(
        "Goal-delegated orchestration: the governing goal contract already authorized this crew — run the wave discipline NOW (crew gates stay internal to the loop; crew_close and abandon are ask-free under this goal), and re-shard via crew_close {abandon: true, reason} + a fresh one-call crew_begin when the decomposition proves wrong.",
        "Wave discipline: waves of parallel native task calls (next wave after the previous results) → per-subtask evidence verdicts → at most one retry → crew_close with the full report covering every declared subtask.",
      )
    } else {
      lines.push(...crewPendingChoiceLines())
    }
    return {
      title: `crew registered: ${objectiveText.slice(0, 60)}`,
      output: lines.join("\n"),
    }
  },
})

const crewCloseTool = tool({
  description:
    "Close this session's crew. Two paths: (a) final report — the gate cross-checks the report against the declared subtask plan (every declared subtask needs a verdict and an evidence statement; an undeclared subtask refuses the close; FAIL requires both failure reports); (b) abandon {abandon: true, reason} — the re-shard exit: no verdict requirements, ends the crew with an abandonment record, frees the session for a fresh crew_begin. Both paths are ask-gated UNLESS a live active goal governs the session (then ask-free — the goal's own gates are the user boundary).",
  args: {
    report: tool.schema.array(tool.schema.object({
      title: tool.schema.string().describe("Subtask title — must match a title declared at crew_begin"),
      verdict: tool.schema.string().describe("PASS or FAIL"),
      evidence: tool.schema.string().describe("Acceptance evidence: what the result contained that satisfies the acceptance statement"),
      attempts: tool.schema.array(tool.schema.string()).optional().describe("For FAIL: both failure reports (attempt and retry)"),
    })).optional().describe("The full crew report — one entry per declared subtask (not needed when abandoning)"),
    abandon: tool.schema.boolean().optional().describe("true = abandon the crew (re-shard / standby-cancel): ends it with an abandonment record, no verdicts required"),
    reason: tool.schema.string().optional().describe("Why the crew is abandoned (recorded in the crew record)"),
  },
  execute: async (args, context) => {
    noteToolAgent(context)
    const crew = crews.get(context.sessionID)
    if (!crew) throw new Error("[forge:crew] No active crew in this session (crew state is in-memory and dies on host restart). Start one with /crew <objective>.")
    // Abandon path (D4): the re-shard exit — usable from PENDING (standby
    // cancel) and EXECUTING (wrong decomposition, including mid-goal-loop
    // re-sharding). Ask-gated unless a governing goal owns the session (D9).
    if (args.abandon === true) {
      const reason = String(args.reason ?? "").trim() || "(no reason given)"
      if (!governingGoalFor(context.sessionID)) await gate(context.ask, "crew_close", `Abandon crew: ${crew.objective}`)
      crews.delete(context.sessionID)
      appendCrewRecord(crew.recordPath, "abandoned", [`mode at abandon: ${crew.mode}`, `reason: ${reason}`, "The session is free for a fresh crew_begin (re-shard or new objective)."])
      return {
        title: `crew abandoned: ${crew.objective.slice(0, 60)}`,
        output: [
          `[forge:crew] Crew ABANDONED: ${crew.objective}`,
          `mode at abandon: ${crew.mode}`,
          `reason: ${reason}`,
          "The session is free for a fresh crew_begin — register the corrected plan next (it starts PENDING again unless a governing goal arms it in the same call).",
        ].join("\n"),
      }
    }
    const report = (args.report ?? []) as CrewSubtaskReport[]
    const check = validateCrewReport(report, crew.subtasks)
    if (!check.ok) {
      throw new Error(`[forge:crew] crew_close refused — the report does not match the declared plan:\n${check.gaps.map((g) => `- ${g}`).join("\n")}\nThe crew stays active; complete or correct the report and call crew_close again.`)
    }
    if (!governingGoalFor(context.sessionID)) await gate(context.ask, "crew_close", `Close crew: ${crew.objective}`)
    crews.delete(context.sessionID)
    const fails = report.filter((r) => String(r.verdict).toUpperCase() === "FAIL").length
    appendCrewRecord(crew.recordPath, "closed", [
      `subtasks: ${report.length} (PASS ${report.length - fails}, FAIL ${fails})`,
      ...report.map((r) => `- ${r.title}: ${String(r.verdict).toUpperCase()} — ${String(r.evidence).slice(0, 200)}`),
    ])
    return {
      title: `crew closed: ${crew.objective.slice(0, 60)}`,
      output: [
        `[forge:crew] Crew closed: ${crew.objective}`,
        `subtasks: ${report.length} (PASS ${report.length - fails}, FAIL ${fails})`,
        ...report.map((r) => `- ${r.title}: ${String(r.verdict).toUpperCase()} — ${String(r.evidence).slice(0, 200)}`),
        crew.recordPath
          ? `Crew record (history): ${crew.recordPath}`
          : "This output is the crew's record (crew state is in-memory; nothing persists).",
      ].join("\n"),
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
  if (!forgeDisabled) {
    tools.crew_begin = crewBeginTool
    tools.crew_close = crewCloseTool
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
    `Crew layer: you own it under this goal — when parallel decomposition serves a criterion, register crews with crew_begin {objective, subtasks, execution: "waves"} in ONE call (born armed; no pause mid-loop), dispatch forge-* waves, and re-shard a wrong decomposition via crew_close {abandon: true, reason} plus a fresh registration. Crew gates stay internal to this loop.`,
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
    // Send-time family re-check (tool-partition): the speaker may have
    // switched agents between scheduling and this send — forge never drives
    // a non-forge turn.
    if (!sessionIsForgeFamily(sessionID)) {
      goalProbe(`skip: agent switched to non-forge before send session=${sessionID}`)
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
      const briefText = goalBriefText(state, goal)
      await client.session.prompt({
        path: { id: sessionID },
        body: { parts: [{ type: "text", text: briefText }] },
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
  // Family gate at scheduling time (tool-partition): a non-forge session's
  // idle never arms a timer — no continuation, not even a session.get probe.
  if (!sessionIsForgeFamily(sessionID)) {
    goalProbe(`skip: non-forge agent at schedule session=${sessionID}`)
    return
  }
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
  const effectiveInitDir = effectiveWorktree(input.worktree, input.directory) || input.directory || ""
  // Session-state fallback axis (plan/goal/crew record binding when a session
  // carries no observable anchor): last-init-wins is honest here — the most
  // recent initialization directory is the most likely current project. The
  // POOL axis is deliberately different: it resolves from the frozen anchor
  // set (see hostAnchors) and never flips.
  hostWorktree = effectiveInitDir
  // Pool axis (hierarchical-pool-materialization): append-only — a shared
  // host's re-initializations only ever ADD anchors/pools.
  rememberHostAnchor(effectiveInitDir)
  const client = input.client as unknown as GoalClient
  jobClient = input.client as unknown as JobClient
  const jobsOpts = (options as { jobs?: { mode?: unknown; keepBuiltinShell?: unknown; survive?: unknown } } | undefined)?.jobs
  if (jobsOpts?.mode === "auto" || jobsOpts?.mode === "forge" || jobsOpts?.mode === "native") jobsMode = jobsOpts.mode
  jobsKeepBuiltinShell = jobsOpts?.keepBuiltinShell === true
  if (jobsOpts?.survive === "never" || jobsOpts?.survive === "always" || jobsOpts?.survive === "deny") jobsSurviveMode = jobsOpts.survive

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
      // Exit matrix trigger (idempotent): graceful-then-force every live
      // non-survive job, then end the fence watcher. Survive jobs keep
      // running by contract — their registry entries await the next host.
      exitCleanup?.trigger("dispose")
      jobManager.disposeAll()
      watchdog.dispose()
      sessions.clear()
    },

    config: async (cfg) => {
      const agentSection = cfg.agent ?? (cfg.agent = {})
      const forgeUserCfg = agentSection[FORGE_AGENT] as { disable?: boolean } | undefined
      forgeDisabled = forgeUserCfg?.disable === true
      if (forgeDisabled) return

      // Host-aligned interpreter (align-shell-interpreter): a host-configured
      // shell, when the merged config exposes one, takes precedence over the
      // plugin's platform chain (fail-soft: absent/blank = platform chain).
      setHostShell(typeof (cfg as { shell?: unknown }).shell === "string" ? (cfg as { shell?: string }).shell : undefined)

      // Native build/plan agents are NOT disabled (partition era): forge
      // coexists with them in the Tab cycle, and their isolation from forge
      // tooling is handled by the tool-partition injections below.

      // Default subject (D13): the host falls back to "build" once a build
      // agent exists — coexistence must not flip the default away from
      // forge. `??=` keeps an explicit user `default_agent` (any value) as
      // the user's own choice.
      ;(cfg as { default_agent?: string }).default_agent ??= FORGE_AGENT

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
        prompt:
          (existing?.prompt as string | undefined) ??
          // Channel mandate composed per gate (forge-shell-mandate): hard
          // refusal while the partition holds, preference under
          // keepBuiltinShell, bare prompt under retirement.
          (jobStage() < 2 ? forgePromptText({ hardRefusal: !jobsKeepBuiltinShell }) : FORGE_PROMPT),
      }

      // Job-supervisor option sanity is unchanged; the capability probe is
      // retired — no experimental-flag scan, no native-parameter sniffing.

      // Exec partition (tool-partition): the forge agent's builtin shell is
      // hidden unconditionally — probe-independent, and INCLUDING on a
      // user-defined forge entry (key-merge: only shell/bash are written,
      // every other field of the entry stands). jobs.keepBuiltinShell is the
      // single escape hatch; supervisor retirement withdraws the hide
      // together with the tool registration.
      if (!jobsKeepBuiltinShell && jobStage() < 2) {
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
      // /crew command is composed per config LATER in this hook (it needs the
      // loaded agent set for the roster/init-gate templates).
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
      for (const gateKey of ["plan_approve", "plan_close", "goal_write", "goal_complete", "goal_resume", "goal_discard", "forge_shell", "crew_close"]) {
        if (permSection[gateKey] !== "deny") permSection[gateKey] = "ask"
      }

      // forge subagents: load forge.json (hot-apply), materialize the static
      // subagents WITH their pinned models, and compose the /crew command for
      // the current agent set. Findings surface through the diagnostics log —
      // never silently swallowed, never an AI-facing configuration invitation.
      // Anchor-set pool resolution (hierarchical-pool-materialization): the
      // UNION materializes — anchor flips only add pools (D1/D2); file truth
      // (edits/creations/deletions) hot-applies through the resolver's mtime
      // caches on every resolve.
      const resolution = resolvePools()
      poolResolution = resolution
      for (const finding of resolution?.findings ?? []) {
        console.warn(`[forge:config] ${finding.level}: ${finding.message}`)
      }
      materializedSnapshot = {}
      for (const [matId, agent] of Object.entries(resolution?.agents ?? {})) {
        const id = `forge-${matId}`
        if (agentSection[id] !== undefined) continue // no-clobber
        const entry = forgeAgentDef(matId, agent.def)
        agentSection[id] = entry
        materializedSnapshot[id] = entry
      }

      // Tool-partition injections (spec: tool-partition, design D3/D9). Runs
      // after materialization so every forge-* entry — plugin-created or
      // user-defined (family rules follow the name, not the author) — is
      // covered. Key-merge only: user-written fields and explicit `true`
      // entries outside the forge family stand.
      // (a) forge-* workers: harness STATE tools are primary-only.
      for (const id of Object.keys(agentSection)) {
        if (!id.startsWith("forge-")) continue
        const entry = agentSection[id] as { tools?: Record<string, boolean> }
        const tools = { ...(entry.tools ?? {}) }
        for (const t of FORGE_STATE_TOOLS) if (tools[t] !== true) tools[t] = false
        entry.tools = tools
      }
      // (b) every other agent: ALL plugin tools hidden (explicit `true`
      // respected — the user's own opt-in wins).
      for (const [id, entry] of Object.entries(agentSection)) {
        if (id === FORGE_AGENT || id.startsWith("forge-")) continue
        const e = entry as { tools?: Record<string, boolean> }
        const tools = { ...(e.tools ?? {}) }
        for (const t of FORGE_ALL_TOOLS) if (tools[t] !== true) tools[t] = false
        e.tools = tools
      }
      // (c) native agents absent from config: minimal partition entries
      // (host merges by name — probe-verified no native-definition loss).
      for (const native of NATIVE_PARTITION_FALLBACKS) {
        if (agentSection[native] !== undefined) continue
        const tools: Record<string, boolean> = {}
        for (const t of FORGE_ALL_TOOLS) tools[t] = false
        agentSection[native] = { tools }
      }

      // models.dev snapshot: optional ladder verification for depth injection.
      // Unavailable -> null -> verbatim pass-through (the provider judges).
      if (process.env.FORGE_TEST_NO_DISPATCH_FETCH === "1") {
        modelsDevCatalog = null
      } else {
        try {
          const snapshot = await loadModelsDevSnapshot()
          modelsDevCatalog = snapshot.catalog
        } catch {
          modelsDevCatalog = null
        }
      }

      // /crew command — composed per config: orchestration rulebook with the
      // live roster when agents exist; the initialization guidance (hard gate)
      // when none do. Overwritten on every config hook while plugin-owned (a
      // template marker prefixes our text), never while user-defined.
      cfg.command ??= {}
      const existingCrew = cfg.command["crew"] as { template?: string } | undefined
      if (!existingCrew || String(existingCrew.template ?? "").startsWith("(forge crew")) {
        const agentCount = Object.keys(resolution?.agents ?? {}).length
        const primaryAnchorDir = hostAnchors[0] ?? undefined
        const template =
          agentCount > 0
            ? crewOrchestrationTemplate(resolution ?? null)
            : CREW_INIT_TEMPLATE.replaceAll("{paths}", `   - ${forgeConfigPaths({ projectDir: primaryAnchorDir, homeDir: process.env.FORGE_TEST_FORGE_HOME ?? homedir() }).project}\n   - ${forgeConfigPaths({ projectDir: primaryAnchorDir, homeDir: process.env.FORGE_TEST_FORGE_HOME ?? homedir() }).global}`)
              .replaceAll("{template}", JSON.stringify({ pool: "short-stable-namespace (optional, [a-z0-9-] up to 24 chars — only meaningful for sub-pool files)", agents: { research: { model: "provider/model", thoughtLevel: "low", prompt: "short role description — what this agent does" } } }, null, 2).split("\n").map((l) => "   " + l).join("\n"))
        const description =
          agentCount > 0
            ? "forge crew orchestration: register a declared subtask plan, execute it in waves of parallel native task calls, close with an evidence-checked report"
            : "forge crew orchestration — NOT INITIALIZED: no forge subagents configured; invoking it shows the one-time setup guidance"
        cfg.command["crew"] = { template, description }
        crewCommandSnapshot = { template, description }
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
      // unreliable there — see src/proc-locate.ts). Family gate
      // (tool-partition): only forge-family sessions are tracked — non-forge
      // and unknown sessions carry no marker and are never intervened upon.
      if (watchdog.mode !== "off" && (input.tool === "shell" || input.tool === "bash") && sessionIsForgeFamily(input.sessionID)) {
        const a = (output?.args ?? {}) as { command?: unknown; cmd?: unknown }
        const cmdText = typeof a.command === "string" ? a.command : typeof a.cmd === "string" ? a.cmd : undefined
        watchdog.track(input.callID, input.sessionID, input.tool, undefined, cmdText !== undefined ? commandNeedle(cmdText) : undefined)
        if (process.env.FORGE_WATCHDOG_PROBE) {
          try {
            appendFileSync(join(tmpdir(), "forge-watchdog-probe.log"), `${new Date().toISOString()} track ${input.callID} needle=${JSON.stringify(cmdText !== undefined ? commandNeedle(cmdText) : undefined)} rawArgs=${JSON.stringify(output?.args ?? null).slice(0, 200)}\n`)
          } catch {}
        }
      }
      // Dispatch belt (tool-partition): a non-forge session must not spawn
      // forge-* workers (the task vocabulary is global; refusal is the only
      // per-parent control). Unknown sessions fail open.
      if (input.tool === "task") {
        const speaker = sessionAgents.get(input.sessionID)
        if (speaker !== undefined && !isForgeFamilyAgent(speaker)) {
          const a = (output?.args ?? {}) as { subagent_type?: unknown; agent?: unknown }
          const target = typeof a.subagent_type === "string" ? a.subagent_type : typeof a.agent === "string" ? a.agent : undefined
          if (target && target.toLowerCase().startsWith("forge-")) {
            throw new Error(
              `[forge:partition] Dispatch refused: "${target}" is a forge-family worker and the current agent ("${speaker}") is outside the forge family. Use the native general/explore subagents, or switch to the forge agent to dispatch forge-* workers.`,
            )
          }
        }
        // Crew pending belt (crew-harness, change add-crew-execution-mode-gate):
        // a registered-but-unarmed crew refuses EVERY task dispatch — the
        // registration→execution seam is a user decision point. Pre-registration
        // recon dispatches freely; armed and ended crews never pend here.
        const pendingCrew = input.sessionID ? crews.get(input.sessionID) : undefined
        if (pendingCrew && pendingCrew.mode === "pending") {
          throw new Error(
            `[forge:crew] Dispatch refused: the crew "${pendingCrew.objective}" is PENDING (registered, not armed). Present the execution-mode choice to the user — supervised waves now / convert to a goal contract / standby — then arm per their choice with crew_begin {execution: "waves" | "goal"}. Reconnaissance task calls are free only BEFORE registration.`,
          )
        }
      }
      // State-file boundary (tool-partition): non-forge sessions must not
      // mutate the forge state directories. Reads stay unrestricted; this is
      // a mis-touch guard, not a security boundary (those paths live inside
      // the workspace). Unknown sessions fail open.
      if ((input.tool === "write" || input.tool === "edit") && input.sessionID) {
        const speaker = sessionAgents.get(input.sessionID)
        if (speaker !== undefined && !isForgeFamilyAgent(speaker)) {
          const a = (output?.args ?? {}) as { filePath?: unknown; path?: unknown }
          const raw = typeof a.filePath === "string" ? a.filePath : typeof a.path === "string" ? a.path : undefined
          if (raw) {
            const state = stateForBan(input.sessionID)
            const base = state?.worktree ?? hostWorktree ?? ""
            const abs = (isAbsolute(raw) ? raw : join(base, raw)).replaceAll("\\", "/").toLowerCase()
            if (abs.includes("/.opencode/plan/") || abs.includes("/.opencode/goal/")) {
              throw new Error(
                `[forge:partition] Write refused: "${raw}" is inside the forge state directories (.opencode/plan, .opencode/goal), which belong to the forge agent in this workspace.`,
              )
            }
          }
        }
      }
      if (typeof input.tool === "string" && isWriteTool(input.tool)) {
        const state = stateForBan(input.sessionID)
        const active = state ? resolveActivePlan(state) : null
        if (active && active.doc.status === "draft") {
          // Session-scoped safety interop (tool-partition, D12): the draft
          // protects shared session state, so the ban binds the session, not
          // the speaker. The wording is agent-agnostic: a blocked non-forge
          // agent cannot see plan_approve and must be told the real way out.
          throw new Error(
            `[forge] A plan is in draft; write operations are denied (${input.tool}). Switch back to the forge agent to present it and complete plan approval (plan_approve), or run /plan discard to abandon the plan.`,
          )
        }
      }
      // Partition fallback belts (tool-partition fallback requirement): on
      // hosts that ignore hook-injected tools maps (the owner's paseo build —
      // E2E-verified), invisibility degrades to hard refusal. On hosts that
      // honor the maps the hidden tools never reach a call, so these belts
      // are dead code there. Placed AFTER the draft ban: during a draft the
      // write ban's message is the more precise refusal for bash.
      if (input.sessionID && typeof input.tool === "string") {
        const speaker = sessionAgents.get(input.sessionID)
        if (speaker !== undefined) {
          if (!isForgeFamilyAgent(speaker) && FORGE_TOOL_SET.has(input.tool)) {
            throw new Error(
              `[forge:partition] Tool refused: "${input.tool}" belongs to the forge agent family and the current agent ("${speaker}") is outside it. Switch to forge (Tab) to use forge tooling.`,
            )
          }
          if (isForgeFamilyAgent(speaker) && (input.tool === "shell" || input.tool === "bash") && !jobsKeepBuiltinShell && jobStage() < 2) {
            throw new Error(
              `[forge:partition] Builtin shell refused: the forge family executes through forge_shell (jobs.keepBuiltinShell or jobs.mode: "native" restores the builtin shell). Re-issue the command through forge_shell.`,
            )
          }
          // R1-degradation third quadrant (tool-partition fallback): on
          // ignore-host builds STATE tools stay visible to forge-* workers
          // but must be unusable; the refusal fires before any execution or
          // ask gate, so the call never reaches a user confirmation dialog.
          // Unknown sessions fail open (same posture as every belt above);
          // on hosts that honor injected tools maps these tools are already
          // hidden from workers, so the belt is dead code there.
          if (isForgeFamilyAgent(speaker) && speaker.toLowerCase() !== FORGE_AGENT && FORGE_STATE_TOOL_SET.has(input.tool)) {
            throw new Error(
              `[forge:partition] Tool refused: "${input.tool}" is a harness state tool reserved for the primary forge agent; "${speaker}" is a forge worker. Report your findings back to the orchestrating session — the primary agent calls ${input.tool} at the gate.`,
            )
          }
        }
      }
      // Draft-phase subagent-spawn ban is INHERITED: the native task tool is
      // in the write-ban class (isWriteTool covers "task"), so no plugin-side
      // dispatch refusal exists to maintain (spec: forge-subagents —
      // "Native-task dispatch surface").
    },

    // Family-map primary source (tool-partition): chat.message carries the
    // agent for every incoming turn (earliest per-request signal; the belt is
    // chat.params in case this hook does not fire on some host shape).
    "chat.message": async (input) => {
      if (forgeDisabled) return
      const raw = input as unknown as { sessionID?: unknown; agent?: unknown }
      if (typeof raw.sessionID === "string" && raw.sessionID) {
        // A turn just started in this session — it is busy until the next
        // session.idle (wake-push gate, job-read-consumption D6).
        idleJobSessions.delete(raw.sessionID)
        if (typeof raw.agent === "string" && raw.agent) {
          sessionAgents.set(raw.sessionID, raw.agent)
        }
      }
    },

    // Reasoning-depth injection for forge subagent sessions (spec:
    // forge-subagents — "Pinned thoughtLevel injection keyed by agent name").
    // Keyed by the AGENT NAME (stable across sessions and spawn paths — any
    // session running a forge-* agent gets its pinned depth), not a
    // per-dispatch table. The FIRST request of a session freezes the
    // translation (never rewritten mid-session); the config is re-read per
    // lookup (mtime-cached hot-apply) for NEW sessions. An untranslatable
    // word injects nothing and records a bounded once-per-agent finding; an
    // unknown provider family injects nothing, silently (not this plugin's
    // vocabulary to guess).
    "chat.params": async (input, output) => {
      if (forgeDisabled) return
      const raw = input as unknown as { sessionID?: string; agent?: unknown; model?: { providerID?: unknown; modelID?: unknown } }
      const sessionID = raw.sessionID
      if (!sessionID) return
      const agentName = typeof raw.agent === "string" ? raw.agent : (raw.agent as { name?: unknown } | undefined)?.name
      // Family-map upsert (tool-partition): fires for every request build,
      // including task-spawned sessions (probe P1).
      if (typeof agentName === "string" && agentName) sessionAgents.set(sessionID, agentName)
      if (typeof agentName !== "string" || !agentName.startsWith("forge-")) return
      const frozen = sessionDepths.get(sessionID)
      if (frozen) {
        applyDepthTranslation(output.options ?? (output.options = {}), frozen.translation)
        return
      }
      const agentId = agentName.slice("forge-".length)
      // Pool-set lookup (hierarchical-pool-materialization): the key is the
      // materialized name sans prefix (plain or <ns>-<id>); fresh resolve per
      // lookup keeps the hot-apply contract.
      const def: ForgeAgentDef | undefined = resolvePools()?.agents[agentId]?.def
      if (!def?.thoughtLevel) return
      const providerID = typeof raw.model?.providerID === "string" ? raw.model.providerID : ""
      const modelID = typeof raw.model?.modelID === "string" ? raw.model.modelID : ""
      const family = dispatchProviderFamily(providerID)
      if (!family) return // unknown provider shape: inject nothing, silently
      const { translation, findingMessage } = resolvePinnedDepth(def.thoughtLevel, family, nativeLadder(modelsDevCatalog, `${providerID}/${modelID}`))
      if (!translation) {
        if (findingMessage && !depthFindingNotes.has(agentId)) {
          depthFindingNotes.set(agentId, findingMessage)
          console.warn(`[forge:depth] agent forge-${agentId}: ${findingMessage}`)
        }
        return
      }
      sessionDepths.set(sessionID, { translation })
      applyDepthTranslation(output.options ?? (output.options = {}), translation)
    },

    // Test seam (wiring tests drive server() with stubs; same pragmatic
    // module-state style as FORGE_TEST_NO_FENCE). Not part of the plugin API.
    __forgeSubagentsTest: {
      crews: () => crews,
      depthState: (sessionID: string) => sessionDepths.get(sessionID)?.translation ?? null,
      depthFinding: (agentId: string) => depthFindingNotes.get(agentId) ?? null,
      catalog: () => modelsDevCatalog,
      setCatalog: (c: CatalogSnapshot | null) => {
        modelsDevCatalog = c
      },
      crewCommand: () => crewCommandSnapshot,
      materialized: () => materializedSnapshot,
      // Anchor-set seam (hierarchical-pool-materialization): the anchor set
      // is host-lifetime state; tests simulate a host restart by resetting.
      resetAnchors: () => {
        hostAnchors.length = 0
        poolResolver = null
        poolResolution = null
      },
      anchors: () => [...hostAnchors],
      resolveNow: () => resolvePools(),
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
          idleJobSessions.add(sessionID)
          scheduleIdleContinuation(client, sessionID)
          void deliverJobWakes(sessionID)
        }
      }
      if (event.type === "session.deleted") {
        const info = (event as unknown as { properties: { info: { id?: string } } }).properties.info
        if (typeof info?.id === "string" && info.id) {
          // Owner session ended: live session-scoped jobs are killed,
          // unread completions ledgered (job-supervisor spec).
          jobManager.onSessionEnd(info.id)
          // The frozen depth translation dies with its session (bounded table).
          sessionDepths.delete(info.id)
          // Same for the agent-family map (tool-partition).
          sessionAgents.delete(info.id)
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
      // Family gate (tool-partition): only forge-family sessions carry the
      // marker — non-forge sessions are entirely outside the watchdog, down
      // to the (invisible) environment variable.
      if (!sessionIsForgeFamily(input.sessionID)) return
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

    // Session-start notices + standing reminders: injected into the system
    // prompt whenever the session has a non-terminal plan or a live goal
    // (both coexist). The relay clause makes the first reply surface them to
    // the user (no native banner API exists for plugins).
    "experimental.chat.system.transform": async (input, output) => {
      if (!input.sessionID) return
      // Family gate (tool-partition): EVERY forge-authored system text —
      // crew-active, job guidance, plan/goal notices — is forge-family-only.
      // Unknown sessions receive nothing (fail-silent by design).
      if (!sessionIsForgeFamily(input.sessionID)) return
      // Job-supervisor guidance reaches every FORGE-FAMILY session including
      // delegated ones (subagents are not in the `sessions` map — that is why
      // this push happens before the state lookup); the family gate above
      // keeps it out of all other agents' sessions.
      const crewActive = crews.get(input.sessionID)
      if (crewActive && !output.system.some((s) => s.startsWith("[forge:crew-active]"))) {
        const modeText = crewActive.mode === "pending"
          ? "PENDING (present the execution-mode choice; every task dispatch is refused until armed)"
          : "armed (executing)"
        output.system.push(`[forge:crew-active] A crew is ${modeText} in this session: "${crewActive.objective}" (started ${crewActive.startedAt}). A second /crew must be refused; finish with crew_close when every subtask has a verdict, or crew_close {abandon: true, reason} to re-shard.`)
      }
      if (!forgeDisabled && jobStage() < 2 && !output.system.some((s) => s.startsWith("[forge:job-guidance]"))) {
        output.system.push(
          jobsKeepBuiltinShell
            ? "[forge:job-guidance] Long-running or possibly non-exiting shell commands (dev servers, watchers, installers, anything spawning detached children) go through forge_shell, never the builtin shell: it returns on idle/success/exit with a jobId instead of blocking indefinitely; manage jobs with forge_jobs. Delegated agents: collect your job results with forge_jobs poll before yielding your conclusion."
            : "[forge:job-guidance] Every shell command — quick ones included — goes through forge_shell: the builtin shell/bash tools are refused on this agent, so never try them first. forge_shell returns on exit/success/idle with a jobId instead of blocking indefinitely; long-running or non-exiting commands use run_in_background. Manage jobs with forge_jobs. Delegated agents: collect your job results with forge_jobs poll before yielding your conclusion.",
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
      // Family gate (tool-partition): the goal brief is forge-authored text.
      if (!sessionIsForgeFamily(input.sessionID)) return
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
      // Family gate (tool-partition): suppression only while the session's
      // current agent belongs to the forge family — a parked loop under a
      // non-forge speaker must not suppress the host's native behavior.
      if (goal && sessionIsForgeFamily(input.sessionID)) output.enabled = false
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
      if (draft.get(FORGE_AGENT) === undefined) {
        draft.update(FORGE_AGENT, (agent) => {
          agent.description =
            "forge — the single general-purpose coding agent: takes implementation tasks directly; planning goes through /plan into the plan harness (plans land in .opencode/plan/, with approve/close confirmation gates and tick discipline enforced by tools and the permission layer)."
          agent.system = FORGE_PROMPT
          agent.mode = "primary"
        })
      }
      // Static forge subagents (spec: forge-subagents — v2 parity): same
      // create-only discipline as the forge entry. The pool resolver reads
      // the process cwd (v2 ctx exposes no launch directory) as the single
      // anchor — plain ids, walk-up root pool plus subtree sub-pools; any
      // failure degrades to no subagents, never a throw.
      try {
        const resolver = createPoolResolver({ homeDir: process.env.FORGE_TEST_FORGE_HOME ?? homedir() })
        const resolution = resolver.resolve([process.cwd()])
        for (const [matId, agent] of Object.entries(resolution.agents)) {
          const id = `forge-${matId}`
          if (draft.get(id) !== undefined) continue // create-only
          const v1def = forgeAgentDef(matId, agent.def)
          draft.update(id, (agentDraft) => {
            agentDraft.description = v1def.description
            agentDraft.system = v1def.prompt
            agentDraft.mode = v1def.mode
            if (v1def.model !== undefined) agentDraft.model = v1def.model // Auto workers carry no model key
            agentDraft.permission = v1def.permission
          })
        }
      } catch {
        // Host-shape drift or unreadable config: skip silently (v2 contract).
      }
    })
  }
}

export default { id: "forge", server, setup: v2Setup }
