# Proposal: async-dispatch

## Why

The native `task` tool blocks the dispatching session until the subagent
finishes. Long-running reconnaissance (a full repo audit, a slow review
pass) freezes the primary for minutes with nothing to do, while the plugin
already owns every piece of machinery async delivery needs (job registry,
completion-wake injection, session-death harvesting). Oh-my-opencode has
proven — entirely at plugin level, zero fork — that an SDK-driven dispatch
tool gets BOTH native TUI progress visibility (child sessions created with
`parentID` render in the host session tree exactly like native task
children) AND async execution (send prompt, return a task handle, inject
the result later). The user has finalized the design stance: whether a
dispatch is async is decided by the primary agent AT DISPATCH TIME via the
tool's mode parameter; mid-flight user conversion is cosmetic and out of
scope (the primary chose blocking because the next step depends on the
result — converting does not change the dependency structure).

## What Changes

- The forge-subagents spec's "Native-task dispatch surface" prohibition
  (which forbids registering any `forge_dispatch` tool) is REPLACED by a
  "forge_dispatch surface" requirement: a plugin-registered
  `forge_dispatch` tool with `mode: "wait" | "async"` that dispatches
  materialized forge subagents through SDK child sessions
  (`client.session.create` with `parentID` linking + the materialized
  agent id), running on the same host server as the parent.
- `wait` mode: the tool polls the child session to terminal and returns
  the child's final assistant message (blocking parity with native task).
- `async` mode (ALL shapes, no phase split — OMO-proven): the tool returns
  a task handle immediately; on completion a single wake message carrying
  the child's final assistant message is injected into the parent session
  following the job-supervisor completion-wake discipline (idle-only,
  at-most-once, delivery window, ledger overflow).
- Unattended-safety: child sessions in BOTH modes are created with the
  question tool denied session-wide (`permission: [{permission: "question",
  action: "deny", pattern: "*"}]`, OMO parity) — a child can never block
  on human input; write authority comes from the materialized agent
  permission map, and a pending permission ask degrades to the honest
  poll-timeout finding (child session id disclosed, natively abortable).
- Gate parity: the session-domain pool gate, crew gates, primary-only
  rule (workers cannot call forge_dispatch), and plan-draft readonly-recon
  exemption apply to forge_dispatch exactly as to native task.
- Lifecycle: per-session concurrent async cap; owner-session death
  aborts the child session and records the orphan in the diagnostics
  ledger; child sessions are real host sessions the user can abort
  natively in the TUI.
- The native `task` path is UNCHANGED in this change (both surfaces
  coexist; retiring native-task dispatch is a future change if the new
  surface proves out).

## Impact

- Spec: `forge-subagents` (REMOVED prohibition requirement + two ADDED
  requirements). No other spec touched.
- Code: `plugin.ts` (tool registration, gate wiring, wake/lifecycle
  hookup), new `src/dispatch-async.ts` core; tool count 17 → 18.
- Users: new capability, additive; `agent["forge"].disable` removes the
  tool with all other forge tools.
