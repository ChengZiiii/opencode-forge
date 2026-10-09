# Design — allow-readonly-recon-during-plan-draft

## 背景与不变量

draft 禁写守护的不变量是：**draft 待审期间工作区不变化、执行不偷渡进决策期**。现状用工具名类（`WRITE_TOOLS` 含 `task`）做代理实现，把"派一个有能力写的东西"和"派发"混为一谈。本 change 把 `task` 从整类拒绝中拆出，改为按**派发目标的有效形状**闸控；其余写类工具的无条件拒绝一字不动。

设计公理（与 crew 的"注册前侦察自由"先例统一）：**无变异相位里的派发闸 = 目标可证明不可变异**。

## 决策

### D1 闸门判据 = 有效形状，不是声明形状

`effectiveReadonlyShape(def)`：`def.shape !== "write"`（缺省 readonly）**且**最终物化 permission map 上 `write`/`edit`/`bash` 全为 `"deny"`——即定义中无 permission override 把三者抬离 deny。`"ask"` 也算抬离（fail closed：ask 意味着用户逐次裁量的写通道，不是"证明不可写"）。`task` 恒 deny 不参与判定（恒真）。

理由：`forgeAgentDef` 允许 `def.permission` 覆盖形状默认（dispatch-tiers.ts:60 `Object.assign(permission, def.permission ?? {})`），声明形状 ≠ 实际能力。纯函数落 `src/dispatch-tiers.ts`，与 `MUTATING_TOOLS` 同源。

- 备选"只看 `shape` 字段"被否：一个 `shape` 缺省但 `permission: {write: "allow"}` 的工人会被误豁免——不变量破洞。

### D2 执行点 = tool.execute.before 主闸，permission.ask 侧带不跟随豁免

形状闸插在 write-class draft ban **之前**（plugin.ts:2418 那段之前、族分区护栏 2375 之后），复用护栏已有的 `output.args.subagent_type`（fallback `agent`）提取缝 + `resolvePools()` 现解析（热应用契约：每次调用重走池解析，文件真相即刻生效）。目标解析成功且有效 readonly → 跳过写类 ban 放行；否则抛新拒绝信息。

`permission.ask` 侧带（plugin.ts:2585 对写类无条件 deny）**保持不动**。后果：用户配了 `task: "ask"` 的宿主上，ask 先于 before 触发 → readonly 侦察也被拒。这是刻意的 fail-closed 降级——降级方向恰好是今天的现状（全拒），belt 不需要理解目标形状；主 enforcement（before 钩子，TUI/run 双模式生效，add-plan-harness 既定模式）承载全部豁免逻辑。

- 备选"两侧带都实现形状解析"被否：permission.ask 的 input 不稳定携带 args（工具名经优先级链解析，1.18.32 已验证 headless 根本不触发），在带上做目标解析是给最脆弱的一层加复杂度。

### D3 拒绝信息携带名册（可行动指引）

拒绝文案列出 `resolvePools()` 现解析的**有效 readonly** 物化名清单（如 `forge-research, forge-scout`）；名册为空时指引"在 forge.json 定义一个 readonly worker 以启用 draft 期侦察"。与既定拒绝文案风格一致（指路不截停）。无 forge.json 的部署：名单为空 → 全拒 = 现状，仅信息更可行动，零行为回退。

### D4 不变量强度不降（三层论证）

1. **物化 permission map 硬 deny**：readonly scout 的子会话对 write/edit/bash 是工具层硬拒（宿主尊重文件配置条目的 permission；E2E 无视注入 tools map 的 build 上此层的实证列入 verify——若失守，第 2 层仍持住）。
2. **子会话 ambient 禁写**：task 子会话是独立 sessionID，但 `session.created` 事件播种 + `resolveActivePlan` 目录兜底重绑（AGENTS.md 机制 1）使同一 worktree 的 draft 对子会话同样生效——scout 在会话内尝试写仍被拒。apply 阶段以测试实证此路径。
3. **forge_shell ask 门 = 同一信任姿态**：scout 手里的 forge_shell 逐调用挂 `context.ask`（plugin.ts:1270），与主 agent draft 期跑 forge_shell 完全同姿态——"用户可见，非不可能"。豁免不引入任何主 agent 自己没有的信任面。

递归物理不可能：`task: deny` 恒强制（dispatch-tiers.ts:61），scout 不能再 spawn——不存在"链式绕过"。

### D5 fail-closed 清单（全部维持拒绝）

- 目标缺失（`subagent_type` 与 `agent` 均无）；
- 目标非 forge 物化名（原生 general/explore、拼写错误、任意字符串）；
- resume 形态（`task_id` 不带 target——闸门无从解析，宁拒勿放）；
- 有效形状不成立（write 形状；或 permission override 抬离任一变异工具，含 ask）。

### D6 非 forge 说话者零新增能力

闸门按目标键控、随写禁会话级生效（与 D12 同域）。但族分区护栏在 before 钩子里先决（非 forge 会话派 forge-* 硬拒，plugin.ts:2375），而原生目标永不满足有效 readonly——两条路对非 forge 轮都是拒绝，行为与豁免前逐字节相同。tool-partition delta 显式声明这一点。

### D7 模板修正（消除劝退）

`/plan` 模板第 1 步改为：write 工具与 bash 在 draft 期禁用；侦察（pre-draft 与 draft 迭代期）可派 effective-readonly scout 收证据、不烧主上下文；write 形状工人等 plan_approve。wiring 测试断言模板含豁免句。

### D8 无新配置钮

豁免由构造保证不变量（D4），不需要逃生门。`agent["forge"].disable` 一键回原生照旧整体生效。不加 `plan.*` 配置项——配置面零增长。

## 明确不做（Non-Goals）

- **crew pending 闸不套形状豁免**：pending 是"用户三选一执行模式"的决策停点，语义是停顿不是防变异；侦察自由在注册前（既定行为）已覆盖。
- **不解禁原生 explore/general**：readonly-by-convention ≠ 插件可证明。原生 agent 的工具面是宿主配置，不是物化时钉死的 permission map。
- **不做独立 plan_recon 工具**：复制原生 task 面、丢宿主 TUI 子代理可见性、第 16 个工具——一个闸门条件已足够。
- **不做逐次 ask 豁免**：规划环频繁弹窗训练条件反射 Allow，且形状保证已覆盖 ask 能防的一切。

## 风险与缓解

| 风险 | 缓解 |
| ---- | ---- |
| E2E 宿主无视注入条目 → 物化 permission 失守 | 第 2 层 ambient 禁写持住（目录兜底）；verify 阶段实证并记录结论 |
| 子会话目录兜底未生效（如子会话 worktree 解析差异） | apply 阶段专测；若失守，豁免仍受第 1 层+forge_shell ask 门保护，不变量退化为"用户可见"而非"不可能"——与主 agent 现状同档，如实记入 verify |
| 名册空（无 forge.json）→ 用户以为坏了 | 拒绝信息明确指引定义 readonly worker（D3） |
| `task_id` resume 误伤（readonly scout 的续派） | 接受：draft 期 resume 拒绝，重新起一次同步派发即可；fail-closed 优先 |
