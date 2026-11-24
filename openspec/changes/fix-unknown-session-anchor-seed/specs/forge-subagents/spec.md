## MODIFIED Requirements

### Requirement: Session directory resolved per session on multi-location hosts

On a host that loads several locations in one process, the plugin SHALL resolve every session's working directory from that session's OWN record — never from which location happened to initialize last. A child session created by a dispatch SHALL be bound to its owner's resolved directory at creation, before its first tool call. A session without an in-memory binding (a fresh child, a session resumed after a host restart) SHALL be resolved through the host's session record — the session's own directory, else its parent's — before any fallback. A fallback to a plugin-level default directory SHALL be disclosed in the tool result. Everything keyed on the session's directory (shell cwd, relative `workdir` joins, plan / goal / crew records, the dispatch journal, the pool gate) SHALL land in the resolved directory.

The same resolution SHALL hold wherever the plugin applies a rule that depends on a session's directory — inside tool bodies and in the checks that run before a tool call (the draft write ban, the dispatch gates, the state-file boundary) alike. No check SHALL bind a session to the directory that was initialized last. A check SHALL apply such a rule to a session that has no in-memory binding only on the strength of the host's session record — the session's own directory, else its parent's — resolved the way a tool body resolves it; a check that cannot read the record SHALL apply the rule to no directory at all and leave the decision to a check that can. Before a write-class tool of such a session executes, the draft write ban SHALL have been decided against the workspace the host's session record names, so that a draft in another location never refuses the call and a draft in the session's own workspace still does. When the record yields no directory, or cannot be read, the session SHALL stay unbound and every such check SHALL let the call through without consulting any record that depends on a directory: the plugin SHALL NOT guess a directory, and SHALL NOT put its default directory in place of the session's for a check. A binding written on behalf of a check SHALL be the directory the host's session record yielded. This holds whatever makes the session known first — a write-class call, a dispatch the plugin checks, or a call that ends refused — and for a child the host created on its own (no plugin binding at creation) as much as for a child the plugin created.

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

#### Scenario: A session's first call after a host restart is a write-class call

- **WHEN** a session that existed before a host restart makes its first tool call after the restart, that call is a write-class one, the host's session record carries workspace A for the session, and the host initialized location B after A
- **THEN** the session is bound to workspace A — never to B — and a following `forge_shell` call without `workdir` runs under A without any default-directory notice

#### Scenario: A fresh session's first call is a write-class call

- **WHEN** a session that acquired no binding when the host created it makes a write-class call as its first tool call, the host's session record carries workspace A for the session, and the host's last-initialized location is workspace B
- **THEN** the session is bound to workspace A, never to B, and a following `forge_shell` call without `workdir` runs under A

#### Scenario: A child the host created on its own is bound from its record on its first write-class call

- **WHEN** a child session created by the host's own subagent tool — no plugin binding at creation — makes a write-class call as its first tool call, the host's session record carries workspace A for the child, and the host's last-initialized location is workspace B
- **THEN** the child is bound to workspace A, never to B, and a following `forge_shell` call without `workdir` runs under A

#### Scenario: A refused dispatch leaves the caller bound to its own directory only

- **WHEN** a session with no in-memory binding dispatches through the plugin's `task` tool, the host's session record carries workspace A for the session, the host's last-initialized location is workspace B, and the dispatch is refused before any child is created
- **THEN** the refusal stands, and every binding written for the session during that call names workspace A — never B

#### Scenario: A draft in another location does not refuse the session's write

- **WHEN** workspace B holds an active draft, workspace A holds none, and a session with no in-memory binding whose host record carries workspace A calls a write-class tool on a host whose last-initialized location is workspace B
- **THEN** the call is not refused on account of the draft in workspace B

#### Scenario: A draft in the session's own workspace is still honored

- **WHEN** workspace A holds an active draft, and a session with no in-memory binding whose host record carries workspace A calls a write-class tool on a host whose last-initialized location is workspace B
- **THEN** the call is denied exactly as it is for a session that was bound to workspace A all along, with the message naming `plan_approve` or discard

#### Scenario: No record and several locations: the session stays unbound and the call passes

- **WHEN** a session with no in-memory binding makes a write-class call, the host initialized more than one location, and the host's session record yields no directory for the session or any ancestor (or cannot be read)
- **THEN** no binding is written for the session, the call is not refused by any check that depends on a directory, and a later forge tool call resolves through the default-directory fallback and discloses it

#### Scenario: The state-file boundary resolves a relative path against the session's own directory

- **WHEN** a non-forge agent's session with no in-memory binding calls `write` or `edit` with a relative path, the host's session record carries workspace A for the session, and the host's last-initialized location is workspace B
- **THEN** the check resolves the path under workspace A: a path that lands in A's `.opencode/plan/` or `.opencode/goal/` is refused, and one that lands elsewhere under A is not refused by this check

#### Scenario: The state-file boundary has no base for a session it cannot place

- **WHEN** a non-forge agent's session with no in-memory binding calls `write` or `edit` with a relative path on a host that initialized more than one location, and the host's session record yields no directory for the session
- **THEN** the path is not resolved against any other directory, and the call is not refused by this check
