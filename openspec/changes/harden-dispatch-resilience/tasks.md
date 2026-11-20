# harden-dispatch-resilience — tasks

## 1. Probes

- [ ] 1.1 Create-body task-deny effectiveness probe (independent of the
  crew change): sandbox serve + directory-discovery probe plugin, create a
  child with the task-tool deny riding the create body, observe the
  child's tool surface (message-parts tool listing or probe echo) —
  evidence archived into this change's dir (feeds D2).

## 2. Block A — active-textful completion override

- [ ] 2.1 `pollChild`: track `activeTextfulTicks` (status active ∧ finish
  ∧ non-empty text), verdict COMPLETE at the same 3-tick stability window
  with a wake text disclosing the message-stream override. Independent
  commit.

## 3. Block C — provider gate + circuit breaker

- [ ] 3.1 `src/dispatch-gate.ts` pure-logic module: live counters
  (provider, provider/model), breaker state machine (closed → open at N
  consecutive failed terminals → half-open after cooldownMs → close on
  success / re-open on failure), injectable clock, no @opencode-ai
  imports.
- [ ] 3.2 forge.json `dispatch` node: cascade-merged maps +
  circuitBreaker, field-level fail-soft (bad value → drop + warn
  finding), absent node = unlimited. (src/forge-config.ts)
- [ ] 3.3 Feed + enforce: `journalTerminalRecord` feeds counters
  (agent→model via the pinned-model pool lookup, session-model fallback);
  dispatch pump refuses before child creation; queued dispatches re-check
  at dequeue; refusal strings verbatim per spec; breaker refusals
  classified as plugin throttle (never provider-retry).

## 4. Block B — nested-dispatch guard (AFTER the crew change merges)

- [ ] 4.1 Fix the async question-deny no-op (probe 1.1 finding): migrate
  QUESTION_DENIED_SESSION_PERMISSION to the v2 array spelling
  (`permissions: [{action, resource, effect}]`) and add `permissions` to
  the v2 session-client forwarding-key list (`plugin.ts:6548`). Own
  commit — a standalone bug fix the guard rides on.
- [ ] 4.2 `createChildSession` gains `taskDeny` create-body option (v2
  array spelling, per probe-1.1-evidence.md); caller rule: non-forge
  target ∧ `dispatchProviderFamily(...) === "anthropic"` → set it.
  Independent commit, sequenced behind `fix-v2-crew-surface-drift`.

## 5. Tests

- [ ] 5.1 Block A: stuck-active+text → override completes; stuck-active
  no-text → stays honest; healthy child unaffected.
- [ ] 5.2 Block C: module tests (bounds, breaker transitions, half-open,
  fail-soft parse); wiring tests (terminal feeds, pump refuses, dequeue
  re-check, refusal strings verbatim).
- [ ] 5.3 Block B: guard rule matrix (non-forge+anthropic → deny rides;
  non-forge+other → untouched; forge-* → untouched by this guard).
- [ ] 5.4 `bun run typecheck`; `node --test tests/*.test.mjs` all green
  (735+ baseline, zero regressions); `bun run bundle` (dist committed).

## 6. Verify + release

- [ ] 6.1 `openspec validate --all`; git+file official-install verify per
  AGENTS (round-trip paired, general-agent channel); version bump + npm
  publish ONLY after user approval.
