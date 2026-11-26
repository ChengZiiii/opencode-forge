## ADDED Requirements

### Requirement: The native subagent tool is the only dispatch surface

The plugin SHALL register no dispatch tool of its own — no `task`, `forge_dispatch`, or any other tool that creates a child session. The host's native `subagent` tool is the only way any session dispatches a worker: the forge primary and every non-forge agent alike call it, and it lists every `forge-*` worker the calling agent may use. A native call returns a child session id at once; the child runs as a host background job in its parent's directory, and the host delivers a `<background-result kind="subagent">` message to the parent each time the child goes idle — carrying its final report, its error, or its cancellation — and again after each later round of work. The plugin SHALL NOT deliver, duplicate, or supplement that message, SHALL NOT poll or re-subscribe to children as a dispatch engine, and SHALL NOT resume children itself. Crew-local scheduling observation and bounded rechecks remain permitted under crew-harness; they neither deliver nor imitate host completion messages. There is no synchronous dispatch, no concurrency cap, no queue, no wait budget, and no automatic retry: the plugin SHALL impose none of them, and no forge.json node, plugin option, or environment variable SHALL bring any of them back. A `forge-*` worker is an ordinary host agent preset: the plugin contributes its worker definitions (model pin, tool face, question denial, prompt) and nothing in the execution path.

#### Scenario: No plugin dispatch tool is registered

- **WHEN** the plugin loads under any configuration
- **THEN** the host's tool registry holds no plugin-registered tool that creates a child session, and the native `subagent` tool is the only one that does

#### Scenario: A forge worker is dispatched natively

- **WHEN** the forge primary calls the native `subagent` tool with `agent: "forge-<ns>-coder"` and a task prompt
- **THEN** the call returns a child session id immediately, the child runs the `forge-<ns>-coder` agent in the parent's directory (a pinned worker on its pinned model, an Auto worker on the parent's model), and the host delivers the child's final message to the parent

#### Scenario: The plugin neither polls nor re-wakes

- **WHEN** a native child completes, fails, or is cancelled
- **THEN** the host owns actual subagent completion notification; any harness continuation is a separate scheduling observation — the plugin injects no completion wake, no progress notice, and no retry

#### Scenario: A failed child is not respawned

- **WHEN** a native child ends in an error
- **THEN** no automatic retry spawns a second child; the parent receives the host's message carrying the error and decides whether to dispatch again

#### Scenario: Nothing brings the engine back

- **WHEN** forge.json carries a top-level `dispatch` node, an old `FORGE_DISPATCH_*` environment variable is set, or a stale workspace dispatch journal exists
- **THEN** none of them is honored; the node and each variable are ignored with a bounded finding; and no cap, queue, circuit breaker, retry, reaping, or restart recovery runs

### Requirement: Dispatch gates enforced on the native subagent tool

Every dispatch gate the plugin enforced on its own `task` tool SHALL be enforced by the plugin's tool-execute interception belt on calls of the host's native `subagent` tool — the host's `execute.before` tool hook, whose rejection refuses the call before the tool runs — so that retiring the engine removes no gate. The belt SHALL judge each call by the directory the calling session resolves to ('Session directory resolved per session on multi-location hosts') and by the agent the call names as its target; no gate SHALL key on the calling session's own agent:

- a `forge-*` target outside the calling session’s exclusive workspace roster or, only without a workspace pool, its global fallback roster SHALL be refused with the cross-workspace refusal and its exits ('Workspace pool ownership and global fallback');
- a `forge-*` target called from a session with an active plan draft SHALL meet the draft's dispatch gate ('Workers are not dispatched while a plan draft is active');
- a `forge-*` target called from a crew-governed session SHALL meet the crew pending and pool-compliance belts (see crew-harness).

A call whose target is not a `forge-*` agent SHALL carry no pool gate and no crew-compliance gate (the crew pending belt is keyed on the session and applies to every call). Every refusal SHALL be decided before any child session is created and SHALL reach the model as the call's error carrying the belt's own message — the gate named, with its way out. A session the belt cannot place SHALL keep the fail-open posture with a disclosure. The gates SHALL key on the host's `subagent` tool name, kept in the plugin's single native-tool vocabulary with its drift-mirror test — never on a plugin tool name (a `task` key in a worker's permission map is the host's to normalize onto `subagent`; it is not a tool name the belt matches).

#### Scenario: Cross-pool dispatch is refused on the native tool

- **WHEN** a session in workspace A calls the native `subagent` tool for `forge-<nsB>-coder`, whose pool origin is workspace B's forge.json
- **THEN** the call is refused by the belt before any child session is created, with the same finding and exits as the cross-workspace refusal always carried

#### Scenario: Own-pool dispatch flows

- **WHEN** a session whose workspace pool is workspace A's forge.json calls the native `subagent` tool for `forge-<nsA>-coder`
- **THEN** the call is admitted, the host creates the child, and the plugin adds no refusal, notice, or wake of its own

#### Scenario: A non-forge target is not pool-gated

- **WHEN** a forge-family session calls the native `subagent` tool for a host agent such as `general`
- **THEN** no pool gate fires and the host serves the call on its own terms

#### Scenario: A non-forge session may dispatch a forge worker under the same gates

- **WHEN** a session driven by a non-forge agent calls the native `subagent` tool for a `forge-*` worker of that session's own workspace pool
- **THEN** the call is admitted exactly as the same call from the forge primary would be — no gate keys on the calling agent — and the host creates the child

#### Scenario: A refused call creates no child

- **WHEN** the belt refuses a native `subagent` call
- **THEN** the host creates no child session and the refusal reaches the model as the tool call's error

#### Scenario: The refusal reaches the model in the belt's words

- **WHEN** the belt refuses a native `subagent` call
- **THEN** the error text the model reads is the belt's own refusal — naming the gate and the way out — never a bare denial

#### Scenario: The gate keys on the host's action name

- **WHEN** a worker's permission map names the dispatch action as `task`
- **THEN** the host evaluates it as `subagent`, the belt judges the call as a `subagent` call, and the name `subagent` is locked by the same drift-mirror test that locks the rest of the native tool vocabulary

### Requirement: Workers cannot ask the user a question

Every `forge-*` worker definition the plugin compiles — a native agent file or a runtime draft — SHALL deny the worker the host's `question` action — the same choice the host ships for its own background subagents `general` and `explore` — so that a worker running as a background child has no question tool and never parks on a question nobody answers. The denial SHALL sit in the compiled definition's own permission face, beside the recursion ban on the host's `subagent` action. The recursion ban SHALL stand for every shape and SHALL NOT be liftable by a recipe. An explicit `permission` entry in the worker's recipe SHALL win for every other tool — `question` included: the pool author's explicit statement wins, and the README SHALL say that a worker allowed to ask will wait for an answer a background child never gets. The plugin SHALL NOT use a hook to deny questions to agents that are not `forge-*` workers — those are the user's own configuration.

#### Scenario: A worker has no question tool

- **WHEN** a `forge-*` worker dispatched as a native subagent tries to ask the user something
- **THEN** it has no question tool and proceeds without blocking — it never parks on an unanswered question

#### Scenario: The denial is in the compiled worker definition

- **WHEN** the plugin compiles a `forge-*` worker (a native agent file or a runtime draft)
- **THEN** its permission face denies `question` and the host's `subagent` action, alongside the shape-derived entries

#### Scenario: A recipe cannot lift the recursion ban

- **WHEN** a recipe entry's `permission` map sets `task` to anything other than deny
- **THEN** the compiled worker is still denied the host's `subagent` action

#### Scenario: A recipe cannot lift the recursion ban by the native name

- **WHEN** a recipe entry's `permission` map sets `subagent` to `allow`
- **THEN** the compiled worker is still denied the host's `subagent` action, and the tool list the host offers a session running that worker carries no dispatch tool

#### Scenario: A recipe may re-enable the question tool explicitly

- **WHEN** a recipe entry's `permission` map sets `question` to `allow`
- **THEN** the compiled worker keeps its question tool — the explicit statement wins — while the recursion ban stands

### Requirement: Workers are not dispatched while a plan draft is active

While the session has an active plan draft, the plugin's tool-execute interception belt SHALL enforce the draft's dispatch gate on native `subagent` calls, exactly as it enforced it on its own `task` calls. The gate SHALL be decided by the TARGET, read from the recipe, in the terms plan-harness 'Hard write ban during draft' defines, and SHALL be no looser than before the builtin shell was opened to readonly workers: a call whose target is a `forge-*` worker of effective readonly shape SHALL flow as a reconnaissance dispatch, and every other `subagent` call — a write-shape worker, a readonly worker that keeps the shell, a non-forge agent target, an absent or unresolvable target — SHALL be refused with the draft refusal naming the dispatchable effective-readonly roster and the exits (`plan_approve` / discard). A follow-up call to an existing child SHALL be judged by the agent it names, like a new dispatch. The gate SHALL be decided before any child session is created and SHALL lift when the plan is approved or discarded.

A qualified scout SHALL have a current compatible materialized definition matching the recipe and the host's effective permission face. Ordinary host permissions still govern the call and child; `execute.before` admission alone is not proof of a successful dispatch. Where the permission chain or materialized definition does not establish the required face, disclose and refuse qualification until corrected through authorized sync, not treating an old generated artifact as evidence.

#### Scenario: Draft blocks a write worker

- **WHEN** the session has an active plan draft and calls the native `subagent` tool for a write-shape `forge-*` worker
- **THEN** the call is refused with the draft refusal before any child session is created

#### Scenario: Draft lets a shell-less effective-readonly worker through

- **WHEN** the session has an active plan draft and calls the native `subagent` tool for a `forge-*` worker of effective readonly shape
- **THEN** the host admits the call through normal permissions, creates the qualified child with the effective readonly face and delivers its reconnaissance report; before-hook admission alone is insufficient

#### Scenario: Draft blocks a readonly worker that keeps the shell

- **WHEN** the session has an active plan draft and calls the native `subagent` tool for a `forge-*` worker of readonly shape whose recipe leaves the shell available
- **THEN** the call is refused — during a draft no worker that can run a command or write a file is dispatched

#### Scenario: Draft blocks a non-forge target

- **WHEN** the session has an active plan draft and calls the native `subagent` tool for a non-forge agent
- **THEN** the call is refused like any write-class tool during a draft

#### Scenario: A follow-up is judged by the agent it names

- **WHEN** the session has an active plan draft and calls the native `subagent` tool with an existing child's session id and the agent `general`
- **THEN** the call is refused like a new dispatch to that agent would be

### Requirement: Worker prompts and descriptions name the native dispatch path

The namespaced worker description and prompt body the plugin compiles — for a native agent file or a runtime draft — SHALL describe work in the native path's terms. They SHALL NOT mention a `task` tool, `subagent_type`, `run_in_background`, `forge_shell`, `forge_jobs`, task handles, completion wakes, or report files, and SHALL NOT prefer `forge_grep` / `forge_glob` over the builtin search tools. The description SHALL tell the dispatching model to call the host's `subagent` tool with the worker's agent id. The prompt SHALL tell a worker that it is a background subagent whose final message is its report, that it cannot ask the user, that it searches with the builtin `grep` / `glob` tools and runs commands with the builtin shell, that a long-running command goes through the shell's `background` parameter and the host re-wakes it when the command exits (never poll or sleep), and that a commit uses `-m` / `--no-edit`, since the builtin shell's editor and pager behavior is the host's.

#### Scenario: No compiled text names the retired surface

- **WHEN** the plugin's compiled worker descriptions and prompt bodies are inspected
- **THEN** none of them mentions `task`, `subagent_type`, `run_in_background`, `forge_shell`, `forge_jobs`, a task handle, a completion wake, or a report file, and none prefers `forge_grep` / `forge_glob`

#### Scenario: The compiled text teaches the native path

- **WHEN** the plugin's compiled worker descriptions and prompt bodies are inspected
- **THEN** the description names the `subagent` tool and the worker's agent id, and the prompt states that the worker is a background subagent, that its final message is its report, that it cannot ask the user, how to run a long command, and how to commit
## MODIFIED Requirements

### Requirement: Field-level fail-soft validation

forge.json parsing SHALL degrade semantically invalid content at the smallest enclosing level rather than discarding more than necessary: a syntactically broken document (invalid JSONC) yields an EMPTY agent set **for its own family only** plus an error finding carrying the parse location. Other valid families remain independently materialized in the host-wide union, but a session with an existing broken workspace pool gets an empty dispatch roster and SHALL NOT fall back to the global family; only absence of an owning workspace pool permits that fallback (see 'Workspace pool ownership and global fallback'). An agent entry whose `model`/`thoughtLevel` pair is half-configured — exactly one of the two present after field-type normalization, in either direction, or a present `model`/`thoughtLevel` of the wrong type — is skipped with an error finding while its siblings still apply. Findings from every consulted family SHALL be surfaced through the plugin's diagnostics channel and never silently swallowed; no fallback seed agents exist in any failure path.

#### Scenario: One bad entry does not disable its siblings

- **WHEN** a forge.json defines two agents and one has `model` but no `thoughtLevel`
- **THEN** the valid agent materializes normally and an error finding names the skipped one and its missing half

#### Scenario: Broken JSON empties the set with an error finding

- **WHEN** a family's forge.json fails JSONC parsing
- **THEN** that family contributes no agents and an error finding carries the parse location; other valid families remain materialized independently, but a session owning the broken workspace pool has an empty dispatch roster even when a valid global recipe exists; the built-in seed is never resurrected

#### Scenario: A mistyped optional field costs only itself

- **WHEN** an agent pins `model: "prov/x"` but defines `thoughtLevel: 3` (a number)
- **THEN** the mistyped field counts as absent for the atomic-pair check, so the entry is skipped with an error finding — the cost is confined to that entry, and its siblings still materialize

### Requirement: Static agent definitions in a dedicated forge.json

Subagents SHALL be configured in a dedicated `forge.json` (JSONC — comments allowed), resolved by exclusive workspace ownership: walk UP from the session effective worktree to the owning `.opencode/forge.json`; nested files below the owning workspace do not participate. Global `~/.config/opencode/forge.json` supplies workers only if the workspace has no pool file; on a host initialized in multiple workspaces, every workspace pool the host has seen materializes as a namespaced family per the *Workspace pool ownership and global fallback* requirement. The anchor SHALL be the session-effective worktree where the plugin can observe one (tool-context worktree with the host launch directory as fallback), and the host anchor set — every directory the host has initialized — for host-wide pool discovery. The workspace pool SHALL be the entire session roster even when empty, unreadable or invalid; disclose findings, never fall back to global on a malformed existing pool. Only absence permits global fallback. Host materialization is the union of known workspace families and global, not a session roster. The independent global `override` entries are not pool workers. The file SHALL define `agents` as a map of agent id to `{model?, thoughtLevel?, prompt?, shape?, permission?}` where the id is a plain role word matching `[a-z0-9-]`: the reserved `forge-` prefix SHALL be stripped from an id (all repetitions) with a warn finding naming the normalized id — the plugin materializes every id as `forge-<ns>-<id>` under its family's namespace, so a prefixed id would double up (`forge-coder` → agent `forge-<ns>-forge-coder`) — and an id that is empty after stripping SHALL be rejected as invalid; when two entries collide after normalization the later entry SHALL be skipped with an error finding (first definition wins). `model` and `thoughtLevel` form an atomic configuration pair: both absent defines an **Auto worker** — the materialized agent carries no `model` key and inherits the parent session's model through the host's native spawn behavior, with no depth injected (the provider default applies); both present defines a **pinned worker** — `model` is the exact `provider/model` identity pinned into the materialized agent and `thoughtLevel` is a pinned reasoning word (canonical `none|low|medium|high|max` or a native level name, verbatim); exactly one of the two present — in either direction, including `thoughtLevel` without `model` — makes the entry invalid: it SHALL be skipped with an error finding naming the agent id and the missing half, while its siblings still apply. A forge.json MAY also declare a top-level `pool` string — a short namespace (`[a-z0-9-]`, at most 24 characters) naming this file's family: EVERY family materializes namespaced (`forge-<ns>-<id>`), and when the field is absent the workspace namespace derives from the file's directory name; global is fixed `global`; an invalid workspace namespace (wrong type, empty after trim, charset mismatch, or over length) SHALL degrade to a warn finding naming the file plus the directory-name fallback, and the family still materializes; the global namespace remains fixed. The crew orchestration layer additionally requires a valid declared `pool` as a file-level compliance precondition for workspace-pool crew-governed dispatch (see the crew-harness capability's *Crew-governed dispatch pool-compliance gate*). The legacy `depths` array SHALL be ignored with a deprecation finding and SHALL NOT influence behavior. Configuration SHALL hot-apply: the plugin re-reads the files (mtime-cached) and re-runs the upward workspace-pool discovery whenever it next resolves the roster and at every depth-injection lookup, so edits — and the appearance or removal of an owning workspace pool file — take effect without a host restart. The plugin SHALL only ever READ these files — never create, write, or migrate them. When no forge.json exists in any layer or pool the unconfigured state SHALL be inert: no subagents registered, no errors raised, no AI-facing configuration recipe emitted; onboarding lives in the README for the human operator.

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

- **WHEN** any plugin lifecycle event occurs (load, setup, a tool call, chat.params, error)
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

#### Scenario: A native call cannot unpin a pinned worker

- **WHEN** a session calls the native `subagent` tool for a pinned `forge-*`
  worker and passes a `model` of its own
- **THEN** the child runs that worker agent and every request it builds is
  rewritten to the pinned model, exactly as for a call that passed no model

### Requirement: Sandbox full-chain proof

The change `SHALL` be verified on the live 2.4.0 sandbox: a pool agent
with a model pin, dispatched through the host's native `subagent` tool,
completes a turn served by the pinned model (asserted on the served
message record).

#### Scenario: Dispatched pinned subagent serves on the pin

- WHEN a primary dispatches a native `subagent` call to a pinned pool agent on the sandbox
- THEN the subagent's assistant record names the pinned model

### Requirement: Parent-interrupt disclosure

WHEN the parent session's turn is interrupted while native subagent children of this session are in flight, the plugin `SHALL` surface the in-flight child list with cancellation guidance in the interruption path — naming the session-scoped stop route (`/forge stop`). There is no per-id cancel verb for native children. The default posture is disclose-only: an interrupt `SHALL NOT` silently cancel running children.

#### Scenario: ESC with children in flight

- **WHEN** the user interrupts the parent session's turn while native subagent children are in flight
- **THEN** the in-flight child list with cancellation guidance (naming `/forge stop`) is surfaced to the session
- **AND** the children remain running unless explicitly cancelled

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

### Requirement: Workspace pool ownership and global fallback

WORKSPACE pool — the nearest `.opencode/forge.json` discovered by walking up from the session's effective worktree — plus the global layer (`~/.config/opencode/forge.json`) as a FALLBACK ONLY: when the workspace has a pool file (including malformed, unreadable or empty), the global layer is NOT consulted for that session's dispatch roster (the workspace pool is the whole roster — fallback, not merge); when the workspace has none, the global layer serves as the whole roster. `forge.json` files nested DEEPER in the workspace's subtree (any directory below the owning one) SHALL be ignored entirely — the same workspace-ownership strictness as the host's native MCP config; a git checkout or subfolder carrying its own forge.json does not split or extend the pool. On a host where multiple workspaces' pools have been materialized, the plugin's dispatch gate (the tool-execute interception belt) SHALL scope dispatch SESSION-LOCALLY: a native `subagent` call targeting a namespaced worker outside that session’s exclusive roster (including global workers in a pooled workspace) SHALL be refused with a finding that names the target's origin pool path, states it is not dispatchable from this session, and names the exits (open a session in that workspace, or configure the role into this workspace's pool or the global layer). For that guard the session's workspace anchor SHALL be resolved from the host's AUTHORITATIVE session record (`client.session.get`, `effectiveWorktree(worktree, directory)`) whenever the record can be fetched — the plugin's in-memory session map serves as the anchor source ONLY when that fetch fails or is unavailable (no client, API error, or missing record); this ordering exists because the in-memory map has degenerate writers (resumed-after-restart sessions never re-fire `session.created`; some tool-context shapes degenerate to the host launch directory), and a session bound to a pool-less anchor by such a writer would otherwise lose its OWN pool's dispatch rights. The MIRROR degeneration is resolved symmetrically: when the authoritative record yields a valid but POOL-LESS anchor (a resumed-after-restart session re-bound to a new launch directory) while the in-memory binding — kept fresh by the session's own live activity — is a DIFFERENT non-degenerate worktree that OWNS a pool file, the POOLED in-memory binding SHALL win that resolution, with ONE bounded disclosure per session recording the substitution; in every other shape the authoritative record keeps its precedence. The BOTH-DEGENERATE shape — an in-memory binding that is EMPTY (a restart-resumed session before any live activity in the new host life) plus an authoritative record re-bound to a pool-less anchor — is resolved by a PERSISTED SESSION-ANCHOR LEDGER: the plugin maintains a namespaced, bounded JSONL ledger (`<os-tmp>/opencode-forge/session-anchors.jsonl`) mapping session ids to the pooled worktrees where live activity bound them, written ONLY when a bind lands on a worktree owning a pool file (positive evidence of a real pooled binding), deduplicated per session (the last entry wins) and FIFO-capped (compacted to the latest entry per session on overflow), with every ledger read/write failure FAIL-SOFT — resolution degrades to the chain below and dispatch is never blocked by ledger IO. When the chain above yields an anchor that owns NO pool, the guard SHALL consult the ledger; a hit whose worktree still OWNS a pool file on disk (verified at resolution time — a deleted pool file keeps the disappears-from-materialization semantics) SHALL re-bind the session (seeding the in-memory map under the non-degenerate-refinement rule), ALLOW own-pool dispatch, and disclose the re-bind once per session; a cross-pool target from that session remains refused. In that in-memory map, a degenerate anchor (empty or filesystem-root) SHALL never overwrite an existing non-degenerate binding; non-degenerate refinement (session.created seed corrected by a later tool-context binding) keeps today's overwrite semantics. The crew compliance gate resolves its session anchor through the same authoritative-first chain (pooled preference included). EVERY family materializes namespaced: each workspace pool under its declared `pool` namespace (failing that, the sanitized pool-directory basename), and the global fallback layer under the fixed namespace `global` (`forge-global-<id>`) — NO family receives plain ids, so a materialized id is identical on every host regardless of the order workspaces were initialized in. Pool resolution order SHALL be deterministic — families ordered lexicographically by absolute pool-file path — and a cross-family materialized-id collision SHALL resolve in that order: the earlier pool's agent wins, the colliding later agent is skipped with an error finding naming both files. Host materialization is visibility only, never session permission or qualification; the per-session roster remains exclusive. The host-wide materialization set is the union of the global layer and every workspace pool the host has seen (hot-applied per the existing mtime contract; there is no append-only anchor set — a pool file deleted from disk disappears from materialization). Sessions whose workspace cannot be observed (unknown anchor — no in-memory binding AND no authoritative record) keep the existing fail-open belt posture with a disclosure.

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

- **WHEN** a session in workspace A calls the host's native `subagent` tool targeting `forge-<nsB>-coder`, whose pool origin is workspace B's forge.json
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
- **THEN** each materializes under its own family's namespace — `forge-<nsA>-coder` and `forge-<nsB>-coder` — no silent overwrite and no plain-id privilege for either; the dispatch gate (see 'The native subagent tool is the only dispatch surface') is the authority on which one a given session may call

#### Scenario: Materialized ids are host-history-independent

- **WHEN** the same two workspaces' pools are materialized on two hosts whose initialization orders are opposite (workspace A first on one host, workspace B first on the other)
- **THEN** every materialized agent id is identical across the two hosts — family namespaces never derive from arrival order, so crew plans, rosters, and muscle memory transfer between hosts

#### Scenario: A cross-family materialized-id collision resolves in path order

- **WHEN** two distinct pool files produce the same materialized id (e.g. one defines the id `aa-shader`, the other declares `"pool": "aa"` and defines `shader`)
- **THEN** the deterministic lexicographic file-path order decides: the earlier pool's agent materializes, the later pool's colliding agent is skipped with an error finding naming both files — identically on every host

#### Scenario: Pool deletion un-materializes

- **WHEN** a workspace's forge.json is deleted from disk and the plugin next resolves the roster
- **THEN** its agents disappear from the host's materialization set (no append-only residue) and sessions in that workspace fall back to the global layer if one exists

#### Scenario: Unknown session anchor keeps the fail-open belt

- **WHEN** a session calling the native `subagent` tool has a workspace that cannot be observed
- **THEN** the existing fail-open belt posture applies, with a disclosure that the session's pool ownership could not be established

### Requirement: Materialization as native subagents with a pinned model

The plugin SHALL materialize each configured namespaced pool worker as a `mode: subagent` agent `forge-<ns>-<id>` (every family namespaced — plain-id materialization no longer exists) that is visible to the host's native `subagent` tool vocabulary (discoverable by the model, excluded from the Tab cycle by its subagent mode), a prompt composed of the worker discipline wrapped around the role prompt, and a deny-style permission: `shape: "readonly"` — which MUST be explicit — denies the mutating file-tool family — `write`, `edit`, and the host's patch-family tools (`patch`, `applypatch`, `apply`, `multiedit`) — while the builtin shell stays available, matching the host's own read-only `explore` agent — and the host's code-mode entry (`execute`) stays denied for the readonly shape, because the builtin shell is reachable through it where the host enables full code mode; `shape: "write"` allows them, and an ABSENT `shape` field SHALL default to `write` (open permissions — readonly is a restriction the pool author must ask for explicitly, never a surprise default); an explicit `permission` map overrides the shape-derived default — and every namespaced worker SHALL deny the host's dispatch action — `subagent` in the host's current vocabulary, onto which the host normalizes an older `task` key — regardless, so recursive spawning stays physically impossible. A pinned entry's materialized agent SHALL carry the definition's pinned `model` (the brain is bound at materialization; a `model` passed on the native call does not unpin it — see 'Runtime model pin on v2 hosts'); an Auto entry's materialized agent SHALL carry no `model` key at all, deferring to the host's native spawn behavior — the parent session's current model binds at dispatch time (snapshot semantics: later primary model switches do not affect already-dispatched runs). The subagent-vocabulary description SHALL name the role and, for a pinned entry, the pinned brain; an Auto entry's description SHALL state that it inherits the parent session's model instead of claiming a pinned identity. Every description SHALL additionally name the agent's POOL PROVENANCE: its family namespace and origin forge.json path, and — for every family except the global fallback — that the agent is dispatchable only from sessions whose workspace pool is that file; the global fallback family’s description names the global layer as its origin and limits dispatchability to sessions without a workspace pool. The provenance line is static host-wide truth (per-family, not per-session): the dispatching model meets where an agent belongs before the dispatch gate is consulted. The worker discipline embedded in the prompt SHALL mandate workspace-relative paths only (never absolute paths outside the workspace), verbatim reporting of tool refusals instead of improvising workarounds, and conclusions carrying evidence references; readonly agents are additionally told to report rather than work around restrictions. Materialization SHALL be create-only: a user-defined entry of the same id is never touched. When the host disables the plugin, Forge SHALL make no runtime agent registrations, materializations or sync writes; existing generated files are independently host-loaded and SHALL remain untouched, as specified in forge-agent 'One-knob return to native' and 'Uninstall self-healing'. Agent-level disablement is not plugin disablement.

#### Scenario: Agent entries carry the pinned model

- **WHEN** the plugin loads with a forge.json defining `research: {model: "prov/x", thoughtLevel: "low"}` and the injected agent set is inspected
- **THEN** `forge-<ns>-research` is a subagent-mode agent whose `model` is exactly `prov/x`, listed for the native subagent tool, with a deny-style permission including the dispatch denial

#### Scenario: An Auto worker materializes without a model key

- **WHEN** the plugin loads with a forge.json defining `scout: {}` (no `model`, no `thoughtLevel`, no `shape`) and the injected agent set is inspected
- **THEN** `forge-<ns>-scout` is a subagent-mode agent with no `model` field, listed for the native subagent tool, with the same deny-style permission including the dispatch denial, a description that names inheritance rather than a pinned identity — and, defining no `shape`, OPEN write permissions (the absent-shape default)

#### Scenario: The materialized prompt embeds the discipline

- **WHEN** the composed prompt of a materialized agent is inspected
- **THEN** it contains the workspace-relative-path mandate and the verbatim-refusal-reporting mandate, wrapped around the agent's role prompt (explicit `prompt` overriding the built-in role default)

#### Scenario: The description carries pool provenance

- **WHEN** the subagent-vocabulary description of a workspace pool's materialized `forge-<ns>-coder` is inspected (on any host, in any session)
- **THEN** it names the namespace `<ns>`, the origin forge.json path of its family, and that it is dispatchable only from sessions whose workspace pool is that file; a global fallback family’s description instead names the global layer as its origin and applies only to sessions without a workspace pool — the same static text in every session

#### Scenario: The readonly deny face covers the patch family

- **WHEN** an agent with an EXPLICIT `shape: "readonly"` has its materialized permission enumerated
- **THEN** `patch`, `applypatch`, `apply`, and `multiedit` are denied alongside `write` and `edit` (the builtin shell is not part of the deny face), the code-mode entry stays denied, and dispatch stays denied for every shape. The draft-phase dispatch gate is stricter than this face (see 'Workers are not dispatched while a plan draft is active'): there a permission override that lifts a file-mutating tool out of `deny` disqualifies the readonly exemption, and so does a shell left available to the worker

#### Scenario: An absent shape defaults to open permissions

- **WHEN** a pool defines `ta-tool: {model: "prov/x"}` with NO `shape` field and the materialized permission is inspected
- **THEN** the mutating-tool family is not denied (open write permissions), dispatch stays denied — and the draft-phase recon exemption does NOT apply to this agent (the exemption keys on an explicitly readonly shape; a shape-less agent is not draft-exempt)

#### Scenario: A permission override keeps the recursion ban

- **WHEN** an agent sets `permission: {"shell": "deny"}` with `shape: "write"`
- **THEN** the materialized permission honors the override and still denies dispatch

#### Scenario: A user-defined agent entry is never clobbered

- **WHEN** the user has their own `agent["forge-<ns>-research"]` configuration
- **THEN** the plugin skips injection for that id and the user's entry stands

#### Scenario: The disable knob registers nothing

- **WHEN** the host's native plugin disable mechanism is applied to Forge and the host restarts
- **THEN** Forge registers no runtime subagents and makes no generated-file writes; any previously generated or hand-written Markdown remains separate host-managed agent data, and the plugin provides no runtime dispatch gates or model injections

### Requirement: Session directory resolved per session on multi-location hosts

On a host that loads several locations in one process, the plugin SHALL resolve every session's working directory from that session's OWN record — never from which location happened to initialize last. The plugin creates no child session of its own: the host places a native subagent child in its parent's directory, and the plugin SHALL resolve any plugin state it writes for such a child from the host's session record. A session without an in-memory binding (a fresh child, a session resumed after a host restart) SHALL be resolved through the host's session record — the session's own directory, else its parent's — before any fallback. A fallback to a plugin-level default directory SHALL be disclosed in the tool result. Everything keyed on the session's directory (plan / goal / crew records, the pool gate) SHALL land in the resolved directory. A command's working directory is not the plugin's to set: the host runs a native subagent child's builtin shell in the parent's directory, and any other session's in the session's own directory.

The same resolution SHALL hold wherever the plugin applies a rule that depends on a session's directory — inside tool bodies and in the checks that run before a tool call (the draft write ban, the dispatch gates, the state-file boundary) alike. No check SHALL bind a session to the directory that was initialized last. A check SHALL apply such a rule to a session that has no in-memory binding only on the strength of the host's session record — the session's own directory, else its parent's — resolved the way a tool body resolves it; a check that cannot read the record SHALL apply the rule to no directory at all and leave the decision to a check that can. Before a write-class tool of such a session executes, the draft write ban SHALL have been decided against the workspace the host's session record names, so that a draft in another location never refuses the call and a draft in the session's own workspace still does. When the record yields no directory, or cannot be read, the session SHALL stay unbound and every such check SHALL let the call through without consulting any record that depends on a directory: the plugin SHALL NOT guess a directory, and SHALL NOT put its default directory in place of the session's for a check. A binding written on behalf of a check SHALL be the directory the host's session record yielded. This holds whatever makes the session known first — a write-class call, a native `subagent` call the dispatch gates check, or a call that ends refused — and for a native subagent child the host created (no plugin binding at creation) like any other session.

#### Scenario: A fresh worker's first shell command runs in the owner's workspace

- **WHEN** a native subagent child of a session anchored to workspace A issues its first builtin shell call on a host whose last-initialized location is workspace B
- **THEN** the command runs under workspace A — the host creates the child in its parent's directory and runs the builtin shell there; no plugin `cwd:` line is involved, and a plugin state write for that child resolves under A

#### Scenario: A goal created from a session lands in that session's workspace

- **WHEN** a session anchored to workspace A creates a goal on a host whose last-initialized location is workspace B
- **THEN** the contract file is written under workspace A's `.opencode/goal/`

#### Scenario: A session resumed after a host restart is resolved from the host record

- **WHEN** a session with no in-memory binding makes its first forge call after a host restart, and the host's session record carries its directory
- **THEN** the session is bound to the directory in the host record, not to the last-initialized location

#### Scenario: A default-directory fallback is disclosed

- **WHEN** neither an in-memory binding nor the host's session record yields a directory, so the plugin falls back to its default directory
- **THEN** the tool result states that the default directory was used and names it

#### Scenario: A single-location host behaves exactly as before

- **WHEN** the host loads one location
- **THEN** every session resolves to the same directory as before this change

#### Scenario: A session's first call after a host restart is a write-class call

- **WHEN** a session that existed before a host restart makes its first tool call after the restart, that call is a write-class one, the host's session record carries workspace A for the session, and the host initialized location B after A
- **THEN** the session is bound to workspace A — never to B — and a following plugin call that depends on the session's directory (for example a goal write) resolves under A without any default-directory notice

#### Scenario: A fresh session's first call is a write-class call

- **WHEN** a session that acquired no binding when the host created it makes a write-class call as its first tool call, the host's session record carries workspace A for the session, and the host's last-initialized location is workspace B
- **THEN** the session is bound to workspace A, never to B, and a following plugin call that depends on the session's directory (for example a goal write) resolves under A

#### Scenario: A child the host created on its own is bound from its record on its first write-class call

- **WHEN** a child session created by the host's own subagent tool — no plugin binding at creation — makes a write-class call as its first tool call, the host's session record carries workspace A for the child, and the host's last-initialized location is workspace B
- **THEN** the child is bound to workspace A, never to B, and a following plugin call that depends on the session's directory (for example a goal write) resolves under A

#### Scenario: A refused dispatch leaves the caller bound to its own directory only

- **WHEN** a session with no in-memory binding calls the native `subagent` tool for a `forge-*` worker of another pool, the host's session record carries workspace A for the session, the host's last-initialized location is workspace B, and the call is refused before any child is created
- **THEN** the refusal stands, and every binding written for the session during that call names workspace A — never B

#### Scenario: A draft in another location does not refuse the session's write

- **WHEN** workspace B holds an active draft, workspace A holds none, and a session with no in-memory binding whose host record carries workspace A calls a write-class tool on a host whose last-initialized location is workspace B
- **THEN** the call is not refused on account of the draft in workspace B

#### Scenario: A draft in the session's own workspace is still honored

- **WHEN** workspace A holds an active draft, and a session with no in-memory binding whose host record carries workspace A calls a write-class tool (the host's builtin `shell`, for example — the plugin counts it write-class) on a host whose last-initialized location is workspace B
- **THEN** the call is denied exactly as it is for a session that was bound to workspace A all along, with the message naming `plan_approve` or discard

#### Scenario: No record and several locations: the session stays unbound and the call passes

- **WHEN** a session with no in-memory binding makes a write-class call, the host initialized more than one location, and the host's session record yields no directory for the session or any ancestor (or cannot be read)
- **THEN** no binding is written for the session, the call is not refused by any check that depends on a directory, and a later forge tool call resolves through the default-directory fallback and discloses it

#### Scenario: The state-file boundary resolves a relative path against the session's own directory

- **WHEN** a non-forge agent's session with no in-memory binding calls `write` or `edit` with a relative path, the host's session record carries workspace A for the session, and the host's last-initialized location is workspace B
- **THEN** the check resolves the path under workspace A: a path that lands in A's `.opencode/plan/` or `.opencode/goal/` is refused, and one that lands elsewhere under A is not refused by this check

#### Scenario: The state-file boundary has no base for a session it cannot place

- **WHEN** a non-forge agent's session with no in-memory binding calls `write` or `edit` with a relative path on a host that initialized more than one location, and the host's session record yields no directory for the session
- **THEN** the path is not resolved against any other directory: one that would land inside a state directory only when read from some particular working directory is not refused by this check, while one that names a state directory by its own spelling — it lands there from every working directory — is still refused, since that verdict needs no base directory

### Requirement: Built-in subagent override via the global recipe

Scaffold creation `SHALL` be explicit-only: the global forge.json
`SHALL` be drafted in-band by the forge agent on the user's explicit
ask — directly, or via the `/forge init global` lever (forge-commands)
— and the plugin `SHALL NOT` write that file uninvited. The scaffold
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
  (directly, or by running `/forge init global`) and no global
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


### Requirement: User-facing /forge command family

The plugin SHALL provide the `sync`, `init`, and `init global` routes of the single `/forge` command via typed arguments (see command-surface 'Single forge command surface'). The three routes SHALL be agent-instructing templates; the commands themselves SHALL NOT write files, and every write SHALL go through the in-band tools with transcript visibility. Before any of these routes starts its work, the plugin SHALL check the actual invoking agent identity, independently of the available tools. Only a verified forge primary may start these routes. Unknown identity, workers and other agents SHALL be redirected without starting route work or reading recipe files. The `stop` route SHALL be exempt from that guard; its command-execution and session-scoped stop semantics are defined in command-surface 'Session-scoped stop for native subagents'.

`sync` SHALL instruct the forge agent to invoke `forge_sync` immediately and report the diff; the staleness gate, in-band default and `sync:"auto"` opt-in remain unchanged. `init` SHALL draft the workspace forge.json in-band with the user (pool namespace, roles, shapes), refuse to overwrite an existing file and offer review instead. `init global` SHALL do likewise for the global forge.json, with commented General/Explore override entries inert until uncommented (see 'Built-in subagent override via the global recipe'). Both init routes SHALL require explicit user consent before any normal write. Unconfigured-crew refusal SHALL name these levers alongside the in-band drafting affordance.

#### Scenario: /forge sync forces an immediate sync

- **WHEN** the user runs `/forge sync` in a verified forge-primary session
- **THEN** the forge agent invokes forge_sync now and reports the created/updated/GC'd diff, and the default posture (staleness gate + in-band sync; `sync:"auto"` opt-in) is unchanged; unavailable or denied tools remain subject to normal permissions

#### Scenario: /forge init scaffolds the project recipe

- **WHEN** the user runs `/forge init` in a verified forge-primary workspace session with no forge.json
- **THEN** the forge agent drafts the recipe in-band with the user (pool namespace, roles, shapes), writes only on explicit consent and through the normal write path, and the file hot-applies and a crew retry passes for a valid authorized recipe
- **WHEN** a forge.json already exists
- **THEN** the command refuses to overwrite and offers a review of the existing recipe instead

#### Scenario: /forge init global scaffolds the global layer inert

- **WHEN** the user runs `/forge init global` in a verified forge-primary session with no global forge.json
- **THEN** the scaffold is drafted in-band with the General/Explore override entries in comment form, written only on explicit consent, and built-in behavior is unchanged until an entry is uncommented and filled

#### Scenario: The net still teaches the levers

- **WHEN** a session with no recipe hits the unconfigured-crew refusal
- **THEN** the refusal names both paths: the in-band ask (the agent drafts it on explicit go-ahead) and the `/forge init` levers

#### Scenario: Family guard holds

- **WHEN** a worker, non-forge session or session of unknown identity invokes `sync`, `init` or `init global`, even if `forge_sync` is visible
- **THEN** the command redirects to the forge primary before any route work or recipe read, and the same guard admits a verified forge primary independently of tool visibility (without overriding normal permissions)

#### Scenario: Stop is exempt from the command family guard

- **WHEN** a non-forge session runs `/forge stop`
- **THEN** the command performs the scope-checked stop and returns its receipt as specified in command-surface, without a family-guard redirect

## REMOVED Requirements

### Requirement: Task shadow surface (native name, forge engine)

- **Reason**: The plugin's own dispatch engine is retired; the host's native `subagent` tool is the only dispatch surface.
- **Migration**: Dispatch by calling the host's native `subagent` tool (see ADDED 'The native subagent tool is the only dispatch surface'). There is no synchronous dispatch and no `run_in_background` choice — native subagents always run in the background and report through the host's completion message.

### Requirement: Dispatch lifecycle (wake, cap, harvest)

- **Reason**: Every mechanism here belongs to the plugin's dispatch engine: its completion wake, progress notices, per-session concurrency cap and FIFO queue, sync wait budget, poller, and owner-death harvest. With native dispatch the host owns execution, completion notification, and restart resume.
- **Migration**: No cap, no queue, no sync wait: a native `subagent` call returns a session id at once and the host delivers a `<background-result kind="subagent">` message when the child goes idle. How many subagents run at once is the model's and the user's decision.

### Requirement: Dispatch resilience (stale reap, retry, restart recovery)

- **Reason**: Stale reaping, automatic respawn, and journal-driven restart recovery re-implement lifecycle management the host performs for its own subagent jobs.
- **Migration**: The host resumes interrupted subagent jobs on its next start. No automatic retry: a failed child's error reaches the parent in the host's completion message and the parent decides whether to re-dispatch. The workspace dispatch journal (`.opencode/forge/dispatch-log.jsonl`) is no longer written; an existing file is inert.

### Requirement: Dispatch outcome honesty on result-stream loss

- **Reason**: The stream-lost/unknown classification exists because the engine read the child's result through a synchronous view it could not trust. The host reports its own subagent outcomes.
- **Migration**: None; the host's completion message carries the child's final message, or its error or interruption.

### Requirement: Ledger completeness across outcome classes

- **Reason**: The ledger recorded the engine's own outcome classes, including `stream-lost/unknown`.
- **Migration**: None; the host's session record carries each child's outcome.

### Requirement: Report-file delivery contract

- **Reason**: Report files compensated for the primary's view of a dispatch being lost — a failure mode of the retired engine.
- **Migration**: A child's final report is the host's completion message. A caller that wants a durable artifact asks the worker to write one in its prompt.

### Requirement: Sync wait-budget expiry presented as a notice

- **Reason**: There is no synchronous dispatch and therefore no wait budget.
- **Migration**: None.

### Requirement: Genuine dispatch failures keep error presentation

- **Reason**: The engine's sync error channel is retired with it.
- **Migration**: A refused dispatch surfaces as the native `subagent` tool's own error (the host's, or the permission belt's refusal).

### Requirement: Budget-expiry notice carries retrieval pointers

- **Reason**: There is no budget-expiry notice without a wait budget.
- **Migration**: None.

### Requirement: Active-textful completion override

- **Reason**: The override corrected the engine's own status view; the host's completion signal needs no correction.
- **Migration**: None.

### Requirement: Nested-dispatch tool guard on non-forge child sessions

- **Reason**: The guard was set in the engine's child-creation body. Native children are created by the host, and the host's depth limit (`experimental.subagent_depth`, default 1) already stops a child from dispatching further.
- **Migration**: None; the host's depth limit covers every native child.

### Requirement: Provider-dimension dispatch gate and circuit breaker

- **Reason**: The gate and breaker were fed by the engine's own terminal-recording seam; the `dispatch` configuration node configured them.
- **Migration**: Remove the `dispatch` node from forge.json; an existing node is ignored with a finding. No per-provider limit or breaker is enforced.

### Requirement: Agent-bound child creation with pre-spawn validation

- **Reason**: Child creation is the host's: the native `subagent` tool resolves the agent, refuses an unknown or primary-mode agent, and binds the agent's configured model.
- **Migration**: None; the pinned model reaches the child through the materialized agent's `model` field.

### Requirement: Host-signal completion detection

- **Reason**: The host delivers its own subagent completion; no plugin polling, reconcile pass, or re-subscription exists.
- **Migration**: None.

### Requirement: Persisted dispatch registry with post-reload adoption

- **Reason**: No plugin-owned dispatch rows exist to persist or adopt.
- **Migration**: None; the host resumes its own subagent jobs after a restart.

### Requirement: Orphan-child disclosure

- **Reason**: Orphans arose from gaps in the engine's own registry. Native children are the host's and stay visible in the host's session tree.
- **Migration**: None.

### Requirement: Dispatch rows survive plugin-instance disposal

- **Reason**: No dispatch rows exist.
- **Migration**: None; native children are unaffected by a plugin reload by construction.

### Requirement: Honest aborted outcome surfacing

- **Reason**: It governed the engine's journal and wake wording for rows it killed.
- **Migration**: `/forge stop` reports what it did per child (see command-surface 'Session-scoped stop for native subagents'); the host records each child's outcome.

### Requirement: Abort effectiveness on the v2 session client

- **Reason**: The engine's kill path is retired; `/forge stop` uses the host's `session.interrupt`, whose result it reports.
- **Migration**: See command-surface 'Session-scoped stop for native subagents'.

### Requirement: User-facing dispatch cancellation (in-flight and queued)

- **Reason**: The lever cancelled the engine's in-flight and queued dispatches; native dispatch has no queue and no plugin-owned rows.
- **Migration**: See command-surface 'Session-scoped stop for native subagents': `/forge stop` interrupts this session's native subagents and terminates the background commands they left behind.

### Requirement: Progress-notice freshness

- **Reason**: The notices it governed were the engine's own.
- **Migration**: None; the host delivers its subagent progress and completion itself.
