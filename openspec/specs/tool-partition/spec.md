# tool-partition Specification

## Purpose
Hard-partition the tool surface and system injections by agent family: everything the plugin brings (the forge primary agent and forge-* subagents) runs exclusively on the forge exec system, everything else runs purely native, and neither side can see or be influenced by the other's tooling.

## Requirements

### Requirement: Forge family runs exclusively on the forge exec surface

Every agent the plugin brings — the forge primary agent and every forge-* subagent regardless of shape — SHALL have the builtin shell tools (shell/bash) hidden via runtime config injection and SHALL execute commands only through forge_shell/forge_jobs. The hiding SHALL hold regardless of any host background capability, SHALL apply to a user-defined `forge` agent entry as a tools merge (builtin shell off, every other field of the entry untouched), and SHALL be withdrawn only by `jobs.keepBuiltinShell: true` or by supervisor retirement (`jobs.mode: "native"`). Harness state tools (the plan_*/goal_*/crew_* families) SHALL be primary-only: they SHALL be hidden from every forge-* subagent, whose forge toolset is limited to forge_shell and forge_jobs.

#### Scenario: A write-shape forge subagent has no builtin shell

- **WHEN** a forge.json agent with shape "write" is materialized
- **THEN** the materialized agent entry hides the builtin shell tools while keeping its shape-derived permission map and pinned model

#### Scenario: A forge worker carries only the exec toolset

- **WHEN** a forge-* subagent session assembles its toolset
- **THEN** the plan_*/goal_*/crew_* harness tools are absent; only forge_shell and forge_jobs are available alongside the shape's own tools

#### Scenario: A crew wave runs on the forge exec surface

- **WHEN** a /crew orchestration dispatches subtasks to forge-* agents through the native task tool
- **THEN** the dispatched workers can execute commands only through forge_shell

#### Scenario: Native backgrounding does not restore the builtin shell on the forge family

- **WHEN** the host's builtin shell presents a native run_in_background parameter
- **THEN** the forge primary agent and all forge-* subagents still exclude the builtin shell tools

### Requirement: Non-forge agents are isolated from forge tooling

Every agent other than the forge family — the native build, plan, general, and explore agents, and every user-defined agent — SHALL have all plugin-registered forge tools (forge_shell, forge_jobs, crew_begin, crew_close, and the plan_*/goal_* harness tools) hidden via runtime config injection, so no non-forge session can see or invoke forge tooling and the builtin shell remains its exec surface. Because the host's task-tool agent vocabulary is global (forge-* subagents cannot be made invisible to a specific parent agent), a non-forge agent's attempt to dispatch a forge-* subagent SHALL be refused at the tool layer with an explanatory error, and no subagent session SHALL be created. Forge state files are boundary-protected: a non-forge session's attempt to write into `.opencode/plan/` or `.opencode/goal/` SHALL be refused at the tool layer, while reading them stays unrestricted. A user's explicit `tools` entry enabling a forge tool on the user's own agent SHALL be respected and never overwritten. Native agents absent from the user's config SHALL receive the hiding through the same runtime materialization mechanism the plugin uses for its own agent entries.

#### Scenario: The native build agent sees no forge tools

- **WHEN** the user selects the native build agent and its toolset is assembled
- **THEN** no plugin-registered forge tool is present, and the builtin shell is available as its exec surface

#### Scenario: A non-forge dispatch of a forge worker is refused

- **WHEN** the native build agent calls the task tool with a forge-* subagent as the target
- **THEN** the call is refused with an error naming the agent-family partition, and no subagent session is created

#### Scenario: A non-forge write into forge state files is refused

- **WHEN** the native build agent attempts to write or edit a file under `.opencode/plan/` or `.opencode/goal/`
- **THEN** the call is refused with an error naming the forge state boundary, and the file is unchanged

#### Scenario: A task-spawned default subagent inherits the isolation

- **WHEN** a non-forge agent dispatches a subagent through the native task tool with the default general agent
- **THEN** the spawned session likewise has no forge tools available

#### Scenario: A user-defined agent gets the isolation without losing its own fields

- **WHEN** the user defines their own agent in config and the plugin loads
- **THEN** only the forge-tool entries are merged into that agent's tools map as disabled, and all other fields of the entry stand unchanged

#### Scenario: Explicit user opt-in is respected

- **WHEN** the user's config explicitly sets tools.forge_shell: true on their own agent entry
- **THEN** the plugin does not override that entry and the tool remains available there

### Requirement: Forge system injections are family-gated

All forge-authored system-prompt injections (job guidance, plan/goal/crew notices, the compaction goal brief) SHALL be gated on the session's agent belonging to the forge family, resolved from a session-to-agent mapping built from the host's per-request agent signal; when the agent is unknown the injection SHALL be skipped. The suppression of the host's post-compaction auto-continue SHALL follow the same gate: it applies only while the session's current agent belongs to the forge family. Non-forge sessions SHALL carry no forge-authored system text.

#### Scenario: A build session's system prompt carries no forge text

- **WHEN** the native build agent answers in its own session
- **THEN** the system prompt contains no forge-authored notices or guidance

#### Scenario: A forge session keeps the full injection set

- **WHEN** a forge-family session builds its system prompt while a plan and a goal are live
- **THEN** the session receives the job guidance and the plan/goal notices exactly as before this capability existed

#### Scenario: Compaction auto-continue suppression follows the agent family

- **WHEN** a goal-owning session is currently driven by a non-forge agent and a compaction completes
- **THEN** the host's synthetic auto-continue behaves natively (not suppressed), while the goal loop itself stays parked per the continuation rule

### Requirement: Forge command entries redirect non-forge sessions

The plugin-authored /plan, /goal, and /crew command templates SHALL carry a fail-fast guard: when the executing session cannot see the family's entry tool (plan_write, goal_write, or crew_begin respectively — i.e., a non-forge-family session), the template SHALL direct the model to stop immediately, tell the user to switch to the forge agent and rerun the command there, and perform no step of the discipline (no reconnaissance, no file operations, no tool calls beyond that self-check).

#### Scenario: /plan under a non-forge agent redirects

- **WHEN** the user runs /plan while the native build agent is selected
- **THEN** the model stops at the guard, reports the redirect to forge, and performs no reconnaissance or file operations

#### Scenario: /goal and /crew under non-forge agents redirect

- **WHEN** the user runs /goal or /crew in a session of a non-forge agent
- **THEN** the model stops at the guard with the same redirect and nothing of the goal or crew discipline is initiated

### Requirement: Session-scoped safety interop for active drafts

While a session has an active plan draft, the draft-phase write ban SHALL remain session-scoped: write-class tool calls are denied for every agent in that session, including non-forge agents, because the draft protects shared session state. The task-dispatch shape exemption SHALL follow the same session scope and the plan harness's semantics: a task call whose target resolves to an effective-readonly forge subagent passes during draft regardless of the speaking agent, while every other target stays denied. Non-forge turns SHALL gain no new dispatch capability from the exemption: the family dispatch guard refuses a non-forge agent's forge-* targets before the draft gate is consulted, and native targets are never effective-readonly — so a non-forge agent's dispatch surface during a draft is byte-identical with and without this exemption. Denials SHALL name the way out (plan_approve, or /plan discard). This remains the one deliberate forge constraint that reaches non-forge turns: passive protection of shared state — forge SHALL never actively drive a non-forge turn.

#### Scenario: A non-forge agent is write-blocked during an active draft

- **WHEN** the user switches a draft-bound session to the build agent and it attempts a write
- **THEN** the write is denied with guidance naming plan approval via forge or /plan discard, and the draft is untouched

#### Scenario: The shape exemption grants non-forge turns nothing

- **WHEN** a draft-bound session is driven by a non-forge agent that dispatches `task {subagent_type: "forge-research"}` (effective readonly) or `task {subagent_type: "general"}`
- **THEN** the forge-* target is refused by the family dispatch guard and the native target by the draft write ban — identical to the pre-exemption behavior

### Requirement: Fallback enforcement on hosts that ignore injected tools maps

Some host builds assemble agent toolsets without honoring `tools` maps that
the plugin injected at runtime into agent entries (verified on the owner's
host build: file-configured entries are honored, hook-injected entries are
not — for both builtin and plugin tools). On such hosts, every partition
constraint that would be expressed as tool invisibility SHALL instead be
enforced as a hard refusal at the tool layer: a forge-family session's
builtin shell/bash call SHALL be refused with a pointer to `forge_shell`
(unless `jobs.keepBuiltinShell` or supervisor retirement applies), a
non-forge session's call of ANY plugin-registered forge tool SHALL be
refused with the partition guidance, and a forge-family session whose agent
is not the primary `forge` agent (a `forge-*` worker) calling any harness
state tool (`plan_*`, `goal_*`, `crew_begin`, `crew_close`) SHALL be refused
with guidance naming the primary-only partition and the way out: report
findings back to the orchestrating session — the primary forge agent alone
calls the state tools. The worker refusal SHALL fire before any execution or
gate ask, so a worker's state-tool call never reaches a user confirmation
dialog and never mutates plan/goal/crew state. Unknown sessions SHALL fail
open. On hosts that honor injected maps the refusals never fire; the refusal
errors name the partition and the way back, degrading "invisible" to
"visible but unusable" without changing any other semantics.

#### Scenario: A forge session's builtin shell call is hard-refused on an unfiltered host

- **WHEN** a host ignores hook-injected tools maps and the forge agent calls the builtin shell tool
- **THEN** the call is refused with guidance to re-issue through forge_shell, and no process is spawned

#### Scenario: A non-forge session's forge tool call is hard-refused on an unfiltered host

- **WHEN** a host ignores hook-injected tools maps and the build agent calls forge_shell
- **THEN** the call is refused with the partition guidance, and nothing executes

#### Scenario: A forge worker's state-tool call is hard-refused on an unfiltered host

- **WHEN** a host ignores hook-injected tools maps and a task-dispatched `forge-*` worker session calls a harness state tool such as goal_complete
- **THEN** the call is refused with the primary-only partition guidance before any execution or user gate, no confirmation dialog is presented, and the active goal's state is unchanged

#### Scenario: The primary forge agent's state-tool calls are unaffected by the fallback

- **WHEN** the primary `forge` agent's session calls goal_complete or any other harness state tool
- **THEN** the fallback belts do not fire and the call proceeds through its own validation and gate

#### Scenario: A forge worker's exec pair is unaffected by the state-tool refusal

- **WHEN** a `forge-*` worker session calls forge_shell or forge_jobs
- **THEN** the state-tool refusal does not fire and the call executes normally

#### Scenario: The escape hatches still open the builtin shell under the fallback

- **WHEN** `jobs.keepBuiltinShell: true` (or `jobs.mode: "native"`) and a forge-family session calls the builtin shell
- **THEN** the call passes — the fallback refusal applies only when the hide would

### Requirement: The goal loop never continues under a non-forge agent

When the goal continuation engine fires for a session whose current agent resolves to a non-forge agent, the engine SHALL skip that continuation round without recording a turn: the goal stays active, the budget is unchanged, and the loop resumes on the next forge-family turn.

#### Scenario: An agent switch parks the loop

- **WHEN** the user switches a goal-owning session to a non-forge agent and the session goes idle
- **THEN** no continuation prompt is sent to the non-forge agent and the goal's turn budget is unchanged

### Requirement: Readonly workers execute on a sealed supervised-exec channel

For any session whose running `forge-*` agent has an effective readonly shape (an EXPLICIT `shape: "readonly"`; an absent shape defaults to write and is NOT sealed), the plugin SHALL gate the supervised exec channel (`forge_shell`) for that session: commands classified READ-CLASS (inspection and search — e.g. directory listings, file reads, `rg`/`grep`, `git log`/`git status`/`git diff`, version and help queries, read-only `node`/`python` evals) SHALL flow normally; commands classified WRITE-CLASS SHALL be denied with a bounded finding that names the readonly shape, names the classified write indicator, and points at the remedy (`shape: "write"` on that agent when its job legitimately mutates). Write-class indicators SHALL cover at minimum: output redirection to files (`>` `>>` and their PowerShell equivalents), the known mutating cmdlets and commands (`Set-Content`, `Out-File`, `New-Item` with a file/item type, `Remove-Item`, `Move-Item`, `Copy-Item` writing, `Add-Content`, `Clear-Content`, `Start-Process`-spawning-writers is NOT covered — indirection stays out of scope), `git` mutating subcommands (`add`, `commit`, `push`, `reset`, `checkout`, `rebase`, `merge`, `clean`, `rm`), package-manager publishes/installs mutating the tree (`npm publish`, `npm install`, `bun add`, `pip install`), and any command whose parsed targets write INSIDE the session workspace by explicit path argument. The classification SHALL be a pure, injectable function (unit-tested, no fs access at classify time) evaluated on the command string BEFORE spawn; a command that fails to classify SHALL be treated as READ-CLASS (fail-open on the channel — the seal is belt-in-depth on top of the tool-face deny, not a sandbox, and the README SHALL disclose the covered indicators and the known bypass surface verbatim). The seal SHALL compose with, not replace, the existing draft-phase write posture: draft-period ask/deny semantics on the channel are unchanged; a write-shaped worker is never sealed; the primary forge session is never sealed.

#### Scenario: Read-class commands flow for an explicit readonly worker

- **WHEN** a session runs `forge-reviewer` with explicit `shape: "readonly"` and its dispatch calls `forge_shell` with `rg TODO src/` or `git log --oneline -10`
- **THEN** the command executes normally and no seal finding is recorded

#### Scenario: A redirect is denied with the shape named

- **WHEN** an explicit readonly worker's `forge_shell` call carries `node build.js > out.txt`
- **THEN** the spawn is denied, and the bounded finding names the readonly shape, the redirect indicator, and the `shape: "write"` remedy — the worker is told to report the refusal verbatim, not work around it

#### Scenario: A mutating cmdlet is denied

- **WHEN** an explicit readonly worker's `forge_shell` call carries `Set-Content -Path notes.md -Value x`
- **THEN** the spawn is denied with the same finding shape (mutating-cmdlet indicator)

#### Scenario: A workspace-path write is denied

- **WHEN** an explicit readonly worker's `forge_shell` call carries `node tools/gen.mjs --out src/generated.ts` where the parsed output target resolves inside the workspace
- **THEN** the spawn is denied (workspace-write indicator) — parsing uses the command string only, at classify time, with no fs access

#### Scenario: Write-shaped and absent-shaped workers are never sealed

- **WHEN** a session runs a `shape: "write"` agent or an agent with NO shape field (the open default) and calls `forge_shell` with any command
- **THEN** the exec channel applies no write-class denial — the seal keys on the explicit readonly shape only

#### Scenario: Unclassifiable commands flow and the bypass surface is disclosed

- **WHEN** a command's write intent hides behind indirection the classifier does not model (a script that writes internally, `Start-Process` writers, encoded payloads)
- **THEN** the command flows (fail-open on the channel), and the README discloses this bypass surface verbatim alongside the covered indicator list — the seal is belt-in-depth, not a sandbox

#### Scenario: The seal composes with the draft posture

- **WHEN** an explicit readonly worker's `forge_shell` call arrives during a plan-draft phase on a governed session
- **THEN** the existing draft-phase ask/deny semantics apply unchanged — the seal neither weakens nor replaces them
