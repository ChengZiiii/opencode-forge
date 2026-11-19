# Tasks: crew-goal-conversion-relay

## 1. Implementation

- [x] 1.1 Conversion output relay (plugin.ts crew_begin execute arm/"goal" branch): append the crew-layer relay — the goal loop may re-register the plan born-armed in ONE call; preserve subtask titles + agent assignments structurally in the goal contract (criteria or constraints), never dissolved into prose; a ready-to-adapt born-armed registration sketch naming the declared subtasks and agents
- [x] 1.2 Structure-aware brief directive (plugin.ts `goalBriefText`): detect a numbered subtask structure or `forge-*` agent mention over criteria+constraints (`/\bforge-[a-z0-9-]+\b/` or `/^\s*\d+[.).]/m`); when detected, extend the Crew-layer line with the PREFER directive (re-register born-armed over self-executing the whole plan, keep per-subtask evidence for the close report); when not detected, the existing discretionary line stands verbatim

## 2. Tests

- [x] 2.1 forge-subagents-wiring conversion test: the conversion output asserts the relay (born-armed re-registration mention, structure-preservation directive, the sketch naming the declared subtasks); the crew record conversion section unchanged
- [x] 2.2 goal-mode brief test: a goal whose criteria name forge-* agents or carry numbered subtasks → the brief carries the PREFER directive; a goal without that structure → the baseline crew-layer line only (no prefer-directive)

## 3. Validation & release

- [x] 3.1 `bun run typecheck` clean; full suite green
- [x] 3.2 `bunx openspec validate crew-goal-conversion-relay --strict` clean; `validate --all` clean
- [x] 3.3 Version bump 0.25.7 + bundle + release commit + npm publish + push (registry-fetch verification, store flip per pitfalls §4.7)
