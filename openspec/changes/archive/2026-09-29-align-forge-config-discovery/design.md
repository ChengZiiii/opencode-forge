# Design — align-forge-config-discovery

## Context

opencode documents two config-discovery invariants ("merged together, not replaced"; project config found by traversing up from the working directory). forge.json predates this alignment and uses single-source shadowing over one frozen path. The reported bug ("`/crew` 只找全局配置") is the conjunction: the anchor froze at the wrapper's launch home, so every workspace inherited that home's pool, and had a workspace file been reachable it would have shadowed (not merged with) the global layer.

## Goals / Non-Goals

- Goals: opencode-aligned layer semantics (merge, project wins per id); upward discovery from an observable anchor; per-layer fail-soft; honest disclosure when the session's workspace has config the host cannot materialize.
- Non-Goals: per-session task-tool materialization (v1 `config` hook has no session/directory dimension — the host API cannot add agents to a running host's vocabulary mid-session); anchoring on directories the plugin cannot observe (explicit per-command `workdir`s are not session anchors); cross-layer field blending (one definition per id, wholesale); archive of this change.

## Decisions

- **D1 — Merge model: global base + nearest project override, per agent id.** `{...global.agents, ...project.agents}` — a colliding id takes the project definition wholesale. Mirrors opencode's "later configs override earlier ones only for conflicting keys" without inventing per-field merge (agent entries are opaque units; blending a project `model` with a global `thoughtLevel` would break the atomic-pair contract).
- **D2 — Project discovery: walk up from the anchor, first hit wins.** Candidate chain `anchor/.opencode/forge.json`, `dirname(anchor)/.opencode/forge.json`, … until `dirname(dir) === dir` (handles `/` and `C:\`). opencode stops its own walk at the nearest git directory; we walk to the root because the plugin cannot cheaply re-derive the host's stop condition and a superset never misses a file the user expects to be found. Discovery re-runs on every `load()` (stat-per-level, cheap; parse results stay mtime-cached per path) so file appearance/removal hot-applies like edits.
- **D3 — Anchors: session where observable, host otherwise.** One chain everywhere: `sessionAnchor(context)` = the session's non-degenerate worktree → the session's own directory (`ToolContext.directory` / session-record directory) → the host launch directory. Plan/goal tool calls (`worktreeFor`) and crew_begin use it; the config-hook materialization, the `/crew` template roster, and chat.params depth lookup anchor on the host launch directory (depth must match the materialized model — re-anchoring depth per session would pin a translation against a different layer's model). crew_begin guidance/mismatch resolution runs through a small bounded per-anchor loader cache (≤8, oldest evicted). Before this change `worktreeFor` skipped the session directory entirely (degenerate worktree → frozen launch dir), which misplaced plan/goal files under the launch directory in multi-directory hosts — the same frozen-anchor disease, fixed by the same chain.
- **D4 — Gate truth stays host-materialized.** The hard gate refuses only when the host-materialized set is empty (that set is what the native task tool can dispatch). Session-anchored discovery NEVER widens dispatchability; it only drives (a) the guidance paths, (b) the workspace-mismatch disclosure (empty-host case: refusal explains the mismatch; non-empty-host case: crew_begin succeeds with a disclosure line). This keeps the gate honest under the v1 API's one-pool-per-host limit — the same limit native `.opencode/agents/` live under.
- **D5 — `LoadedForgeConfig` surface.** `source` gains `project+global` (existing values unchanged); `path` stays the primary backing file (project layer if present, else global); new `projectPath: string | null` backs the mismatch disclosure. Findings from both layers concatenate — each finding's message already embeds its file path.
- **D6 — Per-layer fail-soft.** A broken document empties its layer only. Broken project + valid global → global agents + error finding (was: empty set). Broken global + valid project → project agents + error finding. No seed in any path, unchanged.

## Risks / Trade-offs

- Walk-to-root may find a `.opencode/forge.json` above the git root (e.g. a user home pool). Accepted: superset discovery, and the home-level file is exactly what the paseo-style launch relies on. Mitigation for surprise: disclosure paths in gate messages name the discovered file.
- Per-anchor loader cache could grow under serve-style multi-directory hosts; bounded at 8 with oldest eviction.
- `chat.params` staying host-anchored means a workspace layer overriding a global agent's `thoughtLevel` applies only after the host is (re)launched there — inherent to v1 materialization, disclosed by D4, not papered over.

## Migration Plan

Single-file setups (project-only, global-only) are behavior-identical. Dual-layer setups change from project-shadows-global to merged — that is the fix, released as a minor (0.11.0) with README + AGENTS.md updated in the same change. No on-disk format change; no migration code.
