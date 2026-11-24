# Acceptance gate (`acceptance-gate.mjs`)

One fail-closed verdict for a release acceptance. It never *creates* evidence:
it re-reads the sandbox E2E verdict files and the headed-TUI evidence, re-measures
the repo live, and ties every piece of evidence to the build it ran on.

```bat
cd opencode-forge
node reports\e2e\acceptance-gate.mjs --snapshot reports\e2e\evidence\0.34.1
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
| `e2e-c3-command-stop` / `c4-pin-variant` / `c2-plan-close` / `f-crew-close-door` / `a-anchor-multidir` / `b-spawn-error` / `c-stop-queued` / `e-stale-progress` / `md-ask-door-multidir` | `verdict === true`, `result.pass === true`, every `result.checks` true, no `inconclusive`. The 0.33.1 legs: `crew_close` asks before it acts on both paths and "always" does not reopen the door; a `ws` session keeps its own directory after another directory is initialized last; a job whose working directory does not exist returns the not-started form, verbatim. The 0.34.0 legs: `/forge stop` cancels the session's queued wishes too (nothing spawns into the freed slots, the receipt names both groups); a progress notice whose dispatch has already finished is never delivered and never rides the completion wake (that driver only runs on a host with the short notify interval). The 0.34.1 leg (`21-ask-door-multidir-e2e.mjs`, 13 cells over five directory geometries): with two directories loaded, a session in the directory that was **not** initialized last raises its confirmation request in its own directory's pending table (never in another directory's), the request is answered through the session's own route and the door then executes in the session's own directory; after the last-initialized directory is evicted the other directory's `forge_shell` and doors keep working; the same after re-boots in either order, and for a session whose own directory was evicted and comes back on demand. The driver creates every session with the directory in the request **body** and reads it back from the host's record — `POST /api/session?location[directory]=…` is ignored by 2.4.0 (the session lands in the host's cwd) | any driver check is not `true` |
| `e2e-c1-K1` / `K2` | owner-deleted and cancel-lever legs | `results.<leg>.pass !== true` |
| `e2e-c1-D1` | on host 2.4.0 an evict of the owner location mid-dispatch kills nothing and the dispatch completes with exactly one wake: the dispatch is in flight when the evict lands — the child session's job is a live process right before the evict (`childJobLiveBeforeEvict`; the driver waits up to 240 s for it, a child that ends its turn without running its job is a premise miss, the leg is retried once and two misses are recorded inconclusive); the evicted location's control job (and another location's, when one was started) is still alive 8 s after the evict and runs to its natural end, the job-clearing v1 `dispose` hook never runs (its probe line is absent **and** the probe is proven live by an idle line written before the evict), the journal row is untouched right after the evict, the ledger carries no dispose line, the journal ends terminal and not `aborted`. A plugin unload on a v2 host clears no job — the loader reads only `default.setup` and the cleanup `setup` resolves to only disposes the plugin's own registrations (change `doc-plugin-unload-v2`; before it this leg was booked at every release) | `pass` is not `true`, or the verdict does not carry all seven recorded facts (the six of the `hostContract` — evict not accepted, probe not live, a control dead after the evict or not run to end, the hook ran, the row was touched — and the child's job not live right before the evict). An inconclusive or premise-missed D1 is a FAIL — there is no booked branch |
| `e2e-c5-standard` | A / B / B' / D pass with host and driver on the production-default ceiling | a leg is not `true`, or the ceiling differs from the default |
| `e2e-ceiling-C` | leg C passes with host and driver on the raised ceiling (`--ceiling-leg-ms`, default 240000) | as above |
| `e2e-crew-full` | ONE complete crew on the live host: `crew_begin` → engine briefs → waves → verdicts → `crew_close` (goal criterion 3) | any check not `true`; a check the driver AND the release name is KNOWN, not a pass |
| `e2e-tui-headed` | headed TUI evidence (below) is complete, on this host version, newer than dist | missing, incomplete or stale — a required item that is simply absent from the file is a FAILURE |
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

**The set is fixed** (`REQUIRED_TUI_ITEMS` in the gate): every id on that list
must be present AND passing; an id the file leaves out is a failure, never a
skip. Until 0.34.1 the gate only checked "every item that is in the file
passed", so a hand-written file that dropped an item passed — and two items
observed in the 0.33.0 headed gate (`c2-plan-close-no-dialog`,
`c2-plan-reopen-in-tui`) were absent from the 0.33.1 and 0.34.0 evidence
without any record of a decision to drop them. They are required again. A
release that really retires an item edits the list in a commit.

The thirteen ids (0.34.1) and what each one must show in a real terminal:

| id | what it shows |
| --- | --- |
| `f-crew-close-abandon-dialog-visible-and-answerable-in-tui` | `crew_close` (abandon) shows its dialog; Allow in the terminal releases the call and the crew is abandoned |
| `f-crew-close-report-dialog-reject-in-tui-keeps-the-crew` | Reject in the terminal: the call fails, the crew stays as it was |
| `f-crew-close-report-dialog-allow-in-tui-closes-the-crew` | the same close asked again and allowed: the crew is closed |
| `c2-plan-close-no-dialog` | `plan_close` in the terminal closes the plan (verified section written) without a permission dialog |
| `c2-plan-reopen-in-tui` | `plan_reopen` in the terminal reopens that closed plan (dated reopened section; plan file and transcript are the ground truth) |
| `c3-command-list` | `/` lists `/plan`, `/crew`, `/goal`, `/forge` and no hyphenated forge command |
| `c-forge-stop-cancels-in-flight-and-queued-in-tui` | `/forge stop` cancels the in-flight and the still-queued dispatches of the session |
| `a-session-anchor-holds-after-a-third-directory-in-tui` | a session keeps its own directory after another directory was initialized last |
| `md-ask-door-dialog-visible-and-answerable-in-a-non-last-directory-tui` | in a session whose directory is **not** the host's last-initialized one: the dialog shows, the terminal's answer reaches the request (the request is in the session's own pending table, no 404 reply), and only then does the door execute |
| `md-ask-door-dialog-reject-in-a-non-last-directory-tui-keeps-the-crew` | the same geometry, Reject: the call fails and the crew stays |
| `e-stale-progress-notice-is-not-delivered-in-tui` | a progress notice for a dispatch that already finished is never delivered |
| `tui-no-unexpected-permission-asks` | apart from the dialogs named above, no permission ask was raised in any gated session |
| `tui-windows-closed-cleanly` | every terminal window was closed with its session idle and nothing was left running |

The two `md-` items are the headed half of `fix-ask-door-multi-directory-host`.
On the pre-fix build (measured 2026-11-24 on 0.34.0) the dialog in that
geometry **does** show — a terminal hears of a new request through a host
event — but the terminal's answer is posted to the session's own directory's
pending table, where the request is not: the host answers 404, the dialog
vanishes and the gate waits out its 300 s watchdog. So "answerable" is what
the first `md-` item proves, not merely "visible".

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
