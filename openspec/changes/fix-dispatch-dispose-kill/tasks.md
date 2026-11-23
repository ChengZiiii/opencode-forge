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

- [x] 2.5 规约复核返工 R5–R9（design D7；逐条源码核实，全部在本
      change 契约内，无行为改动）
      — R5 理由同源：击杀钩子在击杀那一刻把一句话盖在行上
      （`meta.abortReason`），journal 终态与唤醒都只读这一句；三种来源
      各一句常量（owner 终结 / 取消杆 / 显式 kill）。R6 `settleKilled`
      结案后泵该会话的派发队列（本 change 的 R1 引入的回归：五个裸
      `return` 跳过了循环后的统一收尾）。R7 重试重生窗口击杀
      `settleRespawnKill`（建孩子后 / 发提示词后各复查一次）。R8
      `executionErrorDetail` 对敌意错误对象全定义（不可序列化或读取
      即抛 → 返回 undefined 交调用方兜底，函数本身不抛）。R9
      `awaitAbortVerdict`：中止调用**挂起不返回**也算未证实；journal
      结算与唤醒投递共用它——谁先写谁后写结论一致（投递侧只在确有
      中止在飞时才等：无条件 `await` 曾让普通后台任务的同步投递晚一
      拍，`job-wiring` 5.1 唤醒引擎用例回归，已修）。
      回归测试新增 8 条（`tests/dispatch-wiring.test.mjs`：`kill
      sentence ①` / `queue pump ②` / `respawn window ③a` `③b` / `idle
      assertion ④` / `abort-unconfirmed ④b` `④c` /
      `executionErrorDetail is TOTAL on hostile shapes`）；
      `tests/dispatch-journal.test.mjs` 的 owner-death 用例改为逐字钉。
      **变异检查**（证明新测试非空转）：拆掉泵队列与读上限 → 恰好
      ②④ 失败；拆掉 `awaitAbortVerdict` → 恰好 ④b ④c 失败（57 条中
      55 过）；两次均已还原，还原后 SHA256 与变异前逐字节一致，仓库
      零残留标记。全量 **1009/1009**（净增 8；24 s 干净退出），typecheck
      绿。顺带加固一条与本次改动无关的测试竞态：`native-child-walker`
      的 "waited-on child DELETED mid-run" 只等到"活跃视图被读过"就断言
      已武装复查，而武装发生在这次 HTTP 往返之后——机器慢时露馅（一轮
      85 s 的负载下全量跑里挂过一次）；`walkedIdleEdge` 增加确定性的
      等待条件，三处调用点传入。产品代码未因此改动。

## 3. Sandbox E2E verification（GATE）

- [ ] 3.1 dispose 豁免 E2E：两上下文沙盒宿主，A 派发慢孩子 → 注入
      dispose → wake 块本体 `Final report:` 携带孩子原文；journal 无
      aborted 终态；零脚手架泄漏
      **记账（D6）**：宿主 2.4.0 上没有已证实的 dispose 触发器。最终构建
      （dist 18:20:35Z）上 D1 于 2026-11-23T18:33:42 到 18:36:56Z 实跑
      （判定文件 dispose-e2e-K1-K2-D1-verdict.json）：驱逐 owner 目录
      （`DELETE /api/debug/location` → 204，目录随即重新启动）后，对照腿
      进程树跑到自然结束、dispose 钩子探针静默（`ranInWindow:false`）→
      `pass:false` + `inconclusive`，对“派发豁免”下不了结论。同构建探针：
      `POST /api/location/reload` 变体 C/D/E（18:46:00 到 18:51:37Z，
      probe-reload-verdict.json）与“驱逐空闲目录”变体 A/B（18:51:37 到
      18:54:29Z，probe-evict-idle-verdict.json）同样探针静默；删会话此前
      已排除。该豁免由单测覆盖（job-manager / host-exit / dispatch-wiring
      的 dispose exemption 用例）。补跑方式：宿主出现能触发插件 dispose
      钩子的动作后 `launch-detached.mjs c1 K1,K2,D1` 重跑，判据不变。
- [x] 3.2 杀路径诚实 E2E：owner 终结 → wake aborted 措辞+理由、无
      "(no output)"；journal 终态与 wake 同 reason
      （      **最终（门控）构建复验**（2026-11-23T18:31:17 到 18:33:00Z，宿主
      2.4.0 pid 30104，dist 18:20:35Z；判定文件
      dispose-e2e-K1-K2-D1-verdict.json，K1、K2 均 **pass**）：K1 journal
      理由逐字以 `registry kill (owner session ended) — the child was
      aborted and the dispatch is never retried` 开头，不再出现
      dispose / user cancel / user abort；台账一条 keep 行；孩子进程树
      被杀、子会话 404。K2 唤醒 `— ABORTED`、逐字携带 journal 理由
      （`cancelled by the user lever (/forge stop) — …`）、击杀类别同为
      cancel、无 Final report、无脚手架、孩子空闲
      （旧构建证据，留档：2026-11-23T17:14:07–17:15:40Z，宿主 2.4.0，最终构建 dist
      16:55:16Z；驱动 11-dispose-e2e.mjs 腿 K1 + K2 均 **pass**：
      K1 owner 被删 → journal 终态 `aborted`、理由
      `registry kill (owner session ended / dispose) — user abort`；台账
      留 keep 行 `owner session ended; registry kill issued (row kept for
      wake delivery …)`；子会话 404、其命令进程树被杀。K1 的唤醒半边在
      活宿主上不可观测（owner 已不存在，无收件箱）——由 dispatch-journal
      单测钉措辞，同一条 jobWakeText 分支由 K2 活体观测。
      K2 取消杆 → 取消输出 `… is confirmed idle (the cancellation is
      REAL, not bookkeeping)`；唤醒 `— ABORTED (task …): cancelled by the
      user lever (/forge stop) — the child was aborted and the dispatch is
      never retried …`；journal `aborted` 且理由与唤醒**逐字一致**、击杀
      类别同为 `cancel`；无 "Final report:"、无脚手架；子会话空闲。
      旧构建上 K2 倒在 `error` + `[object Object]`——杀路径竞态，返工
      R1/R2/R4 修复（见 reports/e2e-convergence-2026-11-23.md S5））

## 4. Release + install verification（GATE）

- [ ] 4.1 并入 0.33.0 合并发版：npm pack --dry-run 白名单核对 →
      publish → dist-tags 翻牌 → shasum 记录入档
- [ ] 4.2 旧物化副本隔离（`1795370347623` → `_quarantine` 改名）
- [ ] 4.3 用户重启后真机终验（Unity 三测金丝雀或探针复跑，判据同 3.1）

## 5. Wrap-up（用户明示后）

- [ ] 5.1 openspec archive + push；探针/驱动脚本归档
      `archive/<日期-主题>/`
