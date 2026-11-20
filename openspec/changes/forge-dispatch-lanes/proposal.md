# forge-dispatch-lanes

## Why

OMO's proven `categories` pattern (`reports/omo-subagent-research-report.md`
Q7-1) answers a need forge currently expresses by duplication: "same
prompt, tiered models". Today a forge pool that wants a scout at two model
tiers defines two agents (`scout-fast` / `scout-deep`) — roster entries,
description surface, and maintenance all multiply N×M. A lane layer makes
the tier dimension orthogonal to agent identity: one agent entry, a named
model chain.

Two things make this timely rather than speculative:

1. Tonight's `harden-dispatch-resilience` block C shipped the
   provider-dimension gate and circuit breaker. Failover chains become
   immediately useful: a lane member whose breaker is open (or whose
   concurrency gate is full) is skipped in favor of the next healthy
   member — the exact automation OMO's `fallback_models` delivers.
2. The honest alternative — tiered duplicate agents — is viable today and
   stays viable; the lane layer pays off when N×M explodes or when
   automatic demotion matters. This proposal is the minimal forge-shaped
   version of that trade, presented for review rather than as a verdict.

## What Changes

- **ADDED — `lanes` node in forge.json (optional, fail-soft):** named
  model chains `{ models: ["provider/model", …], distribution:
  "sequential" | "round_robin" (default sequential), thoughtLevel? }`,
  cascade-merged like every forge.json node; absent node = today's
  behavior.
- **ADDED — agent-entry `lane` as an alternative model source:** an entry
  carries `model` XOR `lane` (both → error finding, entry skipped — the
  existing latter-skip family); the atomic-pair rule generalizes to
  "`thoughtLevel` requires an explicit model source (model or lane)".
- **ADDED — per-spawn resolution with failover demotion:** the dispatch
  pump resolves a lane-backed agent's model at spawn time (sequential =
  first healthy member; round_robin = next in rotation among healthy),
  demotes to the next member on a failed terminal, journals the resolved
  model per hop (forge's equivalent of OMO's model-routing introspection),
  and fails honestly naming the lane when the chain is exhausted or all
  members are blocked by the gate/breaker.
- **ADDED — materialization disclosure:** a lane-backed agent's
  description discloses the lane name, the chain's model ids, and that
  the model resolves per spawn (pool provenance disclosure unchanged).
- **UPDATED — schema publication:** `schema/forge.schema.json` and the
  drift-mirror test gain the `lanes` node, the entry `lane` field, and
  the generalized pair rule (same change, mirror cannot drift).

## Capabilities

### Added Capabilities

- `forge-subagents`: one new requirement — optional dispatch lanes
  (model chains) on agent definitions.

## Non-goals

- No per-hop reasoning/variant/temperature tuning (lane-level
  `thoughtLevel` only; the depth-translation chain is untouched).
- No dispatch-time `lane`/`category` parameter on the task tool (agent
  identity stays the addressing unit — see design D1).
- `round_robin` may be cut at review to sequential-only if the rotation
  state is judged not worth it; the delta is written so that cut is a
  spec edit, not a redesign.
- No `_migrations` machinery (decided against in forge-config-json-schema).

## Authorization note

User directive 2026-11-21 covers autonomous propose. **Apply is
deliberately deferred to user review**: this is a product-level
expressiveness change (the user asked to eyeball the design direction
before apply). Nothing in this change is implemented yet.
