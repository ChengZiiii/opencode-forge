# Design — anchor-pool-preference

## Context

`resolveSessionAnchorForPools` (plugin.ts ~:2591) is the ONE anchor seam feeding both the task pool gate
and the crew compliance belt. Order today: authoritative host record (`client.session.get` →
`effectiveWorktree(worktree, directory)`, skipped when empty/rootish/throwing) → else the in-memory
`sessions` map. The 0.18.0 incident (degenerate map writers) made the record authoritative-first.

0.20.0 evening incident, live: after a restart+resume, the host record for this session carried the NEW
launch directory (pool-less, non-rootish) — the record itself was the degenerate source. The in-memory
map held the true pooled worktree (corroborated by live activity: forge_shell cwd, tool contexts).
Authoritative-first bound the wrong anchor → the session's roster resolved to the (nonexistent) global
fallback → every `forge-plugindev-*` dispatch refused. One parallel dispatch that raced through before
the record became fetchable flowed (fail-open map fallback), proving the two sources disagreed mid-turn.

## Goals / Non-Goals

**Goals**: restore own-pool dispatch rights for resume-rebound sessions; keep every 0.18.0 protection
(record pooled still wins; degenerate-map protections unchanged); keep the seam read-only; bounded
observability of the substitution.

**Non-Goals**: no gate copy changes; no map write-back; no cross-pool relaxation; no new disk state.

## Decisions

### D1 — Pooled-preference conflict rule (adopted)

In the resolver, after obtaining a valid non-rootish authoritative anchor AND the map's binding:

- If they are the SAME path (folded) → authoritative (unchanged behavior).
- If the authoritative anchor owns NO pool file (`sessionPoolFileOf(authoritative) === null`) AND the
  map binding is non-empty, non-rootish, a different path, AND owns a pool file
  (`sessionPoolFileOf(mapped) !== null`) → return the MAP binding. One bounded disclosure per session
  (new `anchorPrefNotes` set, same bounded-console pattern as `poolGateUnknownNotes`): names both paths
  and says the pooled binding won (resume-rebind shape).
- Every other conflict shape → authoritative (unchanged).

Why "prefer the pooled one" is sound in BOTH conflict shapes it can fire in:
(a) tonight's shape — the session never actually moved; its live activity keeps refreshing the map with
the real workspace (the record's launch dir is the rebind artifact); picking the map restores truth.
(b) a genuinely moved session — its OWN live activity rebinds the map to the NEW worktree (tool contexts
and chat hooks carry the current worktree), so the conflict disappears: map and record agree on the new
workspace. The stale-map-moved-session shape requires live activity to keep asserting the OLD worktree —
which is "still working there", not "moved".

### D2 — Same seam, both belts (adopted)

The rule lives inside `resolveSessionAnchorForPools` only. The task pool gate AND the crew compliance
belt consume the seam and get the fix for free; no other consumer changes.

### D3 — Bounded disclosure, not silence (adopted)

The substitution fires ONE `console.warn` per session (bounded set, `session.deleted` evicts): the
mis-binding is an observable anomaly, not a silent correction. Copy pinned by test.

### D4 — Rejected alternatives

- **Fail-open on the conflict (treat as unknown).** Reopens cross-pool leaks: a genuinely-moved session
  could dispatch its OLD pool's workers through the fail-open hole. Rejected.
- **Map-first when pooled (demote the record).** Reintroduces the 0.18.0 incident wholesale — the map's
  degenerate writers were the original disease. Rejected.
- **Write the corrected anchor back into the map.** The resolver is deliberately read-only (other map
  consumers keep their contracts — pool-gate-authoritative-anchor D2). Rejected.

## Risks / Mitigations

- **A session whose map binding is stale-pooled while the record is honestly pool-less** (moved away,
  map never refreshed): requires no live activity asserting the old worktree — at which point the map
  binding would have degraded through the existing writers anyway; residual risk accepted + the bounded
  disclosure makes every firing inspectable.
- **Disclosure noise**: once per session, only on the conflict shape.
- **Test drift**: the new matrix case pins the substitution copy prefix verbatim.
