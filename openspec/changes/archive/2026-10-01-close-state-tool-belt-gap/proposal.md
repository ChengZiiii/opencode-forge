# Proposal: close-state-tool-belt-gap

## Why

A task-dispatched `forge-*` worker closed an active goal prematurely by calling `goal_complete` itself — twice in production now (an executor, then a read-only-shape verifier). Prompt-level constraints ("never touch goal tools") do not hold: on the owner's host build, which ignores hook-injected agent `tools` maps (E2E-verified in the partition change, R1), the harness STATE tools stay visible and callable to workers, and the only remaining barrier is the user ask dialog — which reads as the orchestrator's legitimate gate and gets allowed. The partition's fallback belt family (tool.execute.before hard refusals) closed two of the three quadrants and missed the third: a forge-family WORKER calling a STATE tool is refused nowhere.

## What Changes

- New partition fallback belt in `tool.execute.before`: a session whose mapped agent is a forge-family member other than exactly `forge` (i.e., any `forge-*` worker) calling any harness STATE tool (`plan_*`, `goal_*`, `crew_begin`/`crew_close`) is refused with an error naming the primary-only partition and the way out (report findings back to the orchestrating session; the primary forge agent calls the gate tool). Unknown sessions fail open, consistent with the existing belt family.
- No change on hosts that honor injected tools maps: STATE tools are already invisible to workers there, so the belt is dead code (same zero-cost property as the existing fallback belts).
- No change to the ask-gate design of `goal_complete`/`plan_approve` et al.: the belt fires BEFORE execution, so a worker's call now never reaches the gate at all.
- Tests: partition-wiring belt coverage for the new quadrant (worker→STATE refused across all three families; primary `forge`→STATE unaffected; worker→exec pair unaffected; unknown fail-open).
- Docs: README partition/fallback section and AGENTS.md architecture row note the completed third quadrant.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `tool-partition`: the "Fallback enforcement on hosts that ignore injected tools maps" requirement gains its missing enumerated refusal — a forge-family worker's call of any harness STATE tool SHALL be refused at the tool layer. The requirement's general clause ("every partition constraint that would be expressed as tool invisibility SHALL instead be enforced as a hard refusal") already implies this; the enumeration and the implementation did not.

## Impact

- `plugin.ts`: `tool.execute.before` partition belt block (add STATE-tool branch + a `FORGE_STATE_TOOL_SET` lookup set); no new tools, no tool-surface change on honoring hosts.
- `tests/partition-wiring.test.mjs`: new belt assertions.
- `openspec/specs/tool-partition/spec.md` (merged at archive time).
- `README.md` (partition + Design stance sections), `AGENTS.md` (plugin.ts architecture row).
- No breaking change: refusing an out-of-contract call that honoring hosts already block is gap-closure, not a semantic shift.
