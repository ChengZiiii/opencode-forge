# spec.md delta — forge-subagents

## MODIFIED Requirements

### Requirement: Dispatch lifecycle (wake, cap, harvest)

The async dispatch lifecycle carries over from async-dispatch unchanged
and now attaches to the `task` surface: `run_in_background: true` SHALL
return a task handle immediately (task id, agent identity, child session
id) and deliver at most ONE completion wake carrying the child's final
assistant message (bounded 2500-character tail) following the
job-supervisor completion-wake discipline (idle-only injection,
at-most-once, delivery window with ledger overflow). The plugin SHALL
cap concurrent running async dispatches per session (default 3) and
refuse beyond the cap with in-flight task ids and guidance. When a
dispatching session ends, its live async dispatches SHALL be aborted and
recorded in the diagnostics ledger. A sync dispatch whose child never
reaches a terminal state within the poll timeout SHALL return an honest
timeout finding naming the child session id (natively inspectable and
abortable) — and SHALL arm the standard completion tracking (dispatch
registry entry + completion poller) for the already-running child before
returning, so exactly one `[forge:dispatch-complete]` wake carries the
child's final report when it eventually completes; the arming bypasses
the async concurrency cap (the cap governs new async dispatch decisions,
not an already-running child), and the timeout finding SHALL disclose
the armed wake. The poll timeout SHALL default to 600000 ms and SHALL be
tunable via the `FORGE_DISPATCH_POLL_TIMEOUT_MS` environment variable.
Terminal inference SHALL be sound against transient readings: a status
fetch failure or a session missing from a fetched status map SHALL be
treated as active (keep polling — never a terminal verdict); a completed
verdict SHALL require the not-active + finished-latest-assistant
condition to hold stable across consecutive poll ticks (resetting when
the session turns busy again), and the finished message SHALL carry a
truthy `finish` and non-empty text parts, otherwise the poller SHALL
keep polling (such a child ends as the honest timeout, covered by the
armed wake); the async wake path shares the poller and inherits the same
soundness.
The plan-draft interop is unchanged: during an active draft, a dispatch
to an effective-readonly forge target passes as a reconnaissance
dispatch in either mode, and write targets are refused by the same
write-class deny as before, in either mode.

#### Scenario: Async handle and single completion wake

- **WHEN** the model dispatches `task` with `run_in_background: true` and the owning session later idles
- **THEN** the call returns a handle immediately and exactly one wake message with the child's final message is injected into the session

#### Scenario: Concurrency cap

- **WHEN** a session already has the cap of async dispatches in flight and dispatches async again
- **THEN** the call is refused with the in-flight task ids and guidance

#### Scenario: Owner death harvests children

- **WHEN** a session with live async dispatches is deleted
- **THEN** each child session is aborted via the SDK and the orphan is recorded in the diagnostics ledger

#### Scenario: Sync timeout is honest

- **WHEN** a sync dispatch's child does not reach a terminal state within the poll timeout
- **THEN** the tool returns a timeout finding naming the child session id rather than hanging, the finding discloses the armed wake, the child is registered for completion tracking bypassing the async cap, and exactly one `[forge:dispatch-complete]` wake carrying the child's final report arrives when the child later completes

#### Scenario: Transient status failure never terminates

- **WHEN** a status fetch fails (or the session is missing from a fetched status map) while the child has a finished assistant message
- **THEN** the poller keeps polling (treated as active) and does not declare completion or error on that observation

#### Scenario: Receipt-only messages are not final reports

- **WHEN** the child's latest assistant message is a finished acknowledgement but the session turns busy again (still working) within the stability window
- **THEN** the stability requirement resets and the poller keeps polling; a completed verdict requires the condition to hold stable across consecutive ticks with a truthy finish and non-empty text parts on the latest assistant message

#### Scenario: Draft interop unchanged

- **WHEN** the dispatching session has an active draft plan
- **THEN** an effective-readonly forge target passes in either mode and write targets are refused in either mode — identical outcomes to the pre-shadow gates
