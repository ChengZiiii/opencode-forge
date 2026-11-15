# Acceptance: sync-timeout-notify fold #2 — 0.23.3 (never-die tracking + progress notices)

Date: 2026-11-15 (evening run). Build under test: **npm store install of the PUBLISHED 0.23.3** (post-publish testing per the closed-loop discipline).

## Deterministic layer

- Full suite **566 pass / 0 fail** (baseline 556 → +10: 5 `resolveNotifyIntervalMs` unit + 5 wiring), `bun run typecheck` exit 0 — first-hand re-run, not trusted from the coder report.
- `openspec validate sync-timeout-notify --strict` valid (fold #2 delta: never-die SHALLs, progress-notice scenarios, textless-idle floor, `FORGE_DISPATCH_NOTIFY_INTERVAL_MS`).

## Release layer

- Commit chain: `feat(dispatch): never-die tracking + [forge:dispatch-progress] notices + textless-idle floor …; tests 566` → `chore: release 0.23.3`.
- `npm pack --dry-run` = 3 files; publish `+ @sorenllm/opencode-forge@0.23.3`; REST dist-tags flip observed (`REST-FLIPPED latest=0.23.3 (attempt 8)`, ~2.5 min).
- Store: `npm cache clean --force` then unpinned `opencode plugin "npm:@sorenllm/opencode-forge" --global` → **store version 0.23.3**; dist markers: `forge:dispatch-progress` ✓, `textlessIdleSince` ✓, `FORGE_DISPATCH_NOTIFY_INTERVAL_MS` ✓; case-insensitive `poll timeout after` count in dist = **exactly 1** (the SYNC WAIT throw only — the poller deadline text is gone).
- git push `main -> main` attempt 1; HEAD == origin/main.
- Pitfall dodged (last release's lesson): npm packument cache still serving the stale dist-tags at install time — cache-clean before the store install this time.

## Live replay layer (the closed loop)

Serve: `opencode serve --port 47631`, `OPENCODE_CONFIG_DIR=stn-config` (plugin spec `npm:@sorenllm/opencode-forge` → the STORE build), env `FORGE_DISPATCH_POLL_TIMEOUT_MS=5000`, `FORGE_DISPATCH_NOTIFY_INTERVAL_MS=15000`, `FORGE_DISPATCH_POLL_INTERVAL_MS=1000`, `FORGE_DISPATCH_POLL_SLICE_MS=2000`. Children: tool-free essay sleepers on `forge-plugindev-spec-reviewer` (why tool-free: pitfall #4 below).

| REP | Replays | Result | Evidence |
| --- | --- | --- | --- |
| A | R1/R2 sync orphan (0.23.1 fix) + K3 long-armed (fold #2) | **PASS** | sync throw at 5s, finding verbatim: `Poll timeout after 5000ms — child session ses_e1f4041a1ffevbgJvCHoFv8Zny never reached a terminal state … Completion tracking is ARMED — exactly one [forge:dispatch-complete] wake carrying the final report arrives when the child finishes, however long it takes (interim [forge:dispatch-progress] notices may arr…`; **5** progress notices; **exactly one** completion wake carrying `REP-A-DONE-233` (parent `ses_e1f4060b2ffeOaNxkCOp0oT7Vb`) |
| B | K3/K2 async long child | **ALL-PASS** | no timeout finding; **8** progress notices; exactly one wake with `REP-B-DONE-233` (parent `ses_e1f3dd8abffe3gDgLK5xIhi1Cu`, child `ses_e1f3dc322ffeji0lL8Kj4bX87a`) |
| C | K1a control (short async) | **ALL-PASS** | exactly one wake with `REP-C-DONE-233`; **zero** progress notices — no notice noise on short jobs |
| D | W2 receipt-as-final (soundness) | **ALL-PASS** | receipt-first child; exactly one wake carrying the TRUE final (`REP-D-DONE-233`); no receipt-only wake (parent `ses_e1f3a6594ffeOnZdiW7tJ1RoAg`) |
| E | aborted child (floor family) | **PASS (honest terminal via explicit error path)** | direct child abort (HTTP 200) → exactly one wake: `Final report: (child session ended in error: MessageAbortedError: Aborted)` — no fake report. The abort surfaces an explicit error state, so pollChild's immediate error verdict (spec: explicit, not inferred) short-circuits before the floor; the floor itself (`textlessIdleSince` ≥ notify interval on a silently-textless idle child) is covered deterministically by the wiring test. Parent `ses_e1f34eec1ffeTpqrh7UziKyFoB`, child `ses_e1f34d7ccffeYRoeHD51FizM17` |

Verdict line from the driver: REP-A verified via direct session probe (driver capture bug below), B/C/D ALL-PASS in-driver, E honest-terminal. **Every production pitfall from 0.23.1–0.23.3 replays green on the published build.**

## Pitfall ledger (this round — for the next person)

1. **Substring classify trap**: the progress-notice text deliberately names the `[forge:dispatch-complete]` marker, so `includes()` mis-buckets — classify by `startsWith()`. (Hit twice: in the wiring tests by the coder, then in my first driver.)
2. **Message-level dedupe hides tool-part state transitions**: a task tool part updates IN PLACE (`pending → error`) on the same assistant message; dedupe by message id never revisits it. Dedupe by part id + status. (Cost: one REP-A false-negative and a re-probe.)
3. **Headless forge_shell hang — product gap, NOT a dispatch bug**: `gate(context.ask, "forge_shell", …)` (plugin.ts:1640) is the two-piece permission posture — plugin tools bypass permission evaluation, so `context.ask()` fires and the config hook injects the matching ask rule for a real dialog. In serve mode nobody answers: children stuck at `forge_shell:running` forever even with `"permission": {"forge_shell": "allow"}` in the sandbox config. Reproduced twice (2026-11-15 47621 round and this round). Needs its own change: headless liveness for read-class worker commands. Workaround for sandbox repros: tool-free children.
4. npm packument cache staleness on store installs right after publish — `npm cache clean --force` before `opencode plugin …`.
5. REST dist-tags flip latency ~2.5 min (poll, don't trust the publish exit).

## Residual

- texture-forge host (serve 56992) runs 0.23.2 — after the user restarts it, fold #2 behavior (progress notices + never-die) activates there.
- `sync-timeout-notify` archive: all tasks ticked; awaits the user's explicit archive instruction per discipline.
