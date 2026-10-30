# forge-subagents Delta — pool-namespace-contract

## MODIFIED Requirements

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

### Requirement: Workspace pool ownership and global fallback

A session's dispatchable pool set SHALL be exactly: the session's WORKSPACE pool — the nearest `.opencode/forge.json` discovered by walking up from the session's effective worktree — plus the global layer (`~/.config/opencode/forge.json`) as a FALLBACK ONLY: when the workspace has a pool file, the global layer is NOT consulted for that session's dispatch roster (the workspace pool is the whole roster — fallback, not merge); when the workspace has none, the global layer serves as the whole roster. `forge.json` files nested DEEPER in the workspace's subtree (any directory below the owning one) SHALL be ignored entirely — the same workspace-ownership strictness as the host's native MCP config; a git checkout or subfolder carrying its own forge.json does not split or extend the pool. On a host where multiple workspaces' pools have been materialized, the plugin's task-dispatch guard SHALL scope dispatch SESSION-LOCALLY: a task call targeting an agent whose pool belongs to ANOTHER workspace SHALL be refused with a finding that names the target's origin pool path, states it is not dispatchable from this session, and names the exits (open the session in that workspace, or configure the role into this workspace's pool or the global layer). EVERY family materializes namespaced: each workspace pool under its declared `pool` namespace (failing that, the sanitized pool-directory basename), and the global fallback layer under the fixed namespace `global` (`forge-global-<id>`) — NO family receives plain ids, so a materialized id is identical on every host regardless of the order workspaces were initialized in. Pool resolution order SHALL be deterministic — families ordered lexicographically by absolute pool-file path — and a cross-family materialized-id collision SHALL resolve in that order: the earlier pool's agent wins, the colliding later agent is skipped with an error finding naming both files. The host-wide materialization set is the union of the global layer and every workspace pool the host has seen (hot-applied per the existing mtime contract; there is no append-only anchor set — a pool file deleted from disk disappears from materialization). Sessions whose workspace cannot be observed (unknown anchor) keep the existing fail-open belt posture with a disclosure.

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
