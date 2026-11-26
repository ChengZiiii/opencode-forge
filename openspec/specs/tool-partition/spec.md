# tool-partition Specification

## Purpose
Govern Forge harness access and state boundaries without partitioning native execution: all agents use host-native shell and dispatch, while the fifteen harness state/sync tools remain forge-primary-only and Plan/Goal state-file writes remain tool-mediated. Family-gated system injections and draft write bans coexist with native search availability and session/target dispatch gates; the plugin does not rewrite unrelated agents' tools or permissions.

## Requirements

### Requirement: Forge system injections are family-gated

All forge-authored system-prompt injections (plan/goal/crew notices, the compaction goal brief) SHALL be gated on the session's agent belonging to the forge family, resolved from a session-to-agent mapping built from the host's per-request agent signal; when the agent is unknown the injection SHALL be skipped. The suppression of the host's post-compaction auto-continue SHALL follow the same gate: it applies only while the session's current agent belongs to the forge family. Non-forge sessions SHALL carry no forge-authored system text.

#### Scenario: A build session's system prompt carries no forge text

- **WHEN** the native build agent answers in its own session
- **THEN** the system prompt contains no forge-authored notices or guidance

#### Scenario: A forge session keeps the full injection set

- **WHEN** a forge-family session builds its system prompt while a plan and a goal are live
- **THEN** the session receives the plan/goal notices exactly as before this capability existed

#### Scenario: Compaction auto-continue suppression follows the agent family

- **WHEN** a goal-owning session is currently driven by a non-forge agent and a compaction completes
- **THEN** the host's synthetic auto-continue behaves natively (not suppressed), while the goal loop itself stays parked per the continuation rule

### Requirement: Forge command entries redirect non-forge sessions

The plugin-authored /plan, /goal, and /crew command templates SHALL carry a fail-fast guard: the command execution SHALL resolve the actual invoking agent independently of tool visibility. Only the forge primary enters; a worker, non-forge agent or unknown identity SHALL be redirected before any discipline prompt or work is initiated. The guard SHALL NOT infer identity from visibility of plan_write, goal_write or crew_begin. The command SHALL stop immediately, tell the user to switch to the forge agent and rerun the command there, and perform no step of the discipline (no reconnaissance, no file operations, no model tool calls to establish identity).

#### Scenario: /plan under a non-forge agent redirects

- **WHEN** the user runs /plan while the native build agent is selected
- **THEN** the model stops at the guard, reports the redirect to forge, and performs no reconnaissance or file operations

#### Scenario: /goal and /crew under non-forge agents redirect

- **WHEN** the user runs /goal or /crew in a session of a non-forge agent
- **THEN** the model stops at the guard with the same redirect and nothing of the goal or crew discipline is initiated

#### Scenario: Tool visibility does not determine command identity

- **WHEN** a non-forge agent can see an entry tool or a forge primary has a user permission restricting it
- **THEN** the former redirects before discipline starts and the latter remains subject to normal permission, not misidentified

### Requirement: The goal loop never continues under a non-forge agent

When the goal continuation engine fires for a session whose current agent resolves to a non-forge agent, the engine SHALL skip that continuation round without recording a turn: the goal stays active, the budget is unchanged, and the loop resumes on the next forge-family turn.

#### Scenario: An agent switch parks the loop

- **WHEN** the user switches a goal-owning session to a non-forge agent and the session goes idle
- **THEN** no continuation prompt is sent to the non-forge agent and the goal's turn budget is unchanged

### Requirement: Forge family executes on the host's builtin shell

The plugin SHALL register no command-execution tool of its own. For every
agent — the forge primary, every `forge-*` worker, and every non-forge
agent — the host's builtin shell tool SHALL be the only exec surface (each
agent's own permission face still applies): the plugin SHALL NOT hide it,
SHALL NOT push a deny of it onto any agent record, SHALL NOT refuse a call
of it, and SHALL offer no option that hides it or restores a plugin exec
surface. Two things are not the plugin's doing and are not covered by
that: a deny the user's config or a worker's recipe states explicitly is
compiled as written, and the plan draft's session-scoped write ban denies
the builtin shell like every write-class tool (plan-harness 'Hard write ban
during draft'). Worker shape semantics SHALL govern everything except the
shell: a worker with an explicit `shape: "readonly"` SHALL keep the
mutating tool family (write/edit/patch) denied while keeping the builtin
shell available (the host's shipped `explore` agent makes the same
choice), with no plugin-side command classification; an absent shape
(write, the default) leaves the
shell available as well. The plugin SHALL NOT alter the builtin shell's
environment, working directory, or permission posture; where a worker runs
is the host's business (the host creates a native subagent child in its
parent's directory — forge-subagents 'Session directory resolved per
session on multi-location hosts'). Harness state tools (the plan_*/goal_*/
crew_* families and `forge_sync`) SHALL be primary-only: every `forge-*`
worker's compiled permission face SHALL deny them, so the host offers the
worker none of them, and a call that reaches the plugin anyway SHALL be
refused by the plugin's tool-execute interception belt with the
primary-only guidance. A worker SHALL carry no plugin-registered tool of
its own.

#### Scenario: No plugin exec tool is registered

- **WHEN** the plugin loads under any configuration
- **THEN** the host's tool registry holds no `forge_shell` or `forge_jobs`, and no option brings either back

#### Scenario: A write-shape forge subagent executes on the builtin shell

- **WHEN** a `forge-*` worker of write shape (explicit, or by the absent-shape default) whose recipe does not deny the shell runs a command
- **THEN** its tool face turns no shell tool off on account of its shape and the command executes through the host's builtin shell

#### Scenario: A readonly worker keeps the shell and loses the mutating tools

- **WHEN** an explicit-readonly `forge-*` worker whose recipe does not deny the shell runs a read-only inspection command and then attempts a file write
- **THEN** the shell command executes without any plugin classification, and the write-class tool is denied by the shape's tool face

#### Scenario: A worker's builtin shell call is never refused by the plugin

- **WHEN** a `forge-*` worker session calls the builtin shell, the session has no active plan draft, and neither the worker's recipe nor the user's config denies the shell
- **THEN** the call is decided by the host's own permission flow alone — the plugin injects no deny rule, pushes no deny onto the worker's face, and adds no fallback refusal or rescue for the builtin shell

#### Scenario: The model surface offers the builtin shell to every agent

- **WHEN** a session of any agent — the forge primary, a `forge-*` worker, a non-forge agent — assembles its model-facing tool list, and no recipe or user config denies that agent the shell
- **THEN** the builtin shell tool is present and carries no deny the plugin added on its own

#### Scenario: A forge worker is offered no harness tool

- **WHEN** a `forge-*` worker's compiled permission face and toolset are inspected
- **THEN** every harness state tool is denied on the face and absent from the toolset, and a call of one that reaches the plugin anyway is refused with the primary-only guidance

#### Scenario: A crew wave runs on the builtin shell

- **WHEN** a /crew orchestration makes native `subagent` calls for `forge-*` workers
- **THEN** the workers execute commands through the host's builtin shell

#### Scenario: The builtin shell stays host-native

- **WHEN** any forge-family session runs a command through the builtin shell
- **THEN** the environment, working directory, timeout, and permission handling are the host's own; the plugin sets none of them and classifies no command

### Requirement: Non-forge agents are isolated from the forge harness

Every agent other than the forge family — the native build, plan, general, and explore agents, and every user-defined agent — SHALL be kept off the plugin's harness state tools (crew_begin, crew_close, `forge_sync`, and the plan_*/goal_* families): a call of one from such an agent SHALL be refused by the plugin's tool-execute interception belt before the tool executes, with the partition guidance naming the forge agent as the way in, and nothing of the plan/goal/crew state SHALL change. Nothing else is partitioned. The plugin's search override rides the builtin `grep` / `glob` tools and is available to every agent; the builtin shell is every agent's exec surface; and dispatch is not partitioned either — a non-forge agent may dispatch a `forge-*` worker through the native `subagent` tool under the same session-keyed gates as the forge primary (forge-subagents 'Dispatch gates enforced on the native subagent tool'), and no gate SHALL refuse a call because of who the calling agent is. Forge state files are boundary-protected: a non-forge session's attempt to write into `.opencode/plan/` or `.opencode/goal/` SHALL be refused at the tool layer, while reading them stays unrestricted. Tool partition SHALL NOT write any of these permission or tool fields into an agent record that is not its own; existing configurable primary-picker hiding is independent and retained (forge-agent v2 single-agent surface). The plugin SHALL NOT write any of this tool partition into an agent record that is not its own: a user-defined agent's fields are never touched, and the refusal alone is the guarantee there. Native agents absent from the user's config need no record of the plugin's — the refusal is keyed on the session's agent, not on a config entry.

#### Scenario: A non-forge session's harness tool call is refused

- **WHEN** the native build agent calls a harness state tool such as goal_write
- **THEN** the call is refused with the partition guidance before the tool executes, and the goal state is unchanged

#### Scenario: The search override and the shell are open to every agent

- **WHEN** the native build agent assembles its toolset and the user's own configuration denies none of the three
- **THEN** `grep` and `glob` carry the plugin's override and the builtin shell is available; the plugin has pushed no deny for any of the three onto that agent

#### Scenario: A non-forge dispatch of a forge worker flows

- **WHEN** the native build agent calls the native `subagent` tool for a `forge-*` worker of the session's own workspace pool
- **THEN** the call is admitted exactly as the same call from the forge primary would be, and the host creates the child

#### Scenario: A non-forge write into forge state files is refused

- **WHEN** the native build agent attempts to write or edit a file under `.opencode/plan/` or `.opencode/goal/`
- **THEN** the call is refused with an error naming the forge state boundary, and the file is unchanged

#### Scenario: A native child of a non-forge session inherits the isolation

- **WHEN** a non-forge agent dispatches a child through the native `subagent` tool with the `general` agent
- **THEN** a harness state tool call from that child is refused the same way

#### Scenario: A user-defined agent's fields are never touched

- **WHEN** the user defines their own agent in config and the plugin loads
- **THEN** no field of that entry is changed; a harness tool call from it is refused by the belt, and everything else about the agent stands as the user wrote it

### Requirement: Draft safety interop reaches every agent in the session

While a session has an active plan draft, the draft-phase write ban SHALL remain session-scoped: write-class tool calls — the host's builtin `shell` included — are denied for every agent in that session, including non-forge agents, because the draft protects shared session state. The dispatch shape exemption SHALL follow the same session scope and the plan harness's semantics: a native `subagent` call whose target is a `forge-*` worker of effective readonly shape passes during draft regardless of the speaking agent, while every other call — a write-shape worker, a readonly worker that keeps the shell, a non-forge agent — stays denied, exactly as plan-harness 'Hard write ban during draft' defines. A non-forge turn gains exactly that from the exemption — a reconnaissance dispatch under the session-keyed gates — and no write and no other dispatch. Denials SHALL name the way out (plan_approve, or /plan discard). This remains the one deliberate forge constraint that reaches non-forge turns: passive protection of shared state — forge SHALL never actively drive a non-forge turn.

#### Scenario: A non-forge agent is write-blocked during an active draft

- **WHEN** the user switches a draft-bound session to the build agent and it attempts a write
- **THEN** the write is denied with guidance naming plan approval via forge or /plan discard, and the draft is untouched

#### Scenario: A non-forge turn gains one reconnaissance dispatch and nothing else

- **WHEN** a draft-bound session is driven by a non-forge agent that makes native `subagent` calls for `forge-<ns>-research` (effective readonly, its recipe denying the shell) and for `general`
- **THEN** the forge-* target passes as a reconnaissance dispatch under the session-keyed gates, and the `general` target is refused by the draft's dispatch ban
