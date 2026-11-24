# Proposal: fix-stop-cancels-queued-wishes

> **行为改动，用户已拍板。** 原话（2026-11-23）：“forge stop 要的就是 stop
> 当前 session 所有，排队的也取消好吧”。

## Why

`/forge stop` 现在只取消**在飞**的派发，排队中的 wish 原样留在队列里。
而且顺序对用户不利：stop 取消在飞派发腾出的并发槽位**立刻**被队列头
补上——用户刚敲完 stop，新的子代理就冒出来，还得再敲一次。

规范原本把这一条留成未决项（forge-subagents「User-facing dispatch
cancellation」末句：“Queued wishes are not in flight, so a stop does not
cancel them”；单测注释：“whether-stop-also-flushes-them is an open
decision, not this behavior”）。用户现在拍板：排队的也取消。

## What Changes

- **先清队列，再取消在飞**。顺序是硬性的：先取消在飞派发的话，槽位一空
  队列头就 spawn，再取消就只能去 abort 一个刚出生的子会话。
- 被取消的排队 wish：从队列移除、journal 记 `aborted` + 一句 stop 专属
  理由（从未 spawn、不会重试）；没有子会话，所以没有 wake，回执点名。
- 回执分两段如实报告：在飞取消了几个、排队取消了几个。**只有排队 wish
  时也取消并回执**（不再报“nothing to stop”）；两者都没有才报无事可做。
- `/forge stop` 下发的提示词、工具描述、“cancel all 已退役”的拒文案
  同步改成“在飞 + 排队”。
- **泵正在启动的那个 wish 也不漏**（实现时发现的同源缺口）：队列头被
  泵取走之后、登记进注册表之前，有两次 `await`（建子会话、发提示词）。
  这几百毫秒里它既不在队列也不在“在飞”名单上，stop 会漏掉它。现在
  stop 会等它落地：子会话还没建完的 → 不提示词，按排队取消；提示词已经
  发出去的 → 按在飞取消。详见 design D5。

## Impact

- `plugin.ts`：`forge_jobs` 的 `stop` 分支、三处文案；队列泵
  （`pumpDispatchQueue`）与 stop 之间的在途窗口（design D5）。
- `tests/dispatch-wiring.test.mjs`：原“stop 不取消排队 wish”的断言按新
  约定改写；新增用例（只有排队 wish、队列头不补位、重启后不复活、回执
  形状、journal 句子、在途窗口四则、并发上限计入在途、被拒的队列头不占槽）。
- `tests/forge-commands.test.mjs`：`/forge` 帮助行里 stop 那一句的断言跟着
  改成“in-flight and queued”。
- `tests/dispatch-journal.test.mjs`：重启恢复不重入已取消的排队 wish；在途
  wish 的“已重新入队”通知照常送达。
- `README.md`：`/forge stop` 段落。
- 规格：forge-subagents「User-facing dispatch cancellation」（REMOVED，并以
  「User-facing dispatch cancellation (in-flight and queued)」之名整条重写为
  ADDED——OpenSpec 1.13 不允许 MODIFIED 块丢场景，而本 change 恰好要退役
  “stop 不取消排队 wish 并在回执里点名”这一幕；其余场景原样带过去，归档后
  这条要求会挪到该规格 Requirements 段的末尾）、
  command-surface「Single forge command surface」（MODIFIED，一个场景）。
- 不变：按 id 取消（`cancel` + jobId）在飞派发后，队列头照旧补位；按 id
  取消一个**还在排队**的 wish 不在本次范围（照旧报“注册表里没有”）。
- 版本：0.34.0（与 fix-stale-progress-notice 同版）。
