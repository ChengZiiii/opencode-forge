## Design — pool-gate-authoritative-anchor

### Context

0.18.0 shipped the session-domain pool gate reading only the in-memory `sessions` map.
Live evidence (two hosts, three sessions): sessions whose binding degraded
(resume-after-restart / degenerate tool contexts) lose their OWN pool's dispatch rights
and are refused with `roster is the global fallback`. The host's own session records are
correct the whole time — `client.session.get` returns the true `{ directory, worktree }`
(the goal engine already depends on this, plugin.ts:2098).

### Goals / Non-Goals

Goals:
1. The pool gate and crew compliance gate resolve the session anchor authoritative-first.
2. Degenerate anchors never clobber good in-memory bindings.
3. Positive own-pool dispatch coverage in the deep E2E (assertion g).

Non-Goals:
- Changing the refusal copy, roster semantics, or materialization (all verified correct).
- Reworking the session map's other consumers (plan/goal anchoring keeps its chain —
  `sessionAnchor`'s fallback order is a separate, older surface).
- Caching the authoritative record (task dispatches to forge-* are rare; a per-call
  local-IPC fetch is cheap and always fresh).

### Decisions

**D1 — Authoritative-first, in-memory fallback (not a repair write).**
The belt CALLS the record per dispatch; it does not write the result back into the
`sessions` map (avoids new racing semantics between belt reads and tool-context writes).
If the fetch throws / returns nothing / no client: fall back to the map, then to the
existing fail-open disclosure. Rationale: the map's other writers keep their contracts;
the belt simply stops trusting a source it cannot verify.

**D2 — One shared resolver, both gates.**
`resolveSessionAnchorForPools(sessionID)` (async): authoritative → map → null. The pool
gate and `crewPoolComplianceRefusal`'s call site both use it. The compliance gate
currently re-reads `bound.worktree` (plugin.ts:2641); unifying kills the same drift
class there.

**D3 — Degenerate-clobber guard in `ensureSession`.**
`if (existing)` keeps its binding unless the incoming anchor is non-degenerate
(non-empty, non-rootish). This preserves the legitimate refine path
(session.created seed → tool-context correction) while stopping the poison path.
`isRootish("")` is true, so empty never overwrites — matches.

**D4 — Shape tolerance on the record.**
`effectiveWorktree(record.worktree, record.directory)` exactly as the goal lazy-seed
casts it (`{ directory?, worktree? }`); anything else → treat as unavailable.

### Risks / Trade-offs

- **Async in the belt**: `tool.execute.before` is already async; the fetch adds one local
  IPC roundtrip per forge-* task dispatch. Acceptable (rare path). If the client stalls,
  the host's own tool timeout governs — no plugin-side timer added (fail-open only on
  error, and the fetch resolving null/throwing falls back synchronously).
- **Map/belt divergence window**: a session created mid-dispatch could see the record
  before any map write — that is the FIX working as intended.
- **Test surface**: wiring tests need a stubbed `client.session.get`; existing harnesses
  already inject `getSession` in goal-mode tests — mirror that seam.

### Migration Plan

Patch release 0.18.1. No config changes; strictly fewer false refusals. Users hit by the
0.18.0 symptom are unblocked by upgrading + restarting the host once (to load the new
dist); resumed sessions then resolve authoritatively per dispatch.

### Open Questions

None — the failure mechanism is fully evidenced (host log: correct directory records
alongside refused own-pool dispatches; maintainer session reproduced the identical
refusal).
