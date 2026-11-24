import type { Plugin, ToolDefinition } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { execFileSync, spawn } from "node:child_process"
import { open as fsOpen, readdir as fsReaddir, stat as fsStat } from "node:fs/promises"
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { basename, dirname, isAbsolute, join, relative } from "node:path"
import { tmpdir, homedir } from "node:os"
import {
  PlanError,
  appendPlanCheckLog,
  appendReopenSection,
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
  type PlanCheck,
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
import { OUTPUT_LIMIT, formatOutcomes, outcomesAllOk, runChecks } from "./src/run-check.ts"
import { killTree, pidAlive } from "./src/proc.ts"
import { setHostShell } from "./src/shell-select.ts"
import { createJobManager, newJobId, type Job } from "./src/job-manager.ts"
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
import { nativeLadder, loadModelsDevSnapshot, modelDepthShape, parseIdentity, modelsDevCacheDir, type CatalogSnapshot } from "./src/models-dev.ts"
import { validateCrewReport, type CrewSubtask, type CrewSubtaskReport, type CrewSession } from "./src/crew-gate.ts"
import { createNativeChildTracker, nativeChildDigestLine, nativeChildEventOutcome, nativeSessionBusy, walkNativeChildren, type NativeChildClient, type NativeChildOutcome, type NativeChildWalkView } from "./src/native-child-gate.ts"
import { forgeAgentDef, effectiveReadonlyShape } from "./src/dispatch-tiers.ts"
import { classifyExecCommand, WRITE_CLASS, interactiveBanner } from "./src/exec-classify.ts"
import { applyDepthTranslation, resolvePinnedDepth, type DepthChannel, type DepthTranslation } from "./src/dispatch-depth.ts"
import { createForgeConfigLoader, createPoolResolver, forgeConfigPaths, parseForgeJsonc, parseTopLevelKnobs, poolFileCompliance, sanitizeNamespace, type DispatchNodeConfig, type ForgeAgentDef, type ForgeMaterializeKnob, type LoadedForgeConfig, type PoolResolution } from "./src/forge-config.ts"
import { compileRosterEntry, executeRosterSync, globalAgentDirFor, planOverrideSync, planRosterSync, staleCheckForPool, VARIANT_DEPTH_WORDS, type RosterFsDeps, type SyncPlan } from "./src/roster-compile.ts"
import type { PoolProvenance } from "./src/dispatch-tiers.ts"
import { buildRgArgv, buildRgFilesArgv, dedupeFollowMatches, formatSearchOutput, parseRgFilesList, parseRgJsonStream, resolveRgBinary, type RgMatchRecord, type SearchToolKind } from "./src/search-core.ts"
import { jsSearch, type JsSearchSeams } from "./src/search-js.ts"
import { DEFAULT_POLL_INTERVAL_MS, TASK_CREATE_SEAM_ABSENT, abortChild, createChildSession, decideStaleSweep, fetchFinalMessage, applyStaleProbe, pollChild, resolveNotifyIntervalMs, resolvePollTimeoutMs, resolveStaleFloorMs, resolveStaleMode, resolveStaleMs, sendPrompt, sessionGet, staleSilentMinutes, staleThresholdCrossed, ACTIVE_TEXTFUL_OVERRIDE_NOTE, type DispatchClient, type SessionMessageLike, type StaleMode, type StaleSweepState, type TerminalStabilityState, type CreateChildInput, type CreateChildResult } from "./src/dispatch-async.ts"
import { buildRetryPrompt, classifyDispatchError, resolveMaxAttempts, resolveRetryBackoffMs } from "./src/dispatch-retry.ts"
import { createDispatchGate, type DispatchGate, type ModelIdentity } from "./src/dispatch-gate.ts"
import { withReportDelivery } from "./src/dispatch-prompt.ts"
import {
  createDispatchJournal,
  resolveJournalMax,
  type DispatchJournal,
  type DispatchJournalRecord,
  type JournalFs,
} from "./src/dispatch-journal.ts"

const FORGE_AGENT = "forge"

// Tool-partition vocabulary (spec: tool-partition). Harness STATE tools are
// primary-only; the exec/supervision pair rides with forge-* workers; the
// full set is hidden from every non-forge agent.
const FORGE_STATE_TOOLS = [
  "plan_write",
  "plan_tick",
  "plan_approve",
  "plan_close",
  "plan_reopen",
  "plan_discard",
  "goal_write",
  "goal_check",
  "goal_complete",
  "goal_pause",
  "goal_resume",
  "goal_discard",
  "crew_begin",
  "crew_close",
  // native-first-roster: the in-band roster sync — a coordinator move
  // (primary-only), same family as the crew tools.
  "forge_sync",
  // Dispatch is a coordinator move (async-dispatch design D5, task-shadow):
  // forge_dispatch is RETIRED and `task` is NOT listed here — the worker
  // recursion ban rides the materialized `permission: { task: "deny" }`
  // (dispatch-tiers), plus the primary-only refusal in the task tool's own
  // execute (belt parity).
] as const
const FORGE_EXEC_TOOLS = ["forge_shell", "forge_jobs"] as const
// Search pair (change forge-search-tools, design D6): joins the same
// partition constants — hidden from non-forge agents, available to the
// primary AND every forge-* worker regardless of shape (NOT in
// MUTATING_TOOLS, NOT ask-gated — readonly by construction).
const FORGE_SEARCH_TOOLS = ["forge_grep", "forge_glob"] as const
const FORGE_ALL_TOOLS: readonly string[] = [...FORGE_STATE_TOOLS, ...FORGE_EXEC_TOOLS, ...FORGE_SEARCH_TOOLS]
const FORGE_TOOL_SET = new Set<string>(FORGE_ALL_TOOLS)
const FORGE_STATE_TOOL_SET = new Set<string>(FORGE_STATE_TOOLS)
// Native agents the partition must cover even when absent from the user's
// config (materialized as minimal tools-only entries; hidden utility agents
// summary/title/compaction have no tool surface and are not touched).
const NATIVE_PARTITION_FALLBACKS = ["build", "plan", "general", "explore"] as const

const FORGE_PROMPT = `You are forge — the single general-purpose coding agent. You handle every task directly: exploration, planning, implementation, and verification. There is no agent switching.

Workflow modes are strictly user-initiated. Never enter plan or goal mode — and never call a plan_* or goal_* tool — unless the user ran /plan or /goal, unmistakably asked for that mode (e.g. "plan first", "set a goal"), or the session already carries a [forge:plan-notice] / [forge:goal-notice] for a mode they started. Ordinary task requests are normal work. Mode-specific rules arrive with those commands and notices; when a notice is present, follow it.

Subagent dispatch (task tool): when the work suits a scoped worker, prefer a configured \`forge-*\` subagent whose description matches the job. If none matches, say so plainly to the user and dispatch a host agent through the task tool instead.`

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
export const PLAN_COMMAND_TEMPLATE = [
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
  "1. Reconnaissance and alignment (read-only): explore with read/grep/glob, and dispatch readonly-shape forge scouts (task tool) for breadth evidence — reconnaissance dispatch to effective-readonly workers keeps this session's context lean and is allowed both BEFORE and DURING the draft. All write tools and bash are DENIED while a draft exists, and so is dispatching write-shaped workers or native agents; do not attempt them, do not ask the user to bypass. Gather concrete evidence with file:line references (verified findings, not guesses). If the goal is ambiguous or leaves meaningful choices open (scope, approach, acceptance), settle them with the user FIRST — 1-3 focused questions — and only write the draft once the shape is agreed; never plan against assumptions the user could settle in one line.",
  "2. Draft (plan_write): call plan_write with structured fields; the tool renders and validates the fixed sections, so a malformed plan cannot exist. Quality bar: goal = one line, the outcome not the activity; context = verified findings with file:line evidence, including what you ruled out and why; approach = the chosen approach AND at least one rejected alternative with the reason (a plan with no considered alternative is a guess); tasks = 3-8 concrete, independently verifiable steps, each doable in one sitting ('improve the code' is invalid; 'extract the timeout constant into config.ts and default it to 3000' is valid); risks = what could break, blast radius, rollback path; acceptance = criteria verifiable by a command, a file, or an observable behavior (vague criteria will fail the close); nonGoals = explicit out-of-scope items. To revise after feedback, call plan_write again — while in draft it overwrites the same file.",
  "3. User review, then approval (plan_approve): after plan_write, present the plan in chat — goal, chosen approach with one line why, the numbered task list, the acceptance criteria — then STOP: end your turn and wait. The user owns the review, at their own pace: feedback → revise with plan_write, re-present, and wait again; rejection → /plan discard (or re-plan together); explicit go-ahead (e.g. \"execute\", \"批准\", \"looks good\") → call plan_approve — its confirmation dialog is the final hard gate, and the user's Allow starts execution. Never call plan_approve in the same turn that presents a draft, and never implement before approval succeeds.",
  "4. Execution (tick as you go): work tasks in order; call plan_tick with the task number immediately after EACH task's work is actually done — never batch ticks, never tick ahead of reality (tick timestamps are an audit trail). If the plan turns out wrong mid-execution, do not silently improvise: tell the user what changed and either finish the affected task or ask about revising (/plan with the same goal re-enters planning).",
  "5. Completion (plan_close): when all tasks are ticked, self-check EVERY acceptance criterion with concrete evidence (file:line, command output, test result), then call plan_close — NO confirmation dialog appears. If the plan declares Verification Checks, the plugin itself re-runs the frozen check set on the host (fail-closed: a failing check refuses the close, records the run in the plan's Check Log, and the plan stays approved — that is the design working, not an inconvenience); otherwise your per-criterion self-checks gate the close. Either way an evidence summary is written into the plan file for the user to review asynchronously.",
  "",
  "Boundaries: /plan discard abandons the plan (terminal, file kept as history, writes restored) — pass supersede (the successor artifact path) when the work moves to crew/goal rather than ends, marking it superseded; /plan resume continues an unfinished plan from its remaining tasks. Work expected to span multiple sessions or days of multi-file change is spec work (e.g. OpenSpec), not plan work — say so once and let the user choose.",
  "",
].join("\n")

// /goal routes the same way: empty = status listing, pause/resume/next/discard
// subcommands, "add ..." queues an inert goal, anything else is a new goal
// statement whose contract markers (--check/--contains/--success/...) become
// structured goal_write fields.
export const GOAL_COMMAND_TEMPLATE = [
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

// /forge — the roster levers (change forge-commands, design D1/D2): ONE
// command routing on $ARGUMENTS (the /plan precedent). Templates instruct,
// never write: every effect lands in the transcript through the in-band
// tools (forge_sync / the normal write path on the user's explicit
// go-ahead). /forge sync is the manual force/debug/fallback lever — the
// default staleness-gate posture and sync:"auto" are unchanged (D5).
export const GLOBAL_RECIPE_SCAFFOLD_JSONC = [
  "{",
  '  // GLOBAL forge.json — the machine-wide FALLBACK roster (sole ownership:',
  '  // the nearest .opencode/forge.json walking up from a session\'s worktree',
  '  // IS that session\'s whole roster when it exists; this layer is a',
  '  // fallback, never a merge). Agents here materialize as forge-global-<id>',
  '  // in the host\'s global agent dir once forge_sync runs.',
  '  "agents": {',
  '    // "research": { "model": "provider/model", "thoughtLevel": "low",',
  '    //   "shape": "readonly", "prompt": "short role description" },',
  "  },",
  '  // OPTIONAL built-in overrides: uncomment and fill an entry to pin the',
  '  // host\'s built-in General/Explore subagents machine-wide. Keys are the',
  '  // built-ins\' exact LOWERCASE ids ("general" / "explore") — capitalized',
  '  // files create ambiguous duplicates, never overrides. Activating an',
  '  // entry REPLACES the built-in\'s prompt wholesale (vendor text is never',
  '  // copied) — write your own general/explore prompt. model+thoughtLevel',
  '  // pin brain and depth (an ATOMIC pair); leaving both out of an active',
  '  // entry keeps the Auto worker (inherits the parent session\'s model —',
  '  // the official default). forge_sync compiles an active entry to',
  '  // <global agent dir>/general.md|explore.md (GENERATED marker; re-comment',
  '  // the entry and sync again to garbage-collect it). A hand-written file',
  '  // of the same name is NEVER overwritten — sync refuses and discloses.',
  '  // "override": {',
  '  //   "general": { "model": "provider/model", "thoughtLevel": "low",',
  '  //     "prompt": "You are my general-purpose worker. ..." },',
  '  //   "explore": { "model": "provider/model", "thoughtLevel": "low",',
  '  //     "shape": "readonly", "prompt": "You are my codebase scout. ..." },',
  '  // },',
  "}",
].join("\n")

// Per-lever bodies live in single-source constants (change v2-command-surface
// task 2.1): the /forge router embeds them VERBATIM. The dedicated
// hyphenated commands are RETIRED (command-surface-v2-cleanup D1) — /forge is
// the single command surface, routing on its argument (sync / init / init
// global / stop).

// Step-0 family guard, parameterized by the invoking command's name.
export function forgeFamilyGuard(command: string): string {
  return `FAMILY GUARD (step 0, before anything else): if you do not have the forge_sync tool in your available tools, you are not in a forge session — STOP now: execute nothing below, and tell the user that ${command} belongs to the forge agent, who should switch to forge (Tab) and rerun it there.`
}

export const FORGE_BOUNDARIES_TEXT =
  'Boundaries: this command never writes anything by itself — every write goes through forge_sync or the normal write tool on the user\'s explicit go-ahead, transcript-visible. The staleness gate, the in-band sync default, and sync:"auto" behave exactly as without this command.'

export const SYNC_LEVER_BODY =
  'call the forge_sync tool NOW and report its output verbatim to the user — every created/updated/unchanged/gc\'d file and any error line. This is the manual force lever: the default posture (staleness gate + in-band sync; the sync:"auto" opt-in) is unchanged, so report the diff and stop there.'

export const INIT_WORKSPACE_LEAD = "draft THIS workspace's recipe (.opencode/forge.json) in-band with the user."

export const INIT_FLOW_BODY =
  "First check whether the file already exists — if it does, REFUSE to change it: read it, present a review of the existing recipe (pool namespace, roles, shapes, pinned models) and offer edits the user must explicitly approve; NEVER overwrite or rewrite it. When it does not exist: interview the user briefly (or infer from the project context — language, build system, the roles the work needs) and propose a JSONC recipe covering the pool namespace, the roles (ids as plain role words WITHOUT the forge- prefix), each agent's shape (readonly for read-only roles, write for implementers), and the model+thoughtLevel atomic pair (both to pin, neither for an Auto worker). Show the proposed file, then write it ONLY on the user's explicit go-ahead — the write goes through the normal write tool so it lands in the transcript. The file hot-applies at the next config hook; no restart is needed, and a crew retry then passes."

export const INIT_GLOBAL_SCAFFOLD_NOTE =
  "The global scaffold ships the built-in override entries (general/explore) fully COMMENTED OUT — inert until the user uncomments and fills one (activating an override replaces the built-in's prompt wholesale; the scaffold's inline comments say the same)."

export const INIT_GLOBAL_BODY =
  `same drafting flow for the GLOBAL recipe (~/.config/opencode/forge.json) — refuse-and-review when it already exists, draft in-band otherwise, write only on explicit go-ahead. ${INIT_GLOBAL_SCAFFOLD_NOTE}`

export const FORGE_HELP_ROUTE_LINE =
  "- Argument empty or unknown: tell the user the four forms in one short list — /forge sync (force a roster sync NOW and show the diff), /forge init (draft this workspace's forge.json in-band), /forge init global (draft the global forge.json with commented built-in override entries), /forge stop (cancel THIS session's in-flight and queued async dispatches) — and stop."

// Dispatch stop route body (command-surface-v2-cleanup D1): session-scoped
// cancellation. Host children are independent sessions — ESC interrupts the
// parent turn only, so without this lever a runaway worker is unkillable
// (upstream #64073). The scoping lives in the TOOL layer (forge_jobs stop
// filters by context.sessionID) — template-layer instructions are routing
// only, never trust boundaries (design D2).
export const STOP_LEVER_BODY = [
  '- Argument "stop": call forge_jobs with action "stop" (no other parameters) and relay the tool result verbatim — it cancels every in-flight ASYNC DISPATCH owned by THIS session (each child session is aborted and CONFIRMED idle; each dispatch settles as aborted and is never retried) and every QUEUED wish of this session (removed from the queue before it can spawn — nothing was running for it; it is never dispatched). A dispatch owned by another session is NOT touched: name its task id only if the user asks, and cancel it with the explicit per-id lever forge_jobs {action: "cancel", jobId: "<task-id>"}. Then STOP: no re-dispatch, no replacement work.',
  "Boundaries: cancellation is USER intent only — never stop dispatches on your own initiative; a stopped dispatch is NEVER retried by any resilience path (retry, stale reap, adoption); the aborted journal entries and the owner wakes are delivered by the plugin's terminal path, not by you.",
].join("\n")

export const FORGE_COMMAND_TEMPLATE = [
  '(forge roster levers. Argument: "$ARGUMENTS")',
  "",
  forgeFamilyGuard("/forge"),
  "",
  "Route on the argument above (decide silently; do not recite this routing text to the user):",
  `- Argument "sync": ${SYNC_LEVER_BODY}`,
  `- Argument "init": ${INIT_WORKSPACE_LEAD} ${INIT_FLOW_BODY}`,
  `- Argument "init global": ${INIT_GLOBAL_BODY} Scaffold shape:`,
  ...GLOBAL_RECIPE_SCAFFOLD_JSONC.split("\n").map((l) => `  ${l}`),
  `- ${STOP_LEVER_BODY}`,
  FORGE_HELP_ROUTE_LINE,
  "",
  FORGE_BOUNDARIES_TEXT,
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

// sessionID -> the directory of the host's LATEST `session.moved` event
// (post-move anchor re-resolution, fix-v2-crew-surface-drift 4.1). Live-probe
// fact (2.3.2 sandbox, 2026-11-21): the plugin-facing `session.get` seam does
// NOT reflect session moves — it keeps reporting the session's pre-move
// (creation-anchored) location while REST `GET /api/session/:id` shows the
// moved one. The `session.moved` event IS emitted with the new location, so
// it is the plugin's only live, in-process statement of a session's CURRENT
// workspace; the anchor resolver prefers it over the stale record. Bounded by
// session.deleted eviction like the maps above.
const sessionMovedAnchors = new Map<string, string>()
const anchorMovedNotes = new Set<string>()

// Record a host `session.moved` statement. Tolerant to payload drift (v1
// properties / v2 flat-data shapes); a degenerate directory is ignored
// (never poisons a good binding). Fail-soft by construction.
function noteSessionMoved(sessionID: unknown, directory: unknown): void {
  if (typeof sessionID !== "string" || !sessionID) return
  if (typeof directory !== "string" || !directory || isRootish(directory)) return
  sessionMovedAnchors.set(sessionID, directory)
  const existing = sessions.get(sessionID)
  if (existing) {
    // Same non-degenerate-refinement rule as ensureSession: a real move
    // statement re-binds the session map (the old binding is now stale).
    existing.worktree = directory
  }
}

// Extract the moved-directory payload of a session.moved event across the
// observed host shapes (v1 {properties:{sessionID, location:{directory}}},
// v2 flat {sessionID, location:{directory}} / {directory}).
function movedEventFields(fields: Record<string, unknown>): { sessionID: unknown; directory: unknown } {
  const loc = fields.location as { directory?: unknown } | undefined
  const directory =
    loc !== null && typeof loc === "object" && typeof loc.directory === "string"
      ? loc.directory
      : typeof fields.directory === "string"
        ? fields.directory
        : undefined
  return { sessionID: fields.sessionID ?? fields.sessionId, directory }
}

// sessionID -> current agent name (tool-partition family gate). Primary
// source: chat.message (earliest per-turn signal); belt: chat.params (always
// carries the agent, fires for task-spawned sessions too). Bounded by
// session.deleted eviction. Unknown = no gate behavior (fail-open for refusal
// belts, no injection for push paths).
const sessionAgents = new Map<string, string>()

// Exec-seal findings (readonly-exec-seal, tool-partition): bounded per
// session per WRITE-CLASS indicator — a denial throws on EVERY write-class
// call, but the console finding is recorded once per session per indicator
// class so the transcript never floods. Evicted on session.deleted like the
// maps above. `sealUnknownNotes` bounds the one-time fail-open disclosure
// for sessions whose agent cannot be resolved.
const sealFindings = new Map<string, Set<string>>()
const sealUnknownNotes = new Set<string>()

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

// Workspace pool ownership + global fallback (change sole-pool-ownership,
// spec: forge-subagents — "Workspace pool ownership and global fallback").
// hostAnchors is the registry of EVERY workspace directory the host has been
// initialized in (deduped by normalized form; no entry is privileged). It is
// NOT an append-only POOL set: pool membership is re-resolved on every call
// (each anchor's walk-up NEAREST .opencode/forge.json, stat-per-level), so a
// pool file deleted from disk disappears from materialization at the next
// resolve — deletion is real, no zombie pools. Family order and materialized
// ids derive PURELY from pool-file paths (lexicographic), never from
// registry order. Nested forge.json files deeper in a workspace's
// subtree are never collected (nothing scans subtrees). The task-dispatch
// guard scopes dispatch SESSION-LOCALLY (see tool.execute.before): the
// target's pool must be this session's workspace pool, or the global layer
// when the workspace has none (fallback, not merge).
const hostAnchors: string[] = []
let poolResolver: ReturnType<typeof createPoolResolver> | null = null
// Last config-hook resolution snapshot (roster surfaces + test seam); chat
// params and the crew gate resolve FRESH per call (hot-apply parity).
let poolResolution: PoolResolution | null = null
// Session-domain pool gate disclosures (sole-pool-ownership): bounded
// once-per-session note for the unknown-anchor fail-open posture. Evicted
// on session.deleted.
const poolGateUnknownNotes = new Set<string>()
// anchor-pool-preference: bounded disclosure set for the pooled-preference
// substitution (authoritative record rebound pool-less after a restart-resume
// while the in-memory binding still owns a pool) — one note per session.
const anchorPrefNotes = new Set<string>()

// Win32 path fold for ownership comparisons (family files derive from the
// normalized anchor, session discovery from the raw path).
const foldPath = (p: string) => (process.platform === "win32" ? p.replace(/\//g, "\\").toLowerCase() : p)

// The global fallback layer's forge.json path (test-home aware).
function globalPoolPathOf(): string {
  return forgeConfigPaths({ homeDir: process.env.FORGE_TEST_FORGE_HOME ?? homedir() }).global
}

// ---------------------------------------------------------------------------
// native-first-roster (design D4/D5): materialize-mode state + the roster
// sync primitives. The v1 server() entry NEVER touches these — its
// behavior is byte-equal to the pre-change build (the 788-test baseline
// is the regression net). The v2 setup() entry sets v2HostSeen and reads
// the `materialize` knob (default "native" — owner decision 2026-11-21,
// no deprecation window; "runtime" stays selectable as the escape hatch).
// ---------------------------------------------------------------------------
let v2HostSeen = false
let v2MaterializeMode: ForgeMaterializeKnob = "native"

function nativeRosterActive(): boolean {
  return v2HostSeen && v2MaterializeMode === "native"
}

// Real-fs adapter for the compiler's injectable deps (plugin-side only —
// the pure core in src/roster-compile.ts stays fs-free).
function realRosterFs(): RosterFsDeps {
  return {
    stat: (path) => {
      try {
        const s = statSync(path)
        return { mtimeMs: s.mtimeMs, size: s.size }
      } catch {
        return null
      }
    },
    readFile: (path) => readFileSync(path, "utf8"),
    writeFile: (path, data) => writeFileSync(path, data),
    rename: (from, to) => renameSync(from, to),
    unlink: (path) => unlinkSync(path),
    readdir: (path) => {
      try {
        return readdirSync(path)
      } catch {
        return null
      }
    },
    mkdir: (path) => mkdirSync(path, { recursive: true }),
  }
}

// The global layer's host knobs (materialize/sync), read fail-soft: an
// absent/unreadable/broken global file keeps the defaults.
function readGlobalKnobs(deps?: { readFile?: (path: string) => string }): { materialize: ForgeMaterializeKnob | undefined; syncAuto: boolean } {
  try {
    const path = globalPoolPathOf()
    const text = deps?.readFile ? deps.readFile(path) : readFileSync(path, "utf8")
    const parsed = parseForgeJsonc(text)
    if (!parsed.ok) return { materialize: undefined, syncAuto: false }
    const knobs = parseTopLevelKnobs(parsed.config, "global forge.json")
    for (const f of knobs.findings) console.warn(`[forge:sync] ${f.level}: ${f.message}`)
    return { materialize: knobs.materialize, syncAuto: knobs.syncAuto }
  } catch {
    return { materialize: undefined, syncAuto: false }
  }
}

// Compile + write every family of the current host resolution; returns
// the disclosure lines (created/updated/GC'd/errors). Shared by the
// forge_sync tool and the sync:"auto" session-start path. The GLOBAL
// recipe's `override` node (builtin-override) rides the same pass: its
// entries compile into the host's GLOBAL agent dir (globalAgentDirFor —
// OPENCODE_CONFIG_DIR-aware) as non-namespaced lowercase files.
function runRosterSync(): { lines: string[]; errorCount: number } {
  const resolution = resolvePools()
  const overrideDir = globalAgentDirFor({ homeDir: process.env.FORGE_TEST_FORGE_HOME ?? homedir(), configDir: process.env.OPENCODE_CONFIG_DIR })
  const overridePlan = resolution
    ? planOverrideSync(resolution.overrides ?? {}, {
        dir: overrideDir,
        recipeFile: globalPoolPathOf(),
      })
    : null
  if (!resolution || (resolution.families.length === 0 && overridePlan === null)) {
    return { lines: ["[forge:sync] No forge.json recipe is visible to this host — nothing to compile (the recipe is the authority; native files are only its projection)."], errorCount: 0 }
  }
  const plans: SyncPlan[] = [...planRosterSync(resolution, { globalPoolFile: globalPoolPathOf() })]
  // builtin-override (E2E scenario-6 fix): the override channel ALWAYS rides
  // the sync — planOverrideSync returning null (no ACTIVE entries) becomes an
  // empty plan, which is exactly the DEACTIVATION pass: the executor's
  // marker-keyed GC removes stale general.md/explore.md the recipe no longer
  // wants. Hand-written files never carry the marker and are never touched;
  // when nothing is configured and nothing stale exists the pass is a no-op
  // (one readdir + marker check, zero writes).
  plans.push(overridePlan ?? { kind: "override", dir: overrideDir, files: [] })
  const outcome = executeRosterSync(plans, realRosterFs())
  const lines = [`[forge:sync] Compiled ${plans.reduce((n, p) => n + p.files.length, 0)} roster file(s) across ${plans.filter((p) => p.files.length > 0).length} pool(s):`]
  if (outcome.created.length) lines.push(`  created: ${outcome.created.join(", ")}`)
  if (outcome.updated.length) lines.push(`  updated: ${outcome.updated.join(", ")}`)
  if (outcome.unchanged.length) lines.push(`  unchanged: ${outcome.unchanged.length} file(s) already current`)
  if (outcome.gced.length) lines.push(`  gc'd (entries removed from the recipe): ${outcome.gced.join(", ")}`)
  if (outcome.errors.length) lines.push(`  errors: ${outcome.errors.join("; ")}`)
  // Recipe findings ride the sync disclosure (E2E scenario-9 fix): the
  // resolver's warn/error findings — e.g. a workspace-layer `override` node
  // being ignored by design (global-only, D1) — must be SEEN, not swallowed.
  // Console parity for the design-relevant warn and for errors matches the
  // readGlobalKnobs precedent.
  for (const f of resolution.findings) {
    if (f.level !== "warn" && f.level !== "error") continue
    lines.push(`  finding [${f.level}] ${f.code}: ${f.message}`)
    if (f.level === "error" || f.code === "override-node-ignored-workspace") console.warn(`[forge:sync] ${f.level}: ${f.message}`)
  }
  lines.push("The host hot-applies the files — no restart. Edit the RECIPE (forge.json), never the generated files; forge_sync re-emits.")
  return { lines, errorCount: outcome.errors.length + resolution.findings.filter((f) => f.level === "error").length }
}

// Content oracle for the staleness gate: compile one entry's expected
// content on demand (the mtime trigger is cheap; the final verdict is
// content-based, so a touched-but-identical recipe never dead-ends).
function rosterContentOf(resolution: PoolResolution): (matId: string) => string {
  const globalPath = globalPoolPathOf()
  return (matId) => {
    const agent = resolution.agents[matId]
    const provenance: PoolProvenance = foldPath(agent.file) === foldPath(globalPath) ? { global: true } : { ns: agent.ns, file: agent.file }
    return compileRosterEntry({ matId, def: agent.def, provenance, shared: agent.shared ?? undefined }).content
  }
}

// Staleness refusal for the crew gate (design D4): native mode refuses
// registration when the session's roster artifacts are stale, with the
// one-step fix (same gate language family as the compliance refusal).
function rosterStaleRefusal(anchor: string | null): string | null {
  const resolution = resolvePools()
  const poolFile = anchor ? sessionPoolFileOf(anchor) : null
  const fam = resolution?.families.find((f) => foldPath(f.file) === foldPath(poolFile ?? globalPoolPathOf()))
  const verdict = staleCheckForPool(fam ? fam.file : poolFile, fam ? fam.materializedIds : [], realRosterFs(), resolution ? rosterContentOf(resolution) : undefined)
  if (!verdict.stale) return null
  return (
    `[forge:crew] Roster stale refused: this session's native roster artifacts are out of date with the recipe — ${verdict.reason}. ` +
    `One-step fix: call the forge_sync tool NOW (it recompiles .opencode/agent/forge-*.md atomically, in-band, transcript-visible; the host hot-applies without a restart), then retry this registration. ` +
    `The recipe (forge.json) stays the authority — the gate only refuses dispatching against a stale projection.`
  )
}

// Sync hint for the plain dispatch path (design D4): on a native-mode
// host, a forge-* dispatch that finds no roster must not dead-end at
// "worker not found" — a fresh workspace after upgrade surfaces the same
// one-step sync guidance.
function nativeRosterSyncHint(): string | null {
  if (!nativeRosterActive()) return null
  const resolution = resolvePools()
  if (!resolution) return null
  const deps = realRosterFs()
  const contentOf = rosterContentOf(resolution)
  for (const fam of resolution.families) {
    const verdict = staleCheckForPool(fam.file, fam.materializedIds, deps, contentOf)
    if (verdict.stale) {
      return (
        ` Native-roster hint: this host materializes workers from compiled .opencode/agent/forge-*.md files and they are stale or missing (${verdict.reason}). ` +
        `Call the forge_sync tool to regenerate them, then retry.`
      )
    }
  }
  return null
}


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
  if (process.env.FORGE_ANCHOR_PROBE) {
    try {
      appendFileSync(
        join(probeTmp(), "forge-anchor-probe.log"),
        `${new Date().toISOString()} rememberHostAnchor(${JSON.stringify(dir)}) cwd=${JSON.stringify(process.cwd())}\n`,
      )
    } catch {}
  }
  const normalized = normalizeAnchorDir(dir)
  if (!normalized) return
  if (!hostAnchors.includes(normalized)) hostAnchors.push(normalized)
  if (!poolResolver) {
    poolResolver = createPoolResolver({ homeDir: process.env.FORGE_TEST_FORGE_HOME ?? homedir() })
  }
}

// Resolve over the workspace registry (fresh every call — the resolver's
// caches make repeat resolves cheap; deletions un-materialize). Null only
// before the first server() initialization (tests calling tools directly).
function resolvePools(): PoolResolution | null {
  if (process.env.FORGE_ANCHOR_PROBE) {
    try {
      appendFileSync(
        join(probeTmp(), "forge-anchor-probe.log"),
        `${new Date().toISOString()} resolvePools: resolver=${poolResolver ? "set" : "null"} anchors=${JSON.stringify([...hostAnchors])}\n`,
      )
    } catch {}
  }
  if (!poolResolver || hostAnchors.length === 0) return null
  return poolResolver.resolve(hostAnchors)
}
// Session-anchored project-only discovery (sole-pool-ownership residual
// mismatch + the session's workspace pool): NO global layer here — the
// loader reports the session's own forge.json (nearest walking up) and its
// agents alone. Bounded cache keyed on the session anchor; the host-wide
// resolver above stays the materialization source of truth.
const sessionAnchorLoaders = new Map<string, ReturnType<typeof createForgeConfigLoader>>()
function loaderForAnchor(anchor: string): ReturnType<typeof createForgeConfigLoader> {
  const key = anchor || "-"
  let l = sessionAnchorLoaders.get(key)
  if (!l) {
    // homeDir deliberately omitted: project-layer only (no global merge —
    // sole ownership makes the workspace pool the whole roster).
    l = createForgeConfigLoader({ projectDir: anchor })
    sessionAnchorLoaders.set(key, l)
    while (sessionAnchorLoaders.size > 8) {
      const oldest = sessionAnchorLoaders.keys().next().value
      if (oldest === undefined) break
      sessionAnchorLoaders.delete(oldest)
    }
  }
  return l
}

// The session's workspace pool file (sole ownership primitive): prefers the
// shared resolver's walk-up (single fs/cache surface); before the first
// server() init falls back to the project-only loader's discovery.
function sessionPoolFileOf(anchor: string): string | null {
  if (poolResolver) return poolResolver.workspacePoolOf(anchor)
  return loaderForAnchor(anchor).load().projectPath
}

// Crew-governed dispatch pool-compliance gate (change
// pool-namespace-contract, spec: crew-harness — "Crew-governed dispatch
// pool-compliance gate"): while a crew governs a session, the session's
// workspace pool file must DECLARE a valid top-level `pool` namespace
// (same [a-z0-9-] 1–24 rule as the resolver). File-level ONLY — per-agent
// fail-soft findings (half-pinned entries, mistyped fields) never make the
// file non-compliant. Global-fallback sessions (no workspace pool file)
// are EXEMPT — the fixed `global` namespace carries no rename risk. One
// predicate (src/forge-config.ts poolFileCompliance), two call sites: the
// crew_begin registration pre-flight and the task-dispatch interception
// belt. Returns the refusal string when non-compliant, null when
// compliant/exempt; the read itself is fail-soft (unreadable file ⇒ an
// honest refusal, never a crash). The suggested namespace is the family's
// currently derived ns (resolved families whose file matches), else the
// sanitized pool-directory basename — exactly what the family materializes
// under today, so the fix never renames existing ids.
function crewPoolComplianceRefusal(anchor: string): string | null {
  const poolFile = sessionPoolFileOf(anchor)
  if (poolFile === null) return null // global-fallback roster — exempt
  let text: string
  try {
    text = readFileSync(poolFile, "utf8")
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    return (
      `[forge:crew] Pool compliance refused: this session's workspace pool file (${poolFile}) could not be read (${reason}). ` +
      `Repair the file so it is readable JSONC declaring a valid top-level "pool" namespace ([a-z0-9-], 1-24 chars) — REQUIRED for crew-governed dispatch. ` +
      `The gate lifts hot-apply: the next resolve after the repair admits registration/dispatch; no host restart.`
    )
  }
  const parsed = parseForgeJsonc(text)
  if (!parsed.ok) {
    return (
      `[forge:crew] Pool compliance refused: this session's workspace pool file (${poolFile}) does not parse (${parsed.error.message} at line ${parsed.error.line}). ` +
      `Repair the file so it parses and declares a valid top-level "pool" namespace ([a-z0-9-], 1-24 chars) — REQUIRED for crew-governed dispatch. ` +
      `The gate lifts hot-apply: the next resolve after the repair admits registration/dispatch; no host restart.`
    )
  }
  const verdict = poolFileCompliance(parsed.config)
  if (verdict.compliant) return null
  const fam = resolvePools()?.families.find((f) => foldPath(f.file) === foldPath(poolFile))
  const suggested = fam?.ns ?? sanitizeNamespace(basename(dirname(dirname(poolFile))))
  return (
    `[forge:crew] Pool compliance refused: this session's workspace pool file (${poolFile}) is non-compliant — ${verdict.violation}. ` +
    `Minimal fix: add or repair the top-level "pool": "${suggested}" field (a [a-z0-9-] string, 1-24 chars — REQUIRED for crew-governed dispatch). ` +
    `The gate lifts hot-apply: the next resolve after the repair admits registration/dispatch; no host restart.`
  )
}
// crew-native-fallback (spec: crew-harness — "Native fallback dispatch in
// crew waves"): guidance + disclosure ONLY, zero guard diff. The one-line
// fallback rule rides every waves-arming surface (crew_begin arming output —
// standalone arm AND born-armed/goal-delegated — plus the /crew template's
// wave-discipline line); the native exit sentence is appended to the MID-CREW
// compliance belt refusal ONLY (the registration pre-flight copy stays
// unchanged — the fallback is about DISPATCH, not registration, D3). The
// native task channel was never refused for forge-family sessions and still
// is not; the recording duty rides existing surfaces (wave notes + the close
// evidence saying it ran native — no schema field, D2).
const CREW_NATIVE_FALLBACK_RULE =
  "Native fallback: when the pool offers no forge worker fitting a subtask (or forge-* dispatch is blocked by a degraded pool), dispatch the native general subagent with the same relay contract (artifact path, scoped prompt, evidence demands) and RECORD the fallback (wave notes + the subtask's close evidence says it ran native)."
const CREW_COMPLIANCE_NATIVE_EXIT =
  " Native exit: while the pool is being repaired, the affected subtask may dispatch through the NATIVE task channel with the same relay contract — this compliance belt gates forge-* dispatch only, never the crew's existence."
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
    `  1. supervised waves NOW — when the user says go, call crew_begin {execution: "waves"} and run the wave discipline; waves auto-advance on session idle until crew_close (the engine stops after a stall — nudge or re-shard);`,
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

// sessionID -> frozen resolution: the chat.params injection table. The FIRST
// request of a forge-agent session freezes the resolution (D3 stability:
// never rewritten mid-session even if forge.json changes under it); later
// requests of the same session re-apply it verbatim. postrelease-hardening
// D2: dead ends freeze too — a no-mapping first resolution lands as
// { translation: null }, so the session keeps injecting nothing for its
// whole lifetime; only sessions created after the config edit re-resolve.
const sessionDepths = new Map<string, { translation: DepthTranslation | null }>()

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

// catalog-driven-depth-shapes + postrelease-hardening D1: the wire-shape
// fallback chain, with ONE family gate ahead of the catalog. For the
// anthropic family the shape comes from the EMPIRICALLY VERIFIED TRANSPORT
// MATRIX OF THE CURRENT HOST GENERATION — never from the catalog — because
// this host generation's anthropic transport silently drops the effort-word
// key (`options.reasoningEffort`) that a catalog effort shape selects
// (verify/adaptive-key.md): routing the production catalog's effort
// reasoning_options for bare claude ids onto that wire is silent dead
// injection (the P0-1 blind spot). Adaptive-era models speak the adaptive
// effort channel (`options.effort` → wire `output_config:{effort}`); legacy
// era takes the budget tier table. The catalog (reasoning_options: effort
// values / toggle / budget_tokens) stays the shape authority for every OTHER
// family; a catalog-silent model falls back to the provider-prefix family; a
// provider absent from both defaults to the effort WORD channel (the
// dictionary is a dictionary, not a whitelist — unmatched words pass through
// and the provider judges). If a future host natively honors catalog effort
// shapes on anthropic, a new change must hand authority back to the catalog
// here — the matrix is deliberately isolated in resolveDepthChannel alone.
function isAdaptiveAnthropic(modelID: string): boolean {
  const id = modelID.toLowerCase()
  const m = /^claude-(?:(?:opus|sonnet|haiku)[-.])?(\d+)(?:[.-](\d+))?/.exec(id)
  if (!m) return false
  const major = Number(m[1])
  const minor = m[2] !== undefined ? Number(m[2]) : 0
  return major > 4 || (major === 4 && minor >= 7)
}

function resolveDepthChannel(providerID: string, modelID: string): DepthChannel {
  // Family gate FIRST (postrelease-hardening D1): for anthropic, the
  // empirical transport matrix outranks whatever the catalog carries. The
  // matrix keys on the model id only — non-catalog ids (`-sandbox` suffixes
  // etc.) ride it identically, matching the existing E2E posture.
  if (dispatchProviderFamily(providerID) === "anthropic") {
    return isAdaptiveAnthropic(modelID) ? { kind: "adaptive-effort" } : { kind: "budget" }
  }
  const shape = modelDepthShape(modelsDevCatalog, `${providerID}/${modelID}`)
  if (shape) {
    if (shape.shape === "effort") return { kind: "effort", ladder: shape.ladder }
    if (shape.shape === "toggle") return { kind: "toggle" }
    return { kind: "budget" }
  }
  const family = dispatchProviderFamily(providerID)
  if (family === "openai") return { kind: "effort", ladder: null }
  if (family === "zai") return { kind: "toggle" }
  // Unknown endpoint (custom relay, any provider x any protocol): default to
  // the effort word channel — pass-through territory, provider judges.
  return { kind: "effort", ladder: null }
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
  const registry = createJobRegistry(registryPathFor(jobLogDir()))
  jobRegistry = registry
  // Previous-run survivors: adopt the alive, ledger the dead (POSIX orphan
  // detection rides the same scan — there is no kernel fence there).
  const { adopted, dead } = registry.rescan(pidAlive, structuralRelocate)
  for (const entry of adopted) {
    adoptSurvivor(jobManager, entry, { registry, logDir: jobLogDir(), relocate: structuralRelocate })
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
    // fix-dispatch-dispose-kill D1: dispatch rows are exempt from the ENTIRE
    // exit matrix (dispose + SIGINT/SIGTERM/exit/uncaught) — no kill, no
    // abort, no journal terminal state; continuity rides the dispatch
    // journal + restart recovery.
    skip: isDispatchRow,
    // Diagnostics only (the sandbox probe log): the exit matrix leaves a
    // trace of what each trigger saw and killed.
    trace: (line) => goalProbe(`exit-cleanup ${line}`),
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

// Resolved per call (fix-test-runtime-namespace-isolation): the job home is
// `<os-tmp>/opencode-forge/jobs` with the `<os-tmp>` level from
// forgeRuntimeTmp() — never a module-load constant, so a test's redirect is
// honored wherever in the test body it is set.
function jobLogDir(): string {
  return jobsLogDir(forgeRuntimeRoot())
}

// Diagnostics ledger sink: bounded in memory by the manager; on disk a
// JSONL file that resets once it passes 1MB.
function jobLedgerSink(entry: Record<string, unknown>): void {
  try {
    mkdirSync(jobLogDir(), { recursive: true })
    const jobLedgerPath = join(jobLogDir(), "ledger.jsonl")
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
    if (idleJobSessions.has(job.ownerSession)) {
      // Progress flushes BEFORE terminal wakes (design D6 FINAL/PROGRESS
      // separation): older information lands first on the same idle edge.
      void deliverDispatchProgress(job.ownerSession).then(() => deliverJobWakes(job.ownerSession))
    }
  },
})

// Pending [forge:dispatch-progress] notices (sync-timeout-notify fold #2,
// design D6): parked per owner session at the notify-interval cadence and
// flushed through the SAME idle-edge mechanism as job wakes. Delivery is
// LOSSY by design — a failed send drops the notice (no requeue, no budget
// interaction): progress is informational; the terminal
// [forge:dispatch-complete] wake is the guarantee and never shares this
// queue or the wake budget.
// fix-stale-progress-notice: an entry may carry an `isLive` predicate. The
// notice is delivered ONLY while it still holds AT DELIVERY TIME — a notice
// parked for a busy owner whose dispatch finished meanwhile is dropped (the
// terminal wake is the single carrier of the terminal state; the notice
// itself stays in the job's output tail). Entries without a predicate (a
// notice that is not about one dispatch) are delivered as before.
type DispatchProgressNotice = { text: string; isLive?: () => boolean }
const dispatchProgressQueue = new Map<string, DispatchProgressNotice[]>()
// Dropped-as-stale notices per owner session (bounded; the wiring tests'
// read-only view of the drop side).
const dispatchProgressDropped = new Map<string, string[]>()

/** True while task `jobId` is in flight, between retry attempts, still waiting in a queue, or being spawned from a queue. */
function dispatchStillLive(jobId: string): boolean {
  const row = jobManager.get(jobId)
  if (row) return row.state === "running"
  // No registry row yet: a wish is live while it is still queued, or while
  // the queue pump is spawning it (the transit window — see PumpRun).
  for (const queue of dispatchQueues.values()) {
    if (queue.some((wish) => wish.jobId === jobId)) return true
  }
  for (const pumps of pumpInFlight.values()) {
    for (const run of pumps) if (run.wishId === jobId) return true
  }
  return false
}

function queueDispatchProgress(sessionID: string, text: string, isLive?: () => boolean): void {
  const notice: DispatchProgressNotice = isLive ? { text, isLive } : { text }
  const queued = dispatchProgressQueue.get(sessionID)
  if (queued) queued.push(notice)
  else dispatchProgressQueue.set(sessionID, [notice])
}

async function deliverDispatchProgress(sessionID: string): Promise<void> {
  if (forgeDisabled) return
  const pending = dispatchProgressQueue.get(sessionID)
  if (!pending || pending.length === 0) return
  dispatchProgressQueue.delete(sessionID)
  if (!jobClient || typeof jobClient.session.promptAsync !== "function") return
  for (const notice of pending) {
    if (notice.isLive) {
      // A predicate that throws decides nothing: the notice is delivered as
      // it always was (never a throw into the idle-edge path).
      let live = true
      try {
        live = notice.isLive()
      } catch {}
      if (!live) {
        dispatchProgressDropped.set(sessionID, [...(dispatchProgressDropped.get(sessionID) ?? []), notice.text].slice(-20))
        continue
      }
    }
    try {
      await jobClient.session.promptAsync({ path: { id: sessionID }, body: { parts: [{ type: "text", text: notice.text }] } })
    } catch {
      // Lossy: the notice is dropped — never requeued, never retried.
    }
  }
}

// Message-send client for completion wakes (promptAsync: fire-and-forget,
// does not block the plugin fiber) and session lookups for handoff roots.
type JobClient = {
  session: {
    promptAsync?: (opts: unknown) => Promise<unknown>
    get?: (opts: unknown) => Promise<unknown>
  }
}
let jobClient: JobClient | null = null

// fix-v2-crew-surface-drift task 1.1 (design D1): the authoritative
// anchor-client seam, hoisted into SHARED module state so the dispatch
// belts AND the crew tools consume ONE client. Seeded at exactly the
// moments the belts get it today — v1 server() initialization
// (input.client) and v2 setup (v2AnchorClient(ctx), the session.get
// translation of the promise-layer session domain). Consumers read it via
// sharedAnchorClient() with the same `?.`/typeof guards the belts use;
// with no client available, anchor resolution is EXACTLY today's
// tool-context behavior (a pure strict improvement, no new failure mode).
type AnchorClient = { session?: { get?: (opts: unknown) => Promise<unknown> } }
let anchorClientShared: AnchorClient | null = null
function sharedAnchorClient(): AnchorClient | null {
  return anchorClientShared
}

// Sessions believed idle (job-read-consumption D6): chat.message marks a
// turn in flight (busy), session.idle marks it over. Unknown sessions are
// treated as busy — they keep the conservative idle-edge delivery path.
const idleJobSessions = new Set<string>()

// Dispatch marker riding async-dispatch registry entries (kind=dispatch,
// async-dispatch design D3): the entry is a job-manager registry row, not a
// process — the wake text carries the child's final assistant message inline.
// fix-dispatch-dispose-kill: `outcome` is stamped "aborted" by the kill hook
// (dispatchKillTreeHook) BEFORE markTerminal queues the wake, so the wake
// renders the honest aborted branch; `abortReason` carries the kill reason.
type DispatchJobMeta = { agentID: string; childSessionID: string; description: string; outcome?: string; abortReason?: string }

// fix-dispatch-dispose-kill D1: the single dispatch-row predicate — the
// dispatch meta is the row's ONLY identity marker. Rows it matches are
// exempt from the exit matrix (host-exit skip) and disposeAll: no pid (no
// local process tree — terminateTreeSync is already a no-op for them), the
// child is a server-side session, and continuity is carried by the dispatch
// journal + restart recovery. An exit-time kill's only effects are
// destructive (journal aborted → recovery skips a live child; lost wake).
function isDispatchRow(job: Job): boolean {
  return (job as Job & { dispatch?: DispatchJobMeta }).dispatch != null
}

// fix-dispatch-dispose-kill D2 (abort-unconfirmed disclosure): jobId → the
// honest error from a failed/unavailable abortChild on a kill path. Read at
// journal settle (the poller's kill exit appends it to the terminal reason)
// and at wake delivery (jobWakeText discloses it) — never silently dropped.
const abortUnconfirmedNotes = new Map<string, string>()
// jobId → the abortChild promise a kill hook left in flight. The watcher's
// kill settle waits (bounded) on it before writing the journal terminal, so
// an abort that FAILED is disclosed in the journal too — not only in the
// wake, which is rendered later.
const abortInFlight = new Map<string, Promise<void>>()
// How long a kill settle (and a wake rendered at kill time) waits for an
// in-flight abort before treating it as unconfirmed.
const KILL_ABORT_VERDICT_WAIT_MS = 2_000
const KILL_ABORT_PENDING_NOTE = `the abort call had not returned within ${KILL_ABORT_VERDICT_WAIT_MS / 1000} s`

/**
 * Wait (bounded) for a kill's in-flight abort and make its verdict honest.
 * A FAILED or unavailable abort is recorded by the kill hook itself; an
 * abort that has NOT RETURNED within the bound is recorded HERE as
 * unconfirmed too (spec review 2026-11-23, finding ④): a hung host call is
 * not a clean abort — the child may still be running — and the journal used
 * to write a bare "aborted" once its 2 s wait ran out. BOTH readers call
 * this — the journal settle and the wake delivery — so an already-idle owner
 * (woken at kill time, before the abort verdict lands) is told exactly what
 * the journal says, whichever of the two renders first.
 */
async function awaitAbortVerdict(jobId: string): Promise<void> {
  const pending = abortInFlight.get(jobId)
  if (!pending) return
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => resolve(), KILL_ABORT_VERDICT_WAIT_MS)
    const done = () => {
      clearTimeout(timer)
      resolve()
    }
    pending.then(done, done)
  })
  if (abortInFlight.get(jobId) === pending) abortUnconfirmedNotes.set(jobId, KILL_ABORT_PENDING_NOTE)
}

/**
 * fix-dispatch-dispose-kill D2/D3: the ONE killTree hook factory for
 * dispatch registry rows — every call site routes here, no `void`-discarded
 * abortChild results. The aborted outcome is stamped SYNCHRONOUSLY (before
 * the abort promise settles) because markTerminal fires onWakeQueued
 * synchronously inside kill() — the queued wake must already render the
 * honest aborted branch, never "finished / Final report: (no output)". A
 * failed or unavailable abort lands in abortUnconfirmedNotes for the
 * journal+wake disclosure; it never blocks the kill itself.
 */
function dispatchKillTreeHook(client: DispatchClient, jobId: string, childSessionID: () => string): () => void {
  return () => {
    const job = jobManager.get(jobId)
    const meta = job ? (job as Job & { dispatch?: DispatchJobMeta }).dispatch : undefined
    if (meta && meta.outcome !== "stream-lost/unknown") {
      meta.outcome = "aborted"
      meta.abortReason = meta.abortReason ?? REGISTRY_KILL_ABORT_REASON
    }
    const sid = childSessionID()
    if (!sid) return
    const pending = abortChild(client, sid).then((res) => {
      if (!res.ok) abortUnconfirmedNotes.set(jobId, res.error)
    })
    abortInFlight.set(jobId, pending)
    const drop = () => {
      if (abortInFlight.get(jobId) === pending) abortInFlight.delete(jobId)
    }
    void pending.then(drop, drop)
  }
}

// fix-stale-progress-notice: the plugin's own progress notices ride the
// dispatch job's output tail (the registry row's in-memory tail — `forge_jobs`
// poll stays readable; a dispatch job writes no log file), but they are
// timely markers, not report content — the completion wake's "Final report"
// block never shows a "still running" line above the report. Every notice
// goes through appendDispatchNotice, so the wake cuts them out by the exact
// appended text (never by matching a prefix the report itself could
// legitimately contain). The memo lives on the JOB, not on the dispatch
// meta: a retry rebinds the meta and must not forget earlier notices.
const DISPATCH_NOTICE_MEMORY = 30

function appendDispatchNotice(job: Job, notice: string): void {
  jobManager.appendOutput(job, notice)
  const memo = job as Job & { progressNotices?: string[] }
  if (!memo.progressNotices) memo.progressNotices = []
  memo.progressNotices.push(notice)
  if (memo.progressNotices.length > DISPATCH_NOTICE_MEMORY) memo.progressNotices.splice(0, memo.progressNotices.length - DISPATCH_NOTICE_MEMORY)
}

/**
 * The dispatch job's output AFTER the last plugin notice it still holds.
 * The poller appends notices first and the final text last, so what follows
 * the last notice IS the final text. A notice the tail cap truncated away
 * simply is not found (the cut then sits after a later one, or nowhere — in
 * which case the tail is returned whole, exactly as before this rule).
 */
function dispatchReportTail(job: Job): string {
  const memo = (job as Job & { progressNotices?: string[] }).progressNotices
  if (!memo || memo.length === 0) return job.tail
  let cut = -1
  for (const notice of memo) {
    const at = job.tail.lastIndexOf(notice)
    if (at !== -1) cut = Math.max(cut, at + notice.length)
  }
  return cut === -1 ? job.tail : job.tail.slice(cut)
}

function jobWakeText(job: Job): string {
  const dispatch = (job as Job & { dispatch?: DispatchJobMeta }).dispatch
  if (dispatch) {
    // dispatch-stream-loss-honesty: the stream-lost/unknown wake states the
    // view loss and the UNKNOWN child state — never a terminal verdict.
    if (dispatch.outcome === "stream-lost/unknown") {
      return [
        `[forge:dispatch-complete] task dispatch to ${dispatch.agentID} — RESULT STREAM LOST (task ${job.id}, child session ${dispatch.childSessionID}): the dispatch view broke before a final report arrived; child state UNKNOWN (possibly still running).`,
        `Last observation:\n${job.tail.slice(-2500) || "(no output)"}`,
        `Ground-truth recovery: read reports/${job.id}-report.md in the workspace BEFORE considering a re-dispatch; the child session stays inspectable and natively abortable in the host TUI.`,
      ].join("\n")
    }
    // fix-dispatch-dispose-kill D2 (killed wake honesty): a killed/aborted
    // dispatch is presented AS an abort with its reason — NEVER "finished …
    // Final report:" with an empty tail faking a report.
    if (job.state === "killed" || dispatch.outcome === "aborted") {
      const reason = dispatch.abortReason ?? REGISTRY_KILL_ABORT_REASON
      const unconfirmed = abortUnconfirmedNotes.get(job.id)
      return [
        `[forge:dispatch-complete] task dispatch to ${dispatch.agentID} — ABORTED (task ${job.id}, child session ${dispatch.childSessionID}): ${reason}.`,
        unconfirmed
          ? `abort unconfirmed — child may still be running (${unconfirmed}); inspect or abort it natively in the host TUI.`
          : `The child session was aborted; this dispatch did NOT finish and produced no final report.`,
        `Ground truth if needed: reports/${job.id}-report.md in the workspace, or the child transcript in the host TUI.`,
      ].join("\n")
    }
    return [
      `[forge:dispatch-complete] task dispatch to ${dispatch.agentID} finished (task ${job.id}, child session ${dispatch.childSessionID}).`,
      `Final report:\n${dispatchReportTail(job).slice(-2500) || "(no output)"}`,
      "The dispatch is complete — read the report above; no polling, no re-dispatch needed.",
    ].join("\n")
  }
  return [
    `[forge:job-complete] Background job ${job.id} finished (${job.state}${job.exitCode !== null ? `, exit ${job.exitCode}` : ""}).`,
    `Command: ${job.cmd}`,
    `Recent output:\n${job.tail.slice(-1500) || "(none)"}`,
    "Details via forge_jobs (poll/log); the job stays in the registry until cleared.",
  ].join("\n")
}

// Deliver queued completion wakes to a session that just went idle. A send
// failure re-queues the wake (bounded by the manager's delivery window,
// which abandons it to the ledger instead of looping forever). No jobStage
// guard: async-dispatch registry entries (kind=dispatch) ride this same
// path and their wakes must deliver even under supervisor retirement.
async function deliverJobWakes(sessionID: string): Promise<void> {
  if (forgeDisabled) return
  if (!jobClient || typeof jobClient.session.promptAsync !== "function") return
  for (const job of jobManager.deliverWakesFor(sessionID)) {
    // A killed dispatch's abort may still be in flight when an ALREADY-IDLE
    // owner is woken at kill time — before the abort verdict lands. Give it
    // the same bounded moment the journal settle gets (and the same
    // unconfirmed note for a hung call), so the wake never says a clean
    // "aborted" where the journal says "unconfirmed". Rows with no abort in
    // flight take NO await here: a plain job's wake is delivered
    // synchronously on the idle edge, as it always was.
    if (abortInFlight.has(job.id)) await awaitAbortVerdict(job.id)
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

// ---------------------------------------------------------------------------
// Session-anchor ledger (change pool-rebind-on-resume): persisted, bounded
// JSONL evidence of the pooled worktrees where live activity bound sessions.
// One global plugin-namespaced file (`<os-tmp>/opencode-forge/…` — the
// sanctioned runtime-artifact home); pooled non-degenerate binds write only
// (positive evidence); every read/write failure is fail-soft. The
// both-degenerate shape (an EMPTY in-memory map after a host restart plus a
// pool-less resume-rebound authoritative record) consults it to re-bind the
// session's own pool; cross-pool isolation and fail-open stay untouched.
// ---------------------------------------------------------------------------
type SessionAnchorLedgerFs = { read: () => string; write: (text: string) => void; append: (text: string) => void }
// Prod: `<os-tmp>/opencode-forge/…` (the sanctioned runtime-artifact home).
// Tests redirect it into the sandboxed FORGE_TEST_FORGE_HOME (the HOME alias —
// this ledger's historical knob, unchanged) so suite binds never touch the
// real ledger.
// fix-session-anchor-ledger-use-time-path: the path is resolved AT USE TIME,
// never at module load. ESM hoists every `import` above the statements of a
// test body, so a load-time read here always saw the variable unset and the
// suite's binds went to the REAL `<os-tmp>/opencode-forge/` ledger (verified
// 2026-11-23: fixture sessions in that file). Production never sets the
// variable, so its resolution is byte-identical.
// ---------------------------------------------------------------------------
// Runtime-artifact namespace (fix-test-runtime-namespace-isolation).
// Every per-host runtime artifact lives under `<os-tmp>/opencode-forge/`:
// job logs + the survivor registry + the jobs ledger, the models-dev cache,
// the watchdog ledger, the session-anchor ledger. Production's two levels are
// mirrored by two helpers, both resolved AT USE TIME:
//   forgeRuntimeTmp()  = the `<os-tmp>` level
//   forgeRuntimeRoot() = `<os-tmp>/opencode-forge` (jobs/, models-dev/,
//                        watchdog/, session-anchors.jsonl live under it)
// and the `<os-tmp>` level is:
//   production             → undefined → each helper's own default (as ever)
//   FORGE_TEST_RUNTIME_DIR → a test swaps the `<os-tmp>` level (the suite
//                            preloads a private temp dir via --import)
// FORGE_TEST_FORGE_HOME is NOT this axis: it stays exactly what it always was
// — the HOME alias for config discovery, plus this ledger's historical knob.
// Why (2026-11-24): the job directory used to be fixed at plugin module load,
// so every unit test that spawned a real job wrote its logs into the REAL
// directory shared with the running host plugin, overwrote the host's
// `registry.json`, and `ensureJobLifecycle` adopted the host's live survivors
// into the test process; every `config` hook rewrote the host's models-dev
// snapshot. Production never sets FORGE_TEST_RUNTIME_DIR, so every path is
// byte-identical.
// ---------------------------------------------------------------------------
function forgeRuntimeTmp(): string | undefined {
  return process.env.FORGE_TEST_RUNTIME_DIR || undefined
}

function forgeRuntimeRoot(): string {
  return join(forgeRuntimeTmp() ?? tmpdir(), "opencode-forge")
}

function sessionAnchorLedgerPath(): string {
  // HOME alias first (unchanged), then the suite's `<os-tmp>` redirect, then
  // the production location.
  return join(process.env.FORGE_TEST_FORGE_HOME ?? forgeRuntimeTmp() ?? tmpdir(), "opencode-forge", "session-anchors.jsonl")
}

// The production homes, one named function each. The call sites use THESE and
// the test surface below exposes the same functions — there is no parallel
// formula that could drift away from what production resolves.
function modelsDevCacheRoot(): string {
  // loadModelsDevSnapshot takes the `opencode-forge` ROOT as its `cacheDir`
  // and appends `models-dev` itself (src/models-dev.ts) — handing it the
  // already-joined `<root>/models-dev` nests a second `models-dev` level.
  return forgeRuntimeRoot()
}

function watchdogLogHome(): string {
  return watchdogLogDir(forgeRuntimeTmp())
}

// The env-gated diagnostic probes (FORGE_*_PROBE — off in production) write
// their logs beside the runtime artifacts, under the same `<os-tmp>` redirect,
// so a test or a sandbox that probes never writes into the real temp root.
function probeTmp(): string {
  return forgeRuntimeTmp() ?? tmpdir()
}

// Test surface (fix-test-runtime-namespace-isolation D3): the resolved paths
// of every runtime-artifact home — the production helpers themselves. Nothing
// here runs in a production path.
export const __runtimeNamespaceTestSurface = {
  tmp: forgeRuntimeTmp,
  root: forgeRuntimeRoot,
  jobLogDir: (): string => jobLogDir(),
  jobLedgerPath: (): string => join(jobLogDir(), "ledger.jsonl"),
  modelsDevCacheRoot,
  modelsDevCacheDir: (): string => modelsDevCacheDir(modelsDevCacheRoot()),
  watchdogLogDir: watchdogLogHome,
  probeTmp,
  sessionAnchorLedgerPath,
}
let sessionAnchorLedgerFsFactory: ((filePath: string) => SessionAnchorLedgerFs) | null = null
let sessionAnchorLedgerWarned = false
let sessionAnchorLedgerAppends = 0
const SESSION_ANCHOR_LEDGER_CAP = 200
const poolGateLedgerNotes = new Set<string>()
// Per-host-life dedup memo: sessions already ledger-bound to this folded
// worktree — one append per (session, worktree) pair per host life.
const sessionAnchorLedgerMemo = new Map<string, string>()

function sessionAnchorLedgerFs(): SessionAnchorLedgerFs {
  // One resolution per call: the read/write/append closures of this handle
  // share ONE file (a FIFO compaction's read + write cannot straddle two).
  const filePath = sessionAnchorLedgerPath()
  if (sessionAnchorLedgerFsFactory) return sessionAnchorLedgerFsFactory(filePath)
  return {
    read: () => {
      try {
        return readFileSync(filePath, "utf8")
      } catch {
        return "" // missing file = no entries; real errors surface at callers
      }
    },
    write: (text) => {
      mkdirSync(dirname(filePath), { recursive: true })
      writeFileSync(filePath, text, "utf8")
    },
    append: (text) => {
      mkdirSync(dirname(filePath), { recursive: true })
      appendFileSync(filePath, text, "utf8")
    },
  }
}

function sessionAnchorLedgerWarnOnce(scope: string, err: unknown): void {
  if (sessionAnchorLedgerWarned) return
  sessionAnchorLedgerWarned = true
  console.warn(
    `[forge:pool] session-anchor ledger ${scope} failed (fail-soft; resolution degrades to the live chain): ${err instanceof Error ? err.message : String(err)}`,
  )
}

function ledgerParseEntries(text: string): Map<string, string> {
  const latest = new Map<string, string>()
  if (!text) return latest
  for (const line of text.split(/\r?\n/)) {
    const s = line.trim()
    if (!s) continue
    try {
      const e = JSON.parse(s) as { sessionID?: unknown; worktree?: unknown }
      if (typeof e.sessionID === "string" && e.sessionID && typeof e.worktree === "string" && e.worktree) latest.set(e.sessionID, e.worktree)
    } catch {}
  }
  return latest
}

// The last ledger entry's worktree for a session, or "" (fail-soft read).
function sessionAnchorLedgerLookup(sessionID: string): string {
  try {
    return ledgerParseEntries(sessionAnchorLedgerFs().read()).get(sessionID) ?? ""
  } catch (err) {
    sessionAnchorLedgerWarnOnce("read", err)
    return ""
  }
}

// Record a pooled bind (positive evidence). Guards: non-degenerate worktree,
// the worktree OWNS a pool file at write time, one append per (session,
// worktree) pair per host life. FIFO cap: on overflow the file is compacted
// to the latest entry per session. All failures are fail-soft — binding
// never breaks session flow.
function noteSessionAnchorLedgerBinding(sessionID: string, worktree: string): void {
  try {
    if (!sessionID || !worktree || isRootish(worktree)) return
    if (sessionPoolFileOf(worktree) === null) return
    const folded = foldPath(worktree)
    if (sessionAnchorLedgerMemo.get(sessionID) === folded) return
    const fsx = sessionAnchorLedgerFs()
    fsx.append(JSON.stringify({ sessionID, worktree, ts: nowIso() }) + "\n")
    sessionAnchorLedgerMemo.set(sessionID, folded)
    sessionAnchorLedgerAppends++
    if (sessionAnchorLedgerAppends > SESSION_ANCHOR_LEDGER_CAP) {
      const latest = ledgerParseEntries(fsx.read())
      // FIFO among DISTINCT sessions (Map iteration = insertion order —
      // oldest first appearance drops first) until the rewrite fits the cap.
      while (latest.size > SESSION_ANCHOR_LEDGER_CAP) {
        const oldest = latest.keys().next().value
        if (oldest === undefined) break
        latest.delete(oldest)
      }
      const rewritten = [...latest.entries()]
        .map(([sid, wt]) => JSON.stringify({ sessionID: sid, worktree: wt, ts: nowIso() }))
        .join("\n")
      fsx.write(rewritten ? rewritten + "\n" : "")
      sessionAnchorLedgerAppends = latest.size
    }
  } catch (err) {
    sessionAnchorLedgerWarnOnce("write", err)
  }
}

// ---------------------------------------------------------------------------
// Dispatch gates (change task-shadow, spec: forge-subagents — "Task shadow
// surface"): ONE set of predicates serves BOTH dispatch paths — the
// task interception belt (tool.execute.before) and the task tool execute —
// so the two paths can never drift. Each
// returns the refusal string or null (pass).
// ---------------------------------------------------------------------------

// pool-gate-authoritative-anchor (D1/D2): the dispatch belts resolve the
// session anchor AUTHORITATIVE-FIRST — the host's own session record
// carries the true { directory, worktree } even for resumed-after-restart
// sessions (which never re-fire session.created), while the in-memory map
// has degenerate writers (rootish tool contexts resolve to the launch
// directory). pool-rebind-on-resume: when the live chain resolves an anchor
// that owns NO pool, the persisted session-anchor ledger may re-bind the
// session's own pool — the both-degenerate shape the live sources cannot
// resolve. The re-bind path is the resolver's ONLY map write (a seed under
// the non-degenerate-refinement rule); every other consumer is untouched.
// Diagnostics seam (env-gated, off by default): when FORGE_ANCHOR_PROBE names a
// file path, resolveSessionAnchorForPools appends its raw inputs (the host
// session record and the in-memory map binding) there — the live shape probe
// used to pin down the post-move anchor drift (fix-v2-crew-surface-drift 4.1).
function anchorProbeLog(kind: string, sessionID: string | undefined, payload: Record<string, unknown>): void {
  try {
    appendFileSync(process.env.FORGE_ANCHOR_PROBE as string, JSON.stringify({ t: new Date().toISOString(), kind, sessionID, ...payload }) + "\n")
  } catch {}
}

async function resolveSessionAnchorForPools(anchorClient: { session?: { get?: (opts: unknown) => Promise<unknown> } } | null | undefined, sessionID: string | undefined): Promise<string> {
  if (!sessionID) return ""
  let authoritative = ""
  try {
    // V2 session info carries the directory under `location.directory`
    // (same field reality as the lazy-seed read); v1 had it flat.
    const rec = anchorClient?.session?.get
      ? ((await anchorClient.session.get({ path: { id: sessionID } })) as
          | { directory?: string; worktree?: string; location?: { directory?: string } }
          | undefined)
      : undefined
    const anchor = effectiveWorktree(rec?.worktree, rec?.directory ?? rec?.location?.directory)
    if (anchor && !isRootish(anchor)) authoritative = anchor
    if (process.env.FORGE_ANCHOR_PROBE) anchorProbeLog("rec", sessionID, { rec: rec ?? null, authoritative })
  } catch {}
  const mapped = sessions.get(sessionID)?.worktree ?? ""
  if (process.env.FORGE_ANCHOR_PROBE) anchorProbeLog("map", sessionID, { mapped })
  // Post-move anchor re-resolution (fix-v2-crew-surface-drift 4.1): on 2.3.2
  // the plugin-facing session.get seam keeps the PRE-MOVE location after a
  // real `POST /api/session/:id/move` (live-probed: REST shows the moved
  // directory, session.get does not) — so the "authoritative" record above
  // is STALE for moved sessions. The host's `session.moved` event (recorded
  // in sessionMovedAnchors by the v1/v2 event hooks) is the live statement
  // of the session's CURRENT workspace; it wins over the stale record —
  // both directions (into a pool and out of one; POOLS follow workspaces).
  // No ledger consult on this branch: a deliberate move must not be
  // "resurrected" back to the session's historical pool by the resume
  // ledger (that ledger exists for the restart-resume shape, not to
  // override a live host statement).
  const moved = sessionMovedAnchors.get(sessionID) ?? ""
  if (moved && (authoritative === "" || foldPath(moved) !== foldPath(authoritative))) {
    if (!anchorMovedNotes.has(sessionID)) {
      anchorMovedNotes.add(sessionID)
      console.warn(
        `[forge:pool] session ${sessionID}: dispatch anchor re-resolved from the host's session.moved event (${moved}) — the session.get seam still reports the pre-move location${authoritative ? ` (${authoritative})` : ""}; the moved workspace wins this resolution.`,
      )
    }
    return moved
  }
  if (authoritative === "") return resolveAnchorViaLedger(sessionID, mapped)
  // anchor-pool-preference (the 0.20.0 evening incident's mirror of the
  // 0.18.0 one): a restart-RESUMED session's authoritative record can carry
  // the NEW launch directory (pool-less) while the in-memory binding — kept
  // fresh by the session's own live activity — still owns the real pooled
  // worktree. Authoritative-first would strip the session's own-pool
  // dispatch rights. Conflict rule: when the record anchor owns NO pool and
  // the (different, non-degenerate) map binding owns one, the POOLED
  // binding wins, with one bounded disclosure per session. Every other
  // shape keeps the record's precedence (the 0.18.0 semantics).
  if (
    mapped &&
    !isRootish(mapped) &&
    foldPath(mapped) !== foldPath(authoritative) &&
    sessionPoolFileOf(authoritative) === null &&
    sessionPoolFileOf(mapped) !== null
  ) {
    if (!anchorPrefNotes.has(sessionID)) {
      anchorPrefNotes.add(sessionID)
      console.warn(
        `[forge:pool] session ${sessionID}: the authoritative session record anchors to a POOL-LESS directory (${authoritative}) while the session's live binding owns a pool (${mapped}) — the pooled binding wins this resolution (restart-resume rebind shape).`,
      )
    }
    return mapped
  }
  return resolveAnchorViaLedger(sessionID, authoritative)
}

// The ledger consult (pool-rebind-on-resume): when the live chain resolved
// an anchor that owns NO pool (empty, degenerate, or genuinely pool-less),
// the persisted session-anchor ledger may re-bind the session's own pool —
// the restart-resume shape (empty map + pool-less record) the live sources
// cannot resolve. The hit is disk-truth re-checked at resolution time (a
// deleted pool file keeps the disappears-from-materialization semantics), a
// hit seeds the in-memory map under the non-degenerate-refinement rule, and
// the substitution discloses once per session. A miss (no entry, dead pool
// file, IO failure) keeps today's resolution EXACTLY.
function resolveAnchorViaLedger(sessionID: string, resolved: string): string {
  if (resolved && !isRootish(resolved) && sessionPoolFileOf(resolved) !== null) return resolved
  const hit = sessionAnchorLedgerLookup(sessionID)
  if (!hit || isRootish(hit) || sessionPoolFileOf(hit) === null) return resolved
  const existing = sessions.get(sessionID)
  if (existing) {
    if (!isRootish(hit)) existing.worktree = hit
  } else {
    sessions.set(sessionID, { sessionID, worktree: hit })
  }
  if (!poolGateLedgerNotes.has(sessionID)) {
    poolGateLedgerNotes.add(sessionID)
    console.warn(
      `[forge:pool] session ${sessionID}: dispatch anchor re-bound from the persisted session-anchor ledger (${hit}) — the resumed session's authoritative record is pool-less and the in-memory map was empty (restart-resume rebind shape).`,
    )
  }
  return hit
}

// Session-domain pool gate (sole-pool-ownership): a dispatch targeting a
// forge-* worker whose pool belongs to ANOTHER workspace is refused — the
// target's origin pool path is named, with the three exits. Unknown session
// anchors keep the fail-open belt posture with a bounded disclosure.
async function poolGateRefusal(anchorClient: { session?: { get?: (opts: unknown) => Promise<unknown> } } | null | undefined, sessionID: string, target: string): Promise<string | null> {
  const resolution = resolvePools()
  const agentId = target.slice("forge-".length)
  const entry = resolution?.agents[agentId]
  if (!(resolution && entry)) return null
  const anchor = await resolveSessionAnchorForPools(anchorClient, sessionID)
  if (!anchor) {
    if (!poolGateUnknownNotes.has(sessionID)) {
      poolGateUnknownNotes.add(sessionID)
      console.warn(
        `[forge:pool] session ${sessionID}: task dispatch to ${target} passed an UNGATED pool check — the session's workspace could not be established (fail-open belt posture; pool ownership unscoped).`,
      )
    }
    return null
  }
  const sessionPool = sessionPoolFileOf(anchor)
  const allowed = sessionPool ?? globalPoolPathOf()
  if (allowed === null || foldPath(entry.file) !== foldPath(allowed)) {
    return (
      `[forge:pool] Dispatch refused: "${target}" belongs to the pool ${entry.file} — not dispatchable from this session. ` +
      `This session's dispatchable roster is ${sessionPool ? `its workspace pool (${sessionPool})` : `the global fallback (${globalPoolPathOf()})`}. ` +
      `Exits: open a session in that pool's workspace, or configure the role into this workspace's pool (its .opencode/forge.json), or into the global layer (${globalPoolPathOf()}).`
    )
  }
  return null
}

// Crew pending belt (crew-harness): a registered-but-unarmed crew refuses
// EVERY dispatch — the registration→execution seam is a user decision point.
function crewPendingRefusal(sessionID: string | undefined): string | null {
  const pendingCrew = sessionID ? crews.get(sessionID) : undefined
  if (pendingCrew && pendingCrew.mode === "pending") {
    return (
      `[forge:crew] Dispatch refused: the crew "${pendingCrew.objective}" is PENDING (registered, not armed). Present the execution-mode choice to the user — supervised waves now / convert to a goal contract / standby — then arm per their choice with crew_begin {execution: "waves" | "goal"}. Reconnaissance task calls are free only BEFORE registration.`
    )
  }
  return null
}

// Crew compliance belt (pool-namespace-contract): for dispatches to forge-*
// targets FROM a crew-governed session, re-run the file-level pool
// compliance check. Runs AFTER the session-domain pool gate (a cross-pool
// target keeps its not-dispatchable copy — compliance never masks it).
// Global-fallback sessions are exempt; unknown anchors stay fail-open.
async function crewComplianceRefusalFor(anchorClient: { session?: { get?: (opts: unknown) => Promise<unknown> } } | null | undefined, sessionID: string, target: string): Promise<string | null> {
  if (!(target && target.toLowerCase().startsWith("forge-"))) return null
  const crew = crews.get(sessionID)
  if (!(crew && (crew.mode === "pending" || crew.mode === "executing"))) return null
  const anchor = await resolveSessionAnchorForPools(anchorClient, sessionID)
  if (!anchor) return null
  const complianceRefusal = crewPoolComplianceRefusal(anchor)
  // crew-native-fallback: the MID-CREW refusal gains the native exit
  // sentence; the refusal CONDITION is untouched.
  return complianceRefusal ? complianceRefusal + CREW_COMPLIANCE_NATIVE_EXIT : null
}

// Plan-draft shape gate (allow-readonly-recon): during an active draft a
// dispatch to an effective-readonly forge target passes as reconnaissance
// (BOTH dispatch modes, both surfaces); every other target — write-shape
// workers, native agents, absent/unresolvable targets — is denied with the
// dispatchable readonly roster and the exits.
function draftDispatchRefusal(sessionID: string | undefined, target: string | undefined): string | null {
  const state = stateForBan(sessionID)
  const active = state ? resolveActivePlan(state) : null
  if (!(active && active.doc.status === "draft")) return null
  const agentId = target !== undefined && target.toLowerCase().startsWith("forge-") ? target.slice("forge-".length) : undefined
  const def = agentId !== undefined ? resolvePools()?.agents[agentId]?.def : undefined
  if (def !== undefined && effectiveReadonlyShape(def)) {
    // Reconnaissance dispatch: passes the write-class ban. The worker's own
    // materialized permission denies write/edit/bash (and task, always) —
    // no mutation path is transported.
    return null
  }
  const roster: string[] = []
  const pools = resolvePools()
  if (pools) for (const [id, entry] of Object.entries(pools.agents)) if (effectiveReadonlyShape(entry.def)) roster.push(`forge-${id}`)
  roster.sort()
  return (
    `[forge] A plan is in draft; dispatch is denied for this target. ` +
    (roster.length > 0
      ? `Readonly recon scouts ARE dispatchable during draft: ${roster.join(", ")}. `
      : `No readonly worker is configured — define one in forge.json with an explicit "shape": "readonly" to enable draft-phase reconnaissance. `) +
    `Write-shaped workers and native agents wait for approval (plan_approve); /plan discard to abandon the plan.`
  )
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
    // pool-gate-authoritative-anchor: a degenerate anchor (empty or
    // filesystem-root) never clobbers a good binding — resumed-after-restart
    // sessions and rootish tool contexts were poisoning bindings, which
    // stripped the session's own-pool dispatch rights in the belt.
    // Non-degenerate refinement keeps today's overwrite semantics.
    if (!isRootish(worktree)) {
      existing.worktree = worktree
      // pool-rebind-on-resume: pooled non-degenerate binds persist as
      // ledger evidence (fail-soft, deduped, capped).
      noteSessionAnchorLedgerBinding(sessionID, worktree)
    }
    return existing
  }
  const state: SessionState = { sessionID, worktree }
  sessions.set(sessionID, state)
  if (!isRootish(worktree)) noteSessionAnchorLedgerBinding(sessionID, worktree)
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
    checks: tool.schema
      .array(
        tool.schema.object({
          shell: tool.schema.string().optional().describe("Shell command the plugin itself re-runs on the host at plan_close (fail-closed)"),
          containsFile: tool.schema.string().optional().describe("File contract: workspace-relative file path"),
          containsText: tool.schema.string().optional().describe("File contract: required literal text in that file"),
          timeoutSec: tool.schema.number().int().positive().optional().describe("Shell timeout in seconds (default 120, max 600)"),
        }),
      )
      .optional()
      .describe(
        "Verification Checks: optional structured completion gate, goal-harness-shaped. Rendered into the plan file and FROZEN from approval on — plan_close re-runs exactly this set on the host (fail-closed); a plan without checks keeps the per-criterion self-check close instead",
      ),
  },
  execute: async (args, context) => {
    const state = ensureSession(context.sessionID, worktreeFor(context))
    const active = resolveActivePlan(state)
    const now = nowIso()
    let checks: PlanCheck[] | undefined
    if (args.checks) {
      try {
        checks = coerceChecks(args.checks)
      } catch (err) {
        throw new PlanError((err as Error).message)
      }
    }
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
    const { checks: rawChecks, ...fields } = args
    const text = renderPlan({ ...fields, ...(checks && checks.length > 0 ? { checks } : {}) }, now, created)
    writeFileSync(path, text)
    state.planPath = path
    const doc = parsePlan(text)
    context.metadata({ title: `${mode === "created" ? "Create" : "Revise"} plan: ${doc.goal}` })
    return {
      title: `plan ${mode}: ${doc.goal}`,
      output: [
        `Plan ${mode === "created" ? "created" : "revised"}: ${relFrom(state.worktree, path)}`,
        `Status: draft (${doc.tasks.length} tasks, ${doc.acceptance.length} acceptance criteria).`,
        ...(doc.checks.length > 0
          ? [`Verification Checks: ${doc.checks.length} items frozen into the file — plan_close re-runs them on the host, fail-closed (no close dialog).`]
          : []),
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
          ? `Task ${args.n} done (${p.done}/${p.total}, all complete). Self-check every acceptance criterion with concrete evidence, then call plan_close — it re-runs the plan's frozen verification checks itself on the host (fail-closed; no confirmation dialog).`
          : `Task ${args.n} done and ticked (${p.done}/${p.total}). Continue with the next task.`,
    }
  },
})

// Gates are implemented with ToolContext.ask(), NOT the permission config:
// on opencode 1.18.32 plugin-registered tools bypass permission evaluation
// entirely (verified: config "ask" rules on plan_* never produce a request),
// while context.ask() creates a real user confirmation (TUI dialog; run mode
// auto-rejects; --auto approves). The user's answer IS the gate.
//
// INVARIANT: the gate() helper itself NEVER auto-resolves. forge_shell is
// NOT a user-confirmation door — its gate ask is resolved by the HOST
// against the permission rules (posture pass-through: no plugin-injected
// rule, no plugin-side classification). The 6 doors — plan_approve,
// goal_write (arm), goal_complete, goal_resume, goal_discard, crew_close;
// exactly the non-exec gate() permission keys — are never auto-resolved in
// any mode; they remain real dialogs. plan_close is NOT a door
// (plan-close-verified): its completion gate is plugin-verified — the
// frozen check set re-runs on the host, fail-closed, no modal.
type AskFn = (input: {
  permission: string
  patterns: string[]
  always: string[]
  metadata: Record<string, unknown>
}) => Promise<unknown>

// Exported for tests (dispatch-cancel-lifecycle 4.2): the watchdog is the
// gate() choke point itself — every door already awaits it.
// fix-crew-close-ask-door D2: `permission` is narrowed to the gate key list
// (GatePermissionKey) — a key the list does not carry is a type error here,
// so a door cannot be added without also joining the list the v2 permission
// belt derives its doors from.
export async function gate(ask: AskFn, permission: GatePermissionKey, title: string): Promise<void> {
  // fix-ask-door-multi-directory-host D3: a door with no confirmation
  // channel — the initialization that registered this tool captured no
  // host permission interface — refuses by name. Fail-closed: nothing is
  // approved and nothing executes; never a bare "ask is not a function".
  if (typeof ask !== "function") {
    throw new Error(
      `[forge:gate] The ${permission} confirmation gate has no confirmation channel on this host (the plugin's initialization for this directory captured no permission interface), so "${title}" was REFUSED (fail-closed; state is unchanged, nothing was approved).`,
    )
  }
  const watchdogMs = resolveGateAskWatchdogMs()
  // Gated-ask watchdog (dispatch-cancel-lifecycle, gate-asks spec): every
  // door awaits THIS choke point, so the watchdog is one timed race. When
  // no client adjudication arrives within the window (the 2026-11-22 TUI
  // wedge: the dialog never rendered and goal_write hung forever), the gate
  // resolves as a DISCLOSED REJECTION — fail-closed, state unchanged,
  // nothing auto-approved. 0 disables (today's posture). A decision inside
  // the window wins and cancels the timer; a late reply after a rejection
  // is harmless (the refused call stays refused).
  if (watchdogMs <= 0) {
    await ask({ permission, patterns: ["*"], always: [], metadata: { title } })
    return
  }
  let decided = false
  // Promise-wrapped: the v1 ask MAY return a plain undefined (sync ack) —
  // the proven gates awaited it verbatim; the race needs a thenable.
  const decision = (async () => ask({ permission, patterns: ["*"], always: [], metadata: { title } }))()
  decision.then(
    () => {
      decided = true
    },
    () => {
      decided = true
    },
  )
  let timer: ReturnType<typeof setTimeout> | undefined
  const watchdog = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      if (!decided) {
        console.warn(
          `[gate-watchdog] warn: no adjudication arrived within ${Math.round(watchdogMs / 1000)}s for the ${permission} confirmation gate (${title}) — refusing the call fail-closed.`,
        )
        reject(
          new Error(
            `[gate-watchdog] no adjudication arrived within ${Math.round(watchdogMs / 1000)}s for the ${permission} confirmation gate — REFUSED (fail-closed; state is unchanged, nothing was approved). ` +
              `The confirmation dialog may not be rendering (the known TUI wedge) or is simply unanswered. A late click on the stale dialog cannot approve this refused call: ` +
              `re-run the action when the user can actually see and answer the dialog.`,
          ),
        )
      }
    }, watchdogMs)
  })
  try {
    await Promise.race([decision, watchdog])
  } finally {
    clearTimeout(timer)
  }
}

// The watchdog window (spec gate-asks): default 300 s; env-tunable; 0
// disables (the gates then wait indefinitely — byte-identical to the proven
// posture). Clamped to 1 h so a typo'd value cannot wedge the other way.
const GATE_ASK_WATCHDOG_DEFAULT_MS = 300_000

export function resolveGateAskWatchdogMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.FORGE_GATE_ASK_WATCHDOG_MS)
  if (!Number.isFinite(raw) || raw < 0) return GATE_ASK_WATCHDOG_DEFAULT_MS
  return Math.min(raw, 3_600_000)
}

// ---------------------------------------------------------------------------
// Exec posture pass-through (shell-defang-default-open, spec tool-partition —
// "Exec posture pass-through on the exec surface"). Supersedes dispatch-
// resilience fold A's headless ask liveness: the plugin performs NO command
// classification on the posture path and injects NO default permission rule.
// ---------------------------------------------------------------------------

// The gate permission keys — the exact set the config hook posture-rewrites
// for the DOORS (single constant so the snapshot capture and the rewrite can
// never drift). forge_shell is snapshot-captured but never rewritten: its
// posture passes through untouched.
const GATE_PERMISSION_KEYS = [
  "plan_approve",
  "goal_write",
  "goal_complete",
  "goal_resume",
  "goal_discard",
  "forge_shell",
  "crew_close",
] as const

// Every permission a gate() call may name (fix-crew-close-ask-door D2).
type GatePermissionKey = (typeof GATE_PERMISSION_KEYS)[number]

// The USER'S OWN explicit permission values for the gate keys, captured in
// the config hook. The config hook mutates a MERGED config object that the
// host may RE-PRESENT on later passes — the anti-recapture rule is: only
// "allow"/"deny" are ever captured ("ask" never is). Only forge_shell's
// entry is CONSUMED (belt-in-depth enforcement of the user's own explicit
// rule — the rule itself now stands verbatim in the config; the snapshot is
// defense if a host ever fails to resolve plugin-tool asks); the doors
// never read it.
const gatePermissionSnapshot = new Map<string, "allow" | "deny">()

// The forge_shell posture resolution — PASS-THROUGH, no plugin-side
// resolution of any kind: (1) an explicit user "deny" refuses (the user's
// own rule, enforced belt-in-depth before any ask); (2) an explicit user
// "allow" skips the ask (again the user's own rule — the ask would resolve
// allow anyway, skipping it just avoids the round-trip); (3) otherwise the
// ask reaches the host UNMODIFIED and the host resolves it against the
// permission rules — unconfigured inherits the host default (in practice
// allow everywhere), an explicit user "ask" behaves exactly like the native
// shell tool's ask in the current mode (TUI dialog / run-mode auto-reject /
// serve pending ask). No headless branch, no classifier: the plugin is not
// smarter than the host (omo parity, product decision 2026-11-16).
async function forgeShellGate(ask: AskFn, command: string, sessionID?: string): Promise<void> {
  const explicit = explicitForgeShellPosture()
  if (explicit === "deny") {
    throw new Error(
      `[forge] forge_shell is explicitly denied by user configuration (permission forge_shell: "deny"). Nothing was executed. Remove or change the deny rule to re-enable the exec surface.`,
    )
  }
  if (explicit === "allow") {
    return // the user's own rule — skip the ask round-trip, run
  }
  try {
    await gate(ask, "forge_shell", `forge_shell: ${command.slice(0, 100)}`)
  } catch (err) {
    // worker-shell-session-allow D5 — the fallback belt (v2 worker sessions
    // ONLY): the bare no-reason deny `Permission denied: forge_shell` is the
    // host's cross-anchor deny-all fallback (the assert resolves the agent
    // at the PLUGIN HOST's location; a native worker md registers only at
    // the project location — never resolvable there). A real user deny was
    // already refused above (posture gate); a saved-rule deny carries its
    // rules and an unanswered ask reads differently ("nobody is present"),
    // so inside this scoping the bare message can ONLY be the fallback.
    // Proceed + disclose; never fires on primary sessions (their agent
    // resolves — a bare deny there is a real deny) nor on v1 hosts.
    if (
      v2HostSeen &&
      isForgeWorkerSession(sessionID) &&
      (err as { message?: unknown } | null)?.message === "Permission denied: forge_shell"
    ) {
      markSessionRescueDisclosed(sessionID!)
      return
    }
    throw err
  }
}

// ---------------------------------------------------------------------------
// worker-shell-session-allow D3 — explicit forge_shell posture from the
// host's own config DOCUMENTS (not forge.json). v2 hosts never run the v1
// config hook, so the snapshot above stays empty there; the belt resolves
// the posture by reading the host config files directly: global layer first,
// workspace layers last (highest precedence — the host's own load order);
// within one document the v2 `permissions` rule array (the V2-native field)
// wins over the legacy `permission` map; the array resolves LAST-match-wins,
// mirroring the host's findLast evaluation. allow/deny mirror into the
// snapshot so diagnostics keep one truth. Fail-soft on every layer.
// ---------------------------------------------------------------------------

// Pure core (exported for the test matrix). `documents` ordered
// lowest→highest precedence; null = absent/unreadable layer.
export function resolveForgeShellPosture(documents: Array<string | null>): "allow" | "deny" | "ask" | undefined {
  let resolved: "allow" | "deny" | "ask" | undefined
  for (const text of documents) {
    if (typeof text !== "string" || !text.trim()) continue
    const parsed = parseForgeJsonc(text)
    if (!parsed.ok) continue // a broken layer never blocks the belt
    const cfg = parsed.config as Record<string, unknown>
    // v2 rule array — the V2-native field, wins within this document.
    if (Array.isArray(cfg.permissions)) {
      let hit: "allow" | "deny" | "ask" | undefined
      for (const rule of cfg.permissions) {
        if (rule === null || typeof rule !== "object") continue
        const r = rule as { action?: unknown; resource?: unknown; effect?: unknown }
        if (r.effect !== "allow" && r.effect !== "deny" && r.effect !== "ask") continue
        if (!ruleMatchesForgeShellAssert(r.action, r.resource)) continue
        hit = r.effect // last match wins
      }
      if (hit !== undefined) {
        resolved = hit
        continue // the array decided this document
      }
    }
    // legacy v1 map.
    const legacy = cfg.permission as unknown
    const v = legacy !== null && typeof legacy === "object" ? (legacy as Record<string, unknown>).forge_shell : undefined
    if (v === "allow" || v === "deny" || v === "ask") resolved = v
  }
  return resolved
}

// The belt's assert shape is exactly (action "forge_shell", resource "*") —
// a rule matches when its action pattern matches "forge_shell" AND its
// resource pattern matches "*" (host wildcard semantics: `*` and `?`).
function ruleMatchesForgeShellAssert(action: unknown, resource: unknown): boolean {
  return wildcardMatchValue("forge_shell", action) && wildcardMatchValue("*", resource)
}

function wildcardMatchValue(value: string, pattern: unknown): boolean {
  if (typeof pattern !== "string" || pattern === "") return false
  const re = new RegExp(
    "^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$",
    "i",
  )
  return re.test(value)
}

// The host config documents for the posture belt, lowest→highest: the
// global layer (OPENCODE_CONFIG_DIR override honored, mirroring
// globalAgentDirFor's host resolution) then the workspace layers. Per
// directory the first existing name wins (opencode.json over .jsonc).
function hostConfigDocumentsFor(homeDir: string, workspace: string | null | undefined): Array<string | null> {
  const docs: Array<string | null> = []
  const pushDir = (dir: string | null | undefined) => {
    if (!dir) return
    let pushed = false
    for (const name of ["opencode.json", "opencode.jsonc"]) {
      try {
        docs.push(readFileSync(join(dir, name), "utf8"))
        pushed = true
        break
      } catch {
        // absent — try the next name
      }
    }
    if (!pushed) docs.push(null)
  }
  const cfgEnv = (process.env.OPENCODE_CONFIG_DIR ?? "").trim()
  const sep = homeDir.includes("\\") && !homeDir.includes("/") ? "\\" : "/"
  pushDir(cfgEnv || join(homeDir, ".config", "opencode"))
  if (workspace) {
    pushDir(workspace)
    pushDir(join(workspace, ".opencode"))
  }
  return docs
}

// Single posture entry: v1 hosts keep the snapshot truth (byte-equal
// behavior — the belt never reads disk there); v2 hosts resolve from the
// config documents on demand.
let v2PostureHomeDir: string | null = null
// Test seam (worker-shell-session-allow): non-null = resolve verbatim,
// keeping unit tests off the real config disk. Never set in production.
let v2PostureTestOverride: { value: "allow" | "deny" | "ask" | undefined } | null = null
function explicitForgeShellPosture(): "allow" | "deny" | "ask" | undefined {
  if (v2PostureTestOverride !== null) return v2PostureTestOverride.value
  if (!v2HostSeen) return gatePermissionSnapshot.get("forge_shell")
  const home = v2PostureHomeDir ?? homedir()
  const resolved = resolveForgeShellPosture(hostConfigDocumentsFor(home, hostWorktree))
  if (resolved === "allow" || resolved === "deny") gatePermissionSnapshot.set("forge_shell", resolved)
  return resolved
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
      output: `Plan approved by the user (approved): ${relFrom(state.worktree, active.path)}. The draft-phase write ban is lifted. Execute tasks one by one, calling plan_tick immediately after each; when all are done, self-check and call plan_close (plugin-verified, no dialog).`,
    }
  },
})

const planCloseTool = tool({
  description:
    "Close the session's plan (approved -> done). The completion gate is PLUGIN-VERIFIED — there is NO confirmation dialog. Plans with declared Verification Checks: the frozen check set is re-executed by the plugin on the host right now, fail-closed (any failing command, timeout, or unmet file contract refuses the close, appends the failing run to the plan's Check Log, and the plan stays approved — fix the work and retry; the model cannot change the checks at close time). Plans without declared checks: pass one self-check entry per acceptance criterion (pass + concrete evidence); a failing or missing check refuses the close. Either way a dated evidence-summary terminal section (per-check OK/FAIL with truncated output, or per-criterion PASS/evidence) is appended in the SAME atomic write as the done flip. The user reviews the evidence asynchronously; plan_reopen rolls back.",
  args: {
    checks: tool.schema
      .array(
        tool.schema.object({
          criterion: tool.schema.string().describe("The acceptance criterion text, copied verbatim from the plan"),
          pass: tool.schema.boolean().describe("Whether the criterion is met"),
          evidence: tool.schema.string().describe("Concrete evidence: file:line, command output, test result"),
        }),
      )
      .optional()
      .describe("Self-checks: one entry per acceptance criterion, in plan order. Required for plans without declared Verification Checks; optional extra evidence otherwise"),
  },
  execute: async (args, context) => {
    const state = ensureSession(context.sessionID, worktreeFor(context))
    const active = resolveActivePlan(state)
    if (!active) throw new PlanError("No plan to close.")
    if (active.doc.status !== "approved") {
      throw new PlanError(`Plan status is ${active.doc.status}; only an approved plan (all tasks complete) can be closed.`)
    }
    const closedAt = nowIso()
    // plan-close-verified D2: the FROZEN check set lives in the file — close
    // re-runs exactly it (runChecks imported at this plugin layer only);
    // close-time arguments can never alter the checks. Fail-closed mirrors
    // goal_complete: any failing outcome (incl. runner timeout/spawn
    // failure) appends the failing run to the plan's Check Log and throws;
    // the status stays approved.
    if (active.doc.checks.length > 0) {
      const unticked = active.doc.tasks.filter((t) => !t.done).map((t) => t.n)
      if (unticked.length > 0) {
        throw new PlanError(`Completion gate check failed:\n- Unticked tasks remain: ${unticked.join(", ")}\nTick every task before closing.`)
      }
      const outcomes = await runChecks(active.doc.checks, state.worktree)
      if (!outcomesAllOk(outcomes)) {
        const runId = `${nowIso()}-${Math.random().toString(36).slice(2, 8)}`
        atomicWrite(active.path, appendPlanCheckLog(readFileSync(active.path, "utf8"), runId, outcomes, nowIso()))
        throw new PlanError(
          `Completion gate: verification re-run failed (fail-closed). The plan stays approved; the failing run is recorded in the plan's Check Log.\n${formatOutcomes(outcomes.filter((o) => !o.ok))}\nFix the work and retry — the frozen check set is re-run at every close and cannot be changed here.`,
        )
      }
      const selfChecks = (args.checks ?? []) as CloseCheck[]
      const closed = appendTerminalSection(
        transitionStatus(readFileSync(active.path, "utf8"), "done", closedAt),
        "closed",
        {
          reason: "completion gate passed (plugin-verified)",
          ...(selfChecks.length > 0 ? { checks: selfChecks } : {}),
          outcomes: outcomes.map((o) => ({ index: o.index, ok: o.ok, label: o.label, detail: o.detail, durationMs: o.durationMs })),
          outcomeOutputLimit: OUTPUT_LIMIT,
        },
        closedAt,
      )
      atomicWrite(active.path, closed)
      context.metadata({ title: `Plan done: ${active.doc.goal}` })
      return {
        title: "plan done",
        output: `Plan completed and closed (done, plugin-verified): ${relFrom(state.worktree, active.path)}. All ${outcomes.length} frozen verification items re-run passing at the gate. Terminal section "## ${closedAt} — closed" appended with the per-check evidence summary.`,
      }
    }
    // Legacy path (no declared checks): per-criterion self-check, unchanged
    // semantics — but the modal gate is gone and the terminal write is atomic.
    if (!args.checks) {
      throw new PlanError("Completion gate check failed:\n- This plan declares no verification checks; pass one self-check entry per acceptance criterion (criterion/pass/evidence).")
    }
    const failures = closeCheckFailures(active.doc, args.checks as CloseCheck[])
    if (failures.length > 0) {
      throw new PlanError(`Completion gate check failed:\n- ${failures.join("\n- ")}\nFix the implementation and retry, or revise the plan first.`)
    }
    const closed = appendTerminalSection(
      transitionStatus(readFileSync(active.path, "utf8"), "done", closedAt),
      "closed",
      { reason: "completion gate passed (plugin-verified)", checks: args.checks as CloseCheck[] },
      closedAt,
    )
    atomicWrite(active.path, closed)
    context.metadata({ title: `Plan done: ${active.doc.goal}` })
    return {
      title: "plan done",
      output: `Plan completed and closed (done, plugin-verified): ${relFrom(state.worktree, active.path)}. All ${args.checks.length} self-checks passed. Terminal section "## ${closedAt} — closed" appended with the per-criterion verdicts.`,
    }
  },
})

const planReopenTool = tool({
  description:
    "Reopen the session's done plan (done -> approved) — the explicit rollback window after a plugin-verified close. Call it ONLY on the user's explicit instruction (they read the close evidence and asked to reopen); NEVER self-initiate. Appends a dated `— reopened` section (parser-inert), rebinds this session to the plan, and restores the approved workflow: plan_tick / plan_close (a later close re-runs the SAME frozen checks and appends a second dated close section; the frontmatter status is the single current truth). No dialog — this is a discipline-layer tool.",
  args: {
    reason: tool.schema.string().optional().describe("Short reason recorded in the reply and in the appended reopened section, verbatim"),
  },
  execute: async (args, context) => {
    const state = ensureSession(context.sessionID, worktreeFor(context))
    // resolveActivePlan skips terminal files by design, so the done plan is
    // located explicitly: the session binding first, else the newest done
    // plan in the worktree's .opencode/plan/.
    let target: { path: string; doc: PlanDoc } | null = null
    if (state.planPath && existsSync(state.planPath)) {
      const doc = parsePlanLoose(readFileSync(state.planPath, "utf8"))
      if (doc) target = { path: state.planPath, doc }
    }
    if (!target || target.doc.status !== "done") {
      const done = readPlanDir(state.worktree)
        .map((e) => ({ name: e.name, doc: parsePlanLoose(e.text) }))
        .filter((e): e is { name: string; doc: PlanDoc } => e.doc !== null && e.doc.status === "done")
        .sort((a, b) => (a.doc.updated < b.doc.updated ? 1 : a.doc.updated > b.doc.updated ? -1 : a.name.localeCompare(b.name)))[0]
      if (done) target = { path: join(planDirOf(state.worktree), done.name), doc: done.doc }
    }
    if (!target || target.doc.status !== "done") {
      throw new PlanError("No done plan to reopen in this workspace (only a closed plan can be reopened).")
    }
    const now = nowIso()
    // Same-write contract: the done -> approved flip and the dated reopened
    // narrative land in ONE atomic write; the session rebind is explicit
    // afterwards (resolveActivePlan would otherwise skip the terminal file).
    const next = appendReopenSection(transitionStatus(readFileSync(target.path, "utf8"), "approved", now), now, args.reason)
    atomicWrite(target.path, next)
    state.planPath = target.path
    const p = progressOf(target.doc)
    context.metadata({ title: `Plan reopened: ${target.doc.goal}` })
    return {
      title: "plan reopened",
      output: `Plan reopened (done -> approved): ${relFrom(state.worktree, target.path)} (${p.done}/${p.total} tasks still ticked). Session rebound to it; continue with plan_tick / plan_close — the frozen verification checks re-run at the next close.${args.reason ? ` Reason: ${args.reason}` : ""}`,
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

const forgeShellExecute = async (args: {
  command: string
  workdir?: string
  run_in_background?: boolean
  idle_ms?: number
  max_wait_ms?: number
  success_pattern?: string
  keep_alive?: boolean
  notify?: boolean
  survive?: boolean
}, context: { sessionID: string; worktree: string; ask: AskFn; metadata: (input: { title?: string; metadata?: Record<string, unknown> }) => void }) => {
  if (jobStage() >= 2) {
    throw new Error("[forge] The job supervisor is retired on this host (native backgrounding confirmed complete) — use the shell tool's run_in_background parameter.")
  }
  const state = ensureSession(context.sessionID, worktreeFor(context))
  // Permission posture (shell-defang-default-open): pass-through — the ask
  // reaches the host unmodified and the host resolves it against the
  // permission rules (no plugin-injected rule, no plugin-side
  // classification; unconfigured inherits the host default). An explicit
  // user deny always wins (snapshot-enforced). The readonly-exec-seal in
  // tool.execute.before fires structurally BEFORE this execute, so a seal
  // refusal always lands first.
  //
  // worker-shell-session-allow D4 (coverage channel): belt-inject the
  // session-rule rescue directly on a WORKER session (covers children
  // created before the primary seeding landed — and wins the first-turn
  // race against it). Fail-soft; v1 hosts have no session-rule API and
  // skip this entirely (their drafts resolve at the host anchor).
  if (isForgeWorkerSession(context.sessionID)) await ensureSessionRescueRule(context.sessionID)
  await forgeShellGate(context.ask, args.command, context.sessionID)
  const rescueNote = takeSessionRescueDisclosure(context.sessionID)
  if (rescueNote) context.metadata({ title: rescueNote })
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
      logDir: jobLogDir(),
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
      // fix-shell-spawn-error-outcome D1: a command that never started is its
      // own return form (job-supervisor: the spawn-failure form). It used to
      // share the exited text — "Command finished", "Output was delivered in
      // full above", "output:" — with the real reason on the fifth line
      // (2026-11-23 real machine: three worker calls read as finished).
      if (r.spawnError) {
        return {
          title: `not started`,
          output: [`[forge:job] NOT STARTED — spawn failed; nothing was executed.`, `cwd: ${cwd}`, `jobId: ${started.job.id}`, `spawn error: ${r.spawnError}`].join("\n"),
        }
      }
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
}

// The registered tool: a thin wrapper over forgeShellExecute that prepends
// the non-blocking known-interactive warning (exec hygiene,
// shell-defang-default-open) to whatever result the run produced. The
// warning NEVER blocks, retries, or mutates the command — the permission
// posture and the seal are the only refusers.
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
    const res = await forgeShellExecute(args, context)
    const banner = interactiveBanner(args.command)
    return banner ? { ...res, output: `${banner}\n${res.output}` } : res
  },
})

const FORGE_JOBS_ACTIONS = ["list", "poll", "log", "kill", "cancel", "stop", "clear", "handoff"]

const forgeJobsTool = tool({
  description:
    "Manage forge_shell jobs. Actions: list (all jobs, newest first); poll {jobId, waitMs<=30000} — bounded wait for NEW output or exit, drains it (polling a finished job consumes it: the entry self-clears and no wake fires); log {jobId, offset?, limit?} — line paging over the on-disk log (omitted offset = tail window, default 200 lines); kill {jobId} — terminate the job's whole process tree; cancel {jobId} — cancel ONE in-flight ASYNC DISPATCH by explicit task id, including one owned by ANOTHER session (the deliberate cross-session escape hatch behind no ownership check; its child session is aborted and CONFIRMED idle; the dispatch settles as aborted and is never retried); stop — cancel EVERY in-flight async dispatch AND every queued wish owned by THIS session only (the /forge stop lever; session-scoped by construction, other sessions' dispatches are untouched; the queued wishes leave the queue first, so none spawns into a slot a cancelled dispatch frees; nothing in flight and nothing queued = honest no-op report); clear {jobId} — drop a finished job from the registry (only un-polled early-returned/background jobs need this — synchronously consumed jobs self-clear at completion, and a terminal poll consumes the entry); handoff {jobId} — rebind ownership to the root session so the job survives this (sub)session's end. A delegated agent MUST poll its jobs before yielding its conclusion.",
  args: {
    action: tool.schema.string().describe(`One of: ${FORGE_JOBS_ACTIONS.join(", ")}`),
    jobId: tool.schema.string().optional().describe("Job id from forge_shell (required for every action except list and stop)"),
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
    if (action === "stop") {
      // Session-scoped stop (command-surface-v2-cleanup D2): the scoping
      // decision lives HERE in the tool execute layer — context.sessionID is
      // host-truth, never model-relayed. Cancel each of THIS session's
      // in-flight dispatches SERIALLY (concurrent aborts would race the idle
      // assertion); nothing in flight and nothing queued = honest no-op
      // report. No jobId: the scope IS the calling session.
      // fix-stop-cancels-queued-wishes D1: the session's queued wishes leave
      // the queue FIRST. A slot freed by a cancelled dispatch is pumped the
      // moment that row settles, so a queue still in place would spawn its
      // head before the last cancel returns — the user would watch new
      // children start right after asking for everything to stop.
      const client = dispatchClient()
      if (!client) throw new Error("[forge] stop: no dispatch client on this host.")
      const sid = context.sessionID
      // D5: a wish the queue pump is spawning RIGHT NOW is in neither the
      // queue nor the registry. Mark the stop (a pump reads the epoch when it
      // dequeues), empty the queue, then let the pumps that are running land:
      // a wish whose child is still being created is cancelled unprompted
      // (the pump journals it and hands it to this receipt); one whose prompt
      // already went out is a registered in-flight dispatch the loop below
      // cancels like any other.
      const epoch = stopEpoch(sid) + 1
      stopEpochs.set(sid, epoch)
      stopWaiting.add(sid)
      let landed: "settled" | "timeout"
      let stillLanding = 0
      let flight: string[]
      let queuedCancelled: string[]
      try {
        queuedCancelled = cancelQueuedWishes(sid)
        landed = await settlePumps(sid)
        stillLanding = inTransitWishes(sid).length
        flight = inFlightAsyncDispatches(sid)
      } finally {
        // Same sync edge as the registry read above: a wish registered after
        // this point is cancelled by its own pump.
        stopWaiting.delete(sid)
      }
      // Wishes this session's pumps cancelled unprompted while the lever was
      // waiting. The first lever to resume takes them (a second stop waiting
      // on the same pumps never reports them twice).
      queuedCancelled.push(...(stopDequeued.get(sid) ?? []))
      stopDequeued.delete(sid)
      if (flight.length === 0 && queuedCancelled.length === 0 && stillLanding === 0) {
        return { title: "stop", output: `[forge:job] No async dispatches in flight for this session (${sid}) — nothing to stop.` }
      }
      const results: string[] = []
      for (const taskId of flight) {
        const res = await stopSerialCancel(sid, () => cancelDispatch(client, taskId))
        results.push(`- ${res.text}`)
      }
      return stopReceipt(sid, flight.length, results, queuedCancelled, landed === "timeout" ? stillLanding : 0, stopSettleMs())
    }
    if (!args.jobId) throw new Error(`Action "${action}" requires jobId.`)
    // "all" refusal hoisted BEFORE the registry lookup (command-surface
    // cleanup nit, flagged by the test wave): cancel "all" must always
    // reach the retirement redirect — never a "No job all in the registry"
    // miss on a registry that has no such row.
    if (action === "cancel" && String(args.jobId).trim().toLowerCase() === "all") {
      throw new Error('[forge] cancel "all" is retired — use action "stop" (cancels THIS session\'s in-flight and queued dispatches) or cancel an explicit task id.')
    }
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
      // fix-shell-spawn-error-outcome D2: a terminal job whose process never
      // started says so in its first sentence (it used to read as a plain
      // "killed" row — indistinguishable from a command that ran and was
      // stopped).
      if (job.spawnError) {
        return {
          title: `${job.id}: not started`,
          output: [
            `[forge:job] ${job.id}: NOT STARTED — spawn failed; nothing was executed (terminal state: ${p.state}).`,
            `spawn error: ${job.spawnError}`,
            `new output:\n${p.newOutput || "(none in this window)"}`,
            `logPath: ${p.logPath}`,
          ].join("\n"),
        }
      }
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
      // A dispatch row killed through the generic action: stamp its reason
      // BEFORE the kill (the hook keeps an already-stamped reason) so the
      // journal and the wake name THIS lever — not an owner death.
      {
        const meta = (job as Job & { dispatch?: DispatchJobMeta }).dispatch
        if (meta && meta.outcome !== "stream-lost/unknown") meta.abortReason = EXPLICIT_KILL_ABORT_REASON
      }
      jobManager.kill(job)
      return { title: `${job.id} killed`, output: `[forge:job] ${job.id}: tree kill issued (state: killed).` }
    }
    if (action === "cancel") {
      // Dispatch cancellation engine (dispatch-cancel-lifecycle): abort +
      // CONFIRMED-idle assertion + aborted settle + never-retried. Per-id
      // ONLY (command-surface-v2-cleanup D2): the explicit task id is the
      // deliberate cross-session escape hatch — cancelDispatch performs no
      // ownership check BY DESIGN (spec-pinned). The session-scoped bulk
      // form is the `stop` action; "all" is retired. A non-dispatch job
      // refuses with the in-flight list (kill stays the generic lever).
      const client = dispatchClient()
      if (!client) throw new Error("[forge] cancel: no dispatch client on this host.")
      const res = await cancelDispatch(client, args.jobId)
      if (!res.ok) return { title: `${args.jobId} not cancellable`, output: `[forge:job] ${res.text}` }
      return { title: `${args.jobId} cancelled (${res.idle})`, output: `[forge:job] ${res.text}` }
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

// ---------------------------------------------------------------------------
// task (change task-shadow, spec: forge-subagents — "Task shadow surface" +
// "Dispatch lifecycle"): the 0.22.0 SDK dispatch engine registered under the
// NATIVE tool name `task` (OMO-proven shadow — the TUI keys its live
// subagent panel on the tool NAME), host-wide. Dispatches ANY materialized
// target as a REAL child session on the same host (SDK session.create with
// parentID): forge-* targets pass the full forge gate chain (pool gate,
// crew belts, cap, draft interop); non-forge host targets ride the same
// engine without the forge pool gate (native parity). run_in_background
// selects the mode: sync blocks (question tool available — native parity,
// abort parity: turn abort kills the child), async returns a handle (child
// created with the question tool denied session-wide; single completion
// wake through the job-wake path). forge_dispatch is RETIRED. The
// child-session lifecycle core is src/dispatch-async.ts (structural client
// seam, no @opencode-ai imports).
// ---------------------------------------------------------------------------

// Host agent vocabulary (task-shadow full-parity non-forge path): refreshed
// from the merged agent section on every config pass; the native fallbacks
// are always members. A non-forge target outside this set is an honest
// "Agent not found" refusal.
const knownHostAgents = new Set<string>(["general", ...NATIVE_PARTITION_FALLBACKS])

// Per-session concurrent async cap (spec: Dispatch lifecycle).
export const ASYNC_DISPATCH_CAP = 3

// ---------------------------------------------------------------------------
// Provider-dimension dispatch gate + circuit breaker
// (harden-dispatch-resilience design D3). One host-process gate singleton:
// live counters (provider + provider/model) and per-provider breaker state
// survive config hot-applies (updateConfig only swaps the limits). Fed at
// the terminal-recording seam (journalTerminalRecord), enforced at the
// dispatch call before child creation and re-checked at queue dequeue.
// ---------------------------------------------------------------------------

// sessionID → the session's resolved model (captured at chat.params /
// session.context request-build time — the same resolution chain chat.params
// sees; child sessions report here too, so a finished child's model is the
// terminal feed's session-model fallback).
const sessionModels = new Map<string, ModelIdentity>()

// The host-process gate singleton (null until the first dispatch resolves
// it — an unconfigured host never builds one).
let dispatchGate: DispatchGate | null = null

// jobId → identity for every ADMITTED dispatch whose terminal has not yet
// fed the gate (the release bookkeeping; spawn failures release eagerly).
const admittedGate = new Map<string, ModelIdentity>()

// Every provider ever admitted on this host (test seam: the breaker table
// survives releases, so the observation set is tracked alongside).
const gateProvidersSeen = new Set<string>()

// Anchor-keyed cascade loaders for the dispatch node (global base + the
// session workspace's nearest forge.json override — the same cascade
// semantics as the agent set, with mtime hot-apply).
const dispatchConfigLoaders = new Map<string, ReturnType<typeof createForgeConfigLoader>>()
function dispatchConfigFor(anchor: string): DispatchNodeConfig | null {
  const key = anchor || "-"
  let l = dispatchConfigLoaders.get(key)
  if (!l) {
    l = createForgeConfigLoader({ projectDir: anchor, homeDir: process.env.FORGE_TEST_FORGE_HOME ?? homedir() })
    dispatchConfigLoaders.set(key, l)
    while (dispatchConfigLoaders.size > 8) {
      const oldest = dispatchConfigLoaders.keys().next().value
      if (oldest === undefined) break
      dispatchConfigLoaders.delete(oldest)
    }
  }
  return l.load().dispatch ?? null
}

/** The gate with the anchor's dispatch config hot-applied (state survives). */
function gateFor(anchor: string): DispatchGate {
  if (!dispatchGate) dispatchGate = createDispatchGate()
  const node = dispatchConfigFor(anchor)
  dispatchGate.updateConfig(
    node
      ? {
          providerConcurrency: node.providerConcurrency,
          modelConcurrency: node.modelConcurrency,
          circuitBreaker: { consecutiveFailures: node.circuitBreaker.consecutiveFailures ?? 0, cooldownMs: node.circuitBreaker.cooldownMs ?? 0 },
        }
      : null,
  )
  return dispatchGate
}

/**
 * Agent → model identity (the chat.params resolution chain): a forge-*
 * target's PINNED model from the pool lookup (fresh resolve, hot-apply);
 * anything unpinned falls back to the session's captured model — the CHILD
 * session's when known, else the dispatching owner's (the child inherits
 * the parent's model until its own first request-build reports). Null when
 * nothing resolves: the dispatch is honestly uncounted (no gate applies —
 * an uncounted dimension is never limited).
 */
function dispatchModelIdentity(agentID: string, ownerSession: string, childSessionID?: string): ModelIdentity | null {
  if (agentID.toLowerCase().startsWith("forge-")) {
    const def = resolvePools()?.agents[agentID.slice("forge-".length)]?.def
    if (def?.model) {
      const identity = parseIdentity(def.model)
      if (identity) return { provider: identity.provider, model: identity.model }
    }
  }
  if (childSessionID && sessionModels.has(childSessionID)) return sessionModels.get(childSessionID) ?? null
  return sessionModels.get(ownerSession) ?? null
}

/**
 * Roster pin → create-time model binding (dispatch-v2-hostsignals task 2.1):
 * a forge-* target's PINNED model from the FRESH pool resolution — the
 * create body's `model` key binds it at spawn (host precedence: an explicit
 * create model wins). Null for Auto workers and non-forge targets: no model
 * key, the host default applies (agent's configured model, else inherited).
 * Variant leg (fix-runtime-model-pin-variant D2): when the recipe's
 * thoughtLevel is a variant word (low/medium/high), the pin carries it as
 * `variant` — the same value the compiled `.md` model string would carry as
 * `#<depth>` — so the session's model record (what the UI reads) shows the
 * real depth even when the host did not pre-resolve the agent file.
 */
function rosterModelPin(agentID: string): { providerID: string; modelID: string; variant?: string } | null {
  if (!agentID.toLowerCase().startsWith("forge-")) return null
  const def = resolvePools()?.agents[agentID.slice("forge-".length)]?.def
  if (!def?.model) return null
  const identity = parseIdentity(def.model)
  if (!identity) return null
  const depth = typeof def.thoughtLevel === "string" ? def.thoughtLevel : ""
  return VARIANT_DEPTH_WORDS.includes(depth)
    ? { providerID: identity.provider, modelID: identity.model, variant: depth }
    : { providerID: identity.provider, modelID: identity.model }
}

/**
 * Pre-spawn roster validation (dispatch-v2-hostsignals task 2.2): a forge-*
 * target MUST resolve in the live pool resolution — refuse-not-degrade,
 * naming the agent and the roster source (the task 1.1 probe proved the
 * host's create accepts ANY agent id verbatim, bogus included: without this
 * check a drifted roster spawns a naked default-agent child). Host-built-in
 * targets (general/explore) resolve in the host's own registry and pass.
 * Null = dispatchable.
 */
function forgeTargetUnresolved(agentID: string): string | null {
  if (!agentID.toLowerCase().startsWith("forge-")) return null
  const resolution = resolvePools()
  if (resolution?.agents[agentID.slice("forge-".length)]) return null
  return (
    `"${agentID}" does not resolve in the live roster (pool source: ` +
    `${resolution ? "the workspace pool resolution" : "none — no forge.json in scope for this host"}); ` +
    `refusing to spawn a default-agent child — re-sync the roster (/forge sync) or correct the target`
  )
}

/**
 * Nested-dispatch guard rule (harden-dispatch-resilience D2): a NON-forge
 * host-agent target served by the anthropic family gets the task-tool deny
 * on its create body. forge family targets are untouched here — their depth
 * is structurally capped at ≤1 by the materialized `task: deny`
 * (dispatch-tiers), so this guard never stacks on it. The childSessionID
 * seam (design "known leftovers" — the dead parameter, consumed here):
 * respawn sites pass the PREVIOUS child's id so an unpinned (Auto) worker
 * resolves the child's own captured model, not just the owner's.
 */
function nestedTaskDenyFor(agentID: string, ownerSession: string, childSessionID?: string): boolean {
  const id = agentID.toLowerCase()
  if (id === "forge" || id.startsWith("forge-")) return false
  const identity = dispatchModelIdentity(agentID, ownerSession, childSessionID)
  return identity !== null && dispatchProviderFamily(identity.provider) === "anthropic"
}

/** Release an admission eagerly (spawn failed before any child existed). */
function releaseGateAdmission(jobId: string): void {
  const identity = admittedGate.get(jobId)
  if (!identity) return
  admittedGate.delete(jobId)
  try {
    dispatchGate?.release(identity)
  } catch {
    // Fail-soft by contract.
  }
}

type DispatchHandle = { jobId: string; childSessionID: string; agentID: string; ownerSession: string; description: string }
// jobId -> handle. Entries are pruned when the poller settles or the owner
// session ends; the cap counts entries whose registry job is still running.
const dispatchTasks = new Map<string, DispatchHandle>()

// fix-multi-location-session-anchor (design D1 方案甲 item 1): the moment a
// dispatch child EXISTS it is bound to the owner's resolved directory — the
// very directory the child was created in — so its first tool call never
// reaches the plugin-level default. On a multi-directory host that default
// is the LAST-initialized directory: the 2026-11-23 real-machine incident had
// a review worker (host record: this workspace) bound to the Unity project,
// and its three forge_shell calls failed to spawn (cwd did not exist).
// One binding, three entry shapes:
//   - created here and now  → createChildSessionBound (parentDirectory)
//   - adopted / re-armed    → registerDispatchTask (the dispatch's directory)
// Both are idempotent (ensureSession never lets a degenerate value clobber).
function bindChildToDirectory(childSessionID: string | undefined, directory: string | undefined): void {
  if (!childSessionID || !directory || isRootish(directory)) return
  ensureSession(childSessionID, directory)
}

async function createChildSessionBound(client: DispatchClient, input: CreateChildInput): Promise<CreateChildResult> {
  const created = await createChildSession(client, input)
  if (created.ok) bindChildToDirectory(created.sessionID, input.parentDirectory)
  return created
}

function registerDispatchTask(handle: DispatchHandle, directory: string | undefined): void {
  dispatchTasks.set(handle.jobId, handle)
  bindChildToDirectory(handle.childSessionID, directory)
}

function inFlightAsyncDispatches(sessionID: string): string[] {
  const ids: string[] = []
  for (const [id, handle] of dispatchTasks) {
    if (handle.ownerSession !== sessionID) continue
    const job = jobManager.get(id)
    if (job) {
      if (job.state === "running") ids.push(id)
    } else {
      dispatchTasks.delete(id)
    }
  }
  return ids
}

// ---------------------------------------------------------------------------
// dispatch-resilience fold D — per-session FIFO queue: the 4th+ async wish
// from one session QUEUES (bounded FORGE_DISPATCH_QUEUE_MAX, default 10)
// instead of being refused; a pump spawns the queue head on every slot
// release (any terminal transition of that session's dispatches). Belts
// evaluate at CALL time (unchanged); the pump re-checks the target roster,
// the draft gate, and the crew belt at SPAWN time — a tightening between
// call and spawn fails the wish as an honest error wake, never silently.
// Owner death flushes queued wishes WITHOUT spawning and terminalizes their
// journal records (fold E).
// ---------------------------------------------------------------------------

/** Default queue bound per session (FORGE_DISPATCH_QUEUE_MAX). */
export const DEFAULT_DISPATCH_QUEUE_MAX = 10

/** Resolve FORGE_DISPATCH_QUEUE_MAX (default 10; invalid → default). */
export function resolveDispatchQueueMax(env: { [key: string]: string | undefined } = process.env): number {
  const raw = env.FORGE_DISPATCH_QUEUE_MAX
  if (raw === undefined || raw === "") return DEFAULT_DISPATCH_QUEUE_MAX
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_DISPATCH_QUEUE_MAX
  return Math.round(parsed)
}

type QueuedDispatchWish = {
  jobId: string
  agentID: string
  ownerSession: string
  description: string
  prompt: string
  directory: string
  questionDeny: boolean
  enqueuedAt: number
}

// ownerSession → FIFO wishes (queue order = enqueue order).
const dispatchQueues = new Map<string, QueuedDispatchWish[]>()

// fix-stop-cancels-queued-wishes D5: the queue pump's TRANSIT window. Between
// `queue.shift()` and `registerDispatchTask` a wish sits in several awaits
// (the crew-belt read, child creation, prompt send) — in neither the queue
// nor the registry. A stop that lands inside that window must not miss it, or
// the wish would start right after the user asked for everything to stop.
//   stopEpochs   session → bumped by every stop. A pump iteration that
//                dequeued under an older epoch knows a stop landed while it
//                was in transit.
//   stopWaiting  sessions whose stop lever is waiting for their pumps to
//                land (or is about to read the registry). A wish registered
//                while its owner is in here is seen by that lever.
//   PumpRun      one running pump: the wish it holds (null = none) and its
//                completion. `pumpInFlight` lets the lever wait for a wish in
//                transit to land on one side or the other, and lets a notice
//                about such a wish count as live.
//   stopDequeued wishes a pump cancelled itself because a stop landed while
//                they were in transit unprompted; a lever that is waiting
//                folds them into its receipt (a note is left only when one
//                is, and consumed by the first lever to resume — a second
//                stop waiting on the same pump never reports it twice).
const stopEpochs = new Map<string, number>()
const stopWaiting = new Set<string>()
type PumpRun = { wishId: string | null; done: Promise<void> }
const pumpInFlight = new Map<string, Set<PumpRun>>()
const stopDequeued = new Map<string, string[]>()

const stopEpoch = (sessionID: string): number => stopEpochs.get(sessionID) ?? 0
const stoppedSince = (sessionID: string, epoch: number): boolean => stopEpoch(sessionID) !== epoch

/** Wishes a pump of `sessionID` holds right now (dequeued, not registered yet). */
function inTransitWishes(sessionID: string): string[] {
  const ids: string[] = []
  for (const run of pumpInFlight.get(sessionID) ?? []) if (run.wishId) ids.push(run.wishId)
  return ids
}

/**
 * How long the stop lever lets a wish in transit land (FORGE_STOP_SETTLE_MS
 * overrides it for tests). A parked host call is not waited for past this.
 */
function stopSettleMs(): number {
  const raw = Number(process.env.FORGE_STOP_SETTLE_MS)
  return Number.isFinite(raw) && raw > 0 ? Math.min(raw, 60_000) : 15_000
}

/** Wait (bounded) for the pumps of `sessionID` that are running right now. */
async function settlePumps(sessionID: string): Promise<"settled" | "timeout"> {
  const pumps = [...(pumpInFlight.get(sessionID) ?? [])]
  if (pumps.length === 0) return "settled"
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      Promise.allSettled(pumps.map((run) => run.done)).then(() => "settled" as const),
      new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), stopSettleMs())
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

// Cancels of one session's dispatches run ONE AT A TIME (concurrent aborts
// would race the idle assertion). The stop lever's cancels and a pump's
// self-cancel (a wish that landed after its lever stopped waiting) share
// this per-session chain, so they can never overlap.
const stopCancelTails = new Map<string, Promise<void>>()
function stopSerialCancel<T>(sessionID: string, cancel: () => Promise<T>): Promise<T> {
  const next = (stopCancelTails.get(sessionID) ?? Promise.resolve()).then(cancel)
  const settled: Promise<void> = next.then(
    () => undefined,
    () => undefined,
  )
  stopCancelTails.set(sessionID, settled)
  void settled.then(() => {
    if (stopCancelTails.get(sessionID) === settled) stopCancelTails.delete(sessionID)
  })
  return next
}

function queuedAsyncDispatchIds(sessionID: string): string[] {
  return (dispatchQueues.get(sessionID) ?? []).map((w) => w.jobId)
}

/** The queued-start progress notice (spec: "a progress notice announcing the queued wish's start"). */
function announceQueuedStart(ownerSession: string, notice: string, jobId: string): void {
  // Delivered only while the wish is still queued or in flight — never
  // after it was cancelled or settled (fix-stale-progress-notice).
  queueDispatchProgress(ownerSession, notice, () => dispatchStillLive(jobId))
  if (idleJobSessions.has(ownerSession)) void deliverDispatchProgress(ownerSession)
}

/**
 * Fail a queued wish as an honest ERROR WAKE at spawn time (roster vanished,
 * draft tightened, crew belt) — the wish never spawns, and the single
 * terminal wake carries the reason (never silent).
 */
function failQueuedWishHonestly(wish: QueuedDispatchWish, reason: string): void {
  const job = jobManager.create({
    id: wish.jobId,
    cmd: `dispatch ${wish.agentID}: ${wish.description} (queued, refused at spawn)`,
    worktree: wish.directory,
    ownerSession: wish.ownerSession,
    logPath: join(jobLogDir(), "dispatch", `${wish.jobId}.txt`),
    notify: true,
    killTree: () => {},
  })
  ;(job as Job & { dispatch?: DispatchJobMeta }).dispatch = {
    agentID: wish.agentID,
    childSessionID: "",
    description: wish.description,
  }
  const text = `(spawn refused at queue pump: ${reason} — the queued wish never spawned)`
  jobManager.appendOutput(job, text)
  jobManager.markTerminal(job, "exited", 1)
  journalTerminalRecord(
    { id: wish.jobId, agent: wish.agentID, ownerSession: wish.ownerSession, workspace: wish.directory },
    "error",
    text,
  )
}

/**
 * The queue pump (fold D): spawn queued wishes FIFO while the session has
 * free async slots. Spawn-time re-checks (design D4): the target roster,
 * the draft gate, and the crew belt — a tightening fails the wish as an
 * honest error wake instead of spawning. Retry interplay: a retrying
 * dispatch keeps its registry slot (its job row stays "running"), so the
 * pump sees no free slot until the retry chain settles — queued wishes
 * never jump a retry.
 */
function pumpDispatchQueue(client: DispatchClient, sessionID: string): Promise<void> {
  const run: PumpRun = { wishId: null, done: Promise.resolve() }
  let pumps = pumpInFlight.get(sessionID)
  if (!pumps) pumpInFlight.set(sessionID, (pumps = new Set()))
  pumps.add(run)
  run.done = pumpDequeuedWishes(client, sessionID, run).finally(() => {
    // Also on a rejected body: a wish is never left "in transit" for good
    // (it would hold a cap slot and read as live forever).
    run.wishId = null
    const left = pumpInFlight.get(sessionID)
    if (!left) return
    left.delete(run)
    if (left.size === 0) pumpInFlight.delete(sessionID)
  })
  return run.done
}

/**
 * fix-stop-cancels-queued-wishes D5: a wish the pump had dequeued is
 * cancelled because a stop landed while it was in transit, BEFORE its prompt
 * went out. `child` = a child session the pump managed to create (never
 * prompted): aborted as cleanup only, exactly like the retry respawn
 * window's "empty husk". No registry row ever existed, so nothing settles
 * and no wake follows — the stop receipt is the report. When a lever is
 * waiting for this pump, the wish is handed to its receipt.
 */
function cancelDequeuedByStop(client: DispatchClient, wish: QueuedDispatchWish, child: string | undefined): void {
  releaseGateAdmission(wish.jobId)
  // The empty child's abort is cleanup, not a cancel: nothing is awaited and
  // an empty session cannot be running anything (same rule as the retry
  // respawn window's "empty husk").
  if (child) dispatchKillTreeHook(client, wish.jobId, () => child)()
  journalTerminalRecord(
    { id: wish.jobId, agent: wish.agentID, ownerSession: wish.ownerSession, workspace: wish.directory, description: wish.description, questionDeny: wish.questionDeny },
    "aborted",
    STOP_DEQUEUED_REASON,
  )
  const sessionID = wish.ownerSession
  if (!stopWaiting.has(sessionID)) return
  const notes = stopDequeued.get(sessionID) ?? []
  notes.push(wish.jobId)
  stopDequeued.set(sessionID, notes.slice(-50))
}

async function pumpDequeuedWishes(client: DispatchClient, sessionID: string, run: PumpRun): Promise<void> {
  for (;;) {
    // Sync edge: the previous iteration's wish has landed (registered, or
    // terminal) before the next one is dequeued, so it is no longer in transit.
    run.wishId = null
    const queue = dispatchQueues.get(sessionID)
    if (!queue || queue.length === 0) return
    // A wish another pump is spawning holds its slot already.
    if (inFlightAsyncDispatches(sessionID).length + inTransitWishes(sessionID).length >= ASYNC_DISPATCH_CAP) return
    const wish = queue.shift()
    if (queue.length === 0) dispatchQueues.delete(sessionID)
    if (!wish) return
    // fix-stop-cancels-queued-wishes D5: from here until the row is
    // registered this wish is in transit. A stop that lands meanwhile is
    // recognised through the session's stop epoch (read at dequeue).
    run.wishId = wish.jobId
    const stopEpochAtDequeue = stopEpoch(sessionID)
    // --- spawn-time re-checks (belts evaluated at CALL time; these are the
    // tightening guards). A refusal = honest error wake, never a spawn.
    if (wish.agentID.toLowerCase().startsWith("forge-")) {
      const agentId = wish.agentID.slice("forge-".length)
      const resolution = resolvePools()
      if (!resolution || !resolution.agents[agentId]) {
        failQueuedWishHonestly(
          wish,
          `"${wish.agentID}" is no longer a materialized forge subagent on this host (the roster changed while the wish was queued)`,
        )
        continue
      }
    }
    const crewRefusal = crewPendingRefusal(sessionID) ?? (await crewComplianceRefusalFor(jobClient, sessionID, wish.agentID))
    if (crewRefusal) {
      failQueuedWishHonestly(wish, crewRefusal)
      continue
    }
    // D5: the belt read above is an await too — a stop that landed during it
    // cancels the wish before any child session is created.
    if (stoppedSince(sessionID, stopEpochAtDequeue)) {
      cancelDequeuedByStop(client, wish, undefined)
      continue
    }
    const draftRefusal = draftDispatchRefusal(sessionID, wish.agentID)
    if (draftRefusal) {
      failQueuedWishHonestly(wish, draftRefusal)
      continue
    }
    // Provider gate re-check (harden-dispatch-resilience D3): the gate is
    // re-evaluated at DEQUEUE time — a breaker that opened (or a limit that
    // tightened via hot-apply) while the wish was queued fails it as an
    // honest error wake, never a silent skip. Breaker refusals are the
    // plugin's own throttle — they never enter the provider-retry path
    // (nothing has spawned; the classifier is never consulted).
    const gate = gateFor(wish.directory)
    const wishIdentity = dispatchModelIdentity(wish.agentID, wish.ownerSession)
    if (wishIdentity) {
      const admission = gate.admit(wishIdentity)
      if (!admission.ok) {
        failQueuedWishHonestly(wish, admission.refusal)
        continue
      }
      gateProvidersSeen.add(wishIdentity.provider)
      admittedGate.set(wish.jobId, wishIdentity)
    }
    // --- spawn: same engine as the direct async path.
    const created = await createChildSessionBound(client, {
      parentSessionID: wish.ownerSession,
      parentDirectory: wish.directory,
      agentID: wish.agentID,
      description: wish.description,
      questionDeny: wish.questionDeny,
      // Agent-bound creation (dispatch-v2-hostsignals 2.1): the roster pin
      // rides the create body; the binding is asserted on the record read
      // back (v2 proven by the task 1.1 probe — v1 records not probed, the
      // assert stays off there).
      modelPin: rosterModelPin(wish.agentID),
      assertBinding: v2HostSeen,
      // Nested-dispatch guard (D2): re-resolved at SPAWN time like every
      // other pump re-check — the model identity may have shifted while the
      // wish sat queued.
      taskDeny: nestedTaskDenyFor(wish.agentID, wish.ownerSession),
    })
    if (!created.ok) {
      releaseGateAdmission(wish.jobId)
      failQueuedWishHonestly(wish, `child session creation failed: ${created.error}`)
      continue
    }
    if (stoppedSince(sessionID, stopEpochAtDequeue)) {
      // D5: a stop landed WHILE this child session was being created. The
      // wish is cancelled like one that was still queued — it is never
      // prompted. The created-but-empty child is aborted as cleanup only
      // (the retry respawn window's "empty husk" rule); the stop receipt
      // folds the wish into its queued group.
      cancelDequeuedByStop(client, wish, created.sessionID)
      continue
    }
    const sent = await sendPrompt(client, {
      sessionID: created.sessionID,
      agentID: wish.agentID,
      prompt: wish.prompt,
      directory: wish.directory,
    })
    if (!sent.ok) {
      releaseGateAdmission(wish.jobId)
      failQueuedWishHonestly(wish, `prompt send to child session ${created.sessionID} failed: ${sent.error}`)
      continue
    }
    const job = jobManager.create({
      id: wish.jobId,
      cmd: `dispatch ${wish.agentID}: ${wish.description}`,
      worktree: wish.directory,
      ownerSession: wish.ownerSession,
      logPath: join(jobLogDir(), "dispatch", `${wish.jobId}.txt`),
      notify: true,
      killTree: dispatchKillTreeHook(client, wish.jobId, () => created.sessionID),
    })
    ;(job as Job & { dispatch?: DispatchJobMeta }).dispatch = { agentID: wish.agentID, childSessionID: created.sessionID, description: wish.description }
    registerDispatchTask({ jobId: wish.jobId, childSessionID: created.sessionID, agentID: wish.agentID, ownerSession: wish.ownerSession, description: wish.description }, wish.directory)
    journalTransition(
      wish.directory,
      journalRecord(
        { id: wish.jobId, agent: wish.agentID, ownerSession: wish.ownerSession, workspace: wish.directory, questionDeny: wish.questionDeny, description: wish.description, prompt: wish.prompt },
        "started",
        { childSessionId: created.sessionID },
      ),
    )
    announceQueuedStart(
      wish.ownerSession,
      `[forge:dispatch-progress] wish ${wish.jobId} spawned from the queue (agent ${wish.agentID}, child session ${created.sessionID}) — tracking as a normal async dispatch; the single [forge:dispatch-complete] wake reports when it finishes.`,
      wish.jobId,
    )
    void runAsyncDispatchPoller(client, job, created.sessionID, {
      prompt: wish.prompt,
      directory: wish.directory,
      questionDeny: wish.questionDeny,
    })
    if (stoppedSince(sessionID, stopEpochAtDequeue) && !stopWaiting.has(sessionID)) {
      // D5: the prompt was already on its way when a stop landed, and no
      // lever is waiting to cancel what it started (it gave up waiting, or
      // already read the registry). The row is a normal in-flight dispatch
      // now — cancel it through the lever's own path, serially with any
      // lever cancels still running for this session.
      void stopSerialCancel(sessionID, () => cancelDispatch(client, wish.jobId)).catch((err: unknown) => {
        console.warn(`[forge:dispatch] stop: the late-landing task ${wish.jobId} could not be cancelled by its own pump: ${String(err)}`)
      })
    }
  }
}

/**
 * Owner death (fold D 4.3): queued wishes flush WITHOUT spawning — nothing
 * to abort (no child exists) — and their journal records terminalize.
 */
function flushDispatchQueue(sessionID: string): void {
  const queue = dispatchQueues.get(sessionID)
  if (!queue) return
  dispatchQueues.delete(sessionID)
  for (const wish of queue) {
    journalTerminalRecord(
      { id: wish.jobId, agent: wish.agentID, ownerSession: wish.ownerSession, workspace: wish.directory },
      "aborted",
      `owner session ${sessionID} ended before the queued wish spawned — flushed without spawning`,
    )
  }
}

// fix-stop-cancels-queued-wishes D2/D3: the stop lever's queue half. The
// session's queued wishes leave the queue WITHOUT spawning and their journal
// records terminalize — there is no child to abort and no registry row to
// settle, so no wake follows: the stop receipt is the report and the terminal
// journal record is what restart recovery reads (never re-entered). The
// sentence keeps the lever prefix the in-flight rows carry, and says what is
// true here: nothing was spawned.
export const STOP_QUEUED_REASON =
  "cancelled by the user lever (/forge stop) — the wish was still queued: nothing was spawned and the dispatch is never retried"

// D5: the same lever, for a wish the queue pump had dequeued and was creating
// a child session for when stop landed — that child was never prompted.
export const STOP_DEQUEUED_REASON =
  "cancelled by the user lever (/forge stop) — the wish was leaving the queue when stop arrived: it was never prompted and the dispatch is never retried"

function cancelQueuedWishes(sessionID: string): string[] {
  const queue = dispatchQueues.get(sessionID)
  if (!queue || queue.length === 0) return []
  dispatchQueues.delete(sessionID)
  const ids: string[] = []
  for (const wish of queue) {
    ids.push(wish.jobId)
    // Same base the queued record carried (description + question flag), so
    // the terminal line reads like every other dispatch's.
    journalTerminalRecord(
      { id: wish.jobId, agent: wish.agentID, ownerSession: wish.ownerSession, workspace: wish.directory, description: wish.description, questionDeny: wish.questionDeny },
      "aborted",
      STOP_QUEUED_REASON,
    )
  }
  return ids
}

/**
 * The stop lever's receipt (pure): the in-flight rows first, then the
 * cancelled queued wishes as their own line, then — only when the lever
 * stopped waiting while a wish was still being spawned (D5) — a line saying
 * so. A session with queued wishes and nothing in flight is not reachable
 * while the queue pump is healthy (a wish queues only behind a full cap) —
 * the receipt still says exactly that.
 */
export function stopReceipt(
  sessionID: string,
  flightCount: number,
  rows: string[],
  queuedCancelled: string[],
  stillLanding = 0,
  settleMs = 0,
): { title: string; output: string } {
  const queuedNote =
    queuedCancelled.length > 0
      ? `\n[forge:job] Cancelled ${queuedCancelled.length} queued wish(es) of this session — removed from the queue before they could spawn (nothing was running for them): ${queuedCancelled.join(", ")}`
      : ""
  const landingNote =
    stillLanding > 0
      ? `\n[forge:job] ${stillLanding} queued wish(es) of this session were still being started when the lever stopped waiting (${Math.max(1, Math.round(settleMs / 1000))} s) — each is cancelled the moment it lands; nothing of them is left running.`
      : ""
  if (flightCount === 0) {
    return {
      title: queuedCancelled.length > 0 ? `${queuedCancelled.length} queued wish(es) cancelled` : "stop",
      output: `[forge:job] No async dispatches in flight for this session (${sessionID}).${queuedNote}${landingNote}`,
    }
  }
  return {
    title: `${flightCount} dispatch(es) stopped`,
    output: `[forge:job] Stopped ${flightCount} in-flight dispatch(es) of this session:\n${rows.join("\n")}${queuedNote}${landingNote}`,
  }
}

// ---------------------------------------------------------------------------
// dispatch-resilience fold E — persisted journal + restart recovery. The
// journal is the memory; init is the resurrection. One journal instance per
// workspace (lazy), fs injectable for tests, every operation fail-soft.
// ---------------------------------------------------------------------------

const dispatchJournals = new Map<string, DispatchJournal>()
let dispatchJournalFsFactory: ((filePath: string) => JournalFs) | null = null

function journalFor(worktree: string): DispatchJournal {
  let j = dispatchJournals.get(worktree)
  if (!j) {
    const filePath = join(worktree, ".opencode", "forge", "dispatch-log.jsonl")
    const fs = dispatchJournalFsFactory ? dispatchJournalFsFactory(filePath) : undefined
    j = createDispatchJournal(filePath, { fs, maxRecords: resolveJournalMax() })
    dispatchJournals.set(worktree, j)
  }
  return j
}

/** Journal base fields shared by every transition of one dispatch. */
type JournalBase = {
  id: string
  agent: string
  ownerSession: string
  workspace: string
  prompt?: string
  description?: string
  questionDeny?: boolean
}

function journalRecord(base: JournalBase, state: DispatchJournalRecord["state"], extra: Partial<DispatchJournalRecord> = {}): DispatchJournalRecord {
  const now = Date.now()
  return {
    id: base.id,
    agent: base.agent,
    ownerSession: base.ownerSession,
    workspace: base.workspace,
    state,
    attempts: 1,
    createdAt: now,
    updatedAt: now,
    ...(base.description !== undefined ? { description: base.description } : {}),
    ...(base.questionDeny !== undefined ? { questionDeny: base.questionDeny } : {}),
    // The prompt rides every NON-TERMINAL transition (the journal is the
    // only prompt source after a restart); journalTerminalRecord redacts it
    // by overriding to undefined after this spread.
    ...(base.prompt !== undefined ? { prompt: base.prompt } : {}),
    ...extra,
  }
}

/** Append one transition (fail-soft: a journal failure never breaks a dispatch). */
function journalTransition(worktree: string, record: DispatchJournalRecord): void {
  try {
    journalFor(worktree).append(record)
  } catch {
    // Fail-soft by contract.
  }
}

/** Terminal transition: the prompt is REDACTED (dropped) on terminal records. */
function journalTerminalRecord(base: JournalBase, outcome: string, reason: string): void {
  // Provider-gate feed (harden-dispatch-resilience D3): every terminal of an
  // ADMITTED dispatch releases its concurrency slot and advances the breaker
  // ("completed" closes/resets, "error"/"stream-lost/unknown" count as
  // failed terminals, user aborts / stale kills are neutral). Records that
  // were never admitted (queued refusals, owner-death flushes) feed nothing.
  const admitted = admittedGate.get(base.id)
  if (admitted) {
    admittedGate.delete(base.id)
    try {
      dispatchGate?.recordTerminal(
        admitted,
        outcome === "completed" ? "completed" : outcome === "error" || outcome === "stream-lost/unknown" ? "failed" : "neutral",
      )
    } catch {
      // Fail-soft by contract (the journal append below still runs).
    }
  }
  journalTransition(base.workspace, { ...journalRecord(base, "terminal"), prompt: undefined, outcome, reason })
  // Persisted registry (dispatch-v2-hostsignals 4.1): terminal is the
  // removal choke point — every terminal path (completed / error /
  // aborted / stream-lost / stale) clears its row exactly once here (a
  // no-op on v1 hosts, where no rows are written).
  void removeDispatchStorageRow(base.id)
}

// Workspaces whose journals have been recovered this process (idempotence:
// recovery runs at most once per workspace — launch anchor at init, every
// other workspace lazily on its FIRST session).
const recoveredDispatchWorkspaces = new Set<string>()

/**
 * Restart recovery (fold E 5.3), scoped per workspace. Per non-terminal
 * record: running (alive → re-arm the poller; finished-while-down → fetch
 * the final message and deliver the wake; gone → honest terminal, no wake
 * fabrication), queued/dispatched (owner resolves → re-enter the queue;
 * else honest terminal), retry-pending (attempts remain → respawn with the
 * resume preamble; else honest terminal). Bounded: at most one wake per
 * recovered record, delivered via the standard wake queue.
 */
async function recoverWorkspaceDispatches(client: DispatchClient | null, workspace: string): Promise<void> {
  if (!client || !workspace) return
  if (recoveredDispatchWorkspaces.has(workspace)) return
  recoveredDispatchWorkspaces.add(workspace)
  let records: DispatchJournalRecord[]
  try {
    records = journalFor(workspace).nonTerminal()
  } catch {
    return
  }
  for (const rec of records) {
    try {
      await recoverOneDispatchRecord(client, workspace, rec)
    } catch {
      // Fail-soft per record: siblings still recover.
    }
  }
}

/** Exported for tests (dispatch-cancel-lifecycle 4.1): the recovery respawn path. */
export async function recoverOneDispatchRecord(client: DispatchClient, workspace: string, rec: DispatchJournalRecord): Promise<void> {
  // Idempotence: an id already tracked in this process is never re-armed.
  if (dispatchTasks.has(rec.id) || jobManager.get(rec.id)) return
  // Retry guard (dispatch-cancel-lifecycle 1.4): a cancelled dispatch is
  // never resurrected by recovery — its non-terminal journal record (a
  // retry-pending scheduled before the cancel landed) terminalizes here.
  if (isDispatchCancelled(rec.id)) {
    journalTerminalRecord(
      { id: rec.id, agent: rec.agent, ownerSession: rec.ownerSession, workspace, description: rec.description ?? "" },
      "aborted",
      "cancelled by the user lever (/forge stop) — recovery refuses to respawn a cancelled dispatch",
    )
    return
  }
  const base: JournalBase = {
    id: rec.id,
    agent: rec.agent,
    ownerSession: rec.ownerSession,
    workspace,
    prompt: rec.prompt,
    description: rec.description,
    questionDeny: rec.questionDeny ?? true,
  }
  const prompt = typeof rec.prompt === "string" ? rec.prompt : ""
  const attempts = typeof rec.attempts === "number" && rec.attempts >= 1 ? rec.attempts : 1

  if (rec.state === "started" && typeof rec.childSessionId === "string" && rec.childSessionId !== "") {
    const childId = rec.childSessionId
    const probe = await sessionGet(client, childId)
    if (probe.exists === false) {
      // Child gone: honest terminal + ledger note, no wake fabrication.
      journalTerminalRecord(base, "error", `child session ${childId} no longer exists at recovery — dispatch finalized honestly (no report fabricated)`)
      console.warn(`[forge:dispatch] recovery: task ${rec.id} (child session ${childId}) is gone — journal terminalized honestly.`)
      return
    }
    // Alive (or probe-unresolved — never a verdict): decide running vs
    // finished via the status map; a not-active child with a fetchable
    // final message finished while the host was down → deliver the wake.
    let active = true
    try {
      if (typeof client.session.status !== "function") throw new Error("no status capability")
      const st = await client.session.status()
      if (st.error === undefined && st.data && typeof st.data === "object") {
        const entry = (st.data as { [sid: string]: { type?: string } | undefined })[childId]
        active = entry !== undefined && ["busy", "retry", "running"].includes(entry?.type ?? "")
      }
    } catch {
      active = true // unreadable status = active (soundness posture)
    }
    if (!active) {
      const fin = await fetchFinalMessage(client, childId)
      if (fin.ok) {
        const job = jobManager.create({
          id: rec.id,
          cmd: `dispatch ${rec.agent}: ${rec.description ?? ""} (recovered)`,
          worktree: workspace,
          ownerSession: rec.ownerSession,
          logPath: join(jobLogDir(), "dispatch", `${rec.id}.txt`),
          notify: true,
          killTree: dispatchKillTreeHook(client, rec.id, () => childId),
        })
        ;(job as Job & { dispatch?: DispatchJobMeta }).dispatch = { agentID: rec.agent, childSessionID: childId, description: rec.description ?? "" }
        jobManager.appendOutput(job, fin.text)
        jobManager.markTerminal(job, "exited", 0) // exactly one wake, via the standard queue
        journalTerminalRecord(base, "completed", `final report recovered after host restart (child session ${childId})`)
        // D6 parity (fold E recovery): a fresh host has no idle-edge memory
        // for this owner — its next idle edge may never come. Deliver now
        // when the owner exists and is not mid-turn (lossy single attempt:
        // a failed send re-queues to the standard idle-edge/window path).
        try {
          if (typeof client.session.status !== "function") throw new Error("no status capability")
          const st2 = await client.session.status()
          const ownerEntry = (st2.data as { [sid: string]: { type?: string } | undefined } | undefined)?.[rec.ownerSession]
          if (!ownerEntry || !["busy", "retry", "running"].includes(ownerEntry?.type ?? "")) {
            await deliverJobWakes(rec.ownerSession)
          }
        } catch {
          // Soundness: undeliverable now → the standard window/idle path resumes.
        }
        return
      }
      // Not reportably done → re-arm; the poller's floor resolves honestly.
    }
    // Re-arm the standard completion poller (registry row + tracker).
    const job = jobManager.create({
      id: rec.id,
      cmd: `dispatch ${rec.agent}: ${rec.description ?? ""} (recovered, re-armed)`,
      worktree: workspace,
      ownerSession: rec.ownerSession,
      logPath: join(jobLogDir(), "dispatch", `${rec.id}.txt`),
      notify: true,
      killTree: dispatchKillTreeHook(client, rec.id, () => childId),
    })
    ;(job as Job & { dispatch?: DispatchJobMeta }).dispatch = { agentID: rec.agent, childSessionID: childId, description: rec.description ?? "" }
    registerDispatchTask({ jobId: rec.id, childSessionID: childId, agentID: rec.agent, ownerSession: rec.ownerSession, description: rec.description ?? "" }, workspace)
    journalTransition(workspace, journalRecord(base, "started", { childSessionId: childId, attempts, prompt }))
    void runAsyncDispatchPoller(client, job, childId, {
      prompt,
      directory: workspace,
      questionDeny: base.questionDeny ?? true,
      attemptOffset: attempts - 1,
    })
    return
  }

  if (rec.state === "queued" || rec.state === "dispatched") {
    // Queued semantics (a dispatched-but-never-started crash window rides
    // the same branch): owner resolves → re-enter the queue; else honest
    // terminal + ledger note — never spawn for a dead owner.
    const owner = await sessionGet(client, rec.ownerSession)
    if (owner.exists === true) {
      const queue = dispatchQueues.get(rec.ownerSession) ?? []
      queue.push({
        jobId: rec.id,
        agentID: rec.agent,
        ownerSession: rec.ownerSession,
        description: rec.description ?? "",
        prompt,
        directory: workspace,
        questionDeny: true,
        enqueuedAt: Date.now(),
      })
      dispatchQueues.set(rec.ownerSession, queue)
      announceQueuedStart(
        rec.ownerSession,
        `[forge:dispatch-progress] queued wish ${rec.id} (agent ${rec.agent}) re-entered the queue after host restart — it spawns when a slot frees.`,
        rec.id,
      )
      await pumpDispatchQueue(client, rec.ownerSession)
    } else {
      journalTerminalRecord(base, "aborted", `owner session ${rec.ownerSession} no longer resolves at recovery — queued wish terminalized without spawning`)
      console.warn(`[forge:dispatch] recovery: queued wish ${rec.id} owner ${rec.ownerSession} unresolvable — journal terminalized honestly.`)
    }
    return
  }

  if (rec.state === "retry-pending") {
    const maxAttempts = resolveMaxAttempts()
    // The record's `attempts` is the attempt number that was SCHEDULED but
    // never confirmed started (the started transition overwrites it once the
    // respawn child takes the prompt) — recovery resumes THAT attempt.
    if (attempts <= maxAttempts && prompt !== "") {
      // Attempts remain: respawn the child (same agent, prompt from the
      // journal — its ONLY source after a restart — plus the preamble).
      const refusal =
        crewPendingRefusal(rec.ownerSession) ??
        draftDispatchRefusal(rec.ownerSession, rec.agent) ??
        forgeTargetUnresolved(rec.agent)
      if (refusal) {
        journalTerminalRecord(base, "error", `retry refused at recovery: ${refusal}`)
        return
      }
      const respawn = await createChildSessionBound(client, {
        parentSessionID: rec.ownerSession,
        parentDirectory: workspace,
        agentID: rec.agent,
        description: rec.description ?? "",
        questionDeny: base.questionDeny ?? true,
        modelPin: rosterModelPin(rec.agent),
        assertBinding: v2HostSeen,
        taskDeny: nestedTaskDenyFor(rec.agent, rec.ownerSession, typeof rec.childSessionId === "string" ? rec.childSessionId : undefined),
      })
      if (!respawn.ok) {
        journalTerminalRecord(base, "error", `retry spawn failed at recovery: ${respawn.error}`)
        return
      }
      const sent = await sendPrompt(client, {
        sessionID: respawn.sessionID,
        agentID: rec.agent,
        prompt: buildRetryPrompt(prompt),
        directory: workspace,
      })
      if (!sent.ok) {
        journalTerminalRecord(base, "error", `retry prompt send failed at recovery: ${sent.error}`)
        return
      }
      const job = jobManager.create({
        id: rec.id,
        cmd: `dispatch ${rec.agent}: ${rec.description ?? ""} (recovered retry)`,
        worktree: workspace,
        ownerSession: rec.ownerSession,
        logPath: join(jobLogDir(), "dispatch", `${rec.id}.txt`),
        notify: true,
        killTree: dispatchKillTreeHook(client, rec.id, () => respawn.sessionID),
      })
      ;(job as Job & { dispatch?: DispatchJobMeta }).dispatch = { agentID: rec.agent, childSessionID: respawn.sessionID, description: rec.description ?? "" }
      registerDispatchTask({ jobId: rec.id, childSessionID: respawn.sessionID, agentID: rec.agent, ownerSession: rec.ownerSession, description: rec.description ?? "" }, workspace)
      const nextAttempt = attempts
      journalTransition(workspace, journalRecord(base, "started", { childSessionId: respawn.sessionID, attempts: nextAttempt, prompt }))
      announceQueuedStart(
        rec.ownerSession,
        `[forge:dispatch-progress] task ${rec.id} retry attempt ${nextAttempt}/${maxAttempts} resumed after host restart — child session ${respawn.sessionID}.`,
        rec.id,
      )
      void runAsyncDispatchPoller(client, job, respawn.sessionID, {
        prompt,
        directory: workspace,
        questionDeny: base.questionDeny ?? true,
        attemptOffset: attempts - 1,
      })
    } else {
      journalTerminalRecord(base, "error", `attempts exhausted at recovery (${attempts}/${maxAttempts}) — no respawn`)
    }
    return
  }
  // "terminal" records never reach here (nonTerminal() filters them).
}

function dispatchClient(): DispatchClient | null {
  return jobClient as unknown as DispatchClient | null
}

// Async poller (design D3 + sync-timeout-notify fold #2 never-die tracking):
// an in-plugin loop watching the child session — NOT a job-runner child
// process. The watch runs in slices so a registry kill (owner death,
// dispose) stops the loop at the next slice boundary. There is NO
// wall-clock deadline: the loop ends only at a textful completion, an
// explicit child error, a registry kill, or the textless-idle floor. Past
// each notification interval it emits a non-terminal [forge:dispatch-progress]
// notice (job tail + pending queue — never markTerminal/wakeState, so the
// at-most-once completion budget stays intact). On terminal it fetches the
// final message, parks it on the registry row's tail (the wake text reads
// it inline), and marks the job terminal — the manager's wake queue does
// the rest (idle-only injection, at-most-once, delivery window, ledger
// overflow).
//
// dispatch-resilience folds B+C:
//  • Activity-stale reap (fold B): the SOLE clock-based termination of a
//    RUNNING child. Each slice (while the child is believed active — the
//    textless-idle floor below owns the not-active axis) probes
//    session.get: a refreshed time.updated resets the anchor (a producing
//    child can never be reaped); when the anchor has been silent for
//    FORGE_DISPATCH_STALE_MS past the 60 s runtime floor, kill mode aborts
//    the child via the SDK and delivers the ONE honest terminal wake
//    (`stale: aborted after N min without activity`); a failed abort with
//    the session still existing skips the sweep and re-arms (finalization
//    only when existence proves the session gone). Observe mode notifies
//    once per crossing and never kills.
//  • Error-classified retry (fold C): a child terminating in a RETRYABLE
//    error class with attempts remaining respawns after a fixed backoff —
//    same agent, original prompt + the inspect-then-continue resume
//    preamble — inheriting the dying child's registry slot (same job row,
//    new child session id; no queue re-entry, no cap interaction). Stale
//    kills, user aborts (registry kills), floor findings, and
//    deterministic/unknown classes NEVER retry. The final wake discloses
//    the attempt count; exactly one terminal wake still.
type DispatchRetryContext = {
  /** The ORIGINAL dispatch prompt (the retry prepends the resume preamble). */
  prompt: string
  /** The parent directory the child is anchored to. */
  directory: string
  /** Mode-keyed question policy (task-shadow) — re-applied on the fresh child. */
  questionDeny: boolean
  /**
   * Fold E recovery offset: the journal's attempt count at re-arm — the
   * poller's attempt counter starts at 1 + offset so a recovered chain keeps
   * its true attempt accounting (and the attempt cap).
   */
  attemptOffset?: number
}

// ---------------------------------------------------------------------------
// User-facing cancellation lever (dispatch-cancel-lifecycle, forge-subagents
// spec "User-facing dispatch cancellation"): the cancel core behind the
// `/forge stop` route (session-scoped bulk) and the explicit per-id
// forge_jobs cancel action. Cancel = the EXISTING registry kill (the
// manager's kill fires the row's killTree → abortChild) + the honest
// settle: the journal records `aborted` with the USER-LEVER reason, the
// persisted row is removed by the terminal choke point, and the owner gets
// a wake through the normal aborted-wake path. Post-abort idle assertion:
// the child must be observed idle (absent from the host status map — the
// proven field reality) within the assertion window or the disclosure says
// it resisted. Retry guard: cancelled ids are excluded from every
// resilience path (fold-C respawn checks the set; terminal rows are skipped
// by recovery/adoption by construction).
// ---------------------------------------------------------------------------

const cancelledDispatchIds = new Set<string>()

// One source for the user-lever abort reason: stamped on the row's dispatch
// meta at cancel time (the wake renders it) AND written as the journal
// terminal reason by the watcher's kill settle — journal and wake carry the
// same sentence verbatim. (Live 2.4.0 finding 2026-11-23: a /forge stop wake
// said "registry kill (owner session ended / user cancel)" — a disjunction
// that names neither what happened nor that the owner is alive and cancelling.)
const USER_LEVER_ABORT_REASON =
  "cancelled by the user lever (/forge stop) — the child was aborted and the dispatch is never retried"
// The sentence for a registry kill that is NOT a lever. Since
// fix-dispatch-dispose-kill its only trigger is the owner session ENDING
// (a plugin dispose no longer kills dispatch rows) and the user lever has
// its own sentence above — so the former "(owner session ended / user
// cancel)" named things that were either no longer true or somebody else's
// reason. The kill hook stamps ONE sentence on the row and BOTH readers —
// the journal terminal (settleKilled) and the wake (jobWakeText) — render
// that stamped sentence (a spec review on 2026-11-23 found the two sides
// carrying different sentences on the owner-death path: the journal its own
// literal, the wake this constant).
const REGISTRY_KILL_ABORT_REASON = "registry kill (owner session ended) — the child was aborted and the dispatch is never retried"
// The generic forge_jobs kill action applied to a dispatch row: an explicit
// lever, not an owner death — its reason is stamped before the kill.
const EXPLICIT_KILL_ABORT_REASON = "killed by the explicit forge_jobs kill action — the child was aborted and the dispatch is never retried"

// Read at CALL time (the poll envs' lazy posture): ESM evaluates imported
// modules BEFORE the importing test file's env preamble, so a module-level
// read would freeze the 10 s default into every suite run.
function cancelIdleAssertionMs(): number {
  const raw = Number(process.env.FORGE_CANCEL_IDLE_ASSERTION_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : 10_000
}

function inFlightDispatchList(): Array<{ taskId: string; agent: string; childSessionID: string; ownerSession: string; description: string; ageMs: number | null }> {
  const rows: Array<{ taskId: string; agent: string; childSessionID: string; ownerSession: string; description: string; ageMs: number | null }> = []
  for (const row of dispatchTasks.values()) {
    const job = jobManager.get(row.jobId)
    // Listing semantics match inFlightAsyncDispatches: only RUNNING jobs
    // are in flight; a dead handle is pruned on sight.
    if (!job || job.state !== "running") {
      dispatchTasks.delete(row.jobId)
      continue
    }
    rows.push({
      taskId: row.jobId,
      agent: row.agentID,
      childSessionID: row.childSessionID,
      ownerSession: row.ownerSession,
      description: row.description ?? "",
      ageMs: job?.startedAt ? Date.now() - job.startedAt : null,
    })
  }
  return rows
}

function formatInFlightDispatchList(): string {
  const rows = inFlightDispatchList()
  if (rows.length === 0) return "(no async dispatches in flight)"
  return rows
    .map((r) => {
      const age = r.ageMs !== null ? ` — running ${Math.max(1, Math.round(r.ageMs / 1000))}s` : ""
      const desc = r.description ? ` — ${r.description.slice(0, 80)}` : ""
      return `- ${r.taskId}  agent ${r.agent}  child session ${r.childSessionID}${age}${desc}`
    })
    .join("\n")
}

// Parent-interrupt disclosure (dispatch-cancel-lifecycle 2.1, spec
// "Parent-interrupt disclosure"): ESC interrupts the parent turn ONLY —
// in-flight host children keep running (upstream #64073). Disclose-only:
// the interrupt NEVER cancels a child; the disclosure names the flight and
// the exact cancel lever. Deduplicated per flight COMPOSITION (same flight
// re-discloses nothing; a newly spawned dispatch re-arms the disclosure).
const interruptDisclosureSeen = new Set<string>()

export function disclosedInterruptFlights(): number {
  return interruptDisclosureSeen.size
}

export function discloseInterruptedParent(sessionID: string): boolean {
  const flight = inFlightAsyncDispatches(sessionID)
  if (flight.length === 0) return false
  const key = `${sessionID}:${flight.slice().sort().join(",")}`
  if (interruptDisclosureSeen.has(key)) return false
  interruptDisclosureSeen.add(key)
  // Delivered only while dispatches of this session are still in flight
  // (fix-stale-progress-notice): "REMAIN IN FLIGHT" must be true when read.
  queueDispatchProgress(
    sessionID,
    `[forge:dispatch-notice] Your turn was interrupted, but ${flight.length} async dispatch(es) REMAIN IN FLIGHT (host children are independent sessions — ESC does not stop them):\n${formatInFlightDispatchList()}\nCancel with /forge stop (cancels every in-flight and queued dispatch of THIS session) or the explicit per-id lever forge_jobs {action: "cancel", jobId: "<task-id>"} (the cross-session escape hatch). Nothing was cancelled automatically.`,
    () => inFlightAsyncDispatches(sessionID).length > 0,
  )
  return true
}

/** The active-session view for the post-abort idle assertion.
 * A v1-style client exposes session.status; the v2 promise-layer adapter
 * does not — on a live 2.4.0 host every cancel therefore disclosed "state
 * could not be read to confirm idle" (finding 2026-11-23) while the host's
 * own HTTP surface (GET /api/session/active — the native-child walker's
 * channel) had the answer. The walker stays a DEDICATED object (nothing is
 * added to the shared adapter). Returns null when this host offers no view
 * (no service.json → "unresolved" at once, exactly as before). */
function activeSessionView(client: DispatchClient): (() => Promise<Record<string, unknown> | undefined>) | null {
  const own = client.session?.status
  if (typeof own === "function") {
    const read = own as (this: unknown) => Promise<unknown>
    return async () => {
      const st = await read.call(client.session)
      const map = (st as { data?: unknown } | undefined)?.data
      return map && typeof map === "object" ? (map as Record<string, unknown>) : undefined
    }
  }
  if (!discoverServiceHttp()) return null
  const walker = v2NativeChildWalker()
  const status = walker.session?.status
  if (typeof status !== "function") return null
  return async () => {
    const st = await status.call(walker.session)
    const map = (st as { data?: unknown } | undefined)?.data
    return map && typeof map === "object" ? (map as Record<string, unknown>) : undefined
  }
}

/** Post-abort idle assertion: the child must reach idle within the window. */
async function assertChildIdleAfterAbort(client: DispatchClient, childSessionID: string): Promise<"idle" | "resisted" | "unresolved"> {
  const view = activeSessionView(client)
  if (!view) return "unresolved"
  const assertionMs = cancelIdleAssertionMs()
  const deadline = Date.now() + assertionMs
  // Every view read is bounded by what is left of the assertion window: a
  // hung HTTP read (the v2 view rides service.json HTTP) must not stretch a
  // cancel — or a serial /forge stop over several rows — past the window
  // the disclosure names. A read that overruns counts as unreadable.
  const readWithin = async (ms: number): Promise<Record<string, unknown> | undefined | "timeout"> => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const cap = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), Math.max(1, ms))
    })
    try {
      return await Promise.race([view(), cap])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 400))
    try {
      const map = await readWithin(Math.max(1, deadline - Date.now()))
      // Field reality (soundness, pollChild): the host's status map holds
      // ONLY active sessions — an absent child IS idle.
      if (map !== "timeout" && map && typeof map === "object" && map[childSessionID] === undefined) return "idle"
    } catch {
      // View unreadable: keep trying until the window closes.
    }
  }
  try {
    const map = await readWithin(2_000)
    if (!map || map === "timeout") return "unresolved"
    return map[childSessionID] === undefined ? "idle" : "resisted"
  } catch {
    return "unresolved"
  }
}

export async function cancelDispatch(
  client: DispatchClient,
  taskId: string,
): Promise<{ ok: boolean; childSessionID?: string; idle: "idle" | "resisted" | "unresolved" | "not-asserted"; text: string }> {
  const row = dispatchTasks.get(taskId)
  const job = jobManager.get(taskId)
  if (!row || !job) {
    return {
      ok: false,
      idle: "not-asserted",
      text: `"${taskId}" is not an in-flight async dispatch — nothing to cancel.\nIn flight now:\n${formatInFlightDispatchList()}`,
    }
  }
  cancelledDispatchIds.add(taskId)
  // The wake names the lever: stamped BEFORE the registry kill (the kill hook
  // keeps an abortReason that is already set, jobWakeText renders it).
  {
    const meta = (job as Job & { dispatch?: DispatchJobMeta }).dispatch
    if (meta && meta.outcome !== "stream-lost/unknown") meta.abortReason = USER_LEVER_ABORT_REASON
  }
  // The registry kill fires the row's killTree (abortChild via the SDK) —
  // the SAME engine the owner-death path uses; the watcher settles the row
  // as aborted as soon as it sees the kill (before any poll/signal verdict),
  // the journal choke point removes the persisted row, and the owner gets
  // the normal aborted wake.
  jobManager.kill(job)
  const idle = await assertChildIdleAfterAbort(client, row.childSessionID)
  const assertionMs = cancelIdleAssertionMs()
  const idleNote =
    idle === "idle"
      ? `the child session ${row.childSessionID} is confirmed idle (the cancellation is REAL, not bookkeeping)`
      : idle === "resisted"
        ? `the child session ${row.childSessionID} did NOT reach idle within ${Math.round(assertionMs / 1000)}s — it may have resisted cancellation; inspect or abort it natively in the host TUI`
        : `the child session ${row.childSessionID}'s state could not be read to confirm idle — verify it natively in the host TUI`
  return {
    ok: true,
    childSessionID: row.childSessionID,
    idle,
    text: `Cancelled ${taskId} (agent ${row.agentID}, child session ${row.childSessionID}) — cancelled by the user lever; never retried. ${idleNote}.`,
  }
}

/** Retry guard (task 1.4): a cancelled dispatch is never respawned. */
export function isDispatchCancelled(taskId: string): boolean {
  return cancelledDispatchIds.has(taskId)
}

// ---------------------------------------------------------------------------
// Host-signal completion core (dispatch-v2-hostsignals D4): child-session-id
// keyed terminal-signal inbox + activity ledger. The v2 event subscription
// (and the v1 event hook, where its bus delivers) route durable
// session.execution.{succeeded,failed,interrupted} events here; the watch
// loops consume an inbox signal BEFORE their REST poll — task 3.5: the poll
// is demoted to reconcile plumbing, never the sole terminal signal. The
// activity ledger (execution.started / step edges) feeds the
// reconcile-confirmation rule: a child whose execution events keep flowing
// is NEVER declared stream-lost by an unread synchronous view.
// Exported for tests (same seam posture as TASK_SEAM_DEGRADED_ERROR).
// ---------------------------------------------------------------------------

export type DispatchTerminalSignal = {
  kind: "succeeded" | "failed" | "interrupted"
  /** execution.failed error head / interrupted reason / wait-latch marker. */
  detail?: string
  at: number
}

const dispatchTerminalInbox = new Map<string, DispatchTerminalSignal>()
const dispatchChildActivityAt = new Map<string, number>()

/** Readable detail of a host execution error carried by a terminal event.
 * 2.4.0 publishes `error` as a nested object with no string `message` —
 * `String(obj)` rendered "[object Object]" into the dispatch journal (live
 * finding 2026-11-23). Digs the first informative string (message / name /
 * error / reason / data, bounded depth), else a clipped JSON rendering. */
export function executionErrorDetail(error: unknown): string | undefined {
  try {
    return executionErrorDetailInner(error)
  } catch {
    // A hostile object (a throwing getter, a null-prototype object, a
    // Proxy): the caller's own honest fallback — this function is total, it
    // never throws into the signal path.
    return undefined
  }
}

function executionErrorDetailInner(error: unknown): string | undefined {
  if (error === undefined || error === null) return undefined
  if (typeof error === "string") return error || undefined
  if (typeof error === "number" || typeof error === "boolean") return String(error)
  if (typeof error !== "object") return undefined
  const dig = (v: unknown, depth: number): string | undefined => {
    if (v === undefined || v === null) return undefined
    if (typeof v === "string") return v || undefined
    if (typeof v === "number" || typeof v === "boolean") return String(v)
    if (typeof v !== "object" || depth <= 0) return undefined
    const o = v as Record<string, unknown>
    for (const key of ["message", "error", "reason", "data", "name"]) {
      const got = dig(o[key], depth - 1)
      if (got) return got
    }
    return undefined
  }
  const o = error as Record<string, unknown>
  const name = typeof o.name === "string" && o.name ? o.name : undefined
  // An Error-like object reads like Error.toString(): "Name: message".
  const message = dig(o.message, 4) ?? dig(o.data, 4) ?? dig(o.error, 4) ?? dig(o.reason, 4)
  if (name && message && message !== name) return `${name}: ${message}`
  if (message) return message
  if (name) return name
  const found = dig(error, 4)
  if (found) return found
  try {
    const s = JSON.stringify(error)
    if (s && s !== "{}") return s.length > 300 ? `${s.slice(0, 300)}…` : s
    // An empty object says nothing: undefined lets the caller use its own
    // honest fallback instead of "[object Object]".
    if (s === "{}") return undefined
  } catch {
    // A circular or BigInt-bearing object cannot be serialized: fall to the
    // same "says nothing" answer — String(obj) would render exactly the
    // "[object Object]" this function exists to prevent (and throws for a
    // null-prototype object).
  }
  return undefined
}

/** Route a durable terminal event for a child (first terminal wins). */
export function noteDispatchTerminalSignal(sessionID: string, kind: DispatchTerminalSignal["kind"], detail?: string): void {
  dispatchChildActivityAt.set(sessionID, Date.now())
  if (dispatchTerminalInbox.has(sessionID)) return
  dispatchTerminalInbox.set(sessionID, { kind, detail, at: Date.now() })
}

/** Non-terminal execution activity ping (execution.started / step edges). */
export function noteDispatchChildActivity(sessionID: string): void {
  dispatchChildActivityAt.set(sessionID, Date.now())
}

/** Consume the inbox signal (if any) — the watch loops own this. */
export function takeDispatchTerminalSignal(sessionID: string): DispatchTerminalSignal | null {
  const signal = dispatchTerminalInbox.get(sessionID)
  if (signal) dispatchTerminalInbox.delete(sessionID)
  return signal ?? null
}

/** Reconcile confirmation: execution activity for this child within `withinMs`? */
export function recentDispatchChildActivity(sessionID: string, withinMs: number): boolean {
  const at = dispatchChildActivityAt.get(sessionID)
  return at !== undefined && Date.now() - at <= withinMs
}

/** Watch ended for this child: drop its signal state (bounded ledgers). */
export function forgetDispatchSignals(sessionID: string): void {
  dispatchTerminalInbox.delete(sessionID)
  dispatchChildActivityAt.delete(sessionID)
}

// D4 one-shot wait seam (task 3.2, v2-only): armed per in-flight child —
// resolves when the host's agent loop goes idle (POST
// /api/experimental/session/:id/wait, NoContent). Routed into the SAME
// inbox as the durable events (first-terminal-wins); failures are silent —
// the events + the reconcile pass remain the primaries.
let v2SessionWaitSeam: ((sessionID: string) => Promise<unknown>) | null = null

/** Test seam: inject/clear the v2 wait latch (null restores v1 posture). */
export function setDispatchWaitSeamForTests(seam: ((sessionID: string) => Promise<unknown>) | null): void {
  v2SessionWaitSeam = seam
}

function armDispatchWaitWatcher(sessionID: string): void {
  const wait = v2SessionWaitSeam
  if (!wait) return
  void wait(sessionID)
    .then(() => {
      // Idle latch: settle as succeeded UNLESS a durable terminal event
      // already claimed the inbox (first-terminal-wins ordering).
      if (!dispatchTerminalInbox.has(sessionID)) noteDispatchTerminalSignal(sessionID, "succeeded", "wait-latch")
    })
    .catch(() => {
      // Session gone / service unavailable: silent — the stale reap and the
      // reconcile pass own gone children.
    })
}

// ---------------------------------------------------------------------------
// Persisted dispatch registry (dispatch-v2-hostsignals D5, tasks 4.1-4.3):
// in-flight rows mirrored into ctx.storage (host-native plugin KV) at
// watch start, removed at terminal — the journalTerminalRecord choke point
// owns removal, so every terminal path (completed / error / aborted /
// stream-lost / stale) clears its row exactly once. Setup scans the rows,
// dedupes against the journal recovery's re-arms, adopts running rows back
// into the active watcher set (watch-only — an adopted dispatch NEVER
// re-spawns: the re-dispatch guard is the adoption itself), and falls back
// to a parentID walk when a row is unreadable. v1 hosts keep the
// journal-only posture (design risk table: ctx.storage unavailable →
// fail-soft to today's behavior).
// ---------------------------------------------------------------------------

const DISPATCH_STORAGE_PREFIX = "forge-dispatch/"

type DispatchStorageRow = {
  taskId: string
  childSessionID: string
  agent: string
  ownerSession: string
  workspace: string
  description: string
  /** The prompt anchor (the retry context rides it when the child errors). */
  prompt: string
  questionDeny: boolean
  attempts: number
  startedAt: number
  updatedAt: number
}

// Test seam: the v2 storage domain (null on v1 — every call is a no-op).
let v2DispatchStorage: {
  get: (key: string) => Promise<unknown>
  set: (key: string, value: unknown) => Promise<void>
  remove: (key: string) => Promise<void>
  scan: (options: { prefix: string }) => Promise<{ entries?: ReadonlyArray<{ key: string; value: unknown }> } | undefined> | undefined
} | null = null

export function setDispatchStorageForTests(storage: typeof v2DispatchStorage): void {
  v2DispatchStorage = storage
}

async function writeDispatchStorageRow(row: DispatchStorageRow): Promise<void> {
  const storage = v2DispatchStorage
  if (!storage) return
  try {
    await storage.set(DISPATCH_STORAGE_PREFIX + row.taskId, row)
  } catch {
    // Storage drift: fail-soft — the journal remains the durable truth.
  }
}

async function removeDispatchStorageRow(taskId: string): Promise<void> {
  const storage = v2DispatchStorage
  if (!storage) return
  try {
    await storage.remove(DISPATCH_STORAGE_PREFIX + taskId)
  } catch {
    // Fail-soft: a stale row is adoption-deduped by the child-observable check.
  }
}

/** parentID walk fallback (task 4.2): find the child by its parent link. */
async function findChildByParentWalk(client: DispatchClient, ownerSession: string, agent: string): Promise<string | null> {
  try {
    const raw = await (client as unknown as { session?: { list?: (args?: unknown) => Promise<unknown> } }).session?.list?.({})
    const body = (raw as { data?: unknown } | undefined)?.data ?? raw
    const list = Array.isArray(body)
      ? (body as Array<Record<string, unknown>>)
      : Array.isArray((body as { sessions?: unknown[] } | undefined)?.sessions)
        ? ((body as { sessions: unknown[] }).sessions as Array<Record<string, unknown>>)
        : []
    const hits: { id: string; created: number }[] = []
    for (const s of list) {
      if (!s || typeof s.id !== "string") continue
      if (s.parentID !== ownerSession) continue
      if (agent && s.agent !== agent) continue
      const t = Number((s.time as { created?: unknown } | undefined)?.created ?? 0)
      hits.push({ id: s.id, created: Number.isFinite(t) ? t : 0 })
    }
    hits.sort((a, b) => b.created - a.created)
    return hits[0]?.id ?? null
  } catch {
    return null
  }
}

/** Re-arm the standard completion watcher for an adopted child (watch-only). */
function rearmDispatchWatch(
  client: DispatchClient,
  input: { id: string; agent: string; ownerSession: string; workspace: string; childId: string; description: string; prompt: string; questionDeny: boolean; attempts: number },
): void {
  const job = jobManager.create({
    id: input.id,
    cmd: `dispatch ${input.agent}: ${input.description || "(adopted)"} (adopted, re-armed)`,
    worktree: input.workspace,
    ownerSession: input.ownerSession,
    logPath: join(jobLogDir(), "dispatch", `${input.id}.txt`),
    notify: true,
    killTree: dispatchKillTreeHook(client, input.id, () => input.childId),
  })
  ;(job as Job & { dispatch?: DispatchJobMeta }).dispatch = { agentID: input.agent, childSessionID: input.childId, description: input.description }
  registerDispatchTask({ jobId: input.id, childSessionID: input.childId, agentID: input.agent, ownerSession: input.ownerSession, description: input.description }, input.workspace)
  // Fold E continuity: the adopted watch journals a started transition (a
  // missing journal record gets one; an existing one re-affirms).
  journalTransition(input.workspace, {
    id: input.id,
    agent: input.agent,
    ownerSession: input.ownerSession,
    workspace: input.workspace,
    state: "started",
    childSessionId: input.childId,
    attempts: input.attempts,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    prompt: input.prompt,
    questionDeny: input.questionDeny,
    description: input.description,
  })
  void runAsyncDispatchPoller(client, job, input.childId, {
    prompt: input.prompt,
    directory: input.workspace,
    questionDeny: input.questionDeny,
    attemptOffset: Math.max(0, input.attempts - 1),
  })
}

/** Setup-time adoption (task 4.2): scan persisted rows, adopt what's live. */
export async function adoptPersistedDispatchRows(client: DispatchClient | null, workspace: string): Promise<number> {
  if (!client || !workspace || isRootish(workspace)) return 0
  const storage = v2DispatchStorage
  let adopted = 0
  if (storage) {
    try {
      const scanned = await storage.scan({ prefix: DISPATCH_STORAGE_PREFIX })
      for (const entry of scanned?.entries ?? []) {
        const row = entry?.value as Partial<DispatchStorageRow> | undefined
        if (!row || typeof row !== "object") continue
        if (normalizeAnchorDir(String(row.workspace ?? "")) !== normalizeAnchorDir(workspace)) continue
        const taskId = String(row.taskId ?? "")
        if (!taskId || dispatchTasks.has(taskId)) continue // journal recovery re-armed it first (dedupe)
        if (isDispatchCancelled(taskId)) {
          // Retry guard (1.4): adoption never resurrects a cancelled dispatch.
          journalTerminalRecord(
            { id: taskId, agent: String(row.agent ?? ""), ownerSession: String(row.ownerSession ?? ""), workspace, description: String(row.description ?? "") },
            "aborted",
            "cancelled by the user lever (/forge stop) — adoption refuses to re-arm a cancelled dispatch",
          )
          continue
        }
        const owner = String(row.ownerSession ?? "")
        const agent = String(row.agent ?? "")
        let childId = String(row.childSessionID ?? "")
        if (!childId) {
          // Unreadable/incomplete row → parentID walk fallback (spec 4.2).
          childId = (await findChildByParentWalk(client, owner, agent)) ?? ""
        }
        if (!childId) continue // child unobservable: the journal owns the verdict
        // Child observable? Adopt watch-only. An adopted dispatch never
        // re-spawns (the re-dispatch guard IS the adoption — task 4.3).
        const probe = await sessionGet(client, childId)
        if (probe.exists === false) {
          // Gone child: terminalize the row honestly via the journal choke
          // point (which also removes the storage row).
          journalTerminalRecord(
            { id: taskId, agent, ownerSession: owner, workspace, description: String(row.description ?? "") },
            "error",
            `adopted row's child session ${childId} no longer exists — finalized honestly at adoption`,
          )
          continue
        }
        rearmDispatchWatch(client, {
          id: taskId,
          agent,
          ownerSession: owner,
          workspace,
          childId,
          description: String(row.description ?? ""),
          prompt: String(row.prompt ?? ""),
          questionDeny: row.questionDeny !== false,
          attempts: Number.isFinite(Number(row.attempts)) && Number(row.attempts) > 0 ? Number(row.attempts) : 1,
        })
        adopted++
      }
    } catch {
      // Storage drift / unreadable scan: fail-soft — the journal recovery
      // remains the durable path.
    }
  }
  // Orphan-child disclosure (dispatch-cancel-lifecycle 2.2) rides the same
  // adoption pass — but does NOT serialize behind it: fire-and-forget, so
  // the adoption return contract (and the re-armed watcher's head start)
  // stays byte-identical to the proven pass. A streaming forge-* child with
  // no live row is surfaced with the adopt/cancel guidance.
  void detectOrphanDispatchChildren(client, workspace).catch(() => {})
  return adopted
}

// ---------------------------------------------------------------------------
// Orphan-child disclosure (dispatch-cancel-lifecycle 2.2, spec "Orphan-child
// disclosure"): a forge-* child session observed STREAMING with no live
// dispatch row (an adoption gap) is running invisibly — surfaced with its
// task id (when the journal knows it) and the adopt/cancel guidance.
// Deduplicated per child id per process; the active-map read is the ONLY
// streaming classifier — when the host status view is unreadable the sweep
// stays silent (never cry wolf).
// ---------------------------------------------------------------------------

const orphanDisclosuresSeen = new Set<string>()

export function observedOrphanDispatches(): number {
  return orphanDisclosuresSeen.size
}

export async function detectOrphanDispatchChildren(client: DispatchClient, workspace: string): Promise<number> {
  const trackedChildren = new Set<string>()
  for (const h of dispatchTasks.values()) trackedChildren.add(h.childSessionID)
  // Same list-shape tolerance as findChildByParentWalk (the walk proven on
  // 2.3.2): array | {sessions} | {data:...} envelopes.
  let listed: Array<Record<string, unknown>> = []
  try {
    const raw = await (client as unknown as { session?: { list?: (args?: unknown) => Promise<unknown> } }).session?.list?.({})
    const body = (raw as { data?: unknown } | undefined)?.data ?? raw
    listed = Array.isArray(body)
      ? (body as Array<Record<string, unknown>>)
      : Array.isArray((body as { sessions?: unknown[] } | undefined)?.sessions)
        ? ((body as { sessions: unknown[] }).sessions as Array<Record<string, unknown>>)
        : []
  } catch {
    return 0
  }
  if (listed.length === 0) return 0
  let active: Set<string>
  try {
    if (typeof client.session.status !== "function") return 0
    const st = await client.session.status()
    const map = (st as { data?: Record<string, unknown> } | undefined)?.data
    if (!map || typeof map !== "object") return 0
    active = new Set(Object.keys(map))
  } catch {
    return 0 // streaming unclassifiable: silent (never a false orphan)
  }
  let found = 0
  for (const s of listed) {
    const id = typeof s?.id === "string" ? s.id : ""
    if (!id || trackedChildren.has(id) || orphanDisclosuresSeen.has(id)) continue
    const agent = typeof s.agent === "string" ? s.agent : ""
    const parent = typeof s.parentID === "string" ? s.parentID : ""
    if (!parent || !agent.startsWith("forge-")) continue
    if (!active.has(id)) continue // not streaming: not an orphan NOW
    orphanDisclosuresSeen.add(id)
    found++
    // The journal may still name the task id even though the row is gone.
    let taskId = "(unknown)"
    try {
      const rec = journalFor(workspace).nonTerminal().find((r) => r.childSessionId === id)
      if (rec) taskId = rec.id
    } catch {}
    console.warn(
      `[forge:orphan-dispatch] warn: forge child ${id} (agent ${agent}, parent ${parent}) is STREAMING with no live dispatch row (task id ${taskId}) — adoption gap. Adopt: restart the host or touch the workspace to re-run recovery; Cancel: /forge stop (this session's dispatches) or forge_jobs action=cancel with the task id.`,
    )
    queueDispatchProgress(
      parent,
      `[forge:dispatch-notice] Orphaned dispatch child detected: forge child ${id} (agent ${agent}, task id ${taskId}) is running with no live dispatch row. It will NOT deliver an outcome on its own — recover it (restart/touch to re-run adoption) or cancel it (forge_jobs action=cancel jobId=${taskId === "(unknown)" ? "<task-id>" : taskId}; or /forge stop when it belongs to this session).`,
    )
  }
  return found
}

async function runAsyncDispatchPoller(
  client: DispatchClient,
  job: Job,
  initialChildSessionID: string,
  retryCtx: DispatchRetryContext,
): Promise<void> {
  const intervalMs = Number(process.env.FORGE_DISPATCH_POLL_INTERVAL_MS ?? DEFAULT_POLL_INTERVAL_MS)
  // sliceMs is the SLICE boundary, not a deadline — a slice timeout just
  // returns control here for the kill/floor/notify checks below.
  const sliceMs = Math.max(
    intervalMs,
    Number(process.env.FORGE_DISPATCH_POLL_SLICE_MS ?? 5_000),
    // Reconcile cadence floor (dispatch-v2-hostsignals 3.3): on v2 hosts —
    // where durable events are the PRIMARY completion channel — the REST
    // reconcile pass runs at ≥10s (spec SHALL: "at a cadence of at least 10
    // seconds"; FORGE_DISPATCH_RECONCILE_FLOOR_MS overrides, 0 disables).
    // v1 hosts keep the proven 5s cadence (v1 is a design non-goal).
    v2HostSeen ? Number(process.env.FORGE_DISPATCH_RECONCILE_FLOOR_MS ?? 10_000) : 0,
  )
  // The blind-view streak scales with the cadence so the last-resort
  // verdict stays inside ~2 minutes even at the 10s floor (30×10s would be
  // 5 minutes): 12×10s ≈ the proven 30×5s window. At the 5s cadence the
  // proven default stands.
  const viewLossTicks = sliceMs >= 10_000 ? 12 : undefined
  // Notify cadence (design D6): FORGE_DISPATCH_NOTIFY_INTERVAL_MS is
  // independent of FORGE_DISPATCH_POLL_TIMEOUT_MS — that knob scopes the
  // SYNC WAIT only and must never kill this tracker.
  const notifyIntervalMs = resolveNotifyIntervalMs()
  // Fold B knobs (read at dispatch time, same as the interval knobs).
  const staleMs = resolveStaleMs()
  const staleMode: StaleMode = resolveStaleMode()
  const staleFloorMs = resolveStaleFloorMs()
  // Fold C knobs.
  const maxAttempts = resolveMaxAttempts()
  const retryBackoffMs = resolveRetryBackoffMs()
  const dispatch = (job as Job & { dispatch?: DispatchJobMeta }).dispatch
  const agentID = dispatch?.agentID ?? "unknown"
  let childSessionID = initialChildSessionID
  let attempt = 1 + (retryCtx.attemptOffset ?? 0)
  let startedAt = Date.now()
  let lastNotifiedMultiple = 0
  let text = ""
  let exitCode: number | null = 0
  // dispatch-stream-loss-honesty: the stream-lost/unknown outcome class —
  // the dispatch VIEW broke (sustained unreadable poll view, or the result
  // stream ended without a final report); the child's true state is
  // UNKNOWN (possibly still running). Never an exit-1 death certificate:
  // the registry row settles exit-null and the ledger records
  // stream-lost/unknown with the last-observed activity timestamp.
  let streamLost = false
  // Active-textful override disclosure (harden-dispatch-resilience D1):
  // set when the terminal completion was established from the message
  // stream while the status view lagged — the wake text and the journal
  // reason both name the establishment path.
  let activeOverride = false
  // Terminal-inference soundness is owned by pollChild; the stability
  // counter (and the textless-idle floor streak) live HERE so they survive
  // poll-slice boundaries (the async path inherits the same soundness — a
  // slice timeout must not reset the consecutive-tick run).
  const stability: TerminalStabilityState = { stableTicks: 0 }
  // Stale-reap state (fold B): lastActivity = last OBSERVED time.updated;
  // null until the first probe adopts the host's timestamp (no-message
  // children anchor at the dispatch start time).
  const stale: StaleSweepState = { lastActivity: null, staleNotified: false }
  // Host-signal completion (dispatch-v2-hostsignals): the one-shot wait
  // latch arms for the FIRST child here (respawns re-arm below) and the
  // persisted registry row mirrors this watch (removed at terminal by the
  // journalTerminalRecord choke point).
  armDispatchWaitWatcher(childSessionID)
  void writeDispatchStorageRow({
    taskId: job.id,
    childSessionID,
    agent: agentID,
    ownerSession: job.ownerSession,
    workspace: retryCtx.directory,
    description: dispatch?.description ?? "",
    prompt: retryCtx.prompt,
    questionDeny: retryCtx.questionDeny,
    attempts: attempt,
    startedAt,
    updatedAt: Date.now(),
  })
  const flushProgress = (notice: string) => {
    // Delivered only while this dispatch is still live (fix-stale-progress-notice).
    appendDispatchNotice(job, notice)
    queueDispatchProgress(job.ownerSession, notice, () => dispatchStillLive(job.id))
    // D6 parity (enqueue-while-idle): a notice parked while the owner is
    // already idle has no future idle edge to ride — deliver now (lossy).
    if (idleJobSessions.has(job.ownerSession)) void deliverDispatchProgress(job.ownerSession)
  }
  // Reconcile-hold disclosure state (task 3.5): when the synchronous view
  // is unreadable but host execution signals keep flowing, the verdict is
  // HELD (disclosed once per hold, not per slice).
  let reconcileHoldNotified = false
  // fix-dispatch-dispose-kill D2 (live 2.4.0 finding 2026-11-23): the
  // registry's kill verdict OUTRANKS whatever this watch observes. An abort
  // issued by a kill makes the child surface as a host `execution.failed`
  // event on 2.4.0 (not as an interrupted/user signal), so a signal or poll
  // verdict observed AFTER the kill used to settle the dispatch as `error`:
  // a user cancel was journaled as a failure and fed the dispatch breaker as
  // one. The kill is therefore checked BEFORE any verdict is acted upon —
  // at the slice top, before a consumed signal, after every poll, and once
  // more before the exit settle — not only on the quiet (still-running) path.
  const settleKilled = async (): Promise<boolean> => {
    if (job.state === "running") return false
    dispatchTasks.delete(job.id)
    // A kill seen between slices may still have its abort in flight: give it
    // a bounded moment so a FAILED — or never-RETURNING — abort reaches the
    // journal disclosure too.
    await awaitAbortVerdict(job.id)
    forgetDispatchSignals(childSessionID)
    // fix-dispatch-dispose-kill D2: a kill path whose abort result was not
    // ok (incl. unavailable) appends the unconfirmed disclosure to the
    // terminal reason — the wake text discloses the same fact.
    const unconfirmed = abortUnconfirmedNotes.get(job.id)
    const suffix = unconfirmed ? ` — abort unconfirmed — child may still be running (${unconfirmed})` : ""
    // ONE sentence for both sides (C1 "Honest aborted outcome surfacing": the
    // wake carries the journal reason): the sentence the kill hook stamped on
    // the row — the lever sentence for cancelDispatch / stop, the
    // explicit-kill sentence for forge_jobs kill, the registry sentence for
    // an owner-session end. Read from the ROW (not the `dispatch` captured
    // at watch start: a retry respawn replaces the meta object). The lever
    // fallback covers a row the hook left unstamped (stream-lost/unknown).
    const stamped = (job as Job & { dispatch?: DispatchJobMeta }).dispatch?.abortReason
    journalTerminalRecord(
      { id: job.id, agent: agentID, ownerSession: job.ownerSession, workspace: retryCtx.directory, description: dispatch?.description ?? "" },
      "aborted",
      (stamped ?? (isDispatchCancelled(job.id) ? USER_LEVER_ABORT_REASON : REGISTRY_KILL_ABORT_REASON)) + suffix,
    )
    // This terminal transition released the session's async slot: pump the
    // queue head like every other terminal path (fold D — "any terminal
    // transition of that session's dispatches"). The early returns of this
    // settle used to skip it (spec review 2026-11-23): after a cancel or a
    // /forge stop the owner's queued wishes stayed parked until some OTHER
    // dispatch of that session completed. An owner-death kill pumps nothing
    // to speak of — harvestSessionEnd flushed that queue without spawning.
    void pumpDispatchQueue(client, job.ownerSession)
    return true
  }
  for (;;) {
    if (await settleKilled()) return
    // D4 (task 3.1): host-signal first — a durable terminal event settles
    // the dispatch with ZERO REST polls (the spec: "settles from that
    // signal without any status polling"). The final-message read below is
    // the report carrier, not a poll.
    const signal = takeDispatchTerminalSignal(childSessionID)
    if (signal) {
      // The terminal event may BE the abort a kill just issued.
      if (await settleKilled()) return
      forgetDispatchSignals(childSessionID)
      if (signal.kind === "failed") {
        text = `(child session ended in error: ${signal.detail ?? "session.execution.failed"})`
        exitCode = 1
        break
      }
      if (signal.kind === "interrupted" && signal.detail === "user") {
        text = `(child session ${childSessionID} was interrupted by the user — dispatch finalized honestly; the transcript stays inspectable and natively abortable in the host TUI)`
        exitCode = 1
        break
      }
      if (signal.kind === "succeeded") {
        const fin = await fetchFinalMessage(client, childSessionID)
        text = fin.ok ? fin.text : `(final message unavailable: ${fin.error})`
        break
      }
      // Non-user interruption: the host's own goal consumer ignores these
      // (the run may be internally restarted) — treat as activity, keep
      // reconciling.
      noteDispatchChildActivity(childSessionID)
    }
    const poll = await pollChild(client, { sessionID: childSessionID, intervalMs, timeoutMs: sliceMs, stability, viewLossTicks })
    // A verdict the poll observed may be the abort a kill just issued (or
    // the kill landed during the slice): the registry verdict wins.
    if (await settleKilled()) return
    if (poll.status === "completed") {
      activeOverride = poll.via === "active-textful"
      const fin = await fetchFinalMessage(client, childSessionID)
      text = fin.ok ? fin.text : `(final message unavailable: ${fin.error})`
      if (activeOverride) text += `\n(${ACTIVE_TEXTFUL_OVERRIDE_NOTE})`
      break
    }
    if (poll.status === "error") {
      // Fold C respawn: retry ONLY transient classes, only while attempts
      // remain, only while the registry row is still alive (a registry kill
      // — the owner session ended — is a user abort: never retried).
      if (attempt < maxAttempts && job.state === "running" && classifyDispatchError(poll.error) === "retryable") {
        const errorHead = poll.error.split("\n")[0].slice(0, 160)
        attempt++
        // Fold E: the retry scheduling is a journaled transition
        // (retry-pending) — after a restart this record is what resumes
        // the chain (prompt retained: the journal is its only source).
        journalTransition(retryCtx.directory, {
          id: job.id,
          agent: agentID,
          ownerSession: job.ownerSession,
          workspace: retryCtx.directory,
          state: "retry-pending",
          childSessionId: undefined,
          attempts: attempt,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          prompt: retryCtx.prompt,
          questionDeny: retryCtx.questionDeny,
          description: dispatch?.description ?? "",
        })
        flushProgress(
          `[forge:dispatch-progress] attempt ${attempt}/${maxAttempts} starting after ${errorHead}… — ` +
            `respawning ${agentID} (task ${job.id}, previous child session ${childSessionID}) with the resume preamble; ` +
            `the single [forge:dispatch-complete] wake reports when the last attempt settles.`,
        )
        await new Promise((resolve) => setTimeout(resolve, retryBackoffMs))
        if (job.state !== "running") {
          // The same kill settle as the main loop (a USER cancel during the
          // backoff names the lever; an owner death stays a registry kill).
          if (await settleKilled()) return
        }
        // Dispatch-time policies are re-applied on the fresh child the same
        // way the original spawn applied them (crew belt + draft gate; the
        // mode-keyed question deny rides the create body below).
        const refusal =
          crewPendingRefusal(job.ownerSession) ?? draftDispatchRefusal(job.ownerSession, agentID) ?? forgeTargetUnresolved(agentID)
        if (refusal) {
          text = `(retry refused at respawn: ${refusal} — previous attempt (child session ${childSessionID}) ended in error: ${errorHead})`
          exitCode = 1
          break
        }
        const respawn = await createChildSessionBound(client, {
          parentSessionID: job.ownerSession,
          parentDirectory: retryCtx.directory,
          agentID,
          description: dispatch?.description ?? "",
          questionDeny: retryCtx.questionDeny,
          modelPin: rosterModelPin(agentID),
          assertBinding: v2HostSeen,
          taskDeny: nestedTaskDenyFor(agentID, job.ownerSession, childSessionID),
        })
        if (!respawn.ok) {
          text = `(retry spawn failed: ${respawn.error} — previous attempt (child session ${childSessionID}) ended in error: ${errorHead})`
          exitCode = 1
          break
        }
        // Respawn-window kill (spec review 2026-11-23, finding ③): a kill
        // that lands WHILE the fresh child is being created or prompted (after
        // the backoff check above) must not leave that child running
        // unwatched, and the rebind below must not re-arm the watch on a row
        // the registry already killed. The registry kill fired the row's hook
        // on the DYING attempt's child and stamped its sentence on the row's
        // meta; the fresh child is aborted through the same hook (it keeps
        // the stamped sentence), then the row settles.
        //   bindFresh=false — the kill landed during the CREATE: the fresh
        //   child was never prompted. It is an empty husk, aborted as
        //   cleanup only; the row keeps naming the attempt's real child (the
        //   transcript that exists), so the wake points there.
        //   bindFresh=true — the kill landed during the PROMPT SEND: the
        //   retry DID start in the fresh child; the row is rebound to it
        //   first (same job row, new child session id), then aborted.
        const settleRespawnKill = async (bindFresh: boolean): Promise<void> => {
          const fresh = respawn.sessionID
          if (bindFresh) {
            const previousMeta = (job as Job & { dispatch?: DispatchJobMeta }).dispatch
            ;(job as Job & { dispatch?: DispatchJobMeta }).dispatch = {
              ...(previousMeta ?? { agentID, description: dispatch?.description ?? "" }),
              childSessionID: fresh,
            }
            job.killTree = dispatchKillTreeHook(client, job.id, () => fresh)
            job.killTree()
          } else {
            dispatchKillTreeHook(client, job.id, () => fresh)()
          }
          // The row is not running, so the settle journals the abort (it
          // waits a bounded moment for the fresh abort's verdict, so a FAILED
          // abort is disclosed too) and ends the watch.
          forgetDispatchSignals(fresh)
          await settleKilled()
        }
        if (job.state !== "running") {
          await settleRespawnKill(false)
          return
        }
        const sent = await sendPrompt(client, {
          sessionID: respawn.sessionID,
          agentID,
          prompt: buildRetryPrompt(retryCtx.prompt),
          directory: retryCtx.directory,
        })
        if (!sent.ok) {
          text = `(retry prompt send failed: ${sent.error} — previous attempt (child session ${childSessionID}) ended in error: ${errorHead})`
          exitCode = 1
          break
        }
        if (job.state !== "running") {
          await settleRespawnKill(true)
          return
        }
        // Inherit the dying child's registry SLOT: same job row, new child
        // session id — no queue re-entry, no cap interaction (the cap
        // counts running rows, and the row never left the registry).
        const previousChild = childSessionID
        childSessionID = respawn.sessionID
        // Host-signal rebind: the dead child's signal state is dropped, the
        // wait latch re-arms for the fresh child, and the persisted row
        // mirrors the new binding (terminal removal stays the choke point).
        forgetDispatchSignals(previousChild)
        armDispatchWaitWatcher(childSessionID)
        void writeDispatchStorageRow({
          taskId: job.id,
          childSessionID,
          agent: agentID,
          ownerSession: job.ownerSession,
          workspace: retryCtx.directory,
          description: dispatch?.description ?? "",
          prompt: retryCtx.prompt,
          questionDeny: retryCtx.questionDeny,
          attempts: attempt,
          startedAt,
          updatedAt: Date.now(),
        })
        ;(job as Job & { dispatch?: DispatchJobMeta }).dispatch = { agentID, childSessionID, description: dispatch?.description ?? "" }
        registerDispatchTask({ jobId: job.id, childSessionID, agentID, ownerSession: job.ownerSession, description: dispatch?.description ?? "" }, retryCtx.directory)
        // Fold E: the respawn is a journaled started transition (prompt
        // retained — a crash now recovers as a live running record).
        journalTransition(retryCtx.directory, {
          id: job.id,
          agent: agentID,
          ownerSession: job.ownerSession,
          workspace: retryCtx.directory,
          state: "started",
          childSessionId: childSessionID,
          attempts: attempt,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          prompt: retryCtx.prompt,
          questionDeny: retryCtx.questionDeny,
          description: dispatch?.description ?? "",
        })
        // Owner-death harvest must abort the LIVE child — rebind the kill hook.
        job.killTree = dispatchKillTreeHook(client, job.id, () => childSessionID)
        // Fresh tracking state for the fresh child (stability, floor,
        // progress cadence, and the stale anchor all restart).
        stability.stableTicks = 0
        stability.activeTextfulTicks = 0
        stability.textlessIdleSince = undefined
        startedAt = Date.now()
        lastNotifiedMultiple = 0
        stale.lastActivity = null
        stale.staleNotified = false
        continue
      }
      text = `(child session ended in error: ${poll.error})`
      exitCode = 1
      break
    }
    // Sustained view loss (dispatch-stream-loss-honesty): the ENTIRE poll
    // view (status + messages) was unreadable for the sustained streak —
    // the layer's view broke, the child's state is UNKNOWN. Honest
    // classification, no terminal verdict, the child stays alive and
    // natively abortable; the report file is the recovery channel.
    if (poll.status === "stream-lost") {
      // MODIFIED requirement (dispatch-v2-hostsignals): the verdict requires
      // reconcile confirmation — execution events that keep flowing for the
      // child overrule the unread synchronous view ("a child that host
      // signals show to be alive SHALL NOT be declared lost"). Only when
      // BOTH channels have gone silent for the notification window does the
      // last-resort verdict stand.
      if (recentDispatchChildActivity(childSessionID, notifyIntervalMs)) {
        if (!reconcileHoldNotified) {
          reconcileHoldNotified = true
          flushProgress(
            `[forge:dispatch-progress] the dispatch view (status + messages) is unreadable for child session ${childSessionID}, but host execution signals keep arriving — the child stays in flight (stream-lost verdict withheld; reconcile confirmation active).`,
          )
        }
        await new Promise((resolve) => setTimeout(resolve, sliceMs))
        continue
      }
      reconcileHoldNotified = false
      streamLost = true
      const lastObserved = new Date(stale.lastActivity ?? startedAt).toISOString()
      text =
        `[stream-lost/unknown] result stream lost — child session ${childSessionID} state UNKNOWN (possibly still running): ` +
        `the dispatch view (status + messages) was unreadable for the sustained poll streak; last observed activity ${lastObserved}. ` +
        `Ground-truth recovery: read reports/${job.id}-report.md in the workspace (its mtime shows whether the worker landed its report) ` +
        `BEFORE considering a re-dispatch; inspect or abort the child natively in the host TUI.`
      break
    }
    // (A registry kill that landed during the slice is already settled by
    // the settleKilled() check right after the poll — no wake fires for a
    // killed row beyond the one markTerminal queued; first-wins.)
    // Textless-idle floor (design D6, reclassified by
    // dispatch-stream-loss-honesty): a child continuously not-active for a
    // full notification interval whose latest finished assistant message
    // still lacks a truthy finish or non-empty text is a RESULT STREAM that
    // ended without a final report — classified stream-lost/unknown: the
    // child's state is UNKNOWN (possibly still running — the field incident
    // proved this exit fires on live children), never a death certificate.
    // Any busy reading resets the streak inside pollChild, so a RUNNING
    // child with a readable view can never reach this.
    if (stability.textlessIdleSince !== undefined && Date.now() - stability.textlessIdleSince >= notifyIntervalMs) {
      // Reconcile confirmation (task 3.5): execution signals flowing within
      // the notification window overrule the textless-idle reading — the
      // settled signal (if any) is consumed at the next loop top.
      if (recentDispatchChildActivity(childSessionID, notifyIntervalMs)) {
        await new Promise((resolve) => setTimeout(resolve, sliceMs))
        continue
      }
      streamLost = true
      const lastObserved = new Date(stale.lastActivity ?? startedAt).toISOString()
      text =
        `[stream-lost/unknown] result stream lost — child session ${childSessionID} state UNKNOWN (possibly still running): ` +
        `the result stream ended before a final report arrived (last observed activity ${lastObserved}); ` +
        `the dispatch view cannot confirm completion. ` +
        `Ground-truth recovery: read reports/${job.id}-report.md in the workspace (its mtime shows whether the worker landed its report) ` +
        `BEFORE considering a re-dispatch; inspect or abort the child natively in the host TUI.`
      break
    }
    // Activity-stale reap (fold B) — only on the RUNNING axis (a textless
    // idle streak is the floor's axis; the two never overlap). The probe
    // doubles as the pre-kill re-read (it is fresh by construction) and the
    // refresh rail: a producing child resets its anchor every slice.
    if (stability.textlessIdleSince === undefined) {
      const probe = await sessionGet(client, childSessionID)
      applyStaleProbe(stale, probe)
      if (staleThresholdCrossed(stale, Date.now(), startedAt, staleMs, staleFloorMs)) {
        const decision = decideStaleSweep(probe, stale, staleMode)
        if (decision.action === "gone") {
          text = `(stale: child session ${childSessionID} no longer exists after ${staleSilentMinutes(stale, Date.now(), startedAt)} min without activity — dispatch finalized honestly)`
          exitCode = 1
          break
        }
        if (decision.action === "notify") {
          stale.staleNotified = true
          flushProgress(
            `[forge:dispatch-progress] task dispatch to ${agentID} (task ${job.id}, child session ${childSessionID}) shows no activity for ` +
              `${staleSilentMinutes(stale, Date.now(), startedAt)} min (stale threshold crossed; FORGE_DISPATCH_STALE_MODE=observe — not killing).`,
          )
        } else if (decision.action === "kill") {
          const minutes = staleSilentMinutes(stale, Date.now(), startedAt)
          const ab = await abortChild(client, childSessionID)
          if (!ab.ok) {
            // Failed abort: finalize only when existence proves the session
            // gone; otherwise skip this sweep and re-arm (next sweep retries).
            const reprobe = await sessionGet(client, childSessionID)
            if (reprobe.exists === false) {
              text = `(stale: child session ${childSessionID} no longer exists after ${minutes} min without activity — dispatch finalized honestly)`
              exitCode = 1
              break
            }
          } else {
            text = `(stale: aborted after ${minutes} min without activity — child session ${childSessionID} was killed by the stale reap (FORGE_DISPATCH_STALE_MS=${staleMs}); inspect its transcript in the host TUI)`
            exitCode = 1
            break
          }
        }
        // "skip" (probe unresolved) and "quiet" (observe already notified):
        // do nothing this sweep — the next slice re-probes.
      }
    }
    // Progress cadence: one informational notice per notification interval
    // WHILE THE CHILD RUNS (a textless-idle streak is not "running"). Never
    // touches markTerminal/wakeState — the completion budget stays intact.
    const multiple = Math.floor((Date.now() - startedAt) / notifyIntervalMs)
    if (stability.textlessIdleSince === undefined && multiple > lastNotifiedMultiple) {
      lastNotifiedMultiple = multiple
      const minutes = Math.max(1, Math.round((Date.now() - startedAt) / 60000))
      const notice =
        `[forge:dispatch-progress] task dispatch to ${agentID} (task ${job.id}, child session ${childSessionID}) is still running after ${minutes} min — ` +
        `tracking continues; the final [forge:dispatch-complete] wake with the report arrives when it finishes. ` +
        `Inspect/abort in the host TUI if this looks stuck.`
      appendDispatchNotice(job, notice)
      queueDispatchProgress(job.ownerSession, notice, () => dispatchStillLive(job.id))
      // D6 parity (enqueue-while-idle): a notice parked while the owner is
      // already idle has no future idle edge to ride — deliver now (lossy).
      if (idleJobSessions.has(job.ownerSession)) void deliverDispatchProgress(job.ownerSession)
    }
  }
  if (attempt > 1) text += `\n(after ${attempt} attempt(s))`
  // Host-signal watch over: drop this child's signal state (bounded
  // ledgers; the terminal removal of the persisted row rides the
  // journalTerminalRecord choke point below).
  forgetDispatchSignals(childSessionID)
  jobManager.appendOutput(job, text)
  // stream-lost/unknown: exit-null settle (never an exit-1 death
  // certificate) + the outcome marker rides the dispatch meta so the
  // completion wake words itself honestly (jobWakeText).
  if (streamLost) {
    exitCode = null
    const meta = (job as Job & { dispatch?: DispatchJobMeta }).dispatch
    if (meta) meta.outcome = "stream-lost/unknown"
  }
  // A kill that landed during the final-message read or the stale reap: the
  // registry verdict wins (the queued wake already says ABORTED).
  if (await settleKilled()) return
  jobManager.markTerminal(job, "exited", exitCode)
  dispatchTasks.delete(job.id)
  // Fold D: the terminal transition releases the session's async slot —
  // pump the queue head (if any). Fold E: terminalize the journal record
  // (prompt REDACTED on terminal).
  journalTerminalRecord(
    {
      id: job.id,
      agent: agentID,
      ownerSession: job.ownerSession,
      workspace: retryCtx.directory,
      description: dispatch?.description ?? "",
    },
    streamLost ? "stream-lost/unknown" : exitCode === 0 ? "completed" : "error",
    streamLost
      ? `${text.split("\n")[0].slice(0, 200)} — last observed activity ${new Date(stale.lastActivity ?? startedAt).toISOString()}`
      : activeOverride
        ? `${text.split("\n")[0].slice(0, 200)} (${ACTIVE_TEXTFUL_OVERRIDE_NOTE})`
        : text.split("\n")[0].slice(0, 200),
  )
  void pumpDispatchQueue(client, job.ownerSession)
}

// fix-v2-crew-surface-drift task 2.2 (design D2): the honest-degradation
// CONTRACT STRING for a host client with no child-session creation seam —
// names the native task tool as the dispatch surface. Contract-tested
// verbatim (tests assert this exact string); never a raw TypeError.
export const TASK_SEAM_DEGRADED_ERROR =
  "[forge:dispatch] child-session creation is unavailable on this host (the client exposes no session.create seam) — use the NATIVE task tool as the dispatch surface for subagent dispatches."

const TASK_DESCRIPTION = [
  "Dispatch a subagent as a REAL child session on this host (SDK session.create with parentID): the call renders in the host session tree with native subagent affordances — the live task panel, progress, expandable transcript, user abort — and runs the target agent with its own permission map. This is the single dispatch surface: ANY materialized target dispatches through here — configured `forge-*` subagents AND every other host agent.",
  'run_in_background is YOUR dispatch-time decision: omit it (sync) when your very next step depends on the result — the call blocks until the child finishes and returns its final report (native parity: the child MAY ask the user questions; the user is present at the panel). Set run_in_background: true (async) when the result does NOT block your next steps — the call returns a task handle immediately and the child is created with the question tool denied session-wide (unattended: it never blocks on human input; an unanswered permission ask degrades to the honest poll-timeout finding naming the child session id, which stays inspectable and natively abortable in the TUI).',
  'async discipline: after an async dispatch, END YOUR TURN. Interim [forge:dispatch-progress] notices may arrive while the child runs (informational only); the single [forge:dispatch-complete] message carrying the worker\'s final report is injected when it finishes — however long it takes (idle-only, at-most-once, delivery window). NEVER poll, re-dispatch, or "check on" an async dispatch before that wake arrives — pre-wake polling is a BLOCKING anti-pattern.',
  "Sync dispatches carry abort parity: aborting the dispatching turn aborts the child session via the SDK. Async children intentionally SURVIVE turn aborts (session-scoped; they die at owner-session death, orphan-recorded).",
   "Forge roster guidance: prefer a configured `forge-*` subagent whose description matches the job (each materialized description carries its pool provenance; .opencode/forge.json is the source). Gates on forge-* targets: session-domain pool gate (cross-pool targets refused with the three exits), crew pending/compliance belts, the plan-draft readonly-recon exemption (readonly scouts pass in BOTH modes during a draft; write targets wait for approval), and primary-only (forge-* workers cannot dispatch — recursion is banned at their permission map). Non-forge host targets dispatch with native parity (no forge pool gate; the session-keyed crew pending belt and the plan-draft write-class deny still apply, exactly as for the native task tool). Cap: 3 concurrent async dispatches per session; a wish arriving beyond the cap QUEUES FIFO instead of refusing (per-session bound FORGE_DISPATCH_QUEUE_MAX, default 10) and spawns automatically when a slot frees — its handle reads QUEUED (queue position N) until spawn, and only a full queue refuses the call (listing every in-flight and queued task id).",
].join("\n")

const taskDispatchTool = tool({
  description: TASK_DESCRIPTION,
  args: {
    subagent_type: tool.schema.string().describe('Target agent id — a materialized forge-* subagent (e.g. "forge-plugindev-spec-reviewer") or any other configured host agent id'),
    prompt: tool.schema.string().describe("The complete task prompt for the worker (self-contained: it carries the artifact paths/slices and the evidence demands)"),
    description: tool.schema.string().optional().describe("Short task description used as the child session's title in the host UI (defaults to the prompt's first words)"),
    run_in_background: tool.schema.boolean().optional().describe('Dispatch-time decision: omit for sync (block this call until the child finishes and return its final report — the child may ask questions, native parity) or true for async (return a task handle immediately; interim [forge:dispatch-progress] notices may arrive while the child runs, and a single [forge:dispatch-complete] wake with the final report is guaranteed when it finishes, however long it takes — the child is sealed against human input)'),
  },
  execute: async (args, context) => {
    noteToolAgent(context)
    const target = String(args.subagent_type ?? "").trim()
    const promptRaw = String(args.prompt ?? "")
    // The dispatch's stable id, allocated up front so the report-file
    // delivery contract (dispatch-stream-loss-honesty) can name its
    // concrete path in the child's prompt — the SAME id serves the queued,
    // async, and sync branches (one newJobId() per dispatch).
    const dispatchId = newJobId()
    const prompt = promptRaw ? withReportDelivery(promptRaw, dispatchId) : ""
    const runInBackground = args.run_in_background === true
    if (!target || !prompt) throw new Error("[forge:dispatch] subagent_type and prompt are both required.")
    const forgeTarget = target.toLowerCase().startsWith("forge-")
    // Tool-partition family gates, enforced in-execute (belt parity with
    // tool.execute.before): forge-* workers hit the primary-only refusal
    // (recursion ban depth — their permission map already denies task);
    // non-forge speakers never reach forge-* targets through us.
    const speaker = sessionAgents.get(context.sessionID)
    if (speaker !== undefined && isForgeFamilyAgent(speaker) && speaker.toLowerCase() !== FORGE_AGENT) {
      throw new Error(
        `[forge:partition] Tool refused: "task" dispatch is reserved for the primary forge agent; "${speaker}" is a forge worker. Report your findings back to the orchestrating session — the primary agent dispatches at the gate.`,
      )
    }
    if (speaker !== undefined && !isForgeFamilyAgent(speaker) && forgeTarget) {
      throw new Error(
        `[forge:partition] Dispatch refused: "${target}" is a forge-family worker and the current agent ("${speaker}") is outside the forge family. Use non-forge host subagents, or switch to the forge agent to dispatch forge-* workers.`,
      )
    }
    // Crew pending belt: a registered-but-unarmed crew refuses EVERY task
    // dispatch (both target classes — same copy as the belt).
    const pendingRefusal = crewPendingRefusal(context.sessionID)
    if (pendingRefusal) throw new Error(pendingRefusal)
    if (forgeTarget) {
      // Target must be a materialized pool agent (hot-apply resolve).
      const agentId = target.slice("forge-".length)
      const resolution = resolvePools()
      if (!resolution || !resolution.agents[agentId]) {
        const hint = nativeRosterSyncHint()
        throw new Error(
          `[forge:dispatch] "${target}" is not a materialized forge subagent on this host. Check the roster in the agent descriptions (or .opencode/forge.json), or dispatch a host agent instead.${hint ?? ""}`,
        )
      }
      // Gate parity with the task belt: the SAME predicates, same copy.
      // The anchor resolution uses this host's client (jobClient — the client
      // of the server() initialization that registered this tool's host).
      const poolRefusal = await poolGateRefusal(jobClient, context.sessionID, target)
      if (poolRefusal) throw new Error(poolRefusal)
      const complianceRefusal = await crewComplianceRefusalFor(jobClient, context.sessionID, target)
      if (complianceRefusal) throw new Error(complianceRefusal)
    } else {
      // Non-forge host target (native parity path): same engine, no forge
      // pool gate. The target must exist as a host agent — honest refusal
      // otherwise (OMO "Agent not found" style).
      if (!knownHostAgents.has(target)) {
        throw new Error(
          `Agent not found: "${target}" is neither a materialized forge-* subagent nor a configured host agent. Check the agent id against the TUI agent list (or the forge roster in the agent descriptions) and retry.`,
        )
      }
    }
    const draftRefusal = draftDispatchRefusal(context.sessionID, target)
    if (draftRefusal) throw new Error(draftRefusal)
    // Fold D (cap queueing): at the cap of 3 RUNNING dispatches the wish no
    // longer refuses — it QUEUES (per-session FIFO, bounded
    // FORGE_DISPATCH_QUEUE_MAX default 10). Only a wish beyond the queue
    // bound is refused, with the in-flight AND queued task ids.
    let queueAfterCap = false
    if (runInBackground) {
      const inFlight = inFlightAsyncDispatches(context.sessionID)
      if (inFlight.length >= ASYNC_DISPATCH_CAP) {
        const queuedIds = queuedAsyncDispatchIds(context.sessionID)
        const queueMax = resolveDispatchQueueMax()
        if (queuedIds.length >= queueMax) {
          throw new Error(
            `[forge:dispatch] Async dispatch refused: this session already has ${inFlight.length} async dispatches in flight (cap ${ASYNC_DISPATCH_CAP}): ${inFlight.join(", ")} — and the dispatch queue is full (bound ${queueMax}): ${queuedIds.join(", ")}. ` +
              `Wait for their [forge:dispatch-complete] wakes (they arrive on their own — never poll), or dispatch this one without run_in_background.`,
          )
        }
        queueAfterCap = true
      }
    }
    const client = dispatchClient()
    if (!client) throw new Error("[forge:dispatch] no host client available — dispatch cannot create a child session.")
    // fix-v2-crew-surface-drift task 2.2 (design D2): guarded shape probe on
    // the child-session creation seam. When the host client resolves NO
    // create seam, the tool degrades with the honest contract string naming
    // the native task tool as the dispatch surface — never a raw TypeError
    // (the 2.3.2 live failure: "client.session.create is not a function").
    if (typeof client.session?.create !== "function") throw new Error(TASK_SEAM_DEGRADED_ERROR)
    // fix-v2-crew-surface-drift task 2.3 (design D2): the child's parent
    // directory resolves from the AUTHORITATIVE anchor (the same
    // authoritative-first chain as the belts) — a re-anchored parent
    // produces a correctly-anchored child. Without an anchor client the
    // resolution is exactly today's (tool-context anchor).
    const anchorSeam = sharedAnchorClient()
    const anchorDir =
      anchorSeam && typeof anchorSeam.session?.get === "function"
        ? (await resolveSessionAnchorForPools(anchorSeam, context.sessionID)) || sessionAnchor(context) || context.worktree
        : sessionAnchor(context) || context.worktree
    const state = ensureSession(context.sessionID, anchorDir)
    const description =
      typeof args.description === "string" && args.description.trim() ? args.description.trim().slice(0, 80) : prompt.replace(/\s+/g, " ").slice(0, 60)
    // Provider gate (harden-dispatch-resilience D3): admission is checked
    // BEFORE any child exists — breaker first, then provider/model
    // concurrency. A refusal throws the gate's honest string (mechanism,
    // counted dimension + current value, recovery condition); breaker
    // refusals are the plugin's own throttle and NEVER enter the
    // provider-retry path (no child was created, the error classifier is
    // never consulted). A QUEUED wish checks now but releases immediately —
    // the pump re-checks (and re-admits) at dequeue time.
    const gate = gateFor(state.worktree)
    const gateIdentity = dispatchModelIdentity(target, context.sessionID)
    if (gateIdentity) {
      const admission = gate.admit(gateIdentity)
      if (!admission.ok) throw new Error(admission.refusal)
      gateProvidersSeen.add(gateIdentity.provider)
      if (queueAfterCap) dispatchGate?.release(gateIdentity)
      else admittedGate.set(dispatchId, gateIdentity)
    }
    if (queueAfterCap) {
      // Fold D: the queued handle returns immediately (like an async
      // handle) with queued: true panel metadata and a queue position note;
      // the pump spawns it when a slot frees.
      const jobId = dispatchId
      const queue = dispatchQueues.get(context.sessionID) ?? []
      const position = queue.length + 1
      queue.push({ jobId, agentID: target, ownerSession: context.sessionID, description, prompt, directory: state.worktree, questionDeny: true, enqueuedAt: Date.now() })
      dispatchQueues.set(context.sessionID, queue)
      journalTransition(state.worktree, {
        id: jobId,
        agent: target,
        ownerSession: context.sessionID,
        workspace: state.worktree,
        state: "queued",
        attempts: 1,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        prompt,
        questionDeny: true,
        description,
      })
      const queuedMeta = {
        agent: target,
        sessionId: "",
        taskId: jobId,
        run_in_background: true,
        description,
        prompt,
        queued: true,
      }
      context.metadata({ title: `${target}: dispatch queued (${jobId})`, metadata: { ...queuedMeta } })
      return {
        title: `${target}: dispatch queued (${jobId})`,
        metadata: { ...queuedMeta },
        output: [
          `[forge:dispatch] Dispatched ${target} in async mode — the session is at the async dispatch cap (${ASYNC_DISPATCH_CAP} running), so this wish is QUEUED (queue position ${position}).`,
          `task id: ${jobId}`,
          `agent: ${target}`,
          `queued: position ${position} — the wish spawns automatically when a slot frees (a [forge:dispatch-progress] notice announces its start; the roster, draft gate, and crew belt are re-checked at spawn time).`,
          `Next: END YOUR TURN. Exactly one [forge:dispatch-complete] message carrying the worker's final report arrives when the spawned child finishes — however long it takes. Never poll or re-dispatch to check on it.`,
        ].join("\n"),
      }
    }
    // Fold E: journal the dispatch-time transition BEFORE the child exists —
    // a crash between create and spawn leaves this non-terminal record, which
    // recovery treats with queued semantics.
    const asyncJobId = runInBackground ? dispatchId : ""
    if (asyncJobId) {
      journalTransition(state.worktree, {
        id: asyncJobId,
        agent: target,
        ownerSession: context.sessionID,
        workspace: state.worktree,
        state: "dispatched",
        attempts: 1,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        prompt,
        questionDeny: true,
        description,
      })
    }
    // Pre-spawn roster validation (dispatch-v2-hostsignals 2.2): a drifted
    // roster refuses HERE — the task 1.1 probe proved the host's create
    // accepts ANY agent id verbatim (bogus included), so without this check
    // a stale target spawns a naked default-agent child. Gate admission is
    // released on the same failure shape as a create failure.
    const rosterRefusal = forgeTargetUnresolved(target)
    if (rosterRefusal) {
      releaseGateAdmission(dispatchId)
      throw new Error(`[forge:dispatch] target refused: ${rosterRefusal}`)
    }
    const created = await createChildSessionBound(client, {
      parentSessionID: context.sessionID,
      parentDirectory: state.worktree,
      agentID: target,
      description,
      // Question policy is mode-keyed (task-shadow): sync keeps questions
      // available (native parity); async seals the child unattended.
      questionDeny: runInBackground,
      // Agent-bound creation (dispatch-v2-hostsignals 2.1): the roster pin
      // rides the create body; the binding is asserted on the record read
      // back (v2 proven by the task 1.1 probe — v1 records not probed, the
      // assert stays off there).
      modelPin: rosterModelPin(target),
      assertBinding: v2HostSeen,
      // Nested-dispatch guard (D2): non-forge ∧ anthropic family — the
      // deny rides the create body on BOTH modes (a sync child can nest as
      // much as an async one).
      taskDeny: nestedTaskDenyFor(target, context.sessionID),
    })
    if (!created.ok) {
      releaseGateAdmission(dispatchId)
      throw new Error(`[forge:dispatch] child session creation failed: ${created.error}`)
    }
    const sent = await sendPrompt(client, { sessionID: created.sessionID, agentID: target, prompt, directory: state.worktree })
    if (!sent.ok) {
      releaseGateAdmission(dispatchId)
      throw new Error(`[forge:dispatch] prompt send to child session ${created.sessionID} failed: ${sent.error} — the child exists and is natively abortable in the TUI.`)
    }
    // Tool-part metadata mirroring the native/OMO task shape (design D3) —
    // the TUI task renderer drives off these keys.
    const taskMetadata = {
      agent: target,
      sessionId: created.sessionID,
      taskId: "",
      run_in_background: runInBackground,
      description,
      prompt,
    }
    if (!runInBackground) {
      // dispatch-resilience folds B+C on the SYNC path: the wait is SLICED
      // (5 s boundaries) so the same activity-stale reap and error-classified
      // retry govern sync dispatches — the resilience SHALLs do not carve out
      // the sync window. A real timeout still arms the standard tracker.
      const syncIntervalMs = Number(process.env.FORGE_DISPATCH_POLL_INTERVAL_MS ?? DEFAULT_POLL_INTERVAL_MS)
      const syncSliceMs = Math.max(syncIntervalMs, Number(process.env.FORGE_DISPATCH_POLL_SLICE_MS ?? 5_000))
      const syncTimeoutMs = resolvePollTimeoutMs()
      const staleMsSync = resolveStaleMs()
      const staleModeSync: StaleMode = resolveStaleMode()
      const staleFloorSync = resolveStaleFloorMs()
      const maxAttemptsSync = resolveMaxAttempts()
      const retryBackoffSync = resolveRetryBackoffMs()
      const syncStability: TerminalStabilityState = { stableTicks: 0 }
      const syncStale: StaleSweepState = { lastActivity: null, staleNotified: false }
      taskMetadata.taskId = dispatchId
      const syncJobId = dispatchId
      // Fold E: the sync path journals the same transitions (dispatched →
      // started here; terminal at each return below; retry-pending/started
      // in the retry branch; the armed tracker terminalizes at its settle).
      const syncJournalBase = { id: syncJobId, agent: target, ownerSession: context.sessionID, workspace: state.worktree, prompt, description, questionDeny: false }
      journalTransition(state.worktree, {
        id: syncJobId,
        agent: target,
        ownerSession: context.sessionID,
        workspace: state.worktree,
        state: "dispatched",
        attempts: 1,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        prompt,
        questionDeny: false,
        description,
      })
      journalTransition(state.worktree, {
        id: syncJobId,
        agent: target,
        ownerSession: context.sessionID,
        workspace: state.worktree,
        state: "started",
        childSessionId: created.sessionID,
        attempts: 1,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        prompt,
        questionDeny: false,
        description,
      })
      let childSessionID = created.sessionID
      let attemptSync = 1
      let syncStartedAt = Date.now()
      const waitStartedAt = Date.now()
      let syncCompleted = false
      let syncStreamLost = false
      let syncOverride = false
      let syncError: string | null = null
      const syncDbg = process.env.FORGE_DISPATCH_DEBUG === "1"
      let syncSliceCount = 0
      // Host-signal completion (dispatch-v2-hostsignals): the wait latch
      // arms for the FIRST sync child (respawns re-arm below) and the
      // persisted registry row mirrors this watch while the sync call
      // blocks (removed at terminal by the journal choke point).
      armDispatchWaitWatcher(childSessionID)
      void writeDispatchStorageRow({
        taskId: syncJobId,
        childSessionID,
        agent: target,
        ownerSession: context.sessionID,
        workspace: state.worktree,
        description,
        prompt,
        questionDeny: false,
        attempts: attemptSync,
        startedAt: syncStartedAt,
        updatedAt: Date.now(),
      })
      syncWait: for (;;) {
        // D4 (task 3.1): host-signal first — a durable terminal event
        // settles the sync wait with zero REST polls. The final-message
        // read below is the report carrier, not a poll.
        const signal = takeDispatchTerminalSignal(childSessionID)
        if (signal) {
          forgetDispatchSignals(childSessionID)
          if (signal.kind === "failed") {
            syncError = signal.detail ?? "session.execution.failed"
            break syncWait
          }
          if (signal.kind === "interrupted" && signal.detail === "user") {
            const ab = await abortChild(client, childSessionID)
            journalTerminalRecord(syncJournalBase, "aborted", `child session ${childSessionID} was interrupted by the user (execution.interrupted)`)
            context.metadata({ title: `${target}: dispatch interrupted`, metadata: { ...taskMetadata } })
            return {
              title: `${target}: dispatch interrupted`,
              metadata: { ...taskMetadata },
              output: [
                `[forge:dispatch] Child session ${childSessionID} was interrupted by the user${ab.ok ? "" : ` (abort call failed honestly: ${ab.error})`} — dispatch finalized honestly.`,
                `task id: ${syncJobId}`,
              ].join("\n"),
            }
          }
          if (signal.kind === "succeeded") {
            syncCompleted = true
            break syncWait
          }
          // Non-user interruption: treat as activity, keep waiting.
          noteDispatchChildActivity(childSessionID)
        }
        const poll = await pollChild(client, {
          sessionID: childSessionID,
          intervalMs: syncIntervalMs,
          timeoutMs: syncSliceMs,
          stability: syncStability,
          signal: context.abort,
        })
        if (poll.status === "aborted") {
          // Sync abort parity (design D4): abort the child via the SDK and
          // resolve with the abort disclosed.
          const ab = await abortChild(client, childSessionID)
          journalTerminalRecord(syncJournalBase, "aborted", `dispatching turn aborted — child session ${childSessionID} aborted via the SDK`)
          context.metadata({ title: `${target}: dispatch aborted`, metadata: { ...taskMetadata } })
          return {
            title: `${target}: dispatch aborted`,
            metadata: { ...taskMetadata },
            output: [
              `[forge:dispatch] The dispatching turn was aborted — child session ${childSessionID} was aborted via the SDK${ab.ok ? "" : ` (abort call failed honestly: ${ab.error})`}.`,
              `task id: ${syncJobId}`,
            ].join("\n"),
          }
        }
        if (poll.status === "error") {
          // Fold C on the sync path: retry ONLY transient classes while
          // attempts remain (stale kills never reach this — they are
          // orchestrator-side findings below; a registry kill cannot happen
          // mid-sync-call).
          if (attemptSync < maxAttemptsSync && classifyDispatchError(poll.error) === "retryable") {
            const errorHead = poll.error.split("\n")[0].slice(0, 160)
            attemptSync++
            journalTransition(state.worktree, {
              id: syncJobId,
              agent: target,
              ownerSession: context.sessionID,
              workspace: state.worktree,
              state: "retry-pending",
              attempts: attemptSync,
              createdAt: Date.now(),
              updatedAt: Date.now(),
              prompt,
              questionDeny: false,
              description,
            })
            queueDispatchProgress(
              context.sessionID,
              `[forge:dispatch-progress] attempt ${attemptSync}/${maxAttemptsSync} starting after ${errorHead}… — respawning ${target} (previous child session ${childSessionID}) with the resume preamble.`,
              // Delivered only if this call timed out and armed the tracker
              // (a registry row is then live); a dispatch that completed
              // inside the sync wait has no row — its result was returned.
              () => dispatchStillLive(syncJobId),
            )
            await new Promise((resolve) => setTimeout(resolve, retryBackoffSync))
            const refusal =
              crewPendingRefusal(context.sessionID) ??
              draftDispatchRefusal(context.sessionID, target) ??
              forgeTargetUnresolved(target)
            if (refusal) {
              journalTerminalRecord(syncJournalBase, "error", `retry refused at respawn: ${refusal}`)
              throw new Error(`[forge:dispatch] retry refused at respawn: ${refusal} — previous attempt (child session ${childSessionID}) ended in error: ${errorHead}`)
            }
            const respawn = await createChildSessionBound(client, {
              parentSessionID: context.sessionID,
              parentDirectory: state.worktree,
              agentID: target,
              description,
              questionDeny: false,
              modelPin: rosterModelPin(target),
              assertBinding: v2HostSeen,
              taskDeny: nestedTaskDenyFor(target, context.sessionID, childSessionID),
            })
            if (!respawn.ok) {
              journalTerminalRecord(syncJournalBase, "error", `retry spawn failed: ${respawn.error}`)
              throw new Error(`[forge:dispatch] retry spawn failed: ${respawn.error} — previous attempt (child session ${childSessionID}) ended in error: ${errorHead}`)
            }
            const sent = await sendPrompt(client, {
              sessionID: respawn.sessionID,
              agentID: target,
              prompt: buildRetryPrompt(prompt),
              directory: state.worktree,
            })
            if (!sent.ok) {
              journalTerminalRecord(syncJournalBase, "error", `retry prompt send failed: ${sent.error}`)
              throw new Error(`[forge:dispatch] retry prompt send failed: ${sent.error} — previous attempt (child session ${childSessionID}) ended in error: ${errorHead}`)
            }
            // Slot inheritance: fresh child, same sync call. Stale, stability,
            // and the clock restart for the fresh child. Host-signal rebind:
            // drop the dead child's signals, re-arm the latch + registry row.
            forgetDispatchSignals(childSessionID)
            childSessionID = respawn.sessionID
            armDispatchWaitWatcher(childSessionID)
            void writeDispatchStorageRow({
              taskId: syncJobId,
              childSessionID,
              agent: target,
              ownerSession: context.sessionID,
              workspace: state.worktree,
              description,
              prompt,
              questionDeny: false,
              attempts: attemptSync,
              startedAt: syncStartedAt,
              updatedAt: Date.now(),
            })
            taskMetadata.sessionId = childSessionID
            journalTransition(state.worktree, {
              id: syncJobId,
              agent: target,
              ownerSession: context.sessionID,
              workspace: state.worktree,
              state: "started",
              childSessionId: childSessionID,
              attempts: attemptSync,
              createdAt: Date.now(),
              updatedAt: Date.now(),
              prompt,
              questionDeny: false,
              description,
            })
            syncStartedAt = Date.now()
            syncStale.lastActivity = null
            syncStale.staleNotified = false
            syncStability.stableTicks = 0
            syncStability.activeTextfulTicks = 0
            syncStability.textlessIdleSince = undefined
            continue syncWait
          }
          syncError = attemptSync > 1 ? `${poll.error} — after ${attemptSync} attempt(s)` : poll.error
          break syncWait
        }
        if (poll.status === "timeout") {
          if (Date.now() - waitStartedAt >= syncTimeoutMs) break syncWait // real timeout → arm below
          // Activity-stale reap (fold B) on the running axis — same helpers
          // as the async poller; the probe doubles as the pre-kill re-read
          // and the refresh rail.
          if (syncDbg) {
            syncSliceCount++
            if (syncSliceCount === 1) {
              const names: string[] = []
              let cur = (client as unknown as { session?: object }).session
              while (cur && cur !== Object.prototype) {
                names.push(...Object.getOwnPropertyNames(cur))
                cur = Object.getPrototypeOf(cur)
              }
              console.error(`[forge-dbg] client.session methods: ${[...new Set(names)].filter((n) => n !== "constructor").join(",")}`)
            }
            console.error(`[forge-dbg] slice ${syncSliceCount}: status=timeout idle=${syncStability.textlessIdleSince === undefined ? "undef" : "set"} staleMs=${staleMsSync} floor=${staleFloorSync} mode=${staleModeSync} elapsed=${Math.round((Date.now() - syncStartedAt) / 1000)}s`)
          }
          if (syncStability.textlessIdleSince === undefined) {
            const probe = await sessionGet(client, childSessionID)
            applyStaleProbe(syncStale, probe)
            if (syncDbg) console.error(`[forge-dbg] probe: exists=${probe.exists} timeUpdated=${probe.timeUpdated} anchor=${syncStale.lastActivity}`)
            if (staleThresholdCrossed(syncStale, Date.now(), syncStartedAt, staleMsSync, staleFloorSync)) {
              const decision = decideStaleSweep(probe, syncStale, staleModeSync)
              if (decision.action === "gone") {
                journalTerminalRecord(syncJournalBase, "stale", `child session ${childSessionID} no longer exists after ${staleSilentMinutes(syncStale, Date.now(), syncStartedAt)} min without activity — dispatch finalized honestly`)
                context.metadata({ title: `${target}: dispatch stale-finalized`, metadata: { ...taskMetadata } })
                return {
                  title: `${target}: dispatch stale-finalized`,
                  metadata: { ...taskMetadata },
                  output: [
                    `[forge:dispatch] (stale: child session ${childSessionID} no longer exists after ${staleSilentMinutes(syncStale, Date.now(), syncStartedAt)} min without activity — dispatch finalized honestly).`,
                    `task id: ${syncJobId}`,
                  ].join("\n"),
                }
              }
              if (decision.action === "kill") {
                const ab = await abortChild(client, childSessionID)
                if (ab.ok) {
                  journalTerminalRecord(syncJournalBase, "stale", `aborted after ${staleSilentMinutes(syncStale, Date.now(), syncStartedAt)} min without activity — child session ${childSessionID} killed by the stale reap`)
                  context.metadata({ title: `${target}: dispatch stale-reaped`, metadata: { ...taskMetadata } })
                  return {
                    title: `${target}: dispatch stale-reaped`,
                    metadata: { ...taskMetadata },
                    output: [
                      `[forge:dispatch] (stale: aborted after ${staleSilentMinutes(syncStale, Date.now(), syncStartedAt)} min without activity — child session ${childSessionID} was killed by the stale reap (FORGE_DISPATCH_STALE_MS=${staleMsSync}); inspect its transcript in the host TUI).`,
                      `task id: ${syncJobId}`,
                    ].join("\n"),
                  }
                }
                // Failed abort: finalize only when existence proves gone;
                // otherwise skip this sweep and re-arm (next slice retries).
                const reprobe = await sessionGet(client, childSessionID)
                if (reprobe.exists === false) {
                  journalTerminalRecord(syncJournalBase, "stale", `child session ${childSessionID} no longer exists after ${staleSilentMinutes(syncStale, Date.now(), syncStartedAt)} min without activity — dispatch finalized honestly`)
                  context.metadata({ title: `${target}: dispatch stale-finalized`, metadata: { ...taskMetadata } })
                  return {
                    title: `${target}: dispatch stale-finalized`,
                    metadata: { ...taskMetadata },
                    output: [
                      `[forge:dispatch] (stale: child session ${childSessionID} no longer exists after ${staleSilentMinutes(syncStale, Date.now(), syncStartedAt)} min without activity — dispatch finalized honestly).`,
                      `task id: ${syncJobId}`,
                    ].join("\n"),
                  }
                }
              }
              // observe mode / skipped sweeps: keep waiting (observe notices
              // ride the armed tracker if the wait later times out)
            }
          }
          continue syncWait
        }
        // Sustained view loss (dispatch-stream-loss-honesty) on the sync
        // path: the poll view broke — never misread as completion; break
        // out to the honest arm-and-throw settle below.
        if (poll.status === "stream-lost") {
          syncStreamLost = true
          break syncWait
        }
        syncCompleted = true
        syncOverride = poll.via === "active-textful"
        break syncWait
      }
      // Sync watch over: drop this child's signal state (the persisted row
      // removal rides the journalTerminalRecord choke points above).
      forgetDispatchSignals(childSessionID)
      if (syncCompleted) {
        const fin = await fetchFinalMessage(client, childSessionID)
        if (!fin.ok) {
          journalTerminalRecord(syncJournalBase, "error", fin.error)
          throw new Error(`[forge:dispatch] ${fin.error}`)
        }
        journalTerminalRecord(
          syncJournalBase,
          "completed",
          `${target} finished (child session ${childSessionID})${syncOverride ? ` (${ACTIVE_TEXTFUL_OVERRIDE_NOTE})` : ""}`,
        )
        context.metadata({ title: `${target}: dispatch complete`, metadata: { ...taskMetadata } })
        const recoveredNote = attemptSync > 1 ? ` — recovered on attempt ${attemptSync}/${maxAttemptsSync} (previous child session(s) died with transient errors and were respawned; the [forge:dispatch-progress] notice lands in this transcript when the session idles)` : ""
        const overrideNote = syncOverride ? ` — ${ACTIVE_TEXTFUL_OVERRIDE_NOTE}` : ""
        return {
          title: `${target}: dispatch complete`,
          metadata: { ...taskMetadata },
          output: [`[forge:dispatch] ${target} finished (child session ${childSessionID})${recoveredNote}${overrideNote}.`, `Final report:\n${fin.text}`].join("\n"),
        }
      }
      if (syncError !== null) {
        journalTerminalRecord(syncJournalBase, "error", `child session ${childSessionID} ended in error: ${syncError}`.slice(0, 200))
        throw new Error(`[forge:dispatch] child session ${childSessionID} ended in error: ${syncError}`)
      }
      // sync-timeout-notify: arm, don't abandon (design D1). The child is
      // already running; before the honest throw we register it in the
      // dispatch registry and start the standard completion poller so
      // exactly one [forge:dispatch-complete] wake carries the final
      // report when it eventually finishes. Arming is UNCONDITIONAL
      // (design D3): the async cap governs new async dispatch DECISIONS,
      // not the reality of an already-running child — refusing to track
      // it would change nothing except guaranteeing the result is lost.
      // Shared by BOTH honest wait-ends: the wait-budget timeout AND the
      // sustained view loss (dispatch-stream-loss-honesty) — a lost view
      // arms the same tracker (a recovered view + finish still delivers
      // the wake; a sustained loss settles as a stream-lost wake).
      const armSyncTracker = (): void => {
        const job = jobManager.create({
          id: syncJobId,
          cmd: `dispatch ${target}: ${description} (sync wait ended, armed)`,
          worktree: state.worktree,
          ownerSession: context.sessionID,
          logPath: join(jobLogDir(), "dispatch", `${syncJobId}.txt`),
          notify: true,
          // Owner-death harvest parity: the manager's kill() on session end
          // aborts the child via the SDK and ledgers the orphan.
          killTree: dispatchKillTreeHook(client, syncJobId, () => childSessionID),
        })
        ;(job as Job & { dispatch?: DispatchJobMeta }).dispatch = { agentID: target, childSessionID, description }
        registerDispatchTask({ jobId: syncJobId, childSessionID, agentID: target, ownerSession: context.sessionID, description }, state.worktree)
        void runAsyncDispatchPoller(client, job, childSessionID, { prompt, directory: state.worktree, questionDeny: false })
        context.metadata({ title: `${target}: dispatch async`, metadata: { ...taskMetadata } })
      }
      if (syncStreamLost) {
        // dispatch-sync-handoff-notice: a view loss is NOT an error — the
        // tracker is armed and the handoff surfaces as an informational
        // notice (no error-channel rendering).
        armSyncTracker()
        const attemptNoteLost = attemptSync > 1 ? `${attemptSync} attempt(s) so far; tracking continues in the armed tracker.` : ""
        return {
          title: `${target}: dispatch continues (result stream lost)`,
          metadata: { ...taskMetadata },
          output: [
            `[forge:dispatch] Result stream lost before a final report — child session ${childSessionID} state UNKNOWN (possibly still running). The dispatch continues in the background; collect with forge_jobs.`,
            `task id: ${syncJobId}${attemptNoteLost ? ` — ${attemptNoteLost}` : ""}`,
            `Ground-truth recovery: read reports/${syncJobId}-report.md in the workspace BEFORE considering a re-dispatch.`,
            `If the view recovers and the child finishes, exactly one [forge:dispatch-complete] wake carries the outcome; the child session stays inspectable and natively abortable in the host TUI.`,
          ].join("\n"),
        }
      }
      // dispatch-sync-handoff-notice: the wait-budget expiry handoff is a
      // normal notification, NOT an error — neutral wording naming the
      // outcome, with every retrieval pointer preserved (job id, task
      // handle, child session, report path).
      armSyncTracker()
      const attemptNote = attemptSync > 1 ? ` ${attemptSync} attempt(s) so far; retries continue in the armed tracker.` : ""
      return {
        title: `${target}: dispatch continues in background`,
        metadata: { ...taskMetadata },
        output: [
          `[forge:dispatch] Sync wait budget ended (${syncTimeoutMs}ms) — the dispatch continues in the background; collect with forge_jobs.`,
          `task id: ${syncJobId}${attemptNote}`,
          `child session: ${childSessionID} — it remains a real session: inspect or abort it natively in the host TUI.`,
          `Report path (ground truth): reports/${syncJobId}-report.md.`,
          `The completion contract: exactly one [forge:dispatch-complete] wake carrying the final report arrives when the child finishes (interim [forge:dispatch-progress] notices may arrive meanwhile), however long it takes; do not poll or re-dispatch in the meantime.`,
        ].join("\n"),
      }
    }
    // async: registry entry (kind=dispatch) + poller; the handle returns now.
    const jobId = asyncJobId || newJobId()
    taskMetadata.taskId = jobId
    const job = jobManager.create({
      id: jobId,
      cmd: `dispatch ${target}: ${description}`,
      worktree: state.worktree,
      ownerSession: context.sessionID,
      logPath: join(jobLogDir(), "dispatch", `${jobId}.txt`),
      notify: true,
      // Owner-death harvest: the manager's kill() on session end calls this —
      // the child session is aborted via the SDK and the orphan is ledgered.
      killTree: dispatchKillTreeHook(client, jobId, () => created.sessionID),
    })
    ;(job as Job & { dispatch?: DispatchJobMeta }).dispatch = { agentID: target, childSessionID: created.sessionID, description }
    registerDispatchTask({ jobId, childSessionID: created.sessionID, agentID: target, ownerSession: context.sessionID, description }, state.worktree)
    // Fold E: the started transition (prompt retained — the journal is the
    // only prompt source after a restart).
    journalTransition(state.worktree, {
      id: jobId,
      agent: target,
      ownerSession: context.sessionID,
      workspace: state.worktree,
      state: "started",
      childSessionId: created.sessionID,
      attempts: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      prompt,
      questionDeny: true,
      description,
    })
    void runAsyncDispatchPoller(client, job, created.sessionID, { prompt, directory: state.worktree, questionDeny: true })
    context.metadata({ title: `${target}: dispatch async`, metadata: { ...taskMetadata } })
    return {
      title: `${target}: dispatch async (${jobId})`,
      metadata: { ...taskMetadata },
      output: [
        `[forge:dispatch] Dispatched ${target} in async mode — the child session runs in the background.`,
        `task id: ${jobId}`,
        `agent: ${target}`,
        `child session: ${created.sessionID} (visible in the host session tree; natively abortable)`,
        `Next: END YOUR TURN. Interim [forge:dispatch-progress] notices may arrive while the child runs (informational only); exactly one [forge:dispatch-complete] message carrying the worker's final report arrives when it finishes — however long it takes. Never poll or re-dispatch to check on it. Cap: ${ASYNC_DISPATCH_CAP} concurrent async dispatches per session.`,
      ].join("\n"),
    }
  },
})




// ---------------------------------------------------------------------------
// Search tools (change forge-search-tools D1-D7; engine chain per change
// search-js-fallback D1/D5/D6)
// ---------------------------------------------------------------------------

// Config override read at call time through the plugin-options surface (the
// same surface jobs/watchdog ride). rg resolution itself re-runs PER CALL
// (config override → PATH → bundled JS engine), so installing rg needs no
// restart — and a machine with no rg at all still gets every call served.
let searchRgPathOverride: string | undefined

const FORGE_SEARCH_PREFERENCE_LINE =
  "Prefer forge_grep/forge_glob over the builtin grep/glob — follow and hidden are on by default (symlinks/junctions and dot-directories are in scope; the builtin pair is blind to both)."

const FORGE_GREP_DESCRIPTION = [
  "Fast content search (ripgrep when it resolves, the plugin's bundled JS engine otherwise — a trailing engine line discloses which) that sees through symlinks/junctions and dot-directories where the builtin pair is blind. Readonly by construction: the pattern and path reach the serving engine as single literal values — no shell exists, so shell metacharacters can neither redirect output nor alter execution.",
  "Output matches the builtin grep's format: `Found N matches` header + `path: Line n: content` blocks, truncated at 100 results with a notice. With follow on (default), a file reachable through multiple paths reports once and the output ends with a `+N duplicate paths merged` line; links whose targets lie outside the workspace are followed and the resolved outside target is disclosed.",
  FORGE_SEARCH_PREFERENCE_LINE,
].join("\n")

const FORGE_GLOB_DESCRIPTION = [
  "Fast file-pattern search (ripgrep when it resolves, the plugin's bundled JS engine otherwise — a trailing engine line discloses which) that lists matching paths — including EMPTY files — and paths behind symlinks/junctions and inside dot-directories where the builtin glob is blind. Readonly by construction — no shell ever exists.",
  "Output matches the builtin glob's format: a plain unique path list (`No files found` when empty), truncated at 100 results with a notice. With follow on (default), duplicate link-path hits merge and the output ends with a `+N duplicate paths merged` line.",
  FORGE_SEARCH_PREFERENCE_LINE,
].join("\n")

// Realpath seam for the dedupe post-pass: rg reports paths relative to its
// cwd (the session worktree), so resolve against the worktree first, then
// realpath. A resolution failure degrades to the reported path (fail-soft:
// dedupe simply cannot merge what it cannot resolve).
function reportedPathResolver(worktree: string): (p: string) => string {
  return (p) => {
    try {
      return realpathSync.native(isAbsolute(p) ? p : join(worktree, p)).toString()
    } catch {
      return p
    }
  }
}

// Real fs seams for the bundled JS engine (change search-js-fallback D6):
// readdir(withFileTypes) mapped to the engine's JsDirent shape; stat follows
// links (symlink/junction classification); readFilePrefix reads maxBytes + 1
// so the engine can detect oversized files; realpath via realpathSync.native
// with a fail-soft fallback to the path as-is (a broken resolution must not
// kill the walk — the engine's cycle guard degrades, siblings still apply).
const realJsSeams: JsSearchSeams = {
  readdir: async (dir) => {
    const entries = await fsReaddir(dir, { withFileTypes: true })
    return entries.map((e) => ({
      name: e.name,
      isFile: e.isFile(),
      isDirectory: e.isDirectory(),
      isSymbolicLink: e.isSymbolicLink(),
    }))
  },
  stat: (p) =>
    fsStat(p).then((s) => ({ isFile: s.isFile(), isDirectory: s.isDirectory() })),
  readFilePrefix: async (p, maxBytes) => {
    const fh = await fsOpen(p, "r")
    try {
      const buf = Buffer.alloc(maxBytes + 1)
      const { bytesRead } = await fh.read(buf, 0, maxBytes + 1, 0)
      return buf.subarray(0, bytesRead)
    } finally {
      await fh.close()
    }
  },
  realpath: (p) => {
    try {
      return realpathSync.native(p).toString()
    } catch {
      return p
    }
  },
}

// Engine-disclosure footnotes (design D5) — appended LAST, after the dedupe
// footnotes, whenever the bundled JS engine served the call.
const ENGINE_FOOTNOTE_MISS =
  "(engine: builtin-js — ripgrep not found; install ripgrep or set search.rgPath for the faster engine)"
const engineFootnoteFailure = (reason: string) =>
  `(engine: builtin-js — rg failed to serve the call (${reason}); install ripgrep or set search.rgPath)`

async function runSearch(
  kind: SearchToolKind,
  args: { pattern: string; path?: string; include?: string; follow?: boolean; hidden?: boolean },
  context: { sessionID: string; worktree: string; directory?: string; agent?: unknown; metadata?: (input: { title?: string }) => void },
): Promise<{ title: string; output: string }> {
  // Engine chain (search-js-fallback D1/D6): config override → PATH rg →
  // bundled JS engine. Resolution re-runs per call, so an install picked up
  // mid-session works with no restart — and a miss now SERVES the call
  // through the JS engine instead of failing soft.
  const resolution = resolveRgBinary(searchRgPathOverride !== undefined ? { rgPath: searchRgPathOverride } : undefined)
  const state = ensureSession(context.sessionID, worktreeFor(context))
  const follow = args.follow !== false
  const hidden = args.hidden !== false
  const targetPath = typeof args.path === "string" && args.path.length > 0 ? (isAbsolute(args.path) ? args.path : join(state.worktree, args.path)) : undefined
  // search-glob-anchor D1: an explicit path resolving to a DIRECTORY changes
  // the serving shape on BOTH legs — the pattern anchors and the output reads
  // RELATIVE TO THAT DIRECTORY. Root cause on the rg leg: with --hidden or
  // --follow present (our defaults) and an ABSOLUTE root argument, rg lifts
  // glob anchoring to the whole path, so anchored patterns (`*/x`) can never
  // span the `C:\…` prefix (rg 15.2.0, bisect-verified). The fix: spawn rg
  // with cwd = target dir and the path argument "." — the exact shape the
  // default-root path always used. FILE targets and the default root keep
  // their pre-change shapes.
  let targetIsDir = false
  if (targetPath !== undefined) {
    try {
      targetIsDir = (await fsStat(targetPath)).isDirectory()
    } catch {
      // Unstattable target: keep the legacy absolute-argument shape; the JS
      // leg's root-access error surfaces honestly if rg also cannot serve.
    }
  }
  context.metadata?.({ title: `forge_${kind}: ${args.pattern.slice(0, 60)}` })
  let records: RgMatchRecord[] = []
  let jsNotices: string[] = []
  let engineFootnote: string | undefined
  if (resolution.ok) {
    // A path arg is ALWAYS given: with no path and a piped stdin, rg reads
    // STDIN and never exits (probe-verified). "." keeps output paths relative
    // (builtin parity). search-glob-anchor D1: an explicit DIRECTORY target
    // ALSO serves through "." — rg runs with cwd = the target dir so anchored
    // globs bind target-relative and output paths arrive `.\`-prefixed (the
    // shared strip below turns them target-relative). A FILE target keeps the
    // absolute-argument shape (single-file scan, no traversal anchoring).
    const rgCwd = targetIsDir && targetPath !== undefined ? targetPath : state.worktree
    const searchPath = targetIsDir ? "." : (targetPath ?? ".")
    // One fixed argv vector per kind (D1). grep: literal pattern after `--`.
    // glob: the files-listing vector (D1b, rg --files semantics) — the file
    // pattern rides `--glob=` and EMPTY files are listed too (zero lines → no
    // match events → invisible to the content vector; builtin-glob parity).
    const argv =
      kind === "glob"
        ? buildRgFilesArgv({ pattern: args.pattern, path: searchPath, follow, hidden })
        : buildRgArgv({ kind, pattern: args.pattern, include: args.include, path: searchPath, follow, hidden })
    // Direct spawn, shell:false, fixed argv — no shell string ever exists
    // (readonly by construction; the exec seal governs forge_shell only).
    // stdin is ignored: rg must never mistake our pipe for search input.
    const child = spawn(resolution.binary, argv, { cwd: rgCwd, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    let spawnError: Error | undefined
    child.on("error", (err) => {
      spawnError = err
    })
    child.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString("utf8")
    })
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString("utf8")
    })
    const code = await new Promise<number | null>((resolve) => {
      child.on("close", (c) => resolve(c))
    })
    // rg exit codes: 0 = matches, 1 = no matches (both parse), 2+ = error.
    // Spawn-stage failure (unspawnable binary) or exit > 1 falls THROUGH to
    // the bundled JS engine (D1) — the old error objects die with the
    // fail-soft contract; the footnote names the failure instead.
    if (spawnError !== undefined) {
      engineFootnote = engineFootnoteFailure(spawnError.message)
    } else if (code !== null && code > 1) {
      engineFootnote = engineFootnoteFailure(`exit ${code}`)
    } else {
      // rg --files (glob) emits a plain path list; grep emits the --json
      // stream. The default "." path arg makes rg prefix every path with .\ or
      // ./ — strip it for builtin-pair output parity (they print bare relative
      // paths). stderr intentionally unused on clean exits (rg -h noise).
      void stderr
      const stripDotPrefix = (p: string): string => p.replace(/^\.(?:\\|\/)/, "")
      const rawRecords = kind === "glob" ? parseRgFilesList(stdout) : parseRgJsonStream(stdout).records
      records = rawRecords.map((r) => ({ ...r, path: stripDotPrefix(r.path) }))
    }
  } else {
    // Resolution miss: the bundled JS engine serves the call directly (D6).
    engineFootnote = ENGINE_FOOTNOTE_MISS
  }
  if (engineFootnote !== undefined) {
    // JS engine serves a call rg could not. The walk root is the resolved
    // absolute target (or the session worktree). search-glob-anchor D2: a
    // DIRECTORY target's records stay walk-relative VERBATIM — byte-identical
    // to the rg leg's stripped `.`-form output for the same query (cross-
    // engine consistency); only a FILE target carries the root join (its
    // verbatim-abs records pass through). Errors (compile failure /
    // inaccessible root) return verbatim — no partial results.
    const root = targetPath ?? state.worktree
    const js = await jsSearch(
      { kind, root, pattern: args.pattern, include: args.include, follow, hidden, pathSeparator: process.platform === "win32" ? "\\" : "/" },
      realJsSeams,
    )
    if (js.error !== undefined) {
      return { title: "search engine error", output: js.error }
    }
    records =
      targetPath === undefined || targetIsDir
        ? js.records
        : js.records.map((r) => (isAbsolute(r.path) ? r : { ...r, path: join(root, r.path) }))
    jsNotices = js.notices
  }
  // Shared post-pass, UNCHANGED for both engines (D2): records →
  // dedupeFollowMatches (same reportedPathResolver seam) → formatSearchOutput,
  // with the JS engine's bound notices and — LAST — the engine footnote
  // appended on new lines. rg-served calls carry no footnote.
  // search-glob-anchor D3: the realpath resolver keys to the call's
  // EFFECTIVE root — an explicit directory target resolves its records
  // against THAT directory (they are target-relative now), not the worktree;
  // the outside-workspace disclosure keeps comparing against the worktree
  // (disclosure semantics: what escapes the WORKSPACE).
  const effectiveRoot = targetIsDir && targetPath !== undefined ? targetPath : state.worktree
  const deduped = dedupeFollowMatches(records, {
    worktreeRoot: state.worktree,
    resolvePath: reportedPathResolver(effectiveRoot),
    follow,
  })
  const body = formatSearchOutput(deduped.records, {
    kind,
    mergedDuplicates: deduped.mergedDuplicates,
    outsideTargets: deduped.outsideTargets,
  })
  const output = [body, ...jsNotices, ...(engineFootnote !== undefined ? [engineFootnote] : [])].join("\n")
  return {
    title: `${deduped.records.length} result${deduped.records.length === 1 ? "" : "s"}`,
    output,
  }
}

const forgeGrepTool = tool({
  description: FORGE_GREP_DESCRIPTION,
  args: {
    pattern: tool.schema.string().describe("The regular expression to search for (passed to ripgrep verbatim as a single literal argument)"),
    path: tool.schema.string().optional().describe("Optional target file or directory (workspace-relative, or absolute). Defaults to the session worktree"),
    include: tool.schema.string().optional().describe("File filter glob (e.g. \"*.ts\") — only matching files are searched"),
    follow: tool.schema.boolean().optional().describe("Follow symlinks/junctions during traversal (default TRUE — diverges from the builtin pair by design)"),
    hidden: tool.schema.boolean().optional().describe("Search dot-directories (default TRUE — diverges from the builtin pair by design)"),
  },
  execute: async (args, context) => {
    noteToolAgent(context)
    return runSearch("grep", { pattern: args.pattern, path: args.path, include: args.include, follow: args.follow, hidden: args.hidden }, context)
  },
})

const forgeGlobTool = tool({
  description: FORGE_GLOB_DESCRIPTION,
  args: {
    pattern: tool.schema.string().describe("The file-pattern glob to list (e.g. \"**/*.ts\") — rides ripgrep's --glob filter verbatim"),
    path: tool.schema.string().optional().describe("Optional target directory (workspace-relative, or absolute). Defaults to the session worktree"),
    follow: tool.schema.boolean().optional().describe("Follow symlinks/junctions during traversal (default TRUE — diverges from the builtin pair by design)"),
    hidden: tool.schema.boolean().optional().describe("List dot-directories' files (default TRUE — diverges from the builtin pair by design)"),
  },
  execute: async (args, context) => {
    noteToolAgent(context)
    return runSearch("glob", { pattern: args.pattern, path: args.path, follow: args.follow, hidden: args.hidden }, context)
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
export const CREW_INIT_TEMPLATE = [
  "(forge crew orchestration. Argument: \"$ARGUMENTS\")",
  "",
  "FAMILY GUARD (step 0, before anything else): if you do not have the crew_begin tool in your available tools, you are not in a forge session — STOP now and tell the user that /crew belongs to the forge agent, who should switch to forge (Tab) and rerun it there.",
  "",
  "CREW IS NOT INITIALIZED: no forge subagent is materialized for this session's roster (neither the workspace pool nor the global fallback yields an agent). Refuse to enter orchestration and tell the user this feature needs a one-time setup, offering BOTH options:",
  "",
  "1. The user configures it themselves — create either layer, SOLE OWNERSHIP (the same workspace-ownership strictness as opencode's native MCP config): the workspace pool is the NEAREST .opencode/forge.json walking up from this session's worktree, and when it exists it IS the session's whole roster; the global layer serves only as the fallback when the workspace has none — a fallback, NOT a merge (a workspace with a pool never sees global agents; nested forge.json files deeper in the workspace subtree are ignored entirely):",
  "{paths}",
  "",
  "Two axes, distinct: POOLS follow workspaces (sole ownership above — dispatch is gated to the session's own pool / the global fallback); SESSION ARTIFACTS (plan/goal/crew records) follow the session. A forge.json in another workspace is not dispatchable from this session.",
  "",
  "2. Or, ONLY if the user explicitly asks you to configure it in this conversation, you may write the file yourself through the normal write path. NEVER write forge.json without that explicit go-ahead. When you configure it: name ids as PLAIN role words WITHOUT the `forge-` prefix (a `forge-`-prefixed id doubles up and is auto-stripped with a warning) — every pool materializes as `forge-<ns>-<id>` under its `pool` namespace (the global fallback materializes as `forge-global-<id>`). Give EVERY agent a SHORT prompt derived from the role the user asked for — one or two sentences describing its job (the user trims or extends from there); write a long prompt ONLY when the user explicitly asks for that agent. Give EVERY agent an EXPLICIT `shape`: `readonly` for read-only roles (reviewer/scout/planner — denies write/edit/bash and the patch family), `write` for implementers and build drivers. ALWAYS include the top-level `pool` namespace (a [a-z0-9-] word up to 24 chars — e.g. \"aa\" for a specialist pool): it is REQUIRED for crew-governed dispatch (the compliance gate) and keeps the materialized ids stable across directory renames.",
  "",
  "Template (JSONC — comments allowed): ids are plain role words (research, coder, ...) — every pool materializes as `forge-<ns>-<id>` (the global fallback materializes as `forge-global-<id>`); `model` + `thoughtLevel` are an ATOMIC PAIR — set BOTH to pin the brain and depth (model = exact provider/model identity; thoughtLevel = none/low/medium/high/max or a native level name), or NEITHER for an Auto worker that inherits the parent session's model; exactly one of the two is rejected. Optional per agent: `prompt` — a short role description; an explicit prompt FULLY overrides the built-in role (only the ids `research` and `review` carry built-ins; any other id without a prompt gets a generic one-liner and will not know its job). Optional per agent: `shape` — an ABSENT shape defaults to WRITE (open permissions — the compatibility-preserving default for existing pools); `shape: \"readonly\"` is the explicit seal that denies the mutating-tool family (write/edit/bash + patch/applypatch/apply/multiedit) for read-only roles. Top level: `pool` — the file's namespace, REQUIRED for crew-governed dispatch.",
  "{template}",
  "",
  "After the file is saved: file edits, creations, and deletions apply at the next config hook — NO host restart is needed, and a DELETED pool file un-materializes its agents (deletion is real — no zombie pools survive on disk truth).",
].join("\n")

export function crewOrchestrationTemplate(resolution: PoolResolution | null): string {
  const families = resolution?.families ?? []
  const globalPath = forgeConfigPaths({ homeDir: process.env.FORGE_TEST_FORGE_HOME ?? homedir() }).global
  // Session-scoped roster (sole-pool-ownership): the template is composed
  // per config hook (no session yet), so the SESSION's own pool is resolved
  // live at command time via the `!` injection (same mechanism as the /plan
  // directory listing); every OTHER host pool is listed statically, each
  // marked NOT dispatchable from this session with its origin path.
  const otherLines = families.map((f) => {
    const label = `pool ${f.ns} (forge-${f.ns}-*)`
    return `  - ${label} — origin ${f.file} — NOT dispatchable from this session (unless this session's worktree is owned by that pool / it is the global fallback): ${f.materializedIds.map((id) => `forge-${id}`).join(", ") || "no agents"}`
  })
  return [
    "(forge crew orchestration. Argument: \"$ARGUMENTS\")",
    "",
    "FAMILY GUARD (step 0, before anything else): if you do not have the crew_begin tool in your available tools, you are not in a forge session — STOP now and tell the user that /crew belongs to the forge agent, who should switch to forge (Tab) and rerun it there.",
    "",
    "Configured forge subagents (task-tool vocabulary). ROSTER OWNERSHIP (sole ownership): THIS session's dispatchable roster is its WORKSPACE pool — the nearest .opencode/forge.json walking up from this session's worktree — or, when the workspace has none, the GLOBAL fallback layer (a fallback, not a merge; forge.json files nested deeper in the workspace subtree are ignored, same as opencode's native MCP config). Check this workspace's pool:",
    '  - this workspace pool (when the path prints, its agents ARE the roster): !`ls .opencode/forge.json 2>/dev/null || echo "(no workspace pool — the global fallback applies)"`',
    `  - global fallback layer: ${globalPath} — dispatchable ONLY when the workspace has no pool of its own`,
    ...(otherLines.length > 0
      ? ["Other pools materialized on this host — each NOT dispatchable from this session (open a session in that workspace, or configure the role into this workspace's pool / the global layer):", ...otherLines]
      : []),
    "",
    "You are entering CREW ORCHESTRATION discipline for this session (single subject: do not switch agents). The macro contract above the crew may come from an approved plan, a spec change, or inline text — the discipline is identical in all three cases and never requires a plan. Follow it exactly:",
    "",
    "1. REGISTER: call `crew_begin` with the objective AND the declared subtask plan (subtasks[]: one {title} per subtask, optionally naming the intended forge-* agent). When the macro contract descends from a plan artifact, pass its path as the optional `lineage` argument (e.g. lineage: \".opencode/plan/2026-10-01-my-plan.md\") — the descent is recorded as a first-class line in the crew record header; lineage is never inferred. Reconnaissance BEFORE registration is free (task calls included). If crew_begin refuses (a crew is already active here, or a plan draft is active), STOP and tell the user why — never start a second crew. A wrong plan is fixed by abandoning and re-crewing (crew_close {abandon: true, reason}), never by improvising outside the declared plan.",
    '2. THE PAUSE: registration enters a PENDING crew — execution has NOT started. STOP and present the user the three execution-mode choices (supervised waves now / convert to a goal contract / standby), then END YOUR TURN. Arm per the user\'s choice: waves → crew_begin {execution: "waves"} (waves then auto-advance on session idle until crew_close — the engine stops after a stall, nudge or re-shard); conversion → crew_begin {execution: "goal"} followed by goal_write (arm=true — its dialog is the user\'s gate) folding the declared subtasks into criteria/checks; standby → no call. EXCEPTION: while a live active goal governs this session, register with execution: "waves" in the SAME call — the crew is born armed (the goal contract already authorized orchestration) and crew_close / abandon stay ask-free under that goal.',
    "3. WAVES, NEVER FLOODS (armed crews only): execute subtasks in waves of parallel native `task` calls (subagent_type = the matching forge-* agent; a wave's results return within the calling turn). Launch the next wave ONLY after the previous wave's results are in. GUI / computer-use subtasks are mutually exclusive within a wave (the desktop is a singleton resource — at most ONE in flight; non-GUI subtasks still parallelize freely), and GUI walkthroughs use the `computer` tool rather than DIY shell screenshot pipelines. Native fallback: when the pool offers no forge worker fitting a subtask (or forge-* dispatch is blocked by a degraded pool), dispatch the native general subagent with the same relay contract (artifact path, scoped prompt, evidence demands) and RECORD the fallback (wave notes + the subtask's close evidence says it ran native).",
    "4. CONTRACT RELAY (lineage-descended crews): when the macro contract descends from an on-disk artifact (the lineage names a plan artifact, a spec change directory, or a goal contract), every subtask's dispatch prompt MUST explicitly carry that artifact's path — or the exact slice the subtask works from (a delta file path, a quoted criteria section) — so the dispatched worker reads the contract itself, never your paraphrase of it. A large artifact is relayed by its exact slice; it is NEVER dropped for being too long to inline. Every close-report evidence statement MUST name the contract (or slice) the subtask worked against.",
    "5. MISSING ROLE: when a subtask needs a role no configured forge-* agent matches, run that subtask through a native task call anyway AND tell the user about the gap — suggest configuring the missing role in forge.json.",
    "6. VERIFY: judge each subtask strictly against its acceptance-evidence statement from the task result text. A result that does not meet the statement is a failure even if the worker sounded confident.",
    "7. RETRY AT MOST ONCE: a failed subtask may be retried once with an adjusted prompt or agent. If the retry also fails, record the subtask as FAIL with BOTH failure reports visible (attempts[]). Do not retry twice, do not paper over a failure.",
    "8. CLOSE: when every declared subtask has a verdict, call `crew_close` with the full report (title/verdict/evidence per subtask; attempts[] for FAILs). The gate cross-checks the report against the declared plan — a declared subtask missing from the report refuses the close, and so does an undeclared one. The user confirms the closing dialog (ask-free while a goal governs the session).",
  ].join("\n")
}

const crewBeginTool = tool({
  description:
    'Register this session\'s crew (from /crew) with its DECLARED subtask plan — the crew starts PENDING: the execution-mode choice (waves / convert to goal / standby) is the user\'s. Dual-purpose: called with {execution} ONLY (no objective/subtasks) it ARMS the pending crew — "waves" lifts the dispatch belt, "goal" ends the crew as a conversion record (the following goal_write arm dialog is the user\'s gate). One-call register+arm ({objective, subtasks, execution:"waves"}) is legal ONLY while a live active goal governs the session (born armed, never pends). Refuses: active crew, plan draft, missing/duplicated subtasks, a non-compliant workspace pool file (missing/invalid top-level "pool" namespace — required for crew-governed dispatch). Crew state is in-memory: a host restart ends it honestly.',
  args: {
    objective: tool.schema.string().optional().describe("One-line crew objective (from /crew) — required on registration, ABSENT on the arm call"),
    execution: tool.schema.string().optional().describe('Arm action: "waves" (supervised waves — lifts the belt) or "goal" (convert to a goal contract). Alone = arm the pending crew; with objective+subtasks = one-call born-armed registration, legal only under a governing active goal.'),
    subtasks: tool.schema.array(tool.schema.object({
      title: tool.schema.string().describe("Short unique subtask title — the crew_close report must use these exact titles"),
      agent: tool.schema.string().optional().describe("Intended forge-* agent id for this subtask, when one matches"),
    })).optional().describe("The declared subtask plan (REQUIRED on registration, ABSENT on the arm call) — decompose the objective into these before any execution; crew_close cross-checks the report against exactly this list"),
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
    // initialization gate"): keyed on the SESSION-DOMAIN roster (sole
    // ownership) — the workspace pool when one owns the session's anchor,
    // else the global fallback family; that is what the native task tool
    // may dispatch FROM THIS SESSION. Session-anchored discovery also
    // drives the RESIDUAL mismatch disclosure: a workspace file this host
    // has not materialized is named with its remediation, never masked as
    // plain "unconfigured".
    const resolution = resolvePools()
    // fix-v2-crew-surface-drift task 2.1 (design D1): the roster gate's
    // anchor resolves AUTHORITATIVE-FIRST — the same chain the dispatch
    // belts use (resolveSessionAnchorForPools over the shared anchor
    // client, with its pooled-map preference and ledger-rebind semantics).
    // The tool-context anchor (structural launch-directory source) is ONLY
    // the no-client path, and there it is EXACTLY today's resolution — a
    // pure strict improvement, no new failure mode (the live
    // re-anchored-session incident: session record says the workspace,
    // tool context still says the launch dir, the gate refused while the
    // belt accepted).
    const anchorClient = sharedAnchorClient()
    const anchor =
      anchorClient && typeof anchorClient.session?.get === "function"
        ? (await resolveSessionAnchorForPools(anchorClient, context.sessionID)) || sessionAnchor(context)
        : sessionAnchor(context)
    // Bind the session to its anchor so the dispatch gate scopes this
    // session exactly where the crew guidance says it is.
    if (anchor) ensureSession(context.sessionID, anchor)
    const sessionLoaded = anchor ? loaderForAnchor(anchor).load() : null
    const sessionProject = sessionLoaded?.projectPath ?? null
    const globalPoolPath = forgeConfigPaths({ homeDir: process.env.FORGE_TEST_FORGE_HOME ?? homedir() }).global
    // Sole ownership: the session's dispatchable family = its workspace
    // pool, else the global fallback family.
    const sessionPool = sessionProject
    const sessionFamily =
      resolution?.families.find((f) => foldPath(f.file) === foldPath(sessionPool ?? globalPoolPath)) ?? null
    const sessionCovered = sessionPool === null || sessionFamily !== null
    const sessionRosterIds = sessionFamily ? sessionFamily.materializedIds : []
    if (sessionRosterIds.length === 0) {
      const paths = forgeConfigPaths({ projectDir: anchor || undefined, homeDir: process.env.FORGE_TEST_FORGE_HOME ?? homedir() })
      const lines = [
        `[forge:crew] CREW IS NOT INITIALIZED: no forge subagent is materialized for this session's roster (neither the workspace pool nor the global fallback yields an agent). Crew orchestration is unavailable until the user sets it up.`,
        `Two layers, SOLE OWNERSHIP: the workspace pool — the NEAREST .opencode/forge.json walking up from this session's worktree (${paths.project}) — IS the whole roster when it exists; the global layer (${paths.global}) serves only as the fallback when the workspace has none (a fallback, NOT a merge; forge.json files nested deeper in the workspace subtree are ignored — the same workspace-ownership strictness as opencode's native MCP config).`,
        'Two axes, distinct: POOLS follow workspaces (sole ownership above — dispatch is gated to the session\'s own pool / the global fallback); SESSION ARTIFACTS (plan/goal/crew records) follow the session. A forge.json in another workspace is not dispatchable from this session.',
        'Template (JSONC): the top-level "pool" field names this file\'s namespace (short stable [a-z0-9-] up to 24 chars — REQUIRED for crew-governed dispatch; every pool materializes as forge-<ns>-<id>, the global fallback materializes as forge-global-<id>); {"pool": "short-stable-namespace", "agents": {"research": {"model": "provider/model", "thoughtLevel": "low", "shape": "readonly", "prompt": "short role description"}}} — an absent shape defaults to WRITE (open permissions); "shape": "readonly" is the explicit seal denying write/edit/bash + the patch family for read-only roles.',
        "Agent ids are plain role words WITHOUT the `forge-` prefix — every pool materializes as `forge-<ns>-<id>` under its `pool` namespace (the global fallback materializes as `forge-global-<id>`); a prefixed id is auto-stripped with a warning.",
        "The user may configure it themselves, or ask you to write the file — only on their explicit go-ahead. When you write it: give every agent a SHORT prompt from the role the user asked for (one or two sentences; long only on explicit request), give every agent an EXPLICIT shape (readonly for read-only roles like reviewer/scout/planner; write for implementers and build drivers), and INCLUDE the top-level `pool` namespace — it is REQUIRED for crew-governed dispatch (the compliance gate refuses a missing or invalid field) and keeps ids stable across directory renames. File edits, creations, and deletions apply at the next config hook — no host restart needed, and a DELETED pool file un-materializes its agents (deletion is real).",
        "Levers: the user can also run /forge init (draft this workspace's forge.json in-band, refuse-and-review when one exists) or /forge init global (draft the global layer, built-in override entries shipped commented out) — the explicit one-command starters for exactly this setup.",
      ]
      if (sessionLoaded && Object.keys(sessionLoaded.agents).length > 0 && sessionProject && !sessionCovered) {
        lines.push(
          `NOTE: this session's workspace DOES have a forge.json (${sessionProject}) with usable agents — but this host has NOT materialized it (no initialization in that workspace). Re-initialize the host in that workspace, or move the agents into the global layer (${globalPoolPath}).`,
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
            `[forge:crew] Relay: the goal loop owns this plan from here — its continuation turns may re-register it as a BORN-ARMED crew in ONE call (crew_begin {objective, subtasks, execution: "waves"} — no pause mid-loop); the arming dialog already authorized this orchestration.`,
            "Preserve the subtask STRUCTURE inside the goal contract (criteria or constraints) — keep the declared titles and their forge-* agent assignments verbatim enough to re-register; do not dissolve them into prose.",
            "Born-armed registration sketch to adapt: crew_begin {objective: <this objective>, subtasks: [the declared subtasks with their agents], execution: \"waves\"}.",
          ].join("\n"),
        }
      }
      crew.mode = "executing"
      appendCrewRecord(crew.recordPath, "armed (waves)", ["The user chose supervised waves; the dispatch belt is lifted."])
      return {
        title: `crew armed: ${crew.objective.slice(0, 60)}`,
        output: [
          `[forge:crew] Crew ARMED for supervised waves: ${crew.objective}`,
          `Waves auto-advance on session idle until crew_close (the engine stops after a stall — nudge or re-shard).`,
          `Declared plan (${crew.subtasks.length}):`,
          ...crew.subtasks.map((s, i) => `  ${i + 1}. ${s.title}${s.agent ? ` → ${s.agent}` : ""}`),
          "Proceed with the wave discipline: waves of parallel native task calls (next wave after the previous results) → per-subtask evidence verdicts → at most one retry → crew_close with the full report covering every declared subtask.",
          CREW_NATIVE_FALLBACK_RULE,
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
    // Pool-compliance pre-flight (change pool-namespace-contract, spec:
    // crew-harness — "Crew-governed dispatch pool-compliance gate"): a
    // session whose roster comes from a workspace pool file REFUSES
    // registration outright (no crew record, no PENDING crew) until that
    // file declares a valid top-level `pool` namespace. Global-fallback
    // sessions (no workspace pool) are exempt; per-agent fail-soft
    // findings never enter the file-level predicate; an unobservable
    // anchor keeps the existing fail-open posture.
    if (anchor) {
      const complianceRefusal = crewPoolComplianceRefusal(anchor)
      if (complianceRefusal) throw new Error(complianceRefusal)
    }
    // Native-roster staleness gate (change native-first-roster, design
    // D4): on a native-mode host (v2 default), registration refuses while
    // the session's compiled artifacts are stale — same gate posture as
    // the compliance pre-flight, one-step in-band recovery via forge_sync.
    // v1 hosts and the runtime escape hatch never trip it (no artifacts
    // exist to be stale — byte-equal behavior).
    if (nativeRosterActive()) {
      const staleRefusal = rosterStaleRefusal(anchor)
      if (staleRefusal) throw new Error(staleRefusal)
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
    // Fresh registration clears the crew engine's stall marker and counters
    // (crew-autonomous-waves D3): a stalled PRIOR crew never silences a new
    // one's idle continuation.
    crewEngineForgetSession(context.sessionID)
    crews.set(context.sessionID, { objective: objectiveText, startedAt: nowIso(), subtasks, mode: governed ? "executing" : "pending", recordPath })
    appendCrewRecord(recordPath, governed ? "registered (born armed under a governing goal)" : "registered (pending)", subtasks.map((s, i) => `${i + 1}. ${s.title}${s.agent ? ` → ${s.agent}` : ""}`))
    // Residual workspace-mismatch disclosure (sole-pool-ownership): the
    // session's own discovery found a forge.json this host has NOT
    // materialized (no initialization in that workspace) — its roles are
    // not dispatchable from this session; say so with the remediation
    // instead of letting the crew discover it by failure.
    let disclosure = ""
    if (sessionProject && !sessionCovered) {
      const localOnly = Object.keys(sessionLoaded?.agents ?? {})
      if (localOnly.length > 0) {
        disclosure = `\n[forge:crew] NOTE: this session's workspace has its own forge.json (${sessionProject}) defining ${localOnly.map((id) => `forge-<ns>-${id} (namespaced by its pool)`).join(", ")} — NOT dispatchable from this session (this host has not materialized that file). Re-initialize the host in that workspace, or move the agents into the global layer (${globalPoolPath}).`
      }
    }
    // Session-scoped roster disclosure (sole-pool-ownership): lead with THIS
    // session's dispatchable roster and its forge.json origin (workspace
    // pool, or the global layer marked as fallback when the workspace has
    // none); every other host pool follows, each marked NOT dispatchable
    // from this session with its origin path. Bounded at 8 pools; the
    // remainder are counted, not listed.
    const families = resolution?.families ?? []
    const familyLines: string[] = []
    if (sessionFamily) {
      familyLines.push(
        `   - DISPATCHABLE from this session — ${sessionPool ? "workspace pool" : "global fallback"}: ${sessionFamily.file} — ${sessionFamily.materializedIds.map((id) => `forge-${id}`).join(", ") || "no agents"}`,
      )
    }
    for (const f of families.slice(0, 8)) {
      if (f === sessionFamily) continue
      const label = `pool ${f.ns} (forge-${f.ns}-*)`
      familyLines.push(`   - NOT dispatchable from this session — ${label}: ${f.file} — ${f.materializedIds.map((id) => `forge-${id}`).join(", ") || "no agents"}`)
    }
    if (families.length > 8) familyLines.push(`   - …and ${families.length - 8} more pools`)
    // plan-supersession-and-lineage 4.1: the crew record path LEADS the
    // output — first block, before the objective summary and the declared
    // plan (the plan tools' "Plan created:" prominence); the roster-origin
    // disclosure follows the declared plan.
    const lines = [
      ...(recordNote ? [recordNote] : []),
      ...(lineage
        ? [
            `Lineage: ${lineage}`,
            // crew-contract-relay task 2: remind the orchestrating AI of the
            // relay rule whenever lineage is present — the discipline rides
            // on dispatch prompts, not on this line alone.
            `RELAY RULE: this crew descends from ${lineage} — every dispatch prompt must explicitly carry the artifact path (or its exact slice), and every close-report evidence statement must name the contract it worked against.`,
          ]
        : []),
      governed
        ? `[forge:crew] Crew registered UNDER THE GOVERNING GOAL — born armed, never pends. Objective: ${objectiveText}`
        : `[forge:crew] Crew registered PENDING for this session (execution has NOT started). Objective: ${objectiveText}`,
      `Declared plan (${subtasks.length}):`,
      ...subtasks.map((s, i) => `  ${i + 1}. ${s.title}${s.agent ? ` → ${s.agent}` : ""}`),
      `Session roster origins — sole ownership (dispatch gated to this session's workspace pool / the global fallback); ${families.length} pool${families.length === 1 ? "" : "s"} materialized on this host:`,
      ...familyLines,
      ...(disclosure ? [disclosure] : []),
    ]
    if (governed) {
      lines.push(
        "Goal-delegated orchestration: the governing goal contract already authorized this crew — run the wave discipline NOW (crew gates stay internal to the loop; crew_close and abandon are ask-free under this goal), and re-shard via crew_close {abandon: true, reason} + a fresh one-call crew_begin when the decomposition proves wrong.",
        "This crew is driven by the goal engine's own continuations (no separate crew briefs); standalone waves auto-advance on session idle until crew_close (the engine stops after a stall — nudge or re-shard).",
        "Wave discipline: waves of parallel native task calls (next wave after the previous results) → per-subtask evidence verdicts → at most one retry → crew_close with the full report covering every declared subtask.",
        CREW_NATIVE_FALLBACK_RULE,
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

// forge_sync (native-first-roster design D2/D4): compile the recipe into
// native agent files — in-band (the forge agent calls it; every effect is
// transcript-visible), atomic (temp+rename), with GC and full diff
// disclosure. Registered on BOTH host generations (v1 tool getter + v2
// tool domain through the same forgeTools() factory); it only ever WRITES
// when invoked — absent sync:"auto" the plugin never writes uninvited.
const forgeSyncTool = tool({
  description:
    "Compile the forge.json recipe(s) this host can see into native agent files (.opencode/agent/forge-<ns>-<id>.md): mode:subagent stamped, pinned model with variant where the depth word maps, the shape's tools face, and the dispatch mandates baked into the prompt. Writes are atomic; entries that left the recipe are garbage-collected; the output discloses every created/updated/GC'd file. The host hot-applies without a restart. Call it after ANY recipe edit (the crew gate refuses registration against stale artifacts), or when a dispatch reports a missing forge worker on a native-mode host.",
  args: {},
  execute: async (_args, context) => {
    noteToolAgent(context)
    const { lines, errorCount } = runRosterSync()
    return {
      title: errorCount > 0 ? "forge sync: completed with errors" : "forge sync: roster compiled",
      output: lines.join("\n"),
    }
  },
})

function forgeTools(): Record<string, ToolDefinition> {
  const tools: Record<string, ToolDefinition> = {
    plan_write: planWriteTool,
    plan_tick: planTickTool,
    plan_approve: planApproveTool,
    plan_close: planCloseTool,
    plan_reopen: planReopenTool,
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
  // Search pair (forge-search-tools D6): registered unconditionally — it is
  // not part of the job supervisor (no retirement) and carries no ask-gate.
  tools.forge_grep = forgeGrepTool
  tools.forge_glob = forgeGlobTool
  if (!forgeDisabled) {
    tools.crew_begin = crewBeginTool
    tools.crew_close = crewCloseTool
    // native-first-roster: the in-band roster sync tool (both host
    // generations register it through this one factory).
    tools.forge_sync = forgeSyncTool
    // task (change task-shadow): the SDK dispatch engine shadows the native
    // task tool under its own NAME — the TUI keys its live subagent panel on
    // `task` (OMO-proven on this stack). Removed with the whole family under
    // the disable knob (the native task tool returns). forge_dispatch is
    // RETIRED: this is the single dispatch surface.
    tools.task = taskDispatchTool
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
      appendFileSync(join(probeTmp(), "forge-goal-probe.log"), `${new Date().toISOString()} ${line}\n`)
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

// ---------------------------------------------------------------------------
// Crew continuation engine state (change crew-autonomous-waves). Deliberately
// SEPARATE counters (D3/D6): reusing the goal engine's turnActivity would
// silently weaken the goal no-progress guard's semantics for goal sessions,
// and task dispatches count as crew activity here (waves ARE the work). The
// goal engine's counters/ledger files are never read or written by the crew
// branch. All in-memory — no disk state.
// ---------------------------------------------------------------------------

// Matches the goal engine's NO_PROGRESS_LIMIT (design D3: adopt 3).
const CREW_NO_PROGRESS_LIMIT = 3

// Marks the turn the CREW engine itself started (analog of
// pendingContinuationTurn — only crew-continuation turns are evaluated).
const crewPendingTurn = new Set<string>()
// Per-crew-continuation-turn activity: task dispatches + write-family calls.
const crewTurnActivity = new Map<string, { dispatches: number; writes: number }>()
// Consecutive activity-free crew continuation turns.
const crewNoProgress = new Map<string, number>()
// Sessions whose crew registration the engine stopped continuing (stall or
// transport-failure cap). Cleared on fresh crew_begin registration.
const crewStalled = new Set<string>()

function crewEngineForgetSession(sessionID: string): void {
  crewPendingTurn.delete(sessionID)
  crewTurnActivity.delete(sessionID)
  crewNoProgress.delete(sessionID)
  crewStalled.delete(sessionID)
  // crew-continue-native-child-gate 2.6: gate state dies with the crew
  // registration (tracker rows, ceiling marker, pending digest, the walked
  // watch set and any armed suppression re-check) — zero disk state. Reached
  // from fresh crew_begin, session.deleted harvest, and the session-end
  // evictions.
  crewNativeChildren.forgetParent(sessionID)
  crewNativeCeiling.delete(sessionID)
  crewChildDigest.delete(sessionID)
  crewNativeWatch.delete(sessionID)
  crewStopNativeRecheck(sessionID)
}

// ---------------------------------------------------------------------------
// Native-child gate (change crew-continue-native-child-gate, design D2-D4):
// host-native subagents (task/subagent channel) are invisible to the crew
// engine's own registry — the gate suppresses the idle continuation while a
// native child of the orchestrator session is in flight. The WALK
// (walkNativeChildren, pure core in src/native-child-gate.ts) is
// authoritative; the tracker below is the ADVISORY warm set fed by the
// existing v2SubscribeEvents loop. All state in-memory.
// ---------------------------------------------------------------------------

// Bounded ceiling (D4): first suppression timestamp per registration; past
// FORGE_CREW_NATIVE_CHILD_CEILING_MS the engine sends once, discloses one
// bounded console.warn, and stops suppressing for this registration.
const CREW_NATIVE_CHILD_CEILING_MS = Number(process.env.FORGE_CREW_NATIVE_CHILD_CEILING_MS ?? 900_000)
// Short debounce for the last-child-terminal re-arm (D3 resume edge) —
// shorter than the idle debounce: a deferral never depends on a further
// idle event to resume.
const CREW_CHILD_RESUME_DEBOUNCE_MS = Number(process.env.FORGE_CREW_CHILD_RESUME_DEBOUNCE_MS ?? 500)

const crewNativeChildren = createNativeChildTracker()
const crewNativeCeiling = new Map<string, { firstSuppressedAt: number; disclosed: boolean }>()
// D7 defect-B: digest lines (one per terminal child: id + outcome) awaiting
// the next crew continuation brief — an interrupted child is disclosed as
// dead the moment the plugin knows, riding the re-armed brief.
const crewChildDigest = new Map<string, string[]>()

// Clock seam (ceiling tests advance time without waiting).
let crewGateNow: () => number = () => Date.now()

/** Test seam: inject the gate clock (null restores Date.now). */
export function setCrewNativeChildClockForTests(now: (() => number) | null): void {
  crewGateNow = typeof now === "function" ? now : () => Date.now()
}

// ---------------------------------------------------------------------------
// D8 — walk-authoritative outcomes + suppression re-check (sandbox E2E
// finding #2, 2026-11-23). The event-fed tracker CANNOT be the digest's
// source: a fresh crew_begin wipes the parent's tracker rows
// (crewEngineForgetSession above), so a child created BEFORE the crew was
// armed — the overnight "stall, re-open the crew, children still running"
// case — is unknown to the tracker when its terminal edge arrives
// (terminalize ⇒ null ⇒ no digest; live-verified: the first post-terminal
// brief carried no outcome line). The event stream is volatile by contract
// on top of that. So the WALK is the single authority: a child is waited on
// from the moment the decision-time walk sees it in flight, and its outcome
// is read off its own session row (live 2.3.2 rows carry outcome
// succeeded / failed / interrupted). The tracker stays what it was — an
// advisory accelerator.
// ---------------------------------------------------------------------------

// Children this crew registration's gate is WAITING ON, keyed by child id.
// Enters on a walk that saw it in flight; leaves when its outcome line has
// ridden a brief (or with the registration).
const crewNativeWatch = new Map<string, Set<string>>()

function crewWatchChild(sessionID: string, childID: string): void {
  if (!sessionID || !childID) return
  let watched = crewNativeWatch.get(sessionID)
  if (!watched) {
    watched = new Set()
    crewNativeWatch.set(sessionID, watched)
  }
  watched.add(childID)
}

/** The registration still waiting on this child, if any (reverse lookup — few entries). */
function crewNativeWatchParentOf(childID: string): string | null {
  for (const [sessionID, watched] of crewNativeWatch) if (watched.has(childID)) return sessionID
  return null
}

/**
 * Terminal-edge consequence for a child the gate waited on: queue the digest
 * line for the next crew brief and, when nothing is waited on any more,
 * re-arm scheduleIdleContinuation with the short debounce. Advisory only:
 * the re-armed pass re-runs the full guard chain (the walk re-anchors truth
 * at the decision moment).
 */
function crewReportNativeChildTerminal(sessionID: string, childID: string, outcome: NativeChildOutcome | null, client: GoalClient | null): void {
  const watched = crewNativeWatch.get(sessionID)
  // First report wins: a child leaves the set the moment its line is queued,
  // so a terminal event and the walk never name one child twice — and a
  // child the gate never held on is never named at all (its report reached
  // the parent through the host's own wake).
  if (!watched || !watched.delete(childID)) return
  const lines = crewChildDigest.get(sessionID) ?? []
  lines.push(nativeChildDigestLine(childID, outcome))
  crewChildDigest.set(sessionID, lines)
  goalProbe(`crew native child settled child=${childID} outcome=${outcome ?? "unknown"} parent=${sessionID} stillWaiting=${watched.size}`)
  if (watched.size > 0) return // other children still held
  crewStopNativeRecheck(sessionID)
  if (client) {
    // D3 resume edge: never depend on a further idle event to resume.
    scheduleIdleContinuation(client, sessionID, CREW_CHILD_RESUME_DEBOUNCE_MS)
  }
}

/**
 * After EVERY walk (decision point and suppression re-check alike): the
 * children the walk sees in flight are what this registration waits on;
 * every waited-on child the walk no longer sees in flight has settled — its
 * outcome is its own row's. An unreadable view observes nothing: unknown is
 * never "settled".
 */
function crewObserveNativeWalk(sessionID: string, view: NativeChildWalkView): void {
  if (!view.readable) return
  const busy = new Set(view.inFlight)
  for (const childID of view.inFlight) crewWatchChild(sessionID, childID)
  const watched = crewNativeWatch.get(sessionID)
  if (!watched || watched.size === 0) return
  const outcomes = new Map(view.settled.map((row) => [row.childID, row.outcome]))
  for (const childID of [...watched]) {
    if (busy.has(childID)) continue
    // Absent from the scoped list altogether (deleted mid-run) ⇒ no row ⇒ no outcome.
    crewReportNativeChildTerminal(sessionID, childID, outcomes.get(childID) ?? null, null)
  }
}

// D8 suppression re-check: while the gate holds a crew on native children, a
// bounded timer re-walks the view, so the resume never depends on a host
// idle edge or on a volatile event reaching the plugin — a child deleted
// mid-run may leave the parent with no idle edge at all, and a subscription
// gap can swallow the one that comes. It only SCHEDULES the shared
// continuation: the full guard chain (walk, ceiling, busy re-check,
// no-progress accounting) re-runs at the decision point.
const CREW_NATIVE_CHILD_RECHECK_MS = Number(process.env.FORGE_CREW_NATIVE_CHILD_RECHECK_MS ?? 5_000)
const crewNativeRecheck = new Map<string, { timer: ReturnType<typeof setTimeout>; client: GoalClient | null }>()

function crewArmNativeRecheck(sessionID: string, client: GoalClient | null): void {
  if (crewNativeRecheck.has(sessionID)) return
  if (!Number.isFinite(CREW_NATIVE_CHILD_RECHECK_MS) || CREW_NATIVE_CHILD_RECHECK_MS <= 0) return
  const timer = setTimeout(() => {
    crewNativeRecheck.delete(sessionID)
    void crewNativeRecheckTick(sessionID, client)
  }, CREW_NATIVE_CHILD_RECHECK_MS)
  if (typeof (timer as { unref?: () => void }).unref === "function") (timer as { unref?: () => void }).unref?.() // never holds the host open
  crewNativeRecheck.set(sessionID, { timer, client })
}

function crewStopNativeRecheck(sessionID: string): void {
  const armed = crewNativeRecheck.get(sessionID)
  if (armed) clearTimeout(armed.timer)
  crewNativeRecheck.delete(sessionID)
}

/** One suppression re-check (exported through v2WiringSeam as the deterministic test seam). */
async function crewNativeRecheckTick(sessionID: string, client: GoalClient | null): Promise<void> {
  try {
    const crew = crews.get(sessionID)
    if (!client || !crew || crew.mode !== "executing" || crewStalled.has(sessionID)) return
    // A decision is already pending or running: it re-arms this timer itself
    // when the crew is still held.
    if (continuationInFlight.has(sessionID) || idleTimers.has(sessionID)) return
    const view = await walkNativeChildren(nativeChildWalkerOf(client), sessionID)
    crewObserveNativeWalk(sessionID, view)
    if (!view.readable) {
      crewArmNativeRecheck(sessionID, client) // nothing learned: look again
      return
    }
    const mark = crewNativeCeiling.get(sessionID)
    const expired = mark !== undefined && crewGateNow() - mark.firstSuppressedAt >= CREW_NATIVE_CHILD_CEILING_MS
    if (view.inFlight.length > 0 && !expired) {
      crewArmNativeRecheck(sessionID, client) // still held: look again
      return
    }
    goalProbe(`crew native-child recheck clear session=${sessionID} inFlight=${view.inFlight.length} ceiling=${expired ? "expired" : "none"}`)
    scheduleIdleContinuation(client, sessionID, CREW_CHILD_RESUME_DEBOUNCE_MS)
  } catch {
    // Advisory: never a throw into the host.
  }
}

/** The gate's host view for this client: a v2 adapter's dedicated HTTP walker, else the client itself. */
function nativeChildWalkerOf(client: GoalClient): NativeChildClient {
  return (client as unknown as { nativeChildWalker?: NativeChildClient }).nativeChildWalker ?? (client as unknown as NativeChildClient)
}

/**
 * Task 2.3 — the tracker feed, called from the EXISTING v2SubscribeEvents
 * loop (no new subscription, no new stream). Classifies the event against
 * the tracker semantics: session.created with a parentID marks a child;
 * the durable execution-terminal edges terminalize WITH the outcome;
 * session.status idle / session.idle (tolerated alias, not emitted on
 * 2.3.2) terminalize as quiescent; session.deleted drops the child row.
 * Exported for the stub-client test wave.
 */
export function noteCrewNativeChildEvent(type: string, fields: Record<string, unknown>, client: GoalClient | null): void {
  try {
    if (type === "session.created") {
      const info = (fields.info ?? (fields as { session?: unknown }).session) as { id?: unknown; parentID?: unknown } | undefined
      const id = info !== null && typeof info === "object" && typeof info.id === "string" && info.id ? info.id : v2PickStr(fields, "sessionID", "sessionId")
      const parentID = info !== null && typeof info === "object" && typeof info.parentID === "string" && info.parentID ? info.parentID : v2PickStr(fields, "parentID", "parentId")
      if (id && parentID) crewNativeChildren.mark(id, parentID)
      return
    }
    if (type === "session.deleted") {
      const info = fields.info as { id?: unknown } | undefined
      const id = info !== null && typeof info === "object" && typeof info.id === "string" && info.id ? info.id : v2PickStr(fields, "sessionID", "sessionId")
      if (!id) return
      crewNativeChildren.drop(id)
      // D8: a waited-on child deleted mid-run emits no terminal edge — name
      // it gone the moment the plugin knows (no row ⇒ no outcome).
      const watchedBy = crewNativeWatchParentOf(id)
      if (watchedBy) crewReportNativeChildTerminal(watchedBy, id, null, client)
      return
    }
    const outcome = nativeChildEventOutcome(type)
    if (outcome) {
      const id = v2PickStr(fields, "sessionID", "sessionId")
      if (!id) return
      // D8: the tracker knows the parent only for a child it saw created
      // after the registration; the walk's watch set covers the rest.
      const note = crewNativeChildren.terminalize(id, outcome)
      const parentID = note?.parentID ?? crewNativeWatchParentOf(id)
      if (parentID) crewReportNativeChildTerminal(parentID, id, outcome, client)
      return
    }
    if (type === "session.status" || type === "session.idle") {
      // Idle edges: session.idle is the schema-present tolerated alias
      // (NOT emitted on 2.3.2); session.status carrying type "idle"
      // terminalizes the child as quiescent (recorded "succeeded" — the
      // honest outcome for an idle edge; the walk remains authoritative).
      const id = v2PickStr(fields, "sessionID", "sessionId")
      if (!id) return
      const st = fields.status
      const idle = type === "session.idle" || (st !== null && typeof st === "object" && (st as { type?: unknown }).type === "idle")
      if (!idle) return
      const note = crewNativeChildren.terminalize(id, "succeeded")
      const parentID = note?.parentID ?? crewNativeWatchParentOf(id)
      if (parentID) crewReportNativeChildTerminal(parentID, id, "succeeded", client)
    }
  } catch {
    // Advisory warm set: never a throw into the host.
  }
}

// D2: the crew continuation brief. Subtask titles come from the in-memory
// CrewEntry.subtasks — the close gate's own source, so the brief can never
// drift from what crew_close will demand. The native-child digest (D7
// defect-B) rides the brief as one line per terminal child (id + outcome)
// when the gate collected outcomes during a suppression episode.
function crewContinueBrief(crew: CrewEntry, childDigest: ReadonlyArray<string> = []): string {
  return [
    `[forge:crew-continue] The crew "${crew.objective}" is armed (waves) — continue the wave discipline.`,
    `Declared plan (every subtask needs a verdict at close):`,
    ...crew.subtasks.map((s, i) => `${i + 1}. ${s.title}`),
    ...(childDigest.length > 0
      ? [`Native child outcomes since the last brief (one line per child — an interrupted child is DEAD, never silently stranded):`, ...childDigest.map((l) => `- ${l}`)]
      : []),
    `Next: dispatch the next wave (parallel task calls — forge-* workers from this session's pool, or the native general subagent when no forge worker fits), collect per-subtask evidence verdicts, at most one retry per subtask, then crew_close with the full report. Stalled or wrong decomposition? crew_close {abandon: true, reason} to re-shard.`,
  ].join("\n")
}

// Crew branch of the idle-continuation engine (crew-autonomous-waves D1):
// reached ONLY when no live active goal owns the session (goal-governed
// sessions belong to the goal engine exclusively). Reuses the goal engine's
// send-time family re-check, idle busy re-check, and the shared
// transportFails map + cap; never touches goal ledger files or goal
// accounting. Called inside continueIfEligible's in-flight claim.
async function continueCrewIfEligible(client: GoalClient, state: SessionState, sessionID: string): Promise<void> {
  const crew = crews.get(sessionID)
  // PENDING crews are the user's execution-mode decision seam — NEVER
  // auto-continued; ended crews (close/abandon/convert) were evicted from
  // the map, so this finds nothing and the engine stays silent.
  if (!crew || crew.mode !== "executing") {
    goalProbe(`crew skip: no executing crew session=${sessionID}`)
    return
  }
  // Stalled (or transport-capped) for this registration: the engine never
  // briefs again until a fresh crew_begin clears the marker.
  if (crewStalled.has(sessionID)) {
    goalProbe(`crew skip: stalled session=${sessionID}`)
    return
  }
  // Send-time family re-check (tool-partition): the speaker may have
  // switched agents between scheduling and this send — the family gate
  // holds for the crew branch exactly as for the goal branch.
  if (!sessionIsForgeFamily(sessionID)) {
    goalProbe(`crew skip: agent switched to non-forge before send session=${sessionID}`)
    return
  }
  // Native-child gate (crew-continue-native-child-gate D2/D4/D5): the
  // decision-time walk is authoritative — ANY non-idle/non-terminal
  // host-native child of this session suppresses the nudge. Fail-OPEN:
  // an unreadable view is "no children in flight" (a false in-flight
  // strands the crew; a false idle costs one redundant brief). Hooked
  // BEFORE the crew no-progress accounting: a suppressed nudge is not a
  // turn (no streak, no transport-failure count, no ledger effect).
  // Capability path (4.2 sandbox E2E finding): a v2 adapter carries its
  // DEDICATED HTTP walker — the promise-layer session domain has no
  // list/status, so walking the bare adapter is a structural no-op. v1
  // clients (and stubs) without the property fall through to themselves.
  const walker = nativeChildWalkerOf(client)
  const view = await walkNativeChildren(walker, sessionID)
  // D8: one walk feeds both the gate and the outcome digest — children seen
  // in flight are what this registration waits on; waited-on children the
  // walk no longer sees in flight are named with their row's outcome.
  crewObserveNativeWalk(sessionID, view)
  if (view.inFlight.length > 0) {
    const now = crewGateNow()
    const mark = crewNativeCeiling.get(sessionID)
    if (mark && mark.disclosed) {
      // Past the ceiling for this registration: suppression already
      // stopped — fall through and send.
      goalProbe(`crew native-child ceiling already disclosed session=${sessionID}`)
    } else if (mark && now - mark.firstSuppressedAt >= CREW_NATIVE_CHILD_CEILING_MS) {
      // D4: send ONCE + one bounded disclosure; stop suppressing for this
      // registration (a listed-but-silent child no longer blocks).
      crewNativeCeiling.set(sessionID, { firstSuppressedAt: mark.firstSuppressedAt, disclosed: true })
      console.warn(
        `[forge:crew-continue] native-child ceiling: crew "${crew.objective.slice(0, 80)}" has been held ≥${CREW_NATIVE_CHILD_CEILING_MS}ms by native children that never report a terminal state — sending once and stopping suppression for this registration (fresh crew_begin re-arms the gate).`,
      )
      goalProbe(`crew native-child ceiling expired session=${sessionID}`)
    } else {
      if (!mark) crewNativeCeiling.set(sessionID, { firstSuppressedAt: now, disclosed: false })
      // D8: the resume must not depend on a further idle edge or event.
      crewArmNativeRecheck(sessionID, client)
      goalProbe(`crew skip: native child in flight session=${sessionID}`)
      return // BEFORE crewPendingTurn accounting — not a turn
    }
  } else {
    // Gate open: the suppression episode ends (a later busy child starts a
    // fresh, fully-ceilinged episode).
    crewNativeCeiling.delete(sessionID)
  }
  // Crew no-progress accounting (D3), only for turns the crew engine itself
  // started: task dispatches and write-family calls count as activity.
  if (crewPendingTurn.has(sessionID)) {
    crewPendingTurn.delete(sessionID)
    const act = crewTurnActivity.get(sessionID)
    if (act && (act.dispatches > 0 || act.writes > 0)) {
      crewNoProgress.delete(sessionID)
    } else {
      const n = (crewNoProgress.get(sessionID) ?? 0) + 1
      crewNoProgress.set(sessionID, n)
      goalProbe(`crew no-progress session=${sessionID} streak=${n}`)
      if (n >= CREW_NO_PROGRESS_LIMIT) {
        // D6: disclose and stop — never auto-abandon, never auto-close. The
        // crew itself stays registered; the user stays in charge.
        crewStalled.add(sessionID)
        crewTurnActivity.delete(sessionID)
        console.warn(
          `[forge:crew-continue] stalled: crew "${crew.objective.slice(0, 80)}" produced ${n} activity-free continuation turns — the engine stops continuing it (the crew stays registered; nudge the session, crew_close the report, or crew_close {abandon: true, reason} to re-shard).`,
        )
        return
      }
    }
  }
  // Idle re-check: the user may have resumed the conversation first.
  if (typeof client.session.status === "function") {
    try {
      const st = (await client.session.status({ path: { id: sessionID } })) as Record<string, { type?: string }> | undefined
      const t = st?.[sessionID]?.type
      if (t && t !== "idle") {
        goalProbe(`crew skip: session busy again session=${sessionID} status=${t}`)
        return
      }
    } catch (err) {
      goalProbe(`crew skip: status check failed session=${sessionID} err=${String(err)}`)
      return
    }
  } else {
    // D8 (sandbox E2E finding #3): the production v2 adapter carries no
    // session.status, so the re-check above NEVER ran on live v2 hosts — and
    // the terminal re-arm / suppression re-check schedule continuations
    // OUTSIDE an idle edge, where "the user resumed first" is most likely.
    // The dedicated walker reads the same active map the gate walks (live
    // 2.3.2, three measured turns: an idle parent is already absent from the
    // map when session.execution.succeeded lands). Unreadable ⇒ exactly the
    // behavior this adapter had before (send).
    const busy = await nativeSessionBusy(walker, sessionID)
    if (busy === true) {
      goalProbe(`crew skip: session busy again session=${sessionID} status=active`)
      return
    }
  }
  try {
    // D7 defect-B: the digest collected during the suppression episode rides
    // this brief (one line per terminal child: id + outcome); cleared only
    // on successful delivery.
    const childDigest = crewChildDigest.get(sessionID) ?? []
    await client.session.prompt({
      path: { id: sessionID },
      body: { parts: [{ type: "text", text: crewContinueBrief(crew, childDigest) }] },
    })
    if (childDigest.length > 0) crewChildDigest.delete(sessionID)
    // D8: the episode ended with a delivered brief — a later busy child
    // starts a fresh, fully-ceilinged episode with its own re-check.
    crewStopNativeRecheck(sessionID)
    transportFails.delete(sessionID)
    crewPendingTurn.add(sessionID)
    crewTurnActivity.set(sessionID, { dispatches: 0, writes: 0 })
    goalProbe(`crew continued session=${sessionID} objective="${crew.objective.slice(0, 60)}"`)
  } catch (err) {
    // Shared transport-failure map + cap (D1): repeated delivery failures
    // stop the crew engine too — bounded and disclosed, crew untouched.
    const n = (transportFails.get(sessionID) ?? 0) + 1
    transportFails.set(sessionID, n)
    goalProbe(`crew transport failure session=${sessionID} count=${n} err=${String(err)}`)
    if (n >= TRANSPORT_FAILURE_LIMIT) {
      crewStalled.add(sessionID)
      crewPendingTurn.delete(sessionID)
      crewTurnActivity.delete(sessionID)
      console.warn(
        `[forge:crew-continue] stopped: ${n} consecutive delivery failures for crew "${crew.objective.slice(0, 80)}" — the engine stops continuing it (the crew stays registered; nudge the session or crew_close when back).`,
      )
    }
  }
}

function goalBriefText(state: SessionState, goal: ActiveGoal): string {
  const d = goal.doc
  const structureText = [...d.criteria, d.constraints.trim()].filter(Boolean).join("\n")
  const structured = /\bforge-[a-z0-9-]+\b/.test(structureText) || /^\s*\d+[.).]/m.test(structureText)
  const crewLayerBase = `Crew layer: you own it under this goal — when parallel decomposition serves a criterion, register crews with crew_begin {objective, subtasks, execution: "waves"} in ONE call (born armed; no pause mid-loop), dispatch forge-* waves, and re-shard a wrong decomposition via crew_close {abandon: true, reason} plus a fresh registration. Crew gates stay internal to this loop (your goal turns drive the crew — no separate crew idle briefs fire under this goal; standalone waves auto-advance on session idle until crew_close).`
  const crewLayerLine = structured
    ? `${crewLayerBase} The contract carries a subtask structure — PREFER re-registering it as a born-armed crew (one call, execution: "waves") over self-executing the whole plan in this session; drive the crew through your goal turns and keep per-subtask evidence for the close report.`
    : crewLayerBase
  return [
    `[forge:goal-continue] Continue the active goal (revision ${d.revision}): ${d.goal}`,
    `Success criteria:\n${d.criteria.map((c, i) => `${i + 1}. ${c}`).join("\n")}`,
    `Verification items (the plugin runs these itself; never fake their output):\n${d.checks
      .map((c, i) => `${i + 1}. ${c.kind === "shell" ? `shell \`${c.cmd}\`` : `contains \`${c.file}\` :: \`${c.text}\``}`)
      .join("\n")}`,
    d.constraints.trim() ? `Constraints: ${d.constraints.trim()}` : "",
    `Per-turn discipline: land at least one verification command (forge_shell) or a real write every turn — the Turn Ledger scores read-only turns as no-progress, and consecutive no-progress turns auto-pause the loop (goal-no-progress-honesty: re-running the checks IS progress).`,
    `Budget: ${d.turnsUsed}/${d.maxTurns} turns used. Work the criteria now; call goal_check when you believe they hold, then goal_complete (it re-runs every check itself and asks the user). If genuinely blocked, call goal_pause with the blocker — do not spin.`,
    crewLayerLine,
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
        // V2 session info carries the directory under `location.directory`
        // (live probe: {"location":{"directory":"..."}}); v1 had it flat.
        const info = (await client.session.get({ path: { id: sessionID } })) as
          | { directory?: string; worktree?: string; location?: { directory?: string } }
          | undefined
        const wt = effectiveWorktree(info?.worktree, info?.directory ?? info?.location?.directory)
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
    // Crew branch (crew-autonomous-waves D1): the goal path owns the session
    // ONLY when a live ACTIVE goal is owned by it — every other case (no
    // goal, non-active, or owned elsewhere) falls to the crew branch, which
    // sends a crew continuation ONLY for a waves-armed EXECUTING crew. The
    // ordering makes double-briefing impossible by construction: a
    // goal-governed session (including a goal-delegated born-armed crew)
    // never receives a [forge:crew-continue] brief alongside the goal brief.
    if (!goal || goal.doc.status !== "active" || !goal.doc.session || goal.doc.session !== sessionID) {
      goalProbe(`no live active goal owned by session=${sessionID} — crew branch`)
      await continueCrewIfEligible(client, state, sessionID)
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
      // Pre-mark the turn BEFORE the await: the v2 promise-layer prompt
      // BLOCKS until the whole turn completes, and the idle hook may fire
      // during that await — the pendingContinuationTurn/turnActivity state
      // must already be in place so the guard chain can ledger the turn.
      pendingContinuationTurn.add(sessionID)
      turnActivity.set(sessionID, { writes: 0, checks: 0 })
      await client.session.prompt({
        path: { id: sessionID },
        body: { parts: [{ type: "text", text: briefText }] },
      })
      transportFails.delete(sessionID)
      // Remember which file this session's loop drives so the NEXT idle can
      // ledger the turn even after the goal goes terminal.
      state.goalPath = goal.path
      atomicWrite(goal.path, incTurns(readFileSync(goal.path, "utf8"), nowIso()))
      goalProbe(`continued session=${sessionID} turn=${goal.doc.turnsUsed + 1}/${goal.doc.maxTurns}`)
    } catch (err) {
      // Roll back the pre-send marks: no turn happened, and leaving them
      // set would make the next idle ledger a phantom no-activity turn —
      // the no-progress detector would outrun the transport counter.
      pendingContinuationTurn.delete(sessionID)
      turnActivity.delete(sessionID)
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

function scheduleIdleContinuation(client: GoalClient, sessionID: string, debounceMs: number = IDLE_DEBOUNCE_MS): void {
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
    }, Math.max(0, debounceMs)),
  )
}

// session.deleted harvest (change v2-plugin-api-port task 5.1): the ONE
// core both hosts call — the v1 event hook and the v2 event subscription
// share it verbatim (parity by reuse). Owner session end kills its live
// session-scoped jobs (unread completions ledgered), harvests its async
// dispatches, flushes queued wishes without spawning, and evicts every
// session-bounded map.
function harvestSessionEnd(sessionID: string): void {
  // Owner session ended: live session-scoped jobs are killed,
  // unread completions ledgered (job-supervisor spec).
  // fix-dispatch-dispose-kill D2: dispatch rows are KEPT after the kill —
  // the queued aborted wake must stay deliverable (deliverWakesFor only
  // traverses the live Map); the row self-clears via read-consumption.
  jobManager.onSessionEnd(sessionID, isDispatchRow)
  // Async-dispatch harvest (spec: Async dispatch lifecycle —
  // "Owner death harvests children"): onSessionEnd above killed the
  // session's live dispatch registry rows — each killTree aborted the
  // child session via the SDK and the orphan landed in the
  // diagnostics ledger. The handle map follows.
  for (const [id, handle] of [...dispatchTasks]) {
    if (handle.ownerSession === sessionID) dispatchTasks.delete(id)
  }
  // Fold D (owner-death queue flush): queued wishes flush WITHOUT
  // spawning (no child exists) and their journal records
  // terminalize (fold E pairing).
  flushDispatchQueue(sessionID)
  // The frozen depth translation dies with its session (bounded table).
  sessionDepths.delete(sessionID)
  // Undelivered progress notices die with their audience (lossy by
  // design — the terminal-wake guarantee never rode this queue).
  dispatchProgressQueue.delete(sessionID)
  // Same for the agent-family map (tool-partition).
  sessionAgents.delete(sessionID)
  // worker-shell-session-allow: the rescue bookkeeping dies with its
  // session (the injected session rule itself is host state and follows
  // the session's own lifecycle).
  sessionRescueInjected.delete(sessionID)
  sessionRescueDisclosed.delete(sessionID)
  sessionRescueAttached.delete(sessionID)
  // And the session-model capture table (harden-dispatch-resilience D3).
  sessionModels.delete(sessionID)
  // And the exec-seal finding bounds (readonly-exec-seal).
  sealFindings.delete(sessionID)
  sealUnknownNotes.delete(sessionID)
  // Session-domain pool-gate disclosure bound (sole-pool-ownership).
  poolGateUnknownNotes.delete(sessionID)
  // Anchor-preference disclosure bound (anchor-pool-preference).
  anchorPrefNotes.delete(sessionID)
  // Ledger-rebind disclosure bound + dedup memo (pool-rebind-on-resume;
  // the LEDGER file itself is persistent evidence and survives).
  poolGateLedgerNotes.delete(sessionID)
  sessionAnchorLedgerMemo.delete(sessionID)
  // Post-move anchor bound (fix-v2-crew-surface-drift 4.1): the moved
  // workspace statement dies with the session.
  sessionMovedAnchors.delete(sessionID)
  anchorMovedNotes.delete(sessionID)
  // Crew hygiene (crew-autonomous-waves D4): the session's crew was
  // in-memory and session-bound — end it with the session, and evict
  // the crew continuation engine's maps alongside (mirrors the
  // agent-family evictions above; the crew record on disk is history
  // and stays).
  crews.delete(sessionID)
  crewEngineForgetSession(sessionID)
}

// ---------------------------------------------------------------------------
// v1 server entry (the loader used by `opencode plugin` installs reads this)
// ---------------------------------------------------------------------------

export const server: Plugin = async (input, options) => {
  const effectiveInitDir = effectiveWorktree(input.worktree, input.directory) || input.directory || ""
  // Session-state fallback axis (plan/goal/crew record binding when a session
  // carries no observable anchor): last-init-wins is honest here — the most
  // recent initialization directory is the most likely current project. The
  // POOL axis is deliberately different: every initialization directory joins
  // the workspace registry (see hostAnchors) and pool membership re-resolves
  // from disk truth on every call — deletions un-materialize.
  hostWorktree = effectiveInitDir
  // Pool axis (sole-pool-ownership): the host remembers every workspace
  // directory it was initialized in; pool membership re-resolves per call
  // (deletions un-materialize) and dispatch is session-scoped.
  rememberHostAnchor(effectiveInitDir)
  const client = input.client as unknown as GoalClient
  // pool-gate-authoritative-anchor (D1/D2): the session anchor resolution the
  // dispatch belts use lives at MODULE level (resolveSessionAnchorForPools)
  // so the task interception belt and the task tool execute
  // share one seam over the same client.
  jobClient = input.client as unknown as JobClient
  // fix-v2-crew-surface-drift task 1.1: seed the shared anchor-client seam
  // at the same moment the dispatch belts get their client (the v1 task
  // tool belt reads jobClient — one seam, one source).
  anchorClientShared = (input.client as unknown as AnchorClient | null | undefined) ?? null
  // Fold E (restart recovery): the LAUNCH-ANCHOR workspace's journal recovers
  // at init; every other workspace recovers lazily on its first session
  // (event handler). Fail-soft by construction.
  if (effectiveInitDir && !isRootish(effectiveInitDir)) {
    void recoverWorkspaceDispatches(input.client as unknown as DispatchClient, effectiveInitDir)
  }
  const jobsOpts = (options as { jobs?: { mode?: unknown; keepBuiltinShell?: unknown; survive?: unknown } } | undefined)?.jobs
  if (jobsOpts?.mode === "auto" || jobsOpts?.mode === "forge" || jobsOpts?.mode === "native") jobsMode = jobsOpts.mode
  jobsKeepBuiltinShell = jobsOpts?.keepBuiltinShell === true
  if (jobsOpts?.survive === "never" || jobsOpts?.survive === "always" || jobsOpts?.survive === "deny") jobsSurviveMode = jobsOpts.survive
  // Search pair (forge-search-tools D4): `search.rgPath` config override.
  // Resolution re-runs per call against this value + PATH, so installing rg
  // mid-session needs no restart; the override itself rides the same
  // plugin-options surface as jobs/watchdog.
  const searchOpts = (options as { search?: { rgPath?: unknown } } | undefined)?.search
  searchRgPathOverride = typeof searchOpts?.rgPath === "string" && searchOpts.rgPath.trim().length > 0 ? searchOpts.rgPath : undefined

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

  const watchdogLedger = createFileLedger(join(watchdogLogHome(), "log.jsonl"))
  const rawLocator = createLocator()
  const probing = () => process.env.FORGE_WATCHDOG_PROBE === "1"
  const probeLine = (text: string) => {
    if (!probing()) return
    try {
      appendFileSync(join(probeTmp(), "forge-watchdog-probe.log"), `${new Date().toISOString()} ${text}\n`)
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
      // Diagnostics only: proof that the hook ran on THIS host generation and
      // what its job table held (2026-11-23: no host action on 2.4.0 could be
      // PROVEN to reach this point — the E2E had to infer it from a kill).
      try {
        const all = jobManager.list()
        goalProbe(`plugin dispose hook: registry rows=${all.length} running=${all.filter((j) => j.state === "running").length} dispatch rows=${all.filter(isDispatchRow).length}`)
      } catch {}
      engineForgetAll()
      // Exit matrix trigger (idempotent): graceful-then-force every live
      // non-survive job, then end the fence watcher. Survive jobs keep
      // running by contract — their registry entries await the next host.
      // fix-dispatch-dispose-kill D1: dispatch rows are skipped in BOTH the
      // exit matrix (createExitCleanup skip) and disposeAll — a v2
      // multi-context host fires dispose on every context recycle and the
      // host keeps living; killing in-flight dispatches there is pure
      // destruction (journal aborted → recovery skips live children).
      exitCleanup?.trigger("dispose")
      jobManager.disposeAll(isDispatchRow)
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
          "forge — the single general-purpose coding agent: takes implementation tasks directly; planning goes through /plan into the plan harness (plans land in .opencode/plan/, with an approve confirmation gate, a plugin-verified fail-closed close that re-runs the frozen checks, and tick discipline enforced by tools and the permission layer).",
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

      // /forge command — the roster levers (change forge-commands): one
      // command routing on its argument (sync / init / init global / stop /
      // help). Same no-clobber rule as /plan and /goal. The hyphenated
      // lever family (forge-sync/forge-init/forge-init-global/forge-cancel)
      // is RETIRED (command-surface-v2-cleanup D1) — one command, four
      // argument forms; deletion means "no longer registered", never
      // touching a user's same-named entry.
      cfg.command["forge"] ??= {
        template: FORGE_COMMAND_TEMPLATE,
        description:
          'forge roster levers: sync forces an immediate forge_sync and shows the diff; init drafts the workspace forge.json in-band (refuses when one exists — review instead); init global drafts the global forge.json with the built-in override entries commented out; stop cancels this session\'s in-flight async dispatches',
      }

      // Gate permission rules (shell-defang-default-open): the 6 doors keep
      // the full "ask" rewrite — they stay real user confirmations (an
      // explicit allow on a door is still rewritten to ask). forge_shell is
      // NEVER rewritten: its posture passes through untouched — unconfigured
      // inherits the host default (in practice allow everywhere, so the exec
      // surface behaves exactly like the native shell tool in every mode),
      // and an explicit user allow/deny/ask stands verbatim for the host to
      // resolve (TUI dialog / run auto-reject / serve pending ask). No
      // plugin-side classification anywhere on the posture path. The draft
      // write-ban lives in tool.execute.before (phase-aware, no global
      // tightening), so stock behavior outside planning is unchanged.
      const perm = (cfg as { permission?: Record<string, unknown> }).permission
      const permSection = perm ?? ((cfg as { permission?: Record<string, unknown> }).permission = {})
      // Snapshot — capture the user's OWN explicit values for the gate keys.
      // Anti-recapture guard: only "allow"/"deny" are captured, "ask" never
      // is — the merged config object may be re-presented on later passes
      // carrying the plugin's DOOR rewrites. Only forge_shell's entry is
      // consumed (belt-in-depth enforcement of its explicit rule); the doors
      // never read it.
      for (const gateKey of GATE_PERMISSION_KEYS) {
        const incoming = permSection[gateKey]
        if (incoming === "allow" || incoming === "deny") gatePermissionSnapshot.set(gateKey, incoming)
      }
      // Door posture rewrite. forge_shell is deliberately absent: no
      // injection, no rewrite — pass-through (spec: "Exec posture
      // pass-through on the exec surface").
      for (const gateKey of GATE_PERMISSION_KEYS) {
        if (gateKey === "forge_shell") continue
        const v = permSection[gateKey]
        if (v !== "deny") permSection[gateKey] = "ask"
      }

      // forge subagents: load forge.json (hot-apply), materialize the static
      // subagents WITH their pinned models, and compose the /crew command for
      // the current agent set. Findings surface through the diagnostics log —
      // never silently swallowed, never an AI-facing configuration invitation.
      // Workspace pool ownership (sole-pool-ownership): the materialization
      // set is the global fallback layer + every seen workspace's pool (one
      // per anchor: its walk-up nearest file — nested files ignored); file
      // truth (edits/creations/deletions) hot-applies through the resolver's
      // mtime caches on every resolve, and a deleted pool file disappears.
      // EVERY family materializes namespaced (forge-<ns>-<id>; the global
      // fallback is forge-global-<id> — no plain-id family exists); each
      // agent's description carries its pool provenance (change
      // pool-namespace-contract D3); the task-dispatch guard scopes dispatch
      // session-locally.
      const resolution = resolvePools()
      poolResolution = resolution
      for (const finding of resolution?.findings ?? []) {
        console.warn(`[forge:config] ${finding.level}: ${finding.message}`)
      }
      materializedSnapshot = {}
      const globalMaterializationPath = globalPoolPathOf()
      for (const [matId, agent] of Object.entries(resolution?.agents ?? {})) {
        const id = `forge-${matId}`
        if (agentSection[id] !== undefined) continue // no-clobber
        const provenance = foldPath(agent.file) === foldPath(globalMaterializationPath) ? ({ global: true } as const) : { ns: agent.ns, file: agent.file }
        // forge-prompt-shared D4: the agent's ORIGIN file's `shared` segment
        // threads into the materialized prompt (strict prepend beneath the
        // role chain); null/undefined = byte-identical no-shared build.
        const entry = forgeAgentDef(matId, agent.def, provenance, agent.shared ?? undefined)
        agentSection[id] = entry
        materializedSnapshot[id] = entry
      }

      // Tool-partition injections (spec: tool-partition, design D3/D9). Runs
      // after materialization so every forge-* entry — plugin-created or
      // user-defined (family rules follow the name, not the author) — is
      // covered. Key-merge only: user-written fields and explicit `true`
      // entries outside the forge family stand.
      // (a) forge-* workers: harness STATE tools are primary-only. Workers
      // keep the exec pair AND the search pair (forge_grep/forge_glob,
      // forge-search-tools D6) — readonly-safe, shape-independent.
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

      // Host agent vocabulary refresh (task-shadow full-parity non-forge
      // path): everything the merged config knows, plus the native
      // fallbacks — the task tool's non-forge target router truth-checks
      // against this set ("Agent not found" otherwise).
      knownHostAgents.clear()
      for (const native of NATIVE_PARTITION_FALLBACKS) knownHostAgents.add(native)
      for (const id of Object.keys(agentSection)) knownHostAgents.add(id)

      // models.dev snapshot: optional ladder verification for depth injection.
      // Unavailable -> null -> verbatim pass-through (the provider judges).
      if (process.env.FORGE_TEST_NO_DISPATCH_FETCH === "1") {
        modelsDevCatalog = null
      } else {
        try {
          const snapshot = await loadModelsDevSnapshot({ cacheDir: modelsDevCacheRoot() })
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
              .replaceAll("{template}", JSON.stringify({ pool: "namespace (REQUIRED for crew-governed dispatch, [a-z0-9-] up to 24 chars — every pool materializes as forge-<ns>-<id>; the global fallback materializes as forge-global-<id>)", agents: { research: { model: "provider/model", thoughtLevel: "low", shape: "readonly", prompt: "short role description — what this agent does" }, coder: { model: "provider/model", thoughtLevel: "low", shape: "write", prompt: "short role description — what this agent does" } } }, null, 2).split("\n").map((l) => "   " + l).join("\n"))
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
          appendFileSync(join(probeTmp(), "forge-perm-probe.log"), `${new Date().toISOString()} before tool=${JSON.stringify(input.tool)} session=${input.sessionID}\n`)
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
            appendFileSync(join(probeTmp(), "forge-watchdog-probe.log"), `${new Date().toISOString()} track ${input.callID} needle=${JSON.stringify(cmdText !== undefined ? commandNeedle(cmdText) : undefined)} rawArgs=${JSON.stringify(output?.args ?? null).slice(0, 200)}\n`)
          } catch {}
        }
      }
      // Dispatch belt (tool-partition): a non-forge session must not spawn
      // forge-* workers (the task vocabulary is global; refusal is the only
      // per-parent control). Unknown sessions fail open.
      if (input.tool === "task") {
        const a = (output?.args ?? {}) as { subagent_type?: unknown; agent?: unknown }
        const target = typeof a.subagent_type === "string" ? a.subagent_type : typeof a.agent === "string" ? a.agent : undefined
        const speaker = sessionAgents.get(input.sessionID)
        if (speaker !== undefined && !isForgeFamilyAgent(speaker)) {
          if (target && target.toLowerCase().startsWith("forge-")) {
            throw new Error(
              `[forge:partition] Dispatch refused: "${target}" is a forge-family worker and the current agent ("${speaker}") is outside the forge family. Use the native general/explore subagents, or switch to the forge agent to dispatch forge-* workers.`,
            )
          }
        }
        // Session-domain pool gate (sole-pool-ownership, spec:
        // forge-subagents — "Workspace pool ownership and global fallback"):
        // a task targeting a forge-* worker whose pool belongs to ANOTHER
        // workspace is refused — the target's origin pool path is named,
        // with the three exits. Shared predicate with the task tool execute
        // (poolGateRefusal — same source, same copy).
        if (target && target.toLowerCase().startsWith("forge-") && input.sessionID) {
          const poolRefusal = await poolGateRefusal(client, input.sessionID, target)
          if (poolRefusal) throw new Error(poolRefusal)
        }
        // Crew pending belt (crew-harness, change add-crew-execution-mode-gate):
        // a registered-but-unarmed crew refuses EVERY task dispatch — the
        // registration→execution seam is a user decision point. Pre-registration
        // recon dispatches freely; armed and ended crews never pend here.
        const pendingRefusal = crewPendingRefusal(input.sessionID)
        if (pendingRefusal) throw new Error(pendingRefusal)
        // Crew compliance belt (change pool-namespace-contract, spec:
        // crew-harness — "Crew-governed dispatch pool-compliance gate"):
        // for task dispatches to forge-* targets FROM a crew-governed
        // session (PENDING or EXECUTING, including born-armed), re-run the
        // file-level pool compliance check — a pool degraded mid-crew
        // blocks further crew dispatches until repaired. Runs AFTER the
        // session-domain pool gate above (a cross-pool target keeps its
        // not-dispatchable copy — compliance never masks it) and composes
        // with the pending-crew belt without replacing it. Native
        // (non-forge) targets are unaffected; global-fallback sessions are
        // exempt; an unknown session anchor keeps the fail-open posture.
        if (target && target.toLowerCase().startsWith("forge-") && input.sessionID) {
          const complianceRefusal = await crewComplianceRefusalFor(client, input.sessionID, target)
          if (complianceRefusal) throw new Error(complianceRefusal)
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
          if (input.tool === "task") {
            // allow-readonly-recon-during-plan-draft: the spawn carve-out is
            // keyed on the TARGET's effective readonly shape, not a wholesale
            // deny. Shared predicate with the task tool execute
            // (draftDispatchRefusal — same source, same copy, both modes).
            const a = (output?.args ?? {}) as { subagent_type?: unknown; agent?: unknown }
            const target = typeof a.subagent_type === "string" ? a.subagent_type : typeof a.agent === "string" ? a.agent : undefined
            const refusal = draftDispatchRefusal(input.sessionID, target)
            if (refusal) throw new Error(refusal)
          } else {
            throw new Error(
              `[forge] A plan is in draft; write operations are denied (${input.tool}). Switch back to the forge agent to present it and complete plan approval (plan_approve), or run /plan discard to abandon the plan.`,
            )
          }
        }
      }
      // Exec seal (readonly-exec-seal, tool-partition — "Readonly workers
      // execute on a sealed supervised-exec channel"): a session whose
      // running forge-* worker has an EXPLICIT readonly shape
      // (effectiveReadonlyShape — shape-default-open: an absent shape is
      // write and is NEVER sealed) gets its forge_shell channel gated before
      // spawn: WRITE-CLASS commands (pure-string classifier,
      // src/exec-classify.ts) are denied with a bounded finding naming the
      // shape, the indicator and the `shape: "write"` remedy. The primary
      // forge session is never sealed; an UNKNOWN session fails open (belt
      // posture) with a once-per-session disclosure. Composes with, never
      // replaces, the draft-phase ask/deny posture above — that block treats
      // forge_shell via permission.ask only and is untouched here.
      if (input.tool === "forge_shell" && input.sessionID) {
        const a = (output?.args ?? {}) as { command?: unknown }
        const cmd = typeof a.command === "string" ? a.command : undefined
        if (cmd) {
          const speaker = sessionAgents.get(input.sessionID)
          const workerId =
            speaker !== undefined && isForgeFamilyAgent(speaker) && speaker.toLowerCase() !== FORGE_AGENT ? speaker.slice("forge-".length) : undefined
          if (workerId !== undefined) {
            const def = resolvePools()?.agents[workerId]?.def
            if (def !== undefined && effectiveReadonlyShape(def)) {
              const verdict = classifyExecCommand(cmd)
              if (verdict.klass === WRITE_CLASS) {
                const seen = sealFindings.get(input.sessionID) ?? new Set<string>()
                if (!seen.has(verdict.indicator!)) {
                  seen.add(verdict.indicator!)
                  sealFindings.set(input.sessionID, seen)
                  console.warn(
                    `[forge:seal] session ${input.sessionID} (readonly worker "${speaker}"): write-class forge_shell command denied — indicator "${verdict.indicator}" (${verdict.detail ?? cmd.slice(0, 60)}). Remedy: "shape": "write" on the agent when its job legitimately mutates.`,
                  )
                }
                throw new Error(
                  `[forge:seal] Exec refused: this session runs the readonly worker "${speaker}" (explicit "shape": "readonly") and the command was classified WRITE-CLASS — indicator "${verdict.indicator}"${verdict.detail ? ` (${verdict.detail})` : ""}. READ-CLASS commands (inspection, search, read-only evals) flow normally. If this worker's job legitimately mutates, set "shape": "write" on its forge.json entry. Report this refusal VERBATIM — do not work around it.`,
                )
              }
            }
          } else if (speaker === undefined) {
            // Unknown session: fail-open on the channel (the seal keys on
            // the explicit readonly shape only), disclosed once per session.
            const verdict = classifyExecCommand(cmd)
            if (verdict.klass === WRITE_CLASS && !sealUnknownNotes.has(input.sessionID)) {
              sealUnknownNotes.add(input.sessionID)
              console.warn(
                `[forge:seal] session ${input.sessionID}: a WRITE-CLASS forge_shell command (${verdict.indicator}) flowed UNSEALED — the session's agent is unknown (fail-open; the exec seal binds explicit-readonly forge-* workers only).`,
              )
            }
          }
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
      // Draft-phase subagent-spawn gate is INHERITED: the native task tool is
      // in the write-ban class (isWriteTool covers "task"), and the block
      // above carves out effective-readonly targets per
      // allow-readonly-recon-during-plan-draft (spec: forge-subagents —
      // "Native-task dispatch surface" shape-gated interop).
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
    // word on a word-shaped channel passes through VERBATIM (disclosed
    // unverified — provider judges); the only dead ends (legacy budget,
    // pure toggle) inject nothing and record a bounded once-per-agent
    // finding; a provider absent from catalog and prefix map defaults to
    // the effort word channel (pass-through, never silent).
    "chat.params": async (input, output) => {
      if (forgeDisabled) return
      const raw = input as unknown as { sessionID?: string; agent?: unknown; model?: { providerID?: unknown; modelID?: unknown } }
      const sessionID = raw.sessionID
      if (!sessionID) return
      const agentName = typeof raw.agent === "string" ? raw.agent : (raw.agent as { name?: unknown } | undefined)?.name
      // Family-map upsert (tool-partition): fires for every request build,
      // including task-spawned sessions (probe P1).
      if (typeof agentName === "string" && agentName) sessionAgents.set(sessionID, agentName)
      // Session-model capture (harden-dispatch-resilience D3): every
      // request build reports the session's resolved model — the dispatch
      // gate's session-model fallback for unpinned targets. Both host
      // shapes accepted (modelID plugin-SDK shape, id host 1.18.34 shape);
      // a missing model id records nothing.
      {
        const capObj = raw.model as { modelID?: unknown; id?: unknown } | undefined
        const capProvider = typeof raw.model?.providerID === "string" ? raw.model.providerID : ""
        const capModel = typeof capObj?.modelID === "string" ? capObj.modelID : typeof capObj?.id === "string" ? capObj.id : ""
        if (capProvider && capModel) sessionModels.set(sessionID, { provider: capProvider, model: capModel })
      }
      if (typeof agentName !== "string" || !agentName.startsWith("forge-")) return
      const frozen = sessionDepths.get(sessionID)
      if (frozen) {
        // Frozen hit (postrelease-hardening D2): a null translation is a
        // frozen dead end — the session's FIRST resolution had no counterpart
        // shape, so nothing is injected for the remainder of the session,
        // even if forge.json is edited mid-session (new sessions re-resolve).
        if (process.env.FORGE_DEPTH_PROBE) {
          try {
            appendFileSync(
              join(probeTmp(), "forge-depth-probe.log"),
              `${new Date().toISOString()} sid=${sessionID} agent=${agentName} frozen-apply translation=${JSON.stringify(frozen.translation) ?? "null"}\n`,
            )
          } catch {}
        }
        if (frozen.translation) applyDepthTranslation(output.options ?? (output.options = {}), frozen.translation)
        return
      }
      const agentId = agentName.slice("forge-".length)
      // Pool-set lookup (sole-pool-ownership): the key is the materialized
      // name sans prefix (plain or <ns>-<id>); fresh resolve per lookup
      // keeps the hot-apply contract.
      const def: ForgeAgentDef | undefined = resolvePools()?.agents[agentId]?.def
      if (!def?.thoughtLevel) return
      const modelObj = raw.model as { modelID?: unknown; id?: unknown } | undefined
      const providerID = typeof raw.model?.providerID === "string" ? raw.model.providerID : ""
      // Host shape (empirically, 1.18.34): chat.params carries the full ModelInfo
      // with the model name under `id` — `modelID` is the plugin-SDK test shape.
      // Accept both; an empty model id degrades to the prefix-family fallback.
      const modelID =
        typeof modelObj?.modelID === "string" ? modelObj.modelID : typeof modelObj?.id === "string" ? modelObj.id : ""
      const channel = resolveDepthChannel(providerID, modelID)
      const { translation, findingMessage } = resolvePinnedDepth(def.thoughtLevel, channel)
      // Freeze FIRST (postrelease-hardening D2): BOTH outcomes freeze the
      // session — a translation re-applies verbatim on later requests, a dead
      // end (translation: null) keeps injecting nothing. Mid-session config
      // edits only ever affect sessions created after them (sessionDepths
      // evicts on session.deleted). The once-per-agent finding bound is
      // unchanged: dead ends land here exactly once per agent.
      sessionDepths.set(sessionID, { translation })
      if (translation) {
        applyDepthTranslation(output.options ?? (output.options = {}), translation)
      } else if (findingMessage && !depthFindingNotes.has(agentId)) {
        depthFindingNotes.set(agentId, findingMessage)
        console.warn(`[forge:depth] agent forge-${agentId}: ${findingMessage}`)
      }
      // Env-gated trace (same style as FORGE_GOAL_PROBE): one line per depth
      // resolution, for sandbox E2E attribution (verify/adaptive-key.md).
      // `optionsAfter` is serialized AFTER the apply (postrelease-hardening
      // task 4): it must reflect the options that actually ship — serializing
      // before the apply made triage misread a dropped key as "never
      // injected". Frozen hits trace separately (frozen-apply, above).
      if (process.env.FORGE_DEPTH_PROBE) {
        try {
          appendFileSync(
            join(probeTmp(), "forge-depth-probe.log"),
            `${new Date().toISOString()} sid=${sessionID} agent=${agentName} prov=${providerID} model=${modelID} depth=${def.thoughtLevel} channel=${JSON.stringify(channel)} translation=${JSON.stringify(translation) ?? "null"} finding=${findingMessage ?? "-"}\n` +
              `    input=${JSON.stringify(raw).slice(0, 600)}\n` +
              `    optionsAfter=${JSON.stringify(output.options ?? {})}\n`,
          )
        } catch {}
      }
    },

    // Test seam (wiring tests drive server() with stubs; same pragmatic
    // module-state style as FORGE_TEST_NO_FENCE). Not part of the plugin API.
    __forgeSubagentsTest: {
      crews: () => crews,
      sealFindings: (sessionID: string) => [...(sealFindings.get(sessionID) ?? [])],
      depthState: (sessionID: string) => sessionDepths.get(sessionID)?.translation ?? null,
      depthFinding: (agentId: string) => depthFindingNotes.get(agentId) ?? null,
      catalog: () => modelsDevCatalog,
      setCatalog: (c: CatalogSnapshot | null) => {
        modelsDevCatalog = c
      },
      crewCommand: () => crewCommandSnapshot,
      materialized: () => materializedSnapshot,
      // Workspace-registry seam (sole-pool-ownership): the registry is
      // host-lifetime state; tests simulate a host restart by resetting.
      resetAnchors: () => {
        hostAnchors.length = 0
        poolResolver = null
        poolResolution = null
      },
      anchors: () => [...hostAnchors],
      resolveNow: () => resolvePools(),
      workspacePoolOf: (anchor: string) => sessionPoolFileOf(anchor),
      // Async-dispatch seams (change async-dispatch wiring tests).
      dispatchTasks: () => [...dispatchTasks.values()],
      // harden-dispatch-resilience D2 seams (nested-dispatch guard wiring
      // tests): seed the session-model capture (the anthropic-family input
      // the guard resolves through dispatchModelIdentity) and reset it.
      setSessionModel: (sessionID: string, identity: { provider: string; model: string } | null) => {
        if (identity === null) sessionModels.delete(sessionID)
        else sessionModels.set(sessionID, identity)
      },
      // Fold D seams: the per-session FIFO queues and the journal/recovery
      // surfaces (tests inject an in-memory journal fs BEFORE dispatching).
      dispatchQueues: () =>
        [...dispatchQueues.entries()].flatMap(([owner, wishes]) => wishes.map((w) => ({ ownerSession: owner, jobId: w.jobId, agentID: w.agentID }))),
      setDispatchJournalFs: (factory: ((filePath: string) => JournalFs) | null) => {
        dispatchJournalFsFactory = factory
        dispatchJournals.clear()
        recoveredDispatchWorkspaces.clear()
      },
      dispatchRecoveredWorkspaces: () => [...recoveredDispatchWorkspaces],
      dispatchJournalText: (worktree: string): string | null => {
        try {
          return journalFor(worktree).fs.read()
        } catch {
          return null
        }
      },
      // Session-anchor ledger seams (pool-rebind-on-resume): inject the fs
      // BEFORE binding sessions; the factory clears the disclosure bounds
      // and the dedup memo (the LEDGER FILE itself survives — it is exactly
      // what a host restart keeps).
      setSessionAnchorLedgerFs: (factory: ((filePath: string) => SessionAnchorLedgerFs) | null) => {
        sessionAnchorLedgerFsFactory = factory
        poolGateLedgerNotes.clear()
        sessionAnchorLedgerMemo.clear()
        sessionAnchorLedgerAppends = 0
      },
      // Simulate a NEW PROCESS for the same session id (the restart-resume
      // shape): the in-memory session table and the disclosure bounds all
      // reset — only the LEDGER (injected fs) survives, which is exactly
      // what a host restart keeps.
      resetSessionBindings: () => {
        sessions.clear()
        anchorPrefNotes.clear()
        poolGateUnknownNotes.clear()
        poolGateLedgerNotes.clear()
        sessionAnchorLedgerMemo.clear()
        sessionAnchorLedgerAppends = 0
      },
      sessionAnchorLedgerText: (): string | null => {
        try {
          return sessionAnchorLedgerFs().read()
        } catch {
          return null
        }
      },
      // Pending [forge:dispatch-progress] notices for a session (fold #2
      // wiring tests observe the enqueue side of the lossy queue).
      dispatchProgress: (sessionID: string) => (dispatchProgressQueue.get(sessionID) ?? []).map((notice) => notice.text),
      // fix-stale-progress-notice: notices dropped at delivery time because
      // what they reported was no longer true (newest last, bounded).
      dispatchProgressDropped: (sessionID: string) => [...(dispatchProgressDropped.get(sessionID) ?? [])],
      // Read-only view of one registry row's in-memory output tail (the
      // wiring tests check that a dropped notice stays in the job's output).
      jobTail: (jobId: string): string | null => jobManager.get(jobId)?.tail ?? null,
      // Provider-gate seams (harden-dispatch-resilience D3): observe the
      // host-process gate's counters/breaker, and reset module state for
      // test isolation (server() calls share one process).
      dispatchGateState: () => {
        if (!dispatchGate) return null
        const live = dispatchGate.liveCounts()
        const providers = new Set([...Object.keys(live.provider), ...gateProvidersSeen])
        const breakers: Record<string, { state: string; failures: number }> = {}
        for (const p of providers) breakers[p] = dispatchGate.breakerState(p)
        return { live, breakers }
      },
      resetDispatchGate: () => {
        dispatchGate = null
        admittedGate.clear()
        gateProvidersSeen.clear()
        sessionModels.clear()
        dispatchConfigLoaders.clear()
      },
      jobLedger: () => jobManager.ledgerEntries(),
      // Posture seams (shell-defang-default-open): the pre-rewrite permission
      // snapshot and a reset for test isolation (module state is shared
      // across server() calls in one test process).
      gateSnapshot: () => Object.fromEntries(gatePermissionSnapshot),
      resetGateSnapshot: () => {
        gatePermissionSnapshot.clear()
      },
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
            join(probeTmp(), "forge-perm-probe.log"),
            `${new Date().toISOString()} ask name=${JSON.stringify(name)} in_status=${output.status} id=${JSON.stringify(input.id)} type=${JSON.stringify(input.type)} meta=${JSON.stringify(input.metadata)}\n`,
          )
        } catch {}
      }
      if (name === "plan_approve" || name === "goal_write" || name === "goal_complete" || name === "goal_resume" || name === "goal_discard") {
        // Belt for FIVE of the doors: if a permission request ever surfaces
        // for them (host starts evaluating plugin tools), keep it a real ask
        // unless explicitly denied — user-confirmation doors are never
        // auto-resolved in any mode (plan_close is plugin-verified, not a
        // door — plan-close-verified). forge_shell is deliberately ABSENT
        // (pass-through): its request carries whatever the host resolved
        // from the user's verbatim rules — the plugin never rewrites,
        // classifies, or forces it.
        // crew_close is NOT in this list and never was (v1 logic left
        // byte-identical by fix-crew-close-ask-door D7): on a v1 host the
        // door is held by the config hook's "ask" rewrite of
        // GATE_PERMISSION_KEYS and by the tool's own context.ask — the
        // host's native dialog. The v2 belt derives its doors from that
        // same key list (V2_PERMISSION_DOORS), so v2 cannot drift again.
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
          // Fold E (lazy per-workspace recovery scope): workspaces beyond
          // the launch anchor recover on their FIRST session.
          if (!isRootish(worktree)) void recoverWorkspaceDispatches(jobClient as unknown as DispatchClient | null, worktree)
        }
      }
      if (event.type === "session.idle") {
        const sessionID = (event as unknown as { properties: { sessionID: string } }).properties.sessionID
        if (typeof sessionID === "string" && sessionID) {
          goalProbe(`idle event session=${sessionID}`)
          idleJobSessions.add(sessionID)
          scheduleIdleContinuation(client, sessionID)
          // Progress flushes BEFORE terminal wakes (design D6): older
          // information lands first on the same idle edge.
          void deliverDispatchProgress(sessionID).then(() => deliverJobWakes(sessionID))
        }
      }
      if (event.type === "session.deleted") {
        const info = (event as unknown as { properties: { info: { id?: string } } }).properties.info
        if (typeof info?.id === "string" && info.id) harvestSessionEnd(info.id)
      }
      if ((event as unknown as { type?: string }).type === "session.moved") {
        // Post-move anchor re-resolution: the host's live statement of the
        // session's new workspace (the session.get seam stays pre-move).
        // Typed defensively: "session.moved" is a 2.3.2 v2 event; older v1
        // hosts never emit it (the branch simply never fires there).
        try {
          const props = (event as unknown as { properties?: Record<string, unknown>; location?: unknown }).properties ?? (event as unknown as Record<string, unknown>)
          const f = movedEventFields(props)
          noteSessionMoved(f.sessionID, f.directory)
        } catch {
          // Drifted moved payload: no-op, never a throw into the host.
        }
      }
      // Host-signal completion routing (dispatch-v2-hostsignals 3.1): the
      // v1 hook's bus delivers the same durable execution events where the
      // host publishes them — routed into the child-keyed inbox (a Map-miss
      // for non-children is a no-op). Defensively typed, never a throw.
      const v1Type = (event as unknown as { type?: string }).type
      const v1Props = ((event as unknown as { properties?: Record<string, unknown> }).properties ?? {}) as Record<string, unknown>
      const v1Session = typeof v1Props.sessionID === "string" && v1Props.sessionID ? v1Props.sessionID : undefined
      if (v1Session && (v1Type === "session.execution.succeeded" || v1Type === "session.execution.failed" || v1Type === "session.execution.interrupted")) {
        const kind =
          v1Type === "session.execution.succeeded" ? ("succeeded" as const) : v1Type === "session.execution.failed" ? ("failed" as const) : ("interrupted" as const)
        const detail =
          kind === "failed"
            ? executionErrorDetail(v1Props.error)
            : kind === "interrupted"
              ? v1Props.reason !== undefined
                ? String(v1Props.reason)
                : undefined
              : undefined
        noteDispatchTerminalSignal(v1Session, kind, detail)
        // Parent-interrupt disclosure (dispatch-cancel-lifecycle 2.1): the
        // v1 hook's bus carries the same interrupted edge — disclose-only,
        // deduped, never a throw into the host callback.
        if (kind === "interrupted") {
          try {
            discloseInterruptedParent(v1Session)
          } catch {}
        }
      } else if (v1Session && (v1Type === "session.execution.started" || v1Type === "session.step.started" || v1Type === "session.step.ended")) {
        noteDispatchChildActivity(v1Session)
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
          appendFileSync(join(probeTmp(), "forge-watchdog-probe.log"), `${new Date().toISOString()} mark ${input.callID} hostpid=${process.pid}\n`)
        } catch {}
      }
    },
    "tool.execute.after": async (input) => {
      if ((input.tool === "shell" || input.tool === "bash") && watchdog.has(input.callID)) {
        watchdog.untrack(input.callID)
        if (process.env.FORGE_WATCHDOG_PROBE) {
          try {
            appendFileSync(join(probeTmp(), "forge-watchdog-probe.log"), `${new Date().toISOString()} untrack ${input.callID}\n`)
          } catch {}
        }
      }
      if (typeof input.tool !== "string") return
      const act = turnActivity.get(input.sessionID)
      if (act) {
        if (isWriteTool(input.tool) || input.tool === "plan_tick") act.writes++
        // goal-no-progress-honesty: a verification command on an exec-class
        // tool scores like goal_check — a turn that re-ran the contract's
        // checks through forge_shell can never be scored no-progress.
        if (input.tool === "goal_check" || input.tool === "forge_shell" || input.tool === "shell" || input.tool === "bash") act.checks++
      }
      // Crew-side counters (crew-autonomous-waves D3): task dispatches count
      // as crew-turn activity (waves ARE the work) plus write-family calls;
      // zero cost for sessions without an open crew-continuation turn.
      const crewAct = crewTurnActivity.get(input.sessionID)
      if (crewAct) {
        if (input.tool === "task") crewAct.dispatches++
        if (isWriteTool(input.tool)) crewAct.writes++
      }
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
            : "call plan_tick immediately after each completed task; when all are done, self-check every acceptance criterion and call plan_close — the plugin re-runs the frozen verification checks itself (fail-closed, no dialog) and writes an evidence summary the user reviews asynchronously"
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

// V2 context domains, structurally typed (no @opencode/plugin import —
// conventions §2). Every domain is optional and every method is `?.` +
// typeof guarded at the call site; a drifted domain disables exactly its
// own feature slice. Domains not yet wired (permission/session/command/
// event) land in waves W3–W5; the types exist so the mock harness and the
// guards have one contract to test against.
type V2AgentDraft = {
  list(): Array<{ id: string }>
  get(id: string): unknown
  update(id: string, update: (agent: Record<string, unknown>) => void): void
  remove(id: string): void
  // v2-single-agent-surface D5: the agent draft editor exposes a default
  // setter (binary-verified 2.3.2) — guarded everywhere it is called.
  default?(id: string): void
}
type V2ToolEditor = {
  add?(def: { name: string; description: string; input: Record<string, unknown>; execute: (args: unknown, toolCtx: unknown) => Promise<unknown> }): void
  list?(): Array<{ name: string }>
  get?(name: string): unknown
}
// Command-domain editor (task 4.3, W6a field reality — SDK 2.3.2
// promise/command.d.ts): CommandDefinition is EXECUTE-based
// {name, description?, execute({sessionID, prompt, delivery})} and the
// editor exposes ONLY add() — no list/get/remove (the v1 create-only rule
// is not implementable on this domain; documented drift in design.md).
// The template text rides the execute closure: invoking the command sends
// the SAME constant text into the invoking session via the flat
// {sessionID, text} prompt.
type V2CommandEditor = {
  add?(def: { name: string; description?: string; execute: (input: { sessionID?: unknown }) => Promise<void> }): void
}
type V2PluginContext = {
  agent?: {
    transform?(cb: (draft: V2AgentDraft) => void | Promise<void>): Promise<unknown>
  }
  tool?: {
    transform?(cb: (editor: V2ToolEditor) => void | Promise<void>): Promise<unknown>
    hook?(name: string, cb: (event: unknown) => void): void
  }
  // W6a field realities (SDK 2.3.2 promise/permission.d.ts): the evaluate
  // hook hands the plugin a MUTABLE PermissionEvaluation ({sessionID, agent?,
  // action, resources, metadata?, source?, effect, message?}) — the belt
  // mutates input.effect ("allow" | "deny" | "ask", @opencode/schema
  // permission.d.ts Effect union). The decision-RETURNING gates (the v1
  // context.ask seam the plan/goal tool cores consume) map to
  // ctx.permission.assert(input) — "evaluates rules and prompts the user,
  // resolves when allowed, rejects with Tool.Error on deny".
  permission?: {
    hook?(name: string, cb: (event: unknown) => void): unknown
    assert?(input: unknown): Promise<void>
  }
  // W6a field realities (SDK 2.3.2 promise/session.d.ts): the session domain
  // is Pick<SessionApi, "list"|"create"|"get"|...|"prompt"|...|"context"> —
  // there is NO promptAsync and NO status; prompt takes the flat
  // SessionPrompt {sessionID, messageID?, prompt: PromptInput.Prompt,
  // metadata?, delivery: "steer"|"queue"} (PromptInput.Prompt's minimal
  // valid shape is {text} — @opencode/schema prompt-input.d.ts). hook()
  // covers SessionHooks incl. "prompt"|"context"|"compaction" and
  // "experimental.idle" (SessionIdle {sessionID, background[]} — the
  // in-process idle signal; richer and race-free vs the SSE
  // session.execution.succeeded edge) and returns a Registration{dispose}.
  session?: {
    hook?(name: string, cb: (event: unknown) => void): unknown
    get?(opts: unknown): Promise<unknown>
    prompt?(input: unknown): Promise<unknown>
    context?(opts: unknown): Promise<unknown>
    // dispatch-v2-hostsignals 3.2 (protocol-verified 2.3.2): the one-shot
    // idle latch — POST /api/experimental/session/:sessionID/wait
    // (NoContent success; "Wait for a session agent loop to become idle").
    wait?(input: unknown): Promise<unknown>
    // fix-v2-crew-surface-drift D2 (sandbox-probed 2.3.2): the promise-layer
    // session domain DOES expose create — flat single-object param, bare
    // record response (see v2SessionClient's create adapter).
    create?(input: unknown): Promise<unknown>
    // worker-shell-session-allow (source-verified 2.3.2 plugin/host.ts):
    // update carries {sessionID, ...mutations} incl. `permissions` — the
    // whole session ruleset is REPLACED, so the rescue always read-back-
    // merges first. Guarded: a drifted host simply disables the rescue's
    // injection channel (the D5 fallback belt still covers workers).
    update?(input: unknown): Promise<unknown>
    // fix-dispatch-dispose-kill D3 (live-host probe 2026-11-23, host 2.3.2
    // GET /openapi.json: POST /api/session/{sessionID}/interrupt, optional
    // resume query, 200 {interrupted:boolean}, idle interruption is a no-op;
    // SDK v2 gen sdk.gen.d.ts:1743 session.interrupt — "Interrupt active
    // execution owned by this OpenCode process"): the v2 stop surface. The
    // adapter wires it as the dispatch `abort` seam (HTTP fallback when the
    // promise layer does not expose it).
    interrupt?(input: unknown): Promise<unknown>
  }
  command?: { transform?(cb: (editor: V2CommandEditor) => void | Promise<void>): Promise<unknown> }
  // W6a field realities (SDK 2.3.2 promise/event.d.ts): subscribe(options?)
  // returns an ASYNC ITERABLE of OpenCodeEvent envelopes {id, created, type,
  // data} — no handlers map, no abort return value. SubscribeOptions carries
  // {types?, signal?} (adapter.js makeStreams); cleanup = breaking the
  // for-await loop (iterator.return) and/or aborting the signal.
  event?: { subscribe?(options?: unknown): unknown }
  // dispatch-v2-hostsignals 4.1 (promise/storage.d.ts, 2.3.2): the host
  // plugin KV — get(key)→Json|undefined, set/remove, scan({prefix})→
  // {entries:[{key,value}], next?}. The persisted dispatch registry rides
  // it; a drifted/absent domain fails soft to the journal-only posture.
  storage?: {
    get?(key: string): Promise<unknown>
    set?(key: string, value: unknown): Promise<void>
    remove?(key: string): Promise<void>
    scan?(options: { prefix: string; after?: string; limit?: number }): Promise<{ entries?: ReadonlyArray<{ key: string; value: unknown }>; next?: string } | undefined>
  }
  skill?: { transform?(cb: (draft: unknown) => void | Promise<void>): Promise<unknown> }
  // SANDBOX-PENDING: ctx.location as the workspace/directory source follows
  // the conventions §3 mapping (directory/project → ctx.location.*); the
  // exact method names are verified in the sandbox stage. Guarded readers
  // mean a drifted location simply leaves the process cwd as the anchor.
  location?: { worktree?: () => unknown; directory?: () => unknown }
}

// Injection seam for the V2 harness (task 1.2): the resolver runs on real
// fs by default; tests inject a fake fs + explicit anchors + homeDir.
export type V2SetupDeps = {
  anchors?: string[]
  homeDir?: string
  stat?: (path: string) => { mtimeMs: number; size: number } | null
  readFile?: (path: string) => string
  /** Test seam / explicit override for the materialize knob (the real
   * source is the GLOBAL forge.json layer; default "native"). */
  materialize?: ForgeMaterializeKnob
}

// Registry of every workspace anchor this process's v2 entry has been
// initialized in — keyed by the normalized form (dedup, same
// normalizeAnchorDir as the v1 host registry — parity with
// rememberHostAnchor) but carrying the ORIGINAL spelling for resolution:
// the resolver's stat/read and the provenance descriptions must see the
// caller's own path casing (win32 case-fold would corrupt both against an
// injected fs and the user-visible description). Pool membership is
// re-resolved from disk truth on every setup call, so a deleted pool file
// un-materializes on the next init exactly like v1 (no append-only POOL
// set; anchor arrival order never influences ids — the resolver sorts
// families purely lexicographically).
const v2HostAnchors = new Map<string, string>()

// Workspace-anchor candidates for this call: the ctx.location readers plus
// the process cwd. Field-reality probe (2.3.2 live host, 2026-11-20):
// ctx.location.directory is a string PROPERTY carrying the load location and
// ctx.location.worktree does not exist — the earlier function-only guard
// skipped both, leaving the server process cwd (home on paseo-launched
// services) as the sole anchor, so pool workers never materialized outside
// the sandbox (where serve's cwd happened to be the workspace). Accept both
// shapes; never guess.
function v2AnchorCandidates(ctx: V2PluginContext): string[] {
  const out: string[] = []
  try {
    for (const reader of [ctx.location?.worktree, ctx.location?.directory]) {
      const v = typeof reader === "function" ? (reader as () => unknown)() : reader
      if (typeof v === "string" && v) out.push(v)
    }
  } catch {
    // Drifted location: cwd-only resolution (fail-soft).
  }
  out.push(process.cwd())
  return out
}

// Shared JSON Schema builder (task 2.1): translates one tool's
// `tool.schema.*` (zod) argument record into a plain JSON Schema input
// contract for the v2 `editor.add({ input })` shape. io:"input" keeps
// defaulted fields optional; the $schema decorator is dropped (the host
// owns validation, not the dialect header). Builder drift degrades to an
// empty object contract — the tool still registers, only its argument
// documentation thins.
function v2ToolInputSchema(args: Record<string, unknown> | undefined): Record<string, unknown> {
  try {
    const z = tool.schema as unknown as {
      object?: (shape: Record<string, unknown>) => unknown
      toJSONSchema?: (schema: unknown, opts?: { io?: string }) => unknown
    }
    if (typeof z.object === "function" && typeof z.toJSONSchema === "function") {
      const schema = z.toJSONSchema(z.object(args ?? {}), { io: "input" })
      if (schema !== null && typeof schema === "object") {
        const out = { ...(schema as Record<string, unknown>) }
        delete out.$schema
        return out
      }
    }
  } catch {
    // Zod-shape drift: fall through to the minimal contract.
  }
  return { type: "object", properties: {} }
}

// Wrap the shared execute cores' result ({title, output}) in the v2
// structured-content shape.
// SANDBOX-PENDING: the exact V2 tool-result content shape is unverified
// (a later sandbox stage verifies it against the real binary, same
// pattern as the sibling repos); the sensible default is `{ content }`
// until observed reality replaces it.
function wrapV2ToolResult(res: unknown): { content: unknown; title?: unknown } {
  if (res !== null && typeof res === "object" && "output" in (res as Record<string, unknown>)) {
    const r = res as { output?: unknown; title?: unknown }
    return typeof r.title === "string" ? { content: r.output, title: r.title } : { content: r.output }
  }
  return { content: res }
}

// Adapt the v2 ToolContext onto the ToolContext the shared execute cores
// consume. W6a field realities (SDK 2.3.2 promise/tool.d.ts +
// @opencode/schema tool.d.ts Context): the real context is {sessionID,
// agent, messageID, signal, progress, ...} — NO `ask`, NO `worktree`, NO
// `metadata`. The v1 ask-callback DECISION-RETURNING gates
// (plan_approve/goal_write arm/goal_complete/goal_resume/
// goal_discard/crew_close user-confirmation gates inside the tool cores)
// map to ctx.permission.assert(input) ("evaluates rules and prompts the
// user, resolves when allowed, rejects with Tool.Error on deny") — the
// adapter below synthesizes the AskFn the shared cores expect from the
// permission interface of the initialization that REGISTERED the tool
// (fix-ask-door-multi-directory-host: never a module-level "latest init"
// seam — on a multi-directory host that is another directory's interface,
// or an evicted one's). worktree falls back to the
// session-bound map then the host anchor. metadata defaults to a no-op so
// ungated cores run.
type V2AssertFn = (input: unknown) => Promise<void>

// worker-shell-session-allow D2/D4 — the documented session-rule rescue.
// The host's permission assert evaluates the calling agent at the PLUGIN
// HOST's location; a native worker md registers only at the project
// location, so the assert falls back to a literal deny-all BEFORE any
// rule/saved-approval/hook/ask is consulted (v2.3.2 permission.ts,
// missingAgentPermissions — reports/research-plugin-tool-permission.md
// §1). Session rules merge AFTER agent rules with last-match-wins, so one
// appended allow rule restores the documented default-open posture in
// exactly that geometry. Captured alongside the assert bridge; every call
// site guards. The rule is scoped to the forge_shell action alone — it can
// never affect a builtin tool or another plugin.
let v2SessionRuleApi: {
  get: (sessionID: string) => Promise<unknown>
  update: (input: { sessionID: string; permissions: unknown }) => Promise<unknown>
} | null = null

const SESSION_RESCUE_RULE = { action: "forge_shell", resource: "*", effect: "allow" } as const
const sessionRescueInjected = new Set<string>()
const sessionRescueDisclosed = new Set<string>()

function isSessionRescueRule(rule: unknown): boolean {
  if (rule === null || typeof rule !== "object") return false
  const o = rule as { action?: unknown; resource?: unknown; effect?: unknown }
  return o.action === "forge_shell" && o.resource === "*" && o.effect === "allow"
}

// A forge WORKER session (the primary agent id is exactly "forge" — no
// dash — so the prefix test excludes it). Unknown sessions (family-map
// miss) are NOT workers: the rescue never fires for them.
function isForgeWorkerSession(sessionID: string | undefined): boolean {
  if (!sessionID) return false
  const agent = sessionAgents.get(sessionID)
  return typeof agent === "string" && agent.startsWith("forge-")
}

// D4: ensure the session's permission rules END with our allow rule —
// read-back-merge (never clobbers existing rules), idempotent, disabled
// entirely under an explicit user deny (D3: deny is sacred). Returns
// whether the rule is in place after the call; every failure is fail-soft
// (the D5 fallback belt owns the unavailable case).
async function ensureSessionRescueRule(sessionID: string): Promise<boolean> {
  if (!v2SessionRuleApi) return false
  if (sessionRescueInjected.has(sessionID)) return true
  if (explicitForgeShellPosture() === "deny") return false
  try {
    const record = await v2SessionRuleApi.get(sessionID)
    const current =
      record !== null && typeof record === "object" ? (record as Record<string, unknown>).permissions : undefined
    const merged = Array.isArray(current) ? current.slice() : []
    if (merged.some(isSessionRescueRule)) {
      // already in place — mark idempotent, no write
      sessionRescueInjected.add(sessionID)
      return true
    }
    merged.push({ ...SESSION_RESCUE_RULE })
    await v2SessionRuleApi.update({ sessionID, permissions: merged })
    sessionRescueInjected.add(sessionID)
    return true
  } catch {
    return false
  }
}

// D5 disclosure bookkeeping: the fallback belt fires at most one
// diagnostics line + one tool-call metadata title per session.
function markSessionRescueDisclosed(sessionID: string): void {
  if (sessionRescueDisclosed.has(sessionID)) return
  sessionRescueDisclosed.add(sessionID)
  console.warn(
    `[forge:session-rescue] warn: worker session ${sessionID} — the host permission assert fell back to deny-all (cross-anchor agent resolution; README "Native mode — worker shell rescue"); the documented session-rule rescue let this call through.`,
  )
}

// One-shot disclosure side-channel consumed by the forge_shell execute
// (attaches the rescue note to the tool call's metadata title, once).
const sessionRescueAttached = new Set<string>()
function takeSessionRescueDisclosure(sessionID: string): string | null {
  if (!sessionRescueDisclosed.has(sessionID) || sessionRescueAttached.has(sessionID)) return null
  sessionRescueAttached.add(sessionID)
  return "[forge:session-rescue] cross-anchor deny-all rescued via the session rule (see diagnostics)"
}

// Test surface (worker-shell-session-allow tasks 2.1–2.4): unit seams over
// module state that production reaches only through host surfaces. Nothing
// here runs in production paths.
export const __workerShellRescueTestSurface = {
  setPosture(value: "allow" | "deny" | "ask" | undefined) {
    v2PostureTestOverride = { value }
  },
  clearPosture() {
    v2PostureTestOverride = null
  },
  setHostSeen(value: boolean) {
    v2HostSeen = value
  },
  setSessionRuleApi(api: {
    get: (sessionID: string) => Promise<unknown>
    update: (input: { sessionID: string; permissions: unknown }) => Promise<unknown>
  } | null) {
    v2SessionRuleApi = api
  },
  setFamily(sessionID: string, agent: string | undefined) {
    if (agent === undefined) sessionAgents.delete(sessionID)
    else sessionAgents.set(sessionID, agent)
  },
  ensure: ensureSessionRescueRule,
  isWorker: isForgeWorkerSession,
  gate: forgeShellGate,
  markDisclosed: markSessionRescueDisclosed,
  takeDisclosure: takeSessionRescueDisclosure,
  resetState() {
    sessionRescueInjected.clear()
    sessionRescueDisclosed.clear()
    sessionRescueAttached.clear()
  },
}

// fix-multi-location-session-anchor (design D1 方案甲 item 2): the session's
// directory straight from the HOST's own session record — the record's
// {worktree, directory | location.directory}, else the same read on each
// `parentID` up the chain (bounded, cycle-safe). "" when the host gives
// nothing. Read through the REGISTERING initialization's own client (the
// tool closure's `ctx`), never a module-level "latest init" seam: on a
// multi-directory host the latest-initialized directory is another
// directory's — or already evicted.
type V2AnchorReader = { session?: { get?: (opts: unknown) => Promise<unknown> } } | null | undefined
const HOST_DIRECTORY_WALK_MAX = 8

async function hostSessionDirectory(anchorClient: V2AnchorReader, sessionID: string): Promise<string> {
  const get = anchorClient?.session?.get
  if (!sessionID || typeof get !== "function") return ""
  const seen = new Set<string>()
  let id = sessionID
  while (id && seen.size < HOST_DIRECTORY_WALK_MAX) {
    if (seen.has(id)) return ""
    seen.add(id)
    let rec: unknown
    try {
      rec = await get({ path: { id } })
    } catch {
      return ""
    }
    if (rec === null || typeof rec !== "object") return ""
    const r = rec as { worktree?: unknown; directory?: unknown; location?: { worktree?: unknown; directory?: unknown } | null; parentID?: unknown }
    const str = (v: unknown): string => (typeof v === "string" ? v : "")
    const here = effectiveWorktree(str(r.worktree), str(r.directory) || str(r.location?.directory))
    if (here && !isRootish(here)) return here
    id = typeof r.parentID === "string" ? r.parentID : ""
  }
  return ""
}

type V2ToolContextResolution = { context: Record<string, unknown>; defaultDirectory: string | null }

async function v2ToolContext(raw: unknown, anchorClient: V2AnchorReader = anchorClientShared, assertFn: V2AssertFn | null = null): Promise<V2ToolContextResolution> {
  const c = (raw ?? {}) as Record<string, unknown>
  const pickStr = (...keys: string[]): string | undefined => {
    for (const k of keys) {
      const v = c[k]
      if (typeof v === "string" && v) return v
    }
    return undefined
  }
  const out: Record<string, unknown> = { ...c }
  if (out.sessionID === undefined) out.sessionID = pickStr("sessionId", "session_id")
  if (out.worktree === undefined) out.worktree = pickStr("worktree", "directory")
  if (out.worktree === undefined && typeof out.sessionID === "string") out.worktree = sessions.get(out.sessionID)?.worktree
  // fix-multi-location-session-anchor item 2: the host's session record sits
  // BETWEEN the in-memory binding and the plugin-level default. A session
  // with no binding yet (a just-created child, anything after a host
  // restart) used to land on the default — which on a multi-directory host
  // is the LAST-initialized directory.
  if (out.worktree === undefined && typeof out.sessionID === "string" && out.sessionID) out.worktree = (await hostSessionDirectory(anchorClient, out.sessionID)) || undefined
  // Item 3: the plugin-level default is the LAST resort, and a session that
  // lands on it is TOLD so in the tool result (defaultDirectory).
  let defaultDirectory: string | null = null
  if (out.worktree === undefined) {
    out.worktree = hostWorktree
    if (typeof out.sessionID === "string" && out.sessionID) defaultDirectory = hostWorktree || null
  }
  // fix-ask-door-multi-directory-host D2: the ask behind every door and
  // behind forge_shell goes through the interface the REGISTERING
  // initialization handed in — the one bound to the directory whose
  // sessions run this closure. Given none, no ask is synthesized and the
  // door refuses by name in gate() (fail-closed). There is deliberately NO
  // fallback to "the latest initialization's" interface.
  if (typeof out.ask !== "function" && assertFn && typeof out.sessionID === "string" && out.sessionID) {
    const sid = out.sessionID
    const agentId = typeof out.agent === "string" && out.agent ? out.agent : undefined
    const askHost = assertFn
    out.ask = (askInput: { permission: string; patterns: string[]; metadata: Record<string, unknown> }) =>
      askHost({
        sessionID: sid,
        ...(agentId !== undefined ? { agent: agentId } : {}),
        action: askInput.permission,
        resources: Array.isArray(askInput.patterns) ? askInput.patterns : ["*"],
        metadata: askInput.metadata,
      })
  }
  if (typeof out.metadata !== "function") out.metadata = () => {}
  return { context: out, defaultDirectory }
}

// fix-multi-location-session-anchor item 3: the one sentence that names the
// default directory a call ran in (appended to a text result only).
const V2_DEFAULT_DIRECTORY_NOTE = "[forge] The host gave no workspace for this session (no directory in the session record), so this call ran in the plugin's default directory"

function nameDefaultDirectory(wrapped: { content: unknown; title?: unknown }, defaultDirectory: string | null): { content: unknown; title?: unknown } {
  if (defaultDirectory === null || typeof wrapped.content !== "string") return wrapped
  return { ...wrapped, content: `${wrapped.content}\n\n${V2_DEFAULT_DIRECTORY_NOTE}: ${defaultDirectory}` }
}

// Test surface (fix-multi-location-session-anchor D3,
// fix-session-anchor-ledger-use-time-path D3): the resolver, the in-memory
// binding and the ledger path, for the unit tests. Nothing here runs in a
// production path.
export const __sessionAnchorTestSurface = {
  hostSessionDirectory,
  resolveToolContext: (raw: unknown, anchorClient?: V2AnchorReader, assertFn?: V2AssertFn | null) => v2ToolContext(raw, anchorClient ?? undefined, assertFn ?? null),
  worktreeOf: (sessionID: string): string | null => sessions.get(sessionID)?.worktree ?? null,
  bindChildToDirectory,
  sessionAnchorLedgerPath,
  noteLedgerBinding: noteSessionAnchorLedgerBinding,
}

// ---------------------------------------------------------------------------
// v2 W3/W4 wiring (tasks 3.1 / 4.1 / 4.2 / 4.3): the permission belt, the
// tool execute.before/after seams, the session prompt/context/compaction
// seams, and the /plan /goal /crew command registrations. Every handler is
// a port of the corresponding v1 hook body over the SAME module-level state
// and the SAME shared predicates (crewPendingRefusal / poolGateRefusal /
// crewComplianceRefusalFor / draftDispatchRefusal / stateForBan / ...) —
// one code path per concern. The only deltas are the event adapters
// (SANDBOX-PENDING field names per conventions §4.4 — the W6 sandbox pins
// them; noted in the change design's Open Questions) and posture:
// refusal belts signal by throwing INSIDE the hook callback exactly like
// v1 tool.execute.before; injection/mutation handlers are try/catch
// fail-soft so a drifted event shape degrades to a no-op, never a throw.
// The v1-only watchdog blocks are deliberately absent here (the watchdog
// instance is created inside server(); a v2 watchdog rides a later wave
// once ctx.options pin the option surface).
// ---------------------------------------------------------------------------

// String pick over an assumed-shape event (never throws).
function v2PickStr(src: unknown, ...keys: string[]): string | undefined {
  if (src === null || typeof src !== "object") return undefined
  const o = src as Record<string, unknown>
  for (const k of keys) {
    const v = o[k]
    if (typeof v === "string" && v) return v
  }
  return undefined
}

// Agent name from an assumed-shape event: string verbatim, or { name }.
function v2AgentNameOf(src: unknown): string | undefined {
  if (src === null || typeof src !== "object") return undefined
  const a = (src as Record<string, unknown>).agent
  if (typeof a === "string" && a) return a
  if (a !== null && typeof a === "object") {
    const n = (a as Record<string, unknown>).name
    if (typeof n === "string" && n) return n
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Permission belt (task 3.1) — ctx.permission.hook("evaluate")
// ---------------------------------------------------------------------------

// fix-crew-close-ask-door D2 — DERIVED from GATE_PERMISSION_KEYS, never
// hand-listed. The user-confirmation doors are exactly the non-exec gate()
// permission keys (six today: plan_approve, goal_write, goal_complete,
// goal_resume, goal_discard, crew_close). On a v2 host a tool's ask IS the
// host's ctx.permission.assert, so the dialog a door needs exists only if
// THIS belt rewrites the host's "allow" to "ask" on every evaluation. This
// set used to be a second, hand-copied list without crew_close — which let
// crew_close end a crew without asking (present since the v2 port).
// forge_shell is deliberately absent (pass-through, shell-defang-default-
// open); plan_close is plugin-verified, not a door (plan-close-verified).
const V2_PERMISSION_DOORS = new Set<string>(GATE_PERMISSION_KEYS.filter((key) => key !== "forge_shell"))

// Test surface (fix-crew-close-ask-door D4): the two lists above are
// module-level constants production reaches only through gate() and the
// belt. Nothing here runs in production paths.
export const __permissionDoorsTestSurface = {
  gateKeys: GATE_PERMISSION_KEYS,
  v2Doors: V2_PERMISSION_DOORS,
}

function v2RegisterPermissionBelt(ctx: V2PluginContext): void {
  if (typeof ctx.permission?.hook !== "function") return
  try {
    // W6a: the evaluate callback receives a MUTABLE PermissionEvaluation
    // ({sessionID, agent?, action, resources, metadata?, source?, effect,
    // message?}) and signals by MUTATING input.effect — the @opencode/schema
    // Permission.Effect union is exactly "allow" | "deny" | "ask"
    // (permission.d.ts: `Schema.Literals<readonly ["allow", "deny", "ask"]>`).
    // Name chain (v1 parity, pruned to the fields the real type carries):
    // metadata.tool → action. No status/decision/outcome slot exists.
    ctx.permission.hook("evaluate", async (raw: unknown) => {
      try {
        const evalInput = raw !== null && typeof raw === "object" ? (raw as { sessionID?: unknown; agent?: unknown; action?: unknown; metadata?: unknown; effect?: unknown; message?: unknown }) : null
        if (!evalInput || typeof evalInput.effect !== "string") return
        const meta = (evalInput.metadata !== null && typeof evalInput.metadata === "object" ? evalInput.metadata : {}) as Record<string, unknown>
        const name = (typeof meta.tool === "string" ? meta.tool : undefined) ?? (typeof evalInput.action === "string" ? evalInput.action : undefined)
        if (process.env.FORGE_PERM_PROBE) {
          try {
            appendFileSync(join(probeTmp(), "forge-perm-probe.log"), `${new Date().toISOString()} v2-evaluate name=${JSON.stringify(name)} effect=${evalInput.effect} raw=${JSON.stringify(raw).slice(0, 300)}\n`)
          } catch {}
        }
        if (typeof name === "string" && V2_PERMISSION_DOORS.has(name)) {
          // Doors: keep it a REAL ask unless explicitly denied — the user
          // confirmation (the ask prompt the host raises for effect "ask")
          // is the gate (v1 parity). forge_shell is deliberately absent
          // (pass-through, shell-defang-default-open).
          if (evalInput.effect !== "deny") evalInput.effect = "ask"
          return
        }
        if (typeof name === "string" && isWriteTool(name)) {
          const sessionID = typeof evalInput.sessionID === "string" ? evalInput.sessionID : undefined
          const state = stateForBan(sessionID)
          const active = state ? resolveActivePlan(state) : null
          if (active && active.doc.status === "draft") {
            evalInput.effect = "deny"
            evalInput.message = "[forge] A plan is in draft; write operations are denied. Switch back to the forge agent to present it and complete plan approval (plan_approve), or run /plan discard to abandon the plan."
          }
        }
      } catch {
        // Belt posture: never throw into the host (fail-open on drift).
      }
    })
  } catch {
    // Drifted permission domain: silent no-op.
  }
}

// ---------------------------------------------------------------------------
// Tool execute seams (task 4.1) — ctx.tool.hook("execute.before"/"after")
// ---------------------------------------------------------------------------

// W6a field reality (SDK 2.3.2 promise/tool.d.ts ToolHooks): the
// execute.before payload is {tool, sessionID, agent, messageID,
// id: Tool.CallID, input} — the v1 callID field is named `id` in v2 and
// the arguments live under `input` (legacy spellings kept as harmless
// fallbacks for the mock drift matrix).
function v2ToolEventArgs(raw: unknown): { tool: string | undefined; sessionID: string | undefined; id: string | undefined; args: Record<string, unknown> } {
  if (raw === null || typeof raw !== "object") return { tool: undefined, sessionID: undefined, id: undefined, args: {} }
  const o = raw as Record<string, unknown>
  const tool = typeof o.tool === "string" ? o.tool : undefined
  const sessionID = v2PickStr(o, "sessionID", "sessionId")
  const id = v2PickStr(o, "id", "callID")
  const rawArgs = o.input ?? o.args ?? o.arguments
  const args = rawArgs !== null && typeof rawArgs === "object" ? (rawArgs as Record<string, unknown>) : {}
  return { tool, sessionID, id, args }
}

// Session-domain adapter for the shared dispatch-belt predicates: a v2
// session.get() feeds the authoritative session record exactly like the v1
// client.session.get seam; absent => null (predicates fall back to the
// in-memory map, then the fail-open posture).
function v2AnchorClient(ctx: V2PluginContext): { session?: { get?: (opts: unknown) => Promise<unknown> } } | null {
  const rawGet = typeof ctx.session?.get === "function" ? ctx.session.get.bind(ctx.session) : undefined
  if (!rawGet) return null
  // Same flat-{sessionID} translation as v2SessionClient (W6a field
  // reality): the dispatch-belt predicates call the v1 {path:{id}} shape.
  const get = async (opts: unknown) => {
    const sid = v2SessionIdOf(opts)
    return sid !== undefined ? rawGet({ sessionID: sid }) : rawGet(opts)
  }
  return { session: { get } }
}

function v2RegisterToolHooks(ctx: V2PluginContext, anchorClient: { session?: { get?: (opts: unknown) => Promise<unknown> } } | null): void {
  if (typeof ctx.tool?.hook !== "function") return
  try {
    // Port of the v1 "tool.execute.before" belt (watchdog block excepted —
    // see the region comment). Refusals throw; every message is verbatim
    // v1. Unknown sessions fail open on every belt.
    ctx.tool.hook("execute.before", async (raw: unknown) => {
      const { tool, sessionID, args } = v2ToolEventArgs(raw)
      // Strongest family-map source parity (tool context): an agent field
      // on the event is an authoritative speaker statement.
      const evAgent = v2AgentNameOf(raw)
      if (evAgent && sessionID) sessionAgents.set(sessionID, evAgent)
      if (process.env.FORGE_PERM_PROBE) {
        try {
          appendFileSync(join(probeTmp(), "forge-perm-probe.log"), `${new Date().toISOString()} v2-before tool=${JSON.stringify(tool)} session=${JSON.stringify(sessionID)}\n`)
        } catch {}
      }
      // Dispatch belt (tool-partition): a non-forge session must not spawn
      // forge-* workers. Unknown sessions fail open.
      if (tool === "task") {
        const target = typeof args.subagent_type === "string" ? args.subagent_type : typeof args.agent === "string" ? args.agent : undefined
        const speaker = sessionID ? sessionAgents.get(sessionID) : undefined
        if (speaker !== undefined && !isForgeFamilyAgent(speaker)) {
          if (target && target.toLowerCase().startsWith("forge-")) {
            throw new Error(
              `[forge:partition] Dispatch refused: "${target}" is a forge-family worker and the current agent ("${speaker}") is outside the forge family. Use the native general/explore subagents, or switch to the forge agent to dispatch forge-* workers.`,
            )
          }
        }
        // Session-domain pool gate (sole-pool-ownership).
        if (target && target.toLowerCase().startsWith("forge-") && sessionID) {
          const poolRefusal = await poolGateRefusal(anchorClient, sessionID, target)
          if (poolRefusal) throw new Error(poolRefusal)
        }
        // Crew pending belt (crew-harness).
        const pendingRefusal = crewPendingRefusal(sessionID)
        if (pendingRefusal) throw new Error(pendingRefusal)
        // Crew compliance belt (pool-namespace-contract) — after the pool
        // gate, composing without replacing it.
        if (target && target.toLowerCase().startsWith("forge-") && sessionID) {
          const complianceRefusal = await crewComplianceRefusalFor(anchorClient, sessionID, target)
          if (complianceRefusal) throw new Error(complianceRefusal)
        }
      }
      // State-file boundary (tool-partition).
      if ((tool === "write" || tool === "edit") && sessionID) {
        const speaker = sessionAgents.get(sessionID)
        if (speaker !== undefined && !isForgeFamilyAgent(speaker)) {
          const raw = typeof args.filePath === "string" ? args.filePath : typeof args.path === "string" ? args.path : undefined
          if (raw) {
            const state = stateForBan(sessionID)
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
      if (typeof tool === "string" && isWriteTool(tool)) {
        const state = stateForBan(sessionID)
        const active = state ? resolveActivePlan(state) : null
        if (active && active.doc.status === "draft") {
          if (tool === "task") {
            // allow-readonly-recon: carve-out keyed on the TARGET's shape.
            const target = typeof args.subagent_type === "string" ? args.subagent_type : typeof args.agent === "string" ? args.agent : undefined
            const refusal = draftDispatchRefusal(sessionID, target)
            if (refusal) throw new Error(refusal)
          } else {
            throw new Error(
              `[forge] A plan is in draft; write operations are denied (${tool}). Switch back to the forge agent to present it and complete plan approval (plan_approve), or run /plan discard to abandon the plan.`,
            )
          }
        }
      }
      // Exec seal (readonly-exec-seal): explicit-readonly forge-* workers
      // get WRITE-CLASS forge_shell commands denied before spawn.
      if (tool === "forge_shell" && sessionID) {
        const cmd = typeof args.command === "string" ? args.command : undefined
        if (cmd) {
          const speaker = sessionAgents.get(sessionID)
          const workerId =
            speaker !== undefined && isForgeFamilyAgent(speaker) && speaker.toLowerCase() !== FORGE_AGENT ? speaker.slice("forge-".length) : undefined
          if (workerId !== undefined) {
            const def = resolvePools()?.agents[workerId]?.def
            if (def !== undefined && effectiveReadonlyShape(def)) {
              const verdict = classifyExecCommand(cmd)
              if (verdict.klass === WRITE_CLASS) {
                const seen = sealFindings.get(sessionID) ?? new Set<string>()
                if (!seen.has(verdict.indicator!)) {
                  seen.add(verdict.indicator!)
                  sealFindings.set(sessionID, seen)
                  console.warn(
                    `[forge:seal] session ${sessionID} (readonly worker "${speaker}"): write-class forge_shell command denied — indicator "${verdict.indicator}" (${verdict.detail ?? cmd.slice(0, 60)}). Remedy: "shape": "write" on the agent when its job legitimately mutates.`,
                  )
                }
                throw new Error(
                  `[forge:seal] Exec refused: this session runs the readonly worker "${speaker}" (explicit "shape": "readonly") and the command was classified WRITE-CLASS — indicator "${verdict.indicator}"${verdict.detail ? ` (${verdict.detail})` : ""}. READ-CLASS commands (inspection, search, read-only evals) flow normally. If this worker's job legitimately mutates, set "shape": "write" on its forge.json entry. Report this refusal VERBATIM — do not work around it.`,
                )
              }
            }
          } else if (speaker === undefined) {
            const verdict = classifyExecCommand(cmd)
            if (verdict.klass === WRITE_CLASS && !sealUnknownNotes.has(sessionID)) {
              sealUnknownNotes.add(sessionID)
              console.warn(
                `[forge:seal] session ${sessionID}: a WRITE-CLASS forge_shell command (${verdict.indicator}) flowed UNSEALED — the session's agent is unknown (fail-open; the exec seal binds explicit-readonly forge-* workers only).`,
              )
            }
          }
        }
      }
      // Partition fallback belts (tool-partition fallback requirement).
      if (sessionID && typeof tool === "string") {
        const speaker = sessionAgents.get(sessionID)
        if (speaker !== undefined) {
          if (!isForgeFamilyAgent(speaker) && FORGE_TOOL_SET.has(tool)) {
            throw new Error(
              `[forge:partition] Tool refused: "${tool}" belongs to the forge agent family and the current agent ("${speaker}") is outside it. Switch to forge (Tab) to use forge tooling.`,
            )
          }
          if (isForgeFamilyAgent(speaker) && (tool === "shell" || tool === "bash") && !jobsKeepBuiltinShell && jobStage() < 2) {
            throw new Error(
              `[forge:partition] Builtin shell refused: the forge family executes through forge_shell (jobs.keepBuiltinShell or jobs.mode: "native" restores the builtin shell). Re-issue the command through forge_shell.`,
            )
          }
          // R1 third quadrant: STATE tools are primary-only.
          if (isForgeFamilyAgent(speaker) && speaker.toLowerCase() !== FORGE_AGENT && FORGE_STATE_TOOL_SET.has(tool)) {
            throw new Error(
              `[forge:partition] Tool refused: "${tool}" is a harness state tool reserved for the primary forge agent; "${speaker}" is a forge worker. Report your findings back to the orchestrating session — the primary agent calls ${tool} at the gate.`,
            )
          }
        }
      }
    })
    // Port of the v1 "tool.execute.after" activity ledger (watchdog untrack
    // excepted). Never throws.
    ctx.tool.hook("execute.after", async (raw: unknown) => {
      try {
        const { tool, sessionID } = v2ToolEventArgs(raw)
        if (typeof tool !== "string" || !sessionID) return
        const act = turnActivity.get(sessionID)
        if (act) {
          if (isWriteTool(tool) || tool === "plan_tick") act.writes++
          // goal-no-progress-honesty: exec-class verification commands score
          // like goal_check (mirror of the v1 activity ledger).
          if (tool === "goal_check" || tool === "forge_shell" || tool === "shell" || tool === "bash") act.checks++
        }
        const crewAct = crewTurnActivity.get(sessionID)
        if (crewAct) {
          if (tool === "task") crewAct.dispatches++
          if (isWriteTool(tool)) crewAct.writes++
        }
      } catch {}
    })
  } catch {
    // Drifted tool-hook surface: silent no-op (transform may still work).
  }
}

// ---------------------------------------------------------------------------
// Session seams (task 4.2) — ctx.session.hook("prompt"/"context"/"compaction")
// ---------------------------------------------------------------------------

// The context handler merges the v1 chat.params port (family upsert +
// frozen depth injection onto event.options) with the v1
// experimental.chat.system.transform port (family-gated system injections
// onto event.system) — Decision 3's event topology: capture happens in
// prompt + execute.before; the context handler reads the map.
function v2ContextInjection(raw: unknown): void {
  if (forgeDisabled) return
  const o = raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : {}
  const sessionID = v2PickStr(o, "sessionID", "sessionId")
  if (!sessionID) return
  const agentName = v2AgentNameOf(o)
  if (agentName) sessionAgents.set(sessionID, agentName)
  // worker-shell-session-allow D4 (inheritance channel): seed the rescue
  // rule on the forge PRIMARY session — child worker sessions created
  // AFTER this inherit the session rules in effect at creation (official
  // semantics), so most workers never even reach the belt. Fire-and-forget:
  // the first-turn race is covered by the worker-side belt in the
  // forge_shell execute.
  if (agentName === FORGE_AGENT) void ensureSessionRescueRule(sessionID).catch(() => {})
  // Session-model capture (harden-dispatch-resilience D3, v2 port): the
  // context payload's resolved model seeds the same session→model table.
  {
    const capObj = o.model as { providerID?: unknown; id?: unknown; modelID?: unknown } | undefined
    const capProvider = typeof capObj?.providerID === "string" ? capObj.providerID : ""
    const capModel = typeof capObj?.modelID === "string" ? capObj.modelID : typeof capObj?.id === "string" ? capObj.id : ""
    if (capProvider && capModel) sessionModels.set(sessionID, { provider: capProvider, model: capModel })
  }
  // --- depth injection (chat.params port) ---
  if (agentName && agentName.startsWith("forge-")) {
    const agentId = agentName.slice("forge-".length)
    // Runtime model pin (v2-runtime-model-pin): the draft model field is
    // V1-only (the host's /api/agent encoder 500s on it), so the pin applies
    // HERE — the context payload carries the resolved model (SessionRequest),
    // and mutations on this payload demonstrably propagate on 2.3.2 (the
    // same mechanism as the options/system injections below; the resolve
    // hook clone-eats mutations, the context hook does not). Resolve fresh
    // per request (hot-apply); malformed pins skip silently (D3).
    const pinnedDef: ForgeAgentDef | undefined = resolvePools()?.agents[agentId]?.def
    if (pinnedDef?.model) {
      const identity = parseIdentity(pinnedDef.model)
      if (identity && o.model && typeof o.model === "object") {
        const before = JSON.stringify(o.model)
        const m = o.model as { providerID?: unknown; id?: unknown; modelID?: unknown; variant?: unknown }
        // Variant rewrite rule (fix-runtime-model-pin-variant D1): when the
        // pinned identity EQUALS the resolved identity, the rewrite is an
        // invisible no-op — only the spellings are normalized and the
        // host-resolved #variant (e.g. from a `.md` model string) SURVIVES.
        // When the pin swaps the model: a variant-word thoughtLevel derives
        // the new variant; anything else deletes it (a stale variant of a
        // different model is meaningless). Host contract
        // (fix-dispatch-model-pin-shape): the runner composes providerID +
        // "/" + model.id — `id`/`modelID` stay BARE here, same as the
        // dispatch-async create seam (guarded by unit tests there).
        const resolvedModel = typeof m.modelID === "string" ? m.modelID : typeof m.id === "string" ? m.id : ""
        const identityEquals =
          m.providerID === identity.provider && resolvedModel === identity.model
        const recipeDepth = typeof pinnedDef.thoughtLevel === "string" ? pinnedDef.thoughtLevel : ""
        m.providerID = identity.provider
        m.id = identity.model
        m.modelID = identity.model
        if (identityEquals) {
          // keep m.variant untouched (host-resolved depth survives)
        } else if (VARIANT_DEPTH_WORDS.includes(recipeDepth)) {
          m.variant = recipeDepth
        } else {
          delete m.variant
        }
        if (process.env.FORGE_MODEL_PROBE) {
          try {
            appendFileSync(
              join(probeTmp(), "forge-model-probe.log"),
              `${new Date().toISOString()} sid=${sessionID} agent=${agentName} rewrite ${before} -> ${JSON.stringify(o.model)}\n`,
            )
          } catch {}
        }
      }
    }
    const frozen = sessionDepths.get(sessionID)
    if (frozen) {
      if (frozen.translation) {
        if (o.options === null || typeof o.options !== "object") o.options = {}
        applyDepthTranslation(o.options as Record<string, unknown>, frozen.translation)
      }
    } else {
      const def = pinnedDef
      if (def?.thoughtLevel) {
        const modelObj = o.model as { modelID?: unknown; id?: unknown; providerID?: unknown } | undefined
        const providerID = typeof modelObj?.providerID === "string" ? modelObj.providerID : ""
        const modelID = typeof modelObj?.modelID === "string" ? modelObj.modelID : typeof modelObj?.id === "string" ? modelObj.id : ""
        const channel = resolveDepthChannel(providerID, modelID)
        const { translation, findingMessage } = resolvePinnedDepth(def.thoughtLevel, channel)
        sessionDepths.set(sessionID, { translation })
        if (translation) {
          if (o.options === null || typeof o.options !== "object") o.options = {}
          applyDepthTranslation(o.options as Record<string, unknown>, translation)
        } else if (findingMessage && !depthFindingNotes.has(agentId)) {
          depthFindingNotes.set(agentId, findingMessage)
          console.warn(`[forge:depth] agent forge-${agentId}: ${findingMessage}`)
        }
      }
    }
  }
  // --- system injections (experimental.chat.system.transform port) ---
  // Family gate (tool-partition): EVERY forge-authored system text is
  // forge-family-only; unknown sessions receive nothing (fail-silent).
  if (!sessionIsForgeFamily(sessionID)) return
  if (!Array.isArray(o.system)) o.system = []
  const system = o.system as unknown[]
  const crewActive = crews.get(sessionID)
  if (crewActive && !system.some((s) => typeof s === "string" && s.startsWith("[forge:crew-active]"))) {
    const modeText = crewActive.mode === "pending"
      ? "PENDING (present the execution-mode choice; every task dispatch is refused until armed)"
      : "armed (executing)"
    system.push(`[forge:crew-active] A crew is ${modeText} in this session: "${crewActive.objective}" (started ${crewActive.startedAt}). A second /crew must be refused; finish with crew_close when every subtask has a verdict, or crew_close {abandon: true, reason} to re-shard.`)
  }
  if (!forgeDisabled && jobStage() < 2 && !system.some((s) => typeof s === "string" && s.startsWith("[forge:job-guidance]"))) {
    system.push(
      jobsKeepBuiltinShell
        ? "[forge:job-guidance] Long-running or possibly non-exiting shell commands (dev servers, watchers, installers, anything spawning detached children) go through forge_shell, never the builtin shell: it returns on idle/success/exit with a jobId instead of blocking indefinitely; manage jobs with forge_jobs. Delegated agents: collect your job results with forge_jobs poll before yielding your conclusion."
        : "[forge:job-guidance] Every shell command — quick ones included — goes through forge_shell: the builtin shell/bash tools are refused on this agent, so never try them first. forge_shell returns on exit/success/idle with a jobId instead of blocking indefinitely; long-running or non-exiting commands use run_in_background. Manage jobs with forge_jobs. Delegated agents: collect your job results with forge_jobs poll before yielding your conclusion.",
    )
  }
  const state = sessions.get(sessionID)
  if (!state) return
  const active = resolveActivePlan(state)
  if (active) {
    const p = progressOf(active.doc)
    const rel = relFrom(state.worktree, active.path)
    const rule =
      active.doc.status === "draft"
        ? "while in draft, write operations are denied at the tool layer; present the plan then end your turn to await the user's review — on feedback revise via plan_write and re-present; call plan_approve only after the user explicitly approves in chat (their confirmation dialog is the final gate); /plan discard to abandon"
        : "call plan_tick immediately after each completed task; when all are done, self-check every acceptance criterion and call plan_close — the plugin re-runs the frozen verification checks itself (fail-closed, no dialog) and writes an evidence summary the user reviews asynchronously"
    system.push(
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
    system.push(
      `[forge:goal-notice] This session is bound to a goal: ${rel} (status: ${d.status}${d.stopReason ? `, stopped: ${d.stopReason}` : ""}, revision ${d.revision}, ${d.turnsUsed}/${d.maxTurns} turns used). Rule: ${rule}. If the user has not mentioned the goal yet, relay its path and status to them in one short line at the start of your reply.`,
    )
  }
}

// Goal-brief reinjection (experimental.session.compacting port): the goal
// facts ride along in the compaction context so post-compaction turns keep
// following the goal (compression-safety carrier).
function v2CompactionInjection(raw: unknown): void {
  if (forgeDisabled) return
  const o = raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : {}
  const sessionID = v2PickStr(o, "sessionID", "sessionId")
  if (!sessionID) return
  if (!sessionIsForgeFamily(sessionID)) return
  const state = sessions.get(sessionID)
  if (!state) return
  const goal = resolveLiveGoal(state)
  if (!goal) return
  const d = goal.doc
  if (!Array.isArray(o.context)) o.context = []
  ;(o.context as unknown[]).push(
    `[forge:goal-brief] A live goal governs this session: ${relFrom(state.worktree, goal.path)} (status: ${d.status}, revision ${d.revision}, ${d.turnsUsed}/${d.maxTurns} turns used). Goal: ${d.goal}. Success criteria:\n${d.criteria
      .map((c, i) => `${i + 1}. ${c}`)
      .join("\n")}\nPost-compaction turns must keep following this goal and its constraints.`,
  )
}

function v2RegisterSessionHooks(ctx: V2PluginContext, goalClient: GoalClient | null): { disposables: Array<() => void>; idleHook: boolean } {
  const out = { disposables: [] as Array<() => void>, idleHook: false }
  if (typeof ctx.session?.hook !== "function") return out
  const register = (name: string, cb: (raw: unknown) => void): boolean => {
    try {
      const registration = ctx.session!.hook!(name, cb)
      // Registration is {dispose: () => Promise<void>} (registration.d.ts);
      // collect whichever dispose-like shape the host handed back.
      if (registration !== null && typeof registration === "object" && typeof (registration as { dispose?: unknown }).dispose === "function") {
        const dispose = (registration as { dispose: () => unknown }).dispose
        out.disposables.push(() => void dispose())
      }
      return true
    } catch {
      // One drifted hook name never blocks the siblings.
      return false
    }
  }
  // chat.message port (family capture, primary source): a turn just
  // started — the session is busy until the next idle (wake-push gate).
  // W6a: SessionPrompt carries {sessionID, messageID, prompt, metadata?,
  // delivery} — NO agent field, so family capture rides the context hook
  // (SessionContext.agent) and execute.before's agent; the v1 agent
  // reader stays as a harmless pass-through.
  register("prompt", async (raw: unknown) => {
    try {
      if (forgeDisabled) return
      const sessionID = v2PickStr(raw, "sessionID", "sessionId")
      if (!sessionID) return
      idleJobSessions.delete(sessionID)
      const agent = v2AgentNameOf(raw)
      if (agent) sessionAgents.set(sessionID, agent)
    } catch {}
  })
  register("context", async (raw: unknown) => {
    try {
      v2ContextInjection(raw)
    } catch {}
  })
  register("compaction", async (raw: unknown) => {
    try {
      v2CompactionInjection(raw)
    } catch {}
  })
  // W6a CHOICE (documented in design.md Open Questions): the idle edge —
  // goal continuation + job-wake delivery — rides the IN-PROCESS
  // ctx.session.hook("experimental.idle") (SessionIdle {sessionID,
  // background[]}, session.d.ts: "runs when a Session finishes model work
  // and has no pending input, just before it goes idle"): no SSE race,
  // richer background info, and notices the hook admits run in the same
  // execution. The SSE session.execution.succeeded edge stays only as the
  // event-domain fallback (see v2SubscribeEvents). The work itself is
  // DETACHED (void) so the hook returns promptly — the host proceeds to
  // idle while the continuation/wake sends settle on their own.
  out.idleHook = register("experimental.idle", async (raw: unknown) => {
    const sessionID = v2PickStr(raw, "sessionID", "sessionId")
    if (!sessionID) return
    v2HandleIdle(sessionID, goalClient)
  })
  return out
}
// ---------------------------------------------------------------------------
// Commands (task 4.3) — ctx.command.transform, create-only, templates
// byte-identical by construction (the SAME constants/functions the v1
// config hook registers — they ship in dist unchanged).
// ---------------------------------------------------------------------------

async function v2RegisterCommands(ctx: V2PluginContext): Promise<void> {
  if (typeof ctx.command?.transform !== "function") return
  try {
    await ctx.command.transform(async (editor) => {
      // W6a field reality (SDK 2.3.2 promise/command.d.ts + live host): the
      // v2 CommandDefinition is EXECUTE-based — {name, description?,
      // execute({sessionID, prompt, delivery})} — the editor exposes ONLY
      // add() (no get), so the v1 create-only rule is NOT implementable on
      // the v2 domain (documented drift in design.md; the host dedupes or
      // last-wins). Each v1 template command becomes an executable that
      // sends the SAME template text into the invoking session — the
      // templates stay byte-identical by construction (same constants).
      const addFn = editor?.add
      if (typeof addFn !== "function") {
        console.warn("forge: command domain editor drifted — add() missing; commands not registered")
        return
      }
      const addTemplateCommand = (name: string, template: () => string, description: string) => {
        addFn({
          name,
          description,
          // Task 4.1 (change v2-command-surface): the v2 host passes typed
          // arguments in `prompt.text` and does NO $ARGUMENTS substitution
          // for plugin commands — the registrar composes (upstream
          // evaluateTemplate parity) and passes the delivery hint through.
          execute: async (input: { sessionID?: unknown; prompt?: unknown; delivery?: unknown }) => {
            const sessionID = typeof input?.sessionID === "string" ? input.sessionID : undefined
            if (!sessionID || typeof ctx.session?.prompt !== "function") return
            const promptShape = input?.prompt as { text?: unknown } | undefined
            const typed =
              promptShape && typeof promptShape === "object" && typeof promptShape.text === "string" ? promptShape.text : undefined
            const text = composeCommandPrompt(template(), typed)
            const delivery = typeof input?.delivery === "string" && input.delivery ? input.delivery : undefined
            try {
              await ctx.session.prompt(delivery ? { sessionID, text, delivery } : { sessionID, text })
            } catch (e) {
              // Delivery rides the send; a drifted host schema that rejects
              // the extra key degrades DISCLOSED (retry without it) — never
              // silently, never a non-schema error swallowed.
              if (!delivery) throw e
              const head = `${(e as Error)?.name ?? ""} ${(e as Error)?.message ?? String(e)}`
              if (!/schema/i.test(head)) throw e
              console.warn(`forge: command '${name}' delivery hint rejected by host prompt schema — delivering without it (${head.slice(0, 120)})`)
              await ctx.session.prompt({ sessionID, text })
            }
          },
        })
      }
      addTemplateCommand(
        "plan",
        () => PLAN_COMMAND_TEMPLATE,
        "forge plan harness: no argument lists in-progress plans; resume continues the latest; discard abandons it; a goal enters planning discipline",
      )
      addTemplateCommand(
        "goal",
        () => GOAL_COMMAND_TEMPLATE,
        "forge goal harness (autonomous, host-verified): no argument lists goals; pause/resume/discard drive the loop; add queues; next promotes; an objective drafts a contract and arms it (--check/--contains markers become verification items)",
      )
      // /crew — composed per the live pool resolution exactly like the v1
      // config hook (same template functions => byte-identical text). The
      // composition re-resolves at INVOCATION time (mtime hot-apply is
      // reflected without a host restart); the description is frozen at
      // registration (the editor has no update path).
      const registrationResolution = resolvePools()
      const registrationAgentCount = Object.keys(registrationResolution?.agents ?? {}).length
      const crewTemplate = () => {
        const res = resolvePools()
        if (Object.keys(res?.agents ?? {}).length > 0) return crewOrchestrationTemplate(res ?? null)
        const anchorDir = hostAnchors[0] ?? undefined
        return CREW_INIT_TEMPLATE.replaceAll("{paths}", `   - ${forgeConfigPaths({ projectDir: anchorDir, homeDir: process.env.FORGE_TEST_FORGE_HOME ?? homedir() }).project}\n   - ${forgeConfigPaths({ projectDir: anchorDir, homeDir: process.env.FORGE_TEST_FORGE_HOME ?? homedir() }).global}`)
          .replaceAll("{template}", JSON.stringify({ pool: "namespace (REQUIRED for crew-governed dispatch, [a-z0-9-] up to 24 chars — every pool materializes as forge-<ns>-<id>; the global fallback materializes as forge-global-<id>)", agents: { research: { model: "provider/model", thoughtLevel: "low", shape: "readonly", prompt: "short role description — what this agent does" }, coder: { model: "provider/model", thoughtLevel: "low", shape: "write", prompt: "short role description — what this agent does" } } }, null, 2).split("\n").map((l) => "   " + l).join("\n"))
      }
      addTemplateCommand(
        "crew",
        crewTemplate,
        registrationAgentCount > 0
          ? "forge crew orchestration: register a declared subtask plan, execute it in waves of parallel native task calls, close with an evidence-checked report"
          : "forge crew orchestration — NOT INITIALIZED: no forge subagents configured; invoking it shows the one-time setup guidance",
      )
      // /forge — the roster levers (change forge-commands): the SAME
      // constant template the v1 config hook registers (byte-identical by
      // construction); routes on $ARGUMENTS at the model layer. The
      // hyphenated lever family is RETIRED (command-surface-v2-cleanup D1):
      // one command, four argument forms (sync / init / init global / stop).
      addTemplateCommand(
        "forge",
        () => FORGE_COMMAND_TEMPLATE,
        "forge roster levers: sync forces an immediate forge_sync and shows the diff; init drafts the workspace forge.json in-band (refuses when one exists — review instead); init global drafts the global forge.json with the built-in override entries commented out; stop cancels this session's in-flight and queued async dispatches",
      )
    })
  } catch (e) {
    // Drifted command domain: DISCLOSED degradation (change v2-command-surface
    // task 4.2) — never crash the plugin, never a silent no-op either (the
    // mem0 #7602 incident class).
    const head = e instanceof Error ? e.message : String(e)
    console.warn(`forge: command domain registration drifted — ${head.slice(0, 160)}`)
  }
}

// Typed-argument composition (change v2-command-surface task 4.1) — upstream
// evaluateTemplate semantics for the one placeholder forge templates use:
// $ARGUMENTS → the full typed text (function replacer, so $&-style sequences
// inside the argument are NOT expanded; all occurrences); a template with no
// placeholder + non-empty typed text → the text appended after a blank line;
// empty/whitespace typed text → the template unchanged.
export function composeCommandPrompt(template: string, typed: string | undefined | null): string {
  const text = typeof typed === "string" ? typed : ""
  if (!text.trim()) return template
  if (template.includes("$ARGUMENTS")) return template.replaceAll("$ARGUMENTS", () => text)
  return `${template}\n\n${text}`
}

// ---------------------------------------------------------------------------
// Continuation engines (task 5.1) — ctx.event.subscribe()
// ---------------------------------------------------------------------------

// Session-domain client adapter (task 5.1, W6a-resolved): collects the
// v2 session domain's REAL surface (prompt + get — there is no promptAsync
// and no status in SessionDomain) onto one v1-client-shaped object the
// shared cores consume. prompt translation: the v1 cores send
// {path:{id}, body:{parts:[{type:"text",text}]}}; the accepted v2 input is
// the FLAT root-level {sessionID, text} (see the live shape matrix below).
// promptAsync is approximated by the blocking send (same fallback posture
// as before; the wakes target idle sessions so the block is bounded by the
// send, not a model turn). Missing methods simply disable their own slice,
// never a throw.
// W6a field reality (live shape matrix, probe plugin 2026-11-19): the v2
// promise-layer ctx.session.prompt validates its input against a FLAT
// {sessionID, text} — prompt:{text} / prompt:{parts} / {path,body} shapes
// all throw SchemaError (missing ["text"] or ["sessionID"]); only the flat
// root-level spelling passes and starts a turn (the call then BLOCKS until
// the turn completes — no promptAsync on the promise layer, the send is
// the fire-and-forget approximation). v1-shaped callers stay untouched.
function v2PromptInputOf(opts: unknown): { sessionID: string; text: string } | null {
  if (opts === null || typeof opts !== "object") return null
  const o = opts as { path?: { id?: unknown }; body?: { parts?: unknown; text?: unknown }; sessionID?: unknown }
  const sid = typeof o.path?.id === "string" && o.path.id ? o.path.id : typeof o.sessionID === "string" ? o.sessionID : undefined
  if (!sid) return null
  const parts = Array.isArray(o.body?.parts) ? (o.body!.parts as unknown[]) : []
  const textPart = parts.find((p) => p !== null && typeof p === "object" && typeof (p as { text?: unknown }).text === "string") as { text: string } | undefined
  const text = textPart?.text ?? (typeof o.body?.text === "string" ? o.body.text : undefined)
  if (typeof text !== "string" || !text) return null
  return { sessionID: sid, text }
}

type V2SessionClient = {
  session: {
    prompt?: (opts: unknown) => Promise<unknown>
    promptAsync?: (opts: unknown) => Promise<unknown>
    get?: (opts: unknown) => Promise<unknown>
    create?: (args: { body: Record<string, unknown>; query?: { directory?: string } }) => Promise<{ data?: unknown; error?: unknown }>
    messages?: (args: { path: { id: string }; query?: { limit?: number } }) => Promise<{ data?: unknown[]; error?: unknown }>
    /**
     * fix-dispatch-dispose-kill D3: the dispatch abort seam — the 2.3.2
     * stop surface (interrupt) translated into the v1 abort call shape
     * ({path:{id}}) abortChild uses. Promise-layer ctx.session.interrupt
     * where available, service.json HTTP interrupt endpoint otherwise.
     */
    abort?: (args: { path: { id: string }; query?: { directory?: string } }) => Promise<unknown>
  }
  /**
   * crew-continue-native-child-gate 4.2 (sandbox E2E finding 2026-11-23):
   * the gate's DEDICATED session-tree walker. The promise-layer session
   * domain has no list/status, so a walk on `session` itself is a
   * structural no-op (always empty ⇒ fail-open ⇒ the nudge fires while a
   * native child runs). The walker rides the host's HTTP surfaces over the
   * service.json channel. Deliberately NOT `session.list`/`session.status`:
   * other call sites probe those names with v1-shaped expectations.
   */
  nativeChildWalker?: NativeChildClient
}

// fix-dispatch-view-capability: HTTP-backed messages reader for the v2
// adapter. The v2 session domain has no messages method; the host's own
// HTTP session-message surface is the sanctioned equivalent (upstream
// #59566), reachable with the service discovery artifact the host itself
// writes (service.json: {url, password}). Discovered lazily, cached once;
// a missing/unreadable file simply yields no reader (the core treats that
// as capability absence, never as a view failure). FORGE_SERVICE_FILE
// overrides the path (tests).
type ServiceHttpEndpoint = { url: string; password: string }
let serviceHttpCache: ServiceHttpEndpoint | null | undefined
let serviceHttpLastFail = 0
// Test hermeticity (crew-continue-native-child-gate D8.7; leak scan
// 2026-11-23: `v2-tools` issued 11 real GETs through this fallback): inside
// the Node test runner the DEFAULT service.json location is never read, so a
// test that sets neither FORGE_SERVICE_FILE nor XDG_STATE_HOME can only reach
// the user's REAL host by pointing at it explicitly. An unisolated test
// observes "no service" — what a machine without opencode yields. NODE_TEST_CONTEXT
// covers the default per-file isolation; `--test` in execArgv covers
// --experimental-test-isolation=none (which sets no NODE_TEST_CONTEXT).
// Deliberately NO opt-out: diagnostic scripts run under plain `node`.
function defaultServiceFileReachable(): boolean {
  if (process.env.NODE_TEST_CONTEXT) return false
  return !process.execArgv.some((a) => a === "--test" || a.startsWith("--test-"))
}
function discoverServiceHttp(): ServiceHttpEndpoint | null {
  // Positive results cache forever; failures retry at most once per 10s —
  // service.json can materialize shortly AFTER plugin setup (boot ordering),
  // so a failed discovery must stay retryable, never sticky.
  if (serviceHttpCache) return serviceHttpCache
  if (serviceHttpCache === null && Date.now() - serviceHttpLastFail < 10_000) return null
  const file = process.env.FORGE_SERVICE_FILE || (defaultServiceFileReachable() ? join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "opencode", "service.json") : "")
  if (!file) return null // not cached: a fixture set later in the same process is honored
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"))
    if (raw && typeof raw.url === "string" && typeof raw.password === "string" && raw.url && raw.password) {
      serviceHttpCache = { url: raw.url.replace(/\/+$/, ""), password: raw.password }
    } else {
      serviceHttpCache = null
      serviceHttpLastFail = Date.now()
    }
  } catch {
    serviceHttpCache = null
    serviceHttpLastFail = Date.now()
  }
  return serviceHttpCache
}
/** Test seam: forget the cached service discovery (FORGE_SERVICE_FILE env picks the file). */
export function resetServiceHttpDiscoveryForTests(): void {
  serviceHttpCache = undefined
  serviceHttpLastFail = 0
}
// W6a field reality (live probe 2026-11-19): the v2 promise-layer session
// domain validates its params against a FLAT {sessionID} key — the v1
// client shape {path:{id}} throws SchemaError(Missing key at ["sessionID"])
// (seen in the sandbox probe log as "lazy-seed failed ... err=SchemaError").
// Both call spellings are accepted by the translator; v1-shaped callers
// (goal engine, job seam, dispatch belt) stay untouched.
function v2SessionIdOf(opts: unknown): string | undefined {
  if (opts === null || typeof opts !== "object") return undefined
  const o = opts as { path?: { id?: unknown }; sessionID?: unknown }
  if (typeof o.path?.id === "string" && o.path.id) return o.path.id
  if (typeof o.sessionID === "string" && o.sessionID) return o.sessionID
  return undefined
}
/** Test seam: build the v2 session adapter directly (mock ctx.session domain). */
export function v2SessionClientForTests(ctx: V2PluginContext): V2SessionClient | null {
  return v2SessionClient(ctx)
}

/** service.json HTTP GET with the host's Basic auth; non-2xx throws (callers fail soft/open). */
async function serviceHttpGet(svc: ServiceHttpEndpoint, path: string): Promise<unknown> {
  const res = await fetch(`${svc.url}${path}`, {
    headers: { authorization: `Basic ${Buffer.from(`opencode:${svc.password}`).toString("base64")}` },
  })
  if (!res.ok) throw new Error(`service HTTP ${res.status} for ${path}`)
  return (await res.json()) as unknown
}

// crew-continue-native-child-gate 4.2 (sandbox E2E finding 2026-11-23 — the
// gate was a structural NO-OP on live v2 hosts): the walk needs
// session.list + session.status, but the promise-layer ctx.session domain
// exposes neither, so the adapter handed to the gate always walked an empty
// view and failed OPEN — two [forge:crew-continue] briefs landed while a
// native child was verifiably running. The host's own HTTP surfaces are the
// sanctioned equivalent, on the SAME service.json channel the messages
// reader and the interrupt fallback already ride (both real-host proven):
//   GET /api/session         session.list — every row carries parentID
//                            (optional ?parentID= server-side filter)
//   GET /api/session/active  session.active — map sessionID → {type:"running"};
//                            "sessions absent from the result are inactive"
// A DEDICATED walker object — deliberately NOT session.list/session.status on
// the shared adapter: other call sites probe those names with v1-shaped
// expectations (e.g. the crew send-time idle re-check treats a status throw
// as "skip the brief"); adding them there would silently change their
// behavior. Discovery is lazy per call (service.json can materialize after
// setup); every failure THROWS and the pure core fails OPEN.
//
// Page cap (real host, 2026-11-23): the list returns "the newest 50
// sessions" and that cap applies to a parentID-filtered page TOO — a parent
// with 85 children answered 50 rows by default and all 85 with ?limit=500.
// The scoped call therefore asks for the wider page; the client-side
// parentID filter in the pure core stays the semantic authority.
const NATIVE_CHILD_LIST_LIMIT = 500
function v2NativeChildWalker(): NativeChildClient {
  return {
    session: {
      list: async (args) => {
        const svc = discoverServiceHttp()
        if (!svc) throw new Error("native-child walker: service.json discovery failed")
        const parent = args !== null && typeof args === "object" && typeof (args as { parentID?: unknown }).parentID === "string"
          ? (args as { parentID: string }).parentID
          : ""
        return await serviceHttpGet(svc, parent ? `/api/session?parentID=${encodeURIComponent(parent)}&limit=${NATIVE_CHILD_LIST_LIMIT}` : "/api/session")
      },
      status: async () => {
        const svc = discoverServiceHttp()
        if (!svc) throw new Error("native-child walker: service.json discovery failed")
        const body = await serviceHttpGet(svc, "/api/session/active")
        // Live 2.3.2 shape: the BARE map {sessionID:{type}}. Re-wrap into the
        // {data:map} envelope the pure core unwraps; an already-enveloped
        // body passes its inner map through.
        const map = body !== null && typeof body === "object" && !Array.isArray(body) && "data" in (body as Record<string, unknown>)
          ? (body as { data: unknown }).data
          : body
        return { data: map }
      },
    },
  }
}

function v2SessionClient(ctx: V2PluginContext): V2SessionClient | null {
  const s = ctx.session
  if (s === null || typeof s !== "object") return null;
  const out: V2SessionClient["session"] = {}
  // Per-child directory anchors for the HTTP messages reader (set at create).
  const childDirs = new Map<string, string>()
  let lastKnownDir: string | undefined
  if (typeof s.prompt === "function") {
    const send = async (opts: unknown) => {
      const input = v2PromptInputOf(opts)
      if (!input) return undefined
      return s.prompt!(input)
    }
    out.prompt = send
    out.promptAsync = send // fire-and-forget approximated by the blocking send
  }
  if (typeof s.get === "function") {
    out.get = async (opts: unknown) => {
      const sid = v2SessionIdOf(opts)
      return sid !== undefined ? s.get!({ sessionID: sid }) : s.get!(opts)
    }
  }
  // fix-v2-crew-surface-drift task 2.2 (design D2 — sandbox-probed
  // 2026-11-21 on 2.3.2): the child-session creation seam EXISTS on the
  // promise-layer session domain as ctx.session.create — same name, FLAT
  // single-object param ({parentID?, title?, ...extras}) instead of the
  // v1 {body, query} envelope, and it returns the BARE session record
  // ({id, location:{directory}, ...}) with no {data,error} envelope. The
  // adapter translates the v1 dispatch call shape into the flat form and
  // re-wraps the bare record into the envelope createChildSession reads.
  // parentID is honored (a nonexistent parent rejects with
  // Session.NotFoundError); the directory anchor rides the flat object
  // best-effort (the observed 2.3.2 host anchors to its own cwd when the
  // key is dropped — fail-soft, never fatal).
  if (typeof (s as { create?: unknown }).create === "function") {
    const rawCreate = (s as unknown as { create: (input: Record<string, unknown>) => Promise<unknown> }).create
    out.create = async (args) => {
      const body = args?.body
      const flat: Record<string, unknown> = {}
      if (body && typeof body === "object") {
        // dispatch-v2-hostsignals 2.1: `agent` + `model` join the allowlist —
        // the agent-bound creation rides the flat object exactly like the
        // host's own subagent tool ({parentID, title, agent, model}); the
        // probe proved both keys land on the created record (model wants the
        // {providerID, modelID, id} shape the dispatch core already sends).
        for (const key of ["parentID", "title", "agent", "model", "permission", "permissions", "directory"] as const) {
          const v = (body as Record<string, unknown>)[key]
          if (v !== undefined) flat[key] = v
        }
      }
      const directory = args?.query?.directory
      if (typeof directory === "string" && directory !== "" && flat.directory === undefined) flat.directory = directory
      const record = await rawCreate.call(s, flat)
      // Bare record (observed) → envelope; already-enveloped stays as-is.
      const envelope = record !== null && typeof record === "object" && ("data" in (record as Record<string, unknown>) || "error" in (record as Record<string, unknown>))
        ? (record as { data?: unknown; error?: unknown })
        : { data: record }
      // fix-dispatch-view-capability: remember the child's directory so the
      // HTTP messages reader can anchor its location query per child.
      try {
        const rec = (envelope.data ?? null) as { id?: unknown } | null
        if (rec && typeof rec.id === "string" && typeof directory === "string" && directory) {
          childDirs.set(rec.id, directory)
          lastKnownDir = directory
        }
      } catch {}
      return envelope
    }
  }
  // fix-dispatch-view-capability: HTTP-backed messages reader (upstream
  // #59566 sanctions the session-message HTTP surface). Wired whenever the
  // adapter builds; discovery happens lazily per call and may still be
  // PENDING at early boot (service.json can materialize after setup) — a
  // pending discovery returns {capabilityPending: true}, which the core
  // treats as leg-not-applicable (never view loss) until discovery
  // succeeds. Directory anchors per child (captured at create), falling
  // back to the last known one.
  out.messages = async (args) => {
    const sid = typeof args?.path?.id === "string" ? args.path.id : undefined
    if (!sid) return { error: "messages reader: no session id in args" }
    const svc = discoverServiceHttp()
    if (!svc) return { capabilityPending: true }
    const dir = childDirs.get(sid) ?? lastKnownDir
    try {
      const loc = dir ? `?location%5Bdirectory%5D=${encodeURIComponent(dir)}` : ""
      const res = await fetch(`${svc.url}/api/session/${sid}/message${loc}`, {
        headers: { authorization: `Basic ${Buffer.from(`opencode:${svc.password}`).toString("base64")}` },
      })
      if (!res.ok) return { error: `HTTP ${res.status}` }
      const parsed = JSON.parse(await res.text()) as unknown
      const arr = Array.isArray(parsed) ? parsed : (parsed && typeof parsed === "object" && Array.isArray((parsed as { data?: unknown }).data) ? (parsed as { data: unknown[] }).data : undefined)
      if (!Array.isArray(arr)) return { error: "unexpected message payload shape" }
      // 0.32.3: the 2.3.2 surface ships BARE rows (type/content/time at top
      // level, no info envelope) — translate into the v1-like shape the
      // dispatch core reads, or latestAssistant() filters everything out
      // and every wake reads "no assistant response found" (real-host
      // proven 2026-11-23).
      return { data: arr.map(normalizeV2MessageRow).filter((x): x is SessionMessageLike => x !== null) }
    } catch (e) {
      return { error: String(e) }
    }
  }
  // fix-dispatch-dispose-kill D3 (live-host probe 2026-11-23 on host 2.3.2,
  // GET /openapi.json — 142 paths, ZERO abort anywhere): the sanctioned stop
  // surface is POST /api/session/{sessionID}/interrupt (operationId
  // session.interrupt, optional `resume` query param, 200
  // {interrupted:boolean} — "Whether an active execution owned by this
  // OpenCode process was interrupted"; idle interruption is a no-op). ONE
  // seam, two legs in order:
  //   (1) the promise layer ctx.session.interrupt({sessionID, resume:false})
  //       where the host exposes it (v2 plugin surface);
  //   (2) the service.json HTTP channel — the SAME discoverServiceHttp()
  //       reader the messages reader rides — POST {url}/api/session/{id}/interrupt.
  // {interrupted:false} on an idle child is success-equivalent (the child
  // already finished). The response body is parsed defensively (SDK 1.18.32
  // types claim 204 void and no resume param — code against the LIVE shape).
  // Future harder mode, deliberately NOT wired: DELETE /api/session/{id}
  // (session.remove) "stops active execution and recursively deletes child
  // sessions" — a candidate for a future cancel-hard semantics.
  const rawInterrupt =
    typeof (s as { interrupt?: unknown }).interrupt === "function"
      ? (s as unknown as { interrupt: (input: Record<string, unknown>) => Promise<unknown> }).interrupt.bind(s)
      : undefined
  out.abort = async (args) => {
    const sid =
      v2SessionIdOf(args) ??
      (args !== null && typeof args === "object" && typeof (args as { path?: { id?: unknown } }).path?.id === "string"
        ? (args as { path: { id: string } }).path.id
        : undefined)
    if (!sid) throw new Error("abort seam: no session id in args")
    if (rawInterrupt) {
      return await rawInterrupt({ sessionID: sid, resume: false })
    }
    const svc = discoverServiceHttp()
    if (!svc) {
      throw new Error("abort unavailable on this session client (no promise-layer interrupt and service.json discovery failed)")
    }
    const res = await fetch(`${svc.url}/api/session/${sid}/interrupt?resume=false`, {
      method: "POST",
      headers: { authorization: `Basic ${Buffer.from(`opencode:${svc.password}`).toString("base64")}` },
    })
    if (!res.ok) throw new Error(`session interrupt HTTP ${res.status}`)
    // Live shape: 200 {interrupted:boolean}. interrupted:false on an idle
    // child is success-equivalent — resolved (not thrown) either way.
    try {
      return JSON.parse(await res.text()) as unknown
    } catch {
      return undefined
    }
  }
  return Object.keys(out).length > 0 ? { session: out, nativeChildWalker: v2NativeChildWalker() } : null
}

// 0.32.3 row-shape reality (real-host capture, 2.3.2): the session-message
// HTTP rows are BARE —
//   assistant: {id, time:{created,firstToken,streamed,completed}, type:
//              "assistant", agent, model, content: part[], finish,
//              rawFinish, cost, tokens}
//   user:      {id, time:{created}, type: "user", text: string}
//   idle:      {id, time:{created}, type: "idle", outcome}   ← bookkeeping
// The dispatch core (fetchFinalMessage/latestAssistant/pollChild) reads the
// v1-like envelope {info:{role,finish,error,time:{created,completed}},parts}.
// Translate one row; enveloped rows (info already present) pass through
// untouched (upstream may revert to the enveloped shape); idle markers and
// unclassifiable rows return null (dropped). The content array and the
// v1 parts array share the {type,text} part spelling, so assistant content
// maps 1:1; a user row's top-level text becomes a single text part.
export function normalizeV2MessageRow(row: unknown): SessionMessageLike | null {
  if (row === null || typeof row !== "object") return null
  const r = row as Record<string, unknown>
  if (r.info !== undefined && typeof r.info === "object") return r as unknown as SessionMessageLike
  const type = typeof r.type === "string" ? r.type : undefined
  if (!type || type === "idle") return null
  const t = r.time as { created?: unknown; completed?: unknown } | number | undefined
  const created = typeof t === "number"
    ? t
    : (t !== undefined && t !== null && typeof t === "object" && typeof t.created === "number" ? t.created : 0)
  const parts = Array.isArray(r.parts)
    ? (r.parts as Array<{ type?: string; text?: string }>)
    : Array.isArray(r.content)
      ? (r.content as Array<{ type?: string; text?: string }>)
      : typeof r.text === "string" && r.text !== "" ? [{ type: "text", text: r.text }] : []
  const info: NonNullable<SessionMessageLike["info"]> = { role: type, time: { created } }
  if (typeof r.id === "string") info.id = r.id
  if (typeof r.finish === "string") info.finish = r.finish
  if (r.error !== undefined) info.error = r.error
  if (t !== undefined && t !== null && typeof t === "object" && typeof t.completed === "number") info.time!.completed = t.completed
  return { info, parts }
}

// W6a field reality (SDK 2.3.2 @opencode/protocol session-event.d.ts +
// sandbox SSE capture): the subscription yields OpenCodeEvent envelopes
// {id, created, type, data: {...}} — the payload lives under `data`, NOT
// `properties` (the v1 envelope spelling, kept as a harmless fallback).
function v2EventFields(raw: unknown): Record<string, unknown> {
  if (raw === null || typeof raw !== "object") return {}
  const o = raw as Record<string, unknown>
  if (o.data !== null && typeof o.data === "object") return o.data as Record<string, unknown>
  if (o.properties !== null && typeof o.properties === "object") return o.properties as Record<string, unknown>
  return o
}

// The shared idle body (v1 session.idle port): idle bookkeeping
// (wake-push gate), the debounced goal continuation (same engine, same
// guards, same [forge:goal-continue] brief), then progress flushes BEFORE
// terminal wakes (design D6) — all shared cores, one code path whether the
// edge arrives from the in-process experimental.idle hook or the SSE
// session.execution.succeeded fallback.
function v2HandleIdle(sessionID: string, goalClient: GoalClient | null): void {
  try {
    goalProbe(`v2 idle session=${sessionID}`)
    idleJobSessions.add(sessionID)
    if (goalClient) scheduleIdleContinuation(goalClient, sessionID)
    void deliverDispatchProgress(sessionID).then(() => deliverJobWakes(sessionID))
  } catch {
    // Drifted idle payload: no-op, never a throw into the host.
  }
}

// The v2 event subscription (task 5.1, W6a-resolved; dispatch-v2-hostsignals
// 3.1/3.4): ctx.event.subscribe(options?) returns an AsyncIterable of
// {id, type, data} envelopes — consumed in a DETACHED task (never blocking
// setup). session.deleted (26x literal in the sandbox scan; schema
// Deleted.data = {sessionID}) rides the shared harvestSessionEnd core.
// The idle edge (session.execution.succeeded — the emitted idle signal on
// 2.3.2; "session.idle" exists in the schema but is NOT emitted, kept as a
// harmless alias) is handled HERE only as a FALLBACK for hosts without the
// in-process experimental.idle hook — the primary idle mechanism is
// ctx.session.hook("experimental.idle") (in-process, no SSE race, richer
// background info; see v2RegisterSessionHooks).
//
// dispatch-v2-hostsignals: the durable execution events now ALSO route into
// the host-signal completion core (noteDispatchTerminalSignal /
// noteDispatchChildActivity) — the durable terminal channel of task 3.1 —
// and session.created seeds the session map + runs the LAZY per-workspace
// journal recovery (v1-hook parity; the reload-adoption leg). The stream is
// self-healing: an ended or errored stream RE-SUBSCRIBES with backoff
// (task 3.4) until cleanup; the reconcile pass covers children whose
// terminal events fired inside a gap. Returns the CLEANUP (abort the
// controller + close the current iterator); a drifted event domain returns
// null (slice disabled, no throw).
function v2SubscribeEvents(ctx: V2PluginContext, goalClient: GoalClient | null, idleFallback: boolean): (() => void) | null {
  const subscribeFn = ctx.event?.subscribe?.bind(ctx.event)
  if (typeof subscribeFn !== "function") return null
  const trySubscribe = (): AsyncIterator<unknown> | null => {
    try {
      const sub = subscribeFn()
      if (sub !== null && typeof sub === "object" && typeof (sub as AsyncIterable<unknown>)[Symbol.asyncIterator] === "function") {
        return (sub as AsyncIterable<unknown>)[Symbol.asyncIterator]()
      }
    } catch {
      // Drifted subscribe call: no iterator.
    }
    return null
  }
  try {
    let iterator = trySubscribe()
    if (!iterator) return null
    const controller = new AbortController()
    const run = async () => {
      // Task 3.4: stream loss → re-subscribe loop (1s → 5s backoff) until
      // cleanup or a dead domain; the reconcile pass covers the gap.
      let backoffMs = 1_000
      while (!controller.signal.aborted) {
        const iter = iterator
        if (!iter) return
        try {
          for (;;) {
            const next = await iter.next()
            if (next.done) break
            const ev = next.value as { type?: unknown } | null
            const type = ev !== null && typeof ev === "object" && typeof ev.type === "string" ? ev.type : undefined
            if (!type) continue
            if (controller.signal.aborted) return
            const fields = v2EventFields(ev)
            // crew-continue-native-child-gate 2.3: the native-child tracker
            // feed rides the SAME subscription (advisory warm set — the
            // decision-time walk stays authoritative). No new stream.
            noteCrewNativeChildEvent(type, fields, goalClient)
            if (type === "session.deleted") {
              try {
                const info = fields.info as { id?: unknown } | undefined
                const id =
                  info !== null && typeof info === "object" && typeof info.id === "string" && info.id
                    ? info.id
                    : v2PickStr(fields, "sessionID", "sessionId")
                if (id) harvestSessionEnd(id)
              } catch {
                // Drifted deleted payload: no-op, never a throw into the host.
              }
            } else if (type === "session.moved") {
              // Post-move anchor re-resolution (see the resolver branch): the
              // v2 event payload is flat {sessionID, location:{directory}}
              // under .data — v2EventFields already unwraps it.
              try {
                const f = movedEventFields(fields)
                noteSessionMoved(f.sessionID, f.directory)
              } catch {
                // Drifted moved payload: no-op, never a throw into the host.
              }
            } else if (type === "session.execution.succeeded" || type === "session.execution.failed" || type === "session.execution.interrupted") {
              // Task 3.1: the durable terminal channel — routed into the
              // host-signal completion core (child-keyed inbox; non-children
              // are a Map-miss no-op).
              const sessionID = v2PickStr(fields, "sessionID", "sessionId")
              if (sessionID) {
                const kind =
                  type === "session.execution.succeeded" ? "succeeded" : type === "session.execution.failed" ? "failed" : "interrupted"
                const detail =
                  kind === "failed"
                    ? executionErrorDetail(fields.error)
                    : kind === "interrupted"
                      ? fields.reason !== undefined
                        ? String(fields.reason)
                        : undefined
                      : undefined
                noteDispatchTerminalSignal(sessionID, kind, detail)
                // Parent-interrupt disclosure (dispatch-cancel-lifecycle
                // 2.1): an interrupted OWNER session with children in flight
                // gets the disclose-only notice (a child sessionID is a
                // flight-miss no-op inside the helper).
                if (kind === "interrupted") {
                  try {
                    discloseInterruptedParent(sessionID)
                  } catch {}
                }
                // Idle parity: on hosts without the in-process idle hook,
                // the succeeded edge IS the idle edge (existing fallback).
                if (idleFallback && type === "session.execution.succeeded") v2HandleIdle(sessionID, goalClient)
              }
            } else if (type === "session.execution.started" || type === "session.step.started" || type === "session.step.ended") {
              // Reconcile-confirmation pings: execution activity keeps the
              // stream-lost verdict withheld for a live child.
              const sessionID = v2PickStr(fields, "sessionID", "sessionId")
              if (sessionID) noteDispatchChildActivity(sessionID)
            } else if (type === "session.created") {
              // Lazy per-workspace recovery + session-map seeding (v1-hook
              // parity): workspaces beyond the launch anchor recover on
              // their FIRST session; a hot-reloaded generation adopts the
              // in-flight dispatch journal here.
              try {
                const info = (fields.info ?? (fields as { session?: unknown }).session) as
                  | { id?: unknown; directory?: unknown; worktree?: unknown }
                  | undefined
                const id = info !== null && typeof info === "object" && typeof info.id === "string" && info.id ? info.id : v2PickStr(fields, "sessionID", "sessionId")
                const worktree = effectiveWorktree(
                  info !== null && typeof info === "object" && typeof info.worktree === "string" ? info.worktree : undefined,
                  info !== null && typeof info === "object" && typeof info.directory === "string" ? info.directory : undefined,
                )
                if (id && typeof worktree === "string" && worktree) {
                  ensureSession(id, worktree)
                  if (!isRootish(worktree)) void recoverWorkspaceDispatches(jobClient as unknown as DispatchClient | null, worktree)
                }
              } catch {
                // Drifted created payload: no-op, never a throw into the host.
              }
            } else if (idleFallback && type === "session.idle") {
              const sessionID = v2PickStr(fields, "sessionID", "sessionId")
              if (sessionID) v2HandleIdle(sessionID, goalClient)
            }
          }
        } catch {
          // Stream error: fall through to the re-subscribe beat.
        }
        if (controller.signal.aborted) return
        await new Promise((resolve) => setTimeout(resolve, backoffMs))
        if (controller.signal.aborted) return
        const fresh = trySubscribe()
        if (!fresh) return // the event domain itself is gone: cleanup semantics
        iterator = fresh
        backoffMs = 1_000
      }
    }
    void run()
    let closed = false
    return () => {
      if (closed) return
      closed = true
      controller.abort()
      try {
        void iterator?.return?.()
      } catch {
        // Already-closed iterator: nothing to do.
      }
    }
  } catch {
    // Drifted event domain: silent no-op.
    return null
  }
}

// Test seam for the v2 wiring suites (same pragmatic module-state style as
// the v1 __forgeSubagentsTest): live references to the module maps the v2
// handlers share with the v1 hooks, so tests seed and inspect without a
// host. NOT part of the plugin API surface.
export const v2WiringSeam = { sessions, sessionAgents, crews, sessionDepths, turnActivity, crewTurnActivity, sealFindings, sealUnknownNotes, sessionMovedAnchors, jobLedger: () => jobManager.ledgerEntries(), dispatchTasks, jobManager, crewNativeChildren, crewNativeCeiling, crewChildDigest, crewNativeWatch, crewNativeRecheckArmed: (sessionID: string) => crewNativeRecheck.has(sessionID), crewNativeRecheckNow: (sessionID: string, client: GoalClient | null) => crewNativeRecheckTick(sessionID, client), resetHostAnchors: () => { hostAnchors.length = 0; poolResolver = null; poolResolution = null } }

// ---- v2-single-agent-surface: single-agent-surface primitives (v2Setup
// only — the v1 config-hook path never uses these) ----
//
// Host reality (binary + /api/agent, 2.3.2): v2 agent records carry
// `permissions` as an ARRAY of {action, resource, effect} entries; per-agent
// tool visibility is permission-driven (the host's tool inventory assembly
// drops any tool whose action is blanket-denied, last-match-wins). The deny
// front door for the builtin shell rides that array. HARD RULE: never deny
// action "execute" — that is the Code Mode kill switch.
const V2_SHELL_DENY: { action: string; resource: string; effect: string } = { action: "shell", resource: "*", effect: "deny" }

function v2WithShellDeny(perms: unknown): Array<Record<string, unknown>> {
  const arr: Array<Record<string, unknown>> = Array.isArray(perms) ? perms.filter((p) => p !== null && typeof p === "object") : []
  if (!arr.some((p) => p.action === "shell")) arr.push({ ...V2_SHELL_DENY })
  return arr
}

// Translate the v1 shape-derived permission record ({"task":"deny", ...})
// into the v2 array form, always appending the shell-deny front door. The
// readonly seal (MUTATING_TOOLS deny family) and the task:deny recursion ban
// land in the array form — the old singular `permission` spelling was a
// wrong field name on this domain and never reached the host.
function v2PermissionArray(record: Record<string, string>): Array<Record<string, unknown>> {
  const arr = Object.entries(record).map(([action, effect]) => ({ action, resource: "*", effect }))
  arr.push({ ...V2_SHELL_DENY })
  return arr
}

// hideNativeAgents knob (D3): GLOBAL forge.json layer only (the plugin's own
// config domain — never the user's opencode config), JSONC read-only parse,
// default true; only an explicit false disables. Any read/parse failure keeps
// the default (fail-soft).
function v2ReadHideNatives(deps?: V2SetupDeps): boolean {
  try {
    const homeDir = deps?.homeDir ?? process.env.FORGE_TEST_FORGE_HOME ?? homedir()
    const globalPath = forgeConfigPaths({ homeDir }).global
    const text = deps?.readFile ? deps.readFile(globalPath) : readFileSync(globalPath, "utf8")
    const parsed = parseForgeJsonc(text)
    if (parsed.ok && parsed.config !== null && typeof parsed.config === "object") {
      const knob = (parsed.config as { hideNativeAgents?: unknown }).hideNativeAgents
      if (knob === false) return false
    }
  } catch {
    // Absent/unreadable global layer: keep the default.
  }
  return true
}

export async function v2Setup(ctx: V2PluginContext, deps?: V2SetupDeps): Promise<void | (() => void)> {
  // ---- host-axis parity (tasks 3.1/4.x): the belts and injections below
  // share the v1 module state (only ONE entry ever runs per host process),
  // so seed the workspace registry + launch anchor exactly like server()
  // does — the shared predicates (resolvePools / stateForBan / the pool
  // gates) then see the same disk truth as on a v1 host.
  {
    const v2Candidates = [...(deps?.anchors ?? []), ...v2AnchorCandidates(ctx)]
    for (const cand of v2Candidates) {
      const t = cand.trim()
      if (t) rememberHostAnchor(t)
    }
    const first = v2Candidates.find((c) => c && !isRootish(c))
    if (first) hostWorktree = first
  }
  // ---- native-first-roster (design D5): the materialize knob. The v2
  // host generation DEFAULTS DIRECTLY to "native" (owner decision
  // 2026-11-21 — no deprecation window; v1 hosts stay runtime-pinned and
  // never reach this line, so their behavior is byte-equal). "runtime"
  // remains selectable as the escape hatch: the draft-materialization
  // path below then runs exactly as before. Knob resolution: explicit
  // deps override (test seam) > GLOBAL forge.json layer > default.
  v2HostSeen = true
  v2PostureHomeDir = deps?.homeDir ?? homedir()
  const globalKnobs = readGlobalKnobs(deps)
  v2MaterializeMode = deps?.materialize ?? globalKnobs.materialize ?? "native"
  // ---- sync:"auto" opt-in (design D4): at session start, pools whose
  // OWN file declares sync:"auto" regenerate silently when stale, with a
  // disclosed finding (console warn). The default posture (absent knob)
  // writes NOTHING uninvited — gate + in-band forge_sync only.
  if (v2MaterializeMode === "native") {
    try {
      const homeDir = deps?.homeDir ?? process.env.FORGE_TEST_FORGE_HOME ?? homedir()
      const resolver = createPoolResolver({ homeDir, stat: deps?.stat, readFile: deps?.readFile })
      const seen = new Map<string, string>()
      for (const cand of [...(deps?.anchors ?? []), ...v2AnchorCandidates(ctx)]) {
        const key = normalizeAnchorDir(cand)
        if (key && !seen.has(key)) seen.set(key, cand.trim())
      }
      const resolution = resolver.resolve([...seen.values()])
      const globalPoolFile = forgeConfigPaths({ homeDir }).global
      const allPlans = planRosterSync(resolution, { globalPoolFile })
      for (const family of resolution.families) {
        let auto = false
        try {
          const text = deps?.readFile ? deps.readFile(family.file) : readFileSync(family.file, "utf8")
          const parsed = parseForgeJsonc(text)
          if (parsed.ok) auto = parseTopLevelKnobs(parsed.config, family.file).syncAuto
        } catch {
          // Unreadable pool file: the resolver's findings own that failure.
        }
        if (!auto) continue
        const verdict = staleCheckForPool(family.file, family.materializedIds, realRosterFs(), rosterContentOf(resolution))
        if (!verdict.stale) continue
        const plans = allPlans.filter((p) => p.family.file === family.file)
        const outcome = executeRosterSync(plans, realRosterFs())
        console.warn(
          `[forge:sync] warn: sync:"auto" — stale roster regenerated at session start (${verdict.reason}); created ${outcome.created.length}, updated ${outcome.updated.length}, gc'd ${outcome.gced.length}${outcome.errors.length ? `, errors: ${outcome.errors.join("; ")}` : ""}`,
        )
      }
    } catch {
      // Auto-sync is best-effort: never a throw into the host.
    }
  }
  // ---- agent domain: forge primary + full sole-pool-ownership
  // materialization (task 1.2 — parity with the v1 config hook, same
  // createPoolResolver + forgeAgentDef cores).
  if (typeof ctx.agent?.transform === "function") {
    await ctx.agent.transform(async (draft) => {
      if (typeof draft.get !== "function" || typeof draft.update !== "function") return
      if (draft.get(FORGE_AGENT) === undefined) {
        draft.update(FORGE_AGENT, (agent) => {
          agent.description =
            "forge — the single general-purpose coding agent: takes implementation tasks directly; planning goes through /plan into the plan harness (plans land in .opencode/plan/, with an approve confirmation gate, a plugin-verified fail-closed close that re-runs the frozen checks, and tick discipline enforced by tools and the permission layer)."
          agent.system = FORGE_PROMPT
          agent.mode = "primary"
        })
      }
      // v2-single-agent-surface D4: the builtin-shell deny front door rides
      // the PRIMARY record too — idempotent append, so a user-defined forge
      // entry keeps every other field (tools-merge parity with the v1
      // loader's user-entry semantics).
      try {
        draft.update(FORGE_AGENT, (agent) => {
          agent.permissions = v2WithShellDeny(agent.permissions)
        })
      } catch (err) {
        console.warn(`[forge:v2] error: shell deny not applied to the forge record: ${String(err)}`)
      }
      // ---- v2-single-agent-surface D1/D2: native primary suppression ----
      // Hide-only (records stay — existing build/plan sessions keep
      // resolving), guarded (absent → skip; already hidden → untouched),
      // per-record fail-soft, never touching any other field. Opt-out:
      // "hideNativeAgents": false in the GLOBAL forge.json layer (D3). This
      // block is v2-only — the v1 config hook path never touches native
      // records.
      if (v2ReadHideNatives(deps)) {
        for (const nativeId of ["build", "plan"] as const) {
          try {
            const rec = draft.get(nativeId)
            if (rec === undefined || rec === null) continue
            if (typeof rec === "object" && (rec as { hidden?: unknown }).hidden === true) continue
            draft.update(nativeId, (r) => {
              r.hidden = true
            })
          } catch (err) {
            console.warn(`[forge:v2] error: native agent ${nativeId} not hidden: ${String(err)}`)
          }
        }
      }
      // Static forge subagents (spec: forge-subagents — v2 parity): same
      // create-only discipline as the forge entry. The COMPLETE
      // sole-pool-ownership resolver (src/forge-config.ts createPoolResolver,
      // reused as-is incl. its workspacePoolOf primitive — the W4
      // session-domain gate's seam) resolves over the accumulated host
      // anchor registry: materialization set = global fallback layer + each
      // seen workspace's pool (per anchor the walk-up NEAREST forge.json;
      // nested forge.json files ignored); families materialize NAMESPACED
      // (forge-<ns>-<id>; the global fallback is forge-global-<id> — no
      // plain-id family), ids stable across host/init order (pure
      // lexicographic resolution); descriptions carry the pool provenance
      // line (shared forgeAgentDef path, D3/D5); pinned models ride the
      // entry, Auto workers carry no model key; permissions seal readonly
      // workers (MUTATING_TOOLS deny family) and force task: deny always.
      // Findings surface through the diagnostics channel like the v1 config
      // hook; any failure degrades to no subagents, never a throw.
      // native-first-roster (design D5): on a native-mode v2 host (the
      // DEFAULT) this draft materialization is SKIPPED — worker identity
      // comes from the compiled .opencode/agent/forge-<ns>-<id>.md files
      // (forge_sync tool; host hot-apply). The pool resolver stays the
      // semantic authority for every gate, unchanged. "runtime" (the
      // escape hatch) runs the block exactly as before.
      if (v2MaterializeMode === "native") {
        // Native mode: no draft materialization. The staleness gate +
        // forge_sync tool (wiring above) own the projection.
      } else
      try {
        const homeDir = deps?.homeDir ?? process.env.FORGE_TEST_FORGE_HOME ?? homedir()
        // Anchor registry: explicit deps.anchors (test seam) plus the
        // guarded location/cwd candidates, deduped by normalized form
        // (original spelling preserved for resolution — see the registry
        // comment above).
        const candidates = [...(deps?.anchors ?? []), ...v2AnchorCandidates(ctx)]
        for (const cand of candidates) {
          const key = normalizeAnchorDir(cand)
          if (key && !v2HostAnchors.has(key)) v2HostAnchors.set(key, cand.trim())
        }
        const resolver = createPoolResolver({ homeDir, stat: deps?.stat, readFile: deps?.readFile })
        const resolution = resolver.resolve([...v2HostAnchors.values()])
        for (const finding of resolution.findings) {
          console.warn(`[forge:v2] ${finding.level}: ${finding.message}`)
        }
        const v2GlobalPath = forgeConfigPaths({ homeDir }).global
        for (const [matId, agent] of Object.entries(resolution.agents)) {
          const id = `forge-${matId}`
          if (draft.get(id) !== undefined) continue // create-only
          const provenance = foldPath(agent.file) === foldPath(v2GlobalPath) ? ({ global: true } as const) : { ns: agent.ns, file: agent.file }
          // forge-prompt-shared D4: v1/v2 parity — the ORIGIN file's shared
          // segment rides the prompt here too (create-only semantics and
          // guards untouched).
          const v1def = forgeAgentDef(matId, agent.def, provenance, agent.shared ?? undefined)
          try {
            draft.update(id, (agentDraft) => {
              agentDraft.description = v1def.description
              agentDraft.system = v1def.prompt
              agentDraft.mode = v1def.mode
              // W6 field reality (live bisect 2026-11-19): writing ANY model
              // spelling on the v2 agent draft breaks the agent layer — the
              // v1 string form OR the parsed {providerID, modelID} object
              // both leave /api/agent 500-ing ("Server failed to encode").
              // The model pin therefore stays a V1-ONLY feature until the v2
              // agent schema documents a draft-settable model shape
              // (documented drift; the thoughtLevel pin is unaffected — it
              // rides the runtime chat.params pool lookup by agent id).
              // v2-single-agent-surface D4 + field-name fix: v2 agent
              // records carry `permissions` as an ARRAY of
              // {action, resource, effect} entries — the old singular
              // `permission` record spelling was a wrong field name on this
              // domain and never reached the host. The shape-derived map
              // (readonly seal, task:deny recursion ban) lands in the array
              // form, and every worker — regardless of shape — carries the
              // builtin-shell deny front door. NEVER deny action "execute".
              agentDraft.permissions = v2PermissionArray(v1def.permission as Record<string, string>)
            })
          } catch (err) {
            // Per-agent fail-soft (same posture as the v1 config hook's
            // findings): one bad def never skips the rest of the pool.
            console.warn(`[forge:v2] error: agent ${id} not materialized: ${String(err)}`)
          }
        }
      } catch {
        // Host-shape drift or unreadable config: skip silently (v2 contract).
      }
      // ---- v2-single-agent-surface D5: default subject ----
      // draft.default(FORGE_AGENT) guarded by typeof + try/catch. Ordering
      // gate (task 1.2): the host's config→agent merge (id "opencode.agent")
      // runs AFTER plugin transforms on 2.3.2, so an explicit user
      // default_agent overrides ours — same user-wins precedence as D3/D4.
      // If the ordering probe refutes this, revert this whole block.
      try {
        if (typeof draft.default === "function") draft.default(FORGE_AGENT)
      } catch {
        // Host drift on the default setter: no-op, never a throw into the host.
      }
    })
  }

  // ---- tool domain (task 2.1): register the ENTIRE tool surface through
  // the same forgeTools() factory the v1 tool hook uses — the shared
  // execute cores, descriptions, and argument contracts are one code path
  // (design: "one code path per concern"). The JSON Schema builder
  // translates each tool.schema.* chain above. Result wrapping and the
  // context adaptation carry SANDBOX-PENDING readers (see above). The
  // tool-partition behavior (family-based hiding) is a W4 session-seam
  // concern and is deliberately NOT attempted here — only registration.
  if (typeof ctx.tool?.transform === "function") {
    // fix-multi-location-session-anchor: the session-record read behind every
    // tool call goes through THIS initialization's own client — the one bound
    // to the directory instance whose sessions run these closures. A
    // module-level "latest init" client belongs to another directory (or to
    // an evicted instance) on a multi-directory host.
    const toolAnchor = v2AnchorClient(ctx)
    // fix-ask-door-multi-directory-host D2: the ask bridge behind every door
    // and forge_shell is THIS initialization's own ctx.permission.assert —
    // the interface bound to the directory instance whose sessions run these
    // closures. A module-level "latest init" seam sent every directory's
    // asks to the last-initialized directory's pending table (that other
    // terminal never saw them), and died for EVERY directory once that one
    // was evicted. Read exactly as the seam used to be; only the scope
    // changed — this initialization, never the module.
    const toolAssert: V2AssertFn | null = typeof ctx.permission?.assert === "function" ? (input: unknown) => ctx.permission!.assert!(input) : null
    try {
      await ctx.tool.transform(async (editor) => {
        if (typeof editor?.add !== "function") return
        for (const [name, def] of Object.entries(forgeTools())) {
          const d = def as {
            description?: unknown
            args?: Record<string, unknown>
            execute?: (args: unknown, context: unknown) => Promise<unknown>
          }
          editor.add({
            name,
            description: typeof d.description === "string" ? d.description : name,
            input: v2ToolInputSchema(d.args),
            async execute(args: unknown, toolCtx: unknown) {
              const { context, defaultDirectory } = await v2ToolContext(toolCtx, toolAnchor, toolAssert)
              const res = await d.execute?.(args, context)
              return nameDefaultDirectory(wrapV2ToolResult(res), defaultDirectory)
            },
          })
        }
      })
    } catch {
      // Host-shape drift: tool registration is a silent no-op, never a throw.
    }
  }

  // ---- permission domain (task 3.1): the belt on ctx.permission.hook
  // ("evaluate") — doors keep a REAL ask (explicit deny stands), draft
  // write-freeze denies, forge_shell passes through untouched. Same
  // decision table as the v1 permission.ask hook; W6a pinned the event to
  // the real PermissionEvaluation shape (effect mutation). The v1
  // ask-callback decision gates — plan_approve/goal_write(arm)/
  // goal_complete/goal_resume/goal_discard/crew_close — map to
  // ctx.permission.assert; that bridge is captured per initialization in
  // the tool block above (fix-ask-door-multi-directory-host), never here
  // as module state. Pure classification/refusal stays evaluate-mutation.
  v2RegisterPermissionBelt(ctx)
  // worker-shell-session-allow D2/D4: capture the documented session-rule
  // surface (source-verified on 2.3.2: host.ts routes update.permissions to
  // sessions.setPermissions). The belt's read-back-merge lives in
  // ensureSessionRescueRule; absence degrades to the D5 fallback.
  if (typeof ctx.session?.get === "function" && typeof ctx.session.update === "function") {
    const rawGet = ctx.session.get.bind(ctx.session)
    const rawUpdate = ctx.session.update.bind(ctx.session)
    v2SessionRuleApi = {
      get: (sessionID) => rawGet({ sessionID }),
      update: (input) => rawUpdate(input),
    }
  }

  // ---- tool hooks (task 4.1): activity marking (execute.after ledger) +
  // the full dispatch-guard belt + the readonly-exec seal
  // (execute.before), all over the shared module predicates. W6a: the
  // before payload is {tool, sessionID, agent, messageID, id, input} —
  // the call id is `id` (Tool.CallID), the arguments are `input`.
  const v2Anchor = v2AnchorClient(ctx)
  anchorClientShared = v2Anchor
  v2RegisterToolHooks(ctx, v2Anchor)

  // ---- session-domain client (task 5.1, W6a-resolved): one client feeds
  // BOTH the goal continuation engine (prompt + get) and the module-level
  // jobClient seam (promptAsync ≈ the blocking prompt send) — only ONE
  // entry ever runs per host process, so the assignment is race-free.
  const v2Client = v2SessionClient(ctx)
  if (v2Client && (v2Client.session.promptAsync || v2Client.session.prompt)) jobClient = v2Client
  const goalClient =
    v2Client && typeof v2Client.session.prompt === "function" && typeof v2Client.session.get === "function" ? (v2Client as unknown as GoalClient) : null

  // ---- host-signal completion seams (dispatch-v2-hostsignals 3.2/4.1):
  // the one-shot wait latch (ctx.session.wait) and the persisted registry
  // domain (ctx.storage). v2-only — v1 keeps its journal-only posture
  // (design risk table: fail-soft to today's behavior).
  v2SessionWaitSeam = typeof ctx.session?.wait === "function" ? (sessionID: string) => ctx.session!.wait!({ sessionID }) : null
  v2DispatchStorage =
    ctx.storage && typeof ctx.storage.scan === "function" && typeof ctx.storage.set === "function"
      ? (ctx.storage as unknown as typeof v2DispatchStorage)
      : null
  // Launch-anchor journal recovery (task 4.2, server()-init parity): the
  // reload-mid-dispatch leg — a hot-reloaded generation replays the launch
  // anchor's journal exactly like a fresh v1 process does. Fail-soft.
  try {
    if (hostWorktree && !isRootish(hostWorktree)) {
      void recoverWorkspaceDispatches(v2Client as unknown as DispatchClient, hostWorktree)
    }
  } catch {
    // Recovery is best-effort by construction; never a throw into the host.
  }
  // Persisted-row adoption (task 4.2): scan ctx.storage rows for the
  // launch anchor and re-arm watching for live children (watch-only — an
  // adopted dispatch never re-spawns). Non-launch anchors adopt lazily via
  // the session.created branch of the event subscription.
  try {
    if (hostWorktree && !isRootish(hostWorktree)) {
      void adoptPersistedDispatchRows(v2Client as unknown as DispatchClient, hostWorktree)
    }
  } catch {
    // Adoption is fail-soft; the journal recovery remains the durable path.
  }

  // ---- session seams (task 4.2 + W6a idle choice): prompt (busy
  // marking) / context (thoughtLevel injection + family-gated system
  // injections + channel mandate + plan/goal notices) / compaction
  // (goal-brief reinjection) / experimental.idle (the PRIMARY idle edge —
  // goal continuation + job-wake delivery; SSE fallback below) —
  // Decision 3's event topology, fail-open on drift, registrations
  // collected for the setup cleanup.
  const sessionHooks = v2RegisterSessionHooks(ctx, goalClient)

  // ---- command domain (task 4.3): /plan /goal /crew, create-only,
  // templates byte-identical to the v1 constants.
  await v2RegisterCommands(ctx)

  // ---- event domain (task 5.1, W6a-resolved): the session.deleted
  // harvest on the AsyncIterable subscription (payload under .data); the
  // idle edge rides it ONLY when the in-process experimental.idle hook
  // could not be registered (drifted session domain). The returned
  // cleanup aborts the loop; the combined cleanup (hook disposals + loop
  // abort) is the setup Cleanup.
  const v2AbortEvents = v2SubscribeEvents(ctx, goalClient, !sessionHooks.idleHook)
  const disposables = [...sessionHooks.disposables, ...(v2AbortEvents ? [v2AbortEvents] : [])]
  return disposables.length > 0
    ? () => {
        for (const dispose of disposables) {
          try {
            dispose()
          } catch {
            // Cleanup is best-effort.
          }
        }
      }
    : undefined
}

export default { id: "forge", server, setup: v2Setup }
