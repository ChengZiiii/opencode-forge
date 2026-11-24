## MODIFIED Requirements

### Requirement: Job ownership and lifecycle

Each job SHALL be owned by the session that created it. When an owning session ends, its live jobs SHALL be terminated unless ownership was handed off or the job explicitly opted into survival. **Host-process exit SHALL be an explicit termination trigger equal to session end, honored on every exit path (plugin dispose, SIGINT, SIGTERM, uncaught exception, process exit), not only on graceful dispose.** Plugin `dispose` and every host-process exit path SHALL terminate all live process-backed jobs (jobs owning a local process tree); dispatch registry rows — subagent dispatches tracked against server-side child sessions with no local process — SHALL be exempt from plugin-`dispose` termination: a dispose fired in any plugin context SHALL NOT kill, abort, or terminalize any in-flight dispatch row, its settle loop keeps watching, and cross-restart continuity for dispatch rows is the dispatch journal with restart recovery (specified under forge-subagents) rather than any kill. **Plugin `dispose` is the v1 cleanup hook (`Hooks.dispose` of the v1 plugin contract) and is the only path by which a plugin unload terminates jobs; a v2 host has no such hook and never invokes it.** On a v2 host the plugin's only unload cleanup is the function its `setup` resolves to; that cleanup SHALL dispose only the plugin instance's own registrations and stop its own event subscription, and SHALL terminate no job and no dispatch row: a location eviction, a plugin reload, or any other plugin unload that is not the host-process exit leaves every live job running. Jobs still alive after their owner ended, and completions never read by any session, SHALL be reported in the diagnostics ledger. When the plugin is wholly disabled via the agent disable knob, no job tools SHALL be registered and no job state SHALL persist.

#### Scenario: Owner session end cleans up its jobs

- **WHEN** a subagent session that started a background job ends without handing it off
- **THEN** the job's process tree is terminated and no orphan process survives

#### Scenario: Host process exit terminates background jobs on every path

- **WHEN** the host process exits after a `run` that started a background job, whether normally, via signal, or via an error exit
- **THEN** the job's process tree is terminated shortly after exit and no orphan process survives; a service the job was running no longer accepts connections

#### Scenario: Handoff survives owner end

- **WHEN** a job was handed off before its creating session ended
- **THEN** the job keeps running under the rebound owner and its completion is delivered there

#### Scenario: Disable knob registers no job tools

- **WHEN** the plugin loads with the agent disable knob set
- **THEN** neither `forge_shell` nor `forge_jobs` is registered and no job state exists

#### Scenario: Plugin dispose spares in-flight dispatch rows

- **WHEN** a subagent dispatch is in flight and the v1 plugin `dispose` hook fires (a v1 host unloading the plugin — any dispose that is not the host-process exit)
- **THEN** the dispatch row is not killed or terminalized, its settle loop keeps watching the child, the journal record stays non-terminal, and the completion wake still arrives at true terminal

#### Scenario: A plugin unload on a v2 host terminates no job

- **WHEN** a v2 host unloads the plugin while a process-backed job is live and a subagent dispatch is in flight (the owner location is evicted or the plugin is reloaded; the host process keeps running)
- **THEN** no job process is terminated and no dispatch row is killed or terminalized — the live job runs to its natural end, the v1 `dispose` hook is not invoked, and the dispatch completes with exactly one completion wake at true terminal
