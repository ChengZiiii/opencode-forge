# hang-watchdog Specification

## Purpose
Detect and unblock built-in shell tool calls that hang past a stall threshold in any session (primary or delegated), by marking those calls' processes, timing them, and applying graded intervention including tree-kill — a backstop layer independent of the job-supervisor's own execution path.

## Requirements

### Requirement: Marking and timing of built-in shell calls across all sessions

For every built-in shell tool invocation in any session (primary or delegated), the plugin SHALL attach a marker environment variable carrying the call identifier via the host's shell environment hook, record the start time keyed by call identifier when the call begins, and clear the record when the call ends. The marker SHALL be namespaced to this plugin so foreign processes are never matched.

#### Scenario: A delegated session's shell call is tracked

- **WHEN** a subagent runs a command through the built-in shell tool while the plugin is loaded
- **THEN** the spawned process carries the plugin's marker environment variable and the call is being timed

#### Scenario: Completed calls leave no residue

- **WHEN** a built-in shell call ends normally
- **THEN** its timing record is cleared and no intervention can target it afterwards

### Requirement: Stall detection with graded intervention

When a tracked call has not ended after `watchdog.stallMs` (default 600000, configurable), the plugin SHALL intervene. Intervention SHALL be graded: at 80% of the budget a diagnostic warning entry is recorded (no message is injected into the busy session); at the threshold the call's process tree is located and terminated so the pending tool call unblocks; if the call still has not ended after the kill, or no matching process exists to kill, the incident SHALL be recorded as a diagnostics-only report.

#### Scenario: Stuck foreground call is unlocked by tree-kill

- **WHEN** a built-in shell call hangs because a detached grandchild holds the stdio pipes past the stall threshold
- **THEN** the watchdog terminates the call's process tree and the tool call resolves with the captured output

#### Scenario: Early warning lands in diagnostics, not the busy session

- **WHEN** a tracked call reaches 80% of its stall budget while still running
- **THEN** a diagnostic entry is written and no message is queued into the session

#### Scenario: No-process hangs are reported, not fixed

- **WHEN** a tracked call exceeds the threshold but no matching live process exists (e.g. a dropped provider stream)
- **THEN** the incident is recorded in the diagnostics ledger and no unrelated process is touched

### Requirement: Cross-platform process location with misfire protection

The plugin SHALL locate a stalled call's processes by exact marker match on platforms where foreign process environments are readable. Where environments are unreadable, location SHALL be inferred in two guarded waves, both restricted to processes created at or after the call's start (with a small clock-granularity allowance): wave 1 considers descendants of the host process OR processes whose command line carries the stalled call's own command text; wave 2 — reached only when wave 1 found nothing or provably failed to unblock the call — additionally considers processes whose command lives in the stalled command's own directory (separator-normalized), which is where detached pipe holders of the exit-with-inherited-stdio hang class sit. The locator SHALL never target a process created before the call's window, its own probe processes, or console host processes, and intervention SHALL apply at most once per wave per call identifier.

#### Scenario: Marker match wins where readable

- **WHEN** the stall threshold fires on a platform with readable process environments
- **THEN** only processes carrying this plugin's marker for that call identifier are considered

#### Scenario: Wave 1 inference stays inside the host subtree or the command text

- **WHEN** environment reading is unavailable and wave 1 inference is used
- **THEN** only descendants of the host process created within the call's time window, or processes created within that window whose command line carries the stalled call's command token, are considered

#### Scenario: Wave 2 reaches the detached pipe holder after wave 1 proves insufficient

- **WHEN** wave 1 killed nothing (the call's own chain already exited) or the call did not return within the observation window after a wave 1 kill
- **THEN** wave 2 considers only processes created within the call's time window whose command lives in the stalled command's own directory, kills at most that set, and a subsequent failure is reported as unresolved rather than escalated further

### Requirement: Intervention modes

The watchdog SHALL support `watchdog.mode` values `off`, `dry-run`, and `kill` (default `kill`). `dry-run` SHALL record the process list that would be terminated without terminating anything; `off` SHALL disable timing and intervention entirely.

#### Scenario: Dry-run records the would-be kill list

- **WHEN** a stalled call reaches the threshold with `watchdog.mode: "dry-run"`
- **THEN** the diagnostics ledger lists the processes that would have been terminated and all of them keep running

#### Scenario: Off is fully inert

- **WHEN** `watchdog.mode: "off"` and a built-in shell call hangs
- **THEN** no markers, timing records, diagnostics, or interventions occur

### Requirement: Diagnostics ledger and file ledger

Every intervention (warning, kill, diagnostics-only report) SHALL be recorded in a bounded, rotating ledger under the plugin's namespaced temporary directory. The README file ledger SHALL enumerate the directory and the uninstall steps SHALL leave no plugin-created residue outside documented user-data locations.

#### Scenario: Interventions are auditable after the fact

- **WHEN** the user inspects the watchdog ledger after an intervention
- **THEN** each entry shows the call identifier, session, timestamps, matched processes, and the intervention taken

### Requirement: Boundary with the job-supervisor

Processes started through the job-supervisor's own execution tool SHALL NOT carry the watchdog marker and SHALL NOT be subject to watchdog intervention; the watchdog governs only built-in shell tool calls.

#### Scenario: Job processes are out of watchdog jurisdiction

- **WHEN** a job-supervisor job runs longer than the stall threshold
- **THEN** the watchdog takes no action against it and its lifecycle is governed solely by the job-supervisor's own rules
