# dispatch-stream-loss-honesty — Tasks

- [x] 1. Outcome classification: introduce the `stream-lost/unknown`
  dispatch outcome class; a broken result stream before a final report
  classifies as `stream-lost/unknown` with wording "result stream lost;
  child state UNKNOWN" and NEVER terminal/exit-1 obituary wording —
  verify: unit tests for the classification matrix (final-report /
  definite-failure / stream-loss)
  (2026-11-20: pollChild sustained view-loss detector (DEFAULT
  _VIEW_LOSS_TICKS=30, PollInput.viewLossTicks seam, streak shared across
  slices via TerminalStabilityState.viewLossTicks); async poller exits
  stream-lost for BOTH the detector and the reclassified textless-idle
  floor — exit-null settle, honest wording, no obituary; sync path arms
  the tracker + honest throw; wake wording branches on
  DispatchJobMeta.outcome. Classification matrix: 5 new pollChild tests
  in dispatch-async.test.mjs (threshold/noise/status-only/reset/slice
  survival); wiring floor test asserts RESULT STREAM LOST + UNKNOWN +
  report path + obituary absence)
- [x] 2. Ledger completeness: every dispatch outcome path writes a
  ledger entry, including `stream-lost/unknown` (with last-observed
  activity timestamp) — verify: unit test asserts a ledger entry exists
  after a simulated stream break where today none is written
  (2026-11-20: the async poller tail journals outcome
  stream-lost/unknown with reason carrying the ISO last-observed
  activity timestamp (stale.lastActivity ?? startedAt); wiring test
  reads .opencode/forge/dispatch-log.jsonl and asserts the terminal
  stream-lost/unknown record naming the task id + timestamp)
- [x] 3. Report-file delivery contract: the dispatch prompt template
  gains the standing report-to-file instruction with the
  caller-provided path convention (`reports/<task>-report.md`) —
  verify: prompt-template contract test asserts the standing line and
  the path convention
  (2026-11-20: WORKER_MANDATES gains the standing mandate;
  withReportDelivery appends the concrete `reports/<id>-report.md`
  contract line idempotently (stale-line strip on re-wrap); injected at
  the task tool prompt declaration — queue/async/sync/retry/journal all
  carry it; tests: dispatch-prompt.test.mjs standing line + concrete
  path + idempotence, wiring tests assert the child prompt and queued
  journal carry the contract)
- [x] 4. Documentation: README dispatch section + AGENTS.md note the
  three outcome classes and the report-file ground-truth convention —
  verify: docs present; full suite green; `openspec validate --all` green
  (2026-11-20: README "Dispatch outcome honesty" + "Report-file delivery
  contract" paragraphs; AGENTS.md 关键机制 #8; full suite 715/715;
  validate green)
