# Tasks: pool-rebind-on-resume

## 1. Implementation

- [x] 1.1 Ledger store: module-level ledger path seam (`<os-tmp>/opencode-forge/session-anchors.jsonl`, injectable for tests), JSONL `{sessionID, worktree, ts}` read (last entry per sessionID wins), append-on-pooled-bind write with dedup rewrite + FIFO cap 200 compaction, all IO fail-soft (one-time warn, never throws into bind/dispatch paths)
- [x] 1.2 Bind-path wiring: every session bind/seed/re-bind that lands on a worktree owning a pool file (`sessionPoolFileOf(worktree) !== null`) appends a ledger entry (non-degenerate anchors only; degenerate writers never write)
- [x] 1.3 `resolveSessionAnchorForPools` extension: after the existing chain (mapped-pooled preference, authoritative precedence) yields an anchor owning NO pool, consult the ledger; a hit whose worktree still owns a pool file on disk re-binds the session (seed the in-memory map, non-degenerate refinement semantics), returns the ledger anchor, and discloses once per session (`poolGateLedgerNotes`); miss (no entry / pool file deleted / IO failure) keeps today's resolution exactly
- [x] 1.4 Disclosure copy: `[forge:pool] session <id>: dispatch anchor re-bound from the persisted session-anchor ledger (<worktree>) — the resumed session's authoritative record is pool-less and the in-memory map was empty (restart-resume rebind shape).`

## 2. Tests (tests/hierarchical-pools.test.mjs)

- [x] 2.1 Restart-resume re-bind: bind session → pooled worktree, simulate restart (fresh registry + empty map + pool-less session.get record), dispatch own-pool target → ALLOWED, ledger disclosure emitted once (second dispatch silent), in-memory map re-seeded
- [x] 2.2 Cross-pool still refused from a ledger-rebound session: ledger hit for pool A's worktree, dispatch pool B target → refused with the not-dispatchable copy
- [x] 2.3 Deletion semantics: ledger hit whose worktree pool file was deleted → resolution keeps the global-fallback gate (own-pool target refused, unknown-anchor fail-open unchanged)
- [x] 2.4 Fail-soft IO: ledger read/write throws → dispatch path unaffected (today's resolution + no crash), warn surfaced once
- [x] 2.5 Cap compaction: >200 entries → file rewritten to latest-per-session set; last-entry-wins on re-bind
- [x] 2.6 Live chain unchanged: mapped-pooled preference and authoritative precedence still win over a stale ledger entry (no regression on the 0.20.0 scenarios)

## 3. Validation & release

- [x] 3.1 `bun run typecheck` clean; targeted suites green; `bun test` full suite green
- [ ] 3.2 `bunx openspec validate pool-rebind-on-resume --strict` clean; pre-archive `validate --all` clean
- [ ] 3.3 README pool/dispatch section: one-line note that a restart-resumed session re-binds from the persisted anchor ledger (bounded, plugin-namespaced, fail-soft)
- [ ] 3.4 Version bump + release commit + npm publish + push (publish flow per pitfalls §4.7: npm.cmd + shell:true, registry-fetch verification)
