# Proposal: plan-supersession-and-lineage

## Why

A real production campaign (2026-10-01, SorenUnityLabs) walked the full promotion
pipeline plan → crew → goal and exposed three defects:

1. **Silent plan terminal.** `plan_discard` flips the frontmatter status to
   `abandoned` and drops the caller-supplied reason on the floor — the file
   keeps a bare `- [ ]` task list forever with no narrative and no successor
   link (the reason existed at the transition moment; the system did not
   persist it). The crew record, by contrast, carries a full dated lifecycle
   narrative (registered → converted to goal). The plan file is the only
   information-losing terminal on the chain.
2. **Hand-off masquerading as abandonment.** Discarding a draft because the
   work moved to crew orchestration is a *supersession*, not a failure exit;
   both land in the same status today, so a human scanning `.opencode/plan/`
   cannot tell them apart.
3. **Registration disclosure gap.** The crew record path line is buried at the
   tail of `crew_begin`'s registration output (after the subtask dump and pool
   disclosure); in the incident the model relayed "计划已落盘" for the plan and
   "Goal 已武装" for the goal but silently dropped the crew record line — the
   user reasonably concluded the crew never persisted. Also: the draft-gate
   error names only two exits (approve / discard) while a third legal path
   exists (an *approved* plan does not block `/crew` — the crew may carry the
   approved plan's contract), and nothing records which plan a crew descended
   from except prose the model happens to write.

Incidental spec drift found while drafting: the live crew-harness
`crew_close completion gate` requirement still says "there is no persistent
crew record" — contradicting the implemented `.opencode/crew/` record and the
discipline requirement that describes it. Corrected here.

## What Changes

- **plan-harness**
  - New terminal status `superseded`: `plan_discard {supersede: "<successor
    path>"}` moves draft/approved → superseded (plain discard without the
    argument still → abandoned; both lift the draft write ban).
  - ADDED requirement "Terminal lifecycle narrative": every terminal
    transition (`plan_close` → done, `plan_discard` → abandoned,
    `plan_discard {supersede}` → superseded) appends a dated section to the
    plan file body carrying the reason (close: per-criterion verdict summary;
    discard/supersede: the caller's reason) and, for supersession, the
    successor artifact path. A superseded plan's task list is the frozen
    decision snapshot — closure IS the supersession; ticking is not expected
    and crew/goal results never tick it.
  - Status enum in the persistence-layout requirement gains `superseded`.
- **crew-harness**
  - `crew_begin` registration output: the crew record path line moves to the
    first block (same prominence as `Plan created:`); the PENDING pause text
    instructs the model to relay the record path to the user.
  - `crew_begin` gains an optional `lineage` argument (free-text origin, e.g.
    the plan path it descends from) recorded as a first-class `lineage:` line
    in the crew record header. Explicit argument only — no implicit
    just-abandoned-plan auto-linking.
  - The draft-block error names all three exits: `plan_approve`, `/plan
    discard`, and the fact that an approved plan does not block `/crew`.
  - crew_close requirement: stale "no persistent crew record" clause removed;
    the requirement now states the close summary appends to the crew record.

## Impact

- Spec deltas: plan-harness (2 MODIFIED + 1 ADDED), crew-harness (2 MODIFIED).
- Docs-truth fix (no behavior change): README apply-timing wording corrected per the
  2026-10-01 live finding — materialization triggers are host boot / first config
  build / opencode config reload; a NEW SESSION on a long-lived shared host does
  NOT re-materialize (the earlier "next config hook" phrasing read as per-session).
- Code: `src/plan-file.ts` (status union, transition table, narrative-section
  append helper, parser isolation for appended sections), `plugin.ts`
  (`plan_close`/`plan_discard` args + appends, `crew_begin` output order +
  `lineage` arg + draft-gate error text, /crew template wording).
- Tests: plan-file pure-function suite (transitions, narrative appends,
  parse- isolation), crew wiring suite (output order, lineage in record,
  draft-gate message, PENDING narration instruction).
- Incompatible with nothing: `superseded` is additive; old files stay as they
  are; `resolveActivePlan` treats it like any terminal (unchanged discovery).
