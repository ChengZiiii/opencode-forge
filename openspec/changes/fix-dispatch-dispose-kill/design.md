# Design: fix-dispatch-dispose-kill

## D1 — dispatch 行豁免：单一谓词过滤两个杀出口

判定谓词：`isDispatchRow(job) = job.dispatch != null`（dispatch meta 是
dispatch 行的唯一标识，plugin.ts:1149-1155）。

两个杀出口都挂过滤，同一缝不改语义分层：

- `exitCleanup.trigger("dispose", { skip })`：`host-exit.ts` killOne
  （:70-86）在 `job.killTree()`/`markTerminal` 前检查 skip——dispatch 行
  对出口矩阵本来就是惰性的（无 pid → terminateTreeSync 已 no-op，:71-79），
  skip 掉的只有 killTree+markTerminal 两个破坏性副作用。
- `jobManager.disposeAll({ skip })`（job-manager.ts:326-335）：循环内
  `if (skip?.(job)) continue`——行不删、状态不改。
- host-exit 内部信号路径（SIGINT/SIGTERM/exit/uncaught）的 trigger 同样
  带同一 skip——dispatch 行的跨重启连续性由 journal 承担
  （dispatch-journal nonTerminal 过滤，dispatch-journal.ts:204；重启恢复
  按 started/queued/retry-pending 分支重整，plugin.ts:3225-3435）。

**否决的替代**：给 dispatch 行打 `survive: true`——survive 是另一份契约
（持久注册表+adoption+跨宿主幸存，job-manager.ts:51-52、314、328），
语义 overload 会改 job-supervisor 的 ownership 行为。显式 skip 谓词最小、
可测、不动 survive 语义。

dispose 钩子其余动作（engineForAllForget / watchdog.dispose /
sessions.clear）保持原样——本轮实锤的破坏只有杀 dispatch 行；
`sessions.clear` 是进程内缓存，上下文回收后按需重建，不动。

## D2 — killed wake：诚实措辞 + 必达

- **措辞**：`jobWakeText`（plugin.ts:1154-1178）加 killed/aborted 分支：
  `state === "killed"`（或 dispatch meta 记录 aborted outcome）→
  `[forge:dispatch-complete]` wake 以 "was aborted (reason)" 呈现 + 指向
  journal 理由；**禁止** "finished … Final report:" 措辞与 `(no output)`
  伪报告。与既有 stream-lost 分支（:1159-1165）同构。
- **必达**：kill 路径不再同步删行。`onSessionEnd`（job-manager.ts:311-324）
  对 dispatch 行改为 markTerminal 后**留在 jobs Map**，靠既有
  terminal-evidence + read-consumption 自清（:216-223）在 wake 被读后
  消失——queued wake 因此可达（deliverWakesFor 只遍历活 Map，:340-350）。
  `disposeAll` 的 delete 对 dispatch 行已由 D1 skip 掉。
- **abort 未证实披露**：kill 时 `abortChild` 结果非 ok（含
  unavailable）→ journal 终态 reason 附 "abort unconfirmed — child may
  still be running"，wake 同文披露（孤儿披露路径 plugin.ts:3995-4006 的
  现成措辞风格）。

## D3 — v2 abort 接线（决策依赖 E1 探针，按序取第一个可用）

外部调研（E2，reports/research-community-competitors.md）实锤 v2 官方
会话停止面存在：`ctx.session.interrupt({sessionID, resume:false})` +
`ctx.session.remove`（opencode 官方 server 文档；v1 的 abort+replay 假设
在 v2 已死）。决策树按序取第一个可用：

1. **`ctx.session.interrupt`（首选，官方文档钉死）** → v2Setup ctx 传入
   V2SessionClient 接 `abort`。
2. 宿主 HTTP API 有 session abort/interrupt 端点（E1 GET /api/doc 探测）
   → 经 service.json HTTP 读写器同款通道（plugin.ts:8646-8670 模式）。
3. 都没有 → `abortChild` 开头 `typeof client.session.abort === "function"`
   检测，返回 `{ok:false, error:"abort unavailable on this session
   client"}`；**所有 killTree 调用点**（:3061, 3285, 3319, 3412, 3837,
   4255, 5058, 5114）禁止 `void` 丢弃——统一走 D2 的未证实披露
   （journal note，不阻塞杀本身）。

cancel 杠杆已有 `assertChildIdleAfterAbort`（:3575-3602）确认语义，保留
并复用其输出作为披露事实源。

## D4 — 测试重议清单

| 现有 pin | 处置 |
| --- | --- |
| job-manager.test.mjs:116-124 "dispose kills every running job" | 改：dispose 杀进程型 job；dispatch 行（带 dispatch meta fixture）幸存且状态不变 |
| host-exit.test.mjs:34-50 dispose 优雅-然后-强制矩阵 | 加 skip 参数用例：dispatch 行不被出口矩阵标记 killed |
| dispatch-wiring.test.mjs:1288-1304 USER ABORT 不重试 | 不变（owner-death 路径契约保留） |
| dispatch-journal.test.mjs:364-390 owner-death harvest | 补断言：killed wake 文本含 aborted 措辞、不含 "(no output)" |
| dispatch-async.test.mjs:379-392 abortChild | 加 abort-less client 用例（undefined abort → ok:false + unavailable 文案） |

新增：dispose 注入后 poller 继续走、wake 正常送达（multi-session
fixture，A 会话派发中、B 上下文 dispose）。

## D5 — 沙箱 E2E 场景（③ GATE 判据）

沙盒 v2 宿主（fake USERPROFILE=ws 布局，view-e2e 脚本族）：

1. **dispose 豁免 E2E**：会话 A 派发慢孩子 → 触发一次插件 dispose（模拟
   上下文回收，直接调 dispose 钩子）→ 判定：A 的
   `[forge:dispatch-complete]` wake 仍到达且 `Final report:` 携带孩子
   原文（裸行感知判据——判 wake 块本体，不是原生通道）；journal 无
   aborted 终态。
2. **杀路径诚实 E2E**：派发中 owner 会话终结（session.deleted）→ 判定：
   wake 以 aborted 措辞+理由出现，无 "(no output)"；journal 终态与
   wake 同 reason。

真机复验留给用户晨间（Unity 三测金丝雀或探针，判据同 1）。

## D6 — 版本

并入 **0.33.0 合并发版**（C1/C2/C3/C4 一轮发布、一次隔离、一次重启完成
全部验收——用户晨间一次性验）。烧版纪律照旧：已发布版本号永不复用，
旧物化副本 `_quarantine` 改名隔离。
