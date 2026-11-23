# Tasks: command-surface-v2-cleanup

## 1. Specification

- [x] 1.1 四件套就绪，`npx openspec validate command-surface-v2-cleanup
      --strict` 绿；E2 外部调研（命令面实践）复核折入（无反例——见
      design D0）

## 2. Implementation（crew wave 3a：coder → test-coder → gate-verifier → spec-reviewer）

- [x] 2.1 四条 hyphen 命令删除（v1+v2+模板常量）+ `/forge` 路由表
      stop 路由 + help 四形态 + no-clobber 存续
      （v1 `cfg.command["forge"] ??=` 仅存 /forge plugin.ts:6715；v2
      addTemplateCommand 同 plugin.ts:8525；四个 FORGE_*_LEVER_TEMPLATE
      常量已删；STOP_LEVER_BODY :298 入路由表 :313，help 四形态 :289）
- [x] 2.2 forge_jobs `stop` 动作（工具层 context.sessionID 作用域、
      串行 cancelDispatch）+ `all` 分支与 cancelAllDispatches 删除 +
      per-id 逃生舱保留
      （stop 分支 plugin.ts:2745-2765，jobId 校验之前；cancel 动作
      per-id 化、`all` 显式拒绝 :2767-2783；cancelAllDispatches 已删，
      全库 grep 零引用）
- [x] 2.3 用户可见文案（中断披露/孤儿披露/工具描述/README）
      （中断披露 :3718；孤儿披露 :4134/:4138；forge_jobs 描述 :2727 起；
      README 命令段 :634-659 + Cancellation 段 :1029-1054）
- [x] 2.4 测试重议+新增全绿（design D4）、typecheck 绿、全量套件绿
      （command-surface 12/12：四名缺席 v1+v2 + no-clobber 存续 + v2 精确集
      crew/forge/goal/plan；forge-commands 10/10：help 四形态含 stop；
      v2-session-commands 15/15：精确键集 + /forge stop 路由投递；
      dispatch-cancel 16/16：双会话夹具 stop(A) 只杀 A、no-op 诚实报告、
      per-id 跨会话逃生舱 + "all" 显式拒绝、reason 正则 /forge stop；
      typecheck 绿。全量套件 deferred：crew-continue-native-child-gate
      并行波次占用 plugin.ts/src，按波次约束单文件门通过即记账）

- [x] 2.5 沙箱返工 R3 / R3b（design D7；全部在本 change 契约内，无行为
      改动）
      — R3 取消后的"确认子会话空闲"在活 2.4.0 上每次都说"读不到状态"：
      旧的空闲确认只认 v1 客户端的 `session.status`，v2 承诺层适配器没有
      → `activeSessionView` 改走宿主 HTTP 的 active-session 视图（与 crew
      原生子会话门同一通道），回执三态：确认空闲 / 抗拒 / 读不出。R3b
      每次读以断言窗口的剩余时间为上限——HTTP 读挂起不再拖住 cancel 与
      串行的 `/forge stop`。`/forge stop` 回执点名未被取消的排队 wish
      （**不改行为**：排队 wish 仍留着、随槽位释放派生；"stop 是否连带
      清空队列"另立 change 待批）。回归测试：`idle assertion ④…`、
      `queue pump ②…`（`tests/dispatch-wiring.test.mjs`；变异检查：拆掉
      读上限 → 恰好 ④ 失败，已还原）。全量 1009/1009，typecheck 绿

## 3. Verification（GATE）

- [x] 3.1 沙箱 E2E 双会话作用域：A×2 + B×1 → A 会话 stop → A 终结
      （wake 诚实 aborted）、B 完整跑完 wake 携带原文；`/api/command`
      无 hyphen 命令
      （      **最终（门控）构建复验**（2026-11-23T18:26:27 到 18:31:16Z，宿主
      2.4.0 pid 30104，dist 18:20:35Z；驱动 **16/16**，判定文件
      command-stop-e2e-verdict.json）：`GET /api/command` 共 7 条、有
      `forge`、无任何 `forge-*`、已退役命令不在；`/forge stop` 被接受
      并投递（模板带 `Argument: "stop"`）；A 的 3 个孩子在飞时 stop →
      `Stopped 2 in-flight dispatch(es) of this session`，两条唤醒都是
      ABORTED 且诚实、孩子很快空闲、零重发；B 的孩子未被触碰、完整
      跑完、唤醒带原话、零 aborted
      （旧构建证据，留档：2026-11-23T17:08:44–17:13:27Z，宿主 2.4.0，最终构建 dist
      16:55:16Z；驱动 12-command-stop-e2e.mjs **16/16**：
      `GET /api/command` 有 `forge`、无任何 `forge-*`；
      `POST /api/session/A/command {name:"forge",text:"stop"}` → 204，
      宿主投递的模板带 `Argument: "stop"`；模型经代码调用
      `tools.forge_jobs({action:"stop"})`，输出
      `[forge:job] Stopped 2 in-flight dispatch(es) of this session …
      is confirmed idle (the cancellation is REAL, not bookkeeping)`；
      A 的两条派发 journal 终态 `aborted`、理由
      `cancelled by the user lever (/forge stop) — the child was aborted
      and the dispatch is never retried`；A 的两条唤醒都是
      `— ABORTED (task …)` 且理由与 journal 逐字一致、无 "Final report:"、
      无脚手架；终态后零重发；B 的行保持 `dispatched→started→terminal
      (completed)`，唤醒带 `Final report: CANARY-B-…`、零 aborted 块；
      子会话很快空闲。观察项：`cancel "all"` 如实被拒并指向 `stop`。
      旧构建探路（16:27Z）倒在 `aAbortedWithLeverReason`——同一处
      杀路径竞态，已修（见 reports/e2e-convergence-2026-11-23.md）。
      第一次最终构建跑（16:56Z）owner 回合 4 分钟未返回、无任何工具
      调用，属前提未达成，新鲜会话重跑即上述结果）
- [ ] 3.2 有头 TUI 顺带验证（与 C2 有头窗口同跑）：命令列表、
      `/forge stop` 可用

## 4. Release（0.33.0 合并）

- [ ] 4.1 并入合并发版梯（pack 白名单 → publish → dist-tags →
      shasum → 旧副本隔离）

## 5. Wrap-up（用户明示后）

- [ ] 5.1 archive + push
