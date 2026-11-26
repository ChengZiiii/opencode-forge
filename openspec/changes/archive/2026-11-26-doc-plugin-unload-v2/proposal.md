# Proposal: doc-plugin-unload-v2

> 2026-11-25。四件事 A / B / C / D 由用户授权我定（原话：“abcd我觉得按你
> 分析我的想法然后自己决定吧，记得把决定的结果告诉我到底选择了什么，不然
> 到后来搞错了又得返工”）。A 定为**乙**：只改注释、规格和那条 E2E 腿，那段
> 代码不删。本 change 是它的约定，随 0.34.1 发。**不改任何运行时代码。**

## Why

验收门的 `e2e-c1-D1` 从 0.33.0 到 0.34.1 每一版都挂着同一笔账（D6 记账）。
工作区规则：不得连续两个闭环挂同一笔账。

账的来源：规格和代码注释说“插件 `dispose` 在上下文回收时触发，杀掉进程型
作业、豁免派发行”。E2E 腿 D1 照这个去验——等驱逐目录之后，控制进程树被杀。
可是在宿主 2.4.0 上控制进程树每次都活到自然结束，这条腿就永远“结论不明”。

### 事实（2026-11-25：对照 2.4.0 源码 + 沙箱实况）

| | v1 宿主 | v2 宿主（2.4.0） |
| --- | --- | --- |
| 插件入口 | 插件函数，返回 `Hooks` | `default.setup`（可以是异步的） |
| 卸载时的清理 | `Hooks.dispose()` | `setup` **解析出来的**那个函数 |
| forge 清作业的那段代码 | 在 `Hooks.dispose` 里，v1 宿主卸载插件时会跑 | **永远不跑**：v2 加载器只读 `default` 上的 `id` 和 `setup`（或 `effect`），不碰 v1 的钩子对象 |
| forge 的 v2 清理函数 | — | `v2Setup` 末尾返回的那个：只拆自己这个实例的注册、停自己的事件循环，**不碰任何作业** |

依据：

1. `@opencode-ai/plugin` 1.x 的类型声明：`Hooks { dispose?: () => Promise<void>, … }`
   （仓库里装着的 `node_modules/@opencode-ai/plugin/dist/index.d.ts`）。
2. opencode 2.4.0 `packages/plugin/src/promise/plugin.ts`：
   `setup: (context) => Promise<Cleanup | void> | Cleanup | void`——异步 setup
   是正式契约。
3. 2.4.0 `packages/plugin/src/promise/adapter.ts`（acquireRelease）：登记的清理
   函数是 `setup` **解析出来的值**，是函数才登记。
4. 2.4.0 `packages/core/src/plugin/module.ts`：加载器只认 `default` 上的
   `id` + `effect|setup`。
5. 官方 v1→v2 迁移指南的对照表：v1 的 “returned `dispose()` hook” 对应 v2 的
   “cleanup function returned by `setup`”。
6. 沙箱实况（2026-11-24T08:36Z，宿主 2.4.0）：带活作业和在飞派发的目录被
   驱逐（HTTP 204）后，两个控制进程树都跑到自然结束，`plugin dispose hook`
   探针行没有出现，派发正常完成并送达唤醒。探针日志（截至 11-25 00:16 本地
   时间）：`v2 idle` 行 585 条，`plugin dispose hook` 行 0 条。

### 更正

状态页曾把原因写成“2.4.0 只认 `setup` **同步**返回的函数，而我们的
`v2Setup` 是异步的”。**这句是错的**（见依据 2、3）：异步 setup 返回的清理函数
在 2.4.0 上是会被调用的。“清作业的那段代码在 v2 宿主上永远不跑”这个结论不变，
原因不同：它根本不在 v2 的清理函数里。

## What Changes

- **规格**（`job-supervisor`，需求 “Job ownership and lifecycle”，MODIFIED，只在本 change
  的 delta 里；主规格归档时才合并）：
  写明 `dispose` 是 v1 清理钩子、是插件卸载能终止作业的**唯一**路径，v2 宿主
  没有这个钩子；v2 宿主上插件唯一的卸载清理只拆自己的注册、停自己的事件
  订阅，不终止任何作业和派发行。原场景 “Plugin dispose spares in-flight
  dispatch rows” 的触发条件改成 v1 宿主卸载插件；新增场景 “A plugin unload
  on a v2 host terminates no job”。
- **注释**：`plugin.ts` 里 v1 `dispose` 钩子和 v2 清理函数两处；两处测试注释
  里同一句错误说法（`tests/dispatch-wiring.test.mjs`、
  `tests/dispatch-journal.test.mjs`，只动注释）。
- **用户文档**：README “Ownership” 段、`docs/architecture.md` 第 9 条。
- **E2E 腿 D1**（沙箱驱动 `11-dispose-e2e.mjs`）：改为断言 2.4.0 的真实行为——
  驱逐之后被驱逐目录的控制进程树活到自然结束（另一目录的对照作业起来了也算
  在内）；清作业的钩子没跑，且探针在驱逐**之前**被证明是活的（出现 `v2 idle`
  行）；派发日志行在驱逐后没被碰；台账里没有 dispose 行；恰好一次带金丝雀的
  唤醒；日志终态不是 `aborted`。
- **验收门** `reports/e2e/acceptance-gate.mjs`：`e2e-c1-D1` 去掉记账分支，只有
  通过和失败两种结果；判通过还要求驱动记录的 `hostContract` 能对上（探针活着、
  控制进程跑到底、钩子没跑、派发行没被碰）。
- **新增单测** `tests/v2-setup-cleanup.test.mjs`：`v2Setup` 解析出清理函数；它
  拆掉本实例的注册、停掉事件订阅；不终止任何作业和派发行。
- **不改**：任何运行时代码。v1 `dispose` 钩子原样保留（v1 宿主上它是活的
  契约）；v2 清理函数原样保留（它本来就是官方形状）。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `job-supervisor`：需求 “Job ownership and lifecycle” 写明 v1 `dispose` 钩子的
  身份、v2 宿主上“没有这个钩子”以及 v2 清理函数的范围（只拆自己的注册、停
  自己的事件订阅，不终止作业）。

## Impact

- **代码**：只改注释，加一个单测文件。`plugin.ts` 的可执行语句逐字节不变
  （`dist` 里除注释外的内容不变）。
- **规格**：只动 `job-supervisor` 一条需求（MODIFIED，带全量场景）。
  `forge-subagents` 里 “Plugin `dispose` SHALL NOT be a registry-kill trigger
  for dispatch rows” 那条不动——它说的是“一旦 dispose 触发，派发行不动”，
  仍然成立。
- **验收门**：`e2e-c1-D1` 从“记账”变成实打实的一项；0.34.1 的基线
  33 过 / 0 败 / 1 记账，本 change 之后应为 34 过 / 0 败 / 0 记账。
- **不影响**：v1 宿主、v2 宿主上的运行时行为、npm 依赖、配置项、文件账本、
  工具接口。
- **没有验证的、如实记账**：
  1. **v1 宿主上 `dispose` 会被调用**——只有依据 1 和 5（类型声明与官方文档），
     本仓库没有 v1 宿主可以实跑。
  2. **宿主空闲清扫驱逐一个带活 `forge_shell` 作业的目录**（无人触发的驱逐），
     驱逐之后作业的唤醒能否在目录重新加载后补送——没有单独验过。按本 change
     查清的机制，卸载不会杀作业；但唤醒依赖的空闲钩子随实例一起被拆掉，
     重新加载后是否补送是另一个问题。沙箱需要一台把空闲超时调短的宿主才能
     验，记为待办。
