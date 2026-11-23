# Tasks: fix-crew-close-ask-door

## 1. Specification

- [ ] 1.1 `openspec validate fix-crew-close-ask-door --strict` 绿

## 2. Implementation（design D2 / D3 / D4）

- [ ] 2.1 `V2_PERMISSION_DOORS` 补 `crew_close`；注释如实
- [ ] 2.2 单测：六道门逐个（allow→ask、ask 保持、deny 保持）+ 非门工具
      原样透传
- [ ] 2.3 核实 design D3（确认框「始终允许」不会永久开门），结论回填
- [ ] 2.4 typecheck + 全量套件全绿 + 变异检查（拿掉 `crew_close` → 2.2
      必须失败；还原后哈希一致）

## 3. Verification（GATE）

- [ ] 3.1 `probe-crew-close-door`：放弃 / 交报告两条路径都先弹确认、
      代答后才执行
- [ ] 3.2 有活跃目标管辖时两条路径零确认（规范例外保持）
- [ ] 3.3 完整 crew E2E：`closeGateAskedAndApproved` 通过，判定不再带
      已知缺陷
- [ ] 3.4 有头 TUI：确认框真实可见、可答复

## 4. Release

- [ ] 4.1 并入 0.33.0 之后的下一次发版梯

## 5. Wrap-up（用户明示后）

- [ ] 5.1 archive + push
