# dispatch-stream-loss-honesty — Specs

## ADDED Requirements

### Requirement: Dispatch outcome honesty on result-stream loss

The dispatch layer `SHALL` classify every dispatch outcome as exactly
one of `completed`, `failed`, or `stream-lost/unknown`. A result stream
that breaks before a final report arrives `SHALL` classify as
`stream-lost/unknown` and `SHALL NOT` produce a terminal verdict:
no exit-1 death certificate, no "no reportable final message" obituary.
The surfaced message `SHALL` state that the result stream was lost and
that the child state is unknown (possibly still running).

#### Scenario: Result stream breaks mid-dispatch

- WHEN the child session's result stream breaks (e.g. network
  `Connection reset`) before a final report arrives
- THEN the dispatch outcome is `stream-lost/unknown`
- AND the surfaced message states "result stream lost" and that the
  child state is UNKNOWN (possibly still running)
- AND no exit-1 / death / terminal obituary wording is produced

### Requirement: Ledger completeness across outcome classes

The dispatch layer `SHALL` write a ledger entry for every dispatch
outcome class, including `stream-lost/unknown`, carrying the
last-observed activity timestamp.

#### Scenario: Ledger entry on stream loss

- WHEN a dispatch's result stream breaks before a final report
- THEN the job ledger records a `stream-lost/unknown` entry carrying
  the last-observed activity timestamp
- AND `forge_jobs list` surfaces the dispatch as
  `stream-lost/unknown`

### Requirement: Report-file delivery contract

The dispatch prompt template `SHALL` include a standing report-file
delivery instruction naming the caller-provided report path
(`reports/<task>-report.md` convention), so a worker's final report
survives the primary's view loss.

#### Scenario: Worker report survives view loss

- WHEN a dispatched worker completes its work after the primary's
  result stream was lost
- THEN the worker's final report is available at the agreed report
  path in the workspace
- AND the primary can resolve the dispatch outcome by reading that
  file without re-dispatching
