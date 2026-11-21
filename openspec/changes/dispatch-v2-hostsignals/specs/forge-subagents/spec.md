## ADDED Requirements

### Requirement: Agent-bound child creation with pre-spawn validation

On v2 hosts the dispatch layer `SHALL` pass the target agent id (and the
pinned model when the roster defines one) in the child session-create call,
mirroring the host's own subagent creation contract. Before spawning, the
layer `SHALL` validate that the target agent resolves in the live roster
(pool resolution or materialized native roster); a non-resolving agent
`SHALL` be refused with a disclosure naming the agent and the roster source,
and `SHALL NOT` degrade to a default-agent child. After creation, the layer
`SHALL` read back the created session and assert the bound agent matches the
request; a mismatch or unknown-agent result `SHALL` fail the dispatch loud
(error class + journal entry) rather than leave a silently-unbound child
running.

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

### Requirement: Host-signal completion detection

On v2 hosts the dispatch layer `SHALL` detect child completion primarily via
host-owned signals: durable `session.execution.{succeeded, failed,
interrupted}` events matched on the child session id, and/or a one-shot wait
on the child session. The layer `SHALL` run a reconcile pass over in-flight
children at a cadence of at least 10 seconds that reads each child's actual
state as the backstop for missed or lost events, and `SHALL` re-subscribe
when its event stream is lost. The synchronous status/messages REST view
`SHALL NOT` be the sole terminal signal for a dispatch.

#### Scenario: durable event settles a dispatch

- **WHEN** a child session's execution emits a terminal durable event
- **THEN** the dispatch settles from that signal without any status polling

#### Scenario: reconcile pass catches a missed event

- **WHEN** a terminal event for an in-flight child is missed (e.g. the
  event stream dropped between publish and subscribe)
- **THEN** the reconcile pass observes the child's settled state and the
  dispatch settles from that observation

#### Scenario: event stream loss triggers re-subscription

- **WHEN** the plugin's event subscription is lost (e.g. plugin reload,
  connection drop)
- **THEN** the layer re-subscribes and the reconcile pass covers children
  whose terminal events fired during the gap

### Requirement: Persisted dispatch registry with post-reload adoption

The dispatch layer `SHALL` persist in-flight dispatch rows (task id, child
session id, target agent, prompt anchor, timestamps) outside plugin-instance
memory, and after a plugin reload or host restart `SHALL` adopt persisted
in-flight rows: re-arm completion watching for each child and resume the
normal outcome path. Restart recovery `SHALL` fall back to walking the
parent session relationship when a stored row is unreadable. An adopted
dispatch `SHALL NOT` be re-dispatched while its child is still observable.

#### Scenario: reload mid-dispatch adopts the child

- **WHEN** the plugin is hot-reloaded while a dispatch is in flight
- **THEN** the reloaded generation adopts the persisted row and continues
  watching the same child session
- **AND** the final outcome is delivered exactly once, without a second
  child being spawned for the same task

#### Scenario: restart recovery falls back to parent walk

- **WHEN** a persisted row is unreadable after a restart but the child
  session records the parent relationship
- **THEN** the layer recovers the dispatch from the parent walk instead of
  losing it

## MODIFIED Requirements

### Requirement: Dispatch outcome honesty on result-stream loss

The dispatch layer `SHALL` classify every dispatch outcome as exactly one of
`completed`, `failed`, or `stream-lost/unknown`. A result stream that breaks
before a final report arrives `SHALL` classify as `stream-lost/unknown` and
`SHALL NOT` produce a terminal verdict: no exit-1 death certificate, no "no
reportable final message" obituary. The surfaced message `SHALL` state that
the result stream was lost and that the child state is unknown (possibly
still running). On hosts where host-signal completion detection is active,
the `stream-lost/unknown` verdict `SHALL` be declared only after the
reconcile pass also fails to observe the child: execution events that keep
flowing for an in-flight child `SHALL NOT` be overruled by an unread
synchronous view, and a child that host signals show to be alive `SHALL NOT`
be declared lost.

#### Scenario: Result stream breaks mid-dispatch

- WHEN the child session's result stream breaks (e.g. network
  `Connection reset`) before a final report arrives
- THEN the dispatch outcome is `stream-lost/unknown`
- AND the surfaced message states "result stream lost" and that the
  child state is UNKNOWN (possibly still running)
- AND no exit-1 / death / terminal obituary wording is produced

#### Scenario: healthy child is never declared lost

- WHEN the synchronous status/messages view is unreadable while the child's
  execution events continue to arrive
- THEN the dispatch stays in flight (no verdict is declared)
- AND the outcome settles from the host signals or the reconcile pass as
  usual

#### Scenario: verdict only after signals and reconcile both fail

- WHEN neither the host signals nor the reconcile pass can observe an
  in-flight child for the sustained streak
- THEN the outcome is `stream-lost/unknown` with the last-observed activity
  timestamp
- AND the report-file delivery contract remains the ground-truth recovery
  channel
