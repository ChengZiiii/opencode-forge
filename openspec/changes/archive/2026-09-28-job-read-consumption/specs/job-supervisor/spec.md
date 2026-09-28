# job-supervisor delta — job-read-consumption

## MODIFIED Requirements

### Requirement: Terminal-evidence self-cleanup

A foreground `forge_shell` invocation that resolves on the exit event delivers the job's complete output to the caller synchronously; that return is **terminal evidence** and the job has no residual registry value. The same holds for **deferred consumption**: the first `poll` that observes a job's terminal state delivers the exit status and drains the output — that observation consumes the completion. A consumed job SHALL be removed from the session's job registry at the moment of consumption — the model-facing list SHALL NOT show it, no manual `clear` SHALL be required, and any completion wake queued for it SHALL NOT be delivered. Only `poll` consumes a completion; `list` and `log` do not assert terminal state. A follow-up `poll`, `log`, or `kill` on a consumed job id SHALL fail with an error that names the job as already consumed (output delivered with the original return or the terminal poll). On-disk log retention and rotation SHALL be unaffected by self-cleanup.

#### Scenario: A fire-and-forget command leaves no registry litter

- **WHEN** a foreground command exits within the wait budget, so `forge_shell` returns the full output on the exit event, and the job completes normally
- **THEN** the job is removed from the registry at completion, `forge_jobs list` does not show it, and no `clear` call is needed

#### Scenario: A polled background job consumes itself

- **WHEN** a background job exits and the model then polls it, observing the terminal state and receiving the exit status and drained output
- **THEN** the entry leaves the registry at that poll, no completion wake is delivered for it, and no `clear` call is needed

#### Scenario: A stale id is reported honestly

- **WHEN** the model polls, kills, or clears a job id that was consumed — by synchronous delivery or by a terminal poll
- **THEN** the verb fails with an error naming the job as already consumed, not as unknown-and-lost

#### Scenario: List and log do not consume

- **WHEN** the model runs `forge_jobs list` or pages a finished job's log with `log`, without ever polling the job
- **THEN** the entry stays listed and its queued completion wake still fires normally

#### Scenario: Early-return jobs keep their registry presence

- **WHEN** a command returned `still-running` (idle or max-wait) or was started with `run_in_background`, and its completion has not been observed by any poll
- **THEN** the finished job remains listed for `poll`/`log`/`clear` exactly as before

### Requirement: Completion wake injection

When a job exits, the plugin SHALL inject at most one synthetic completion message (exit code plus a bounded output tail) into the job's owning session via the host's message-sending API — EXCEPT for consumed completions: terminal-evidence jobs, whose foreground invocation already resolved on the exit event and delivered the complete output inline, and poll-read jobs, whose terminal state a poll has already observed and reported; neither SHALL inject a completion wake. A wake therefore fires only for a completion the caller has never read. Injection SHALL occur only while the owning session is idle; if the session does not become idle within a delivery window, the completion SHALL be recorded in the diagnostics ledger instead of remaining queued forever. A per-call `notify: false` SHALL suppress the wake for that job.

#### Scenario: Background job wakes an idle session once

- **WHEN** a background job with default notify exits, was never polled (or was last polled while still running), and its owning session is idle
- **THEN** exactly one completion message is delivered to that session, containing the exit code and output tail

#### Scenario: A synchronously consumed command does not wake

- **WHEN** a foreground command resolves on the exit event — the caller received the complete output in the same call — and the session later idles
- **THEN** no completion message is injected for that job

#### Scenario: A polled completion does not wake

- **WHEN** a background job is polled after exit — the poll returned the terminal state and the drained output — and the session later idles
- **THEN** no completion message is injected for that job (the completion was already delivered by the poll)

#### Scenario: A completion arriving during idle is pushed immediately

- **WHEN** a job completes while its owning session is already idle — the turn that started it has ended, no poll will follow, and no further idle transition is pending
- **THEN** the queued completion is delivered at completion time, without waiting for a subsequent idle edge or the delivery window

#### Scenario: An early-returned job still wakes

- **WHEN** a command returned `still-running` on the idle condition and exits afterwards while the owning session is idle
- **THEN** exactly one completion message is delivered to that session

#### Scenario: Busy session defers, ledger catches the overflow

- **WHEN** a job exits while its owning session stays busy past the delivery window
- **THEN** no message is injected and the completion is recorded in the diagnostics ledger
