# Proposal — fix-job-lifecycle-on-host-exit

## Why

实机复现（2026-09-26，采纳实验的副产物 + 定向实验钉死）：`opencode run` 退出后，
其 `run_in_background` 起的后台 job 进程**存活**且**以坏损状态存活**——宿主死时 job 的
stdout 管道消亡，逐请求写 stdout 的服务（`python -m http.server`）TCP 可握手但 HTTP
空回复（handler 死于 broken-pipe 写）。单测覆盖的"owner 终束清杀"在宿主进程退出路径
上实机未生效；即便存活是 handoff 语义想要的，活下来的也必须是健康服务。社区对照
（调研 2026-09-26）：Claude Code headless `-p` 即"run 结束即杀后台命令"；Node 官方
文档明示 stdio 连父进程的子进程在父退出后不得以后台方式存活；opencode 原生 shell
同类 issue #20902/#24731（无退出清理 + 管道继承卡 close）。

## What Changes

- **job stdio 与宿主管道解耦**（地基修复）：spawn 时 stdin→null、stdout/stderr→job 日志
  文件句柄；宿主侧日志读取改为 tail 文件，不再依赖管道。同时消除 forge 自身
  "管道持有者卡 close 事件"的挂起风险（#47350 的近亲）。
- **宿主退出全出口显式清杀**：dispose / SIGINT / SIGTERM / 未捕获异常 / process.exit
  全部出口上，对存活 job 做进程组/进程树终止（优雅 → 宽限 → 强杀）——默认语义。
- **OS 级兜底**：Windows 上 job 子进程入 Job Object（KILL_ON_JOB_CLOSE，
  CREATE_SUSPENDED→Assign→Resume 防逃逸，不设 BREAKAWAY_OK）；POSIX 上新进程组 +
  退出杀组。仅默认 kill 模式启用。
- **显式存活模式**（opt-in）：`jobs.survive` 配置或 forge_shell 参数 `survive:true`
  声明的 job 跳过退出清杀与 OS 兜底；job 注册表持久化（pid/日志路径/命令），跨会话用
  现有 forge_jobs poll/kill/handoff 接管——stdio 已文件化，存活者天然健康。

## Capabilities

### Modified Capabilities

- `job-supervisor` — "Job ownership and lifecycle" 需求强化（宿主进程退出是显式终止触发
  且覆盖全部出口；存活仅限显式 opt-in 且健康），并新增三条需求：stdio 解耦、OS 级
  兜底、显式存活模式与持久化注册表。

## Impact

- 代码面：`src/job-runner.ts`（spawn stdio 重定向 + 退出钩子）、`src/job-manager.ts`
  （注册表持久化字段）、`src/proc.ts`（进程组/Job Object 底座）、`plugin.ts`（退出
  出口接线、survive 配置）。
- 兼容性：forge_shell 契约不变；日志获取路径从管道 tail 改文件 tail 对工具返回
  无感（logPath 语义本就落盘）。默认行为从"可能留僵尸"变为"退出即净"，属缺陷修复。
- 文档：README 配置面（jobs.survive）、文件账本（registry.json）、卸载口径补充。
- 发布：0.3.1 patch 车次。
