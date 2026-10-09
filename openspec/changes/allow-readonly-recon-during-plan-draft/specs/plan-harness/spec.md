# plan-harness Delta — allow-readonly-recon-during-plan-draft

## MODIFIED Requirements

### Requirement: Hard write ban during draft

While the current session has an active draft (created via `/plan` or bound via `/plan resume`, with status draft), the permission layer SHALL unconditionally deny write-class tools (edit, write, bash, and other mutating tools); an `allow` in the user's config SHALL NOT override it. Read-class tools and the harness tools (`plan_*`) SHALL be allowed. Subagent dispatch SHALL be gated by target shape instead of denied wholesale: while the draft is active, a `task` call whose target resolves to a materialized forge subagent of **effective readonly shape** SHALL be allowed as a reconnaissance dispatch (breadth evidence-gathering without spending the planning session's context), and every other `task` call — a write-shape worker, a native agent target, an absent target, or a target that cannot be resolved (including resume calls that carry no target) — SHALL be denied exactly like any write-class tool, with a refusal that names the currently dispatchable effective-readonly roster (empty-roster refusals SHALL point to defining a readonly worker in forge.json) and the exits (`plan_approve` / discard). Effective readonly shape SHALL mean: the definition's `shape` is not `"write"` (absent defaults to readonly) AND no explicit permission override in the definition lifts `write`, `edit`, or `bash` off `"deny"` (any other value — `allow` or `ask` — counts as lifted; the judgment is fail-closed). The denial SHALL NOT be overridable by user allow config. The `/plan` discipline text SHALL state the split accurately: write tools and bash are denied during draft, reconnaissance may dispatch effective-readonly forge scouts (before and during the draft), and write-shaped workers wait for approval. After `plan_approve` approves or discard abandons the plan, the ban and the shape gate SHALL lift immediately.

#### Scenario: Writing a file during draft is denied

- **WHEN** the session has an active draft and the model calls a write/edit-class tool
- **THEN** the call is denied by the permission layer, with a message pointing to `plan_approve` or discard

#### Scenario: bash during draft is denied

- **WHEN** the session has an active draft and the model calls bash
- **THEN** the call is denied for the same reason

#### Scenario: A readonly recon dispatch passes during draft

- **WHEN** the session has an active draft and the model dispatches `task {subagent_type: "forge-research"}` where `research` is defined with no shape (defaults readonly) and no permission override
- **THEN** the dispatch is allowed, the scout session runs with its materialized readonly permission (write/edit/bash denied, task denied), and its findings return to the planning session as the task result

#### Scenario: A write-shape dispatch is denied with roster guidance

- **WHEN** the session has an active draft and the model dispatches `task {subagent_type: "forge-coder"}` where `coder` is defined with `shape: "write"`
- **THEN** the call is refused like any write-class tool, and the refusal names the dispatchable effective-readonly roster and the exits (plan_approve / discard) — never a bare "wait for approval"

#### Scenario: Unresolvable and native targets fail closed

- **WHEN** the session has an active draft and the model dispatches `task` with a native agent target (`general`/`explore`), with no `subagent_type`, or with a resume `task_id` that carries no target
- **THEN** every such call is denied like any write-class tool during draft

#### Scenario: A permission override breaks effectiveness

- **WHEN** a definition declares no `shape` (defaults readonly) but its `permission` map sets `write: "allow"` (or `edit`/`bash` to any value other than `"deny"`), and the model dispatches it during a draft
- **THEN** the target is not effective-readonly and the call is denied with the same roster guidance

#### Scenario: The ban lifts after approval

- **WHEN** `plan_approve` succeeds with user confirmation and the model calls a write-class tool again
- **THEN** the write goes through the normal permission flow

#### Scenario: Graceful degradation after process restart

- **WHEN** the opencode process restarts with a status-draft plan still on disk
- **THEN** the write ban no longer applies automatically (session binding state is lost); skill discipline still guides approval or resume first, and the session-start notice surfaces the unfinished plan
