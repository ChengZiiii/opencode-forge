# builtin-override — tasks

> Status: PROPOSED — awaiting owner review (proposal Authorization
> note). Do not check off until apply is approved.

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

- [ ] 1.1 Global scaffold content (override entries in comment form)
  delivered through the `/forge init global` lever and the in-band
  ask (command itself owned by forge-commands).
- [ ] 1.2 Scaffold content: General/Explore override entries in
  COMMENT form (JSONC), Auto-worker semantics documented inline.
- [ ] 1.3 Compiler: non-namespaced same-name emission mode for
  override entries — **case-locked lowercase stems (`general.md`,
  `explore.md`) per probe evidence, capitalized never emitted** — +
  collision redline (refuse + disclose when a
  hand-written same-name file exists) + GC keyed on GENERATED marker
  for override files.

## 2. Tests + docs

- [ ] 2.1 Test matrix: scaffold shape, commented-by-default,
  collision refusal, marker-keyed GC, unconfigured = no emission.
- [ ] 2.2 README handbook: the override pattern, the official-default
  promise, the scaffold paths (in-band ask + `/forge init global`).

## 3. Gate + release

- [ ] 3.1 Full gate (typecheck, suite, validate, bundle) + sandbox
  E2E; version bump + npm publish only after owner approval.
