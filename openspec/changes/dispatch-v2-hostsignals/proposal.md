# Proposal: dispatch-v2-hostsignals

## Why

Production incident 2026-11-22 (F:\UNITY_Project\SorenUnityLabs, host 2.3.2,
forge 0.31.0): two async dispatches created child sessions that (a) **lost
agent binding** — the create body and the v2 adapter never carry `agent`, so
children ran as the naked default agent on the host-default free model
(`tidepool-alpha-free`); role discipline, model pin, and tool partition were
all silently gone; (b) were **declared `stream-lost/unknown` at exactly +30s
by the REST status/messages poll while both children were healthy and
productive** (DB evidence: messages flowing 13–23 minutes; the work was
delivered to disk). The false verdict triggered an automatic re-dispatch of an
already-running task. Root cause alignment: the poll loop keeps all state in
plugin-instance memory and treats the read view as ground truth — the exact
pattern every healthy ecosystem plugin avoids (courier: pure events, zero
polling; mission-control: events + reconcile tick; upstream: durable
`session.execution.*` + `ctx.session.wait` + persisted state in
`ctx.storage`).

## What Changes

- **ADDED**: agent-bound child creation — the create call carries `agent`
  (and the pinned model when the roster defines one), mirrors the host's own
  subagent tool contract; the agent is validated against the live roster
  BEFORE spawn (refuse-not-degrade); after create, the bound agent is read
  back and asserted — mismatch fails loud, never a silently-naked child.
- **ADDED**: host-signal completion detection — durable
  `session.execution.{succeeded,failed,interrupted}` events and/or
  `ctx.session.wait` as the primary terminal signal, plus a slow reconcile
  pass (≥10s cadence) over in-flight children as the lossy-stream backstop,
  and re-subscription on event-stream loss. The REST status/messages view is
  no longer a terminal signal by itself.
- **ADDED**: persisted dispatch registry — in-flight rows (task id, child
  session, agent, prompt anchor) live in `ctx.storage`; after a plugin
  reload or restart the new generation adopts in-flight children and resumes
  watching; restart recovery walks `parentID` as fallback.
- **MODIFIED**: `Dispatch outcome honesty on result-stream loss` — the
  `stream-lost/unknown` verdict is now declared only when BOTH the host
  signals and the reconcile pass fail to observe the child; a healthy child
  with flowing execution events is never declared lost.
- All existing outcome classes (`completed` / `failed` /
  `stream-lost/unknown`), the ledger, and the report-file delivery contract
  are unchanged.

## Capabilities

- **New Capabilities**: none.
- **Modified Capabilities**: `forge-subagents` — one requirement MODIFIED
  (outcome honesty), three requirements ADDED (agent-bound creation,
  host-signal detection, persisted registry adoption).

## Impact

- Code: `src/dispatch-async.ts` (create contract, completion classification),
  `plugin.ts` (v2 wiring: event subscription, reconcile tick, storage
  adoption), dispatch belt/registry touchpoints.
- Tests: new unit + wiring tests per requirement; sandbox E2E gains a
  hot-reload-mid-dispatch leg.
- Docs: README dispatch chapter (binding guarantees, reload adoption,
  cancellation pointer to dispatch-cancel-lifecycle).
- No breaking changes: v1 dispatch path is untouched; v2 outcomes keep the
  same classes and ledger shape.
