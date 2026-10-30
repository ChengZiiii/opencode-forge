# Design — pool-namespace-contract

## Context

v1/v2 opencode materialize agents host-wide (`config` hook / `setup` transform); there is no per-session agent registry. On a shared host the materialization set is therefore forced to be the union of every seen workspace pool + the global layer. The current resolver grants the first-registered anchor's pool plain ids (`plainPoolFile`), which makes ids depend on host initialization order and hands foreign specialized pools the most generic-looking names in other sessions' rosters (see proposal.md — Why; the 2026-09-29 SorenUnityLabs incident lineage in the sole-pool-ownership archive). The session-domain dispatch gate already tells the truth at dispatch time; this change makes the NAMING and DESCRIPTION layers tell the same truth, and turns the `pool` field from a recommendation into a crew-gated file-level contract.

## Goals / Non-Goals

Goals: host-history-independent materialized ids; zero plain-id families; provenance visible pre-dispatch; crew-governed dispatch blocked on a declared valid `pool` namespace; v1/v2 parity through one resolver.

Non-Goals: per-session agent visibility (impossible in v1 — upstream feature territory); renaming or merging existing pools; any compat alias from old plain ids to new namespaced ids; touching dispatch-gate semantics for cross-pool refusals; making the global layer declare a `pool` field (fixed `global` namespace by construction).

## Decisions

**D1 — Delete the primary special case; pure lexicographic resolution order.** `resolve()` loses `plainPoolFile` entirely; family order becomes the existing lexicographic sort over all pool files (global included). Every family gets `ns = declaredPool ?? derived`. This is a deletion, not new machinery; arrival order stops influencing anything (ids AND collision winners). *Alternative: deterministic primary (host cwd, or a `pools.primary` config knob) — rejected: still exactly one privileged pool per host, wrong for every other session, and adds config surface.*

**D2 — Global fallback family materializes under the fixed namespace `global` (`forge-global-<id>`).** One rule, zero exceptions. *Alternative: keep the global layer's ids bare for pool-less-workspace ergonomics — rejected: it re-creates the trap this change removes (pooled sessions seeing bare, generic-looking, non-dispatchable ids) and reintroduces a two-class id vocabulary. Cost accepted: pool-less sessions type `forge-global-coder`.*

**D3 — Provenance is static, per-family, host-wide — baked into the task-vocabulary description at materialization.** The description carries namespace + origin forge.json path + "dispatchable only from sessions whose workspace pool is this file" (global family: "origin: the global fallback layer"). The v1 config hook cannot vary descriptions per session, and static text is true in every session — the belt stays the dynamic authority, the description is the honest label. *Alternative: session-scoped roster injection only (à la /crew template) — kept as-is where it already exists, but it is prompt-surface, not vocabulary-surface; the description is what the dispatching model actually reads when picking an agent id.*

**D4 — One compliance predicate, three call sites, file-level scope.** A pure function beside `validatePoolField` in `src/forge-config.ts`: `poolFileCompliance(parsedTop)` → compliant iff a valid declared top-level `pool` (same `[a-z0-9-]` 1–24 rule). Call sites: `crew_begin` pre-flight (refuse registration — no record, no PENDING crew), the `tool.execute.before` belt for crew-governed sessions dispatching `forge-*` targets (runs AFTER the session-domain pool gate so cross-pool refusals keep their copy), and nothing else — non-crew single dispatches are untouched per scope. Per-agent fail-soft findings never enter the predicate. *Alternative: also block non-crew dispatches — rejected: user asked for the gate at crew dispatch; widening later is trivial, narrowing after a complaint is not.*

**D5 — v2 `setup` inherits everything by construction.** It already resolves through the shared resolver (`resolve([process.cwd()])`); with D1 its single-anchor pool now namespaces too, and the description builder (D3) is shared via `forgeAgentDef`. No v2-specific branch is added; the create-only discipline is unchanged.

**D6 — No compat aliases for old plain ids.** An alias layer (bare id → namespaced id) would resurrect exactly the ambiguity this change kills (two ids, one agent, cross-session lies). Crew records and docs referencing old ids are history artifacts; the README carries a migration note: single-pool users add a `pool` field and dispatch `forge-<pool>-<id>` from now on.

**D7 — Roster/label plumbing simplifies.** The `f.primary ? "primary pool (plain forge-<id> ids)" : …` label branches in plugin.ts die; every family renders as `pool <ns> (forge-<ns>-*)`. Template strings teaching `non-primary pools materialize as forge-<ns>-<id>` flip to `every pool materializes as forge-<ns>-<id>; the global fallback materializes as forge-global-<id>`, and the embedded JSONC template's `pool` hint becomes the crew compliance requirement (declared field required for crew-governed dispatch).

## Risks / Trade-offs

- [BREAKING: every materialized id changes shape overnight] → README migration section + suggest-a-namespace in the compliance refusal copy; version bump to 0.18.0 signals the break.
- [Longer agent ids hurt ergonomics in one's own workspace] → short namespaces are the documented contract (≤24 chars, `pool` field preferred — plugindev already declares `"plugindev"`); roster surfaces list full ids for copy-paste.
- [crew_begin suddenly refuses legacy pools at the worst moment] → the refusal copy is one JSONC line to add, names the exact file and a suggested namespace, and lifts hot-apply without restart; AI-assisted config discipline already mandates the field, so newly written pools are pre-compliant.
- [Description bloat narrows the vocabulary surface] → provenance is one compact sentence appended to the existing short description; role + brain + provenance stay within the task-vocabulary norms.
- [Resolver order change alters who wins a cross-family id collision] → now deterministic by path (same on every host) instead of arrival order; an error finding names both files either way.

## Migration Plan

1. Ship as 0.18.0 (breaking → minor bump per the repo's pre-1.0 convention; the design's original "0.5.0" was written against a stale 0.4.x baseline — the repo is at 0.17.0, and 0.5.0 would be a semver downgrade). 2. README: rewrite the id-shape documentation; add a migration note (declare `pool`; ids become `forge-<pool>-<id>`; `forge-global-*` for pool-less workspaces). 3. No data migration (no state keys on materialized ids; depth injection keys by agent name and re-resolves). 4. Rollback: revert to the prior release tag; pool files need no changes in either direction (a declared `pool` is valid in both eras).

## Open Questions

(none)
