## Why

On a shared `opencode serve` host, materialized agent ids depend on the ORDER workspaces were initialized in: the first anchor's pool gets plain ids (`forge-coder`) and every other pool is namespaced — so the same forge.json materializes as different ids on different hosts, and sessions in every non-first workspace see foreign specialized agents holding the most generic-looking names (observed live: a Unity session's roster carried the plugindev pool's `forge-coder`/`forge-spec-reviewer` as bare ids while the session's own pool sat namespaced). The session-domain dispatch gate already refuses cross-pool dispatch, but the naming layer tells the opposite story, and id instability breaks crew plans, muscle memory, and docs per-host. Separately, a pool file without a declared `pool` namespace silently rides a directory-name-derived namespace that changes on renames — the file-level id-stability contract is currently a recommendation, not a requirement.

## What Changes

- **BREAKING** — the primary-anchor plain-id privilege is removed: EVERY pool family materializes namespaced (`forge-<ns>-<id>`), including the global fallback layer (`forge-global-<id>`). No family receives plain ids anywhere; a materialized id is identical on every host regardless of initialization order (resolution order becomes pure lexicographic by pool-file path, which also makes cross-family collision outcomes deterministic across hosts).
- Pool provenance is disclosed in the task-vocabulary description of every materialized agent: its namespace, its origin forge.json path, and (for non-global families) that it is dispatchable only from sessions whose workspace pool is that file — the model meets the truth before any dispatch gate fires.
- A crew-governed pool-compliance gate: `crew_begin` refuses to register, and every `task` dispatch from a crew-governed session is refused, while the session's workspace pool file does not declare a valid top-level `pool` namespace (`[a-z0-9-]`, 1–24 chars). The refusal names the file, the violation, and the minimal compliant fix; compliance hot-applies (the gate lifts at the next resolve after the file is repaired). Global-fallback sessions are exempt (fixed namespace `global`). Per-agent fail-soft findings keep their existing skip semantics and never make the file non-compliant.
- Spec hygiene riders in the same requirements: the stale cross-reference to the removed *Hierarchical pool materialization* requirement and the equally stale "bounded subtree scan" wording in the static-definitions requirement are corrected to workspace-pool semantics.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `forge-subagents`: three requirements change. *Static agent definitions in a dedicated forge.json* — the `pool` field sentence is rewritten for always-namespaced materialization and the stale hierarchical-era references are fixed. *Materialization as native subagents with a pinned model* — the task-vocabulary description additionally names pool provenance (namespace, origin file, session-domain dispatchability). *Workspace pool ownership and global fallback* — the plain-id primary family is removed; every family (workspace pools and the global fallback) materializes namespaced, ids become host-history-independent, and cross-family materialized-id collisions resolve deterministically in lexicographic file-path order.
- `crew-harness`: one requirement added — the crew-governed dispatch pool-compliance gate (crew_begin pre-flight + per-dispatch re-check, sharing one compliance predicate with the existing session-domain pool gate belt).

## Impact

- `src/forge-config.ts` — pool resolver: delete the primary/plain-pool special case (`plainPoolFile`), pure lexicographic resolution order, global fallback family always namespaced `global`; expose a file-level pool-compliance predicate.
- `src/dispatch-tiers.ts` — `agentDescriptionFor` gains the provenance line (namespace + origin path + dispatchability scope).
- `plugin.ts` — config-hook materialization passes provenance; crew roster label logic drops the "primary pool (plain ids)" branch; `crew_begin` pre-flight compliance refusal; the `tool.execute.before` belt gains the crew-governed compliance check (composed after the session-domain pool gate); `/crew` and unconfigured-gate template wording updated (`non-primary pools materialize as…` → `every pool materializes as forge-<ns>-<id>`; the embedded template's `pool` hint becomes the compliance requirement); v2 `setup` inherits everything through the shared resolver.
- Tests — `hierarchical-pools.test.mjs` (primary-plain assertions flip to all-namespaced; global-fallback ids; determinism across anchor orders; compliance-gate matrix incl. crew_begin refusal + per-dispatch refusal + hot-apply lift + global exemption), `forge-subagents-wiring.test.mjs` and `v2-setup.test.mjs` (materialized ids, description provenance, create-only parity), crew template assertions.
- README — id-shape documentation rewritten; migration note for single-pool users (ids change unless a `pool` field is added; recommend declaring one).
- **BREAKING** for existing rosters: every materialized agent id changes shape (e.g. `forge-coder` → `forge-plugindev-coder`); crew records and docs referencing old ids are history artifacts.
