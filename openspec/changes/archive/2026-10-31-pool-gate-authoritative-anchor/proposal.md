## Proposal — Pool gate resolves session anchors from the authoritative host session record

### Why

0.18.0 live deployment evidence (user-reported, reproduced in the maintainer's own session):
a session whose workspace HAS a pool gets its own-pool `forge-<ns>-<id>` dispatch REFUSED
with the roster cited as *the global fallback*. Host-side session records are correct
(`directory="F:\UNITY_Project\SorenUnityLabs"`), and sibling sessions on the same host
dispatch fine — only sessions whose in-memory binding degraded are refused.

Root cause: the task-dispatch pool gate (and the crew compliance gate sharing its anchor)
reads ONLY the plugin's in-memory `sessions` map. That map has known degenerate writers:

1. **Resumed sessions after a host restart** never re-fire `session.created` (documented
   trap, plugin.ts:1969) — the binding comes from whatever wrote first.
2. **Degenerate tool contexts** (non-git workspace → `worktree: "/"` global-project; some
   context shapes carry no `directory`) resolve to the host LAUNCH directory via
   `sessionAnchor`'s fallback chain — a pool-less directory.
3. **`ensureSession` clobbers unconditionally** (plugin.ts:763): any degenerate writer can
   overwrite a good binding afterwards.

Meanwhile the goal continuation engine already seeds lazily from the AUTHORITATIVE host
API `client.session.get()` (plugin.ts:2098) — which returns the correct
`{ directory, worktree }`. Two legs, two truth sources; the belt trusted the wrong one.

A secondary gap: the deep E2E had no positive own-pool dispatch assertion — every live
probe asserted refusals only, so this class survived the release gate.

### What Changes

- **Authoritative-anchor belt**: for `task` dispatches to `forge-*` targets, the pool gate
  (and the crew compliance gate) resolves the session's anchor from
  `client.session.get({ path: { id } })` FIRST (effectiveWorktree(worktree, directory));
  the in-memory binding serves only as fallback when the API call fails or is unavailable.
  Unknown-everything keeps the fail-open belt posture with disclosure (unchanged).
- **No-degenerate-clobber**: `ensureSession` must not overwrite an existing non-degenerate
  binding with a degenerate anchor (empty or rootish); non-degenerate refinement keeps
  today's overwrite semantics (session.created seed → tool-context refinement).
- **Deep E2E hardening**: the deep script gains a positive assertion (g): dispatching the
  session's OWN pool agent through the live belt must SUCCEED, not just refusals firing.

### Impact

- Affected specs: `forge-subagents` (session-anchor resolution requirement).
- Affected code: `plugin.ts` (belt anchor resolution, `ensureSession`), deep E2E script.
- Compatibility: refusal copy unchanged; success path unchanged for correctly-bound
  sessions; strictly FEWER false refusals. No config surface changes.
