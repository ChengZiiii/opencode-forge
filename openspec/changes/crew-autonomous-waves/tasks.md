# Tasks — crew-autonomous-waves

- [x] 1. Engine crew branch (`plugin.ts`)
  - [x] 1.1 In `continueIfEligible`, after the live-active-goal ownership check returns no goal, add the crew branch: `crews.get(sessionID)` with `mode === "executing"` → send the crew continuation brief (D2 text: objective + declared subtask titles + wave discipline + abandon exit); every other state returns without sending
  - [x] 1.2 Reuse the shared guards for the crew branch: send-time forge-family re-check, idle busy re-check before send, transport-failure map + cap (stop after repeated failures); never touch goal ledger files, `pendingContinuationTurn`, or `turnActivity`
  - [x] 1.3 Crew-side activity counters (D3): `crewTurnActivity` reset per crew continuation send; `tool.execute.after` counts `task` dispatches and write-family calls into it; `crewNoProgress` streak with limit 3 → `crewStalled` set + ONE bounded console disclosure; any activity resets; `crewStalled` cleared on fresh crew registration
  - [x] 1.4 Hygiene (D4): `session.deleted` evicts the crew-side engine maps; verify close/abandon/convert evicts the `crews` entry (add eviction + test if missing)
  - [x] 1.5 Wording (D5): `/crew` template waves choice, `crew_begin {execution: "waves"}` arming output, and the goal-delegated one-call text each gain the auto-advance clause

- [x] 2. Tests (`tests/crew-continue.test.mjs` or extend `tests/goal-mode.test.mjs` — stub-client pattern, `FORGE_GOAL_DEBOUNCE_MS=10` before importing plugin.ts)
  - [x] 2.1 Idle + EXECUTING crew + no live goal → exactly one `[forge:crew-continue]` brief, carrying objective and every declared subtask title
  - [x] 2.2 Closed/abandoned crew → no brief; PENDING crew → no brief; goal-governed session → goal brief only (no crew brief)
  - [x] 2.3 Non-forge speaker at schedule or send → no brief
  - [x] 2.4 Stall: 3 consecutive activity-free crew turns → engine stops + one disclosure; a turn WITH a task dispatch resets the streak; fresh `crew_begin` clears `crewStalled`
  - [x] 2.5 `session.deleted` evicts crew engine state; crew close/abandon evicts the `crews` entry

- [x] 3. README + verification gates
  - [x] 3.1 README crew section: waves auto-advance on idle until crew_close; the stall guard stops the engine (never the crew) after 3 activity-free turns
  - [x] 3.2 `bun run typecheck` — clean
  - [x] 3.3 `node --test tests/*.test.mjs` — full suite green (448 baseline + new, zero regressions)
  - [x] 3.4 `bun run bundle` + `npm pack --dry-run` — whitelist still exactly dist + README.md + package.json
