# add-hang-watchdog — 内置 shell 挂死的停滞哨兵（全 会话兜底）

## Why

job-supervisor（并行 change `add-job-supervisor`）让走 `forge_shell` 的命令结构性免疫挂死，但**内置 shell 工具的挂死类 bug 仍会在其管辖之外发生**：用户自定义 agent 继续用内置 shell、降级矩阵 stage 1/2 恢复内置 shell 之后、以及任何未经 forge_shell 的执行路径。上游实测过的挂死形态（#47350：孙进程握管道 1h44m、#49169：超时后不放弃 stdio 读取、#47546：子代理同款）在 1.18.x 均未修复；且 opencode 的 `task` 工具对子代理无超时无看门狗（源码核实），内置 shell 挂死会连带父层 task 调用无限等。

参照系的做法是在子代理/停滞层设常驻监视（Hermes：闲置 450s / **卡在单个工具调用内 1200s 即中断**，结果带 `timeout_phase` 结构化元数据），原则是**限不活跃、不限总时长**。opencode 插件层拿不到内置工具运行中的进程句柄（`tool.execute.before/after` 只在前后各触发一次），但 `shell.env` 钩子入参带 `callID` 且对所有会话（主/子代理）生效——这是把"哪个进程属于哪次调用"写进环境的唯一通道。据此做停滞哨兵：标记 → 计时 → 到点击杀解锁，作为独立于 job-supervisor 的兜底层。

## What Changes

- **标记与计时**：`shell.env` 钩子为内置 shell 的子进程注入带 callID 的标记环境变量；`tool.execute.before`（tool ∈ shell/bash）记录 `(callID, sessionID, t0)`，`tool.execute.after` 清除。覆盖插件进程内**所有会话**（主会话与 task 派出的子代理一视同仁）。
- **停滞判定与分级处置**（Hermes 式三级）：
  1. 预算 80%：写诊断账本与插件日志（不向会话注入消息——会话正忙时注入只会排队，预警失去意义）；
  2. `watchdog.stallMs`（默认 600000，可配）仍无 after：定位该调用的进程树并**杀树**——进程一死管道 EOF，卡住的内置调用立即解锁；
  3. 击杀后仍无 after（如 #51291 类流消失、根本无进程可杀的挂死）：仅诊断上报，诚实边界。
- **进程定位（跨平台混合策略）**：POSIX 经 `/proc/<pid>/environ` 精确匹配标记 env；Windows（读第三方进程 env 不可行）按宿主进程的子孙树 + 创建时间 ≥ t0 + 时间窗推算。两路都要求祖先是 opencode 宿主进程。
- **误杀防护三层**：只处置带本插件标记（POSIX）或满足树+时间窗推算（Windows）的进程；杀前校验进程创建时间不早于调用 t0；每 callID 至多处置一次（击杀后不再重复）。
- **模式旋钮**：`watchdog.mode: "off" | "dry-run" | "kill"`，默认 `kill`（用户核心诉求是止损；`dry-run` 只记录将要处置的进程清单）。
- **诊断账本**：每次介入（预警/击杀/仅诊断）写入 `<系统临时目录>/opencode-forge/watchdog/`（有界轮转），README 文件账本增补，卸载无残留。
- **与 job-supervisor 的边界**：`forge_shell` 的 job 不打哨兵标记、不受哨兵管辖（job 体系自有 idle/maxwait/kill/owner 生命周期）；哨兵只管内置 shell 调用。两层互不越界。
- **独立退役路径**：当上游以 exit-based completion 修复相关 issue 并发布后，建议用户切 `dry-run` 观察、再切 `off`；旋钮与文档即退役通道（不自动探测"已修复"——语义级完备不可自动判定，与 job-supervisor D10 同立场）。
- 版本：与 `add-job-supervisor` 同车 0.3.0（先后 apply 时以后到者递增 patch）。

## Capabilities

### New Capabilities

- `hang-watchdog`：内置 shell 挂死的停滞哨兵——标记与计时契约（shell.env + before/after，全会话覆盖）、三级分级处置（预警诊断 / 到点击杀解锁 / 无进程仅诊断）、跨平台进程定位与三层误杀防护、模式旋钮（off/dry-run/kill）、诊断账本与文件账本、与 job-supervisor 的管辖边界、独立退役通道。

### Modified Capabilities

（无——哨兵不改任何 agent 配置、不注册模型可见工具、不改既有 capability 的 requirement。）

## Impact

- **本仓库**：`plugin.ts`（shell.env / tool.execute.before / tool.execute.after 接线、watchdog 配置）、新 `src/watchdog.ts`（计时表/判定/处置引擎/账本，无 @opencode-ai 依赖）、新 `src/proc-locate.ts`（POSIX environ 匹配 + Windows 树推算，可注入 fake）、`tests/watchdog*.test.mjs`、README（watchdog 章节、文件账本、退役指引）、AGENTS.md 架构表。
- **宿主 opencode API 面**（1.18.32 类型已核实存在）：`shell.env`（入参含 `callID`）、`tool.execute.before/after`、plugin `dispose`。不新增模型可见面。
- **无新增依赖**；打包红线不受影响。
- **系统副作用**：击杀的是宿主 opencode 进程树内、被标记/推算属于停滞调用的进程——三层防护下误杀面收敛到"时间窗内宿主新起的 shell 子孙"，dry-run 模式可零风险试运行。
