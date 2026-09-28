## MODIFIED Requirements

### Requirement: Unconfigured crew initialization gate

When `/crew` is invoked and the host-materialized forge.json agent set is empty, the command SHALL refuse entry into crew orchestration (hard gate) and SHALL present initialization guidance stating: the two configuration layer paths (global `~/.config/opencode/forge.json` and the nearest project `.opencode/forge.json` discovered by walking up from the workspace — both layers MERGE, the project layer overriding the global one per agent id), a copy-paste JSONC agent template embedded in the command's discipline text, and the choice between configuring it themselves or having the session AI do so — where AI-assisted configuration SHALL happen only after the user's explicit go-ahead in that conversation, through the normally-visible write path. The guidance — template example AND prose — SHALL disclose the optional per-agent `prompt` field: an explicit prompt fully overrides the built-in role, only the ids `research` and `review` carry built-ins, and any other id without a prompt gets a generic one-liner (it will not know its job). When the session AI writes the configuration on the user's go-ahead, it SHALL give every agent a SHORT prompt derived from the role the user asked for — one or two sentences the user can trim or extend — and SHALL write a long prompt only when the user explicitly asks for that agent. The guidance SHALL also state the application timing: newly added agents require a host restart to enter the task vocabulary, while `thoughtLevel` edits apply without restart. The gate SHALL anchor its guidance on the calling session's effective worktree where one is observable (walking up from it for the project layer), falling back to the host launch directory; and when the session's anchor discovers a usable project layer that the host's materialized set does not include, the gate output SHALL say so explicitly — naming the discovered file and directing the user to relaunch the host in that workspace (or to move the agents into the global layer) — instead of claiming the feature is unconfigured. The same disclosure SHALL apply on a successful `crew_begin` whose session-anchored discovery found project-layer agents the host did not materialize. The plugin itself SHALL never write or create the file. This invitation surface SHALL exist only inside the unconfigured `/crew` flow — no other plugin surface (tool description, agent prompt, error path) SHALL invite AI-authored configuration.

#### Scenario: Unconfigured /crew refuses with initialization guidance

- **WHEN** `/crew <objective>` is invoked and the effective agent set is empty
- **THEN** entry into orchestration is refused and the response names the two layer paths with the merge rule (project overrides global per agent), shows the embedded template — including the optional per-agent `prompt` field — offers the self-configure or AI-assisted options with the consent rule, and states the restart/hot-apply timing

#### Scenario: AI-assisted configuration writes short role prompts

- **WHEN** the user explicitly asks the session AI to configure forge.json in that conversation
- **THEN** every agent the AI writes carries a SHORT prompt derived from the role the user asked for (one or two sentences), unless the user explicitly asked for a longer prompt on that agent — and the consent rule (never write forge.json without the explicit go-ahead) still governs the write itself

#### Scenario: A workspace file the host cannot see is disclosed, not masked

- **WHEN** the host-materialized agent set is empty (or lacks the session's agents) but the calling session's anchor discovers a usable project `.opencode/forge.json`
- **THEN** the gate output names that file and states that this host instance was not launched there — directing the user to relaunch in that workspace or add the agents to the global layer — rather than reporting the feature as unconfigured

#### Scenario: The configuration invitation lives only in the /crew gate

- **WHEN** any other plugin surface is inspected (tool descriptions, materialized agent prompts, error paths)
- **THEN** no surface invites the session AI to author forge.json — the everyday dispatch path stays configuration-silent

#### Scenario: A configured crew bypasses the gate

- **WHEN** `/crew <objective>` is invoked and at least one agent materialized successfully
- **THEN** the gate does not fire and orchestration discipline proceeds normally; if the session's own discovery additionally found project-layer agents missing from the host vocabulary, the crew_begin output carries that disclosure alongside the registration summary
