# dispatch Specification (delta)

> Baseline note: this delta is written against the post-archive baseline of
> `add-dispatch-suite` (not yet archived). Archive order MUST be
> `add-dispatch-suite` first, this change second.

## REMOVED Requirements

### Requirement: Roster keyed by full provider/model identity with exposure tables

- **Reason**: the roster/expose/profiles concept set is too heavy for both humans and AI to configure correctly, and its zero-config auto-generation of dispatchable entries for unlisted configured identities was ruled out by the owner (configured ≠ usable; live evidence: keyless endpoints fail deterministically on restricted toolsets). Dispatch configuration moves to the dedicated `forge.json` with per-agent `{model, depths}` definitions.
- **Migration**: existing inline `dispatch.roster`/`dispatch.tiers` options keep working through the legacy resolution path (documented in the README advanced section). New configuration happens in `forge.json` (see ADDED requirements). No user file is migrated automatically — the plugin never writes user config.

### Requirement: Startup validation checklist

- **Reason**: depth-policing at config time contradicts the owner ruling (zero config-time validation; the provider is the final judge of a depth word and its raw error flows back through the honest report). The checklist's remaining legitimate concern (surfacing the unconfigured state) is covered by the seed onboarding notice.
- **Migration**: unconfigured installs get a startup notice pointing at the recipe; mis-set depth words surface at dispatch time as provider errors carried verbatim, or as `no-native-mapping` errors listing both vocabularies. The checklist's dead-key warning survives only on the legacy inline path, kept by the legacy clause of the modified "Exact-match resolution with no clamping" requirement.

### Requirement: Tier materialization as the permission vehicle

- **Reason**: tiers as a separate concept disappear from the primary surface; dispatch roles are user-defined agents in `forge.json`.
- **Migration**: see ADDED "Agent materialization as the permission vehicle" — same protection properties (hidden subagent, deny-style permission, `task: deny` forced, create-only, never a `model` field), sourced from agent definitions.

## MODIFIED Requirements

### Requirement: Exact-match resolution with no clamping

`resolve(agent, depth)` SHALL resolve against the agent definition from `forge.json`: the model is user-pinned (the request SHALL NOT carry a model; a broken or unconfigured pinned model SHALL error naming it — never fall back to another model). The ONLY config-side validation SHALL be dispatch-time set membership: a requested `depth` MUST appear in that agent's `depths` verbatim (default = the first entry; an out-of-set depth errors listing the agent's set). Depth words SHALL come from the canonical metalanguage (`none`, `low`, `medium`, `high`, `max`) or be native level names passed through verbatim as an escape hatch. Translation to the provider's native parameter SHALL follow the three hard rules: **verbatim-first** (a meta word that is natively valid passes as-is), **no interpolation** (a meta word with no counterpart on the model errors listing both vocabularies — never a nearest guess), **full disclosure** (the report shows `canonical <word> → native <word>`). The legacy inline roster/tiers path SHALL keep its existing exact-match semantics, including the one-retry-excluding-a-failed-identity rule and the startup dead-key warning for unknown keys in inline rosters; the agents path SHALL have no alternative-candidate retry (a pinned model that fails reports the honest error).

#### Scenario: Out-of-set depth is a hard error

- **WHEN** the main agent dispatches agent=research depth=max and research declares `depths: ["low", "medium", "high"]`
- **THEN** the call errors listing the agent's allowed set, and nothing is spawned

#### Scenario: Meta word with no native counterpart errors, never interpolates

- **WHEN** an agent's model natively offers `none, low, medium, XHigh` and a dispatch requests canonical `high`
- **THEN** the dispatch errors naming both vocabularies (the model's native levels and the meta words available on it); the plugin does not silently pick `medium` or `XHigh`

#### Scenario: Pinned agent model unavailable errors with the recipe

- **WHEN** an agent pins a model that is not configured on the host (including the built-in placeholder `Local/GPT Luna`)
- **THEN** dispatch errors naming the pinned model and the error carries the configuration recipe (see the seed onboarding requirement); no other model is used

#### Scenario: Requested depth nobody exposes is a hard error

- **WHEN** a dispatch names a legacy inline tier (agent id = tier name) at a depth that no candidate serving that tier exposes
- **THEN** the dispatch call returns a structured error listing every candidate's exposure and the available depth vocabulary, and nothing is spawned

#### Scenario: Pinned model unavailable errors without fallback

- **WHEN** a legacy inline tier pins `model: "zai-coding-plan/glm-5.3"` with `depth: "max"` and that identity is not currently available
- **THEN** dispatch errors naming the pinned identity and suggesting fixing or unpinning it; no other model is used

#### Scenario: One retry after a mid-dispatch failure

- **WHEN** a legacy inline tier's resolved identity fails during the dispatch attempt
- **THEN** resolution retries once excluding that identity and the result reports which identity actually served the dispatch; an agents-path dispatch (model pinned per definition) never retries with another model — the honest error is reported

### Requirement: forge_dispatch tool contract

The plugin SHALL register a `forge_dispatch` tool on the forge agent taking `{prompt, agent, depth?, background?}` (`agent` names a dispatch agent from `forge.json`; `depth` defaults to the agent's first depths entry and must be a member of that agent's set). The tool SHALL create a child session on the host instance via the plugin input's bundled client, attach the materialized agent via the message body's `agent` field and the pinned model via the body's `model` field, poll for completion with a per-dispatch deadline (`dispatch.timeoutMs`, default 600000, max 600000), and return an honest report: `{agent, requested:{agent,depth}, actual:{model,depth}, sessionID, durationMs, tokens{...}, costUsd|null, text, depthTranslation}` where `depthTranslation` discloses `canonical → native` (or "verbatim"). Concurrent dispatches beyond `dispatch.maxConcurrent` (default 4) SHALL be refused with a retry hint. When `agent["forge"].disable` is set the tool SHALL not be registered.

#### Scenario: A successful dispatch reports actuals honestly

- **WHEN** forge_dispatch runs agent=research depth=low and the child session completes
- **THEN** the result names the pinned model, the actual depth with its `canonical → native` disclosure (`depthTranslation`), real token counts, a self-computed cost, and the worker's concluding text

#### Scenario: Timeout reports partial state

- **WHEN** a child session does not finish within the deadline
- **THEN** the tool returns a timeout report with the sessionID, elapsed time, and any partial transcript pointer; the session is left for the host to reclaim

#### Scenario: Concurrency cap refuses excess dispatches

- **WHEN** four dispatches are in flight and a fifth arrives
- **THEN** the fifth is refused with the current in-flight count and a retry hint

### Requirement: Reasoning-depth injection via chat params

For every dispatched child session the plugin SHALL translate the resolved depth to the provider's native parameter and stamp it onto the LLM request via the `chat.params` hook, keyed by sessionID, using a per-family map: effort-style families (OpenAI-compatible) receive the effort word (verbatim when natively valid, else via the family table); budget-style families (Anthropic-style) receive a documented budget tier per meta word (`none` → thinking off; `low`/`medium`/`high`/`max` → published budget table); toggle-style families receive on/off. The verbatim-first, no-interpolation and full-disclosure rules SHALL govern translation. For a provider absent from the map the plugin SHALL inject nothing and the dispatch result SHALL disclose "depth not injected (unknown provider shape)". The injected value SHALL remain stable for the whole worker session (never rewritten mid-session).

#### Scenario: Depth reaches the provider request

- **WHEN** a dispatch on an OpenAI-compatible identity resolves depth `low`
- **THEN** the child session's chat.params hook writes `options.reasoningEffort = "low"` exactly once for that session's first turn

#### Scenario: Budget family gets a published tier

- **WHEN** a dispatch on an Anthropic-style identity resolves canonical `high`
- **THEN** the injected option carries the documented budget tier for `high` and the report discloses `canonical high → native budget:<tier>`

#### Scenario: Unknown provider shape is disclosed, not guessed

- **WHEN** a dispatch lands on a provider whose option shape the map does not know
- **THEN** no option is injected and the result reports `depth not injected (unknown provider shape)`

### Requirement: Worker prompt discipline

Every dispatched prompt SHALL be wrapped with the outer discipline template, which SHALL mandate: workspace-relative paths only (never absolute paths), verbatim reporting of tool refusals instead of improvising workarounds, and conclusions with evidence references; the template SHALL differ by agent shape (readonly agents are told to report, not to work around restrictions). Inside the wrapper, the role prompt SHALL come from the agent definition: an explicit `prompt` overrides everything; a built-in role (research, review) has a curated default; a custom agent without `prompt` gets the generic worker prompt.

#### Scenario: Worker gets the relative-path discipline

- **WHEN** a dispatch is made and the composed child prompt is inspected
- **THEN** it contains the workspace-relative-path mandate and the verbatim-refusal-reporting mandate, wrapped around the agent's role prompt

#### Scenario: A custom role prompt rides inside the discipline wrapper

- **WHEN** an agent defines `prompt: "You are a dependency auditor..."`
- **THEN** the child prompt contains that role text inside the outer discipline template — the three mandates are never replaceable

### Requirement: Background dispatch mode

`forge_dispatch` SHALL accept `background: true`: resolution happens eagerly at submit time (set-membership and pin errors return synchronously with nothing spawned), the child session is created, and the tool returns immediately with `{dispatchId, agent, requested, resolved, queuedAt}`. The concurrency cap (`dispatch.maxConcurrent`, default 4) SHALL be one global slot pool shared by sync and background dispatches; over-cap submits are refused with the in-flight count and a retry hint. Every background dispatch carries the same per-dispatch deadline as sync mode, and every terminal state (completed / timeout / killed / error) SHALL be both appended to the ledger and delivered to the parent session — a background dispatch SHALL never be silently dropped.

#### Scenario: Background submit resolves eagerly and returns a handle

- **WHEN** `forge_dispatch` is called with `background: true` and a valid agent/depth
- **THEN** the call returns promptly with the dispatchId, the resolved identity, and queued state — no result text yet, and resolution errors (if any) would have returned synchronously before any session was created

#### Scenario: Shared cap refuses over-cap background submits

- **WHEN** four dispatches (any mix of sync and background) are in flight and a fifth background submit arrives
- **THEN** it is refused with the current in-flight count and a retry hint, identical to the sync refusal

## ADDED Requirements

### Requirement: Dedicated forge.json configuration file

Dispatch agents SHALL be configured in a dedicated `forge.json` (JSONC — comments allowed), resolved by three-level cascade with a single winning source (no merging): project `<project>/.opencode/forge.json` (versionable, team-shared) over global `~/.config/opencode/forge.json` over the built-in seed. The file SHALL define `agents` as a map of agent id (`[a-z0-9-]`) to `{model, depths, prompt?, shape?, permission?}`. Configuration SHALL hot-apply: the plugin re-reads the file (mtime-cached) before each dispatch, so edits take effect on the next dispatch without a host restart. The plugin SHALL only ever READ this file — it SHALL NOT create, write, or migrate it. Host-level knobs (`dispatch.timeoutMs`, `dispatch.maxConcurrent`, `dispatch.disable`) remain inline plugin options and are unaffected.

#### Scenario: Project file wins over global

- **WHEN** both `<project>/.opencode/forge.json` and `~/.config/opencode/forge.json` exist
- **THEN** the project file fully determines the agent set; the global file is not merged in

#### Scenario: Edits hot-apply without restart

- **WHEN** a running host has dispatched once and the user (or their session AI) edits `forge.json`
- **THEN** the next dispatch reflects the new file content; no host restart is required

#### Scenario: The plugin never writes the file

- **WHEN** any plugin lifecycle event occurs (load, dispatch, error)
- **THEN** `forge.json` is only read; onboarding happens through the error recipe, never by generating the file

### Requirement: Seed placeholder onboarding

The built-in seed SHALL define exactly two readonly agents: `research` with `depths ["low","medium"]` and `review` with `depths ["medium","high","max"]`, both pinned to the placeholder model `Local/GPT Luna` (an identity that never resolves). When dispatch is unconfigured, any `forge_dispatch` call SHALL fail with `pin-unavailable` naming the placeholder, and the error SHALL carry a machine-actionable recipe: the detected configured identity strings (no ladders), the file paths to create, a copy-paste template block with inline comments, a verification dispatch, and the extension hints (write agents need `shape: "write"`; more agents are more entries). At startup the unconfigured state SHALL surface one notice pointing at the same recipe (e.g. "ask your session AI to configure dispatch").

#### Scenario: First dispatch on a fresh install teaches configuration

- **WHEN** a fresh install calls `forge_dispatch {prompt, agent: "research"}`
- **THEN** the error names the placeholder pin and carries the full recipe (detected identities, paths, template, verify step)

#### Scenario: Startup notice for the unconfigured state

- **WHEN** the host starts and no forge.json exists
- **THEN** startup findings carry one notice describing the unconfigured dispatch state and where the recipe lives

### Requirement: Agent materialization as the permission vehicle

The config hook SHALL materialize agent entries as hidden `mode: subagent` agents `forge-<agent>` (create-only: a user-defined entry of the same id is never touched), carrying the agent's role prompt (from `prompt` or the role default) and a deny-style permission: `shape: "readonly"` (the default) denies mutating tools, `shape: "write"` allows them, an explicit `permission` map overrides the shape-derived default — and every agent SHALL deny `task` regardless (recursive dispatch stays physically impossible). Agent entries SHALL NEVER set a `model` field — the brain is bound by the agent definition's pinned model at dispatch time. Materialization SHALL re-run on the plugin config hook (host config reload): hot-applied `forge.json` edits affect dispatch resolution immediately, while added/removed agents materialize only after the next config hook — that documented lag never blocks dispatch (the dispatch message body carries the agent name), and user-defined same-id entries are never touched. When `agent["forge"].disable` is set no agents SHALL be registered and the Tab cycle SHALL continue to contain only `forge` as the primary subject.

#### Scenario: Agent entries are hidden and modelless

- **WHEN** the plugin loads with a forge.json and the injected agent set is inspected
- **THEN** each `forge-<agent>` is a hidden subagent with no `model` field and a deny-style permission including `task: deny`

#### Scenario: permission override keeps the recursion ban

- **WHEN** an agent sets `permission: {"bash": "deny"}` with `shape: "write"`
- **THEN** the materialized permission honors the override and still carries `task: deny`

#### Scenario: A user-defined agent entry is never clobbered

- **WHEN** the user has their own `agent["forge-research"]` configuration
- **THEN** the plugin skips injection for that id and the user's entry stands

### Requirement: forge_dispatch_config introspection

The plugin SHALL register a read-only `forge_dispatch_config` tool returning exactly the round-trip configuration shape plus validation state: the effective `agents` map (as defined in the winning forge.json, or the seed), the inline `knobs` {timeoutMs, maxConcurrent}, and current `findings`. It SHALL NOT invent discovery fields (no vocabulary constants, no detected identities, no in-flight state — in-flight belongs to `forge_dispatch_list`). The output SHALL be writable back as valid forge.json `agents` content, so a session AI can read state and edit the file in the same shape.

#### Scenario: Round-trip shape

- **WHEN** forge_dispatch_config is called on a configured host
- **THEN** the `agents` field mirrors the winning forge.json (same keys, same value shapes) alongside knobs and findings, and nothing else

#### Scenario: Unconfigured state reports the seed

- **WHEN** no forge.json exists
- **THEN** forge_dispatch_config reports the seed agents (research/review pinned to the placeholder) and the unconfigured finding
