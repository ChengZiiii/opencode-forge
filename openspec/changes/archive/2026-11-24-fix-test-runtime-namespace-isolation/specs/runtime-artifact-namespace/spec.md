## ADDED Requirements

### Requirement: Runtime artifacts resolve under one `<os-tmp>` namespace at use time

The plugin SHALL keep every per-host runtime artifact under the `<os-tmp>` level
of the host, resolved each time a path is needed (never fixed at plugin module
load): job logs, the survivor registry and the jobs ledger under
`<os-tmp>/opencode-forge/jobs`, the models-dev catalog cache under
`<os-tmp>/opencode-forge/models-dev`, the watchdog ledger under
`<os-tmp>/opencode-forge/watchdog`, the session-anchor ledger at
`<os-tmp>/opencode-forge/session-anchors.jsonl`, and the env-gated diagnostic
probe logs directly under `<os-tmp>`.

#### Scenario: production host (no redirect)

- **WHEN** neither `FORGE_TEST_RUNTIME_DIR` nor `FORGE_TEST_FORGE_HOME` is set
- **THEN** every artifact path equals the corresponding `src` helper's own default
- **AND** the resolved paths are byte-identical to those before this requirement

#### Scenario: a test swaps the `<os-tmp>` level

- **WHEN** `FORGE_TEST_RUNTIME_DIR` names a directory
- **THEN** the job logs, survivor registry, jobs ledger, models-dev cache, watchdog
  ledger and probe logs resolve under that directory instead of `<os-tmp>`, with
  the same sub-layout (`opencode-forge/jobs`, `opencode-forge/models-dev`, …)
- **AND** a path asked for after the variable changes reflects the new value

### Requirement: The HOME alias keeps its meaning

`FORGE_TEST_FORGE_HOME` SHALL remain the HOME alias for config discovery and the
session-anchor ledger's own redirect, exactly as before; it SHALL NOT move the
job, models-dev or watchdog artifacts.

#### Scenario: only the HOME alias is set

- **WHEN** `FORGE_TEST_FORGE_HOME` names a directory and `FORGE_TEST_RUNTIME_DIR`
  is unset
- **THEN** the session-anchor ledger resolves under that directory
- **AND** the job, models-dev and watchdog artifacts resolve under `<os-tmp>`

#### Scenario: both are set

- **WHEN** both variables are set
- **THEN** the session-anchor ledger follows the HOME alias
- **AND** every other artifact follows `FORGE_TEST_RUNTIME_DIR`

### Requirement: The canonical unit-test entry isolates the namespace

The canonical unit-test entry (`npm test`, the acceptance gate's live unit
suite, and the documented commands) SHALL preload `tests/lib/test-runtime-namespace.mjs`,
which sets `FORGE_TEST_RUNTIME_DIR` to a private per-process directory before any
test module is evaluated and removes it on exit.

#### Scenario: the suite runs beside a live host

- **WHEN** the full unit suite runs while the host plugin is using the real
  `<os-tmp>/opencode-forge`
- **THEN** no file under the real directory is created, modified or removed by the
  suite
