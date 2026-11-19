# Proposal: crew-goal-conversion-relay

## Why

Live incident (2026-11-19, owner report): after registering a crew and choosing the "convert to a goal contract" execution mode, the model dissolved the crew and self-executed the whole plan in the main session under the goal contract — never re-registering the plan as a born-armed crew. The owner's expected semantics (and the documented mechanism, spec `goal-harness` continuation brief) is that goal mode EXECUTES the crew: the goal loop's continuation turns re-register the plan born-armed and dispatch forge-* waves.

Investigation found the mechanism is intact and unchanged since its introduction (commit `9112745`, release 0.12.0 — `git log -S` over "Crew layer: you own it" / "born armed" / "conversion record" returns only that commit), but a GUIDANCE GAP makes self-execution the default path:

1. **The conversion output never mentions the crew layer.** `crew_begin {execution: "goal"}` returns "draft the goal contract, folding the declared subtasks into its criteria and verification checks" — zero words about the goal loop being able to re-register the plan as a born-armed crew. The model's first post-arming turn runs on this text alone.
2. **The first post-arming turn never sees the brief's Crew-layer directive.** The "Crew layer: you own it under this goal…" guidance ships only in idle-triggered continuation briefs; a model that starts working in the arming turn (the common case) never reaches it. Its phrasing is also purely discretionary ("when parallel decomposition serves a criterion").
3. **The fold destroys the delegation structure.** Subtask titles and their forge-* agent assignments (e.g. `3. wire the gate → forge-xxx-coder`) are folded into criteria prose, so even a model willing to orchestrate no longer has a structured plan to re-register.

## What Changes

Pure guidance-surface change (no gate, state, or engine semantics move):

1. **Conversion output relays the crew layer** (`crew-harness`): the `crew_begin {execution: "goal"}` output additionally states that the goal loop's continuation turns may re-register the plan as a born-armed crew in ONE call, directs preserving the subtask structure (titles + agent assignments) inside the goal contract's criteria/constraints rather than dissolving them into prose, and provides a ready-to-adapt born-armed registration sketch naming the declared subtasks and agents.
2. **The continuation brief's crew directive becomes structure-aware** (`goal-harness`): when the goal contract's criteria or constraints carry a numbered subtask structure or name `forge-*` agents, the brief directs preferring born-armed crew re-registration over self-executing the whole plan; without that structure the existing discretionary phrasing stands.

## Capabilities

### Modified
- `crew-harness` — the execution-mode gate requirement's conversion clause gains the relay obligations (crew-layer mention, structure preservation directive, born-armed sketch), plus one new scenario.
- `goal-harness` — the idle-continuation requirement's crew-layer directive gains the structure-aware preference rule, plus one new scenario.

## Impact

- `plugin.ts` — the conversion output text (crew_begin execute arm/"goal" branch) and `goalBriefText` (structure detection over criteria+constraints, conditional strengthened directive).
- `tests/` — forge-subagents-wiring conversion assertions extended; goal-mode brief assertions added (structured → prefer-directive present, unstructured → baseline only).
- No changes to crew state, gates, engines, or the goal loop's mechanics.
