# implement-dispatch-resilience-b-report — Block B（tasks 4.1 / 4.2 / 5.3）

日期：2026-11-21 · change：harden-dispatch-resilience（apply 阶段，A+C 已在 HEAD 774 基线）

## 结论一览

| Task | 状态 | 说明 |
| --- | --- | --- |
| 4.1 QUESTION_DENY no-op 修复 | ✅ 无缺口（已由 crew change 7d7a497 完成，如实核对后零补丁） | 见下「4.1 核对记录」 |
| 4.2 createChildSession taskDeny | ✅ 本 commit 实现 | `opts.taskDeny`（v2 数组拼写）+ 五个 spawn 位接线 + `nestedTaskDenyFor` 调用侧规则 |
| 5.3 测试 | ✅ 全绿 | 784 pass / 0 fail（774 基线 + 10 新增，零回归） |
| 顺带：`dispatchModelIdentity` 死参 childSessionID | ✅ **消费**（未删除） | `nestedTaskDenyFor` 第三参在两个 retry-respawn 位传入前子会话 id——Auto（未钉扎）worker 解析子会话自身捕获的模型而非仅回退 owner 的 |

## 4.1 核对记录（无代码缺口）

- `src/dispatch-async.ts` `QUESTION_DENY_PERMISSIONS_V2 = [{action:"question",resource:"*",effect:"deny"}]`（action 名与现有 QUESTION_DENY 语义一致：action=工具名 question）
- `createChildSession` create body 双拼写并发：v1 `permission` + v2 `permissions`（questionDeny=true 时）
- v2 session-client 转发键列表（`plugin.ts` v2SessionClient adapter，内容定位，原 ~6548 已漂移）已含 `["parentID","title","permission","permissions","directory"]`
- v1 信封路径与新拼写兼容：`createChildSession` 走 `{body,query}` 信封，v1 宿主读 `permission`、2.3.2 读 `permissions`，各取所需、互不干扰
- 以上均为 crew commit 7d7a497 已落内容；本次仅补 payload 断言（见 5.3）

## 文件清单（本次改动）

| 文件 | 改动 |
| --- | --- |
| `src/dispatch-async.ts` | `CreateChildInput.taskDeny?: boolean`；`TASK_DENY_PERMISSIONS_V2`（`{action:"task",resource:"*",effect:"deny"}`）；create body 单一 `permissions` 键合并 question seal 与 task deny（v1 键仅 question） |
| `plugin.ts` | `nestedTaskDenyFor(agentID, ownerSession, childSessionID?)` 纯规则（非 forge 家族 ∧ `dispatchProviderFamily(identity.provider)==="anthropic"`；forge/forge-* 恒 false）；五个 `createChildSession` 位接线：主派发（sync+async 同规则）、queue pump（spawn 时重解析）、async retry respawn、recovery retry-pending respawn、sync retry respawn（后三者消费 childSessionID 死参）；测试缝 `__forgeSubagentsTest.setSessionModel` |
| `tests/dispatch-async.test.mjs` | QUESTION_DENY v2 payload 断言 + taskDeny 三态 payload 矩阵（alone / merged / absent） |
| `tests/dispatch-guard.test.mjs`（新） | 接线级守卫矩阵（真 task 工具驱动） |
| `dist/index.js` | bundle 重建（入库） |
| `openspec/changes/harden-dispatch-resilience/tasks.md` | 勾 4.1/4.2/5.3 |

## 测试名（5.3）

dispatch-async.test.mjs：
- `createChildSession: parentID + native title + parent directory; question-deny is MODE-KEYED (task-shadow)`（扩 v2 permissions 断言）
- `createChildSession taskDeny (harden-dispatch-resilience D2): the v2 task deny rides the permissions array; merged when the question seal is set; absent when unset`

dispatch-guard.test.mjs：
- `guard matrix (D2): non-forge + anthropic → the task deny RIDES the create body (both modes)`（sync=仅 task 条目；async=question+task 合并且 v1 键并存）
- `guard matrix (D2): non-forge + NON-anthropic family → the create body is UNTOUCHED`
- `guard matrix (D2): forge-* targets are untouched by THIS guard (even when the pinned model is anthropic)`

## 验收

- `bun run typecheck` ✅（exit 0）
- `node --test tests/*.test.mjs` ✅ **784 pass / 0 fail**（774 基线零回归，+10 新增）
- `bun run bundle` ✅（dist/index.js 入库提交）

## Commits（conventional，不 push 不 publish）

1. `plugin:` 4.2 wiring（src/dispatch-async.ts + plugin.ts）
2. `tests:` 5.3（两个测试文件）
3. `chore:` rebuild dist
4. `docs:` tick 4.1/4.2/5.3 + 本报告

## 附注

- 工作区另有他人未提交内容（forge-config-json-schema 的 tasks.md、若干 reports/、未跟踪 dist/forge.schema.json——bundle 脚本副产物但归属该 change）——本次提交未触碰。
