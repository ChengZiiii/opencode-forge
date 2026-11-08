# forge-search-tools — Design

## Context

The host's builtin grep/glob tools spawn rg without `--follow` (grep) and without `--follow`/`--hidden` (glob) — verified against the opencode 1.18.34 bundle on the owner's host, plus a live junction sandbox (same session that motivated this change): builtin grep from a parent directory misses junction content, builtin glob misses junctions AND dot-directories; `rg --follow` and explicit link-path args both work at the shell level. The plugin already owns an exec surface with a readonly classifier (`src/exec-classify.ts`) that misparses rg's `-o` as an output-target flag — search is the workload hit hardest. See proposal.md - Why.

Existing seams this design rides: `src/proc.ts` `shellSpawn` (injectable spawn, tree-kill), the tool registration path in `plugin.ts` (15 tools today), `FORGE_ALL_TOOLS` hiding lists, `src/dispatch-prompt.ts` `WORKER_MANDATES`, and the tool-partition injection blocks (worker toolset, non-forge hiding).

## Goals / Non-Goals

**Goals:**

- Deterministic, readonly-by-construction search that sees what the builtin pair misses (links, dot-dirs) without routing through `forge_shell`'s classifier.
- Interface/output parity with the builtin pair so workers transfer habits with zero relearning.
- Zero new runtime dependencies and zero packaging changes.

**Non-Goals:**

- No `forge_read` (builtin read already resolves links correctly).
- No fix to the exec classifier's `-o` false positive here — that is a separate change (`exec-seal` fix, change #2 of the batch).
- No replacement/symbolic-engine work: no JS search core, no gitignore reimplementation — rg does that; we only feed it flags.
- No hiding of the builtin grep/glob from forge sessions (preference mandate only).

## Decisions

**D1 — Direct rg spawn, no shell, fixed argv.** `search-core.ts` builds an argv array (`--no-config --json --hidden? --follow? --glob=!**/.git/** [--glob=<include>] -- <pattern> <path>`) and spawns via `shellSpawn` with `shell: false`. No shell string ever exists, so the readonly guarantee is constructional rather than classifier-based. Alternative rejected: routing through `forge_shell` (keeps the classifier in the loop and reintroduces the `-o`-class false positives this change exists to remove).

**D2 — Dedupe in the JSON-stream post-pass, keyed by realpath.** rg `--follow` reports duplicates (verified: 2 files → 4 matches in the sandbox). The core parses rg's JSON events, groups match records by resolved real path (`fs.realpathSyncNative` on the rg-reported path), keeps the lexicographically first reported path per group, and appends `+N duplicate paths merged` when N>0. Realpath resolution is done once per distinct reported path (memoized in the call). Alternative rejected: letting duplicates through (noise; workers treat them as distinct files — observed confusion).

**D3 — Outside-workspace links: follow + disclose, no refusal.** rg follows them naturally under `--follow`; the core detects that a searched link's realpath escapes the worktree root and emits a disclosure line naming the resolved target. Refusing would defeat the primary use case (workspace links to external data directories). Read-only surface, so no write-boundary parallel applies.

**D4 — rg resolution: `search.rgPath` → PATH → fail-soft error.** No bundled binary (bundling would break the `files` whitelist = dist + README packaging red line and the self-contained-dist rule; a PATH dependency is no more alien than the system shell `forge_shell` already depends on). The fail-soft error names both remedies and suggests the builtin pair for that call. `search.rgPath` is read through the existing config surface at call time (no restart needed to pick up an install).

**D5 — Output format is byte-compatible with the builtin pair.** `Found N matches` + `path: Line n:` blocks, 100-result truncation notice, `No files found` empty case. Parity is what makes the preference mandate cheap to follow — a worker switching tools mid-task reads the same shapes.

**D6 — Partition wiring: extend the existing constants, don't fork them.** `forge_grep`/`forge_glob` join `FORGE_ALL_TOOLS` (non-forge hiding + primary gets them), and the worker toolset injection grows from the exec pair to exec+search. They are NOT added to `MUTATING_TOOLS` (readonly-safe) nor to the ask-gate list in the config hook — an ask-gate would recreate the exact friction this change removes. The fallback-refusal belt for hosts that ignore injected maps treats them like any plugin tool: non-forge calls refused with partition guidance.

**D7 — Preference mandate rides `WORKER_MANDATES`.** One line added to `src/dispatch-prompt.ts` ("search through forge_grep/forge_glob first; builtin grep/glob only as fallback"). The forge-subagents spec's discipline scenario requires the two pre-existing mandates to be present — adding a line keeps it satisfied; no forge-subagents delta needed. Tool descriptions also carry the preference (teaches the primary, which has no materialized mandate).

## Risks / Trade-offs

- [PATH rg absent on clean Windows machines] → fail-soft error with both remedies; `search.rgPath` escape hatch; README discloses the dependency.
- [Duplicate-heavy workspaces (many links to the same trees) pay realpath cost] → memoized per call; dedupe only when follow is on; pure-function core keeps the cost unit-testable.
- [Two visible grep tools confuse workers on which to pick] → preference mandate + preference-bearing tool descriptions; builtin stays as fallback by design (user decision); observe in practice before considering hiding.
- [rg JSON event drift across rg versions] → parser is strict-but-tolerant (unknown event types ignored; `type: "match"` records only); rg resolution pinned via `search.rgPath` for reproducibility.
- [Windows junction E2E in tests] → junction creation needs no admin (`New-Item -ItemType Junction` / `fs.symlinkSync(..., 'junction')`); tests skip symlink-type cases when the platform refuses, junction cases always run.

## Migration Plan

Purely additive: two new tools, one mandate line, extended lists. No config migration; old forge.json files and hosts without rg behave exactly as today until a search tool is called (fail-soft). Rollback = revert the commit; no state files touched.
