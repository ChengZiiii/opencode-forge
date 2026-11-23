# “跑着跑着停住”诊断记录 — 2026-11-23

> 状态：**已按用户裁定关闭**（2026-11-23：今日中断归因 Paseo 客户端侧，指示不再追查；
> 宿主已升 2.4.0，不再考虑降级）。本记录只做留档——2.4.0 上若复发，从这里续查。

## 现象

- TUI 显示 `[System Error] The operation timed out.`；该回合判失败、宿主不重试，会话停在
  空闲态，必须用户再发一条消息才继续（过夜自主闭环里等于整夜停摆）。
- 真机日志：`ERROR message="Failed to drain Session" cause="TimeoutError: The operation timed out."`，
  `role=server`。
- 真机日志 2026-11-19 17:27 → 2026-11-23 08:53（UTC）共 **26 次 / 18 个会话，全部在 v2.3.2**；
  其中 2026-11-23 06:25–08:53 主会话（`ses_…yhA95A`）6 次，过夜 crew 的 8 个子会话各中过 1 次。

## 调用栈（2.3.2 构建，chunk-qqvj4jwz / chunk-41r1gxg9，自安装二进制抠出的源码）

```
TimeoutError: The operation timed out.
    at SessionModelRequest.prepare
    at SessionRunner.runStep
    at SessionRunner.drain
    at ServerProcess.start
```

- `prepare` 第一步：`trigger("session","context",{sessionID, model, system, messages, options, agent, tools})`，
  随后 `trigger("session","model.request",…)`；`runStep` 外层没有显式超时。
- 结论：超时发生在触发器内部等待的某个 Promise 上（Bun `Promise.timeout` 语义的报错串），
  不是模型请求本身（请求尚未发出）。

## 已排除

| 假设 | 证据 |
| --- | --- |
| 模型的问题 | 失败在请求准备阶段，请求未发出 |
| 工具调用卡住 | 工具全部 `completed`，失败在其后的下一次请求准备 |
| forge 的 context 钩子慢 | `v2ContextInjection` 全同步；唯一异步点 `ensureSessionRescueRule` 是 fire-and-forget |
| 数据库持续不健康 | 642 次 `insert into "session_message"` 失败全在 11-20 02:58 的 11 秒内（一次批量导入） |
| 客户端路径模板问题 | 108 次 `%7Bid%7D` 报错全在 11-15 一个下午 |
| 版本（v2.2.7 免疫） | v2.2.7 上 0 次，但只有 15 次启动 / 约半小时使用量，样本不足，**不下结论** |

## 判别性证据

- **只装 forge 的沙箱宿主（同为 2.3.2，全天 E2E）**：14 次 drain 失败，原因全部是 forge agent
  未物化（11 次，11-22 14:28–14:54）与鉴权头缺失（3 次，11-22 15:44–16:01），
  `The operation timed out` **0 次** → 该故障依赖真机独有条件（其他插件 / 客户端 / 负载 / 网络）。
- 真机加载 14 个插件并挂着 Paseo 客户端；沙箱只有 forge。

## 方法论缺口（记账，待立约定）

③ GATE 的“生产同款沙箱”目前只加载 forge——凡依赖真机插件集 / 客户端的交互缺陷在沙箱里
**不可见**。建议后续至少一条验证腿带用户真实插件集跑。

## 补记：2026-11-23 21:41 的中断是整机崩溃（用户当晚追问“会话总断开”后取证）

**这一次既不是 Paseo，也不是插件。** 系统事件日志（本地时间，`view-e2e/machine-downtime.ps1`）：

| 时刻 | 事件 |
| --- | --- |
| 21:41:14 | 系统非正常关机（EventLog 6008；Kernel-Power 41；无 1001 BugCheck 记录） |
| 21:41:50 | 开机 |
| 21:42:59 / 21:44:32 / 21:45:35 | `TrustedInstaller.exe`（NT AUTHORITY\SYSTEM）三次发起重启（User32 1074）——Windows 更新在装 |
| 21:46:23 | 末次开机（22:34 实测系统运行时间 0.8 h） |
| 22:20:58 | 真机 opencode 宿主重启（新 pid），会话至此恢复；主会话一条工具调用从 21:41 挂到 22:21 |

崩溃前的机器状态（20:30–21:00 实测，`view-e2e/probe-hostcpu.mjs`）：CPU 92–98%；
Telegram（pid 43560）单进程持续 7–8.5 核；进程创建慢 5–10 倍（PowerShell 启动 5–9 s、
node 1.5–6 s）；同一时刻沙箱宿主 ≈0.13 核、真机宿主 ≈0.02 核。重启后 22:34
（`view-e2e/machine-load.ps1`）：CPU 29%、磁盘空闲、空闲内存 46 GB、Telegram 未运行。

对上文结论的影响：

- **负载不是充分解释**：沙箱宿主跑在同一台满负荷机器上，`The operation timed out`
  仍为 0 次。满负荷最多是放大因素——真机挂 14 个插件与 Paseo 客户端，其钩子在
  CPU 饥饿下更容易撞触发器内部的超时；未证实，列为 2.4.0 复发时的首要核对项
  （复发时先看 `machine-load.ps1` 的采样）。
- 崩溃原因未定：无蓝屏记录；重启前唯一的持续大户是 Telegram。取证脚本已备
  （`machine-load.ps1` / `machine-downtime.ps1`），再卡死时先跑这两个。

连坐效应（对 ③ GATE 流程的教训）：forge 的作业围栏（`src/job-fence.ts`，
`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`）按设计在宿主退出时杀掉整棵作业树——
沙箱宿主与 E2E 驱动此前都作为真机宿主的 shell 作业运行，于是随宿主一起死，
当晚一轮 E2E 作废。沙箱进程此后必须脱离宿主进程树启动
（`view-e2e/launch-detached.mjs`，WMI `Win32_Process.Create`）。

## 2.4.0 上复发时的续查步骤

1. `node %LOCALAPPDATA%/Temp/opencode/view-e2e/probe-stall4.mjs hist 12` — 按宿主版本统计
   `Failed to drain Session`（注意 2.4.0 的构建里源码不再是明文，抠源码那几步不可用）。
2. `… probe-stall4.mjs win -1 44 'run=<id>'` — 失败时刻前后的真机日志窗口。
3. 隔离复现：沙箱带真实插件集 + 并发负载，逐个剔除插件定位慢钩子。
4. 插件侧兜底（行为改动，须立 change）：forge 族会话的回合因该错误失败后，有界次自动续跑。
