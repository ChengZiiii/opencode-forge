# v2-single-agent-surface — forge-agent delta

## ADDED Requirements

### Requirement: v2 single-agent surface

Under the v2 loader, the plugin SHALL suppress the native `build` and `plan` primary agents by setting `hidden: true` on their agent records via the agent domain — records are hidden, never removed, and no other field of a native record SHALL be touched. The suppression and default-setting SHALL be delivered exclusively as runtime agent-layer state and SHALL NOT write to the user's opencode config or any file outside the plugin's own config domain (forge.json); removing the plugin SHALL restore the native primaries and the default subject on the next agent-layer rebuild. The suppression SHALL be guarded (an absent record is skipped, an already-hidden record is left untouched), fail-soft per record, and SHALL be opt-out-able via `"hideNativeAgents": false` in the global forge.json layer; `agent["forge"].disable = true` remains the whole-plugin off switch. Where the agent draft editor exposes a default setter AND the plugin's transforms are confirmed to run before the host's config→agent merge (so an explicit user `default_agent` overrides the plugin), `setup` SHALL set the agent default to `forge`; on hosts where that ordering cannot be confirmed, the default-subject slice SHALL ship nothing and the README config recipe (`default_agent: "forge"`) remains the documented way. Suppression SHALL NOT touch the `general`, `explore`, `compaction`, `title`, or `summary` agents, and SHALL NOT apply under the v1 loader (v1 users get the README config recipe).

#### Scenario: Native primaries disappear from the picker on v2

- **WHEN** the plugin loads on a v2 host and the agent layer resolves
- **THEN** the native `build` and `plan` records carry `hidden: true` and the agent picker offers `forge` as the visible primary, while `general`/`explore`/host-internal agents remain untouched

#### Scenario: Uninstalling the plugin restores the natives

- **WHEN** the plugin is removed and the agent layer rebuilds
- **THEN** `build` and `plan` return to `hidden: false` and the default subject reverts — no trace of the suppression persists in the user's config or on disk

#### Scenario: Nothing is written to the user's config

- **WHEN** the plugin delivers suppression, default-setting, or the shell deny
- **THEN** the user's opencode config file is byte-identical to before the plugin loaded; all plugin-owned state is runtime agent-layer data or files in the plugin's own domain (forge.json, plugin ledgers)

#### Scenario: Existing native-agent sessions keep working

- **WHEN** a session was created with agent `build` before suppression and is reopened after it
- **THEN** the session still resolves its agent (hidden, not removed) and behaves exactly as before

#### Scenario: The opt-out knob restores the natives

- **WHEN** the global forge.json sets `"hideNativeAgents": false`
- **THEN** `setup` leaves the native `build`/`plan` records untouched and the picker shows them again

#### Scenario: A user's explicit config still wins where ordering allows

- **WHEN** the host merges user config agent entries after plugin transforms (2.3.2 observed ordering) and the user explicitly sets `agent.build.hidden: false`
- **THEN** the final merged record is visible — the plugin's suppression never overrides an explicit user statement on hosts with that ordering

#### Scenario: Fresh sessions default to forge under the confirmed ordering

- **WHEN** the agent draft editor exposes a default setter, the plugin-before-config ordering is confirmed, and the user has no explicit `default_agent`
- **THEN** a new session without a named agent starts as `forge`
