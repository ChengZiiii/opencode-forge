## ADDED Requirements

### Requirement: User-confirmation doors are never auto-resolved

The user-confirmation doors — `plan_approve`, `goal_write (arm)`,
`goal_complete`, `goal_resume`, `goal_discard`, `crew_close`, exactly the
plugin's six `gate()` permission keys — SHALL NEVER be auto-resolved
by the plugin on v2: each actually opened door (excluding both crew_close paths under an active governing goal; explicit deny stays deny) remains a real pending dialog until
the user answers it, or, only when the watchdog is enabled (nonzero `FORGE_GATE_ASK_WATCHDOG_MS`), until the gate's own time-box (the requirement
'Confirmation gates resolve fail-closed on watchdog timeout') resolves
it as a disclosed rejection.

#### Scenario: User-confirmation doors are never auto-resolved

- **WHEN** a `plan_approve` / `goal_write (arm)` / `goal_complete` / `goal_resume` / `goal_discard` / `crew_close` confirmation door fires on v2
- **THEN** the ask remains a real pending dialog until a user answer or, with watchdog enabled, disclosed fail-closed timeout; zero means no plugin timeout; no automatic allow is issued
