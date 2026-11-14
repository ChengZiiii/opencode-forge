# Tasks: async-dispatch

## 1. Specification

- [ ] Deltas (REMOVED prohibition + ADDED forge_dispatch surface + ADDED async lifecycle) written; `openspec validate --strict` passes

## 2. Spike

- [x] Verify on our pinned @opencode-ai/plugin+sdk versions: `client.session.create` (parentID + directory), prompt send with materialized agent id, session status polling, session abort; record exact call shapes in design.md

## 3. Core (`src/dispatch-async.ts`)

- [x] Pure/injectable core: child-session create (parentID link + question-deny session permission, titled `[dispatch] <desc> (@<agent>)`), prompt send, status poller, final-message fetch, abort, wait-mode timeout

## 4. Tool + gates (`plugin.ts`)

- [x] Register `forge_dispatch` (mode param; description carries the dispatch-time decision guidance + no-pre-wake-polling rule); getter removal under disable knob
- [x] Gate wiring inside execute: session-domain pool gate + crew pending/compliance gates + primary-only + per-session async cap (3) + plan-draft shape exemption parity (readonly-only, both modes)

## 5. Wake + lifecycle

- [x] Async completion wake via the job-wake path: idle-only, at-most-once, delivery window, child's final message inline; registry entry (kind=dispatch) with session-death harvest (child abort + ledger)

## 6. Tests

- [x] Core unit tests with fake client (create/send/poll/fetch/abort/timeout; question-deny permission asserted in the create body)
- [x] Wiring: registration + disable removal; gate matrix (cross-pool refuse, crew pending, primary-only, cap, draft readonly pass both modes, draft write refuse both modes, write-target async accepted)
- [x] Wake: single idle injection with final message; busy-window ledger overflow; owner-death harvest

## 7. Docs

- [x] README dispatch section: forge_dispatch modes, all-shapes async + question-deny rationale, permission-ask-degrades-to-timeout disclosure, native TUI abort affordance, native-task coexistence note

## 8. Release

- [ ] Version bump, typecheck, full suite, bundle, pack = 3 files, publish, store update, push
- [ ] Live verify on a real host: wait dispatch returns result; async dispatch handle → wake with result; child session visible in session tree
