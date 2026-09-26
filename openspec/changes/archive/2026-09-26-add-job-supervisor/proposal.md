# add-job-supervisor — 非阻塞 shell 执行与 job 管理（工具层全局修复）

## Why

opencode 的内置 shell 工具完成判定绑定「进程退出 / 流 EOF」，导致两类实际挂死：主会话前台命令卡数小时（上游 [#47350](https://github.com/anomalyco/opencode/issues/47350) 实测 1h44m、#50316、#49169，agent 被吊死在不返回的工具调用上，期间零模型请求）；子代理同款（#47546）。根因之一是完成语义单一：server、watch、留下 detached 子进程的 launcher 这类命令**天生不退出**，其完成信号在输出文本里（"listening on :3000"），现有判定永不满足。

参照系（ZCode、OpenClaw、Hermes）已收敛出标准机制：前台调用有有界等待预算、进程退化为句柄、增量取输出、完成事件回注会话、显式 kill；工具层一次修复、主/子代理共享。OpenCode 官方有四个未合并 PR 在向同构形状收敛（`run_in_background` + jobId + `bash_jobs` + 退出注入合成消息，#47231/#33310/#50276/#48352，伞形 #34366），但截至 2026-09 无一进 main，且预计第一版残缺（无 idle 检测、无输出模式完成判定）。因此 forge 在插件层自建此能力，并**以官方未来的接口形状为对齐目标**，保证官方下场时零迁移。

## What Changes

- 新增 `forge_shell` 工具（v1 tool hook 注册，全局流向所有 agent 包括 task 子代理——registry 源码核实插件工具无需 opt-in）：
  - **四条件完成判定，先到先判**：进程 exit（绑 exit 事件而非 stdio EOF，结构性免疫 #47350/#47546 类挂死）；`success_pattern`（opt-in 正则）命中输出 → 判成功返回；`idle_ms` 无新输出（默认 60s）→ 提前归还 `{status:"still-running", outputTail, jobId}`；`max_wait_ms` 硬上限（默认 120s，上限 600s）→ 同样归还；
  - `run_in_background: true` 立即返回 `{jobId, logPath}`（参数名对齐上游 PR #47231）；
  - 进程 fate：exit 自然终；idle/max_wait 归还后进程保活（模型续判）；success_pattern 命中后默认保活（server 语义，`keep_alive:false` 显式杀树）；
  - 权限姿态保持：execute 内 `ToolContext.ask()` + config 注入 `permission.forge_shell = "ask"` 两件套（避坑文档 §4.5 已知：插件工具绕过 permission 求值），尊重用户显式 deny/allow。
- 新增 `forge_jobs` 管理工具（动词对齐 OpenClaw process / 上游 bash_jobs）：`list / poll（有界等待 ≤30s，增量 drain）/ log（offset/limit 分页）/ kill（进程树强杀，复用 run-check 的 taskkill /F /T 与 POSIX 进程组逻辑）/ clear（清理已终 job）/ handoff（所有权改绑根会话）`。
- **完成唤醒**：job 退出时经 `PluginInput.client.session.promptAsync()` 向 owner 会话注入一次合成消息（`[forge:job-complete]` + exitCode + 输出尾巴）；仅会话空闲时投递（`session.idle` 事件防竞态，避开 #41753 单飞排队），每 job 至多一次，超时未投递落诊断账本；每调用 `notify:false` 可关。
- **job 所有权规则**（Hermes 语义）：job 归属创建会话；owner 会话结束 → 清杀其存活 jobs；`handoff` 例外改绑；插件 `dispose` 全量清场；孤儿与未读完成在诊断账本上报。
- **模型面引导**：`experimental.chat.system.transform` 给所有会话（含子代理）注入两条规则——长跑/可能不退出的命令用 `forge_shell`；委派上下文交还结论前先 `poll` 收割后台结果（OpenClaw 文档化规则的 forge 版）。
- **forge agent 工具面组成变更**：forge 自有 agent 条目上默认禁用内置 shell（`tools.shell = false`，运行时注入不落盘），执行面由 `forge_shell` 提供；`keepBuiltinShell: true` 旋钮或用户自定义 forge 条目时不注入。**用户自定义的其他 agent 一律不碰**（只动插件自建条目）。
- **能力探测与三档降级**（未来兼容核心）：探测 = config hook 检查 `config.experimental` 背景化 flag + `tool.definition` 钩子读内置 shell 参数 schema 是否含 `run_in_background` + plugin option `jobs.mode: "auto" | "forge" | "native"` 手动档。行为矩阵：无原生（现状）→ forge 全量实现；原生残缺 → 停止禁用内置 shell、forge_shell 降为增值层（idle/成功模式判定叠加原生进程管理）；原生完备 → forge_shell 退役、恢复内置 shell。模型面语义与命名全程不变，降级零迁移。
- 输出与日志：job 输出 ring buffer + 落盘 `<系统临时目录>/opencode-forge/jobs/<jobId>.log`（避坑文档 §6C 命名空间目录），容量上限与逐出策略（参照 OpenClaw 50 会话 / 2MB），README 文件账本增补。
- 版本 0.3.0，npm 发布流程沿用；与并行 change `add-hang-watchdog` 同车发布（后到 apply 者递增 patch）。

## Capabilities

### New Capabilities

- `job-supervisor`：非阻塞 shell 执行契约——`forge_shell` 四条件完成判定（exit / success_pattern / idle_ms / max_wait_ms）与进程 fate 规则、`run_in_background` 语义、`forge_jobs` 六动词契约（list/poll/log/kill/clear/handoff）、完成唤醒注入（幂等单次、空闲投递、可关）、job 所有权与生命周期（owner 终束清杀、handoff、dispose 清场、孤儿上报）、权限姿态保持（ask 两件套）、输出保留与截断、模型面引导注入、能力探测与三档降级矩阵、配置面与文件账本。

### Modified Capabilities

- `forge-agent`：requirement「Register the single general-purpose forge agent」的执行面组成变更——内置 shell 在 forge agent 上默认隐藏，执行面由 `forge_shell` 提供（`keepBuiltinShell` 旋钮与用户自定义条目除外）；disable 一键回归原生的语义同步覆盖 job 工具。

## Impact

- **本仓库**：`plugin.ts`（2 个新工具、唤醒引擎、system.transform 引导、config 扩展、能力探测）、新 `src/job-manager.ts`（job 表/生命周期/所有权/唤醒队列，无 @opencode-ai 依赖）、新 `src/job-runner.ts`（spawn/管道/四条件判定/杀树，自 `src/run-check.ts` 的进程肌肉抽取共用）、`tests/job-*.test.mjs`、README（job 章节、文件账本加 tmp 命名空间目录）、AGENTS.md 架构表。
- **宿主 opencode API 面**（1.18.32 类型已核实存在）：`hooks.tool`、`tool.definition`、`experimental.chat.system.transform`、`PluginInput.client`（`session.promptAsync`）、event 总线（`session.idle`）、`permission.ask`、config hook。
- **无新增依赖**：peerDependencies 维持 `@opencode-ai/plugin ^1.18.0`；打包红线（脚本名、dist 入库）不受影响——纯运行时功能。
- **上游联动**：#34366 / #47231 / #33310 / #50276 任一合并即触发降级矩阵的阶段迁移。
