# Design — shape-default-open

## 决策

1. **默认翻转而非存量迁移**：缺省 shape = write。理由：一切存量池（plugindev、sorenunitylabs，以及用户手写的任何文件）按旧默认全部被隐性封写，与实际用法（写活绕 forge_shell）不符——翻转默认让"工具面权限"与"exec 通道实际能力"一致化，且零迁移成本。readonly 从此是**主动声明的限制**，不是惊喜。
2. **新建强制显式 shape**：只在"教学面"强制（未配置门模板、AI 代写规则）——插件运行时对缺 shape 的条目不告警不拒绝（那会重新惩罚存量），教学面写死规则：AI 写的文件每个 agent 必须带 shape。
3. **draft 侦察豁免联动翻转**：`effectiveReadonlyShape` 的判定基准从"shape ≠ write"翻转为"shape === 'readonly'（显式）"。效果：无 shape 的 scout 不再豁免（fail-closed 正确方向——豁免是放行，必须显式）；显式 readonly 的 scout 照旧豁免。这同时修掉一个潜在漏洞：旧语义下任何无 shape 条目都算 readonly 从而豁免 draft 派发闸。
4. **基线取 postrelease-hardening 未归档版本**（其 Materialization 重写含 patch 族场景）；归档顺序 postrelease → 本 change。

## 备选与拒绝理由

- 存量文件批量补 shape：拒绝——翻转默认即可达到同等效果，批量改用户文件违反"插件永不写 forge.json"红线。
- 运行时对缺 shape 出 warn finding：拒绝——噪音；教学面强制足够（新文件都带，旧文件靠默认开放已是正确语义）。

## 归档顺序依赖

- postrelease-hardening 先归档（本 delta 的 Materialization 基线即其版本）。
- **sole-pool-ownership 后归档**（其 Unconfigured gate 重写以新池模型为基础，携带本 change 的 shape 教学条款作超集）。

## 影响面

- `src/dispatch-tiers.ts`：物化默认权限 + `effectiveReadonlyShape` 判定（两处单点：`MUTATING_TOOLS` 家族常量不动，只动默认方向）。
- `plugin.ts`：/crew 未配置门模板文本 + 缺角色指引文本。
- 测试：`dispatch-prompt`（默认矩阵翻转）、`forge-subagents-wiring`（recon 闸三态：显式 readonly 豁免 / 无 shape 不豁免 / write 拒）、`crew-gate` 模板断言加 shape。
- 文档：README 权限段、AGENTS 关键机制 §2。
