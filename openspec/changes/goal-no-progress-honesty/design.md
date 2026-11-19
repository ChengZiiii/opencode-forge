# goal-no-progress-honesty — Design

## Context

The no-progress detector scores each ENGINE-STARTED continuation turn by the
per-turn activity counters (`turnActivity`: writes / checks) that
`tool.execute.after` increments. Qualifying activity was write-class tools
or `goal_check`. The goal contract's own verification loop, however, runs
its Verification Checks through `forge_shell` — a READ-classified exec in
the readonly-exec-seal taxonomy — so the most productive kind of turn (one
that re-runs the checks and reads the evidence) scored zero and fed the
streak toward the auto-pause. Field incident: 2026-11-19 closure session,
turn spent entirely on `forge_shell` verification + evidence reading,
streak incremented, loop paused with `no-progress`.

## Decisions

- **D1 — Exec tools are the checks channel (not writes).** A
  `forge_shell`/`shell`/`bash` execution increments `act.checks` (the same
  counter `goal_check` feeds). Rationale: the ledger field is semantically
  "verification commands", the brief mandates them, and the readonly-exec
  seal already classifies these tools as the exec family — no new schema.
  Pure reads (`read`/`grep`/`glob`/`forge_*` search tools) still do NOT
  count: stalling by re-reading files must keep earning no-progress, or the
  detector dies.
- **D2 — The brief teaches the same rule it enforces.** One standing line in
  the continuation brief: every turn should land a verification command
  (`forge_shell`) or a real write — read-only turns are ledgered as
  no-progress. Directive and detector cannot drift apart again.
- **D3 — Both wiring faces change together.** The counters live twice (the
  v1 `tool.execute.after` hook and the v2 seam mirror at the v2 tool
  surface); a one-sided fix would fork the semantics per loader.
- **D4 — Crew counters untouched.** The crew-side per-turn activity already
  counts `task` dispatches (waves ARE the work) plus writes; its misfire
  class differs and no field incident implicates it.

## Alternatives rejected

- Raise `NO_PROGRESS_LIMIT` — treats the symptom, keeps mis-scoring
  verifying turns, and dulls the detector for genuinely idle loops.
- Count pure reads as activity — makes the detector unkillable (an idle
  loop that opens a file each turn never pauses).
- Ledger schema change (`execs` field) — breaks the ledger format for zero
  information gain; `checks` already means "verification commands ran".
