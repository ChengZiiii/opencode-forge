# Tasks — hierarchical-pool-materialization

## 1. Implementation

- [x] 1.1 plugin.ts: replace the mutable `hostWorktree`/`forgeLoader` singleton with an append-only **anchor set** (server() appends its effective directory, deduped and normalized; first entry = primary; nothing ever removes); the config hook materializes from the union snapshot — anchor flips can no longer mutate the vocabulary
- [x] 1.2 src/forge-config.ts: bounded subtree scan (pure, fs-injectable) — dependency skip-list (`node_modules`, `.git`, `dist`, `build`, `out`, `target`, `.cache`, `venv`, `.venv`, `__pycache__`, `coverage`), per-anchor scanned-directory budget (default 2,000), directory-mtime cache; returns pool families `{file, anchor}` for every `.opencode/forge.json` in the anchor's subtree; a sub-pool's own ancestor chain is not consulted
- [x] 1.3 src/forge-config.ts: `pool` field parsing and namespace derivation — `[a-z0-9-]` ≤24 chars, invalid → warn finding + sanitized directory-basename fallback; namespace collision across distinct files → deterministic first-seen-wins + suffix + error finding; pool identity = absolute file path (dedup across anchors)
- [x] 1.4 plugin.ts config hook: namespaced materialization — primary anchor's root pool keeps plain `forge-<id>` ids; every other family materializes as `forge-<ns>-<id>` with the global layer as per-family base; per-agent semantics (pinned pair / Auto, shapes, permissions, discipline, task deny, depth keying) identical for namespaced agents; file creation/deletion hot-applies via the existing mtime contract
- [x] 1.5 plugin.ts surfaces: `/crew` template roster grouped by pool with origin paths (primary marked); `crew_begin` origin disclosure enumerates pools; unconfigured gate = zero pools across the anchor set; residual mismatch disclosure reworded (no anchor covers the session-workspace file)
- [x] 1.6 plugin.ts onboarding texts: AI-assisted forge.json guidance (unconfigured refusal + crew onboarding) gains the pool-namespace proposal mandate (short, stable, directory-name-independent)

## 2. Tests

- [x] 2.1 Freeze: a second server() initialization with a different directory only ADDS pools — previously materialized agents survive; no surface reverts (the 14:24/14:26 tear regression test)
- [x] 2.2 Anchor-set accumulation: two anchors → both families materialized; single-anchor host byte-compatible with pre-change roster (plain ids only)
- [x] 2.3 Subtree scan: sub-pool discovered under the anchor; skip-list dirs ignored; budget caps the scan deterministically (BFS + lexicographic sibling order — which pools survive the cap is a function of the tree); new pool file hot-applies on the next config; deletion removes the family; broken pool file empties only its own family (error finding with parse location, others materialize)
- [x] 2.4 Namespaces: `pool` field wins over directory name; invalid `pool` degrades to finding + fallback; sanitized-basename algorithm (lowercase, charset-run collapse, trim, `pool` fallback); same file via two anchors materializes once; ns collision → deterministic order + incrementing suffix + finding; cross-family materialized-id collision → earlier pool wins, later skipped + finding; namespaced agent semantic parity (pinned model, shape permission minus recursion/task deny, discipline, depth keyed by materialized name)
- [x] 2.5 Surfaces: roster grouped by pool with origins; registration disclosure enumerates pools with the primary marked; unconfigured gate fires only at zero pools across the anchor set
- [x] 2.6 Full suite green (`node --test tests/*.test.mjs`), `bun run typecheck` clean, `bun run bundle` clean

## 3. Docs

- [x] 3.1 README: hierarchical pools chapter (anchor set, root 总管 pool, sub-pools, namespaces, `pool` field with AI-assist rule), anchoring section gains the two-axis table (host vocabulary axis vs session state axis), file-ledger forge.json row updated to mention subtree pool files
- [x] 3.2 AGENTS.md: plugin.ts and forge-config.ts rows updated (anchor set + freeze, subtree scan, namespaces, pool field)

## 4. Verification & release (gated on user go)

- [x] 4.1 `openspec validate hierarchical-pool-materialization --strict`; archive only on explicit user instruction AND after `align-forge-config-discovery` is archived (order dependency)
- [x] 4.2 Sandbox E2E on the built plugin: multi-pool host (root pool + sub-pool + second anchor) — roster grouping, crew dispatch of both plain and namespaced agents, freeze under re-init (scripts/e2e-hiero.mjs: real serve host, root+both sub-pools read, skip-list holds)
- [x] 4.3 Version bump, layered commits, push (proxy), npm publish, switch local global install, live smoke in the multi-project layout (0.13.0 published; local cache re-installed at session creation with all hierarchical-pool markers)
