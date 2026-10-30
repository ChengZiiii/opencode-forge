# Proposal — allow-readonly-recon-during-plan-draft

## Why

draft 禁写把 `task` 整个归进写类（`WRITE_TOOLS` 含 task，`tool.execute.before` 对整类硬拒），派发能力在 draft 存续期完全消失。但规划恰恰是最需要"外包侦察"的相位：plan 的质量线要求 Context Findings 带 file:line 证据，而拿证据的广度侦察最不该烧主会话上下文——draft 是设计上长存的（用户按自己节奏审、反馈→改稿可能多轮），每轮反馈后补证据都会撞墙。现状有两个伤害：

1. **draft 存续期硬死**：反馈迭代环（"去查一下 X 是怎么配置的"→scout→改稿）被一刀切拒绝；
2. **pre-draft 也被劝退**：`/plan` 模板第 1 步写 "explore with read/grep/glob only — ... subagents are DENIED"，技术上 pre-draft 派发合法，实际上模板把模型教成了不派。

根因是**代理分类**：派出去的子会话工具面不可控，所以"派发≈潜在写"→全禁。但 forge 已有一套可证明不可变异的机制——readonly 形状工人在物化时被钉死 `write/edit/bash: deny` + `task: deny` 恒强制（`src/dispatch-tiers.ts`）。禁令该约束的是不变量（draft 待审期工作区不变化、执行不偷渡进决策期），不是工具名。**禁"派一个有能力写的东西"，而不是禁"派发"本身。**

## What Changes

- **draft 期 `task` 派发从整类硬拒改为目标形状闸**：目标解析为**有效 readonly 形状**的 forge 子代理（`shape` 非 "write" 且定义中无 permission override 把 write/edit/bash 抬离 deny）→ 放行为侦察派发；其余目标（write 形状工人、原生 agent、缺失/不可解析目标、resume 不带目标）→ 维持写类拒绝，**拒绝信息列出当前可派的有效 readonly 名册**（池解析现算，空名册时指引去 forge.json 定义）并指向 plan_approve / /plan discard。
- **放行不削弱不变量**（三层）：物化 permission map 硬 deny 是第一层；子会话自身命中 session 级 draft 禁写（目录兜底重绑）是第二层；scout 手里的 forge_shell 逐调用挂 ask 门——与主 agent draft 期跑 forge_shell 同一信任姿态（用户可见，非不可能），强度对齐而非下降。递归派发物理不可能（task 恒 deny）。
- **fail-closed 边界**：`permission.ask` 侧带不跟随豁免（用户配 `task: "ask"` 的宿主上 readonly 侦察也被拒，降级方向=今天的现状）；未知/不可解析目标一律拒；resume（task_id 形态不带 subagent_type）拒。
- **非 forge 说话者零新增能力**：闸门按目标键控、会话级生效，与禁令同域；族分区护栏（非 forge 派 forge-* 硬拒）先决，原生目标永不在豁免集——非 forge 轮在 draft 期派发能力与现状逐字节相同。
- **模板修正**：`/plan` 第 1 步侦察句改写——write 工具与 bash 仍禁；侦察可派 readonly scout（含 pre-draft 与 draft 迭代期），write 形状工人等批准。消除对 pre-draft 合法派发的劝退。
- **crew pending 闸不动**：那是用户执行模式决策停点（语义不同），不套用形状闸。
- **无新配置钮**：豁免由构造保证不变量，无需逃生门；`agent["forge"].disable` 一键回原生照旧覆盖一切。

## Capabilities

### New Capabilities

（无——本 change 是既有禁写语义的收敛，不引入新能力域。）

### Modified Capabilities

- `plan-harness`: 「Hard write ban during draft」修订——`task` 从整类拒绝改为目标形状闸：有效 readonly forge 子代理放行（侦察豁免），其余目标维持写类拒绝且拒绝信息携带 readonly 名册；其余写类工具（edit/write/bash/patch 族）无条件拒绝语义不变。
- `forge-subagents`: 「Native-task dispatch surface」修订——plan-draft 互操作从"继承 spawn 类整禁"改为"形状门控继承"：draft 期 task 到有效 readonly 形状的 forge 子代理作为侦察派发放行，到 write 形状工人仍被写类拒绝；插件不新增独立派发拒绝（闸即 plan harness 的写禁语义本身）。
- `tool-partition`: 「Session-scoped safety interop for active drafts」修订——形状豁免随写禁语义同步会话级生效；显式声明非 forge 轮在 draft 期派发能力零变化（族分区先决 + 原生目标永不豁免）。

## Impact

- `plugin.ts`：`tool.execute.before` ——在 write-class draft ban 之前插入 task 形状闸（复用 2375 行族分区护栏的 `output.args.subagent_type` 提取缝 + `resolvePools()` 热解析）；拒绝文案带名册；`/plan` 模板第 1 步文案改写。`permission.ask` 不动。
- `src/dispatch-tiers.ts`：新增纯函数 `effectiveReadonlyShape(def)`（有效形状判定：shape 非 write 且最终 permission map 上 write/edit/bash 全为 deny；`ask` 算抬离，fail closed）。
- 测试：`tests/`——dispatch-tiers 单测（默认 readonly/write 形状/逐工具 override 抬离含 ask/无 override）；wiring 单测（draft+readonly 放行、draft+write 拒且带名册、draft+原生/无 target/resume 拒、无 draft 全放行、override 后拒、模板含新侦察句）。
- 子会话第二层 belt 实证：task 子会话内 write/edit/bash 在 draft 期仍被 session 级禁写拒绝（目录兜底重绑路径）——单测或沙盒验证。
- 文档：README Design stance（禁写条目的形状豁免说明）、AGENTS.md 架构行与关键机制 2。
- 顺序：无未归档 change（`openspec list` 已确认），基线干净。
- 行为兼容性：无 forge.json 的部署名册为空 → 名单为空 → 全部派发照旧拒绝（= 现状，仅拒绝信息更可行动）；E2E 宿主（无视注入 tools map 的 build）上物化 permission map 是否被宿主尊重需在 verify 阶段实证——若不被尊重，第二层（子会话 ambient 禁写）仍持住不变量，结论记入 verify 笔记。
