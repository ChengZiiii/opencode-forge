# Design: sync-timeout-notify

## Context

Root cause (code-verified, 2026-11-15 incident): the sync dispatch path
polls the child for 600000 ms (`DEFAULT_POLL_TIMEOUT_MS`, hardcoded) and
on expiry throws the honest timeout finding WITHOUT arming anything —
no dispatch registry entry, no completion poller. The wake engine
(`[forge:dispatch-complete]` via promptAsync) is driven exclusively by
the registry that only the async branch populates. Any sync dispatch
whose child outlives the window therefore orphans its result: the child
completes (it is a real host session), nobody is listening, the primary
never learns the outcome. Observed boundary condition matches exactly:
sync under 10 min returns normally; sync over 10 min loses the callback.

## Goals / Non-Goals

- Goals: (1) timed-out sync dispatches self-heal — completion tracking
  armed, exactly one wake with the final report; (2) the timeout finding
  stays honest and stays a throw; (3) the window becomes tunable.
- Non-Goals: no auto-convert of the call semantics (the tool result
  remains the timeout error; the model still must not wait in place);
  no change to async-path behavior, cap semantics for NEW dispatches,
  wake discipline, or draft interop.

## Decisions

1. **Arm, don't abandon** — the child is already running; registering it
   for tracking is pure benefit at zero cost. The alternative (document
   "poll manually / check the TUI") pushes recovery work onto the model
   and failed in production.
2. **Throw stays** — the calling turn must learn the window expired
   (its next step depended on the result). The finding text changes from
   "No auto-convert to async happened" to a disclosure that the wake is
   armed and will carry the report.
3. **Cap bypass for arming** — the cap (3) guards the async dispatch
   DECISION at call time; a timed-out sync's child is already running
   regardless of the cap, so refusing to track it would change nothing
   except guaranteeing the result is lost. Arming is unconditional.
4. **Env knob `FORGE_DISPATCH_POLL_TIMEOUT_MS`** — parity with the
   existing `FORGE_DISPATCH_POLL_INTERVAL_MS`; also enables a fast
   minimal repro (short timeout + sleeper child) for acceptance.
5. **Soundness: fail toward waiting on unreadable signals** (folded,
   production-observed, then empirically corrected): the poller's fatal
   line was `active = statusMap !== undefined && isActiveStatus(...)`:
   any status fetch failure counted as "not active", and one observation
   terminated the poll. Fix: (a) a fetch FAILURE is treated as ACTIVE;
   (b) a session MISSING from a successfully fetched map is the host's
   idle signal — LIVE-PROBED on host 1.19.5 mid-change: `GET
   /session/status` returns only currently-active sessions and a
   completed session is REMOVED, so missing = not-active (the contract's
   first guess, "missing = active", would have made completions
   undetectable — the live repro caught it before release); (c) terminal
   completion requires the not-active + finished condition stable across
   TERMINAL_STABILITY_TICKS = 3 consecutive ticks (any active reading
   resets the run) — this is what kills the texture-forge receipt bug: a
   running child that blinks out of the map for a tick or two looks like
   a candidate, but it re-appears busy and resets before a stale receipt
   could reach depth; (d) the finished message must carry a truthy
   `finish` AND non-empty text parts. A genuinely idle child with no
   usable final message ends as the honest timeout (armed wake covers
   it). The async wake path shares the poller and inherits the fix.

## Risks / Trade-offs

- A timed-out sync's child was created with the sync question policy
  (questions available); it keeps that policy after arming — policy is
  mode-keyed at creation (task-shadow D3), unchanged.
- Wake load: each timed-out sync adds one registry entry; bounded by how
  often syncs exceed 10 minutes — rare, and owner-death harvest already
  bounds leaks.

## Migration Plan

Pure plugin change: arm on timeout + message wording + env knob + tests.
No config or data migration. Released as 0.23.1.

## Open Questions

- None. The minimal repro is settled: `FORGE_DISPATCH_POLL_TIMEOUT_MS`
  low + a sleeper child — timeout at the window, wake at child
  completion.
