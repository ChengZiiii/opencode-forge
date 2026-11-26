# crew-harness Specification

## Purpose
The /crew file-backed orchestration harness: register declared subtasks, obtain execution authorization, govern waves of host-native `subagent` calls and verified round settlement, and cross-check close verdicts against declared work, attempts, fallback disclosure and actual evidence. The host owns execution and completion notifications; Crew governs waiting, continuation and bounded retry discipline without a plugin dispatch engine.

## Requirements

### Requirement: /crew command discipline

The plugin SHALL register a `/crew <objective>` command that enters crew orchestration discipline in the current session (single-subject: no agent switching). The discipline SHALL mandate: after any needed reconnaissance, decompose the objective into subtasks and REGISTER the plan via `crew_begin {objective, subtasks}` — each subtask carrying a title and, optionally, the intended `forge-*` agent and an acceptance-evidence statement. `crew_begin` SHALL accept an optional `lineage` argument (free-text origin of the macro contract — e.g. the plan artifact path this crew descends from); when present, it SHALL be recorded as a first-class `lineage:` line in the crew record header (explicit argument only — the plugin SHALL NOT infer lineage by linking to recently-terminal plans). When the macro contract descends from an on-disk artifact (the `lineage` value names a plan artifact, a spec change directory, or a goal contract), the discipline SHALL require every subtask's dispatch prompt to explicitly carry that artifact's path — or the exact slice the subtask works from — so the dispatched worker reads the contract itself; and every close-report evidence statement SHALL name the contract (or its slice) the subtask worked against. The `crew_begin` registration output SHALL remind the session AI of this relay rule whenever `lineage` is present. Registration enters a **PENDING** crew, writes the crew record file, and the registration output SHALL lead with the crew record path line (the same first-block prominence as the plan tools' `Plan created:` line) before the objective summary and declared plan; the session SHALL stop and present the execution-mode choice — begin supervised waves now, convert the objective into an autonomous goal contract, or stand by — ending the turn, and the PENDING pause text SHALL instruct the session AI to relay the crew record path to the user when presenting that choice (the record is on disk from the registration moment — the user must hear it). Execution SHALL start only after the user’s decision arms the standalone crew via a follow-up `crew_begin {execution}` call, or the active governing goal authorizes born-armed registration as below. The `/crew` command template's roster section SHALL be SESSION-SCOPED: the session's dispatchable roster first — its workspace pool (the `.opencode/forge.json` owning this session's worktree) or, when the workspace has none, the global layer — each with its origin path; every other pool materialized on this host SHALL be listed after it, each marked NOT dispatchable from this session with its origin path. The registration output SHALL disclose the origin of the session's dispatchable roster the same way (the owning forge.json path — workspace pool or global fallback), and whenever the residual mismatch disclosure fires (the session's workspace carries a forge.json this host has not yet materialized, so its roles are temporarily undispatchable), it SHALL pair that disclosure with the remediation: a host re-initialization in that workspace, or moving the roles into the global layer. Where the discipline or the unconfigured guidance teaches the session AI how to write a forge.json on the user's explicit go-ahead, it SHALL additionally propose a short, stable `pool` namespace for the file and include the field (directory-name-independent agent ids). Once armed for waves, execute the plan in waves of native `subagent` calls — a wave is the set of calls made together; every call returns at once and the children work in the background, so a wave's results arrive later, each in the host's own completion message, and the next wave launches only after every round of the previous wave is verified settled; waiting or idle status alone never advances the wave — never flooding. The discipline SHALL tell the session AI that host completion notifications may arrive separately: a wave is complete only when every dispatched work round has a verified settled result; partial, truncated or unknown session lists, idle or missing rows and unresolved outcomes SHALL NOT settle a wave, and a wake that carries some but not all of a wave's results SHALL NOT launch the next wave (the session ends its turn and waits for the rest). When a subtask calls for a role that no configured agent matches, dispatch that subtask through a native `subagent` call for a non-forge agent and surface the gap to the user with a suggestion to configure the missing role; verify each subtask's evidence from the children's reports; retry a failed subtask at most once (a fresh dispatch with an adjusted prompt or agent — nothing retries automatically); finish with a completion report covering every declared subtask. The crew discipline is source-agnostic about the macro contract above it — an approved plan artifact, a spec change document, or inline objective text all feed the same discipline, and crew never requires a plan artifact to exist. An active plan draft SHALL refuse `/crew` naming all three exits: `plan_approve` (an approved plan does NOT block `/crew` — the crew may carry the approved plan's contract), `/plan discard`, or `/plan discard {supersede}` when the work moves into the crew (mutual-exclusion safety interop, not an ordering dependency); a session with an active crew SHALL refuse a second concurrent `/crew`; argument-less `/crew` SHALL print usage. Crew state is in-memory and session-bound: on host restart it dies honestly and a new `/crew` starts fresh — there is no cross-session crew resume in this capability; the record file under `.opencode/crew/` is inert history, never a resume mechanism.

#### Scenario: /crew decomposes and paces waves on briefs

- **WHEN** the user runs `/crew` with an objective and the model follows the discipline
- **THEN** the subtask plan is registered through `crew_begin`, subtasks execute as waves of native `subagent` calls, and a later wave launches only after every round of the previous wave is verified settled

#### Scenario: Missing role falls back to native with an explicit notice

- **WHEN** a declared subtask needs a role that no configured `forge-*` agent matches
- **THEN** the discipline directs the model to run that subtask through a native `subagent` call for a non-forge agent and to tell the user about the gap, suggesting the missing role be configured

#### Scenario: Registration pauses for the execution-mode decision

- **WHEN** `crew_begin` registers the subtask plan and the roster is confirmed
- **THEN** the session presents the execution-mode choice (supervised waves / goal conversion / standby) and ends the turn — no native `subagent` call is admitted before the user's decision

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

#### Scenario: A partial wave does not launch the next wave

- **WHEN** the host wakes a waves-armed session with the report of one child of the current wave while the wave's other children are still running
- **THEN** the discipline in force tells the session AI that the wave is not complete: it does not dispatch the next wave and ends its turn to wait for the remaining reports

### Requirement: crew_close completion gate

The plugin SHALL register a `crew_close` tool pinned to ask-level confirmation (never auto-allowed, not exempted by user allow config). The tool SHALL cross-check the submitted report against the crew's registered subtask plan: it SHALL refuse when any declared subtask lacks a verdict or an evidence statement, when the report carries a subtask that was never declared (renegade work — discoveries must be folded into existing verdict notes or the crew restarted, never silently adopted), or when a subtask failed both its attempt and its one retry yet is not marked FAIL. The close cross-check SHALL associate each declared subtask with its accepted dispatch/reused-session rounds, attempts (including at most one retry), fallback lane where used, and verified evidence using existing report, record and observable host results; no new record format or dispatch registry is required. Host session terminal state does not itself establish a subtask PASS: evidence must establish the actual declared acceptance outcome. An observed failed attempt SHALL NOT be represented as PASS; a verified successful retry may support final PASS with both attempts recorded. Unknown or incomplete evidence cannot establish PASS, nor can a partial/truncated/unknown session list settle outstanding work; refuse a claimed PASS lacking verified evidence. A final honest FAIL may disclose unverified or failed attempts under existing retry discipline; unresolved in-flight work is not a settled wave. On success it SHALL end the crew, emit the summary (per-subtask verdict and evidence) as the tool's output, and append a dated close section (per-subtask verdicts) to the crew record file — the record under `.opencode/crew/` is the persistent history; the close output is its relay. The tool SHALL additionally accept an abandon path: `crew_close {abandon: true, reason}` ends the crew with an abandonment record and NO verdict requirements — the exit for a wrong decomposition (re-shard: abandon, then register a fresh crew) and for cancelling a standby crew; the ask gate applies to abandonment exactly as to completion — except while a live active goal governs the session, where both close paths drop the ask requirement (crew gates are internal to the goal loop; the goal's gates remain the user boundary). A crew ended by abandonment or conversion is over: its record file carries the final section, and a new `crew_begin` may follow immediately.

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

#### Scenario: Abandon path enables re-shard

- **WHEN** the decomposition proves wrong mid-execution (or a pending crew is cancelled) and the user confirms the ask dialog on `crew_close {abandon: true, reason}`
- **THEN** the crew ends with an abandonment record — no verdicts are demanded — and a fresh `crew_begin` may register a corrected plan immediately

#### Scenario: Close correlates rounds and verified subtask evidence

- **WHEN** a declared subtask uses a fallback or reused session, an earlier attempt fails, or its host outcome or result evidence is incomplete
- **THEN** close checks declared title, associated rounds and fallback notes against verified subtask evidence; it rejects unsupported PASS or a misrepresented failed attempt, permits a verified successful retry or honest final FAIL under existing retry rules, and never treats unknown enumeration as settlement

### Requirement: Unconfigured crew initialization gate

When `/crew` is invoked and the session's dispatchable roster is empty (neither the session's workspace pool nor the global fallback materializes any agent), the command SHALL refuse entry into crew orchestration (hard gate) and SHALL present initialization guidance stating: the two configuration layers and their relationship (the global `~/.config/opencode/forge.json` and the workspace's own `.opencode/forge.json` — SOLE OWNERSHIP: the nearest `.opencode/forge.json` walking up from the session's worktree owns the session and IS the whole roster; the global layer serves only as the fallback when the workspace has none — a fallback, not a merge; `forge.json` files nested deeper in the workspace subtree are ignored, the same workspace-ownership strictness as the host's native MCP config), a copy-paste JSONC agent template embedded in the command's discipline text, and the choice between configuring it themselves or having the session AI do so — where AI-assisted configuration SHALL happen only after the user's explicit go-ahead in that conversation, through the normally-visible write path. The guidance — template example AND prose — SHALL disclose the optional per-agent `prompt` field: an explicit prompt fully overrides the built-in role, only the ids `research` and `review` carry built-ins, and any other id without a prompt gets a generic one-liner (it will not know its job). The guidance SHALL likewise disclose the `shape` field: an ABSENT shape defaults to WRITE (open permissions — the compatibility-preserving default for existing pools), and `shape: "readonly"` is the explicit seal on the mutating-tool family for read-only roles; the embedded template example SHALL show the shape field on every agent entry. The guidance SHALL also state the id naming rule: ids are plain role words WITHOUT the `forge-` prefix, which the plugin adds at materialization (a prefixed id is auto-stripped with a warning). When the session AI writes the configuration on the user's go-ahead, it SHALL name ids as plain role words, SHALL give every agent a SHORT prompt derived from the role the user asked for — one or two sentences the user can trim or extend — SHALL give every agent an explicit `shape` (`readonly` for read-only roles — reviewers, scouts, planners; `write` for implementers and build-driving verifiers), SHALL write a long prompt only when the user explicitly asks for that agent, and SHALL include a proposed short, stable `pool` namespace for the file (a `[a-z0-9-]` word of at most 24 characters, independent of the directory name) so the materialized agent ids survive directory renames. The guidance SHALL also state the application timing: file edits, creations, and deletions hot-apply without a host restart — the plugin re-reads the files whenever it next resolves the roster — and a deleted pool file un-materializes its agents. The gate SHALL resolve the calling session's roster anchor through the SAME authoritative-first chain as the dispatch belts (the host session record via the anchor client — with its pooled-map preference and ledger-rebind semantics; the tool-context anchor is consulted only when no anchor client is available), and SHALL anchor its guidance on that resolved worktree where one is observable (walking up from it for the owning pool), falling back to the host launch directory; and when the session's worktree carries a `.opencode/forge.json` the host has not yet materialized (the residual mismatch case — e.g. the file was created after host start), the gate output SHALL say so explicitly — naming the discovered file and directing the user to a host re-initialization in that workspace or to moving the agents into the global layer — instead of claiming the feature is unconfigured. The same disclosure SHALL apply on a successful `crew_begin` whose session-anchored discovery found a forge.json the host did not materialize. The plugin itself SHALL never write or create the file. This invitation surface SHALL exist only inside the unconfigured `/crew` flow — no other plugin surface (tool description, agent prompt, error path) SHALL invite AI-authored configuration.

#### Scenario: Unconfigured /crew refuses with initialization guidance

- **WHEN** `/crew <objective>` is invoked and the session's dispatchable roster is empty (no workspace pool, no global fallback)
- **THEN** entry into orchestration is refused and the response names the two layers with the sole-ownership rule (the workspace pool IS the roster; global is fallback-only, never merged; nested forge.json files ignored), shows the embedded template — including the optional per-agent `prompt` field and the `shape` field with its absent-defaults-to-write rule — offers the self-configure or AI-assisted options with the consent rule, and states the hot-apply timing (file changes apply without a host restart; a deleted pool file un-materializes)

#### Scenario: AI-assisted configuration writes short role prompts

- **WHEN** the user explicitly asks the session AI to configure forge.json in that conversation
- **THEN** every agent the AI writes carries a SHORT prompt derived from the role the user asked for (one or two sentences), unless the user explicitly asked for a longer prompt on that agent — ids are named as plain role words without the `forge-` prefix, every agent carries an explicit `shape` (`readonly` for read-only roles, `write` for implementers), the file includes a proposed short stable `pool` namespace, and the consent rule (never write forge.json without the explicit go-ahead) still governs the write itself

#### Scenario: A workspace file the host cannot see is disclosed, not masked

- **WHEN** the session's dispatchable roster is empty but the calling session's worktree carries a usable `.opencode/forge.json` the host has not materialized
- **THEN** the gate output names that file and states that this host has not materialized it — directing the user to a host re-initialization in that workspace or to add the agents to the global layer — rather than reporting the feature as unconfigured

#### Scenario: The configuration invitation lives only in the /crew gate

- **WHEN** any other plugin surface is inspected (tool descriptions, materialized agent prompts, error paths)
- **THEN** no surface invites the session AI to author forge.json — the everyday dispatch path stays configuration-silent

#### Scenario: A configured crew bypasses the gate

- **WHEN** `/crew <objective>` is invoked and the session's dispatchable roster materializes at least one agent
- **THEN** the gate does not fire and orchestration discipline proceeds normally; if the session's own discovery additionally found a forge.json the host did not materialize, the crew_begin output carries that disclosure alongside the registration summary

#### Scenario: A re-anchored session resolves its roster from the authoritative record

- **WHEN** the session was created in a pool-less directory, the host session record now carries a pool-owning directory (session moved / re-anchored), and the tool context still reports the original pool-less directory
- **THEN** the gate resolves the roster from the authoritative record's directory (the workspace pool IS the roster) and does NOT fire the unconfigured refusal — the same verdict the dispatch belts give for that session

#### Scenario: A freshly moved session's roster follows the host's live move statement

- **WHEN** the host emits `session.moved` carrying the session's new directory while the plugin-facing session record seam still reports the pre-move location — the move being into a pooled workspace or out of one
- **THEN** the gate resolves the roster from the moved workspace (the live move statement outranks the stale record seam; moving into a pool gains its roster, moving out loses it with the honest unconfigured refusal) — neither the pooled-map preference nor the resume ledger resurrects the abandoned workspace's pool

#### Scenario: A fresh install with only a per-project pool enters crew

- **WHEN** a host has no global forge.json anywhere, the session's workspace carries a `.opencode/forge.json` with at least one agent, and `/crew` is invoked
- **THEN** the gate does not fire — the workspace pool alone is a complete roster and crew orchestration proceeds with zero global configuration

### Requirement: Crew execution-mode gate

The plugin SHALL hold every registered crew in a PENDING state until the user's execution-mode decision arms it, and SHALL enforce the pause mechanically: while the session's crew is PENDING, every native `subagent` call from the session SHALL be refused by the plugin's tool-execute interception belt (the host's `execute.before` tool hook), with the refusal message presenting the three choices (supervised waves now / convert to a goal contract / stand by). The belt SHALL NOT fire before a crew is registered (reconnaissance dispatches are free) nor after the crew is armed, converted, or ended. Mode transitions SHALL happen through a follow-up `crew_begin` call carrying only `execution`: `waves` flips the crew to executing and lifts the belt; `goal` ends the crew as a conversion record with no verdicts and no extra ask gate — the immediately following `goal_write(arm=true)` confirmation dialog is the user gate for that path — and the conversion output SHALL direct folding the declared subtask plan into the goal contract's criteria and checks The conversion output SHALL additionally RELAY the crew layer into the goal loop: it SHALL state that the goal engine's continuation turns may re-register this plan as a born-armed crew in ONE call (`crew_begin {objective, subtasks, execution: "waves"}` — no pause mid-loop), SHALL direct preserving the subtask STRUCTURE (titles and their forge-* agent assignments) inside the goal contract's criteria or constraints verbatim enough to survive the fold rather than dissolving them into prose, and SHALL include a ready-to-adapt born-armed registration sketch naming the declared subtasks and their agents — so the model's FIRST post-arming turn (which runs before any idle continuation brief) already knows the crew layer exists.; standby is the absence of a call (the crew stays PENDING harmlessly until armed or abandoned). The arm call SHALL refuse when the crew is not PENDING (already armed, converted, or ended). This gate composes with, and never replaces, the goal loop: an active goal's continuation turns may register crews (fresh or after abandonment) and the pending belt applies there equally — re-sharding decisions are user-visible. **Goal-delegated self-orchestration**: while a live active goal governs the session, `crew_begin` MAY carry `execution: "waves"` in the SAME registration call — the crew is born EXECUTING and never pends (the goal contract's arming dialog already authorized autonomous orchestration); without a governing goal, `execution` at registration SHALL be refused with a pointer to the two-step pause; `execution: "goal"` under a governing goal SHALL be refused as meaningless (already governed). While a live active goal governs the session, both `crew_close` paths (report and abandon) drop the ask requirement — the crew's gates are internal machinery under the goal loop, whose own arm / resume / complete gates remain the user boundary.

A born-armed crew SHALL retain its goal-delegated authorization origin for its in-memory lifetime; pause (including budget exhaustion), discard, completion or loss of the governing active goal SHALL suspend its autonomous work, not confer standalone authorization. While that authorization is suspended, the belt SHALL refuse new native `subagent` dispatches under the crew's autonomous work authorization, including non-forge fallback and reused-session calls; already admitted host work need not be cancelled, and duplicate or late idle/results cannot restore authorization. Existing user-approved goal resume can restore its goal governance if the same live contract/session is established. To run independently, use existing standalone registration and explicit execution-mode choice (end/abandon the prior crew through the applicable close gate first). The plugin SHALL NOT infer a standalone arm from absence of an active goal, free-text lineage, or historical notes. On restart crew state dies as before; existing goal file status, owning session, revision and arming/budget fields establish whether a goal may continue under its existing rules, and existing crew records are inert history, not authorization. If authorization or association cannot be established from current in-memory state and existing persisted evidence, wait for the user's explicit choice; no new persisted format or resume interface is promised.

#### Scenario: Pending crew refuses task dispatch

- **WHEN** a crew is registered PENDING and the model attempts any native `subagent` call
- **THEN** the belt refuses the call with the three-choice message, and no child session is created

#### Scenario: Arming for waves lifts the belt

- **WHEN** the user chooses supervised waves and the model calls `crew_begin {execution: "waves"}`
- **THEN** the crew flips to executing, subsequent `subagent` calls flow, and the wave discipline proceeds

#### Scenario: Goal conversion ends the crew cleanly

- **WHEN** the user chooses goal conversion and the model calls `crew_begin {execution: "goal"}`
- **THEN** the crew ends as a conversion record without verdict demands or an extra ask gate, and the output directs folding the declared subtasks into the upcoming goal contract

#### Scenario: The conversion output relays the crew layer into the goal loop

- **WHEN** the user chooses goal conversion and the model calls `crew_begin {execution: "goal"}`
- **THEN** the conversion output states the goal loop may re-register the plan born-armed in one call, directs preserving the subtask titles and agent assignments structurally in the goal contract, and includes a ready-to-adapt born-armed registration sketch — the relay reaches the model's first post-arming turn without waiting for an idle continuation brief

#### Scenario: Standby keeps the crew pending harmlessly

- **WHEN** the user chooses standby and no arm call is made
- **THEN** the crew stays PENDING with no belt side effects, and may later be armed or abandoned

#### Scenario: Pre-registration reconnaissance is unimpeded

- **WHEN** the model makes native `subagent` calls during reconnaissance before any `crew_begin`
- **THEN** the belt does not fire — the pause guards the registration-to-execution seam only

#### Scenario: One-call arm under a governing goal

- **WHEN** a live active goal governs the session and the model registers `crew_begin {objective, subtasks, execution: "waves"}` in a single call
- **THEN** the crew is born EXECUTING, the pending belt never fires for it, and both `crew_close` paths operate without an ask dialog — the goal's gates are the user boundary

#### Scenario: Execution-at-register refused without a governing goal

- **WHEN** no live active goal governs the session and `crew_begin` carries `execution` at registration
- **THEN** the call is refused with a pointer to the two-step pause — the standalone gate cannot be self-armed by the model

#### Scenario: Goal-delegated crew cannot become standalone when governance ends

- **WHEN** a born-armed crew's governing goal pauses, exhausts either budget, is discarded or completes, including after restart where authorization cannot be confirmed
- **THEN** no standalone continuation is sent and new autonomous crew dispatches (including fallback or reused-session calls) are refused; already admitted work need not be cancelled and late results do not restore authorization; only existing explicit user arming/resume mechanisms restore authorized work, historical records do not resume a dead crew, and uncertain authorization waits for the user

### Requirement: Crew-governed dispatch pool-compliance gate

While a crew governs a session (PENDING or EXECUTING, including a goal-delegated born-armed crew), the plugin SHALL enforce file-level POOL COMPLIANCE on the session's configuration before any crew work dispatches: the session's workspace pool file SHALL declare a valid top-level `pool` namespace (a `[a-z0-9-]` string, 1–24 characters after trim). `crew_begin` SHALL run the compliance check as a registration pre-flight — a non-compliant pool file refuses the registration outright (no crew record is written, no PENDING crew exists) — and the plugin's tool-execute interception belt SHALL re-run the same check on every native `subagent` call from a crew-governed session targeting a `forge-*` worker, so a pool file degraded mid-crew blocks further crew dispatches until repaired. A compliance refusal SHALL name the session's pool file path, the violation (missing or invalid `pool` field), and the minimal compliant fix — add or repair the top-level `"pool": "<suggested>"` field (the suggestion being the family's currently derived namespace or a sanitized short form of it) — and SHALL state that the gate lifts hot-apply: the next resolve after the file is repaired admits registration/dispatch with no host restart. The MID-CREW belt refusal copy SHALL additionally name the NATIVE EXIT: while the pool is being repaired, the affected subtask may dispatch through a native `subagent` call for a non-forge agent with the same relay contract — the compliance belt gates `forge-*` targets only, never the crew's existence. The check is FILE-LEVEL only: per-agent fail-soft findings (half-pinned entries, mistyped optional fields, broken individual entries) keep their existing skip-with-finding semantics and NEVER make the file non-compliant. Sessions whose roster comes from the global fallback layer (workspace without a pool file) are EXEMPT — the global family's namespace is fixed (`global`) and carries no rename risk. Belt composition: the compliance check runs in the same interception belt as, and AFTER, the session-domain pool gate — a cross-pool target is refused by the pool gate regardless of the session's own compliance state — and composes with the pending-crew execution-mode belt without replacing it. Unknown session anchors keep the existing fail-open posture (belt disclosure unchanged).

#### Scenario: Registration refuses a non-compliant pool file

- **WHEN** `crew_begin` is called in a session whose workspace pool forge.json defines agents but declares NO top-level `pool` field
- **THEN** the registration is refused outright — no crew record is written and no PENDING crew exists — and the refusal names the pool file path, the missing `pool` field, and the minimal fix (`"pool": "<suggested>"`), stating the gate lifts hot-apply once the file is repaired

#### Scenario: An invalid pool value is non-compliant too

- **WHEN** the session's workspace pool declares `"pool": "Aa Team!"` (charset mismatch) or `"pool": 7` (wrong type)
- **THEN** `crew_begin` refuses with the same fix copy as a missing field (the load-time warn finding and directory-name fallback still apply for materialization; crew dispatch waits for a valid declared value)

#### Scenario: A compliant registration proceeds

- **WHEN** the session's workspace pool declares a valid `pool` namespace (e.g. `"plugindev"`)
- **THEN** `crew_begin` registers the crew normally (record written, PENDING pause or born-armed execution per the execution-mode gate) — the compliance gate does not fire again for registration

#### Scenario: Mid-crew degradation blocks further crew dispatches

- **WHEN** a crew is EXECUTING and the workspace pool's `pool` field is removed (or invalidated) before a later wave's native `subagent` call to a `forge-*` worker
- **THEN** that call is refused with the compliance fix copy PLUS the native exit (the affected subtask may run through a native `subagent` call for a non-forge agent with the relay contract while the pool is repaired — the belt gates `forge-*` targets only); `subagent` calls for non-forge agents from the same session are unaffected; once the file is repaired, the next call flows with no restart

#### Scenario: Global-fallback sessions are exempt

- **WHEN** a crew-governed session's workspace has no pool file and its roster comes from the global fallback layer
- **THEN** the compliance gate never fires — the global family's fixed `global` namespace carries no rename risk and needs no declared field

#### Scenario: Per-agent fail-soft findings do not block

- **WHEN** the session's workspace pool declares a valid `pool` but one agent entry is half-configured (`model` without `thoughtLevel`)
- **THEN** the file is compliant: `crew_begin` registers and crew dispatches flow — the bad entry keeps its existing skip-with-error-finding semantics and never blocks the crew

#### Scenario: The pool gate outranks the compliance belt

- **WHEN** a crew-governed session with a COMPLIANT pool makes a native `subagent` call targeting another workspace's `forge-<nsB>-coder`
- **THEN** the session-domain pool gate refuses it (not-dispatchable-from-this-session copy with exits) — the compliance belt never rewrites or masks a cross-pool refusal

### Requirement: Waves-armed crews auto-advance on session idle

The plugin's idle-continuation engine SHALL extend to waves-armed crews: when a session goes idle, no live active goal governs it, and the session’s registered crew is in EXECUTING mode with independently confirmed standalone user authorization, the engine SHALL (after the shared debounce) send the session a `[forge:crew-continue]` continuation brief carrying the crew objective, the declared subtask titles, and the wave discipline (dispatch the next wave via native `subagent` calls, wait for every child's report in the host's completion messages, collect per-subtask evidence verdicts, at most one retry, then `crew_close` with the full report). The engine SHALL NOT continue a crew in any other state: a PENDING crew is the user's execution-mode decision seam and is never auto-continued; a crew governed by a live active goal is driven by the goal engine's turns (no second brief); an ended crew (closed, abandoned, or converted) never continues; a goal-delegated crew whose goal is paused, budget-exhausted, discarded or completed never automatically becomes standalone. The continuation SHALL only run while the host has enabled the plugin (see forge-agent 'One-knob return to native') and SHALL pass the shared guard plumbing — debounce, in-flight claim, forge-family gate at schedule AND send time (a session switched to a non-forge agent is never continued), and a busy-recheck immediately before send — and SHALL stop after repeated transport failures (bounded, disclosed). A crew continuation turn with ZERO dispatch/write activity increments a no-progress streak; at the streak limit the engine SHALL stop sending crew continuations for that crew and disclose once (bounded console note) that it stalled — the crew itself stays registered: no auto-abandon, no auto-close, the user stays in charge. Accepted native `subagent` work rounds during a crew continuation turn SHALL count as activity (the crew engine keeps its own activity counter; the goal engine uses the same dispatch activity semantics while governing a crew). No disk state is added: the crew record on disk is unchanged and the engine state is in-memory.

The engine SHALL additionally hold a native in-flight gate: while any accepted native work round remains outstanding, the idle continuation brief SHALL be suppressed; parent-linked busy sessions are observations, not proof of dispatch or settlement. The gate SHALL be decided by a decision-time session-tree walk (session list filtered by parent link, cross-read against the host's active/status map) taken at the moment of the continuation decision; an event-fed tracker (session-created marks a child, terminal execution/status edges record explicit terminal evidence when present, session deletion drops) MAY keep the set warm and MAY re-arm the idle continuation when the last native child of a recently suppressed session goes terminal, but a complete walk is reconciled with accepted rounds and round evidence, not used to erase unresolved rounds. The re-armed brief SHALL carry a one-line native-child digest naming each child session the gate held the crew on that has since left the in-flight view, and its outcome (succeeded / failed / interrupted), read from the child's own session row — the complete walk corroborated by round-specific host evidence governs the digest; a partial, truncated, missing or unknown view does not prove settlement, so a relevant child created before the crew was armed or whose terminal event never reached the plugin is named where evidence exists, otherwise disclosed as unknown; a child whose row is gone or carries no outcome (deleted mid-run) SHALL be disclosed as unverified rather than given a verdict, and no dispatched round SHALL be named twice. A child that died ABORTED (interrupted) is surfaced to the orchestrator the moment the plugin knows, so a dead wave child never silently strands the crew (the abort itself is host/harness territory the plugin cannot prevent; the guarantee is detection, wake, and disclosure). The gate SHALL allow a bounded diagnostic brief on an unreadable session list or status view, disclosing unknown status rather than treating it as no outstanding work. Suppression SHALL be bounded by a wall-clock ceiling (default 900000 ms): once suppression for a crew registration persists past the ceiling, the engine SHALL allow one diagnostic brief for that registration, and disclose once via a bounded console note; a fresh `crew_begin` clears the ceiling marker. While the gate holds a crew, a bounded re-check SHALL re-walk the view on an interval and schedule the shared continuation only once every outstanding round is verified settled, or for a diagnostic-only brief at the ceiling, so the resume never depends on a further idle edge or on an event reaching the plugin (the scheduled continuation re-runs the full guard chain). The busy-recheck immediately before send SHALL also hold on hosts whose session adapter exposes no per-session status surface: the orchestrator's own entry in the active/status map is read instead, and a brief is never injected into a session that is mid-turn; an unreadable map leaves the prior behavior unchanged. A suppressed nudge is NOT a turn: it accrues no no-progress streak, no transport-failure count, and no crew ledger effect — the gate is evaluated before the crew-turn accounting. Gate state SHALL be in-memory only (zero disk state) and SHALL be evicted with the rest of the crew engine state when the session ends. The goal branch uses this same waiting observation while governing a crew, but remains the sole continuation owner (goal-harness). During waiting neither branch sends normal work continuations or scores no-progress. A ceiling or unreadable view allows a bounded diagnostic continuation only, naming unresolved rounds; it does not authorize the next wave, imply terminal success or accrue waiting as work. Crew observation is harness-local scheduling, not a replacement dispatch engine or another host completion notification. Track work by dispatched round as well as session id: duplicate events and observations of one round count once; a later accepted call reusing a session id is a distinct round. Idle or absence from the busy map alone is not terminal evidence; if no authoritative outcome is available the digest says unverified. No success is inferred from idle. A partial/truncated/unknown listing never settles a wave; continue observing or wait for the user; diagnostics remain separate from work continuation.

#### Scenario: Idle between waves sends the continue brief

- **WHEN** a waves-armed crew is EXECUTING, the session has gone idle after all wave rounds are verified settled, the crew has independent standalone user authorization, and no live active goal governs the session
- **THEN** after the debounce the engine sends one `[forge:crew-continue]` brief carrying the crew objective and the declared subtask titles, and the session proceeds with the next wave

#### Scenario: A closed or abandoned crew never continues

- **WHEN** the session's crew has ended (crew_close report or abandon, or goal conversion) and the session goes idle
- **THEN** no crew continuation brief is sent — the engine's crew branch finds no EXECUTING crew

#### Scenario: A pending crew is never auto-continued

- **WHEN** the session's crew is PENDING (registered, not armed) and the session goes idle
- **THEN** no crew continuation is sent — the execution-mode pause is the user's decision seam, and the pending belt still refuses `subagent` calls

#### Scenario: A goal-governed session is owned by the goal engine

- **WHEN** a live active goal governs the session (including a goal-delegated born-armed crew)
- **THEN** idle continuation follows the goal engine exclusively — no `[forge:crew-continue]` brief is ever sent alongside or instead of the goal brief

#### Scenario: A non-forge speaker is never continued

- **WHEN** the session's running agent has switched away from the forge family (at schedule time or send time) while a crew is EXECUTING
- **THEN** no crew continuation is sent — the family gate holds for the crew branch exactly as for the goal branch

#### Scenario: A stalled crew stops the engine, not the crew

- **WHEN** consecutive crew continuation turns produce zero dispatch/write activity up to the streak limit
- **THEN** the engine stops sending crew continuations and discloses the stall once (bounded console note) — the crew stays registered (no auto-abandon, no auto-close), and the user may nudge, crew_close, or abandon

#### Scenario: Task dispatches count as crew-turn activity

- **WHEN** a crew continuation turn makes native `subagent` calls (waves) but performs no writes or checks
- **THEN** the turn counts as active — the no-progress streak resets and the engine keeps advancing the crew

#### Scenario: A busy native child suppresses the brief without touching the streak

- **WHEN** a waves-armed crew is EXECUTING, the orchestrator session is idle, and a host-native child session (parentID = the orchestrator's session id, dispatched through the native `subagent` tool) is present in the host's active/busy status view
- **THEN** zero `[forge:crew-continue]` briefs are sent while the child stays non-idle/non-terminal, and the suppression is not a turn: the no-progress streak, transport-failure count, and crew ledger are untouched

#### Scenario: Last native child terminal re-arms exactly one brief

- **WHEN** the gate has been suppressing briefs for a session and its last outstanding round settles with verified terminal evidence on a complete view
- **THEN** after the shared debounce the engine sends exactly one `[forge:crew-continue]` brief — the re-arm fires once, not once per suppressed idle edge

#### Scenario: An aborted native child wakes the crew with its outcome

- **WHEN** a native child of a waves-armed orchestrator reaches a terminal state with outcome `interrupted` (aborted out from under the wave — e.g. stopped by `/forge stop`) while the gate had been suppressing
- **THEN** the re-arm fires promptly and the brief carries a one-line digest naming the child session and its interrupted outcome — the orchestrator learns the child is dead the moment the plugin does, and no dead wave child silently strands the crew

#### Scenario: A child created before the crew was armed is still named

- **WHEN** a native child of the orchestrator is already running when the crew is armed (the fresh registration wipes the advisory tracker's rows) and the gate then holds the crew on that child
- **THEN** when the child settles, the next brief carries its digest line with the outcome read from its session row — the tracker's ignorance of the child changes nothing

#### Scenario: A lost event stream changes nothing

- **WHEN** no terminal event for a held child reaches the plugin (volatile stream) and the child has settled in the host view
- **THEN** the next continuation decision's walk names the child with its row outcome in the brief digest, exactly once — and the terminal event and the walk observing the same round never name it twice

#### Scenario: A child that vanishes mid-run never strands the crew

- **WHEN** the gate is holding a crew on a native child and that child's session is deleted mid-run, so no terminal edge arrives and the host produces no further idle edge for the orchestrator
- **THEN** the suppression re-check observes the child gone and sends at most a diagnostic brief without any further idle edge (bounded by the re-check interval plus the debounce), and the diagnostic names the child as unverified — no outcome is invented and no next wave is authorized

#### Scenario: No brief is injected into a busy orchestrator

- **WHEN** a continuation decision runs on a host whose session adapter carries no per-session status surface and the orchestrator session is itself present in the active/status map (mid-turn)
- **THEN** no brief is sent for that decision, and the brief lands on the session's next idle edge

#### Scenario: The ceiling is evaluated without an idle edge

- **WHEN** suppression for a registration persists past the ceiling while the orchestrator produces no further idle edge
- **THEN** the suppression re-check schedules the continuation, the engine allows a diagnostic brief without authorizing the next wave, sends it, and discloses once

#### Scenario: Suppression past the ceiling sends once with a bounded disclosure

- **WHEN** continuous suppression for one crew registration persists past the native-child ceiling (default 900000 ms) while a child still appears non-terminal
- **THEN** the engine sends one diagnostic brief without authorizing the next wave, and discloses once via a bounded console note naming the ceiling — a fresh `crew_begin` clears the marker and re-arms normal gating

#### Scenario: An unreadable status view fails open

- **WHEN** the continuation decision runs and the session list or the active/status map read fails or returns an unreadable shape while a native child is actually running
- **THEN** a bounded diagnostic brief discloses the unreadable view and unresolved rounds; it does not authorize a next wave or count waiting as no-progress

#### Scenario: Session deletion evicts the gate state

- **WHEN** a session carrying native-child gate state (tracker entries, the walked watch set, ceiling marker, pending digest, any armed re-check) is deleted (session.deleted) or otherwise forgotten by the crew engine
- **THEN** the gate state for that session is evicted with the rest of the crew engine state — no disk state is written, and a later crew in a new session starts with a clean gate

#### Scenario: Idle is not success and a reused session is a new round

- **WHEN** a child leaves the busy view without verified outcome, duplicate observations arrive, and a later accepted call reuses its session id
- **THEN** the first round is observed once with its unknown outcome disclosed, not marked settled; the later round is tracked independently and the next wave waits for verified settlement of all outstanding rounds

### Requirement: Native fallback dispatch in crew waves

An armed crew's wave discipline SHALL treat a native `subagent` call for a non-forge agent as a first-class fallback lane: when the session's pool offers no forge worker fitting a subtask's job, or `forge-*` dispatch is blocked by a degraded pool file, the session MAY dispatch the subtask through a native `subagent` call for a non-forge agent (e.g. `general`) carrying the SAME relay contract as a forge dispatch — the change/artifact path for authoritative guides, the scoped task prompt, and the evidence demands. The fallback SHALL be disclosed, not silent: the `crew_begin` waves-arming output and the wave-discipline text SHALL carry the one-line fallback rule, and any natively-dispatched subtask SHALL be recorded — the crew record's wave notes name it, and its `crew_close` evidence statement SHALL say it ran native. The close report retains its existing fields: a fallback subtask needs no new field, but it is subject to the same round association and verified evidence cross-check as any other subtask (see 'crew_close completion gate'). No guard semantics change: non-forge targets remain subject to pending and draft gates but not pool/compliance checks, and every `forge-*` gate (pool, compliance, pending belt) keeps its exact refusal conditions — the fallback is guidance and disclosure, never a bypass.

#### Scenario: No fitting forge worker falls back natively and records it

- **WHEN** an armed crew's subtask needs a role the session's pool does not define (e.g. an e2e-verifier subtask in a pool of coders) and the session dispatches the native `general` subagent with the relay contract
- **THEN** the dispatch flows (no pool/compliance guard refuses a native target; ordinary permissions and other gates still apply), the crew record's wave notes name the fallback, and the subtask's crew_close evidence says it ran native — the close gate accepts it like any other verdict

#### Scenario: Degraded-pool crew keeps moving via native dispatch

- **WHEN** a crew is EXECUTING and the workspace pool file is non-compliant, so native `subagent` calls for `forge-*` workers are refused with the native exit in the copy
- **THEN** the session dispatches the affected subtasks natively with the relay contract while repairing the pool — the crew continues instead of stalling, and the fallback is recorded

#### Scenario: The arming output teaches the fallback lane

- **WHEN** `crew_begin {execution: "waves"}` arms a crew (standalone or born-armed under a goal)
- **THEN** the arming output carries the fallback rule: no fitting forge worker (or forge dispatch blocked) → dispatch the native subagent with the same relay contract and record the fallback in the wave notes and the close evidence

#### Scenario: Normal all-forge waves are unchanged

- **WHEN** the session's pool fits every subtask and is compliant
- **THEN** waves dispatch `forge-*` workers exactly as before — the fallback rule is present in the guidance but changes no behavior

#### Scenario: Fallback never weakens a forge gate

- **WHEN** any crew session attempts a `forge-*` dispatch that a belt would refuse (cross-pool target, non-compliant pool, pending crew)
- **THEN** the refusal fires exactly as before — the native fallback lane adds no exception to any `forge-*` gate
