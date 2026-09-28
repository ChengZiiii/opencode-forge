# forge-subagents Specification

## Purpose
Static, forge.json-defined worker subagents for the forge agent: each definition pins a model and an optional reasoning depth, is materialized as a native hidden-from-cycle subagent carrying the worker discipline and a shape-derived permission, and is dispatched through the host's native task tool — TUI-visible, with no plugin-side dispatch engine. The plugin reads user configuration and never writes it.

## Requirements

### Requirement: Static agent definitions in a dedicated forge.json

Subagents SHALL be configured in a dedicated `forge.json` (JSONC — comments allowed), resolved by a two-level cascade with a single winning source (no merging): project `<project>/.opencode/forge.json` (versionable, team-shared) over global `~/.config/opencode/forge.json`. The file SHALL define `agents` as a map of agent id (`[a-z0-9-]`) to `{model, thoughtLevel?, prompt?, shape?, permission?}`: `model` is the exact `provider/model` identity pinned into the materialized agent; `thoughtLevel` is an optional pinned reasoning word (canonical `none|low|medium|high|max` or a native level name, verbatim); the legacy `depths` array SHALL be ignored with a deprecation finding and SHALL NOT influence behavior. Configuration SHALL hot-apply: the plugin re-reads the file (mtime-cached) at every config hook and every depth-injection lookup, so edits take effect without a host restart. The plugin SHALL only ever READ this file — never create, write, or migrate it. When no forge.json exists the unconfigured state SHALL be inert: no subagents registered, no errors raised, no AI-facing configuration recipe emitted; onboarding lives in the README for the human operator.

#### Scenario: Project file wins over global

- **WHEN** both `<project>/.opencode/forge.json` and `~/.config/opencode/forge.json` exist
- **THEN** the project file fully determines the agent set; the global file is not merged in

#### Scenario: Edits hot-apply without restart

- **WHEN** the user edits `forge.json` on a running host and the next config hook fires
- **THEN** the materialized agent set and depth lookups reflect the new file content; no host restart is required

#### Scenario: The plugin never writes the file

- **WHEN** any plugin lifecycle event occurs (load, config hook, chat.params, error)
- **THEN** `forge.json` is only read; the plugin never generates, completes, or migrates it

#### Scenario: Legacy depths field degrades to a finding

- **WHEN** an agent definition carries `depths: ["low", "medium"]` and no `thoughtLevel`
- **THEN** the agent still materializes, a deprecation finding naming the agent is recorded, and no depth is injected for it

#### Scenario: Unconfigured state is inert

- **WHEN** the host starts with no forge.json anywhere in the cascade
- **THEN** no `forge-*` subagents are registered, no error or recipe is surfaced to the model, and the host behaves exactly as without this capability

### Requirement: Materialization as native subagents with a pinned model

The config hook SHALL materialize each configured agent as a `mode: subagent` agent `forge-<id>` that is visible to the host's native `task` tool vocabulary (discoverable by the model, excluded from the Tab cycle by its subagent mode), carrying the definition's pinned `model` (the brain is bound at materialization — there is no per-call model selection), a prompt composed of the worker discipline wrapped around the role prompt, and a deny-style permission: `shape: "readonly"` (the default) denies mutating tools, `shape: "write"` allows them, an explicit `permission` map overrides the shape-derived default — and every agent SHALL deny `task` regardless (recursive spawning stays physically impossible). The worker discipline embedded in the prompt SHALL mandate workspace-relative paths only (never absolute paths outside the workspace), verbatim reporting of tool refusals instead of improvising workarounds, and conclusions carrying evidence references; readonly agents are additionally told to report rather than work around restrictions. Materialization SHALL be create-only: a user-defined entry of the same id is never touched (identically under the v2 `setup` entry point, which registers the same agents on a create-only basis). When `agent["forge"].disable` is set no subagents SHALL be registered.

#### Scenario: Agent entries carry the pinned model

- **WHEN** the plugin loads with a forge.json defining `research: {model: "prov/x", thoughtLevel: "low"}` and the injected agent set is inspected
- **THEN** `forge-research` is a subagent-mode agent whose `model` is exactly `prov/x`, listed for the native task tool, with a deny-style permission including `task: deny`

#### Scenario: The materialized prompt embeds the discipline

- **WHEN** the composed prompt of a materialized agent is inspected
- **THEN** it contains the workspace-relative-path mandate and the verbatim-refusal-reporting mandate, wrapped around the agent's role prompt (explicit `prompt` overriding the built-in role default)

#### Scenario: A permission override keeps the recursion ban

- **WHEN** an agent sets `permission: {"bash": "deny"}` with `shape: "write"`
- **THEN** the materialized permission honors the override and still carries `task: deny`

#### Scenario: A user-defined agent entry is never clobbered

- **WHEN** the user has their own `agent["forge-research"]` configuration (v1 or v2 loader)
- **THEN** the plugin skips injection for that id and the user's entry stands

#### Scenario: The disable knob registers nothing

- **WHEN** `agent["forge"].disable: true` is set
- **THEN** no `forge-*` subagents are registered alongside the other plugin silences

### Requirement: Pinned thoughtLevel injection keyed by agent name

For any session running a `forge-<id>` agent, the plugin SHALL translate that agent's pinned `thoughtLevel` to the provider's native parameter and stamp it onto the LLM request via the `chat.params` hook, keyed by the agent name (stable across sessions and spawn paths — no per-dispatch session table). Translation SHALL follow the family rules: effort-style families receive the effort word verbatim when natively valid; budget-style families receive the documented budget tier per meta word (`none` → thinking off); toggle-style families receive on/off; the verbatim-first and no-interpolation rules SHALL govern. An agent without `thoughtLevel`, a word with no native counterpart on the family, or a provider absent from the family map SHALL inject nothing — and in the no-counterpart case SHALL record a bounded finding naming both vocabularies (the worker session itself must never be broken by an untranslatable word). The injected value SHALL remain stable for the whole session (never rewritten mid-session).

#### Scenario: The pinned depth reaches the provider request

- **WHEN** a session runs `forge-research` pinned `thoughtLevel: "low"` on an effort-style family provider
- **THEN** that session's chat.params writes `options.reasoningEffort = "low"` and keeps it stable across turns

#### Scenario: Absent thoughtLevel injects nothing

- **WHEN** an agent defines no `thoughtLevel`
- **THEN** the provider's default applies and no reasoning option is injected

#### Scenario: An untranslatable word degrades to a finding, not a broken session

- **WHEN** an agent pins `thoughtLevel: "medium"` on a provider whose native vocabulary has no `medium`
- **THEN** nothing is injected, the session runs at the provider default, and a finding naming the model's native levels and the meta words is recorded once

### Requirement: Field-level fail-soft validation

forge.json parsing SHALL degrade semantically invalid content at the smallest enclosing level rather than discarding the file: a syntactically broken document (invalid JSONC) yields the empty agent set plus an error finding; an agent entry with a missing or non-string `model` is skipped with an error finding while its siblings still apply; a `thoughtLevel`/`shape` of the wrong type is ignored with a finding while the agent still materializes. Findings SHALL be surfaced through the plugin's diagnostics channel and never silently swallowed; no fallback seed agents exist in any failure path.

#### Scenario: One bad entry does not disable its siblings

- **WHEN** forge.json defines two agents and one has a missing `model`
- **THEN** the valid agent materializes normally and an error finding names the skipped one

#### Scenario: Broken JSON empties the set with an error finding

- **WHEN** the winning forge.json fails JSONC parsing
- **THEN** no agents are registered and an error finding carries the parse location — the built-in seed is never resurrected

#### Scenario: A mistyped optional field costs only itself

- **WHEN** an agent defines `thoughtLevel: 3` (number)
- **THEN** the agent materializes without depth injection and a finding records the ignored field

### Requirement: Native-task dispatch surface

The plugin SHALL NOT register any dispatch tool: no `forge_dispatch`, `forge_dispatch_config`, `forge_dispatch_list`, or `forge_dispatch_kill`. forge subagents are spawned through the host's native `task` tool, and their runs render in the host UI with the native subagent affordances (progress visibility, expandable transcript). Plan-draft interop SHALL be inherited from the plan harness's existing spawn-class deny (the `task` tool is already denied while a draft exists); the plugin adds no dispatch-specific refusal.

#### Scenario: No dispatch tools are registered

- **WHEN** the plugin's tool registrations are enumerated on a v1 host
- **THEN** none of the forge_dispatch family appears; the subagent vocabulary is reachable only through the native task tool

#### Scenario: A task call runs the pinned brain

- **WHEN** the model dispatches `task {subagent_type: "forge-research", prompt: ...}` on a host where `prov/x` is configured
- **THEN** the subagent session runs on the pinned `prov/x` identity with the materialized permission and discipline

#### Scenario: Draft-plan interop is inherited

- **WHEN** the session has an active draft plan and the model attempts a task call to a forge subagent
- **THEN** the existing plan-harness write ban refuses it exactly as for any native task call — no plugin-side dispatch refusal exists to bypass or maintain
