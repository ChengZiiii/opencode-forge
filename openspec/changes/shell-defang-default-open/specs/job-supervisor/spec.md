# job-supervisor delta — shell-defang-default-open

## MODIFIED Requirements

### Requirement: Permission posture preserved

`forge_shell` SHALL preserve the shell permission posture of the host: the
plugin SHALL NOT inject any default permission rule — an unconfigured tool
inherits the host's own default (in practice the `"*": allow` fallback), so
the command runs without a plugin-added confirmation ask, exactly like the
native shell tool. When the user's config carries an explicit value for the
tool — captured by the plugin's config snapshot — that value SHALL be honored
verbatim in every mode with no plugin-side resolution: `allow` runs without
any ask in interactive, headless, and run modes alike; `deny` always refuses;
`ask` requests confirmation and reaches the host unmodified — a real dialog
in interactive mode, the host's ask auto-reject semantics in run mode, and a
pending ask on a serve host exactly like the native shell tool's ask there
(the plugin classifies nothing and never refuses on the posture path). In no
case SHALL the plugin's injected posture override an explicit user value, and
in no case SHALL a default posture block or refuse an execution on its own.

#### Scenario: Default posture asks before executing

- **WHEN** `forge_shell` executes with default configuration (no explicit user permission) in an interactive session — the legacy behavior this scenario title named under the pre-inversion spec
- **THEN** (inverted by this change) the command runs WITHOUT a confirmation ask — the plugin injects no default and the host's own permission default applies; the title remains as the archive matching key

#### Scenario: Explicit deny is never overridden

- **WHEN** the user's config denies the tool
- **THEN** `forge_shell` refuses to execute regardless of mode

#### Scenario: Explicit allow skips the ask

- **WHEN** the user's config explicitly allows `forge_shell` in any session mode — interactive, headless, or run
- **THEN** the command runs without the confirmation ask

#### Scenario: Explicit ask reaches the host unmodified

- **WHEN** the user's config explicitly sets `forge_shell: "ask"`
- **THEN** interactive mode shows the confirmation dialog, run mode follows the host's ask auto-reject semantics, and serve mode leaves the ask pending exactly like the native shell tool's ask — the plugin adds no resolution of its own
