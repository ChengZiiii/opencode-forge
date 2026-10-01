# plan-harness Specification (delta)

## MODIFIED Requirements

### Requirement: Plan file persistence layout

Plan files SHALL be created under the workspace's `.opencode/plan/` directory (the plugin's only write location outside its package), named `YYYY-MM-DD-<slug>.md`, with the slug derived from the task goal (kebab-case, length-truncated). The frontmatter SHALL contain at least `status` (draft / approved / done / abandoned / superseded), `created`, and `updated`. Same-day slug collisions SHALL get a numeric suffix.

#### Scenario: A compliant plan file is generated

- **WHEN** `plan_write` successfully persists a plan with the goal "fix the login timeout"
- **THEN** a file like `2026-09-25-fix-login-timeout.md` appears under `.opencode/plan/`, with frontmatter containing `status: draft` and timestamp fields

#### Scenario: Same-day slug collision

- **WHEN** a plan file with the same name already exists today and another `plan_write` produces the same slug
- **THEN** the new filename gets a `-2` suffix; the existing file is not overwritten

### Requirement: Discard exit

`/plan discard` SHALL set the session-bound active draft to abandoned and lift the write ban; terminal (done/abandoned/superseded) plan files SHALL remain under `.opencode/plan/` as history. `plan_discard` SHALL additionally accept an optional `supersede` argument (the successor artifact's path or identifier): when present, the plan SHALL move to `superseded` instead of `abandoned` — the exit for work whose execution moves to another harness (crew orchestration, a goal contract) rather than ends. Both exits SHALL lift the draft write ban identically.

#### Scenario: Freedom restored after discard

- **WHEN** the user runs `/plan discard`
- **THEN** the plan's status becomes abandoned and write operations return to normal

#### Scenario: Supersession exit records where the work went

- **WHEN** the work moves to crew orchestration and the model runs `plan_discard {reason, supersede: ".opencode/crew/2026-10-01-....md"}`
- **THEN** the plan's status becomes superseded (not abandoned), the draft write ban lifts, and the successor reference is persisted in the file (see the terminal lifecycle narrative requirement)

#### Scenario: Plain discard stays abandonment

- **WHEN** `plan_discard` runs without the `supersede` argument
- **THEN** the plan becomes abandoned exactly as before — supersession is opt-in and never inferred from the reason text

## ADDED Requirements

### Requirement: Terminal lifecycle narrative

Every terminal transition of a plan SHALL append a dated section to the plan file body before the status flips: `plan_close` SHALL append the close section (per-criterion pass/evidence summary the model already submitted); `plan_discard` SHALL append the abandon section carrying the caller-supplied reason (a missing reason appends the section with an explicit `reason: (none given)` marker — the transition never happens silently); `plan_discard {supersede}` SHALL append the superseded section carrying the reason and the successor reference. Appended sections SHALL be inert to the parser: status parsing reads frontmatter only, and tick counts read the Task List section only — a lifecycle section's content SHALL never alter either. A superseded plan's Task List is the frozen decision snapshot: closure IS the supersession, ticks are not expected afterwards, and crew/goal execution results SHALL NEVER tick a superseded plan's tasks (no cross-harness tick forwarding — the executing harness's own ledger is the progress record).

#### Scenario: Close appends the verdict narrative

- **WHEN** `plan_close` passes the completion gate
- **THEN** the plan file gains a dated close section summarizing each acceptance criterion's pass/evidence, and the frontmatter status becomes done

#### Scenario: Discard persists the reason instead of dropping it

- **WHEN** `plan_discard {reason: "user cancelled the task"}` runs
- **THEN** the file gains a dated abandon section carrying that reason verbatim — the reason text survives in the artifact, not only in the tool reply

#### Scenario: Superseded section names the successor

- **WHEN** `plan_discard {supersede}` runs with a reason and successor path
- **THEN** the dated superseded section carries both, and a reader of the plan file alone can tell where the work continued

#### Scenario: Lifecycle sections are parser-inert

- **WHEN** a plan file carries appended terminal sections (whose text may contain checkbox-like or key-value lines)
- **THEN** tick counts and status parsing are unchanged — only the frontmatter status and the Task List section are read

#### Scenario: No cross-harness tick forwarding

- **WHEN** a crew closes (or a goal completes) over work that a superseded plan's Task List also describes
- **THEN** the superseded plan's checkboxes stay exactly as frozen at supersession — the crew record / goal Check Log is the progress ledger
