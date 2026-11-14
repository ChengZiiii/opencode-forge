# Tasks: search-js-fallback

## 1. Specification

- [x] Write the search-tools delta (two MODIFIED requirements, full scenario carriage): engine chain replaces fail-soft; engine-agnostic readonly-construction wording + JS-engine junction scenario
- [x] `openspec validate search-js-fallback` passes

## 2. Core — `src/search-js.ts`

- [x] Dialect-subset glob matcher (`*`, `**`, `?`, `[class]`, `{a,b}`) as a pure function + unit matrix (including exotic-construct under-match cases)
- [x] Injected-fs walk engine: follow (junction/symlink descent + realpath cycle guard), hidden, `.git` exclusion, entry cap with notice
- [x] grep scan: include filter, per-file size cap + skip notice, binary skip, JS RegExp with honest compile-failure error
- [x] Both kinds emit `RgMatchRecord[]` + notices; empty files listed in glob kind

## 3. Wiring — `plugin.ts`

- [x] `runRgSearch` → `runSearch` engine dispatch (config → PATH → JS; spawn fall-through to JS), shared post-pass (dedupe/disclosure/format) + engine footnote
- [x] Tool descriptions reworded (engine chain); preference line unchanged
- [x] Delete the fail-soft early-return path and `RG_MISSING_REMEDIES` guidance surface

## 4. Tests

- [x] `search-js.test.mjs`: matcher matrix, walk semantics (junction follow/cycle guard, hidden, .git), caps + notices, binary skip, grep scan, compile-failure error
- [x] Wiring: scrubbed-PATH end-to-end (no rg resolvable → live results + footnote), override-wins (no footnote), broken-override fall-through (footnote), junction visibility through the JS engine with outside-target disclosure
- [x] Full suite green (`node --test tests/*.test.mjs`), typecheck clean

## 5. Release

- [x] README search section: engine chain, footnote, subset + caps documentation
- [x] `bun run bundle` (self-contained), `npm pack --dry-run` = 3 files
- [x] Version 0.21.0, publish, store update, push
- [x] **Field-parity acceptance**: rg-scrubbed serve sandbox (minimal PATH without rg) — forge_glob finds a junction target outside the workspace with disclosure footnote, forge_grep returns matches — the exact field-failure chain, replayed green
