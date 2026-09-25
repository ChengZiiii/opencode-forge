# Design — add-job-supervisor

## Context

见 proposal.md「Why」。当前 opencode 1.18.x 内置 shell 工具完成判定绑 stdio EOF、无 idle 检测、无后台句柄（上游 #34366 伞形未决、四个 PR 未合并）；forge 已有 v1 tool hook、config hook、permission 两件套、`session.idle` 事件与 `client.session.prompt` 注入的现成肌肉（goal-harness 已用）。进程树管理代码已存在于 `src/run-check.ts`（Windows `taskkill /PID /F /T`、POSIX 进程组 `SIGKILL`）。

## Goals / Non-Goals

**Goals**：任何 agent（主/子代理）经 `forge_shell` 执行命令时，调用物理上有界（≤ max_wait_ms），进程可存活为 job 句柄、增量可读、可强杀、完成有唤醒；接口形状对齐上游收敛方向，官方落地后可分档降级、模型面零迁移。

**Non-Goals**：不动用户自定义 agent 的工具配置；不做 PTY/交互 stdin（OpenClaw 有 send-keys，上游无对应物，等官方——ZCode 也没有）；不做子代理停滞检测（独立 change `add-hang-watchdog`）；不做跨主机执行（Hermes 的 7 backend 超出 forge 定位）；不修核心层 bug（#51291 类流消失无进程可杀的挂死，只能由上游修）。

## Decisions

### D1 完成判定绑 exit 事件，插件自持管道
spawn 后 completion 只 race「exit / success_pattern / idle / maxwait」四源；输出捕获是独立 fiber，**不 join 进完成判定**——孙进程继承管道握着流不放时，捕获 fiber 继续在后台收，调用照样按 exit 返回（结构性免疫 #47350/#47546）。这是与内置工具的本质差异，也是本 change 存在的理由。备选「包装原生工具 + 转发」被否：插件拿不到内置工具运行中的进程句柄，`tool.execute.before/after` 只在执行前后各触发一次。

### D2 参数面与默认值
`idle_ms` 默认 60000、`max_wait_ms` 默认 120000 / 上限 600000（对齐 opencode 自身 `bashDefaultTimeoutMs` 2min 与 ZCode 600s 上限）、`poll` 内部等待 clamp 30000（对齐 OpenClaw `process poll`）。四条件都满足「先到先判、归还不杀进程」——限不活跃/限等待预算，不限进程总寿命（参照系共同原则；总寿命归 `kill` 与 owner 生命周期管）。

### D3 success_pattern 的进程 fate
命中即判成功返回；**默认保活**（server 是该参数的主场景，默认杀会毁掉刚验证成功的服务），`keep_alive:false` 显式杀树。默认不启用该参数（避免误判"完成"），工具描述内附常见模式速查（`listening on|ready in|compiled successfully|Done in`）引导模型显式传。误判兜底：命中行上下文随结果返回，模型可见可纠正；idle/maxwait 归还路径始终存在（模型当裁判的最终通道）。

### D4 单管理工具 + action 枚举
`forge_jobs {action, jobId?, waitMs?, offset?, limit?}`，动词 `list/poll/log/kill/clear/handoff`。对齐上游 `bash_jobs` 与 OpenClaw `process`（都是单工具 action 枚举），少占工具面、动词可增量加。`poll` 语义 = drain 自上次 poll 的新输出 + 退出状态（非 cursor 协议，与会话内调用序列天然绑定）。

### D5 权限两件套
插件工具绕过 permission 求值（避坑 §4.5 实测），故：execute 内 `ctx.ask()` 发起确认 + config hook 注入 `permission.forge_shell = "ask"`。只升不降、显式 deny 永远赢；run 模式下 ask 自动拒绝与原生 bash 姿态一致（不算回归）。`forge_jobs` 不设门（模型管理自己会话的 job，上游 `bash_kill` 同姿势）。

### D6 完成唤醒：promptAsync + idle 门 + 单次幂等
job 退出 → 入投递队列；`event` 钩子跟踪 `session.idle`，owner 空闲时经 `client.session.promptAsync()` 注入一次 `[forge:job-complete]`（exitCode + 尾巴 + 建议动词）。用 `promptAsync` 而非 `prompt`：立即返回不阻塞插件 fiber。投递窗口（默认 10min）超时 → 落诊断账本，不无限排队（防 #41753 式排队雪崩）。`notify:false` 每调用可关。注入显示为用户消息是已知 UX 代价——上游 PR #47231 的"合成消息"同款，官方没有更好的通道前这是社区共识做法。

### D7 所有权规则（照抄 Hermes 语义）
job 记录 owner sessionID；宿主事件里 owner 会话结束 → 杀其存活 jobs（"子代理结束不留下进程所有权"）；`handoff` 改绑根祖先（经会话 parent 链解析，解析不到回退插件全局 scope）；`dispose` 全量清场；孤儿与未读完成写诊断账本。防堆积：registry 上限（存活 job 数 + 内存输出量，超限逐出最旧已完成项，参照 OpenClaw 50 会话/2MB 量级）。

### D8 forge agent 上禁用内置 shell：只动自建条目
registry 源码核实：插件工具全局流向所有 agent，但同名注册不覆盖内置（内置按位置优先）——所以「让 forge agent 不用内置 shell」唯一路径是 config 注入 `tools.shell = false`。边界：仅当 `agent["forge"]` 条目为插件自建（only-if-absent 语义）时注入；`jobs.keepBuiltinShell: true` 或用户自定义条目不注入；用户自定义的其他 agent 永不碰。阶段 2 撤销注入。

### D9 能力探测：三层，结果缓存
① config hook 读 `config.experimental` 的背景化 flag（上游 #47231 是 flag 门控）；② `tool.definition` 钩子在内置 shell 上触发时读参数 schema 是否含 `run_in_background`（output 预填模式，首次触发置标志）；③ `jobs.mode` 手动档覆盖一切。探测结果缓存 + 写插件日志，供阶段矩阵与诊断用。

### D10 阶段迁移：stage 0→1 自动，→2 手动
stage 1 判据 = 探测到原生 `run_in_background` 参数存在（可自动探测），动作 = 撤销 shell-hide、`forge_shell` 描述改为优先引导原生参数、增值层（idle/success/唤醒账本）保留。stage 2 判据 = "原生完备"**不可自动探测**（伞形 issue 的验收标准是语义级），必须 `jobs.mode: "native"` 手动确认——设计立场：宁可多留一档手动，不冒然退役再回滚。

### D11 输出保留
内存 ring buffer（每 job 上限 + registry 总量上限，超限逐出最旧已完成）；磁盘 tee 到 `<tmp>/opencode-forge/jobs/<jobId>.log`（全量、按总量上限轮转删除最旧文件）；返回模型的输出截断为尾窗。敏感信息不额外脱敏（与原生 shell 同姿势，不在插件层重复造轮子）。

### D12 system.transform 引导：两行规则
`experimental.chat.system.transform` 给所有会话注入：长跑/可能不退出的命令用 `forge_shell`；委派上下文交还结论前先 poll 收割。控制在两行内（系统提示预算敏感，与 goal/plan notice 并存）。

### D13 进程肌肉抽取
`src/run-check.ts` 的 spawn/杀树逻辑抽为共享 `src/proc.ts`（无 @opencode-ai 依赖、可注入 fake），run-check 与 job-runner 共用；job 侧进程标记变量名用 `FORGE_JOB_ID`（≠ watchdog 的 `FORGE_WATCHDOG_MARK`，两 change 互不匹配对方的标记）；`src/job-manager.ts`（job 表/所有权/唤醒队列/账本，纯逻辑）与 `src/job-runner.ts`（四条件 race/管道捕获）分层，`plugin.ts` 只接线——沿用 goal-file/run-check 的可测分层模式。

## Risks / Trade-offs

- [promptAsync 注入在子代理会话/run 模式的行为未实测] → tasks 里安排实机验证（TUI + `opencode run` 各一轮），异常则子代理场景降级为"poll 收割纪律"（引导规则已在），唤醒只保主会话。
- [success_pattern 误判完成] → 默认关闭、命中上下文随返回、idle 归还通道兜底（模型终审）。
- [idle 误归还让模型以为失败] → 归还结果带明确 hint 文案（"still-running, poll to continue / kill to stop"）+ 工具描述示例。
- [上游 PR 形状与预测不符] → 模型面语义（动词、jobId/logPath）稳定，参数名差异由 stage 1 shim 吸收；D10 手动档保证不自动踩坑。
- [唤醒消息污染对话流] → 单次幂等 + notify 开关 + 文案标记 `[forge:job-complete]` 便于用户识别与忽略。
- [杀树误伤] → 只杀 job 自己的树（spawn 时记录 pid/进程组），与 watchdog change 的 env 标记机制互不越界。

## Migration Plan

版本 0.3.0 发布（npm 流程沿用；与 `add-hang-watchdog` 同车，后到 apply 者递增 patch）。上线即 stage 0；上游合并任一背景化 PR 后发布 0.4.0 自动进 stage 1（release notes 说明）；用户确认原生完备后手动 `jobs.mode: "native"` 进 stage 2。回滚：`jobs.mode: "forge"` 钉住 stage 0，或插件 disable/卸载（forge-agent spec 的一键回归语义覆盖 job 工具）。

## Open Questions

- 唤醒消息的精确文案格式（占位符、尾巴行数）——实现期定，不影响契约。
- jobs 日志目录是否需按 worktree 隔离（多 worktree 并存场景）——默认按 `PluginInput.worktree` 隔离，若实测 Windows 路径长度有问题再调整。
