# Proposal: readonly-exec-seal

## Why

readonly shape 只封工具面（write/edit/bash/patch 族），**不封 forge_shell**——readonly 工人照样能经执行通道改世界。Unity 侧实证：ta-tool（readonly 形状）被派 179 次，全部 Unity 代码写入都走 forge_shell。工具面分区存在一个明确的洞。

## What Changes

- tool-partition 新增 requirement：**effectiveReadonlyShape 为显式 readonly 的会话，其 forge_shell 执行通道对"写类命令"封禁**——读类命令照常放行；写类（重定向、已知写 cmdlet/命令、工作区路径写入）拒绝并出 finding（点名 readonly、指路 shape: write）。
- 分级诚实披露：分类是尽力而为（belt-in-depth，不是沙箱），README 公布已覆盖的写入形态与已知绕过面。
- 与 shape-default-open 组合：翻转后缺 shape = write 不受影响；只有**显式** readonly 被封——语义干净（你声明了只读，就真的只读）。

## Capabilities

### New Capabilities

（无新 capability；`tool-partition` 新增 requirement）

### Modified Capabilities

- `tool-partition`：ADDED「Readonly workers execute on a sealed supervised-exec channel」

## Impact

- 代码：新增纯函数命令分类模块（可注入、单测覆盖）+ plugin.ts forge_shell `tool.execute.before` 按 sessionID→agent 族映射查 effectiveReadonlyShape 挂闸。
- 测试：读类放行 / 重定向拒 / 写 cmdlet 拒 / 相对路径写入拒 / write 形状不受影响 / draft ask 姿态不叠加变化 / finding 文案断言。
- 行为变更：显式 readonly 工人失去 forge_shell 写能力（正是目的）；发布并入 0.17.0。
- 非目标：不做 OS 级沙箱（真封死需 win32/POSIX 双实现的大重构，明确不做——设计文档记录该选项与拒绝理由）。
