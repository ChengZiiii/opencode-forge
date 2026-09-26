## MODIFIED Requirements

### Requirement: Bounded foreground execution with four completion conditions

The `forge_shell` tool SHALL resolve a foreground invocation on the first of four conditions, and SHALL never leave the calling agent blocked beyond its hard cap: (1) the direct child process exits — completion SHALL be bound to the exit event, not to stdio stream EOF; (2) an opt-in `success_pattern` regular expression matches newly captured output; (3) no new output has arrived for `idle_ms` (default 60000); (4) `max_wait_ms` elapses (default 120000, clamped to at most 600000). Conditions (2)–(4) SHALL return early with a `still-running` or `success` status, an output tail, and a `jobId` for follow-up, while the process remains alive unless explicitly killed. EVERY foreground return form — `exited`, `succeeded`, `still-running`, and the spawn-failure form — SHALL state the absolute working directory the command actually ran in, so a caller (or the user reading the transcript) can verify the execution location against the agent's own narrative of it.

#### Scenario: Detached grandchild holding inherited stdio does not hang the call

- **WHEN** a command spawns a long-lived background child that inherits the stdio pipes and the direct child exits
- **THEN** `forge_shell` resolves on the direct child's exit with the captured output, without waiting for stream EOF

#### Scenario: Idle early return keeps the process alive

- **WHEN** a foreground command produces no new output for `idle_ms`
- **THEN** the call returns `still-running` with the output tail and a `jobId`, and the process keeps running

#### Scenario: Success pattern short-circuits a server-style command

- **WHEN** `success_pattern` matches captured output of a command that never exits
- **THEN** the call returns `success` immediately with the matched context; the process is kept alive by default and terminated with its tree when `keep_alive` is `false`

#### Scenario: Hard cap returns without killing

- **WHEN** a command keeps producing output past `max_wait_ms`
- **THEN** the call returns `still-running` with a `jobId` and the process is not killed

#### Scenario: Every foreground return discloses the actual working directory

- **WHEN** a `forge_shell` call resolves in any form (exit, success match, idle, max-wait, or spawn failure)
- **THEN** the result states the absolute directory the command ran in, taken from the resolved execution cwd — not from the agent's assumption — so "serving the current directory" claims can be checked against it

### Requirement: Background start semantics

`forge_shell` with `run_in_background: true` SHALL return immediately with a `jobId` and the `logPath` of the tee'd output file, without waiting for any output or exit, and the return SHALL state the absolute working directory the command runs in. Parameter and return-field naming (`run_in_background`, `jobId`, `logPath`) SHALL match the upstream opencode backgrounding direction so prompts transfer unchanged across degradation stages.

#### Scenario: Immediate handle for a background start

- **WHEN** the model calls `forge_shell` with `run_in_background: true` for a dev server
- **THEN** the call returns at once with `jobId` and `logPath`, and the session continues with other work

#### Scenario: Background handle discloses the working directory

- **WHEN** a background job starts
- **THEN** the immediate handle states the absolute directory the command runs in, alongside `jobId` and `logPath`
