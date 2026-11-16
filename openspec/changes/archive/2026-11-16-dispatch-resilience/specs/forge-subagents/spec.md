# spec.md delta — forge-subagents

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
SHALL be spawned when a slot frees, a `[forge:dispatch-progress]` notice
announcing the queued wish's start; the checks re-evaluated at spawn time
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
terminated by it; the registry kill (owner death, dispose) stops the
watch at a slice boundary as before. The sync-armed poller shares the
tracker and inherits never-die tracking. Terminal
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

## ADDED Requirements

### Requirement: Dispatch resilience (stale reap, retry, restart recovery)

A running dispatch child that produces no activity for
`FORGE_DISPATCH_STALE_MS` (default 2700000 ms = 45 min) past a 60-second
minimum-runtime floor SHALL be reaped. The activity anchor is the child's
`session.get` `time.updated` timestamp (part-level updates — a child
streaming one long generation still refreshes it); when no message has
ever arrived, the anchor is the dispatch start time. Before acting, the
reaper SHALL re-read `session.get`: a refreshed timestamp resets the
timer (a child that is actually producing can never be reaped), and the
same call doubles as the existence probe (status unresolved → skip this
sweep, session missing → finalize). The reap SHALL abort the child via
the SDK and deliver exactly one honest terminal wake (`stale: aborted
after N min without activity`); if the abort call fails and the session
still exists, the reaper SHALL skip this sweep and re-arm — finalization
happens only when existence proves the session gone.
`FORGE_DISPATCH_STALE_MODE` SHALL support `kill` (default) and `observe`
(one progress notice per threshold crossing, no kill). A child that
terminates in a RETRYABLE error — the transient transport/5xx/overload/
rate-limit error patterns — SHALL be respawned automatically: same agent,
original prompt plus a resume preamble instructing the new child to
inspect the current workspace state before acting and continue the work
rather than redo it; `FORGE_DISPATCH_MAX_ATTEMPTS` SHALL bound total
attempts (default 2), with a fixed 10 s backoff between attempts; the
retry inherits the dying child's registry slot (no queue re-entry) and
re-applies the dispatch-time policies (draft/crew mode-keyed denies);
each attempt is surfaced as a `[forge:dispatch-progress]` notice and the
final wake SHALL disclose the number of attempts; exactly one terminal
wake still. Deterministic terminal error classes — the provider-
configuration, auth, model-not-supported, and contract error patterns —
SHALL never be retried; unknown error classes SHALL never be retried;
stale kills, user aborts, and textless-idle floor findings SHALL never
be retried. Every dispatch record SHALL be appended to a bounded
workspace journal (`.opencode/forge/dispatch-log.jsonl`, bounded at
`FORGE_DISPATCH_JOURNAL_MAX` records, default 200) on every state
transition (dispatched, queued, started, retry-pending, terminal); a
corrupt journal line SHALL be tolerated (skipped) without aborting
recovery; rotation SHALL compact terminal records only and SHALL never
remove a non-terminal record; the original prompt SHALL be retained
while a record is non-terminal (the journal is the only prompt source
after a restart) and SHALL be redacted when the record terminates. On plugin
init, non-terminal records SHALL be recovered per state, scoped to the
launch-anchor workspace at init and lazily per workspace on its first
session: a `running` record's child still alive → registry row and
poller re-armed; finished while the host was down → final message
fetched and the completion wake delivered; child gone → honest terminal.
A `queued` record → re-entered into the queue when the owner session
still resolves, otherwise terminated honestly and ledgered. A
`retry-pending` record → the retry decision resumed (respawn when
attempts remain, otherwise honest terminal). A host restart SHALL NOT
orphan a running child, silently discard a queued wish, or lose a
finished child's report. This journal is the dispatch-session analogue
of job-supervisor's persisted survival registry (which recovers
surviving job processes); they are separate ledgers and are not
cross-read.

#### Scenario: Stale reap after prolonged inactivity

- **WHEN** a running child's `session.get` `time.updated` has not advanced for the stale threshold past the runtime floor, the pre-kill re-read confirms no refresh, and stale mode is `kill`
- **THEN** the child is aborted via the SDK and exactly one terminal wake delivers the honest stale finding naming the child session id

#### Scenario: Stale observe mode only notifies

- **WHEN** stale mode is `observe` and the stale threshold is crossed
- **THEN** one progress notice reports the inactivity (one per crossing, not per tick) and the child is NOT aborted

#### Scenario: Active children are never reaped

- **WHEN** the stale threshold is crossed but the pre-kill re-read finds a refreshed `time.updated`
- **THEN** the timer resets and the child keeps running

#### Scenario: Runtime floor blocks early reap

- **WHEN** a child is younger than the 60-second minimum runtime, however silent
- **THEN** no reap is considered for it

#### Scenario: Existence probe decides the ambiguous reading

- **WHEN** the status map is unhelpful at reap consideration
- **THEN** the `session.get` probe decides: unresolved status skips the sweep, a missing session finalizes the record

#### Scenario: Failed abort skips the sweep

- **WHEN** the reaper's abort call fails and the session still exists
- **THEN** the sweep is skipped and re-armed — the record is only finalized when existence proves the session gone

#### Scenario: No-message children anchor at start

- **WHEN** a child has produced no message at all and stays silent past the stale threshold measured from dispatch start
- **THEN** the reap machinery applies identically (floor, re-read, abort, honest wake)

#### Scenario: Retryable error respawns with a resume preamble

- **WHEN** a child terminates in a transient transport/5xx/overload/rate-limit-class error and attempts remain
- **THEN** a fresh child of the same agent spawns after the 10 s backoff with the original prompt plus the inspect-then-continue preamble, a progress notice discloses the retry, the retry keeps the dying child's registry slot, and the final wake arrives once, when the last attempt settles, disclosing the attempt count

#### Scenario: Deterministic terminal classes are never retried

- **WHEN** a child terminates in a provider-configuration, auth, model-not-supported, or contract error pattern
- **THEN** no respawn happens and the honest terminal wake is delivered as-is

#### Scenario: Stale kills, aborts, and floor findings are never retried

- **WHEN** a child terminates via a stale reap, a user abort, or a textless-idle floor finding
- **THEN** no respawn happens and the honest terminal wake is delivered as-is

#### Scenario: Rotation never loses a non-terminal record

- **WHEN** the journal reaches its rotation bound while a dispatch is still running
- **THEN** only terminal records are compacted and the running dispatch's record survives

#### Scenario: Every state transition is journaled

- **WHEN** a dispatch moves between dispatched / queued / started / retry-pending / terminal states
- **THEN** a journal record is appended for the transition

#### Scenario: Restart re-arms a live child

- **WHEN** the plugin initializes and the journal holds a running dispatch whose child session is still alive
- **THEN** the registry row and poller are re-armed and the completion wake still arrives when the child finishes

#### Scenario: Restart delivers a missed report

- **WHEN** the plugin initializes and the journal holds a running dispatch whose child finished while the host was down
- **THEN** the final message is fetched and the completion wake is delivered to the owner session

#### Scenario: Restart terminalizes a gone child

- **WHEN** the plugin initializes and the journal holds a running dispatch whose child session no longer exists
- **THEN** the record terminates with an honest finding instead of resurrecting a phantom

#### Scenario: Restart re-queues a queued wish

- **WHEN** the plugin initializes and the journal holds a queued record whose owner session still resolves
- **THEN** the wish re-enters the queue and spawns when a slot frees; when the owner no longer resolves, the record terminates honestly and is ledgered

#### Scenario: Restart resumes a retry-pending attempt

- **WHEN** the plugin initializes and the journal holds a retry-pending record
- **THEN** the retry decision resumes — the child respawns when attempts remain, otherwise the record terminates honestly
