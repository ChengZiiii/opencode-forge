# plan-harness Specification

## Purpose
Make single-task plans first-class citizens on disk: plan-file persistence and structure are guaranteed by tool validation, the draft-phase write ban and the approve/completion permission gates guard phase transitions, numbered tasks track completion by ticking, and session notices and resume form a "short-horizon, single-task spec workflow".

## Requirements

### Requirement: Plan file persistence layout

Plan files SHALL be created under the workspace's `.opencode/plan/` directory (the plugin's only write location outside its package), named `YYYY-MM-DD-<slug>.md`, with the slug derived from the task goal (kebab-case, length-truncated). The frontmatter SHALL contain at least `status` (draft / approved / done / abandoned / superseded), `created`, and `updated`. Same-day slug collisions SHALL get a numeric suffix.

#### Scenario: A compliant plan file is generated

- **WHEN** `plan_write` successfully persists a plan with the goal "fix the login timeout"
- **THEN** a file like `2026-09-25-fix-login-timeout.md` appears under `.opencode/plan/`, with frontmatter containing `status: draft` and timestamp fields

#### Scenario: Same-day slug collision

- **WHEN** a plan file with the same name already exists today and another `plan_write` produces the same slug
- **THEN** the new filename gets a `-2` suffix; the existing file is not overwritten

### Requirement: Structured template validation

`plan_write` SHALL validate the content and render fixed sections: Goal, Non-Goals, Context Findings (with `file:line` evidence references), Approach and Alternatives (with rejected alternatives and reasons), a numbered Task List (`- [ ]` checkboxes, globally unique numbers), Risks, and Acceptance Criteria. When any required section is missing or empty, the tool SHALL error and refuse to write.

#### Scenario: Complete content persists

- **WHEN** the planning content contains every required section
- **THEN** persistence succeeds and the tool returns the file path and task count

#### Scenario: Missing acceptance criteria rejected

- **WHEN** the planning content lacks the acceptance criteria section
- **THEN** the tool errors naming the missing section; no file is created

### Requirement: Hard write ban during draft

While the current session has an active draft (created via `/plan` or bound via `/plan resume`, with status draft), the plugin SHALL unconditionally deny write-class tools before they execute — `edit`, `write`, the patch family, and the host's builtin `shell` (whatever the host names it: the plugin's write-class family SHALL name the host's own tool names `shell` and `subagent`, kept in its single native-tool vocabulary); an `allow` in the user's config SHALL NOT override it. Read-class tools and the harness tools (`plan_*`) SHALL be allowed. Native subagent dispatch SHALL be gated by target instead of denied wholesale: while the draft is active, a native `subagent` call whose target is a `forge-*` worker of **effective readonly shape** SHALL be allowed as a reconnaissance dispatch (breadth evidence-gathering without spending the planning session's context — the child runs in the background and its report arrives in the host's own completion message), and every other `subagent` call — a write-shape worker, a readonly worker that keeps the shell, a non-forge agent target, an absent target, or a target that cannot be resolved — SHALL be denied exactly like any write-class tool; a follow-up call to an existing child SHALL be judged by the agent it names; with a refusal that names the currently dispatchable effective-readonly roster (empty-roster refusals SHALL point to defining a readonly worker in forge.json) and the exits (`plan_approve` / discard). Effective readonly shape SHALL mean: the definition's `shape` IS `"readonly"` — an explicit declaration (an absent shape defaults to write and is NOT exempt; the exemption is a pass and must be asked for explicitly) — AND no explicit permission override in the definition lifts `write`, `edit`, or a patch-family tool off `"deny"` (any other value — `allow` or `ask` — counts as lifted; the judgment is fail-closed) — AND the worker's recipe leaves the shell unavailable (an explicit `permission` entry denying the host's shell action). The third clause is stricter than the worker's everyday face: a readonly worker keeps the builtin shell for its normal work (the host's shipped `explore` agent makes the same choice), but a worker that can run a command or write a file is not dispatched while a draft is active, so opening the shell to readonly workers SHALL NOT loosen this gate. The roster named in a refusal lists exactly the workers that satisfy all three clauses. The denial SHALL NOT be overridable by user allow config. The `/plan` discipline text SHALL state the split accurately: write tools and the builtin shell are denied during draft, reconnaissance may dispatch effective-readonly forge scouts through the native `subagent` tool (before and during the draft), and write-shaped workers — and any other native subagent — wait for approval. After `plan_approve` approves or discard abandons the plan, the ban and the dispatch gate SHALL lift immediately.

A qualified scout SHALL have a current compatible materialized definition matching the recipe and the host's effective permission face. Ordinary host permissions still govern the call and child; `execute.before` admission alone is not proof of a successful dispatch. Where the permission chain or materialized definition does not establish the required face, disclose and refuse qualification until corrected through authorized sync, not treating an old generated artifact as evidence.

#### Scenario: Writing a file during draft is denied

- **WHEN** the session has an active draft and the model calls a write/edit-class tool
- **THEN** the call is denied by the plugin's belts, with a message pointing to `plan_approve` or discard

#### Scenario: bash during draft is denied

- **WHEN** the session has an active draft and the model calls the host's builtin shell
- **THEN** the call is denied for the same reason

#### Scenario: A readonly recon dispatch passes during draft

- **WHEN** the session has an active draft and the model makes a native `subagent` call for `forge-<ns>-research`, where `research` is defined with `shape: "readonly"`, a `permission` entry denying the shell, and no override lifting a file-mutating tool
- **THEN** the call is allowed, the child runs with its compiled readonly face (file-mutating tools, the shell, and dispatch denied), and its findings reach the planning session in the host's completion message

#### Scenario: A write-shape dispatch is denied with roster guidance

- **WHEN** the session has an active draft and the model makes a native `subagent` call for `forge-<ns>-coder`, where `coder` is defined with `shape: "write"`
- **THEN** the call is refused like any write-class tool, and the refusal names the dispatchable effective-readonly roster and the exits (plan_approve / discard) — never a bare "wait for approval"

#### Scenario: Unresolvable and native targets fail closed

- **WHEN** the session has an active draft and the model makes a native `subagent` call with a non-forge agent target (`general`/`explore`), with no agent named, with a follow-up to an existing child that names `general`, or with a target that does not resolve
- **THEN** every such call is denied like any write-class tool during draft, before any child session is created

#### Scenario: A permission override breaks effectiveness

- **WHEN** a definition declares `shape: "readonly"` but its `permission` map sets `write: "allow"` (or `edit` to any value other than `"deny"`), and the model dispatches it during a draft
- **THEN** the target is not effective-readonly and the call is denied with the same roster guidance

#### Scenario: A readonly worker that keeps the shell is not dispatched during draft

- **WHEN** the session has an active draft and the model makes a native `subagent` call for a `forge-*` worker of readonly shape whose recipe leaves the shell available
- **THEN** the call is refused with the same roster guidance, and that worker is not in the roster the refusal names

#### Scenario: The ban lifts after approval

- **WHEN** `plan_approve` succeeds with user confirmation and the model calls a write-class tool again
- **THEN** the write goes through the normal permission flow

#### Scenario: Graceful degradation after process restart

- **WHEN** the opencode process restarts with a status-draft plan still on disk
- **THEN** the write ban no longer applies automatically (session binding state is lost); the plan discipline carried by the `/plan` command still guides approval or resume first, and the session-start notice surfaces the unfinished plan

### Requirement: Approval gate permission confirmation

`plan_approve` SHALL transition the active plan's status from draft to approved; the call SHALL be pinned to an ask-level confirmation (never auto-allowed, not exempted by user allow config). Approval SHALL be user-led: after a draft is written, the harness guidance SHALL direct the agent to present the plan and end its turn — the user reviews at their own pace (revision feedback triggers a `plan_write` revision and re-presentation; rejection leads to `/plan discard` or re-planning) — and `plan_approve` SHALL only be called after the user's explicit go-ahead in conversation, with the confirmation dialog acting as the final hard gate. Calling it with a non-draft status SHALL error.

#### Scenario: Entering execution after user confirmation

- **WHEN** the draft is presented, the user replies with an explicit go-ahead, the model calls `plan_approve`, and the user allows it in the confirmation dialog
- **THEN** status becomes approved and the draft-phase write ban lifts

#### Scenario: The user steers the review before any approval

- **WHEN** the draft is presented and the user replies with change requests instead of a go-ahead
- **THEN** the agent revises the draft via `plan_write`, re-presents it, and ends its turn again — no `plan_approve` call and no execution happen without the user's explicit approval

#### Scenario: Duplicate approval rejected

- **WHEN** status is already approved and the model calls `plan_approve`
- **THEN** the tool errors explaining the current state cannot be approved

### Requirement: Numbered task ticking

`plan_tick` takes a task number n, SHALL verify that task exists and is unticked, then atomically set it to `- [x]` with a completion-timestamp HTML comment on the same line; a missing number or an already-ticked task SHALL error without modifying the file. The `/plan` command's discipline SHALL mandate ticking immediately after each numbered task completes, banning batch after-the-fact ticking.

#### Scenario: Ticking a completed task

- **WHEN** task 3 is actually complete and unticked, and the model calls `plan_tick(3)`
- **THEN** task 3 becomes ticked with a completion-timestamp comment, and the tool reports the remaining unticked count

#### Scenario: Ticking a nonexistent number rejected

- **WHEN** no task number 7 exists in the plan and the model calls `plan_tick(7)`
- **THEN** the tool errors and the file is unchanged

#### Scenario: Duplicate tick rejected

- **WHEN** task 2 is already ticked and the model calls `plan_tick(2)` again
- **THEN** the tool errors and the file is unchanged

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

### Requirement: Phase commands without switching subjects

The plugin SHALL register `/plan <goal>`, `/plan resume`, and `/plan discard` commands: `/plan` enters planning discipline (read-only recon → clarification → `plan_write` → present and await `plan_approve`), `/plan resume` binds the most recent non-terminal plan and continues it, and argument-less `/plan` SHALL list non-terminal plans with progress. Commands SHALL NOT trigger agent switching (single-subject principle).

#### Scenario: Entering the planning phase

- **WHEN** the user runs `/plan fix the login timeout`
- **THEN** forge enters planning discipline in the current session, ultimately persisting a plan and awaiting approval, with no agent switching at any point

#### Scenario: Resuming an unfinished plan

- **WHEN** a half-done plan with status approved exists and the user runs `/plan resume`
- **THEN** the session binds that plan and continues from the remaining tasks

#### Scenario: Listing in-progress plans

- **WHEN** the user runs argument-less `/plan`
- **THEN** every non-terminal plan is listed with path, status, and tick progress

### Requirement: Session-start notice

The session_start hook SHALL detect non-terminal plans in the workspace; when one exists, it SHALL emit a notice at session start with the path and tick progress so the user can decide whether to resume.

#### Scenario: Notice when an unfinished plan exists

- **WHEN** a plan with status approved (3/7 ticked) exists under `.opencode/plan/` and the user opens a new session
- **THEN** a notice appears at session start with that plan's path and `3/7` progress

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

### Requirement: Structured verification checks on plans

`plan_write` SHALL accept an optional structured `checks` array — each item a shell check (`shell`) or a file-contract check (`containsFile` + `containsText`), with an optional `timeoutSec` — isomorphic to the goal harness's verification items. Plan and goal SHALL share the host-aligned interpreter selection and check execution chain (goal-harness Host-aligned interpreter for verification shell checks), preserving cwd, timeout, exit status, output and file-contract boundary semantics; plan close remains independent of goal state and fail-closed. Declared checks SHALL be rendered into a `## Verification Checks` section of the plan file and SHALL round-trip through parse. The check set SHALL freeze at approval: `plan_close` re-runs exactly the frozen set read from the plan file, and a close call SHALL NOT be able to alter, add, or drop checks. A plan without declared checks keeps the per-criterion self-check path unchanged.

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

### Requirement: Planning discipline travels in the plan command

The plugin SHALL ship no skill file and SHALL register none. The planning discipline SHALL travel in the `/plan` command template — the command's own turn is the rulebook — and SHALL cover: planning discipline (read-only reconnaissance and clarifying questions before persisting; execute only after approval), the tick-immediately discipline, and the tiering boundary — work expected to span sessions, involve long multi-file change, or need multi-round requirement review SHALL be recommended to an OpenSpec spec workflow instead of a plan. Nothing SHALL be copied into the user's config directory.

#### Scenario: The plan command carries the discipline

- **WHEN** the `/plan` command's template is inspected
- **THEN** it states the read-only reconnaissance and alignment step with its clarifying questions, approval before any execution, ticking each task the moment it is done, and that long-horizon work is spec work rather than plan work

#### Scenario: No skill ships

- **WHEN** the published package is inspected
- **THEN** it contains no SKILL.md, and the plugin registers no skill with the host
