## ADDED Requirements

### Requirement: Session directory resolved per session on multi-location hosts

On a host that loads several locations in one process, the plugin SHALL resolve every session's working directory from that session's OWN record — never from which location happened to initialize last. A child session created by a dispatch SHALL be bound to its owner's resolved directory at creation, before its first tool call. A session without an in-memory binding (a fresh child, a session resumed after a host restart) SHALL be resolved through the host's session record — the session's own directory, else its parent's — before any fallback. A fallback to a plugin-level default directory SHALL be disclosed in the tool result. Everything keyed on the session's directory (shell cwd, relative `workdir` joins, plan / goal / crew records, the dispatch journal, the pool gate) SHALL land in the resolved directory.

#### Scenario: A fresh worker's first shell command runs in the owner's workspace

- **WHEN** a worker child created by a session anchored to workspace A issues its first `forge_shell` call on a host whose last-initialized location is workspace B
- **THEN** the command's cwd is resolved under workspace A, and the result's `cwd:` line names a directory under workspace A

#### Scenario: A goal created from a session lands in that session's workspace

- **WHEN** a session anchored to workspace A creates a goal on a host whose last-initialized location is workspace B
- **THEN** the contract file is written under workspace A's `.opencode/goal/`

#### Scenario: A session resumed after a host restart is resolved from the host record

- **WHEN** a session with no in-memory binding makes its first forge call after a host restart, and the host's session record carries its directory
- **THEN** the session is bound to the directory in the host record, not to the last-initialized location

#### Scenario: A default-directory fallback is disclosed

- **WHEN** neither an in-memory binding nor the host's session record yields a directory, so the plugin falls back to its default directory
- **THEN** the tool result states that the default directory was used and names it

#### Scenario: A single-location host behaves exactly as before

- **WHEN** the host loads one location
- **THEN** every session resolves to the same directory as before this change
