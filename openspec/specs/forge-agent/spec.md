# forge-agent Specification

## Purpose
Govern the single general-purpose agent identity for opencode sessions: register forge, hide the native build/plan agents at runtime for the plugin's lifetime, provide a one-knob return-to-native and uninstall self-healing — replacing "multi-agent persona switching" as the orchestration shape.

## Requirements

### Requirement: One-knob return to native

When the user sets `agent["forge"].disable: true`, the plugin SHALL go wholly silent: no forge agent or forge-* subagent registered, no runtime injection of any kind performed (agent registrations, tool hiding, permission rules, commands), no harness tools registered — the system returns to its native shape.

#### Scenario: Native restored after the knob is set

- **WHEN** the user sets `agent["forge"].disable: true` in their config and restarts opencode
- **THEN** the agent list has no `forge`, the native agents carry no plugin-injected tool hiding, and no harness tools or commands are registered

### Requirement: Uninstall self-healing

After the user completes the uninstall steps documented in the README, the system SHALL carry no plugin residue: forge is gone, native build/plan are restored. Plan files already generated under `.opencode/plan/` are user data, and uninstall SHALL NOT delete them.

#### Scenario: Native restored after uninstall

- **WHEN** the user uninstalls the plugin following the README's four steps and restarts opencode
- **THEN** the agent list shows the native `build`/`plan` again, with no `forge`

#### Scenario: Uninstall keeps plan data

- **WHEN** the workspace contains historical plan files and the user uninstalls the plugin
- **THEN** the `.opencode/plan/` directory and its files remain untouched

### Requirement: v2 forward-compatible registration

Under a v2 loader, the plugin `SHALL` provide full feature parity through
the `setup` entry while the v1 `server` entry stays untouched. `setup`
`SHALL` register: the forge primary agent, the materialized `forge-<ns>-<id>`
subagents, and the skill via the agent and skill domains on a create-only
basis (an existing target entry is skipped; fields use the v2 shape) —
using the complete sole-pool-ownership resolver, not a simplified
single-workspace subset; the full tool surface (`forge_shell`, `forge_jobs`,
plan_\*, goal_\*, crew_\*, task, grep/glob) via `ctx.tool.transform` with
JSON Schema argument contracts; the permission belt (draft write-freeze,
plan/goal/crew double gates, crew pending and pool-compliance belts,
worker→STATE primary-only refusals, status-file boundaries) via
`ctx.permission.hook("evaluate")`, with gate rewrites producing ask
outcomes so user dialogs remain the gates; the session seams via
`ctx.tool.hook("execute.before")` (activity marking, dispatch guards,
readonly-exec seal) and `ctx.session.hook("prompt")` /
`ctx.session.hook("context")` / `ctx.session.hook("compaction")` (family
mapping capture, thoughtLevel injection, forge system injections, channel
mandate, goal-brief compaction reinjection); the `/plan` `/goal` `/crew`
commands via the command domain; and the continuation engines (goal idle
continuation, job-wake delivery, `session.deleted` harvest) via
`ctx.event.subscribe()` with the cleanup function. On host API shape
drift, registration `SHALL` skip silently instead of throwing; a domain
that is absent or reshaped disables exactly its own feature slice and the
rest of `setup` still runs.

Pool and workspace anchor resolution `SHALL` accept anchor fields in BOTH
shapes: a zero-arg function (invoked for the value, unchanged) or a plain
property value used directly as the anchor string. A non-callable anchor
field `SHALL NOT` be treated as absent: on the 2.3.2 host, where
`ctx.location.directory` is a string property and `ctx.location.worktree`
does not exist, anchor resolution `SHALL` still produce candidates from
the property so the `forge-<ns>-<id>` workers materialize. Guarded
degradation `SHALL NOT` swallow the entire pool when only the anchor
field's shape differs from the function expectation.

#### Scenario: An existing same-name entry is not clobbered under v2

- **WHEN** a v2 loader calls `setup` and the agent draft already contains a
  `forge` entry
- **THEN** the plugin skips creation and the existing entry's content is
  unchanged

#### Scenario: The full tool surface registers under v2

- **WHEN** a v2 host with `ctx.tool.transform` loads the plugin
- **THEN** `forge_shell` and the harness tools appear in the tool registry
  with the same argument contracts and agent-family partition semantics as
  under the v1 loader

#### Scenario: Permission gates fire under v2

- **WHEN** a plan draft is active on a v2 host and a write-class tool call
  is evaluated
- **THEN** the evaluate outcome is a refusal (or an ask rewrite for the
  gated plan/goal/crew transitions), matching the v1 belt's decision for
  the same input

#### Scenario: Shape drift disables only its own slice

- **WHEN** a v2 host lacks `ctx.permission` (or its method shapes drifted)
  while the other domains are intact
- **THEN** the permission belt registration is skipped without throwing
  and the tool, agent, session, command, and event registrations still run

#### Scenario: Property-shaped location anchors resolve on real v2 hosts

- **WHEN** a v2 host exposes `ctx.location.directory` as a plain string
  property (opencode 2.3.2 field reality) and a workspace pool declares
  anchor-based workers
- **THEN** the resolver reads the property value directly, materializes
  the `forge-<ns>-<id>` workers for the pool, and `/api/agent` lists them
  for the pool's directory

#### Scenario: Absent anchor fields fall through without failing

- **WHEN** the host context lacks an anchor field entirely (e.g.
  `ctx.location.worktree` does not exist on 2.3.2)
- **THEN** that field yields no candidate, resolution falls through to the
  remaining candidates, and no error is thrown

### Requirement: Register the forge primary agent on the forge exec surface

Once the plugin loads, the system SHALL register a primary general-purpose agent with id `forge` (full read/write/execute tool surface). The Tab agent cycle SHALL offer forge alongside the native primary agents: forge is the plugin's general-purpose subject, while the native agents remain selectable and behave fully natively (per the tool-partition capability). Because the host's own default subject is the native build agent once it exists, the plugin SHALL set the host's default agent to `forge` unless the user configured `default_agent` themselves — coexistence MUST NOT flip the default subject away from forge, so a direct unplanned task in a fresh session executes as forge exactly as before.

The forge agent's execute surface SHALL be provided by `forge_shell` with the builtin shell tool hidden via runtime config injection (nothing written to the user's config file). The hiding SHALL be unconditional with respect to any capability probe: it holds whether or not the host offers native backgrounding, and it SHALL also apply to a user-defined `forge` agent entry (injected as a tools merge that only turns the builtin shell off, never touching the entry's other fields). `jobs.keepBuiltinShell: true` SHALL keep the builtin shell tool in place as the explicit escape hatch. When the job supervisor is manually retired (`jobs.mode: "native"`), the hide SHALL be withdrawn together with the `forge_shell` registration so the forge agent is never left without an exec surface.

#### Scenario: forge appears in the agent list after an official install

- **WHEN** the plugin is installed via an official `opencode plugin` install mode and loaded, and the user views the agent list
- **THEN** the list contains `forge` as a primary general-purpose agent

#### Scenario: A direct unplanned task is executed by forge

- **WHEN** the user issues an implementation-type task directly in a forge session (without `/plan`)
- **THEN** forge executes the task directly, with no agent switching at any point

#### Scenario: A fresh session defaults to forge under coexistence

- **WHEN** the plugin is loaded and the user starts a session without naming an agent (bare `opencode run` or a new TUI session with no remembered choice)
- **THEN** the default subject is forge — the native build agent's revival does not capture the default — unless the user set `default_agent` in their own config

#### Scenario: The exec surface is forge_shell regardless of native capability

- **WHEN** the host's builtin shell offers a native run_in_background parameter
- **THEN** the forge agent's toolset still excludes the builtin shell tool and includes `forge_shell`

#### Scenario: keepBuiltinShell retains the native tool

- **WHEN** the user sets `jobs.keepBuiltinShell: true`
- **THEN** the builtin shell tool remains available on the forge agent alongside `forge_shell`

#### Scenario: A user-defined forge entry still gets the partition

- **WHEN** the user has their own `agent["forge"]` configuration
- **THEN** the builtin shell is hidden on that entry via a merge that leaves the entry's other fields untouched, unless `jobs.keepBuiltinShell` is set

#### Scenario: Supervisor retirement restores the builtin shell

- **WHEN** the user sets `jobs.mode: "native"`
- **THEN** `forge_shell` is no longer registered and the builtin shell tool returns to the forge agent's toolset

### Requirement: Channel mandate in forge-family prompts

While the exec partition holds (forge-family builtin shell hidden, `forge_shell` registered), the forge agent's system prompt SHALL carry an unconditional channel mandate: every shell command — quick ones included — runs through `forge_shell`, and the builtin shell/bash tools are refused on the forge family, so the model must not try them first. The `[forge:job-guidance]` system injection SHALL carry the same absolutized wording (it SHALL NOT teach that only long-running commands belong to `forge_shell`). When `jobs.keepBuiltinShell: true` restores the builtin tool, the mandate SHALL soften to a preference — `forge_shell` first — without claiming the builtin tool is refused. Under `jobs.mode: "native"` the supervisor is retired, `forge_shell` no longer exists, and no forge-authored shell mandate SHALL be injected. The `forge_shell` tool description SHALL present the tool as the exec surface for every shell command.

#### Scenario: A forge-family session receives the absolute mandate

- **WHEN** a forge-family session builds its system prompt under the default partition (`jobs.mode` `auto`/`forge`, no `keepBuiltinShell`)
- **THEN** the prompt and the `[forge:job-guidance]` injection state that every shell command goes through `forge_shell` and that builtin shell calls are refused — with no long-running qualifier on the channel rule

#### Scenario: The escape hatch softens the refusal claim

- **WHEN** the user sets `jobs.keepBuiltinShell: true`
- **THEN** the mandate still names `forge_shell` as the exec surface and asks for it first, but no longer claims the builtin shell is refused (it is available by explicit choice)

#### Scenario: Supervisor retirement injects no mandate

- **WHEN** `jobs.mode` is `native`
- **THEN** no forge-authored shell mandate reaches any session (the tool and its guidance are gone)

#### Scenario: A quick command still routes through forge_shell

- **WHEN** the forge agent needs to run a trivially short command (an echo, a version check)
- **THEN** the model-facing text it was seeded with gives no basis for reaching for the builtin shell first — the channel rule is unconditional

### Requirement: v2 single-agent surface

Under the v2 loader, the plugin SHALL suppress the native `build` and `plan` primary agents by setting `hidden: true` on their agent records via the agent domain — records are hidden, never removed, and no other field of a native record SHALL be touched. The suppression and default-setting SHALL be delivered exclusively as runtime agent-layer state and SHALL NOT write to the user's opencode config or any file outside the plugin's own config domain (forge.json); removing the plugin SHALL restore the native primaries and the default subject on the next agent-layer rebuild. The suppression SHALL be guarded (an absent record is skipped, an already-hidden record is left untouched), fail-soft per record, and SHALL be opt-out-able via `"hideNativeAgents": false` in the global forge.json layer; `agent["forge"].disable = true` remains the whole-plugin off switch. Where the agent draft editor exposes a default setter AND the plugin's transforms are confirmed to run before the host's config→agent merge (so an explicit user `default_agent` overrides the plugin), `setup` SHALL set the agent default to `forge`; on hosts where that ordering cannot be confirmed, the default-subject slice SHALL ship nothing and the README config recipe (`default_agent: "forge"`) remains the documented way. Suppression SHALL NOT touch the `general`, `explore`, `compaction`, `title`, or `summary` agents, and SHALL NOT apply under the v1 loader (v1 users get the README config recipe).

#### Scenario: Native primaries disappear from the picker on v2

- **WHEN** the plugin loads on a v2 host and the agent layer resolves
- **THEN** the native `build` and `plan` records carry `hidden: true` and the agent picker offers `forge` as the visible primary, while `general`/`explore`/host-internal agents remain untouched

#### Scenario: Uninstalling the plugin restores the natives

- **WHEN** the plugin is removed and the agent layer rebuilds
- **THEN** `build` and `plan` return to `hidden: false` and the default subject reverts — no trace of the suppression persists in the user's config or on disk

#### Scenario: Nothing is written to the user's config

- **WHEN** the plugin delivers suppression, default-setting, or the shell deny
- **THEN** the user's opencode config file is byte-identical to before the plugin loaded; all plugin-owned state is runtime agent-layer data or files in the plugin's own domain (forge.json, plugin ledgers)

#### Scenario: Existing native-agent sessions keep working

- **WHEN** a session was created with agent `build` before suppression and is reopened after it
- **THEN** the session still resolves its agent (hidden, not removed) and behaves exactly as before

#### Scenario: The opt-out knob restores the natives

- **WHEN** the global forge.json sets `"hideNativeAgents": false`
- **THEN** `setup` leaves the native `build`/`plan` records untouched and the picker shows them again

#### Scenario: A user's explicit config still wins where ordering allows

- **WHEN** the host merges user config agent entries after plugin transforms (2.3.2 observed ordering) and the user explicitly sets `agent.build.hidden: false`
- **THEN** the final merged record is visible — the plugin's suppression never overrides an explicit user statement on hosts with that ordering

#### Scenario: Fresh sessions default to forge under the confirmed ordering

- **WHEN** the agent draft editor exposes a default setter, the plugin-before-config ordering is confirmed, and the user has no explicit `default_agent`
- **THEN** a new session without a named agent starts as `forge`

### Requirement: Every user-confirmation door raises its dialog under v2

On a v2 host the permission belt SHALL rewrite the evaluate outcome of every user-confirmation door — `plan_approve`, `goal_write`, `goal_complete`, `goal_resume`, `goal_discard` and `crew_close` — to `ask` unless the outcome is `deny`, so that the gate each of these tools opens is a real pending dialog that the user's answer settles. The belt SHALL leave the outcome of a tool that is not a door (for example `crew_begin`) exactly as the host produced it. A door the tool itself does not open produces no evaluation and no dialog: both `crew_close` paths stay ask-free while a live active goal governs the session, as the crew-harness spec requires.

On a host that has initialized the plugin in more than one directory, a door opened in a session SHALL raise its dialog for that session whether or not the session's directory is the most recently initialized one: the plugin SHALL route the ask through the host interface captured by the plugin initialization of the session's own directory — the initialization that registered the tool being called — never through an interface captured for another directory or by the latest initialization, and SHALL keep no module-level interface that a door could fall back to. A pending dialog raised this way SHALL be visible to the session's terminal client and answerable from it — the request SHALL sit in the pending table that the session's own routes read — and SHALL settle only on the user's answer. When the interface captured for the most recently initialized directory is no longer usable because that directory left the host, doors and `forge_shell` in the other directories SHALL keep working; a door that cannot raise its dialog SHALL fail closed with a clear error and SHALL never execute without the user's answer. The plugin SHALL NOT retry a failed ask on another directory's interface: a refusal and a closed directory are indistinguishable, and the user's refusal is final.

#### Scenario: crew_close asks in a session no goal governs

- **WHEN** `crew_close` (either close path) is evaluated with outcome `allow` on a v2 host, in a session that no live active goal governs
- **THEN** the evaluate outcome is `ask`, and the close does not execute until the user answers the dialog

#### Scenario: crew_close stays ask-free under a governing goal

- **WHEN** a live active goal governs the session and `crew_close` is called on either path
- **THEN** no dialog is raised and the close executes, exactly as before

#### Scenario: A tool that is not a door is untouched

- **WHEN** `crew_begin` is evaluated on a v2 host
- **THEN** the belt leaves the outcome as the host produced it

#### Scenario: An explicit deny is kept

- **WHEN** a door is evaluated with outcome `deny`
- **THEN** the belt leaves it `deny` and the tool is refused without a dialog

#### Scenario: A door in a session whose directory is not the last initialized one

- **WHEN** the host initialized the plugin in directory A and afterwards in directory B, and a door is opened in a session bound to A
- **THEN** the request sits in A's pending table, where that session's terminal client both sees and answers it, the terminal's answer reaches the request, and the door executes only after that answer

#### Scenario: The most recently initialized directory leaves the host

- **WHEN** directory B, initialized after A, is evicted from the host, and afterwards a door is opened in a session bound to A
- **THEN** the dialog is raised and the door settles on the user's answer, and `forge_shell` in A keeps working

#### Scenario: The evicted directory comes back

- **WHEN** directory B is evicted and later booted again, so it is once more the most recently initialized one, and a door is opened in a session bound to A
- **THEN** the dialog is raised for that session and never lands in B

#### Scenario: The host gave an initialization no permission interface

- **WHEN** the plugin's initialization for a directory captured no permission interface from the host, and a door or `forge_shell` is called in a session of that directory
- **THEN** the call is refused with an error that says it was refused fail-closed, and nothing is executed
