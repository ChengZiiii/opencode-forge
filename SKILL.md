---
name: forge-plan
description: >-
  The plan discipline for the forge agent (loaded as the "forge-plan" skill;
  the /plan command is the entry point, this skill is the rulebook). You
  **MUST** load this skill when the /plan command routes a task goal to you,
  OR the user asks to "plan first", "make a plan", "think before coding"
  before implementation. It
  governs the whole plan lifecycle: read-only reconnaissance, clarifying
  questions, plan_write (structured, tool-rendered), user-approval via
  plan_approve, tick-as-you-go execution via plan_tick, per-criterion
  self-check at plan_close, and the OpenSpec boundary for long-horizon work.
  Do NOT load it for direct implementation requests with no planning intent.
---

# Plan Discipline (forge)

Plans are short-horizon, single-task-goal documents on disk
(`.opencode/plan/<date>-<slug>.md`). The harness (tools + permission layer)
enforces the hard parts; you supply the engineering judgment.

## Phase 1 — Reconnaissance (read-only)

- Explore with read/grep/glob only. **All write tools, bash, and task
  (subagents) are denied while a draft exists** — do not attempt them, do not
  ask the user to bypass.
- Gather concrete evidence with `file:line` references; the plan's Context
  Findings section must contain findings you actually verified, not guesses.
- If the goal is ambiguous on scope, behavior, or acceptance — ask the user
  1-3 focused questions FIRST. Do not plan against assumptions the user could
  settle in one line.

## Phase 2 — Write the plan (plan_write)

Call `plan_write` with structured fields; the tool renders and validates the
fixed sections (Goal / Non-Goals / Context Findings / Approach and
Alternatives / Task List / Risks / Acceptance Criteria), so a malformed plan
cannot exist.

Quality bar for each field:

- **goal**: one line, the outcome — not the activity.
- **context**: verified findings with `file:line` evidence; include what you
  ruled out and why.
- **approach**: the chosen approach AND at least one rejected alternative
  with the reason. A plan with no considered alternative is a guess.
- **tasks**: 3-8 concrete, independently verifiable steps, each doable in one
  sitting. A task like "improve the code" is invalid; "extract timeout
  constant into config.ts and default it to 3000" is valid.
- **risks**: what could break, blast radius, rollback path.
- **acceptance**: criteria you can verify with a command, a file, or an
  observable behavior. Vague criteria will fail the plan_close self-check.
- **nonGoals**: explicit out-of-scope items (what the user might expect but
  will NOT get).

Revising: calling `plan_write` again while still in draft overwrites the same
file. Do this after user feedback instead of hand-editing.

## Phase 3 — Approval gate (plan_approve)

Present to the user, briefly: goal, chosen approach (one line why), the
numbered task list, and the acceptance criteria. Then call `plan_approve`.
The user confirms in a dialog — that confirmation IS the approval. If they
object, revise with `plan_write` and present again. Never proceed to
implementation before approval succeeds.

## Phase 4 — Execution (tick as you go)

- Execute tasks in order; after EACH task's work is actually done, call
  `plan_tick` with its number immediately. Never batch ticks; never tick
  ahead of reality — the tick timestamp is an audit trail.
- If mid-execution you discover the plan is wrong, do not silently improvise:
  tell the user what changed and either finish the affected task anyway or
  ask whether to revise (/plan with the same goal re-enters planning).

## Phase 5 — Completion gate (plan_close)

When all tasks are ticked: self-check EVERY acceptance criterion with
concrete evidence (`file:line`, command output, test result). Call
`plan_close` with one check per criterion, `pass` honest — a ✗ fails the
close and that is the design working, not an inconvenience. The user
confirms closure in a dialog.

## Boundaries

- **Abandon**: user cancels → `/plan discard` (or plan_discard). Terminal,
  file kept as history, writes restored.
- **Resume**: new session with unfinished plan → the system notice carries
  the path; `/plan resume` continues from the remaining tasks.
- **Spec-workflow boundary**: work expected to span multiple sessions, days
  of multi-file change, or multi-round requirement review is spec work, not
  plan work. Say so once (e.g. "this fits a spec workflow like OpenSpec
  better"), let the user choose, and proceed with a plan only if they insist.
