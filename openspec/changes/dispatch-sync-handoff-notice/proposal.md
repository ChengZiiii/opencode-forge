# dispatch-sync-handoff-notice

## Why

When a synchronous dispatch hands back after its wait budget expires,
the layer renders the handoff as a RED ERROR ("dispatch timed out" in
the error channel) even though a sync handoff timeout is a NORMAL,
expected outcome — the child keeps running in the background and the
caller is expected to pick the result up later. During the 2026-11-19
migration session this mispresentation repeatedly confused the flow:
the red banner suggested a failure needing remediation when the correct
reading was simply "the wait budget ended; the dispatch continues;
collect via the job tools". Presentation semantics must match outcome
semantics.

## What Changes

- The sync-wait-budget-expiry handoff is reclassified from an error to
  a normal notification: informational styling and wording ("sync wait
  budget ended — the dispatch continues in the background; collect
  with `forge_jobs`"), no error-channel rendering, no alarm color.
- The genuine failure paths (dispatch refused, worker errored with
  evidence) keep their existing error presentation — only the budget
  expiry path changes class.
- The notification carries the same retrieval pointers as today (job
  id / task handle / report path when the report-file convention is in
  play).

## Impact

- Specs: `forge-subagents` (sync handoff presentation requirement)
- Code: the sync-dispatch handoff path's message classification only
- Tests: handoff presentation matrix (budget-expiry → notice;
  refused/errored → error)
