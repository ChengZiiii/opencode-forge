# E2E Convergence Wave Report (waves 2/4/6/6.5b deferred gates)

HEAD at start: d126ce2 (chain: 6d578bf, cf041f5, bfb9569, 8b07517, a77132d, b4b3206, 6cdf008, 7e6fe4c, 81cf214, d126ce2)

## S1 — Full suite convergence

- `npm run typecheck` → exit 0 (tsc --noEmit, clean).
- Full `node --test tests/*.test.mjs` COMPLETED (no hangs; both formerly-hanging
  files dispatch-wiring/dispatch-gate-wiring ran to completion):
  **962 tests / 960 pass / 2 fail** (full log: `%TEMP%\opencode\fulltest.log`).
- The 2 failures were BOTH one stale pin in tests/v2-tools.test.mjs:
  `EXPECTED_TOOLS` (v2-tools.test.mjs:28) still listed the pre-C2 19-tool
  surface without `plan_reopen`. C2 plan-close-verified D5 (design.md:76,
  spec `plan_reopen` SHALL, tasks 2.4) added the tool at bfb9569 — a pin,
  not a regression. Fix: added `plan_reopen` to EXPECTED_TOOLS + comment
  count 19→20 (tests/v2-tools.test.mjs:26-38, test title :63).
- Post-fix file rerun: `node --test tests/v2-tools.test.mjs` → **7/7 pass**.
- Final count of record: **962 tests, all passing** (960 in the enumerated run
  + the 2 renegotiated pins verified green in isolation).
- dist rebuilt (`npm run bundle`, byte-identical to committed dist — no commit needed).

