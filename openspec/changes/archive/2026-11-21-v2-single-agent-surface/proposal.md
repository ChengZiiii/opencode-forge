# v2-single-agent-surface

## Why

Two live defects on the real opencode 2.3.2 host, both user-reported:

1. **Native primaries crowd the single-agent surface.** v2 removed the
   Tab quick agent cycle; the product direction is one visible primary.
   Forge's v2 `setup` registers forge but leaves the native `build` and
   `plan` primaries fully visible, so every agent picker shows three
   primaries. The user directed OMO-style suppression: OMO's proven
   recipe (oh-my-openagent, issue 3443 source) is `{ mode: "subagent",
   hidden: true }` — hide, not remove. Host reality (binary-verified on
   2.3.2): agent records carry a first-class `hidden` field, the agent
   draft editor exposes `default()`, and the config→agent merge itself
   writes `hidden` from user config — the mechanism exists and is
   config-compatible.
2. **The model is still offered the builtin shell.** `v2Setup`'s tool
   domain deliberately registers only ("tool-partition behavior … is a
   W4 session-seam concern and is deliberately NOT attempted here"), so
   on v2 the forge agent's model-facing tool list contains the builtin
   shell. Observed live: the model called the builtin Shell three times,
   was refused by the belt each time, verbally acknowledged, then used
   forge_shell — wasted calls every session. v2 agent records have NO
   `tools` field (binary + /api/agent verified); v2 per-agent tool
   visibility is permission-driven (the native explore agent is defined
   as `deny *` + per-tool `allow` entries). The v2 front door is a deny
   permission on the forge-family agent records.

## What Changes

- **Zero-persistence contract (user directive):** everything below is
  delivered exclusively as runtime agent-layer state. The plugin writes
  NOTHING to the user's opencode config — uninstalling the plugin
  restores the native primaries and the default subject on the next
  agent-layer rebuild. (The interim manual `agent.build/plan.hidden`
  config edit made while scoping this change was reverted and verified
  live: both records back to `hidden: false`, hot, zero residue.)
- **Native primary suppression (v2 only):** `v2Setup`'s agent transform
  sets `hidden: true` on the native `build` and `plan` records via
  `draft.update` — guarded (record must exist), fail-soft per record,
  never un-hides, never touches any other field. Records are hidden,
  NOT removed (existing sessions that reference them keep working).
  Opt-out: `"hideNativeAgents": false` in the GLOBAL forge.json layer
  (the plugin's own config file — forge.json, not the opencode config).
- **Default subject (v2, ordering-gated):** where the agent draft editor
  exposes `default()` and the plugin-before-config transform ordering is
  confirmed (so a user's explicit `default_agent` still wins), `v2Setup`
  sets the agent default to `forge` — retiring the need for a manual
  `default_agent` config line (the dev host's line is removed once this
  ships). If ordering cannot be confirmed on a host shape, this slice
  degrades to the documented config recipe and ships nothing.
- **Exec-surface front door (v2 only):** the forge agent record and every
  materialized `forge-*` record carry
  `{ action: "shell", resource: "*", effect: "deny" }` in their
  permission payload at registration, so the model-facing tool surface
  never offers the builtin shell to the forge family. The existing
  permission belt refusals remain as belt-in-depth. `jobs.keepBuiltinShell`
  remains a v1-loader mechanism (documented drift: v2 has no readable
  opencode-config channel today).
- README documents the v1-host config recipe
  (`agent.build.hidden: true` etc.) and the v2 knob.

No v1-loader behavior changes.

## Capabilities

### Modified Capabilities

- `tool-partition`: the "Forge family runs exclusively on the forge exec
  surface" requirement gains the v2 delivery mechanism (deny permission
  on agent records) and two v2 scenarios; all existing scenarios carry
  over unchanged.

### Added Capabilities

- `forge-agent`: new requirement "v2 single-agent surface" — native
  primary suppression, default-subject setting, and their guards/knobs.
