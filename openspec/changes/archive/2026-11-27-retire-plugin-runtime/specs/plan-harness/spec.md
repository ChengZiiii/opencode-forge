## ADDED Requirements

### Requirement: Planning discipline travels in the plan command

The plugin SHALL ship no skill file and SHALL register none. The planning discipline SHALL travel in the `/plan` command template — the command's own turn is the rulebook — and SHALL cover: planning discipline (read-only reconnaissance and clarifying questions before persisting; execute only after approval), the tick-immediately discipline, and the tiering boundary — work expected to span sessions, involve long multi-file change, or need multi-round requirement review SHALL be recommended to an OpenSpec spec workflow instead of a plan. Nothing SHALL be copied into the user's config directory.

#### Scenario: The plan command carries the discipline

- **WHEN** the `/plan` command's template is inspected
- **THEN** it states the read-only reconnaissance and alignment step with its clarifying questions, approval before any execution, ticking each task the moment it is done, and that long-horizon work is spec work rather than plan work

#### Scenario: No skill ships

- **WHEN** the published package is inspected
- **THEN** it contains no SKILL.md, and the plugin registers no skill with the host
## MODIFIED Requirements

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

## REMOVED Requirements

### Requirement: Bundled skill single-channel distribution and planning discipline

- **Reason**: No skill file ships and no plugin entry registers one — the v2 port's design already records that forge ships no bundled skill, and the planning discipline rides the `/plan` command template. The requirement also described a v1-era config channel (`config.skills.paths`) that no longer exists.
- **Migration**: See ADDED 'Planning discipline travels in the plan command'.
