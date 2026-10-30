## Tasks — pool-gate-authoritative-anchor

- [x] 1.1 `ensureSession` no-degenerate-clobber guard: an existing non-degenerate binding is only overwritten by a non-degenerate anchor; unit tests for keep-good / refine-good / seed-from-degenerate paths
- [x] 1.2 Add `resolveSessionAnchorForPools(sessionID)` in plugin.ts: authoritative `client.session.get` (`effectiveWorktree(worktree, directory)`, D4 shape tolerance) → in-memory map fallback → null; never writes back to the map
- [x] 1.3 Rewire the task-dispatch pool gate (plugin.ts ~:2589-2615) to the shared resolver; refusal copy and fail-open disclosure unchanged
- [x] 1.4 Rewire the crew compliance belt's anchor (plugin.ts ~:2637-2646) to the same resolver
- [x] 2.1 Wiring tests: resumed-session scenario — no session.created, degraded map binding, stubbed record returns the pool workspace → own-pool dispatch ALLOWED
- [x] 2.2 Wiring tests: record fetch throws / no client → in-memory binding decides (cross-pool refusal copy intact); unknown-everything → fail-open disclosure intact
- [x] 2.3 Wiring tests: crew compliance gate uses the authoritative anchor (degraded map + record names wsC → compliance refusal names the right file)
- [x] 3.1 Deep E2E script fixes (interrupted-worker draft, 4 bugs): afterAB snapshot freshness; path matcher lower-case-only (no slash folding) for substring containment; :313 `api`→`api1` crash; catch default route plain end_turn for warmups (no dispatch recursion)
- [x] 3.2 Deep E2E new assertion (g): own-pool dispatch through the live belt SUCCEEDS (dispatch the session's own workspace-pool agent, expect completed not refusal)
- [x] 4.1 Gate: `bun run typecheck`, `node --test tests/*.test.mjs` all green, `bun run bundle`, `npm pack --dry-run` whitelist check
- [ ] 4.2 Deep E2E rerun: all verdicts PASS (a, f, c, d1, d2, e, g, b), exit 0; evidence JSON archived
- [ ] 4.3 Version 0.18.1, npm publish, postpublish E2E, verify note in the change's verify/ dir
