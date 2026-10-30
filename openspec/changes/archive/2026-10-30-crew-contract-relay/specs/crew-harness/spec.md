# crew-harness Delta — crew-contract-relay

> 与 sole-pool-ownership 同改「/crew command discipline」requirement：两者携带**逐字相同**的超集文本（roster 会话域化 + 契约中继），任一归档顺序都收敛到同一终态。

## MODIFIED Requirements

### Requirement: /crew command discipline

The plugin SHALL register a `/crew <objective>` command that enters crew orchestration discipline in the current session (single-subject: no agent switching). The discipline SHALL mandate: after any needed reconnaissance, decompose the objective into subtasks and REGISTER the plan via `crew_begin {objective, subtasks}` — each subtask carrying a title and, optionally, the intended `forge-*` agent and an acceptance-evidence statement. `crew_begin` SHALL accept an optional `lineage` argument (free-text origin of the macro contract — e.g. the plan artifact path this crew descends from); when present, it SHALL be recorded as a first-class `lineage:` line in the crew record header (explicit argument only — the plugin SHALL NOT infer lineage by linking to recently-terminal plans). When the macro contract descends from an on-disk artifact (the `lineage` value names a plan artifact, a spec change directory, or a goal contract), the discipline SHALL require every subtask's dispatch prompt to explicitly carry that artifact's path — or the exact slice the subtask works from — so the dispatched worker reads the contract itself; and every close-report evidence statement SHALL name the contract (or its slice) the subtask worked against. The `crew_begin` registration output SHALL remind the session AI of this relay rule whenever `lineage` is present. Registration enters a **PENDING** crew, writes the crew record file, and the registration output SHALL lead with the crew record path line (the same first-block prominence as the plan tools' `Plan created:` line) before the objective summary and declared plan; the session SHALL stop and present the execution-mode choice — begin supervised waves now, convert the objective into an autonomous goal contract, or stand by — ending the turn, and the PENDING pause text SHALL instruct the session AI to relay the crew record path to the user when presenting that choice (the record is on disk from the registration moment — the user must hear it). Execution SHALL start only after the user's decision arms the crew via a follow-up `crew_begin {execution}` call. The `/crew` command template's roster section SHALL be SESSION-SCOPED: the session's dispatchable roster first — its workspace pool (the `.opencode/forge.json` owning this session's worktree) or, when the workspace has none, the global layer — each with its origin path; every other pool materialized on this host SHALL be listed after it, each marked NOT dispatchable from this session with its origin path. The registration output SHALL disclose the origin of the session's dispatchable roster the same way (the owning forge.json path — workspace pool or global fallback), and whenever the residual mismatch disclosure fires (the session's workspace carries a forge.json this host has not yet materialized, so its roles are temporarily undispatchable), it SHALL pair that disclosure with the remediation: a host re-initialization in that workspace, or moving the roles into the global layer. Where the discipline or the unconfigured guidance teaches the session AI how to write a forge.json on the user's explicit go-ahead, it SHALL additionally propose a short, stable `pool` namespace for the file and include the field (directory-name-independent agent ids). Once armed for waves, execute the plan in waves of parallel native `task` calls (a wave's results return within the calling turn; the next wave launches only after the previous wave's results are in — never flooding); when a subtask calls for a role that no configured agent matches, execute that subtask through a native task call and surface the gap to the user with a suggestion to configure the missing role; verify each subtask's evidence from the task results; retry a failed subtask at most once (adjusted prompt or agent); finish with a completion report covering every declared subtask. The crew discipline is source-agnostic about the macro contract above it — an approved plan artifact, a spec change document, or inline objective text all feed the same discipline, and crew never requires a plan artifact to exist. An active plan draft SHALL refuse `/crew` naming all three exits: `plan_approve` (an approved plan does NOT block `/crew` — the crew may carry the approved plan's contract), `/plan discard`, or `/plan discard {supersede}` when the work moves into the crew (mutual-exclusion safety interop, not an ordering dependency); a session with an active crew SHALL refuse a second concurrent `/crew`; argument-less `/crew` SHALL print usage. Crew state is in-memory and session-bound: on host restart it dies honestly and a new `/crew` starts fresh — there is no cross-session crew resume in this capability; the record file under `.opencode/crew/` is inert history, never a resume mechanism.

#### Scenario: /crew decomposes and paces waves on briefs

- **WHEN** the user runs `/crew` with an objective and the model follows the discipline
- **THEN** the subtask plan is registered through `crew_begin`, subtasks execute as parallel native `task`-call waves, and a later wave launches only after the previous wave's results have returned in-turn

#### Scenario: Missing role falls back to native with an explicit notice

- **WHEN** a declared subtask needs a role that no configured `forge-*` agent matches
- **THEN** the discipline directs the model to run that subtask through a native task call and to tell the user about the gap, suggesting the missing role be configured

#### Scenario: Registration pauses for the execution-mode decision

- **WHEN** `crew_begin` registers the subtask plan and the roster is confirmed
- **THEN** the session presents the execution-mode choice (supervised waves / goal conversion / standby) and ends the turn — no `task` dispatch happens before the user's decision

#### Scenario: Host pool origin is disclosed

- **WHEN** the host has materialized the session's workspace pool plus other workspaces' pools (and/or the global layer)
- **THEN** the `/crew` template's roster lists the session's dispatchable pool first with its forge.json origin path (workspace pool, or the global layer marked as fallback when the workspace has none), followed by every other host pool marked NOT dispatchable from this session with its origin path — and the residual mismatch disclosure (a session-workspace forge.json the host has not yet materialized) still pairs with its remediation lines

#### Scenario: Lineage is relayed into dispatch prompts

- **WHEN** `crew_begin` is called with `lineage: ".opencode/plan/2026-10-01-....md"` (or a spec change directory / goal contract path) and the crew is later armed
- **THEN** the discipline requires each subtask's dispatch prompt to carry the artifact path or its exact slice, the registration output reminds the session AI of this relay rule, and every close-report evidence statement names the contract (or slice) the subtask worked against

#### Scenario: AI-assisted forge.json creation proposes a pool namespace

- **WHEN** the session AI writes a forge.json on the user's explicit go-ahead (unconfigured-host guidance or missing-role configuration)
- **THEN** the written file includes a proposed short, stable `pool` namespace (e.g. `"aa"` for the devAa specialist pool), keeping the materialized agent ids independent of directory renames

#### Scenario: Registered plan lands as an inspectable record

- **WHEN** `crew_begin` registers the subtask plan
- **THEN** the declared plan is written to a record file under the session workspace's `.opencode/crew/` directory, arm / convert / abandon / close append to it, and the record never resumes a dead crew — after host restart it is inert history

#### Scenario: The record path leads the registration output and is relayed

- **WHEN** `crew_begin` registration succeeds
- **THEN** the crew record path appears in the first block of the tool output (before the objective summary and declared plan), and the PENDING pause text instructs the session AI to relay that path to the user alongside the execution-mode choice

#### Scenario: Lineage is recorded as a first-class line

- **WHEN** `crew_begin` is called with `lineage: ".opencode/plan/2026-10-01-....md"`
- **THEN** the crew record header carries a `lineage:` line with that value — the descent is machine-recorded, not left to prose in the objective

#### Scenario: Planless crew runs the same discipline

- **WHEN** `/crew` is invoked with the macro contract sourced from a spec change document or inline text instead of a plan artifact
- **THEN** the discipline is identical — no plan dependency exists, and no surface of the crew flow assumes plan precedence

#### Scenario: Draft plan blocks /crew

- **WHEN** the session has an active draft plan and `/crew` is invoked
- **THEN** the command refuses naming `plan_approve` (with the note that an approved plan does not block `/crew`), `/plan discard`, and `/plan discard {supersede}` for moving the work into the crew

#### Scenario: One crew per session

- **WHEN** a crew is already active in the session and `/crew` is invoked again
- **THEN** the command refuses, naming the active crew

#### Scenario: Restart mid-crew is an honest death

- **WHEN** the host restarts while a crew run is active
- **THEN** crew state is gone after restart and a new `/crew` starts fresh — no residue, no resume
