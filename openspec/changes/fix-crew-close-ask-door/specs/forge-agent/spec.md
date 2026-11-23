## ADDED Requirements

### Requirement: Every user-confirmation door raises its dialog under v2

On a v2 host the permission belt SHALL rewrite the evaluate outcome of every user-confirmation door — `plan_approve`, `goal_write`, `goal_complete`, `goal_resume`, `goal_discard` and `crew_close` — to `ask` unless the outcome is `deny`, so that the gate each of these tools opens is a real pending dialog that the user's answer settles. The belt SHALL leave the outcome of a tool that is not a door (for example `crew_begin`) exactly as the host produced it. A door the tool itself does not open produces no evaluation and no dialog: both `crew_close` paths stay ask-free while a live active goal governs the session, as the crew-harness spec requires.

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
