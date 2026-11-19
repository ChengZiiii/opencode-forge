# dispatch-sync-handoff-notice — Tasks

- [ ] 1. Reclassify the sync wait-budget expiry handoff as an
  informational notice: neutral styling, outcome-naming wording,
  retrieval pointers preserved (job id, task handle, report path when
  present) — verify: unit tests for the handoff presentation matrix
  (budget-expiry → notice; refusal/evidence-backed failure → error)
- [ ] 2. Keep genuine failure paths on the error channel unchanged —
  verify: existing refusal/failure presentation tests still green;
  new assertions pin the error-class rendering
- [ ] 3. Documentation: README dispatch section notes the sync handoff
  presentation contract — verify: docs present; full suite green;
  `openspec validate --all` green
