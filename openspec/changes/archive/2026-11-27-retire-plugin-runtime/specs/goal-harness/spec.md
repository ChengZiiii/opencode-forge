## ADDED Requirements

### Requirement: Host-aligned interpreter for verification shell checks

Every plugin-spawned plan or goal verification shell check (`plan_close`, `goal_check` recording or `goal_complete` gate re-run) SHALL resolve its interpreter through the host-aligned selection chain instead of the Node `shell: true` default (cmd.exe on Windows, `/bin/sh` on POSIX). The chain SHALL be: a host-configured shell, when one is visible to the plugin in the merged host config, takes precedence; otherwise on Windows the first available of `pwsh` → `powershell` → git-bash → `%COMSPEC%` (cmd.exe as a machine-level capability fallback only), and on POSIX the environment login shell with `bash` preferred and `/bin/sh` as the capability fallback. PowerShell-family interpreters SHALL be invoked directly as `<shell> -NoProfile -Command <command>` with an exit-code guard so a native command's exit status propagates as the check's exit status. No plugin option SHALL configure or override the interpreter choice.

#### Scenario: PowerShell syntax executes on Windows

- **WHEN** a plan or goal verification shell check runs a PowerShell-syntax command (e.g. `Get-Content "$env:USERPROFILE\..."`) on a Windows host where a PowerShell-family binary is available
- **THEN** the check's process tree root is the resolved PowerShell binary invoked as `-NoProfile -Command <command>` (never through a cmd.exe `/c` wrapper), and the check's verdict reflects the command's exit status

#### Scenario: Exit code of a wrapped native command propagates

- **WHEN** a native command inside a PowerShell-wrapped check invocation exits with a nonzero status
- **THEN** the check's reported exit code equals that nonzero status (the wrapper does not swallow it)

#### Scenario: POSIX prefers bash with login semantics

- **WHEN** a plan or goal verification shell check runs on a POSIX host where `/bin/bash` exists
- **THEN** the command executes under bash (login invocation) rather than plain `/bin/sh`

#### Scenario: Capability fallback still executes

- **WHEN** the resolution chain reaches its tail (no pwsh/powershell/git-bash on Windows; no bash on POSIX)
- **THEN** the check still executes via cmd.exe (`/c`) or `/bin/sh` respectively, and no error is raised solely because a preferred interpreter was absent

#### Scenario: Host-configured shell wins

- **WHEN** the host exposes a configured shell option visible in the merged config
- **THEN** the verification check resolves to that shell in preference to the platform defaults

#### Scenario: The host exposes no initial merged shell setting

- **WHEN** the public plugin interface does not expose the initial merged host shell setting
- **THEN** the platform selection chain remains the verification interpreter contract; the plugin does not claim equivalence with a potentially configured native shell, infer an initial setting from another session's shell event, or independently merge host configuration

## MODIFIED Requirements

### Requirement: No-progress auto-pause

The engine SHALL assess observable activity per actual goal work continuation turn only (ordinary replies outside the goal loop never count). Qualifying activity includes meaningful reads, reconnaissance and review, real writes, plan ticks, commits, verification (`goal_check` or the host's builtin shell) with new evidence, diagnosis of a failure with new evidence, and accepted native dispatch rounds (deduplicated per round). Read-only work and non-git workspaces SHALL NOT require a file change, git diff, or shell execution to count as activity. Waiting on outstanding host work or a legitimate host-side wait SHALL NOT be treated as a work turn or stagnation. Unknown or incomplete observations SHALL NOT be guessed to be inactivity, progress or settlement. The existing two-consecutive-turn no-progress threshold SHALL apply only to clearly established absence of activity, causing auto-pause with stop reason `no-progress` and a handoff directive. A lightweight repeated-no-information check SHALL distinguish demonstrably identical check inputs and results across work continuations, with no other new activity or evidence: repeating such checks SHALL NOT indefinitely reset the no-progress detector, and persistent confirmed repetition SHALL trigger an appropriate bounded no-progress pause with the repeated evidence disclosed. A changed result, new evidence, a different meaningful investigation or other qualifying activity SHALL break repetition; uncertain equality SHALL NOT be treated as repetition. No semantic scoring, LLM verifier, generic process supervision or guarantee of detecting every loop inside a single model turn is introduced. The existing Turn Ledger and Check Log remain auditable; check execution is recorded even when its repetition adds no information.

#### Scenario: Spinning without effect pauses the loop

- **WHEN** two consecutive goal work continuations are confirmed to have no qualifying activity, neither is waiting, and observations are sufficient to establish inactivity
- **THEN** the goal auto-pauses with stop reason `no-progress` instead of burning budget

#### Scenario: A verifying turn is never mis-scored

- **WHEN** a continuation turn runs the goal's verification commands through the builtin shell tool and obtains new evidence but writes nothing
- **THEN** the turn is scored as activity, the streak resets, and the loop continues

#### Scenario: Productive read-only and non-git work is not stagnation

- **WHEN** work continuations perform meaningful reconnaissance, review, failure diagnosis with new evidence, or a commit, including work outside a git repository where applicable
- **THEN** the turn is not classified as no-progress merely because it wrote no file, produced no diff, or ran no shell command

#### Scenario: Identical checks cannot keep the goal alive indefinitely

- **WHEN** successive goal work turns repeatedly run a check with provably equal inputs and results and no other new activity
- **THEN** repetition is detected with lightweight observable evidence and bounded by a no-progress pause, not counted indefinitely as progress; changed results, new evidence or other activity break the repetition, and incomplete observations do not prove it

### Requirement: Continuation turn verification discipline

The continuation brief SHALL teach productive work toward the goal criteria, including read-only reconnaissance/review, new verification or diagnosis evidence, real changes, commits and native dispatch; legitimate host waiting is not work. It SHALL NOT demand a write, shell check or git diff each turn, nor encourage repeated checks without new information. If a concrete local issue blocks only one path and independent authorized work remains, continue that work; if no independent work can advance the goal without user input or an unavailable prerequisite, call `goal_pause` with the concrete blocker instead of merely narrating it and ending the turn. The detector SHALL NOT decide to pause by matching keywords in natural-language replies. The brief SHALL teach the same distinction the detector enforces.

#### Scenario: The brief states the per-turn discipline

- **WHEN** a continuation brief is sent
- **THEN** it teaches qualifying work, legitimate waiting and concrete blocker pause, without requiring write/verification each turn or a git diff

#### Scenario: A local blocker does not stop independent work

- **WHEN** one subtask or approach is blocked but another authorized independent task can still advance the goal
- **THEN** the discipline directs continuing the independent work rather than pausing the entire goal; incidental natural-language blocker wording alone does not trigger pause

### Requirement: Autonomous continuation under budget

While the session's goal is active, the plugin SHALL listen for `session.idle` and, after a short debounce and a re-check that the session is still idle, send a compact continuation prompt through the host client containing the goal brief (statement, success criteria, outstanding verification items, remaining budget) and directives (work the criteria, `goal_check` when you believe they hold, `goal_complete` at the gate, `goal_pause` with a blocker summary if stuck; when the work calls for parallel decomposition, own the crew layer — register crews with `crew_begin {execution: "waves"}` in a single call, dispatch native `subagent` waves under the crew discipline, and re-shard via `crew_close {abandon}` plus a fresh registration when the decomposition proves wrong — the goal contract's arming authorization covers this orchestration autonomy) The crew-layer directive SHALL be STRUCTURE-AWARE: when the goal contract's criteria or constraints carry a numbered subtask structure or name `forge-*` agents, the brief SHALL direct preferring born-armed crew re-registration (one-call `execution: "waves"`) over self-executing the whole plan in the main session; without such structure the discretionary phrasing stands. Each actual work continuation SHALL increment `turns_used` exactly once. The loop SHALL enforce two budgets — continuation turns and wall-clock minutes since arming, including crew waiting (existing hard ceiling, armed_at, revision and restart semantics unchanged) — with defaults and hard ceilings; budget exhaustion SHALL auto-pause the goal with the matching stop reason and send one wrap-up continuation directing a handoff summary, never silently keep looping. Consecutive continuation delivery failures SHALL be counted and after a small threshold SHALL auto-pause with a transport stop reason. The existing one-time budget wrap-up is a handoff-only prompt, not authorization for further goal work; it SHALL NOT override an intervening explicit pause. Token budgets are outside this change's implementation scope: only a host capability probe is planned, and unproven metering SHALL NOT be presented as a hard limit.

#### Scenario: Idle session with an active goal continues

- **WHEN** the model finishes a reply without completing the goal and the session goes idle
- **THEN** the plugin sends the continuation prompt and the session resumes working the goal

#### Scenario: Turn budget exhausted

- **WHEN** `turns_used` reaches the goal's turn budget
- **THEN** the goal auto-pauses with stop reason `budget-turns` after one wrap-up handoff prompt; no further continuation is sent

#### Scenario: Continuation transport keeps failing

- **WHEN** three consecutive continuation sends fail
- **THEN** the goal auto-pauses with a transport stop reason instead of retrying forever

#### Scenario: No continuation for non-owner sessions

- **WHEN** a second session in the same workspace goes idle while the goal belongs to another session
- **THEN** that session sends no continuation (single continuation owner)

#### Scenario: Continuation brief owns the crew layer

- **WHEN** a goal continuation fires and the work benefits from parallel decomposition
- **THEN** the brief's directives authorize one-call crew arming (`execution: "waves"` at registration) and abandon-based re-sharding, and the crew tools' gates stay internal to the loop — no user dialog mid-loop

#### Scenario: A structured goal contract prefers born-armed orchestration

- **WHEN** the goal contract's criteria or constraints name `forge-*` agents or carry a numbered subtask structure and the session goes idle under the active goal
- **THEN** the brief directs re-registering the plan as a born-armed crew (one-call `execution: "waves"`) over self-executing the entire plan in the main session

While an active goal has positively established outstanding host work or legitimate host-side waiting (including accepted native child rounds with or without a crew, owning-session background shell work and pending host permission/user responses where observable), normal goal continuation SHALL be suppressed. The engine SHALL use existing host-observable evidence and bounded harness-local observation; uncertainty, missing or incomplete events SHALL NOT be guessed to mean either settlement or inactivity. No polling-induced model turns SHALL be sent merely to wait; bounded diagnostic or budget handoff, if still authorized, is not a work continuation. Wall-clock minutes still elapse and expiration SHALL pause even while waiting. When the wait is verifiably resolved, only the still-authorized owner may resume once through the normal debounce and busy recheck. For goal-governed crews, shared crew in-flight observation SHALL suppress normal continuation while waiting for outstanding rounds. Held decisions and partial host-result wakes SHALL NOT consume turns, no-progress streak or delivery-failure budget merely for waiting. A bounded diagnostic handoff on an unreadable view or ceiling SHALL disclose unresolved evidence without starting a next wave or converting waiting into work; explicit goal pause/discard and draft conflict retain precedence. Only upon independently verified settlement of every outstanding round, the goal engine alone resumes once through its normal debounce and busy recheck, with no crew brief. Budget expiration during waiting SHALL pause the goal with the existing stop reason and bounded handoff, without falling back to standalone crew autonomy. Pause, discard, completion and loss of active governing authorization SHALL inhibit crew continuation; only the existing explicit user arming or resume path can restore authorization (crew-harness). Accounting SHALL deduplicate round observations and distinguish a new accepted dispatch reusing a session id.

#### Scenario: Goal-governed crew waits without burning continuation budget

- **WHEN** an active goal owns a born-armed crew with a partial wave, including duplicate idle or result observations
- **THEN** no normal goal or crew continuation is injected while waiting, no next wave starts, and turn, delivery-failure and no-progress budgets are not consumed merely by waiting; wall-clock minutes continue to elapse; when every round is verified settled and the goal remains active within budget, only one goal continuation resumes

#### Scenario: Legitimate host waiting without a crew does not spin

- **WHEN** the goal owner has observable outstanding native child work, background shell work or a pending host response, including duplicate idle notifications and incomplete result observations
- **THEN** no normal work prompt is sent merely to wait, neither turn nor stagnation nor delivery-failure counters advance for waiting, minutes still elapse and can expire, and only verified resolution within active authorization permits one continuation; unknown status is disclosed without guessing settlement

### Requirement: Pause, resume, discard, and explicit reactivation

`goal_pause` SHALL be available at any time without a confirmation gate (pausing is always safe) and SHALL atomically persist `status: paused` with a concrete stop reason/blocker in the existing goal file. The five existing states (`queued`, `active`, `paused`, `completed`, `abandoned`) and file format SHALL remain unchanged. A successful pause SHALL take precedence over pending or scheduled continuation, stale in-memory decisions and later idle/result notifications: re-check current persisted status, owner and revision before committing a continuation or admitting new autonomous goal work. No new autonomous work calls, including native dispatch (forge or fallback), or new goal/crew work continuation may be initiated under paused authorization; an already admitted in-flight call or host work is not promised cancellation, and its eventual result is not a resume signal. Duplicate or late idle/results and host restart SHALL NOT re-arm a paused goal nor downgrade a goal-governed crew to standalone. This restriction concerns autonomous authorization, not ordinary user-directed chat or the existing explicitly authorized standalone crew path. Re-arming SHALL require explicit intent routed through the gated `goal_resume`: short, unambiguous continuation phrases from the user (e.g. "continue", "resume") SHALL be routed by the model to `goal_resume`, whose ask gate protects the transition; arbitrary chat SHALL NOT reactivate a paused goal. `goal_resume` MAY accept a budget top-up (bounded by hard ceilings) and SHALL rebind ownership to the resuming session. `goal_discard` SHALL abandon the goal under an ask-level user confirmation (abandoning the user's objective is the user's decision). Existing completion checks, criterion attestations and confirmation gates are unchanged.

#### Scenario: Model self-reports a blocker

- **WHEN** the model encounters a concrete blocking prerequisite or user decision and cannot advance independent authorized work, then calls `goal_pause` with a reason
- **THEN** the goal file persists paused status and the concrete blocker, the loop stops, and the user decides to resume or discard

#### Scenario: "Continue" routes through the gate

- **WHEN** the goal is paused and the user types "continue"
- **THEN** the model calls `goal_resume`, the confirmation dialog appears, and only on allow does continuation re-arm

#### Scenario: Ordinary chat does not reactivate

- **WHEN** the goal is paused and the user discusses an unrelated topic
- **THEN** no continuation is sent and the goal stays paused

#### Scenario: Pause wins over stale continuation decisions and late results

- **WHEN** `goal_pause` succeeds while continuation is debounced or work is in flight, and repeated/late idle or results arrive before or after restart
- **THEN** the persisted paused status and blocker remain authoritative, no new autonomous work call or goal/crew continuation is admitted, already admitted work is not promised cancellation, and only the existing explicit resume gate can restore goal authorization

### Requirement: Mid-flight checks, Check Log, and Turn Ledger

`goal_check` SHALL execute the goal's verification items (or a selected subset) with the same host execution semantics as the completion gate, appending one dated, revision-stamped entry per run to the Check Log (item, exit code or file-contract result, truncated output). Recorded results are advisory feedback for the model and carry no gating authority. Each actual continuation work turn SHALL append a Turn Ledger entry (turn number, whether any write-class tool, `goal_check`, or verification command ran, plus the observable activity disposition under 'No-progress auto-pause') using the existing ledger; waiting alone is not a turn. Recorded tool execution SHALL remain distinct from new information, so repeated identical checks remain auditable without being credited as progress.

#### Scenario: Model verifies progress mid-flight

- **WHEN** the model believes the criteria may now hold and calls `goal_check`
- **THEN** the items actually run on the host and a dated, revision-stamped entry appears in the Check Log

#### Scenario: Turn activity is recorded

- **WHEN** an actual continuation work turn ends
- **THEN** the Turn Ledger gains an entry stating whether that turn contained writes, checks, or verification commands and its observable activity disposition; waiting by itself creates no work turn

