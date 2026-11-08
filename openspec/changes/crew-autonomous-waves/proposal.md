# Proposal: crew-autonomous-waves

## Why

A waves-armed crew (no governing goal) advances only while the session keeps producing turns: when the
session goes idle between waves, NOTHING restarts it — the user must nudge "continue" per wave. The goal
harness already solved this exact problem (session.idle → debounce → guard chain → continuation brief);
the crew harness re-registers the plan, arms waves, then stalls on every idle. Overnight/long crews are
impossible without the user babysitting each wave.

## What Changes

- The idle-continuation engine gains a CREW branch: when a session goes idle, no live active goal governs
  it, and the session's crew is EXECUTING (waves-armed), the engine sends a
  `[forge:crew-continue]` brief that carries the crew objective, the declared subtask titles, and the wave
  discipline (dispatch next wave → collect verdicts → crew_close when every subtask has one).
- Guards reused from the goal engine's plumbing: plugin-disable knob, debounce, in-flight claim,
  forge-family gate at schedule AND send time, idle re-check before send, transport-failure cap.
- Crew-specific stop conditions: the crew ends (close/abandon/convert — map eviction) → no continuation;
  PENDING crews are NEVER auto-continued (that pause is the user's decision seam); a session governed by a
  live active goal is owned by the GOAL engine (no double-briefing — the crew under a goal is already
  driven by goal turns).
- No-progress stall guard: a crew continuation turn with zero dispatch/write activity increments a streak;
  at the limit the engine STOPS continuing (bounded console disclosure — the crew stays registered and the
  user stays in charge; no auto-abandon, no auto-close). Task dispatches COUNT as activity for crew turns
  (separate counter — goal no-progress semantics untouched).
- No budgets, no ledger files, no new state on disk: the crew record on disk is unchanged; the engine state
  is in-memory beside the goal engine's.

## Capabilities

**Modified Capabilities:**

- `crew-harness` — ADDED requirement "Waves-armed crews auto-advance on session idle" (7 scenarios). No
  existing requirement text changes: the execution-mode gate, pending belt, and close gate are untouched.

## Impact

- `plugin.ts` — `continueIfEligible` gains the crew branch (after the live-goal check fails); a
  `crewContinueBrief` builder; crew-side no-progress/transport counters; `tool.execute.after` counts task
  dispatches into a crew activity counter; crew close/abandon/convert paths already evict the map entry.
- `tests/goal-mode.test.mjs` or a new `tests/crew-continue.test.mjs` — stub-client coverage: idle+executing
  crew → brief sent with objective+subtasks; closed crew → nothing; pending → nothing; goal-governed →
  goal engine only; non-forge speaker → nothing; no-progress streak → engine stops with disclosure; task
  dispatch resets the streak.
- `README.md` — crew section: waves-armed crews auto-advance on idle; the stall guard behavior.
- `dist/index.js` — rebuilt (standing red line).
- The `/crew` template's "supervised waves" wording gains one clause: waves auto-advance on idle until
  crew_close (or stall).
