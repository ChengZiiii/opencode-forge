## REMOVED Requirements

### Requirement: Capability probe and staged degradation

**Reason**: The probe no longer drives any hiding behavior: `auto` and `forge` modes are equivalent (the forge-side exec partition holds regardless of host capability) and only the manual `native` mode retires the supervisor. The stage vocabulary and both probe sources are retired with it.
**Migration**: Replaced by the ADDED requirement "Mode selection and supervisor retirement" (below); user-facing option names (`jobs.mode` values) are unchanged.

## ADDED Requirements

### Requirement: Mode selection and supervisor retirement

The plugin SHALL accept a manual `jobs.mode` option (`auto` | `forge` | `native`). The `auto` and `forge` modes SHALL be equivalent: the forge-side exec partition (builtin shell hidden on forge-family agents, per the tool-partition capability) SHALL hold regardless of any host background capability. Only `native` mode retires the supervisor: `forge_shell` and `forge_jobs` are no longer registered and the builtin shell is restored on the forge agent. Model-facing semantics and naming SHALL remain constant across modes.

#### Scenario: Native backgrounding does not unhide the builtin shell

- **WHEN** the host's builtin shell presents a run_in_background parameter and jobs.mode is `auto`
- **THEN** the forge agent's builtin shell tool remains hidden and `forge_shell` stays the exec surface

#### Scenario: Manual retirement restores the native surface without prompt changes

- **WHEN** the user sets `jobs.mode` to `native`
- **THEN** `forge_shell` is no longer registered, the builtin shell is restored, and prompts written against the job verbs keep working through the native surface

## MODIFIED Requirements

### Requirement: Model-facing guidance injection

The plugin SHALL inject the job guidance into the system prompt of sessions whose agent belongs to the forge family (the forge primary agent and forge-* subagents), including delegated forge-family sessions; sessions of any other agent SHALL receive no forge-authored system text.

#### Scenario: Forge-family sessions receive the guidance

- **WHEN** a forge or forge-* session builds its system prompt
- **THEN** it contains the forge_shell guidance and the delegated collection rule

#### Scenario: Subagent sessions receive the collection rule

- **WHEN** a delegated forge-family session is spawned while the plugin is loaded
- **THEN** its system prompt contains the rule to poll job results before yielding

#### Scenario: Non-forge sessions receive no forge text

- **WHEN** a native or user-defined non-forge agent session builds its system prompt
- **THEN** its system prompt contains no forge-authored guidance
