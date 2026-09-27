# crew-harness Specification (delta)

## ADDED Requirements

### Requirement: /crew command discipline

The plugin SHALL register a `/crew <objective>` command that enters crew orchestration discipline in the current session (single-subject: no agent switching). The discipline SHALL mandate: decompose the objective into waves of subtasks, each carrying a prompt, a tier/profile, a depth, and an acceptance-evidence statement; execute waves via background `forge_dispatch` paced on completion briefs (the next batch launches only as capacity frees — never flooding past the concurrency cap); verify each subtask's evidence from the dispatch result text; retry a failed subtask at most once (adjusted prompt or depth); finish with a completion report covering every subtask. An active plan draft SHALL refuse `/crew` with a pointer to `plan_approve` or `/plan discard`; a session with an active crew SHALL refuse a second concurrent `/crew`; argument-less `/crew` SHALL print usage. Crew state is in-memory and session-bound: on host restart it dies honestly (the dispatch ledger survives) and a new `/crew` starts fresh — there is no cross-session crew resume in this capability.

#### Scenario: /crew decomposes and paces waves on briefs

- **WHEN** the user runs `/crew` with an objective and the model follows the discipline
- **THEN** subtasks are dispatched via background `forge_dispatch`, and later waves launch only as completion briefs free capacity

#### Scenario: Draft plan blocks /crew

- **WHEN** the session has an active draft plan and `/crew` is invoked
- **THEN** the command refuses with a pointer to `plan_approve` or `/plan discard`

#### Scenario: One crew per session

- **WHEN** a crew is already active in the session and `/crew` is invoked again
- **THEN** the command refuses, naming the active crew

#### Scenario: Restart mid-crew is an honest death

- **WHEN** the host restarts while a crew run is active
- **THEN** crew state is gone after restart, the dispatch ledger retains the history, and a new `/crew` starts fresh

### Requirement: crew_close completion gate

The plugin SHALL register a `crew_close` tool pinned to ask-level confirmation (never auto-allowed, not exempted by user allow config). The tool SHALL cross-check the submitted report against the dispatch ledger: it SHALL refuse when any subtask lacks a verdict or an evidence reference, or when a dispatch in the ledger for this crew has no corresponding verdict in the report (nothing silently dropped), or when a subtask failed both its attempt and its one retry yet is not marked FAIL. On success it SHALL append the crew summary (per-subtask verdict, dispatch ledger references, aggregate tokens and cost) to the dispatch ledger and end the crew.

#### Scenario: Closing with full evidence

- **WHEN** every subtask has a verdict with an evidence reference matching the ledger, and the user confirms the ask dialog
- **THEN** `crew_close` appends the summary to the ledger and the crew ends

#### Scenario: Incomplete crew cannot close

- **WHEN** subtasks are missing verdicts, or a dispatched subtask has no verdict in the report
- **THEN** `crew_close` errors naming the gaps and the crew continues

#### Scenario: Bounded retry then honest FAIL

- **WHEN** a subtask fails its attempt and its single retry
- **THEN** the final report carries it as FAIL with both failure reports visible, and `crew_close` permits closing with the FAIL on record (refusal is for missing or dropped results, not for honest failures)
