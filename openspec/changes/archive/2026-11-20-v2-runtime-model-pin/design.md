# v2-runtime-model-pin — Design

## Context

v2-plugin-api-port documented the model-pin drift: the host's agent
encoder 500s on any draft carrying `model`, so pool pins were skipped on
V2. The 2.3.2 sandbox probe ladder (2026-11-19):

1. `session.hook("experimental.model.resolve")` — fires with
   `{sessionID, agent, kind, model}` exactly per the d.ts (model
   documented mutable, "change it to serve this request with another
   model"), but mutating the payload does NOT propagate: the served
   model stayed `opencode/tidepool-alpha-free`. The promise adapter
   (`Effect.promise(() => Promise.resolve(callback(event)))`) hands each
   hook a clone; `Hooks<Spec>` callbacks return void — no patch channel.
2. `session.hook("context")` — the payload (SessionContext extends
   SessionRequest) carries `model`, and forge's production mutations
   (`options`, `system`) already propagate on this exact hook. The probe
   rewrote `payload.model` (`providerID` + `id` + `modelID`, variant
   deleted) under an env gate: control run served `tidepool-alpha-free`,
   experiment run served `glm-coding-worker/glm-5.3` (OVERRIDE HONORED,
   reply "OK" from the real model).

## Goals / Non-Goals

- Goal: pool `model` pins apply on V2 at request-build time, mirroring
  V1 semantics (pinned agents always serve on the pinned model).
- Non-Goal: fixing the host's draft-encoder 500 (upstream's bug; the
  draft skip stays).
- Non-Goal: V1 changes (the draft field works there; untouched).
- Non-Goal: cross-provider auth provisioning (the pin resolves to
  whatever provider the user configured; auth is the user's setup).

## Decisions

- **D1 — context hook, same block as depth.** The rewrite lives in
  `v2ContextInjection` inside the forge-family block: resolve the pool
  def fresh per lookup (hot-apply contract), read `def.model`
  (`"provider/model"`), `parseIdentity`, and rewrite `payload.model`
  (`providerID` + `id` + `modelID` spellings; `variant` deleted — the
  source model's variant is meaningless for the pinned model; depth
  rides the existing thoughtLevel options injection, not variant).
- **D2 — unconditional for pinned agents.** When the def pins a model,
  every request for that agent (any kind: primary/title/compaction —
  the hook fires for all) is rewritten. This mirrors V1, where the
  pinned agent IS the pinned model.
- **D3 — parse failures skip silently.** A malformed pin (no slash,
  empty halves) skips the rewrite without throwing (fail-soft, same as
  the depth dead-end path; the once-per-agent warn is NOT duplicated
  here — config validation already findings on bad pins at the
  boundary).
- **D4 — probe log.** `FORGE_MODEL_PROBE=1` traces each rewrite
  (before → after, agent, session) to the OS-temp marker log, the same
  posture as FORGE_DEPTH_PROBE/FORGE_GOAL_PROBE for sandbox attribution.

## Risks / Trade-offs

- The host may someday clone the context payload too (matching the
  resolve hook's behavior) — then the rewrite silently stops applying;
  the sandbox full-chain task catches it (served-model assertion).
- Variant deletion could surprise a user whose workflow leaned on the
  default model's variant — irrelevant in practice: on V2 the draft
  never carried the pin, so no existing V2 user has a variant contract.

## Migration Plan

Single release; no state migration. The pin applies from the first
request after plugin load.

## Open Questions

- None.
