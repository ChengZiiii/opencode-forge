# Proposal: task-shadow

## Why

The async-dispatch release (0.22.0) delivers real SDK child sessions, but
the TUI renders `forge_dispatch` as a generic tool-call block — the live
subagent panel the user expects is keyed by the opencode TUI on the tool
NAME `task` (verified: oh-my-openagent registers its own SDK-based async
dispatch engine under `tools.task = delegateTask`,
`packages/omo-opencode/src/plugin/tool-registry-core-tools.ts:148`, and
its runs render with the native task panel). The mechanism underneath is
already identical to OMO's; the only gap is the name. On a forge host the
forge agent is the default agent, forge replaced the native plan/build
agents, and opencode v2 itself deprecates the multi-agent-config surface —
owning the `task` name is the honest end-state: one dispatch surface,
native rendering, async capability.

## What Changes

- The plugin registers its dispatch implementation under the tool name
  **`task`**, shadowing the native task tool host-wide (OMO-proven
  approach on the same stack). The engine is the 0.22.0 SDK child-session
  engine, extended to full native parity:
  - ANY materialized target agent (forge-* via the pool-gated roster,
    non-forge host agents via the same SDK path without the forge pool
    gate).
  - Args: `description`, `prompt`, `subagent_type`, and
    `run_in_background` (async flag, OMO-style).
  - Question policy per mode: sync dispatches keep questions available
    (native parity — the user is present at the panel); async dispatches
    create the child with the question tool denied session-wide
    (unattended safety, carried over from async-dispatch).
  - Sync-mode abort parity: when the dispatching turn is aborted, the
    child session is aborted (native behavior; async children keep
    surviving turn aborts by design and die at session death).
- Tool-part metadata mirrors the native/OMO shape (`agent`, `sessionId`,
  `taskId`, `run_in_background`, `description`, `prompt`) so the TUI
  task renderer drives off the same keys; rendering fidelity is verified
  live in the TUI (the user watches the panel) as an acceptance scenario.
- The `forge_dispatch` tool is RETIRED (registered since 0.22.0): one
  dispatch surface named `task`; the engine, wake, registry, harvest,
  and per-session async cap (3) carry over unchanged. The async-dispatch
  spec requirements are superseded by this change's deltas.
- Gates carry over keyed on the `task` name: session-domain pool gate +
  crew belts for forge-* targets, primary-only (workers keep the forced
  `task: deny` recursion ban), per-session async cap, plan-draft shape
  interop (readonly scouts pass, write targets denied — both modes).

## Impact

- Spec: `forge-subagents` (REMOVE the two async-dispatch requirements,
  ADD the task-shadow surface + lifecycle requirements). Other specs
  reference task dispatch generically and hold.
- Code: `plugin.ts` registration rename + arg schema + metadata
  publishing + non-forge target path; `src/dispatch-async.ts` gains the
  abort-signal hook. The registration map stays 18 keys (`task` replaces
  `forge_dispatch` — a swap, not a removal); the forge partition
  vocabulary hidden from non-forge agents drops 18 → 17 (`forge_dispatch`
  is removed and `task` is intentionally shared with every agent).
- Users: the TUI shows the native-style live panel for forge dispatches;
  breaking-note in README — co-installing with oh-my-opencode is not
  supported (both shadow `task`; registration order would decide).
