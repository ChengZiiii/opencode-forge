# v2-single-agent-surface — tool-partition delta

## MODIFIED Requirements

### Requirement: Forge family runs exclusively on the forge exec surface

Every agent the plugin brings — the forge primary agent and every forge-* subagent regardless of shape — SHALL have the builtin shell tools (shell/bash) hidden and SHALL execute commands only through forge_shell/forge_jobs. On the v1 loader the hiding SHALL be delivered via runtime config injection; on the v2 loader — where agent records carry no `tools` field and per-agent tool visibility is permission-driven — the hiding SHALL be delivered as a deny permission (`action: "shell"`, `resource: "*"`, `effect: "deny"`) pushed onto the forge agent record and every materialized forge-* record at registration, shaping the model-facing tool surface before any call; the permission-belt refusals SHALL remain in place as belt-in-depth under both loaders. The hiding SHALL hold regardless of any host background capability, SHALL apply to a user-defined `forge` agent entry as a tools merge (builtin shell off, every other field of the entry untouched), and SHALL be withdrawn only by `jobs.keepBuiltinShell: true` or by supervisor retirement (`jobs.mode: "native"`) — both remaining v1-loader mechanisms (documented v2 drift until a readable opencode-config channel exists on v2). Harness state tools (the plan_*/goal_*/crew_* families) SHALL be primary-only: they SHALL be hidden from every forge-* subagent, whose forge toolset is limited to the exec pair (forge_shell and forge_jobs) and the search pair (forge_grep and forge_glob).

#### Scenario: A write-shape forge subagent has no builtin shell

- **WHEN** a forge.json agent with shape "write" is materialized
- **THEN** the materialized agent entry hides the builtin shell tools while keeping its shape-derived permission map and pinned model

#### Scenario: A forge worker carries only the exec toolset

- **WHEN** a forge-* subagent session assembles its toolset
- **THEN** the plan_*/goal_*/crew_* harness tools are absent; only forge_shell, forge_jobs, forge_grep, and forge_glob are available alongside the shape's own tools

#### Scenario: A crew wave runs on the forge exec surface

- **WHEN** a /crew orchestration dispatches subtasks to forge-* agents through the native task tool
- **THEN** the dispatched workers can execute commands only through forge_shell

#### Scenario: Native backgrounding does not restore the builtin shell on the forge family

- **WHEN** the host's builtin shell presents a native run_in_background parameter
- **THEN** the forge primary agent and all forge-* subagents still exclude the builtin shell tools

#### Scenario: The v2 model surface never offers the builtin shell

- **WHEN** a forge session on a v2 host assembles its model-facing tool list
- **THEN** the builtin shell tool is absent from the offered surface (deny-shaped via the agent record's permission payload) while forge_shell remains available, and no belt refusal is needed for the model to stay on the forge exec surface

#### Scenario: v2 worker records carry the front door alongside their shape map

- **WHEN** a forge-* subagent record materializes under the v2 loader
- **THEN** its permission payload carries the shell deny in addition to its shape-derived permission map, for every shape including write
