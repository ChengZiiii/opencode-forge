## REMOVED Requirements

### Requirement: User-facing dispatch cancellation

**Reason**: the stop lever's scope grew from in-flight dispatches only to in-flight and queued wishes, which retires the scenario "stop names the queued wishes it did not cancel". A MODIFIED block replaces the whole requirement and may not drop a scenario, so the requirement is re-added whole under a name that states its scope.

**Migration**: nothing for callers — the command surface (`/forge stop`) is unchanged. The replacement is the ADDED requirement "User-facing dispatch cancellation (in-flight and queued)" below; every scenario of the old block except the retired one is carried over unchanged.

## ADDED Requirements

### Requirement: User-facing dispatch cancellation (in-flight and queued)

The plugin `SHALL` expose a session-scoped stop lever for in-flight async dispatches: the stop route `SHALL` cancel every in-flight dispatch owned by the invoking session — and only those; dispatches owned by other sessions `SHALL` never be touched by another session's stop. Invoked for a listing, the lever `SHALL` list every in-flight dispatch on the host with its task id, target agent, child session id, owner session, and age (host-wide visibility, no session scoping on the listing). Invoked with an explicit task id, the lever `SHALL` cancel that dispatch — the explicit-id escape hatch, which MAY target another session's dispatch by explicit intent. No host-wide cancel verb `SHALL` exist: no single lever call cancels every dispatch on the host. Cancellation `SHALL` abort the child session through the existing abort engine, settle the registry row as `aborted`, record the cancellation in the ledger, and deliver a wake disclosing it. A cancelled dispatch `SHALL NOT` be retried by any resilience path. Each cancellation receipt (the per-id cancel, and every row of a stop) `SHALL` report the post-abort idle confirmation honestly as one of three outcomes: the child is confirmed idle through the host's active-session view; the child did not reach idle within the assertion window (it may have resisted); or the view could not be read, so idle is unconfirmed — a receipt `SHALL` never claim a confirmed idle without a readable view, and no view read `SHALL` hold a receipt past the assertion window. The stop route `SHALL` also cancel every queued wish of the invoking session — and only those: the session's queued wishes `SHALL` be removed from its queue BEFORE any in-flight dispatch is cancelled, so no slot a cancelled dispatch frees is pumped and no cancelled wish ever spawns. A cancelled queued wish `SHALL` terminalize its journal record as `aborted` with a sentence naming the stop lever and stating that nothing was spawned; it has no child and no registry row, so it `SHALL` deliver no wake and `SHALL NOT` be re-entered by restart recovery. The stop receipt `SHALL` name the cancelled queued wishes separately from the cancelled in-flight dispatches; a stop in a session with queued wishes and nothing in flight `SHALL` cancel the queued wishes and say that nothing was in flight; only a session with neither `SHALL` report nothing to stop. A queued wish the queue pump is already spawning when the stop fires `SHALL` be cancelled as well and `SHALL` never be left running: while its child session is still being created the wish `SHALL` not be prompted — its journal record is terminal `aborted` with a sentence naming the stop lever and stating that the wish was never prompted, and the receipt counts it with the cancelled queued wishes; once its prompt was sent the wish `SHALL` be cancelled like any in-flight dispatch of that stop. If the stop fires before the pump has created a child session for the wish, `SHALL` none be created. The lever `SHALL` wait a bounded time for such a wish to land; a wish still being started when that wait ends `SHALL` be cancelled the moment it lands, and the receipt `SHALL` say that it was still starting. Cancels of one session's dispatches `SHALL` run one at a time, whether the stop lever or the queue pump issues them.

#### Scenario: list in-flight dispatches

- **WHEN** the cancel lever is invoked for a listing while dispatches are in flight
- **THEN** each in-flight dispatch is listed with task id, agent, child session id, owner session, and age
- **AND** no dispatch is cancelled by a bare listing

#### Scenario: cancel one dispatch

- **WHEN** the cancel lever is invoked with an in-flight task id
- **THEN** the child session is aborted and the receipt reports the idle-confirmation outcome (confirmed idle, resisted, or unreadable view)
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

#### Scenario: An unreadable idle view is disclosed, never claimed

- **WHEN** the active-session view cannot be read (or a read hangs) while a cancellation's idle confirmation is running
- **THEN** the receipt returns within the assertion window, reports that idle could not be confirmed, and makes no confirmed-idle or resisted claim

#### Scenario: stop cancels the queued wishes and nothing spawns into the freed slots

- **WHEN** a session has queued wishes beyond the concurrency cap and the stop lever fires in that session
- **THEN** the session's queued wishes are removed from its queue first, the in-flight dispatches are cancelled, and no wish spawns into the slots the cancelled dispatches freed
- **AND** each cancelled queued wish's journal record is terminal `aborted` with the stop-lever sentence stating nothing was spawned, and no wake is delivered for it
- **AND** the receipt names the cancelled in-flight dispatches and the cancelled queued wishes separately

#### Scenario: stop with queued wishes only

- **WHEN** nothing is in flight for a session but it owns queued wishes, and the stop lever fires in that session
- **THEN** the queued wishes are cancelled and the receipt says that nothing was in flight and names the cancelled wishes

#### Scenario: a cancelled queued wish stays cancelled

- **WHEN** the host restarts after a stop cancelled queued wishes
- **THEN** none of those wishes re-enters the queue or spawns

#### Scenario: a wish the queue pump is already spawning when stop lands

- **WHEN** the queue pump has dequeued one of a session's queued wishes and is creating its child session, and the stop lever fires in that session
- **THEN** that child session is never prompted: the wish's journal record is terminal `aborted` with the never-prompted sentence, the empty child session is aborted as cleanup, the receipt counts the wish with the cancelled queued wishes, and no wake is delivered for it

#### Scenario: stop lands before the spawning wish has a child session

- **WHEN** the queue pump has dequeued one of a session's queued wishes, the stop lever fires in that session before the pump has created a child session for it, and the pump reaches its spawn step afterwards
- **THEN** no child session is created for that wish, its journal record is terminal `aborted` with the never-prompted sentence, and the receipt counts it with the cancelled queued wishes

#### Scenario: a wish whose prompt was already sent when stop lands

- **WHEN** the queue pump has dequeued one of a session's queued wishes and its prompt is being sent while the stop lever fires in that session
- **THEN** the lever waits for the wish to land and cancels it like any in-flight dispatch of that stop: the child is aborted once, the journal record is terminal `aborted` with the lever sentence, and the receipt lists it among the stopped in-flight dispatches

#### Scenario: the lever stops waiting while a wish is still being started

- **WHEN** a wish is still being started when the lever's bounded wait ends
- **THEN** the receipt says that a wish was still starting, the lever's own cancels and the late wish's cancellation never run at the same time, and the late wish is cancelled the moment it lands with the lever sentence and an aborted wake
