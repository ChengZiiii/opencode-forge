# Design: pool-rebind-on-resume

## Context

`resolveSessionAnchorForPools` (plugin.ts ~line 800) resolves the dispatching session's anchor for both the session-domain pool gate and the crew compliance gate. Current chain:

1. `client.session.get` → `effectiveWorktree(rec?.worktree, rec?.directory)` → `authoritative` (if non-rootish).
2. `sessions.get(sessionID)?.worktree` → `mapped`.
3. If `authoritative === ""` → return `mapped`.
4. Anchor-pool-preference (0.20.0 rule): when `mapped` is a DIFFERENT non-degenerate worktree owning a pool and `authoritative` owns none, `mapped` wins (+ one bounded disclosure).
5. Otherwise `authoritative` wins.

The both-degenerate shape (restart → empty map; cross-launch resume → pool-less record) returns the pool-less `authoritative`, the gate computes `allowed = globalPoolPathOf()`, and an own-pool target is refused.

## Goals / Non-Goals

**Goals**
- A restart-resumed session with a pool-less record and an empty map regains its OWN pool's dispatch rights from persisted evidence.
- Cross-pool isolation, fail-open for unknown anchors, and pool-deletion semantics are bit-for-bit preserved.

**Non-Goals**
- No change to pool resolution/materialization, hot-apply, or the crew gates' logic.
- No per-session persistence beyond the bounded ledger; no background jobs, no timers.
- No attempt to fix the HOST's resume-rebind behavior (the record carrying the new launch directory is opencode's domain).

## Decisions

### D1 — One global plugin-namespaced ledger file, not per-workspace ledgers

`<os-tmp>/opencode-forge/session-anchors.jsonl` (the namespace dir is already the plugin's sanctioned runtime-artifact home — dispatch journal precedent). A single file means the gate miss path is ONE lookup; per-workspace ledgers would additionally need a persisted workspace registry to know where to look (the post-restart seen-set is empty too) — more moving parts, same evidence.

*Alternative rejected*: reading opencode's own session storage directly — the resumed record itself mutates to the new launch directory (that is the bug's face), so there is no disk truth there to read.

*Trust note*: the ledger lives where anyone with FS access can edit it, exactly like `.opencode/forge.json`; it grants nothing the user could not configure directly.

### D2 — Write policy: pooled bindings only, append + dedup, FIFO cap

The ledger records ONLY positive evidence: a bind/seed/re-bind that lands on a worktree where `sessionPoolFileOf(worktree) !== null`. Entries `{ sessionID, worktree, ts }`; a re-bind appends and readers take the LAST entry per sessionID; when the file exceeds a cap (200 entries) it is rewritten to the latest-entry-per-session set. Write failures (and the compaction rewrite) are fail-soft: swallowed with a one-time warn, never thrown into the bind path.

### D3 — Resolution position: after the existing chain fails to yield a pooled anchor

New order: (1) mapped-pooled win (the 0.20.0 preference rule, untouched); (2) authoritative pooled win (today's precedence); (3) NEW ledger consult — when the resolved anchor owns NO pool and the ledger's last entry for the sessionID names a worktree that STILL owns a pool file on disk (`sessionPoolFileOf` at resolution time): re-bind (seed the in-memory map, non-degenerate refinement semantics), return that anchor, one bounded disclosure per session (`poolGateLedgerNotes`); (4) today's fallback (authoritative / mapped), unchanged.

The disk-truth check is what keeps deletion honest: if the ledger's worktree pool file has been deleted, the hit is discarded and resolution lands exactly where today lands (global fallback gate).

*Alternative rejected*: fail-open on the both-degenerate shape — it would weaken cross-pool isolation for every genuinely pool-less resumed session to fix one artifact; the ledger restores correctness without giving up evidence-based gating.

### D4 — Crew compliance inherits automatically

`crewComplianceRefusalFor` resolves through the same `resolveSessionAnchorForPools` chain; the ledger consult lands inside it, so both gates re-bind identically. The compliance belt's file-level pool re-check runs on the re-bound anchor — no separate wiring.

### D5 — Test seams

Ledger path + fs via an injectable seam (the dispatch journal's `setDispatchJournalFs` precedent): `FORGE_TEST_FORGE_HOME` tests namespace the tmpdir; the seam lets the suite point the ledger at a per-test path and simulate IO failures without touching the real tmpdir.

## Risks / Trade-offs

- **Stale ledger grants a moved session its old pool** → only if the session id collides AND the old pool file still exists; a session genuinely relocated keeps its own-pool rights it demonstrably had pre-restart — the same trade the 0.20.0 preference rule already makes for live bindings.
- **Ledger growth** → FIFO cap 200, compaction on overflow, pooled-bindings-only writes.
- **IO latency on the gate path** → one small-file read, cached per session after first hit (re-seeded map), fail-soft.
- **Spec drift** → the delta text pins the resolution position, verification, disclosure, cap, and fail-soft contract verbatim.

## Migration

None — additive; first pooled bind after deploy populates the ledger; existing sessions regain rights on their first post-restart dispatch.
