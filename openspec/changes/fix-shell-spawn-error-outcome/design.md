# Design: fix-shell-spawn-error-outcome

> 草案，待用户批准。

## D1 — 渲染分支（plugin.ts:2708-2721）

现状：`started.settle` 对启动失败给出
`{ status: "exited", exitCode: null, spawnError }`，前台返回只有
`status === "exited"` 一个分支——启动失败与正常退出共用一段文字。

改法：在 `exited` 分支里按 `r.spawnError` 分叉（不改结算形状）：

```
title: `not started`
output:
  [forge:job] NOT STARTED — spawn failed; nothing was executed.
  cwd: <绝对路径>
  jobId: <id>
  spawn error: <原文>
```

- 不出现 “Command finished”、“Output was delivered in full above”、
  `output:` 三段——对一条没启动的命令，三句都不成立。
- 自清理语义不变：作业同样从注册表移除，后续 `poll`/`kill` 同样报
  “already consumed”。
- 正常退出 / `succeeded` / `still-running` 三种形态逐字节不变。

## D2 — `forge_jobs poll` 的同类文案（对齐点）

`poll` 观察到带 `spawnError` 的终态时，现在只写 `<id>: exited`，不提
“未启动”。本 change 一并对齐为首句点名未启动；行号以实现时的实际代码
为准（返工后 plugin.ts 行号有位移）。

## D3 — 测试

| 用例 | 断言 |
| --- | --- |
| 前台启动失败（cwd 不存在） | 标题 `not started`；首句含 `NOT STARTED`；不含 `Command finished` / `Output was delivered`；含 `cwd:` 与 `spawn error:` |
| 正常退出 | 文案逐字节不变（现有断言不动） |
| `poll` 观察 `spawnError` 终态 | 首句点名未启动 |

## D4 — 验证

1. 单测 + typecheck 全绿；变异检查：临时拆掉分叉 → 新用例恰好变红，
   还原后 SHA256 一致。
2. 沙箱 E2E：在活宿主上让一个会话用不存在的相对目录调 `forge_shell`，
   抓工具返回原文逐字比对。

## D5 — 版本

并入 0.33.0 之后的下一次发版。
