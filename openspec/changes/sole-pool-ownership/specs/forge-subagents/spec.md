# forge-subagents Delta — sole-pool-ownership

## REMOVED Requirements

### Requirement: Hierarchical pool materialization on shared hosts

- **Reason**: 共享宿主的 append-only 锚点并集 + 子树 BFS 子池扫描造成两个实际事故：跨项目串派（SorenUnityLabs 的 crew 派发到 plugindev/root 池工人）与嵌套 forge.json 误收；host-home 根池成为误植通道（2026-09-29 误写事故）。池的生效范围应跟随会话的工作区，而不是宿主见过的所有目录。
- **Migration**: 工作区自有的 `.opencode/forge.json` 行为不变（仍是会话的池）；子树子池扫描与锚点并集语义废除——需要多池的角色放进全局层或各自工作区；已被删除的宿主 home 根池无需迁移（其工人本就不该在那里）；`pool` 字段保留为命名空间标签。

## ADDED Requirements

### Requirement: Workspace pool ownership and global fallback

A session's dispatchable pool set SHALL be exactly: the session's WORKSPACE pool — the nearest `.opencode/forge.json` discovered by walking up from the session's effective worktree — plus the global layer (`~/.config/opencode/forge.json`) as a FALLBACK ONLY: when the workspace has a pool file, the global layer is NOT consulted for that session's dispatch roster (the workspace pool is the whole roster — fallback, not merge); when the workspace has none, the global layer serves as the whole roster. `forge.json` files nested DEEPER in the workspace's subtree (any directory below the owning one) SHALL be ignored entirely — the same workspace-ownership strictness as the host's native MCP config; a git checkout or subfolder carrying its own forge.json does not split or extend the pool. On a host where multiple workspaces' pools have been materialized (host-wide vocabulary keeps them registered, non-primary namespaces `forge-<ns>-<id>` preventing id collisions — the `pool` field preferred as the stable namespace), the plugin's task-dispatch guard SHALL scope dispatch SESSION-LOCALLY: a task call targeting an agent whose pool belongs to ANOTHER workspace SHALL be refused with a finding that names the target's origin pool path, states it is not dispatchable from this session, and names the exits (open the session in that workspace, or configure the role into this workspace's pool or the global layer). The primary workspace pool materializes as plain ids; the host-wide materialization set is the union of the global layer and every workspace pool the host has seen (hot-applied per the existing mtime contract; there is no append-only anchor set — a pool file deleted from disk disappears from materialization). Sessions whose workspace cannot be observed (unknown anchor) keep the existing fail-open belt posture with a disclosure.

#### Scenario: The workspace pool is the whole roster

- **WHEN** a session's worktree is `F:\unity_project\sorenunitylabs` (which carries `.opencode/forge.json`) and `~/.config/opencode/forge.json` also exists with different agents
- **THEN** the session's dispatchable roster is exactly the workspace pool's agents — the global layer is not merged in, and its agents are not dispatchable from this session

#### Scenario: A poolless workspace falls back to the global layer

- **WHEN** a session's worktree has no `.opencode/forge.json` anywhere up its chain and the global layer exists
- **THEN** the global layer serves as the session's whole dispatch roster

#### Scenario: Nested forge.json files are ignored

- **WHEN** a workspace owns `.opencode/forge.json` at its root and a nested folder (e.g. a cloned repo with its own `.opencode/forge.json`) sits deeper in the subtree
- **THEN** the nested file contributes nothing — no agents, no families — on this host's materialization and no session in the outer workspace can dispatch from it

#### Scenario: Cross-workspace dispatch is refused with exits

- **WHEN** a session in workspace A dispatches a task targeting `forge-<nsB>-coder`, whose pool origin is workspace B's forge.json
- **THEN** the dispatch is refused; the finding names workspace B's forge.json path, states it is not dispatchable from this session, and lists the exits (open a session in workspace B, or configure the role into this workspace's pool / the global layer)

#### Scenario: Same-id agents across workspaces stay collision-free

- **WHEN** two workspaces' pools both define a `coder` agent and both are materialized on one host
- **THEN** the primary workspace's materializes as `forge-coder` (or namespaced by its `pool` field) and the other's as `forge-<nsB>-coder` — no silent overwrite; the session-local dispatch guard is the authority on which one a given session may call

#### Scenario: Pool deletion un-materializes

- **WHEN** a workspace's forge.json is deleted from disk and the next config hook runs
- **THEN** its agents disappear from the host's materialization set (no append-only residue) and sessions in that workspace fall back to the global layer if one exists

#### Scenario: Unknown session anchor keeps the fail-open belt

- **WHEN** a task-dispatching session's workspace cannot be observed
- **THEN** the existing fail-open belt posture applies, with a disclosure that the session's pool ownership could not be established
