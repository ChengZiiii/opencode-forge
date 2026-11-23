## MODIFIED Requirements

### Requirement: Dispatch lifecycle (wake, cap, harvest)

The async dispatch lifecycle carries over from async-dispatch unchanged
and now attaches to the `task` surface: `run_in_background: true` SHALL
return a task handle immediately (task id, agent identity, child session
id) and deliver at most ONE completion wake carrying the child's final
assistant message (bounded 2500-character tail) following the
job-supervisor completion-wake discipline (idle-only injection,
at-most-once, delivery window with ledger overflow). Interim
`[forge:dispatch-progress]` notices are informational, delivered
idle-only, and never consume that budget. The plugin SHALL
cap concurrent running async dispatches per session (default 3); beyond
the cap, an async dispatch SHALL enter a per-session FIFO queue (bounded,
default 10) instead of failing — the call SHALL return a queued handle
immediately (metadata marking it queued until it spawns) and the child
SHALL be spawned when a slot frees — any terminal transition of that
session's dispatches frees a slot, a kill settle included, so a cancelled
dispatch releases its slot to the queued head — with a
`[forge:dispatch-progress]` notice announcing the queued wish's start; the
checks re-evaluated at spawn time
are the target roster, the draft gate, and the crew belt (a tightening
between call and spawn fails the wish as an honest error wake, never
silently); beyond the queue bound the call SHALL be refused with the
in-flight and queued task ids and guidance. When a
dispatching session ends, its live async dispatches SHALL be aborted and
recorded in the diagnostics ledger, and its queued wishes SHALL be
flushed without spawning — the flush SHALL terminalize the journal
records of those queued wishes. A sync dispatch whose child never
reaches a terminal state within the poll timeout SHALL return an honest
timeout finding naming the child session id (natively inspectable and
abortable) — and SHALL arm the standard completion tracking (dispatch
registry entry + completion poller) for the already-running child before
returning, so exactly one `[forge:dispatch-complete]` wake carries the
child's final report when it eventually completes; the arming bypasses
the async concurrency cap (the cap governs new async dispatch decisions,
not an already-running child), and the timeout finding SHALL disclose
the armed wake. The poll timeout SHALL default to 600000 ms and SHALL
be tunable via the `FORGE_DISPATCH_POLL_TIMEOUT_MS` environment
variable; it scopes the SYNC WAIT only. The completion tracker SHALL
NOT terminate on any wall-clock deadline measured from dispatch:
while the child is running (active in the status map) the poller SHALL
keep polling indefinitely — the sole clock-based termination of a running
child is the activity-stale reap specified under "Dispatch resilience" — and past
the notification interval (default
600000 ms, tunable via `FORGE_DISPATCH_NOTIFY_INTERVAL_MS`) it SHALL
emit non-terminal `[forge:dispatch-progress]` notices — informational
only, delivered idle-only, never consuming the completion wake budget;
the single `[forge:dispatch-complete]` wake carrying the final report
SHALL arrive at true terminal regardless of duration or how close
completion falls to an interval boundary. A child that stays
continuously not-active (missing from the map) across a full
notification interval while its latest finished assistant message
lacks a truthy `finish` or non-empty text SHALL terminate honestly as
a no-reportable-final-message finding naming the child session id; any
busy reading resets that streak, so a running child is never
terminated by it; a registry kill (an owner-session end, the user cancel
lever, or the explicit kill of a dispatch row through the job lever)
stops the watch at its next kill check — at a slice top, before a
consumed signal, after every poll, and once more before the exit settle
— and the kill verdict outranks any verdict the watch observed: the
dispatch is journaled and surfaced as aborted, never as `error` or
`completed`, and never feeds the provider breaker as a failure. A
plugin-instance dispose is not a registry-kill trigger (specified under
"Dispatch rows survive plugin-instance disposal"). The sync-armed poller
shares the tracker and inherits never-die tracking. Terminal
inference SHALL be sound against unreadable readings: a status
fetch failure SHALL be treated as active (keep polling — never a
terminal verdict on a signal that could not be read); a session MISSING
from a successfully fetched status map is the host's idle signal (the
map lists only currently-active sessions — a completed session is
removed) and counts as not-active; a completed
verdict SHALL require the not-active + finished-latest-assistant
condition to hold stable across consecutive poll ticks (resetting when
the session turns busy again — which also self-heals transient flakes
where a running child blinks out of the map for a tick or two), and the
finished message SHALL carry a
truthy `finish` and non-empty text parts, otherwise the poller SHALL
keep polling; the async wake path shares the poller and inherits the same
soundness.
The plan-draft interop is unchanged: during an active draft, a dispatch
to an effective-readonly forge target passes as a reconnaissance
dispatch in either mode, and write targets are refused by the same
write-class deny as before, in either mode. Activity-stale reaping,
error-classified retry, and restart recovery are specified under
"Dispatch resilience".

#### Scenario: Async handle and single completion wake

- **WHEN** the model dispatches `task` with `run_in_background: true` and the owning session later idles
- **THEN** the call returns a handle immediately and exactly one wake message with the child's final message is injected into the session (interim `[forge:dispatch-progress]` notices may precede it; they are informational and never replace it)

#### Scenario: Long child keeps tracking past the notification interval

- **WHEN** an async child runs past the notification interval and reaches a textful terminal state later
- **THEN** non-terminal `[forge:dispatch-progress]` notices arrive while it runs, and the single `[forge:dispatch-complete]` wake carrying the final report still arrives when it completes — however long it runs or how close completion falls to an interval boundary

#### Scenario: Textless idle child terminates honestly

- **WHEN** a child stays continuously not-active (missing from the status map) across a full notification interval while its latest finished assistant message lacks a truthy `finish` or non-empty text
- **THEN** the tracker terminates with an honest no-reportable-final-message finding naming the child session id, and a busy reading within the window resets the streak so a running child is never terminated

#### Scenario: Concurrency cap

- **WHEN** a session already has the cap of async dispatches running and dispatches async again within the queue bound
- **THEN** the call returns a queued handle immediately, the wish spawns automatically when a slot frees with a progress notice announcing its start (roster, draft gate, and crew belt re-checked at spawn), and only a wish beyond the queue bound is refused with the in-flight and queued task ids and guidance

#### Scenario: Owner death harvests children

- **WHEN** a session with live async dispatches is deleted
- **THEN** each running child session is aborted via the SDK, the orphans are recorded in the diagnostics ledger, the session's queued wishes are flushed without spawning, and the queued wishes' journal records are terminalized

#### Scenario: Sync timeout is honest

- **WHEN** a sync dispatch's child does not reach a terminal state within the poll timeout
- **THEN** the tool returns a timeout finding naming the child session id rather than hanging, the finding discloses the armed wake, the child is registered for completion tracking bypassing the async cap, and exactly one `[forge:dispatch-complete]` wake carrying the child's final report arrives when the child later completes

#### Scenario: Status fetch failure never terminates

- **WHEN** a status fetch fails (unreadable) while the child has a finished assistant message
- **THEN** the poller treats the reading as active, keeps polling, and does not declare completion or error on that observation

#### Scenario: Missing-from-map is the idle signal, flakes self-heal

- **WHEN** a session is missing from a successfully fetched status map (the host lists only currently-active sessions, so missing = not-active) — either because it completed or because a running child transiently blinked out during a server flake
- **THEN** the reading counts toward the stability run; if the child re-appears busy within the window the run resets (a flake can never reach depth on a stale receipt), and a genuinely completed child reaches the depth stably and completes

#### Scenario: Receipt-only messages are not final reports

- **WHEN** the child's latest assistant message is a finished acknowledgement but the session turns busy again (still working) within the stability window
- **THEN** the stability requirement resets and the poller keeps polling; a completed verdict requires the condition to hold stable across consecutive ticks with a truthy finish and non-empty text parts on the latest assistant message

#### Scenario: Draft interop unchanged

- **WHEN** the dispatching session has an active draft plan
- **THEN** an effective-readonly forge target passes in either mode and write targets are refused in either mode — identical outcomes to the pre-shadow gates

#### Scenario: A kill outranks the verdict the watch observed

- **WHEN** a dispatch row is killed (owner-session end, the cancel lever, or an explicit kill) and the abort makes the child surface afterwards as a host `session.execution.failed` verdict or as a finished-looking transcript that the watch reads
- **THEN** the dispatch is journaled and surfaced as aborted with the killer's reason — never as an error that feeds the dispatch breaker, never as a completion — and the slot it held is pumped to the session's queued head like any other terminal transition

## ADDED Requirements

### Requirement: Dispatch rows survive plugin-instance disposal

Plugin `dispose` SHALL NOT be a registry-kill trigger for dispatch rows. On any host — single- or multi-context — a plugin dispose that is not the host-process exit SHALL leave every in-flight dispatch row untouched: no kill, no child abort, no journal terminalization; the settle loop keeps watching and the completion wake arrives at true terminal. This supersedes any earlier implication that dispose is a dispatch registry-kill trigger; the remaining legitimate registry-kill triggers are owner-session end and the user cancel lever. A real host-process exit needs no dispatch kill either: dispatch children are server-side sessions unaffected by the plugin process, and their cross-restart continuity is the dispatch journal with restart recovery (probe → re-arm, completed-wake, or honest error per record state).

#### Scenario: Dispose in another context leaves the dispatch running

- **WHEN** a dispatch is in flight and a plugin context (not the whole host process) is disposed
- **THEN** the dispatch row remains running, its journal record stays non-terminal, and the final wake is delivered on completion

#### Scenario: Host-process exit relies on the journal, not on kills

- **WHEN** the host process exits while dispatches are in flight
- **THEN** no dispatch journal record is terminalized by the exit itself, and on next host boot restart recovery resolves each live child (re-arm the running, deliver the finished, honestly terminalize the gone)

### Requirement: Honest aborted outcome surfacing

When a dispatch row is legitimately killed (owner-session end or the user cancel lever), the surfaced wake and the journal terminal record SHALL name the outcome as aborted with its reason — never as a completed "finished" report. A killed dispatch's wake SHALL NOT present an empty tail as a final report (no "(no output)" fabrication); the wake SHALL state that the dispatch was aborted, carry the journal reason, and — when the child could not be confirmed idle after the abort attempt — disclose that the child session may still be running (the orphan-disclosure path). The reason SHALL be ONE sentence on both sides — the sentence the kill stamped on the row at kill time — and each lever SHALL have its own sentence: an owner-session end, the user cancel lever (the per-id cancel and the session-scoped stop), and the explicit kill of a dispatch row through the job lever; the owner-death sentence SHALL NOT name any other trigger (a plugin dispose is not one). A host execution error carried as a nested object SHALL be rendered readable (its message, name, error, reason, or data — else a clipped JSON rendering) wherever a journal reason or a wake cites it — never the string `[object Object]`; an error object that cannot be rendered (circular, BigInt-bearing, or throwing when read) SHALL yield to the caller's own honest fallback and SHALL NOT throw into the signal path. A kill that lands while a retry respawns the child SHALL be honored — the fresh child SHALL NOT be left running unwatched: when the kill landed during its creation it is never prompted (aborted as cleanup; the row keeps naming the attempt's real child), and when the kill landed during the prompt send the row is rebound to it and it is aborted. An abort that has not returned within a bounded moment counts as unconfirmed too — a hung host call is not a clean abort — and a wake rendered while the abort is still in flight SHALL wait for that same bounded moment, so the wake discloses exactly what the journal discloses whichever of the two is written first.

#### Scenario: Killed dispatch wakes as aborted, not finished

- **WHEN** an in-flight dispatch row is killed by owner-session end or the cancel lever
- **THEN** the wake names the dispatch as aborted with its reason, no final-report text is fabricated from the empty tail, and the journal terminal record carries the same reason

#### Scenario: Each lever names itself on both sides

- **WHEN** a dispatch row is killed by the explicit job-lever kill, by the cancel lever, or by an owner-session end
- **THEN** the journal terminal reason and the wake carry that lever's sentence verbatim and no other lever's — an explicit kill is never reported as an owner death or as a plugin dispose

#### Scenario: Nested error objects render readable

- **WHEN** a host terminal event carries its error as a nested object with no string `message` and the dispatch journals it
- **THEN** the journal reason names the error's own text (or a clipped JSON rendering of the object) and never contains `[object Object]`

#### Scenario: Unrenderable error objects never throw

- **WHEN** the error object cannot be serialized (circular, BigInt-bearing) or throws when read (a throwing getter, a hostile Proxy)
- **THEN** the renderer returns no detail, the citing journal reason and wake fall back to their own honest wording, and nothing is thrown into the signal path

#### Scenario: Kill lands in the respawn window

- **WHEN** a dispatch row is killed while its retry child is being created, or while the retry prompt is being sent to it
- **THEN** the dispatch settles aborted with the killer's sentence, the fresh child is aborted (never prompted when the kill preceded the prompt), and no unwatched child keeps running

#### Scenario: Unconfirmed abort is disclosed

- **WHEN** a kill path's abort attempt fails or cannot be verified (e.g. an abort-less session client)
- **THEN** the journal and the wake disclose that the abort could not be confirmed and the child may still be running

#### Scenario: An abort that never returns is unconfirmed

- **WHEN** a kill path issues its abort and the host call has not returned within the bounded wait
- **THEN** the journal terminal reason and the wake both disclose that the abort call had not returned and the child may still be running — never a bare aborted outcome

#### Scenario: An already-idle owner hears what the journal says

- **WHEN** the owning session is already idle when its dispatch row is killed, so the wake is delivered at kill time, and the abort then fails
- **THEN** the wake waits for the abort verdict and discloses the failed abort with the same wording the journal terminal reason carries

### Requirement: Abort effectiveness on the v2 session client

The session client used for dispatch SHALL provide a real abort on every host generation, or the absence SHALL be disclosed rather than swallowed. On v2 hosts the child-session abort SHALL be wired through an actually available surface (the SDK session abort or the host's HTTP session-abort endpoint) instead of silently no-opping on a missing method; kill paths SHALL NOT discard the abort result silently — a failed or unverifiable abort SHALL be journaled and surfaced per the honest-aborted-outcome requirement.

#### Scenario: v2 kill path aborts the child for real

- **WHEN** a dispatch row is killed on a v2 host and the wired abort surface is available
- **THEN** the abort is issued through that surface and the child session stops running

#### Scenario: Abort-less client is disclosed, not swallowed

- **WHEN** the session client cannot abort at all (no abort surface on this host generation)
- **THEN** the kill path records the unverifiable abort in the journal and the wake instead of silently treating the row as cleanly killed
