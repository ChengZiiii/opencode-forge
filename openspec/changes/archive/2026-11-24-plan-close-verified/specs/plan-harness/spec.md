## MODIFIED Requirements

### Requirement: Completion gate acceptance self-check

`plan_close` SHALL transition status from approved to done only when every numbered task is ticked and the completion evidence passes. For a plan that declared structured verification checks (frozen at approval), the close SHALL re-run the frozen check set on the host and every check SHALL pass: any failing outcome — including a check-runner timeout or spawn failure — SHALL refuse the close fail-closed (the failing run is appended to the plan's Check Log, status stays approved, and the error names the failing check with its output). For a plan without structured checks, the call SHALL carry a per-criterion self-check (each acceptance criterion with ✓/✗ and an evidence reference); unticked tasks or any ✗ SHALL error and refuse. The call SHALL NOT be pinned to an ask-level confirmation — the completion gate is plugin-verified, not modal-confirmed; `plan_approve` remains the only permission-ask gate in the plan lifecycle.

#### Scenario: Closing after all ticked and all passing

- **WHEN** every task is ticked and the completion evidence passes (frozen checks re-run all-passing, or every self-check ✓ with evidence for a plan without checks) and the model calls `plan_close`
- **THEN** status becomes done with no confirmation dialog and the tool returns the evidence summary

#### Scenario: Rejected with unticked tasks

- **WHEN** tasks remain unticked and the model calls `plan_close`
- **THEN** the tool errors listing the unticked task numbers

#### Scenario: Rejected when acceptance fails

- **WHEN** a self-check marks some acceptance criterion ✗
- **THEN** the tool refuses to close, directing a fix or a plan revision first

#### Scenario: Failing host re-run refuses the close

- **WHEN** a frozen verification check fails at the close-time re-run
- **THEN** status stays approved, the failing run is appended to the plan's Check Log, and the error names the failing check with its output

### Requirement: Terminal lifecycle narrative

Every terminal transition of a plan SHALL append a dated section to the plan file body before the status flips: `plan_close` SHALL append the close section carrying the plugin-verified evidence summary (for structured plans the close-time re-run outcomes per check; for plans without checks the per-criterion pass/evidence summary the model submitted); `plan_discard` SHALL append the abandon section carrying the caller-supplied reason (a missing reason appends the section with an explicit `reason: (none given)` marker — the transition never happens silently); `plan_discard {supersede}` SHALL append the superseded section carrying the reason and the successor reference; `plan_reopen` SHALL append the dated reopened section before flipping done back to approved. Appended sections SHALL be inert to the parser: status parsing reads frontmatter only, and tick counts read the Task List section only — a lifecycle section's content SHALL never alter either. A superseded plan's Task List is the frozen decision snapshot: closure IS the supersession, ticks are not expected afterwards, and crew/goal execution results SHALL NEVER tick a superseded plan's tasks (no cross-harness tick forwarding — the executing harness's own ledger is the progress record).

#### Scenario: Close appends the verdict narrative

- **WHEN** `plan_close` passes the completion gate
- **THEN** the plan file gains a dated close section carrying the plugin-verified evidence summary (per-check re-run outcomes, or per-criterion pass/evidence for plans without checks), and the frontmatter status becomes done

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

## ADDED Requirements

### Requirement: Structured verification checks on plans

`plan_write` SHALL accept an optional structured `checks` array — each item a shell check (`shell`) or a file-contract check (`containsFile` + `containsText`), with an optional `timeoutSec` — isomorphic to the goal harness's verification items. Declared checks SHALL be rendered into a `## Verification Checks` section of the plan file and SHALL round-trip through parse. The check set SHALL freeze at approval: `plan_close` re-runs exactly the frozen set read from the plan file, and a close call SHALL NOT be able to alter, add, or drop checks. A plan without declared checks keeps the per-criterion self-check path unchanged.

#### Scenario: Declared checks render and round-trip

- **WHEN** `plan_write` declares structured checks
- **THEN** the plan file carries a Verification Checks section that re-parses to the same items

#### Scenario: Checks freeze at approval

- **WHEN** an approved plan is closed
- **THEN** the close re-runs exactly the check set frozen in the approved plan file — later tool arguments cannot swap the checks

#### Scenario: Legacy plans keep the self-check path

- **WHEN** a plan file predates structured checks and `plan_close` is called
- **THEN** the per-criterion self-check contract applies unchanged

### Requirement: Reopen window after close

`plan_reopen` SHALL be the only legal transition out of `done`: it SHALL flip the frontmatter status back to `approved`, append a dated `— reopened` section (parser-inert like every lifecycle section), and re-bind the session's active plan to the reopened file. Reopen SHALL be user-directed: the model calls it only on explicit user instruction (a discipline-layer contract — no modal, no auto-reopen). A reopened plan may be re-closed, producing a second dated close section; the frontmatter status remains the single source of truth for which closure is current.

#### Scenario: Reopen restores approved and rebinds

- **WHEN** the user directs reopening a done plan
- **THEN** status becomes approved, the session's active plan rebinds to it, and a dated reopened section is appended

#### Scenario: Re-close appends a second dated section

- **WHEN** a reopened plan closes again
- **THEN** a second dated close section appears and readers rely on the frontmatter status for currency
