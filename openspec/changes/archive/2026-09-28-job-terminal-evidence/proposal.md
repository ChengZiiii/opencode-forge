# job-terminal-evidence

## Why

Every forge_shell invocation that resolves on the exit event delivers its complete output to the caller synchronously — and then, when the job's terminal state settles moments later, the completion wake fires anyway. The wake is a pure duplicate: the session already saw the full output. Real-world exposure (2026-09-28 session): ~40 short probe jobs produced ~40 wake turns plus ~40 manual `clear` turns — two wasted turns per probe. OMO converged on the same fix from two implementations: upstream's background-task manager suppresses notification for sync-waited sessions ("A sync waiter is still polling this session"), and oh-my-opencode-slim's terminal gate states the rule outright — "A foreground run's synchronous native terminal return is itself terminal evidence — the host call bound to this exact run has already come back… Background runs never qualify." Upstream additionally auto-clears consumed tasks (10-min TTL into a capped archive); slim retains for reuse. Our jobs have no reusable session behind them, so the consumed entry has zero residual value: clear it immediately.

## What Changes

- **job-supervisor (MODIFIED + ADDED)**:
  - Completion wake injection: a job whose foreground invocation already resolved on the exit event is terminal-evidence-consumed — no completion wake for it. Wakes are unchanged for background-started jobs, idle/max-wait early returns, and success-pattern returns.
  - New requirement: terminal-evidence self-cleanup — a consumed job is removed from the registry at completion (fire-and-forget); poll/kill/clear on such an id reports it honestly as already consumed; on-disk log retention is unchanged.
- **Code**: job-runner stamps how the caller last saw the job (exit-event resolution = terminal evidence); job-manager skips wake scheduling and removes the registry entry at completion for those jobs; forge_jobs verbs return a self-describing "already consumed" error for stale ids.
- **README**: the forge_shell return-form table gains a "what happens on completion" column.

## Impact

- Specs: job-supervisor (1 MODIFIED, 1 ADDED)
- Code: src/job-runner.ts, src/job-manager.ts (plugin wiring unchanged or minimal)
- Tests: job-runner, job-manager, job-wiring
- Docs: README.md
- E2E: positive path only (background job still wakes an idle session); suppression is asserted at unit level
