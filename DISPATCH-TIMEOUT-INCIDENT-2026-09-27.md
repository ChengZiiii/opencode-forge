# Incident handoff: dispatch wrapper false-timeout (2026-09-27)

给新 session 的交接文档：forge dispatch 编排层在 0.3.3（npm 装机版）上的超时误判事故。
现象报告人：opencode 主 session（forge agent）；子代理视角"完全正常运行完毕"。

## TL;DR

`forge_dispatch`（sync, review agent, depth=high）的**子会话实际运行 5m34s 并正常完成**，
但 dispatch **wrapper 在 281s 处判 timeout、ledger 记 ERROR、completion brief 被吞**；
随后插件侧**未经理发派**自动出现降档重试（bg-2 @medium），撞上 keyless 端点 0-token
空响应怪癖后二次 ERROR。主 session 只能换 Task 通道重跑 review。
**结论：不是模型/端点故障（bg-1 侧），是编排层等待-记账语义的 bug 簇。**

## 时间线（opencode.log: C:\Users\Soren\.local\share\opencode\log\opencode.log）

| 时刻 | 事件 | 层 | 证据行 |
|---|---|---|---|
| 13:49:42.397 | child `ses_f1cdf0d82ffe5iZ8tRLSjPRFJc` 创建，`agent=forge-review mode=subagent`，parentID=本根会话 | 子会话 | 18462 |
| 13:49:42→13:52:33 | 正常推进 step=1…6（流式+工具调用） | 子会话 | 18463-18650 |
| ~13:54:23 | **wrapper timeout（durationMs=281017）→ ledger ERROR "The operation timed out."** | 包装层 | forge_dispatch_list 终态 bg-1 |
| 13:54:43.451 | **bg-2 出现：review @medium，主 session 未调用**（bg-1 超时后 +20s） | 包装层 | forge_dispatch_list 队列记录 |
| 13:54:47.076 | **同一 child session id 恢复流式，但身份标签翻转为 `agent=forge mode=primary`**，step 重置=1 | ??? | 18756, 18773 |
| 13:55:16.016 | 该会话 `exiting loop` 正常收尾（= 用户看到的"正常跑完"，比 ERROR 判定晚 53s） | 子会话 | 18797-18798 |
| 之后 | bg-2 终态 ERROR：`child session ses_f1cda7558ffeUJmc0Ef5kQjimJ returned an empty response (0-token assistant message)`，注释称"keyless 端点+受限档位已知怪癖" | 包装层 | forge_dispatch_list 终态 bg-2 |

## 缺陷清单（按严重度）

1. **[major] wrapper 超时预算不随 depth 缩放**。固定 ~281s 硬上限；high 深度 review
   （npm test + tsc + 几十个文件读取）合法耗时 5-10min，注定误杀。
   建议：timeoutBudget 按 depth 分档（none/low ~3min，medium ~8min，high/max ~15min），
   并允许 forge.json knobs 覆盖。
2. **[major] "wrapper 等待超时" 被记账为 dispatch 失败，而 child 还活着**。
   正确语义：ledger 记 `wrapper_timeout_child_alive`，不抑制 completion brief，
   child 收尾后照常投递（本例 child 在 ERROR 后 53s 完成，报告滞留在子会话里永远没送到）。
   "The child session itself cannot be aborted on this host version"（kill 工具自己的话）
   更加说明：超时后 child 必然自走完，记账必须反映这一点。
3. **[major?] 未请求的自动重试（bg-2）**。主 session 从未发起；bg-1 是 wrapper 超时
   （child 存活），重试= 双花 token + 与原 child 并发竞争。若这是 0.3.3 的重试逻辑：
   应只对 child 终止型错误重试，wrapper 超时绝不重试；也不该降档（high→medium 丢质量）。
   另：bg-2 显示 @medium，但本仓 forge.json 里 review 的 depths 首项（默认）是 low
   ——降档规则是"降一档"还是别的，需要读码确认。
4. **[minor] sync 模式把等待窗口耗尽当错误抛给调用方**（"The operation timed out"）。
   应在窗口耗尽时降级返回 {dispatchId, jobId} 而非报错——调用方就能 poll。
5. **[minor] child 身份标签翻转**：18756 行起，`ses_f1cdf0d8…` 从 forge-review/subagent
   变为 forge/primary 继续 step=1→3。是重试逻辑复用了原 child 会话并注入了新 prompt？
   还是 session 记录被改写？需要读码定性。mode=primary 的子会话在权限域上意味着什么，
   值得查（安全面）。
6. **[nit] ledger 终态结果里 `"sessionID": ""`**——in-flight 时明明有 id，落盘时丢了。
7. **[已知怪癖确认] 0-token 空响应**（bg-2）：keyless 端点 + 受限档位。既然已知且良性，
   值得做一次自动退避重试，而不是终态 ERROR。

## 与 /crew 的关系（用户疑问）

设计上编排入口是 `/crew`（crew_begin/crew_close + dispatch ledger）。本次**没有任何
crew 被注册/启动**——问题出在 `forge_dispatch` 工具可被 agent 直接调用（独立于 crew）。
要决策的点：普通 dispatch 是否也应要求显式授权/开关？自动重试（缺陷 3）无论如何
违反最小惊讶。

## 复现环境

- opencode 1.18.32（win32），@sorenllm/opencode-forge 0.3.3（npm 装机版，源码在本仓）
- forge.json（当次新建）：`C:\Users\Soren\Desktop\AgentWorkCommon\.opencode\forge.json`
  —— agents: research/review → glm-coding-worker/glm-5.3，depths [low, medium, high]
- 触发：`forge_dispatch(agent=review, depth=high, sync)`，任务=大 repo 的 openspec
  change + 工作树 review（含 npm test / tsc），prompt 很长、工具轮次多
- forge_dispatch_list 快照与完整时间线日志行号见上；新 session 可直接
  `rg -n "f1cdf0d82ffe5iZ8tRLSjPRFJc" %LOCALAPPDATA%\..\..\.local\share\opencode\log\opencode.log`
  复核（绝对路径：C:\Users\Soren\.local\share\opencode\log\opencode.log）

## 建议的验证顺序

1. 读 dispatch 的超时常量与重试触发点（281017ms 这个数应该能搜到来源）
2. 复跑：sync + depth=high + 长任务；观察 ledger 语义与 bg-N 行为
3. 写单测：wrapper 超时时 child 仍在流式 → 期望 ledger 记 wrapper_timeout_child_alive、
   brief 延迟到送、无自动重试

---

## 结案裁定（2026-09-27 同日，fix-dispatch-transport-timeout change 落地）

> 以下结论由 opencode.log 逐行取证 + ledger 原始行 + 二进制串扫描 + Bun 1.3.14
> 探测（600s+ 挂起不中止）+ serve 沙盒 E2E 共同支撑，修正本文上文的两处误判。

### 时间线修正

- **bg-1 实为 background 模式**（原文标 sync 有误）：parent 会话在 bg-1 全程
  每 5-15s 持续流式推进 step 1→26（log 18451-18742），sync 工具调用会阻塞
  parent，不可能出现该形态。
- **281s 中止源**：宿主侧传输层对 turn 同步 POST 的 abort（错误串
  `"The operation timed out."` = 运行时 fetch 中止类 DOMException 的标准消息）。
  排除项：非引擎 600s deadline（源码+装机 dist 均 600000）；非 HTTP 错误响应
  （api() 会包成带状态码前缀的 host-error）；非裸 Bun fetch 默认超时（探测挂
  600s+ 不中止）。与 README 已记载的 ~262s host tool ceiling 疑似同族
  （262s/281s 两次观测、机制未精确定位——修复对该来源免疫，见下）。

### 缺陷逐条裁定

| # | 原判定 | 结案 |
|---|---|---|
| 1 | wrapper 超时预算不随 depth 缩放 [major] | **非本案根因**（child 5m34s < 600s 本可正常完成；真凶是传输层中止）。预算分档移交 Non-goals 另裁 |
| 2 | wrapper 超时记 dispatch 失败而 child 活着 [major] | **确认为核心缺陷，已修**：turn POST 传输级失败 → ledger `transport-interrupted`（带 sessionID/dispatchId）→ 落入既有轮询恢复（同 deadline）；child 跑完照常投递；绝不重发 POST；未送达退化为诚实 timeout |
| 3 | 未请求的自动降档重试 bg-2 [major?] | **非插件行为**：主会话 LLM 读到假 ERROR brief 后自行降档重发（bg-2 child 恰在 parent step=26 流式回合内诞生，log 18738-18739；插件零自动重发路径，唤醒只投 brief）。修复假终态即消除诱因 |
| 4 | sync 窗口耗尽抛错 [minor] | 维持现语义（sync 调用方在场，抛错即诚实），移交 Non-goals |
| 5 | child 身份标签翻转 [minor] | **非插件缺陷**：13:54:47.006 同一 child 以 forge/primary 重跑 = 主会话经 Task 通道 resume 该子会话（与 child 首轮 "exiting loop" 13:54:46.959 严丝合缝） |
| 6 | 终态 `"sessionID": ""` [nit] | **确认，已修**：bgTerminal 从 registry 取真实 child id；error ledger 行补齐 dispatchId/parentSessionID/sessionID/durationMs |
| 7 | 0-token 空响应自动退避重试 | 与 agents 路径 pinned-no-retry 裁定相抵，移交 Non-goals（owner 裁决） |

**/crew 关系**：本次无任何 crew 注册，crew 层完全无关。"dispatch 是否要求显式
授权"仍是开放设计决策（可经 `permission: {"forge_dispatch": "ask"}` 逐次把关，
或另立 change 结构化解决）。

### 验收记录（change: fix-dispatch-transport-timeout）

- 单测：TI-1…TI-6（传输中断恢复/未送达退化 timeout/HTTP 错误不恢复/恢复期
  kill/sync 同型/终态标识）+ crew-gate 白名单用例，全绿；全量 328 pass
  （watchdog-wiring 1 例存量失败，git stash 原树复跑证实与本 change 无关）。
- Live E2E（`opencode serve` 沙盒 + 免费 keyless 模型，真实宿主/真实会话）：
  - 中断注入：`transport-interrupted` @1523ms（note 正是 "The operation
    timed out."）→ 恢复轮询 → `completed` @9608ms（同一 child、真实 token
    input 233 + cache 16384、报告完整）→ ACCEPTANCE PASS（job
    j-20260927-150250-uhx8g4）
  - 无中断回归：review 型任务 10.9s completed、证据引用齐全、零
    transport-interrupted → ACCEPTANCE PASS（job j-20260927-150321-uvd2wy）
- ~281s 精确定源未完成：沙盒 keyless 会话拒绝 bash（"not bound to a Paseo
  agent"），无法构造 >281s 真实长回合；修复语义对中止来源免疫，定源留作后续
  观测项（若再次出现，ledger 的 transport-interrupted 行即取证点）。
