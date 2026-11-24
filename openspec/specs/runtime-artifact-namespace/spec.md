# runtime-artifact-namespace Specification

## Purpose
Keep every per-host runtime artifact the plugin writes outside any project — job logs, the survivor registry and jobs ledger, the models-dev catalog cache, the watchdog ledger, the session-anchor ledger and the diagnostic probe logs — under ONE `<os-tmp>`-rooted namespace that is resolved whenever a path is needed, and give tests a single environment switch (`FORGE_TEST_RUNTIME_DIR`) that redirects that whole namespace, so a test suite, a sandbox or a second host profile can never write into the runtime directory of the user's own running host.

## Requirements

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

### Requirement: The session-anchor ledger path resolves at use time

The plugin SHALL resolve the persisted session-anchor ledger's file path each
time the ledger is read or written — never once at plugin module load. With the
HOME alias `FORGE_TEST_FORGE_HOME` set the ledger SHALL live under that
directory (`<home>/opencode-forge/session-anchors.jsonl`); otherwise at
`<os-tmp>/opencode-forge/session-anchors.jsonl`.

#### Scenario: production host

- **WHEN** `FORGE_TEST_FORGE_HOME` is unset
- **THEN** the ledger path is `<os-tmp>/opencode-forge/session-anchors.jsonl`, byte-identical to the path before this requirement

#### Scenario: a test redirects HOME after the plugin module was evaluated

- **WHEN** a test sets `FORGE_TEST_FORGE_HOME` to a directory of its own after importing the plugin (ESM hoists every import above the test body, so the plugin module has already been evaluated) and a session then binds
- **THEN** the ledger row is appended under that directory
- **AND** nothing is appended under `<os-tmp>/opencode-forge`
