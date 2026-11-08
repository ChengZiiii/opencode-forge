# Design — crew-autonomous-waves

## Context

The goal harness's idle-continuation engine (plugin.ts ~2143-2405) already implements: debounce
(`FORGE_GOAL_DEBOUNCE_MS`), in-flight claim, lazy session seeding, family gates at schedule+send,
no-progress accounting, draft-conflict pause, budget pause, idle re-check, transport-failure cap. It
fires ONLY for a live active goal owned by the session. Crews are in-memory `CrewEntry`
(plugin.ts:431: `{objective, startedAt, subtasks: CrewSubtask[], mode: "pending"|"executing", recordPath}`)
in `crews: Map<sessionID, CrewEntry>`; close/abandon/convert evict the entry; `session.deleted` should
also evict (verify during implementation — if it does not today, eviction on session end is a bugfix
folded into this change with a test).

Without a governing goal, an armed crew stalls on every idle — the "supervised" in supervised waves
currently means "the user presses continue per wave".

## Goals / Non-Goals

**Goals**: waves-armed crews advance through idles autonomously with the SAME guard discipline as the
goal engine; every stop condition is honest (stall disclosure, never silent); zero new disk state.

**Non-Goals**: no crew turn budgets (the stall guard + user's crew_close own the lifecycle); no changes to
the pending belt, execution-mode gate, or close gate; no changes to the goal engine's no-progress
semantics; no crew record format changes.

## Decisions

### D1 — Branch inside `continueIfEligible`, after the live-goal check (adopted)

Order inside the engine: (1) shared plumbing (disable knob, in-flight, lazy seed); (2) turn-ledger
accounting for the GOAL path stays where it is; (3) `resolveLiveGoal` — if a live ACTIVE goal owned by
this session exists → goal path, crew branch never fires (goal-governed ownership); (4) else, crew branch:
`crews.get(sessionID)` with `mode === "executing"` → crew continuation; anything else → return.

The crew branch reuses: send-time family re-check, idle busy re-check, transport-failure map + cap. It
does NOT touch: goal ledger files, `pendingContinuationTurn`/`turnActivity` (goal accounting), draft
pause (crew has no draft interlock today — a draft plan's write ban will simply make the turn produce no
activity and the stall guard handles it; folding a draft-conflict pause into the crew branch is tempting
but adds coupling for a rare composition — REJECTED, noted here).

### D2 — The `[forge:crew-continue]` brief (adopted)

```
[forge:crew-continue] The crew "<objective>" is armed (waves) — continue the wave discipline.
Declared plan (every subtask needs a verdict at close):
1. <title>  2. <title> …
Next: dispatch the next wave (parallel task calls — forge-* workers from this session's pool, or the
native general subagent when no forge worker fits), collect per-subtask evidence verdicts, at most one
retry per subtask, then crew_close with the full report. Stalled or wrong decomposition?
crew_close {abandon: true, reason} to re-shard.
```

Subtask titles come from the in-memory `CrewEntry.subtasks` (the close gate's own source — the brief can
never drift from what close will demand). One brief per idle, after debounce, in-flight-claimed.

### D3 — Crew-side activity + stall guard (adopted)

Separate counters: `crewTurnActivity: Map<sessionID, {dispatches: number; writes: number}>` reset per crew
continuation send; `tool.execute.after` increments `dispatches` for `input.tool === "task"` and `writes`
via the existing `isWriteTool` (only when the counter exists — zero cost for other sessions). At idle: a
crew continuation turn with zero dispatches+writes increments `crewNoProgress`; ANY activity resets and
evicts the streak. At `CREW_NO_PROGRESS_LIMIT` (adopt 3, matching the goal engine's limit): the engine
evicts its crew-continuation eligibility marker for that crew registration (a `crewStalled: Set<sessionID>`
cleared on fresh `crew_begin`), emits ONE bounded console disclosure, and never briefs again for that crew.
The crew itself is untouched — user stays in charge. Goal-engine counters are NEVER read or written by the
crew branch.

### D4 — Session end and crew end hygiene (adopted)

`session.deleted` evicts the engine's crew-side maps (mirroring the existing goal-engine + agent-family
evictions); crew close/abandon/convert already deletes the `crews` entry (verify + test; add eviction if
missing). Restart honesty: crews are in-memory by design — a host restart ends the crew; the engine
finding no EXECUTING crew simply does nothing.

### D5 — Wording touchpoints (adopted)

`/crew` template's waves choice + `crew_begin {execution:"waves"}` arming output + the goal-delegated
one-call text each gain one clause: "waves auto-advance on session idle until crew_close (the engine
stops after a stall — nudge or re-shard)". README crew section gains the same paragraph. No spec text
beyond the new requirement moves.

### D6 — Rejected alternatives

- **Reuse goal accounting wholesale (shared counters).** Task-as-activity would silently weaken the goal
  no-progress guard's semantics for goal sessions. Rejected — separate counters (D3).
- **Crew turn budgets (maxWaves).** Budgets without a contract file are arbitrary; the stall guard bounds
  waste and the user's close owns the end. Rejected for this change (a future change may add budgets if
  real usage demands).
- **Auto-abandon on stall.** The stall may be a transient dispatch failure away from done; destroying the
  crew record automatically is the one irreversible move available. Rejected — disclose and stop.

## Risks / Mitigations

- **Double-briefing (goal + crew)**: impossible by construction (D1 order: goal wins, crew only when no
  live active goal).
- **Endless ping-pong on a crew that only chats**: the stall guard stops it after 3 activity-free turns
  with a disclosed note.
- **Prompt-loop cost while the user is away**: bounded by the stall guard + the user's own crew_close;
  same trust model as the goal loop the host already ships.
