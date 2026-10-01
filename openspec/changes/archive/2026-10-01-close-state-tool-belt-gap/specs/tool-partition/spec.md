## MODIFIED Requirements

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
