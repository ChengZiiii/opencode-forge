import { stopNative, STOP_LIST_LIMIT } from "./src/stop-native.ts"
import { authorizedSearch, ambiguousSearchPath, jsGrep, type SearchInput, type SearchInvocation, type SearchMatch } from "./src/search-authorized.ts"
import { strictGlobToRegExp, matchGlob, MAX_FILE_BYTES } from "./src/search-js.ts"
import { resolveRgBinary } from "./src/search-core.ts"
import { spawnSync } from "node:child_process"
import { classifyGoalActivity, hasIdleBackgroundShell, idleBackgroundKnown, settledGoalRounds, observeGoalActivity, rememberGoalCheck, type GoalActivity } from "./src/goal-activity.ts"
import type { ToolDefinition } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { closeSync, fstatSync, openSync, readSync, appendFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs"
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
import { loadModelsDevSnapshot, modelDepthShape, parseIdentity, modelsDevCacheDir, type CatalogSnapshot } from "./src/models-dev.ts"
import { validateCrewReport, crewAcceptedRound, crossCheckCrewEvidence, type CrewRound, type CrewCloseEvidence, type CrewSubtask, type CrewSubtaskReport } from "./src/crew-gate.ts"
import { createNativeChildTracker, nativeChildDigestLine, nativeChildEventOutcome, nativeSessionBusy, walkNativeChildren, type NativeChildClient, type NativeChildOutcome, type NativeChildWalkView } from "./src/native-child-gate.ts"
import { forgeAgentDef, effectiveReadonlyShape } from "./src/dispatch-tiers.ts"
import { applyDepthTranslation, resolvePinnedDepth, type DepthChannel, type DepthTranslation } from "./src/dispatch-depth.ts"
import { legacyDispatchEnvFindings, createForgeConfigLoader, createPoolResolver, forgeConfigPaths, parseForgeJsonc, parseTopLevelKnobs, poolFileCompliance, recipeFileStat, sanitizeNamespace, type ForgeAgentDef, type ForgeMaterializeKnob, type LoadedForgeConfig, type PoolResolution } from "./src/forge-config.ts"
import { agentDirFor, rosterAgentDirFor, compileResolvedRosterEntry, executeRosterSync, globalAgentDirFor, planOverrideSync, overrideSyncFindings, planRosterSync, staleCheckForPool, NATIVE_TOOL_VOCAB, VARIANT_DEPTH_WORDS, type RosterFsDeps, type SyncPlan } from "./src/roster-compile.ts"


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
const FORGE_TOOL_SET = new Set<string>(FORGE_STATE_TOOLS)
const FORGE_STATE_TOOL_SET = new Set<string>(FORGE_STATE_TOOLS)

const FORGE_PROMPT = `You are forge — the single general-purpose coding agent. You handle every task directly: exploration, planning, implementation, and verification. There is no agent switching.

Workflow modes are strictly user-initiated. Never enter plan or goal mode — and never call a plan_* or goal_* tool — unless the user ran /plan or /goal, unmistakably asked for that mode (e.g. "plan first", "set a goal"), or the session already carries a [forge:plan-notice] / [forge:goal-notice] for a mode they started. Ordinary task requests are normal work. Mode-specific rules arrive with those commands and notices; when a notice is present, follow it.

Subagent dispatch (native \`subagent\` tool): when the work suits a scoped worker, prefer a configured \`forge-*\` subagent whose description matches the job. If none matches, say so plainly to the user and dispatch a host agent through the native \`subagent\` tool instead, subject to existing permissions and approvals. Native calls run in the background; use available host completion messages and session records as evidence, not repeated polling. Never assume unknown outcomes are settled. For ordinary commands, use the host shell when permitted; long commands can use \`background\` and host completion notifications rather than polling or sleeping. Git commits should use \`-m\` or \`--no-edit\`. Never create or edit files under .opencode/plan/ or .opencode/goal/ directly; use their state tools within the user-authorized mode.`

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
  "Inspect the current .opencode/plan/ directory using read/glob when needed for routing; treat an absent directory as empty.",
  "",
  "Route on the argument above (decide silently; do not recite this routing text to the user):",
  '- Argument empty: for every non-terminal plan (status draft or approved) in that directory, read its frontmatter and numbered checkboxes, then report to the user: path, status, progress (x/y ticked). Ask whether to resume one or start something new.',
  '- Argument "resume": pick the most recently updated non-terminal plan, summarize its remaining unticked steps to the user in one short list, then continue according to its status: if draft, remain read-only and follow user review and approval below; if approved, execute the remaining steps — tick each step the moment it is done (plan_tick). If none exists, say so.',
  '- Argument "discard": call the plan_discard tool with a short reason, then tell the user the plan was abandoned and writes are restored. If the work is NOT ending but moving to another harness — crew orchestration (/crew) or a goal contract (/goal) — pass supersede with the successor artifact path (e.g. ".opencode/crew/2026-10-01-....md") so the plan is marked superseded instead, with the successor recorded in the plan file.',
  "- Any other argument: treat it as the plan goal — you are now in planning mode for this goal. Follow the plan discipline below end to end.",
  "",
  "## Plan discipline",
  "",
  "Plans are short-horizon, single-goal documents (.opencode/plan/<date>-<slug>.md). The harness enforces the hard parts (draft write-ban, approval gate, verification at close); you supply the engineering judgment. Never edit or create plan files by hand — every change goes through the plan_* tools.",
  "",
  "1. Reconnaissance and alignment (read-only): explore with read/grep/glob, and use the native subagent tool for breadth evidence from effective-readonly forge scouts both BEFORE and DURING the draft. Only dispatch workers with a current, compatible definition and effective host permissions that match an explicitly readonly recipe, deny all file-mutating tools (write/edit/patch family), and explicitly deny shell. Respect ordinary host permissions; if eligibility is unknown or denied, stay with permitted read tools and disclose the limitation. The host delivers the background scout's findings in its completion message. Remain read-only: all write tools and the builtin shell are DENIED while a draft exists (plan_* tools manage the plan). Write-shaped workers, readonly workers with shell, and non-forge agents must wait for approval; do not attempt them, do not ask the user to bypass. Gather concrete evidence with file:line references (verified findings, not guesses). If the goal is ambiguous or leaves meaningful choices open (scope, approach, acceptance), settle them with the user FIRST — 1-3 focused questions — and only write the draft once the shape is agreed; never plan against assumptions the user could settle in one line.",
  "2. Draft (plan_write): call plan_write with structured fields; the tool renders and validates the fixed sections, so a malformed plan cannot exist. Quality bar: goal = one line, the outcome not the activity; context = verified findings with file:line evidence, including what you ruled out and why; approach = the chosen approach AND at least one rejected alternative with the reason (a plan with no considered alternative is a guess); tasks = 3-8 concrete, independently verifiable steps, each doable in one sitting ('improve the code' is invalid; 'extract the timeout constant into config.ts and default it to 3000' is valid); risks = what could break, blast radius, rollback path; acceptance = criteria verifiable by a command, a file, or an observable behavior (vague criteria will fail the close); nonGoals = explicit out-of-scope items. To revise after feedback, call plan_write again — while in draft it overwrites the same file.",
  "3. User review, then approval (plan_approve): after plan_write, present the plan in chat — goal, chosen approach with one line why, the numbered steps, the acceptance criteria — then STOP: end your turn and wait. The user owns the review, at their own pace: feedback → revise with plan_write, re-present, and wait again; rejection → /plan discard (or re-plan together); explicit go-ahead (e.g. \"execute\", \"批准\", \"looks good\") → call plan_approve — its confirmation dialog is the final hard gate, and the user's Allow starts execution. Never call plan_approve in the same turn that presents a draft, and never implement before approval succeeds.",
  "4. Execution (tick as you go): after approval succeeds, execute directly or dispatch via the native subagent tool, subject to ordinary host permissions. Work tasks in order; call plan_tick with the numbered step immediately after EACH step's work is actually done — never batch ticks, never tick ahead of reality (tick timestamps are an audit trail). If the plan turns out wrong mid-execution, do not silently improvise: tell the user what changed and either finish the affected step or ask about revising (/plan with the same goal re-enters planning).",
  "5. Completion (plan_close): when all tasks are ticked, self-check EVERY acceptance criterion with concrete evidence (file:line, command output, test result), then call plan_close — NO confirmation dialog appears. If the plan declares Verification Checks, the plugin itself re-runs the frozen check set on the host (fail-closed: a failing check refuses the close, records the run in the plan's Check Log, and the plan stays approved — that is the design working, not an inconvenience); otherwise your per-criterion self-checks gate the close. Either way an evidence summary is written into the plan file for the user to review asynchronously.",
  "",
  "Boundaries: /plan discard abandons the plan (terminal, file kept as history, writes restored) — pass supersede (the successor artifact path) when the work moves to crew/goal rather than ends, marking it superseded; /plan resume continues an unfinished plan from its remaining tasks. Work expected to span multiple sessions or days of multi-file change, or needing multi-round requirement review, is spec work (e.g. OpenSpec), not plan work — say so once and let the user choose.",
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
  '- Argument "pause": call the goal_pause tool (with the blocker text as `blocker` when there is one), then tell the user the goal is paused, that already accepted work may finish, and how to resume.',
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
  "- Argument empty or unknown: tell the user the four forms in one short list — /forge sync (force a roster sync NOW and show the diff), /forge init (draft this workspace's forge.json in-band), /forge init global (draft the global forge.json with commented built-in override entries), /forge stop (request stop of confirmed native child sessions) — and stop."

// Session-scoped cancellation. A parent interrupt does not guarantee the
// native children stop; /forge stop explicitly requests their cancellation.
export const STOP_LEVER_BODY = [
  '- Argument "stop": relay the command receipt for confirmed native child sessions; do not issue additional cancellation requests. Do not claim anything was stopped without confirmation. Do not launch further work.',
  "Boundaries: cancellation is USER intent only; do not touch unrelated sessions or commands. Interrupting the parent does not guarantee children stop; use /forge stop for explicit child cancellation. Report unknown outcomes honestly.",
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


function isForgeFamilyAgent(name: unknown): boolean {
  if (typeof name !== "string") return false
  const n = name.toLowerCase()
  return n === FORGE_AGENT || n.startsWith("forge-")
}

// Authorization is independent of tool visibility and host permission decisions.
function assertHarnessAgent(tool: string | undefined, speaker: string | undefined): void {
  if (!tool || !FORGE_STATE_TOOL_SET.has(tool) || speaker === FORGE_AGENT) return
  if (speaker && !isForgeFamilyAgent(speaker)) {
    throw new Error(`[forge:partition] Tool refused: "${tool}" belongs to the forge agent family and the current agent ("${speaker}") is outside it. Switch to forge (Tab) to use forge tooling.`)
  }
  if (speaker?.toLowerCase().startsWith("forge-")) {
    throw new Error(`[forge:partition] Tool refused: "${tool}" is a harness state tool reserved for the primary forge agent; "${speaker}" is a forge worker. Report your findings back to the orchestrating session — the primary agent calls ${tool} at the gate.`)
  }
  throw new Error(`[forge:partition] Tool refused: "${tool}" is reserved for the primary forge agent; primary identity is not established. Switch to forge (Tab) to use forge tooling.`)
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
// Historical recipe paths are for missing-artifact disclosure only. They
// never participate in resolution or authorize a sync plan.
const observedRecipeFiles = new Set<string>()
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
  const fixtureRoot = process.env.FORGE_TEST_FIXTURE_ROOT
  // Test-only boundary: resolve existing path components before any real
  // filesystem access. Missing directories are checked via their nearest
  // existing ancestor; an unresolvable existing entry fails closed.
  const checkPath = (path: string): void => {
    if (!fixtureRoot) return
    const within = (root: string, candidate: string) => {
      const rel = relative(root, candidate)
      return !isAbsolute(rel) && rel !== ".." && !rel.startsWith("../") && !rel.startsWith("..\\")
    }
    const refused = () => new Error(`test fixture root refused roster path: ${path}`)
    if (!within(fixtureRoot, path)) throw refused()
    const root = realpathSync(fixtureRoot)
    let cursor = path
    while (true) {
      try {
        lstatSync(cursor)
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err
        const parent = dirname(cursor)
        if (parent === cursor || !within(fixtureRoot, parent)) throw refused()
        cursor = parent
        continue
      }
      if (!within(root, realpathSync(cursor))) throw refused()
      return
    }
  }
  return {
    stat: (path) => {
      try {
        checkPath(path)
        const s = statSync(path)
        return { mtimeMs: s.mtimeMs, size: s.size }
      } catch {
        return null
      }
    },
    readFile: (path) => { checkPath(path); return readFileSync(path, "utf8") },
    writeFile: (path, data) => { checkPath(dirname(path)); checkPath(path); writeFileSync(path, data) },
    rename: (from, to) => {
      checkPath(dirname(from)); checkPath(from)
      checkPath(dirname(to)); checkPath(to)
      renameSync(from, to)
    },
    unlink: (path) => { checkPath(dirname(path)); checkPath(path); unlinkSync(path) },
    readdir: (path) => {
      try {
        checkPath(path)
        return readdirSync(path)
      } catch {
        return null
      }
    },
    mkdir: (path) => { checkPath(path); mkdirSync(path, { recursive: true }) },
  }
}

// The global layer's host knobs (materialize/sync), read fail-soft: an
// absent/unreadable/broken global file keeps the defaults.
function readGlobalKnobs(path: string, deps?: { readFile?: (path: string) => string }): { materialize: ForgeMaterializeKnob | undefined; syncAuto: boolean } {
  try {
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
  const rosterDirs = { globalPoolFile: globalPoolPathOf(), globalAgentDir: overrideDir }
  const overridePlan = resolution
    ? planOverrideSync(resolution.overrides ?? {}, {
        dir: overrideDir,
        recipeFile: globalPoolPathOf(),
      })
    : null
  if (!resolution) {
    return { lines: ["[forge:sync] No forge.json recipe is visible to this host — nothing to compile (the recipe is the authority; native files are only its projection)."], errorCount: 0 }
  }
  const missingRecipeNotes: string[] = []
  const candidateFiles = new Set([globalPoolPathOf(), ...observedRecipeFiles, ...hostAnchors.map((anchor) => forgeConfigPaths({ projectDir: anchor }).project)])
  for (const file of candidateFiles) {
    const fixtureRoot = process.env.FORGE_TEST_FIXTURE_ROOT
    if (fixtureRoot) {
      const rel = relative(fixtureRoot, file)
      if (isAbsolute(rel) || rel === ".." || rel.startsWith("../") || rel.startsWith("..\\")) continue
    }
    if (recipeFileStat(file) !== null) continue
    const verdict = staleCheckForPool(file, [], realRosterFs(), rosterContentOf(resolution), rosterAgentDirFor(file, rosterDirs))
    if (verdict.stale) missingRecipeNotes.push(`  finding [warn]: ${verdict.reason}; restore the recipe or explicitly manage its generated files (sync leaves them untouched).`)
  }
  if (resolution.families.length === 0 && overridePlan === null) {
    return { lines: ["[forge:sync] No forge.json recipe is visible to this host — nothing to compile (the recipe is the authority; native files are only its projection).", ...missingRecipeNotes], errorCount: 0 }
  }
  const recipeUsable = (file: string) => recipeFileStat(file) !== null && !resolution.findings.some((f) => (f.code === "config-parse-error" || f.code === "config-not-object") && f.message.startsWith(`${file}:`))
  const plans: SyncPlan[] = planRosterSync(resolution, rosterDirs).filter((p) => recipeUsable(p.family.file))
  // builtin-override (E2E scenario-6 fix): the override channel ALWAYS rides
  // the sync — planOverrideSync returning null (no ACTIVE entries) becomes an
  // empty plan, which is exactly the DEACTIVATION pass: the executor's
  // marker-keyed GC removes stale general.md/explore.md the recipe no longer
  // wants. Hand-written files never carry the marker and are never touched;
  // when nothing is configured and nothing stale exists the pass is a no-op
  // (one readdir + marker check, zero writes).
  if (recipeUsable(globalPoolPathOf())) plans.push(overridePlan ?? { kind: "override", dir: overrideDir, files: [] })
  const outcome = executeRosterSync(plans, realRosterFs())
  const lines = [`[forge:sync] Compiled ${plans.reduce((n, p) => n + p.files.length, 0)} roster file(s) across ${plans.filter((p) => p.files.length > 0).length} pool(s):`, ...missingRecipeNotes]
  if (foldPath(agentDirFor(rosterDirs.globalPoolFile)) !== foldPath(overrideDir)) lines.push(`  global artifacts use ${overrideDir}; former recipe-sibling path ${agentDirFor(rosterDirs.globalPoolFile)} is not scanned or cleaned by this global sync.`)
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

// Content oracle for the staleness gate: use exactly the sync compiler.
function rosterContentOf(resolution: PoolResolution): (matId: string) => string {
  const globalPoolFile = globalPoolPathOf()
  return (matId) => compileResolvedRosterEntry(resolution, matId, { globalPoolFile }).content
}

// Staleness refusal for the crew gate (design D4): native mode refuses
// registration when the session's roster artifacts are stale, with the
// one-step fix (same gate language family as the compliance refusal).
function rosterStaleRefusal(anchor: string | null): string | null {
  const resolution = resolvePools()
  const poolFile = anchor ? sessionPoolFileOf(anchor) : null
  const fam = resolution?.families.find((f) => foldPath(f.file) === foldPath(poolFile ?? globalPoolPathOf()))
  const file = fam ? fam.file : poolFile
  const verdict = staleCheckForPool(file, fam ? fam.materializedIds : [], realRosterFs(), resolution ? rosterContentOf(resolution) : undefined, file === null ? undefined : rosterAgentDirFor(file, { globalPoolFile: globalPoolPathOf(), globalAgentDir: globalAgentDirFor({ homeDir: process.env.FORGE_TEST_FORGE_HOME ?? homedir(), configDir: process.env.OPENCODE_CONFIG_DIR }) }))
  if (!verdict.stale) return null
  return (
    `[forge:crew] Roster stale refused: this session's native roster artifacts are out of date with the recipe — ${verdict.reason}. ` +
    `One-step fix: call the forge_sync tool NOW (it recompiles .opencode/agent/forge-*.md atomically, in-band, transcript-visible; the host hot-applies without a restart), then retry this registration. ` +
    `The recipe (forge.json) stays the authority — the gate only refuses dispatching against a stale projection.`
  )
}

// Anchor normalization: resolved real path, backslashes + case-folding on
// win32 — "C:/Temp1" and "c:\temp1\" cannot double-add.
function anchorPath(dir: string): string {
  const p = (dir ?? "").trim()
  if (!p) return ""
  try {
    return realpathSync(p)
  } catch {
    // Missing/unresolvable (e.g. tests with fake fs): keep the trimmed input.
    return p
  }
}

function anchorKey(path: string): string {
  return process.platform === "win32" ? path.replace(/\//g, "\\").toLowerCase() : path
}

function normalizeAnchorDir(dir: string): string {
  return anchorKey(anchorPath(dir))
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
  const path = anchorPath(dir)
  const normalized = anchorKey(path)
  if (!normalized) return
  // The folded identity is only a dedup key; retain the real path for
  // discovery, provenance and filesystem operations.
  if (!hostAnchors.some((anchor) => anchorKey(anchor) === normalized)) hostAnchors.push(path)
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
  const resolution = poolResolver.resolve(hostAnchors)
  for (const family of resolution.families) observedRecipeFiles.add(family.file)
  return resolution
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
const CREW_WAVE_RULE =
  "A wave is the set of native `subagent` calls made together by the orchestrating session (agent = the selected worker). Reuse of a sessionID starts another work round; duplicate observations of one round count once. Children work in the background; use host completion messages and available session evidence to verify settlement. Launch the next wave ONLY after every work round of the previous wave is verified settled. Partial, truncated or unknown views, idle or missing sessions, and unresolved outcomes do not establish settlement; end your turn and wait for the rest, without polling or sleeping. A diagnostic is not permission to launch another wave."
const CREW_NATIVE_FALLBACK_RULE =
  "Native fallback: when the pool offers no forge worker fitting a subtask or the pool is degraded, disclose the gap and suggest configuring the missing role; use the native `subagent` tool for a non-forge agent (e.g. general) only when permitted, with the same relay contract (artifact path, scoped prompt, evidence demands) and RECORD the fallback (wave notes + the subtask's close evidence says it ran native). Respect all approvals and host permissions."
// Legacy task-belt refusal: keep its live-runtime wording until 6.4 migrates the belt.
const CREW_COMPLIANCE_NATIVE_EXIT =
  " Repair the pool before retrying the refused operation; respect existing approvals and permissions."
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
type CrewEntry = { objective: string; startedAt: string; subtasks: CrewSubtask[]; mode: CrewMode; recordPath: string | null; goalGoverned?: boolean; rounds?: CrewRound[] }
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
    "[forge:crew] The crew is PENDING — execution has NOT started. Present the execution-mode choice to the user and END YOUR TURN (do not start any subagent work while the crew pends):",
    `RELAY FIRST: tell the user the crew record path (it leads this output) alongside this choice — the record is on disk from the registration moment, and the user must hear it.`,
    `  1. supervised waves NOW — when the user says go, call crew_begin {execution: "waves"} and run the wave discipline; waves auto-advance on session idle until crew_close only after verified settlement of the previous wave (the engine stops after a stall — nudge or re-shard);`,
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
// the models-dev cache and session-anchor ledger. Diagnostic probes use
// the same temp redirect. Production's two levels are
// mirrored by two helpers, both resolved AT USE TIME:
//   forgeRuntimeTmp()  = the `<os-tmp>` level
//   forgeRuntimeRoot() = `<os-tmp>/opencode-forge` (models-dev/, session-anchors.jsonl)
// and the `<os-tmp>` level is:
//   production             → undefined → each helper's own default (as ever)
//   FORGE_TEST_RUNTIME_DIR → a test swaps the `<os-tmp>` level (the suite
//                            preloads a private temp dir via --import)
// FORGE_TEST_FORGE_HOME is NOT this axis: it stays exactly what it always was
// — the HOME alias for config discovery, plus this ledger's historical knob.
// Production never sets FORGE_TEST_RUNTIME_DIR; the retained paths are unchanged.
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

// Both entry points use the same snapshot/cache and fail-soft policy.
async function refreshModelsDevCatalog(skipFetch = process.env.FORGE_TEST_NO_DISPATCH_FETCH === "1", timeoutMs?: number): Promise<void> {
  if (skipFetch) {
    modelsDevCatalog = null
    return
  }
  try {
    const snapshot = await loadModelsDevSnapshot({ cacheDir: modelsDevCacheRoot(), timeoutMs })
    modelsDevCatalog = snapshot.catalog
  } catch {
    modelsDevCatalog = null
  }
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
  modelsDevCacheRoot,
  modelsDevCacheDir: (): string => modelsDevCacheDir(modelsDevCacheRoot()),
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
async function poolGateRefusal(anchorClient: { session?: { get?: (opts: unknown) => Promise<unknown> } } | null | undefined, sessionID: string, target: string, requireEntry = false, deferMissing?: (refusal: string) => void): Promise<string | null> {
  const anchor = await resolveSessionAnchorForPools(anchorClient, sessionID)
  return poolGateRefusalAtAnchor(anchor, sessionID, target, requireEntry, deferMissing)
}

function poolGateRefusalAtAnchor(anchor: string, sessionID: string, target: string, requireEntry = false, deferMissing?: (refusal: string) => void): string | null {
  const resolution = resolvePools()
  const agentId = target.slice("forge-".length)
  const entry = resolution?.agents[agentId]
  if (!entry && !requireEntry) return null
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
  if (!entry) {
    // Preserve stale-roster recovery guidance before reporting a missing role.
    const stale = nativeRosterActive() ? rosterStaleRefusal(anchor) : null
    const refusal = stale ?? (
      `[forge:pool] Dispatch refused: "${target}" is not a materialized forge subagent and is not dispatchable from this session. ` +
      `This session's dispatchable roster is ${sessionPool ? `its workspace pool (${sessionPool})` : `the global fallback (${globalPoolPathOf()})`}. ` +
      `Exits: open a session in the role's workspace, or configure the role into this workspace's pool (its .opencode/forge.json), or into the global layer (${globalPoolPathOf()}).`
    )
    // An absent entry proves no foreign origin. Keep the refusal while the
    // crew belts provide the more specific pending/compliance recovery.
    if (deferMissing) {
      deferMissing(refusal)
      return null
    }
    return refusal
  }
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
  return crewComplianceRefusalAtAnchor(anchor, sessionID, target)
}

function crewComplianceRefusalAtAnchor(anchor: string, sessionID: string, target: string): string | null {
  if (!anchor || !target.toLowerCase().startsWith("forge-")) return null
  const crew = crews.get(sessionID)
  if (!(crew && (crew.mode === "pending" || crew.mode === "executing"))) return null
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
//
// fix-unknown-session-anchor-seed (design D2): the draft-shape verdict over
// an ALREADY-RESOLVED state. Async callers resolve the session first
// (stateForCheck — host record on a multi-directory process) and judge this;
// the synchronous wrapper below keeps the v1 belt's signature and its
// single-directory seeding.
function draftDispatchRefusalForState(state: SessionState | null, target: string | undefined): string | null {
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

function nativeDraftDispatchRefusal(state: SessionState, target: string | undefined): string | null {
  const pool = sessionPoolFileOf(state.worktree) ?? globalPoolPathOf()
  const resolution = resolvePools()
  const scouts = Object.entries(resolution?.agents ?? {}).filter(([, entry]) =>
    pool !== null && foldPath(entry.file) === foldPath(pool) && effectiveReadonlyShape(entry.def) &&
    (entry.def.permission?.shell === "deny" || entry.def.permission?.bash === "deny"))
  const roster = rosterStaleRefusal(state.worktree) ? [] : scouts.map(([id]) => "forge-" + id).sort()
  if (target && roster.includes(target)) return null
  return "[forge] A plan is in draft; dispatch is denied for this target. " +
    (roster.length ? "Qualified readonly recon scouts: " + roster.join(", ") + ". " : "No current qualified shell-denied readonly scout. Define a readonly worker in forge.json with explicit shape readonly and shell permission deny. ") +
    "Wait for plan_approve or /plan discard."
}

// Keep legacy task/bash classified until the old execution surfaces retire.
// Native dispatch is conservatively write-class until its draft recon gate lands.
const WRITE_TOOLS = new Set<string>([
  ...NATIVE_TOOL_VOCAB.mutatingFamily,
  ...NATIVE_TOOL_VOCAB.legacyShellKeys,
  NATIVE_TOOL_VOCAB.dispatchTool,
  NATIVE_TOOL_VOCAB.taskKey,
])

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
    atomicWrite(path, text)
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
    atomicWrite(active.path, next)
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
// gate() never auto-resolves. plan_close is not a door:
// its completion gate is plugin-verified — the
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

// The exact user-confirmation doors, shared by gate() and both permission adapters.
const GATE_PERMISSION_KEYS = [
  "plan_approve",
  "goal_write",
  "goal_complete",
  "goal_resume",
  "goal_discard",
  "crew_close",
] as const

// Every permission a gate() call may name (fix-crew-close-ask-door D2).
type GatePermissionKey = (typeof GATE_PERMISSION_KEYS)[number]


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
    atomicWrite(active.path, transitionStatus(readFileSync(active.path, "utf8"), "approved", nowIso()))
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
    atomicWrite(active.path, next)
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
            ...(existing.doc.status === "paused" && existing.doc.stopReason ? { stopReason: existing.doc.stopReason, blocker: existing.doc.blocker } : {}),
          },
        ),
        existing.doc,
      )
      atomicWrite(existing.path, text)
      const doc = parseGoal(text)
      const retry = goalNativeRecheck.get(doc.session)
      const flight = continuationInFlight.get(doc.session) ?? goalDeadlineTimers.get(doc.session)
      if (doc.status === "active" && (retry || flight)) {
        goalStopNativeRecheck(doc.session)
        goalArmNativeRecheck(doc.session, (retry || flight)!.client, { path: existing.path, doc }, retry ? retry.deadlineOnly : false)
        goalArmDeadline(doc.session, (retry || flight)!.client, { path: existing.path, doc })
      }
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
            "The loop is intended to continue this session on eligible idle turns until the goal completes, pauses, or the budget runs out. Work the criteria; call goal_check whenever you believe they hold; goal_complete re-runs every check itself and asks the user. If globally blocked with no independent authorized work remaining, call goal_pause with the concrete blocker. If a local issue leaves independent authorized work, continue that work. End your turn during genuine host waiting rather than polling.",
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
    const activity = turnActivity.get(context.sessionID)
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
    const output = [
      `Host verification run (revision ${goal.doc.revision}), recorded in the Check Log:`,
      formatOutcomes(outcomes),
      ok ? "All selected items pass. Proceed to goal_complete (it re-runs everything itself at the gate)." : "Failing items remain — fix the work, then re-run goal_check.",
    ].join("\n")
    if (activity && turnActivity.get(context.sessionID) === activity) rememberGoalCheck(activity, selected, outcomes, output)
    return { title: `goal_check ${ok ? "all pass" : "failing"}`, output }
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
    "Pause the session's live goal (active -> paused); do not start further autonomous work. Already accepted host work may finish; cancellation is not promised. Always safe, no confirmation needed. Pass the blocker text when pausing because you are stuck (stop_reason blocker); omit it for a user-requested pause.",
  args: {
    blocker: tool.schema.string().optional().describe("Specific blocker that prevents progress (recorded as stop_reason blocker)"),
  },
  execute: async (args, context) => {
    const state = ensureSession(context.sessionID, worktreeFor(context))
    const goal = resolveSessionGoal(state)
    if (!goal || goal.doc.status !== "active") {
      throw new GoalError(`No active goal to pause (status: ${goal?.doc.status ?? "none"}).`)
    }
    const stopReason: StopReason = args.blocker?.trim() ? "blocker" : "user"
    atomicWrite(goal.path, transitionGoal(readFileSync(goal.path, "utf8"), "paused", nowIso(), { stopReason, blocker: args.blocker?.trim() }))
    engineForgetSession(context.sessionID)
    if (goal.doc.session && goal.doc.session !== context.sessionID) engineForgetSession(goal.doc.session)
    context.metadata({ title: `Goal paused (${stopReason}): ${goal.doc.goal}` })
    return {
      title: `goal paused (${stopReason})`,
      output: `Goal paused: ${relFrom(state.worktree, goal.path)} (stop_reason: ${stopReason}${args.blocker ? ` — ${args.blocker}` : ""}). Do not start further autonomous work; already accepted host work may finish. /goal resume or an explicit "continue" from the user re-arms it through a confirmation dialog.`,
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
    const confirmed = parseGoalLoose(text)
    if (!confirmed || confirmed.status !== goal.doc.status || confirmed.revision !== goal.doc.revision || confirmed.armedAt !== goal.doc.armedAt || confirmed.session !== goal.doc.session || confirmed.created !== goal.doc.created) {
      throw new GoalError("Goal authorization changed while awaiting confirmation; retry goal_resume.")
    }
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

function bindChildToDirectory(childSessionID: string | undefined, directory: string | undefined): void {
  if (!childSessionID || !directory || isRootish(directory)) return
  ensureSession(childSessionID, directory)
}

// /crew discipline (spec: crew-harness, change simplify-dispatch-to-static-agents):
// a template rulebook + an in-memory registry. The native workflow describes
// waves of `subagent` calls and separately delivered results; the declared subtask plan
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
    "Configured forge subagents (native subagent tool). ROSTER OWNERSHIP (sole ownership): THIS session's dispatchable roster is its WORKSPACE pool — the nearest .opencode/forge.json walking up from this session's worktree — or, when the workspace has none, the GLOBAL fallback layer (a fallback, not a merge; forge.json files nested deeper in the workspace subtree are ignored, same as opencode's native MCP config). Check this workspace's pool:",
    '  - this workspace pool (when the path prints, its agents ARE the roster): !`ls .opencode/forge.json 2>/dev/null || echo "(no workspace pool — the global fallback applies)"`',
    `  - global fallback layer: ${globalPath} — dispatchable ONLY when the workspace has no pool of its own`,
    ...(otherLines.length > 0
      ? ["Other pools materialized on this host — each NOT dispatchable from this session (open a session in that workspace, or configure the role into this workspace's pool / the global layer):", ...otherLines]
      : []),
    "",
    "You are entering CREW ORCHESTRATION discipline for this session (single subject: do not switch agents). The macro contract above the crew may come from an approved plan, a spec change, or inline text — the discipline is identical in all three cases and never requires a plan. Follow it exactly:",
    "",
    "1. REGISTER: call `crew_begin` with the objective AND the declared subtask plan (subtasks[]: one {title} per subtask, optionally naming the intended forge-* agent). When the macro contract descends from a plan artifact, pass its path as the optional `lineage` argument (e.g. lineage: \".opencode/plan/2026-10-01-my-plan.md\") — the descent is recorded as a first-class line in the crew record header; lineage is never inferred. Reconnaissance BEFORE registration is subject to ordinary host permissions and existing approvals. If crew_begin refuses (a crew is already active here, or a plan draft is active), STOP and tell the user why — never start a second crew. A wrong plan is fixed by abandoning and re-crewing (crew_close {abandon: true, reason}), never by improvising outside the declared plan.",
    '2. THE PAUSE: registration enters a PENDING crew — execution has NOT started. STOP and present the user the three execution-mode choices (supervised waves now / convert to a goal contract / standby), then END YOUR TURN. Arm per the user\'s choice: waves → crew_begin {execution: "waves"} (waves then continue on session idle only after verified settlement and while authorization remains — if stalled, seek the user’s decision or re-shard within existing approvals); conversion → crew_begin {execution: "goal"} followed by goal_write (arm=true — its dialog is the user\'s gate) folding the declared subtasks into criteria/checks; standby → no call. EXCEPTION: while a live active goal governs this session, register with execution: "waves" in the SAME call — the crew is born armed (the goal contract already authorized orchestration) and crew_close / abandon stay ask-free under that goal.',
    `3. WAVES, NEVER FLOODS (armed crews only): ${CREW_WAVE_RULE} GUI / computer-use subtasks are mutually exclusive within a wave (the desktop is a singleton resource — at most ONE in flight; non-GUI subtasks still parallelize freely), and GUI walkthroughs use the \`computer\` tool rather than DIY shell screenshot pipelines. ${CREW_NATIVE_FALLBACK_RULE}`,
    "4. CONTRACT RELAY (lineage-descended crews): when the macro contract descends from an on-disk artifact (the lineage names a plan artifact, a spec change directory, or a goal contract), every subtask's dispatch prompt MUST explicitly carry that artifact's path — or the exact slice the subtask works from (a delta file path, a quoted criteria section) — so the dispatched worker reads the contract itself, never your paraphrase of it. A large artifact is relayed by its exact slice; it is NEVER dropped for being too long to inline. Every close-report evidence statement MUST name the contract (or slice) the subtask worked against.",
    "5. MISSING ROLE: when a subtask needs a role no configured forge-* agent matches, tell the user about the gap — suggest configuring the missing role in forge.json. Use only an authorized native subagent for that work.",
    "6. VERIFY: judge each subtask strictly against its acceptance-evidence statement using the child's report and verified evidence. Associate the declared title with the work rounds (including a reused session), attempts and any recorded fallback. A host terminal outcome alone does not establish PASS; unknown or incomplete evidence cannot establish PASS.",
    "7. RETRY AT MOST ONCE: a failed subtask may be retried once with an adjusted prompt or agent, subject to existing approvals. Keep both attempts visible; only verified successful evidence supports PASS after a failure. If the retry also fails, record FAIL with BOTH failure reports visible (attempts[]). Do not retry twice, do not paper over a failure.",
    "8. CLOSE: when all work rounds are verified settled and every declared subtask has a verdict, call `crew_close` with the full report (title/verdict/evidence per subtask; attempts[] for FAILs). The gate cross-checks the report against the declared plan — a declared subtask missing from the report refuses the close, and so does an undeclared one. The user confirms the closing dialog under existing approval rules.",
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
    // fix-unknown-session-anchor-seed D2: an unknown session is judged by
    // its OWN directory (host record on a multi-directory process) — without
    // the seed it would otherwise not be judged at all.
    const state = await stateForCheck(context.sessionID, sharedAnchorClient())
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
      crew.goalGoverned = governingGoalFor(context.sessionID)
      crew.mode = "executing"
      appendCrewRecord(crew.recordPath, "armed (waves)", ["The user chose supervised waves; the dispatch belt is lifted."])
      return {
        title: `crew armed: ${crew.objective.slice(0, 60)}`,
        output: [
          `[forge:crew] Crew ARMED for supervised waves: ${crew.objective}`,
          `Waves auto-advance on session idle until crew_close only after verified settlement of the previous wave (the engine stops after a stall — nudge or re-shard).`,
          `Declared plan (${crew.subtasks.length}):`,
          ...crew.subtasks.map((s, i) => `  ${i + 1}. ${s.title}${s.agent ? ` → ${s.agent}` : ""}`),
          `Proceed with the wave discipline: ${CREW_WAVE_RULE} Record per-subtask evidence verdicts, at most one retry, then crew_close with the full report covering every declared subtask under existing user approval rules.`,
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
    crews.set(context.sessionID, { objective: objectiveText, startedAt: nowIso(), subtasks, mode: governed ? "executing" : "pending", recordPath, goalGoverned: governed })
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
        "This crew is driven by the goal engine's own continuations (no separate crew briefs); standalone waves auto-advance on session idle until crew_close only after verified settlement of the previous wave (the engine stops after a stall — nudge or re-shard).",
        `Wave discipline: ${CREW_WAVE_RULE} Record per-subtask evidence verdicts, at most one retry, then crew_close with the full report covering every declared subtask under existing approval rules.`,
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
      attempts: tool.schema.array(tool.schema.string()).optional().describe("Both attempts when retried, including both failure reports for FAIL"),
      rounds: tool.schema.array(tool.schema.string()).optional().describe("Optional native dispatch call IDs when the dispatch description does not identify this declared title"),
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
    if (check.ok) {
      const read = (context as unknown as { crewCloseEvidence?: () => Promise<CrewCloseEvidence> }).crewCloseEvidence
      const evidence = read ? await read() : { rounds: crew.rounds ?? [], readable: false, inFlight: [], settled: [], context: null }
      check.gaps.push(...crossCheckCrewEvidence(report, crew.subtasks, evidence))
      check.ok = check.gaps.length === 0
    }
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
  tools.crew_begin = crewBeginTool
  tools.crew_close = crewCloseTool
  // The host owns the v2 registry lifecycle; the retained v1 getter
  // independently decides whether to expose this factory at all.
  tools.forge_sync = forgeSyncTool
  for (const [name, def] of Object.entries(tools)) {
    if (!FORGE_STATE_TOOL_SET.has(name)) continue
    tools[name] = {
      ...def,
      async execute(args, context) {
        const speaker = v2AgentNameOf(context) ?? sessionAgents.get(context.sessionID)
        assertHarnessAgent(name, speaker)
        return def.execute(args, context)
      },
    }
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

// fix-unknown-session-anchor-seed (design D1): the directories THIS process
// has initialized through the v2 setup entry — the same non-root anchor that
// feeds hostWorktree on every initialization. On a multi-directory host
// "the last initialized directory" is another directory's, so it must never
// decide where a session the plugin does not know lives. The set is the ONE
// switch for launch-directory seeding: empty (a v1 host — v2Setup never runs)
// or one entry (a single-directory v2 host) seeds exactly as before; two or
// more never seed. Eviction does not shrink the set: this host generation's
// eviction signals are unreliable (location.shutdown is not emitted; a
// healthy location's build.close does not run), so a process that has ever
// initialized a second directory stays multi-directory for the rest of its
// life — the fail-safe direction (an unresolved session, never a wrong one).
const v2InitializedDirs = new Set<string>()

function banSeedAllowed(): boolean {
  return v2InitializedDirs.size <= 1
}

// Bind a session for ban lookups: known state, or — on a single-directory
// process only — seeded from the launch worktree. Returns null only when
// nothing is known about the session.
function stateForBan(sessionID: string | undefined): SessionState | null {
  if (!sessionID) return null
  const existing = sessions.get(sessionID)
  if (existing) return existing
  if (!hostWorktree || !banSeedAllowed()) return null
  return ensureSession(sessionID, hostWorktree)
}

// fix-unknown-session-anchor-seed (design D2): the async resolver every seam
// that can await uses BEFORE it judges a session. A known session is
// returned as is. On a single-directory process an unknown session seeds
// exactly as stateForBan does. On a multi-directory process an unknown
// session is resolved from the HOST's own session record (the session's own
// directory, else the same read on each parentID up the chain — the tool
// bodies' chain), read through the client the calling seam owns, and bound
// by the tool bodies' own write path. When the host gives nothing the
// session stays UNBOUND: null, never a guess, never a default directory.
async function stateForCheck(sessionID: string | undefined, anchorClient: V2AnchorReader | null | undefined): Promise<SessionState | null> {
  if (!sessionID) return null
  const known = stateForBan(sessionID)
  if (known) return known
  // Single-directory process (a v1 host included): stateForBan has either
  // seeded above, or there is no launch directory to seed from. The host
  // record is not consulted — the pre-change behavior, exactly.
  if (banSeedAllowed()) return null
  const directory = await hostSessionDirectory(anchorClient ?? null, sessionID)
  return directory ? ensureSession(sessionID, directory) : null
}

// fix-unknown-session-anchor-seed (design D3): the base directory a
// RELATIVE path is resolved against by the state-file boundary. The launch
// directory is a base on a single-directory process only — on a
// multi-directory process an unbound session has no base, and the boundary
// judges the path by its own spelling (see the seam) instead of joining it
// onto another directory's.
function banBaseDirectory(state: SessionState | null): string {
  return state?.worktree ?? (banSeedAllowed() ? hostWorktree : "")
}

// A dispatch client's session.get declares its REST-ish argument type; the
// anchor reader types the same call's parameter as unknown. The runtime call
// is the same { path: { id } } either way — one cast, in one place.
function anchorReaderOf(client: unknown): V2AnchorReader {
  return client as V2AnchorReader
}

// ---------------------------------------------------------------------------
// Goal continuation engine state (module-level so tools can reset it)
// ---------------------------------------------------------------------------

// Debounce between a session.idle event and the continuation send.
const IDLE_DEBOUNCE_MS = Number(process.env.FORGE_GOAL_DEBOUNCE_MS ?? 2000)

const idleTimers = new Map<string, { timer: ReturnType<typeof setTimeout>; client: GoalClient }>()
const continuationInFlight = new Map<string, { client: GoalClient }>()
const disposedGoalClients = new WeakSet<GoalClient>()

// Each v2 setup creates its own adapter. Revoke only work captured by it;
// session-wide forgetting can write a ledger and would affect other setups.
function disposeGoalClient(client: GoalClient): void {
  disposedGoalClients.add(client)
  for (const [id, pending] of idleTimers) {
    if (pending.client !== client) continue
    clearTimeout(pending.timer)
    idleTimers.delete(id)
  }
  for (const [id, flight] of continuationInFlight) {
    if (flight.client !== client) continue
    continuationInFlight.delete(id)
    const pending = pendingContinuationTurn.get(id)
    if (pending?.client === client && pending.turn === undefined) {
      pendingContinuationTurn.delete(id)
      turnActivity.delete(id)
    }
  }
  for (const [id, pending] of goalDeadlineTimers) {
    if (pending.client === client) goalStopDeadline(id)
  }
  for (const [id, pending] of goalNativeRecheck) {
    if (pending.client === client) { goalStopNativeRecheck(id); goalNativeWatch.delete(id) }
  }
  for (const [id, pending] of crewNativeRecheck) {
    if (pending.client === client) crewStopNativeRecheck(id)
  }
}
// Goal waits reuse the native host walk, but never accept an old child event
// as proof of a reused session's current round. Keep the observed busy IDs
// until their own durable terminal rows are visible.
const goalNativeWatch = new Map<string, Set<string>>()
const goalAcceptedCalls = new Map<string, Map<string, string>>()
const goalBackgroundHeld = new Set<string>()
const goalDeadlineTimers = new Map<string, { timer: ReturnType<typeof setTimeout>; client: GoalClient }>()
function goalStopDeadline(sessionID: string): void {
  const pending = goalDeadlineTimers.get(sessionID)
  if (pending) clearTimeout(pending.timer)
  goalDeadlineTimers.delete(sessionID)
}
function goalArmDeadline(sessionID: string, client: GoalClient, goal: ActiveGoal): void {
  goalStopDeadline(sessionID)
  const deadline = Date.parse(goal.doc.armedAt || goal.doc.created) + goal.doc.maxMinutes * 60_000
  const timer = setTimeout(() => {
    if (goalDeadlineTimers.get(sessionID)?.timer !== timer) return
    goalDeadlineTimers.delete(sessionID)
    if (disposedGoalClients.has(client)) return
    const state = sessions.get(sessionID)
    const fresh = state && resolveLiveGoal(state)
    if (!state || !fresh || fresh.path !== goal.path || fresh.doc.status !== "active" || fresh.doc.session !== sessionID || fresh.doc.revision !== goal.doc.revision || fresh.doc.armedAt !== goal.doc.armedAt) return
    if (budgetState(fresh.doc) === "budget-time") void autoPauseGoal(client, state, fresh, "budget-time", false)
    else if (Date.now() <= deadline) goalArmDeadline(sessionID, client, fresh)
  }, Math.max(1, deadline - Date.now() + 1))
  timer.unref?.()
  goalDeadlineTimers.set(sessionID, { timer, client })
}
const goalNativeRecheck = new Map<string, { timer: ReturnType<typeof setTimeout>; client: GoalClient; deadlineOnly: boolean }>()
function goalStopNativeRecheck(sessionID: string): void {
  const pending = goalNativeRecheck.get(sessionID)
  if (pending) clearTimeout(pending.timer)
  goalNativeRecheck.delete(sessionID)
}
function goalNativeViewHeld(sessionID: string, view: NativeChildWalkView): boolean {
  if (!view.readable) return true
  const watched = goalNativeWatch.get(sessionID) ?? new Set<string>()
  for (const child of view.inFlight) watched.add(child)
  for (const row of view.settled) {
    if (row.outcome) watched.delete(row.childID)
    else watched.add(row.childID)
  }
  if (watched.size) goalNativeWatch.set(sessionID, watched)
  else goalNativeWatch.delete(sessionID)
  return watched.size > 0 || view.settled.some(row => !row.outcome)
}
function goalArmNativeRecheck(sessionID: string, client: GoalClient, goal: ActiveGoal, deadlineOnly = false): void {
  if (goalNativeRecheck.has(sessionID) || disposedGoalClients.has(client)) return
  const deadline = Date.parse(goal.doc.armedAt || goal.doc.created) + goal.doc.maxMinutes * 60_000
  const remaining = Math.max(1, deadline - Date.now() + 1)
  // After the observation ceiling, stop polling; one final deadline check
  // preserves the wall-clock budget even without another host edge.
  const ceiling = crewNativeCeiling.get(sessionID)?.disclosed
  const interval = CREW_NATIVE_CHILD_RECHECK_MS > 0 ? CREW_NATIVE_CHILD_RECHECK_MS : remaining
  const delay = ceiling || deadlineOnly ? remaining : Math.min(interval, remaining)
  const timer = setTimeout(() => {
    if (goalNativeRecheck.get(sessionID)?.timer !== timer) return
    goalNativeRecheck.delete(sessionID)
    const state = sessions.get(sessionID)
    const fresh = state && resolveLiveGoal(state)
    if (!fresh || fresh.path !== goal.path || fresh.doc.status !== "active" || fresh.doc.session !== sessionID ||
        fresh.doc.revision !== goal.doc.revision || fresh.doc.armedAt !== goal.doc.armedAt) return
    if (!idleTimers.has(sessionID)) void continueIfEligible(client, sessionID, deadlineOnly)
  }, delay)
  timer.unref?.()
  goalNativeRecheck.set(sessionID, { timer, client, deadlineOnly })
}

const transportFails = new Map<string, number>()
const noProgressStreak = new Map<string, number>()
// Per-continuation-turn activity counters, read by tool.execute.after and
// evaluated at the next idle for the no-progress detector.
const turnActivity = new Map<string, GoalActivity>()
const previousGoalEvidence = new Map<string, string>()
type PendingGoalTurn = { client: GoalClient; goal: ActiveGoal; activity: GoalActivity; turn?: number; previous?: string; waited?: boolean }
const pendingContinuationTurn = new Map<string, PendingGoalTurn>()

// Address the admitted contract directly, never a newly ranked live goal.
function matchingGoalTurn(text: string, pending: PendingGoalTurn): GoalDoc | null {
  const fresh = parseGoalLoose(text)
  const admitted = pending.goal.doc
  return fresh && fresh.created === admitted.created && fresh.revision === admitted.revision &&
    fresh.session === admitted.session && fresh.armedAt === admitted.armedAt ? fresh : null
}

function ledgerGoalTurn(pending: PendingGoalTurn) {
  const act = pending.activity
  const classification = classifyGoalActivity(act, pending.previous)
  if (pending.turn !== undefined) {
    try {
      const text = readFileSync(pending.goal.path, "utf8")
      if (matchingGoalTurn(text, pending)) {
        atomicWrite(pending.goal.path, appendLedger(text, {
          turn: pending.turn, revision: pending.goal.doc.revision, at: nowIso(),
          activity: classification.activity, writes: act.writes, checks: act.checks,
        }, nowIso()))
      }
    } catch (err) {
      goalProbe(`ledger append failed session=${pending.goal.doc.session} err=${String(err)}`)
    }
  }
  return classification
}

function goalProbe(line: string): void {
  if (process.env.FORGE_GOAL_PROBE) {
    try {
      appendFileSync(join(probeTmp(), "forge-goal-probe.log"), `${new Date().toISOString()} ${line}\n`)
    } catch {}
  }
}

function engineForgetSession(sessionID: string): void {
  goalStopDeadline(sessionID)
  goalStopNativeRecheck(sessionID)
  goalNativeWatch.delete(sessionID)
  // Keep accepted round history across pause/resume so late results cannot
  // be attributed to a new call reusing the same child session.
  goalBackgroundHeld.delete(sessionID)
  crewNativeCeiling.delete(sessionID)
  const t = idleTimers.get(sessionID)
  if (t) clearTimeout(t.timer)
  idleTimers.delete(sessionID)
  continuationInFlight.delete(sessionID)
  transportFails.delete(sessionID)
  noProgressStreak.delete(sessionID)
  previousGoalEvidence.delete(sessionID)
  const pending = pendingContinuationTurn.get(sessionID)
  if (pending?.turn !== undefined) ledgerGoalTurn(pending)
  turnActivity.delete(sessionID)
  pendingContinuationTurn.delete(sessionID)
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
const crewTurnActivity = new Map<string, { dispatches: number; writes: number; seen?: Set<string> }>()
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
function crewNativeViewHeld(sessionID: string, view: NativeChildWalkView): boolean {
  return !view.readable || view.inFlight.length > 0 || view.settled.some(row => !row.outcome && !crewNativeChildren.rows().get(row.childID)?.outcome) || (crewNativeWatch.get(sessionID)?.size ?? 0) > 0
}

function crewDiscloseNativeHold(sessionID: string, objective: string): void {
  const now = crewGateNow()
  const mark = crewNativeCeiling.get(sessionID)
  if (!mark) crewNativeCeiling.set(sessionID, { firstSuppressedAt: now, disclosed: false })
  else if (!mark.disclosed && now - mark.firstSuppressedAt >= CREW_NATIVE_CHILD_CEILING_MS) {
    crewNativeCeiling.set(sessionID, { firstSuppressedAt: mark.firstSuppressedAt, disclosed: true })
    console.warn(`[forge:crew-continue] native-child ceiling: crew "${objective.slice(0, 80)}" remains held; terminal evidence unavailable. No continuation authorized.`)
  }
}

function crewObserveNativeWalk(sessionID: string, view: NativeChildWalkView): void {
  if (!view.readable) return
  const busy = new Set(view.inFlight)
  for (const childID of view.inFlight) crewWatchChild(sessionID, childID)
  const watched = crewNativeWatch.get(sessionID)
  if (!watched || watched.size === 0) return
  const outcomes = new Map(view.settled.map((row) => [row.childID, row.outcome]))
  for (const childID of [...watched]) {
    if (busy.has(childID)) continue
    // Missing or idle without a durable outcome is not verified settlement.
    const outcome = outcomes.get(childID) ?? crewNativeChildren.rows().get(childID)?.outcome
    if (outcome) crewReportNativeChildTerminal(sessionID, childID, outcome, null)
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
  if ((client && disposedGoalClients.has(client)) || crewNativeRecheck.has(sessionID)) return
  if (!Number.isFinite(CREW_NATIVE_CHILD_RECHECK_MS) || CREW_NATIVE_CHILD_RECHECK_MS <= 0) return
  const timer = setTimeout(() => {
    if (crewNativeRecheck.get(sessionID)?.timer !== timer) return
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
    if (!client || disposedGoalClients.has(client) || !crew || crew.mode !== "executing" || crewStalled.has(sessionID)) return
    // A decision is already pending or running: it re-arms this timer itself
    // when the crew is still held.
    if (continuationInFlight.has(sessionID) || idleTimers.has(sessionID)) return
    const view = await walkNativeChildren(nativeChildWalkerOf(client), sessionID)
    if (disposedGoalClients.has(client)) return
    crewObserveNativeWalk(sessionID, view)
    if (crewNativeViewHeld(sessionID, view)) {
      crewDiscloseNativeHold(sessionID, crew.objective)
      crewArmNativeRecheck(sessionID, client)
      return
    }
    goalProbe(`crew native-child recheck clear session=${sessionID}`)
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
      if (watchedBy) crewArmNativeRecheck(watchedBy, client)
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
      const parentID = crewNativeWatchParentOf(id)
      if (parentID) crewArmNativeRecheck(parentID, client)
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
    `Wave discipline: ${CREW_WAVE_RULE} Collect verified per-subtask evidence verdicts from the reports; terminal status alone is not PASS. Keep at most one retry per subtask, then crew_close with the full report and existing approvals. Stalled or wrong decomposition? crew_close {abandon: true, reason} to re-shard.`,
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
  if (!crew || crew.mode !== "executing" || crew.goalGoverned) {
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
  if (disposedGoalClients.has(client) || crews.get(sessionID) !== crew || crew.goalGoverned || governingGoalFor(sessionID)) return
  crewObserveNativeWalk(sessionID, view)
  if (crewNativeViewHeld(sessionID, view)) {
    crewDiscloseNativeHold(sessionID, crew.objective)
    crewArmNativeRecheck(sessionID, client)
    return // BEFORE accounting — waiting or unknown is not a turn
  }
  crewNativeCeiling.delete(sessionID)
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
  if (disposedGoalClients.has(client) || crews.get(sessionID) !== crew || crew.goalGoverned || governingGoalFor(sessionID) || !sessionIsForgeFamily(sessionID)) return
  try {
    // D7 defect-B: the digest collected during the suppression episode rides
    // this brief (one line per terminal child: id + outcome); cleared only
    // on successful delivery.
    const childDigest = crewChildDigest.get(sessionID) ?? []
    await client.session.prompt({
      path: { id: sessionID },
      body: { parts: [{ type: "text", text: crewContinueBrief(crew, childDigest) }] },
    })
    if (disposedGoalClients.has(client) || crews.get(sessionID) !== crew) return
    if (childDigest.length > 0) crewChildDigest.delete(sessionID)
    // D8: the episode ended with a delivered brief — a later busy child
    // starts a fresh, fully-ceilinged episode with its own re-check.
    crewStopNativeRecheck(sessionID)
    transportFails.delete(sessionID)
    crewPendingTurn.add(sessionID)
    crewTurnActivity.set(sessionID, { dispatches: 0, writes: 0 })
    goalProbe(`crew continued session=${sessionID} objective="${crew.objective.slice(0, 60)}"`)
  } catch (err) {
    if (disposedGoalClients.has(client) || crews.get(sessionID) !== crew) return
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
  const crewLayerBase = `Crew layer: you own it under this goal — when parallel decomposition serves a criterion, register crews with crew_begin {objective, subtasks, execution: "waves"} in ONE call (born armed; no pause mid-loop), follow the native subagent wave discipline below, and re-shard a wrong decomposition via crew_close {abandon: true, reason} plus a fresh registration. Preserve existing user approvals, host permissions and goal stop conditions. Your goal turns drive the crew — no separate crew idle briefs fire under this goal.`
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
    `Per-turn discipline: meaningful read-only reconnaissance and review, real changes, commits, and checks or failure diagnosis with new evidence are productive work, including outside git. No write, shell command, or git diff is required every turn. Repeating a check with the same input and complete result without new evidence or other activity is not progress; unknown or truncated evidence does not establish equality. Do not repeat checks merely to fill a turn. For genuine host waiting (outstanding child work, background commands, permissions or user responses), end your turn rather than polling or sleeping. Waiting is not work; the intended two-turn no-progress threshold applies only to clearly empty work turns.`,
    `Budget: ${d.turnsUsed}/${d.maxTurns} turns used. The wall-clock minute limit continues during waiting; stop on either budget limit or when goal authorization ends, and wait for the user's explicit decision before resuming. Do not start new autonomous work after a pause or loss of authorization, including crew fallback or session reuse; already accepted host work may finish. A goal-governed crew must not become standalone automatically. Call goal_check when criteria hold, then goal_complete (it re-runs every check itself and asks the user). If globally blocked, call goal_pause with the concrete blocker; if independent work remains, continue that work — do not spin.`,
    crewLayerLine,
    `For a crew under this goal: ${CREW_WAVE_RULE} Treat verified waiting as distinct from work or no-progress; do not assume the host can observe every wait. Collect verified evidence for each declared subtask; a completion notification is not by itself PASS.`,
    `Goal file: ${relFrom(state.worktree, goal.path)}`,
  ]
    .filter((s) => s.length > 0)
    .join("\n")
}

function wrapupBriefText(goal: ActiveGoal, reason: StopReason, repeatedEvidence = false): string {
  return [
    `[forge:goal-wrapup] The goal loop is stopping (stop_reason: ${reason}); the goal is now PAUSED.`,
    `Goal (revision ${goal.doc.revision}): ${goal.doc.goal}`,
    ...(repeatedEvidence ? ["Repeated identical check input and result added no observable evidence; see the Turn Ledger."] : []),
    "Produce a concise handoff summary and nothing else: what is done, what remains, the single next concrete step. Do not continue working the goal in this turn.",
  ].join("\n")
}

type GoalClient = {
  session: {
    prompt: (opts: unknown) => Promise<unknown>
    get: (opts: unknown) => Promise<unknown>
    status?: (opts: unknown) => Promise<unknown>
    context?: (opts: unknown) => Promise<unknown>
  }
}

// Auto-pause with an optional final wrap-up continuation. Pause happens
// first (atomic, no race with another idle); the wrap-up prompt is
// best-effort and does not count against the turn budget.
async function autoPauseGoal(client: GoalClient, state: SessionState, goal: ActiveGoal, reason: StopReason, wrapup: boolean, repeatedEvidence = false): Promise<void> {
  goalProbe(`auto-pause session=${state.sessionID} reason=${reason} wrapup=${wrapup}`)
  atomicWrite(goal.path, transitionGoal(readFileSync(goal.path, "utf8"), "paused", nowIso(), { stopReason: reason }))
  engineForgetSession(state.sessionID)
  if (wrapup && goal.doc.session) {
    try {
      await client.session.prompt({
        path: { id: goal.doc.session },
        body: { parts: [{ type: "text", text: wrapupBriefText(goal, reason, repeatedEvidence) }] },
      })
    } catch (err) {
      goalProbe(`wrapup delivery failed session=${state.sessionID} err=${String(err)}`)
    }
  }
}

// Full guard chain, then send one continuation. Any unexpected error inside
// degrades to "skip this round" — the loop never fights the host.
async function continueIfEligible(client: GoalClient, sessionID: string, backgroundWaiting = false): Promise<void> {
  if (disposedGoalClients.has(client)) return
  if (continuationInFlight.has(sessionID)) return
  // Claim the in-flight slot BEFORE any await: two idles racing through the
  // lazy-seed path must not both send a continuation (double-briefing and
  // double turn accounting).
  const flight = { client }
  continuationInFlight.set(sessionID, flight)
  const stillCurrent = () => !disposedGoalClients.has(client) && continuationInFlight.get(sessionID) === flight
  try {
    let state = sessions.get(sessionID)
    if (!state) {
      try {
        // V2 session info carries the directory under `location.directory`
        // (live probe: {"location":{"directory":"..."}}); v1 had it flat.
        const info = (await client.session.get({ path: { id: sessionID } })) as
          | { directory?: string; worktree?: string; location?: { directory?: string } }
          | undefined
        if (!stillCurrent()) return
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
    if (!stillCurrent()) return
    const ownedGoal = resolveLiveGoal(state)
    const governedCrew = crews.get(sessionID)
    backgroundWaiting ||= goalBackgroundHeld.has(sessionID)
    if (ownedGoal?.doc.status === "active" && ownedGoal.doc.session === sessionID) goalArmDeadline(sessionID, client, ownedGoal)
    if (backgroundWaiting) {
      goalStopNativeRecheck(sessionID)
      if (ownedGoal?.doc.status === "active" && ownedGoal.doc.session === sessionID) goalArmNativeRecheck(sessionID, client, ownedGoal, true)
    }
    if (ownedGoal?.doc.status === "active" && ownedGoal.doc.session === sessionID && !backgroundWaiting) {
      const walker = nativeChildWalkerOf(client)
      const view = await walkNativeChildren(walker, sessionID)
      if (!stillCurrent()) return
      // An idle callback can race a resumed or permission-blocked owner.
      // Check the host active map before settling any pending work turn.
      const ownerBusy = await nativeSessionBusy(walker, sessionID)
      if (!stillCurrent()) return
      const current = resolveLiveGoal(state)
      if (!current || current.path !== ownedGoal.path || current.doc.status !== "active" || current.doc.session !== sessionID ||
          current.doc.revision !== ownedGoal.doc.revision || current.doc.armedAt !== ownedGoal.doc.armedAt) return
      // Goal ownership uses durable outcomes for both ordinary and crew
      // turns; advisory crew events cannot settle a reused child round.
      let roundHeld = false
      const rounds = goalAcceptedCalls.get(sessionID)
      if (rounds?.size) {
        let settled = new Set<string>()
        try { settled = settledGoalRounds(rounds, await client.session.context?.({ sessionID })) } catch {}
        if (!stillCurrent()) return
        const latest = resolveLiveGoal(state)
        if (!latest || latest.path !== ownedGoal.path || latest.doc.status !== "active" || latest.doc.session !== sessionID || latest.doc.revision !== ownedGoal.doc.revision || latest.doc.armedAt !== ownedGoal.doc.armedAt) return
        roundHeld = [...rounds.keys()].some(id => !settled.has(id))
      }
      backgroundWaiting = goalNativeViewHeld(sessionID, view) || ownerBusy !== false || roundHeld || goalBackgroundHeld.has(sessionID)
      if (governedCrew?.goalGoverned) crewObserveNativeWalk(sessionID, view)
      if (backgroundWaiting) {
        crewDiscloseNativeHold(sessionID, governedCrew?.objective ?? ownedGoal.doc.goal)
        goalArmNativeRecheck(sessionID, client, ownedGoal, goalBackgroundHeld.has(sessionID))
      } else {
        goalStopNativeRecheck(sessionID)
      }
    }
    // Account a delivered turn against its captured file and arm, even if
    // that goal is now terminal. Never attribute it to a different goal.
    const pending = pendingContinuationTurn.get(sessionID)
    let accountedContinuationTurn = false
    let turnHadActivity = false
    let repeatedEvidence = false
    let uncertainActivity = false
    // An owning wait edge is not a settlement edge. Retain late tool evidence
    // only for the same active arm; terminal or replaced arms still settle as before.
    const waitingGoal = backgroundWaiting ? resolveLiveGoal(state) : null
    const deferSettlement = waitingGoal?.doc.status === "active" && waitingGoal.doc.session === sessionID &&
      pending?.goal.path === waitingGoal.path && pending.goal.doc.revision === waitingGoal.doc.revision &&
      pending.goal.doc.armedAt === waitingGoal.doc.armedAt
    if (pending && deferSettlement) pending.waited = true
    if (pending?.turn !== undefined && !deferSettlement) {
      pendingContinuationTurn.delete(sessionID)
      turnActivity.delete(sessionID)
      const classification = ledgerGoalTurn(pending)
      const currentGoal = resolveLiveGoal(state)
      accountedContinuationTurn = currentGoal?.path === pending.goal.path &&
        currentGoal.doc.revision === pending.goal.doc.revision &&
        currentGoal.doc.armedAt === pending.goal.doc.armedAt && currentGoal.doc.session === sessionID
      turnHadActivity = classification.activity
      repeatedEvidence = classification.repeated
      uncertainActivity = classification.uncertain === true
      if (accountedContinuationTurn && classification.evidence) previousGoalEvidence.set(sessionID, classification.evidence)
      else previousGoalEvidence.delete(sessionID)
    }
    const goal = resolveLiveGoal(state)
    if (goal?.doc.status === "paused" && goal.doc.session === sessionID) return
    // Crew branch (crew-autonomous-waves D1): the goal path owns the session
    // A live owned goal drives its own turns. Only independently armed
    // crews may fall back to standalone continuation; registration
    // provenance survives disappearance of the governing goal.
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
    // Explicit owning-session background evidence suppresses new Goal prompts,
    // including wrap-ups, without skipping draft conflict or budget evaluation.
    // No wake is installed; subsequent ordinary idle edges use their own evidence.
    if (backgroundWaiting) {
      if (resolveActivePlan(state)?.doc.status === "draft") {
        await autoPauseGoal(client, state, goal, "draft-conflict", false)
        return
      }
      const bs = budgetState(goal.doc)
      if (bs !== "ok") await autoPauseGoal(client, state, goal, bs, false)
      return
    }
    // No-progress accounting, only for turns the engine itself started. The
    // finished turn's activity is also recorded in the goal's Turn Ledger
    // (auditable anti-batching evidence, visible at the completion gate).
    if (accountedContinuationTurn) {
      if (turnHadActivity) {
        noProgressStreak.delete(sessionID)
      } else if (!pending?.waited && !uncertainActivity) {
        const n = (noProgressStreak.get(sessionID) ?? 0) + 1
        noProgressStreak.set(sessionID, n)
        goalProbe(`no-progress session=${sessionID} streak=${n}`)
        if (n >= NO_PROGRESS_LIMIT) {
          await autoPauseGoal(client, state, goal, "no-progress", true, repeatedEvidence)
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
    const stillAuthorized = () => {
      if (!stillCurrent()) return false
      const fresh = parseGoalLoose(readFileSync(goal.path, "utf8"))
      return fresh?.status === "active" && fresh.session === sessionID &&
        fresh.revision === goal.doc.revision && fresh.armedAt === goal.doc.armedAt
    }
    if (!stillAuthorized()) return
    const pendingTurn: PendingGoalTurn = {
      client,
      goal,
      activity: { writes: 0, checks: 0, scope: JSON.stringify([state.worktree, goal.path, goal.doc.revision, goal.doc.armedAt]) },
      previous: previousGoalEvidence.get(sessionID),
    }
    try {
      const briefText = goalBriefText(state, goal)
      pendingContinuationTurn.set(sessionID, pendingTurn)
      turnActivity.set(sessionID, pendingTurn.activity)
      await client.session.prompt({
        path: { id: sessionID },
        body: { parts: [{ type: "text", text: briefText }] },
      })
    } catch (err) {
      if (!stillAuthorized()) {
        if (pendingContinuationTurn.get(sessionID) === pendingTurn) {
          pendingContinuationTurn.delete(sessionID)
          turnActivity.delete(sessionID)
        }
        return
      }
      // No successful delivery: do not ledger or charge a phantom turn.
      pendingContinuationTurn.delete(sessionID)
      turnActivity.delete(sessionID)
      const n = (transportFails.get(sessionID) ?? 0) + 1
      transportFails.set(sessionID, n)
      goalProbe(`transport failure session=${sessionID} count=${n} err=${String(err)}`)
      if (n >= TRANSPORT_FAILURE_LIMIT) {
        await autoPauseGoal(client, state, goal, "transport-failures", false)
      }
      return
    }
    // The host prompt can block through pause/complete. Charge the accepted
    // turn on the same contract arm without changing its lifecycle fields.
    // A re-arm/revision/owner change is not this callback's authorization.
    const text = readFileSync(goal.path, "utf8")
    const fresh = matchingGoalTurn(text, pendingTurn)
    if (disposedGoalClients.has(client) || !fresh || (!stillCurrent() && fresh.status === "active")) {
      if (pendingContinuationTurn.get(sessionID) === pendingTurn) {
        pendingContinuationTurn.delete(sessionID)
        turnActivity.delete(sessionID)
      }
      return
    }
    atomicWrite(goal.path, incTurns(text, nowIso()))
    pendingTurn.turn = fresh.turnsUsed + 1
    if (!stillCurrent() || fresh.status !== "active") {
      ledgerGoalTurn(pendingTurn)
      if (pendingContinuationTurn.get(sessionID) === pendingTurn) {
        pendingContinuationTurn.delete(sessionID)
        turnActivity.delete(sessionID)
      }
      return
    }
    transportFails.delete(sessionID)
    goalProbe(`continued session=${sessionID} turn=${pendingTurn.turn}/${fresh.maxTurns}`)
  } catch (err) {
    goalProbe(`continuation aborted session=${sessionID} err=${String(err)}`)
  } finally {
    if (stillCurrent()) continuationInFlight.delete(sessionID)
  }
}

function scheduleIdleContinuation(client: GoalClient, sessionID: string, debounceMs: number = IDLE_DEBOUNCE_MS, backgroundWaiting = false): void {
  if (disposedGoalClients.has(client)) return
  // Family gate at scheduling time (tool-partition): a non-forge session's
  // idle never arms a timer — no continuation, not even a session.get probe.
  if (!sessionIsForgeFamily(sessionID)) {
    goalProbe(`skip: non-forge agent at schedule session=${sessionID}`)
    return
  }
  const state = sessions.get(sessionID)
  if (state) {
    const goal = resolveLiveGoal(state)
    if (goal?.doc.status === "paused" && goal.doc.session === sessionID) return
  }
  const existing = idleTimers.get(sessionID)
  if (existing) clearTimeout(existing.timer)
  const pending = { client, timer: setTimeout(() => {
    if (idleTimers.get(sessionID) !== pending) return
    idleTimers.delete(sessionID)
    void continueIfEligible(client, sessionID, backgroundWaiting)
  }, Math.max(0, debounceMs)) }
  idleTimers.set(sessionID, pending)
}

// session.deleted harvest (change v2-plugin-api-port task 5.1): the ONE
// core both hosts call — the v1 event hook and the v2 event subscription
// share it verbatim (parity by reuse) and evict session-bounded maps.
function harvestSessionEnd(sessionID: string): void {
  // The frozen depth translation dies with its session (bounded table).
  sessionDepths.delete(sessionID)
  // Same for the agent-family map (tool-partition).
  sessionAgents.delete(sessionID)
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
  goalAcceptedCalls.delete(sessionID)
  engineForgetSession(sessionID)
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
  update?(name: string, update: (draft: Record<string, unknown>) => void): void
}
// Command-domain editor (task 4.3, W6a field reality — SDK 2.3.2
// promise/command.d.ts): CommandDefinition is EXECUTE-based
// {name, description?, execute({sessionID, prompt, delivery})} and the
// editor exposes ONLY add() — no list/get/remove (the v1 create-only rule
// is not implementable on this domain). In host v2.4.0, configured
// commands are replayed after plugin registration and win name collisions;
// editor-level add order alone does not determine the final host registry.
// The template text rides the execute closure: invoking the command sends
// the SAME constant text into the invoking session via the flat
// {sessionID, text} prompt.
type V2CommandEditor = {
  add?(def: { name: string; description?: string; execute: (input: { sessionID?: unknown }) => Promise<void> }): void
}
type V2PluginContext = {
  agent?: {
    transform?(cb: (draft: V2AgentDraft) => void): Promise<unknown>
  }
  tool?: {
    transform?(cb: (editor: V2ToolEditor) => void): Promise<unknown>
    hook?(name: string, cb: (event: unknown) => void): unknown
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
    list?(opts: unknown): Promise<unknown>
    interrupt?(opts: unknown): Promise<unknown>
    // worker-shell-session-allow (source-verified 2.3.2 plugin/host.ts):
    // update carries {sessionID, ...mutations} incl. `permissions` — the
    // whole session ruleset is REPLACED, so the rescue always read-back-
    // merges first. Guarded: a drifted host simply disables the rescue's
    // injection channel (the D5 fallback belt still covers workers).
    update?(input: unknown): Promise<unknown>
  }
  command?: { transform?(cb: (editor: V2CommandEditor) => void): Promise<unknown> }
  // W6a field realities (SDK 2.3.2 promise/event.d.ts): subscribe(options?)
  // returns an ASYNC ITERABLE of OpenCodeEvent envelopes {id, created, type,
  // data} — no handlers map, no abort return value. SubscribeOptions carries
  // {types?, signal?} (adapter.js makeStreams); cleanup = breaking the
  // for-await loop (iterator.return) and/or aborting the signal.
  event?: { subscribe?(options?: unknown): unknown }
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
function v2AnchorCandidates(ctx: V2PluginContext, includeCwd = true): string[] {
  const out: string[] = []
  try {
    for (const reader of [ctx.location?.worktree, ctx.location?.directory]) {
      const v = typeof reader === "function" ? (reader as () => unknown)() : reader
      if (typeof v === "string" && v) out.push(v)
    }
  } catch {
    // Drifted location: cwd-only resolution (fail-soft).
  }
  if (includeCwd) out.push(process.cwd())
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
  // fix-ask-door-multi-directory-host D2: every door uses the interface the REGISTERING
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
  resolveSessionAnchorForPools,
  workspacePoolOf: sessionPoolFileOf,
  resolvePools,
  resolveToolContext: (raw: unknown, anchorClient?: V2AnchorReader, assertFn?: V2AssertFn | null) => v2ToolContext(raw, anchorClient ?? undefined, assertFn ?? null),
  worktreeOf: (sessionID: string): string | null => sessions.get(sessionID)?.worktree ?? null,
  bindChildToDirectory,
  sessionAnchorLedgerPath,
  noteLedgerBinding: noteSessionAnchorLedgerBinding,
  setSessionAnchorLedgerFs: (factory: ((filePath: string) => SessionAnchorLedgerFs) | null) => {
    sessionAnchorLedgerFsFactory = factory
    poolGateLedgerNotes.clear()
    sessionAnchorLedgerMemo.clear()
    sessionAnchorLedgerAppends = 0
  },
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
  // fix-unknown-session-anchor-seed: the seed switch, the async resolver and
  // the boundary base, for the unit tests. Nothing here runs in a
  // production path.
  initializedDirectories: (): string[] => [...v2InitializedDirs],
  resetInitializedDirectories: (): void => {
    v2InitializedDirs.clear()
  },
  stateForBan: (sessionID: string | undefined): SessionState | null => stateForBan(sessionID),
  stateForCheck: (sessionID: string | undefined, anchorClient?: V2AnchorReader | null): Promise<SessionState | null> =>
    stateForCheck(sessionID, anchorClient ?? null),
  boundaryBaseOf: (sessionID: string | undefined): string => banBaseDirectory(stateForBan(sessionID)),
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
// hand-listed. The user-confirmation doors are exactly the gate()
// permission keys (six today: plan_approve, goal_write, goal_complete,
// goal_resume, goal_discard, crew_close). On a v2 host a tool's ask IS the
// host's ctx.permission.assert, so the dialog a door needs exists only if
// THIS belt rewrites the host's "allow" to "ask" on every evaluation. This
// set used to be a second, hand-copied list without crew_close — which let
// crew_close end a crew without asking (present since the v2 port).
const V2_PERMISSION_DOORS = new Set<string>(GATE_PERMISSION_KEYS)

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
    // Registration may reject asynchronously; keep the same silent drift posture.
    void Promise.resolve(ctx.permission.hook("evaluate", async (raw: unknown) => {
      try {
        const evalInput = raw !== null && typeof raw === "object" ? (raw as { sessionID?: unknown; agent?: unknown; action?: unknown; resources?: unknown; metadata?: unknown; effect?: unknown; message?: unknown }) : null
        if (!evalInput || typeof evalInput.effect !== "string") return
        const meta = (evalInput.metadata !== null && typeof evalInput.metadata === "object" ? evalInput.metadata : {}) as Record<string, unknown>
        const name = evalInput.action === NATIVE_TOOL_VOCAB.dispatchTool ? evalInput.action : (typeof meta.tool === "string" ? meta.tool : undefined) ?? (typeof evalInput.action === "string" ? evalInput.action : undefined)
        if (process.env.FORGE_PERM_PROBE) {
          try {
            appendFileSync(join(probeTmp(), "forge-perm-probe.log"), `${new Date().toISOString()} v2-evaluate name=${JSON.stringify(name)} effect=${evalInput.effect} raw=${JSON.stringify(raw).slice(0, 300)}\n`)
          } catch {}
        }
        if (typeof name === "string" && V2_PERMISSION_DOORS.has(name)) {
          // Doors: keep it a REAL ask unless explicitly denied — the user
          // confirmation (the ask prompt the host raises for effect "ask")
          // is the gate (v1 parity). native shell is not a confirmation door
          // (pass-through, shell-defang-default-open).
          if (evalInput.effect !== "deny") evalInput.effect = "ask"
          return
        }
        if (typeof name === "string" && isWriteTool(name)) {
          const sessionID = typeof evalInput.sessionID === "string" ? evalInput.sessionID : undefined
          // fix-unknown-session-anchor-seed (design D2): a SYNCHRONOUS
          // lookup that never seeds on a multi-directory process — this belt
          // signals by mutating evalInput.effect and whether the host waits
          // for an async hook's mutation is unproven, so it takes no await.
          // The execute.before seam fires first (host 2.4.0) and is the
          // authoritative draft gate for sessions this map does not know.
          const state = stateForBan(sessionID)
          const active = state ? resolveActivePlan(state) : null
          if (active && active.doc.status === "draft") {
            // Native subagent asserts its actual agent id as the sole resource.
            // Recheck the current draft roster, never lift the host's own deny/ask.
            if (evalInput.action === NATIVE_TOOL_VOCAB.dispatchTool && state) {
              const resources = evalInput.resources
              const target = Array.isArray(resources) && resources.length === 1 && typeof resources[0] === "string" ? resources[0] : undefined
              const refusal = nativeDraftDispatchRefusal(state, target)
              if (!refusal) return
              evalInput.effect = "deny"
              evalInput.message = refusal
              return
            }
            evalInput.effect = "deny"
            evalInput.message = "[forge] A plan is in draft; write operations are denied. Switch back to the forge agent to present it and complete plan approval (plan_approve), or run /plan discard to abandon the plan."
          }
        }
      } catch {
        // Belt posture: never throw into the host (fail-open on drift).
      }
    })).catch(() => {})
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
    // Port of the v1 "tool.execute.before" belt. Refusals throw.
    // Missing identity does not grant access to harness state tools.
    // Handle each registration promise independently so an async rejection does not suppress its sibling.
    void Promise.resolve(ctx.tool.hook("execute.before", async (raw: unknown) => {
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
      const nativeDispatch = tool === NATIVE_TOOL_VOCAB.dispatchTool
      // Capture an already-known active arm before any anchor/pool awaits.
      // A newly armed revision cannot authorize an older in-flight decision.
      const goalWork = typeof tool === "string" && (isWriteTool(tool) || tool === "goal_check")
      const initialState = goalWork && sessionID ? sessions.get(sessionID) : undefined
      const initialGoal = initialState ? resolveLiveGoal(initialState) : null
      const initialArm = initialGoal?.doc.session === sessionID ? initialGoal : null
      const nativeTarget = nativeDispatch && typeof args.agent === "string" ? args.agent : undefined
      // Bind the caller's own directory before judging even a missing target.
      const nativeAnchor = nativeDispatch && sessionID ? await resolveSessionAnchorForPools(anchorClient, sessionID) : ""
      if (nativeAnchor && sessionID) ensureSession(sessionID, nativeAnchor)
      // Legacy dispatch belt pending v1 retirement.
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
      if (tool === "write" || tool === "edit") {
        const raw = typeof args.filePath === "string" ? args.filePath : typeof args.path === "string" ? args.path : undefined
        if (raw) {
          // fix-unknown-session-anchor-seed (design D2/D3): the session is
          // resolved from the host's own record (through THIS
          // initialization's client) before it is judged; an unresolvable
          // session has no base directory on a multi-directory process.
          const state = sessionID ? await stateForCheck(sessionID, anchorClient) : null
          const base = banBaseDirectory(state)
          // No base (an unresolvable session on a multi-directory process):
          // the relative path is judged by its OWN spelling, normalized
          // against a neutral root — never joined onto another directory's.
          // A path that names a state directory relative to ANY working
          // directory (".opencode/plan/x.md") is still refused; one that
          // would land there only from some particular directory
          // ("../plan/y.md") cannot be judged here and passes.
          const abs = (isAbsolute(raw) ? raw : join(base || "/", raw)).replaceAll("\\", "/").toLowerCase()
          if (abs.includes("/.opencode/plan/") || abs.includes("/.opencode/goal/")) {
            throw new Error(
              `[forge:partition] Write refused: "${raw}" is inside the forge state directories (.opencode/plan, .opencode/goal), which belong to the forge agent in this workspace.`,
            )
          }
        }
      }
      if (typeof tool === "string" && isWriteTool(tool)) {
        // fix-unknown-session-anchor-seed (design D2): the authoritative
        // draft gate. It fires BEFORE the permission evaluation (host 2.4.0,
        // probed 2026-11-24T13:47Z) and resolves an unknown session from the
        // host's own session record through THIS initialization's client —
        // the synchronous permission belt no longer seeds, so on a
        // multi-directory process this seam is where the session's own
        // directory is established before the verdict.
        const state = await stateForCheck(sessionID, anchorClient)
        const active = state ? resolveActivePlan(state) : null
        if (active && active.doc.status === "draft") {
          if (nativeDispatch && state) {
            const refusal = nativeDraftDispatchRefusal(state, nativeTarget)
            if (refusal) throw new Error(refusal)
          } else if (tool === "task") {
            // allow-readonly-recon: carve-out keyed on the TARGET's shape.
            const target = typeof args.subagent_type === "string" ? args.subagent_type : typeof args.agent === "string" ? args.agent : undefined
            const refusal = draftDispatchRefusalForState(state, target)
            if (refusal) throw new Error(refusal)
          } else {
            throw new Error(
              `[forge] A plan is in draft; write operations are denied (${tool}). Switch back to the forge agent to present it and complete plan approval (plan_approve), or run /plan discard to abandon the plan.`,
            )
          }
        }
      }
      // Partition fallback belts (tool-partition fallback requirement).
      assertHarnessAgent(tool, evAgent ?? (sessionID ? sessionAgents.get(sessionID) : undefined))
      if (sessionID && typeof tool === "string") {
        const speaker = sessionAgents.get(sessionID)
        if (speaker !== undefined) {
          if (!isForgeFamilyAgent(speaker) && FORGE_TOOL_SET.has(tool)) {
            throw new Error(
              `[forge:partition] Tool refused: "${tool}" belongs to the forge agent family and the current agent ("${speaker}") is outside it. Switch to forge (Tab) to use forge tooling.`,
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
      // The native tool remains host-owned. This preflight only refuses a
      // stale generated roster for a known caller; it never executes a child.
      let missingPoolRefusal: string | undefined
      let dispatchAnchor = nativeAnchor
      if (nativeDispatch && nativeTarget?.toLowerCase().startsWith("forge-") && sessionID) {
        // Resolve once at the final gate, then make pool/compliance decisions
        // synchronously on current recipes with no intervening await.
        dispatchAnchor = await resolveSessionAnchorForPools(anchorClient, sessionID)
        const poolRefusal = poolGateRefusalAtAnchor(dispatchAnchor, sessionID, nativeTarget, true, refusal => { missingPoolRefusal = refusal })
        if (poolRefusal) throw new Error(poolRefusal)
      }
      // Pending registration is not authorization to start native work.
      // Refuse it for every target, following the pool ownership check.
      if (nativeDispatch) {
        const pendingRefusal = crewPendingRefusal(sessionID)
        if (pendingRefusal) throw new Error(pendingRefusal)
      }
      if (nativeDispatch && nativeTarget?.toLowerCase().startsWith("forge-") && sessionID && dispatchAnchor) {
        const complianceRefusal = crewComplianceRefusalAtAnchor(dispatchAnchor, sessionID, nativeTarget)
        if (complianceRefusal) throw new Error(complianceRefusal)
        if (nativeRosterActive()) {
          const stale = rosterStaleRefusal(dispatchAnchor)
          if (stale) throw new Error(stale)
        }
      }
      if (missingPoolRefusal) throw new Error(missingPoolRefusal)
      // Last synchronous admission decision: the goal may have been paused,
      // replaced or re-armed while native pool/compliance checks awaited.
      // Read-only chat and explicit arming gates are deliberately outside
      // this belt; already accepted host calls are not cancelled here.
      if (goalWork && sessionID) {
        const state = sessions.get(sessionID)
        const fresh = state ? resolveLiveGoal(state) : null
        const owns = fresh?.doc.session === sessionID
        const forgeSpeaker = sessionIsForgeFamily(sessionID)
        if ((forgeSpeaker && owns && fresh?.doc.status === "paused") ||
            (crews.get(sessionID)?.goalGoverned && (!owns || fresh?.doc.status !== "active")) ||
            (initialArm && (!owns || fresh?.doc.status !== "active" || fresh.path !== initialArm.path ||
              fresh.doc.revision !== initialArm.doc.revision || fresh.doc.armedAt !== initialArm.doc.armedAt))) {
          throw new Error("[forge:goal] Autonomous work refused: the goal is paused or its authorization changed. Ask the user to resume or explicitly re-arm before starting new work.")
        }
      }
    })).catch(() => {})
    // Port of the v1 "tool.execute.after" activity ledger. Never throws.
    void Promise.resolve(ctx.tool.hook("execute.after", async (raw: unknown) => {
      try {
        const { tool, sessionID, id, args } = v2ToolEventArgs(raw)
        if (typeof tool !== "string" || !sessionID) return
        const act = turnActivity.get(sessionID)
        const event = raw as Record<string, unknown>
        const activityEvent = {
          messageID: typeof event.messageID === "string" ? event.messageID : undefined,
          status: event.status,
          codemode: typeof event.codemode === "boolean" ? event.codemode : undefined,
        }
        if (tool === "subagent") {
          const result = event.result as Record<string, unknown> | undefined
          const metadata = result?.metadata as Record<string, unknown> | undefined
          const accepted = event.status === "completed" && id && metadata?.status === "running" && typeof metadata.sessionID === "string" && metadata.sessionID
          const state = sessions.get(sessionID)
          const goal = state && resolveLiveGoal(state)
          const owns = goal?.doc.status === "active" && goal.doc.session === sessionID
          const seen = goalAcceptedCalls.get(sessionID) ?? new Map<string, string>()
          if (accepted && id && !seen.has(id)) {
            if (owns) {
              seen.set(id, metadata.sessionID as string)
              goalAcceptedCalls.set(sessionID, seen)
              const watched = goalNativeWatch.get(sessionID) ?? new Set<string>()
              watched.add(metadata.sessionID as string)
              goalNativeWatch.set(sessionID, watched)
            }
            if (act) observeGoalActivity(act, tool, isWriteTool(tool), id, args, result, activityEvent)
          } else if (!accepted && act) observeGoalActivity(act, tool, isWriteTool(tool), id, args, undefined, activityEvent)
        } else if (act) observeGoalActivity(act, tool, isWriteTool(tool), id,
          event.codemode === true ? event.input : args, event.result ?? event.output, activityEvent)
        const crew = crews.get(sessionID)
        if (crew?.mode === "executing" && tool === NATIVE_TOOL_VOCAB.dispatchTool) {
          const round = crewAcceptedRound(id, args, raw)
          if (round && !crew.rounds?.some(r => r.id === round.id)) {
            ;(crew.rounds ??= []).push(round)
            appendCrewRecord(crew.recordPath, "wave dispatch", [`${round.description}: ${round.id} → ${round.childID} (${round.agent}${round.agent.startsWith("forge-") ? "" : ", native fallback"})`])
          }
        }
        const crewAct = crewTurnActivity.get(sessionID)
        if (crewAct) {
          if (id && crewAct.seen?.has(id)) return
          if (id) (crewAct.seen ??= new Set()).add(id)
          if (tool === "subagent" || tool === "task") crewAct.dispatches++
          if (isWriteTool(tool)) crewAct.writes++
        }
      } catch {}
    })).catch(() => {})
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
  const o = raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : {}
  const sessionID = v2PickStr(o, "sessionID", "sessionId")
  if (!sessionID) return
  const agentName = v2AgentNameOf(o)
  if (agentName) sessionAgents.set(sessionID, agentName)
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
        // "/" + model.id; keep id/modelID bare.
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
      ? "PENDING (present the execution-mode choice; do not start subagent work until the user authorizes execution)"
      : "armed (executing)"
    system.push(`[forge:crew-active] A crew is ${modeText} in this session: "${crewActive.objective}" (started ${crewActive.startedAt}). A second /crew must be refused; wait without polling or sleeping for verified settlement of all work rounds and collect evidence for every declared subtask before crew_close (terminal status alone is not PASS), or crew_close {abandon: true, reason} to re-shard, subject to existing approvals.`)
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
  const goal = resolveLiveGoal(state)
  if (goal) {
    const rel = relFrom(state.worktree, goal.path)
    const d = goal.doc
    const rule =
      d.status === "active"
        ? "work the success criteria within the approved contract and remaining budgets; wait for verified settlement of any outstanding crew rounds before advancing; during genuine host waiting end your turn without polling or sleeping, the minute budget still runs; meaningful read-only work, commits and checks with new evidence are productive, no write, shell command or git diff is required every turn, and repeated identical checks without new evidence are not progress; stop at either budget limit or loss of authorization, do not start further autonomous work (already accepted host work may finish); call goal_check for host-run feedback and goal_complete at the gate (it re-runs every check itself and asks the user); if globally blocked call goal_pause with the concrete blocker, but if independent authorized work remains after a local issue continue that work"
        : "the goal is paused; if the user clearly asks to continue (e.g. 'continue'/'resume'), call goal_resume — the user confirms in a dialog; ordinary chat never reactivates it; do not start new autonomous work, including goal-governed crew work; already accepted host work may finish"
    system.push(
      `[forge:goal-notice] This session is bound to a goal: ${rel} (status: ${d.status}${d.stopReason ? `, stopped: ${d.stopReason}` : ""}, revision ${d.revision}, ${d.turnsUsed}/${d.maxTurns} turns used). Rule: ${rule}. If the user has not mentioned the goal yet, relay its path and status to them in one short line at the start of your reply.`,
    )
  }
}

// Goal-brief reinjection (experimental.session.compacting port): the goal
// facts ride along in the compaction context so post-compaction turns keep
// following the goal (compression-safety carrier).
function v2CompactionInjection(raw: unknown): void {
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

async function v2RegisterSessionHooks(ctx: V2PluginContext, goalClient: GoalClient | null): Promise<{ disposables: Array<() => unknown>; idleHook: boolean }> {
  const out = { disposables: [] as Array<() => unknown>, idleHook: false }
  if (typeof ctx.session?.hook !== "function") return out
  const register = async (name: string, cb: (raw: unknown) => void): Promise<boolean> => {
    try {
      // The promise-layer hook resolves to Registration; keep its receiver
      // and return the disposal result so cleanup can await it.
      const registration = await ctx.session!.hook!(name, cb)
      if (registration !== null && typeof registration === "object" && typeof (registration as { dispose?: unknown }).dispose === "function") {
        out.disposables.push(() => (registration as { dispose: () => unknown }).dispose())
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
  await register("prompt", async (raw: unknown) => {
    try {
      const sessionID = v2PickStr(raw, "sessionID", "sessionId")
      if (!sessionID) return
      const agent = v2AgentNameOf(raw)
      if (agent) sessionAgents.set(sessionID, agent)
    } catch {}
  })
  await register("context", async (raw: unknown) => {
    try {
      v2ContextInjection(raw)
    } catch {}
  })
  await register("compaction", async (raw: unknown) => {
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
  out.idleHook = await register("experimental.idle", async (raw: unknown) => {
    const sessionID = v2PickStr(raw, "sessionID", "sessionId")
    if (!sessionID) return
    if (hasIdleBackgroundShell(raw, sessionID)) goalBackgroundHeld.add(sessionID)
    else if (idleBackgroundKnown(raw)) goalBackgroundHeld.delete(sessionID)
    v2HandleIdle(sessionID, goalClient, goalBackgroundHeld.has(sessionID))
  })
  return out
}
// ---------------------------------------------------------------------------
// Commands (task 4.3) — ctx.command.transform, add-only editor, templates
// byte-identical by construction (the SAME constants/functions the v1
// config hook registers — they ship in dist unchanged).
// ---------------------------------------------------------------------------

async function v2StopNative(ctx: V2PluginContext, sessionID: string): Promise<string> {
  const svc = discoverServiceHttp()
  const request = async (path: string, method = "GET") => {
    if (!svc) throw new Error("service unavailable")
    const url = new URL(svc.url)
    if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) throw new Error("non-local service")
    const res = await fetch(svc.url + path, {
      method, redirect: "error", signal: AbortSignal.timeout(1500),
      headers: { authorization: `Basic ${Buffer.from(`opencode:${svc.password}`).toString("base64")}` },
    })
    if (!res.ok) throw new Error("stop service request failed")
    return res.status === 204 ? undefined : await res.json()
  }
  let directory = ""
  return stopNative(sessionID, {
    children: async (parent, cursor) => {
      if (ctx.session?.list) {
        try { return await ctx.session.list({ parentID: parent, limit: STOP_LIST_LIMIT, ...(cursor ? { cursor } : {}) }) } catch { /* use local HTTP fallback */ }
      }
      return request(`/api/session?parentID=${encodeURIComponent(parent)}&limit=${STOP_LIST_LIMIT}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`)
    },
    context: async parent => {
      if (!ctx.session?.context) throw new Error("context unavailable")
      return ctx.session.context({ sessionID: parent })
    },
    shells: async () => {
      if (!svc) throw new Error("service unavailable")
      if (!directory) {
        const rec = await ctx.session?.get?.({ sessionID }) as { location?: { directory?: string }; directory?: string } | undefined
        directory = rec?.location?.directory ?? rec?.directory ?? ""
      }
      if (!directory) throw new Error("directory unknown")
      return request(`/api/shell?location[directory]=${encodeURIComponent(directory)}`)
    },
    active: () => request("/api/session/active"),
    removeShell: id => request(`/api/shell/${encodeURIComponent(id)}?location[directory]=${encodeURIComponent(directory)}`, "DELETE"),
    interrupt: async id => {
      if (!ctx.session?.interrupt) throw new Error("interrupt unavailable")
      return ctx.session.interrupt({ sessionID: id })
    },
    wait: () => new Promise(resolve => setTimeout(resolve, 200)),
  })
}

async function v2RegisterCommands(ctx: V2PluginContext): Promise<void> {
  if (typeof ctx.command?.transform !== "function") return
  try {
    await ctx.command.transform((editor) => {
      // W6a field reality (SDK 2.3.2 promise/command.d.ts + live host): the
      // v2 CommandDefinition is EXECUTE-based — {name, description?,
      // execute({sessionID, prompt, delivery})} — the editor exposes ONLY
      // add() (no get), so the v1 create-only check is NOT implementable in
      // the editor. In host v2.4.0, post-plugin config replay wins a same-name
      // collision; editor add order alone is not final registry precedence.
      // Each v1 template command becomes an executable that
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
            const stop = name === "forge" && typed?.trim() === "stop"
            if (!stop) {
              // CommandInvocation has no agent field. Read the documented
              // SessionV2Info.agent fresh; a prior turn cannot prove identity.
              let record: { agent?: unknown; parentID?: unknown } | undefined
              try {
                record = await ctx.session.get?.({ sessionID }) as typeof record
              } catch { /* unknown identity fails closed */ }
              if (record?.agent !== FORGE_AGENT || record.parentID !== undefined) {
                throw new Error(`[forge:command] /${name} belongs to the primary forge agent. Switch to forge (Tab) and rerun it there.`)
              }
            }
            // Stop runs before receipt delivery.
            const text = stop ? await v2StopNative(ctx, sessionID) : composeCommandPrompt(template().split("\n").filter(line => !line.startsWith("FAMILY GUARD (step 0")).join("\n"), typed)
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
          ? "forge crew orchestration: register a declared subtask plan, execute it in waves of native subagent calls, close with an evidence-checked report"
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
        "forge roster levers: sync forces an immediate forge_sync and shows the diff; init drafts the workspace forge.json in-band (refuses when one exists — review instead); init global drafts the global forge.json with the built-in override entries commented out; stop requests cancellation of confirmed native children",
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
    context?: (opts: unknown) => Promise<unknown>
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
        const cursor = (args as { cursor?: unknown } | undefined)?.cursor
        return await serviceHttpGet(svc, parent ? `/api/session?parentID=${encodeURIComponent(parent)}&limit=${NATIVE_CHILD_LIST_LIMIT}${typeof cursor === "string" && cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}` : "/api/session")
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
  if (typeof s.context === "function") out.context = opts => s.context!(opts)
  return Object.keys(out).length > 0 ? { session: out, nativeChildWalker: v2NativeChildWalker() } : null
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

// The shared idle body (v1 session.idle port): the debounced goal continuation
// (same engine, guards and [forge:goal-continue] brief) — one code path whether the
// edge arrives from the in-process experimental.idle hook or the SSE
// session.execution.succeeded fallback.
function v2HandleIdle(sessionID: string, goalClient: GoalClient | null, backgroundWaiting = false): void {
  try {
    goalProbe(`v2 idle session=${sessionID}`)
    if (goalClient) scheduleIdleContinuation(goalClient, sessionID, IDLE_DEBOUNCE_MS, backgroundWaiting)
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
function v2SubscribeEvents(ctx: V2PluginContext, goalClient: GoalClient | null, idleFallback: boolean): (() => Promise<void>) | null {
  const subscribeFn = ctx.event?.subscribe?.bind(ctx.event)
  if (typeof subscribeFn !== "function") return null
  const controller = new AbortController()
  const trySubscribe = (): AsyncIterator<unknown> | null => {
    try {
      const sub = subscribeFn({ signal: controller.signal })
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
    const run = async () => {
      // Task 3.4: stream loss → re-subscribe loop (1s → 5s backoff) until
      // cleanup or a dead domain.
      let backoffMs = 1_000
      while (!controller.signal.aborted) {
        const iter = iterator
        if (!iter) return
        try {
          for (;;) {
            const next = await iter.next()
            if (controller.signal.aborted) return
            if (next.done) break
            const ev = next.value as { type?: unknown } | null
            const type = ev !== null && typeof ev === "object" && typeof ev.type === "string" ? ev.type : undefined
            if (!type) continue
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
            } else if (idleFallback && type === "session.execution.succeeded") {
              const sessionID = v2PickStr(fields, "sessionID", "sessionId")
              if (sessionID) v2HandleIdle(sessionID, goalClient)
            } else if (type === "session.created") {
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
    let closing: Promise<void> | undefined
    return () => {
      if (!closing) {
        controller.abort()
        closing = (async () => {
          try {
            await iterator?.return?.()
          } catch {
            // Iterator close is best-effort, including asynchronous rejection.
          }
        })()
      }
      return closing
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
export const v2WiringSeam = { modelsDevCatalog: () => modelsDevCatalog, resolveDepthChannel, sessions, sessionAgents, crews, sessionDepths, turnActivity, crewTurnActivity, sessionMovedAnchors, crewNativeChildren, crewNativeCeiling, crewChildDigest, crewNativeWatch, crewNativeRecheckArmed: (sessionID: string) => crewNativeRecheck.has(sessionID), crewNativeRecheckNow: (sessionID: string, client: GoalClient | null) => crewNativeRecheckTick(sessionID, client), resetHostAnchors: () => { hostAnchors.length = 0; v2HostAnchors.clear(); observedRecipeFiles.clear(); poolResolver = null; poolResolution = null } }

// ---- v2-single-agent-surface: single-agent-surface primitives (v2Setup
// only — the v1 config-hook path never uses these) ----
//
function v2PermissionArray(record: Record<string, string>): Array<Record<string, unknown>> {
  const arr = Object.entries(record).map(([action, effect]) => ({ action, resource: "*", effect }))
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

export async function v2Setup(ctx: V2PluginContext, deps?: V2SetupDeps): Promise<void | (() => Promise<void>)> {
  for (const finding of legacyDispatchEnvFindings(process.env)) console.warn(`[forge:v2] ${finding.level}: ${finding.message}`)
  // Load before registering any consumer of the depth catalog. Existing
  // v2 harnesses did not fetch; keep node:test offline by default, with
  // explicit "0" on the existing fetch switch for transport-fixture tests.
  const noFetch = process.env.FORGE_TEST_NO_DISPATCH_FETCH
  const nodeTest = !!process.env.NODE_TEST_CONTEXT || process.execArgv.some((a) => a === "--test" || a.startsWith("--test-"))
  // Leave headroom for the host's bounded async setup registration window.
  await refreshModelsDevCatalog(noFetch === "1" || (noFetch !== "0" && nodeTest), 2_000)

  // ---- host-axis parity (tasks 3.1/4.x): the belts and injections below
  // share the v1 module state, so seed the workspace registry + launch
  // anchor exactly like server() does — the shared predicates
  // (resolvePools / the pool gates) then see the same disk truth as on a v1
  // host. NOT "only one entry per host process" any more (that v1 fact is
  // what fix-unknown-session-anchor-seed corrects): a v2 host runs this
  // setup once PER DIRECTORY over ONE module, so every module-level
  // "last writer wins" value below — hostWorktree above all — belongs to
  // whichever directory initialized last, and session-directory decisions
  // go through stateForCheck (the host's session record) instead.
  const explicitCandidates = [...(deps?.anchors ?? []), ...v2AnchorCandidates(ctx, false)]
  const v2Candidates = [...explicitCandidates, process.cwd()]
  {
    for (const cand of v2Candidates) {
      const t = cand.trim()
      if (t) rememberHostAnchor(t)
    }
    const first = v2Candidates.find((c) => c && !isRootish(c))
    if (first) {
      hostWorktree = first
      // fix-unknown-session-anchor-seed (design D1): remember that THIS
      // process initialized this directory. From the second distinct
      // directory on, "the last initialized directory" is no longer any
      // session's own, and launch-directory seeding stops (stateForBan).
      v2InitializedDirs.add(normalizeAnchorDir(first) || first)
    }
  }
  // ---- native-first-roster (design D5): the materialize knob. The v2
  // host generation DEFAULTS DIRECTLY to "native" (owner decision
  // 2026-11-21 — no deprecation window; v1 hosts stay runtime-pinned and
  // never reach this line, so their behavior is byte-equal). "runtime"
  // remains selectable as the escape hatch: the draft-materialization
  // path below then runs exactly as before. Knob resolution: explicit
  // deps override (test seam) > GLOBAL forge.json layer > default.
  v2HostSeen = true
  const homeDir = deps?.homeDir ?? process.env.FORGE_TEST_FORGE_HOME ?? homedir()
  const globalPoolFile = forgeConfigPaths({ homeDir }).global
  const readRecipe = deps?.readFile ?? ((path: string) => readFileSync(path, "utf8"))
  const recipeStat = deps?.stat ?? recipeFileStat
  const snapshots = new Map<string, string>()
  const unreadable = new Set<string>()
  const snapshotRead = (path: string): string => {
    const previous = snapshots.get(path)
    if (previous !== undefined) return previous
    if (unreadable.has(path)) throw new Error(`Recipe unavailable in this sync snapshot: ${path}`)
    try {
      const text = readRecipe(path)
      snapshots.set(path, text)
      return text
    } catch (err) {
      unreadable.add(path)
      throw err
    }
  }
  const globalKnobs = readGlobalKnobs(globalPoolFile, { readFile: snapshotRead })
  // Authorization must belong to exactly the recipe compiled by this pass.
  // Recheck its presence and bytes immediately before any write or GC.
  const stillAuthorized = (path: string): boolean => {
    const text = snapshots.get(path)
    if (text === undefined) return false
    const parsed = parseForgeJsonc(text)
    if (!parsed.ok || !parseTopLevelKnobs(parsed.config, path).syncAuto) return false
    try {
      return recipeStat(path) !== null && readRecipe(path) === text
    } catch {
      return false
    }
  }
  v2MaterializeMode = deps?.materialize ?? globalKnobs.materialize ?? "native"
  // ---- sync:"auto" opt-in (design D4): at session start, pools whose
  // OWN file declares sync:"auto" regenerate silently when stale, with a
  // disclosed finding (console warn). The default posture (absent knob)
  // writes NOTHING uninvited — gate + in-band forge_sync only.
  if (v2MaterializeMode === "native") {
    try {
      const resolver = createPoolResolver({ homeDir, stat: recipeStat, readFile: snapshotRead })
      // Name against the same accumulated host anchors as explicit sync,
      // but authorize only sources discovered by THIS setup (plus global).
      // Cwd remains a host-union candidate, but is only an auto-sync
      // source when no explicit setup location is available.
      const explicitKeys = explicitCandidates.map(normalizeAnchorDir).filter(Boolean)
      const currentKeys = new Set(explicitKeys.length ? explicitKeys : [normalizeAnchorDir(process.cwd())])
      const currentFiles = new Set<string>([globalPoolFile])
      for (const anchor of hostAnchors) {
        if (!currentKeys.has(anchorKey(anchor))) continue
        const file = resolver.workspacePoolOf(anchor)
        if (file !== null) currentFiles.add(file)
      }
      const resolution = resolver.resolve(hostAnchors)
      for (const family of resolution.families) observedRecipeFiles.add(family.file)
      const overrideDir = globalAgentDirFor({ homeDir, configDir: process.env.OPENCODE_CONFIG_DIR })
      const rosterDirs = { globalPoolFile, globalAgentDir: overrideDir }
      const allPlans = planRosterSync(resolution, rosterDirs)
      for (const family of resolution.families) {
        if (!currentFiles.has(family.file)) continue
        const verdict = staleCheckForPool(family.file, family.materializedIds, realRosterFs(), (matId) => compileResolvedRosterEntry(resolution, matId, { globalPoolFile }).content, rosterAgentDirFor(family.file, rosterDirs))
        if (!verdict.stale) continue
        if (!stillAuthorized(family.file)) {
          console.warn(`[forge:sync] warn: ${verdict.reason}; call forge_sync to reconcile (no current auto opt-in).`)
          continue
        }
        const plans = allPlans.filter((p) => p.family.file === family.file)
        const outcome = executeRosterSync(plans, realRosterFs())
        console.warn(
          `[forge:sync] warn: sync:"auto" — stale roster regenerated at session start (${verdict.reason}); created ${outcome.created.length}, updated ${outcome.updated.length}, gc'd ${outcome.gced.length}${outcome.errors.length ? `, errors: ${outcome.errors.join("; ")}` : ""}`,
        )
      }
      // Overrides are independently authorized by the global recipe, even when
      // it contributes no fallback workers. Inspect before deciding to write.
      const overridePlan = planOverrideSync(resolution.overrides ?? {}, { dir: overrideDir, recipeFile: globalPoolFile })
        ?? { kind: "override" as const, dir: overrideDir, files: [] }
      const overrideFindings = overrideSyncFindings(overridePlan, realRosterFs())
      if (overrideFindings.length) {
        if (stillAuthorized(globalPoolFile)) {
          const outcome = executeRosterSync([overridePlan], realRosterFs())
          console.warn(`[forge:sync] warn: sync:"auto" — ${overrideFindings.join("; ")}; created ${outcome.created.length}, updated ${outcome.updated.length}, gc'd ${outcome.gced.length}${outcome.errors.length ? `, errors: ${outcome.errors.join("; ")}` : ""}`)
        } else {
          console.warn(`[forge:sync] warn: ${overrideFindings.join("; ")}; call forge_sync to reconcile (no auto opt-in).`)
        }
      }
    } catch {
      // Auto-sync is best-effort: never a throw into the host.
    }
  }
  // ---- agent domain: forge primary + full sole-pool-ownership
  // materialization (task 1.2 — parity with the v1 config hook, same
  // createPoolResolver + forgeAgentDef cores).
  if (typeof ctx.agent?.transform === "function") {
    await ctx.agent.transform((draft) => {
      if (typeof draft.get !== "function" || typeof draft.update !== "function") return
      if (draft.get(FORGE_AGENT) === undefined) {
        draft.update(FORGE_AGENT, (agent) => {
          agent.description =
            "forge — the single general-purpose coding agent: takes implementation tasks directly; planning goes through /plan into the plan harness (plans land in .opencode/plan/, with an approve confirmation gate, a plugin-verified fail-closed close that re-runs the frozen checks, and tick discipline enforced by tools and the permission layer)."
          agent.system = FORGE_PROMPT
          agent.mode = "primary"
        })
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
        const resolver = createPoolResolver({ homeDir, stat: deps?.stat ?? recipeFileStat, readFile: deps?.readFile })
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
    // is THIS initialization's own ctx.permission.assert —
    // the interface bound to the directory instance whose sessions run these
    // closures. A module-level "latest init" seam sent every directory's
    // asks to the last-initialized directory's pending table (that other
    // terminal never saw them), and died for EVERY directory once that one
    // was evicted. Read exactly as the seam used to be; only the scope
    // changed — this initialization, never the module.
    const toolAssert: V2AssertFn | null = typeof ctx.permission?.assert === "function" ? (input: unknown) => ctx.permission!.assert!(input) : null
    try {
      await ctx.tool.transform((editor) => {
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
              if (name === "crew_close" && typeof context.sessionID === "string") {
                const sid = context.sessionID
                context.crewCloseEvidence = async (): Promise<CrewCloseEvidence> => {
                  const view = await walkNativeChildren(v2NativeChildWalker(), sid)
                  let transcript: unknown = null
                  try { transcript = await ctx.session?.context?.({ sessionID: sid }) } catch {}
                  return { ...view, rounds: crews.get(sid)?.rounds ?? [], context: transcript }
                }
              }
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

  // D9: v2.4.0 Location.Info carries workspaceID; absence binds the
  // searchable local Environment (core/environment/environment.ts:60–85).
  const searchLocation = ctx.location as unknown as { directory?: unknown; workspaceID?: unknown; project?: { directory?: unknown } } | undefined
  const searchDirectory = searchLocation?.directory
  const searchProject = searchLocation?.project?.directory
  const searchWarn = (message: string) => console.warn(`[forge:search] ${message}; native tools retained`)
  if (typeof searchDirectory === "string" && isAbsolute(searchDirectory) && typeof searchProject === "string" && isAbsolute(searchProject) && searchLocation?.workspaceID === undefined && typeof ctx.permission?.assert === "function" && typeof ctx.tool?.transform === "function") {
    const ask = ctx.permission.assert.bind(ctx.permission)
    try {
      await ctx.tool.transform(editor => {
        for (const kind of ["grep", "glob"] as const) {
          const native = editor.get?.(kind) as Record<string, unknown> | undefined
          if (!native || !editor.update || typeof native.execute !== "function" || !native.output) { searchWarn(`${kind} definition unavailable`); continue }
          const output = native.output as { value?: { fields?: Record<string, unknown> }; type?: string; items?: { properties?: Record<string, unknown> } }
          const outputFields = output.value?.fields ?? output.items?.properties
          const requiredOutput = kind === "grep" ? ["entry", "line", "offset", "text", "submatches"] : ["path", "type"]
          if (!outputFields || !requiredOutput.every(key => key in outputFields)) { searchWarn(`${kind} unknown output schema`); continue }
          const executeNative = native.execute as (input: unknown, context: unknown) => Promise<unknown>
          // Preserve every native field codec/annotation. For Effect Structs
          // use the host object's own mapFields method and its optional Boolean
          // field as the follow codec (no second Effect runtime imported).
          const schema = native.input as { fields?: Record<string, any>; mapFields?: (f: (fields: Record<string, any>) => Record<string, any>) => unknown; properties?: Record<string, any>; type?: string } | undefined
          let enhancedInput: unknown
          if (schema?.fields && typeof schema.mapFields === "function") {
            const bool = schema.fields[kind === "grep" ? "literal" : "hidden"]
            if (typeof bool?.annotate !== "function") { searchWarn(`${kind} optional boolean schema unavailable`); continue }
            enhancedInput = schema.mapFields(fields => ({ ...fields, ...(kind === "glob" ? { hidden: bool.annotate({ description: "Include hidden files and directories (default: true).", default: true }) } : {}), follow: bool.annotate({ description: "Follow symbolic links and junctions (default: true).", default: true }) }))
          } else if (schema?.type === "object" && schema.properties) {
            enhancedInput = { ...schema, properties: { ...schema.properties, ...(kind === "glob" ? { hidden: { ...schema.properties.hidden, default: true, description: "Include hidden files and directories (default: true)." } } : {}), follow: { type: "boolean", default: true, description: "Follow symbolic links and junctions (default: true)." } } }
          } else { searchWarn(`${kind} unknown input schema`); continue }
          try {
            editor.update(kind, draft => {
              draft.input = enhancedInput
              draft.description = `${native.description ?? kind} Follows symbolic links and junctions by default.${kind === "glob" ? " Hidden directories are included by default." : ""}`
              draft.execute = async (raw: SearchInput, invocation: SearchInvocation) => {
                if (raw.path && ambiguousSearchPath(raw.path)) {
                  // Machine path syntax belongs to the host, never local fs.
                  const { follow: _follow, ...nativeInput } = raw
                  return executeNative(nativeInput, invocation)
                }
                let rgConfig: { rgPath?: string } | undefined
                for (const file of [forgeConfigPaths({ projectDir: searchProject }).project, globalPoolPathOf()]) {
                  try {
                    const parsed = parseForgeJsonc(readFileSync(file, "utf8"))
                    const search = parsed.ok ? (parsed.config as { search?: { rgPath?: string } } | undefined)?.search : undefined
                    if (typeof search?.rgPath === "string") { rgConfig = search; break }
                  } catch { /* absent recipe */ }
                }
                const rg = resolveRgBinary(rgConfig)
                let engine = rg.ok ? "ripgrep" : "builtin-js"
                const startupFailed = (result: { error?: Error; status: number | null }) => result.error && result.status === null && ["ENOENT", "EACCES", "EPERM", "ENOEXEC"].includes((result.error as NodeJS.ErrnoException).code ?? "")
                const grep = rg.ok ? ((bytes: Buffer, input: SearchInput): SearchMatch[] => {
                  if (engine === "builtin-js") return jsGrep(bytes, input)
                  const args = ["--no-config", "--no-ignore", "--json", ...(input.literal ? ["--fixed-strings"] : []), ...(input.caseSensitive === false ? ["--ignore-case"] : []), "--", input.pattern, "-"]
                  // rg receives bytes only, never a search path: it cannot
                  // open files or follow a link after permission checks.
                  const result = spawnSync(rg.binary, args, { input: bytes, encoding: "utf8", windowsHide: true, timeout: 10000, maxBuffer: 32 * 1024 * 1024 })
                  if (startupFailed(result)) { engine = "builtin-js"; return jsGrep(bytes, input) }
                  if (result.error || (result.status !== 0 && result.status !== 1)) throw new Error(result.error?.message ?? result.stderr ?? "ripgrep failed")
                  return result.stdout.split(/\r?\n/).filter(Boolean).flatMap(line => {
                    const event = JSON.parse(line)
                    if (event.type !== "match") return []
                    const d = event.data
                    const text = d.lines.text ?? Buffer.from(d.lines.bytes, "base64").toString("utf8")
                    return [{ line: d.line_number, offset: d.absolute_offset, text: text.length > 2000 ? text.slice(0, 2000) + "..." : text, submatches: d.submatches.slice(0, 100).map((m: { match: { text?: string; bytes?: string }; start: number; end: number }) => ({ text: m.match.text ?? Buffer.from(m.match.bytes ?? "", "base64").toString("utf8"), start: m.start, end: m.end })) }]
                  })
                }) : undefined
                const glob = rg.ok ? ((pattern: string, paths: string[]): boolean[] => {
                  // Match the already listed names as NUL-delimited data, never
                  // give rg a directory or a file path to traverse independently.
                  if (!paths.length) return []
                  const fallback = () => paths.map(path => matchGlob(pattern, path))
                  if (engine === "builtin-js") return fallback()
                  const result = spawnSync(rg.binary, ["--no-config", "--no-ignore", "--null-data", "--line-number", "--no-filename", "--color", "never", "--", strictGlobToRegExp(pattern).source, "-"], { input: paths.join("\0") + "\0", encoding: "utf8", windowsHide: true, timeout: 10000, maxBuffer: 32 * 1024 * 1024 })
                  if (startupFailed(result)) { engine = "builtin-js"; return fallback() }
                  if (result.error || (result.status !== 0 && result.status !== 1)) throw new Error(result.error?.message ?? result.stderr ?? "ripgrep failed")
                  const matched = new Set(result.stdout.split("\0").map(line => Number(line.slice(0, line.indexOf(":")))))
                  return paths.map((_, i) => matched.has(i + 1))
                }) : undefined
                return authorizedSearch(kind, raw, invocation, searchDirectory, searchProject, { realpath: realpathSync, stat: lstatSync, list: readdirSync, read: path => {
                  const fd = openSync(path, "r")
                  try {
                    const before = fstatSync(fd)
                    if (!before.isFile() || before.size > MAX_FILE_BYTES || realpathSync(path) !== path) return Buffer.alloc(MAX_FILE_BYTES + 1)
                    const bytes = Buffer.allocUnsafe(MAX_FILE_BYTES + 1)
                    const n = readSync(fd, bytes, 0, bytes.length, 0)
                    const after = fstatSync(fd)
                    if (before.ino !== after.ino || before.dev !== after.dev || realpathSync(path) !== path) throw new Error("Search target changed")
                    return bytes.subarray(0, n)
                  } finally { closeSync(fd) }
                }, assert: ask, grep, glob, engine: () => engine,
                  globalIgnore: { home: (process.platform === "win32" ? process.env.USERPROFILE : process.env.HOME) ?? "", xdg: process.env.XDG_CONFIG_HOME },
                  delegateNative: () => { searchWarn("global ignore authorization or environment unavailable"); const { follow: _follow, ...nativeInput } = raw; return executeNative(nativeInput, invocation) }
                })
              }
            })
          } catch (error) { searchWarn(`${kind} update rejected: ${String(error)}`) }
        }
      })
    } catch (error) { searchWarn(`tool transform rejected: ${String(error)}`) }
  } else searchWarn("host availability or permission context unknown or non-local")

  // ---- permission domain (task 3.1): the belt on ctx.permission.hook
  // ("evaluate") — doors keep a REAL ask (explicit deny stands), draft
  // write-freeze denies, native shell permissions otherwise pass through untouched. Same
  // decision table as the v1 permission.ask hook; W6a pinned the event to
  // the real PermissionEvaluation shape (effect mutation). The v1
  // ask-callback decision gates — plan_approve/goal_write(arm)/
  // goal_complete/goal_resume/goal_discard/crew_close — map to
  // ctx.permission.assert; that bridge is captured per initialization in
  // the tool block above (fix-ask-door-multi-directory-host), never here
  // as module state. Pure classification/refusal stays evaluate-mutation.
  v2RegisterPermissionBelt(ctx)

  // ---- tool hooks (task 4.1): activity marking (execute.after ledger) +
  // the full dispatch-guard belt
  // (execute.before), all over the shared module predicates. W6a: the
  // before payload is {tool, sessionID, agent, messageID, id, input} —
  // the call id is `id` (Tool.CallID), the arguments are `input`.
  const v2Anchor = v2AnchorClient(ctx)
  anchorClientShared = v2Anchor
  v2RegisterToolHooks(ctx, v2Anchor)

  // ---- session-domain client for goal continuation (prompt + get).
  const v2Client = v2SessionClient(ctx)
  const goalClient =
    v2Client && typeof v2Client.session.prompt === "function" && typeof v2Client.session.get === "function" ? (v2Client as unknown as GoalClient) : null


  // ---- session seams (task 4.2 + W6a idle choice): prompt (busy
  // marking) / context (thoughtLevel injection + family-gated system
  // injections + plan/goal notices) / compaction
  // (goal-brief reinjection) / experimental.idle (the PRIMARY idle edge —
  // goal continuation + job-wake delivery; SSE fallback below) —
  // Decision 3's event topology, fail-open on drift, registrations
  // collected for the setup cleanup.
  const sessionHooks = await v2RegisterSessionHooks(ctx, goalClient)

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
  // doc-plugin-unload-v2: this combined cleanup is the ONLY cleanup a v2
  // host runs on plugin unload (2.4.0 registers the function `setup`
  // resolves to). It tears down THIS instance only
  // (tests/v2-setup-cleanup.test.mjs pins it).
  const disposables = [...sessionHooks.disposables, ...(v2AbortEvents ? [v2AbortEvents] : [])]
  return disposables.length > 0
    ? async () => {
        if (goalClient) disposeGoalClient(goalClient)
        // Start every disposal, including event abort, without waiting for
        // another registration's asynchronous cleanup to settle.
        await Promise.allSettled(disposables.map(async (dispose) => dispose()))
      }
    : undefined
}

export default { id: "forge", setup: v2Setup }
