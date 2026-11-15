# Proposal: sync-timeout-notify

## Why

Production-observed (2026-11-15, texture-forge crew session): two parallel
sync `task` dispatches outlived the 600s poll window, both returned the
honest timeout finding — and the children kept running and COMPLETED
(files landed 20:09–20:31, TUI-visible), but **zero
`[forge:dispatch-complete]` wakes ever arrived**. Control group: sync
dispatches finishing within the window returned normally. Boundary
condition isolated: any sync dispatch whose child outlives the poll
timeout loses its result — the timeout path throws without arming the
completion tracking (`plugin.ts` sync branch registers nothing; the wake
engine is driven exclusively by the dispatch registry that only the
async branch populates). The result is an orphaned child and a primary
that never learns the outcome — crew waves stall on idle nudges alone.

## What Changes

- On sync poll timeout, the plugin SHALL arm the standard completion
  tracking (dispatch registry entry + completion poller) for the
  already-running child before returning the timeout finding, so exactly
  one `[forge:dispatch-complete]` wake carries the child's final report
  when it eventually completes. The timeout finding stays a throw (the
  caller still must not wait in place) but its text now discloses the
  armed wake. The arming bypasses the async concurrency cap: the cap
  governs new async dispatch decisions, not the reality of an
  already-running child.
- The poll timeout becomes tunable via `FORGE_DISPATCH_POLL_TIMEOUT_MS`
  (currently a hardcoded 600000 constant; only the interval is
  env-tunable today). Default unchanged.
- No auto-convert of the call semantics: the tool result remains the
  timeout error (the dependency structure did not change); only the
  notification is armed.
- **Terminal-inference soundness** (production-observed 2026-11-15,
  texture-forge crew session, folded into this change): the poller
  declared false completions on transient non-active readings — a status
  fetch failure (`statusMap === undefined`) counted as "not active", and
  a single observation was enough to terminate. Three bad verdicts in
  one evening: receipt-only completions (a finished acknowledgement
  message mistaken for the final report while the child kept running),
  and "no assistant text output found" errors on children that were
  alive and working. The poller SHALL fail toward "keep waiting": a
  status fetch failure or a session missing from a fetched status map
  SHALL be treated as ACTIVE; a terminal completed verdict SHALL require
  the non-active + finished-latest-assistant condition to hold stable
  across consecutive poll ticks (resetting if the session turns busy
  again); the finished message SHALL carry a truthy `finish` and non-empty
  text parts, otherwise the poller SHALL keep polling (an idle child
  with no usable final message ends as the honest timeout, which the
  armed wake then covers). The async wake path shares the poller and
  inherits the same soundness.

## Impact

- Spec: `forge-subagents` (MODIFIED "Dispatch lifecycle (wake, cap,
  harvest)" — the sync-timeout scenario gains the armed wake; the
  requirement text gains the arming + env knob SHALLs).
- Code: `plugin.ts` sync-timeout path (arm + message), `src/dispatch-async.ts`
  (timeout env knob), tests (arming produces exactly one wake after
  timeout; cap bypass; env knob), README (timeout section + env knob
  row).
- Users: a timed-out sync dispatch now self-heals — the primary gets the
  report via wake instead of losing it.
