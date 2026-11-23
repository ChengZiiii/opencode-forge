# Acceptance gate (`acceptance-gate.mjs`)

One fail-closed verdict for a release acceptance. It never *creates* evidence:
it re-reads the sandbox E2E verdict files and the headed-TUI evidence, re-measures
the repo live, and ties every piece of evidence to the build it ran on.

```bat
cd opencode-forge
node reports\e2e\acceptance-gate.mjs --snapshot reports\e2e\evidence\0.33.0
```

Exit code 0 only when no check failed. A leg the sandbox cannot reach shows as
`BOOKED` (workspace D6 rule): it is listed separately in `booked` and makes
`hardPass` false — it never counts as a pass.

A product defect the release knowingly ships shows as `KNOWN`. It never counts
as a pass, it makes `hardPass` false, the header names it (`PASS (1 known
defect)`), and it only exists when BOTH sides say so: the driver carries the
failing check as a named known defect (`result.knownDefects`), AND the release
command names it (`--accept-known <check>`). Unnamed by either side it is an
ordinary FAIL. Every release decides again, so nothing accumulates silently.

| Check | What it proves | Fails when |
| --- | --- | --- |
| `build-fresh` | `dist/index.js` is newer than `plugin.ts`, `src/**`, `schema/` | any source changed after the build |
| `evidence-fresh-*` | each verdict file is newer than dist **and** carries an in-file start time later than dist | an E2E ran on an older build, or is undated |
| `e2e-c3-command-stop` / `c4-pin-variant` / `c2-plan-close` | `verdict === true`, `result.pass === true`, every `result.checks` true, no `inconclusive` | any driver check is not `true` |
| `e2e-c1-K1` / `K2` | owner-deleted and cancel-lever legs | `results.<leg>.pass !== true` |
| `e2e-c1-D1` | dispatch row survives a plugin dispose of the owner location | `pass` false without an inconclusive reason → FAIL; with one → BOOKED |
| `e2e-c5-standard` | A / B / B' / D pass with host and driver on the production-default ceiling | a leg is not `true`, or the ceiling differs from the default |
| `e2e-ceiling-C` | leg C passes with host and driver on the raised ceiling (`--ceiling-leg-ms`, default 240000) | as above |
| `e2e-crew-full` | ONE complete crew on the live host: `crew_begin` → engine briefs → waves → verdicts → `crew_close` (goal criterion 3) | any check not `true`; a check the driver AND the release name is KNOWN, not a pass |
| `e2e-tui-headed` | headed TUI evidence (below) is complete, on this host version, newer than dist | missing, incomplete or stale |
| `live-typecheck` | `tsc --noEmit`, measured at gate time | non-zero exit |
| `live-unit-suite` | `node --import ./tests/lib/test-runtime-namespace.mjs --test tests/*.test.mjs` (same preload as `npm test`), measured at gate time | any fail/cancelled, or fewer than `--min-tests` (default 1001) tests |
| `live-host-version` | `opencode --version` equals `--host` (default 2.4.0) | anything else |
| `no-secret-in-evidence` | no evidence file contains the sandbox host password | a leak (the file is also refused by the snapshot) |

## `tui-gate.json` (headed TUI evidence)

Written by hand after the headed session (PowerShell → real terminal →
computer use); the gate only reads it. Default location: the sandbox evidence
directory (`%LOCALAPPDATA%\Temp\opencode\view-e2e\logs\tui-gate.json`), or
`--tui <file>`.

```json
{
  "pass": true,
  "checkedAt": "2026-11-23T18:40:00.000Z",
  "hostVersion": "2.4.0",
  "items": [
    { "id": "c2-plan-close-no-dialog", "pass": true, "note": "what was on screen, and when" }
  ]
}
```

`pass` must be `true`, every item `pass: true`, and `checkedAt` later than the
build — an item that could not be observed is `pass: false`, with the reason in
`note`.

## Options

`--evidence <dir>` · `--tui <file>` · `--c1 <file>` · `--c5-standard <file>` ·
`--c5-ceiling <file>` · `--crew <file>` · `--host <version>` ·
`--min-tests <n>` · `--ceiling-leg-ms <n>` ·
`--accept-known <check[,check]>` · `--out <file.json>` · `--snapshot <dir>`

The unit suite is measured with the runner's reporter PINNED to tap
(`--test-reporter=tap`); the parser also accepts the spec shape (`ℹ tests N`).
The first live gate run (2026-11-23 19:59Z) parsed no counts at all — Node 24
defaults to the spec reporter — and failed closed, as it should have.

`--no-live` is a dry run for testing this script while an E2E chain owns the
machine: the three live measures are reported as **failed** (not measured), so
a dry run can never produce a passing gate.

The snapshot copies the evidence verdict files plus the report into `<dir>`
with a `manifest.json` of sha256 hashes.
