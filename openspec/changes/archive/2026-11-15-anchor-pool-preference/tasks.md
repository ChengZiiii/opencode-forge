# Tasks — anchor-pool-preference

- [x] 1. Resolver conflict rule (`plugin.ts`)
  - [x] 1.1 In `resolveSessionAnchorForPools`: resolve BOTH the authoritative anchor (record, non-rootish) and the map binding; SAME path → authoritative; authoritative POOL-LESS + map different non-degenerate POOLED → return the map binding with ONE bounded disclosure per session (`anchorPrefNotes` set, evicted on session.deleted; copy names both paths + "pooled binding wins"); every other shape → authoritative (0.18.0 semantics untouched)
  - [x] 1.2 No other guard logic, gate copy, or map write-back changes; the seam stays read-only

- [x] 2. Tests (`tests/hierarchical-pools.test.mjs`, authoritative-anchor matrix)
  - [x] 2.1 Case (e) — resume-rebind shape: record carries a pool-less launch dir, map holds the pooled workspace → own-pool dispatch ALLOWED (was refused pre-fix); cross-pool target from the same session STILL refused (preference ≠ leak); the bounded disclosure fires exactly once with the pinned copy prefix
  - [x] 2.2 Regression re-asserts: record pooled + map different → record wins (existing case (a) unchanged); record unavailable → map decides (case (b)); unknown-everything fail-open (case (b)) — all green untouched

- [x] 3. README + gates
  - [x] 3.1 README troubleshooting/anchor paragraph: the pooled-preference rule + its disclosure
  - [x] 3.2 `bun run typecheck` — clean
  - [x] 3.3 `node --test tests/*.test.mjs` — full suite green (473 baseline + new, zero regressions)
  - [x] 3.4 `bun run bundle` + `npm pack --dry-run` — whitelist exactly dist + README.md + package.json
