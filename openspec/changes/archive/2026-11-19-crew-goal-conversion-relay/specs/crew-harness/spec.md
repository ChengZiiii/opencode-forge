# crew-harness — MODIFIED (change crew-goal-conversion-relay)

## MODIFIED Requirements

### Requirement: Crew execution-mode gate

The plugin SHALL hold every registered crew in a PENDING state until the user's execution-mode decision arms it, and SHALL enforce the pause mechanically: while the session's crew is PENDING, the `task` tool SHALL be refused by the tool-execute interception belt, with the refusal message presenting the three choices (supervised waves now / convert to a goal contract / stand by). The belt SHALL NOT fire before a crew is registered (reconnaissance dispatches are free) nor after the crew is armed, converted, or ended. Mode transitions SHALL happen through a follow-up `crew_begin` call carrying only `execution`: `waves` flips the crew to executing and lifts the belt; `goal` ends the crew as a conversion record with no verdicts and no extra ask gate — the immediately following `goal_write(arm=true)` confirmation dialog is the user gate for that path — and the conversion output SHALL direct folding the declared subtask plan into the goal contract's criteria and checks The conversion output SHALL additionally RELAY the crew layer into the goal loop: it SHALL state that the goal engine's continuation turns may re-register this plan as a born-armed crew in ONE call (`crew_begin {objective, subtasks, execution: "waves"}` — no pause mid-loop), SHALL direct preserving the subtask STRUCTURE (titles and their forge-* agent assignments) inside the goal contract's criteria or constraints verbatim enough to survive the fold rather than dissolving them into prose, and SHALL include a ready-to-adapt born-armed registration sketch naming the declared subtasks and their agents — so the model's FIRST post-arming turn (which runs before any idle continuation brief) already knows the crew layer exists.; standby is the absence of a call (the crew stays PENDING harmlessly until armed or abandoned). The arm call SHALL refuse when the crew is not PENDING (already armed, converted, or ended). This gate composes with, and never replaces, the goal loop: an active goal's continuation turns may register crews (fresh or after abandonment) and the pending belt applies there equally — re-sharding decisions are user-visible. **Goal-delegated self-orchestration**: while a live active goal governs the session, `crew_begin` MAY carry `execution: "waves"` in the SAME registration call — the crew is born EXECUTING and never pends (the goal contract's arming dialog already authorized autonomous orchestration); without a governing goal, `execution` at registration SHALL be refused with a pointer to the two-step pause; `execution: "goal"` under a governing goal SHALL be refused as meaningless (already governed). While a live active goal governs the session, both `crew_close` paths (report and abandon) drop the ask requirement — the crew's gates are internal machinery under the goal loop, whose own arm / resume / complete gates remain the user boundary.

#### Scenario: Pending crew refuses task dispatch

- **WHEN** a crew is registered PENDING and the model attempts any `task` call
- **THEN** the belt refuses the call with the three-choice message, and no dispatch happens

#### Scenario: Arming for waves lifts the belt

- **WHEN** the user chooses supervised waves and the model calls `crew_begin {execution: "waves"}`
- **THEN** the crew flips to executing, subsequent `task` calls flow, and the wave discipline proceeds

#### Scenario: Goal conversion ends the crew cleanly

- **WHEN** the user chooses goal conversion and the model calls `crew_begin {execution: "goal"}`
- **THEN** the crew ends as a conversion record without verdict demands or an extra ask gate, and the output directs folding the declared subtasks into the upcoming goal contract

#### Scenario: The conversion output relays the crew layer into the goal loop

- **WHEN** the user chooses goal conversion and the model calls `crew_begin {execution: "goal"}`
- **THEN** the conversion output states the goal loop may re-register the plan born-armed in one call, directs preserving the subtask titles and agent assignments structurally in the goal contract, and includes a ready-to-adapt born-armed registration sketch — the relay reaches the model's first post-arming turn without waiting for an idle continuation brief

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

