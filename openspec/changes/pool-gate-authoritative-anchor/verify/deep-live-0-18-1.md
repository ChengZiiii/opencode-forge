# Verify — pool-gate-authoritative-anchor (0.18.1)

Date: 2026-10-31 (UTC). Verifier: orchestrator (direct — dispatch belts were the
very surface under repair, so worker dispatch from this session was refused by
the 0.18.0 bug itself; disclosed in-conversation and in the change proposal).

## The live incident (0.18.0, user-reported)

Session in `F:\UNITY_Project\SorenUnityLabs` dispatching its OWN pool's
`forge-sorenunitylabs-ta-tool` → refused:
`[forge:pool] Dispatch refused: … not dispatchable from this session. This
session's dispatchable roster is the global fallback (…).`
Same refusal reproduced in the maintainer's plugindev session. Host-side
session records were correct the whole time (`directory="F:\UNITY_Project\SorenUnityLabs"`
in opencode.log); sibling sessions with fresh bindings dispatched fine — the
failure followed DEGRADED in-memory bindings (resumed-after-restart sessions
never re-fire `session.created`; rootish tool contexts fall back to the host
launch directory; `ensureSession` clobbered good bindings unconditionally),
while the goal engine already used the authoritative `client.session.get`.

## Fix

`resolveSessionAnchorForPools` (authoritative record → in-memory map fallback,
never writes back) wired into the task pool gate AND the crew compliance belt;
`ensureSession` no-degenerate-clobber guard. Refusal copy, fail-open posture,
and roster semantics unchanged.

## Evidence chain

1. **Unit + wiring**: 396/396 green (`node --test tests/*.test.mjs`), including
   4 new authoritative-anchor scenarios: (a) degraded binding + record →
   own-pool ALLOWED and cross-pool still refused with the workspace-pool roster
   line; (b) record fetch throws → map decides, unknown-everything fail-open;
   (c) degenerate re-anchor never clobbers a good binding; (d) crew compliance
   re-check refuses via the record while the map says compliant.
2. **Gate**: typecheck clean; bundle self-contained; `npm pack --dry-run`
   3-file whitelist (dist + README.md + package.json), 157.7 kB,
   shasum bf3c1b7dd0df6c73432948912b87c2b60ccd174e.
3. **Deep live E2E, git+file:// official install** (first run of the fixed
   script had three draft bugs of its own — raw-JSON path matching, a bare
   `api` crash at the run-1 final fetch, and an apples-to-oranges order
   comparison; all fixed in 78c959a): final run 2026-10-30T19:10:16Z —
   `POOLNS_DEEP a=PASS f=PASS g=PASS c=PASS d1=PASS d2=PASS e=PASS b=PASS`,
   EXIT=0. Evidence: `%TEMP%/poolns-deep-evidence-1793387416738.json`.
   **(g) is the new positive twin**: own-pool dispatch through the live belt
   SUCCEEDS (worker ran, no refusal) — the coverage whose absence let 0.18.0 ship.
4. **Published artifact, npm channel** (registry dist-tags `latest=0.18.1`
   confirmed via REST before running): `NPM_POSTPUB A=PASS B=PASS`
   (xhigh effort wire + draft-readonly scout dispatch, zero refusals; evidence
   `%TEMP%/npm-postpub-evidence-1793387773925.json`), then
   `POOLNS_DEEP … all PASS, EXIT=0` at 2026-10-30T19:23:25Z (evidence
   `%TEMP%/poolns-deep-evidence-1793388205155.json`).

## Honest failure ledger

- Deep run 1 (pre-fix script): a/f/c/d1 FAIL + b NOT-VERIFIED — plugin
  behaviors all fired correctly; failures were the interrupted worker's script
  bugs (stale snapshot, slash-folding matcher, `api` crash) plus a dead SSE
  idle watcher burning 90 s per turn (run took 14 min; catch-count waiting
  replaced it).
- Deep run 2/3 residual: (b) compared a session-reaped end state against a
  fresh one — the serve reaps stale sessions and the union follows; both runs
  now compare peak-state views. One benign observation kept: the first wsC
  view right after hot-apply showed the pre-hot-apply derived ns (`forge-wsc-*`)
  for ~seconds before the declared `deepc` ns settled (mtime-cache window);
  end-state was correct in both runs and nothing asserts the transient.
- package.json was briefly corrupted by a PowerShell 5.1 `Set-Content`
  UTF-16 write during the version bump (watchdog tests caught it via
  ERR_INVALID_PACKAGE_CONFIG); restored via git and bumped with node. Pitfall
  recorded in ../opencode-plugin-dev-pitfalls.md §10.

## Upgrade note for users hit by the 0.18.0 symptom

Refresh the plugin store (the installer pins the first-seen version):
delete `~/.cache/opencode/packages/npm_@sorenllm/opencode-forge*` (both the
plain and `npm_` prefixed dirs if present), restart opencode (the sandbox
config's `npm:@sorenllm/opencode-forge` entry re-resolves 0.18.1 on first
session), then verify `opencode agent list` shows `forge-<ns>-*` ids. Resumed
sessions recover per-dispatch (the belt re-resolves the anchor from the host
record every task call — no session restart needed once the host runs 0.18.1).
