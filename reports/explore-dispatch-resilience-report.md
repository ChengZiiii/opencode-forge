# explore — 派发路径韧性三块现状勘察（为 change proposal 供料）

- **基线**：HEAD `d52d883`（0.28.0 + OMO 调研报告）。全部源码事实经 `git show HEAD:<path>` 读取，行号 = HEAD 基线行号（工作树行号已因在途 crew change 漂移，勿直接对表）。
- **对照基准**：`reports/omo-subagent-research-report.md` Q3（派发实现 + 踩坑 issue）/ Q5（并发闸与熔断）/ Q7（建议动作）。
- **纪律**：本勘察零源码改动；唯一产出即本报告（新文件，不在在途 diff 内）。

---

## A. 派发完成判定

### 现状事实【HEAD 基线】

**核心轮询：`pollChild` — `src/dispatch-async.ts:541-661`**（sync 与 async 共用同一判定核）

每个 poll tick（默认 1000ms，`DEFAULT_POLL_INTERVAL_MS` @ dispatch-async.ts:225）做两次读取：

1. **status 信号**（:572-587）：`client.session.status()` 返回全宿主活跃会话 map（host 1.19.5+ 语义：完成的会话**从 map 移除**，map 只含 busy/retry/running，`ACTIVE_STATUS_TYPES` @ :26）。三种解释：
   - fetch 抛错/map 不可读 → **视为 ACTIVE**（可靠性姿态：读不到的信号不作裁决，:582-583）
   - 会话不在 map 中 → not-active（宿主的 IDLE 信号，:585-586）
   - 在 map 且 type 活跃 → active
2. **消息流信号**（:589-604）：`client.session.messages({limit:100})` 取最新 assistant 消息（`latestAssistant` @ :507-519）。

**完成判定（:628-645）= 与关系三条件 + 稳定窗**：

```
completed ⇔ not-active ∧ truthy finish ∧ 非空 text parts
           且该候选连续保持 TERMINAL_STABILITY_TICKS = 3 个 tick（:482）
           （任一 active 读数或候选破缺 → stableTicks 清零，:641-645）
```

**卡死保护（四层）**：

| 机制 | 位置 | 语义 |
|---|---|---|
| 显式错误即决 | :623-627 | 最新 assistant 消息带 `error` 对象 → 立即 terminal error，**不走稳定窗**（窗口保护的是推断，不是声明） |
| 视图丢失 streak | `DEFAULT_VIEW_LOSS_TICKS = 30` @ :505，判定 :612-620 | status+messages **双双不可读**连续 30 tick → `stream-lost`（诚实的 UNKNOWN，绝不是子代死亡裁决；可读 tick 即清零） |
| textless-idle 地板 | :646-655（状态戳）+ async 接线 plugin.ts:2836-2846 / sync 侧 3281-3351 | not-active 但拿不到可报告的终报（无消息/falsy finish/空文本）→ 起地板 streak；跨满一个通知间隔（`resolveNotifyIntervalMs`）→ 判 `stream-lost/unknown`。active 读数或文本候选即清除——RUNNING 子代永远攒不到地板时间 |
| stale 收割（fold B） | async :2847-2888 / sync :3299-3350，核 `dispatch-async.ts:406-469` | 唯一的钟表型终止。每 slice 探 `session.get`：刷新的 `time.updated` 重置锚点（产出中的子代永不收割）；`FORGE_DISPATCH_STALE_MS`（默认 45min，:275）越过 60s 运行地板后 kill 模式 abort 子代并交付唯一诚实终醒；observe 模式只通知 |

**超时语义**：sync 等待窗 `FORGE_DISPATCH_POLL_TIMEOUT_MS`（默认 600s，上限 3600s，:226/229/:240）到点**不杀子代**——arm 后台 tracker 接管（`runAsyncDispatchPoller`）并返回 handoff 通知（plugin.ts:3430-3446）；async 侧无钟表 deadline，只终于文本完成/显式错误/registry kill/地板（plugin.ts:2585-2597 注释契约）。

**重试（fold C）**：error 且 `classifyDispatchError`（dispatch-retry.ts:143，retryable = 5xx/429/overload/auth-contract 文本类）且 attempts < `maxAttempts`（默认 2，上限 10）→ 固定 backoff 10s 后同 agent 原 prompt + resume preamble 重生，继承同一 registry 槽位（async :2695-2797 / sync :3206-2777）。stale 杀、用户 abort、地板发现、deterministic/unknown 类**永不重试**。

**恢复路径**：宿主重启后 `recoverWorkspaceDispatches` / `recoverOneDispatchRecord`（plugin.ts:2369/2388）按 journal 重挂轮询：record alive → re-arm；finished-while-down → 取终报补交 wake；gone → 诚实终结。

### 差距映射：OMO → 我们

| OMO 抄点 | 我们现状 | 差距判定 |
|---|---|---|
| **#5293 poller 反卡死**：status 卡 `running/retry` 但 assistant 文本已出 → 干等 5min+；修法 = 状态活跃但消息流已有产出，5s 宽限后**强制完成** | 完成判定是**与关系**：`!active` 是 completed 的必要条件（:636）。status 卡活跃 + 消息流已有 finish+textful 终报 → 我们会一路轮到 sync 超时 / async 永续轮询（靠 stale 收割兜底，最坏 45min） | **真差距，预防性抄点成立**。我们已是双信号"读"，但裁决是 AND；OMO 是 OR + 5s 宽限 |
| **#5294 晚到 session.error 桥接**：error 事件晚于 poll 检查 → error-store 暂存、poll 消费 | 我们的错误走 **pull 模**：每 tick 都重读 messages 列表，`info.error` 在列表里就必然被下一个 tick 消费（:623-627），不存在"错过事件"问题 | **已有等价物**（pull 天然覆盖晚到）。无需事件 store |
| 5s 宽限参数 | 我们有同位物：`TERMINAL_STABILITY_TICKS=3` × 默认 interval 1000ms ≈ 3s 稳定窗 | 形态等价，可复用稳定窗计数器，不必新引 5s 定时 |

**结论（A）**：双信号已有、错误桥接已有；唯一缺口是 **pollChild 的"status 活跃 ∧ 消息流已出终报"强制完成分支**（OMO #5293 的逆命题）。最小落点：`pollChild` 内加一个与 `stableTicks` 并列的计数器（如 `activeTextfulTicks`：active 读数 ∧ finished ∧ textful 连续 N tick → 返回 completed），一处改动同时覆盖 sync/async 两条路径（共用判定核），且不碰任何 plugin.ts 接线。

---

## B. 嵌套派发工具下发面

### 现状事实【HEAD 基线】

**v1 物化路径：`forgeAgentDef` — `src/dispatch-tiers.ts:90-123`**（所有 forge worker 的权限唯一构造点）

```
:96   const permission = { task: "deny" }          ← 递归封印起点
:101-104  shape === "readonly" → MUTATING_TOOLS 全 deny
          （MUTATING_TOOLS = write/edit/bash/patch/applypatch/apply/multiedit，:25）
:105  Object.assign(permission, def.permission)    ← 用户覆盖
:106  permission.task = "deny"                     ← 覆盖永不解除递归封印（恒强制）
:119  tools: { shell: false, bash: false }         ← 内建 shell 封印
:121  def.model 有值 → entry.model                  ← 模型钉扎
```

**v2 物化路径：`v2PermissionArray` — `plugin.ts:6586-6590`**，应用点 `v2Setup` agent.transform @ :6735

- v1 record（`{"task":"deny",...}`）翻译为 v2 数组 `{action, resource:"*", effect}` + 恒追加 `V2_SHELL_DENY`（:6573，硬规则：永不 deny `"execute"`）。
- 即 **v2 的 task:deny 与 readonly 封印都源自同一个 `forgeAgentDef` 调用**（:6713 `const v1def = forgeAgentDef(...)` → :6735 `agentDraft.permissions = v2PermissionArray(v1def.permission)`）。
- primary forge 条目另走 `v2WithShellDeny`（:6647，幂等追加）。

**子会话创建漏斗：`createChildSession` — `src/dispatch-async.ts:119-144`**

```
body = { parentID, title, ...(questionDeny === true ? { permission: QUESTION_DENY_PERMISSION } : {}) }
```

- `QUESTION_DENY_PERMISSION`（:19-23）= `[{permission:"question", action:"deny", pattern:"*"}]`（OMO 同款 session.create body 注入，注释明言 "OMO parity"）。
- **全部 5 个 spawn 点共用此漏斗**：queue pump（plugin.ts:2218）、恢复重生（:2527）、async 重试重生（:2739）、首次派发（:3099，`questionDeny: runInBackground`）、sync 重试重生（:3232）。
- 子会话的工具面 = 目标 agent 的物化权限图（forge-*）或原生权限图（非 forge 目标）。create body 不携带任何工具/agent 级权限（除 question seal）。

**执行层补充封印（plugin.ts:2970-2980）**：forge worker 调 task 工具 → primary-only 拒绝（"their permission map already denies task" 双保险）；非 forge 会话派发 forge-* 目标 → 跨家族拒绝。

**providerID 感知现状：仅存在于深度通道，与工具面无关**

- `OPENAI_FAMILY` / `ANTHROPIC_FAMILY` / `ZAI_FAMILY`（plugin.ts:557-559）+ `dispatchProviderFamily`（:561）+ `resolveDepthChannel`（:595）——**只**用于 thoughtLevel/budget 翻译（调用点 :5259 v1 chat.params、:6165 v2 等价物）。
- 权限构造（forgeAgentDef / v2PermissionArray / createChildSession）**零** providerID 感知。

### 差距映射：OMO → 我们

**OMO #3630**（anthropic 嵌套派发 400：anthropic 家族子代理再调 `call_omo_agent` 被判第三方计费违规 → `providerID === "anthropic"` 的子代理不下发再派发工具，7 处 guard）。

我们的暴露面拆解：

| 子代类别 | 递归封印现状 | anthropic 400 风险 |
|---|---|---|
| forge-\* worker（v1 + v2） | `task:deny` 恒强制（两路径同源 forgeAgentDef）+ 执行层 primary-only 双保险 | **无**（结构性免疫） |
| 非 forge 宿主 agent（general/build/plan…，knownHostAgents @ plugin.ts:2075；crew 的 Native fallback 规则 :450 明文鼓励这条路） | 原生权限图，可能含 task 工具；我们不下发也不撤销任何工具 | **有**：anthropic 模型的非 forge 子代再派发 → 同款 400 只是时间问题 |

**最小落点判定**：**不需要 v1/v2 各一处**。理由：

1. 材化路径（forgeAgentDef / v2PermissionArray）已封死，无需再加 guard；
2. 暴露面只在**派发时创建的子会话**，而 `createChildSession` 是全部 5 个 spawn 点的单一漏斗——加一个与 `questionDeny` 同形的可选入参（如 `taskDeny`，OMO 精确同款：create body 注入 task deny），一处改动覆盖 sync/async/重试/恢复/队列泵全路径；
3. `questionDeny` 已验证 create body 的 permission 注入在当前宿主（2.3.2）生效（task-shadow 验收过），task deny 可骑同一字段——但需一个 probe 验证宿主对 create body 的 **task** 工具可见性确实响应该注入（question 与 tool 的 deny 通道可能不同，这是唯一不确定性）。

前置条件（决定 taskDeny 何时为 true）：子代模型可解析性——forge 钉扎定义看 `def.model`；Auto worker / 非 forge 目标继承父会话当前模型（需 `session.get(parent).model` 快照，锚定逻辑 `resolveSessionAnchorForPools` 已有同款 client 用法可抄）。家族判定函数 `dispatchProviderFamily` 现成。

**结论（B）**：落点 = `createChildSession` 入参 + 一个派发点的模型解析助手；不碰 v1/v2 材化路径。

---

## C. 并发闸与熔断

### 现状事实【HEAD 基线】

**全景（维度 → 机制 → 位置）**：

| 维度 | 机制 | 位置【HEAD】 |
|---|---|---|
| 会话域 × 池 | 池闸：session anchor → 该 workspace 的池 + 全局 fallback，越池拒绝（fail-open on unknown anchor） | `poolGateRefusal` plugin.ts:1036-1061；crew 合规 belt :1080-1097 |
| 会话域 × 异步派发 | `ASYNC_DISPATCH_CAP = 3`（:2078）：按 ownerSession 数 running registry 行（`inFlightAsyncDispatches` :2085-2097）；满 3 → 进 FIFO 队列（`DEFAULT_DISPATCH_QUEUE_MAX = 10`，:2112）；队满才拒绝（:3018-3029）；槽释放即泵（:2190，泵在 spawn 时重查 belts） |
| crew 波次引擎 | idle 续航 + 两个停机帽：`CREW_NO_PROGRESS_LIMIT = 3` 连续无活动续航轮 → stall（:4237, :4308-4317）；`TRANSPORT_FAILURE_LIMIT = 3`（goal-file.ts:102）连续投递失败 → 停（:4349-4356）；`crewStalled` 标记直到新 crew_begin 清除 | `continueCrewIfEligible` :4275-4358；idle 去抖 `IDLE_DEBOUNCE_MS` 2000（:4193） |
| goal 引擎（对照） | `NO_PROGRESS_LIMIT = 2`（goal-file.ts:103，应用 :4518）+ 同款 transport 帽（:4576） | :4196-4221 共享 map |
| job 预算类 | wake 交付窗 `DEFAULT_WAKE_WINDOW_MS = 600000`、finished 保留 50、tail 8192 字符、registry 总内存 524288、ledger 200 条（job-manager.ts:76-80）；forge_shell `max_wait_ms` 默认 120s 夹紧 600s（plugin.ts:1963）；forge_jobs poll `waitMs ≤ 30s`（:1980） | job-manager.ts + plugin.ts |
| 轮询预算类 | interval 1000ms / sync 窗 600s(≤3600s) / stale 45min + 60s 地板 / 稳定窗 3 tick / 视图丢失 30 tick / journal 上限 200 条 | dispatch-async.ts:225-505、dispatch-journal.ts:60 |
| owner 死亡收割 | `killTree` → `abortChild` + 孤儿记账（async :3458-3461 / sync arm :3402-3406）；队列 wish 不 spawn 直接冲账终结（fold D/E，:2107-2108） | job-manager kill 挂钩 |
| 宿主退出 | host-exit / job-fence（src/host-exit.ts、src/job-fence.ts） | 独立模块 |

**熔断现状：确认不存在。** `git grep -i "providerConcurrency|modelConcurrency|circuitBreaker|per-provider|per-model|rate.?limit"` 在 HEAD 全 ts+mjs 仅命中 dispatch-retry.ts 的**错误分类**（429/rate-limit 文本是**重试理由**，dispatch-retry.ts:38/:9）——即当前系统对限流的行为是"退避后再试"，与熔断（连败即停）方向相反。无 provider/model 任何维度的并发计数、无 `maxLiveDescendantsPerRoot`、无连续失败熔断器。

**派发 ledger 数据结构（熔断器数据源候选）**：

- `dispatch-log.jsonl`（`<workspace>/.opencode/forge/dispatch-log.jsonl`，dispatch-journal.ts:1-2）：一行一次状态迁移（dispatched/queued/started/retry-pending/terminal），load 按 id 去重取最新。字段（:29-57）：`id` / `agent` / `ownerSession` / `workspace` / `state` / `childSessionId?` / `prompt?`（非终态保留，**终态红acted**）/ `attempts` / `createdAt` / `updatedAt` / `questionDeny?` / `description?` / `outcome?`（终态：completed \| error \| stale \| aborted \| stream-lost/unknown）/ `reason?`。
  - **够熔断用**：`agent` + `outcome` + `updatedAt` 可算 per-agent 连败 streak。**两个 caveat**：(1) 无 provider/model 字段——provider 维度熔断需在 journalTerminalRecord 调用点补记或在内存计数器里自持；(2) 轮转策略是**终态记录最旧先丢**（cap 200，:150-165）——从文件回读连败史会被轮转截断，熔断器应持有**内存计数器**、由 `journalTerminalRecord`（plugin.ts:2351）顺手喂，而不是重读日志。
- job `ledger.jsonl`（plugin.ts:694，sink :698-706，1MB 重置）：进程作业面诊断账，与派发熔断关系较远。

### 差距映射：OMO → 我们

| OMO 抄点 | 判定 |
|---|---|
| `providerConcurrency` / `modelConcurrency` map | **真空**。注意落地前置：我们在 spawn 时**不总知道**子代模型（Auto worker 继承父会话、非 forge 目标未知）——闸门需要 forge 钉扎定义直读 + 父会话 `session.get().model` 快照回退（与 B 抄点共用同一模型解析助手） |
| `maxLiveDescendantsPerRoot` | **边际价值低，建议缓**：forge 家族递归被 task:deny 封死（深度恒 ≤1），root 活后代 ≈ per-session cap 已覆盖；只有 B 抄点若选择"非 forge 目标也发 task"的宽松路线时才需要 |
| circuitBreaker（连续 N 败熔断） | **真空但料齐**：数据源（journal 终态 outcome）与喂点（journalTerminalRecord）都在；建议独立小模块（内存计数 + 交 window 内自动复位 + 拒绝文案含恢复语义） |

---

## Change 打包建议

### 高优先三项的独立可回退性

| 抄点 | 改动面 | 可回退性 | 备注 |
|---|---|---|---|
| **A：pollChild 强制完成分支**（OMO #5293 逆命题） | `src/dispatch-async.ts` pollChild 单函数 + 新计数器 + tests/dispatch-async.test.mjs | **优**：纯判定核内改动，一处覆盖 sync/async；回退 = 删分支。plugin.ts **零接线** | 判定核（:541-661）当前不在在途 diff 内；仅测试文件与工人共文件 |
| **B：anthropic 嵌套派发 guard**（OMO #3630） | `createChildSession` 入参 + 派发点模型解析 + probe 验证 create body 对 task 工具可见性的效力 | 良：新可选参数默认关；回退 = 不传参 | **createChildSession（:116-146）正被在途工人编辑**——建议等 crew change 落地后再动，或先做 probe（独立脚本，零碰撞） |
| **C：provider/model 并发闸 + 连败熔断** | 新模块（如 src/dispatch-throttle.ts）+ 两处闸门接入（execute :3020 附近 / 泵 :2190）+ `journalTerminalRecord` 喂点 | **优**：新模块 + 常量区（:2077-2135）接入，env 可关 | 三项中碰撞最低；模型解析助手与 B 共享，建议 B/C 同 change 打包（C 依赖 B 的助手，B 独立可先） |

### 与在途 crew change（fix-v2-crew-surface-drift）的文件重叠对照

`git diff --name-only HEAD`（工作树未提交改动）：

```
plugin.ts
src/dispatch-async.ts
tests/dispatch-async.test.mjs
tests/dispatch-wiring.test.mjs
tests/hierarchical-pools.test.mjs
tests/lib/v2-mock-context.mjs
tests/v2-tools.test.mjs
```

plugin.ts 的 11 个 hunk（`@@` 头，HEAD 行号）：77 / 763 / **2945-2960（runAsyncDispatchPoller 区）** / **3042-3064（taskDispatchTool 区）** / 3867-3901（crewBeginTool）/ 4695-4738（server 入口）/ 5692-5739 / 6441-6527（v2 session client 三处）/ 6839-6924（v2Setup 尾部）。src/dispatch-async.ts 的 2 个 hunk 集中在 **116-146（createChildSession + CreateChildResult）**。

按块的碰撞判定：

- **A = 中低**：判定核 pollChild（dispatch-async.ts:541+）不在 hunk 内；plugin.ts 侧 A 无需接线。共文件但不共区域。
- **B = 高**：唯一推荐落点 createChildSession 正是工人当前编辑区（116-146）；taskDispatchTool execute（3042-3064）也在 hunk 内。**必须串行**。
- **C = 低**：常量区（2077-2135）、journalTerminalRecord（2351）、crew 引擎（4192+）、dispatch-journal.ts（未改）全不在 hunk 内；仅闸门接入点之一（:3020 附近）贴近 taskDispatchTool hunk（3042），接入可选泵侧（:2190，干净）为主。

### 建议打包顺序

1. **先 A**（碰撞最低、纯判定核、独立可回退，测试加在共文件的新 describe 块即可）；
2. **C 的 probe/熔断器模块**可先行（新文件零碰撞），闸门接入等工人落地；
3. **B 押后**至 crew change 合入，createChildSession 稳定后单点进入；B 的 probe（宿主对 create body task-deny 的工具可见性效力验证）可立即做——独立脚本、零源码接触。
