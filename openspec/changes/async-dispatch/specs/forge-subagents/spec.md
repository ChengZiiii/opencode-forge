# spec.md delta — forge-subagents

## REMOVED Requirements

### Requirement: Native-task dispatch surface

The prohibition reading "The plugin SHALL NOT register any dispatch tool:
no `forge_dispatch` ... forge subagents are spawned through the host's
native `task` tool ..." is removed. Native task REMAINS a valid dispatch
surface with unchanged semantics, but it is no longer the only one; the
forge_dispatch surface requirement below replaces this requirement.

## ADDED Requirements

### Requirement: forge_dispatch surface (SDK child sessions)

The plugin SHALL register a `forge_dispatch` tool on v1 hosts (removed
with all forge tools under the agent disable knob) that dispatches a
materialized forge subagent by creating a REAL child session on the SAME
host server via the SDK (`client.session.create` with `parentID` set to
the dispatching session, the materialized agent id, the session directory
of the parent, and the question tool denied session-wide — a child can
never block on human input), so the child renders in the host UI with
native subagent affordances (session tree, progress, user abort). The
tool SHALL take `mode: "wait" | "async"` decided by the calling model at
dispatch time; BOTH modes accept every materialized shape (write workers
included — write authority is the materialized permission map, not a
mode gate). A pending permission ask that no one answers degrades to the
honest poll-timeout finding. `wait` mode SHALL poll the child session to
a terminal state and return the child's final assistant message (plus
agent identity and session id). Dispatch gates SHALL match the
native-task surface exactly: the session-domain pool gate (cross-pool
target refused with the `not dispatchable from this session` finding and
its exits), the crew pending belt and pool-compliance gates, the
primary-only rule (a forge-* worker calling forge_dispatch is refused as
a STATE tool call), and the plan-draft interop exemption (during an
active draft, a dispatch to an effective-readonly target passes as a
reconnaissance dispatch in either mode; any write-shape target is
refused by the same write-class deny as native task, in either mode).

#### Scenario: wait dispatch returns the child's final message

- **WHEN** the model calls `forge_dispatch {subagent_type: "forge-plugindev-spec-reviewer", prompt: ..., mode: "wait"}`
- **THEN** a child session is created on the host server with `parentID` linking it to the dispatching session (visible in the host session tree), the child runs the materialized agent, and the tool returns after the child's turn reaches a terminal state with the child's final assistant message, the agent identity, and the child session id

#### Scenario: async dispatch accepts every shape and never blocks on questions

- **WHEN** the model calls `forge_dispatch` with `mode: "async"` targeting a write-shape agent
- **THEN** the call returns a task handle immediately — write authority is the target's materialized permission map — and the child session is created with the question tool denied session-wide, so an in-flight child that needs human input proceeds without asking and reports honestly rather than blocking

#### Scenario: Cross-pool target refused identically to native task

- **WHEN** a forge_dispatch targets an agent whose pool belongs to another workspace
- **THEN** the call is refused with the same finding as the native-task path — target origin pool path, `not dispatchable from this session`, and the three exits

#### Scenario: Workers cannot dispatch

- **WHEN** a forge-* worker session calls forge_dispatch
- **THEN** the call is refused under the same primary-only rule as STATE tools

#### Scenario: Draft-plan interop is shape-gated as on native task

- **WHEN** the dispatching session has an active draft plan
- **THEN** a dispatch to an effective-readonly target passes as a reconnaissance dispatch in either mode, and a write-shape target is refused with roster guidance in either mode — identical outcomes to the native-task path

#### Scenario: Disable knob removes the tool

- **WHEN** `agent["forge"].disable` is set
- **THEN** forge_dispatch is not registered, alongside all other forge tools

### Requirement: Async dispatch lifecycle

An async dispatch SHALL return a task handle immediately (task id, agent
identity, child session id once known) and SHALL deliver at most ONE
completion wake into the dispatching session carrying the child's final
assistant message, following the job-supervisor completion-wake
discipline (idle-only injection, delivery window with ledger overflow,
no duplicate wake after a read). The plugin SHALL cap concurrent running
async dispatches PER SESSION (default 3): a dispatch beyond the cap SHALL
be refused with in-flight task ids and guidance. When a dispatching
session ends, its live async dispatches SHALL be aborted (child session
abort via the SDK) and recorded in the diagnostics ledger. A `wait`
dispatch whose child never reaches a terminal state within the poll
timeout SHALL return an honest timeout finding naming the child session
id (the child remains a real session the user can inspect or abort
natively in the TUI).

#### Scenario: Async handle and single completion wake

- **WHEN** the model calls forge_dispatch with `mode: "async"` on a readonly target and the owning session later idles
- **THEN** the call returns a handle immediately (task id, agent, child session id), the child completes in the background, and exactly one wake message containing the child's final assistant message is injected into the session

#### Scenario: Concurrency cap

- **WHEN** a session already has the cap of async dispatches in flight and calls forge_dispatch `mode: "async"` again
- **THEN** the call is refused with the in-flight task ids and guidance to wait or use `mode: "wait"`

#### Scenario: Owner death harvests children

- **WHEN** a session with live async dispatches is deleted
- **THEN** each child session is aborted via the SDK and the orphan is recorded in the diagnostics ledger

#### Scenario: Wait-mode timeout is honest

- **WHEN** a `wait` dispatch's child session does not reach a terminal state within the poll timeout
- **THEN** the tool returns a timeout finding naming the child session id rather than hanging, and the child session remains inspectable and abortable in the host UI
