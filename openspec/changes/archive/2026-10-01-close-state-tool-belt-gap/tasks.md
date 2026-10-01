## 1. Belt implementation

- [x] 1.1 `plugin.ts`: add `FORGE_STATE_TOOL_SET` lookup set next to `FORGE_TOOL_SET`, and the worker→STATE refusal branch inside the `tool.execute.before` partition fallback block (speaker is forge-family but not exactly `forge`, tool in STATE set → throw with the D4 wording: primary-only partition + report back to the orchestrating session). Verify: `bun run typecheck` passes.
- [x] 1.2 Confirm branch ordering interacts correctly with the existing belts: non-forge belt keeps its own message for non-forge speakers; shell/bash belt untouched; draft write-ban still fires first for write-class tools. Verify: read-through of the final belt block + existing partition-wiring belt tests stay green.

## 2. Belt tests

- [x] 2.1 `tests/partition-wiring.test.mjs`: worker quadrant — a session mapped to a `forge-*` agent calling each STATE family representative (`goal_complete`, `plan_close`, `crew_begin`) throws with the partition wording. Verify: new assertions pass under `node --test tests/partition-wiring.test.mjs`.
- [x] 2.2 `tests/partition-wiring.test.mjs`: non-interference — primary `forge` session calling `goal_complete` passes the belt; worker calling `forge_shell` passes; unknown-session (no mapping) calling `goal_complete` fails open. Verify: assertions pass, no existing test red.

## 3. Regression + build

- [x] 3.1 Full suite green: `node --test tests/*.test.mjs` (282-test baseline, zero regressions). Verify: suite exit 0 with total count reported. — actual: 327/327 pass, exit 0 (baseline had grown past 282; zero fail).
- [x] 3.2 Rebuild dist: `bun run bundle`; self-contained bundle contains the new belt. Verify: `Select-String -Path dist/index.js -Pattern "harness state tool reserved"` hits. — hits at dist/index.js:17603; constant at :15827.

## 4. Docs

- [x] 4.1 README partition/fallback section: the fallback enumeration now lists the third refusal (worker → STATE tools, fired before any gate). Verify: README section names all three quadrants.
- [x] 4.2 AGENTS.md `plugin.ts` architecture row: belt enumeration updated. Verify: row mentions the worker→STATE refusal.

## 5. Closeout

- [x] 5.1 `openspec validate close-state-tool-belt-gap` passes and `openspec status --change close-state-tool-belt-gap --json` reports all tasks ticked. Verify: fresh command output. — validate "valid" + status isComplete:true, all four artifacts done, 2026-10-01.
