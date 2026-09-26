# dispatch Specification (delta)

## ADDED Requirements

### Requirement: Roster keyed by full provider/model identity with exposure tables

The dispatch roster SHALL key every entry by the complete `provider/model` identity (opencode's dispatch key); bare model-name matching SHALL NOT exist (same model name across providers means separate entries with independently curated exposure, priority, and price). Each entry SHALL declare `expose` — the set of reasoning levels that identity offers to dispatch, written as **native level names passed through verbatim**. When an entry omits `expose`, it SHALL default to that identity's full native ladder discovered from the models.dev catalog. Configured identities absent from the user's roster SHALL receive generated default entries (default tiers quick/scout, full native ladder). Availability discovery SHALL use the full catalog plus config overrides, never the availability-gated provider list (keyless providers must remain visible).

#### Scenario: Same-name model on two providers is two entries

- **WHEN** the user configures both `zai-coding-plan/glm-5.3` and `opencode-go/glm-5.3` and curates different `expose` sets on two roster entries
- **THEN** dispatch treats them as independent candidates with their own exposure, declaration order, and price

#### Scenario: Unlisted configured model gets a default entry

- **WHEN** a configured identity is not listed in the user's roster
- **THEN** dispatch generates a default entry for it with default tiers and the full native ladder as exposure

### Requirement: Exact-match resolution with no clamping

`resolve(tier, depth)` SHALL select candidates that serve the tier, are available, and whose `expose` contains the requested depth **exactly**; ranking SHALL be by roster declaration order then cost tier. There SHALL be no automatic clamping, interpolation, or substitution of reasoning depth anywhere in the system. When no candidate matches, resolution SHALL fail with a structured error carrying the full menu (each candidate identity's exposure and unavailability reason). A tier pinned to a specific model (`model` pin) SHALL skip roster resolution; a pinned model that is unavailable SHALL error naming the pin (never fall back to another model). One retry excluding a failed identity SHALL be permitted per dispatch.

#### Scenario: Requested depth nobody exposes is a hard error

- **WHEN** the main agent dispatches profile=build depth=medium and no build candidate exposes `medium`
- **THEN** the dispatch call returns a structured error listing every candidate's exposure and the available depth vocabulary, and nothing is spawned

#### Scenario: Pinned model unavailable errors without fallback

- **WHEN** a tier pins `model: "zai-coding-plan/glm-5.3"` with `depth: "max"` and that identity is not currently available
- **THEN** dispatch errors naming the pinned identity and suggesting fixing or unpinning it; no other model is used

#### Scenario: One retry after a mid-dispatch failure

- **WHEN** the resolved identity fails during the dispatch attempt
- **THEN** resolution retries once excluding that identity and the result reports which identity actually served the dispatch

### Requirement: forge_dispatch tool contract

The plugin SHALL register a `forge_dispatch` tool on the forge agent taking `{prompt, profile, depth?}` (depth defaults to the tier's `defaultDepth`; a tier whose default is dead SHALL be depth-required — omitted depth errors with the menu). The tool SHALL create a child session on the host instance via the plugin input's bundled client, attach the materialized tier agent via the message body's `agent` field and the model via the body's `model` field, poll for completion with a per-dispatch deadline (`dispatch.timeoutMs`, default 600000, max 600000), and return an honest report: `{tier, requested:{profile,depth}, actual:{model,depth}, sessionID, durationMs, tokens{input,output,reasoning,cacheRead,cacheWrite}, costUsd|null, text}`. Concurrent dispatches beyond `dispatch.maxConcurrent` (default 4) SHALL be refused with a retry hint. When `agent["forge"].disable` is set the tool SHALL not be registered.

#### Scenario: A successful dispatch reports actuals honestly

- **WHEN** forge_dispatch resolves scout/low to an available identity and the child session completes
- **THEN** the result object names the actual provider/model identity and depth (identical to requested — exact match), real token counts, a self-computed cost, and the worker's concluding text

#### Scenario: Timeout reports partial state

- **WHEN** a child session does not finish within the deadline
- **THEN** the tool returns a timeout report with the sessionID, elapsed time, and any partial transcript pointer; the session is left for the host to reclaim

#### Scenario: Concurrency cap refuses excess dispatches

- **WHEN** four dispatches are in flight and a fifth arrives
- **THEN** the fifth is refused with the current in-flight count and a retry hint

### Requirement: Tier materialization as the permission vehicle

The config hook SHALL materialize tier agents `forge-<tier>` as hidden `mode: subagent` entries (create-only: a user-defined entry of the same id is never touched), carrying the tier's discipline prompt and deny-style permission (mutating tools denied per shape; every tier SHALL deny `task` to physically prevent recursive dispatch). Tier entries SHALL NEVER set a `model` field — the brain is bound per dispatch by the request body. Tier ids SHALL match `[a-z0-9-]`. A custom tier without an explicit `shape` SHALL default to readonly. When `agent["forge"].disable` is set no tier agents SHALL be registered, and the Tab cycle SHALL continue to contain only `forge` as the primary subject.

#### Scenario: Tier agents are hidden and modelless

- **WHEN** the plugin loads and the injected agent set is inspected
- **THEN** each `forge-<tier>` is a hidden subagent with no `model` field and a deny-style permission including `task: deny`

#### Scenario: A user-defined tier entry is never clobbered

- **WHEN** the user has their own `agent["forge-build"]` configuration
- **THEN** the plugin skips injection for that id and the user's entry stands

#### Scenario: One-knob disable removes tiers too

- **WHEN** `agent["forge"].disable: true` is set and opencode restarts
- **THEN** no `forge-<tier>` agents exist and `forge_dispatch` is not registered

### Requirement: Reasoning-depth injection via chat params

For every dispatched child session the plugin SHALL stamp the resolved native depth onto the LLM request via the `chat.params` hook, keyed by sessionID, using a per-provider option map (OpenAI-compatible `reasoningEffort`; Anthropic-style `thinking`; Z.ai GLM `thinking` toggle/effort shape); for a provider absent from the map the plugin SHALL inject nothing and the dispatch result SHALL disclose "depth not injected (unknown provider shape)". The depth SHALL remain stable for the whole worker session (never rewritten mid-session).

#### Scenario: Depth reaches the provider request

- **WHEN** a dispatch on an OpenAI-compatible identity resolves depth `low`
- **THEN** the child session's chat.params hook writes `options.reasoningEffort = "low"` exactly once for that session's first turn

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

### Requirement: Startup validation checklist

At load the plugin SHALL run the full validation checklist and surface findings at startup: roster identities not configured (dead keys) warn by name; `expose` entries not in the identity's known native ladder error listing the legal values, while providers unknown to the catalog are accepted verbatim with an "unverified" notice; a tier `defaultDepth` no candidate exposes warns and degrades the tier to depth-required (the default is removed, never silently replaced); `profiles` referencing nonexistent tiers warn; tier ids violating `[a-z0-9-]` warn.

#### Scenario: Dead default depth degrades to depth-required

- **WHEN** the quick tier defaults to `off` and no quick candidate exposes `off`
- **THEN** startup warns naming the tier and the menu shows quick as depth-required; a depthless quick dispatch errors with the menu

#### Scenario: Expose typo fails fast

- **WHEN** a roster entry lists `"hihg"` in expose for a catalog-known identity
- **THEN** startup errors listing the identity's legal level names

### Requirement: Draft-plan interop and dispatch ledger

While the session has an active draft plan, `forge_dispatch` SHALL refuse execution (same protection class as the plan-harness write ban — spawning workers during planning is denied), with a message pointing to `plan_approve` or discard. Dispatch events (resolved identity, depth, outcome, token/cost summary, timeouts, lost-on-exit) SHALL append to a bounded ledger under `<tmp>/opencode-forge/dispatch/` (capped rotation like the existing ledgers). Child sessions are host memory objects: on host exit they vanish, and in-flight dispatches SHALL be recorded as `lost-on-exit` (no survive semantics).

#### Scenario: Dispatch refused during plan draft

- **WHEN** the session has an active draft plan and the model calls forge_dispatch
- **THEN** the call is refused with a pointer to plan_approve or /plan discard

#### Scenario: In-flight dispatches die with the host, honestly

- **WHEN** the opencode host exits while dispatches are in flight
- **THEN** no orphan processes remain (sessions are memory objects) and the ledger records the in-flight entries as lost-on-exit

### Requirement: Worker prompt discipline

Every dispatched prompt SHALL be wrapped with the tier's discipline template, which SHALL mandate: workspace-relative paths only (never absolute paths), verbatim reporting of tool refusals instead of improvising workarounds, and conclusions with evidence references. The template SHALL differ by tier shape (readonly tiers are told to report, not to work around restrictions).

#### Scenario: Worker gets the relative-path discipline

- **WHEN** a dispatch is made and the composed child prompt is inspected
- **THEN** it contains the workspace-relative-path mandate and the verbatim-refusal-reporting mandate

### Requirement: Background dispatch mode

`forge_dispatch` SHALL accept `background: true`: resolution happens eagerly at submit time (menu and pin errors return synchronously with nothing spawned), the child session is created, and the tool returns immediately with `{dispatchId, tier, requested, resolved, queuedAt}`. The concurrency cap (`dispatch.maxConcurrent`, default 4) SHALL be one global slot pool shared by sync and background dispatches; over-cap submits are refused with the in-flight count and a retry hint. Every background dispatch carries the same per-dispatch deadline as sync mode, and every terminal state (completed / timeout / killed / error) SHALL be both appended to the ledger and delivered to the parent session — a background dispatch SHALL never be silently dropped.

#### Scenario: Background submit resolves eagerly and returns a handle

- **WHEN** `forge_dispatch` is called with `background: true` and a resolvable profile/depth
- **THEN** the call returns promptly with the dispatchId, the resolved identity, and queued state — no result text yet, and resolution errors (if any) would have returned synchronously before any session was created

#### Scenario: Shared cap refuses over-cap background submits

- **WHEN** four dispatches (any mix of sync and background) are in flight and a fifth background submit arrives
- **THEN** it is refused with the current in-flight count and a retry hint, identical to the sync refusal

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
