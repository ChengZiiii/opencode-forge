# goal-harness Specification

## Purpose
Give forge an execution layer that is orthogonal to every workflow discipline: a goal is a persistent, self-contained objective the agent autonomously drives to **host-verified** completion — continuation on session idle under a hard budget, verification items (shell commands and file contracts) actually executed by the plugin on the host (fail-closed), structured self-attestation per success criterion, and every transition into or out of autonomy gated by user confirmation. Goals read no state from and hold no binding to the plan harness or any spec workflow; the only intersection is safety (a live draft write-ban pauses the loop). The objective itself always remains the semantic requirement — verification items add proof obligations, they never replace the outcome.

## Requirements

### Requirement: Goal file persistence layout

Goal files SHALL be created under the workspace's `.opencode/goal/` directory, named `YYYY-MM-DD-<slug>.md` with the slug derived from the goal statement (kebab-case, length-truncated); same-day slug collisions SHALL get a numeric suffix. The frontmatter SHALL contain at least `status` (queued / active / paused / completed / abandoned), `created`, `updated`, `revision` (starting at 1), `session` (owning session ID, empty while queued), budget fields (`max_turns`, `turns_used`, `max_minutes`), and `stop_reason` (set whenever paused). All goal-file mutations SHALL be atomic (write to a temp file, then rename over the target) so a crash mid-write never leaves a half-written goal. Worktree resolution SHALL use the session-observable anchor chain: the session's non-degenerate worktree first, then the session's own directory (as carried by the tool context / session record — a degenerate or global-project worktree never shadows it), then the host launch directory as the final fallback. Terminal and queued goal files SHALL remain under `.opencode/goal/` (uninstalling the plugin SHALL NOT delete them).

#### Scenario: A compliant goal file is generated

- **WHEN** `goal_write` successfully persists an armed goal with the statement "make the test suite green"
- **THEN** a file like `2026-09-25-make-test-suite-green.md` appears under `.opencode/goal/`, with frontmatter containing `status: active`, `revision: 1`, the owning session ID, and budget fields

#### Scenario: Crash mid-write leaves the previous state intact

- **WHEN** the plugin is killed while updating a goal file
- **THEN** the file on disk is either the old complete version or the new complete version, never a partial hybrid

#### Scenario: A degenerate worktree does not shadow the session directory

- **WHEN** a session's reported worktree is degenerate (global-project "/") while the session's own directory is observable (tool context or session record) and differs from the host launch directory
- **THEN** goal (and plan) files anchor under the session's directory, not the host launch directory

### Requirement: Structured goal contract rendering with revision isolation

`goal_write` SHALL validate input and render fixed sections: Goal, Success Criteria (numbered, verifiable), Verification Checks (numbered items of two kinds — shell commands with per-command timeout, and file contracts `file::required text`), Constraints, and Non-Goals. Missing or empty required content SHALL error without writing. A revision of a live or queued goal SHALL increment `revision` in place; all recorded evidence (check results, turn ledger) SHALL carry the revision it was produced under, and evidence from an older revision SHALL carry no authority for the current revision. The full goal statement SHALL remain the semantic completion requirement — verification checks add proof obligations, they do not replace the outcome.

#### Scenario: Complete contract persists

- **WHEN** the goal contract contains every required section
- **THEN** persistence succeeds and the tool returns the file path and criterion/check counts

#### Scenario: Missing verification rejected

- **WHEN** the contract declares success criteria but no verification items
- **THEN** the tool errors explaining that verified completion needs at least one verification item, and no file is created

#### Scenario: Editing starts a new revision

- **WHEN** the user tightens the criteria of a live goal and `goal_write` revises the contract
- **THEN** `revision` increments and prior Check Log entries remain visible but stamped with the old revision number

### Requirement: Single live goal per session with queueing

Each session SHALL have at most one live (active or paused) goal; creating another SHALL error, directing the user to edit the live goal, queue the new one, or discard. Queued goals (`status: queued`) SHALL be inert contracts with no owner session and no continuation; promotion to active SHALL go through the same arm gate as direct arming. The queue SHALL be ordered by file creation, and promotion SHALL take the oldest queued goal in the workspace.

#### Scenario: Second live goal refused

- **WHEN** the session already has an active goal and `goal_write` is called to create another with arming
- **THEN** the tool errors listing the live goal and the edit/queue/discard options

#### Scenario: Queued goal stays inert

- **WHEN** a queued goal exists and no live goal does, and a session in that workspace goes idle
- **THEN** no continuation is sent for the queued goal

#### Scenario: Promotion goes through the gate

- **WHEN** the user runs `/goal next` and the oldest queued goal is picked
- **THEN** the arm confirmation is presented; only on allow does it become active and owned by this session

### Requirement: Arm gate on arming and promotion

Arming a goal — direct creation with arming (`/goal <text>` path) or promotion of a queued goal — starts an autonomous continuation loop and SHALL be pinned to an ask-level user confirmation (the user's Allow IS the arm action). Ungated creation SHALL only produce a queued (inert) goal; revision of the current goal SHALL NOT require a new confirmation. Arming SHALL be refused while the session has an active draft plan (autonomous execution cannot run against the planning-phase write ban).

#### Scenario: User confirms arming

- **WHEN** the model presents the goal contract and calls `goal_write` with arming, and the user allows the confirmation dialog
- **THEN** the goal becomes active, owned by this session, and the continuation engine is armed

#### Scenario: Queued creation needs no gate

- **WHEN** the user runs `/goal add tighten error messages` and the model calls `goal_write` without arming
- **THEN** a queued goal file is created with no confirmation dialog

#### Scenario: Arming refused during draft planning

- **WHEN** the session's plan is in draft and arming is attempted
- **THEN** the tool errors directing the user to approve or discard the plan first

### Requirement: Host-verified completion gate

`goal_complete` SHALL re-execute every verification item itself on the host at gate time — shell commands spawned by the plugin (worktree as cwd, per-command timeout, output captured and truncated) and file contracts re-read from disk inside the project boundary — ignoring all previously recorded results (fail closed: any nonzero exit, timeout, spawn failure, missing file, or absent required text aborts completion with the failing item and its captured evidence, leaving the goal active). The call SHALL additionally require a structured self-attestation: one entry per success criterion of the current revision, each with pass/fail and concrete evidence; any failing or unmatched entry SHALL abort before the user gate. Only after all checks and all attestations pass SHALL the user confirmation be presented; on allow the goal transitions to completed with the final results recorded.

#### Scenario: Completion refused when a check fails

- **WHEN** the model calls `goal_complete` and the re-run of shell check 2 exits nonzero
- **THEN** the tool errors with the command and its output; the goal stays active and the model continues working

#### Scenario: File contract failure fails closed

- **WHEN** a file contract requires `config.ts::READ_PORT_FROM_ENV` and the re-read file no longer contains that text
- **THEN** completion is refused naming the file and the missing text

#### Scenario: Self-attestation with a gap rejected

- **WHEN** the attestation array omits one success criterion of the current revision or marks it unmet
- **THEN** the tool errors naming the criterion; the user gate is never reached

#### Scenario: Verified completion closes the goal

- **WHEN** every re-run check passes, every attestation is passing with evidence, and the user confirms the dialog
- **THEN** the goal's status becomes completed with the final check results and attestations recorded

### Requirement: Mid-flight checks, Check Log, and Turn Ledger

`goal_check` SHALL execute the goal's verification items (or a selected subset) with the same host execution semantics as the completion gate, appending one dated, revision-stamped entry per run to the Check Log (item, exit code or file-contract result, truncated output). Recorded results are advisory feedback for the model and carry no gating authority. Each actual continuation work turn SHALL append a Turn Ledger entry (turn number, whether any write-class tool, `goal_check`, or verification command ran, plus the observable activity disposition under 'No-progress auto-pause') using the existing ledger; waiting alone is not a turn. Recorded tool execution SHALL remain distinct from new information, so repeated identical checks remain auditable without being credited as progress.

#### Scenario: Model verifies progress mid-flight

- **WHEN** the model believes the criteria may now hold and calls `goal_check`
- **THEN** the items actually run on the host and a dated, revision-stamped entry appears in the Check Log

#### Scenario: Turn activity is recorded

- **WHEN** an actual continuation work turn ends
- **THEN** the Turn Ledger gains an entry stating whether that turn contained writes, checks, or verification commands and its observable activity disposition; waiting by itself creates no work turn

### Requirement: Autonomous continuation under budget

While the session's goal is active, the plugin SHALL listen for `session.idle` and, after a short debounce and a re-check that the session is still idle, send a compact continuation prompt through the host client containing the goal brief (statement, success criteria, outstanding verification items, remaining budget) and directives (work the criteria, `goal_check` when you believe they hold, `goal_complete` at the gate, `goal_pause` with a blocker summary if stuck; when the work calls for parallel decomposition, own the crew layer — register crews with `crew_begin {execution: "waves"}` in a single call, dispatch native `subagent` waves under the crew discipline, and re-shard via `crew_close {abandon}` plus a fresh registration when the decomposition proves wrong — the goal contract's arming authorization covers this orchestration autonomy) The crew-layer directive SHALL be STRUCTURE-AWARE: when the goal contract's criteria or constraints carry a numbered subtask structure or name `forge-*` agents, the brief SHALL direct preferring born-armed crew re-registration (one-call `execution: "waves"`) over self-executing the whole plan in the main session; without such structure the discretionary phrasing stands. Each actual work continuation SHALL increment `turns_used` exactly once. The loop SHALL enforce two budgets — continuation turns and wall-clock minutes since arming, including crew waiting (existing hard ceiling, armed_at, revision and restart semantics unchanged) — with defaults and hard ceilings; budget exhaustion SHALL auto-pause the goal with the matching stop reason and send one wrap-up continuation directing a handoff summary, never silently keep looping. Consecutive continuation delivery failures SHALL be counted and after a small threshold SHALL auto-pause with a transport stop reason. The existing one-time budget wrap-up is a handoff-only prompt, not authorization for further goal work; it SHALL NOT override an intervening explicit pause. Token budgets are outside this change's implementation scope: only a host capability probe is planned, and unproven metering SHALL NOT be presented as a hard limit.

#### Scenario: Idle session with an active goal continues

- **WHEN** the model finishes a reply without completing the goal and the session goes idle
- **THEN** the plugin sends the continuation prompt and the session resumes working the goal

#### Scenario: Turn budget exhausted

- **WHEN** `turns_used` reaches the goal's turn budget
- **THEN** the goal auto-pauses with stop reason `budget-turns` after one wrap-up handoff prompt; no further continuation is sent

#### Scenario: Continuation transport keeps failing

- **WHEN** three consecutive continuation sends fail
- **THEN** the goal auto-pauses with a transport stop reason instead of retrying forever

#### Scenario: No continuation for non-owner sessions

- **WHEN** a second session in the same workspace goes idle while the goal belongs to another session
- **THEN** that session sends no continuation (single continuation owner)

#### Scenario: Continuation brief owns the crew layer

- **WHEN** a goal continuation fires and the work benefits from parallel decomposition
- **THEN** the brief's directives authorize one-call crew arming (`execution: "waves"` at registration) and abandon-based re-sharding, and the crew tools' gates stay internal to the loop — no user dialog mid-loop

#### Scenario: A structured goal contract prefers born-armed orchestration

- **WHEN** the goal contract's criteria or constraints name `forge-*` agents or carry a numbered subtask structure and the session goes idle under the active goal
- **THEN** the brief directs re-registering the plan as a born-armed crew (one-call `execution: "waves"`) over self-executing the entire plan in the main session

While an active goal has positively established outstanding host work or legitimate host-side waiting (including accepted native child rounds with or without a crew, owning-session background shell work and pending host permission/user responses where observable), normal goal continuation SHALL be suppressed. The engine SHALL use existing host-observable evidence and bounded harness-local observation; uncertainty, missing or incomplete events SHALL NOT be guessed to mean either settlement or inactivity. No polling-induced model turns SHALL be sent merely to wait; bounded diagnostic or budget handoff, if still authorized, is not a work continuation. Wall-clock minutes still elapse and expiration SHALL pause even while waiting. When the wait is verifiably resolved, only the still-authorized owner may resume once through the normal debounce and busy recheck. For goal-governed crews, shared crew in-flight observation SHALL suppress normal continuation while waiting for outstanding rounds. Held decisions and partial host-result wakes SHALL NOT consume turns, no-progress streak or delivery-failure budget merely for waiting. A bounded diagnostic handoff on an unreadable view or ceiling SHALL disclose unresolved evidence without starting a next wave or converting waiting into work; explicit goal pause/discard and draft conflict retain precedence. Only upon independently verified settlement of every outstanding round, the goal engine alone resumes once through its normal debounce and busy recheck, with no crew brief. Budget expiration during waiting SHALL pause the goal with the existing stop reason and bounded handoff, without falling back to standalone crew autonomy. Pause, discard, completion and loss of active governing authorization SHALL inhibit crew continuation; only the existing explicit user arming or resume path can restore authorization (crew-harness). Accounting SHALL deduplicate round observations and distinguish a new accepted dispatch reusing a session id.

#### Scenario: Goal-governed crew waits without burning continuation budget

- **WHEN** an active goal owns a born-armed crew with a partial wave, including duplicate idle or result observations
- **THEN** no normal goal or crew continuation is injected while waiting, no next wave starts, and turn, delivery-failure and no-progress budgets are not consumed merely by waiting; wall-clock minutes continue to elapse; when every round is verified settled and the goal remains active within budget, only one goal continuation resumes

#### Scenario: Legitimate host waiting without a crew does not spin

- **WHEN** the goal owner has observable outstanding native child work, background shell work or a pending host response, including duplicate idle notifications and incomplete result observations
- **THEN** no normal work prompt is sent merely to wait, neither turn nor stagnation nor delivery-failure counters advance for waiting, minutes still elapse and can expire, and only verified resolution within active authorization permits one continuation; unknown status is disclosed without guessing settlement

### Requirement: No-progress auto-pause

The engine SHALL assess observable activity per actual goal work continuation turn only (ordinary replies outside the goal loop never count). Qualifying activity includes meaningful reads, reconnaissance and review, real writes, plan ticks, commits, verification (`goal_check` or the host's builtin shell) with new evidence, diagnosis of a failure with new evidence, and accepted native dispatch rounds (deduplicated per round). Read-only work and non-git workspaces SHALL NOT require a file change, git diff, or shell execution to count as activity. Waiting on outstanding host work or a legitimate host-side wait SHALL NOT be treated as a work turn or stagnation. Unknown or incomplete observations SHALL NOT be guessed to be inactivity, progress or settlement. The existing two-consecutive-turn no-progress threshold SHALL apply only to clearly established absence of activity, causing auto-pause with stop reason `no-progress` and a handoff directive. A lightweight repeated-no-information check SHALL distinguish demonstrably identical check inputs and results across work continuations, with no other new activity or evidence: repeating such checks SHALL NOT indefinitely reset the no-progress detector, and persistent confirmed repetition SHALL trigger an appropriate bounded no-progress pause with the repeated evidence disclosed. A changed result, new evidence, a different meaningful investigation or other qualifying activity SHALL break repetition; uncertain equality SHALL NOT be treated as repetition. No semantic scoring, LLM verifier, generic process supervision or guarantee of detecting every loop inside a single model turn is introduced. The existing Turn Ledger and Check Log remain auditable; check execution is recorded even when its repetition adds no information.

#### Scenario: Spinning without effect pauses the loop

- **WHEN** two consecutive goal work continuations are confirmed to have no qualifying activity, neither is waiting, and observations are sufficient to establish inactivity
- **THEN** the goal auto-pauses with stop reason `no-progress` instead of burning budget

#### Scenario: A verifying turn is never mis-scored

- **WHEN** a continuation turn runs the goal's verification commands through the builtin shell tool and obtains new evidence but writes nothing
- **THEN** the turn is scored as activity, the streak resets, and the loop continues

#### Scenario: Productive read-only and non-git work is not stagnation

- **WHEN** work continuations perform meaningful reconnaissance, review, failure diagnosis with new evidence, or a commit, including work outside a git repository where applicable
- **THEN** the turn is not classified as no-progress merely because it wrote no file, produced no diff, or ran no shell command

#### Scenario: Identical checks cannot keep the goal alive indefinitely

- **WHEN** successive goal work turns repeatedly run a check with provably equal inputs and results and no other new activity
- **THEN** repetition is detected with lightweight observable evidence and bounded by a no-progress pause, not counted indefinitely as progress; changed results, new evidence or other activity break the repetition, and incomplete observations do not prove it

### Requirement: Pause, resume, discard, and explicit reactivation

`goal_pause` SHALL be available at any time without a confirmation gate (pausing is always safe) and SHALL atomically persist `status: paused` with a concrete stop reason/blocker in the existing goal file. The five existing states (`queued`, `active`, `paused`, `completed`, `abandoned`) and file format SHALL remain unchanged. A successful pause SHALL take precedence over pending or scheduled continuation, stale in-memory decisions and later idle/result notifications: re-check current persisted status, owner and revision before committing a continuation or admitting new autonomous goal work. No new autonomous work calls, including native dispatch (forge or fallback), or new goal/crew work continuation may be initiated under paused authorization; an already admitted in-flight call or host work is not promised cancellation, and its eventual result is not a resume signal. Duplicate or late idle/results and host restart SHALL NOT re-arm a paused goal nor downgrade a goal-governed crew to standalone. This restriction concerns autonomous authorization, not ordinary user-directed chat or the existing explicitly authorized standalone crew path. Re-arming SHALL require explicit intent routed through the gated `goal_resume`: short, unambiguous continuation phrases from the user (e.g. "continue", "resume") SHALL be routed by the model to `goal_resume`, whose ask gate protects the transition; arbitrary chat SHALL NOT reactivate a paused goal. `goal_resume` MAY accept a budget top-up (bounded by hard ceilings) and SHALL rebind ownership to the resuming session. `goal_discard` SHALL abandon the goal under an ask-level user confirmation (abandoning the user's objective is the user's decision). Existing completion checks, criterion attestations and confirmation gates are unchanged.

#### Scenario: Model self-reports a blocker

- **WHEN** the model encounters a concrete blocking prerequisite or user decision and cannot advance independent authorized work, then calls `goal_pause` with a reason
- **THEN** the goal file persists paused status and the concrete blocker, the loop stops, and the user decides to resume or discard

#### Scenario: "Continue" routes through the gate

- **WHEN** the goal is paused and the user types "continue"
- **THEN** the model calls `goal_resume`, the confirmation dialog appears, and only on allow does continuation re-arm

#### Scenario: Ordinary chat does not reactivate

- **WHEN** the goal is paused and the user discusses an unrelated topic
- **THEN** no continuation is sent and the goal stays paused

#### Scenario: Pause wins over stale continuation decisions and late results

- **WHEN** `goal_pause` succeeds while continuation is debounced or work is in flight, and repeated/late idle or results arrive before or after restart
- **THEN** the persisted paused status and blocker remain authoritative, no new autonomous work call or goal/crew continuation is admitted, already admitted work is not promised cancellation, and only the existing explicit resume gate can restore goal authorization

### Requirement: Compaction survival and continuation ownership

While a goal is live the plugin SHALL inject the goal brief into the session's compaction context (the goal survives context compaction) and SHALL disable the host's synthetic compaction auto-continue for that session (the goal loop is the single continuation owner — no double continuation).

#### Scenario: Goal facts survive compaction

- **WHEN** the session compacts mid-goal
- **THEN** the compaction prompt carries the goal statement, criteria, and budget state, and post-compaction continuation still follows the goal

#### Scenario: No double continuation after compaction

- **WHEN** compaction completes on a goal session
- **THEN** the host's synthetic continue turn is suppressed and only the goal continuation fires

### Requirement: Goal phase commands

The plugin SHALL register a `/goal` command family that does not switch agents: argument-less `/goal` lists workspace goals with status and budget; `pause`, `resume`, `discard` (and common aliases such as `stop`/`cancel` for discard) drive the corresponding tools; `add <text>` queues an inert goal; `next` promotes the oldest queued goal through the gate; any other argument is a new goal statement, with the template directing the model to extract contract markers (e.g. `--check "npm test"`, `--contains "config.ts::PORT from env"`, `--success`, `--constraint`, `--non-goal`, `--max-turns`, `--max-minutes`) into the structured fields.

#### Scenario: Starting a verified goal from a command

- **WHEN** the user runs `/goal make the suite green --check "npm test"`
- **THEN** forge drafts a goal contract whose Verification Checks include `npm test`, presents it, and arms only on the user's confirmation

#### Scenario: Status listing

- **WHEN** the user runs argument-less `/goal`
- **THEN** every non-terminal goal is listed with path, status, revision, and turns-used/budget

#### Scenario: Queueing and promoting

- **WHEN** the user runs `/goal add refactor config layer` while another goal is live, later runs `/goal next` after it completes
- **THEN** the queued goal is listed as inert while the first runs, and is promoted through the gate afterward

### Requirement: Goal session notice

The system-prompt injection SHALL carry a `[forge:goal-notice]` line whenever the session's goal is live, stating the goal path, status, stop reason when paused, budget remaining, and the next required action, with the same one-line relay rule as the plan notice; it SHALL coexist with (not replace) the plan notice. While paused it SHALL additionally instruct that explicit continuation phrases route through `goal_resume`.

#### Scenario: Notice reflects a live goal

- **WHEN** a session has an active goal with 10/25 turns used
- **THEN** the system prompt contains a goal notice naming the file, status active, and the remaining budget

### Requirement: Workflow decoupling boundary

Goal mode SHALL hold no binding to and read no state from the plan harness or any spec workflow: plan or OpenSpec artifacts SHALL NOT be goal evidence, goal files SHALL NOT reference plan files as completion conditions, and goal tools SHALL NOT inspect plan status. The only permitted intersection is the pre-existing safety constraint — while the session has an active draft plan, arming is refused and continuation auto-pauses with a `draft-conflict` stop reason — and write-ban semantics SHALL be byte-identical with and without goal mode. Nothing prevents the model from choosing to work a plan's tasks or a change's tasks inside a goal; that is convention, not coupling.

#### Scenario: Goal completion does not consult plan state

- **WHEN** a goal completes while a plan in the same workspace is half-done
- **THEN** the goal's completion is judged solely by its own checks and attestations; no plan status is read

#### Scenario: Draft appears mid-goal

- **WHEN** the user starts `/plan` while a goal is live and a draft plan exists at continuation time
- **THEN** the goal auto-pauses with a `draft-conflict` stop reason and the draft ban behaves exactly as without goal mode

#### Scenario: Working a plan inside a goal is convention

- **WHEN** the user arms a goal whose statement is "finish the current plan" without any structural binding
- **THEN** the goal completes on its own verification items only; the plan's own lifecycle (ticks, close gate) proceeds independently

### Requirement: Continuation turn verification discipline

The continuation brief SHALL teach productive work toward the goal criteria, including read-only reconnaissance/review, new verification or diagnosis evidence, real changes, commits and native dispatch; legitimate host waiting is not work. It SHALL NOT demand a write, shell check or git diff each turn, nor encourage repeated checks without new information. If a concrete local issue blocks only one path and independent authorized work remains, continue that work; if no independent work can advance the goal without user input or an unavailable prerequisite, call `goal_pause` with the concrete blocker instead of merely narrating it and ending the turn. The detector SHALL NOT decide to pause by matching keywords in natural-language replies. The brief SHALL teach the same distinction the detector enforces.

#### Scenario: The brief states the per-turn discipline

- **WHEN** a continuation brief is sent
- **THEN** it teaches qualifying work, legitimate waiting and concrete blocker pause, without requiring write/verification each turn or a git diff

#### Scenario: A local blocker does not stop independent work

- **WHEN** one subtask or approach is blocked but another authorized independent task can still advance the goal
- **THEN** the discipline directs continuing the independent work rather than pausing the entire goal; incidental natural-language blocker wording alone does not trigger pause

### Requirement: Host-aligned interpreter for verification shell checks

Every plugin-spawned plan or goal verification shell check (`plan_close`, `goal_check` recording or `goal_complete` gate re-run) SHALL resolve its interpreter through the host-aligned selection chain instead of the Node `shell: true` default (cmd.exe on Windows, `/bin/sh` on POSIX). The chain SHALL be: a host-configured shell, when one is visible to the plugin in the merged host config, takes precedence; otherwise on Windows the first available of `pwsh` → `powershell` → git-bash → `%COMSPEC%` (cmd.exe as a machine-level capability fallback only), and on POSIX the environment login shell with `bash` preferred and `/bin/sh` as the capability fallback. PowerShell-family interpreters SHALL be invoked directly as `<shell> -NoProfile -Command <command>` with an exit-code guard so a native command's exit status propagates as the check's exit status. No plugin option SHALL configure or override the interpreter choice.

#### Scenario: PowerShell syntax executes on Windows

- **WHEN** a plan or goal verification shell check runs a PowerShell-syntax command (e.g. `Get-Content "$env:USERPROFILE\..."`) on a Windows host where a PowerShell-family binary is available
- **THEN** the check's process tree root is the resolved PowerShell binary invoked as `-NoProfile -Command <command>` (never through a cmd.exe `/c` wrapper), and the check's verdict reflects the command's exit status

#### Scenario: Exit code of a wrapped native command propagates

- **WHEN** a native command inside a PowerShell-wrapped check invocation exits with a nonzero status
- **THEN** the check's reported exit code equals that nonzero status (the wrapper does not swallow it)

#### Scenario: POSIX prefers bash with login semantics

- **WHEN** a plan or goal verification shell check runs on a POSIX host where `/bin/bash` exists
- **THEN** the command executes under bash (login invocation) rather than plain `/bin/sh`

#### Scenario: Capability fallback still executes

- **WHEN** the resolution chain reaches its tail (no pwsh/powershell/git-bash on Windows; no bash on POSIX)
- **THEN** the check still executes via cmd.exe (`/c`) or `/bin/sh` respectively, and no error is raised solely because a preferred interpreter was absent

#### Scenario: Host-configured shell wins

- **WHEN** the host exposes a configured shell option visible in the merged config
- **THEN** the verification check resolves to that shell in preference to the platform defaults

#### Scenario: The host exposes no initial merged shell setting

- **WHEN** the public plugin interface does not expose the initial merged host shell setting
- **THEN** the platform selection chain remains the verification interpreter contract; the plugin does not claim equivalence with a potentially configured native shell, infer an initial setting from another session's shell event, or independently merge host configuration
