# crew-harness Specification

## Purpose
The /crew orchestration layer: decompose an objective into evidence-checked subtasks, dispatch them as concurrency-paced background waves, retry each failure at most once, and gate the close on per-subtask PASS/FAIL verdicts cross-checked against the dispatch ledger.

## Requirements

### Requirement: /crew command discipline

The plugin SHALL register a `/crew <objective>` command that enters crew orchestration discipline in the current session (single-subject: no agent switching). The discipline SHALL mandate: after any needed reconnaissance, decompose the objective into subtasks and REGISTER the plan via `crew_begin {objective, subtasks}` — each subtask carrying a title and, optionally, the intended `forge-*` agent and an acceptance-evidence statement; execute the plan in waves of parallel native `task` calls (a wave's results return within the calling turn; the next wave launches only after the previous wave's results are in — never flooding); when a subtask calls for a role that no configured agent matches, execute that subtask through a native task call and surface the gap to the user with a suggestion to configure the missing role; verify each subtask's evidence from the task results; retry a failed subtask at most once (adjusted prompt or agent); finish with a completion report covering every declared subtask. An active plan draft SHALL refuse `/crew` with a pointer to `plan_approve` or `/plan discard`; a session with an active crew SHALL refuse a second concurrent `/crew`; argument-less `/crew` SHALL print usage. Crew state is in-memory and session-bound: on host restart it dies honestly and a new `/crew` starts fresh — there is no cross-session crew resume in this capability.

#### Scenario: /crew decomposes and paces waves on briefs

- **WHEN** the user runs `/crew` with an objective and the model follows the discipline
- **THEN** the subtask plan is registered through `crew_begin`, subtasks execute as parallel native `task`-call waves, and a later wave launches only after the previous wave's results have returned in-turn

#### Scenario: Missing role falls back to native with an explicit notice

- **WHEN** a declared subtask needs a role that no configured `forge-*` agent matches
- **THEN** the discipline directs the model to run that subtask through a native task call and to tell the user about the gap, suggesting the missing role be configured

#### Scenario: Draft plan blocks /crew

- **WHEN** the session has an active draft plan and `/crew` is invoked
- **THEN** the command refuses with a pointer to `plan_approve` or `/plan discard`

#### Scenario: One crew per session

- **WHEN** a crew is already active in the session and `/crew` is invoked again
- **THEN** the command refuses, naming the active crew

#### Scenario: Restart mid-crew is an honest death

- **WHEN** the host restarts while a crew run is active
- **THEN** crew state is gone after restart and a new `/crew` starts fresh — no residue, no resume

### Requirement: crew_close completion gate

The plugin SHALL register a `crew_close` tool pinned to ask-level confirmation (never auto-allowed, not exempted by user allow config). The tool SHALL cross-check the submitted report against the crew's registered subtask plan: it SHALL refuse when any declared subtask lacks a verdict or an evidence statement, when the report carries a subtask that was never declared (renegade work — discoveries must be folded into existing verdict notes or the crew restarted, never silently adopted), or when a subtask failed both its attempt and its one retry yet is not marked FAIL. On success it SHALL end the crew and emit the summary (per-subtask verdict and evidence) as the tool's output — with the dispatch ledger removed there is no persistent crew record; the close output and the session transcript are the record.

#### Scenario: Closing with full evidence

- **WHEN** every declared subtask has a verdict with an evidence statement and the user confirms the ask dialog
- **THEN** `crew_close` ends the crew and emits the summary as its output

#### Scenario: Incomplete crew cannot close

- **WHEN** a declared subtask is missing a verdict or an evidence statement
- **THEN** `crew_close` errors naming the gaps and the crew continues

#### Scenario: Renegade subtask is refused

- **WHEN** the report contains a subtask title that was not part of the plan registered at `crew_begin`
- **THEN** `crew_close` refuses, naming the undeclared subtask and pointing at the fold-or-restart rule

#### Scenario: Bounded retry then honest FAIL

- **WHEN** a subtask fails its attempt and its single retry
- **THEN** the final report carries it as FAIL with both failure reports visible, and `crew_close` permits closing with the FAIL on record (refusal is for missing, dropped, or undeclared results, not for honest failures)

### Requirement: Unconfigured crew initialization gate

When `/crew` is invoked and the winning forge.json yields an empty agent set (no file anywhere in the cascade, or a file whose agents all failed validation), the command SHALL refuse entry into crew orchestration (hard gate) and SHALL present initialization guidance stating: the two configuration file paths (project-level first), a copy-paste JSONC agent template embedded in the command's discipline text, and the choice between configuring it themselves or having the session AI do so — where AI-assisted configuration SHALL happen only after the user's explicit go-ahead in that conversation, through the normally-visible write path. The guidance SHALL also state the application timing: newly added agents require a host restart to enter the task vocabulary, while `thoughtLevel` edits apply without restart. The plugin itself SHALL never write or create the file. This invitation surface SHALL exist only inside the unconfigured `/crew` flow — no other plugin surface (tool description, agent prompt, error path) SHALL invite AI-authored configuration.

#### Scenario: Unconfigured /crew refuses with initialization guidance

- **WHEN** `/crew <objective>` is invoked and the effective agent set is empty
- **THEN** entry into orchestration is refused and the response names the two file paths, shows the embedded template, offers the self-configure or AI-assisted options with the consent rule, and states the restart/hot-apply timing

#### Scenario: The configuration invitation lives only in the /crew gate

- **WHEN** any other plugin surface is inspected (tool descriptions, materialized agent prompts, error paths)
- **THEN** no surface invites the session AI to author forge.json — the everyday dispatch path stays configuration-silent

#### Scenario: A configured crew bypasses the gate

- **WHEN** `/crew <objective>` is invoked and at least one agent materialized successfully
- **THEN** the gate does not fire and orchestration discipline proceeds normally
