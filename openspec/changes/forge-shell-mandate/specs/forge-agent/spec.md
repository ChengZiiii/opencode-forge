# forge-agent delta — forge-shell-mandate

## ADDED Requirements

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
