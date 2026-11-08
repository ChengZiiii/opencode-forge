# crew-harness Delta — crew-autonomous-waves

## ADDED Requirements

### Requirement: Waves-armed crews auto-advance on session idle

The plugin's idle-continuation engine SHALL extend to waves-armed crews: when a session goes idle, no live active goal governs it, and the session's registered crew is in the EXECUTING mode (armed for waves), the engine SHALL (after the shared debounce) send the session a `[forge:crew-continue]` continuation brief carrying the crew objective, the declared subtask titles, and the wave discipline (dispatch the next wave via parallel task calls, collect per-subtask evidence verdicts, at most one retry, then `crew_close` with the full report). The engine SHALL NOT continue a crew in any other state: a PENDING crew is the user's execution-mode decision seam and is never auto-continued; a crew governed by a live active goal is driven by the goal engine's turns (no second brief); an ended crew (closed, abandoned, or converted) never continues. The continuation SHALL pass the shared guard plumbing — plugin-disable knob, debounce, in-flight claim, forge-family gate at schedule AND send time (a session switched to a non-forge agent is never continued), and a busy-recheck immediately before send — and SHALL stop after repeated transport failures (bounded, disclosed). A crew continuation turn with ZERO dispatch/write activity increments a no-progress streak; at the streak limit the engine SHALL stop sending crew continuations for that crew and disclose once (bounded console note) that it stalled — the crew itself stays registered: no auto-abandon, no auto-close, the user stays in charge. Task dispatches during a crew continuation turn SHALL count as activity (the crew engine keeps its own activity counter; the goal engine's no-progress semantics are untouched). No disk state is added: the crew record on disk is unchanged and the engine state is in-memory.

#### Scenario: Idle between waves sends the continue brief

- **WHEN** a waves-armed crew is EXECUTING, the session has gone idle after a wave's results, and no live active goal governs the session
- **THEN** after the debounce the engine sends one `[forge:crew-continue]` brief carrying the crew objective and the declared subtask titles, and the session proceeds with the next wave

#### Scenario: A closed or abandoned crew never continues

- **WHEN** the session's crew has ended (crew_close report or abandon, or goal conversion) and the session goes idle
- **THEN** no crew continuation brief is sent — the engine's crew branch finds no EXECUTING crew

#### Scenario: A pending crew is never auto-continued

- **WHEN** the session's crew is PENDING (registered, not armed) and the session goes idle
- **THEN** no crew continuation is sent — the execution-mode pause is the user's decision seam, and the pending dispatch belt still refuses task calls

#### Scenario: A goal-governed session is owned by the goal engine

- **WHEN** a live active goal governs the session (including a goal-delegated born-armed crew)
- **THEN** idle continuation follows the goal engine exclusively — no `[forge:crew-continue]` brief is ever sent alongside or instead of the goal brief

#### Scenario: A non-forge speaker is never continued

- **WHEN** the session's running agent has switched away from the forge family (at schedule time or send time) while a crew is EXECUTING
- **THEN** no crew continuation is sent — the family gate holds for the crew branch exactly as for the goal branch

#### Scenario: A stalled crew stops the engine, not the crew

- **WHEN** consecutive crew continuation turns produce zero dispatch/write activity up to the streak limit
- **THEN** the engine stops sending crew continuations and discloses the stall once (bounded console note) — the crew stays registered (no auto-abandon, no auto-close), and the user may nudge, crew_close, or abandon

#### Scenario: Task dispatches count as crew-turn activity

- **WHEN** a crew continuation turn dispatches task calls (waves) but performs no writes or checks
- **THEN** the turn counts as active — the no-progress streak resets and the engine keeps advancing the crew
