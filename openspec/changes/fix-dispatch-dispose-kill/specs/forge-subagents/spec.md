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

When a dispatch row is legitimately killed (owner-session end or the user cancel lever), the surfaced wake and the journal terminal record SHALL name the outcome as aborted with its reason — never as a completed "finished" report. A killed dispatch's wake SHALL NOT present an empty tail as a final report (no "(no output)" fabrication); the wake SHALL state that the dispatch was aborted, carry the journal reason, and — when the child could not be confirmed idle after the abort attempt — disclose that the child session may still be running (the orphan-disclosure path).

#### Scenario: Killed dispatch wakes as aborted, not finished

- **WHEN** an in-flight dispatch row is killed by owner-session end or the cancel lever
- **THEN** the wake names the dispatch as aborted with its reason, no final-report text is fabricated from the empty tail, and the journal terminal record carries the same reason

#### Scenario: Unconfirmed abort is disclosed

- **WHEN** a kill path's abort attempt fails or cannot be verified (e.g. an abort-less session client)
- **THEN** the journal and the wake disclose that the abort could not be confirmed and the child may still be running

### Requirement: Abort effectiveness on the v2 session client

The session client used for dispatch SHALL provide a real abort on every host generation, or the absence SHALL be disclosed rather than swallowed. On v2 hosts the child-session abort SHALL be wired through an actually available surface (the SDK session abort or the host's HTTP session-abort endpoint) instead of silently no-opping on a missing method; kill paths SHALL NOT discard the abort result silently — a failed or unverifiable abort SHALL be journaled and surfaced per the honest-aborted-outcome requirement.

#### Scenario: v2 kill path aborts the child for real

- **WHEN** a dispatch row is killed on a v2 host and the wired abort surface is available
- **THEN** the abort is issued through that surface and the child session stops running

#### Scenario: Abort-less client is disclosed, not swallowed

- **WHEN** the session client cannot abort at all (no abort surface on this host generation)
- **THEN** the kill path records the unverifiable abort in the journal and the wake instead of silently treating the row as cleanly killed
