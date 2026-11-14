# Proposal: search-glob-anchor

## Why

Live-session 实战核验 (2026-11-09, post-0.21.0) caught a real bug the 502-test suite was blind to: with an EXPLICIT `path` argument pointing at a directory, slash-bearing (anchored) glob patterns — `*/tasks.md`, `*/*/x` — silently return `No files found` on the ripgrep leg, while `**/…` and basename patterns work. Full bisect chain (live A/B → bare-rg control → node exact-argv replication → single-variable matrix) pinned it on rg 15.2.0: when `--hidden` OR `--follow` is present and the root argument is ABSOLUTE, rg lifts the glob anchoring domain from root-relative to the whole path — anchored patterns can never span the `C:\Users\…` prefix. `forge_grep`'s `include` filter rides the same `--glob` and inherits the defect. Our defaults (`follow: true`, `hidden: true` — the 0.19.0 founding feature) make every explicit-path anchored call a guaranteed miss. The suite never caught it because every test uses the default (no-`path`) root `"."` — a test blind spot only real work could expose. The JS engine anchors walk-relative (correct), so the two engines also DISAGREE on the same query — a parity violation of the engine-chain contract.

## What Changes

- **Anchoring semantics, pinned**: when `path` points at a directory, glob patterns and `include` filters match against paths RELATIVE TO THAT DIRECTORY, and results are reported relative to it — on BOTH engines, identically. (Builtin-glob intuition: pattern and output share the root you named.)
- **rg leg implementation**: explicit-directory `path` spawns rg with `cwd = <that directory>` and the path argument `"."` — the shape every existing test proves anchors correctly; the existing `.\`-prefix strip turns output target-relative.
- **JS leg unification**: explicit-directory records drop the absolute-root prefix and emit walk-relative paths verbatim — byte-identical to the rg leg. Default root (worktree) and FILE-path roots keep their current shapes unchanged.
- **Dedupe/outside-disclosure correctness**: the realpath resolver for the follow-dedupe pass keys to the call's EFFECTIVE root (explicit directory when given, else worktree) — resolving link records under the actual search root instead of the worktree. Outside-workspace disclosure still compares against the worktree (disclosure semantics untouched).
- **Cross-engine consistency tests**: one fixture, one anchored pattern, one explicit path — asserted identical across the rg leg (real rg) and the JS leg (scrubbed PATH); plus an rg-present anchored-explicit-path regression that fails on 0.21.0.
- Version 0.21.1 (patch).

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `search-tools`: ADDED requirement "Explicit path anchors pattern and output" (both engines anchor slash-bearing patterns and report results relative to an explicit directory `path`; file-path and default roots unchanged) — sits beside the existing parity requirement without rewriting it.

## Impact

- `plugin.ts` `runSearch` (rg spawn cwd/patharg, JS record pathing, effective-root resolver), `tests/search-wiring.test.mjs` (+ cross-engine consistency cases), README (one sentence pinning the anchoring semantics), 0.21.1 release chain. No spec text elsewhere references absolute-path output for explicit roots; README gains the pinned semantics line.
