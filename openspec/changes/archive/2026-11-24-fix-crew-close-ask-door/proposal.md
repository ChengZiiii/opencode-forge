# Proposal: fix-crew-close-ask-door

> **按现行规范的缺陷修复，不改行为。** 规范原文早已要求 `crew_close` 弹
> 确认，是 v2 实现没做到。授权语境：用户过夜目标“不会有任何 bug，持续
> 测试和迭代直到完美运行”。2026-11-23 19:50Z 完整 crew E2E 首次暴露，
> 19:55Z 聚焦复现坐实。

## Why

v2 宿主上，**没有活跃目标管辖**的会话里，`crew_close` 的两条关闭路径
（放弃 / 交报告）不弹确认框就直接执行。

### 规范怎么说

- crew-harness「crew_close completion gate」：`crew_close` 固定为 ask 级
  确认（永不自动放行，用户 allow 配置也不能豁免）；放弃路径与完成路径
  适用完全相同的确认门，仅当活跃目标管辖会话时除外。
- tool-partition「User-confirmation doors are never auto-resolved」：
  `plan_approve` / `goal_write (arm)` / `goal_complete` / `goal_resume` /
  `goal_discard` / `crew_close` 任何模式下都不自动放行。
- forge-agent「v2 forward-compatible registration」：权限带经
  `ctx.permission.hook("evaluate")` 为 plan / goal / crew 的门产出 ask。

### 代码实际怎么做

`crewCloseTool` 在无目标管辖时调用 `gate(context.ask, "crew_close", …)`。
v2 上 `context.ask` 被适配成宿主的 `ctx.permission.assert`——要弹框，
必须由插件的权限带把宿主的评估结果从 `allow` 改写成 `ask`。

而 v2 权限带的门集合（`plugin.ts` 的 `V2_PERMISSION_DOORS`）只有五个名字：
`plan_approve` / `goal_write` / `goal_complete` / `goal_resume` /
`goal_discard`——**没有 `crew_close`**。旁边的注释写的是「crew_close 在
ask 路径上从不自己冒出权限请求（v1 对等原样保留）」：v1 上
`context.ask()` 本身就是确认框，确实不需要；v2 移植（提交 `dfce83d`，
2026-11-19）把门改成宿主权限评估之后，这一条对等没有跟着搬。所以这是
v2 移植起就存在的缺陷，与 0.33.0 的五个 change 无关。

### 实证（沙箱，宿主 2.4.0，构建 `00565a61…`）

- `logs/probe-crew-close-door.json`（19:55Z）：放弃、交报告两条路径都
  执行了（crew 记录出现 `abandoned` / `closed` 段），全程待确认请求为 0。
  插件自带的只读权限探针（`FORGE_PERM_PROBE`）记下了宿主的评估：
  `v2-evaluate name="crew_close" effect=allow … metadata:{"title":"Close crew: …"}`。
- 完整 crew E2E 第 2、3 轮：`closeGateAskedAndApproved` 同样为
  `crew_close asks=[]`。
- 单测 `tests/v2-permission.test.mjs` 的注释写着「six doors」，实际只遍历
  了五个名字——`crew_close` 从未被测试覆盖，所以这个洞一直没被发现。

## What Changes

- v2 权限带的门集合补上 `crew_close`，与另外五道门同一处理（非 `deny`
  一律改写为 `ask`，`deny` 保持 `deny`）。**做法是派生而不是再手写一个
  名字**：门集合直接从 `gate()` 的键清单 `GATE_PERMISSION_KEYS` 派生，
  `gate()` 的键参数收窄为该清单的字面量类型——以后漏不掉（design D2）。
- 注释改为如实描述（v2 门集合、v1 那条权限带的注释一并改实，v1 逻辑
  不动——design D7）；单测把六道门逐个钉死，并钉「非门工具不受影响」。
- 有活跃目标管辖时 `crew_close` 根本不调用门——现有逻辑不变，照旧
  免确认。

## Impact

- `plugin.ts`：`V2_PERMISSION_DOORS` 改为派生、`gate()` 的键参数类型收窄、
  两处注释、一个只给单测用的导出面；运行时逻辑只多一件事——`crew_close`
  的评估结果被改写为 `ask`。
- `tests/v2-permission.test.mjs`。
- 行为：v2 宿主、无目标管辖的会话里，`crew_close` 从「不问就关」变成
  「弹确认框」；其余路径不变，v1 的逻辑不受影响。
- 版本：并入 0.33.0 之后的下一次发版（第二批第一项——它最小、最重要）。
