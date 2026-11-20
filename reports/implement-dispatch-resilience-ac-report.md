# harden-dispatch-resilience — Block A + Block C implementation report

Date: 2026-11-21 · Branch: main · Baseline: 742 tests → final **774 pass / 0 fail** (+32 new), `bun run typecheck` green, `bun run bundle` committed.

Scope per dispatch: **Block A (active-textful completion override, design D1) + Block C (provider gate + circuit breaker, design D3), tasks 2.1 / 3.1–3.3 / 5.1 / 5.2 / 5.4.** Block B (4.1/4.2/5.3 — `createChildSession` taskDeny + QUESTION_DENY migration) was **NOT touched** (awaits the crew change E2E); no code in `createChildSession` / `QUESTION_DENIED_SESSION_PERMISSION` was modified.

## Changed files

| File | Change |
| ---- | ---- |
| `src/dispatch-async.ts` | `activeTextfulTicks` on `TerminalStabilityState`; `ACTIVE_TEXTFUL_OVERRIDE_NOTE` export; `pollChild` override branch (readable-status-active ∧ finish ∧ non-empty text → COMPLETE at the same 3-tick window, `via: "active-textful"`); `PollResult.completed.via?` |
| `src/dispatch-gate.ts` (new) | Pure-logic gate: live counters (provider + provider/model), breaker state machine (closed → open at N consecutive failed terminals → half-open after cooldownMs, one probe → closed on success / re-open on failure with cooldown re-armed and streak carried), injectable clock, `updateConfig` hot-apply preserving live state, verbatim refusal builders. Zero @opencode-ai imports |
| `src/forge-config.ts` | `DispatchNodeConfig` + `validateDispatchNode` (field-level fail-soft, warn findings, never throws) + `mergeDispatchNodes` (per map key / per breaker field); loader parses the per-layer `dispatch` node and cascade-merges global base + project override onto `LoadedForgeConfig.dispatch` |
| `plugin.ts` | A wiring: override disclosure on the sync tool output, async job tail, and terminal journal reason; respawn resets `activeTextfulTicks`. C wiring: gate singleton (`gateFor(anchor)` hot-applied via an anchor-keyed cascade loader); `journalTerminalRecord` feeds admitted terminals (completed → success; error/stream-lost → failed; aborted/stale → neutral) and releases slots; dispatch call admits **before child creation** (queued wishes check-and-release); `pumpDispatchQueue` re-checks at dequeue; session→model capture at `chat.params` + v2 `session.context` (pinned pool lookup first — same chain as chat.params — session-model fallback); `session.deleted` eviction; test seams `dispatchGateState` / `resetDispatchGate` |
| `tests/dispatch-async.test.mjs` | +7 Block A poller tests |
| `tests/dispatch-gate.test.mjs` (new) | 11 module tests |
| `tests/dispatch-gate-wiring.test.mjs` (new) | 8 wiring tests (A + C) |
| `tests/forge-config.test.mjs` | +8 dispatch-node tests |
| `dist/index.js` | rebuilt (self-contained, committed) |
| `openspec/changes/harden-dispatch-resilience/tasks.md` | ticked 2.1, 3.1–3.3, 5.1, 5.2, 5.4 |

## Task status

- **2.1** ✅ override branch in `pollChild`, same 3-tick window, wake text discloses "completion established from the message stream while the status view lagged" (constant asserted verbatim in tests). Design correction applied: an **unreadable** status map never advances the run — only a *readable map listing the child active* does (preserves the existing soundness test "status fetch FAILING every tick → honest timeout").
- **3.1** ✅ `src/dispatch-gate.ts` (pure, injectable clock, no @opencode-ai).
- **3.2** ✅ forge.json `dispatch` node: `providerConcurrency` / `modelConcurrency` maps + `circuitBreaker {consecutiveFailures, cooldownMs}`; cascade-merged; field-level fail-soft (bad value → drop + warn finding, never throw); absent node = unlimited.
- **3.3** ✅ fed at `journalTerminalRecord` (agent→model: pinned pool lookup → session-model fallback via the chat.params/session.context capture); enforced before child creation; **dequeue re-check** in the pump; refusals verbatim (mechanism + counted dimension + current value + recovery condition); breaker refusals throw as the plugin's own throttle before anything spawns — the provider-retry classifier is never consulted.
- **5.1 / 5.2 / 5.4** ✅ (5.3 = Block B, untouched).

## Tests (names)

Block A (dispatch-async.test.mjs):
- active-textful override: status stuck busy + finished textful message → COMPLETE at the same 3-tick window, via=active-textful
- active-textful override: a flapped run resets — busy-with-text then busy-without-text never completes
- active-textful override: stuck-active with NO text stays honest (existing timeout semantics govern)
- active-textful override: the healthy not-active path is UNCHANGED (no via flag)
- active-textful override: an UNREADABLE status map never advances the run (soundness posture intact)
- active-textful override: the streak survives poll-slice boundaries via the shared stability state

Block C module (dispatch-gate.test.mjs):
- unconfigured gate admits without limits (absent node = today's behavior)
- provider concurrency: boundary refusal is VERBATIM; release re-admits
- model concurrency: the provider/model dimension refuses verbatim
- breaker: closed → open at N consecutive failed terminals; refusal verbatim; cooldown gate
- breaker: half-open admits exactly ONE probe; failure re-opens with the cooldown re-armed; success closes
- breaker: neutral outcomes (user aborts, stale kills) never feed the streak; success resets it
- breaker disabled unless consecutiveFailures is configured
- release clamps at zero
- hot-apply (updateConfig) swaps the limits while live counters and breaker state survive
- modelKey + verbatim string contracts hold their exact shape

Fail-soft parse (forge-config.test.mjs): dispatch node absent/non-object/valid/bad-map-values/bad-breaker-fields/mergeDispatchNodes/loader-cascade/loader-fail-soft (8 tests).

Wiring (dispatch-gate-wiring.test.mjs):
- A (wiring, sync): stuck-active child with the final text out → completes with the override disclosure in the tool output
- A (wiring, async): stuck-active+text → the terminal journal record carries the override disclosure
- A (wiring): stuck-active with NO text stays honest — no completion invented (sync wait budget governs)
- A (wiring): a healthy child is unaffected (ordinary completion, no override disclosure)
- C (wiring): the terminal seam feeds the counters — a live child holds the provider slot; a refusal is VERBATIM; the next terminal re-admits
- C (wiring): queued wishes RE-CHECK the gate at dequeue — a hot-applied tightening fails the wish as an honest error wake
- C (wiring): the breaker opens on consecutive failed terminals and refuses BEFORE child creation (never provider-retry)
- C (wiring): a malformed dispatch node refuses NOTHING (fail-soft — never a parse-failure refusal)

## Commits (this task)

- `57aba9d` src: pollChild active-textful completion override (harden-dispatch-resilience 2.1)
- `0f75c4b` src: provider dispatch gate module + forge.json dispatch node (harden-dispatch-resilience 3.1/3.2)
- `5a7810f` plugin: wire the completion override disclosure + the provider gate feed/enforcement (harden-dispatch-resilience 2.1 wiring + 3.3)
- `06fa941` tests: dispatch resilience blocks A+C (harden-dispatch-resilience 5.1/5.2/5.4); tick tasks 2.1/3.1-3.3/5.1-5.2/5.4
- `3b219b2` chore: rebuild dist (harden-dispatch-resilience blocks A+C)

Note: `plugin.ts` is one shared file, so Block A's wake-disclosure wiring and Block C's feed/enforcement land together in `5a7810f` (each block's core is still an independent revert unit: A = `src/dispatch-async.ts` branch + the three disclosure call sites; C = `src/dispatch-gate.ts` + `src/forge-config.ts` node + the gate call sites). A concurrent `docs:` commit (`f696ecf`, another session) landed underneath; the full suite was re-run green after it.

## Boundaries respected

- `createChildSession`, `QUESTION_DENIED_SESSION_PERMISSION` / `QUESTION_DENY_PERMISSIONS_V2`, and the v2 forwarding-key list: **untouched** (Block B).
- No push, no publish, no npm pack; no spec outside the harden change modified; journal format, stale reaper, retry classifier, job-supervisor registry unchanged (breaker is in-memory per design non-goals).
