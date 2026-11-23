# crew-continue-native-child-gate — delta

## MODIFIED Requirements

### Requirement: Waves-armed crews auto-advance on session idle

The plugin's idle-continuation engine SHALL extend to waves-armed crews: when a session goes idle, no live active goal governs it, and the session's registered crew is in the EXECUTING mode (armed for waves), the engine SHALL (after the shared debounce) send the session a `[forge:crew-continue]` continuation brief carrying the crew objective, the declared subtask titles, and the wave discipline (dispatch the next wave via parallel task calls, collect per-subtask evidence verdicts, at most one retry, then `crew_close` with the full report). The engine SHALL NOT continue a crew in any other state: a PENDING crew is the user's execution-mode decision seam and is never auto-continued; a crew governed by a live active goal is driven by the goal engine's turns (no second brief); an ended crew (closed, abandoned, or converted) never continues. The continuation SHALL pass the shared guard plumbing — plugin-disable knob, debounce, in-flight claim, forge-family gate at schedule AND send time (a session switched to a non-forge agent is never continued), and a busy-recheck immediately before send — and SHALL stop after repeated transport failures (bounded, disclosed). A crew continuation turn with ZERO dispatch/write activity increments a no-progress streak; at the streak limit the engine SHALL stop sending crew continuations for that crew and disclose once (bounded console note) that it stalled — the crew itself stays registered: no auto-abandon, no auto-close, the user stays in charge. Task dispatches during a crew continuation turn SHALL count as activity (the crew engine keeps its own activity counter; the goal engine's no-progress semantics are untouched). No disk state is added: the crew record on disk is unchanged and the engine state is in-memory.

The engine SHALL additionally hold a native in-flight gate: while ANY session whose `parentID` equals the orchestrator session id is present in the host's active/busy status view (non-idle, non-terminal) — a host-native task/subagent child, invisible to the plugin's own dispatch registry — the idle continuation brief SHALL be suppressed. The gate SHALL be decided by a decision-time session-tree walk (session list filtered by parent link, cross-read against the host's active/status map) taken at the moment of the continuation decision; an event-fed tracker (session-created marks a child, terminal execution/status edges terminalize with their outcome recorded, session deletion drops) MAY keep the set warm and MAY re-arm the idle continuation when the last native child of a recently suppressed session goes terminal, but on any disagreement the walk is authoritative. The re-armed brief SHALL carry a one-line native-child digest naming each child session the gate held the crew on that has since left the in-flight view, and its outcome (succeeded / failed / interrupted), read from the child's own session row — the walk is the single authority for the digest exactly as for the gate, so a child created before the crew was armed, or whose terminal event never reached the plugin, is named no less than one the tracker saw; a child whose row is gone or carries no outcome (deleted mid-run) SHALL be disclosed as unverified rather than given a verdict, and no child SHALL be named twice. A child that died ABORTED (interrupted) is surfaced to the orchestrator the moment the plugin knows, so a dead wave child never silently strands the crew (the abort itself is host/harness territory the plugin cannot prevent; the guarantee is detection, wake, and disclosure). The gate SHALL fail OPEN: an unreadable session list or status view is treated as no children in flight and the brief is sent (a false in-flight strands the crew; a false idle costs one redundant brief). Suppression SHALL be bounded by a wall-clock ceiling (default 900000 ms): once suppression for a crew registration persists past the ceiling, the engine SHALL stop suppressing for that registration, send the brief once, and disclose once via a bounded console note; a fresh `crew_begin` clears the ceiling marker. While the gate holds a crew, a bounded re-check SHALL re-walk the view on an interval and schedule the shared continuation once no child is in flight or the ceiling has passed, so the resume never depends on a further idle edge or on an event reaching the plugin (the scheduled continuation re-runs the full guard chain). The busy-recheck immediately before send SHALL also hold on hosts whose session adapter exposes no per-session status surface: the orchestrator's own entry in the active/status map is read instead, and a brief is never injected into a session that is mid-turn; an unreadable map leaves the prior behavior unchanged. A suppressed nudge is NOT a turn: it accrues no no-progress streak, no transport-failure count, and no crew ledger effect — the gate is evaluated before the crew-turn accounting. Gate state SHALL be in-memory only (zero disk state) and SHALL be evicted with the rest of the crew engine state when the session ends. The goal branch of the idle-continuation engine is unchanged by this gate.

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

#### Scenario: A busy native child suppresses the brief without touching the streak

- **WHEN** a waves-armed crew is EXECUTING, the orchestrator session is idle, and a host-native child session (parentID = the orchestrator's session id, dispatched through the native task/subagent channel) is present in the host's active/busy status view
- **THEN** zero `[forge:crew-continue]` briefs are sent while the child stays non-idle/non-terminal, and the suppression is not a turn: the no-progress streak, transport-failure count, and crew ledger are untouched

#### Scenario: Last native child terminal re-arms exactly one brief

- **WHEN** the gate has been suppressing briefs for a session and its last non-terminal native child reaches a terminal state (terminal execution/status event, or absence from the active/status map at walk time)
- **THEN** after the shared debounce the engine sends exactly one `[forge:crew-continue]` brief — the re-arm fires once, not once per suppressed idle edge

#### Scenario: An aborted native child wakes the crew with its outcome

- **WHEN** a native child of a waves-armed orchestrator reaches a terminal state with outcome `interrupted` (aborted out from under the wave — e.g. its dispatch handle timed out) while the gate had been suppressing
- **THEN** the re-arm fires promptly and the brief carries a one-line digest naming the child session and its interrupted outcome — the orchestrator learns the child is dead the moment the plugin does, and no dead wave child silently strands the crew

#### Scenario: A child created before the crew was armed is still named

- **WHEN** a native child of the orchestrator is already running when the crew is armed (the fresh registration wipes the advisory tracker's rows) and the gate then holds the crew on that child
- **THEN** when the child settles, the next brief carries its digest line with the outcome read from its session row — the tracker's ignorance of the child changes nothing

#### Scenario: A lost event stream changes nothing

- **WHEN** no terminal event for a held child reaches the plugin (volatile stream) and the child has settled in the host view
- **THEN** the next continuation decision's walk names the child with its row outcome in the brief digest, exactly once — and the terminal event and the walk observing the same child never name it twice

#### Scenario: A child that vanishes mid-run never strands the crew

- **WHEN** the gate is holding a crew on a native child and that child's session is deleted mid-run, so no terminal edge arrives and the host produces no further idle edge for the orchestrator
- **THEN** the suppression re-check observes the child gone and resumes the crew without any further idle edge (bounded by the re-check interval plus the debounce), and the brief names the child as unverified — no outcome is invented for a row that no longer exists

#### Scenario: No brief is injected into a busy orchestrator

- **WHEN** a continuation decision runs on a host whose session adapter carries no per-session status surface and the orchestrator session is itself present in the active/status map (mid-turn)
- **THEN** no brief is sent for that decision, and the brief lands on the session's next idle edge

#### Scenario: The ceiling is evaluated without an idle edge

- **WHEN** suppression for a registration persists past the ceiling while the orchestrator produces no further idle edge
- **THEN** the suppression re-check schedules the continuation, the engine stops suppressing for that registration, sends the brief, and discloses once

#### Scenario: Suppression past the ceiling sends once with a bounded disclosure

- **WHEN** continuous suppression for one crew registration persists past the native-child ceiling (default 900000 ms) while a child still appears non-terminal
- **THEN** the engine stops suppressing for that registration, sends the brief once, and discloses once via a bounded console note naming the ceiling — a fresh `crew_begin` clears the marker and re-arms normal gating

#### Scenario: An unreadable status view fails open

- **WHEN** the continuation decision runs and the session list or the active/status map read fails or returns an unreadable shape while a native child is actually running
- **THEN** the gate treats the view as no children in flight and the brief is sent — the fail-open polarity trades one redundant brief against never stranding the crew

#### Scenario: Session deletion evicts the gate state

- **WHEN** a session carrying native-child gate state (tracker entries, the walked watch set, ceiling marker, pending digest, any armed re-check) is deleted (session.deleted) or otherwise forgotten by the crew engine
- **THEN** the gate state for that session is evicted with the rest of the crew engine state — no disk state is written, and a later crew in a new session starts with a clean gate
