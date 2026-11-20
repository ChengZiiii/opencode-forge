# gate-both-repos 波次 — 双仓库全量门禁报告

日期：2026-11-21（会话时间 2026-11-20 晚）。零源码改动；唯一允许改动（dist 产物提交）未触发 —— 两仓库 bundle 后 dist 均无 diff。

## opencode-forge/

| Gate | 结果 | 证据 |
|---|---|---|
| `bun run typecheck` | ✅ exit 0 | `$ tsc --noEmit`，无输出 |
| `node --test tests/*.test.mjs` | ✅ **735 pass / 0 fail** | summary: `tests 735 / pass 735 / fail 0 / skipped 0`，duration 79.8s |
| `bun run bundle` | ✅ exit 0，**dist diff = 0** | `Bundled 97 modules in 42ms → index.js 0.82 MB`；随后的 `git status --porcelain` 无 dist 改动，无需提交 `chore: rebuild dist` |
| `openspec validate --all --json` | ✅ 全部 valid | totals: items 11 / passed 11 / failed 0（change 2/2，spec 9/9；仅 INFO 级 "requirement text >500 chars" 提示） |
| 树卫生 `git status --porcelain` | ✅ 符合预期 | 仅 `?? openspec/changes/fix-v2-crew-surface-drift/`（他人 WIP，未触碰） |
| `git log --oneline -8` | 快照见下 | — |

```
1e0fe6f docs: harden-tests wave report
b0e3d57 tests: harden v2 setup surface — v2WithShellDeny defensive shapes, findLast deny-order nail, hide/suppress coexistence, hideNativeAgents JSONC boundary
abd7803 docs: land probe + review reports, tick verified test tasks
4fa0c1c docs: v2 single-agent surface — README section + v1 config recipe, probe verdicts recorded, implementation report
d26a2c4 tests: v2-setup matrix — suppression, knob, shell deny; permissions-array reality + atomic-pair fixture fixes
670c629 plugin: v2 single-agent surface — native suppression, hideNativeAgents knob, shell-deny front door (permissions array fix)
55b6b13 docs: v2-single-agent-surface zero-persistence contract + snapshot deny evidence
4d540a0 docs: propose v2-single-agent-surface (hide native primaries, forge default, shell-deny front door)
```

## opencode-vision-bridge/

| Gate | 结果 | 证据 |
|---|---|---|
| `bun run typecheck` | ✅ exit 0 | `$ tsc --noEmit`，无输出 |
| `node --test tests/*.test.mjs` | ✅ **111 pass / 0 fail** | summary: `tests 111 / pass 111 / fail 0 / skipped 0`，duration 0.8s |
| `bun run bundle` | ✅ exit 0，**dist diff = 0** | `Bundled 75 modules in 35ms → index.js 0.46 MB`；随后的 `git status --porcelain` 输出为空 |
| `openspec validate --all --json` | ✅ 全部 valid | totals: items 2 / passed 2 / failed 0（change 1/1，spec 1/1；仅 INFO 级长文本提示） |
| 树卫生 `git status --porcelain` | ✅ 完全干净 | 输出为空 |
| `git log --oneline -5` | 快照见下 | — |

```
0edb739 docs: harden-tests wave report
e43c201 tests: harden v2 knob resolution — P2 class-instance record shape, throwing-getter degradation, config-fallback edges (nonexistent dir, '//' in strings, block comment + trailing comma)
9a79bb4 docs: carry VH-2 delta (lazy execute-time knobs + capability-map refresh scenario) and land the delta review report
ccb4c82 docs: record P2 execute-time readability verdict in knob-timing design
66dc8ac docs: record v2 knob capture timing + capability-map limitation in README, apply-phase design/tasks notes, and change report
```

## 结论

- 12/12 门禁全绿；两仓库测试计数均精确命中预期（735/0、111/0）。
- 两仓库 dist 重建后均为零 diff —— 与「源码自上次构建后未动」预期一致，未产生提交。
- 未 push、未修任何文件；唯一落盘改动为本报告文件。
- 过程注记：一次 `&&` 复合命令在旧版 PowerShell 下报 ParserError（InvalidEndOfLine），拆成单条命令重跑后正常，非仓库问题。
