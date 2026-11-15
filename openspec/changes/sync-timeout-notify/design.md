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

Second incident (folded, 2026-11-16): the ASYNC poller itself breaks on
its own 600s deadline and emits the timeout text AS the terminal wake —
consuming the at-most-once completion budget. texture-forge 补完轮 W1
on host 0.23.2, DB- and status-probe-verified: K3 finished ~21 min after
its deadline (poller gone, zero report), K2 same shape, K1b finished
within a stability window of the deadline and lost the race (full final
report retrievable in the child session, never delivered), K1a (inside
the window) succeeded. The deadline cannot remain a termination
condition at all.

## Goals / Non-Goals

- Goals: (1) timed-out sync dispatches self-heal — completion tracking
  armed, exactly one wake with the final report; (2) the timeout finding
  stays honest and stays a throw; (3) the window becomes tunable;
  (4) async/sync-armed tracking never terminates on a wall-clock
  deadline — long children get their report wake at true terminal, with
  non-terminal progress notices keeping the owner informed meanwhile.
- Non-Goals: no auto-convert of the call semantics (the tool result
  remains the timeout error; the model still must not wait in place);
  no change to cap semantics for NEW dispatches, to the terminal wake
  discipline (idle-only, at-most-once, delivery window), or to draft
  interop; no auto-abort of stalled children (the owner decides via
  notices); no event-driven completion path (the poller's tick latency
  is already seconds).

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
   usable final message terminates via the textless-idle floor (below),
   not via a wall clock. The async wake path shares the poller and
   inherits the fix.
6. **Never-die tracking + FINAL/PROGRESS separation** (folded after the
   omo study): the async/sync-armed poller drops its deadline break —
   the loop ends only on completed, error, registry kill, owner death,
   or the textless-idle floor. A child that is RUNNING (active in the
   status map) is never terminated, whatever the clock says. Past the
   notification interval (`FORGE_DISPATCH_NOTIFY_INTERVAL_MS`, default
   600000 ms — the same wall clock the sync wait uses by default,
   tunable independently; the sync-wait knob keeps scoping the sync
   wait only), the poller appends a `[forge:dispatch-progress]` notice
   to the job tail and parks it on a plugin-side pending-progress queue
   flushed on owner idle edges (D6 parity: enqueue-while-idle delivers
   immediately; progress delivery is lossy and failure-tolerant — the
   terminal wake is the guarantee). Progress notices never touch
   `markTerminal`/`wakeState`, so the terminal once-budget is intact.
   Textless-idle floor: a child continuously not-active (missing from
   the map) for a full notification interval whose latest finished
   assistant message still lacks a truthy `finish` or non-empty text
   ends honestly as a no-reportable-final-message finding; any busy
   reading resets the streak (a running child can never reach it). This
   bounds the pathological cases (TUI-aborted child, session purged)
   without any dispatch-anchored wall clock. omo (oh-my-openagent)
   background-agent comparison: completion = dual-signal (session.idle
   event + 10s stability) with NO deadline-terminate; stale handling is
   ACTIVITY-based (45 min) with abort + final notification; the wake
   queue separates FINAL from PROGRESS with final-priority merge;
   dedupe by coverage, not once-per-lifetime. Adopted: never-die
   tracking, FINAL/PROGRESS separation, bounded floor on truly-gone
   children. Rejected: event-driven completion (poll tick latency is
   already seconds — a second detection path buys little), stale
   auto-abort (destructive; the owner decides via visible notices),
   merge-queue machinery (separate channels make it unnecessary).

## Risks / Trade-offs

- A timed-out sync's child was created with the sync question policy
  (questions available); it keeps that policy after arming — policy is
  mode-keyed at creation (task-shadow D3), unchanged.
- Wake load: each timed-out sync adds one registry entry; bounded by how
  often syncs exceed 10 minutes — rare, and owner-death harvest already
  bounds leaks.
- Indefinite tracking: a child that never reaches terminal truth (e.g.
  hung on a headless permission ask) keeps its registry entry and poller
  alive indefinitely — bounded by the owner session lifecycle (owner
  death harvests), and the progress notices make the stall VISIBLE so
  the owner can abort. Auto-abort was considered and rejected
  (destructive).
- Notice cadence: one notice per notification interval per dispatch —
  at most one per ~10 min per child; idle-only injection. Negligible.

## Migration Plan

Pure plugin change: arm on timeout + message wording + env knob + tests.
No config or data migration. Released as 0.23.1 (folds 1-2: soundness
0.23.2; never-die tracking + progress notices 0.23.3).

## Open Questions

- None. The minimal repro is settled: `FORGE_DISPATCH_POLL_TIMEOUT_MS`
  low + a sleeper child — timeout at the window, wake at child
  completion.
