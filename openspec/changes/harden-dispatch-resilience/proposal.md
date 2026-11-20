# harden-dispatch-resilience

## Why

OMO competitive research (`reports/omo-subagent-research-report.md`, v5.1.79)
surfaced three runtime-resilience designs we lack; a HEAD-baseline survey
(`reports/explore-dispatch-resilience-report.md`) then localized each to a
concrete gap in our dispatch path:

1. **Completion verdict is AND-shaped.** `pollChild`
   (`src/dispatch-async.ts:541-661`) already READS two signals (status map +
   message stream) but completes only on `not-active ∧ finish ∧ non-empty
   text`. When the status view is stuck "active" while the final assistant
   text has already streamed out (OMO PR #5293's exact failure), we poll all
   the way to a timeout and report dishonest uncertainty for a child that
   actually finished.
2. **Nested-dispatch 400 exposure on non-forge targets.** The forge family
   is structurally immune (`task: deny` is forced at the single
   `forgeAgentDef` seam), but non-forge host targets — the exact path crew's
   native-fallback rules encourage — hand the child a dispatchable task
   tool. Anthropic-family providers reject nested delegation with a 400
   (OMO PR #3630); we will hit the same wall the moment crew dispatches a
   native anthropic-backed agent.
3. **No provider-dimension gate, no circuit breaker.** Verified vacuum: the
   existing gates are all session-domain (pool gate, `ASYNC_DISPATCH_CAP=3`,
   crew caps); nothing is keyed by provider/model, a 429 is currently a
   RETRY reason (the opposite of a breaker), and one hot provider key can be
   ground to paste by our own concurrent dispatches.

## What Changes

- **ADDED — Active-textful completion override:** when the status view
  stays `active` but the child's final assistant text has been readable for
  the same 3-tick stability window the not-active path uses, the poller
  SHALL verdict COMPLETE through that path — never waiting for the status
  view to flip. One branch in `pollChild`, covers sync and async, zero
  plugin.ts wiring, independently revertible.
- **ADDED — Nested-dispatch tool guard (non-forge targets):** child-session
  creation gains a `taskDeny` option; when the target is a non-forge host
  agent whose provider family is anthropic, the create body carries the
  task-tool deny (the same body channel QUESTION_DENY already rides and that
  a sandbox probe shall first confirm effective). Single funnel:
  `createChildSession` (`src/dispatch-async.ts:119`), all five spawn sites
  inherit. Forge-* targets need nothing (structural immunity stands).
- **ADDED — Provider-dimension concurrency gate + circuit breaker:** an
  in-memory counter fed at `journalTerminalRecord` (plugin.ts:2351, outside
  the in-flight crew hunks) plus an optional `dispatch` node in forge.json
  (`providerConcurrency` / `modelConcurrency` maps, `circuitBreaker`
  {consecutiveFailures, cooldownMs}) — field-level fail-soft like every
  forge.json knob, absent node = today's behavior. The breaker counts
  consecutive failed terminals per provider, refuses NEW dispatches with an
  honest refusal naming the breaker and its recovery condition, and
  half-opens after the cooldown.

## Capabilities

### Added Capabilities

- `forge-subagents`: three new requirements — active-textful completion
  override; nested-dispatch tool guard on non-forge child sessions;
  provider-dimension dispatch gate and circuit breaker.

## Authorization note

User directive 2026-11-21 ("该开的 change 你自己开……自行完成多轮任务闭环"):
explore → propose → apply → verify run autonomously this session;
npm publish and change archival still require explicit user approval.
Block B's implementation is sequenced behind the in-flight crew change
(`fix-v2-crew-surface-drift`) — both touch `createChildSession`.
