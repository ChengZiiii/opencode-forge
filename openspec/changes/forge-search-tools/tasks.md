# forge-search-tools — Tasks

## 1. Pure core (src/search-core.ts)

- [x] 1.1 Implement the argv builder (grep/glob variants; `follow`/`hidden` flags; `include` glob; `.git/**` exclusion; pattern and path as final literal args) with injectable seams and verify `tests/search-core.test.mjs` asserts the full argv matrix (defaults on, both opt-outs, include present/absent, file-vs-directory path)
- [x] 1.2 Implement the rg `--json` stream parser (match events → records; unknown event types ignored; oversized record guard) and verify canned-JSON unit tests pass (happy path, interleaved begin/end events, garbage line tolerance)
- [x] 1.3 Implement the follow-dedupe post-pass (group by resolved realpath via injectable/memoized resolver; keep lexicographically first path; emit `+N duplicate paths merged` footnote; outside-worktree target disclosure line) and verify unit tests: real+link duplicate reports once, footnote count correct, outside target named
- [x] 1.4 Implement rg binary resolution (config `search.rgPath` when it exists → PATH `rg` → fail-soft error naming both remedies) with injectable fs and verify unit tests cover all three outcomes
- [x] 1.5 Implement the output formatter (`Found N matches` header, `path: Line n:` blocks, `No files found` empty case, 100-result truncation notice) and verify parity unit tests against the builtin format shapes

## 2. Wiring (plugin.ts, dispatch-prompt.ts)

- [x] 2.1 Register `forge_grep`/`forge_glob` (descriptions carry the preference line), extend `FORGE_ALL_TOOLS` and the worker toolset injection to the search pair, and verify wiring tests: a materialized `forge-*` worker's tools map includes both search tools, non-forge fallback entries hide them, plugin tool count is 17
- [x] 2.2 Keep the tools out of the ask-gate list and `MUTATING_TOOLS`, and verify wiring tests: the config hook's permission section gains no `forge_grep`/`forge_glob` keys, and a readonly worker's materialized permission carries no deny on them
- [x] 2.3 Add the search-preference mandate line to `WORKER_MANDATES` and verify the dispatch-prompt test asserts the composed prompt contains the preference line alongside the pre-existing mandates

## 3. Behavior tests

- [x] 3.1 Add a Windows junction E2E (temp workspace, junction via `fs.symlinkSync(..., "junction")`, real+link duplicate file, dot-directory fixture; run against the real rg binary when it resolves, skip with an explicit reason otherwise) and verify it exercises follow-default, dedupe, and hidden-default end to end
- [x] 3.2 Add the rg-missing fail-soft path test (fake fs: no override, no PATH hit → guidance error, no throw) and verify it passes

## 4. Docs, gate, build

- [x] 4.1 Update README (tool table row for the search pair, rg dependency + `search.rgPath` escape hatch, dedupe/outside-target semantics) and verify the sections exist via doc grep
- [x] 4.2 Run the full gate and verify green: `bun run typecheck`, `node --test tests/*.test.mjs`, `bun run bundle` (self-contained dist rebuilt), `npm pack --dry-run` (files whitelist = dist + README.md + package.json)
