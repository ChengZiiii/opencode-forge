## ADDED Requirements

### Requirement: Confirmation gates resolve fail-closed on watchdog timeout

The seven confirmation gates (plan_approve, plan_close, goal_write arm,
goal_complete, goal_resume, goal_discard, crew_close) `SHALL` be time-boxed
by the plugin-side watchdog: when no client adjudication arrives within the
configured window (default 300 s, `FORGE_GATE_ASK_WATCHDOG_MS` tunable, 0
disables), the gate `SHALL` resolve as a disclosed rejection — the awaiting
tool call `SHALL` fail with a finding that names the gate, the timeout, the
fail-closed posture (state unchanged), and the retry contract (re-run when
the user can see and answer the dialog; a late click on the stale dialog
cannot approve the refused call). The watchdog `SHALL NOT` auto-approve any
gate under any configuration, and `SHALL` leave a late client reply
harmless (the refused call stays refused). The gates' never-auto-resolve
invariant is otherwise unchanged: with the watchdog disabled (0) or a
client answer inside the window, behavior is byte-identical to the proven
gates.

#### Scenario: wedge — no adjudication ever arrives

- **WHEN** the confirmation dialog is not rendered or is never answered and
  the watchdog window elapses
- **THEN** the gate resolves as a disclosed rejection and the awaiting tool
  call fails with the watchdog finding
- **AND** no state change is applied and nothing is auto-approved

#### Scenario: the client answers inside the window

- **WHEN** the user answers the confirmation dialog before the watchdog
  window elapses
- **THEN** the gate resolves with the user's decision exactly as the proven
  gates always have
- **AND** the watchdog timer is cancelled and never fires

#### Scenario: watchdog disabled

- **WHEN** `FORGE_GATE_ASK_WATCHDOG_MS=0`
- **THEN** the gates wait indefinitely for adjudication (today's posture)

#### Scenario: late client reply after a watchdog rejection

- **WHEN** the client replies to the stale dialog after the watchdog already
  refused the call
- **THEN** the reply does not approve, mutate state, or affect the refused
  call
- **AND** the refusal disclosure already delivered names the retry contract
