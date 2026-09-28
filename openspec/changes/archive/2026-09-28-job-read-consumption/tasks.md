# Tasks — job-read-consumption

## 1. Supervisor core

- [x] 1.1 `src/job-manager.ts` `poll()`: when the polled job is terminal — set `readAfterEnd`, remove the entry from the registry, and `rememberConsumed(id)` (the stale-id machinery answers follow-up verbs). Non-terminal polls unchanged. Verify: job-manager unit tests — terminal poll consumes + drops queued wake; non-terminal poll retains. — DONE.
- [x] 1.2 `plugin.ts`: forge_jobs description poll clause gains "polling a finished job consumes it (the entry self-clears and no wake fires)". Verify: read-through. — DONE.
- [x] 1.3 (D6, discovered in E2E) wake push during idle: manager fires `onWakeQueued` at wake queueing; the wiring tracks believed-idle sessions (chat.message → busy, session.idle → idle; unknown → conservatively busy) and delivers immediately for idle-known sessions, so a completion landing after the starting turn ended is not abandoned to the delivery window. Verify: manager hook test + wiring "pushed immediately (no further idle edge needed)" test. — DONE.

## 2. Tests

- [x] 2.1 `tests/job-manager.test.mjs`: terminal poll → entry gone + queued wake dropped + `consumed(id)` true; wake-already-delivered then poll → self-clears; non-terminal poll → no consumption; `list`/`log` never consume. — DONE (three tests).
- [x] 2.2 `tests/job-wiring.test.mjs`: background job polled to terminal → no `[forge:job-complete]` on idle and `list` empty; background job never polled → wake still fires once. Existing wake-engine test (background, no poll) stays green. — DONE, plus the D6 immediate-push wiring test.

## 3. Docs

- [x] 3.1 README: completion-behavior table background/early-return rows note "wake fires only if the completion was never polled; a terminal poll consumes the entry"; Exit wakes paragraph gains the poll-consumption sentence. — DONE.

## 4. Verification

- [x] 4.1 Full regression: typecheck + `node --test tests/*.test.mjs` green; `openspec validate --all` clean. — DONE: 268/268, validate 9/9.
- [x] 4.2 E2E (real environment, npm channel after release): `scripts/job-wake-e2e.mjs` phase B rewritten — (a) background job polled to terminal → no wake, list empty; (b) background job never polled → exactly one wake on idle. Evidence appended to verify/e2e.md. — DONE on 0.9.1: B1 silent + self-cleared, B2 woke once via the D6 completion-time push. Note: 0.9.0 was published before D6 surfaced in the first B2 run and is superseded by 0.9.1.
