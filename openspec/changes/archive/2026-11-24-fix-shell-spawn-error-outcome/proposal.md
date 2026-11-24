# Proposal: fix-shell-spawn-error-outcome

> **已批准。** 用户 2026-11-23 睡前批复「A+B我都批」（B = 本 change，
> A = fix-multi-location-session-anchor）。按草案实施。
> 过夜自主闭环 2026-11-23 发现。

## Why

真机实证（2026-11-23T17:11:40Z，宿主 2.4.0，0.32.3 物化副本）：一个复核
子代理（`ses_df69bff0…`）的三次 `forge_shell` 调用因工作目录不存在而
**启动失败**（作业 j-20261123-171140-z0af81 / -xz02he / -0iwu0p），工具
返回的正文是：

```
[forge:job] Command finished (exit=none).
cwd: F:\UNITY_Project\SorenUnityLabs\opencode-forge
jobId: j-20261123-171140-z0af81
Output was delivered in full above — terminal evidence: the job self-cleared from the registry (no wake fires, no forge_jobs clear needed).
spawn error: ENOENT: no such file or directory
output:
(none)
```

一条**从未启动**的命令：首句写着 “Command finished”，第四句写着
“输出已完整送达”，真实原因排在第五行，标题是 `exit ?`。这次子代理自己
识破了（改用 read/grep 完成了复核），但读这段文字的是模型——把“没跑”
读成“跑完了”的风险是结构性的。

代码（plugin.ts:2708-2721）：启动失败被结算为
`{ status: "exited", exitCode: null, spawnError }`（src/job-manager.ts /
job-runner.ts:239、:356），前台返回只有 `exited` 一个分支，把它当普通
退出渲染，只在末尾追加一行 `spawn error:`。

基线规约 job-supervisor《Bounded foreground execution with four
completion conditions》已经把 **spawn-failure form** 列为与 `exited`
并列的第四种返回形态——是实现把它折叠进了 `exited`。同仓库的验证检查
模块对同一情况写的是老实的 `spawn failed: …`（src/run-check.ts:110）。

## What Changes

- 前台返回的启动失败形态独立渲染：标题 `not started`；首句
  `[forge:job] NOT STARTED — spawn failed; nothing was executed.`；随后
  `cwd:`、`jobId:`、`spawn error: <原文>`。**不出现** “Command finished”、
  “Output was delivered in full above” 与 `output:` 三段。
- 其余三种形态（`exited` / `succeeded` / `still-running`）逐字节不变。
- `forge_jobs poll` 观察到带 `spawnError` 的终态时同样首句点名未启动。
- 不改 job-runner 的结算形状，不改自清理语义（作业照样从注册表移除）。

## Impact

- `plugin.ts`：`forgeShellExecute` 前台 `exited` 分支；`forge_jobs` poll
  终态文案。
- 单测：新增启动失败形态断言；现有断言若钉了旧文案则同步。
- 用户可见：只有“命令没启动”这一种情况的返回文案变化。
- 版本：并入 0.33.0 之后的下一次发版（草案晚于 0.33.0 门控构建）。
