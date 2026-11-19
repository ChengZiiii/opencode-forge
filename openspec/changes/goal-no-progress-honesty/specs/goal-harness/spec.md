# goal-no-progress-honesty — Specs

## MODIFIED Requirements

### Requirement: No-progress auto-pause

The engine SHALL track qualifying activity per continuation turn only
(ordinary assistant replies outside the goal loop never count): any
write-class tool execution, `goal_check`, OR a verification command executed
through an exec-class tool (`forge_shell`, `shell`, `bash`) observed for the
owning session during that turn. A turn that re-ran the goal's verification
commands is never scored as no-progress, even when it wrote nothing. After a
small number of consecutive goal-continuation turns with zero qualifying
activity the goal SHALL auto-pause with a no-progress stop reason and a
handoff directive.

#### Scenario: Spinning without effect pauses the loop

- **WHEN** two consecutive goal continuations produce no writes, checks, or
  verification commands
- **THEN** the goal auto-pauses with stop reason `no-progress` instead of burning budget

#### Scenario: A verifying turn is never mis-scored

- **WHEN** a continuation turn runs the goal's verification commands through
  `forge_shell` and reads the evidence but writes nothing
- **THEN** the turn is scored as activity, the streak resets, and the loop continues

### Requirement: Mid-flight checks, Check Log, and Turn Ledger

`goal_check` SHALL execute the goal's verification items (or a selected subset) with the same host execution semantics as the completion gate, appending one dated, revision-stamped entry per run to the Check Log (item, exit code or file-contract result, truncated output). Recorded results are advisory feedback for the model and carry no gating authority. Each continuation turn SHALL append a Turn Ledger entry (turn number, whether any write-class tool, `goal_check`, or verification command ran) so per-turn activity is auditable and batch-completion without real work is visible at the gate.

#### Scenario: Model verifies progress mid-flight

- **WHEN** the model believes the criteria may now hold and calls `goal_check`
- **THEN** the items actually run on the host and a dated, revision-stamped entry appears in the Check Log

#### Scenario: Turn activity is recorded

- **WHEN** a continuation turn ends
- **THEN** the Turn Ledger gains an entry stating whether that turn contained writes, checks, or verification commands

## ADDED Requirements

### Requirement: Continuation turn verification discipline

The continuation brief SHALL carry a standing discipline line directing the
model to land at least one verification command (`forge_shell`) or a real
write per turn, stating that read-only turns are ledgered as no-progress —
the directive the detector enforces is the directive the brief teaches.

#### Scenario: The brief states the per-turn discipline

- **WHEN** a continuation brief is sent
- **THEN** it includes the verification-or-write discipline line
