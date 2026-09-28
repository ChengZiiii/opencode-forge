## MODIFIED Requirements

### Requirement: Static agent definitions in a dedicated forge.json

Subagents SHALL be configured in a dedicated `forge.json` (JSONC — comments allowed), resolved by an opencode-aligned two-layer merge: global `~/.config/opencode/forge.json` as the base layer, plus the NEAREST project `.opencode/forge.json` discovered by walking UP from the discovery anchor directory until the filesystem root (the first file found on the walk is the project layer; no deeper file is consulted). The anchor SHALL be the session-effective worktree where the plugin can observe one (tool-context worktree with the host launch directory as fallback), and the host launch directory for host-level materialization in the config hook. The two layers SHALL be MERGED, not replaced: the agent maps combine, and on agent-id collision the project definition replaces the global one for that id (per-agent precedence; there is never cross-layer field blending — an agent's definition comes wholly from one layer). The file SHALL define `agents` as a map of agent id (`[a-z0-9-]`) to `{model?, thoughtLevel?, prompt?, shape?, permission?}` where `model` and `thoughtLevel` form an atomic configuration pair: both absent defines an **Auto worker** — the materialized agent carries no `model` key and inherits the parent session's model through the host's native spawn behavior, with no depth injected (the provider default applies); both present defines a **pinned worker** — `model` is the exact `provider/model` identity pinned into the materialized agent and `thoughtLevel` is a pinned reasoning word (canonical `none|low|medium|high|max` or a native level name, verbatim); exactly one of the two present — in either direction, including `thoughtLevel` without `model` — makes the entry invalid: it SHALL be skipped with an error finding naming the agent id and the missing half, while its siblings still apply. The legacy `depths` array SHALL be ignored with a deprecation finding and SHALL NOT influence behavior. Configuration SHALL hot-apply: the plugin re-reads the files (mtime-cached) and re-runs the upward discovery at every config hook and every depth-injection lookup, so edits — and the appearance or removal of a project file anywhere on the anchor's ancestor chain — take effect without a host restart. The plugin SHALL only ever READ these files — never create, write, or migrate them. When no forge.json exists in either layer the unconfigured state SHALL be inert: no subagents registered, no errors raised, no AI-facing configuration recipe emitted; onboarding lives in the README for the human operator.

#### Scenario: Project file wins over global

- **WHEN** both `~/.config/opencode/forge.json` (defining `research` and `review`) and a project `.opencode/forge.json` (defining `research` with a different definition) are loadable
- **THEN** the layers MERGE: the effective set contains both `review` (wholly from the global layer) and `research` (wholly from the project layer — the project definition wins for that id, never field-blended)

#### Scenario: The project layer is discovered by walking up

- **WHEN** the discovery anchor is `C:/work/repo/packages/app` and the only project file is `C:/work/repo/.opencode/forge.json`
- **THEN** that file is the project layer (nearest on the ancestor chain wins); a `.opencode/forge.json` at any deeper level would take precedence over it, and no file above it on the chain is consulted once one is found

#### Scenario: A session-visible anchor re-runs discovery where the plugin reads per session

- **WHEN** `crew_begin` executes in a session whose effective worktree differs from the host launch directory
- **THEN** the gate's guidance resolves the project-layer path from the session's anchor (walking up from it), and the load reflects that anchor's chain

#### Scenario: Edits hot-apply without restart

- **WHEN** the user edits a layer's `forge.json` on a running host — or creates/deletes a project file on the anchor's ancestor chain — and the next config hook or depth lookup fires
- **THEN** the materialized agent set and depth lookups reflect the new effective set; no host restart is required

#### Scenario: The plugin never writes the file

- **WHEN** any plugin lifecycle event occurs (load, config hook, chat.params, error)
- **THEN** `forge.json` is only read; the plugin never generates, completes, or migrates it

#### Scenario: Legacy depths field degrades to a finding

- **WHEN** an agent definition carries `depths: ["low", "medium"]` alongside a pinned `model` + `thoughtLevel` pair
- **THEN** the agent still materializes on the pinned pair, a deprecation finding naming the agent is recorded, and the `depths` array does not influence behavior

#### Scenario: Unconfigured state is inert

- **WHEN** the host starts with no forge.json in either layer
- **THEN** no `forge-*` subagents are registered, no error or recipe is surfaced to the model, and the host behaves exactly as without this capability

#### Scenario: An Auto worker entry is valid

- **WHEN** an agent definition carries neither `model` nor `thoughtLevel`
- **THEN** the entry is accepted with no error finding and materializes as an Auto worker (no `model` key on the materialized agent; the parent session's model applies at dispatch; the provider's default depth applies)

#### Scenario: A half-configured entry is rejected in both directions

- **WHEN** one entry defines `model` without `thoughtLevel`, and another defines `thoughtLevel` without `model`
- **THEN** both entries are skipped with an error finding each naming the agent id and the missing half, and the remaining entries still apply

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
