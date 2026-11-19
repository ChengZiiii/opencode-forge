# Proposal: pool-rebind-on-resume

## Why

The session-domain pool gate (spec `forge-subagents` — *Workspace pool ownership and global fallback*) resolves the dispatching session's anchor through an authoritative-first chain: the host's session record (`client.session.get` → `effectiveWorktree(worktree, directory)`) first, the plugin's in-memory session map second, plus the anchor-pool-preference rule for the mirror degeneration (pool-less record + pooled live binding). A live incident (2026-11-16, the `sorenunitylabs` workspace, plugin 0.25.5) exposed a THIRD degeneration shape the current chain cannot resolve:

- A session resumes after a **host restart**. The in-memory map is empty (the session has made no tool calls yet in the new host life, so no writer has re-bound it).
- The authoritative session record carries the **new launch directory** — a pool-less anchor (the cross-launch-resume artifact already documented in the spec's mirror-degeneration clause).
- The session dispatches a task targeting one of its OWN workspace's `forge-<ns>-<id>` workers.
- Both live sources fail to yield a pooled anchor → the resolution falls through to the global-fallback roster → the dispatch is **refused** with the "not dispatchable from this session" finding — the session is locked out of its own pool for its entire resumed life (until a live tool call happens to bind a pooled worktree, which the launch-directory degeneration may never produce).

The existing preference rule cannot help: it requires the in-memory binding to be a *different pooled* worktree, and after a restart the map is empty. The anchor-pool-preference bounded disclosure in the code explicitly describes this class of failure ("restart-resume rebind shape") but only covers the shape where the live binding survives.

Impact: real, pre-existing (not introduced by 0.25.5), medium-low severity — the affected dispatch degrades to a host-agent fallback (non-blocking), but the gate also breaks its own spec promise that a session keeps its OWN pool's dispatch rights, and every restart-resumed pooled session hits the lockout on its first forge dispatch.

## What Changes

Add a **persisted session-anchor ledger** as the third anchor source — the missing re-bind path for the both-degenerate shape:

1. **Ledger store**: a plugin-namespaced JSONL file (`<os-tmp>/opencode-forge/session-anchors.jsonl`), mapping `{ sessionID, worktree, ts }` entries. Written ONLY when a session binds to a worktree that OWNS a pool file (positive evidence of a real pooled binding); deduplicated per session (later binding replaces), FIFO-capped so the file stays bounded; every read/write failure is fail-soft — resolution degrades to today's behavior and dispatch is never blocked by ledger IO.
2. **Resolution order** (in `resolveSessionAnchorForPools`): the existing chain keeps its shape — pooled in-memory binding wins (the 0.20.0 preference rule), then the authoritative record; NEW: when neither yields a pooled anchor, consult the ledger; a ledger hit whose worktree still owns a pool file on disk (verified at resolution time — the pool-file-deleted semantics are preserved) re-binds the session (seeding the in-memory map) and allows own-pool dispatch, with one bounded disclosure per session.
3. **Isolation preserved**: a ledger hit can only restore OWN-pool rights for the exact sessionID it was recorded under — cross-pool targets remain refused; the fail-open posture for genuinely unknown anchors is untouched; the crew compliance gate inherits the fix automatically (it resolves through the same chain).

## Capabilities

### Modified
- `forge-subagents` — the *Workspace pool ownership and global fallback* requirement gains the persisted-ledger re-bind source, its resolution position, the disk-truth verification, the bounded disclosure, and the fail-soft IO contract, plus one new scenario for the both-degenerate shape.

## Impact

- `plugin.ts` — `resolveSessionAnchorForPools` (consult + re-seed + disclosure), the session bind/seed paths (ledger append), module state (ledger path seam for tests).
- `tests/` — hierarchical-pools / pool-gate suite gains the restart-resume ledger cases (re-bind allowed, cross-pool still refused, pool file deleted → today's gate, unknown anchor unchanged, ledger IO failure fail-soft, cap rotation).
- No spec-external behavior changes: hot-apply, materialization, namespacing, and the fallback semantics are untouched.
