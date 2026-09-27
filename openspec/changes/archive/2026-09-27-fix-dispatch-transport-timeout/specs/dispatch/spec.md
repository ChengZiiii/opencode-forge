# dispatch Delta — fix-dispatch-transport-timeout

## MODIFIED Requirements

### Requirement: forge_dispatch tool contract

The plugin SHALL register a `forge_dispatch` tool on the forge agent taking `{prompt, agent, depth?, background?}` (`agent` names a dispatch agent from `forge.json`; `depth` defaults to the agent's first depths entry and must be a member of that agent's set). The tool SHALL create a child session on the host instance via the plugin input's bundled client, attach the materialized agent via the message body's `agent` field and the pinned model via the body's `model` field, poll for completion with a per-dispatch deadline (`dispatch.timeoutMs`, default 600000, max 600000), and return an honest report: `{agent, requested:{agent,depth}, actual:{model,depth}, sessionID, durationMs, tokens{...}, costUsd|null, text, depthTranslation}` where `depthTranslation` discloses `canonical → native` (or "verbatim"). Concurrent dispatches beyond `dispatch.maxConcurrent` (default 4) SHALL be refused with a retry hint. When `agent["forge"].disable` is set the tool SHALL not be registered.

The turn-synchronous message POST SHALL be transport-recovery safe: when the POST rejects at the transport level (fetch abort or network failure — anything that is not an HTTP error response) and a child session exists, the engine SHALL NOT fail the dispatch; it SHALL ledger a `transport-interrupted` event (carrying the child sessionID, dispatchId when background, and elapsed time) and fall through to the normal completion polling under the same per-dispatch deadline. The engine SHALL NOT re-POST the message during recovery (the prompt may already have been delivered — re-sending could duplicate work). If the child completes within the deadline, the dispatch reports normally (completed); if the deadline expires first, the timeout semantics above apply; if the message was never delivered (child has no assistant messages), polling degrades to the same honest timeout rather than an empty-response error.

#### Scenario: A successful dispatch reports actuals honestly

- **WHEN** forge_dispatch runs agent=research depth=low and the child session completes
- **THEN** the result names the pinned model, the actual depth with its `canonical → native` disclosure (`depthTranslation`), real token counts, a self-computed cost, and the worker's concluding text

#### Scenario: Timeout reports partial state

- **WHEN** a child session does not finish within the deadline
- **THEN** the tool returns a timeout report with the sessionID, elapsed time, and any partial transcript pointer; the session is left for the host to reclaim

#### Scenario: Concurrency cap refuses excess dispatches

- **WHEN** four dispatches are in flight and a fifth arrives
- **THEN** the fifth is refused with the current in-flight count and a retry hint

#### Scenario: Transport interruption of the turn POST recovers via polling

- **WHEN** the turn-synchronous message POST rejects with a transport-level error (e.g. a runtime fetch timeout or connection reset) 281s into a dispatch whose child session is still running host-side
- **THEN** the dispatch does not fail: a `transport-interrupted` ledger event is recorded with the child sessionID and elapsed time, completion polling continues under the same deadline, and when the child finishes the dispatch reports `completed` with the full honest result (tokens, cost, worker text)

#### Scenario: Undelivered message degrades to an honest timeout

- **WHEN** the turn POST fails at the transport level before the host delivered the message (the child session never produces assistant messages)
- **THEN** recovery polling never fabricates completion or an empty-response error; the dispatch ends in the deadline `timeout` state naming the child session

#### Scenario: HTTP error responses are not recovered

- **WHEN** the turn POST returns an HTTP error response (non-2xx) or a dispatch API call rejects with a structured host error
- **THEN** the existing error semantics stand (no recovery polling is started for API refusals)

### Requirement: Background dispatch mode

`forge_dispatch` SHALL accept `background: true`: resolution happens eagerly at submit time (set-membership and pin errors return synchronously with nothing spawned), the child session is created, and the tool returns immediately with `{dispatchId, agent, requested, resolved, queuedAt}`. The concurrency cap (`dispatch.maxConcurrent`, default 4) SHALL be one global slot pool shared by sync and background dispatches; over-cap submits are refused with the in-flight count and a retry hint. Every background dispatch carries the same per-dispatch deadline as sync mode, and every terminal state (completed / timeout / killed / error) SHALL be both appended to the ledger and delivered to the parent session — a background dispatch SHALL never be silently dropped. Terminal reports and registry results SHALL carry the child sessionID whenever a child session was created, and a timeout terminal report SHALL state that the child session is left running host-side with its transcript queryable. A transport-level interruption of the turn POST SHALL NOT by itself terminate a background dispatch while recovery polling (same deadline) can still deliver the child's result.

#### Scenario: Background submit resolves eagerly and returns a handle

- **WHEN** `forge_dispatch` is called with `background: true` and a valid agent/depth
- **THEN** the call returns promptly with the dispatchId, the resolved identity, and queued state — no result text yet, and resolution errors (if any) would have returned synchronously before any session was created

#### Scenario: Shared cap refuses over-cap background submits

- **WHEN** four dispatches (any mix of sync and background) are in flight and a fifth background submit arrives
- **THEN** it is refused with the current in-flight count and a retry hint, identical to the sync refusal

#### Scenario: Transport interruption does not false-terminal a background dispatch

- **WHEN** a background dispatch's turn POST dies at the transport layer while its child session keeps running host-side
- **THEN** the dispatch stays non-terminal (no error/timeout is recorded at that moment); if the child completes within the deadline the parent receives the completed brief as usual, and only a genuine deadline expiry produces the timeout brief

#### Scenario: Terminal results carry the child sessionID

- **WHEN** a background dispatch reaches any terminal state after its child session was created
- **THEN** the registry result delivered in the brief (and visible in `forge_dispatch_list`) carries the child sessionID, not an empty string

### Requirement: Draft-plan interop and dispatch ledger

While the session has an active draft plan, `forge_dispatch` SHALL refuse execution (same protection class as the plan-harness write ban — spawning workers during planning is denied), with a message pointing to `plan_approve` or discard. Dispatch events (resolved identity, depth, outcome, token/cost summary, timeouts, lost-on-exit) SHALL append to a bounded ledger under `<tmp>/opencode-forge/dispatch/` (capped rotation like the existing ledgers). Terminal and outcome ledger events SHALL be self-describing: they SHALL carry the dispatchId and parentSessionID when known, the child sessionID when one exists, and the elapsed durationMs. Child sessions are host memory objects: on host exit they vanish, and in-flight dispatches SHALL be recorded as `lost-on-exit` (no survive semantics).

#### Scenario: Dispatch refused during plan draft

- **WHEN** the session has an active draft plan and the model calls forge_dispatch
- **THEN** the call is refused with a pointer to plan_approve or /plan discard

#### Scenario: In-flight dispatches die with the host, honestly

- **WHEN** the opencode host exits while dispatches are in flight
- **THEN** no orphan processes remain (sessions are memory objects) and the ledger records the in-flight entries as lost-on-exit

#### Scenario: Terminal ledger rows are self-describing

- **WHEN** a background dispatch terminates in error or timeout after its child session was created
- **THEN** the terminal ledger row carries its dispatchId, parentSessionID, child sessionID, and durationMs — the row can be attributed without cross-referencing other rows
