# tool-partition Delta

## MODIFIED Requirements

### Requirement: Forge family runs exclusively on the forge exec surface

Every agent the plugin brings — the forge primary agent and every forge-* subagent regardless of shape — SHALL have the builtin shell tools (shell/bash) hidden via runtime config injection and SHALL execute commands only through forge_shell/forge_jobs. The hiding SHALL hold regardless of any host background capability, SHALL apply to a user-defined `forge` agent entry as a tools merge (builtin shell off, every other field of the entry untouched), and SHALL be withdrawn only by `jobs.keepBuiltinShell: true` or by supervisor retirement (`jobs.mode: "native"`). Harness state tools (the plan_*/goal_*/crew_* families) SHALL be primary-only: they SHALL be hidden from every forge-* subagent, whose forge toolset is limited to the exec pair (forge_shell and forge_jobs) and the search pair (forge_grep and forge_glob).

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

### Requirement: Non-forge agents are isolated from forge tooling

Every agent other than the forge family — the native build, plan, general, and explore agents, and every user-defined agent — SHALL have all plugin-registered forge tools (forge_shell, forge_jobs, forge_grep, forge_glob, crew_begin, crew_close, and the plan_*/goal_* harness tools) hidden via runtime config injection, so no non-forge session can see or invoke forge tooling and the builtin shell remains its exec surface. Because the host's task-tool agent vocabulary is global (forge-* subagents cannot be made invisible to a specific parent agent), a non-forge agent's attempt to dispatch a forge-* subagent SHALL be refused at the tool layer with an explanatory error, and no subagent session SHALL be created. Forge state files are boundary-protected: a non-forge session's attempt to write into `.opencode/plan/` or `.opencode/goal/` SHALL be refused at the tool layer, while reading them stays unrestricted. A user's explicit `tools` entry enabling a forge tool on the user's own agent SHALL be respected and never overwritten. Native agents absent from the user's config SHALL receive the hiding through the same runtime materialization mechanism the plugin uses for its own agent entries.

#### Scenario: The native build agent sees no forge tools

- **WHEN** the user selects the native build agent and its toolset is assembled
- **THEN** no plugin-registered forge tool is present, and the builtin shell is available as its exec surface

#### Scenario: A non-forge dispatch of a forge worker is refused

- **WHEN** the native build agent calls the task tool with a forge-* subagent as the target
- **THEN** the call is refused with an error naming the agent-family partition, and no subagent session is created

#### Scenario: A non-forge write into forge state files is refused

- **WHEN** the native build agent attempts to write or edit a file under `.opencode/plan/` or `.opencode/goal/`
- **THEN** the call is refused with an error naming the forge state boundary, and the file is unchanged

#### Scenario: A task-spawned default subagent inherits the isolation

- **WHEN** a non-forge agent dispatches a subagent through the native task tool with the default general agent
- **THEN** the spawned session likewise has no forge tools available

#### Scenario: A user-defined agent gets the isolation without losing its own fields

- **WHEN** the user defines their own agent in config and the plugin loads
- **THEN** only the forge-tool entries are merged into that agent's tools map as disabled, and all other fields of the entry stand unchanged

#### Scenario: Explicit user opt-in is respected

- **WHEN** the user's config explicitly sets tools.forge_shell: true on their own agent entry
- **THEN** the plugin does not override that entry and the tool remains available there
