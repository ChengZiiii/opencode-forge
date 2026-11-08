# Proposal: forge-prompt-shared

## Why

Pool authors repeat the same context block in every agent's `prompt` (project conventions, repo layout,
standing rules) — duplication that drifts per agent and bloats forge.json. The five-change batch approved
a pool-level `shared` prompt segment: written ONCE at the top of the pool file, inherited by every agent
the file materializes. The companion idea of a built-in role library (expanded named roles beyond
research/review) was explicitly DROPPED in the same discussion — reference-only design, no role catalog
growth.

## What Changes

- forge.json gains an optional top-level `shared` field (string): a prompt segment inherited by EVERY
  agent materialized from that file.
- Composition order (the layering contract): the materialized role prompt = `shared` (when present) +
  blank-line join + the EXISTING three-layer chain unchanged (explicit `def.prompt` > built-in
  `research`/`review` default > generic one-liner). `shared` rides BENEATH the chain — an explicit
  per-agent prompt keeps its priority over role defaults and never suppresses `shared`; `shared` never
  overrides anything.
- Fail-soft validation: absent → nothing changes; non-string or empty-after-trim → ONE warn finding
  (`shared-invalid`, naming the file) and the field is ignored — every agent still materializes. The
  global fallback file MAY declare `shared` (its family inherits; the namespace-ignored rule for the
  global `pool` field does NOT extend to `shared` — content, not namespace).
- Hot-apply: rides the existing mtime cache — editing `shared` re-materializes at the next config hook
  like any pool edit.
- Compatibility: with no `shared` anywhere, materialized prompts are byte-identical to today.

## Capabilities

**Modified Capabilities:**

- `forge-subagents` — ADDED requirement "Pool-level shared prompt segment" (6 scenarios). No existing
  requirement text changes.

## Impact

- `src/forge-config.ts` — parse `top.shared` per pool file (fail-soft, one finding), carry it on the
  family/resolution structures the materializers already consume.
- `src/dispatch-tiers.ts` — `rolePromptFor` (or the `forgeAgentDef` composition point) accepts the pool's
  shared segment and composes per the layering contract.
- `plugin.ts` — v1 `server()` and v2 `setup()` materialization call sites pass the file's `shared` through.
- `tests/` — `hierarchical-pools` (fake-fs: shared inheritance, per-file scoping across two pools,
  invalid-shared warn+ignore, global-file shared) + `forge-subagents-wiring`/`dispatch-prompt` composition
  assertions (shared+explicit, shared+role-default, shared+generic, no-shared byte-identical).
- `README.md` — forge.json authoring section: the `shared` field, the layering contract, the fail-soft
  rule, hot-apply.
- `dist/index.js` — rebuilt.
