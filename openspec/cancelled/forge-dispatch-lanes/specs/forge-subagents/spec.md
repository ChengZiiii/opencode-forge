# forge-dispatch-lanes — forge-subagents delta

## ADDED Requirements

### Requirement: Optional dispatch lanes (model chains) on agent definitions

forge.json `SHALL` support an optional `lanes` node of named model
chains (`models` array of provider/model identities, optional
`distribution` of `sequential` or `round_robin` defaulting to
`sequential`, optional lane-level `thoughtLevel`), parsed with the
established field-level fail-soft semantics and cascade-merged across
config layers; an absent node `SHALL` mean today's behavior. An agent
entry `SHALL` carry `model` XOR `lane` (both present → error finding
and the entry is skipped), and `thoughtLevel` `SHALL` be valid with
either model source (the atomic-pair rule generalized). A dispatch to a
lane-backed agent `SHALL` resolve the spawn's model from the chain at
spawn time — sequential resolves the first healthy member, round_robin
the next in rotation among healthy members — where healthy means not
refused by the provider-dimension gate or an open circuit breaker, and
each skip `SHALL` be journaled. A failed terminal of a lane spawn
`SHALL` demote to the next chain member within the existing respawn
machinery; an exhausted chain `SHALL` produce an honest terminal failure
naming the lane and the last member attempted. The materialized
description of a lane-backed agent `SHALL` disclose the lane name, the
chain's model identities, and that the model resolves per spawn; the
dispatch journal `SHALL` record the resolved model identity per hop.
Lane and entry edits `SHALL` hot-apply through the existing mtime cache
chain (next spawn sees the new chain, no restart), and the published
JSON Schema and its drift-mirror test `SHALL` cover the `lanes` node,
the entry `lane` field, and the generalized pair rule.

#### Scenario: Lane-backed agent resolves per spawn with disclosure

- **WHEN** an agent entry carries a valid `lane` and a dispatch spawns it
- **THEN** the spawn's model is the chain's resolved member per the
  distribution strategy, the dispatch journal records that identity,
  and the agent's materialized description names the lane, the chain,
  and the per-spawn resolution

#### Scenario: Failed hop demotes; exhausted chain fails honestly

- **WHEN** a lane spawn ends in a failed terminal and the chain holds a
  next member
- **THEN** the respawn uses the next member; when the chain is exhausted
  the dispatch ends in an honest failure naming the lane and the last
  member attempted

#### Scenario: Gate and breaker steer member selection

- **WHEN** a lane member's provider has an open circuit breaker or a
  full concurrency gate at resolution time
- **THEN** that member is skipped in favor of a healthy one (sequential:
  next in chain; round_robin: next in rotation), the skip is journaled,
  and a fully blocked chain produces an honest refusal naming the lane
  and the blocking mechanism

#### Scenario: Fail-soft config semantics and hot apply

- **WHEN** a lane definition is malformed, an entry references an
  unknown lane, an entry carries both `model` and `lane`, or the lanes
  node changes on disk
- **THEN** field-level findings govern (bad def dropped with warn,
  unknown-ref and conflict entries skipped with error findings, nothing
  throws) and the next spawn after an on-disk edit sees the new chain
  without a restart

#### Scenario: Atomic pair generalizes to lanes

- **WHEN** an entry carries `thoughtLevel` alongside a `lane` (and no
  `model`), or carries `thoughtLevel` with neither model source
- **THEN** the lane pairing is accepted (depth translation applies to
  lane spawns), while the orphan `thoughtLevel` keeps today's
  atomic-pair finding
