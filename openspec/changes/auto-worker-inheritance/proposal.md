# auto-worker-inheritance

## Why

ZCode-style "Auto" subagents — a worker that simply runs on whatever model (and default depth) the parent session runs on — are the most reliable form of model inheritance: no selection happens, so the "configured ≠ usable" failure class that killed the dispatch roster cannot occur (the parent is by definition running on it). Today's spec forbids exactly this: every forge.json agent entry MUST pin `model`, and an entry without one is skipped as invalid. A user who wants "same brain as my primary" must know and re-pin an exact `provider/model` identity, and the pin silently drifts every time they switch primaries.

User ruling (2026-09-28): `model` and `thoughtLevel` become an atomic pair with three states — both absent (Auto/inherit), both present (pinned, current behavior), exactly one present (invalid entry, either direction, including depth-without-model).

## What Changes

- **forge-subagents (MODIFIED ×3)**:
  - Config schema: `model` + `thoughtLevel` SHALL be an atomic pair — both absent → "Auto worker" (materialized WITHOUT a `model` key; the host's native behavior inherits the parent session's model; no depth injection = provider default); both present → pinned (unchanged); exactly one present → entry skipped with an error finding (fail-soft, siblings unaffected).
  - Materialization: the pinned-model clause becomes conditional — Auto entries carry no `model` key and their task-vocabulary description does not claim a pinned brain.
  - Fail-soft: the skip rule changes from "missing model" to "half-configured pair (model-without-thoughtLevel, or thoughtLevel-without-model)".
- **Code**: `src/forge-config.ts` validation + `ForgeAgentDef.model` becomes optional; `src/dispatch-tiers.ts` `forgeAgentDef` writes `model` conditionally, `agentDescriptionFor` branches its wording. Depth-injection path untouched (absent thoughtLevel already injects nothing).
- **README**: three-state configuration table + an upgrade note (breaking: previously-valid model-only entries are now rejected).

## Impact

- Specs: forge-subagents (3 requirements MODIFIED)
- Code: src/forge-config.ts, src/dispatch-tiers.ts
- Tests: forge-config, forge-subagents-wiring, v2-setup
- Docs: README.md
- E2E: auto worker dispatch runs on the parent's model; half-config entry is skipped with a finding
- Breaking: model-only entries that materialized before will now be skipped — declared intentional; README carries the migration note
