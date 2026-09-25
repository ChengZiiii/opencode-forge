# goal-harness Specification

## Purpose
Give forge an execution layer that is orthogonal to every workflow discipline: a goal is a persistent, self-contained objective the agent autonomously drives to **host-verified** completion — continuation on session idle under a hard budget, verification items (shell commands and file contracts) actually executed by the plugin on the host (fail-closed), structured self-attestation per success criterion, and every transition into or out of autonomy gated by user confirmation. Goals read no state from and hold no binding to the plan harness or any spec workflow; the only intersection is safety (a live draft write-ban pauses the loop). The objective itself always remains the semantic requirement — verification items add proof obligations, they never replace the outcome.

## Requirements

### Requirement: Goal file persistence layout

Goal files SHALL be created under the workspace's `.opencode/goal/` directory, named `YYYY-MM-DD-<slug>.md` with the slug derived from the goal statement (kebab-case, length-truncated); same-day slug collisions SHALL get a numeric suffix. The frontmatter SHALL contain at least `status` (queued / active / paused / completed / abandoned), `created`, `updated`, `revision` (starting at 1), `session` (owning session ID, empty while queued), budget fields (`max_turns`, `turns_used`, `max_minutes`), and `stop_reason` (set whenever paused). All goal-file mutations SHALL be atomic (write to a temp file, then rename over the target) so a crash mid-write never leaves a half-written goal. Worktree resolution SHALL reuse the effective-worktree fallback (degenerate/global-project worktrees fall back to the launch directory). Terminal and queued goal files SHALL remain under `.opencode/goal/` (uninstalling the plugin SHALL NOT delete them).

#### Scenario: A compliant goal file is generated

- **WHEN** `goal_write` successfully persists an armed goal with the statement "make the test suite green"
- **THEN** a file like `2026-09-25-make-test-suite-green.md` appears under `.opencode/goal/`, with frontmatter containing `status: active`, `revision: 1`, the owning session ID, and budget fields

#### Scenario: Crash mid-write leaves the previous state intact

- **WHEN** the plugin is killed while updating a goal file
- **THEN** the file on disk is either the old complete version or the new complete version, never a partial hybrid

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

`goal_check` SHALL execute the goal's verification items (or a selected subset) with the same host execution semantics as the completion gate, appending one dated, revision-stamped entry per run to the Check Log (item, exit code or file-contract result, truncated output). Recorded results are advisory feedback for the model and carry no gating authority. Each continuation turn SHALL append a Turn Ledger entry (turn number, whether any write-class tool / `goal_check` ran) so per-turn activity is auditable and batch-completion without real work is visible at the gate.

#### Scenario: Model verifies progress mid-flight

- **WHEN** the model believes the criteria may now hold and calls `goal_check`
- **THEN** the items actually run on the host and a dated, revision-stamped entry appears in the Check Log

#### Scenario: Turn activity is recorded

- **WHEN** a continuation turn ends
- **THEN** the Turn Ledger gains an entry stating whether that turn contained writes or checks

### Requirement: Autonomous continuation under budget

While the session's goal is active, the plugin SHALL listen for `session.idle` and, after a short debounce and a re-check that the session is still idle, send a compact continuation prompt through the host client containing the goal brief (statement, success criteria, outstanding verification items, remaining budget) and directives (work the criteria, `goal_check` when you believe they hold, `goal_complete` at the gate, `goal_pause` with a blocker summary if stuck). Each continuation SHALL increment `turns_used`. The loop SHALL enforce two budgets — continuation turns and wall-clock minutes since arming — with defaults and hard ceilings; budget exhaustion SHALL auto-pause the goal with the matching stop reason and send one wrap-up continuation directing a handoff summary, never silently keep looping. Consecutive continuation delivery failures SHALL be counted and after a small threshold SHALL auto-pause with a transport stop reason.

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

### Requirement: No-progress auto-pause

The engine SHALL track qualifying activity per continuation turn only (ordinary assistant replies outside the goal loop never count): any write-class tool execution, or `goal_check`, observed for the owning session during that turn. After a small number of consecutive goal-continuation turns with zero qualifying activity the goal SHALL auto-pause with a no-progress stop reason and a handoff directive.

#### Scenario: Spinning without effect pauses the loop

- **WHEN** two consecutive goal continuations produce no writes or checks
- **THEN** the goal auto-pauses with stop reason `no-progress` instead of burning budget

### Requirement: Pause, resume, discard, and explicit reactivation

`goal_pause` SHALL be available at any time without a confirmation gate (pausing is always safe) and SHALL record a stop reason; the engine SHALL stop continuation immediately while paused. Re-arming SHALL require explicit intent routed through the gated `goal_resume`: short, unambiguous continuation phrases from the user (e.g. "continue", "resume") SHALL be routed by the model to `goal_resume`, whose ask gate protects the transition; arbitrary chat SHALL NOT reactivate a paused goal. `goal_resume` MAY accept a budget top-up (bounded by hard ceilings) and SHALL rebind ownership to the resuming session. `goal_discard` SHALL abandon the goal under an ask-level user confirmation (abandoning the user's objective is the user's decision).

#### Scenario: Model self-reports a blocker

- **WHEN** the model hits a blocker and calls `goal_pause` with a reason
- **THEN** the loop stops with the blocker recorded; the user decides to resume or discard

#### Scenario: "Continue" routes through the gate

- **WHEN** the goal is paused and the user types "continue"
- **THEN** the model calls `goal_resume`, the confirmation dialog appears, and only on allow does continuation re-arm

#### Scenario: Ordinary chat does not reactivate

- **WHEN** the goal is paused and the user discusses an unrelated topic
- **THEN** no continuation is sent and the goal stays paused

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
