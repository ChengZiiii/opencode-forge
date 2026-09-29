# crew-harness Specification

## Purpose
The /crew orchestration layer: decompose an objective into evidence-checked subtasks, dispatch them as concurrency-paced background waves, retry each failure at most once, and gate the close on per-subtask PASS/FAIL verdicts cross-checked against the dispatch ledger.

## Requirements

### Requirement: /crew command discipline

The plugin SHALL register a `/crew <objective>` command that enters crew orchestration discipline in the current session (single-subject: no agent switching). The discipline SHALL mandate: after any needed reconnaissance, decompose the objective into subtasks and REGISTER the plan via `crew_begin {objective, subtasks}` — each subtask carrying a title and, optionally, the intended `forge-*` agent and an acceptance-evidence statement. Registration enters a **PENDING** crew and the session SHALL stop and present the execution-mode choice — begin supervised waves now, convert the objective into an autonomous goal contract, or stand by — ending the turn; execution SHALL start only after the user's decision arms the crew via a follow-up `crew_begin {execution}` call. The registration output SHALL disclose the origin of the dispatchable roster — the forge.json path the host materialized its agent set from (the launch anchor) — and whenever the workspace-mismatch disclosure fires (a session-anchored workspace forge.json carries roles the host cannot dispatch), it SHALL pair that disclosure with the remediation: workspace-layer roles enter the dispatch vocabulary only after a host restart anchored there, and a cross-host universal pool belongs in the true global file. Once armed for waves, execute the plan in waves of parallel native `task` calls (a wave's results return within the calling turn; the next wave launches only after the previous wave's results are in — never flooding); when a subtask calls for a role that no configured agent matches, execute that subtask through a native task call and surface the gap to the user with a suggestion to configure the missing role; verify each subtask's evidence from the task results; retry a failed subtask at most once (adjusted prompt or agent); finish with a completion report covering every declared subtask. The crew discipline is source-agnostic about the macro contract above it — an approved plan artifact, a spec change document, or inline objective text all feed the same discipline, and crew never requires a plan artifact to exist. An active plan draft SHALL refuse `/crew` with a pointer to `plan_approve` or `/plan discard` (mutual-exclusion safety interop, not an ordering dependency); a session with an active crew SHALL refuse a second concurrent `/crew`; argument-less `/crew` SHALL print usage. Crew state is in-memory and session-bound: on host restart it dies honestly and a new `/crew` starts fresh — there is no cross-session crew resume in this capability.

#### Scenario: /crew decomposes and paces waves on briefs

- **WHEN** the user runs `/crew` with an objective and the model follows the discipline
- **THEN** the subtask plan is registered through `crew_begin`, subtasks execute as parallel native `task`-call waves, and a later wave launches only after the previous wave's results have returned in-turn

#### Scenario: Missing role falls back to native with an explicit notice

- **WHEN** a declared subtask needs a role that no configured `forge-*` agent matches
- **THEN** the discipline directs the model to run that subtask through a native task call and to tell the user about the gap, suggesting the missing role be configured

#### Scenario: Registration pauses for the execution-mode decision

- **WHEN** `crew_begin` registers the subtask plan and the roster is confirmed
- **THEN** the session presents the execution-mode choice (supervised waves / goal conversion / standby) and ends the turn — no `task` dispatch happens before the user's decision

#### Scenario: Host pool origin is disclosed

- **WHEN** `crew_begin` reports the registered plan and the roster it may dispatch
- **THEN** the output names the forge.json path the dispatchable set materialized from (the launch anchor), and any workspace-mismatch disclosure carries the remediation lines (restart-from-workspace-anchor; true-global location for cross-host pools)

#### Scenario: Registered plan lands as an inspectable record

- **WHEN** `crew_begin` registers the subtask plan
- **THEN** the declared plan is written to a record file under the session workspace's `.opencode/crew/` directory, arm / convert / abandon / close append to it, and the record never resumes a dead crew — after host restart it is inert history

#### Scenario: Planless crew runs the same discipline

- **WHEN** `/crew` is invoked with the macro contract sourced from a spec change document or inline text instead of a plan artifact
- **THEN** the discipline is identical — no plan dependency exists, and no surface of the crew flow assumes plan precedence

#### Scenario: Draft plan blocks /crew

- **WHEN** the session has an active draft plan and `/crew` is invoked
- **THEN** the command refuses with a pointer to `plan_approve` or `/plan discard`

#### Scenario: One crew per session

- **WHEN** a crew is already active in the session and `/crew` is invoked again
- **THEN** the command refuses, naming the active crew

#### Scenario: Restart mid-crew is an honest death

- **WHEN** the host restarts while a crew run is active
- **THEN** crew state is gone after restart and a new `/crew` starts fresh — no residue, no resume

### Requirement: crew_close completion gate

The plugin SHALL register a `crew_close` tool pinned to ask-level confirmation (never auto-allowed, not exempted by user allow config). The tool SHALL cross-check the submitted report against the crew's registered subtask plan: it SHALL refuse when any declared subtask lacks a verdict or an evidence statement, when the report carries a subtask that was never declared (renegade work — discoveries must be folded into existing verdict notes or the crew restarted, never silently adopted), or when a subtask failed both its attempt and its one retry yet is not marked FAIL. On success it SHALL end the crew and emit the summary (per-subtask verdict and evidence) as the tool's output — with the dispatch ledger removed there is no persistent crew record; the close output and the session transcript are the record. The tool SHALL additionally accept an abandon path: `crew_close {abandon: true, reason}` ends the crew with an abandonment record and NO verdict requirements — the exit for a wrong decomposition (re-shard: abandon, then register a fresh crew) and for cancelling a standby crew; the ask gate applies to abandonment exactly as to completion — except while a live active goal governs the session, where both close paths drop the ask requirement (crew gates are internal to the goal loop; the goal's gates remain the user boundary). A crew ended by abandonment or conversion is over: the record is the tool output, and a new `crew_begin` may follow immediately.

#### Scenario: Closing with full evidence

- **WHEN** every declared subtask has a verdict with an evidence statement and the user confirms the ask dialog
- **THEN** `crew_close` ends the crew and emits the summary as its output

#### Scenario: Incomplete crew cannot close

- **WHEN** a declared subtask is missing a verdict or an evidence statement
- **THEN** `crew_close` errors naming the gaps and the crew continues

#### Scenario: Renegade subtask is refused

- **WHEN** the report contains a subtask title that was not part of the plan registered at `crew_begin`
- **THEN** `crew_close` refuses, naming the undeclared subtask and pointing at the fold-or-restart rule

#### Scenario: Bounded retry then honest FAIL

- **WHEN** a subtask fails its attempt and its single retry
- **THEN** the final report carries it as FAIL with both failure reports visible, and `crew_close` permits closing with the FAIL on record (refusal is for missing, dropped, or undeclared results, not for honest failures)

#### Scenario: Abandon path enables re-shard

- **WHEN** the decomposition proves wrong mid-execution (or a pending crew is cancelled) and the user confirms the ask dialog on `crew_close {abandon: true, reason}`
- **THEN** the crew ends with an abandonment record — no verdicts are demanded — and a fresh `crew_begin` may register a corrected plan immediately

### Requirement: Unconfigured crew initialization gate

When `/crew` is invoked and the winning forge.json yields an empty agent set (no file anywhere in the cascade, or a file whose agents all failed validation), the command SHALL refuse entry into crew orchestration (hard gate) and SHALL present initialization guidance stating: the two configuration file paths (project-level first), a copy-paste JSONC agent template embedded in the command's discipline text, and the choice between configuring it themselves or having the session AI do so — where AI-assisted configuration SHALL happen only after the user's explicit go-ahead in that conversation, through the normally-visible write path. The guidance SHALL also state the application timing: newly added agents require a host restart to enter the task vocabulary, while `thoughtLevel` edits apply without restart. The plugin itself SHALL never write or create the file. This invitation surface SHALL exist only inside the unconfigured `/crew` flow — no other plugin surface (tool description, agent prompt, error path) SHALL invite AI-authored configuration.

#### Scenario: Unconfigured /crew refuses with initialization guidance

- **WHEN** `/crew <objective>` is invoked and the effective agent set is empty
- **THEN** entry into orchestration is refused and the response names the two file paths, shows the embedded template, offers the self-configure or AI-assisted options with the consent rule, and states the restart/hot-apply timing

#### Scenario: The configuration invitation lives only in the /crew gate

- **WHEN** any other plugin surface is inspected (tool descriptions, materialized agent prompts, error paths)
- **THEN** no surface invites the session AI to author forge.json — the everyday dispatch path stays configuration-silent

#### Scenario: A configured crew bypasses the gate

- **WHEN** `/crew <objective>` is invoked and at least one agent materialized successfully
- **THEN** the gate does not fire and orchestration discipline proceeds normally

### Requirement: Crew execution-mode gate

The plugin SHALL hold every registered crew in a PENDING state until the user's execution-mode decision arms it, and SHALL enforce the pause mechanically: while the session's crew is PENDING, the `task` tool SHALL be refused by the tool-execute interception belt, with the refusal message presenting the three choices (supervised waves now / convert to a goal contract / stand by). The belt SHALL NOT fire before a crew is registered (reconnaissance dispatches are free) nor after the crew is armed, converted, or ended. Mode transitions SHALL happen through a follow-up `crew_begin` call carrying only `execution`: `waves` flips the crew to executing and lifts the belt; `goal` ends the crew as a conversion record with no verdicts and no extra ask gate — the immediately following `goal_write(arm=true)` confirmation dialog is the user gate for that path — and the conversion output SHALL direct folding the declared subtask plan into the goal contract's criteria and checks; standby is the absence of a call (the crew stays PENDING harmlessly until armed or abandoned). The arm call SHALL refuse when the crew is not PENDING (already armed, converted, or ended). This gate composes with, and never replaces, the goal loop: an active goal's continuation turns may register crews (fresh or after abandonment) and the pending belt applies there equally — re-sharding decisions are user-visible. **Goal-delegated self-orchestration**: while a live active goal governs the session, `crew_begin` MAY carry `execution: "waves"` in the SAME registration call — the crew is born EXECUTING and never pends (the goal contract's arming dialog already authorized autonomous orchestration); without a governing goal, `execution` at registration SHALL be refused with a pointer to the two-step pause; `execution: "goal"` under a governing goal SHALL be refused as meaningless (already governed). While a live active goal governs the session, both `crew_close` paths (report and abandon) drop the ask requirement — the crew's gates are internal machinery under the goal loop, whose own arm / resume / complete gates remain the user boundary.

#### Scenario: Pending crew refuses task dispatch

- **WHEN** a crew is registered PENDING and the model attempts any `task` call
- **THEN** the belt refuses the call with the three-choice message, and no dispatch happens

#### Scenario: Arming for waves lifts the belt

- **WHEN** the user chooses supervised waves and the model calls `crew_begin {execution: "waves"}`
- **THEN** the crew flips to executing, subsequent `task` calls flow, and the wave discipline proceeds

#### Scenario: Goal conversion ends the crew cleanly

- **WHEN** the user chooses goal conversion and the model calls `crew_begin {execution: "goal"}`
- **THEN** the crew ends as a conversion record without verdict demands or an extra ask gate, and the output directs folding the declared subtasks into the upcoming goal contract

#### Scenario: Standby keeps the crew pending harmlessly

- **WHEN** the user chooses standby and no arm call is made
- **THEN** the crew stays PENDING with no belt side effects, and may later be armed or abandoned

#### Scenario: Pre-registration reconnaissance is unimpeded

- **WHEN** the model dispatches `task` calls during reconnaissance before any `crew_begin`
- **THEN** the belt does not fire — the pause guards the registration-to-execution seam only

#### Scenario: One-call arm under a governing goal

- **WHEN** a live active goal governs the session and the model registers `crew_begin {objective, subtasks, execution: "waves"}` in a single call
- **THEN** the crew is born EXECUTING, the pending belt never fires for it, and both `crew_close` paths operate without an ask dialog — the goal's gates are the user boundary

#### Scenario: Execution-at-register refused without a governing goal

- **WHEN** no live active goal governs the session and `crew_begin` carries `execution` at registration
- **THEN** the call is refused with a pointer to the two-step pause — the standalone gate cannot be self-armed by the model
