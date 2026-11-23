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

## D2 — 修法

1. `V2_PERMISSION_DOORS` 增加 `"crew_close"`。
2. 注释改为：六道门（含 `crew_close`）；v1 上 `context.ask()` 自带确认框
   所以不经过权限带，v2 上确认要靠这里把 `allow` 改写成 `ask`。
3. 「有活跃目标管辖则免确认」不由权限带负责，而由 `crewCloseTool` 自己
   负责（`if (!governingGoalFor(sessionID)) await gate(...)`）：不调用
   `gate` 就没有评估、没有确认框。权限带不需要知道目标状态。

## D3 — 「始终允许」会不会把门永久打开（实现时核实的结论）

规范：用户 allow 配置不能豁免。权限带对每次评估都把 `allow` 改写成
`ask`，所以配置里的 `crew_close: allow` 不生效。需要核实的是确认框上的
「始终允许」：v2 的 ask 适配器往 `assert` 里传了什么 `always` / `patterns`。
如果适配器对门传的是空数组，宿主就没有可写入的规则，门不会被永久打开。
结论记在 tasks 2.3；若不为空，则先改适配器（同一 change 内），因为那
会是同一不变量的另一个缺口。

## D4 — 单测

- 六道门逐个：`allow → ask`、`ask` 保持、`deny` 保持。
- 非门工具（`crew_begin`、`forge_shell`、一个无关名字）原样透传。
- 变异检查：把 `crew_close` 从集合里拿掉，上述用例必须失败。

## D5 — E2E（沙箱，宿主 2.4.0）

- `probe-crew-close-door.mjs`（已在第三轮之前写好）：放弃、交报告两条
  路径都必须**先出现确认请求**（驱动像用户一样代答 `once`）**再执行**；
  记录里才出现 `abandoned` / `closed` 段。
- 规范例外：有活跃目标管辖的会话里两条路径都零确认（沙箱里用
  `goal_write` 建并武装一个目标，其自身的确认同样由驱动代答）。
- 完整 crew E2E：`closeGateAskedAndApproved` 转绿，判定文件不再携带
  已知缺陷；验收门的 KNOWN 类目随之消失。
- 有头 TUI：确认框真实可见、可答复（用户侧看到的形态）。

## D6 — 用户可见的变化

v2 宿主上，在没有目标的会话里关闭 crew（两种方式）会多出一个权限
确认框，标题为 `Close crew: <目标>` 或 `Abandon crew: <目标>`。目标模式
下的 crew 关闭不变。
