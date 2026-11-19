# dispatch-stream-loss-honesty

## Why

During the 2026-11-19 V2 migration session, four dispatched child sessions
were reported dead by the dispatch layer — each with an exit-1 terminal
state, a "no reportable final message" obituary, and ZERO ledger entries —
while every child was actually still alive and completed its work. The
ground truth only surfaced hours later through out-of-band channels:
task-list ticks, git commits, and report files the children wrote to disk.
The root cause: the result poller's SSE stream broke mid-flight (network
`Connection reset`), and the layer treats a broken result stream as
authoritative evidence that the child died. Two independent field
replications (waves ⑦⑧ and ⑨a) confirm this is systematic, not a one-off.
A dispatch layer that files false death certificates and loses the ledger
trail is actively harmful: the primary either re-dispatches duplicate
work or abandons work that is in fact done.

## What Changes

- **Honest uncertainty on stream loss**: when the result stream breaks
  before a final report arrives, the layer reports the event as a
  *view loss* — "result stream lost; child state UNKNOWN (possibly still
  running)" — instead of an exit-1 death certificate. No obituary
  wording, no terminal verdict.
- **Ledger entry on every dispatch outcome class**: stream loss writes a
  ledger entry (today it writes nothing), classified
  `stream-lost/unknown` so `forge_jobs list` and post-mortems see the
  dispatch happened.
- **Report-file delivery becomes the reliability contract**: the
  dispatched prompt template gains a standing instruction — the worker
  MUST write its final report to a caller-provided file path
  (`reports/<task>-report.md` under the workspace) in addition to the
  normal result stream. The poller, on recovery or on a later
  observation, treats the presence (or absence, with mtime) of that file
  as the ground-truth signal for completion.
- **Watchdog semantics unchanged**: an alive-but-silent child is still
  the watchdog's jurisdiction (stall kill after threshold); this change
  only fixes what the layer *claims* when its own view breaks.

## Impact

- Specs: `forge-dispatch` (requirements for dispatch outcome honesty and
  the report-file delivery contract)
- Code: the dispatch poller result classification, the ledger write
  paths, and the dispatch prompt template (one added standing line)
- Tests: stream-break classification matrix + ledger-entry assertions +
  prompt-template contract test
