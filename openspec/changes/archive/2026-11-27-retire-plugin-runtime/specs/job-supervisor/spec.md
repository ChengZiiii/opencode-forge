## REMOVED Requirements

### Requirement: Bounded foreground execution with four completion conditions

- **Reason**: The exec tool this requirement specifies is retired. With the builtin shell the host owns the timeout behavior; specific pipe-holding behavior remains a probe, and its success-pattern and idle early returns are not host concepts.
- **Migration**: Use the host's builtin shell: a foreground call is bounded by the host timeout (default 2 minutes) and moves to the background instead of hanging; there is no success-pattern or idle early return.

### Requirement: Background start semantics

- **Reason**: `forge_shell`, the only surface of the background start contract, is retired; the builtin shell has a native `background` parameter.
- **Migration**: Pass `background: true` to the builtin shell; it returns at once and notifies the session on completion.

### Requirement: Job management verbs

- **Reason**: `forge_jobs` is retired together with the exec surface it manages; no plugin job exists to list, poll, read, kill, clear, or hand off.
- **Migration**: Running commands are listed and killed from the host's shell view; there is no model-facing poll, log, or kill verb.

### Requirement: Completion wake injection

- **Reason**: No plugin job remains whose completion could be injected; the builtin shell notifies the session itself when a backgrounded command exits.
- **Migration**: Rely on the host's own completion notification.

### Requirement: Job ownership and lifecycle

- **Reason**: Both process-backed jobs and plugin dispatch rows/registry are retired; no plugin ownership or adoption ledger remains.
- **Migration**: Background commands follow the host's own job lifecycle; native child lifecycle and records belong to the host; crew scheduling evidence is harness-local, not a surviving dispatch registry.

### Requirement: Permission posture preserved

- **Reason**: The exec surface whose posture this requirement preserves is retired; the builtin shell carries the host's own permission behavior and the plugin adds none.
- **Migration**: Configure the builtin shell through the host's own permission config; no plugin posture exists.

### Requirement: Output retention and truncation

- **Reason**: No plugin job output exists.
- **Migration**: The builtin shell truncates large output itself and saves the full result to a file.

### Requirement: Model-facing guidance injection

- **Reason**: The guidance teaches the model to use `forge_shell` and `forge_jobs`; both are retired.
- **Migration**: No job guidance is injected. The plan and goal notices stay specified by tool-partition 'Forge system injections are family-gated'.

### Requirement: Configuration surface and file ledger

- **Reason**: Every `jobs.*` option configures the retired supervisor.
- **Migration**: Remove `jobs.*` from the plugin options; nothing replaces them.

### Requirement: Job stdio decoupled from host pipes

- **Reason**: No plugin-spawned job process exists.
- **Migration**: None; command output is the host's.

### Requirement: OS-level safety net for orphaned jobs

- **Reason**: No plugin-spawned job process exists to orphan.
- **Migration**: Orphan handling of commands is the host's.

### Requirement: Explicit survival mode with a persisted registry

- **Reason**: Survivor adoption exists to re-attach to job processes across plugin reloads; no new plugin-supervised process is created; existing survivors are not adopted or silently removed.
- **Migration**: None; the survivor registry under `<os-tmp>/opencode-forge` is no longer read or written.

### Requirement: Mode selection and supervisor retirement

- **Reason**: The switch between supervised and host-native execution is moot: host-native is the only mode.
- **Migration**: `jobs.mode` and `jobs.keepBuiltinShell` are removed; the builtin shell is always the exec surface (see tool-partition 'Forge family executes on the host's builtin shell').

### Requirement: Terminal-evidence self-cleanup

- **Reason**: No terminal evidence file is written without jobs.
- **Migration**: None.

### Requirement: Host-aligned shell interpreter selection

- **Reason**: Its exec-tool half — the interpreter used by `forge_shell` and its capability fallback — is retired with the tool.
- **Migration**: The interpreter guarantee for plan and goal verification shell checks moves unchanged to goal-harness 'Host-aligned interpreter for verification shell checks'.

### Requirement: Interpreter flavor disclosed in the tool description

- **Reason**: No plugin exec tool description exists.
- **Migration**: The builtin shell's own description discloses the interpreter it uses.

### Requirement: Lifecycle initialization succeeds on a host without a jobs directory

- **Reason**: No jobs directory is used.
- **Migration**: None.
