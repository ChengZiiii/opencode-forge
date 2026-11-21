# fix-v2-crew-surface-drift — forge-subagents delta

## MODIFIED Requirements

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
