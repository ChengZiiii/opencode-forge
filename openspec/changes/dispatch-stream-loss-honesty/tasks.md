# dispatch-stream-loss-honesty — Tasks

- [ ] 1. Outcome classification: introduce the `stream-lost/unknown`
  dispatch outcome class; a broken result stream before a final report
  classifies as `stream-lost/unknown` with wording "result stream lost;
  child state UNKNOWN" and NEVER terminal/exit-1 obituary wording —
  verify: unit tests for the classification matrix (final-report /
  definite-failure / stream-loss)
- [ ] 2. Ledger completeness: every dispatch outcome path writes a
  ledger entry, including `stream-lost/unknown` (with last-observed
  activity timestamp) — verify: unit test asserts a ledger entry exists
  after a simulated stream break where today none is written
- [ ] 3. Report-file delivery contract: the dispatch prompt template
  gains the standing report-to-file instruction with the
  caller-provided path convention (`reports/<task>-report.md`) —
  verify: prompt-template contract test asserts the standing line and
  the path convention
- [ ] 4. Documentation: README dispatch section + AGENTS.md note the
  three outcome classes and the report-file ground-truth convention —
  verify: docs present; full suite green; `openspec validate --all` green
