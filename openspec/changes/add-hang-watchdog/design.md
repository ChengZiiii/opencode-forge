# Design — add-hang-watchdog

## Context

见 proposal.md「Why」。约束：插件拿不到内置 shell 工具运行中的进程句柄（`tool.execute.before/after` 只在前后触发一次）；`shell.env` 入参含 `callID` 且对插件进程内所有会话生效（1.18.32 类型核实）。参照系：Hermes 常驻停滞监视（idle 450s / inside-tool 1200s 中断，`timeout_phase` 元数据）；原则"限不活跃、不限总时长"。与 `add-job-supervisor` 并行且互不依赖（其 `src/proc.ts` 的杀树肌肉可复用，若其先 apply）。

## Goals / Non-Goals

**Goals**：内置 shell 在任意会话（主/子代理）停滞超过阈值时被解锁；处置可审计、可 dry-run、可关闭；误杀面收敛到宿主进程树内、时间窗内、带标记（或推算匹配）的进程；独立于 job-supervisor 退役。

**Non-Goals**：不修核心 bug（#51291 类无进程挂死只能上游修，哨兵仅上报）；不管辖 forge_shell 的 job（其自有 idle/maxwait/kill/owner 体系）；不做子代理整体停滞检测（Hermes 的 450s 会话级监视——会话级事件语义在 1.18 不可靠，等上游，本 change 只做工具调用级）；不注入消息到忙碌会话（#41753 排队语义，预警无意义）。

## Decisions

### D1 标记通道：shell.env + callID
`shell.env` 是唯一能把"哪次调用"写进子进程环境的钩子（入参含 `callID`，类型上为可选字段：**callID 缺失时不注入标记、不计时**——防 undefined 成为计时表 key，此时照常跑命令，只是本次不受哨兵管辖）。标记变量名 `FORGE_WATCHDOG_MARK=<plugin-namespaced callID>`，值含插件名与 callID，天然排除外国进程。计时表 key=callID，value=(sessionID, t0, toolName)；before 写入、after 清除、dispose 清空。

### D2 定时器：单例 interval 扫表，非每调用一个 timer
计时表由一个低频 interval（如 30s）扫描：到 80% 的打预警、到阈值的进处置。调用数通常个位数，扫表成本可忽略；避免海量 timer 的分配与清理负担。模式为 `off` 时不启 interval（完全惰性）。

### D3 进程定位：POSIX 精确 / Windows 推算，双实现可注入
- POSIX：遍历 `/proc/*/environ` 精确匹配 `FORGE_WATCHDOG_MARK=<callID>`（命中集即为处置集）。
- Windows：读第三方进程 env 不可行（无公开 API）→ 推算。**实机修订（2026-09-26，opencode 1.18.32/Win11）**：CIM 的 `ParentProcessId` 对宿主起的 shell 子进程不可靠（同一复现在两次运行里分别把 bash 工具子进程报到宿主名下与隔代 shell 名下），纯子孙闭包会漏掉待杀目标；且 `#47350` 类挂死在处置时刻其 bash/launcher 链**已正常退出**，唯一活进程是 detached 管道持有者（父已死、命令文本不同）——子树与命令匹配都看不见它。据此 Windows 定位为两波：
  - **波 1（精确面）**：命中 = 时间窗内 ∧（宿主子孙闭包 ∨ 命令行携带本次调用命令的特征 token（`commandNeedle`，取命令最长 token））；排除定位器自身（含 `Win32_Process` 的命令行）与一切 `conhost.exe`（杀 conhost 会瘫痪后续探测）。
  - **波 2（工作区面）**：仅当波 1 为空（或波 1 击杀后观察窗内仍未解锁）时，命中 = 时间窗内 ∧ 命令行（分隔符归一化后）位于停滞命令自己的目录——即 #47350 形态 detached helper 所在处。误杀面由"时间窗 + 同目录 + 仅在波 1 证明不足后"三层收敛，dry-run 可审计。
  - 时间窗带 2s 宽限（CIM CreationDate 秒级取整 + before→spawn 延迟）。
  - 实现注：PowerShell 经 `execFileSync("powershell", [...])` 直接调起（`execSync` 默认 shell 是 cmd.exe 会把管道符喂给 cmd）；不用 `-AsArray`（PS 5.1 无此参数）。
两路统一接口 `locate(callID, t0, needle?, phase2?) → pid[]`，注入 fake 可测。杀树复用 `src/proc.ts`。

### D4 处置分级与单次性
80% → 账本预警条目（不动会话）；100% → 定位 + 杀树 + 记账（命中清单含候选全集、命令行、时间戳）；击杀后等待观察窗（如 60s）仍无 after → 追加"unresolved"诊断条目（#51291 类）。每 callID 一个 `acted` 标志，处置至多一次——避免对同一调用反复击杀或与 after 竞态双杀。**实机修订**：Windows 侧"处置"为两波（D3 波 1/波 2），波 2 只在波 1 空手或证明不足后发生；`wave` 记录 0/1/2，波 2 之后不再有第三波（观察窗耗尽 → unresolved）。定位器/击杀的任何异常都被兜住并降级为 unresolved 记账，扫描器不因单次处置失败而死。

### D5 阈值默认 600s
Hermes inside-tool 上限 1200s 的一半：宁可偏早（用户核心诉求是止损数小时级挂死）；`watchdog.stallMs` 可配，最小保护值（如 60s）防误配成 0。

### D6 模式默认 kill，dry-run 先行建议
默认 `kill`（装了哨兵就是要止损）；README 建议首次部署可先 `dry-run` 观察一轮再切 kill。三层误杀防护（标记/树+时间窗、创建时间校验、单次处置）下，kill 的爆炸半径限于停滞调用自身。

### D7 账本：有界 JSONL
`<tmp>/opencode-forge/watchdog/log.jsonl`（append-only JSONL，按条数上限轮转删旧）；条目含 callID、sessionID、tool、t0、事件（warn/kill/unresolved）、命中进程清单（pid/命令行/创建时间）。README 文件账本与卸载说明覆盖。

### D8 与 job-supervisor 的互斥边界
forge_shell 的 spawn 不设 `FORGE_WATCHDOG_MARK`（job 体系自己的 idle/maxwait 归还、kill、owner 终束清杀已覆盖生命周期）；哨兵只 match 内置 shell 的标记。两 change apply 顺序无关、运行时互不感知（仅共享 proc 杀树肌肉）。

## Risks / Trade-offs

- [Windows 推算误杀并发调用] → 树+时间窗收敛 + dry-run 审计 + 单次处置；README 说明并发场景的残余风险。
- [杀掉实际在干活的慢命令]（阈值内正当长跑被击杀——但阈值默认 600s 且限不活跃语义：计时的是"调用未结束"而非"无输出"；正当长跑会被误伤）→ 明确权衡：内置 shell 无输出可见性，无法区分"挂着"与"安静地干活"；600s + 可配 + dry-run 是该信息约束下的最优解；引导规则（job-supervisor 的 system.transform）已把正当长跑引向 forge_shell（那里有真 idle 判定）。
- [shell.env 钩子在 v2/未来版本不触发]（参照 #41117 先例）→ 探测到标记缺失时哨兵自动降级 dry-run 并记账（不盲杀）。
- [扫描实现的平台差异] → locate 注入 fake 单测覆盖两路；实机验证双平台各一轮（tasks 7.x）。

## Migration Plan

与 `add-job-supervisor` 同车 0.3.0（后到者递增 patch）。上线默认 kill；建议 release notes 引导先 dry-run 一轮。退役：上游修复发布后用户手动 `dry-run` 观察 → `off`；插件大版本可改默认 off（届时以 README 公告）。

## Open Questions

- 预警/击杀条目的保留条数与轮转阈值（实现期定，账本有界即可）。
- Windows 推算是否需要排除已知系统 shell 祖先（如 svchost 起的进程）——实现时按"必须祖先是 opencode 宿主进程"已排除，无需额外名单。
