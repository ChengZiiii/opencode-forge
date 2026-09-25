# forge-agent Specification (delta)

## MODIFIED Requirements

### Requirement: Register the single general-purpose forge agent

Once the plugin loads, the system SHALL register a primary general-purpose agent with id `forge` (full read/write/execute tool surface) as the only primary subject in the Tab cycle. Implementation-type tasks the user issues directly, without any planning flow, SHALL be executed by forge directly.

While the job-supervisor operates at stage 0 or stage 1 (no complete native background capability detected) and the `forge` agent entry was created by the plugin itself, the execute surface SHALL be provided by `forge_shell` with the builtin shell tool hidden on the `forge` agent via runtime config injection (nothing written to the user's config file). Setting `jobs.keepBuiltinShell: true`, or a user-defined `forge` agent entry, SHALL leave the builtin shell tool in place. At stage 2 the hide injection SHALL be withdrawn and the builtin shell restored as the exec surface. Agents other than the plugin-created `forge` entry SHALL never have their tool configuration touched.

#### Scenario: forge appears in the agent list after an official install

- **WHEN** the plugin is installed via an official `opencode plugin` install mode and loaded, and the user views the agent list
- **THEN** the list contains `forge` as a primary general-purpose agent

#### Scenario: A direct unplanned task is executed by forge

- **WHEN** the user issues an implementation-type task directly in a forge session (without `/plan`)
- **THEN** forge executes the task directly, with no agent switching at any point

#### Scenario: Stage 0 exec surface is forge_shell

- **WHEN** the plugin created the `forge` agent entry and no complete native background capability is detected
- **THEN** the forge agent's toolset excludes the builtin shell tool and includes `forge_shell`

#### Scenario: keepBuiltinShell retains the native tool

- **WHEN** the user sets `jobs.keepBuiltinShell: true`
- **THEN** the builtin shell tool remains available on the forge agent alongside `forge_shell`

#### Scenario: A user-defined forge entry is never modified

- **WHEN** the user has their own `agent["forge"]` configuration
- **THEN** the plugin does not inject the shell-hide into that entry and the user's tool configuration stands

#### Scenario: Stage migration restores the builtin shell

- **WHEN** the capability probe moves to stage 2
- **THEN** the hide injection is withdrawn and the builtin shell tool returns to the forge agent's toolset
