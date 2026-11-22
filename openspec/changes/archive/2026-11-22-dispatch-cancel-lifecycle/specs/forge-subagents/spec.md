## ADDED Requirements

### Requirement: User-facing dispatch cancellation

The plugin `SHALL` expose a cancellation lever for in-flight async
dispatches: invoked without arguments it `SHALL` list every in-flight
dispatch with its task id, target agent, child session id, and age; invoked
with a task id it `SHALL` cancel that dispatch; invoked with `all` it
`SHALL` cancel every in-flight dispatch. Cancellation `SHALL` abort the
child session through the existing abort engine, settle the registry row as
`aborted`, record the cancellation in the ledger, and deliver a wake
disclosing it. A cancelled dispatch `SHALL NOT` be retried by any resilience
path.

#### Scenario: list in-flight dispatches

- **WHEN** the cancel lever is invoked with no arguments while dispatches
  are in flight
- **THEN** each in-flight dispatch is listed with task id, agent, child
  session id, and age
- **AND** no dispatch is cancelled by a bare listing

#### Scenario: cancel one dispatch

- **WHEN** the cancel lever is invoked with an in-flight task id
- **THEN** the child session is aborted and reaches an idle/terminal state
- **AND** the registry row settles as `aborted` and the ledger records the
  cancellation
- **AND** the owner session receives a wake disclosing the cancellation

#### Scenario: cancelled dispatch never retries

- **WHEN** a dispatch is cancelled by the user lever
- **THEN** no resilience path (retry, stale reap, adoption) respawns or
  resumes it

### Requirement: Parent-interrupt disclosure

WHEN the parent session's turn is interrupted while async dispatches are in
flight, the plugin `SHALL` surface the in-flight dispatch list with
cancellation guidance in the interruption path. The default posture is
disclose-only: an interrupt `SHALL NOT` silently cancel running children.

#### Scenario: ESC with children in flight

- **WHEN** the user interrupts the parent session's turn while dispatches
  are in flight
- **THEN** the in-flight dispatch list with cancellation guidance is
  surfaced to the session
- **AND** the children remain running unless explicitly cancelled

### Requirement: Orphan-child disclosure

WHEN a child session produced by the dispatch layer is observed streaming
while its registry row is dead or missing (e.g. an adoption gap), the plugin
`SHALL` surface the orphan with adopt/cancel guidance instead of letting it
run invisibly.

#### Scenario: orphaned streaming child is surfaced

- **WHEN** a streaming child session has no live registry row
- **THEN** the orphan is disclosed with its task id and child session id
- **AND** the disclosure offers the adopt and cancel paths
