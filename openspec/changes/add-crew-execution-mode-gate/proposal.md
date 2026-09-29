## Why

The three forge harnesses compose into a pipeline in real use — macro contract (plan OR spec), crew decomposition/roster prep, then execution — but the seam between "crew registered" and "execution starts" has no decision point today: `crew_begin`'s success output literally says "Proceed with the discipline: waves of parallel native task calls", so within the same user turn the model barrels straight into mass execution. The user never gets the chance to choose the execution mode (supervised waves now vs. an autonomous goal contract vs. standby). Community consensus (spec-kit phase gates, LangGraph `interrupt_before`, BMAD re-sharding) is that this seam must be a mechanical interrupt, not prompt discipline.

## What Changes

- Crew gains a two-phase lifecycle: `crew_begin` registers the crew as **PENDING** — registration no longer means execution start.
- While PENDING, the `task` tool is refused by the existing `tool.execute.before` belt (the same family as the plan-draft write ban); the refusal message presents the three execution-mode choices.
- Mode transitions via a follow-up `crew_begin {execution}` arm call: `waves` (lifts the belt, classic wave discipline), `goal` (ends the crew as a conversion record — the immediately following `goal_write(arm=true)` ask dialog is the user gate), or standby (no call; crew stays pending).
- `crew_close` gains an ask-gated `abandon` path with no verdict requirements — the re-shard exit for wrong decompositions, usable mid-execution and inside goal loops.
- `/crew` command template and `crew_begin` success output rewritten: roster confirmed → present three choices → STOP (end turn).
- **Goal-delegated self-orchestration**: under a live active goal, crews register armed in one call (`execution: "waves"` at registration), crew close/abandon gates go internal (no ask), and the goal continuation brief directs the agent to own the crew layer — unattended overnight loops can decompose, dispatch, and re-shard autonomously. Refused outside a governing goal.
- **Slash-free operation stays guaranteed**: both harnesses are reachable purely conversationally — the ask dialogs are the authorization surfaces; the slash templates are rulebooks, not capability gates.

## Red Line (design constraint)

**Crew and goal are decoupled from plan.** The macro contract above crew may come from an approved plan, an OpenSpec change, or inline `/crew` arguments — the crew discipline is identical in all three cases and never requires a plan artifact. The existing "active plan draft refuses /crew" interlock stays, documented as mutual-exclusion safety interop (same family as the draft write ban), NOT a pipeline ordering dependency. Nothing in this change adds a plan→crew or plan→goal flow dependency, and the spec (OpenSpec) workflow coexists untouched.

## Non-Goals

- No changes to plan-harness — the plan decoupling red line holds absolutely.
- Goal-harness touches exactly ONE requirement (the continuation brief's directive list) to carry the goal↔crew composition interface; goal semantics, budgets, gates, and file layout are untouched. The composition is optional in both directions: goal runs fine crew-less, crew runs fine goal-less.
- No new tools: `crew_begin` becomes dual-purpose (register / arm), `crew_close` gains the abandon flag.
- No cross-session crew persistence: crews remain in-memory and session-bound (the D7 record file is history, never resume).
