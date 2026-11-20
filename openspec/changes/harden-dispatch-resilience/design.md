# harden-dispatch-resilience — design

## Survey anchors (HEAD baseline, 2026-11-21)

- `pollChild` `src/dispatch-async.ts:541-661` — dual-read verdict,
  AND-shaped: `not-active ∧ finish ∧ non-empty text` over a 3-tick window.
  Existing stuck-protections: explicit-error instant verdict (:623 — the
  pull model already bridges OMO #5294's late error; NOT copied), 30-tick
  dual-failure streak, textless-idle floor, 45-min stale reap.
- `forgeAgentDef` `src/dispatch-tiers.ts:96/106` — the single seam where
  `task: deny` is forced for every forge worker (v1 direct, v2 via
  `v2PermissionArray` from the same call). Non-forge host targets get no
  such treatment.
- `createChildSession` `src/dispatch-async.ts:116-146` — the single
  funnel behind all five spawn sites; already carries the QUESTION_DENY
  create-body precedent.
- Gates today: pool gate (session-domain), `ASYNC_DISPATCH_CAP=3` + queue
  10 (`plugin.ts:2078/2112`), crew stop caps, job/wake/poll budgets.
  Zero provider/model-dimension state anywhere; 429 classified RETRYABLE.
- `journalTerminalRecord` `plugin.ts:2351` — every terminal transition
  funnels here; outside the in-flight crew diff.

## Decisions

- **D1 — Active-textful override (block A):** inside `pollChild`, track
  `activeTextfulTicks` — ticks where the status map still says active BUT
  the finish + non-empty-text conditions hold. At the same 3-tick
  stability count the not-active path uses, verdict COMPLETE via a
  disclosed override path (wake text names it: completion established from
  the message stream while the status view lagged). No new timers, no
  config; the branch sits next to the existing stability window so sync
  and async inherit. Revert = delete the branch.
- **D2 — Nested-dispatch guard (block B):** `createChildSession(...,
  opts.taskDeny?)` — when true, the create body carries the task-tool deny
  permission. Caller-side rule: target is non-forge AND
  `dispatchProviderFamily(model) === "anthropic"` (existing helper,
  `plugin.ts:561`). **Probe 1.1 evidence (2026-11-21,
  probe-1.1-evidence.md): the create-body channel WORKS on 2.3.2 — a
  `permissions: [{action, resource, effect}]` array lands verbatim in the
  child's session record via both `POST /api/session` and the
  `ctx.session.create` plugin seam.** Two corrections the probe forced:
  (a) the LEGACY spelling `permission: [{permission, action, pattern}]` —
  which the existing QUESTION_DENIED_SESSION_PERMISSION uses — is
  SILENTLY DROPPED on 2.3.2: the async question-deny has been a no-op on
  v2 hosts; block B therefore also MIGRATES the question-deny payload to
  the v2 array spelling and adds `permissions` to the v2 session-client
  forwarding-key list (`plugin.ts:6548`) — its own commit, a bug fix the
  guard rides on. (b) the child-create seam for this change is
  `ctx.session.create` (flat single-object args, honors parentID/
  directory). Sequenced AFTER the crew change merges
  (`createChildSession` is in its diff); implemented as its own
  commit for clean revert.
- **D3 — Provider gate + breaker (block C):** new pure-logic module
  `src/dispatch-gate.ts` (counters, breaker state machine: closed → open
  at N consecutive failed terminals → half-open after cooldownMs → closed
  on first success / re-open on first failure). Fed in-process at
  `journalTerminalRecord` (agent→model resolution via the existing
  pinned-model pool lookup, falling back to the session's model when
  unpinned — same resolution chain chat.params uses). Enforced at the
  dispatch pump before child creation (queued dispatches re-check at
  dequeue). Config: optional `dispatch` node in forge.json (global OR
  workspace layer, cascade-merged maps, field-level fail-soft — bad values
  drop with a warn finding, never a throw); absent node = unlimited =
  today. Refusals are honest: name the gate/breaker, the counted
  dimension, and the recovery condition (cooldown elapse for the breaker;
  a slot freeing for the concurrency gate); breaker refusals are NOT
  retry-classified as provider errors (they are our own throttle).
- **D4 — Not doing:** `maxLiveDescendantsPerRoot` — the forge family's
  depth is structurally capped at ≤1 by `task: deny`; per-session cap
  already approximates per-root under that invariant. Revisit only if
  crew's native-fallback grows deep trees.

## Non-goals

- No changes to the stale reaper, retry classifier, or journal format
  (the breaker is in-memory; the journal stays the survival ledger).
- No cross-ledger reads (job-supervisor registry untouched).
- No new plugin.ts config surface beyond the forge.json `dispatch` node.
- Blocks land as independent commits; block B waits for the crew change
  (shared file), A and C may land first in either order.

## Test plan

- A: poller regression — status stuck active + final text readable →
  override completes at the stability window; status stuck active + NO
  text → stays honest (no false completion); healthy child unaffected.
- B: guard rule matrix (non-forge+anthropic → deny rides the create body;
  non-forge+other family → untouched; forge-* → untouched by this guard);
  probe evidence archived in the change dir.
- C: module tests (counter bounds, breaker transitions, half-open
  semantics, fail-soft config parsing); wiring test (terminal feeds
  counters; pump refuses when open; queued re-check at dequeue); refusal
  strings asserted verbatim.
- Full suite green (735+ baseline); `bun run typecheck`; `bun run bundle`.
