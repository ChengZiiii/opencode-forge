# Acceptance gate — 0.33.0 — PASS (1 booked leg · 1 known defect)

- generated: 2026-11-23T20:34:36.144Z · git 1669dc1 (0 uncommitted paths) · host wanted: 2.4.0
- build: dist 2026-11-23T18:20:35.850Z (newest source plugin.ts 2026-11-23T18:19:44.932Z) · sha256 00565a61758f74da1669a0a2e875e93d7c57929ed653e04ed30da85e7231c021
- counts: 20 pass · 0 fail · 1 booked · 1 known

| check | status | detail |
| --- | --- | --- |
| build-fresh | PASS | dist 2026-11-23T18:20:35.850Z vs newest source plugin.ts 2026-11-23T18:19:44.932Z |
| c3-command-stop | PASS | file 2026-11-23T18:31:16.822Z · startedAt 2026-11-23T18:26:27.372Z · dist 2026-11-23T18:20:35.850Z |
| e2e-c3-command-stop | PASS | 16/16 checks |
| c4-pin-variant | PASS | file 2026-11-23T18:25:05.980Z · startedAt 2026-11-23T18:24:02.164Z · dist 2026-11-23T18:20:35.850Z |
| e2e-c4-pin-variant | PASS | 6/6 checks |
| c2-plan-close | PASS | file 2026-11-23T18:26:27.190Z · startedAt 2026-11-23T18:25:06.169Z · dist 2026-11-23T18:20:35.850Z |
| e2e-c2-plan-close | PASS | 11/11 checks |
| c1-dispose | PASS | file 2026-11-23T18:36:56.777Z · startedAt 2026-11-23T18:31:17.038Z · dist 2026-11-23T18:20:35.850Z |
| e2e-c1-K1 | PASS | {} |
| e2e-c1-K2 | PASS | {} |
| e2e-c1-D1 | BOOKED | the evict did not kill the control process tree of the evicted location - the plugin dispose hook did not run inside the leg window (probe silent): no verdict on the dispatch exemption \| dispose hook probe: {"ranInWindow":false,"secondsEvictToHook":null,"line… |
| c5-standard | PASS | file 2026-11-23T18:46:00.469Z · started 2026-11-23T18:36:56.952Z · dist 2026-11-23T18:20:35.850Z |
| e2e-c5-standard | PASS | legs A,B,BI,D · ceiling 900000ms = production default |
| c5-ceiling-C | PASS | file 2026-11-23T19:32:33.454Z · started 2026-11-23T19:27:55.361Z · dist 2026-11-23T18:20:35.850Z |
| e2e-c5-ceiling-C | PASS | leg C · ceiling 240000ms |
| crew-full | PASS | file 2026-11-23T20:28:02.599Z · startedAt 2026-11-23T20:22:40.996Z · dist 2026-11-23T18:20:35.850Z |
| e2e-crew-full | KNOWN | 15/16 checks; KNOWN DEFECT closeGateAskedAndApproved: F: crew_close executes WITHOUT its user-confirmation ask on the v2 host when no goal governs the session (the v2 permission belt's door set has no cre… |
| tui-headed | PASS | 6 items · checked 2026-11-23T19:27:30.000Z · host 2.4.0 |
| live-typecheck | PASS | no errors |
| live-unit-suite | PASS | 1009/1009 pass |
| live-host-version | PASS | opencode v2.4.0 |
| no-secret-in-evidence | PASS | checked 8 files |

## Booked legs (D6 — not a pass)

- **e2e-c1-D1** — D6 — the sandbox host (2.4.0) offers no action proven to run the plugin dispose hook while a dispatch is in flight. the evict did not kill the control process tree of the evicted location - the plugin dispose hook did not run inside the leg window (probe silent): no verdict on the dispatch exemption | dispose hook probe: {"ranInWindow":false,"secondsEvictToHook":null,"lines":[],"note":"probe lines are written by the plugin's dispose hook / exit matrix when they run (build 2026-11-23T16:5xZ+); none = neither ran inside this leg's window"}

## Known defects this release ships (accepted by name — NOT a pass)

- **e2e-crew-full** · check `closeGateAskedAndApproved` — F: crew_close executes WITHOUT its user-confirmation ask on the v2 host when no goal governs the session (the v2 permission belt's door set has no crew_close; present since the 2026-11-19 v2 port; reproduced 2026-11-23 19:55Z, logs/probe-crew-close-door.json; tracked as fix-crew-close-ask-door)

