# forge-commands — forge-subagents delta

## ADDED Requirements

### Requirement: User-facing /forge command family

The plugin `SHALL` register three execute-type slash commands —
`/forge sync`, `/forge init`, and `/forge init global` — each
family-guarded to forge sessions and implemented as agent-instructing
templates (the commands themselves `SHALL NOT` write files; every
write goes through the in-band tools with transcript visibility).
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

- **WHEN** a non-forge session runs any `/forge` command
- **THEN** the template stops and tells the user the command belongs
  to the forge agent (switch agents and rerun)
