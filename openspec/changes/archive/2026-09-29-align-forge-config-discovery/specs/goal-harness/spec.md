## MODIFIED Requirements

### Requirement: Goal file persistence layout

Goal files SHALL be created under the workspace's `.opencode/goal/` directory, named `YYYY-MM-DD-<slug>.md` with the slug derived from the goal statement (kebab-case, length-truncated); same-day slug collisions SHALL get a numeric suffix. The frontmatter SHALL contain at least `status` (queued / active / paused / completed / abandoned), `created`, `updated`, `revision` (starting at 1), `session` (owning session ID, empty while queued), budget fields (`max_turns`, `turns_used`, `max_minutes`), and `stop_reason` (set whenever paused). All goal-file mutations SHALL be atomic (write to a temp file, then rename over the target) so a crash mid-write never leaves a half-written goal. Worktree resolution SHALL use the session-observable anchor chain: the session's non-degenerate worktree first, then the session's own directory (as carried by the tool context / session record — a degenerate or global-project worktree never shadows it), then the host launch directory as the final fallback. Terminal and queued goal files SHALL remain under `.opencode/goal/` (uninstalling the plugin SHALL NOT delete them).

#### Scenario: A compliant goal file is generated

- **WHEN** `goal_write` successfully persists an armed goal with the statement "make the test suite green"
- **THEN** a file like `2026-09-25-make-test-suite-green.md` appears under `.opencode/goal/`, with frontmatter containing `status: active`, `revision: 1`, the owning session ID, and budget fields

#### Scenario: Crash mid-write leaves the previous state intact

- **WHEN** the plugin is killed while updating a goal file
- **THEN** the file on disk is either the old complete version or the new complete version, never a partial hybrid

#### Scenario: A degenerate worktree does not shadow the session directory

- **WHEN** a session's reported worktree is degenerate (global-project "/") while the session's own directory is observable (tool context or session record) and differs from the host launch directory
- **THEN** goal (and plan) files anchor under the session's directory, not the host launch directory
