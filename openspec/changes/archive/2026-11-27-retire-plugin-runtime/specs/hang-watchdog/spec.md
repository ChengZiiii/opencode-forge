## REMOVED Requirements

### Requirement: Stall detection with graded intervention

- **Reason**: The stall it unblocks — a `forge_shell` call that never returns — no longer exists: opencode 2.x's builtin shell already bounds every command (a default 2-minute timeout that moves a still-running foreground command to the background and stops a backgrounded one, a native `background` parameter, completion tied to process exit with a session notification), and the v2 plugin interface offers no hook into it.
- **Migration**: None. A still-running command is bounded by the host timeout and stopped from the host's shell view.

### Requirement: Cross-platform process location with misfire protection

- **Reason**: Process location exists only to feed the stall intervention.
- **Migration**: None.

### Requirement: Intervention modes

- **Reason**: The watchdog and its `watchdog.mode` option are removed.
- **Migration**: Remove `watchdog.*` from the plugin options; nothing replaces it.

### Requirement: Diagnostics ledger and file ledger

- **Reason**: No intervention remains to record.
- **Migration**: The `<os-tmp>/opencode-forge/watchdog` ledger is no longer written; an existing file is inert.

### Requirement: Boundary with the job-supervisor

- **Reason**: Both sides of the boundary are retired.
- **Migration**: None.

### Requirement: Marking and timing of built-in shell calls in forge-family sessions

- **Reason**: Without intervention there is nothing to time or mark, and the plugin has no hook into the builtin shell.
- **Migration**: None; builtin shell calls carry no plugin marker.
