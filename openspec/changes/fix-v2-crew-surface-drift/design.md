# fix-v2-crew-surface-drift — design

## Live evidence (2026-11-20, opencode 2.3.2)

- **Fresh-restart reproduction (2026-11-21, stronger than the original):**
  after a FULL host restart (in-memory maps emptied; forge_shell spawn
  capability restored, confirming the restart took effect), `crew_begin`
  on the same moved session STILL refuses with the worktree named as
  `C:\Users\Soren` (home) — while the session record's
  `location.directory` says plugindev and the native dispatch belt
  accepts the pool. This rules out the stale-in-memory-map hypothesis:
  the tool-context anchor is STRUCTURALLY sourced from the launch
  directory, not from the session record. Anchor unification (D1) is
  the only fix.
- Session `ses_e0ad…` created at `C:\Users\Soren` (PASEO launch), moved
  via `session_move` to the plugindev workspace. `/api/session/:id`
  shows `location.directory` = the workspace; three `crew_begin`
  attempts still refused with the home path named in the gate output —
  the tool context reports the ORIGINAL directory and nothing refreshes
  it mid-session.
- The native-path dispatch belt (which uses
  `resolveSessionAnchorForPools` → authoritative record) accepted
  `forge-plugindev-e2e-verifier` and two `forge-plugindev-coder`
  dispatches from that same session, same minute. Two chains, two
  verdicts — the authoritative one is right.
- `tools.task` (the plugin's task tool) failed with
  `client.session.create is not a function` — the seam exists in the
  code but the client object it receives on 2.3.2 has no
  `session.create`. The error leaked as a raw TypeError, not an honest
  degradation.

## Decisions

- **D1 anchor unification:** `crew_begin`'s roster gate, its
  session-anchor binding (`ensureSession`) and the crew record path use
  `resolveSessionAnchorForPools` (authoritative record first, existing
  pooled-map preference + ledger rebind semantics unchanged). The
  anchorClient seam used by `v2RegisterToolHooks` is hoisted into shared
  module state (seeded where the belt gets it today) so the crew tool
  can consume it with the same `?.`/typeof guards. With no client
  available, resolution is EXACTLY today's behavior (tool-context →
  launch dir) — a pure strict improvement, no new failure mode.
- **D2 task client seam:** probe the 2.3.2 client surface first (what
  the SDK/plugin context actually exposes for session creation —
  renamed method, different receiver, or nothing); adapt the call with
  guarded shape checks. If NO create seam exists on the host, the tool
  returns an honest error naming the native task tool as the dispatch
  surface (contract-tested string) — never a raw TypeError. The
  `query.directory` handed to creation comes from the authoritative
  anchor so re-anchored parents produce correctly-anchored children.
- **D3 acceptance shape (user directive):** fresh-install per-project
  pattern — the E2E workspace has a `.opencode/forge.json` pool and
  there is NO global forge.json on the machine under test. The full crew
  loop must pass in that shape; the re-anchored-session case (finding 1)
  is a second required scenario.

## Non-goals

- No global fallback layer is added or required anywhere.
- Sole-ownership semantics untouched (workspace pool IS the roster).
- v1 server() paths unchanged beyond consuming the shared anchor helper.
- Native task dispatch path untouched (it already works).
