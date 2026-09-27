# dispatch Specification

## Purpose
Scoped worker dispatch for the forge agent: forge.json-defined agents (model pinned, depth from a canonical metalanguage translated per provider family, permission shape materialized as hidden subagents) dispatched as child sessions with honest actuals-only reporting, background handles with wake briefs, and a dispatch ledger. The plugin reads user configuration and never writes it.

## Requirements

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

The turn-synchronous message POST SHALL be transport-recovery safe: when the POST rejects at the transport level (fetch abort or network failure — anything that is not an HTTP error response) and a child session exists, the engine SHALL NOT fail the dispatch; it SHALL ledger a `transport-interrupted` event (carrying the child sessionID, dispatchId when background, and elapsed time) and fall through to the normal completion polling under the same per-dispatch deadline. The engine SHALL NOT re-POST the message during recovery (the prompt may already have been delivered — re-sending could duplicate work). If the child completes within the deadline, the dispatch reports normally (completed); if the deadline expires first, the timeout semantics above apply; if the message was never delivered (child has no assistant messages), polling degrades to the same honest timeout rather than an empty-response error.

#### Scenario: A successful dispatch reports actuals honestly

- **WHEN** forge_dispatch runs agent=research depth=low and the child session completes
- **THEN** the result names the pinned model, the actual depth with its `canonical → native` disclosure (`depthTranslation`), real token counts, a self-computed cost, and the worker's concluding text

#### Scenario: Timeout reports partial state

- **WHEN** a child session does not finish within the deadline
- **THEN** the tool returns a timeout report with the sessionID, elapsed time, and any partial transcript pointer; the session is left for the host to reclaim

#### Scenario: Concurrency cap refuses excess dispatches

- **WHEN** four dispatches are in flight and a fifth arrives
- **THEN** the fifth is refused with the current in-flight count and a retry hint

#### Scenario: Transport interruption of the turn POST recovers via polling

- **WHEN** the turn-synchronous message POST rejects with a transport-level error (e.g. a runtime fetch timeout or connection reset) 281s into a dispatch whose child session is still running host-side
- **THEN** the dispatch does not fail: a `transport-interrupted` ledger event is recorded with the child sessionID and elapsed time, completion polling continues under the same deadline, and when the child finishes the dispatch reports `completed` with the full honest result (tokens, cost, worker text)

#### Scenario: Undelivered message degrades to an honest timeout

- **WHEN** the turn POST fails at the transport level before the host delivered the message (the child session never produces assistant messages)
- **THEN** recovery polling never fabricates completion or an empty-response error; the dispatch ends in the deadline `timeout` state naming the child session

#### Scenario: HTTP error responses are not recovered

- **WHEN** the turn POST returns an HTTP error response (non-2xx) or a dispatch API call rejects with a structured host error
- **THEN** the existing error semantics stand (no recovery polling is started for API refusals)

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

### Requirement: Cost reporting with self-computed prices

Dispatch results SHALL take token counts from the host message info (never fabricated) and compute cost locally from a cached models.dev price snapshot against the actual identity, labeling the snapshot; when no price exists for the identity the result SHALL report `costUsd: null` with a "price unavailable" note — never `0`.

#### Scenario: Tokens real, cost computed

- **WHEN** a dispatch completes on an identity priced in the snapshot
- **THEN** the report's tokens match the host message info and costUsd equals the snapshot-priced sum with a snapshot label

#### Scenario: Unpriced identity reports null

- **WHEN** the serving identity has no price in the snapshot (e.g. a custom provider)
- **THEN** `costUsd` is null with a "price unavailable" note, not zero

### Requirement: Draft-plan interop and dispatch ledger

While the session has an active draft plan, `forge_dispatch` SHALL refuse execution (same protection class as the plan-harness write ban — spawning workers during planning is denied), with a message pointing to `plan_approve` or discard. Dispatch events (resolved identity, depth, outcome, token/cost summary, timeouts, lost-on-exit) SHALL append to a bounded ledger under `<tmp>/opencode-forge/dispatch/` (capped rotation like the existing ledgers). Terminal and outcome ledger events SHALL be self-describing: they SHALL carry the dispatchId and parentSessionID when known, the child sessionID when one exists, and the elapsed durationMs. Child sessions are host memory objects: on host exit they vanish, and in-flight dispatches SHALL be recorded as `lost-on-exit` (no survive semantics).

#### Scenario: Dispatch refused during plan draft

- **WHEN** the session has an active draft plan and the model calls forge_dispatch
- **THEN** the call is refused with a pointer to plan_approve or /plan discard

#### Scenario: In-flight dispatches die with the host, honestly

- **WHEN** the opencode host exits while dispatches are in flight
- **THEN** no orphan processes remain (sessions are memory objects) and the ledger records the in-flight entries as lost-on-exit

#### Scenario: Terminal ledger rows are self-describing

- **WHEN** a background dispatch terminates in error or timeout after its child session was created
- **THEN** the terminal ledger row carries its dispatchId, parentSessionID, child sessionID, and durationMs — the row can be attributed without cross-referencing other rows

### Requirement: Worker prompt discipline

Every dispatched prompt SHALL be wrapped with the outer discipline template, which SHALL mandate: workspace-relative paths only (never absolute paths), verbatim reporting of tool refusals instead of improvising workarounds, and conclusions with evidence references; the template SHALL differ by agent shape (readonly agents are told to report, not to work around restrictions). Inside the wrapper, the role prompt SHALL come from the agent definition: an explicit `prompt` overrides everything; a built-in role (research, review) has a curated default; a custom agent without `prompt` gets the generic worker prompt.

#### Scenario: Worker gets the relative-path discipline

- **WHEN** a dispatch is made and the composed child prompt is inspected
- **THEN** it contains the workspace-relative-path mandate and the verbatim-refusal-reporting mandate, wrapped around the agent's role prompt

#### Scenario: A custom role prompt rides inside the discipline wrapper

- **WHEN** an agent defines `prompt: "You are a dependency auditor..."`
- **THEN** the child prompt contains that role text inside the outer discipline template — the three mandates are never replaceable

### Requirement: Background dispatch mode

`forge_dispatch` SHALL accept `background: true`: resolution happens eagerly at submit time (set-membership and pin errors return synchronously with nothing spawned), the child session is created, and the tool returns immediately with `{dispatchId, agent, requested, resolved, queuedAt}`. The concurrency cap (`dispatch.maxConcurrent`, default 4) SHALL be one global slot pool shared by sync and background dispatches; over-cap submits are refused with the in-flight count and a retry hint. Every background dispatch carries the same per-dispatch deadline as sync mode, and every terminal state (completed / timeout / killed / error) SHALL be both appended to the ledger and delivered to the parent session — a background dispatch SHALL never be silently dropped. Terminal reports and registry results SHALL carry the child sessionID whenever a child session was created, and a timeout terminal report SHALL state that the child session is left running host-side with its transcript queryable. A transport-level interruption of the turn POST SHALL NOT by itself terminate a background dispatch while recovery polling (same deadline) can still deliver the child's result.

#### Scenario: Background submit resolves eagerly and returns a handle

- **WHEN** `forge_dispatch` is called with `background: true` and a valid agent/depth
- **THEN** the call returns promptly with the dispatchId, the resolved identity, and queued state — no result text yet, and resolution errors (if any) would have returned synchronously before any session was created

#### Scenario: Shared cap refuses over-cap background submits

- **WHEN** four dispatches (any mix of sync and background) are in flight and a fifth background submit arrives
- **THEN** it is refused with the current in-flight count and a retry hint, identical to the sync refusal

#### Scenario: Transport interruption does not false-terminal a background dispatch

- **WHEN** a background dispatch's turn POST dies at the transport layer while its child session keeps running host-side
- **THEN** the dispatch stays non-terminal (no error/timeout is recorded at that moment); if the child completes within the deadline the parent receives the completed brief as usual, and only a genuine deadline expiry produces the timeout brief

#### Scenario: Terminal results carry the child sessionID

- **WHEN** a background dispatch reaches any terminal state after its child session was created
- **THEN** the registry result delivered in the brief (and visible in `forge_dispatch_list`) carries the child sessionID, not an empty string

### Requirement: Completion wake briefs

When the parent session is idle and background dispatches have reached terminal states since the last idle, the plugin SHALL inject one coalesced `[forge:dispatch-complete]` brief carrying every finished dispatch's full result object (same shape as the sync report, including timeout and error reports). Briefs SHALL be debounced (a burst of completions yields one brief), SHALL never interrupt an active turn (delivery waits for the next idle), each terminal dispatch SHALL appear in exactly one brief, and when the goal continuation brief would fire on the same idle the two SHALL coalesce into a single combined re-prompt (never two separate re-prompts for one idle). `forge_dispatch_list` SHALL return in-flight dispatches and recent terminal results (with dispatchIds) so the model can recover state after context compaction.

#### Scenario: Completions wake an idle parent once

- **WHEN** two background dispatches complete while the parent session is idle
- **THEN** a single `[forge:dispatch-complete]` brief arrives carrying both full result objects

#### Scenario: No interruption of an active turn

- **WHEN** a background dispatch completes while the parent is mid-turn
- **THEN** the brief waits for the next idle and the running turn is not interrupted

#### Scenario: Recovery after compaction

- **WHEN** the parent context was compacted and the model calls `forge_dispatch_list`
- **THEN** in-flight dispatches and recent terminal results are listed with their dispatchIds

### Requirement: Background kill, run-mode disclosure and host-exit honesty

`forge_dispatch_kill {dispatchId}` SHALL attempt a best-effort abort of the child session and, regardless of whether the host exposes an abort API, SHALL stop polling, suppress the completion brief for that dispatch, and ledger the outcome as killed (or kill-failed with reason; a result arriving after a kill is discarded and noted). In `opencode run` (non-interactive) mode a finished session cannot be re-prompted: the `forge_dispatch` tool description SHALL disclose that background mode targets live TUI sessions and sync mode is recommended under run mode; completions landing after session end are ledger-only. On host exit, all in-flight background dispatches SHALL be ledgered `lost-on-exit` (sessions are host memory objects; no orphan processes).

#### Scenario: Kill stops the wake and ledgers honestly

- **WHEN** `forge_dispatch_kill` is called on an in-flight background dispatch
- **THEN** no completion brief fires for it and the ledger records the kill outcome (or the kill failure reason)

#### Scenario: Run-mode background completion is ledger-only

- **WHEN** a run-mode session ends before a background dispatch completes
- **THEN** the completion is recorded in the ledger only and no wake is attempted

#### Scenario: Host exit marks in-flight background dispatches

- **WHEN** the host exits with background dispatches in flight
- **THEN** the ledger records each as lost-on-exit

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
