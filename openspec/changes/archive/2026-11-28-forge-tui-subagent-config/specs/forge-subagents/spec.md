## MODIFIED Requirements

### Requirement: Static agent definitions in a dedicated forge.json

Subagents SHALL be configured in a dedicated `forge.json` (JSONC — comments allowed), resolved by exclusive workspace ownership: walk UP from the session effective worktree to the owning `.opencode/forge.json`; nested files below the owning workspace do not participate. Global `~/.config/opencode/forge.json` supplies workers only if the workspace has no pool file; on a host initialized in multiple workspaces, every workspace pool the host has seen materializes as a namespaced family per the *Workspace pool ownership and global fallback* requirement. The anchor SHALL be the session-effective worktree where the plugin can observe one (tool-context worktree with the host launch directory as fallback), and the host anchor set — every directory the host has initialized — for host-wide pool discovery. The workspace pool SHALL be the entire session roster even when empty, unreadable or invalid; disclose findings, never fall back to global on a malformed existing pool. Only absence permits global fallback. Host materialization is the union of known workspace families and global, not a session roster. The independent global `override` entries are not pool workers. The file SHALL define `agents` as a map of agent id to `{model?, thoughtLevel?, prompt?, shape?, permission?}` where the id is a plain role word matching `[a-z0-9-]`: the reserved `forge-` prefix SHALL be stripped from an id (all repetitions) with a warn finding naming the normalized id — the plugin materializes every id as `forge-<ns>-<id>` under its family's namespace, so a prefixed id would double up (`forge-coder` → agent `forge-<ns>-forge-coder`) — and an id that is empty after stripping SHALL be rejected as invalid; when two entries collide after normalization the later entry SHALL be skipped with an error finding (first definition wins). `model` and `thoughtLevel` form an atomic configuration pair: both absent defines an **Auto worker** — the materialized agent carries no `model` key and inherits the parent session's model through the host's native spawn behavior, with no depth injected (the provider default applies); both present defines a **pinned worker** — `model` is the exact `provider/model` identity pinned into the materialized agent and `thoughtLevel` is a pinned reasoning word (canonical `none|low|medium|high|max` or a native level name, verbatim); exactly one of the two present — in either direction, including `thoughtLevel` without `model` — makes the entry invalid: it SHALL be skipped with an error finding naming the agent id and the missing half, while its siblings still apply. A forge.json MAY also declare a top-level `pool` string — a short namespace (`[a-z0-9-]`, at most 24 characters) naming this file's family: EVERY family materializes namespaced (`forge-<ns>-<id>`), and when the field is absent the workspace namespace derives from the file's directory name; global is fixed `global`; an invalid workspace namespace (wrong type, empty after trim, charset mismatch, or over length) SHALL degrade to a warn finding naming the file plus the directory-name fallback, and the family still materializes; the global namespace remains fixed. The crew orchestration layer additionally requires a valid declared `pool` as a file-level compliance precondition for workspace-pool crew-governed dispatch (see the crew-harness capability's *Crew-governed dispatch pool-compliance gate*). The legacy `depths` array SHALL be ignored with a deprecation finding and SHALL NOT influence behavior. Configuration SHALL hot-apply: the plugin re-reads the files (mtime-cached) and re-runs the upward workspace-pool discovery whenever it next resolves the roster and at every depth-injection lookup, so edits — and the appearance or removal of an owning workspace pool file — take effect without a host restart. The server plugin SHALL only READ these files — never create, write, or migrate them through its lifecycle or tools. The sole plugin-owned exception is an explicit human save in the Forge TUI — executed by the server's forge-config RPC handlers on that human's explicit confirmation, under the bounded commit protocol of forge-tui-subagent-config — scoped and validated as specified in forge-tui-subagent-config. Existing user-directed in-band editing remains unchanged. When no forge.json exists in any layer or pool the unconfigured state SHALL be inert: no subagents registered, no errors raised, no AI-facing configuration recipe emitted; onboarding lives in the README and the explicitly opened TUI for the human operator.

#### Scenario: Project file wins over global

- **WHEN** both `~/.config/opencode/forge.json` (defining `research` and `review`) and a project `.opencode/forge.json` (defining `research` with a different definition) are loadable
- **THEN** the workspace session roster contains only project `research`; global `review` remains in the host union but is not dispatchable from that session

#### Scenario: Malformed or empty workspace pool does not inherit global workers

- **WHEN** a workspace pool exists but is empty, malformed or unreadable while the global recipe contains workers
- **THEN** the workspace roster remains exclusive, findings are disclosed as applicable, no global worker is substituted, and only actual pool absence enables global fallback

#### Scenario: A forge--prefixed id is self-healed to its plain role word

- **WHEN** forge.json defines `forge-coder` (and separately `coder` does not exist)
- **THEN** the entry materializes under the normalized id `coder` as `forge-<ns>-coder` — never `forge-<ns>-forge-coder` — and a warn finding names the normalization; when `coder` IS also defined, the later of the two entries is skipped with an error finding and the first definition wins

#### Scenario: The project layer is discovered by walking up

- **WHEN** the discovery anchor is `C:/work/repo/packages/app` and the only project file is `C:/work/repo/.opencode/forge.json`
- **THEN** that file owns the workspace roster; nested files below the owning workspace do not take precedence, and global does not merge

#### Scenario: A session-visible anchor re-runs discovery where the plugin reads per session

- **WHEN** `crew_begin` executes in a session whose effective worktree differs from the host launch directory
- **THEN** the gate's guidance resolves the project-layer path from the session's anchor (walking up from it), and the load reflects that owning workspace, not a deeper nested file or host launch directory

#### Scenario: A pool field names the family's namespace

- **WHEN** a workspace pool's forge.json declares `"pool": "aa"` and defines `shader`
- **THEN** the family materializes under the namespace `aa` (the agent id `forge-aa-shader`) regardless of the directory's name — renaming the directory leaves the materialized ids unchanged

#### Scenario: An invalid pool field degrades to a finding plus the fallback

- **WHEN** a forge.json declares `"pool": "Aa Team!"` (charset mismatch) or `"pool": 7` (wrong type)
- **THEN** a warn finding names the file and the invalid value, and the workspace family materializes under the directory-name-derived namespace instead (global remains fixed `global`) — the family is never dropped for a bad `pool`

#### Scenario: Edits hot-apply without restart

- **WHEN** the user edits a layer's `forge.json` on a running host — or creates/deletes a project file on an anchor's ancestor chain — and the plugin next resolves the roster
- **THEN** the materialized agent set and depth lookups reflect the new effective set; no host restart is required

#### Scenario: The plugin never writes the file

- **WHEN** any plugin lifecycle event occurs (load, setup, a tool call, chat.params, error) without an explicit human TUI save
- **THEN** `forge.json` is only read; the plugin never generates, completes, or migrates it absent that explicit human TUI save — the sole exception being the server-side execution of that save per the forge-tui-subagent-config commit protocol

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
the materialized projection. Each namespaced worker compiled file `SHALL` carry the
provenance-bearing description, an always-stamped `mode: subagent`
(without which the host silently falls back to a general dispatch), the
pinned model identity including its variant channel where the recipe's
depth word maps to one, the tools face in the host's current tool
vocabulary per the entry's shape as 'Materialization as native subagents
with a pinned model' defines it — the builtin shell open to every worker
unless an explicit permission override denies it — and the
worker mandates baked into the prompt body as 'Worker prompts and
descriptions name the native dispatch path' defines them — all emitted
under a GENERATED header that directs edits to the recipe. The sync `SHALL` write atomically and `SHALL`
garbage-collect namespaced files whose entries left the recipe.
The compiler SHALL separate namespaced worker policies from `general`/`explore` override compilation even where `toolsFaceFor` is shared. Only namespaced workers receive this change’s worker-specific question, harness and recursion restrictions and discipline; built-in overrides retain their independent existing shape/model/prompt/permission semantics. Compilation `SHALL` emit only probe-proven frontmatter keys (unknown
keys are dropped by the host once `permissions` is present). Before
crew registration or dispatch relying on a generated definition (including draft scouts) on a native-mode host the plugin `SHALL` check
recipe-versus-artifact staleness — content and compiler-contract compatibility adjudication independent of mtime (a byte-identical current artifact touch is not staleness; an old compiler projection is stale even at equal timestamps) — and refuse use of incompatible artifacts with a one-step recovery instruction when stale; the sync
operation `SHALL` be agent-invocable so recovery happens in-band and
transcript-visible, and the host's hot-apply `SHALL` be relied on (no
restart demanded). The explicit human TUI Save & Sync operation SHALL invoke the same compilation contract without a model request, for the selected recipe family only, and independently disclose recipe-save and host-application outcomes as specified in forge-tui-subagent-config. A `sync: "auto"` opt-in `SHALL` regenerate on
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

#### Scenario: Upgrade rejects old projection even at identical timestamps

- **WHEN** an unchanged workspace recipe or global fallback recipe has an old generated permission face or prompt with matching timestamps
- **THEN** the incompatible projection is detected before use; explicit authorized sync or the owning recipe's existing auto opt-in regenerates it, otherwise no write occurs and recovery is disclosed. Workspace and global fallback are checked separately without merging the session roster.

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
  current compatible artifacts arrive with the recipe via the same pull and content/compatibility checks pass; travelling together is not itself proof of compatibility

#### Scenario: Runtime materialization remains available as an escape hatch

- **WHEN** the materialize knob selects the runtime path (an escape hatch a
  host may opt into)
- **THEN** the host runtime projection uses the new worker face and prompts from the recipe (the generated-file staleness gate is a native-mode facility)

### Requirement: Built-in subagent override via the global recipe

Scaffold creation `SHALL` be explicit-only: the global forge.json
`SHALL` be drafted in-band by the forge agent on the user's explicit
ask — directly, or via the `/forge init global` lever (forge-commands)
— or by the human through explicit TUI Save & Sync of a missing global recipe as specified in forge-tui-subagent-config. The plugin `SHALL NOT` write that file uninvited. The in-band scaffold
`SHALL` carry General/Explore
override entries in comment form — uncommenting and filling an entry
is the user's act, and the default-installed state `SHALL` be
byte-equal to official built-in behavior (no vendor prompt text is
ever copied). When the global recipe contains an override entry, sync
`SHALL` emit it as a same-name, non-namespaced file in the host's
global agent directory, case-locked to the built-in's exact LOWERCASE
id stem (`general.md` / `explore.md` — the probe-established identity
key; a capitalized variant creates an ambiguous duplicate entry and
`SHALL` never be emitted); if a hand-written file of that name already
exists, sync `SHALL`
refuse and disclose rather than overwrite. Garbage collection for
override files `SHALL` key on the in-content GENERATED marker rather
than the `forge-` prefix. The gating probe ran 2026-11-21
(`reports/probe-builtin-override.md`): user same-name files DO shadow
the built-ins (description/system/model replaced, permissions
base-∪-appended, hot-apply) on the lowercase id only — POSITIVE.

The namespaced worker-only policy changes SHALL NOT alter the existing override face, prompts or model semantics through shared compilation helpers. Existing generated lowercase `general.md` / `explore.md` SHALL be checked against the independent override projection; stale generated files may be corrected only by the existing authorized explicit sync or applicable global auto opt-in. Hand-written same-name files remain byte-identical, never treated as generated, overwritten or garbage-collected. If authorization is absent, disclose stale generated files without writing; preserve original override behavior and marker-keyed deletion.

#### Scenario: The scaffold arrives only on ask, inert by default

- **WHEN** the user asks for global workers or a built-in override
  in-band (directly, or by running `/forge init global`) and no global
  forge.json exists
- **THEN** the forge agent drafts the scaffold in-band with
  General/Explore entries in comment form, the host's built-in
  behavior is unchanged until the user uncomments and fills an entry,
  and without an explicit ask or command the plugin writes nothing

#### Scenario: An activated override pins the built-in machine-wide

- **WHEN** the global recipe's Explore entry is uncommented with a
  model and depth word and forge_sync runs
- **THEN** `explore.md` (lowercase id stem) lands in the host's
  global agent dir, the
  compiled identity shadows the built-in in every workspace, and a
  later sync garbage-collects it (marker-keyed) when the entry is
  re-commented or removed

#### Scenario: Hand-written same-name files are never clobbered

- **WHEN** sync would emit `general.md` and a hand-written file of
  that name exists in the host's global agent dir
- **THEN** sync refuses with a disclosure naming the collision, and
  the hand-written file is left byte-identical

#### Scenario: Worker compiler migration preserves independent built-in overrides

- **WHEN** namespaced workers and activated global overrides are compiled, including existing generated files at equal timestamps and a hand-written same-name file
- **THEN** worker-specific policy applies only to namespaced workers, existing override semantics remain intact; authorized sync reconciles stale generated files only, absent authorization writes nothing, and hand-written collisions are disclosed without modification
