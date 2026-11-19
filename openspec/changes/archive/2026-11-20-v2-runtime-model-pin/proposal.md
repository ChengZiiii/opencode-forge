# v2-runtime-model-pin

## Why

The V2 migration (v2-plugin-api-port) documented a drift: pool agents'
`model` pins are V1-only because writing the `model` field on a V2 agent
draft breaks the host's `/api/agent` encoder with a 500 ("Server failed
to encode its response") — any shape (plain string or
`{providerID, modelID}` object) fails. Per-agent model pinning is a core
workload feature (the oh-my-openagent precedent pins models per agent),
and silently dropping it on V2 leaves pool workers on the host's default
model. Sandbox empiricism on 2.3.2 (2026-11-19) found the designed
runtime seam: the `session.hook("context")` payload (SessionContext
extends SessionRequest) carries the resolved `model` (Model.Ref), and —
unlike `experimental.model.resolve`, whose per-hook event cloning eats
mutations — mutations on the context payload demonstrably propagate:
forge already rewrites `options` and `system` there in production. A
live probe rewrote `payload.model` to `glm-coding-worker/glm-5.3` and
the request was served by that exact model, with the record showing it
(OVERRIDE HONORED).

## What Changes

- **Runtime model pin on V2**: in the v2 context-injection path, when the
  session's agent is forge-family and its pool def pins `model`
  (`"provider/model"` string), rewrite the payload's `model`
  (`providerID` + `id`/`modelID` spellings, variant dropped) to the
  pinned identity — the same hook, the same pool-lookup chain, and the
  same mutation mechanism as the existing thoughtLevel injection.
- **The draft `model` field stays skipped on V2** (the 500 stands); the
  pin is applied at request-build time instead. V1 behavior unchanged
  (draft field keeps working there).
- **Sandbox full-chain proof**: a pool agent pinned to a second model,
  dispatched as a subagent, serves its turn on the pinned model —
  verified via the served message record.
- **Docs**: the v2-plugin-api-port design supersession item for the
  model-pin drift is updated from "V1-only" to "resolved via runtime
  pin (context hook)".

## Impact

- Specs: `forge-subagents` (per-agent model pin on v2 hosts)
- Code: `v2ContextInjection` in plugin.ts (one guarded rewrite block)
- Tests: v2 mock-harness unit tests (wired + drift legs) + sandbox E2E
