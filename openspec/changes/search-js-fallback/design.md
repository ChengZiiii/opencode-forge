# Design: search-js-fallback

## Context

0.19.0 shipped the forge search pair with a spec-mandated fail-soft death on rg-less machines (reproduced by PATH-scrub; confirmed by field report where the remedy text redirected the user into the builtin glob's junction blind spot — the pair's founding scenario). The fix must make the pair zero-dependency like the rest of the plugin, without weakening the readonly-by-construction guarantee or the output contract.

## Goals / Non-Goals

- Goals: (1) every call served on every machine — rg when resolvable, bundled JS engine otherwise; (2) output contract byte-identical apart from one appended engine footnote; (3) junction/dot-directory visibility and the dedupe/disclosure post-pass work identically on both engines; (4) bounded and honestly disclosed resource use; (5) zero new deps, zero install scripts, 3-file bundle preserved.
- Non-Goals: full ripgrep dialect parity (regex + glob both get the common subset, divergences disclosed); gitignore semantics (unchanged — never applied); replacing rg as the preferred engine on equipped machines; streaming output.

## Decisions

### D1 — Engine chain, rg first (retained)

`search.rgPath` (exists on disk) → `rg` on PATH → JS engine. Spawn-stage failure of a resolved rg (override or PATH hit) also falls through to JS. Equipped machines see zero behavior change; the fail-soft error path is deleted. Rationale: rg keeps its documented semantics and speed where it exists; the JS engine is a correctness net, not a replacement.

### D2 — `src/search-js.ts` pure core, fs-injectable

`jsSearch(kind, params, seams) → { records: RgMatchRecord[], notices: string[] }`. Walk via injected `readdir(withFileTypes)`/`lstat`/`readFile` seams (test parity with the project's fake-fs style). Records feed the EXISTING `dedupeFollowMatches` + `formatSearchOutput` untouched — link-path reporting + realpath merge + outside-target disclosure come free from the same post-pass.

- **Walk**: DFS, `withFileTypes`; directory entries named `.git` skipped always; dot-entries skipped unless `hidden`; symlink/junction dirs (`entry.isSymbolicLink()` — junctions report as symlinks in Node on win32) descended only when `follow`, **cycle-guarded** by a seen-set of `realpath` values (injectable resolver, same seam as the dedupe pass); files matched per kind.
- **glob kind**: pattern → dialect-subset matcher (D3) applied to the walk-relative path with `/` separators; matched files become `{path, line: 0, text: ""}` records — empty files included (parity with the rg `--files` vector).
- **grep kind**: per matched file (after `include` filter, same matcher), read up to `MAX_FILE_BYTES`, split lines, `RegExp` test per line. Binary skip: NUL in the first 8 KiB → file skipped silently (rg-parity silence). Pattern compile failure → single honest error line naming the dialect divergence and the rg remedy; no partial results.

### D3 — Glob dialect subset

`*` (within segment), `**` (crosses separators), `?`, `[class]` (+ negation), `{a,b}` alternates — translated to a JS RegExp over the walk-relative path. This is the common subset of rg `--glob` and the builtin pair; exotic constructs simply fail to match (no error). Documented in README as the subset, not claimed as parity.

### D4 — Bounded walk, disclosed

`MAX_WALK_ENTRIES = 200_000` (entries visited) and `MAX_FILE_BYTES = 8 MiB` (per file scanned). Hitting the walk cap stops the walk and appends `(js engine: walk capped at 200000 entries — narrow the path)`; files skipped for size append `(js engine: skipped N files over 8 MiB)` only when N > 0. Truncation-style notices, same voice as the 100-result cap.

### D5 — Engine footnote

One line, appended after the dedupe footnotes, whenever the JS engine served (miss OR spawn fall-through): `(engine: builtin-js — ripgrep not found; install ripgrep or set search.rgPath for the faster engine)` — spawn fall-through variant names the failure. First output line stays `Found N matches` / path list (parity preserved).

### D6 — Wiring

`runRgSearch` becomes `runSearch`: resolve → if rg, existing spawn path unchanged; on miss or spawn error, `jsSearch` with the SAME absolute-path resolution and `.`-prefix-stripping the rg path applies, then the shared post-pass + footnote. Tool descriptions reworded ("ripgrep when available, bundled JS engine otherwise"); the discipline preference line is unchanged (the pair is now genuinely always available).

## Risks / Trade-offs

- **Dialect divergence** (rg vs JS RegExp vs glob subset): disclosed, not hidden — compile failure is a hard honest error; glob exotic constructs under-match silently (subset documented). rg-equipped machines never hit the JS path.
- **Perf on huge trees**: caps bound the worst case; notices make bounds visible; `path` param narrows naturally.
- **Cycle guard cost**: realpath per directory only (memoized) — bounded by directory count, not file count.
- **Bundle size**: pure JS, no deps — dist grows modestly; 3-file whitelist intact.

## Migration Plan

Single release (0.21.0): spec delta merges on archive; README section rewritten; no config migration (fail-soft remedies text simply stops appearing).

## Open Questions

- None blocking. (Considered and rejected: shipping a binary — violates the zero-trigger/no-deps packaging red lines; delegating to the host's builtin search internals — undocumented API, fragile.)
