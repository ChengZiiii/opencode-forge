# Proposal: fix-dispatch-transport-timeout

## Why

2026-09-27 实战事故（DISPATCH-TIMEOUT-INCIDENT-2026-09-27.md）：一次合法的
background dispatch（review @high，child 正常运行 5m34s 并完成）在 281s 处被
turn-synchronous message POST 的**传输层中断**（fetch 抛
`DOMException "The operation timed out."`，非引擎 600s deadline、非 HTTP 错误响应）
误杀：ledger 记为 dispatch ERROR、completion brief 携带错误终态、child 的真实报告
永远丢失；主会话 LLM 读到错误 brief 后自发降档重发（bg-2 @medium），双花 token
并二次 ERROR。根因：`runAttempt` 把 turn POST 的任何非 DispatchError 拒绝都当作
dispatch 失败上抛，而 child session 是宿主侧对象——POST 客户端断了 child 依然
活着并会跑完。引擎已有完成轮询回路，缺的只是"传输中断后落到轮询"的恢复语义。

## What Changes

- **传输中断恢复（核心）**：`runAttempt` 中 turn-synchronous POST 若以非
  DispatchError（传输层 abort/网络错误）拒绝，且 child session 已创建：记一条
  `transport-interrupted` ledger 事件（含 sessionID/dispatchId/耗时），随后落入
  既有的完成轮询回路，在同一 per-dispatch deadline 内继续等 child。child 跑完
  → 照常聚合 `completed` 报告并投递 brief；deadline 到期 child 仍未完 → 既有
  `timeout` 终态（child-alive 语义）。sync 与 background 共用该语义。
  HTTP 错误响应（`host-error`）不做恢复——那是真实的 API 拒绝，保持现有上抛。
- **终态报告携带 child sessionID**：`bgTerminal` 的 report 目前硬编码
  `sessionID: ""`（事故里 bg-1 终态丢了 child id）；改为从 registry 条目取
  真实 child id，并在 timeout 报告 note 中明示 child session 仍在宿主侧运行、
  transcript 可查。
- **终态 ledger 行补全标识**：`bgTerminal` 的 `error` ledger 事件补上
  dispatchId / parentSessionID / sessionID / durationMs（事故 bg-1 行五缺其四）。
- **测试**：engine 单测（可注入 fetcher + fake clock）覆盖：传输中断→轮询恢复→
  completed 正常投递；恢复期 deadline 到期→诚实 timeout；HTTP 错误仍上抛不恢复；
  恢复轮询中 kill 依然生效；sync 路径同语义。

## Capabilities

- **Modified Capabilities**: `dispatch`
  - `forge_dispatch tool contract`：deadline/轮询语义增加传输中断恢复场景。
  - `Background dispatch mode`：终态交付诚实性（终态报告携带 sessionID、
    传输中断不产生假 ERROR 终态）。
  - `Draft-plan interop and dispatch ledger`：终态 ledger 事件的标识完整性。

## Impact

- 代码：`src/dispatch-engine.ts`（runAttempt 恢复分支、bgTerminal 报告），
  `tests/dispatch-engine.test.mjs`（新增用例）。`plugin.ts` 无需改动（错误
  文案随 engine 消息走）。
- 无配置面/工具签名/ledger 兼容性破坏：新增 `transport-interrupted` 事件类型
  为追加；既有事件语义不变。crew-gate 的 ledger 过滤名单需同步放行新事件
  （`crew-gate.ts` 已有 event 白名单——新增事件不得被误判为 gap）。
- 不改：超时预算默认值/上限（600s 维持）、agents 路径 no-retry 裁定、
  empty-response 终态语义（均见 Non-goals）。

## Non-goals（明确不做，留待用户另裁）

1. **depth 分档超时预算 / 提高上限**：事故的真凶是传输层中断而非 600s 预算
  （child 5m34s < 600s 本可正常完成）；预算分档是产品决策，另立 change。
2. **empty-response 自动退避重试**：与 agents 路径 pinned-no-retry 的既有裁定
  相抵，需 owner 裁决，另立 change。
3. **sync 窗口耗尽降级为 handle 返回**：工具 API 形状变更，收益存疑
  （sync 调用方在场，抛错即诚实），暂不做。
4. **事故中"身份翻转"现象**：已定性为主会话经 Task 通道 resume 同一 child
  session（13:54:47 第二轮 forge/primary 流即 Task resume 的消息），非插件
  缺陷；本 change 只在 postmortem 文档记录。
