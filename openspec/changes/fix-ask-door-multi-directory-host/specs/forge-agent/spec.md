## MODIFIED Requirements

### Requirement: Every user-confirmation door raises its dialog under v2

On a v2 host the permission belt SHALL rewrite the evaluate outcome of every user-confirmation door — `plan_approve`, `goal_write`, `goal_complete`, `goal_resume`, `goal_discard` and `crew_close` — to `ask` unless the outcome is `deny`, so that the gate each of these tools opens is a real pending dialog that the user's answer settles. The belt SHALL leave the outcome of a tool that is not a door (for example `crew_begin`) exactly as the host produced it. A door the tool itself does not open produces no evaluation and no dialog: both `crew_close` paths stay ask-free while a live active goal governs the session, as the crew-harness spec requires.

On a host that has initialized the plugin in more than one directory, a door opened in a session SHALL raise its dialog for that session whether or not the session's directory is the most recently initialized one: the plugin SHALL route the ask through the host interface captured by the plugin initialization of the session's own directory — the initialization that registered the tool being called — never through an interface captured for another directory or by the latest initialization, and SHALL keep no module-level interface that a door could fall back to. A pending dialog raised this way SHALL be visible to the session's terminal client and answerable from it — the request SHALL sit in the pending table that the session's own routes read — and SHALL settle only on the user's answer. When the interface captured for the most recently initialized directory is no longer usable because that directory left the host, doors and `forge_shell` in the other directories SHALL keep working; a door that cannot raise its dialog SHALL fail closed with a clear error and SHALL never execute without the user's answer. The plugin SHALL NOT retry a failed ask on another directory's interface: a refusal and a closed directory are indistinguishable, and the user's refusal is final.

#### Scenario: crew_close asks in a session no goal governs

- **WHEN** `crew_close` (either close path) is evaluated with outcome `allow` on a v2 host, in a session that no live active goal governs
- **THEN** the evaluate outcome is `ask`, and the close does not execute until the user answers the dialog

#### Scenario: crew_close stays ask-free under a governing goal

- **WHEN** a live active goal governs the session and `crew_close` is called on either path
- **THEN** no dialog is raised and the close executes, exactly as before

#### Scenario: A tool that is not a door is untouched

- **WHEN** `crew_begin` is evaluated on a v2 host
- **THEN** the belt leaves the outcome as the host produced it

#### Scenario: An explicit deny is kept

- **WHEN** a door is evaluated with outcome `deny`
- **THEN** the belt leaves it `deny` and the tool is refused without a dialog

#### Scenario: A door in a session whose directory is not the last initialized one

- **WHEN** the host initialized the plugin in directory A and afterwards in directory B, and a door is opened in a session bound to A
- **THEN** the request sits in A's pending table, where that session's terminal client both sees and answers it, the terminal's answer reaches the request, and the door executes only after that answer

#### Scenario: The most recently initialized directory leaves the host

- **WHEN** directory B, initialized after A, is evicted from the host, and afterwards a door is opened in a session bound to A
- **THEN** the dialog is raised and the door settles on the user's answer, and `forge_shell` in A keeps working

#### Scenario: The evicted directory comes back

- **WHEN** directory B is evicted and later booted again, so it is once more the most recently initialized one, and a door is opened in a session bound to A
- **THEN** the dialog is raised for that session and never lands in B

#### Scenario: The host gave an initialization no permission interface

- **WHEN** the plugin's initialization for a directory captured no permission interface from the host, and a door or `forge_shell` is called in a session of that directory
- **THEN** the call is refused with an error that says it was refused fail-closed, and nothing is executed
