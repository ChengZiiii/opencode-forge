# Design — sole-pool-ownership

## 用户裁定（2026-10-12）

> 池按项目走：项目有 forge.json 就用项目的，没有就落到全局 opencode 配置。担心场景：大工作区没建池、里面一个 git 文件夹自己有 forge.json——麻烦。若该特例难处理，就按 opencode 官方 MCP 配置的严格性：只有工作区 `.opencode/forge.json` 作数，嵌套一律忽略。

→ 采纳严格模型（用户的倾向项），特例直接消失：**工作区所有权 + 全局兜底 + 嵌套忽略**。

## 决策

1. **fallback 不合并**（决策点，已按用户原话定）：工作区有池 → 全局层完全不进该会话的花名册。合并模式（全局通用池 + 项目专用池叠加）被拒绝的理由：回到"并集"就回到串派面；要通用角色就显式配进项目池或复制。**若用户想翻成合并，改这一句即可，其余不动。**
2. **宿主物化 vs 会话可派分离**：物化保持宿主全局（词汇表注册所有见过的池，namespaced 防撞——task 词汇表是宿主级的，这是 opencode 机制约束）；**派发带按会话域闸**（tool.execute.before 现有派发护栏扩展：目标 agent 的池归属 ≠ 本会话工作区池/全局兜底 → 拒 + 三出口文案）。跨项目串派在这一层被物理切断。
3. **嵌套忽略**：与 opencode MCP 工作区所有权同款严格性；子树 BFS 扫描整段删除（大工作区性能担忧同时消失）。
4. **append-only 锚点集废除**：物化集 = 全局层 + 各已见工作区池，全部走既有 mtime 热应用契约——删文件即失池（旧行为是"宿主重启前僵尸池永生"）。
5. **未知会话锚**：belt fail-open 姿态照旧 + 披露（宁可漏拒不可误杀主流程）。

## 拒绝的备选

- 池合并（全局+项目 union）：见决策 1。
- 每 agent 而非每文件的归属：粒度无意义（文件是归属单位）。
- 只靠 /crew 模板提示"别派别家的"（纯软约束）：拒绝——这正是事故根因，必须机械闸。

## 同 requirement 叠加策略

- 「/crew command discipline」：与 crew-contract-relay 携带**逐字相同**的超集文本（roster 会话域化 + 契约中继），归档顺序无关地收敛。
- 「Unconfigured gate」：本 change 版本为**超集**（新池模型 + shape-default-open 的 shape 教学）——归档顺序 shape-default-open → 本 change。

## 影响面

- `src/forge-config.ts`：`createPoolResolver` 大改（去 BFS/锚点并集；工作区归属解析 + 全局兜底；物化集热应用）。
- `plugin.ts`：派发护栏扩会话域闸；/crew 模板 roster 段；未配置门文案。
- 测试：`hierarchical-pools.test.mjs` 大改（子树扫描用例删除，新增：嵌套忽略/跨工作区拒/fallback 不合并/删文件失池/命名空间防撞）；`forge-subagents-wiring` /crew 模板断言。
- README 池归属段、AGENTS 表格两行重写。
