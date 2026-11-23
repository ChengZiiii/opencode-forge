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

## D3 — v2 abort 接线（E1 探针已定案）

E1 真机探针（reports/research-v2-host-surface.md，GET /openapi.json
142 路径实证）+ E2 官方文档双源定案：**宿主 2.3.2 没有 `abort` 端点**；
真面 = `POST /api/session/{sessionID}/interrupt`（可选 `resume` 参数；
`200 {interrupted}`；**idle 会话 interrupt 是 no-op**）；promise 层
`await ctx.session.interrupt({sessionID, resume:false})`（官方 server
文档）。SDK 1.18.32 类型是另一代形状（204/无 resume）——按活宿主形状
防御性解析。接线：

1. **单一 seam**：`ctx.session.interrupt`（promise 层）+ HTTP fallback
   `POST {service.url}/api/session/{sessionID}/interrupt`（走既有
   `discoverServiceHttp()` 读服务面，plugin.ts:8525-8545）；
   `{interrupted:false}` 且孩子已 idle 视为成功等价（孩子本来就完了）。
2. 都不可用 → `abortChild`（dispatch-async.ts:936-943）开头
   `typeof` 检测，返回 `{ok:false, error:"abort unavailable on this
   session client"}`。
3. **无论哪个分支**：所有 killTree 调用点（:3061, 3285, 3319, 3412,
   3837, 4255, 5058, 5114）禁止 `void` 丢弃——统一走 D2 的未证实披露
   （journal note，不阻塞杀本身）。

顺带修正 stale 注释：dispatch-async.ts:9（prompt_async 在 2.3.2 不存在
——宿主祝福的 fire-and-forget 是 durable admission `resume:false`）与
:13（session.abort 是错误世代）。更强杀面 `DELETE /api/session/{id}`
（session.remove，递归删孩子）留注不接线。cancel 杠杆既有
`assertChildIdleAfterAbort`（:3575-3602）保留复用。

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

## D7 — 规约复核返工（2026-11-23 夜；全部在本 change 契约内）

沙箱 E2E 过后做了一轮规约复核，逐条回源码核实。五处返工 + 一处时序
加固（R5–R9），共同病根只有一个：**同一事实有两个说法，或者有人说
有人不说**。

| # | 问题（源码核实） | 根因 | 处置 | 回归测试（`tests/dispatch-wiring.test.mjs`，注明者除外） |
| --- | --- | --- | --- | --- |
| R5 | journal 终态理由与唤醒理由不是同一句：journal 写 `registry kill (owner session ended / dispose) — user abort`，wake 渲染常量 `(owner session ended / user cancel)`；通用 `forge_jobs kill` 打在派发行上时两边都不属实 | 两处各写各的字面量；旧单测只断言"同一 kill 类"，E2E 的 K1 腿（owner 已删）观测不到唤醒 | 击杀钩子在击杀那一刻把一句话盖在行上（`meta.abortReason`），`settleKilled` 与 `jobWakeText` **都只读这一句**；三种来源各一句常量（owner 终结 / 取消杆 / 显式 kill） | `kill sentence ①…`；`tests/dispatch-journal.test.mjs` 的 owner-death 用例改为逐字钉 |
| R6 | 击杀结案后不泵该会话的派发队列 | 本 change 的 R1 给 `settleKilled` 加了五个裸 `return`，跳过了循环后的统一收尾（返工前是 `break` 走到收尾再泵）——**本 change 自己引入的回归** | `settleKilled` 结案时泵一次（owner 死亡时队列已被 harvest 清空，泵无可泵） | `queue pump ②…`（变异检查：拆掉这一行即失败） |
| R7 | 重试重生窗口落下的击杀：新孩子建出来没人管 | 建孩子 / 发提示词两段等待里没有复查 | `settleRespawnKill`：建孩子后、发提示词后各复查一次。建孩子期间落下 → 不发提示词、仅作清理中止、行不改绑（唤醒点名上一次尝试的孩子）；发提示词期间落下 → 行改绑新孩子后中止 | `respawn window ③a…` / `③b…` |
| R8 | 错误对象含循环引用或 BigInt 时 `executionErrorDetail` 落到 `String(error)`，又渲染成 `[object Object]`；空原型对象直接抛 | JSON 兜底的 catch 分支返回 `String(error)`；读取属性无防护 | 兜底返回 undefined 交调用方自己的诚实措辞；整个函数包在 try/catch 里（敌意 getter / Proxy 不抛进信号路径） | `executionErrorDetail is TOTAL on hostile shapes…` |
| R9 | abort 未证实的两处时序漏洞：① 中止调用挂起不返回时，结算等满 2 秒就写了光秃秃的 `aborted`——孩子可能还在跑而无人被告知；② owner 已空闲时唤醒在击杀瞬间投递，可能早于 abort 失败渲染，于是唤醒说"已中止"、journal 说"未证实" | 结算与投递两处各自等 / 不等，且都只认"失败"不认"没返回" | 共用 `awaitAbortVerdict`（限时等待；到点仍未返回即记一笔未证实），journal 结算与唤醒投递都走它——谁先写谁后写，结论一致 | `abort-unconfirmed ④b…` / `④c…` |

**明确不在此决定**：`/forge stop` 是否连带清空本会话**排队中**的
wish。现行为 = 在飞的全停、排队的留着，并在回执里点名（基线 fold D：
槽位释放即泵，取消腾出的槽位立刻给队首）；本 change 只补了回执
点名与 R6 的泵。"要不要一并清空"是行为改动，另立 change 待批。
