## MODIFIED Requirements

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
