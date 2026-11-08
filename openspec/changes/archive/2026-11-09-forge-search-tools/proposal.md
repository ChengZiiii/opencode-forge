# forge-search-tools

## Why

Verified on the owner's host (opencode 1.18.34): the builtin `grep` tool spawns rg without `--follow`, and the builtin `glob` tool passes neither `--follow` nor `--hidden` — so workspace content behind symlinks/junctions (and, for `glob`, every dot-directory) is silently invisible to every forge session, primary and workers alike. Readonly scouts fare worst: their sanctioned exec channel (`forge_shell`) misparses rg's `-o` (only-matching) flag as an output-target write and seals exactly the search commands they need, pushing them onto the builtin tools that cannot see the linked content at all. (The `-o` classifier fix is a separate change; this one removes the need to route search through the shell at all.)

## What Changes

- Two new plugin-registered tools `forge_grep` and `forge_glob`: rg-backed, direct spawn (no shell), interface parity with the builtin pair (`pattern`/`path`/`include`), output format aligned (`Found N matches` / `path: Line n:`) so worker habits transfer with zero relearning.
- Divergence by default: `follow` and `hidden` default TRUE (both exposed as explicit params) — junctions/symlinks and dot-directories are in scope by default; `.git/**` excluded.
- Follow-dedupe: a file reachable via its real path AND a link path reports once (lexicographically-first path kept) with a trailing `+N duplicate paths merged` line.
- Link targets outside the workspace: followed, with the resolved target disclosed in the result.
- Readonly by construction: fixed argv, no shell, no redirection surface — never sealed by the exec classifier, never ask-gated; available to the primary forge agent and every `forge-*` worker regardless of shape.
- Worker standing discipline gains a preference line: search goes through `forge_grep`/`forge_glob` first, builtin `grep`/`glob` as fallback only (builtin tools stay visible — preference, not hiding).
- rg resolution chain: explicit config override (`search.rgPath`) → `rg` on PATH → fail-soft tool error naming both fallbacks. No bundled binary, no new dependency, packaging unchanged.
- `tool-partition`: the `forge-*` worker forge-toolset extends from the exec pair to exec pair + search pair; the non-forge hiding list adds the two tools.

## Capabilities

### New Capabilities

- `search-tools`: the forge search surface — behavior contracts for `forge_grep`/`forge_glob`: parity interface, follow/hidden defaults, follow-dedupe, outside-target disclosure, rg fail-soft resolution, readonly-safe construction, and the family-scoped worker preference mandate.

### Modified Capabilities

- `tool-partition`: Requirement *Forge family runs exclusively on the forge exec surface* — the `forge-*` worker toolset sentence extends to include `forge_grep`/`forge_glob` (search pair alongside the exec pair). Requirement *Non-forge agents are isolated from forge tooling* — the enumerated hidden-tool list adds `forge_grep`/`forge_glob`.

## Impact

- `plugin.ts`: register the two tools (15 → 17 plugin tools), extend `FORGE_ALL_TOOLS` and the worker toolset injection, tool descriptions teach preference; `src/dispatch-prompt.ts`: one preference mandate line; new `src/search-core.ts` pure core (argv builder, rg `--json` stream parser, realpath dedupe, fail-soft resolution) with injectable spawn, wired through `src/proc.ts` `shellSpawn` with `shell: false`; tests: new search-core suite + wiring assertions + a Windows junction E2E (junction creation needs no admin); README: tool table row, rg dependency disclosure; `dist` rebuilt via `bun run bundle`.
- No forge.json/config breaking changes; builtin grep/glob untouched.
