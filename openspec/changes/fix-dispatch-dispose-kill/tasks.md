# Tasks: fix-dispatch-dispose-kill

## 1. Specification

- [x] 1.1 四件套就绪（proposal/design/tasks/specs deltas），`npx openspec
      validate fix-dispatch-dispose-kill --strict` 绿

## 2. Implementation（crew wave 1：coder → test-coder → gate-verifier → spec-reviewer）

- [x] 2.1 `isDispatchRow` 谓词 + dispose/出口矩阵/disposeAll 三处 skip
      过滤（host-exit killOne、job-manager disposeAll、dispose 钩子
      trigger 传参）；dispatch 行不被标记 killed、不被删行
      — plugin.ts:1169 谓词；plugin.ts:1045 `skip: isDispatchRow`
      （createExitCleanup，覆盖 dispose+SIGINT/SIGTERM/exit/uncaught 全部
      触发路径）；src/host-exit.ts liveTargets+killOne skip 守卫（行号
      62-88 区）；src/job-manager.ts disposeAll(skip)（行 ~355-366）；
      plugin.ts:6550 dispose 钩子 `disposeAll(isDispatchRow)`
- [x] 2.2 `jobWakeText` killed/aborted 诚实分支（禁止 finished+空 tail
      伪报告）；`onSessionEnd` 对 dispatch 行改 terminal-evidence 自清
      （kill 后行留存至 wake 被读）
      — plugin.ts:1218-1231 killed/aborted 分支（ABORTED+理由，无
      "Final report:"、无 "(no output)"）；abort-unconfirmed 披露
      plugin.ts:1222-1225；src/job-manager.ts onSessionEnd(sessionID,
      keep)（行 ~311-333：keep 行 kill 后留 Map，read-consumption 自清）；
      plugin.ts:6380 harvestSessionEnd 传 isDispatchRow；journal 终态
      reason 附注 plugin.ts:4224-4229、4363-4376
- [x] 2.3 `abortChild` abort-less 显式检测；killTree 调用点全部消灭
      `void` 丢弃（未证实 → journal reason 附注 + wake 披露）；v2
      abort 接线按 design D3 决策树落地（E1 探针结果落档）
      — D3 分支 1+2 同缝接线（E1 实锤探针：host 2.3.2 openapi.json
      142 路径零 abort，官方停止面 = POST /api/session/{id}/interrupt；
      SDK 1.18.32 v2 gen sdk.gen.d.ts:1743 session.interrupt）：
      plugin.ts:7537-7548 V2PluginContext.session.interrupt 声明；
      plugin.ts:8749-8793 v2SessionClient 的 out.abort —— 优先承诺层
      `ctx.session.interrupt({sessionID, resume:false})`，否则
      discoverServiceHttp() HTTP `POST {url}/api/session/{id}/interrupt
      ?resume=false`；`{interrupted:false}`（idle no-op）视为成功等价；
      分支 3：src/dispatch-async.ts abortChild 开头 typeof 检测 →
      `{ok:false, error:"abort unavailable on this session client"}`，
      DispatchClient.abort 改可选；8 个 killTree 调用点全部改走
      dispatchKillTreeHook（plugin.ts:1189；调用点 3125/3347/3379/
      3470/3893/4310/5116/5170），abort 失败进 abortUnconfirmedNotes
      → journal 附注 + wake 披露；stale 头注释修正（v1 prompt_async/
      abort 代际 → 2.3.2 interrupt 现实，dispatch-async.ts:8-27）
- [x] 2.4 测试重议 + 新增全绿（design D4 清单）、typecheck 绿、全量套件
      909+ 绿
      — D4 五处置全落地：job-manager "dispose kills process-backed jobs
      only — dispatch rows SURVIVE"（+ owner-end keep 行留存直至 wake 被读
      + "plugin dispose; tree killed" ledger 类单层钉死）；host-exit
      "dispatch rows are exempt — never killed, never marked, on dispose
      AND signal paths"；dispatch-wiring USER ABORT 不重试 pin 保留 +
      两处挂起修复（owner session.deleted + waitFor tracker 清空显式终
      态 teardown：ses_caparm/ses_a3/ses_c1/ses_c2）；dispatch-journal
      owner-death 补 wake 断言（ABORTED 措辞、无 "(no output)"、journal
      reason 与 wake 同 kill 类）；dispatch-async abort-less client
      （"abort unavailable on this session client" 逐字）。新增：
      dispose 豁免 multi-session fixture（dispatch-wiring "dispose
      exemption: A's dispatch row SURVIVES dispose…B's process job is
      killed"）；abort-unconfirmed journal+wake 双披露（dispatch-wiring
      "kill-path abort-unconfirmed…"）；interrupt 缝 5 例（v2-setup：
      promise 层胜出/{interrupted:false} 成功等价/throw 拒绝/HTTP
      fallback POST ?resume=false + Basic/双腿皆无 → 不可用文案）。
      7 个 C1 关联文件逐个全绿（109+40+8+44 含重跑 job-manager 19/19），
      两个前挂起文件（dispatch-wiring 44/44、dispatch-gate-wiring 8/8）
      均 COMPLETE（13.4s / 1.0s 退出）；`npm run typecheck` 绿。全量套件
      909+ 绿 deferred：并行波次正在改 plugin.ts/plan-file，全量跑会撞
      其在途实现 —— 由后续波次收口（本任务按 C1 文件门收账）

## 3. Sandbox E2E verification（GATE）

- [ ] 3.1 dispose 豁免 E2E：两上下文沙盒宿主，A 派发慢孩子 → 注入
      dispose → wake 块本体 `Final report:` 携带孩子原文；journal 无
      aborted 终态；零脚手架泄漏
- [ ] 3.2 杀路径诚实 E2E：owner 终结 → wake aborted 措辞+理由、无
      "(no output)"；journal 终态与 wake 同 reason

## 4. Release + install verification（GATE）

- [ ] 4.1 并入 0.33.0 合并发版：npm pack --dry-run 白名单核对 →
      publish → dist-tags 翻牌 → shasum 记录入档
- [ ] 4.2 旧物化副本隔离（`1795370347623` → `_quarantine` 改名）
- [ ] 4.3 用户重启后真机终验（Unity 三测金丝雀或探针复跑，判据同 3.1）

## 5. Wrap-up（用户明示后）

- [ ] 5.1 openspec archive + push；探针/驱动脚本归档
      `archive/<日期-主题>/`
