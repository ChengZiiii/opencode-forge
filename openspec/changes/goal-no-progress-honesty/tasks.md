# goal-no-progress-honesty — Tasks

- [x] 1. Activity scoring: exec-class tools (`forge_shell`/`shell`/`bash`)
  increment the checks counter in BOTH wiring faces (v1
  `tool.execute.after` + the v2 seam mirror) — verify: unit tests (an
  exec-only continuation turn scores activity, resets the streak, and
  continues; a pure-read turn still feeds the streak; the auto-pause
  matrix is unchanged for genuinely idle loops)
  (2026-11-20: both counters updated — v1 hook + v2 execute.after mirror;
  goal-mode.test.mjs "no-progress honesty": forge_shell-only turn →
  ledgered activity=true checks=1 writes=0, loop continues, then the
  no-tool-call path still auto-pauses with no-progress + wrap-up;
  existing no-progress/write-reset test unchanged green)
- [x] 2. Brief discipline line: the continuation brief carries the
  standing verification-or-write line (read-only turns are ledgered as
  no-progress) — verify: unit test asserts the line in the sent brief
  (2026-11-20: goalBriefText gains the "Per-turn discipline" line;
  asserted in the same test against the delivered prompt)
- [x] 3. Full gate: suite green, typecheck green, `openspec validate
  --all` green — verify: commands exit 0
  (2026-11-20: suite 717/717, typecheck 0, validate --all 14/14; README
  goal section carries the verification-honest scoring note)
