# goal-harness Delta — add-crew-execution-mode-gate

## MODIFIED Requirements

### Requirement: Autonomous continuation under budget

While the session's goal is active, the plugin SHALL listen for `session.idle` and, after a short debounce and a re-check that the session is still idle, send a compact continuation prompt through the host client containing the goal brief (statement, success criteria, outstanding verification items, remaining budget) and directives (work the criteria, `goal_check` when you believe they hold, `goal_complete` at the gate, `goal_pause` with a blocker summary if stuck; when the work calls for parallel decomposition, own the crew layer — register crews with `crew_begin {execution: "waves"}` in a single call, dispatch `forge-*` waves, and re-shard via `crew_close {abandon}` plus a fresh registration when the decomposition proves wrong — the goal contract's arming authorization covers this orchestration autonomy). Each continuation SHALL increment `turns_used`. The loop SHALL enforce two budgets — continuation turns and wall-clock minutes since arming — with defaults and hard ceilings; budget exhaustion SHALL auto-pause the goal with the matching stop reason and send one wrap-up continuation directing a handoff summary, never silently keep looping. Consecutive continuation delivery failures SHALL be counted and after a small threshold SHALL auto-pause with a transport stop reason.

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
