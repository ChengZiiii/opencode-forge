# forge-commands — tasks

> Status: APPLY APPROVED (owner, 2026-11-21) — implementation tasks below.

## 1. Commands

- [x] 1.1 `/forge sync` — execute-type template (invoke forge_sync
  NOW, report the diff) + registration in both v1 config and v2
  command domains + family guard.
- [x] 1.2 `/forge init` — in-band project-recipe drafting flow
  (pool namespace, roles, shapes; interview or project context),
  refuse-if-exists with review offer.
- [x] 1.3 `/forge init global` — same flow for the global forge.json,
  scaffold ships commented General/Explore override entries
  (builtin-override content).
- [x] 1.4 Unconfigured-crew refusal text: name the levers alongside
  the in-band ask.

## 2. Tests + docs

- [x] 2.1 Test matrix: command registration both domains, argument
  routing (sync / init / init global / unknown), family guard,
  refuse-if-exists, template content assertions.
- [x] 2.2 README: command table gains the /forge family; the "no
  /forge command family" note is replaced by the family inventory.

## 3. Gate + release

- [x] 3.1 Full gate + sandbox E2E (2026-11-21): typecheck 0, suite 860/860,
  bundle committed; E2E 9/9 scenarios PASS (final tally after the retest
  round @92fc059) — reports/e2e-0310-dual-change-report.md (scenarios 1-4
  cover this change: command registration, force sync + contrast,
  refuse-if-exists, global scaffold).
- [x] 3.2 Version bump + npm publish — DONE 2026-11-21: 0.30.0 → 0.31.0
  (commit 12e97ef), `npm pack --dry-run` clean (4 files: dist + README,
  224.6 kB), `npm publish` → `+ @sorenllm/opencode-forge@0.31.0` (tag
  latest). Real-machine verification after cache purge + service restart:
  registry serves 0.31.0; fresh cache snapshot carries
  `@sorenllm/opencode-forge version=0.31.0`; host run `0ab78fea` loads it;
  loaded dist carries both fix markers (empty-plan GC channel, findings
  disclosure); worker rescue alive on the OFFICIAL package
  (`OFFICIAL-0310-ALIVE`, exit=0); /forge command family live via
  /api/command on the production server.
