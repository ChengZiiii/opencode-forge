# harden-tests wave — opencode-forge

Scope: tests/ only (tests/v2-setup.test.mjs). Zero implementation changes. Commit `b0e3d57` (`tests:`). Not pushed.

## New tests (7)

1. `v2 setup: weird pre-set permissions shapes normalize to [shell deny] (defensive merge)` — user-preset `permissions` of `null` / non-array string / number / plain object all collapse to the valid v2 array `[{action:"shell",resource:"*",effect:"deny"}]`, other record fields survive.
2. `v2 setup: junk entries in a pre-set permissions array are filtered; real entries survive verbatim` — `[null, 42, "x", undefined, {nope}, {edit deny}]` → junk dropped, object entries kept in order, deny appended.
3. `v2 setup: the appended shell deny is the LAST array slot (findLast — deny wins over anything merged in front)` — semantic nail: where the plugin appends, the deny is `permissions[len-1]`, so any last-match-wins host merge (e.g. global config allow merged in front, per P3 CONFIRMED) resolves to the deny.
4. `v2 setup: a record already carrying a shell entry keeps it verbatim (idempotent append, no duplicate)` — pins CURRENT semantics (`v2WithShellDeny` skips append when any shell entry exists, plugin.ts:6605-6609). Note: P3's "deny 总赢" applies to the host-side global-permission-layer merge (out of unit reach); at the record level the current semantic is idempotent-keep, pinned as-is.
5. `v2 setup: readonly worker — the shell deny rides LAST after the seal family (findLast nail)` — seal entries + task:deny first, deny closes the array.
6. `v2 setup: native suppression and the shell-deny front door coexist in the same transform` — combined assertion: build/plan hidden + forge registered + deny + default setter, one v2Setup run.
7. `v2 setup: hideNativeAgents JSONC boundary — comments/trailing commas honor the knob; bad shapes keep the default` — line+block comments and trailing commas still honor `false`; top-level array / string `"false"` / `0` / absent knob all fail-soft back to hide-on.

## Implementation-side findings

None requiring code changes. One semantic observation recorded above (item 4): a user-preset `shell` entry on the forge record suppresses the plugin deny (idempotent append). This matches design D4 wording ("幂等 append 不覆盖既有 shell 条目") and needs no change.

## Final counts

- `node --test tests/*.test.mjs` → **735 pass / 0 fail** (was 728; +7)
- `bun run typecheck` → exit 0
- `node --test tests/v2-setup.test.mjs` → 26 pass / 0 fail
