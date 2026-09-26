# Tasks — add-job-supervisor

## 1. 进程基础抽取

- [x] 1.1 从 `src/run-check.ts` 抽取共享模块 `src/proc.ts`（spawn、跨平台进程树杀、可注入 fake；若 `src/proc.ts` 已因 add-hang-watchdog 先行 apply 而存在，则合并复用不重复建），`run-check.ts` 改为消费方；验证：现有 `tests/*.test.mjs` 全绿 + 新增 proc 单测（杀树命令构造：win `taskkill /PID /F /T`、posix 进程组）
- [x] 1.2 在 `src/proc.ts` 落 env 标记注入点（供 spawn 时附加环境变量）；验证：单测断言子进程环境含标记（fake spawn 捕获参数）

## 2. job-manager（纯逻辑，无宿主依赖）

- [x] 2.1 job 表与生命周期状态机（running → exited/killed/succeeded；clear 语义；存活数与内存输出上限逐出）；验证：`tests/job-manager.test.mjs` 覆盖创建/终态/clear/超限逐出最旧已完成
- [x] 2.2 所有权规则（owner 会话绑定、owner 终束触发清杀回调、handoff 根祖先解析回退全局、dispose 全量清场）；验证：单测用 fake 会话树覆盖四条路径
- [x] 2.3 唤醒队列（每 job 至多一次、投递窗口超时落账本、notify:false 抑制）；验证：单测含"窗口超时不投递且账本有记录"
- [x] 2.4 诊断账本（孤儿 job、未读完成、超时投递三类条目，有界）；验证：单测断言条目结构与上限

## 3. job-runner（四条件判定）

- [x] 3.1 实现四条件 race 与输出捕获分离（捕获 fiber 不 join 进完成判定）；验证：单测模拟"直接子进程退出但 grandchild 持有管道"（fake 流不 close），断言调用按 exit 返回（#47350 场景的结构性测试）
- [x] 3.2 idle_ms / max_wait_ms 提前归还（含 hint 文案与 clamp：max_wait ≤ 600000、poll waitMs ≤ 30000）；验证：单测覆盖归还、clamp、进程不被杀
- [x] 3.3 success_pattern 命中判定与 fate（默认保活、keep_alive:false 杀树、命中上下文随返回）；验证：单测覆盖命中/不命中/显式杀
- [x] 3.4 输出保留（每 job ring buffer、registry 总量上限、磁盘 tee 到命名空间目录、返回尾窗截断、日志文件轮转）；验证：单测覆盖截断与轮转删最旧
- [x] 3.5 `run_in_background: true` 立即返回路径（返回字段含 `jobId` 与 `logPath`，不等待任何输出/退出）；验证：单测断言返回即时性与字段完整性（specs「Background start semantics」）

## 4. 插件接线

- [x] 4.1 `plugin.ts` 注册 `forge_shell` / `forge_jobs`（v1 tool hook），`forge_shell` execute 内 `ctx.ask()` + config hook 注入 `permission.forge_shell = "ask"`（显式 deny 不覆盖）；验证：接线单测（fake ToolContext）断言 ask 流程与 deny 短路
- [x] 4.2 forge agent 的 shell-hide 注入（仅当 `agent["forge"]` 为插件自建条目；`jobs.keepBuiltinShell: true` 跳过；stage≥1 撤销）；验证：config hook 单测覆盖自建/用户自定义/旋钮三态
- [x] 4.3 `experimental.chat.system.transform` 注入两行引导（长跑→forge_shell；委派上下文 yield 前 poll 收割）；验证：钩子单测断言注入内容与幂等

## 5. 唤醒引擎与能力探测

- [x] 5.1 event 钩子跟踪 `session.idle`，空闲时经 `client.session.promptAsync` 投递 `[forge:job-complete]`（复用 2.3 队列）；验证：集成测试用 fake client + fake 事件序列，断言仅空闲投递且单次
- [x] 5.2 能力探测三层（config.experimental flag / tool.definition 读内置 shell schema / `jobs.mode` 手动档）与阶段矩阵动作（stage 0/1/2 的注册与 hide 行为）；验证：单测覆盖探测三源与矩阵三档

## 6. 文档与账本

- [x] 6.1 README：job-supervisor 章节（工具契约、jobs 配置项、stage 矩阵说明）、文件账本增补 tmp 命名空间目录、卸载章节覆盖运行时产物；验证：按避坑 §6 口径核对账本三块齐全
- [x] 6.2 AGENTS.md 架构表加入 job-manager/job-runner/proc 模块行；验证：文档与实际模块一致

## 7. 实机集成验证

- [x] 7.1 用 #47350 的 repro 形态（spawn 持管道的 detached 子进程的 launcher）在 opencode 1.18.3x 实机验证 `forge_shell` 正常返回且不残留挂起调用；验证：会话不再卡死、诊断无异常
- [x] 7.2 唤醒注入实机验证：TUI 主会话跑后台 job 触发退出唤醒；`opencode run` 模式验证 ask 姿态（无 --auto 拒绝、--auto 放行）；验证：两种模式行为符合 D5/D6 预期
- [x] 7.3 子代理会话路径验证（子代理内 forge_shell 可用、退出唤醒行为）；若 promptAsync 在子会话异常则按 design 降级为 poll 纪律并记录结论；验证：结论写入 change 目录备注或 design 修订

## 8. 发布门槛

- [x] 8.1 `bun build` 打包、dist 入库、版本 0.3.0、npm 发布（沿用 0.2.x 流程，脚本名避开七个触发词）；验证：`npm pack` 产物检查（0.3.0，3 文件 105.7 kB；142/142 测试 + tsc 干净后发布；token 经 Edge 浏览器 passkey sudo-auth 现场签发，发布后已撤销）
- [x] 8.2 官方安装模式终验（发布后，npm spec 模式）：`opencode plugin @sorenllm/opencode-forge --global`（npm registry 名安装，不用 github/file 源）安装、注册、冒烟（forge_shell 执行 + forge_jobs poll/kill）全过；完整卸载四步 + 以同一 npm spec 重装回到干净可用状态（避坑 §TL;DR 6/§5）。**最终状态硬性要求：用户环境停留在 npm plugin 模式（registry 名安装）且全部冒烟通过**（用户 2026-09-26 明示）（registry @latest→0.3.0；卸载后 NATIVE-OK 原生回归；重装后 forge_shell echo 出 `SMOKE-FORGE-SHELL-030` exit 0、后台 job `j-20260926-001948-u4wxnm` poll→kill→list=killed；用户 opencode.jsonc 注释与字节数保持不变）
