# job-supervisor Specification

## Purpose
Provide non-blocking shell execution with multi-condition completion semantics, a session-owned job table with incremental output retrieval and completion wake-up, and a staged degradation path aligned with the upstream opencode backgrounding effort — so agents (primary or delegated) are never suspended indefinitely by a shell command.

## Requirements

### Requirement: Bounded foreground execution with four completion conditions

The `forge_shell` tool SHALL resolve a foreground invocation on the first of four conditions, and SHALL never leave the calling agent blocked beyond its hard cap: (1) the direct child process exits — completion SHALL be bound to the exit event, not to stdio stream EOF; (2) an opt-in `success_pattern` regular expression matches newly captured output; (3) no new output has arrived for `idle_ms` (default 60000); (4) `max_wait_ms` elapses (default 120000, clamped to at most 600000). Conditions (2)–(4) SHALL return early with a `still-running` or `success` status, an output tail, and a `jobId` for follow-up, while the process remains alive unless explicitly killed.

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

### Requirement: Background start semantics

`forge_shell` with `run_in_background: true` SHALL return immediately with a `jobId` and the `logPath` of the tee'd output file, without waiting for any output or exit. Parameter and return-field naming (`run_in_background`, `jobId`, `logPath`) SHALL match the upstream opencode backgrounding direction so prompts transfer unchanged across degradation stages.

#### Scenario: Immediate handle for a background start

- **WHEN** the model calls `forge_shell` with `run_in_background: true` for a dev server
- **THEN** the call returns at once with `jobId` and `logPath`, and the session continues with other work

### Requirement: Job management verbs

The `forge_jobs` tool SHALL expose the verbs `list`, `poll`, `log`, `kill`, `clear`, and `handoff`. `poll` SHALL support a bounded in-call wait (clamped to at most 30000 ms) returning output newly produced since the last poll plus current exit status; `log` SHALL page historical output by `offset`/`limit`; `kill` SHALL terminate the job's whole process tree on Windows and POSIX; `clear` SHALL drop finished jobs from the registry; `handoff` SHALL rebind ownership to the job's root ancestor session, falling back to a plugin-global scope when no ancestor is resolvable.

#### Scenario: Incremental polling with bounded wait

- **WHEN** the model polls a running job with `waitMs: 20000` and output arrives after 5 seconds
- **THEN** `poll` returns the new output and `running` status within the bounded wait instead of the full 20 seconds

#### Scenario: Kill removes the whole tree

- **WHEN** the model kills a job whose command spawned child processes
- **THEN** all processes in the job's tree are terminated, and a subsequent `poll` reports the job as killed

### Requirement: Completion wake injection

When a job exits, the plugin SHALL inject at most one synthetic completion message (exit code plus a bounded output tail) into the job's owning session via the host's message-sending API. Injection SHALL occur only while the owning session is idle; if the session does not become idle within a delivery window, the completion SHALL be recorded in the diagnostics ledger instead of remaining queued forever. A per-call `notify: false` SHALL suppress the wake for that job.

#### Scenario: Background job wakes an idle session once

- **WHEN** a background job with default notify exits while its owning session is idle
- **THEN** exactly one completion message is delivered to that session, containing the exit code and output tail

#### Scenario: Busy session defers, ledger catches the overflow

- **WHEN** a job exits while its owning session stays busy past the delivery window
- **THEN** no message is injected and the completion is recorded in the diagnostics ledger

### Requirement: Job ownership and lifecycle

Each job SHALL be owned by the session that created it. When an owning session ends, its live jobs SHALL be terminated unless ownership was handed off or the job explicitly opted into survival. **Host-process exit SHALL be an explicit termination trigger equal to session end, honored on every exit path (plugin dispose, SIGINT, SIGTERM, uncaught exception, process exit), not only on graceful dispose.** Plugin `dispose` SHALL terminate all live jobs. Jobs still alive after their owner ended, and completions never read by any session, SHALL be reported in the diagnostics ledger. When the plugin is wholly disabled via the agent disable knob, no job tools SHALL be registered and no job state SHALL persist.

#### Scenario: Owner session end cleans up its jobs

- **WHEN** a subagent session that started a background job ends without handing it off
- **THEN** the job's process tree is terminated and no orphan process survives

#### Scenario: Host process exit terminates background jobs on every path

- **WHEN** the host process exits after a `run` that started a background job, whether normally, via signal, or via an error exit
- **THEN** the job's process tree is terminated shortly after exit and no orphan process survives; a service the job was running no longer accepts connections

#### Scenario: Handoff survives owner end

- **WHEN** a job was handed off before its creating session ended
- **THEN** the job keeps running under the rebound owner and its completion is delivered there

#### Scenario: Disable knob registers no job tools

- **WHEN** the plugin loads with the agent disable knob set
- **THEN** neither `forge_shell` nor `forge_jobs` is registered and no job state exists

### Requirement: Permission posture preserved

`forge_shell` SHALL preserve the shell permission posture of the host: each execution SHALL pass through an execute-time confirmation request evaluated against an injected permission rule defaulting to `ask`, and explicit user `deny` SHALL always win. In non-interactive run mode the gate SHALL follow the host's ask semantics (auto-reject without the auto-approve flag), matching the native shell tool's posture rather than bypassing it.

#### Scenario: Default posture asks before executing

- **WHEN** `forge_shell` executes with default configuration in an interactive session
- **THEN** the user is asked for confirmation before the command runs

#### Scenario: Explicit deny is never overridden

- **WHEN** the user's config denies the tool
- **THEN** `forge_shell` refuses to execute regardless of the injected default

### Requirement: Output retention and truncation

Job output SHALL be tee'd to a log file inside the plugin's namespaced temporary directory. Retained in-memory output SHALL be bounded per job and per registry with oldest-first eviction, and output returned to the model SHALL be truncated to a bounded tail.

#### Scenario: Output cap evicts oldest jobs

- **WHEN** retained output exceeds the registry cap
- **THEN** the oldest finished jobs' retained output is evicted first while on-disk logs remain within the namespaced directory

### Requirement: Model-facing guidance injection

The plugin SHALL inject concise guidance into the system prompt of all sessions, including delegated ones: long-running or potentially non-exiting commands go through `forge_shell`; a delegated agent collects its job results via `poll` before yielding its conclusion.

#### Scenario: Subagent sessions receive the collection rule

- **WHEN** a delegated session is spawned while the plugin is loaded
- **THEN** its system prompt contains the rule to poll job results before yielding

### Requirement: Capability probe and staged degradation

The plugin SHALL probe the host's native background capability via configuration flags, the native shell tool's parameter schema, and a manual `jobs.mode` option (`auto` | `forge` | `native`). Based on the probe it SHALL apply a stage matrix: with no native capability it provides the full forge path (stage 0); with an incomplete native capability it stops hiding the builtin shell and reduces `forge_shell` to an additive layer on top of native process management (stage 1); with a complete native capability it retires `forge_shell` and restores the builtin shell (stage 2). Model-facing semantics and naming SHALL remain constant across stages.

#### Scenario: Stage 0 hides builtin shell on the forge agent

- **WHEN** the probe finds no native background capability
- **THEN** the forge agent's builtin shell tool is hidden via runtime config injection and `forge_shell` is the exec surface

#### Scenario: Stage 2 retires forge_shell without prompt changes

- **WHEN** the probe finds a complete native background capability
- **THEN** `forge_shell` is no longer registered, the builtin shell is restored, and prompts written against the job verbs keep working through the native surface

### Requirement: Configuration surface and file ledger

All job-supervisor behavior SHALL be configurable through documented plugin options (`jobs.mode`, `jobs.keepBuiltinShell`, `jobs.notify`, log caps). Runtime artifacts SHALL be confined to the plugin's namespaced temporary directory, the README file ledger SHALL enumerate them, and uninstalling the plugin SHALL leave no residue outside documented user-data locations.

#### Scenario: Ledger accounts for runtime artifacts

- **WHEN** the user follows the README's uninstall steps after running jobs
- **THEN** no plugin-created files remain outside the documented user-data directories

### Requirement: Job stdio decoupled from host pipes

Background jobs SHALL be spawned with stdin attached to null and stdout/stderr attached to the job's log file handles (never the host's pipes). Log capture for poll/log actions SHALL read from the log files. A job process SHALL therefore never depend on the lifetime of a host-owned file descriptor, and shall remain fully functional if it outlives the host.

#### Scenario: A surviving service stays healthy

- **WHEN** a job process is still running after the host process that spawned it has exited
- **THEN** the process's stdio still resolves to valid file handles and a request-logging service keeps answering requests (no broken-pipe zombie)

#### Scenario: Log reads do not depend on live pipes

- **WHEN** a poll or log action reads job output
- **THEN** the content comes from the job's log file rather than an in-memory pipe buffer

### Requirement: OS-level safety net for orphaned jobs

In the default (kill-on-exit) posture, jobs SHALL additionally be fenced by an OS-level mechanism so that a host death which runs no exit handler still cannot leave silent orphans. On Windows, background jobs SHALL be terminated by the OS shortly after such a host death without any plugin code running. On POSIX, where no equivalent kernel fence is used, jobs whose host died without running exit handlers SHALL be detected by the next host start (persisted job registry scan) and reported in the diagnostics ledger as unresolved orphans (and killable from there). The safety net SHALL be disabled for jobs that explicitly opted into survival.

#### Scenario: Windows host force-kill still fences jobs

- **WHEN** the host process is force-killed while a background job runs in the default posture on Windows
- **THEN** the OS terminates the job's tree shortly after the host death, with no plugin code having run

#### Scenario: POSIX force-kill survivors are reported, not silent

- **WHEN** the host process is force-killed on POSIX while a background job runs in the default posture
- **THEN** the next host start reports the surviving job in the diagnostics ledger as an unresolved orphan with its id, pid, and log path

#### Scenario: Surviving jobs are not fenced

- **WHEN** a job explicitly opted into survival
- **THEN** no kill-on-close fence applies to it and it remains running across host exit

### Requirement: Explicit survival mode with a persisted registry

A job SHALL survive host exit only when explicitly marked (per-call `survive` flag or a configuration default). The configuration default SHALL be no survival, and an explicit configuration deny SHALL NOT be overridable by the per-call flag. The job registry for surviving jobs SHALL be persisted beyond the host process (job id, pid, command, log path) so a later session can list, poll, kill, or hand off survivors via the existing job-management verbs. Survivors SHALL be reported as such in list output (owner marked as a previous host run).

#### Scenario: Opt-in survivor is reclaimable across sessions

- **WHEN** a job was started with survival and the host later exits
- **THEN** a subsequent session's job list shows the survivor with its id, pid, and log path, and can kill or hand it off

#### Scenario: Default is no survival

- **WHEN** a job is started without any survival opt-in and the host exits
- **THEN** the job does not survive, regardless of how long it was configured to run
