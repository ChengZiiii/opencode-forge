## ADDED Requirements

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
