# Tasks — sole-pool-ownership

- [x] 1. `src/forge-config.ts`：池解析器重构——删除子树 BFS 扫描与 append-only 锚点并集；新增会话工作区归属解析（向上最近 `.opencode/forge.json`）+ 全局层兜底（有池不合并）；物化集 = 全局 + 各已见工作区池，全走 mtime 热应用（删文件失池）
- [x] 2. `plugin.ts`：task 派发护栏扩会话域闸——目标池归属非本工作区池/全局兜底即拒，文案点名来源池路径 + 三出口（去那个工作区开会话 / 配进本工作区 / 配进全局层）；未知会话锚 fail-open + 披露
- [x] 3. `plugin.ts`：/crew 模板 roster 段会话域化（本会话可派池带来源路径在前，他池标 NOT dispatchable 在后）；crew_begin 注册输出披露同步；未配置门文案改sole-ownership + 全局兜底 + 嵌套忽略
- [x] 4. 测试：`hierarchical-pools` 重构（删子树用例；新增嵌套忽略/跨工作区拒/兜底不合并/删文件失池/同 id 命名空间防撞/热应用）；`forge-subagents-wiring` roster 与派发闸矩阵
- [x] 5. README 池归属段（sole ownership 模型 + 兜底语义 + 嵌套忽略）与 AGENTS 架构表两行重写
- [x] 6. `bun run typecheck` + `node --test tests/*.test.mjs` 全绿 + `bun run bundle`；openspec validate --all 通过
