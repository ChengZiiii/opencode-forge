## MODIFIED Requirements

### Requirement: User-facing dispatch cancellation

The plugin `SHALL` expose a session-scoped stop lever for in-flight async dispatches: the stop route `SHALL` cancel every in-flight dispatch owned by the invoking session — and only those; dispatches owned by other sessions `SHALL` never be touched by another session's stop. Invoked for a listing, the lever `SHALL` list every in-flight dispatch on the host with its task id, target agent, child session id, owner session, and age (host-wide visibility, no session scoping on the listing). Invoked with an explicit task id, the lever `SHALL` cancel that dispatch — the explicit-id escape hatch, which MAY target another session's dispatch by explicit intent. No host-wide cancel verb `SHALL` exist: no single lever call cancels every dispatch on the host. Cancellation `SHALL` abort the child session through the existing abort engine, settle the registry row as `aborted`, record the cancellation in the ledger, and deliver a wake disclosing it. A cancelled dispatch `SHALL NOT` be retried by any resilience path.

#### Scenario: list in-flight dispatches

- **WHEN** the cancel lever is invoked for a listing while dispatches are in flight
- **THEN** each in-flight dispatch is listed with task id, agent, child session id, owner session, and age
- **AND** no dispatch is cancelled by a bare listing

#### Scenario: cancel one dispatch

- **WHEN** the cancel lever is invoked with an in-flight task id
- **THEN** the child session is aborted and reaches an idle/terminal state
- **AND** the registry row settles as `aborted` and the ledger records the cancellation
- **AND** the owner session receives a wake disclosing the cancellation

#### Scenario: cancelled dispatch never retries

- **WHEN** a dispatch is cancelled by the user lever
- **THEN** no resilience path (retry, stale reap, adoption) respawns or resumes it

#### Scenario: stop scopes to the invoking session

- **WHEN** session A owns two in-flight dispatches, session B owns one, and the stop lever fires in session A
- **THEN** both of A's dispatches are cancelled with honest aborted wakes and B's dispatch is untouched — it keeps running and delivers its completion wake at true terminal

#### Scenario: No host-wide cancel verb

- **WHEN** the lever is asked to cancel `all` dispatches in one call
- **THEN** the request is refused as an unknown route with guidance to the session-scoped stop and the per-id escape hatch

### Requirement: Parent-interrupt disclosure

WHEN the parent session's turn is interrupted while async dispatches are in flight, the plugin `SHALL` surface the in-flight dispatch list with cancellation guidance in the interruption path — naming the session-scoped stop route and the per-id cancel escape hatch. The default posture is disclose-only: an interrupt `SHALL NOT` silently cancel running children.

#### Scenario: ESC with children in flight

- **WHEN** the user interrupts the parent session's turn while dispatches are in flight
- **THEN** the in-flight dispatch list with cancellation guidance is surfaced to the session
- **AND** the children remain running unless explicitly cancelled
