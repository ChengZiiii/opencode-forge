# Tasks: fix-crew-close-ask-door

## 1. Specification

- [x] 1.1 `openspec validate fix-crew-close-ask-door --strict` 绿
      （2026-11-24T21:13Z：valid）

## 2. Implementation（design D2 / D3 / D4）

- [x] 2.1 `V2_PERMISSION_DOORS` 补 `crew_close`；注释如实
      （做法升级为 design D2 的**派生**：`new Set(GATE_PERMISSION_KEYS.filter(k
      => k !== "forge_shell"))`，不再手抄；`gate()` 的键参数收窄为
      `GatePermissionKey`——往 `gate()` 传清单外的键直接过不了 typecheck。
      v2 门集合注释、v1 权限带注释（约 7915 行）一并改实，v1 逻辑逐字节
      未动（design D7））
- [x] 2.2 单测：六道门逐个（allow→ask、ask 保持、deny 保持）+ 非门工具
      原样透传
      （`tests/v2-permission.test.mjs`：六个名字在测试里写死；另加
      `crew_close` 经 `metadata.tool` 的名字链；非门工具 8 个 × 3 个方向
      （经 action 与经 metadata.tool 各一遍）原样透传；派生关系
      （v2 门 ≡ `gate()` 键去掉 `forge_shell`，恰为六个）；`crew_close`
      工具链路（两条路径各恰一次 `assert`、拒绝后 crew 仍在、报告不合格
      在门之前被拒且零 `assert`、有目标管辖时零 `assert`）。该文件 12/12，
      全量 1013/1013）
- [x] 2.3 核实 design D3（确认框「始终允许」不会永久开门），结论回填
      （源码层结论见 design D3：适配器只转
      `sessionID/agent/action/resources/metadata`，`always` 被丢弃，插件
      从不请求「始终允许」规则；宿主即便存了 allow 规则，权限带对每次
      评估都改写回 `ask`。实况腿列入 3.5）
- [x] 2.4 typecheck + 全量套件全绿 + 变异检查（拿掉 `crew_close` → 2.2
      必须失败；还原后哈希一致）
      （2026-11-24T21:12Z，`mutate-doors.mjs`：基线 12/12 + typecheck 干净。
      M1 运行时把 `crew_close` 滤出门集合 → 3 条门测试失败、typecheck 干净；
      M2 把 `crew_close` 从 `GATE_PERMISSION_KEYS` 删掉 → 同样 3 条失败，
      **且 tsc 在两处 `gate(context.ask, "crew_close", …)` 报 TS2345**
      （类型层防漏闸生效）。两次均逐字节还原（plugin.ts sha256
      `49cebcab7a614347…` 前后一致）。全量 1013/1013。记录
      `view-e2e\logs\mutate-doors-report.json`）

## 3. Verification（GATE）

- [x] 3.1 `probe-crew-close-door`：放弃 / 交报告两条路径都先弹确认、
      代答后才执行
      （`16-crew-close-door-e2e.mjs`，2026-11-24T00:06–00:10Z，7/7：
      `abandonAsksThenExecutes`、`reportAsksThenExecutes`、
      `rejectedAskLeavesCrewActive`、`beginRegistersPendingCrew`；
      判定文件 `reports/e2e/evidence/0.33.1/crew-close-door-e2e-verdict.json`）
- [x] 3.2 有活跃目标管辖时两条路径零确认（规范例外保持）
      （同一驱动：`goalGoverningClosesAskFree`、`governedGoalNotLeftActive`）
- [x] 3.3 完整 crew E2E：`closeGateAskedAndApproved` 通过，判定不再带
      已知缺陷
      （`crew-full-e2e-verdict.json`，00:20–00:24Z，16/16，无已知缺陷；
      验收门 KNOWN = 0）
- [x] 3.4 有头 TUI：确认框真实可见、可答复
      （有头 TUI 门 `reports/e2e/evidence/0.33.1/tui-gate.json` 三项：
      弃用路径——确认框在真实 TUI 里弹出，TUI 内回车允许，记录
      `registered (pending) → abandoned`；交报告路径——TUI 内选
      `Reject`，crew 保持未关闭；再发一次确认框再弹，允许后
      `closed`（PASS 1 / FAIL 0）。askwatch 全程恰 3 条 `crew_close`。
      截图 `…/0.33.1/tui-shots/tui-f{1,2,3}-dialog.png`）
- [x] 3.5 实况核实 D3：代答一次 `always` 之后，再关一个 crew 仍弹确认
      （同一驱动：`alwaysDoesNotReopenTheDoor`）

## 4. Release

- [x] 4.1 并入 0.33.0 之后的下一次发版梯
      （0.33.1：2026-11-24T00:57Z 发布，sha1 `d53d9e7d7d8f7749…`，
      `dist-tags.latest` 生效后 CDN 逐字节一致；验收门 27 过 / 0 败 /
      1 记账 / 0 已知；证据 `reports/e2e/evidence/0.33.1`）

## 5. Wrap-up（用户明示后）

- [ ] 5.1 archive + push
      （archive 已做：2026-11-24T01:06Z，有头 TUI 门通过后；push 待用户授权）
