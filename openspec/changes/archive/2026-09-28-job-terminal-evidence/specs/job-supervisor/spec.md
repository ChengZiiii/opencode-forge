# job-supervisor delta — job-terminal-evidence

## ADDED Requirements

### Requirement: Terminal-evidence self-cleanup

A foreground `forge_shell` invocation that resolves on the exit event delivers the job's complete output to the caller synchronously; that return is **terminal evidence** and the job has no residual registry value. Such a job SHALL be removed from the session's job registry at completion — the model-facing list SHALL NOT show it and no manual `clear` SHALL be required. A follow-up `poll`, `log`, or `kill` on a self-cleared job id SHALL fail with an error that names the job as already consumed (output delivered with the original return). Jobs that returned before completion — `still-running`, `success` with a kept-alive process, or `run_in_background` starts — SHALL follow the existing retention semantics: they remain listed until explicitly cleared or evicted. On-disk log retention and rotation SHALL be unaffected by self-cleanup.

#### Scenario: A fire-and-forget command leaves no registry litter

- **WHEN** a foreground command exits within the wait budget, so `forge_shell` returns the full output on the exit event, and the job completes normally
- **THEN** the job is removed from the registry at completion, `forge_jobs list` does not show it, and no `clear` call is needed

#### Scenario: A stale id is reported honestly

- **WHEN** the model polls, kills, or clears a job id that was self-cleared after synchronous delivery
- **THEN** the verb fails with an error naming the job as already consumed (output delivered with the original return), not as unknown-and-lost

#### Scenario: Early-return jobs keep their registry presence

- **WHEN** a command returned `still-running` (idle or max-wait) or was started with `run_in_background`
- **THEN** the finished job remains listed for `poll`/`log`/`clear` exactly as before

## MODIFIED Requirements

### Requirement: Completion wake injection

When a job exits, the plugin SHALL inject at most one synthetic completion message (exit code plus a bounded output tail) into the job's owning session via the host's message-sending API — EXCEPT for terminal-evidence jobs, whose foreground invocation already resolved on the exit event and delivered the complete output inline: such jobs SHALL NOT inject a completion wake. Injection SHALL occur only while the owning session is idle; if the session does not become idle within a delivery window, the completion SHALL be recorded in the diagnostics ledger instead of remaining queued forever. A per-call `notify: false` SHALL suppress the wake for that job. Wakes SHALL be delivered for jobs the caller last saw before completion: background starts, `still-running` early returns, and `success` returns with a kept-alive process.

#### Scenario: Background job wakes an idle session once

- **WHEN** a background job with default notify exits while its owning session is idle
- **THEN** exactly one completion message is delivered to that session, containing the exit code and output tail

#### Scenario: A synchronously consumed command does not wake

- **WHEN** a foreground command resolves on the exit event — the caller received the complete output in the same call — and the session later idles
- **THEN** no completion message is injected for that job

#### Scenario: An early-returned job still wakes

- **WHEN** a command returned `still-running` on the idle condition and exits afterwards while the owning session is idle
- **THEN** exactly one completion message is delivered to that session

#### Scenario: Busy session defers, ledger catches the overflow

- **WHEN** a job exits while its owning session stays busy past the delivery window
- **THEN** no message is injected and the completion is recorded in the diagnostics ledger
