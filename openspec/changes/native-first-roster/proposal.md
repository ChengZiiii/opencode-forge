# native-first-roster

## Why

The runtime-materialization seam is where every fragile v2 dependency lives:
the context-hook payload rewrite that pins worker models (an observed
implementation accident, not a documented API), the permission-array
spelling that already silently changed once, the draft-domain shapes. The
owner's stability call (2026-11-21 discussion): identity should belong to
the host; forge should compile + orchestrate.

The sandbox probe (`reports/probe-native-agent-surface.md`, 2026-11-21,
2.3.2) makes this concrete and safe:

- **Model pinning is fully native** — frontmatter `model:` lands verbatim
  (three spellings) and a dispatched child actually served the pinned
  identity, including the **variant channel** (`provider/model#low`,
  runtime-proven).
- **Seals are natively expressible** — `tools:{write:false,...}` removes
  tools from the agent's surface entirely (a readonly child self-reported
  "no write or edit tool is available" and indeed could not write).
- **Hot-apply works** — agent files refresh without a serve restart.
- Five hard facts shape the design (below): no first-class depth key
  (variant is the robust channel); `mode: subagent` must be stamped or
  task dispatch SILENTLY falls back to general; host tool vocabulary has
  drifted (shell channel is `execute`, the dispatch tool's real name is
  `subagent`); directory scoping is up-tree MERGE (not our
  nearest-exclusive) with no cross-layer collision protection;
  `/api/config` does not expose native agents.

The owner's existing workflow (forge drafts the forge.json recipe from
the project, owner tweaks model/depth) is preserved unchanged — the
recipe stays the single human-editable surface.

## What Changes

- **ADDED — Compiler (`forge_sync` + pure core):** forge.json (unchanged
  format) compiles to namespaced native files
  `.opencode/agent/forge-<ns>-<id>.md`: `mode: subagent` ALWAYS stamped
  (probe trap), `model: provider/model[#variant]`, tools face in current
  host vocabulary (write/edit/bash + `execute`, `subagent`), v2-array
  permissions, GENERATED header, dispatch mandates baked into the prompt
  body at compile time.
- **ADDED — Staleness gate + agent-layer sync:** crew/draft precheck
  compares recipe vs artifact mtimes; stale → honest refusal with
  one-step guidance; the forge agent runs the sync tool in-band
  (everything visible in the transcript); host hot-apply picks it up.
  Optional `sync:"auto"` knob for silent auto-regeneration for owners
  who accept the write-without-asking trade.
- **ADDED — Depth strategy:** variant-first (`#low/medium/high`) where
  the recipe's word maps; full 7-word dictionary via the existing
  chat.params name-keyed injection (public API) otherwise — per-spawn
  disclosure unchanged.
- **ADDED — Division of authority:** forge.json KEEPS the semantic center
  (pools, session-domain gating, crew roster disclosure, compliance —
  the pool resolver is untouched); native files are ONLY the
  materialization. Visibility follows native up-tree-merge scoping —
  a disclosed behavior difference (nested sessions see parent agents).
- **ADDED — Handbook:** README cookbook — recipe fields, three starter
  recipes (scout/coder/reviewer), the `mode: subagent` trap and
  vocabulary notes for hand-writers, cross-machine story (generated
  files are committed; `git pull` = zero-init, lockfile pattern).
- **KNOB — `materialize: "native" | "runtime"`:** defaults by host
  generation — v1 hosts pinned to "runtime" (byte-equal to today,
  forever); v2 hosts default DIRECTLY to "native" (owner decision
  2026-11-21, no deprecation window), "runtime" stays selectable as the
  escape hatch. `sync: "auto"` is kept as an exposed opt-in (absent =
  gate + in-band sync, the default posture; present = silent
  regeneration at session-start detection with a disclosed finding).

## Capabilities

### Added Capabilities

- `forge-subagents`: one new requirement — native roster compilation and
  sync (recipe authority, compiler output contract, staleness gate,
  depth strategy, cross-machine story).

## Non-goals

- No orchestration changes (crew/journal/breaker/jobs/plan/goal
  untouched; gates keep reading forge.json exactly as today).
- No plugin-silent file writes in the default mode (agent-layer sync
  only; `auto` is opt-in).
- No attempt to fix host layering semantics (up-tree merge, no collision
  protection) — file-level namespacing (`forge-<ns>-<id>.md`) is our
  collision answer; host behavior is disclosed, not fought.
- No per-hop reasoning tuning beyond variant + the existing dictionary.

## Authorization note

Owner approved the probe (2026-11-21) and the direction discussion;
this proposal is written for owner review. Apply starts only on explicit
approval. Probe evidence: `reports/probe-native-agent-surface.md`.
