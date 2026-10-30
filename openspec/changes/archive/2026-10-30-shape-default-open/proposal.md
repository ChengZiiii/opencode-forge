# Proposal: shape-default-open

## Why

建池引导（/crew 未配置门 + 缺角色指引）从未教过 `shape` 字段 → 存量池全部缺 shape → 按"缺省 readonly"语义，所有实现工人被封写工具，写活全部绕道 forge_shell（Unity 侧 ta-tool 被派 179 次全程如此）。设计疏漏的根修：**默认翻转为开放写**（兼容一切存量文件），**新建必须显式写 shape**（readonly 是需要主动声明的限制，不是惊喜）。

## What Changes

- 缺省 shape = **write**（开放写权限）；`shape: "readonly"` 必须显式声明才封禁变异工具族。
- 引导流改造：未配置门的模板示例、字段披露、AI 代写规则全部加入 shape——**AI 写的每个 agent 必须带显式 shape**（readonly 给只读角色：reviewer/scout/planner；write 给实现/验证角色）。
- draft 侦察豁免联动：`effectiveReadonlyShape` 默认随翻——无 shape 的 scout **不再**豁免 draft 派发闸，豁免必须显式 readonly。
- 两未归档 change（recon/catalog）delta 中 "shape defaults to readonly" 类措辞 pre-archive 纠偏。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `forge-subagents`：MODIFIED「Materialization as native subagents with a pinned model」（shape 语义翻转 + 场景调整；基线取 postrelease-hardening 未归档 delta 的版本作超集）。
- `crew-harness`：MODIFIED「Unconfigured crew initialization gate」（引导/模板/AI 代写规则加 shape 必填）。

## Impact

- 代码：`src/dispatch-tiers.ts`（物化默认 + `effectiveReadonlyShape` 默认）、plugin.ts 引导文本。
- 测试：默认矩阵翻转、recon 闸（无 shape scout 不豁免、显式 readonly 豁免）、引导模板断言。
- 行为变更：无 shape 存量工人从"工具面只读"变"工具面可写"（与他们实际的 forge_shell 行为一致化）；发布并入 0.17.0（四 change 合并落地）。
- 非目标：不动 forge_shell 封印（readonly-exec-seal 管）；不动池归属（sole-pool-ownership 管）。
