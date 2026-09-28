# Tasks — auto-worker-inheritance

## 1. Validation core

- [x] 1.1 `src/forge-config.ts`: `ForgeAgentDef.model` becomes optional (`model?: string`); `validateAgentSet` implements normalize-then-pair-check — both absent → Auto (accepted, no finding); both present as non-empty strings → pinned; exactly one present after type normalization (wrong-type or non-string counting as absent), in either direction → skip entry + error finding naming the id and the missing half. Verify: forge-config tests — three states, the ④ inverse (thoughtLevel without model), mistyped `thoughtLevel: 3` with pinned model skips the entry, empty-string model skips, siblings unaffected in every rejection case.

## 2. Materialization

- [x] 2.1 `src/dispatch-tiers.ts`: `forgeAgentDef` writes the `model` key only for pinned entries; `agentDescriptionFor` branches — pinned entries name the pinned brain (current wording), Auto entries state they inherit the parent session's model. Verify: dispatch-prompt/forge-subagents-wiring tests assert both description shapes and `!("model" in entry)` for Auto.

## 3. Wiring

- [x] 3.1 `tests/forge-subagents-wiring.test.mjs` + `tests/v2-setup.test.mjs`: materialization coverage for the Auto shape (no model key, subagent mode, task-listed, task: deny, description wording) on both loaders; pinned-path regression unchanged; hot-apply test extended — flipping an entry between Auto and pinned re-materializes accordingly. Verify: full suite green.

## 4. Docs

- [x] 4.1 README: three-state configuration table (Auto / pinned / rejected half-config) with examples; upgrade note declaring the breaking change (model-only entries now skipped, error finding names the missing half); Auto worker described as "inherits the parent session's model at dispatch (snapshot); provider-default depth". Verify: read-through matches implementation; no stale "model required" claims remain.

## 5. Verification

- [x] 5.1 Full regression: `bun run typecheck` + `node --test tests/*.test.mjs` all green; `openspec validate --all` clean.
- [x] 5.2 E2E (real environment): forge.json with an Auto worker → `task` dispatch → child session header model == parent model; forge.json with a half-configured entry → startup finding names id + missing half, that agent absent from the task vocabulary. Evidence appended to verify/e2e.md.
