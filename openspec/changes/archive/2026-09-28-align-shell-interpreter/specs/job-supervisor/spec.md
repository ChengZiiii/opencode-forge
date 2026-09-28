## ADDED Requirements

### Requirement: Host-aligned shell interpreter selection

Every plugin-spawned shell execution — `forge_shell` foreground and background jobs, and goal-harness verification shell checks — SHALL resolve its interpreter through the host-aligned selection chain instead of the Node `shell: true` default (cmd.exe on Windows, `/bin/sh` on POSIX). The chain SHALL be: a host-configured shell, when one is visible to the plugin in the merged host config, takes precedence; otherwise on Windows the first available of `pwsh` → `powershell` → git-bash → `%COMSPEC%` (cmd.exe as a machine-level capability fallback only), and on POSIX the environment login shell with `bash` preferred and `/bin/sh` as the capability fallback. PowerShell-family interpreters SHALL be invoked directly as `<shell> -NoProfile -Command <command>` with an exit-code guard so a native command's exit status propagates as the job's exit status; POSIX interpreters SHALL preserve the existing detached process-group semantics. No plugin option SHALL configure or override the interpreter choice. The four-condition completion semantics, exit-event binding, stdio file-backing, and kill/fence mechanics SHALL be unaffected by the interpreter change.

#### Scenario: PowerShell syntax executes on Windows

- **WHEN** `forge_shell` runs a command on a Windows host where a PowerShell-family binary is available and the command uses PowerShell syntax (e.g. `Get-Content "$env:USERPROFILE\..."`)
- **THEN** the job's process tree root is the resolved PowerShell binary invoked as `-NoProfile -Command <command>` (never through a cmd.exe `/c` wrapper), the command executes, and its output is captured like any job's

#### Scenario: Exit code of a wrapped native command propagates

- **WHEN** a native command inside a PowerShell-wrapped invocation exits with a nonzero status
- **THEN** the job's reported exit code equals that nonzero status (the wrapper does not swallow it)

#### Scenario: POSIX prefers bash with login semantics

- **WHEN** `forge_shell` runs a command on a POSIX host where `/bin/bash` exists
- **THEN** the command executes under bash (login invocation) rather than plain `/bin/sh`, and the job remains in its own process group exactly as before

#### Scenario: Capability fallback still executes

- **WHEN** the resolution chain reaches its tail (no pwsh/powershell/git-bash on Windows; no bash on POSIX)
- **THEN** the command still executes via cmd.exe (`/c`) or `/bin/sh` respectively, and no error is raised solely because a preferred interpreter was absent

#### Scenario: Host-configured shell wins

- **WHEN** the host exposes a configured shell option visible in the merged config
- **THEN** plugin-spawned executions resolve to that shell in preference to the platform defaults

#### Scenario: Goal verification checks share the interpreter

- **WHEN** a goal verification shell check executes (`goal_check` recording or `goal_complete` gate re-run)
- **THEN** it runs under the same resolved interpreter as `forge_shell` jobs, and its pass/fail verdict reflects that interpreter's exit status

### Requirement: Interpreter flavor disclosed in the tool description

The `forge_shell` tool description SHALL state, at interpreter-family granularity, which shell executes commands on each platform (PowerShell family on Windows; the login shell, bash preferred, on POSIX), so the model writes syntax matching the actual interpreter. The disclosure SHALL NOT name machine-specific resolved paths.

#### Scenario: Description names the interpreter families

- **WHEN** the `forge_shell` tool description is rendered
- **THEN** it identifies the Windows interpreter as the PowerShell family and the POSIX interpreter as the login shell with bash preferred, in addition to its existing exec-surface framing
