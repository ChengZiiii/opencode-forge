# forge-commands — forge-subagents delta

## ADDED Requirements

### Requirement: User-facing /forge command family

The plugin `SHALL` provide the `sync`, `init`, and `init global` routes
of the single `/forge` command via typed arguments (see command-surface
'Single forge command surface'). These three routes `SHALL` be
agent-instructing templates (the commands themselves `SHALL NOT` write
files; every write goes through the in-band tools with transcript
visibility). The shared `/forge` template `SHALL` instruct the agent to
stop and redirect the user to forge before routing if `forge_sync` is
not available. The guard here is the existing template-level tool
visibility check, not a separate host identity check; the behavior of
the existing `stop` route is governed by command-surface.
`/forge sync` `SHALL` instruct the forge agent to invoke the
`forge_sync` tool immediately and report the diff — a manual
force/debug/fallback lever that leaves the default staleness-gate
posture and the `sync:"auto"` opt-in unchanged. `/forge init` `SHALL`
draft the workspace forge.json in-band with the user (pool namespace,
roles, shapes) and `SHALL` refuse when the file already exists,
offering review instead of overwrite. `/forge init global` `SHALL`
draft the global forge.json the same way, shipping built-in override
entries in comment form (inert until uncommented — see
builtin-override). The unconfigured-crew refusal `SHALL` name these
levers alongside the in-band drafting affordance.

#### Scenario: /forge sync forces an immediate sync

- **WHEN** the user runs `/forge sync` in a forge session
- **THEN** the forge agent invokes forge_sync now and reports the
  created/updated/GC'd diff — and the default posture (staleness gate
  + in-band sync; `sync:"auto"` opt-in) is unchanged

#### Scenario: /forge init scaffolds the project recipe

- **WHEN** the user runs `/forge init` in a workspace with no
  forge.json
- **THEN** the forge agent drafts the recipe in-band with the user
  (pool namespace, roles, shapes); the file hot-applies and a crew
  retry passes
- **WHEN** a forge.json already exists
- **THEN** the command refuses to overwrite and offers a review of the
  existing recipe instead

#### Scenario: /forge init global scaffolds the global layer inert

- **WHEN** the user runs `/forge init global` with no global
  forge.json
- **THEN** the scaffold is drafted in-band with the General/Explore
  override entries in comment form; built-in behavior is unchanged
  until an entry is uncommented and filled

#### Scenario: The net still teaches the levers

- **WHEN** a session with no recipe hits the unconfigured-crew
  refusal
- **THEN** the refusal names both paths: the in-band ask (the agent
  drafts it on explicit go-ahead) and the `/forge init` levers

#### Scenario: Family guard holds

- **WHEN** a session without `forge_sync` in its available tools invokes `/forge`
- **THEN** the shared template instructs the agent to stop before routing
  and tell the user the command belongs to the forge agent (switch agents
  and rerun)
