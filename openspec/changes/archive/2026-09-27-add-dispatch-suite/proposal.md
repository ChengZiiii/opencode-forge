# Proposal: add-dispatch-suite

> 2026-09-27 合并版：原三期路线（add-dispatch-core / add-dispatch-waves / add-crew-harness，
> 见 `dispatch-wargame.md` §7）按用户决策合并为单一 change，一次性交付完整多模型派发套件；
> 内部仍按阶段门推进（见仓库根 `dispatch-tdd-process.md`），回退仍是 `dispatch.disable` 一键关。

## Why

forge 目前是单 agent 单模型工作面：主 agent 想把一块工作交给"更便宜/更快/更强"的模型
时没有任何机制，只能自己干。社区方案（oh-my-openagent）验证了"按任务类型路由到不同
模型+推理深度"的价值，但其持久化 agent×模型绑定矩阵配置负担重。探针（本目录
`probe/FINDINGS.md`，opencode 1.18.32 实机）已验证：插件可经宿主自带 client 按**每次
调用**动态创建指定模型的子会话、`chat.params` 钩子对 HTTP 会话触发（推理深度可注入）、
agent 级权限在真实 provider 上被强制执行——动态绑定（用户策展曝光表 + 主 agent 战术
选择 + 插件执法）在当前宿主版本即可全量落地，无需任何静态中间层。设计推演全文见
仓库根 `dispatch-wargame.md`。

单次同步派发只覆盖"偶尔外包一块工作"；并行波次（后台派发 + 完成唤醒）与 `/crew`
编排命令才能覆盖"把一个目标拆给一组模型干完再汇合"的工作流，故三期并入同一 change
一次做完，避免中间态 API 反复迁移。

## What Changes

**派发核心（原 add-dispatch-core）**

- 新增**能力标注名册（roster）**：每条记录以完整 `provider/model` 身份为键（同名跨
  provider 即不同条目），声明 `expose`（该身份对派发开放的推理档位，原生档名透传，
  缺省 = 原生梯全量）、可承担的 tier、成本档。零配置起步，用户经 plugin options 覆盖。
- 新增 **`forge_dispatch` 工具**：入参 `{prompt, profile(tier), depth?, background?}`；
  解析 = **精确匹配**（expose 不含该档 → 结构化错误 + 完整菜单，系统内不存在任何自动
  钳制路径）；经 `input.client` 在宿主实例上建子会话（带 tier agent 定义）并以请求体
  指定模型，`chat.params` 注入该会话的推理档位；同步模式返回如实披露对象（实际
  model/depth、tokens 真值、cost 自算、缺价目报 null）。
- 新增 **tier 物化**：config hook 运行时注入少量 `forge-<tier>` 子代理（hidden、
  `mode: subagent`、**永不写 model 字段**、deny 式 permission 含 `task: deny` 物理禁
  递归）；不落盘，卸载即消失。默认四 tier：scout（只读）/ build（可写）/ review
  （只读+测试）/ quick（机械小改）。
- 新增**启动期校验清单**：死键告警、expose ⊆ 原生梯（拼写错报错；未知 provider 逐字
  接受 + 未验证告警）、tier defaultDepth 死档 → depth-required 降级（绝不静默换档）、
  自定义 tier 缺 shape 默认 readonly、tier id 字符集与 profiles 引用检查。

**并行波次（原 add-dispatch-waves）**

- `forge_dispatch` 增**后台模式**（`background: true`）：提交时急解析（菜单/钉扎错误
  同步返回），立即返回 `{dispatchId, resolved, queuedAt}`；全局并发槽（默认 4）同步/
  后台共享。
- 新增**完成唤醒**：父会话空闲时注入合并式 `[forge:dispatch-complete]` brief（防抖、
  不打断活跃回合、每终态恰一次、与 goal 续跑 brief 共存合并为单次再提示）。
- 新增 `forge_dispatch_list`（在飞 + 近期结果，compaction 后恢复）与
  `forge_dispatch_kill`（best-effort 中止 + 账本如实）；run 模式后台限制如实披露。

**crew 编排（原 add-crew-harness）**

- 新增 **`/crew <objective>` 命令**：当前会话内进入编排纪律（单主体，不切 agent）——
  分解为波次（每子任务带 prompt/tier/depth/验收证据）→ 后台派发、按完成 brief 节奏
  推进（不洪水）→ 逐子任务证据验收，失败至多一次有界重试 → 完成报告；draft 期拒绝、
  每会话单 crew、宿主重启即诚实死亡（账本留痕）。
- 新增 **`crew_close` 完成门**：ask 级确认；按派发账本交叉核对（缺 verdict/证据拒关、
  失败两次必须以 FAIL 呈现、不许静默丢）；通过后摘要入账本。

**公共**

- 有界派发账本 `<tmp>/opencode-forge/dispatch/`（风格同现有 job ledger），事件覆盖
  解析/结果/超时/kill/lost-on-exit/crew 摘要。
- plan draft 期间 `forge_dispatch` 与 `/crew` 均拒绝（与 plan-harness 写禁同类）；
  一键回原生（`agent["forge"].disable` 或 `dispatch.disable`）时 tier、工具、命令、
  唤醒引擎全部摘除。

## Capabilities

### New Capabilities

- `dispatch`: 多模型派发——能力标注名册（曝光表 + 精确匹配解析，无翻译无钳制）、
  forge_dispatch 工具契约（同步 + 后台、档位注入、如实披露、超时与并发）、完成唤醒
  引擎（合并 brief、与 goal 共存）、kill/list 辅助工具、tier 物化（权限面载体）、启动
  期校验、与 plan/一键回原生的互操作。
- `crew-harness`: `/crew` 编排纪律（分解→波次→证据验收→完成报告，单主体、有界重试、
  诚实死亡）与 `crew_close` ask 级完成门（按账本交叉核对）。

### Modified Capabilities

（无——draft 禁派/禁 crew 与一键回原生以 dispatch/crew 侧需求表达，与
forge-agent/plan-harness 现有需求语义一致，不改动其条文。）

## Impact

- 代码：`plugin.ts`（工具/钩子/tier 注入/唤醒引擎/命令接线）+ 新纯函数模块
  `src/dispatch-roster.ts`、`src/dispatch-resolver.ts`、`src/dispatch-client.ts`、
  `src/dispatch-registry.ts`（后台注册表状态机）+ 单测 `tests/dispatch-*.test.mjs`、
  `tests/crew-*.test.mjs` + `dist/` 重建。
- 运行时痕迹：`<tmp>/opencode-forge/dispatch/`（有界账本）+ models.dev 价目缓存
  （只读拉取）；crew 状态仅内存（无新用户数据目录）。
- 用户配置：零写入；plugin options 增 `dispatch` 块（roster/tiers/maxConcurrent/
  timeoutMs/disable）。
- 依赖：无新增运行时依赖（HTTP 走宿主 `input.client`，fetch 原生）。
