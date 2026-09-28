## REMOVED Requirements

### Requirement: Marking and timing of built-in shell calls across all sessions

**Reason**: The owner requires zero forge feature spillover into non-forge agents: the watchdog is plugin-brought functionality, so marking/timing/intervention MUST NOT touch sessions of non-forge agents. Under the tool-partition capability, forge-family sessions no longer produce builtin shell calls at all — the watchdog's remaining jurisdiction is the keepBuiltinShell escape hatch and any future leak path on forge-family sessions.
**Migration**: Replaced by the ADDED requirement "Marking and timing of built-in shell calls in forge-family sessions" (below). Non-forge sessions lose nothing they ever owned: stall protection there was always plugin-added, and it now stays entirely out of their way.

## ADDED Requirements

### Requirement: Marking and timing of built-in shell calls in forge-family sessions

For every built-in shell tool invocation in a session whose agent belongs to the forge family (primary or delegated), the plugin SHALL attach a marker environment variable carrying the call identifier via the host's shell environment hook, record the start time keyed by call identifier when the call begins, and clear the record when the call ends. The marker SHALL be namespaced to this plugin so foreign processes are never matched. Sessions of any other agent SHALL NOT be marked, timed, or intervened upon: their builtin shell behavior SHALL remain entirely native, with no plugin-created marker variables, ledger entries, or process termination.

#### Scenario: A forge-family session's shell call is tracked and marked

- **WHEN** a forge or forge-* session runs a command through the builtin shell tool (e.g. under the keepBuiltinShell escape hatch)
- **THEN** the spawned process carries the plugin's marker environment variable and the call is being timed

#### Scenario: A non-forge session is entirely outside the watchdog

- **WHEN** the native build agent's builtin shell call hangs past the stall threshold
- **THEN** no marker was injected, no timing record exists, no intervention occurs, and the call's fate is the host's own native shell behavior

#### Scenario: Completed calls leave no residue

- **WHEN** a tracked builtin shell call ends normally
- **THEN** its timing record is cleared and no intervention can target it afterwards
