# Acceptance gate — 0.34.1 — PASS

- generated: 2026-11-24T22:30:09.056Z · git 395ff5d (1 uncommitted paths) · host wanted: 2.4.0
- build: dist 2026-11-24T18:43:34.008Z (newest source plugin.ts 2026-11-24T18:38:14.595Z) · sha256 f767eedbe8015a66bb4678a368ea2f7bde2444c4f713855555ab39db3c5d8821
- counts: 34 pass · 0 fail · 0 booked · 0 known

| check | status | detail |
| --- | --- | --- |
| build-fresh | PASS | dist 2026-11-24T18:43:34.008Z vs newest source plugin.ts 2026-11-24T18:38:14.595Z |
| c3-command-stop | PASS | file 2026-11-24T20:20:55.406Z · startedAt 2026-11-24T20:16:05.542Z · dist 2026-11-24T18:43:34.008Z |
| e2e-c3-command-stop | PASS | 16/16 checks |
| c4-pin-variant | PASS | file 2026-11-24T20:14:37.789Z · startedAt 2026-11-24T20:13:37.005Z · dist 2026-11-24T18:43:34.008Z |
| e2e-c4-pin-variant | PASS | 6/6 checks |
| c2-plan-close | PASS | file 2026-11-24T20:16:05.337Z · startedAt 2026-11-24T20:14:38.001Z · dist 2026-11-24T18:43:34.008Z |
| e2e-c2-plan-close | PASS | 11/11 checks |
| f-crew-close-door | PASS | file 2026-11-24T20:38:52.143Z · startedAt 2026-11-24T20:36:40.099Z · dist 2026-11-24T18:43:34.008Z |
| e2e-f-crew-close-door | PASS | 7/7 checks |
| a-anchor-multidir | PASS | file 2026-11-24T20:40:12.520Z · startedAt 2026-11-24T20:39:37.860Z · dist 2026-11-24T18:43:34.008Z |
| e2e-a-anchor-multidir | PASS | 9/9 checks |
| b-spawn-error | PASS | file 2026-11-24T20:39:37.654Z · startedAt 2026-11-24T20:38:52.349Z · dist 2026-11-24T18:43:34.008Z |
| e2e-b-spawn-error | PASS | 10/10 checks |
| c-stop-queued | PASS | file 2026-11-24T20:55:40.324Z · startedAt 2026-11-24T20:54:37.335Z · dist 2026-11-24T18:43:34.008Z |
| e2e-c-stop-queued | PASS | 9/9 checks |
| e-stale-progress | PASS | file 2026-11-24T20:59:31.670Z · startedAt 2026-11-24T20:55:40.593Z · dist 2026-11-24T18:43:34.008Z |
| e2e-e-stale-progress | PASS | 11/11 checks |
| md-ask-door-multidir | PASS | file 2026-11-24T20:42:58.014Z · startedAt 2026-11-24T20:40:12.751Z · dist 2026-11-24T18:43:34.008Z |
| e2e-md-ask-door-multidir | PASS | 21/21 checks |
| c1-dispose | PASS | file 2026-11-24T20:26:14.141Z · startedAt 2026-11-24T20:20:55.629Z · dist 2026-11-24T18:43:34.008Z |
| e2e-c1-K1 | PASS | {} |
| e2e-c1-K2 | PASS | {} |
| e2e-c1-D1 | PASS | evict 204 · child job live before the evict (4 s after it was seen) · probe live · controls ["B","C"] alive after the evict and ran to end · dispose hook not run · dispatch untouched right after · journal terminal/completed · wakes 1 · owner location still loa… |
| c5-standard | PASS | file 2026-11-24T20:35:16.715Z · started 2026-11-24T20:26:14.311Z · dist 2026-11-24T18:43:34.008Z |
| e2e-c5-standard | PASS | legs A,B,BI,D · ceiling 900000ms = production default |
| c5-ceiling-C | PASS | file 2026-11-24T20:47:35.613Z · started 2026-11-24T20:43:01.828Z · dist 2026-11-24T18:43:34.008Z |
| e2e-c5-ceiling-C | PASS | leg C · ceiling 240000ms |
| crew-full | PASS | file 2026-11-24T20:54:33.486Z · startedAt 2026-11-24T20:47:39.464Z · dist 2026-11-24T18:43:34.008Z |
| e2e-crew-full | PASS | 16/16 checks · closed after 389s · sections ["registered (pending)","armed (waves)","closed"] |
| tui-headed | PASS | 13 items (all 13 required present) · checked 2026-11-24T22:28:29.514Z · host 2.4.0 |
| live-typecheck | PASS | no errors |
| live-unit-suite | PASS | 1068/1068 pass |
| live-host-version | PASS | opencode v2.4.0 |
| no-secret-in-evidence | PASS | checked 14 files |

