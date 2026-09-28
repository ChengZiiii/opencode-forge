## REMOVED Requirements

### Requirement: Register the single general-purpose forge agent

**Reason**: Rewritten by the tool-partition capability: the Tab cycle changes from "forge as the only primary" to coexistence with the native primaries, the exec-surface hide becomes unconditional (probe- and user-entry-independent), and the old scenarios ("Stage 0 exec surface", "a user-defined forge entry is never modified", "stage migration restores the builtin shell") describe stage/user-entry semantics that no longer exist.
**Migration**: Replaced by the ADDED requirement "Register the forge primary agent on the forge exec surface" (below); behavior differences are owned by the tool-partition capability.

### Requirement: Hide the native build/plan agents while the plugin is loaded

**Reason**: The user wants forge to coexist with the native agents instead of replacing them: build/plan return to the Tab cycle and behave fully natively (their isolation from forge tooling is governed by the tool-partition capability, not by disabling).
**Migration**: None needed — the plugin simply stops injecting the disables. Users who preferred the forge-only Tab cycle can keep their own `agent.build`/`agent.plan` disable entries in config (the plugin never touches user-written fields).

## ADDED Requirements

### Requirement: Register the forge primary agent on the forge exec surface

Once the plugin loads, the system SHALL register a primary general-purpose agent with id `forge` (full read/write/execute tool surface). The Tab agent cycle SHALL offer forge alongside the native primary agents: forge is the plugin's general-purpose subject, while the native agents remain selectable and behave fully natively (per the tool-partition capability). Because the host's own default subject is the native build agent once it exists, the plugin SHALL set the host's default agent to `forge` unless the user configured `default_agent` themselves — coexistence MUST NOT flip the default subject away from forge, so a direct unplanned task in a fresh session executes as forge exactly as before.

The forge agent's execute surface SHALL be provided by `forge_shell` with the builtin shell tool hidden via runtime config injection (nothing written to the user's config file). The hiding SHALL be unconditional with respect to any capability probe: it holds whether or not the host offers native backgrounding, and it SHALL also apply to a user-defined `forge` agent entry (injected as a tools merge that only turns the builtin shell off, never touching the entry's other fields). `jobs.keepBuiltinShell: true` SHALL keep the builtin shell tool in place as the explicit escape hatch. When the job supervisor is manually retired (`jobs.mode: "native"`), the hide SHALL be withdrawn together with the `forge_shell` registration so the forge agent is never left without an exec surface.

#### Scenario: forge appears in the agent list after an official install

- **WHEN** the plugin is installed via an official `opencode plugin` install mode and loaded, and the user views the agent list
- **THEN** the list contains `forge` as a primary general-purpose agent

#### Scenario: A direct unplanned task is executed by forge

- **WHEN** the user issues an implementation-type task directly in a forge session (without `/plan`)
- **THEN** forge executes the task directly, with no agent switching at any point

#### Scenario: A fresh session defaults to forge under coexistence

- **WHEN** the plugin is loaded and the user starts a session without naming an agent (bare `opencode run` or a new TUI session with no remembered choice)
- **THEN** the default subject is forge — the native build agent's revival does not capture the default — unless the user set `default_agent` in their own config

#### Scenario: The exec surface is forge_shell regardless of native capability

- **WHEN** the host's builtin shell offers a native run_in_background parameter
- **THEN** the forge agent's toolset still excludes the builtin shell tool and includes `forge_shell`

#### Scenario: keepBuiltinShell retains the native tool

- **WHEN** the user sets `jobs.keepBuiltinShell: true`
- **THEN** the builtin shell tool remains available on the forge agent alongside `forge_shell`

#### Scenario: A user-defined forge entry still gets the partition

- **WHEN** the user has their own `agent["forge"]` configuration
- **THEN** the builtin shell is hidden on that entry via a merge that leaves the entry's other fields untouched, unless `jobs.keepBuiltinShell` is set

#### Scenario: Supervisor retirement restores the builtin shell

- **WHEN** the user sets `jobs.mode: "native"`
- **THEN** `forge_shell` is no longer registered and the builtin shell tool returns to the forge agent's toolset

## MODIFIED Requirements

### Requirement: One-knob return to native

When the user sets `agent["forge"].disable: true`, the plugin SHALL go wholly silent: no forge agent or forge-* subagent registered, no runtime injection of any kind performed (agent registrations, tool hiding, permission rules, commands), no harness tools registered — the system returns to its native shape.

#### Scenario: Native restored after the knob is set

- **WHEN** the user sets `agent["forge"].disable: true` in their config and restarts opencode
- **THEN** the agent list has no `forge`, the native agents carry no plugin-injected tool hiding, and no harness tools or commands are registered
