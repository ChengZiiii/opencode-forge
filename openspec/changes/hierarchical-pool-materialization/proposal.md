# Proposal — hierarchical-pool-materialization

## Why

Real-world frontends (paseo today, opencode desktop and others next) drive opencode as a backend and routinely run **one shared host process for sessions belonging to different projects and directories**. Two failure modes are now field-proven:

1. **The anchor-flip tear** (2026-09-29 incident, SorenUnityLabs session `ses_f142af86`): opencode re-initializes the plugin with different directories over the host's lifetime; the plugin's materialization anchor is a mutable singleton ("last init wins"). At 14:24 the `/crew` template carried the seven-agent Unity roster; at 14:26 `crew_begin` refused with an empty set — same host, two minutes apart. Template, gate, and task vocabulary told three different stories.
2. **Single-pool hosts cannot express multi-project work**. The user's standing workflow: several parallel dev lines (each with its own workspace, sessions, `/crew` orchestrations, and goals) riding one frontend-spawned host, where a workspace's root forge.json is the general-manager pool (总管) for everything unmarked — including sub-projects without their own config and doc-only folders — while specific sub-projects carry their own forge.json specialist pools that must be dispatchable **from the same session**.

Neither can be fixed frontend-side (no dedicated-server option exists in paseo, and future frontends cannot be relied on), and git-repo structure cannot be assumed (plain-folder workspaces holding many repos and non-versioned doc folders are common and must keep working with a single root pool).

## What Changes

- **Anchor set, frozen**: the host's materialization anchors become an append-only set (every directory the plugin is initialized with joins; the first is *primary* and never replaced). The flip tear becomes structurally impossible; file-level changes still hot-apply per the existing contract.
- **Hierarchical pool resolution**: per anchor, the plugin resolves a pool family — the nearest `.opencode/forge.json` walking up (the root pool, merged over the global layer as today) **plus every `.opencode/forge.json` in the anchor's subtree** (bounded scan: dependency-dir skip-list, directory budget, mtime cache; creation/deletion hot-applies).
- **Namespaced materialization**: the primary anchor's root pool keeps plain ids (`forge-shader` — single-anchor hosts are byte-compatible with today); every other family materializes as `forge-<ns>-<id>`. Pool identity is the forge.json file itself — the same file reached via two anchors materializes once. Per-agent semantics are unchanged by namespacing.
- **Optional `pool` field**: a forge.json may declare a short namespace (`"pool": "aa"`) that overrides the directory-name-derived namespace; the AI-assisted-config guidance teaches the session AI to propose a stable pool name whenever it writes a forge.json on the user's go-ahead.
- **Roster and disclosure scale up**: the `/crew` roster groups agents by pool with origin paths; `crew_begin`'s origin disclosure enumerates the pools (primary marked); the unconfigured gate now means *zero pools across the whole anchor set*.

## Non-Goals

- No change to plan/goal/crew **state anchoring** — artifacts stay session-anchored (the session axis is deliberately different from the host vocabulary axis; making state hierarchical would collapse line isolation and goal single-live namespaces).
- No per-session agent vocabulary (host-global task registry is an opencode constraint, not a plugin choice).
- No frontend reliance: no dedicated-server assumptions, no paseo-specific behavior.
- No dispatch-engine changes: everything still rides the native task tool.

## Impact

- Affected specs: `forge-subagents` (file format gains `pool`; new hierarchical materialization requirement), `crew-harness` (roster grouping, pool-origin disclosure, AI-assist line, gate wording).
- Affected code: `plugin.ts` (anchor set + freeze, materialization union, roster/disclosure), `src/forge-config.ts` (subtree scan + namespace derivation + pool field validation — pure, fs-injectable), onboarding texts, tests, README/AGENTS.md.
- Archive-order dependency: `align-forge-config-discovery` (shipped 0.11.0, still unarchived) modifies the same `forge-subagents` requirement — it MUST be archived before this change.
