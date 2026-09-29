## MODIFIED Requirements

### Requirement: Static agent definitions in a dedicated forge.json

Subagents SHALL be configured in a dedicated `forge.json` (JSONC — comments allowed), resolved by an opencode-aligned two-layer merge: global `~/.config/opencode/forge.json` as the base layer, plus the NEAREST project `.opencode/forge.json` discovered by walking UP from the discovery anchor directory until the filesystem root (the first file found on the walk is the project layer; no deeper file is consulted); on hosts with multiple anchors, each anchor's chain contributes a pool family and subtree `.opencode/forge.json` files contribute additional sub-pool families per the *Hierarchical pool materialization on shared hosts* requirement. The anchor SHALL be the session-effective worktree where the plugin can observe one (tool-context worktree with the host launch directory as fallback), and the host anchor set for host-level materialization in the config hook. The two layers SHALL be MERGED, not replaced: the agent maps combine, and on agent-id collision the project definition replaces the global one for that id (per-agent precedence; there is never cross-layer field blending — an agent's definition comes wholly from one layer). The file SHALL define `agents` as a map of agent id to `{model?, thoughtLevel?, prompt?, shape?, permission?}` where the id is a plain role word matching `[a-z0-9-]`: the reserved `forge-` prefix SHALL be stripped from an id (all repetitions) with a warn finding naming the normalized id — the plugin materializes every id as `forge-<id>` (or `forge-<ns>-<id>` under a namespace), so a prefixed id would double up (`forge-coder` → agent `forge-forge-coder`) — and an id that is empty after stripping SHALL be rejected as invalid; when two entries collide after normalization the later entry SHALL be skipped with an error finding (first definition wins). `model` and `thoughtLevel` form an atomic configuration pair: both absent defines an **Auto worker** — the materialized agent carries no `model` key and inherits the parent session's model through the host's native spawn behavior, with no depth injected (the provider default applies); both present defines a **pinned worker** — `model` is the exact `provider/model` identity pinned into the materialized agent and `thoughtLevel` is a pinned reasoning word (canonical `none|low|medium|high|max` or a native level name, verbatim); exactly one of the two present — in either direction, including `thoughtLevel` without `model` — makes the entry invalid: it SHALL be skipped with an error finding naming the agent id and the missing half, while its siblings still apply. A forge.json MAY also declare a top-level `pool` string — a short namespace (`[a-z0-9-]`, at most 24 characters) naming this file's family when it materializes under a namespace; when absent the namespace derives from the file's directory name; an invalid value (wrong type, empty after trim, charset mismatch, or over length) SHALL degrade to a warn finding naming the file plus the directory-name fallback, and the family still materializes. The legacy `depths` array SHALL be ignored with a deprecation finding and SHALL NOT influence behavior. Configuration SHALL hot-apply: the plugin re-reads the files (mtime-cached) and re-runs the upward discovery and the bounded subtree scan at every config hook and every depth-injection lookup, so edits — and the appearance or removal of a project or pool file anywhere covered by an anchor's chain or subtree — take effect without a host restart. The plugin SHALL only ever READ these files — never create, write, or migrate them. When no forge.json exists in any layer or pool the unconfigured state SHALL be inert: no subagents registered, no errors raised, no AI-facing configuration recipe emitted; onboarding lives in the README for the human operator.

#### Scenario: Project file wins over global

- **WHEN** both `~/.config/opencode/forge.json` (defining `research` and `review`) and a project `.opencode/forge.json` (defining `research` with a different definition) are loadable
- **THEN** the layers MERGE: the effective set contains both `review` (wholly from the global layer) and `research` (wholly from the project layer — the project definition wins for that id, never field-blended)

#### Scenario: A forge--prefixed id is self-healed to its plain role word

- **WHEN** forge.json defines `forge-coder` (and separately `coder` does not exist)
- **THEN** the entry materializes as the agent `forge-coder` — never `forge-forge-coder` — under the normalized id `coder`, and a warn finding names the normalization; when `coder` IS also defined, the later of the two entries is skipped with an error finding and the first definition wins

#### Scenario: The project layer is discovered by walking up

- **WHEN** the discovery anchor is `C:/work/repo/packages/app` and the only project file is `C:/work/repo/.opencode/forge.json`
- **THEN** that file is the project layer (nearest on the ancestor chain wins); a `.opencode/forge.json` at any deeper level would take precedence over it, and no file above it on the chain is consulted once one is found

#### Scenario: A session-visible anchor re-runs discovery where the plugin reads per session

- **WHEN** `crew_begin` executes in a session whose effective worktree differs from the host launch directory
- **THEN** the gate's guidance resolves the project-layer path from the session's anchor (walking up from it), and the load reflects that anchor's chain

#### Scenario: A pool field names the family's namespace

- **WHEN** a sub-pool forge.json declares `"pool": "aa"` and defines `shader`
- **THEN** the family materializes under the namespace `aa` (the agent id `forge-aa-shader`) regardless of the directory's name — renaming the directory leaves the materialized ids unchanged

#### Scenario: An invalid pool field degrades to a finding plus the fallback

- **WHEN** a forge.json declares `"pool": "Aa Team!"` (charset mismatch) or `"pool": 7` (wrong type)
- **THEN** a warn finding names the file and the invalid value, and the family materializes under the directory-name-derived namespace instead — the family is never dropped for a bad `pool`

#### Scenario: Edits hot-apply without restart

- **WHEN** the user edits a layer's `forge.json` on a running host — or creates/deletes a project file on an anchor's ancestor chain or a pool file in an anchor's subtree — and the next config hook or depth lookup fires
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

## ADDED Requirements

### Requirement: Hierarchical pool materialization on shared hosts

On a host whose plugin has been initialized with one or more directories (agent frontends routinely share one host process across projects), materialization SHALL resolve from an append-only **anchor set**: every initialization directory joins the set exactly once (normalized — resolved real path with case-folding on win32 — so the same directory cannot double-add) and the first entry is the primary anchor; no anchor SHALL be removed or replaced within the host's lifetime, and a re-initialization with a different directory SHALL NOT remove or replace any materialized agent (anchor flips never mutate the vocabulary; file truth always does). For each anchor the plugin SHALL resolve a pool family: the root pool (the nearest `.opencode/forge.json` walking up from the anchor, merged over the global layer per agent id) plus every sub-pool file at `<subdirectory>/.opencode/forge.json` within the anchor's subtree, discovered by a bounded **breadth-first descent in lexicographic sibling order** that skips dependency directories (`node_modules`, `.git`, `dist`, `build`, `out`, `target`, `.cache`, `venv`, `.venv`, `__pycache__`, `coverage`) and caps the scanned-directory count per anchor (default 2,000 — when the cap is reached no further directories are opened in that order), mtime-caching directories so unchanged subtrees are not rescanned; a sub-pool's own ancestor chain SHALL NOT be consulted (the root pool already carries it). A pool's identity SHALL be its absolute file path: the same file reached through two anchors' resolutions SHALL materialize exactly once. A pool file that fails JSONC parsing SHALL contribute no agents for that pool, with an error finding carrying the parse location, while every other pool and the global layer still materialize. Pool resolution order SHALL be deterministic: the primary anchor's root pool first, then the remaining pools ordered lexicographically by absolute file path. Materialized ids: the primary anchor's root pool SHALL keep plain `forge-<id>` ids (a single-anchor host is unchanged in behavior and roster); every other family SHALL materialize as `forge-<ns>-<id>`, where `ns` is the file's `pool` field when valid and otherwise the sanitized directory basename (lowercased; each run of characters outside `[a-z0-9-]` collapsed to a single `-`; leading and trailing `-` trimmed; an empty result falls back to the literal namespace `pool`). Namespace collisions across distinct files SHALL be disambiguated deterministically: in resolution order, the first file keeps the short namespace and later colliding files receive an incrementing hyphen suffix (`-2`, `-3`, …) until unique across both derived and declared namespaces, with an error finding naming both files. Where two distinct families would compose the same materialized agent id (a plain primary id matching a namespaced id, or two namespaced families composing to one), the same deterministic order decides: the earlier pool's agent materializes and the later pool's colliding agent SHALL be skipped with an error finding naming both files — no silent shadowing. Id normalization (including `forge-` prefix stripping) SHALL apply to the raw id BEFORE namespace composition, and the namespace infix SHALL never be parsed back out of a materialized id. Every materialized agent — plain or namespaced — SHALL carry identical per-agent semantics (pinned pair or Auto worker, shape-derived permission with the recursion ban, worker discipline, depth injection keyed by the materialized name). Presentation of the dispatchable roster grouped by pool with origins is governed by the crew-harness capability's `/crew` command discipline requirement.

#### Scenario: Anchor re-initialization never flips the vocabulary

- **WHEN** a shared host initializes the plugin with `C:/Temp1` and later re-initializes it with `D:/TempOpenUnity` (a session from another project appearing)
- **THEN** the agents materialized from the `C:/Temp1` anchor set remain registered and dispatchable — the later initialization only ADDS the new anchor's pools; no template, gate, or vocabulary ever reverts to an earlier or different anchor's view

#### Scenario: Sub-pools are discovered by the bounded subtree scan

- **WHEN** the anchor is `C:/Temp1` (root forge.json present) and `C:/Temp1/devAa/.opencode/forge.json` exists while `devAb` has no forge.json
- **THEN** the anchor's family resolves as the root pool plus the `devAa` sub-pool; a session anchored at `C:/Temp1` can dispatch both the root pool's plain-id agents and the sub-pool's namespaced agents in the same crew

#### Scenario: The skip-list and budget bound the scan

- **WHEN** the anchor's subtree contains `node_modules/pkg/.opencode/forge.json` or exceeds the scanned-directory budget
- **THEN** the skipped or over-budget pool files contribute nothing (no agents, no findings about them), and the scan completes without traversing the skipped trees

#### Scenario: The same file via two anchors materializes once

- **WHEN** one host's anchor set contains both `C:/Temp1` and `C:/Temp1/devAc`, so the root anchor's subtree scan and the devAc anchor's walk-up both reach `C:/Temp1/devAc/.opencode/forge.json`
- **THEN** that file's family materializes exactly once under a single namespace — the two discovery paths deduplicate by file identity

#### Scenario: The primary root pool keeps plain ids; other families are namespaced

- **WHEN** the primary anchor's root pool defines `shader` and a second anchor's root pool also defines `shader`
- **THEN** the primary's agent is `forge-shader` while the second's is `forge-<ns>-shader` — two distinct agents, no silent shadowing, and a single-anchor host's roster is byte-compatible with the pre-hierarchy behavior

#### Scenario: A namespace collision is disambiguated with a finding

- **WHEN** two distinct pool files derive or declare the same namespace (both directory-named `dev`)
- **THEN** in deterministic resolution order (primary root pool first, then lexicographic by file path) the first file keeps the short namespace, the later file's agents carry the incrementing suffix form (`-2`, `-3`, … unique across derived and declared namespaces), and an error finding names both files

#### Scenario: A cross-family materialized-id collision is never silently shadowed

- **WHEN** the primary root pool defines the id `aa-shader` (→ `forge-aa-shader`) and a sub-pool with `"pool": "aa"` defines `shader` (→ `forge-aa-shader`)
- **THEN** the deterministic order decides — the primary root pool's agent materializes as `forge-aa-shader`, the sub-pool's colliding agent is skipped, and an error finding names both files; the namespace infix is never parsed back out of a materialized id

#### Scenario: A broken pool file empties only its own family

- **WHEN** one sub-pool forge.json fails JSONC parsing while other pools and the global layer are loadable
- **THEN** that pool contributes no agents with an error finding carrying the parse location, and every other pool plus the global layer still materialize

#### Scenario: Namespaced agents carry identical per-agent semantics

- **WHEN** a namespaced `forge-aa-shader` (pinned pair, `shape: "write"`) is dispatched through the native task tool
- **THEN** it runs the pinned model with the write-shape permission minus the recursion ban, the worker discipline in its prompt, and its depth injected keyed by the materialized name — indistinguishable in semantics from any plain-id agent

#### Scenario: A new pool file in a subtree hot-applies

- **WHEN** the user creates `C:/Temp1/devAa/.opencode/forge.json` on a running host and the next config hook fires
- **THEN** the sub-pool's agents appear in the vocabulary and roster without a host restart, and deleting the file removes the family again (file truth hot-applies in both directions)
