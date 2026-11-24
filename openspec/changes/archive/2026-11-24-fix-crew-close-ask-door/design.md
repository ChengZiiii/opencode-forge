# Design: fix-crew-close-ask-door

## D1 — 病根只有一处

`v2RegisterPermissionBelt` 的评估回调：

```ts
if (typeof name === "string" && V2_PERMISSION_DOORS.has(name)) {
  if (evalInput.effect !== "deny") evalInput.effect = "ask"
  return
}
```

逻辑本身是对的，问题只在集合少了 `crew_close`。名字解析链
（`metadata.tool → action`）对 `crew_close` 是通的——探针记到
`name="crew_close"`，说明门一旦进集合就会被命中。

## D2 — 修法（2026-11-24 开工时定稿：派生，不再手抄）

规范 tool-partition 的原话是这六道门「**恰好就是** `gate()` 的非执行权限
键」。同一个文件里其实已经有那份权威清单——`GATE_PERMISSION_KEYS`
（配置钩子给六道门写 `ask` 用的就是它，`forge_shell` 也在里面但从不被
改写）。v2 的门集合是另抄的一份，少一个名字。所以：

1. `V2_PERMISSION_DOORS` **不再手写**，改为从 `GATE_PERMISSION_KEYS`
   派生（去掉 `forge_shell`）。今后任何一道进入 `gate()` 键清单的门自动
   成为 v2 的门。
2. `gate()` 的 `permission` 参数类型收窄为该清单的字面量联合
   （`GatePermissionKey`）：往 `gate()` 里传一个清单外的键，typecheck
   直接报错——清单想漏都漏不了。运行时零变化。
3. 注释改为如实：六道门（含 `crew_close`）；v2 上工具的 ask 就是宿主的
   `ctx.permission.assert`，确认框只有靠这条权限带把 `allow` 改写成
   `ask` 才存在。
4. 「有活跃目标管辖则免确认」不由权限带负责，而由 `crewCloseTool` 自己
   负责（`if (!governingGoalFor(sessionID)) await gate(...)`）：不调用
   `gate` 就没有评估、没有确认框。权限带不需要知道目标状态。

## D3 — 「始终允许」会不会把门永久打开（源码层结论 2026-11-24）

- `gate()` 发出的请求是 `{permission, patterns: ["*"], always: [],
  metadata: {title}}`。
- v2 适配器 `v2ToolContext` 转给宿主 `ctx.permission.assert` 的只有
  `sessionID / agent / action / resources / metadata` 五个字段——`always`
  被丢弃，**插件从不请求「始终允许」规则**。
- 确认框上有没有「始终允许」按钮、点了之后宿主存不存规则，是宿主的行为。
  即便宿主存了一条 allow 规则，权限带对**每一次**评估都把 `allow` 改写成
  `ask`（单测「doors forced to a REAL ask」逐门钉死），规则打不开门。
- 这一条在沙箱里实测（tasks 3.5）：代答一次 `always` 之后，再关一个
  crew 必须仍然弹确认。

## D7 — v1 那条权限带有同样的洞：本次不改逻辑，如实记账

v1 的 `permission.ask` 钩子（`plugin.ts` 约 7915 行）是同一份五个名字的
清单，旁边注释同样写着「六道门」。区别在于 v1 上 `crew_close` 另有两层
兜着：配置钩子把 `crew_close` 改写成 `ask`（`GATE_PERMISSION_KEYS`，
`tests/search-wiring.test.mjs` 已钉），工具的 `context.ask` 本身就是宿主
的原生确认框。往 v1 清单里补一个名字是**行为改动**，而手头没有 v1 宿主
可以验证（沙箱与真机都是 2.4.0，只走 v2 入口），用户也已明确不再考虑
降级。所以：本次只把 v1 那段注释改成实话，逻辑逐字节不动；是否补齐留给
用户决定（记入状态报告）。

## D4 — 单测（`tests/v2-permission.test.mjs`）

- 六道门逐个（测试里写死六个名字，不从实现里读）：`allow → ask`、
  `ask` 保持、`deny` 保持；`crew_close` 另测 `metadata.tool` 这条名字链。
- 非门工具三个方向原样透传：`crew_begin`、`forge_shell`、`plan_close`
  （已不是门）、`goal_check`、`goal_pause`、`plan_tick`、一个无关名字。
- 派生关系：v2 门集合 ≡ `gate()` 键清单去掉 `forge_shell`，且恰为那六个
  名字。
- 工具这一侧：无目标管辖时 `crew_close` 两条路径各恰好调用一次
  `assert`（action `crew_close`、标题 `Abandon crew: …` / `Close crew: …`）；
  拒绝时 crew 仍在；报告不合格时在门之前就被拒、零 `assert`；有目标管辖
  时零 `assert`。
- 变异检查：把 `crew_close` 从门集合里拿掉，上述用例必须失败；还原后
  文件哈希一致。

## D5 — E2E（沙箱，宿主 2.4.0）

- `probe-crew-close-door.mjs`（已在第三轮之前写好）：放弃、交报告两条
  路径都必须**先出现确认请求**（驱动像用户一样代答 `once`）**再执行**；
  记录里才出现 `abandoned` / `closed` 段。
- 规范例外：有活跃目标管辖的会话里两条路径都零确认（沙箱里用
  `goal_write` 建并武装一个目标，其自身的确认同样由驱动代答）。
- 完整 crew E2E：`closeGateAskedAndApproved` 转绿，判定文件不再携带
  已知缺陷；验收门的 KNOWN 类目随之消失。
- 「始终允许」不开门（D3 的实况腿）：代答一次 `always` 后，再关一个
  crew 仍然弹确认。
- 有头 TUI：确认框真实可见、可答复（用户侧看到的形态）。

## D6 — 用户可见的变化

v2 宿主上，在没有目标的会话里关闭 crew（两种方式）会多出一个权限
确认框，标题为 `Close crew: <目标>` 或 `Abandon crew: <目标>`。目标模式
下的 crew 关闭不变。
