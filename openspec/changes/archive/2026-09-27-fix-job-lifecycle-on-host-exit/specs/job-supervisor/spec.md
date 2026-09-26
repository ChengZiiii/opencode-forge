## MODIFIED Requirements

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

## ADDED Requirements

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
