# spec.md delta — job-supervisor

## MODIFIED Requirements

### Requirement: Permission posture preserved

`forge_shell` SHALL preserve the shell permission posture of the host: each execution SHALL pass through an execute-time confirmation request evaluated against an injected permission rule defaulting to `ask` — subject to the explicit-allow carve-out below — and explicit user `deny` SHALL always win. In non-interactive run mode the gate SHALL follow the host's ask semantics (auto-reject without the auto-approve flag), matching the native shell tool's posture rather than bypassing it. One carve-out is introduced by dispatch-resilience: an explicit user-configured `allow` for `forge_shell` — as captured by the plugin's config snapshot taken BEFORE posture rewriting (the snapshot records the user's own value, never the plugin's injected `ask`) — SHALL skip the execute-time ask and run, in interactive, headless, and run modes alike; this is the only posture that bypasses the ask, the default remains `ask`, and `deny` still always wins.

#### Scenario: Default posture asks before executing

- **WHEN** `forge_shell` executes with default configuration in an interactive session
- **THEN** the user is asked for confirmation before the command runs

#### Scenario: Explicit deny is never overridden

- **WHEN** the user's config denies the tool
- **THEN** `forge_shell` refuses to execute regardless of the injected default

#### Scenario: Explicit allow skips the ask

- **WHEN** the user's config explicitly allows `forge_shell` (captured by the pre-rewrite snapshot) in any session mode — interactive, headless, or run
- **THEN** the command runs without the confirmation ask — the documented single exception to the default ask posture
