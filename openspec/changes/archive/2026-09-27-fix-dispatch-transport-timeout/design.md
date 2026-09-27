# Design — fix-dispatch-transport-timeout

## Context

见 proposal（Why）。现状：`src/dispatch-engine.ts` 的 `runAttempt` 把 turn POST 的
`Promise.race` 结果直接 `await`——任何非 DispatchError 拒绝（fetch abort / 网络
错误）原样上抛；background 管线的 catch 把它送进 `bgTerminal` → `markError` 终态
（report 硬编码 `sessionID: ""`），brief 携带假 ERROR。事故时间线证明 child 在
POST 客户端中断后仍在宿主侧跑完（13:54:23 中断 → 13:54:47 完成，报告滞留子会话
永久丢失）。既有 `completionVerdict`（stable-x2，`count > 0` 才判 complete/empty）
已经为恢复轮询提供了正确的退化语义：0 消息（从未送达）永远 waiting → deadline
诚实 timeout。

## Goals / Non-Goals

- Goals：传输中断不产生假终态；child 存活时结果照常送达；终态报告/ledger 行
  自描述（sessionID 等标识齐全）；HTTP 级错误保持现有语义。
- Non-Goals：不重发 POST、不改超时预算/上限、不动 retry 裁定、不改工具签名
  （proposal Non-goals 1-3）；不处理轮询 GET 自身的传输失败（现语义：GET 失败 =
  宿主通信断 = 诚实 error，维持）。

## Decisions

1. **恢复逻辑放 `runAttempt` 内部，不是外层包装。** t0/deadline/killControl/
   onChild 全在这一层共享；放 bg 管线 catch 里会迫使 sync 路径再抄一份，且 slot
   会计被拆散。恢复 = turn POST 拒绝后不 throw，落入紧随其后的轮询循环。
   备选（拒绝）：bg 管线 catch-and-repoll——被否，双路径漂移。
2. **传输级 vs HTTP 级的判据：是否 DispatchError。** `api()` 对 `!res.ok` 统一
   包成 `DispatchError("host-error")`，因此能到达 race 的裸异常（DOMException/
   TypeError/SyntaxError）必然不是 HTTP 错误响应——按传输级处理，进恢复。恢复
   只认"child 已创建"（`childID !== ""`）：POST 之前（建会话阶段）的失败仍按
   现有语义上抛。
3. **绝不重发 POST。** 消息可能已送达（事故即此情形）；重发等于给 child 双份
   prompt。恢复只轮询。消息从未送达的情形由 `completionVerdict` 的 `count > 0`
   门槛兜底 → waiting → deadline timeout（诚实，且不会误报 empty-response）。
4. **不给 POST 加显式 AbortSignal。** 引擎 deadline 已由 `deadlinePromise` race
   管辖；再挂 `AbortSignal.timeout` 会引入第二时钟源和 DOMException 归因歧义。
   运行时层的任何 fetch 中止（本案 ~281s 来源）落入恢复路径后无害化——恢复语义
   对"谁掐断了 POST"免疫。
5. **ledger 事件 `transport-interrupted`：每次尝试至多一条**，字段对齐既有
   timeout/empty 事件（tier/agent/identity/depth/sessionID/durationMs + bg 时
   dispatchId/parentSessionID）。crew-gate 的非结局事件白名单同步加它——它不是
   终态，不得触发 crew 报告缺口判定。
6. **`bgTerminal` report 修三处**：sessionID 取 `reg.get(dispatchId).sessionID`；
   `deps.sink` 的 error 事件补 dispatchId/parentSessionID/sessionID/durationMs；
   timeout 报告 note 明示 child 留存宿主侧、transcript 可查（文案与 sync 侧
   `runAttempt` 的 timeout 消息同源）。
7. **sync 路径零改动共享恢复**：`dispatch()` 的 sync 重试环调用同一
   `runAttempt`；传输恢复后正常返回 result 或抛既有 timeout——工具层文案自动
   跟随。

## Risks / Trade-offs

- [sync 调用方在传输闪断后要等满 deadline 才有结果/超时] 缓解：相比假失败+人工
  重跑（双花 token），等满 deadline 是更诚实的语义；deadline 仍是 600s 上限。
- [恢复轮询期间 GET 失败仍会终止管线（error）] 接受：GET 是亚秒级请求，与
  ~281s 级的 POST 中止源不同族；GET 失败意味着宿主通信真断了。
- [`transport-interrupted` 后 child 之外无第二数据源验证消息确已送达] 接受：
  轮询结果即验证——送达则 completed，未送达则 timeout；两种结局都诚实。
- [运行时 ~281s 中止源未最终定位（二进制内多处 `AbortSignal.timeout` 均在
  provider/SDK 路径，裸 Bun fetch 探测 600s+ 不中止）] 缓解：决策 4 使修复对该
  来源免疫；verify 阶段的 serve 沙盒慢回合（>281s）E2E 若复现中止即顺带定源。

## Migration Plan

进程内行为变更，无数据/配置迁移。发版流程照旧：`bun run typecheck` →
`node --test` → `bun run bundle` →（提交后）官方安装模式终验。回滚 = 回退
dist。ledger 新事件类型为追加，旧读方（crew-gate）随本变更同版本发布。

## Open Questions

- 无（budget 分档与 empty-response 重试已在 proposal Non-goals 中显式移交用户）。
