# search-tools Delta

## ADDED Requirements

### Requirement: Explicit path anchors pattern and output

When a call's `path` argument resolves to a DIRECTORY, the serving engine (whichever leg of the chain) SHALL match slash-bearing glob patterns and `include` filters against paths relative to that directory, and SHALL report result paths relative to that same directory — the two legs of the engine chain SHALL return identical path sets for identical explicit-path anchored queries. A `path` resolving to a FILE and the default (no-`path`) worktree root SHALL keep their existing shapes unchanged. The follow-dedupe pass's realpath resolution SHALL key to the call's effective root (the explicit directory when given, else the worktree); outside-workspace disclosure SHALL continue to compare resolved targets against the worktree.

#### Scenario: An anchored glob with an explicit directory path finds one-level files

- **WHEN** `forge_glob` is called with pattern `*/tasks.md` and a `path` pointing at a directory containing `<change>/tasks.md` one level down
- **THEN** the change's `tasks.md` is listed as `<change>/tasks.md` (or with the platform separator) — relative to the given directory — on BOTH the ripgrep leg and the bundled JS engine leg

#### Scenario: Cross-engine agreement on the same explicit-path query

- **WHEN** the same anchored pattern and explicit directory path are served first by ripgrep (resolvable) and then by the bundled JS engine (ripgrep unresolvable)
- **THEN** the two results' path sets are identical, differing only by the engine-disclosure footnote

#### Scenario: The default root and file roots are unchanged

- **WHEN** no `path` is given, or `path` resolves to a single file
- **THEN** output pathing matches the pre-change behavior (worktree-relative for the default root; the given file root for a file)
