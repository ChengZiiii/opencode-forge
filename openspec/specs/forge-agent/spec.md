# forge-agent Specification

## Purpose
Govern the single general-purpose agent identity for opencode sessions: register forge, hide the native build/plan agents at runtime for the plugin's lifetime, provide a one-knob return-to-native and uninstall self-healing — replacing "multi-agent persona switching" as the orchestration shape.

## Requirements

### Requirement: One-knob return to native

When the user sets `agent["forge"].disable: true`, the plugin SHALL go wholly silent: no forge agent or forge-* subagent registered, no runtime injection of any kind performed (agent registrations, tool hiding, permission rules, commands), no harness tools registered — the system returns to its native shape.

#### Scenario: Native restored after the knob is set

- **WHEN** the user sets `agent["forge"].disable: true` in their config and restarts opencode
- **THEN** the agent list has no `forge`, the native agents carry no plugin-injected tool hiding, and no harness tools or commands are registered

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

### Requirement: Channel mandate in forge-family prompts

While the exec partition holds (forge-family builtin shell hidden, `forge_shell` registered), the forge agent's system prompt SHALL carry an unconditional channel mandate: every shell command — quick ones included — runs through `forge_shell`, and the builtin shell/bash tools are refused on the forge family, so the model must not try them first. The `[forge:job-guidance]` system injection SHALL carry the same absolutized wording (it SHALL NOT teach that only long-running commands belong to `forge_shell`). When `jobs.keepBuiltinShell: true` restores the builtin tool, the mandate SHALL soften to a preference — `forge_shell` first — without claiming the builtin tool is refused. Under `jobs.mode: "native"` the supervisor is retired, `forge_shell` no longer exists, and no forge-authored shell mandate SHALL be injected. The `forge_shell` tool description SHALL present the tool as the exec surface for every shell command.

#### Scenario: A forge-family session receives the absolute mandate

- **WHEN** a forge-family session builds its system prompt under the default partition (`jobs.mode` `auto`/`forge`, no `keepBuiltinShell`)
- **THEN** the prompt and the `[forge:job-guidance]` injection state that every shell command goes through `forge_shell` and that builtin shell calls are refused — with no long-running qualifier on the channel rule

#### Scenario: The escape hatch softens the refusal claim

- **WHEN** the user sets `jobs.keepBuiltinShell: true`
- **THEN** the mandate still names `forge_shell` as the exec surface and asks for it first, but no longer claims the builtin shell is refused (it is available by explicit choice)

#### Scenario: Supervisor retirement injects no mandate

- **WHEN** `jobs.mode` is `native`
- **THEN** no forge-authored shell mandate reaches any session (the tool and its guidance are gone)

#### Scenario: A quick command still routes through forge_shell

- **WHEN** the forge agent needs to run a trivially short command (an echo, a version check)
- **THEN** the model-facing text it was seeded with gives no basis for reaching for the builtin shell first — the channel rule is unconditional
