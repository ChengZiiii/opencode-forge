# dispatch-sync-handoff-notice — Design

## Context

The sync dispatch path blocks on the child's final report up to a wait
budget. When the budget expires while the child is still healthy, the
layer hands back — but does so through the error channel with red
"dispatch timed out" styling. Budget expiry with a still-running child
is a designed outcome, not a failure; the misclassification makes every
long-running sync dispatch look broken and invites spurious remediation
(re-dispatch loops, abandoned in-flight children).

## Goals / Non-Goals

- Goal: presentation class matches outcome class — budget expiry is a
  notice, genuine failures stay errors.
- Non-Goal: changing the wait budget mechanics, the background
  continuation of the child, or the retrieval tools.
- Non-Goal: touching the stream-loss honesty path (separate change:
  `dispatch-stream-loss-honesty`).

## Decisions

- **D1 — reclassify budget expiry as a notice.** The handoff message
  when the wait budget expires moves to the informational channel:
  neutral styling, wording that names the outcome ("sync wait budget
  ended — the dispatch continues in the background; collect with
  `forge_jobs`"). No error banner, no alarm color.
- **D2 — failure paths unchanged.** Dispatch refusal (gates, pool
  caps) and evidence-backed worker errors keep error-class
  presentation. Only the expiry path changes.
- **D3 — retrieval pointers preserved.** The notice carries the same
  handle data as the current error message (job id, task handle, report
  path when present) so nothing is lost in the reclassification.

## Risks / Trade-offs

- Callers that keyed on the red styling as a signal — mitigated: the
  message text still names the outcome unambiguously, and the retrieval
  pointers are unchanged.

## Migration Plan

Single release; presentation-only. No state migration.

## Open Questions

- None.
