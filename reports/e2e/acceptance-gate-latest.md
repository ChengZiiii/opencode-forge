# Acceptance gate — 0.33.1 — PASS (1 booked leg)

- generated: 2026-11-24T00:56:35.603Z · git 3a77901 (1 uncommitted paths) · host wanted: 2.4.0
- build: dist 2026-11-23T23:40:55.425Z (newest source src/job-runner.ts 2026-11-23T23:33:35.033Z) · sha256 e10722f05a28a87be689c1f74fdad7c542cd3864048ef5c11e912ca42571c313
- counts: 27 pass · 0 fail · 1 booked · 0 known

| check | status | detail |
| --- | --- | --- |
| build-fresh | PASS | dist 2026-11-23T23:40:55.425Z vs newest source src/job-runner.ts 2026-11-23T23:33:35.033Z |
| c3-command-stop | PASS | file 2026-11-23T23:50:02.284Z · startedAt 2026-11-23T23:45:18.834Z · dist 2026-11-23T23:40:55.425Z |
| e2e-c3-command-stop | PASS | 16/16 checks |
| c4-pin-variant | PASS | file 2026-11-23T23:44:51.158Z · startedAt 2026-11-23T23:43:40.475Z · dist 2026-11-23T23:40:55.425Z |
| e2e-c4-pin-variant | PASS | 6/6 checks |
| c2-plan-close | PASS | file 2026-11-24T00:06:00.743Z · startedAt 2026-11-24T00:04:47.864Z · dist 2026-11-23T23:40:55.425Z |
| e2e-c2-plan-close | PASS | 11/11 checks |
| f-crew-close-door | PASS | file 2026-11-24T00:10:07.893Z · startedAt 2026-11-24T00:06:00.931Z · dist 2026-11-23T23:40:55.425Z |
| e2e-f-crew-close-door | PASS | 7/7 checks |
| a-anchor-multidir | PASS | file 2026-11-24T00:14:22.540Z · startedAt 2026-11-24T00:13:42.463Z · dist 2026-11-23T23:40:55.425Z |
| e2e-a-anchor-multidir | PASS | 9/9 checks |
| b-spawn-error | PASS | file 2026-11-24T00:10:45.620Z · startedAt 2026-11-24T00:10:08.101Z · dist 2026-11-23T23:40:55.425Z |
| e2e-b-spawn-error | PASS | 10/10 checks |
| c1-dispose | PASS | file 2026-11-23T23:55:31.163Z · startedAt 2026-11-23T23:50:02.494Z · dist 2026-11-23T23:40:55.425Z |
| e2e-c1-K1 | PASS | {} |
| e2e-c1-K2 | PASS | {} |
| e2e-c1-D1 | BOOKED | the evict did not kill the control process tree of the evicted location - the plugin dispose hook did not run inside the leg window (probe silent): no verdict on the dispatch exemption \| dispose hook probe: {"ranInWindow":false,"secondsEvictToHook":null,"line… |
| c5-standard | PASS | file 2026-11-24T00:04:24.725Z · started 2026-11-23T23:55:31.323Z · dist 2026-11-23T23:40:55.425Z |
| e2e-c5-standard | PASS | legs A,B,BI,D · ceiling 900000ms = production default |
| c5-ceiling-C | PASS | file 2026-11-24T00:19:29.517Z · started 2026-11-24T00:14:57.543Z · dist 2026-11-23T23:40:55.425Z |
| e2e-c5-ceiling-C | PASS | leg C · ceiling 240000ms |
| crew-full | PASS | file 2026-11-24T00:24:29.033Z · startedAt 2026-11-24T00:20:07.618Z · dist 2026-11-23T23:40:55.425Z |
| e2e-crew-full | PASS | 16/16 checks · closed after 236s · sections ["registered (pending)","armed (waves)","closed"] |
| tui-headed | PASS | 8 items · checked 2026-11-24T00:54:28.333Z · host 2.4.0 |
| live-typecheck | PASS | no errors |
| live-unit-suite | PASS | 1032/1032 pass |
| live-host-version | PASS | opencode v2.4.0 |
| no-secret-in-evidence | PASS | checked 11 files |

## Booked legs (D6 — not a pass)

- **e2e-c1-D1** — D6 — the sandbox host (2.4.0) offers no action proven to run the plugin dispose hook while a dispatch is in flight. the evict did not kill the control process tree of the evicted location - the plugin dispose hook did not run inside the leg window (probe silent): no verdict on the dispatch exemption | dispose hook probe: {"ranInWindow":false,"secondsEvictToHook":null,"lines":[],"note":"probe lines are written by the plugin's dispose hook / exit matrix when they run (build 2026-11-23T16:5xZ+); none = neither ran inside this leg's window"}

