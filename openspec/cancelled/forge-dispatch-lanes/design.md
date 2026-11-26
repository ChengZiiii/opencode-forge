# forge-dispatch-lanes — design

## Anchors

- OMO pattern: `categories` in omo.jsonc (`delegate_task` routing:
  model + `models[]` + `fallback_models[]`, `models_distribution`
  sequential/round_robin) — research report Q7-1.
- Forge seams the layer rides: `src/forge-config.ts` (fail-soft parse +
  cascade + mtime hot-apply), `src/dispatch-tiers.ts` `forgeAgentDef`
  (materialization + description provenance), the dispatch pump +
  `journalTerminalRecord` (block C's gate/breaker lives here), the
  v2-runtime-model-pin context-hook rewrite (per-spawn identity seam),
  `schema/forge.schema.json` + drift-mirror test.

## Decisions

- **D1 — lane lives on the agent entry, not the task tool.** OMO routes
  by a `category` argument on `delegate_task` because its agents are
  override-maps, not stable identities. Forge is identity-first: the
  entry `lane` keeps one materialized agent per id (roster and tool
  description stay small), keeps the task tool's parameter surface
  untouched, and puts resolution where pinned-model resolution already
  lives. A dispatch-time parameter is rejected as the primary design;
  it can layer on later without config changes if ever needed.
- **D2 — config shape (fail-soft family):** `lanes: { <name>: { models:
  [identity strings ≥1], distribution?: "sequential"|"round_robin"
  (default sequential, bad value → warn + default), thoughtLevel? } }`.
  Lane names obey the pool/id regex family. Entry `model` XOR `lane`
  (both → error finding + entry skip); `thoughtLevel` requires model or
  lane (pair rule generalized — schema updated in the same change).
  Unknown lane reference → error finding + entry skip (a dispatch to a
  skipped entry fails honestly at the roster check, as today). Bad lane
  def → that lane dropped + warn; entries referencing it then hit the
  unknown-lane path. Cascade-merged maps like `dispatch`; absent node =
  today.
- **D3 — per-spawn resolution + demotion (sequential primary):** the
  pump resolves lane → candidate order (sequential: chain order;
  round_robin: rotation starting after the last spawned member,
  in-memory per process, hot-apply resets) filtered by the block-C gate
  (breaker-open or gate-full members are skipped and the skip is
  journaled). Spawn; on a failed terminal (provider-class failure
  reaching `journalTerminalRecord`) demote to the next member and
  respawn within the existing retry/respawn machinery (the child-session
  respawn seams from block B inherit the hop identity); chain exhausted
  → honest terminal failure naming the lane and the last member.
  Successful terminal resets the lane's demotion cursor.
- **D4 — disclosure + introspection:** materialized description gains
  `lane <name> → model chain [a, b, c] (resolves per spawn)`. The
  dispatch journal records the resolved model identity per hop, so
  "which model actually ran" is answerable from the log — OMO #9's
  introspection without a new API surface.
- **D5 — v1/v2 parity:** v1 chat.params injection resolves the lane per
  spawn (same resolution call, thoughtLevel from lane when present);
  v2 reuses the runtime-model-pin context-hook rewrite, fed the resolved
  identity instead of the pinned one. The depth translation chain is
  untouched.
- **D6 — schema + mirror in the same change:** `lanes` node, entry
  `lane`, generalized pair rule added to `schema/forge.schema.json`;
  drift-mirror test extended to lock them to the validator.

## Non-goals

Per-hop reasoning/variant/temperature; task-tool lane parameter;
cross-agent lane mutation; `_migrations`; persistence of rotation state.

## Test plan

- Config: parse/fail-soft matrix (bad lane def, unknown ref, model+lane
  conflict, thoughtLevel pair generalization, cascade merge, hot-apply).
- Resolution: sequential order, round_robin rotation, gate/breaker skip
  + journal, demotion on failed terminal, chain-exhausted honest
  failure, cursor reset on success.
- Wiring: description disclosure, chat.params per-spawn resolution,
  v2 context-hook fed resolved identity; task tool surface unchanged.
- Schema: mirror test locks lane node/field/pair rule.
- Full suite green (788+ baseline); typecheck; bundle.
