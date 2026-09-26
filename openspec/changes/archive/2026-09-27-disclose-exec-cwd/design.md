# Design — disclose-exec-cwd

## Context

实机两轮复现（2026-09-27）：同一提示词（"起个静态服务器 serve 当前目录"）
下，第一轮 agent 叙述服务根目录为 `AgentWorkCommon`（错误），复现轮为
`Desktop\Temp`（正确）。定向探针排除了 cwd 计算缺陷：非 git cwd 下
input.worktree="/"，`effectiveWorktree` 回落 launch directory；`cmd /c cd`
经 forge_shell 实测输出 Temp。缺陷定性为**叙述不可核对**——结果输出里没有
执行目录的权威锚点。

## Decisions

### D1 披露点放在 tool 返回层，不进 job 结构

cwd 在 `forgeShellTool.execute` 里已解析（`cwd` 变量：workdir 参数解析或
worktree 兜底）。返回层拼 `cwd: <path>` 一行即可，不动 job-runner /
job-manager / 注册表——结果即时可读，不引入持久化面。

**被否备选**：把 cwd 存进 Job 并由 forge_jobs list 展示——多一条持久字段
和迁移语义，收益仅限 list 视图；poll/log 已有 logPath 锚点，不需要。

### D2 spawn 失败形态也带 cwd

spawn 失败的高频根因之一就是 cwd 无效（打错的 workdir）；失败返回带上
`cwd:` 直接把诊断信息给到模型。

### D3 叙述纠偏靠锚点，不靠提示词

不在工具描述里加"请正确报告目录"之类的软引导——结果首行的硬锚点让用户
与模型都有可核对的事实。README 同步一句口径。

## Risks / Trade-offs

- 输出多一行，token 开销可忽略。
- 模型仍可能叙述错（如首轮）——但用户核对成本从"自行排查"降为"看结果
  首行"，这正是本 change 的验收口径。
