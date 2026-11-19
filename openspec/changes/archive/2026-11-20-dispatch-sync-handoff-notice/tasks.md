# dispatch-sync-handoff-notice — Tasks

- [x] 1. Reclassify the sync wait-budget expiry handoff as an
  informational notice: neutral styling, outcome-naming wording,
  retrieval pointers preserved (job id, task handle, report path when
  present) — verify: unit tests for the handoff presentation matrix
  (budget-expiry → notice; refusal/evidence-backed failure → error)
  (2026-11-20: the sync settle returns a normal result — "Sync wait
  budget ended (<window>ms) — the dispatch continues in the background;
  collect with forge_jobs" + task id / child session / report path /
  completion contract; the stream-lost handoff rides the same
  informational channel with its UNKNOWN-state wording; the armed
  tracker publishes before the return. Matrix test:
  budget-expiry → informational result; worker error + gate refusal →
  rejections (error channel, no handoff styling))
- [x] 2. Keep genuine failure paths on the error channel unchanged —
  verify: existing refusal/failure presentation tests still green;
  new assertions pin the error-class rendering
  (2026-11-20: syncError → throw "child session ... ended in error"
  unchanged; retry refusals, spawn failures, gate/pool/cap refusals all
  still throw; the matrix test pins the error rendering + the existing
  refusal/wake tests stay green)
- [x] 3. Documentation: README dispatch section notes the sync handoff
  presentation contract — verify: docs present; full suite green;
  `openspec validate --all` green
  (2026-11-20: README "Sync handoff presentation" paragraph; full suite
  + validate green)
