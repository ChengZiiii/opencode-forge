# fix-v2-crew-surface-drift

## Why

Discovered live during the v2 crew-waves test (2026-11-20), two independent
drifts break crew orchestration on opencode 2.3.2:

1. **Crew init gate resolves a stale anchor.** `crew_begin`'s roster gate
   reads the TOOL-CONTEXT anchor (`sessionAnchor(context)` → tool-context
   worktree/directory → host launch directory), while the dispatch belts
   resolve the AUTHORITATIVE session record first
   (`resolveSessionAnchorForPools`). Observed: a session created at the
   home directory and later re-anchored
   (`session_move` to the plugindev workspace) has an up-to-date session
   record (location.directory = the workspace, verified via
   `/api/session/:id`) but a tool context still reporting home — the crew
   gate refused ("CREW IS NOT INITIALIZED") while the native-path dispatch
   belt accepted the very same pool. Two anchor chains, two answers.
2. **The task tool's child-session client seam is gone.** `tools.task`
   dispatch died with `client.session.create is not a function` — the
   SDK client surface the plugin calls (`client.session.create` with
   `parentID` + `query.directory`) does not exist in that shape on 2.3.2.

User directive that fixes the direction: **no global fallback pool**. A
fresh install has no global layer, and per-project (workspace-pool)
subagent configuration is the primary user pattern — crew must work
end-to-end with ZERO global configuration. The answer is fixing the two
drifts, not adding a global layer.

## What Changes

- **Anchor unification:** the crew init gate's roster resolution (and the
  crew record path anchor) resolve the session anchor through the SAME
  authoritative-first chain as the dispatch belts: session record via the
  anchor client (with the existing pooled-map preference and ledger
  rebind semantics), tool-context anchor only as the no-client fallback.
- **Task client seam adaptation:** the task tool's child-session creation
  resolves the ACTUAL client surface on the host (guarded shape probing),
  and when no create seam exists, degrades with an honest error naming
  the native task tool as the dispatch surface — never a raw TypeError.
  The parent directory handed to child creation comes from the
  authoritative anchor, so children of re-anchored sessions anchor
  correctly.
- **Acceptance shape:** the sandbox E2E proves the full crew loop
  (register → arm waves → dispatch → close) on 2.3.2 with a
  workspace pool ONLY — no global forge.json present anywhere — plus the
  re-anchored-session scenario that produced finding 1.

## Capabilities

### Modified Capabilities

- `crew-harness`: "Unconfigured crew initialization gate" — roster
  resolution moves to the authoritative-first anchor chain; all existing
  scenarios carry over, two anchor scenarios added.
- `forge-subagents`: "Task shadow surface (native name, forge engine)" —
  the SDK child-session clause gains host-shape adaptation and honest
  degradation; all existing scenarios carry over, two v2 scenarios added.
