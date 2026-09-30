# Design: plan-supersession-and-lineage

## Context

A production campaign (SorenUnityLabs, 2026-10-01) walked plan → crew → goal and
left three same-stem artifacts. The crew record chains its lifecycle with dated
appended sections; the plan file ends in a bare frontmatter status flip; the
goal knows its session but not its origin. Forensics (opencode.db + disk)
proved: the crew record WAS written at registration; the "not persisted"
perception came from the model dropping the tail-buried record path line while
explicitly announcing the plan and goal paths.

## Goals / Non-Goals

- Goals: no silent terminals (every plan/crew terminal carries a dated,
  reasoned narrative section); supersession as a first-class exit (distinct
  from abandonment); the crew record path impossible to miss; lineage
  machine-recorded; the draft-gate error honest about all three exits.
- Non-Goals: no single campaign artifact (three files stay the audit chain of
  governance modes); no cross-harness tick forwarding; no implicit
  just-abandoned-plan auto-linking; no goal-side origin plumbing (YAGNI — the
  crew conversion section already points forward; goal frontmatter untouched);
  no migration of historical abandoned files.

## Decisions

- **D1 — `superseded` as a first-class terminal status** (not
  abandoned-plus-body-note). Humans scanning `.opencode/plan/` must
  distinguish "died" from "moved" at a glance; `resolveActivePlan` treats it
  like any terminal (no discovery change); transition table:
  draft/approved → superseded, parallel to abandoned.
- **D2 — Closure-by-supersession; ticks frozen.** A superseded plan's Task
  List is the decision snapshot exported to the executing harness's ledger.
  Crew verdicts / goal results NEVER tick it: double certification under two
  rigor levels (crew evidence cross-check vs plan acceptance gate) plus
  guaranteed ledger drift — the incident's goal already renumbered and
  reworded the plan's 7 tasks into 8 criteria; the two lists are not the same
  objects and must not be synchronized.
- **D3 — Narrative sections are append-only, dated, end-of-file, and
  parser-inert.** Status reads frontmatter only; ticks read the Task List
  section only (verified in plan-file.ts parsing — the design adds tests
  pinning that appended sections containing checkbox-like text never alter
  counts). The transition still flips frontmatter (single atomic file write:
  append + status rewrite in one `writeFileSync`).
- **D4 — Reason persistence, not reason collection.** `plan_discard` already
  receives `reason`; today it lands only in the tool reply. The fix persists
  what exists; a missing reason appends `(none given)` — the transition
  narrative is mandatory, the reason field is best-effort.
- **D5 — Record path leads the registration output** (same first-block
  prominence as `Plan created:`), and the PENDING pause text carries an
  explicit instruction to relay the path to the user. The incident showed the
  model reliably announces what the output leads with and reliably drops what
  it buries.
- **D6 — `lineage` is an explicit optional argument** on `crew_begin`,
  recorded as a first-class header line in the crew record. Rejected:
  implicit linking to a plan abandoned moments ago (time-window heuristics
  are fragile; the model knows the lineage and can state it — the argument
  just makes it durable data instead of objective prose).
- **D7 — Draft-gate error gains the approved-plan exit.** Current text offers
  approve-or-discard; an approved plan does not block `/crew` (the macro
  contract may come from an approved plan — already spec'd). The error also
  mentions `{supersede}` once D1 lands.
- **D8 — Spec drift fix:** crew_close requirement still claims "there is no
  persistent crew record", contradicting the implemented `.opencode/crew/`
  record (writeCrewRecord/appendCrewRecord) and the discipline requirement
  describing it. The MODIFIED requirement states the close appends to the
  record. No code change — spec catches up to reality.

## Risks / Trade-offs

- Status-enum widening touches every `PlanStatus` consumer; bounded by
  typecheck — `superseded` joins TERMINAL, nothing else branches on it.
- Parser-inertness is a load-bearing invariant (D3): any future parser change
  that scans the whole file for checkboxes would silently corrupt counts —
  pinned by explicit tests here.
- The `/crew` template grows by one instruction line (relay the record path);
  template bloat is the accepted cost — the incident cost was a false
  "data loss" report.

## Migration Plan

None. Historical files keep `abandoned` regardless of actual semantics;
`superseded` exists only for future transitions. Readers must not interpret
old abandoned files as failures.

## Open Questions

- None blocking. (Goal-side origin plumbing deliberately deferred; revisit if
  campaign archaeology becomes a real need.)
