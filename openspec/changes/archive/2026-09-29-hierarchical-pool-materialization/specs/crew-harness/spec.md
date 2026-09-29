## MODIFIED Requirements

### Requirement: /crew command discipline

The plugin SHALL register a `/crew <objective>` command that enters crew orchestration discipline in the current session (single-subject: no agent switching). The discipline SHALL mandate: after any needed reconnaissance, decompose the objective into subtasks and REGISTER the plan via `crew_begin {objective, subtasks}` — each subtask carrying a title and, optionally, the intended `forge-*` agent and an acceptance-evidence statement. Registration enters a **PENDING** crew and the session SHALL stop and present the execution-mode choice — begin supervised waves now, convert the objective into an autonomous goal contract, or stand by — ending the turn; execution SHALL start only after the user's decision arms the crew via a follow-up `crew_begin {execution}` call. The `/crew` command template's roster section SHALL group the dispatchable agents by pool with each pool's origin path, the primary anchor's root pool marked. The registration output SHALL disclose the origin of the dispatchable roster grouped the same way — every pool's forge.json path, the primary root pool marked — and whenever the residual workspace-mismatch disclosure fires (the session's workspace carries a forge.json that NO anchor's ancestor chain or subtree covers, so its roles are undispatchable on this host), it SHALL pair that disclosure with the remediation: those roles enter the dispatch vocabulary once an anchor covering them exists (a host initialization in that workspace) or through the true global file for cross-host pools. Where the discipline or the unconfigured guidance teaches the session AI how to write a forge.json on the user's explicit go-ahead, it SHALL additionally propose a short, stable `pool` namespace for the file and include the field (directory-name-independent agent ids). Once armed for waves, execute the plan in waves of parallel native `task` calls (a wave's results return within the calling turn; the next wave launches only after the previous wave's results are in — never flooding); when a subtask calls for a role that no configured agent matches, execute that subtask through a native task call and surface the gap to the user with a suggestion to configure the missing role; verify each subtask's evidence from the task results; retry a failed subtask at most once (adjusted prompt or agent); finish with a completion report covering every declared subtask. The crew discipline is source-agnostic about the macro contract above it — an approved plan artifact, a spec change document, or inline objective text all feed the same discipline, and crew never requires a plan artifact to exist. An active plan draft SHALL refuse `/crew` with a pointer to `plan_approve` or `/plan discard` (mutual-exclusion safety interop, not an ordering dependency); a session with an active crew SHALL refuse a second concurrent `/crew`; argument-less `/crew` SHALL print usage. Crew state is in-memory and session-bound: on host restart it dies honestly and a new `/crew` starts fresh — there is no cross-session crew resume in this capability.

#### Scenario: /crew decomposes and paces waves on briefs

- **WHEN** the user runs `/crew` with an objective and the model follows the discipline
- **THEN** the subtask plan is registered through `crew_begin`, subtasks execute as parallel native `task`-call waves, and a later wave launches only after the previous wave's results have returned in-turn

#### Scenario: Missing role falls back to native with an explicit notice

- **WHEN** a declared subtask needs a role that no configured `forge-*` agent matches
- **THEN** the discipline directs the model to run that subtask through a native task call and to tell the user about the gap, suggesting the missing role be configured

#### Scenario: Registration pauses for the execution-mode decision

- **WHEN** `crew_begin` registers the subtask plan and the roster is confirmed
- **THEN** the session presents the execution-mode choice (supervised waves / goal conversion / standby) and ends the turn — no `task` dispatch happens before the user's decision

#### Scenario: Host pool origin is disclosed

- **WHEN** the host materializes multiple pools (a primary root pool plus namespaced sub-pools or other anchors' pools), or a single pool
- **THEN** the `/crew` template's roster and the `crew_begin` registration output list the agents grouped by pool, each group carrying its forge.json origin path, the primary root pool marked — and the residual mismatch disclosure (a session-workspace forge.json no anchor covers) still pairs with its remediation lines

#### Scenario: AI-assisted forge.json creation proposes a pool namespace

- **WHEN** the session AI writes a forge.json on the user's explicit go-ahead (unconfigured-host guidance or missing-role configuration)
- **THEN** the written file includes a proposed short, stable `pool` namespace (e.g. `"aa"` for the devAa specialist pool), keeping the materialized agent ids independent of directory renames

#### Scenario: Registered plan lands as an inspectable record

- **WHEN** `crew_begin` registers the subtask plan
- **THEN** the declared plan is written to a record file under the session workspace's `.opencode/crew/` directory, arm / convert / abandon / close append to it, and the record never resumes a dead crew — after host restart it is inert history

#### Scenario: Planless crew runs the same discipline

- **WHEN** `/crew` is invoked with the macro contract sourced from a spec change document or inline text instead of a plan artifact
- **THEN** the discipline is identical — no plan dependency exists, and no surface of the crew flow assumes plan precedence

#### Scenario: Draft plan blocks /crew

- **WHEN** the session has an active draft plan and `/crew` is invoked
- **THEN** the command refuses with a pointer to `plan_approve` or `/plan discard`

#### Scenario: One crew per session

- **WHEN** a crew is already active in the session and `/crew` is invoked again
- **THEN** the command refuses, naming the active crew

#### Scenario: Restart mid-crew is an honest death

- **WHEN** the host restarts while a crew run is active
- **THEN** crew state is gone after restart and a new `/crew` starts fresh — no residue, no resume

### Requirement: Unconfigured crew initialization gate

When `/crew` is invoked and the pool-resolved agent set across the whole anchor set is empty (zero pools materialized), the command SHALL refuse entry into crew orchestration (hard gate) and SHALL present initialization guidance stating: the two configuration layer paths (global `~/.config/opencode/forge.json` and the nearest project `.opencode/forge.json` discovered by walking up from the workspace — both layers MERGE, the project layer overriding the global one per agent id; on a host with multiple anchors, sub-pool `.opencode/forge.json` files in each anchor's subtree contribute additional families, and the two axes are distinct — pools follow host directories, session artifacts follow the session), a copy-paste JSONC agent template embedded in the command's discipline text, and the choice between configuring it themselves or having the session AI do so — where AI-assisted configuration SHALL happen only after the user's explicit go-ahead in that conversation, through the normally-visible write path. The guidance — template example AND prose — SHALL disclose the optional per-agent `prompt` field: an explicit prompt fully overrides the built-in role, only the ids `research` and `review` carry built-ins, and any other id without a prompt gets a generic one-liner (it will not know its job). The guidance SHALL also state the id naming rule: ids are plain role words WITHOUT the `forge-` prefix, which the plugin adds at materialization (a prefixed id is auto-stripped with a warning). When the session AI writes the configuration on the user's go-ahead, it SHALL name ids as plain role words, SHALL give every agent a SHORT prompt derived from the role the user asked for — one or two sentences the user can trim or extend — SHALL write a long prompt only when the user explicitly asks for that agent, and SHALL include a proposed short, stable `pool` namespace for the file (a `[a-z0-9-]` word of at most 24 characters, independent of the directory name) so the materialized agent ids survive directory renames. The guidance SHALL also state the application timing: file edits, creations, and deletions hot-apply through the next config hook — no host restart is required for pool or layer changes — and only the anchor set itself is fixed at host start (re-initializations add anchors and pools; they never remove them). The gate SHALL anchor its guidance on the calling session's effective worktree where one is observable (walking up from it for the project layer), falling back to the host launch directory; and when the session's anchor discovers a usable project `.opencode/forge.json` that NO anchor of this host covers (the residual mismatch case), the gate output SHALL say so explicitly — naming the discovered file and directing the user to a host initialization in that workspace (which adds its anchor and family to the host's set) or to moving the agents into the global layer — instead of claiming the feature is unconfigured. The same disclosure SHALL apply on a successful `crew_begin` whose session-anchored discovery found a forge.json the host did not materialize. The plugin itself SHALL never write or create the file. This invitation surface SHALL exist only inside the unconfigured `/crew` flow — no other plugin surface (tool description, agent prompt, error path) SHALL invite AI-authored configuration.

#### Scenario: Unconfigured /crew refuses with initialization guidance

- **WHEN** `/crew <objective>` is invoked and zero pools are materialized across the whole anchor set
- **THEN** entry into orchestration is refused and the response names the two layer paths with the merge rule (project overrides global per agent), shows the embedded template — including the optional per-agent `prompt` field — offers the self-configure or AI-assisted options with the consent rule, states the hot-apply timing (file changes apply at the next config hook; only the anchor set is fixed at host start), and carries the two-axis note (pools follow host directories, session artifacts follow the session)

#### Scenario: AI-assisted configuration writes short role prompts

- **WHEN** the user explicitly asks the session AI to configure forge.json in that conversation
- **THEN** every agent the AI writes carries a SHORT prompt derived from the role the user asked for (one or two sentences), unless the user explicitly asked for a longer prompt on that agent — ids are named as plain role words without the `forge-` prefix, the file includes a proposed short stable `pool` namespace, and the consent rule (never write forge.json without the explicit go-ahead) still governs the write itself

#### Scenario: A workspace file the host cannot see is disclosed, not masked

- **WHEN** zero pools (or none covering them) are materialized but the calling session's anchor discovers a usable project `.opencode/forge.json` that no host anchor covers
- **THEN** the gate output names that file and states that this host has no anchor covering it — directing the user to a host initialization in that workspace or to add the agents to the global layer — rather than reporting the feature as unconfigured

#### Scenario: The configuration invitation lives only in the /crew gate

- **WHEN** any other plugin surface is inspected (tool descriptions, materialized agent prompts, error paths)
- **THEN** no surface invites the session AI to author forge.json — the everyday dispatch path stays configuration-silent

#### Scenario: A configured crew bypasses the gate

- **WHEN** `/crew <objective>` is invoked and at least one pool materialized successfully
- **THEN** the gate does not fire and orchestration discipline proceeds normally; if the session's own discovery additionally found a forge.json no host anchor covers, the crew_begin output carries that disclosure alongside the registration summary
