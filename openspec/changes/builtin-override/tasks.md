# builtin-override — tasks

> Status: APPLY APPROVED (owner, 2026-11-21, probe POSITIVE).

## 0. Pre-implementation probe

- [x] 0.1 Sandbox probe on 2.3.2: does a user same-name agent file
  actually override the BUILT-IN (description/model observable via
  /api/agent)? **RESULT (2026-11-21): POSITIVE with hard constraint —
  identity key is the id stem, case-sensitive; only lowercase
  `general.md`/`explore.md` truly override; capitalized files create
  ambiguous duplicates (negative form). Layer mechanics identical;
  dual-layer same-id: project wins. Report:
  `reports/probe-builtin-override.md`.**

## 1. Implementation

- [x] 1.1 Global scaffold content (override entries in comment form)
  delivered through the `/forge init global` lever and the in-band
  ask (command itself owned by forge-commands).
- [x] 1.2 Scaffold content: General/Explore override entries in
  COMMENT form (JSONC), Auto-worker semantics documented inline.
  (plugin.ts GLOBAL_RECIPE_SCAFFOLD_JSONC)
- [x] 1.3 Compiler: non-namespaced same-name emission mode for
  override entries — **case-locked lowercase stems (`general.md`,
  `explore.md`) per probe evidence, capitalized never emitted** — +
  collision redline (refuse + disclose when a
  hand-written same-name file exists) + GC keyed on GENERATED marker
  for override files. (src/roster-compile.ts compileOverrideEntry /
  planOverrideSync / executeRosterSync kind:"override")

## 2. Tests + docs

- [x] 2.1 Test matrix: scaffold shape, commented-by-default,
  collision refusal, marker-keyed GC, unconfigured = no emission.
  (tests/builtin-override.test.mjs; + globalAgentDirFor both branches)
- [x] 2.2 README handbook: the override pattern, the official-default
  promise, the scaffold paths (in-band ask + `/forge init global`).

## 3. Gate + release

- [x] 3.1 Full gate + sandbox E2E (2026-11-21): typecheck 0, suite 860/860
  (859 + 1 new deactivation-GC test), bundle committed; E2E scenarios 5-9
  PASS at final tally @92fc059 — reports/e2e-0310-dual-change-report.md.
  E2E first round surfaced two spec-promised behaviors the wiring missed
  (scenario 6 deactivation GC channel; scenario 9 findings disclosure);
  both fixed in 92fc059 and retest-verified PASS (marker-keyed GC spares
  hand-written files; `override-node-ignored-workspace` now disclosed
  in-band + console).
- [x] 3.2 Version bump + npm publish — DONE 2026-11-21 (same train as
  forge-commands: 0.31.0 published, cache purged, service restarted, host
  loaded the official package; worker rescue + /forge command family + both
  fix markers verified on the production server — evidence in
  forge-commands tasks.md 3.2).
