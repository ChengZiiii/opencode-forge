## Purpose

Make single-task plans first-class citizens on disk: plan-file persistence and structure are guaranteed by tool validation, the draft-phase write ban and the approve/completion permission gates guard phase transitions, numbered tasks track completion by ticking, and session notices and resume form a "short-horizon, single-task spec workflow".

## ADDED Requirements

### Requirement: Plan file persistence layout

Plan files SHALL be created under the workspace's `.opencode/plan/` directory (the plugin's only write location outside its package), named `YYYY-MM-DD-<slug>.md`, with the slug derived from the task goal (kebab-case, length-truncated). The frontmatter SHALL contain at least `status` (draft / approved / done / abandoned), `created`, and `updated`. Same-day slug collisions SHALL get a numeric suffix.

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

While the current session has an active draft (created via `/plan` or bound via `/plan resume`, with status draft), the permission hook SHALL unconditionally deny write-class tools (edit, write, bash, and other mutating tools); an `allow` in the user's config SHALL NOT override it. Read-class tools and the harness tools (`plan_*`) SHALL be allowed. After `plan_approve` approves or discard abandons the plan, the ban SHALL lift immediately.

#### Scenario: Writing a file during draft is denied

- **WHEN** the session has an active draft and the model calls a write/edit-class tool
- **THEN** the call is denied by the permission layer, with a message pointing to `plan_approve` or discard

#### Scenario: bash during draft is denied

- **WHEN** the session has an active draft and the model calls bash
- **THEN** the call is denied for the same reason

#### Scenario: The ban lifts after approval

- **WHEN** `plan_approve` succeeds with user confirmation and the model calls a write-class tool again
- **THEN** the write goes through the normal permission flow

#### Scenario: Graceful degradation after process restart

- **WHEN** the opencode process restarts with a status-draft plan still on disk
- **THEN** the write ban no longer applies automatically (session binding state is lost); skill discipline still guides approval or resume first, and the session-start notice surfaces the unfinished plan

### Requirement: Approval gate permission confirmation

`plan_approve` SHALL transition the active plan's status from draft to approved; the call SHALL be pinned to an ask-level confirmation (never auto-allowed, not exempted by user allow config), and the user's confirmation-dialog action IS the approval. Calling it with a non-draft status SHALL error.

#### Scenario: Entering execution after user confirmation

- **WHEN** the model presents the plan summary, calls `plan_approve`, and the user allows it in the confirmation dialog
- **THEN** status becomes approved and the draft-phase write ban lifts

#### Scenario: Duplicate approval rejected

- **WHEN** status is already approved and the model calls `plan_approve`
- **THEN** the tool errors explaining the current state cannot be approved

### Requirement: Numbered task ticking

`plan_tick` takes a task number n, SHALL verify that task exists and is unticked, then atomically set it to `- [x]` with a completion-timestamp HTML comment on the same line; a missing number or an already-ticked task SHALL error without modifying the file. The bundled skill SHALL mandate ticking immediately after each numbered task completes, banning batch after-the-fact ticking.

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

`plan_close` SHALL transition status from approved to done only when every numbered task is ticked and the call carries a per-criterion self-check (each acceptance criterion with ✓/✗ and an evidence reference); with unticked tasks or any ✗ it SHALL error and refuse. The call SHALL be pinned to an ask-level confirmation.

#### Scenario: Closing after all ticked and all passing

- **WHEN** every task is ticked, every self-check is ✓ with evidence, and the user confirms `plan_close`
- **THEN** status becomes done and the tool returns the final summary

#### Scenario: Rejected with unticked tasks

- **WHEN** tasks remain unticked and the model calls `plan_close`
- **THEN** the tool errors listing the unticked task numbers

#### Scenario: Rejected when acceptance fails

- **WHEN** a self-check marks some acceptance criterion ✗
- **THEN** the tool refuses to close, directing a fix or a plan revision first

### Requirement: Discard exit

`/plan discard` SHALL set the session-bound active draft to abandoned and lift the write ban; terminal (done/abandoned) plan files SHALL remain under `.opencode/plan/` as history.

#### Scenario: Freedom restored after discard

- **WHEN** the user runs `/plan discard`
- **THEN** the plan's status becomes abandoned and write operations return to normal

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

### Requirement: Bundled skill single-channel distribution and planning discipline

SKILL.md SHALL be discovered by opencode via `config.skills.paths` pointing at the package directory (SHALL NOT be copied into the user's config directory). Its content SHALL cover: planning discipline (read-only reconnaissance and clarifying questions before persisting; execute only after approval), the tick-immediately discipline, and the tiering boundary — work expected to span sessions, involve long multi-file change, or need multi-round requirement review SHALL be recommended to an OpenSpec spec workflow instead of a plan.

#### Scenario: Skill discovered through the single channel

- **WHEN** the plugin is installed via an official install mode and the skill discovery source is inspected
- **THEN** SKILL.md is found by scanning the package directory via skills.paths, with no mirror copy in the user's config directory

#### Scenario: Long-horizon work is guided to the spec workflow

- **WHEN** the user submits a large refactor expected to span multiple sessions via `/plan`
- **THEN** forge, following the skill's tiering boundary, explains that the task fits an OpenSpec spec workflow better and lets the user decide whether to continue with a plan
