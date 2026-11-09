# Design: search-glob-anchor

## Context

rg 15.2.0 (win32-verified, likely platform-wide): with `--hidden` or `--follow` present and an ABSOLUTE root argument, glob anchoring lifts to the whole path — anchored patterns (`*/x`, `*/*/x`, `a/b`) match nothing; basename and `**/` patterns survive; the bare form (no hidden/follow) anchors root-relative correctly. Our defaults (follow+hidden true) + absolute target resolution (`join(worktree, path)`) make every explicit-directory anchored call a guaranteed silent miss on the rg leg. The JS leg anchors walk-relative (correct) → engines disagree. Bisect evidence: bare/abs=2 hits; hidden|follow/abs=0; dot-root+hidden+follow=2 hits.

## Goals / Non-Goals

- Goals: (1) identical anchoring + output semantics on both legs for explicit-directory paths; (2) zero behavior change for the default root and FILE roots; (3) dedupe/outside-disclosure correct under the new root keying; (4) cross-engine consistency pinned by tests; (5) 0.21.1 patch release.
- Non-Goals: changing `follow`/`hidden` defaults; translating user patterns (e.g. `**/`-prefilling — silently changes semantics); a JS-fallback retry when rg returns 0 rows (double execution, nondeterministic latency); fixing rg upstream.

## Decisions

### D1 — rg leg: cwd-swap instead of path-passing

When the resolved target is a DIRECTORY, spawn rg with `cwd = <target dir>` and the path argument `"."` (the exact shape every green test already exercises): anchored globs bind root-relative, output paths arrive `.\`-prefixed and the EXISTING `stripDotPrefix` turns them target-relative. No argv builder change (`buildRgFilesArgv`/`buildRgArgv` keep receiving the final path segment — the wiring feeds them `".")`. FILE targets keep today's absolute-argument shape (single-file scan, no traversal anchoring involved).

### D2 — JS leg: drop the absolute prefix for explicit directories

Wave-2 wiring prefixed explicit-target records with `join(root, rel)`; that branch is removed for DIRECTORY roots — records stay walk-relative verbatim (already the emission form). FILE roots (verbatim root string) and the default root (worktree-relative) unchanged. Result: rg and JS legs emit byte-identical path sets for the same query.

### D3 — Effective root keys the dedupe resolver

`reportedPathResolver(state.worktree)` joins non-absolute records against the WORKTREE — wrong once records are target-relative. The resolver is constructed per call with the EFFECTIVE root (`targetDir ?? state.worktree`). The follow-dedupe realpath merge then resolves link records under the actual search root; `worktreeRoot` for outside-disclosure keeps receiving `state.worktree` (disclosure semantics: what escapes the WORKSPACE), unchanged.

### D4 — Cross-engine consistency tests (the blind spot killer)

Same fixture tree + anchored pattern + explicit directory path, asserted twice: once with rg resolvable (real binary — fails on 0.21.0, the regression proof), once with scrubbed PATH (JS leg). Both assert the identical relative path set (and the JS copy additionally carries the footnote). Adds the missing explicit-path coverage class to the matrix (grep-leg `include` anchored variant included).

### D5 — README one-liner

The search section gains: explicit-directory `path` anchors both the pattern matching and the reported paths to that directory; default root stays worktree-relative.

## Risks / Trade-offs

- **Output change for explicit-directory calls** (absolute → target-relative) on the rg leg: the 0.21.0 absolute form was itself the defect's shadow; the relative form is the builtin-intuitive contract being pinned. Disclosed in the proposal/release notes.
- **cwd-swap on exotic roots** (UNC paths, long paths): `child_process` cwd handles UNC (`\\server\share`); if spawn EINVALs on an exotic cwd the existing spawn-error fall-through to the JS leg already covers it (engine footnote discloses).
- **rg quoting of `.`**: none needed — fixed argv, shell:false.

## Migration Plan

Single patch release 0.21.1; no config migration; suite grows by the consistency class.

## Open Questions

- None blocking.
