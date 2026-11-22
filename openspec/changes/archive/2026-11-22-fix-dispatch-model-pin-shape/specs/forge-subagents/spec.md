## MODIFIED Requirements

### Requirement: Agent-bound child creation with pre-spawn validation

On v2 hosts the dispatch layer `SHALL` pass the target agent id (and the
pinned model when the roster defines one) in the child session-create call,
mirroring the host's own subagent creation contract. The create-time model
record `SHALL` carry the bare model id in its `id` field (`{providerID,
modelID, id: <modelID>}`): the host stores `id` verbatim in the session
model record and composes the runner select key as `providerID + "/" + id`,
so a provider-qualified `id` produces a tripled key and fails the child at
drain with `ModelUnavailableError`. Before spawning, the layer `SHALL`
validate that the target agent resolves in the live roster (pool resolution
or materialized native roster); a non-resolving agent `SHALL` be refused
with a disclosure naming the agent and the roster source, and `SHALL NOT`
degrade to a default-agent child. After creation, the layer `SHALL` read
back the created session and assert the bound agent matches the request; a
mismatch or unknown-agent result `SHALL` fail the dispatch loud (error
class + journal entry) rather than leave a silently-unbound child running.

#### Scenario: agent binding honored at create

- **WHEN** a dispatch targets a roster agent that resolves in the live
  roster on a v2 host
- **THEN** the child session is created with that agent bound (and the
  pinned model when defined), and the read-back assertion passes

#### Scenario: non-resolving agent is refused, not degraded

- **WHEN** a dispatch targets an agent that does not resolve in the live
  roster
- **THEN** the dispatch is refused with a disclosure naming the agent and
  the roster source
- **AND** no child session is created as a default agent

#### Scenario: read-back mismatch fails loud

- **WHEN** the created child's bound agent does not match the requested
  agent
- **THEN** the dispatch fails with a loud binding-lost error and a journal
  entry, and no prompt is sent to the mismatched child

#### Scenario: pinned model record carries the bare model id

- **WHEN** a dispatch resolves a roster pin to a model identity
  (providerID, modelID) and builds the child session-create body
- **THEN** the body's model record is `{providerID, modelID, id: <modelID>}`
  with `id` equal to the bare model id, never the provider-qualified key

#### Scenario: runner composes a clean key from the stored record

- **WHEN** a child session is created from the pinned model record and the
  host runner resolves its select key
- **THEN** the composed key is `providerID + "/" + modelID` (two segments),
  not a tripled key, regardless of the provider being known to the host
  catalog
