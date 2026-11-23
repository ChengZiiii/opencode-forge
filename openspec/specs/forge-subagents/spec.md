# forge-subagents Specification

## Purpose
Static, forge.json-defined worker subagents for the forge agent: each definition is either pinned (a model + thoughtLevel atomic pair bound at materialization) or an Auto worker (neither field — the materialized agent carries no model key and inherits the parent session's model at dispatch, provider-default depth); a half-configured pair is rejected per entry. Every definition materializes as a native hidden-from-cycle subagent carrying the worker discipline and a shape-derived permission, and is dispatched through the host's native task tool — TUI-visible, with no plugin-side dispatch engine. The plugin reads user configuration and never writes it.

## Requirements

### Requirement: Static agent definitions in a dedicated forge.json

Subagents SHALL be configured in a dedicated `forge.json` (JSONC — comments allowed), resolved by an opencode-aligned two-layer merge: global `~/.config/opencode/forge.json` as the base layer, plus the NEAREST project `.opencode/forge.json` discovered by walking UP from the discovery anchor directory until the filesystem root (the first file found on the walk is the project layer; no deeper file is consulted); on a host initialized in multiple workspaces, every workspace pool the host has seen materializes as a namespaced family per the *Workspace pool ownership and global fallback* requirement. The anchor SHALL be the session-effective worktree where the plugin can observe one (tool-context worktree with the host launch directory as fallback), and the host anchor set for host-level materialization in the config hook. The two layers SHALL be MERGED, not replaced: the agent maps combine, and on agent-id collision the project definition replaces the global one for that id (per-agent precedence; there is never cross-layer field blending — an agent's definition comes wholly from one layer). The file SHALL define `agents` as a map of agent id to `{model?, thoughtLevel?, prompt?, shape?, permission?}` where the id is a plain role word matching `[a-z0-9-]`: the reserved `forge-` prefix SHALL be stripped from an id (all repetitions) with a warn finding naming the normalized id — the plugin materializes every id as `forge-<ns>-<id>` under its family's namespace, so a prefixed id would double up (`forge-coder` → agent `forge-<ns>-forge-coder`) — and an id that is empty after stripping SHALL be rejected as invalid; when two entries collide after normalization the later entry SHALL be skipped with an error finding (first definition wins). `model` and `thoughtLevel` form an atomic configuration pair: both absent defines an **Auto worker** — the materialized agent carries no `model` key and inherits the parent session's model through the host's native spawn behavior, with no depth injected (the provider default applies); both present defines a **pinned worker** — `model` is the exact `provider/model` identity pinned into the materialized agent and `thoughtLevel` is a pinned reasoning word (canonical `none|low|medium|high|max` or a native level name, verbatim); exactly one of the two present — in either direction, including `thoughtLevel` without `model` — makes the entry invalid: it SHALL be skipped with an error finding naming the agent id and the missing half, while its siblings still apply. A forge.json MAY also declare a top-level `pool` string — a short namespace (`[a-z0-9-]`, at most 24 characters) naming this file's family: EVERY family materializes namespaced (`forge-<ns>-<id>`), and when the field is absent the namespace derives from the file's directory name; an invalid value (wrong type, empty after trim, charset mismatch, or over length) SHALL degrade to a warn finding naming the file plus the directory-name fallback, and the family still materializes. The crew orchestration layer additionally requires a valid declared `pool` as a file-level compliance precondition for crew-governed dispatch (see the crew-harness capability's *Crew-governed dispatch pool-compliance gate*). The legacy `depths` array SHALL be ignored with a deprecation finding and SHALL NOT influence behavior. Configuration SHALL hot-apply: the plugin re-reads the files (mtime-cached) and re-runs the upward workspace-pool discovery at every config hook and every depth-injection lookup, so edits — and the appearance or removal of a project or pool file anywhere on an anchor's ancestor chain — take effect without a host restart. The plugin SHALL only ever READ these files — never create, write, or migrate them. When no forge.json exists in any layer or pool the unconfigured state SHALL be inert: no subagents registered, no errors raised, no AI-facing configuration recipe emitted; onboarding lives in the README for the human operator.

#### Scenario: Project file wins over global

- **WHEN** both `~/.config/opencode/forge.json` (defining `research` and `review`) and a project `.opencode/forge.json` (defining `research` with a different definition) are loadable
- **THEN** the layers MERGE: the effective set contains both `review` (wholly from the global layer) and `research` (wholly from the project layer — the project definition wins for that id, never field-blended)

#### Scenario: A forge--prefixed id is self-healed to its plain role word

- **WHEN** forge.json defines `forge-coder` (and separately `coder` does not exist)
- **THEN** the entry materializes under the normalized id `coder` as `forge-<ns>-coder` — never `forge-<ns>-forge-coder` — and a warn finding names the normalization; when `coder` IS also defined, the later of the two entries is skipped with an error finding and the first definition wins

#### Scenario: The project layer is discovered by walking up

- **WHEN** the discovery anchor is `C:/work/repo/packages/app` and the only project file is `C:/work/repo/.opencode/forge.json`
- **THEN** that file is the project layer (nearest on the ancestor chain wins); a `.opencode/forge.json` at any deeper level would take precedence over it, and no file above it on the chain is consulted once one is found

#### Scenario: A session-visible anchor re-runs discovery where the plugin reads per session

- **WHEN** `crew_begin` executes in a session whose effective worktree differs from the host launch directory
- **THEN** the gate's guidance resolves the project-layer path from the session's anchor (walking up from it), and the load reflects that anchor's chain

#### Scenario: A pool field names the family's namespace

- **WHEN** a workspace pool's forge.json declares `"pool": "aa"` and defines `shader`
- **THEN** the family materializes under the namespace `aa` (the agent id `forge-aa-shader`) regardless of the directory's name — renaming the directory leaves the materialized ids unchanged

#### Scenario: An invalid pool field degrades to a finding plus the fallback

- **WHEN** a forge.json declares `"pool": "Aa Team!"` (charset mismatch) or `"pool": 7` (wrong type)
- **THEN** a warn finding names the file and the invalid value, and the family materializes under the directory-name-derived namespace instead — the family is never dropped for a bad `pool`

#### Scenario: Edits hot-apply without restart

- **WHEN** the user edits a layer's `forge.json` on a running host — or creates/deletes a project file on an anchor's ancestor chain — and the next config hook or depth lookup fires
- **THEN** the materialized agent set and depth lookups reflect the new effective set; no host restart is required

#### Scenario: The plugin never writes the file

- **WHEN** any plugin lifecycle event occurs (load, config hook, chat.params, error)
- **THEN** `forge.json` is only read; the plugin never generates, completes, or migrates it

#### Scenario: Legacy depths field degrades to a finding

- **WHEN** an agent definition carries `depths: ["low", "medium"]` alongside a pinned `model` + `thoughtLevel` pair
- **THEN** the agent still materializes on the pinned pair, a deprecation finding naming the agent is recorded, and the `depths` array does not influence behavior

#### Scenario: Unconfigured state is inert

- **WHEN** the host starts with no forge.json in any layer or pool across the whole anchor set
- **THEN** no `forge-*` subagents are registered, no error or recipe is surfaced to the model, and the host behaves exactly as without this capability

#### Scenario: An Auto worker entry is valid

- **WHEN** an agent definition carries neither `model` nor `thoughtLevel`
- **THEN** the entry is accepted with no error finding and materializes as an Auto worker (no `model` key on the materialized agent; the parent session's model applies at dispatch; the provider's default depth applies)

#### Scenario: A half-configured entry is rejected in both directions

- **WHEN** one entry defines `model` without `thoughtLevel`, and another defines `thoughtLevel` without `model`
- **THEN** both entries are skipped with an error finding each naming the agent id and the missing half, and the remaining entries still apply

### Requirement: Materialization as native subagents with a pinned model

The config hook SHALL materialize each configured agent as a `mode: subagent` agent `forge-<ns>-<id>` (every family namespaced — plain-id materialization no longer exists) that is visible to the host's native `task` tool vocabulary (discoverable by the model, excluded from the Tab cycle by its subagent mode), a prompt composed of the worker discipline wrapped around the role prompt, and a deny-style permission: `shape: "readonly"` — which MUST be explicit — denies the full mutating-tool family — `write`, `edit`, `bash`, and the host's patch-family tools (`patch`, `applypatch`, `apply`, `multiedit`); `shape: "write"` allows them, and an ABSENT `shape` field SHALL default to `write` (open permissions — readonly is a restriction the pool author must ask for explicitly, never a surprise default); an explicit `permission` map overrides the shape-derived default — and every agent SHALL deny `task` regardless (recursive spawning stays physically impossible). A pinned entry's materialized agent SHALL carry the definition's pinned `model` (the brain is bound at materialization — there is no per-call model selection); an Auto entry's materialized agent SHALL carry no `model` key at all, deferring to the host's native spawn behavior — the parent session's current model binds at dispatch time (snapshot semantics: later primary model switches do not affect already-dispatched runs). The task-vocabulary description SHALL name the role and, for a pinned entry, the pinned brain; an Auto entry's description SHALL state that it inherits the parent session's model instead of claiming a pinned identity. Every description SHALL additionally name the agent's POOL PROVENANCE: its family namespace and origin forge.json path, and — for every family except the global fallback — that the agent is dispatchable only from sessions whose workspace pool is that file; the global fallback family's description names the global layer as its origin. The provenance line is static host-wide truth (per-family, not per-session): the dispatching model meets where an agent belongs before any dispatch gate fires. The worker discipline embedded in the prompt SHALL mandate workspace-relative paths only (never absolute paths outside the workspace), verbatim reporting of tool refusals instead of improvising workarounds, and conclusions carrying evidence references; readonly agents are additionally told to report rather than work around restrictions. Materialization SHALL be create-only: a user-defined entry of the same id is never touched (identically under the v2 `setup` entry point, which registers the same agents on a create-only basis). When `agent["forge"].disable` is set no subagents SHALL be registered.

#### Scenario: Agent entries carry the pinned model

- **WHEN** the plugin loads with a forge.json defining `research: {model: "prov/x", thoughtLevel: "low"}` and the injected agent set is inspected
- **THEN** `forge-<ns>-research` is a subagent-mode agent whose `model` is exactly `prov/x`, listed for the native task tool, with a deny-style permission including `task: deny`

#### Scenario: An Auto worker materializes without a model key

- **WHEN** the plugin loads with a forge.json defining `scout: {}` (no `model`, no `thoughtLevel`, no `shape`) and the injected agent set is inspected
- **THEN** `forge-<ns>-scout` is a subagent-mode agent with no `model` field, listed for the native task tool, with the same deny-style permission including `task: deny`, a description that names inheritance rather than a pinned identity — and, defining no `shape`, OPEN write permissions (the absent-shape default)

#### Scenario: The materialized prompt embeds the discipline

- **WHEN** the composed prompt of a materialized agent is inspected
- **THEN** it contains the workspace-relative-path mandate and the verbatim-refusal-reporting mandate, wrapped around the agent's role prompt (explicit `prompt` overriding the built-in role default)

#### Scenario: The description carries pool provenance

- **WHEN** the task-vocabulary description of a workspace pool's materialized `forge-<ns>-coder` is inspected (on any host, in any session)
- **THEN** it names the namespace `<ns>`, the origin forge.json path of its family, and that it is dispatchable only from sessions whose workspace pool is that file; a global fallback family's description instead names the global layer as its origin — the same static text in every session

#### Scenario: The readonly deny face covers the patch family

- **WHEN** an agent with an EXPLICIT `shape: "readonly"` has its materialized permission enumerated
- **THEN** `patch`, `applypatch`, `apply`, and `multiedit` are denied alongside `write`, `edit`, and `bash`, and `task` stays denied for every shape; the same family governs the draft-phase shape gate's lifting test (a permission override that lifts any of them out of `deny` disqualifies the readonly exemption)

#### Scenario: An absent shape defaults to open permissions

- **WHEN** a pool defines `ta-tool: {model: "prov/x"}` with NO `shape` field and the materialized permission is inspected
- **THEN** the mutating-tool family is not denied (open write permissions), `task` stays denied — and the draft-phase recon exemption does NOT apply to this agent (the exemption keys on an explicitly readonly shape; a shape-less agent is not draft-exempt)

#### Scenario: A permission override keeps the recursion ban

- **WHEN** an agent sets `permission: {"bash": "deny"}` with `shape: "write"`
- **THEN** the materialized permission honors the override and still carries `task: deny`

#### Scenario: A user-defined agent entry is never clobbered

- **WHEN** the user has their own `agent["forge-<ns>-research"]` configuration (v1 or v2 loader)
- **THEN** the plugin skips injection for that id and the user's entry stands

#### Scenario: The disable knob registers nothing

- **WHEN** `agent["forge"].disable: true` is set
- **THEN** no `forge-*` subagents are registered alongside the other plugin silences

### Requirement: Pinned thoughtLevel injection keyed by agent name

For any session running a `forge-<id>` agent, the plugin SHALL translate that agent's pinned `thoughtLevel` to the provider's native parameter and stamp it onto the LLM request via the `chat.params` hook, keyed by the agent name (stable across sessions and spawn paths — no per-dispatch session table). The meta vocabulary SHALL be the seven-word dictionary `none / minimal / low / medium / high / xhigh / max` — a translation dictionary, never a whitelist. The pinned word SHALL be normalized at the configuration boundary (trimmed and lowercased — `High` and `XHigh` behave exactly as `high` and `xhigh`) with a warn finding recorded when normalization changed the value. Wire-shape resolution SHALL be data-driven in a fallback chain: when the models.dev catalog carries `reasoning_options` for the model, the shape (effort word list / toggle / token budget) SHALL come from that data for every provider family EXCEPT anthropic, with the ladder matched case-insensitively and the catalog's native casing emitted on the wire; for the anthropic family the shape SHALL instead be resolved from the empirically verified transport matrix — adaptive-era models receive the adaptive effort channel, legacy-era models receive the budget tier table — regardless of what the catalog carries, because the current host generation's anthropic transport silently drops the effort-word key a catalog effort shape would select. A model the catalog is silent on SHALL fall back to the provider-prefix family map; a provider absent from both SHALL be treated as an effort-word channel by default. A word that matches neither the dictionary nor the model's ladder SHALL pass through VERBATIM on word-shaped channels, disclosed as unverified — the provider is the final judge, and a provider-side rejection surfaces as the request's own error, never swallowed by the plugin. Legacy budget-only models and toggle-only endpoints — the shapes with no word channel — are the only no-counterpart cases: there the plugin SHALL inject nothing and record a bounded finding naming both vocabularies (the worker session itself must never be broken by the plugin). Budget-tier translation on legacy budget models SHALL use the documented tier table per meta word (`none` → thinking off; the table carries tiers for `minimal` and `xhigh`). Adaptive-era Anthropic models SHALL receive the effort word on the empirically verified adaptive effort key; the plugin does not own transport-layer capability probing, so the patched-host presumption (a host generation whose anthropic transport maps the adaptive key onto the wire) is a documented limitation in the README, not a runtime-detectable condition. The verbatim-first and no-interpolation rules SHALL govern every translation (a word passes as-is or is refused with a finding — it is never remapped to a different level). An agent without `thoughtLevel` SHALL inject nothing. The session's first depth resolution — including a no-mapping (dead-end) resolution — SHALL be frozen for the whole session: neither the injected value nor the absence of injection is rewritten mid-session, and configuration edits affect only sessions created afterwards.

#### Scenario: The pinned depth reaches the provider request
- **WHEN** a session runs `forge-research` pinned `thoughtLevel: "low"` on an effort-style family provider
- **THEN** that session's chat.params writes `options.reasoningEffort = "low"` and keeps it stable across turns

#### Scenario: Absent thoughtLevel injects nothing
- **WHEN** an agent defines no `thoughtLevel`
- **THEN** the provider's default applies and no reasoning option is injected

#### Scenario: An untranslatable word degrades to a finding, not a broken session
- **WHEN** a pinned word has no counterpart on a shape with no word channel — a legacy budget-only model offered a word outside the tier table, or a toggle-only endpoint offered `xhigh`
- **THEN** nothing is injected, the session runs at the provider default, and a bounded finding naming the shape's vocabulary and the meta dictionary is recorded once

#### Scenario: Case variants normalize at the boundary
- **WHEN** forge.json pins `thoughtLevel: "High"` (or `"XHigh"`) and the entry loads
- **THEN** the pinned word normalizes to `high` (or `xhigh`), injection behaves exactly as the lowercase word, and a warn finding records the normalization once

#### Scenario: An unknown word passes through on word channels
- **WHEN** an agent pins `thoughtLevel: "ultra"` on an effort-word channel and the model's ladder does not list it
- **THEN** the word is injected verbatim with an unverified disclosure, and any provider-side rejection surfaces as the request's own error — the plugin neither swallows it nor breaks the session itself

#### Scenario: The catalog decides the shape, with prefix fallback
- **WHEN** the models.dev catalog carries `reasoning_options` for the model (effort values / toggle / budget), is silent for another model on a known provider, and absent for a custom provider
- **THEN** the first model translates by its catalog shape (ladder matched case-insensitively, catalog casing emitted), the second falls back to the provider-prefix family, and the third defaults to effort-word pass-through

#### Scenario: Catalog effort metadata does not override the verified anthropic matrix
- **WHEN** the models.dev catalog carries `reasoning_options` of type effort for `anthropic/claude-opus-4-7` and `anthropic/claude-opus-4-6` (as the production catalog does) and agents pin `thoughtLevel: "xhigh"` on each
- **THEN** the adaptive-era model translates on the empirically verified adaptive effort key (never the effort-word key the current host generation's anthropic transport silently drops), and the legacy-era model translates on the budget tier table — the catalog's effort claim for the anthropic family is not consulted for shape selection

#### Scenario: Adaptive-era Anthropic models receive the effort word
- **WHEN** an adaptive-era Anthropic model is pinned `thoughtLevel: "xhigh"` on a host whose anthropic transport maps the adaptive effort key onto the wire
- **THEN** the effort word reaches the wire on that key as-is; the patched-host presumption is documented in the README (the plugin performs no transport-layer capability probing)

#### Scenario: Budget tiers cover the seven-word dictionary
- **WHEN** a legacy budget-tier model is pinned `minimal` or `xhigh`
- **THEN** the documented tier table resolves them (the published floors/caps, including the 1024 API-minimum tier for `minimal`) and the README table remains the verbatim source

#### Scenario: A dead-end resolution freezes like any other
- **WHEN** a session's first depth resolution is a dead end (no-counterpart shape) and the user then edits forge.json mid-session in a way that would make the pinned word translatable
- **THEN** nothing is injected for the remainder of that session and the bounded finding is not re-recorded; a session created after the edit resolves fresh and injects

### Requirement: Field-level fail-soft validation

forge.json parsing SHALL degrade semantically invalid content at the smallest enclosing level rather than discarding more than necessary: a syntactically broken document (invalid JSONC) yields an EMPTY agent set **for its own layer only** plus an error finding carrying the parse location, while the other layer still applies; an agent entry whose `model`/`thoughtLevel` pair is half-configured — exactly one of the two present after field-type normalization, in either direction, or a present `model`/`thoughtLevel` of the wrong type — is skipped with an error finding while its siblings still apply. Findings from every consulted layer SHALL be surfaced through the plugin's diagnostics channel and never silently swallowed; no fallback seed agents exist in any failure path.

#### Scenario: One bad entry does not disable its siblings

- **WHEN** a forge.json defines two agents and one has `model` but no `thoughtLevel`
- **THEN** the valid agent materializes normally and an error finding names the skipped one and its missing half

#### Scenario: Broken JSON empties the set with an error finding

- **WHEN** a layer's forge.json fails JSONC parsing
- **THEN** that layer contributes no agents and an error finding carries the parse location; the other layer still applies (a broken project file over a valid global file leaves the global agents in effect), with no other layer present the effective set is empty — the built-in seed is never resurrected in any case

#### Scenario: A mistyped optional field costs only itself

- **WHEN** an agent pins `model: "prov/x"` but defines `thoughtLevel: 3` (a number)
- **THEN** the mistyped field counts as absent for the atomic-pair check, so the entry is skipped with an error finding — the cost is confined to that entry, and its siblings still materialize

### Requirement: Workspace pool ownership and global fallback

WORKSPACE pool — the nearest `.opencode/forge.json` discovered by walking up from the session's effective worktree — plus the global layer (`~/.config/opencode/forge.json`) as a FALLBACK ONLY: when the workspace has a pool file, the global layer is NOT consulted for that session's dispatch roster (the workspace pool is the whole roster — fallback, not merge); when the workspace has none, the global layer serves as the whole roster. `forge.json` files nested DEEPER in the workspace's subtree (any directory below the owning one) SHALL be ignored entirely — the same workspace-ownership strictness as the host's native MCP config; a git checkout or subfolder carrying its own forge.json does not split or extend the pool. On a host where multiple workspaces' pools have been materialized, the plugin's task-dispatch guard SHALL scope dispatch SESSION-LOCALLY: a task call targeting an agent whose pool belongs to ANOTHER workspace SHALL be refused with a finding that names the target's origin pool path, states it is not dispatchable from this session, and names the exits (open a session in that workspace, or configure the role into this workspace's pool or the global layer). For that guard the session's workspace anchor SHALL be resolved from the host's AUTHORITATIVE session record (`client.session.get`, `effectiveWorktree(worktree, directory)`) whenever the record can be fetched — the plugin's in-memory session map serves as the anchor source ONLY when that fetch fails or is unavailable (no client, API error, or missing record); this ordering exists because the in-memory map has degenerate writers (resumed-after-restart sessions never re-fire `session.created`; some tool-context shapes degenerate to the host launch directory), and a session bound to a pool-less anchor by such a writer would otherwise lose its OWN pool's dispatch rights. The MIRROR degeneration is resolved symmetrically: when the authoritative record yields a valid but POOL-LESS anchor (a resumed-after-restart session re-bound to a new launch directory) while the in-memory binding — kept fresh by the session's own live activity — is a DIFFERENT non-degenerate worktree that OWNS a pool file, the POOLED in-memory binding SHALL win that resolution, with ONE bounded disclosure per session recording the substitution; in every other shape the authoritative record keeps its precedence. The BOTH-DEGENERATE shape — an in-memory binding that is EMPTY (a restart-resumed session before any live activity in the new host life) plus an authoritative record re-bound to a pool-less anchor — is resolved by a PERSISTED SESSION-ANCHOR LEDGER: the plugin maintains a namespaced, bounded JSONL ledger (`<os-tmp>/opencode-forge/session-anchors.jsonl`) mapping session ids to the pooled worktrees where live activity bound them, written ONLY when a bind lands on a worktree owning a pool file (positive evidence of a real pooled binding), deduplicated per session (the last entry wins) and FIFO-capped (compacted to the latest entry per session on overflow), with every ledger read/write failure FAIL-SOFT — resolution degrades to the chain below and dispatch is never blocked by ledger IO. When the chain above yields an anchor that owns NO pool, the guard SHALL consult the ledger; a hit whose worktree still OWNS a pool file on disk (verified at resolution time — a deleted pool file keeps the disappears-from-materialization semantics) SHALL re-bind the session (seeding the in-memory map under the non-degenerate-refinement rule), ALLOW own-pool dispatch, and disclose the re-bind once per session; a cross-pool target from that session remains refused. In that in-memory map, a degenerate anchor (empty or filesystem-root) SHALL never overwrite an existing non-degenerate binding; non-degenerate refinement (session.created seed corrected by a later tool-context binding) keeps today's overwrite semantics. The crew compliance gate resolves its session anchor through the same authoritative-first chain (pooled preference included). EVERY family materializes namespaced: each workspace pool under its declared `pool` namespace (failing that, the sanitized pool-directory basename), and the global fallback layer under the fixed namespace `global` (`forge-global-<id>`) — NO family receives plain ids, so a materialized id is identical on every host regardless of the order workspaces were initialized in. Pool resolution order SHALL be deterministic — families ordered lexicographically by absolute pool-file path — and a cross-family materialized-id collision SHALL resolve in that order: the earlier pool's agent wins, the colliding later agent is skipped with an error finding naming both files. The host-wide materialization set is the union of the global layer and every workspace pool the host has seen (hot-applied per the existing mtime contract; there is no append-only anchor set — a pool file deleted from disk disappears from materialization). Sessions whose workspace cannot be observed (unknown anchor — no in-memory binding AND no authoritative record) keep the existing fail-open belt posture with a disclosure.

#### Scenario: The workspace pool is the whole roster

- **WHEN** a session's worktree is `F:\unity_project\sorenunitylabs` (which carries `.opencode/forge.json`) and `~/.config/opencode/forge.json` also exists with different agents
- **THEN** the session's dispatchable roster is exactly the workspace pool's agents — the global layer is not merged in, and its agents are not dispatchable from this session

#### Scenario: A poolless workspace falls back to the global layer

- **WHEN** a session's worktree has no `.opencode/forge.json` anywhere up its chain and the global layer exists
- **THEN** the global layer serves as the session's whole dispatch roster, its agents materializing namespaced under the fixed `global` namespace (`forge-global-<id>`)

#### Scenario: Nested forge.json files are ignored

- **WHEN** a workspace owns `.opencode/forge.json` at its root and a nested folder (e.g. a cloned repo with its own `.opencode/forge.json`) sits deeper in the subtree
- **THEN** the nested file contributes nothing — no agents, no families — on this host's materialization and no session in the outer workspace can dispatch from it

#### Scenario: Cross-workspace dispatch is refused with exits

- **WHEN** a session in workspace A dispatches a task targeting `forge-<nsB>-coder`, whose pool origin is workspace B's forge.json
- **THEN** the dispatch is refused; the finding names workspace B's forge.json path, states it is not dispatchable from this session, and lists the exits (open a session in workspace B, or configure the role into this workspace's pool / the global layer)

#### Scenario: Own-pool dispatch survives a degraded in-memory binding

- **WHEN** a session was resumed after a host restart (no `session.created` re-fire) and its in-memory binding degraded to a pool-less anchor (host launch directory or empty), while the host's authoritative session record still carries the session's real directory inside a workspace that owns a pool, and the session dispatches its OWN pool's `forge-<ns>-<id>` agent
- **THEN** the guard resolves the anchor from the authoritative record, finds the session's workspace pool, and the dispatch is ALLOWED — the degraded in-memory binding does not strip the session's own-pool dispatch rights

#### Scenario: A pool-less resume-rebound record yields to the pooled in-memory binding

- **WHEN** a session was resumed after a host restart and the authoritative session record carries a POOL-LESS anchor (the new launch directory), while the in-memory binding — refreshed by the session's live activity — holds the session's real pooled worktree, and the session dispatches its OWN pool's `forge-<ns>-<id>` agent
- **THEN** the guard resolves the anchor to the POOLED in-memory binding and ALLOWS the dispatch, with one bounded disclosure recording the substitution; a cross-pool target from the same session is still refused — the preference restores own-pool rights without opening cross-pool leaks

#### Scenario: A pool-less resume record with an empty binding re-binds from the persisted ledger

- **WHEN** a session resumes after a host restart with an EMPTY in-memory map (no live activity in the new host life) and an authoritative record re-bound to a POOL-LESS launch directory, while the persisted session-anchor ledger carries the session's pre-restart pooled worktree whose pool file still exists on disk, and the session dispatches its OWN pool's `forge-<ns>-<id>` agent
- **THEN** the guard re-binds the session from the ledger, seeds the in-memory map, ALLOWS the dispatch, and emits one bounded disclosure recording the re-bind; a cross-pool target from the same session is still refused, and when the ledger's worktree pool file has since been deleted the resolution keeps the global-fallback gate — deletion semantics are preserved

#### Scenario: The authoritative record is unavailable

- **WHEN** the client API call for the session record fails or returns nothing usable and the in-memory map holds a binding
- **THEN** that binding decides the guard exactly as before this change — a cross-pool target is refused with the same copy, an own-pool target is allowed

#### Scenario: A degenerate anchor never clobbers a good binding

- **WHEN** the in-memory map already binds a session to a non-degenerate worktree and a later writer (tool context with a rootish worktree and no directory, or the launch-directory fallback) offers a degenerate anchor
- **THEN** the existing non-degenerate binding is kept — only a non-degenerate anchor may refine (overwrite) the binding

#### Scenario: Same-id agents across workspaces stay collision-free

- **WHEN** two workspaces' pools both define a `coder` agent and both are materialized on one host
- **THEN** each materializes under its own family's namespace — `forge-<nsA>-coder` and `forge-<nsB>-coder` — no silent overwrite and no plain-id privilege for either; the session-local dispatch guard is the authority on which one a given session may call

#### Scenario: Materialized ids are host-history-independent

- **WHEN** the same two workspaces' pools are materialized on two hosts whose initialization orders are opposite (workspace A first on one host, workspace B first on the other)
- **THEN** every materialized agent id is identical across the two hosts — family namespaces never derive from arrival order, so crew plans, rosters, and muscle memory transfer between hosts

#### Scenario: A cross-family materialized-id collision resolves in path order

- **WHEN** two distinct pool files produce the same materialized id (e.g. one defines the id `aa-shader`, the other declares `"pool": "aa"` and defines `shader`)
- **THEN** the deterministic lexicographic file-path order decides: the earlier pool's agent materializes, the later pool's colliding agent is skipped with an error finding naming both files — identically on every host

#### Scenario: Pool deletion un-materializes

- **WHEN** a workspace's forge.json is deleted from disk and the next config hook runs
- **THEN** its agents disappear from the host's materialization set (no append-only residue) and sessions in that workspace fall back to the global layer if one exists

#### Scenario: Unknown session anchor keeps the fail-open belt

- **WHEN** a task-dispatching session's workspace cannot be observed
- **THEN** the existing fail-open belt posture applies, with a disclosure that the session's pool ownership could not be established

### Requirement: Pool-level shared prompt segment

A pool's forge.json MAY declare an optional top-level `shared` field — a string prompt segment inherited by EVERY agent that file materializes. The materialized role prompt SHALL compose as: `shared` (when present and valid) joined by a blank line BENEATH the existing role chain, which is unchanged — an explicit per-agent `prompt` wins over the built-in `research`/`review` defaults, any other id without a prompt gets the generic one-liner, and `shared` never suppresses and never overrides anything (it is the pool's common base, not a replacement for any layer). Validation SHALL be field-level fail-soft: a `shared` that is not a non-empty string after trim records exactly ONE warn finding naming the file (`shared-invalid`) and is ignored — every agent of the pool still materializes with the unshared chain. The GLOBAL fallback file MAY declare `shared` and its family inherits it (the rule that ignores the global file's `pool` namespace field does NOT extend to `shared` — content is not namespace). Changes to `shared` SHALL hot-apply through the existing mtime cache at the next config resolve, exactly like any pool edit. With no `shared` declared anywhere, materialized prompts SHALL be byte-identical to the pre-change build.

#### Scenario: Shared rides beneath an explicit prompt

- **WHEN** a pool declares `"shared": "Project X conventions: …"` and an agent declares its own `prompt`
- **THEN** the materialized role prompt is the shared segment, a blank line, then the agent's explicit prompt — the explicit prompt's priority over role defaults is unchanged

#### Scenario: Shared rides beneath a built-in role default

- **WHEN** a pool declares `shared` and defines `research` WITHOUT a prompt
- **THEN** the materialized prompt is shared + blank line + the built-in research default — the built-in chain is intact beneath the shared base

#### Scenario: Shared rides beneath the generic one-liner

- **WHEN** a pool declares `shared` and defines a prompt-less agent whose id is neither research nor review
- **THEN** the materialized prompt is shared + blank line + the generic one-liner for that id

#### Scenario: Invalid shared warns once and is ignored

- **WHEN** a pool's top-level `shared` is a number, an array, or a whitespace-only string
- **THEN** exactly one warn finding (`shared-invalid`) names the file, the field is ignored, and every agent of the pool materializes with the unshared chain — the pool stays otherwise fully usable

#### Scenario: The global fallback file's shared inherits

- **WHEN** the global `~/.config/opencode/forge.json` declares a valid `shared`
- **THEN** every agent of the global fallback family inherits it — the `pool`-namespace-ignored rule for the global file does not extend to `shared`

#### Scenario: No shared anywhere is byte-identical

- **WHEN** no pool file (workspace or global) declares `shared`
- **THEN** every materialized prompt is byte-identical to the pre-change build, and no finding is recorded

### Requirement: Task shadow surface (native name, forge engine)

The plugin SHALL register its dispatch implementation under the tool name `task`, shadowing the native task tool host-wide, so the TUI drives its native task rendering (the live subagent panel) for forge dispatches. The tool SHALL accept `description`, `prompt`, `subagent_type`, and `run_in_background` and SHALL dispatch ANY materialized target agent via SDK child sessions (child creation with `parentID`, the target agent id, the parent's session directory — resolved from the authoritative session anchor — and the native-parity title): forge-* targets pass the forge dispatch gates (session-domain pool gate with the `not dispatchable from this session` finding, crew pending and pool-compliance belts); non-forge host targets dispatch through the same engine without the forge pool gate — the crew pending belt stays SESSION-keyed (it refuses ANY `task` call per the crew-harness pause semantics, target class notwithstanding) while the pool-compliance belt stays forge-*-keyed. Child-session creation SHALL resolve the ACTUAL client surface on the host with guarded shape probing (the literal `client.session.create` seam is a pre-2.3.2 shape; on hosts where the seam moved or is absent, the tool SHALL adapt to the host's exposed create surface), and when NO create seam is resolvable on the host, the tool SHALL return an honest degradation error naming the native task tool as the available dispatch surface — never a raw TypeError. Child sessions carry tool-part metadata mirroring the native shape (`agent`, `sessionId`, `taskId`, `run_in_background`, `description`, `prompt`). Question policy is mode-keyed: sync dispatches keep questions available (native parity); async (`run_in_background: true`) dispatches create the child with the question tool denied session-wide. Sync dispatches SHALL abort the child when the dispatching turn is aborted; async children survive turn aborts and die at session death. The `forge_dispatch` tool SHALL NOT be registered.

#### Scenario: A forge dispatch renders in the native task panel

- **WHEN** the forge primary dispatches `task {subagent_type: "forge-plugindev-coder", description: "...", prompt: ...}` and the user opens the transcript in the TUI
- **THEN** the call is rendered by the native task panel (live block keyed on the `task` tool name with the child session linked via metadata), indistinguishable in shape from a native dispatch

#### Scenario: Non-forge targets keep native dispatch parity

- **WHEN** a non-forge agent dispatches `task` to a host agent target (not a forge-* agent)
- **THEN** the same SDK child-session engine serves the call without the forge pool gate — the child runs the target agent and the result returns to the dispatcher as the native task tool would

#### Scenario: Question policy is mode-keyed

- **WHEN** a sync dispatch runs, its child may ask the user questions (native parity); WHEN an async dispatch runs, its child session is created with the question tool denied session-wide and proceeds without blocking on human input

#### Scenario: Sync abort parity

- **WHEN** the dispatching turn is aborted while a sync dispatch is in flight
- **THEN** the child session is aborted via the SDK, and the tool call resolves with the abort disclosed

#### Scenario: forge_dispatch is retired

- **WHEN** the plugin's tool registrations are enumerated
- **THEN** no `forge_dispatch` tool exists; `task` is the single dispatch surface

#### Scenario: A moved child-creation seam adapts by probing

- **WHEN** the host's client exposes child-session creation under a different receiver or method name than the pre-2.3.2 shape
- **THEN** the guarded probe finds the exposed create surface and dispatch proceeds through it, with the parent's directory resolved from the authoritative session anchor

#### Scenario: An absent create seam degrades honestly

- **WHEN** the host's client surface exposes no resolvable child-session creation seam
- **THEN** the task tool returns the contract degradation error naming the native task tool as the dispatch surface (exact string, no raw TypeError), and the native task tool remains fully functional for the same dispatch

### Requirement: Dispatch lifecycle (wake, cap, harvest)

The async dispatch lifecycle carries over from async-dispatch unchanged
and now attaches to the `task` surface: `run_in_background: true` SHALL
return a task handle immediately (task id, agent identity, child session
id) and deliver at most ONE completion wake carrying the child's final
assistant message (bounded 2500-character tail) following the
job-supervisor completion-wake discipline (idle-only injection,
at-most-once, delivery window with ledger overflow). Interim
`[forge:dispatch-progress]` notices are informational, delivered
idle-only, and never consume that budget. The plugin SHALL
cap concurrent running async dispatches per session (default 3); beyond
the cap, an async dispatch SHALL enter a per-session FIFO queue (bounded,
default 10) instead of failing — the call SHALL return a queued handle
immediately (metadata marking it queued until it spawns) and the child
SHALL be spawned when a slot frees — any terminal transition of that
session's dispatches frees a slot, a kill settle included, so a cancelled
dispatch releases its slot to the queued head — with a
`[forge:dispatch-progress]` notice announcing the queued wish's start; the
checks re-evaluated at spawn time
are the target roster, the draft gate, and the crew belt (a tightening
between call and spawn fails the wish as an honest error wake, never
silently); beyond the queue bound the call SHALL be refused with the
in-flight and queued task ids and guidance. When a
dispatching session ends, its live async dispatches SHALL be aborted and
recorded in the diagnostics ledger, and its queued wishes SHALL be
flushed without spawning — the flush SHALL terminalize the journal
records of those queued wishes. A sync dispatch whose child never
reaches a terminal state within the poll timeout SHALL return an honest
timeout finding naming the child session id (natively inspectable and
abortable) — and SHALL arm the standard completion tracking (dispatch
registry entry + completion poller) for the already-running child before
returning, so exactly one `[forge:dispatch-complete]` wake carries the
child's final report when it eventually completes; the arming bypasses
the async concurrency cap (the cap governs new async dispatch decisions,
not an already-running child), and the timeout finding SHALL disclose
the armed wake. The poll timeout SHALL default to 600000 ms and SHALL
be tunable via the `FORGE_DISPATCH_POLL_TIMEOUT_MS` environment
variable; it scopes the SYNC WAIT only. The completion tracker SHALL
NOT terminate on any wall-clock deadline measured from dispatch:
while the child is running (active in the status map) the poller SHALL
keep polling indefinitely — the sole clock-based termination of a running
child is the activity-stale reap specified under "Dispatch resilience" — and past
the notification interval (default
600000 ms, tunable via `FORGE_DISPATCH_NOTIFY_INTERVAL_MS`) it SHALL
emit non-terminal `[forge:dispatch-progress]` notices — informational
only, delivered idle-only, never consuming the completion wake budget;
the single `[forge:dispatch-complete]` wake carrying the final report
SHALL arrive at true terminal regardless of duration or how close
completion falls to an interval boundary. A child that stays
continuously not-active (missing from the map) across a full
notification interval while its latest finished assistant message
lacks a truthy `finish` or non-empty text SHALL terminate honestly as
a no-reportable-final-message finding naming the child session id; any
busy reading resets that streak, so a running child is never
terminated by it; a registry kill (an owner-session end, the user cancel
lever, or the explicit kill of a dispatch row through the job lever)
stops the watch at its next kill check — at a slice top, before a
consumed signal, after every poll, and once more before the exit settle
— and the kill verdict outranks any verdict the watch observed: the
dispatch is journaled and surfaced as aborted, never as `error` or
`completed`, and never feeds the provider breaker as a failure. A
plugin-instance dispose is not a registry-kill trigger (specified under
"Dispatch rows survive plugin-instance disposal"). The sync-armed poller
shares the tracker and inherits never-die tracking. Terminal
inference SHALL be sound against unreadable readings: a status
fetch failure SHALL be treated as active (keep polling — never a
terminal verdict on a signal that could not be read); a session MISSING
from a successfully fetched status map is the host's idle signal (the
map lists only currently-active sessions — a completed session is
removed) and counts as not-active; a completed
verdict SHALL require the not-active + finished-latest-assistant
condition to hold stable across consecutive poll ticks (resetting when
the session turns busy again — which also self-heals transient flakes
where a running child blinks out of the map for a tick or two), and the
finished message SHALL carry a
truthy `finish` and non-empty text parts, otherwise the poller SHALL
keep polling; the async wake path shares the poller and inherits the same
soundness.
The plan-draft interop is unchanged: during an active draft, a dispatch
to an effective-readonly forge target passes as a reconnaissance
dispatch in either mode, and write targets are refused by the same
write-class deny as before, in either mode. Activity-stale reaping,
error-classified retry, and restart recovery are specified under
"Dispatch resilience".

#### Scenario: Async handle and single completion wake

- **WHEN** the model dispatches `task` with `run_in_background: true` and the owning session later idles
- **THEN** the call returns a handle immediately and exactly one wake message with the child's final message is injected into the session (interim `[forge:dispatch-progress]` notices may precede it; they are informational and never replace it)

#### Scenario: Long child keeps tracking past the notification interval

- **WHEN** an async child runs past the notification interval and reaches a textful terminal state later
- **THEN** non-terminal `[forge:dispatch-progress]` notices arrive while it runs, and the single `[forge:dispatch-complete]` wake carrying the final report still arrives when it completes — however long it runs or how close completion falls to an interval boundary

#### Scenario: Textless idle child terminates honestly

- **WHEN** a child stays continuously not-active (missing from the status map) across a full notification interval while its latest finished assistant message lacks a truthy `finish` or non-empty text
- **THEN** the tracker terminates with an honest no-reportable-final-message finding naming the child session id, and a busy reading within the window resets the streak so a running child is never terminated

#### Scenario: Concurrency cap

- **WHEN** a session already has the cap of async dispatches running and dispatches async again within the queue bound
- **THEN** the call returns a queued handle immediately, the wish spawns automatically when a slot frees with a progress notice announcing its start (roster, draft gate, and crew belt re-checked at spawn), and only a wish beyond the queue bound is refused with the in-flight and queued task ids and guidance

#### Scenario: Owner death harvests children

- **WHEN** a session with live async dispatches is deleted
- **THEN** each running child session is aborted via the SDK, the orphans are recorded in the diagnostics ledger, the session's queued wishes are flushed without spawning, and the queued wishes' journal records are terminalized

#### Scenario: Sync timeout is honest

- **WHEN** a sync dispatch's child does not reach a terminal state within the poll timeout
- **THEN** the tool returns a timeout finding naming the child session id rather than hanging, the finding discloses the armed wake, the child is registered for completion tracking bypassing the async cap, and exactly one `[forge:dispatch-complete]` wake carrying the child's final report arrives when the child later completes

#### Scenario: Status fetch failure never terminates

- **WHEN** a status fetch fails (unreadable) while the child has a finished assistant message
- **THEN** the poller treats the reading as active, keeps polling, and does not declare completion or error on that observation

#### Scenario: Missing-from-map is the idle signal, flakes self-heal

- **WHEN** a session is missing from a successfully fetched status map (the host lists only currently-active sessions, so missing = not-active) — either because it completed or because a running child transiently blinked out during a server flake
- **THEN** the reading counts toward the stability run; if the child re-appears busy within the window the run resets (a flake can never reach depth on a stale receipt), and a genuinely completed child reaches the depth stably and completes

#### Scenario: Receipt-only messages are not final reports

- **WHEN** the child's latest assistant message is a finished acknowledgement but the session turns busy again (still working) within the stability window
- **THEN** the stability requirement resets and the poller keeps polling; a completed verdict requires the condition to hold stable across consecutive ticks with a truthy finish and non-empty text parts on the latest assistant message

#### Scenario: Draft interop unchanged

- **WHEN** the dispatching session has an active draft plan
- **THEN** an effective-readonly forge target passes in either mode and write targets are refused in either mode — identical outcomes to the pre-shadow gates

#### Scenario: A kill outranks the verdict the watch observed

- **WHEN** a dispatch row is killed (owner-session end, the cancel lever, or an explicit kill) and the abort makes the child surface afterwards as a host `session.execution.failed` verdict or as a finished-looking transcript that the watch reads
- **THEN** the dispatch is journaled and surfaced as aborted with the killer's reason — never as an error that feeds the dispatch breaker, never as a completion — and the slot it held is pumped to the session's queued head like any other terminal transition

### Requirement: Dispatch resilience (stale reap, retry, restart recovery)

A running dispatch child that produces no activity for
`FORGE_DISPATCH_STALE_MS` (default 2700000 ms = 45 min) past a 60-second
minimum-runtime floor SHALL be reaped. The activity anchor is the child's
`session.get` `time.updated` timestamp (part-level updates — a child
streaming one long generation still refreshes it); when no message has
ever arrived, the anchor is the dispatch start time. Before acting, the
reaper SHALL re-read `session.get`: a refreshed timestamp resets the
timer (a child that is actually producing can never be reaped), and the
same call doubles as the existence probe (status unresolved → skip this
sweep, session missing → finalize). The reap SHALL abort the child via
the SDK and deliver exactly one honest terminal wake (`stale: aborted
after N min without activity`); if the abort call fails and the session
still exists, the reaper SHALL skip this sweep and re-arm — finalization
happens only when existence proves the session gone.
`FORGE_DISPATCH_STALE_MODE` SHALL support `kill` (default) and `observe`
(one progress notice per threshold crossing, no kill). A child that
terminates in a RETRYABLE error — the transient transport/5xx/overload/
rate-limit error patterns — SHALL be respawned automatically: same agent,
original prompt plus a resume preamble instructing the new child to
inspect the current workspace state before acting and continue the work
rather than redo it; `FORGE_DISPATCH_MAX_ATTEMPTS` SHALL bound total
attempts (default 2), with a fixed 10 s backoff between attempts; the
retry inherits the dying child's registry slot (no queue re-entry) and
re-applies the dispatch-time policies (draft/crew mode-keyed denies);
each attempt is surfaced as a `[forge:dispatch-progress]` notice and the
final wake SHALL disclose the number of attempts; exactly one terminal
wake still. Deterministic terminal error classes — the provider-
configuration, auth, model-not-supported, and contract error patterns —
SHALL never be retried; unknown error classes SHALL never be retried;
stale kills, user aborts, and textless-idle floor findings SHALL never
be retried. Every dispatch record SHALL be appended to a bounded
workspace journal (`.opencode/forge/dispatch-log.jsonl`, bounded at
`FORGE_DISPATCH_JOURNAL_MAX` records, default 200) on every state
transition (dispatched, queued, started, retry-pending, terminal); a
corrupt journal line SHALL be tolerated (skipped) without aborting
recovery; rotation SHALL compact terminal records only and SHALL never
remove a non-terminal record; the original prompt SHALL be retained
while a record is non-terminal (the journal is the only prompt source
after a restart) and SHALL be redacted when the record terminates. On plugin
init, non-terminal records SHALL be recovered per state, scoped to the
launch-anchor workspace at init and lazily per workspace on its first
session: a `running` record's child still alive → registry row and
poller re-armed; finished while the host was down → final message
fetched and the completion wake delivered; child gone → honest terminal.
A `queued` record → re-entered into the queue when the owner session
still resolves, otherwise terminated honestly and ledgered. A
`retry-pending` record → the retry decision resumed (respawn when
attempts remain, otherwise honest terminal). A host restart SHALL NOT
orphan a running child, silently discard a queued wish, or lose a
finished child's report. This journal is the dispatch-session analogue
of job-supervisor's persisted survival registry (which recovers
surviving job processes); they are separate ledgers and are not
cross-read.

#### Scenario: Stale reap after prolonged inactivity

- **WHEN** a running child's `session.get` `time.updated` has not advanced for the stale threshold past the runtime floor, the pre-kill re-read confirms no refresh, and stale mode is `kill`
- **THEN** the child is aborted via the SDK and exactly one terminal wake delivers the honest stale finding naming the child session id

#### Scenario: Stale observe mode only notifies

- **WHEN** stale mode is `observe` and the stale threshold is crossed
- **THEN** one progress notice reports the inactivity (one per crossing, not per tick) and the child is NOT aborted

#### Scenario: Active children are never reaped

- **WHEN** the stale threshold is crossed but the pre-kill re-read finds a refreshed `time.updated`
- **THEN** the timer resets and the child keeps running

#### Scenario: Runtime floor blocks early reap

- **WHEN** a child is younger than the 60-second minimum runtime, however silent
- **THEN** no reap is considered for it

#### Scenario: Existence probe decides the ambiguous reading

- **WHEN** the status map is unhelpful at reap consideration
- **THEN** the `session.get` probe decides: unresolved status skips the sweep, a missing session finalizes the record

#### Scenario: Failed abort skips the sweep

- **WHEN** the reaper's abort call fails and the session still exists
- **THEN** the sweep is skipped and re-armed — the record is only finalized when existence proves the session gone

#### Scenario: No-message children anchor at start

- **WHEN** a child has produced no message at all and stays silent past the stale threshold measured from dispatch start
- **THEN** the reap machinery applies identically (floor, re-read, abort, honest wake)

#### Scenario: Retryable error respawns with a resume preamble

- **WHEN** a child terminates in a transient transport/5xx/overload/rate-limit-class error and attempts remain
- **THEN** a fresh child of the same agent spawns after the 10 s backoff with the original prompt plus the inspect-then-continue preamble, a progress notice discloses the retry, the retry keeps the dying child's registry slot, and the final wake arrives once, when the last attempt settles, disclosing the attempt count

#### Scenario: Deterministic terminal classes are never retried

- **WHEN** a child terminates in a provider-configuration, auth, model-not-supported, or contract error pattern
- **THEN** no respawn happens and the honest terminal wake is delivered as-is

#### Scenario: Stale kills, aborts, and floor findings are never retried

- **WHEN** a child terminates via a stale reap, a user abort, or a textless-idle floor finding
- **THEN** no respawn happens and the honest terminal wake is delivered as-is

#### Scenario: Rotation never loses a non-terminal record

- **WHEN** the journal reaches its rotation bound while a dispatch is still running
- **THEN** only terminal records are compacted and the running dispatch's record survives

#### Scenario: Every state transition is journaled

- **WHEN** a dispatch moves between dispatched / queued / started / retry-pending / terminal states
- **THEN** a journal record is appended for the transition

#### Scenario: Restart re-arms a live child

- **WHEN** the plugin initializes and the journal holds a running dispatch whose child session is still alive
- **THEN** the registry row and poller are re-armed and the completion wake still arrives when the child finishes

#### Scenario: Restart delivers a missed report

- **WHEN** the plugin initializes and the journal holds a running dispatch whose child finished while the host was down
- **THEN** the final message is fetched and the completion wake is delivered to the owner session

#### Scenario: Restart terminalizes a gone child

- **WHEN** the plugin initializes and the journal holds a running dispatch whose child session no longer exists
- **THEN** the record terminates with an honest finding instead of resurrecting a phantom

#### Scenario: Restart re-queues a queued wish

- **WHEN** the plugin initializes and the journal holds a queued record whose owner session still resolves
- **THEN** the wish re-enters the queue and spawns when a slot frees; when the owner no longer resolves, the record terminates honestly and is ledgered

#### Scenario: Restart resumes a retry-pending attempt

- **WHEN** the plugin initializes and the journal holds a retry-pending record
- **THEN** the retry decision resumes — the child respawns when attempts remain, otherwise the record terminates honestly

### Requirement: Runtime model pin on v2 hosts

On a v2 host, a forge-family agent whose pool def pins `model`
(`"provider/model"`) `SHALL` serve every request on the pinned model:
the context-injection path `SHALL` rewrite the payload's `model`
(providerID + id/modelID spellings) to the pinned identity, resolved fresh
per request (hot-apply contract). The variant field `SHALL` survive the
rewrite honestly: when the pinned identity equals the resolved model the
existing `variant` `SHALL` be preserved (the compiled roster's variant
channel — e.g. `#low` — reaches the host UI intact); when the pin switches
to a different model, the variant `SHALL` be derived from the recipe's
pinned depth when that depth is a variant word (`low`/`medium`/`high`),
and only otherwise `SHALL` be dropped (a stale variant of a different model
is meaningless). The agent draft `SHALL` still omit `model` (the host
encoder rejects it).

#### Scenario: Pinned pool agent serves on the pinned model

- GIVEN a pool def pinning `model: "glm-coding-worker/glm-5.3"` on a v2
  host whose default model differs
- WHEN the pinned agent's session builds a request
- THEN the served request uses the pinned model
- AND the assistant message record names the pinned model

#### Scenario: Unpinned agents keep the resolved model

- WHEN a forge-family agent's def has no `model` pin
- THEN the context path leaves the payload model untouched

#### Scenario: Malformed pin skips silently

- WHEN a def's `model` does not parse as `"provider/model"`
- THEN no rewrite happens and no error surfaces

#### Scenario: Same-identity pin preserves the variant channel

- GIVEN a compiled worker whose `.md` model string carries a variant
  (e.g. `glm-coding-worker/glm-5.3-flash#low`) and whose recipe pins the
  same model
- WHEN the pinned agent's session builds a request
- THEN the payload model keeps `variant: "low"` — the host UI shows the
  real depth instead of default

#### Scenario: Model switch derives the variant from the pinned depth

- GIVEN a recipe pinning a different model with
  `thoughtLevel: "high"`
- WHEN the context path rewrites the payload model to the pinned identity
- THEN the variant is set to `"high"`; with no depth word pinned, the
  stale variant is dropped instead

### Requirement: Sandbox full-chain proof

The change `SHALL` be verified on the live 2.3.2 sandbox: a pool agent
with a model pin, dispatched as a subagent, completes a turn served by
the pinned model (asserted on the served message record).

#### Scenario: Dispatched pinned subagent serves on the pin

- WHEN a primary dispatches a task to a pinned pool agent on the sandbox
- THEN the subagent's assistant record names the pinned model

### Requirement: Dispatch outcome honesty on result-stream loss

The dispatch layer `SHALL` classify every dispatch outcome as exactly one of
`completed`, `failed`, or `stream-lost/unknown`. A result stream that breaks
before a final report arrives `SHALL` classify as `stream-lost/unknown` and
`SHALL NOT` produce a terminal verdict: no exit-1 death certificate, no "no
reportable final message" obituary. The surfaced message `SHALL` state that
the result stream was lost and that the child state is unknown (possibly
still running). On hosts where host-signal completion detection is active,
the `stream-lost/unknown` verdict `SHALL` be declared only after the
reconcile pass also fails to observe the child: execution events that keep
flowing for an in-flight child `SHALL NOT` be overruled by an unread
synchronous view, and a child that host signals show to be alive `SHALL NOT`
be declared lost.

#### Scenario: Result stream breaks mid-dispatch

- WHEN the child session's result stream breaks (e.g. network
  `Connection reset`) before a final report arrives
- THEN the dispatch outcome is `stream-lost/unknown`
- AND the surfaced message states "result stream lost" and that the
  child state is UNKNOWN (possibly still running)
- AND no exit-1 / death / terminal obituary wording is produced

#### Scenario: healthy child is never declared lost

- WHEN the synchronous status/messages view is unreadable while the child's
  execution events continue to arrive
- THEN the dispatch stays in flight (no verdict is declared)
- AND the outcome settles from the host signals or the reconcile pass as
  usual

#### Scenario: verdict only after signals and reconcile both fail

- WHEN neither the host signals nor the reconcile pass can observe an
  in-flight child for the sustained streak
- THEN the outcome is `stream-lost/unknown` with the last-observed activity
  timestamp
- AND the report-file delivery contract remains the ground-truth recovery
  channel

### Requirement: Ledger completeness across outcome classes

The dispatch layer `SHALL` write a ledger entry for every dispatch
outcome class, including `stream-lost/unknown`, carrying the
last-observed activity timestamp.

#### Scenario: Ledger entry on stream loss

- WHEN a dispatch's result stream breaks before a final report
- THEN the job ledger records a `stream-lost/unknown` entry carrying
  the last-observed activity timestamp
- AND `forge_jobs list` surfaces the dispatch as
  `stream-lost/unknown`

### Requirement: Report-file delivery contract

The dispatch prompt template `SHALL` include a standing report-file
delivery instruction naming the caller-provided report path
(`reports/<task>-report.md` convention), so a worker's final report
survives the primary's view loss.

#### Scenario: Worker report survives view loss

- WHEN a dispatched worker completes its work after the primary's
  result stream was lost
- THEN the worker's final report is available at the agreed report
  path in the workspace
- AND the primary can resolve the dispatch outcome by reading that
  file without re-dispatching

### Requirement: Sync wait-budget expiry presented as a notice

The sync dispatch layer `SHALL` present a wait-budget expiry handoff as
a normal notification — informational styling with wording naming the
outcome ("sync wait budget ended — the dispatch continues in the
background; collect with `forge_jobs`") — and `SHALL NOT` render it
through the error channel.

#### Scenario: Wait budget expires while child is healthy

- WHEN a synchronous dispatch's wait budget expires while the child
  session is still running
- THEN the handoff surfaces as an informational notice naming the
  outcome and the collection path (`forge_jobs`)
- AND no error-channel rendering / alarm styling is used

### Requirement: Genuine dispatch failures keep error presentation

Genuine sync dispatch failures `SHALL` keep error-class presentation:
dispatch refusal (gates, pool caps) and evidence-backed worker errors
render through the error channel as before.

#### Scenario: Refusal and evidence-backed failure stay errors

- WHEN a dispatch is refused by a gate/pool cap, or the worker fails
  with recorded evidence
- THEN the message renders through the error channel unchanged

### Requirement: Budget-expiry notice carries retrieval pointers

The budget-expiry notice `SHALL` carry the retrieval pointers previously
carried by the error message — job id, task handle, and report path
when present — so the caller can collect the result without
re-dispatching.

#### Scenario: Notice is actionable

- WHEN the budget-expiry notice surfaces
- THEN it includes the job id (and task handle / report path when
  present)

### Requirement: Active-textful completion override

When a dispatch child's status view keeps reporting the session active but
the child's final assistant text has already arrived and remained stable,
the poller `SHALL` verdict the dispatch COMPLETE from the message-stream
evidence alone — it `SHALL NOT` wait for the status view to flip, `SHALL
NOT` run the dispatch to a timeout, and the terminal wake `SHALL` disclose
that completion was established from the message stream while the status
view lagged. The override `SHALL` use the same stability window (three
consecutive poll ticks with finish conditions holding and non-empty final
text) as the ordinary not-active completion path, `SHALL` cover sync and
async dispatches alike, and `SHALL NOT` fire when the final text has not
arrived (a stuck-active child with no text keeps its existing honest
uncertainty handling — the override never invents completion).

#### Scenario: Stuck-active status with the final report already out

- **WHEN** a child's status map reports active on every poll tick while
  the child's final assistant text is readable and has held the finish
  conditions for the stability window
- **THEN** the poller verdicts COMPLETE, the terminal wake names the
  message-stream override as the establishment path, and no timeout path
  runs

#### Scenario: Stuck-active with no text stays honest

- **WHEN** a child's status map reports active and no final assistant text
  has arrived
- **THEN** the override does not fire and the existing textless-idle and
  stale handling governs — no completion is invented

### Requirement: Nested-dispatch tool guard on non-forge child sessions

Child-session creation `SHALL` accept a task-deny option that carries the
task-tool deny permission in the create body (the channel QUESTION_DENY
already uses, proven effective by a sandbox probe before the guard ships).
The dispatch path `SHALL` set this option when — and only when — the
target is a non-forge host agent whose resolved provider family is
anthropic: such children `SHALL NOT` receive a dispatchable task tool,
preventing the nested-delegation 400 that family returns. Forge-*
targets `SHALL` remain governed solely by their structural `task: deny`
(this guard adds nothing to them), and non-forge targets on other
provider families `SHALL` be untouched by this guard. The guard lives at
the single child-creation funnel so every spawn site inherits it.

#### Scenario: Non-forge anthropic target denies the task tool in the child

- **WHEN** a dispatch targets a non-forge host agent whose provider family
  resolves to anthropic
- **THEN** the child session is created with the task-tool deny riding the
  create body, and the child cannot dispatch further subagents

#### Scenario: Forge family and other families are untouched

- **WHEN** a dispatch targets a forge-* agent, or a non-forge agent on a
  non-anthropic family
- **THEN** the create body carries no task deny from this guard (forge's
  structural deny still applies to forge-* targets through the materialized
  permissions)

### Requirement: Provider-dimension dispatch gate and circuit breaker

The dispatch path `SHALL` maintain in-process counters of live children
keyed by provider and by provider/model, fed at the terminal-recording
seam, and `SHALL` enforce optional per-provider and per-model concurrency
limits. A circuit breaker `SHALL` track consecutive failed terminals per
provider: at the configured threshold the breaker opens and refuses NEW
dispatches on that provider; after the configured cooldown it half-opens
(one dispatch allowed; success closes, failure re-opens). Both mechanisms
`SHALL` be configured through an optional `dispatch` node in forge.json
(`providerConcurrency` map, `modelConcurrency` map, `circuitBreaker`
`{consecutiveFailures, cooldownMs}`), cascade-merged across config layers
with field-level fail-soft (a bad value drops with a warn finding and
never throws); an absent node `SHALL` mean no limits (today's behavior).
Queued dispatches `SHALL` re-check the gate at dequeue time. Every
refusal `SHALL` be an honest message naming the mechanism, the counted
dimension and its current value, and the recovery condition (a live child
  finishing for the concurrency gate; the cooldown elapsing for the
breaker); breaker refusals `SHALL` be classified as the plugin's own
throttle, not as provider errors, and `SHALL NOT` trigger the provider
  retry path.

#### Scenario: Provider concurrency gate refuses and admits

- **WHEN** the live count for a provider is at its configured limit and a
  new dispatch on that provider arrives
- **THEN** the dispatch is refused with the gate named, the counted
  dimension shown, and the recovery condition stated; when a live child on
  that provider terminates, the next dispatch is admitted

#### Scenario: Breaker opens, half-opens, and closes

- **WHEN** a provider accumulates the configured number of consecutive
  failed terminals
- **THEN** new dispatches on that provider are refused naming the breaker
  and cooldown; after the cooldown the next dispatch is admitted
  (half-open) and on its success the breaker closes (a failure re-opens it
  with the cooldown re-armed)

#### Scenario: Absent or malformed dispatch node is fail-soft

- **WHEN** forge.json carries no `dispatch` node, or one with malformed
  values
- **THEN** dispatches are unlimited (or the malformed fields are ignored
  with a warn finding) and no dispatch is ever refused due to a parse
  failure

### Requirement: JSON Schema publication for forge.json

The plugin `SHALL` publish a hand-written JSON Schema
(`schema/forge.schema.json`, mirrored into `dist/forge.schema.json` by
the bundle step and exposed via the package `exports` map under
`./schema.json`) describing the forge.json surface: the consumed
top-level keys (`agents`, `pool`, `shared`), the per-agent entry fields
(`prompt`, the atomic `model`+`thoughtLevel` pair expressed so that
half-pairs fail validation, `shape` with exactly the values `readonly`
and `write`, `permission` overrides), the id and pool naming rules the
validator enforces, and the deprecated `depths` key. The schema `SHALL`
be mirror-locked to the code: a test `SHALL` assert the schema's enums
and patterns against the code constants they mirror (the shape union,
the id/pool regexes, the atomic-pair rule), failing when either side
drifts. The parser's existing unknown-key tolerance `SHALL` keep
accepting a user-pasted `$schema` key verbatim (documented in README
with the node_modules reference form and the `.json`-extension comment
caveat), and the `shape-invalid` finding `SHALL` state the true default
(`write`), matching the shape-default-open semantics.

#### Scenario: Editor completion and typo defense

- **WHEN** a user references the published schema from their forge.json
  (`$schema` pointing at the package's `./schema.json` export)
- **THEN** their editor offers completion over the documented surface and
  flags invalid entries — a `model` without `thoughtLevel`, or a
  misspelled `shape` — before the file ever reaches the plugin

#### Scenario: Schema and validator cannot drift silently

- **WHEN** the validator's shape union, id/pool patterns, or atomic-pair
  rule changes without the schema changing in step (or vice versa)
- **THEN** the drift-mirror test fails, naming the drifted pair

#### Scenario: $schema stays tolerated and the finding tells the truth

- **WHEN** a forge.json carries a `$schema` key, or an entry carries an
  invalid `shape` value
- **THEN** the `$schema` key parses clean (unknown-key tolerance), and
  the `shape-invalid` finding states that the entry defaults to WRITE
  (not readonly) while naming the accepted values

### Requirement: Native roster compilation and sync

The plugin `SHALL` compile the forge.json recipe into namespaced native
agent files through an explicit sync operation — workspace pools into
the workspace's `.opencode/agent/forge-<ns>-<id>.md` and the global
fallback family into the host's global agent directory
(`<home>/.config/opencode/agent/`, a write that never occurs on
machines without a global recipe) — and `SHALL` keep the recipe as the
sole semantic
authority: pools, session-domain dispatch gating, crew roster
disclosure, and compliance checks `SHALL` continue reading the recipe
through the existing pool resolver, with native files serving only as
the materialized projection. Each compiled file `SHALL` carry the
provenance-bearing description, an always-stamped `mode: subagent`
(without which the host silently falls back to a general dispatch), the
pinned model identity including its variant channel where the recipe's
depth word maps to one, the tools face in the host's current tool
vocabulary per the entry's shape, and the dispatch mandates baked into
the prompt body — all emitted under a GENERATED header that directs
edits to the recipe. The sync `SHALL` write atomically and `SHALL`
garbage-collect namespaced files whose entries left the recipe.
Compilation `SHALL` emit only probe-proven frontmatter keys (unknown
keys are dropped by the host once `permissions` is present). Before
crew registration on a native-mode host the plugin `SHALL` check
recipe-versus-artifact staleness — mtime-triggered with content
adjudication (a byte-identical touch is not staleness) — and refuse
with a one-step recovery instruction when stale; the sync
operation `SHALL` be agent-invocable so recovery happens in-band and
transcript-visible, and the host's hot-apply `SHALL` be relied on (no
restart demanded). A `sync: "auto"` opt-in `SHALL` regenerate on
detection with a disclosed finding; absent the opt-in the plugin
`SHALL NOT` write files uninvited. Depth words that map to variant
values `SHALL` compile into the model string; all other words `SHALL`
keep riding the per-spawn chat.params injection with its existing
disclosure. Generated artifacts `SHALL` be designed to travel with the
workspace (committed like a lockfile: a fresh machine pulling the
workspace needs no initialization), and the README handbook `SHALL`
document the recipe fields, starter recipes, the `mode: subagent`
trap, the current host tool vocabulary with its drift caveat, and the
cross-machine story.

#### Scenario: Recipe compiles to namespaced native agents

- **WHEN** a recipe with a pool and mixed-shape entries is synced
- **THEN** each entry exists as `.opencode/agent/forge-<ns>-<id>.md`
  with `mode: subagent` stamped, the pinned model (variant included
  where mapped), the shape's tools face in the current host vocabulary,
  mandates baked into the prompt body, and a GENERATED header — and
  removing the entry from the recipe garbage-collects its file on the
  next sync

#### Scenario: Stale artifacts refuse and recover in-band

- **WHEN** the recipe is newer than its compiled artifacts and a crew
  registration (or materialization precheck) runs
- **THEN** the operation is refused with a one-step recovery
  instruction; invoking the sync tool regenerates atomically, the host
  hot-applies the files, and the retry passes — all visible in the
  session transcript

#### Scenario: Depth rides variant where expressible, params elsewhere

- **WHEN** an entry's depth word maps to a variant value versus a word
  outside the variant set
- **THEN** the variant word compiles into the model string while the
  other keeps the per-spawn chat.params injection with its existing
  disclosure — the 7-word dictionary and translation matrix unchanged

#### Scenario: Recipe stays the authority; visibility follows the host

- **WHEN** dispatch gating, crew roster disclosure, or compliance
  checks run against a workspace whose agents are native-compiled
- **THEN** verdicts derive from the recipe exactly as today, while
  agent visibility follows the host's up-tree-merge scoping (nested
  directories see parent agents — a disclosed difference from
  nearest-exclusive pool scoping)

#### Scenario: Cross-machine is zero-initialization

- **WHEN** a workspace with committed recipe and committed generated
  artifacts is pulled onto a fresh machine
- **THEN** no initialization or migration step is required — the
  artifacts arrive with the recipe via the same pull, and staleness
  checks pass because both files travelled together

#### Scenario: Runtime materialization remains available as an escape hatch

- **WHEN** the materialize knob selects the runtime path (v1 hosts are
  pinned to it by generation; v2 hosts may opt in as the escape hatch)
- **THEN** behavior is byte-equal to today's draft-based
  materialization (the staleness gate is a native-mode facility)

### Requirement: Agent-bound child creation with pre-spawn validation

On v2 hosts the dispatch layer `SHALL` pass the target agent id (and the
pinned model when the roster defines one) in the child session-create call,
mirroring the host's own subagent creation contract. The create-time model
record `SHALL` carry the bare model id in its `id` field (`{providerID,
modelID, id: <modelID>}`): the host stores `id` verbatim in the session
model record and composes the runner select key as `providerID + "/" + id`,
so a provider-qualified `id` produces a tripled key and fails the child at
drain with `ModelUnavailableError`. Before spawning, the layer `SHALL`
validate that the target agent resolves in the live roster (pool resolution
or materialized native roster); a non-resolving agent `SHALL` be refused
with a disclosure naming the agent and the roster source, and `SHALL NOT`
degrade to a default-agent child. After creation, the layer `SHALL` read
back the created session and assert the bound agent matches the request; a
mismatch or unknown-agent result `SHALL` fail the dispatch loud (error
class + journal entry) rather than leave a silently-unbound child running.

#### Scenario: agent binding honored at create

- **WHEN** a dispatch targets a roster agent that resolves in the live
  roster on a v2 host
- **THEN** the child session is created with that agent bound (and the
  pinned model when defined), and the read-back assertion passes

#### Scenario: non-resolving agent is refused, not degraded

- **WHEN** a dispatch targets an agent that does not resolve in the live
  roster
- **THEN** the dispatch is refused with a disclosure naming the agent and
  the roster source
- **AND** no child session is created as a default agent

#### Scenario: read-back mismatch fails loud

- **WHEN** the created child's bound agent does not match the requested
  agent
- **THEN** the dispatch fails with a loud binding-lost error and a journal
  entry, and no prompt is sent to the mismatched child

#### Scenario: pinned model record carries the bare model id

- **WHEN** a dispatch resolves a roster pin to a model identity
  (providerID, modelID) and builds the child session-create body
- **THEN** the body's model record is `{providerID, modelID, id: <modelID>}`
  with `id` equal to the bare model id, never the provider-qualified key

#### Scenario: runner composes a clean key from the stored record

- **WHEN** a child session is created from the pinned model record and the
  host runner resolves its select key
- **THEN** the composed key is `providerID + "/" + modelID` (two segments),
  not a tripled key, regardless of the provider being known to the host
  catalog

### Requirement: Host-signal completion detection

On v2 hosts the dispatch layer `SHALL` detect child completion primarily via
host-owned signals: durable `session.execution.{succeeded, failed,
interrupted}` events matched on the child session id, and/or a one-shot wait
on the child session. The layer `SHALL` run a reconcile pass over in-flight
children at a cadence of at least 10 seconds that reads each child's actual
state as the backstop for missed or lost events, and `SHALL` re-subscribe
when its event stream is lost. The synchronous status/messages REST view
`SHALL NOT` be the sole terminal signal for a dispatch.

#### Scenario: durable event settles a dispatch

- **WHEN** a child session's execution emits a terminal durable event
- **THEN** the dispatch settles from that signal without any status polling

#### Scenario: reconcile pass catches a missed event

- **WHEN** a terminal event for an in-flight child is missed (e.g. the
  event stream dropped between publish and subscribe)
- **THEN** the reconcile pass observes the child's settled state and the
  dispatch settles from that observation

#### Scenario: event stream loss triggers re-subscription

- **WHEN** the plugin's event subscription is lost (e.g. plugin reload,
  connection drop)
- **THEN** the layer re-subscribes and the reconcile pass covers children
  whose terminal events fired during the gap

### Requirement: Persisted dispatch registry with post-reload adoption

The dispatch layer `SHALL` persist in-flight dispatch rows (task id, child
session id, target agent, prompt anchor, timestamps) outside plugin-instance
memory, and after a plugin reload or host restart `SHALL` adopt persisted
in-flight rows: re-arm completion watching for each child and resume the
normal outcome path. Restart recovery `SHALL` fall back to walking the
parent session relationship when a stored row is unreadable. An adopted
dispatch `SHALL NOT` be re-dispatched while its child is still observable.

#### Scenario: reload mid-dispatch adopts the child

- **WHEN** the plugin is hot-reloaded while a dispatch is in flight
- **THEN** the reloaded generation adopts the persisted row and continues
  watching the same child session
- **AND** the final outcome is delivered exactly once, without a second
  child being spawned for the same task

#### Scenario: restart recovery falls back to parent walk

- **WHEN** a persisted row is unreadable after a restart but the child
  session records the parent relationship
- **THEN** the layer recovers the dispatch from the parent walk instead of
  losing it

### Requirement: User-facing dispatch cancellation

The plugin `SHALL` expose a session-scoped stop lever for in-flight async dispatches: the stop route `SHALL` cancel every in-flight dispatch owned by the invoking session — and only those; dispatches owned by other sessions `SHALL` never be touched by another session's stop. Invoked for a listing, the lever `SHALL` list every in-flight dispatch on the host with its task id, target agent, child session id, owner session, and age (host-wide visibility, no session scoping on the listing). Invoked with an explicit task id, the lever `SHALL` cancel that dispatch — the explicit-id escape hatch, which MAY target another session's dispatch by explicit intent. No host-wide cancel verb `SHALL` exist: no single lever call cancels every dispatch on the host. Cancellation `SHALL` abort the child session through the existing abort engine, settle the registry row as `aborted`, record the cancellation in the ledger, and deliver a wake disclosing it. A cancelled dispatch `SHALL NOT` be retried by any resilience path. Each cancellation receipt (the per-id cancel, and every row of a stop) `SHALL` report the post-abort idle confirmation honestly as one of three outcomes: the child is confirmed idle through the host's active-session view; the child did not reach idle within the assertion window (it may have resisted); or the view could not be read, so idle is unconfirmed — a receipt `SHALL` never claim a confirmed idle without a readable view, and no view read `SHALL` hold a receipt past the assertion window. Queued wishes are not in flight, so a stop does not cancel them; its receipt `SHALL` name the queued wishes of the session it did not cancel (their spawning then follows the queue contract — a slot freed by a cancelled dispatch is pumped).

#### Scenario: list in-flight dispatches

- **WHEN** the cancel lever is invoked for a listing while dispatches are in flight
- **THEN** each in-flight dispatch is listed with task id, agent, child session id, owner session, and age
- **AND** no dispatch is cancelled by a bare listing

#### Scenario: cancel one dispatch

- **WHEN** the cancel lever is invoked with an in-flight task id
- **THEN** the child session is aborted and the receipt reports the idle-confirmation outcome (confirmed idle, resisted, or unreadable view)
- **AND** the registry row settles as `aborted` and the ledger records the cancellation
- **AND** the owner session receives a wake disclosing the cancellation

#### Scenario: cancelled dispatch never retries

- **WHEN** a dispatch is cancelled by the user lever
- **THEN** no resilience path (retry, stale reap, adoption) respawns or resumes it

#### Scenario: stop scopes to the invoking session

- **WHEN** session A owns two in-flight dispatches, session B owns one, and the stop lever fires in session A
- **THEN** both of A's dispatches are cancelled with honest aborted wakes and B's dispatch is untouched — it keeps running and delivers its completion wake at true terminal

#### Scenario: No host-wide cancel verb

- **WHEN** the lever is asked to cancel `all` dispatches in one call
- **THEN** the request is refused as an unknown route with guidance to the session-scoped stop and the per-id escape hatch

#### Scenario: An unreadable idle view is disclosed, never claimed

- **WHEN** the active-session view cannot be read (or a read hangs) while a cancellation's idle confirmation is running
- **THEN** the receipt returns within the assertion window, reports that idle could not be confirmed, and makes no confirmed-idle or resisted claim

#### Scenario: stop names the queued wishes it did not cancel

- **WHEN** a session has queued wishes beyond the concurrency cap and the stop lever fires in that session
- **THEN** the in-flight dispatches are cancelled, the receipt names the queued wishes as not cancelled, and a queued wish spawns into the slot a cancelled dispatch freed

### Requirement: Parent-interrupt disclosure

WHEN the parent session's turn is interrupted while async dispatches are in flight, the plugin `SHALL` surface the in-flight dispatch list with cancellation guidance in the interruption path — naming the session-scoped stop route and the per-id cancel escape hatch. The default posture is disclose-only: an interrupt `SHALL NOT` silently cancel running children.

#### Scenario: ESC with children in flight

- **WHEN** the user interrupts the parent session's turn while dispatches are in flight
- **THEN** the in-flight dispatch list with cancellation guidance is surfaced to the session
- **AND** the children remain running unless explicitly cancelled

### Requirement: Orphan-child disclosure

WHEN a child session produced by the dispatch layer is observed streaming
while its registry row is dead or missing (e.g. an adoption gap), the plugin
`SHALL` surface the orphan with adopt/cancel guidance instead of letting it
run invisibly.

#### Scenario: orphaned streaming child is surfaced

- **WHEN** a streaming child session has no live registry row
- **THEN** the orphan is disclosed with its task id and child session id
- **AND** the disclosure offers the adopt and cancel paths

### Requirement: Dispatch rows survive plugin-instance disposal

Plugin `dispose` SHALL NOT be a registry-kill trigger for dispatch rows. On any host — single- or multi-context — a plugin dispose that is not the host-process exit SHALL leave every in-flight dispatch row untouched: no kill, no child abort, no journal terminalization; the settle loop keeps watching and the completion wake arrives at true terminal. This supersedes any earlier implication that dispose is a dispatch registry-kill trigger; the remaining legitimate registry-kill triggers are owner-session end and the user cancel lever. A real host-process exit needs no dispatch kill either: dispatch children are server-side sessions unaffected by the plugin process, and their cross-restart continuity is the dispatch journal with restart recovery (probe → re-arm, completed-wake, or honest error per record state).

#### Scenario: Dispose in another context leaves the dispatch running

- **WHEN** a dispatch is in flight and a plugin context (not the whole host process) is disposed
- **THEN** the dispatch row remains running, its journal record stays non-terminal, and the final wake is delivered on completion

#### Scenario: Host-process exit relies on the journal, not on kills

- **WHEN** the host process exits while dispatches are in flight
- **THEN** no dispatch journal record is terminalized by the exit itself, and on next host boot restart recovery resolves each live child (re-arm the running, deliver the finished, honestly terminalize the gone)

### Requirement: Honest aborted outcome surfacing

When a dispatch row is legitimately killed (owner-session end or the user cancel lever), the surfaced wake and the journal terminal record SHALL name the outcome as aborted with its reason — never as a completed "finished" report. A killed dispatch's wake SHALL NOT present an empty tail as a final report (no "(no output)" fabrication); the wake SHALL state that the dispatch was aborted, carry the journal reason, and — when the child could not be confirmed idle after the abort attempt — disclose that the child session may still be running (the orphan-disclosure path). The reason SHALL be ONE sentence on both sides — the sentence the kill stamped on the row at kill time — and each lever SHALL have its own sentence: an owner-session end, the user cancel lever (the per-id cancel and the session-scoped stop), and the explicit kill of a dispatch row through the job lever; the owner-death sentence SHALL NOT name any other trigger (a plugin dispose is not one). A host execution error carried as a nested object SHALL be rendered readable (its message, name, error, reason, or data — else a clipped JSON rendering) wherever a journal reason or a wake cites it — never the string `[object Object]`; an error object that cannot be rendered (circular, BigInt-bearing, or throwing when read) SHALL yield to the caller's own honest fallback and SHALL NOT throw into the signal path. A kill that lands while a retry respawns the child SHALL be honored — the fresh child SHALL NOT be left running unwatched: when the kill landed during its creation it is never prompted (aborted as cleanup; the row keeps naming the attempt's real child), and when the kill landed during the prompt send the row is rebound to it and it is aborted. An abort that has not returned within a bounded moment counts as unconfirmed too — a hung host call is not a clean abort — and a wake rendered while the abort is still in flight SHALL wait for that same bounded moment, so the wake discloses exactly what the journal discloses whichever of the two is written first.

#### Scenario: Killed dispatch wakes as aborted, not finished

- **WHEN** an in-flight dispatch row is killed by owner-session end or the cancel lever
- **THEN** the wake names the dispatch as aborted with its reason, no final-report text is fabricated from the empty tail, and the journal terminal record carries the same reason

#### Scenario: Each lever names itself on both sides

- **WHEN** a dispatch row is killed by the explicit job-lever kill, by the cancel lever, or by an owner-session end
- **THEN** the journal terminal reason and the wake carry that lever's sentence verbatim and no other lever's — an explicit kill is never reported as an owner death or as a plugin dispose

#### Scenario: Nested error objects render readable

- **WHEN** a host terminal event carries its error as a nested object with no string `message` and the dispatch journals it
- **THEN** the journal reason names the error's own text (or a clipped JSON rendering of the object) and never contains `[object Object]`

#### Scenario: Unrenderable error objects never throw

- **WHEN** the error object cannot be serialized (circular, BigInt-bearing) or throws when read (a throwing getter, a hostile Proxy)
- **THEN** the renderer returns no detail, the citing journal reason and wake fall back to their own honest wording, and nothing is thrown into the signal path

#### Scenario: Kill lands in the respawn window

- **WHEN** a dispatch row is killed while its retry child is being created, or while the retry prompt is being sent to it
- **THEN** the dispatch settles aborted with the killer's sentence, the fresh child is aborted (never prompted when the kill preceded the prompt), and no unwatched child keeps running

#### Scenario: Unconfirmed abort is disclosed

- **WHEN** a kill path's abort attempt fails or cannot be verified (e.g. an abort-less session client)
- **THEN** the journal and the wake disclose that the abort could not be confirmed and the child may still be running

#### Scenario: An abort that never returns is unconfirmed

- **WHEN** a kill path issues its abort and the host call has not returned within the bounded wait
- **THEN** the journal terminal reason and the wake both disclose that the abort call had not returned and the child may still be running — never a bare aborted outcome

#### Scenario: An already-idle owner hears what the journal says

- **WHEN** the owning session is already idle when its dispatch row is killed, so the wake is delivered at kill time, and the abort then fails
- **THEN** the wake waits for the abort verdict and discloses the failed abort with the same wording the journal terminal reason carries

### Requirement: Abort effectiveness on the v2 session client

The session client used for dispatch SHALL provide a real abort on every host generation, or the absence SHALL be disclosed rather than swallowed. On v2 hosts the child-session abort SHALL be wired through an actually available surface (the SDK session abort or the host's HTTP session-abort endpoint) instead of silently no-opping on a missing method; kill paths SHALL NOT discard the abort result silently — a failed or unverifiable abort SHALL be journaled and surfaced per the honest-aborted-outcome requirement.

#### Scenario: v2 kill path aborts the child for real

- **WHEN** a dispatch row is killed on a v2 host and the wired abort surface is available
- **THEN** the abort is issued through that surface and the child session stops running

#### Scenario: Abort-less client is disclosed, not swallowed

- **WHEN** the session client cannot abort at all (no abort surface on this host generation)
- **THEN** the kill path records the unverifiable abort in the journal and the wake instead of silently treating the row as cleanly killed
