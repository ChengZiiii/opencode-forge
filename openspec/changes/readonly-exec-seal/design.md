# Design — readonly-exec-seal

## 用户问题直答：需要大重构吗？

**不需要。** 三档选项：

| 方案 | 规模 | 封禁强度 | 结论 |
| --- | --- | --- | --- |
| D1 命令分类闸（本 change） | 中：纯函数分类器 + forge_shell `tool.execute.before` 一处挂闸 | 尽力而为（覆盖重定向/已知写命令/工作区路径写入；间接写入绕过）——belt-in-depth | **采纳** |
| D2 readonly 的 forge_shell 全量 ask | 小 | 形式上强 | 拒绝：折断合法只读 shell 用户（侦察工人 rg/git log/node 读求值全要确认框），日常不可用 |
| D3 OS 级沙箱（写时重定向/影子副本/容器） | 大：win32+POSIX 双实现、路径语义、进程树 | 真封死 | 拒绝：这才是"大重构"，收益不成比例；明确不做并记录 |

诚实定位：D1 不是沙箱，是把"工具面封禁"的洞从"完全敞开"收到"显式构造才绕过"。绕过面 README 逐字公布。

## 决策

1. **分类是纯函数**：输入命令字符串（+ workspace 相对路径表），零 fs 访问，可注入单测。分类失败 → 读类放行（通道上 fail-open，与 belt 拒绝面 fail-open 姿态一致；工具面 deny 仍是第一道）。
2. **挂闸点**：plugin.ts forge_shell `tool.execute.before` 现有主闸旁，按 sessionID→agent 族映射（三源采集，已有基建）查 effectiveReadonlyShape——**显式 readonly 才封**（与 shape-default-open 翻转后的语义咬合：缺 shape = write 不封）。
3. **finding 有界**：每 session 每指标类一次，不刷屏。
4. **不封 primary**：主 forge 会话永不封（它本来就没有 readonly 形状）。

## 归档顺序依赖

- **shape-default-open 先归档**（"explicit readonly" 语义由它定义；本 delta 的场景已按翻转后语义书写）。

## 影响面

- 新增 `src/exec-classify.ts`（纯函数 + 指标表导出给 README 生成对照）。
- `plugin.ts` 挂闸一处；README 新增封禁指标表 + 绕过面披露；AGENTS §7。
