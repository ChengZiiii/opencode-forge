# spec.md delta — forge-subagents

## REMOVED Requirements

### Requirement: forge_dispatch surface (SDK child sessions)

Superseded by the task-shadow surface: the dedicated `forge_dispatch`
tool is retired; the dispatch implementation now ships under the native
`task` name (see the ADDED requirement below). All its guarantees
(SDK parentID child sessions, question-deny on async, gate parity)
carry into the new requirement.

### Requirement: Async dispatch lifecycle

Superseded by the dispatch lifecycle requirement below; the wake
discipline, per-session cap, owner-death harvest, and honest timeout all
carry over unchanged, now attached to the `task` surface.

## ADDED Requirements

### Requirement: Task shadow surface (native name, forge engine)

The plugin SHALL register its dispatch implementation under the tool
name `task`, shadowing the native task tool host-wide, so the TUI drives
its native task rendering (the live subagent panel) for forge dispatches.
The tool SHALL accept `description`, `prompt`, `subagent_type`, and
`run_in_background` and SHALL dispatch ANY materialized target agent via
SDK child sessions (`client.session.create` with `parentID`, the target
agent id, the parent's session directory, and the native-parity title):
forge-* targets pass the forge dispatch gates (session-domain pool gate
with the `not dispatchable from this session` finding, crew pending and
pool-compliance belts); non-forge host targets dispatch through the same
engine without the forge pool gate. Child sessions carry tool-part
metadata mirroring the native shape (`agent`, `sessionId`, `taskId`,
`run_in_background`, `description`, `prompt`). Question policy is
mode-keyed: sync dispatches keep questions available (native parity);
async (`run_in_background: true`) dispatches create the child with the
question tool denied session-wide. Sync dispatches SHALL abort the child
when the dispatching turn is aborted; async children survive turn aborts
and die at session death. The `forge_dispatch` tool SHALL NOT be
registered.

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

### Requirement: Dispatch lifecycle (wake, cap, harvest)

The async dispatch lifecycle carries over from async-dispatch unchanged
and now attaches to the `task` surface: `run_in_background: true` SHALL
return a task handle immediately (task id, agent identity, child session
id) and deliver at most ONE completion wake carrying the child's final
assistant message (bounded 2500-character tail) following the
job-supervisor completion-wake discipline (idle-only injection,
at-most-once, delivery window with ledger overflow). The plugin SHALL
cap concurrent running async dispatches per session (default 3) and
refuse beyond the cap with in-flight task ids and guidance. When a
dispatching session ends, its live async dispatches SHALL be aborted and
recorded in the diagnostics ledger. A sync dispatch whose child never
reaches a terminal state within the poll timeout SHALL return an honest
timeout finding naming the child session id (natively inspectable and
abortable). The plan-draft interop is unchanged: during an active draft,
a dispatch to an effective-readonly forge target passes as a
reconnaissance dispatch in either mode, and write targets are refused by
the same write-class deny as before, in either mode.

#### Scenario: Async handle and single completion wake

- **WHEN** the model dispatches `task` with `run_in_background: true` and the owning session later idles
- **THEN** the call returns a handle immediately and exactly one wake message with the child's final message is injected into the session

#### Scenario: Concurrency cap

- **WHEN** a session already has the cap of async dispatches in flight and dispatches async again
- **THEN** the call is refused with the in-flight task ids and guidance

#### Scenario: Owner death harvests children

- **WHEN** a session with live async dispatches is deleted
- **THEN** each child session is aborted via the SDK and the orphan is recorded in the diagnostics ledger

#### Scenario: Sync timeout is honest

- **WHEN** a sync dispatch's child does not reach a terminal state within the poll timeout
- **THEN** the tool returns a timeout finding naming the child session id rather than hanging

#### Scenario: Draft interop unchanged

- **WHEN** the dispatching session has an active draft plan
- **THEN** an effective-readonly forge target passes in either mode and write targets are refused in either mode — identical outcomes to the pre-shadow gates
