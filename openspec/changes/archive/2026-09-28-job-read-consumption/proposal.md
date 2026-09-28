# job-read-consumption

## Why

Live cross-machine evidence (0.8.0, second install): a background job polled to completion still fires its completion wake afterwards — the model itself judged the wake "没有新信息" — and then must manually clear the entry. The completion was consumed by the poll; the wake is a duplicate and the retained entry serves nobody. OMO-slim implements exactly this suppression ("a queued wake would double-notify"). job-terminal-evidence fixed the inline case (exit-event delivery); this closes the deferred case: a poll that observes the terminal state is consumption just the same. The wake then fires only for completions never read by anyone — its entire reason to exist.

## What Changes

- **job-supervisor (2 MODIFIED)**:
  - Terminal-evidence self-cleanup: extended to deferred consumption — the first `poll` that observes a job's terminal state consumes the completion: any queued wake is dropped, the entry self-clears, and stale verb ids answer "already consumed". Only `poll` consumes (`list` and `log` do not assert state).
  - Completion wake injection: wakes fire only for completions never read by the caller — background/early-returned jobs that were never polled (or last polled while still running), whose completion then arrives unread.
- **Code**: `src/job-manager.ts` `poll()` — terminal observation consumes (one site; the stale-id and stale-wake machinery from job-terminal-evidence already covers the rest).
- **Docs**: README completion-behavior table + Exit wakes paragraph + forge_jobs poll description clause.

## Impact

- Specs: job-supervisor (2 MODIFIED)
- Code: src/job-manager.ts (poll), plugin.ts (one description clause)
- Tests: job-manager, job-wiring (background-polled → no wake; background-unread → wake)
- E2E: job-wake-e2e phase B rewritten to the canonical unread-notification scenario (start background, do NOT poll, idle → exactly one wake)
