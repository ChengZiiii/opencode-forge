# forge-subagents Delta — anchor-pool-preference

## MODIFIED Requirements

### Requirement: Workspace pool ownership and global fallback

WORKSPACE pool — the nearest `.opencode/forge.json` discovered by walking up from the session's effective worktree — plus the global layer (`~/.config/opencode/forge.json`) as a FALLBACK ONLY: when the workspace has a pool file, the global layer is NOT consulted for that session's dispatch roster (the workspace pool is the whole roster — fallback, not merge); when the workspace has none, the global layer serves as the whole roster. `forge.json` files nested DEEPER in the workspace's subtree (any directory below the owning one) SHALL be ignored entirely — the same workspace-ownership strictness as the host's native MCP config; a git checkout or subfolder carrying its own forge.json does not split or extend the pool. On a host where multiple workspaces' pools have been materialized, the plugin's task-dispatch guard SHALL scope dispatch SESSION-LOCALLY: a task call targeting an agent whose pool belongs to ANOTHER workspace SHALL be refused with a finding that names the target's origin pool path, states it is not dispatchable from this session, and names the exits (open a session in that workspace, or configure the role into this workspace's pool or the global layer). For that guard the session's workspace anchor SHALL be resolved from the host's AUTHORITATIVE session record (`client.session.get`, `effectiveWorktree(worktree, directory)`) whenever the record can be fetched — the plugin's in-memory session map serves as the anchor source ONLY when that fetch fails or is unavailable (no client, API error, or missing record); this ordering exists because the in-memory map has degenerate writers (resumed-after-restart sessions never re-fire `session.created`; some tool-context shapes degenerate to the host launch directory), and a session bound to a pool-less anchor by such a writer would otherwise lose its OWN pool's dispatch rights. The MIRROR degeneration is resolved symmetrically: when the authoritative record yields a valid but POOL-LESS anchor (a resumed-after-restart session re-bound to a new launch directory) while the in-memory binding — kept fresh by the session's own live activity — is a DIFFERENT non-degenerate worktree that OWNS a pool file, the POOLED in-memory binding SHALL win that resolution, with ONE bounded disclosure per session recording the substitution; in every other shape the authoritative record keeps its precedence. In that in-memory map, a degenerate anchor (empty or filesystem-root) SHALL never overwrite an existing non-degenerate binding; non-degenerate refinement (session.created seed corrected by a later tool-context binding) keeps today's overwrite semantics. The crew compliance gate resolves its session anchor through the same authoritative-first chain (pooled preference included). EVERY family materializes namespaced: each workspace pool under its declared `pool` namespace (failing that, the sanitized pool-directory basename), and the global fallback layer under the fixed namespace `global` (`forge-global-<id>`) — NO family receives plain ids, so a materialized id is identical on every host regardless of the order workspaces were initialized in. Pool resolution order SHALL be deterministic — families ordered lexicographically by absolute pool-file path — and a cross-family materialized-id collision SHALL resolve in that order: the earlier pool's agent wins, the colliding later agent is skipped with an error finding naming both files. The host-wide materialization set is the union of the global layer and every workspace pool the host has seen (hot-applied per the existing mtime contract; there is no append-only anchor set — a pool file deleted from disk disappears from materialization). Sessions whose workspace cannot be observed (unknown anchor — no in-memory binding AND no authoritative record) keep the existing fail-open belt posture with a disclosure.

#### Scenario: The workspace pool is the whole roster

- **WHEN** a session's worktree is `F:\unity_project\sorenunitylabs` (which carries `.opencode/forge.json`) and `~/.config/opencode/forge.json` also exists with different agents
- **THEN** the session's dispatchable roster is exactly the workspace pool's agents — the global layer is not merged in, and its agents are not dispatchable from this session

#### Scenario: A poolless workspace falls back to the global layer

- **WHEN** a session's worktree has no `.opencode/forge.json` anywhere up its chain and the global layer exists
- **THEN** the global layer serves as the session's whole dispatch roster, its agents materializing namespaced under the fixed `global` namespace (`forge-global-<id>`)

#### Scenario: Nested forge.json files are ignored

- **WHEN** a workspace owns `.opencode/forge.json` at its root and a nested folder (e.g. a cloned repo with its own `.opencode/forge.json`) sits deeper in the subtree
- **THEN** the nested file contributes nothing — no agents, no families — on this host's materialization and no session in the outer workspace can dispatch from it

#### Scenario: Cross-workspace dispatch is refused with exits

- **WHEN** a session in workspace A dispatches a task targeting `forge-<nsB>-coder`, whose pool origin is workspace B's forge.json
- **THEN** the dispatch is refused; the finding names workspace B's forge.json path, states it is not dispatchable from this session, and lists the exits (open a session in workspace B, or configure the role into this workspace's pool / the global layer)

#### Scenario: Own-pool dispatch survives a degraded in-memory binding

- **WHEN** a session was resumed after a host restart (no `session.created` re-fire) and its in-memory binding degraded to a pool-less anchor (host launch directory or empty), while the host's authoritative session record still carries the session's real directory inside a workspace that owns a pool, and the session dispatches its OWN pool's `forge-<ns>-<id>` agent
- **THEN** the guard resolves the anchor from the authoritative record, finds the session's workspace pool, and the dispatch is ALLOWED — the degraded in-memory binding does not strip the session's own-pool dispatch rights

#### Scenario: A pool-less resume-rebound record yields to the pooled in-memory binding

- **WHEN** a session was resumed after a host restart and the authoritative session record carries a POOL-LESS anchor (the new launch directory), while the in-memory binding — refreshed by the session's live activity — holds the session's real pooled worktree, and the session dispatches its OWN pool's `forge-<ns>-<id>` agent
- **THEN** the guard resolves the anchor to the POOLED in-memory binding and ALLOWS the dispatch, with one bounded disclosure recording the substitution; a cross-pool target from the same session is still refused — the preference restores own-pool rights without opening cross-pool leaks

#### Scenario: The authoritative record is unavailable

- **WHEN** the client API call for the session record fails or returns nothing usable and the in-memory map holds a binding
- **THEN** that binding decides the guard exactly as before this change — a cross-pool target is refused with the same copy, an own-pool target is allowed

#### Scenario: A degenerate anchor never clobbers a good binding

- **WHEN** the in-memory map already binds a session to a non-degenerate worktree and a later writer (tool context with a rootish worktree and no directory, or the launch-directory fallback) offers a degenerate anchor
- **THEN** the existing non-degenerate binding is kept — only a non-degenerate anchor may refine (overwrite) the binding

#### Scenario: Same-id agents across workspaces stay collision-free

- **WHEN** two workspaces' pools both define a `coder` agent and both are materialized on one host
- **THEN** each materializes under its own family's namespace — `forge-<nsA>-coder` and `forge-<nsB>-coder` — no silent overwrite and no plain-id privilege for either; the session-local dispatch guard is the authority on which one a given session may call

#### Scenario: Materialized ids are host-history-independent

- **WHEN** the same two workspaces' pools are materialized on two hosts whose initialization orders are opposite (workspace A first on one host, workspace B first on the other)
- **THEN** every materialized agent id is identical across the two hosts — family namespaces never derive from arrival order, so crew plans, rosters, and muscle memory transfer between hosts

#### Scenario: A cross-family materialized-id collision resolves in path order

- **WHEN** two distinct pool files produce the same materialized id (e.g. one defines the id `aa-shader`, the other declares `"pool": "aa"` and defines `shader`)
- **THEN** the deterministic lexicographic file-path order decides: the earlier pool's agent materializes, the later pool's colliding agent is skipped with an error finding naming both files — identically on every host

#### Scenario: Pool deletion un-materializes

- **WHEN** a workspace's forge.json is deleted from disk and the next config hook runs
- **THEN** its agents disappear from the host's materialization set (no append-only residue) and sessions in that workspace fall back to the global layer if one exists

#### Scenario: Unknown session anchor keeps the fail-open belt

- **WHEN** a task-dispatching session's workspace cannot be observed
- **THEN** the existing fail-open belt posture applies, with a disclosure that the session's pool ownership could not be established
