# harden-dispatch-resilience — forge-subagents delta

## ADDED Requirements

### Requirement: Active-textful completion override

When a dispatch child's status view keeps reporting the session active but
the child's final assistant text has already arrived and remained stable,
the poller `SHALL` verdict the dispatch COMPLETE from the message-stream
evidence alone — it `SHALL NOT` wait for the status view to flip, `SHALL
NOT` run the dispatch to a timeout, and the terminal wake `SHALL` disclose
that completion was established from the message stream while the status
view lagged. The override `SHALL` use the same stability window (three
consecutive poll ticks with finish conditions holding and non-empty final
text) as the ordinary not-active completion path, `SHALL` cover sync and
async dispatches alike, and `SHALL NOT` fire when the final text has not
arrived (a stuck-active child with no text keeps its existing honest
uncertainty handling — the override never invents completion).

#### Scenario: Stuck-active status with the final report already out

- **WHEN** a child's status map reports active on every poll tick while
  the child's final assistant text is readable and has held the finish
  conditions for the stability window
- **THEN** the poller verdicts COMPLETE, the terminal wake names the
  message-stream override as the establishment path, and no timeout path
  runs

#### Scenario: Stuck-active with no text stays honest

- **WHEN** a child's status map reports active and no final assistant text
  has arrived
- **THEN** the override does not fire and the existing textless-idle and
  stale handling governs — no completion is invented

### Requirement: Nested-dispatch tool guard on non-forge child sessions

Child-session creation `SHALL` accept a task-deny option that carries the
task-tool deny permission in the create body (the channel QUESTION_DENY
already uses, proven effective by a sandbox probe before the guard ships).
The dispatch path `SHALL` set this option when — and only when — the
target is a non-forge host agent whose resolved provider family is
anthropic: such children `SHALL NOT` receive a dispatchable task tool,
preventing the nested-delegation 400 that family returns. Forge-*
targets `SHALL` remain governed solely by their structural `task: deny`
(this guard adds nothing to them), and non-forge targets on other
provider families `SHALL` be untouched by this guard. The guard lives at
the single child-creation funnel so every spawn site inherits it.

#### Scenario: Non-forge anthropic target denies the task tool in the child

- **WHEN** a dispatch targets a non-forge host agent whose provider family
  resolves to anthropic
- **THEN** the child session is created with the task-tool deny riding the
  create body, and the child cannot dispatch further subagents

#### Scenario: Forge family and other families are untouched

- **WHEN** a dispatch targets a forge-* agent, or a non-forge agent on a
  non-anthropic family
- **THEN** the create body carries no task deny from this guard (forge's
  structural deny still applies to forge-* targets through the materialized
  permissions)

### Requirement: Provider-dimension dispatch gate and circuit breaker

The dispatch path `SHALL` maintain in-process counters of live children
keyed by provider and by provider/model, fed at the terminal-recording
seam, and `SHALL` enforce optional per-provider and per-model concurrency
limits. A circuit breaker `SHALL` track consecutive failed terminals per
provider: at the configured threshold the breaker opens and refuses NEW
dispatches on that provider; after the configured cooldown it half-opens
(one dispatch allowed; success closes, failure re-opens). Both mechanisms
`SHALL` be configured through an optional `dispatch` node in forge.json
(`providerConcurrency` map, `modelConcurrency` map, `circuitBreaker`
`{consecutiveFailures, cooldownMs}`), cascade-merged across config layers
with field-level fail-soft (a bad value drops with a warn finding and
never throws); an absent node `SHALL` mean no limits (today's behavior).
Queued dispatches `SHALL` re-check the gate at dequeue time. Every
refusal `SHALL` be an honest message naming the mechanism, the counted
dimension and its current value, and the recovery condition (a live child
  finishing for the concurrency gate; the cooldown elapsing for the
breaker); breaker refusals `SHALL` be classified as the plugin's own
throttle, not as provider errors, and `SHALL NOT` trigger the provider
  retry path.

#### Scenario: Provider concurrency gate refuses and admits

- **WHEN** the live count for a provider is at its configured limit and a
  new dispatch on that provider arrives
- **THEN** the dispatch is refused with the gate named, the counted
  dimension shown, and the recovery condition stated; when a live child on
  that provider terminates, the next dispatch is admitted

#### Scenario: Breaker opens, half-opens, and closes

- **WHEN** a provider accumulates the configured number of consecutive
  failed terminals
- **THEN** new dispatches on that provider are refused naming the breaker
  and cooldown; after the cooldown the next dispatch is admitted
  (half-open) and on its success the breaker closes (a failure re-opens it
  with the cooldown re-armed)

#### Scenario: Absent or malformed dispatch node is fail-soft

- **WHEN** forge.json carries no `dispatch` node, or one with malformed
  values
- **THEN** dispatches are unlimited (or the malformed fields are ignored
  with a warn finding) and no dispatch is ever refused due to a parse
  failure
