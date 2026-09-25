## Purpose

Govern the single general-purpose agent identity for opencode sessions: register forge, hide the native build/plan agents at runtime for the plugin's lifetime, provide a one-knob return-to-native and uninstall self-healing — replacing "multi-agent persona switching" as the orchestration shape.

## ADDED Requirements

### Requirement: Register the single general-purpose forge agent

Once the plugin loads, the system SHALL register a primary general-purpose agent with id `forge` (full read/write/execute tool surface) as the only primary subject in the Tab cycle. Implementation-type tasks the user issues directly, without any planning flow, SHALL be executed by forge directly.

#### Scenario: forge appears in the agent list after an official install

- **WHEN** the plugin is installed via an official `opencode plugin` install mode and loaded, and the user views the agent list
- **THEN** the list contains `forge` as a primary general-purpose agent

#### Scenario: A direct unplanned task is executed by forge

- **WHEN** the user issues an implementation-type task directly in a forge session (without `/plan`)
- **THEN** forge executes the task directly, with no agent switching at any point

### Requirement: Hide the native build/plan agents while the plugin is loaded

While the plugin is loaded, the system SHALL disable the native `build` and `plan` agents, and the Tab agent cycle SHALL no longer offer them. The hiding SHALL be implemented as runtime config injection (nothing written to the user's config file).

#### Scenario: Only forge remains in the Tab cycle

- **WHEN** the plugin has loaded and the user cycles agents
- **THEN** the cycle contains only `forge`; the native `build` and `plan` do not appear

#### Scenario: The hide never touches disk

- **WHEN** the user inspects their opencode config file after the plugin injected the disables
- **THEN** the config file contains no agent-disable entries written by the plugin

### Requirement: One-knob return to native

When the user sets `agent["forge"].disable: true`, the plugin SHALL go wholly silent: no forge agent registered, the native build/plan hide injection withdrawn, no harness tools, command, or skill registered — the system returns to its native shape.

#### Scenario: Native restored after the knob is set

- **WHEN** the user sets `agent["forge"].disable: true` in their config and restarts opencode
- **THEN** the agent list has no `forge`, the native `build` and `plan` are available again, and no harness tools or commands are registered

### Requirement: Uninstall self-healing

After the user completes the uninstall steps documented in the README, the system SHALL carry no plugin residue: forge is gone, native build/plan are restored. Plan files already generated under `.opencode/plan/` are user data, and uninstall SHALL NOT delete them.

#### Scenario: Native restored after uninstall

- **WHEN** the user uninstalls the plugin following the README's four steps and restarts opencode
- **THEN** the agent list shows the native `build`/`plan` again, with no `forge`

#### Scenario: Uninstall keeps plan data

- **WHEN** the workspace contains historical plan files and the user uninstalls the plugin
- **THEN** the `.opencode/plan/` directory and its files remain untouched

### Requirement: v2 forward-compatible registration

Under a v2 loader, the plugin SHALL register the forge agent and the skill via `setup` on a create-only basis (an existing target entry is skipped; fields use the v2 shape); the v2 side SHALL NOT attempt to register tools, permission hooks, or commands (v2 has no domain for them at 1.18). On host API shape drift, registration SHALL skip silently instead of throwing.

#### Scenario: An existing same-name entry is not clobbered under v2

- **WHEN** a v2 loader calls `setup` and the agent draft already contains a `forge` entry
- **THEN** the plugin skips creation and the existing entry's content is unchanged
