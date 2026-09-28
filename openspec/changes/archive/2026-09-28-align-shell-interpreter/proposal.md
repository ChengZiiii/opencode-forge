# align-shell-interpreter

## Why

`forge_shell` spawns every command through `spawn(cmd, { shell: true })`, which on Windows resolves to **cmd.exe** and on POSIX to plain **/bin/sh**. The host's native shell tool does neither: upstream opencode resolves its shell through a preference chain (`packages/core/src/shell.ts`) — on Windows `pwsh → powershell → git-bash → cmd.exe (last resort only)`, on POSIX `zsh (darwin) → bash → sh (last resort)` — invokes PowerShell directly as `shell -NoLogo -NoProfile -NonInteractive -Command <command>` with no cmd.exe wrapper, renders a per-shell, per-platform tool description (that is why the builtin tool's description says "Windows PowerShell (5.1)"), and even parses commands with tree-sitter bash/PowerShell grammars for permission scanning. `shell: true` bypasses that entire chain and lands on the host's **last-resort** interpreter.

Consequences, with field evidence (2026-09-28, session `ses_f17b6ea6`):

- The model writes PowerShell syntax (the host environment tells it to), the belt
  steers the refused bash call to `forge_shell`, and the re-issued command **fails
  under cmd.exe** — `'Get-Content' is not recognized as an internal or external
  command`, exit 255. The belt's recovery path ("re-issue through forge_shell")
  presupposes command portability that the interpreter mismatch breaks: on Windows
  the channel switch costs up to two wasted rounds, not one.
- Even with zero belt hits, any first-shot PowerShell command fails in
  `forge_shell` on Windows. The defect is independent of the routing layer
  archived as final in `forge-shell-final` (that note covers the channel, not the
  interpreter).
- Goal verification checks (`run-check.ts`) share `shellSpawn`, so `--check`
  commands drafted under the model's PowerShell expectations fail spuriously on
  Windows — false-negative completions.

## What Changes

- **Host-aligned interpreter selection** for every plugin-spawned shell execution
  (`forge_shell` jobs and goal verification checks): resolve the interpreter
  through the host's chain — a host-configured shell when visible in the merged
  config, else on Windows `pwsh → powershell → git-bash → cmd.exe` (machine-level
  capability fallback only), on POSIX the environment login shell with `bash`
  preferred, `/bin/sh` as capability fallback. PowerShell-family shells are
  invoked directly as `<shell> -NoProfile -Command <command>` (no cmd.exe
  wrapper); POSIX shells keep the detached process-group semantics.
- **No configuration knob.** There is deliberately no `jobs.windowsShell` escape
  hatch: the host itself defaults to PowerShell on Windows and treats cmd.exe as
  a last resort, and this change aligns with that, it does not invent a second
  preference system.
- **Interpreter disclosure**: the `forge_shell` tool description states which
  interpreter family executes commands per platform, so the model writes the
  matching syntax instead of guessing.
- Exit-code propagation is preserved (the job's exit event and exit code remain
  terminal evidence), including for PowerShell-wrapped native commands.

## Impact

- Specs: job-supervisor (2 ADDED requirements)
- Code: `src/proc.ts` (shellSpawn host-aligned), `src/job-runner.ts` (spawn wiring), `src/run-check.ts` (inherits via shared shellSpawn), `plugin.ts` (FORGE_SHELL_DESCRIPTION flavor sentence)
- Tests: `tests/proc.test.mjs`, `tests/job-wiring.test.mjs`, `tests/goal-mode.test.mjs` (injectable-shell assertions)
- Docs: README (job supervisor chapter — interpreter selection paragraph)
- Non-goals: no tree-sitter command parsing, no per-agent interpreter choice, no
  change to the routing/mandate/belt layers, no new plugin options.
