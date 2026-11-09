# Tasks: search-glob-anchor

## 1. Specification

- [x] Delta: ADDED requirement "Explicit path anchors pattern and output" (3 scenarios: anchored explicit-dir find / cross-engine agreement / default+file roots unchanged); strict validation passes

## 2. Implementation (`plugin.ts` `runSearch`)

- [x] rg leg: explicit DIRECTORY target → spawn `cwd = target`, path argument `"."`; FILE target and default root unchanged
- [x] JS leg: explicit DIRECTORY target → records walk-relative verbatim (drop the `join(root, rel)` prefix branch); FILE/default unchanged
- [x] Dedupe resolver keyed to the effective root (`targetDir ?? state.worktree`); `worktreeRoot` disclosure comparison unchanged
- [x] README one-liner pinning the anchoring semantics

## 3. Tests

- [x] rg-present regression: anchored `*/tasks.md` + explicit dir → listed relative (fails on 0.21.0)
- [x] Cross-engine consistency: identical fixture/pattern/path on rg leg and scrubbed-PATH JS leg → identical path sets (JS copy + footnote)
- [x] grep-leg anchored `include` + explicit dir; file-root and default-root regressions unchanged
- [x] Full suite + typecheck green (506/506, 0 errors)
- [x] Live dual-leg spot check caught the JS translator conflating `*/` with `**/` (single-star-before-separator and mid-segment star runs); translateGlob star-kind disambiguation + two-level fixture rows + `src/*.ts` within-segment rows (508/508)

## 4. Release

- [ ] 0.21.2 (translator fix folded in), bundle, pack = 3 files, publish, store update, push
- [ ] Live dual-leg spot check: `opencode run` same anchored query with normal PATH (rg leg) and scrubbed PATH (JS leg) — identical relative results, JS copy footnoted
