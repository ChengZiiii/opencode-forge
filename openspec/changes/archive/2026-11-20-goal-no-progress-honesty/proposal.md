# goal-no-progress-honesty

## Why

During the 2026-11-19 goal-closure session, the loop auto-paused with a
no-progress stop reason while it was ACTIVELY verifying — the turn spent its
budget re-running verification commands through `forge_shell` (the check that
caught the flaky #13) and reading evidence, and the detector scored the turn
as zero activity. Root cause: qualifying activity is defined as write-class
tools or `goal_check` only — verification commands executed through
`forge_shell` (exactly what the goal contract's own Verification Checks do)
are invisible to the accounting. A detector that files false no-progress
certificates on a working loop is harmful twice: it stops real progress, and
the ledger it writes defames the turn it just mis-scored.

## What Changes

- **Verification commands count as activity**: a `forge_shell`/`shell`/`bash`
  execution during a continuation turn scores as qualifying activity (the
  checks channel), same as `goal_check` — a turn that re-ran the contract's
  checks can never be scored no-progress.
- **The brief states the discipline**: the continuation brief gains a
  standing line directing at least one verification command or write per
  turn (read-only turns are ledgered as no-progress) — the detector and the
  directive now teach the same contract.
- **Ledger wording stays honest**: the Turn Ledger entry records writes,
  checks (now including verification commands), and the activity verdict —
  no schema change, only truthful counting.
- **Pause semantics unchanged**: a genuinely idle loop still auto-pauses
  after the same small streak; only the scoring was wrong, not the stop.

## Impact

- Specs: `goal-harness` (No-progress auto-pause; Mid-flight checks / Turn
  Ledger; plus the new continuation-turn verification discipline)
- Code: the per-turn activity counters in `tool.execute.after` (v1 + the v2
  seam mirror) and the continuation brief text
- Tests: activity-scoring matrix (exec-only turn → active; pure-read turn →
  no-progress path unchanged; brief carries the discipline line)
