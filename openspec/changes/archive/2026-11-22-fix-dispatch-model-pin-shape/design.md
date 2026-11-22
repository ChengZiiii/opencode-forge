# Design: fix-dispatch-model-pin-shape

## Decision

Change the create-time model record from
`{providerID, modelID, id: `${providerID}/${modelID}`}` to
`{providerID, modelID, id: modelID}` — one line in
`src/dispatch-async.ts` (the single seam all five `modelPin` call sites
flow through). No consumer change: `rosterModelPin` already returns
`{providerID, modelID}` and `parseIdentity` already splits correctly.

## Field realities (sandbox probe, 2.3.2, 2026-11-22)

Probe: isolated `OPENCODE_CONFIG_DIR` + XDG set, minimal config, no plugins;
`opencode serve` on 47941; sessions created via `POST /api/session` with
model variants; prompt via `POST /api/session/:sid/prompt`; errors read from
`--print-logs` stderr.

| variant | create body `id` | stored record | runner select key |
| --- | --- | --- | --- |
| A (current code) | `glm-coding-worker/glm-5.3` | `{"id":"glm-coding-worker/glm-5.3","providerID":"glm-coding-worker","variant":"default"}` | `Model unavailable: glm-coding-worker/glm-coding-worker/glm-5.3` — **tripled, production bug reproduced** |
| B | `glm-5.3` | `{"id":"glm-5.3","providerID":"glm-coding-worker","variant":"default"}` | `Model unavailable: glm-coding-worker/glm-5.3` — clean two-segment key |
| C (no modelID key) | `glm-5.3` | `{"id":"glm-5.3","providerID":"glm-coding-worker","variant":"default"}` | clean, same as B |

Host behavior notes:

- The session model record stores `id` VERBATIM from the create body and
  adds `variant: "default"` when absent. The runner composes
  `providerID + "/" + model.id` at select — `id` must be the bare model id.
- The `/api/agent` normalized AGENT model uses the same shape
  (`{"id":"glm-5.3","providerID":"glm-coding-worker","variant":"low"}`) —
  bare `id` is the host-wide convention, not a session-only quirk.
- The v2 runtime pin context-hook rewrite (plugin.ts, `m.id = identity.
  model`) already writes the bare id — it matches the host contract and was
  NOT the bug; it stays, now guarded by a test.
- The same-second `SchemaError(Expected object)` seen in production is
  consistent with the host schema processing the malformed record; it was
  not reproducible in the probe log slice and is treated as a symptom, not
  a separate defect. If it resurfaces post-fix with a clean key, it gets
  its own change.

## Why the earlier probes shipped the defect

The task-1.1/2.1 probes asserted the record echoes the create body — a
self-confirming observation ("what we sent is what landed"), with no
downstream runner exercise. The real-host create-with-pin leg was recorded
as D6 debt (tasks.md 1.2/5.2 of dispatch-v2-hostsignals) and never billed;
production billed it. Process lesson recorded: a create-payload probe that
only reads back the same record is an echo, not a verification — the
assertion must reach the consumer of the payload.

## Verification shape (③)

1. Unit: create-body assertions updated to the bare-id contract (old
   assertions pinned the defective shape).
2. Sandbox: fixed dist loaded in an isolated serve; pinned-model dispatch
   via the real create seam; `GET /api/session/:id` asserts
   `model.id` is the bare model id (the probe's variant-B storage shape).
   The adopted-wish leg shares this single create seam; the opportunistic
   real-host adoption re-kill stays an ④ user-leg item (D6 noted in tasks).
