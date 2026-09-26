# Design — fix-job-lifecycle-on-host-exit

## Context

实机症状与机理（2026-09-26 定向实验，job `j-20260926-120857-w4jic4`）：
`python -m http.server` 后台 job 在宿主退出后进程存活、TCP 可握手、HTTP 空回复
（curl exit 52）；日志文件证明宿主存活期正常、退出后请求全无响应——stdout 管道随
宿主消亡，逐请求写 stdout 的 handler 死于 broken-pipe。上午采纳实验中两个
"存活但 000"的 python 同因。单测层"owner 终束清杀"为何实机未触发待实施时定位
（候选：`opencode run` 退出路径不产生 session.deleted 事件，或 dispose 时序竞争），
但修复不依赖该结论——四层修法对任一根因都成立。

社区证据（调研 2026-09-26，全 URL 见提案背景与下方引用）：
- Node 官方：stdio 连父的子进程父退后不得后台存活 → 我们是"连着管道活了但坏了"。
- Claude Code headless `-p`："background commands end shortly after the run's final
  result"——与 `opencode run` 一轮一退同构，默认杀的先例。
- opencode 原生 shell：无退出清理（shell.ts），社区 #20902（管道继承卡 close）与
  #24731（要求配置化退出杀/等）同类。
- Windows Job Object kill-on-close：Raymond Chen 两篇（2013 经典 + 2023 的
  suspended-assign-resume 顺序）；不设 BREAKAWAY_OK（Chromium 系逃逸）。
- POSIX：进程组 + 组杀为主清理；PDEATHSIG 仅兜底且有"父线程死亡误杀"坑
  （recall.ai），不采用。

## Goals / Non-Goals

**Goals**：默认退出即净（全出口）；存活仅显式 opt-in 且健康（stdio 文件化）；
顺手消除 forge 自身管道-close 挂起风险；注册表跨进程持久化以支撑 handoff。

**Non-Goals**：tmux/PTY 持久会话模型（Windows 原生不可用、多一层依赖，收益不抵）；
后台 job 的重启/监督语义（存活≠守护）；watchdog 联动改动。

## Decisions

### D1 stdio 文件化（地基，必做且最先）

spawn 从 `stdio:["pipe","pipe","pipe"]` 改为 `["ignore", logFd, logFdAppend]`——
stdout/stderr 直接指向 job 日志文件句柄（本就 tee 落盘，去掉中间管道）。宿主侧
输出捕获改为 tail 该文件（job-runner 现有 ring buffer 改从文件读增量）。效果：
(a) 存活者天然健康；(b) 宿主不再持有 job 管道 → close 事件不再可能被孙进程卡住
（#47350 近亲风险顺手消除，exitGrace 兜底保留）；(c) 管道断裂类问题整类消失。
**备选**：保持管道 + 退出前重定向（不可行——进程启动后无法改 fd）。

### D2 宿主退出全出口清杀（默认语义的主通道）

`plugin.ts` dispose 之外，补齐出口矩阵：process.on("SIGINT"/"SIGTERM"/"exit")、
uncaughtException/unhandledRejection 收尾时对存活 job（未 opt-in survive）执行
killTree（现有 `src/proc.ts` 肌肉：Windows `taskkill /PID /T /F`、POSIX 负 pgid），
先优雅（SIGTERM，3s 宽限）后强杀；同一次退出内幂等（防多出口重复触发）。
实施时先加诊断探针定位"单测过、实机不过"的确切出口缺口，再补对应出口。

### D3 OS 级兜底（防无出口死亡）

Windows：CreateJobObject（KILL_ON_JOB_CLOSE，不设 BREAKAWAY_OK）→ spawn 后立即
AssignProcessToJobObject——node 未暴露 CREATE_SUSPENDED，故不追求"入 job 前无法
spawn 孙进程"的强时序，依赖 job 的继承语义（后 spawn 的后代自动属于同一 job，
除非显式 breakaway）兜住窗口期；宿主无论怎么死，句柄关闭即内核杀光 job 内全部
后代（Postgres 实测 100–200ms；Chromium 系显式 breakaway 进程的逃逸为已知边界，
README 记录）。嵌套 job 需 Win8+（宿主环境满足）。POSIX：spawn `detached:true`
新进程组（现有），退出杀组为主清理；**无内核级兜底**——SIGKILL 场景的孤儿由
下宿主启动的注册表扫描检出并记 ledger（spec 对应场景），不采用 PDEATHSIG
（"父线程死亡误杀"坑，recall.ai）。仅默认 kill 模式启用；survive job 不 fence。

### D4 显式存活 + 注册表持久化

`forge_shell` 参数 `survive?: boolean` 与配置 `jobs.survive?: "never"|"always"`
（默认 never；参数可覆盖配置的 never，不可覆盖显式 deny）。survive job：跳过 D2/D3，
注册表落 `<tmp>/opencode-forge/jobs/registry.json`（job id、pid、命令、日志路径、
startedAt、ownerHost 标记）；新宿主启动时扫描注册表，把仍存活的 survivor 并入 job
表（owner 标"previous run"），poll/log/kill/handoff 全部现有动词直接可用；pid 已死
的条目清理并记 ledger。与既有 handoff 语义的边界：handoff 是会话间转移（宿主内），
survive 是宿主间跨越（宿主外）——注册表是两者共同的落点。

### D5 模块落点

- `src/proc.ts`：Windows Job Object 绑定 `fenceJobTree(pid)`（零依赖约束下经
  `AssignProcessToJobObject` 系统 API——Node 无原生封装，以最小 FFI/原生模块或
  `powershell -Command` 一次性调用实现，取舍在 apply 时定；**被否备选**：引入
  `ffi-napi` 常驻依赖（破坏零依赖姿态，仅当 Assign 后置竞态实机证明有害时重评））。
- `src/job-runner.ts`：stdio 文件句柄 + 退出钩子注册。
- `src/job-manager.ts`：注册表持久化字段与扫描合并（POSIX 孤儿检出也走这里）。
- `plugin.ts`：出口矩阵接线 + survive 配置解析。

## Risks / Trade-offs

- **AssignProcessToJobObject 后置竞态**：job 对象的继承语义覆盖后 spawn 的孙进程；
  窗口内 breakaway 进程（Chromium 系）不受 fence——README 记录此边界。
- **stdio 文件化后的输出即时性**：poll 语义从管道事件改为文件 tail 轮询/增量读，
  延迟量级不变（poll 本就是等待窗口）；单测全部改走文件断言。
- **注册表持久化与多宿主并发**：两个 opencode 进程同跑时 registry 读写加进程级
  文件锁（沿用 ledger 的 read-modify-write 模式）。
- **survive 滥用留垃圾**：默认 never + ledger 报告 + README 卸载口径补充
  registry.json 清理。
