# Tasks: plan-close-verified

## 1. Specification

- [x] 1.1 四件套就绪，`npx openspec validate plan-close-verified
      --strict` 绿；E2 外部调研结论复核折入（无反例，设计 A 全部获
      先例印证——见 design D0）

## 2. Implementation（crew wave 2：coder → test-coder → gate-verifier → spec-reviewer）

- [x] 2.1 plan-file：checks 节解析/渲染（parse/render，纯
      string→string）+ Check Log 节渲染 + done→approved 迁移 +
      reopened 节（src/plan-file.ts:67 PlanCheck、:94 done:["approved"]、
      :122-124 节别名、:174-232 renderPlan+renderPlanCheck、
      :259-273 parseChecksSection、:373 PlanDoc.checks、:497
      appendReopenSection、:513 appendPlanCheckLog）
- [x] 2.2 plan_close verified：冻结集 runChecks fail-closed（失败 run
      入 Check Log + throw）+ 证据摘要终节 + 原子写 + reason 新串；
      legacy 自检路径保持（plugin.ts:2094-2177 planCloseTool：
      :2121-2133 冻结集 runChecks→appendPlanCheckLog+throw（状态留
      approved）；:2135-2148 证据摘要 outcomes+OUTPUT_LIMIT+atomicWrite；
      :2141/:2167 reason "completion gate passed (plugin-verified)"；
      :2150-2174 legacy closeCheckFailures 路径原样，仅去门+原子写）
- [x] 2.3 ask 门四层拆除（gate 调用已随 2.2 重写删除（旧 ~2090 行
      `await gate(context.ask,"plan_close",...)` 不复存在）；
      GATE_PERMISSION_KEYS :1897-1905 去 plan_close；v1 belt :7376 去
      plan_close；V2_PERMISSION_DOORS :8044 去 plan_close）+ 文案同步
      （/plan 模板 step5 :188、plan_tick 输出 :1790、plan_approve 输出
      :2089、plan_close 描述 :2095-2096、plan-notice v1 :7566/v2 :8409、
      agent 描述 :6696/:9279、README :14-15/:53-63/:1100-1105、
      AGENTS.md:7-9、docs/architecture.md:48-54）
- [x] 2.4 plan_reopen 工具（迁移见 2.1 + appendReopenSection :497 +
      会话重绑 state.planPath :2226 + 纪律层描述 :2181；注册
      FORGE_STATE_TOOLS :107 + forgeTools() :6008——v2 经同一工厂注册）
- [x] 2.5 测试重议+新增全绿（design D6）、typecheck 绿；五个受影响文件
      单独全绿（goal-mode 50/50、plan-file 22/22、v2-permission 8/8、
      search-wiring 15/15、headless-gate 15/15，tsc --noEmit exit 0）——
      全量套件绿递延至并行波（C3/C4 落地后统一跑）

## 3. Verification（GATE）

- [ ] 3.1 无头 E2E（沙盒宿主）：失败 check 拒关（状态留 approved +
      Check Log 落盘）→ 修复 → close 过（证据节落盘、零 ask 事件
      断言）→ reopen 回滚 → 再关
- [ ] 3.2 有头 TUI 验证（computer use）：plan_close 无确认框、close
      完成、磁盘证据可读、reopen 可用——原楔死场景不复现

## 4. Release（与 C3/C4 协调 0.33.0）

- [ ] 4.1 合并发版：pack 白名单核对 → publish → dist-tags → shasum
      入档 → 旧物化副本隔离

## 5. Wrap-up（用户明示后）

- [ ] 5.1 archive + push；有头测试记录归档
