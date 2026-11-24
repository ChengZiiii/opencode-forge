# Acceptance gate — 0.34.0 — PASS (1 booked leg)

- generated: 2026-11-24T05:06:34.903Z · git 4f40a50 (1 uncommitted paths) · host wanted: 2.4.0
- build: dist 2026-11-24T03:18:19.155Z (newest source plugin.ts 2026-11-24T03:18:17.267Z) · sha256 8c97c396fb75bcdc60a5475131d0b57ef2b6e442f6945af9b506e0f927f19803
- counts: 31 pass · 0 fail · 1 booked · 0 known

| check | status | detail |
| --- | --- | --- |
| build-fresh | PASS | dist 2026-11-24T03:18:19.155Z vs newest source plugin.ts 2026-11-24T03:18:17.267Z |
| c3-command-stop | PASS | file 2026-11-24T03:42:40.159Z · startedAt 2026-11-24T03:37:17.418Z · dist 2026-11-24T03:18:19.155Z |
| e2e-c3-command-stop | PASS | 16/16 checks |
| c4-pin-variant | PASS | file 2026-11-24T03:35:07.534Z · startedAt 2026-11-24T03:33:38.443Z · dist 2026-11-24T03:18:19.155Z |
| e2e-c4-pin-variant | PASS | 6/6 checks |
| c2-plan-close | PASS | file 2026-11-24T03:37:17.195Z · startedAt 2026-11-24T03:35:07.747Z · dist 2026-11-24T03:18:19.155Z |
| e2e-c2-plan-close | PASS | 11/11 checks |
| f-crew-close-door | PASS | file 2026-11-24T04:03:26.053Z · startedAt 2026-11-24T04:00:45.449Z · dist 2026-11-24T03:18:19.155Z |
| e2e-f-crew-close-door | PASS | 7/7 checks |
| a-anchor-multidir | PASS | file 2026-11-24T04:05:04.177Z · startedAt 2026-11-24T04:04:07.782Z · dist 2026-11-24T03:18:19.155Z |
| e2e-a-anchor-multidir | PASS | 9/9 checks |
| b-spawn-error | PASS | file 2026-11-24T04:04:07.583Z · startedAt 2026-11-24T04:03:26.261Z · dist 2026-11-24T03:18:19.155Z |
| e2e-b-spawn-error | PASS | 10/10 checks |
| c-stop-queued | PASS | file 2026-11-24T04:00:44.774Z · startedAt 2026-11-24T03:58:50.925Z · dist 2026-11-24T03:18:19.155Z |
| e2e-c-stop-queued | PASS | 9/9 checks |
| e-stale-progress | PASS | file 2026-11-24T03:30:39.902Z · startedAt 2026-11-24T03:25:22.511Z · dist 2026-11-24T03:18:19.155Z |
| e2e-e-stale-progress | PASS | 11/11 checks |
| c1-dispose | PASS | file 2026-11-24T03:49:28.977Z · startedAt 2026-11-24T03:42:40.403Z · dist 2026-11-24T03:18:19.155Z |
| e2e-c1-K1 | PASS | {} |
| e2e-c1-K2 | PASS | {} |
| e2e-c1-D1 | BOOKED | the evict did not kill the control process tree of the evicted location - the plugin dispose hook did not run inside the leg window (probe silent): no verdict on the dispatch exemption \| dispose hook probe: {"ranInWindow":false,"secondsEvictToHook":null,"line… |
| c5-standard | PASS | file 2026-11-24T03:58:50.618Z · started 2026-11-24T03:49:29.142Z · dist 2026-11-24T03:18:19.155Z |
| e2e-c5-standard | PASS | legs A,B,BI,D · ceiling 900000ms = production default |
| c5-ceiling-C | PASS | file 2026-11-24T04:09:57.537Z · started 2026-11-24T04:05:08.040Z · dist 2026-11-24T03:18:19.155Z |
| e2e-c5-ceiling-C | PASS | leg C · ceiling 240000ms |
| crew-full | PASS | file 2026-11-24T04:17:06.396Z · startedAt 2026-11-24T04:10:01.311Z · dist 2026-11-24T03:18:19.155Z |
| e2e-crew-full | PASS | 16/16 checks · closed after 400s · sections ["registered (pending)","armed (waves)","closed"] |
| tui-headed | PASS | 9 items · checked 2026-11-24T05:04:30.272Z · host 2.4.0 |
| live-typecheck | PASS | no errors |
| live-unit-suite | PASS | 1047/1047 pass |
| live-host-version | PASS | opencode v2.4.0 |
| no-secret-in-evidence | PASS | checked 13 files |

## Booked legs (D6 — not a pass)

- **e2e-c1-D1** — D6 — the sandbox host (2.4.0) offers no action proven to run the plugin dispose hook while a dispatch is in flight. the evict did not kill the control process tree of the evicted location - the plugin dispose hook did not run inside the leg window (probe silent): no verdict on the dispatch exemption | dispose hook probe: {"ranInWindow":false,"secondsEvictToHook":null,"lines":[],"note":"probe lines are written by the plugin's dispose hook / exit matrix when they run (build 2026-11-23T16:5xZ+); none = neither ran inside this leg's window"}

