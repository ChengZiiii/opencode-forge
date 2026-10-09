# forge-subagents Delta — allow-readonly-recon-during-plan-draft

## MODIFIED Requirements

### Requirement: Native-task dispatch surface

The plugin SHALL NOT register any dispatch tool: no `forge_dispatch`, `forge_dispatch_config`, `forge_dispatch_list`, or `forge_dispatch_kill`. forge subagents are spawned through the host's native `task` tool, and their runs render in the host UI with the native subagent affordances (progress visibility, expandable transcript). Plan-draft interop SHALL be shape-gated inheritance from the plan harness's write ban: while a draft is active in the dispatching session, a task call to a forge subagent of effective readonly shape (definition `shape` not `"write"` and no permission override lifting `write`/`edit`/`bash` off `"deny"`) passes the ban as a reconnaissance dispatch, while a task call to any other target — write-shape workers included — is refused by the same write-class deny as any native task call. The plugin SHALL add no dispatch-specific refusal beyond the plan harness's shape gate: a readonly-shape dispatch during a draft creates no new refusal surface, and the recursion ban (`task: deny` forced on every worker regardless of shape and overrides) keeps a dispatched scout physically incapable of spawning further.

#### Scenario: No dispatch tools are registered

- **WHEN** the plugin's tool registrations are enumerated on a v1 host
- **THEN** none of the forge_dispatch family appears; the subagent vocabulary is reachable only through the native task tool

#### Scenario: A task call runs the pinned brain

- **WHEN** the model dispatches `task {subagent_type: "forge-research", prompt: ...}` on a host where `prov/x` is configured
- **THEN** the subagent session runs on the pinned `prov/x` identity with the materialized permission and discipline

#### Scenario: Draft-plan interop is inherited

- **WHEN** the session has an active draft plan and the model attempts a task call to a forge subagent
- **THEN** the plan harness's own write ban decides it by target shape — the call passes as a reconnaissance dispatch when the target resolves to effective readonly shape, and is refused with roster guidance when the target is a write-shape worker or an unresolvable/native target; no plugin-side dispatch refusal exists beyond that gate

#### Scenario: A dispatched scout cannot recurse or write

- **WHEN** a readonly forge subagent runs as a reconnaissance dispatch during a draft
- **THEN** its own `task` calls are denied by the forced recursion ban and its write/edit/bash calls are denied by its materialized permission map — the carve-out transports no mutation path
