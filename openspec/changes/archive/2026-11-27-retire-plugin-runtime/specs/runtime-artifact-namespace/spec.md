## MODIFIED Requirements

### Requirement: Runtime artifacts resolve under one `<os-tmp>` namespace at use time

The plugin SHALL keep every per-host runtime artifact under the `<os-tmp>` level
of the host, resolved each time a path is needed (never fixed at plugin module
load): the models-dev catalog cache under
`<os-tmp>/opencode-forge/models-dev`, the session-anchor ledger at
`<os-tmp>/opencode-forge/session-anchors.jsonl`, and the env-gated diagnostic
probe logs directly under `<os-tmp>`. No job, dispatch, or watchdog artifact
SHALL be written any more; a leftover `opencode-forge/jobs` or
`opencode-forge/watchdog` directory from an earlier version SHALL be left
alone — never read, never deleted by the plugin.

#### Scenario: production host (no redirect)

- **WHEN** neither `FORGE_TEST_RUNTIME_DIR` nor `FORGE_TEST_FORGE_HOME` is set
- **THEN** every artifact path equals the corresponding `src` helper's own default
- **AND** the resolved paths are byte-identical to those before this requirement
  for every artifact that still exists

#### Scenario: a test swaps the `<os-tmp>` level

- **WHEN** `FORGE_TEST_RUNTIME_DIR` names a directory
- **THEN** the models-dev cache, session-anchor ledger and probe logs resolve
  under that directory instead of `<os-tmp>`, with the same sub-layout
  (`opencode-forge/models-dev`, `opencode-forge/session-anchors.jsonl`, …)
- **AND** a path asked for after the variable changes reflects the new value

### Requirement: The HOME alias keeps its meaning

`FORGE_TEST_FORGE_HOME` SHALL remain the HOME alias for config discovery and the
session-anchor ledger's own redirect, exactly as before; it SHALL NOT move the
models-dev artifacts.

#### Scenario: only the HOME alias is set

- **WHEN** `FORGE_TEST_FORGE_HOME` names a directory and `FORGE_TEST_RUNTIME_DIR`
  is unset
- **THEN** the session-anchor ledger resolves under that directory
- **AND** the models-dev artifacts and the probe logs resolve under `<os-tmp>`

#### Scenario: both are set

- **WHEN** both variables are set
- **THEN** the session-anchor ledger follows the HOME alias
- **AND** every other artifact follows `FORGE_TEST_RUNTIME_DIR`

