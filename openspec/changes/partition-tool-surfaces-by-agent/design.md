# Design — partition-tool-surfaces-by-agent

## Context

宿主 1.18.32 实测 agent 名单（`GET /agent`）：原生 `build`/`plan`（被本插件 `disable` 后从名单消失）、`general`/`explore`（subagent，task 派发默认面）、隐藏的 `summary`/`title`/`compaction`；插件侧 `forge` 与 forge-* 物化条目。机制事实：(a) agent 条目的 `tools` map 对**内置**工具的隐藏已在生产验证（stage 0 时代）；对**插件注册工具**的过滤是本 change 的承重假设，需 E2E 首验；(b) `chat.message` 入参带 `agent?`、`chat.params` 必带 `agent`（probe P1 证实对 task 派生会话同样触发）、`experimental.chat.system.transform` 不带 agent——注入门控必须自建 sessionID→agent 映射。动机见 proposal Why。

## Goals / Non-Goals

**Goals:** forge 族（forge + forge-*）与原生面的工具/注入双向硬隔离；非 forge agent 对 forge-* 的派发硬拒绝；build/plan 复活共存；watchdog 管辖域收缩到 forge 族（零溢出）。

**Non-Goals:** 不改 forge_shell/forge_jobs 工具本体与 job 语义；不改 plan/goal/crew 门与会话级状态机；不改 watchdog 的介入分级/阈值/模式语义（只缩管辖域，引擎零改动）；不做 v2 隔离（v2 无 tool 域，README 既有边界声明）；不动 `summary`/`title`/`compaction`（隐藏工具型 agent，无工具面）。

## Decisions

### D1 隐藏统一走 config hook 的 `tools` 注入（唯一机制，双向复用）
forge 族注入 `shell:false, bash:false`；非 forge 条目注入 15 个插件工具的 `false`。对 config 中已存在的条目做**键级合并**（只写我们的键，用户显式 `true` 不覆盖——no-clobber 与"尊重显式意愿"一致）；对 config 缺席的原生条目按 build/plan 同款机制物化最小条目（`{ tools: {...} }`，宿主按名合并原生定义）。被否替代：tool.execute.before 硬拒绝（工具仍可见，模型反复试错浪费 turn；只留作宿主不支持 tools 过滤插件工具时的降级路径，见 R1）。

### D2 forge 族的注入点分两处
主 agent 在 config hook 现有位置（条件从 `jobStage() < 1` 改为 `jobStage() < 2` 且不再看探测、且 `userDefinedForge` 也注入）；forge-* 在 `forgeAgentDef` 物化时携带（readonly 与 write 形状统一；readonly 的 permission deny bash 保留作双保险）。`userDefinedForge` 反转的理由：owner 要求"定死"；合并注入不触碰用户字段，且 keepBuiltinShell 是唯一保留逃生门——两条逃生门（自定义条目 + keepBuiltinShell）收敛为一条，契约更简单。

### D3 非 forge 清单 = 显式枚举 + config 全遍历
config hook 遍历 `cfg.agent` 全部键（除 `forge`/`forge-*`）注入隔离；对 config 缺席的原生条目显式物化 `build`、`plan`、`general`、`explore`。被否替代：试图枚举"未来未知内置 agent"（不可行，宿主名单漂移只能靠升级插件跟进——README 行为表注明）。

### D4 注入门控用 sessionID→agent 映射（chat.message 主源 + chat.params 兜底）
`chat.message` 在请求管线最早带 `agent`；`chat.params` 必带 `agent` 且对派生会话触发（P1）。两源都 upsert 映射（bounded，session.deleted 逐出，复用 sessionDepths 的表风格）。未知 agent → 不注入（fail-silent：宁漏注入不污染非 forge 面；forge 自身 prompt 已含纪律，损失可忽略）。探测顺序风险（chat.params 是否先于 system.transform）不阻塞：最坏情形是新会话首轮漏注入，次轮自愈。`[forge:goal-continue]` 续跑 brief 不经 system.transform，由引擎在**调度时**查同一映射（idle 即判，非 forge 族连 session.get 探测都不发），发送前二次复核；非 forge 族直接 skip（不记 turn，goal 保持 active）。

### D5 探测与 STAGE1_NOTE 退役，jobs.mode 语义收敛
`nativeBackgroundSeen` 与两处探测点（config experimental 正则、tool.definition 参数表）移除；`STAGE1_NOTE` 注入删除。`jobStage()` 简化：`auto`/`forge` → 隐藏恒成立的同一档，`native` → 退役档（工具注销 + 隐藏撤销同tick，防止 forge 裸奔无 shell）。选项值三态保留解析（向后兼容用户现有 config）。

### D6 混合会话边界（同一 session 换 agent）
工具面与注入按"当前请求的 agent"走（映射表即最后信号）；plan/goal 会话级状态不感知 agent（现状语义）：draft 写禁仍对该 session 的任何 agent 生效——非 forge agent 在 draft 期被禁写且看不到 plan_* 工具，notice 缺失可能让它困惑，README 混合会话小节说明"切回 forge 处理 plan/goal"。goal 续跑按 D4 跳过非 forge 轮。

### D7 watchdog 管辖域收缩：接线层门控，引擎零改动
`shell.env` 的标记注入与 `tool.execute.before` 的 `watchdog.track` 均查 D4 的 sessionID→agent 映射：forge 族照常标记/计时，非 forge 族与未知会话**不注入标记、不计时**（自然永不介入）。被否替代：改 watchdog 引擎加 agent 参数（引擎是纯逻辑、注入式测试，改接口波及测试面，而门控本质是"哪些调用进入管辖"的接线决策）。溢出面复核：非 forge 会话从此不获得 `FORGE_WATCHDOG_MARK` 环境变量（连不可见管道也不碰）。归档后需直接编辑 `openspec/specs/hang-watchdog/spec.md` 的 Purpose 行（delta 不承载 Purpose 修改）。

### D8 forge-* 派发护栏：tool.execute.before 硬拒绝
宿主 task 词汇表全局可见（D10 时代设计即如此：`not hidden` 是可发现性的前提），无按父 agent 裁剪词汇的宿主机制 → 非 forge 会话（按映射表）对 `agent` 参数为 `forge-*` 的 task 调用在 `tool.execute.before` 抛引导性错误（点名 partition，建议用原生 general/explore 或切 forge），不创建子会话。反向不受影响：forge 族派发 forge-*（crew 波次）照常；forge-* 自身 `task: deny` 递归禁令不变。被否替代：把 forge-* 改回 `hidden`（全部 agent 都看不见，连 forge 也派发不了——与任务词汇可发现性直接冲突）。

### D9 harness 状态工具 primary 专属（全量审计产出）
现状全部会话可见全部插件工具：readonly research 工人理论上可调 `plan_tick`/`goal_pause`/`crew_begin`——工人触碰状态机是管辖内硬度缺口。修正：config pass 对 forge-* 条目键级合并注入 plan_*/goal_*/crew_* `false`，工人只留 forge_shell/forge_jobs（job-guidance 的 poll 收集规则仍适用）。forge 主 agent 工具面不变。被否替代：按工具调用时校验（工具可见却拒绝，模型反复试错；不可见才是硬约束）。

### D10 命令入口重定向：模板 fail-fast 护栏 + 工具缺失双保险
/plan、/goal、/crew 是全局命令（宿主无按 agent 的命令可见性），build 会话可敲 /plan 拿到整本纪律再撞工具墙。模板头部加自检护栏："先确认 plan_write/goal_write/crew_begin 在你的工具表里；不在即非 forge 会话——立即停止，告知用户切到 forge 重跑"。软护栏（prompt 级）但零风险：真正有杀伤力的步骤全部依赖缺失的工具，模型自检工具表是可靠能力。`!`ls`` 目录列举在护栏前执行，只读无害。被否替代：按会话动态改写命令模板（config hook 无会话上下文，宿主机制不存在）。

### D11 状态文件边界：非 forge 会话禁写 .opencode/plan|goal
tool.execute.before 对非 forge 会话（按映射表）的 write/edit 目标做路径前缀检查，命中 `.opencode/plan/`、`.opencode/goal/` 即拒绝（点名边界）；读不拦。性质是**边界防御非安全边界**：这些文件本就在工作区内，任何 agent 的 write 都物理可达，硬护栏只是防误触（诚实标注，不宣称防恶意）。forge 自身经 write 手改状态文件属既有行为，由工具层结构校验兜底，不在本 change 范围。

### D12 draft 写禁保持会话级：被动防护可达 / 主动驱动不可达
全量审计的划分原则：forge 对非 forge 轮的影响分两类——**被动防护**（draft 写禁：防止切 agent 绕过 draft 禁令的 loophole，保护的是会话共享状态）保持会话级；**主动驱动**（goal 续跑、注入、唤醒）一律族门控。这条原则把"零溢出"精确定义为"零主动溢出"，写进 spec 作为显式声明的唯一越界，README 混合会话小节同名解释。

### D13 default_agent 钉回 forge（apply 期发现，E2E 实证）
宿主 1.18.32 二进制逻辑：`config.default_agent ? match : "build"`（SDK 类型未声明但功能存在）。build/plan 复活后默认主语会从 forge 翻回 build，违反本 change ADDED 需求自带场景「A direct unplanned task is executed by forge」。修正：config hook 注入 `default_agent ??= "forge"`（`??=` 尊重用户显式配置——用户写 "build" 则随他）。被否替代：仅 README 文档化（要求每个用户手动补救一次升级断裂，不可接受）。

## Risks / Trade-offs

- [宿主 `tools` 过滤不覆盖插件注册工具 → **已实证触发（apply 期）**：本机 paseo 宿主构建对插件 config-hook 注入的 agent 条目整体忽略 tools map（文件定义条目正常）——1.1 探针证明机制存在但仅限文件条目，运行时注入条目的内置/插件工具全数可见] → **R1 降级已落地**（fallback requirement）：tool.execute.before 双 belt——forge 族 bash/shell 硬拒绝（keepBuiltinShell/退役放行）+ 非 forge 族 15 个 forge 工具硬拒绝；unknown fail-open。标准宿主上注入生效时 belt 永不触发（无成本）；本机宿主上"不可见"降级为"可见但不可用+引导"。
- [非 forge 面彻底没有挂死兜底] → 这是 owner"零溢出"要求的直接结果而非损失：非 forge 面回归纯原生姿态（该面的 stall 保护本来就是插件外加的功能）；watchdog 保留的全部价值在 keepBuiltinShell 逃生门与 forge 族的任何泄漏路径上，默认 kill + stallMs 可配不变。
- [原生条目物化的合并语义与预期不符（替换而非合并）] → build/plan 现有 disable 注入已证实按名合并生效；E2E 再验 general/explore 物化后 prompt/工具不丢。
- [forge-* 隐藏 bash 后 write 工人丧失快速命令能力] → forge_shell 前台快命令语义等价（exit 即返回），仅多一道 ask 门（该门对原生 bash 同样存在于默认权限姿态）；crew/worker 纪律文本（dispatch-prompt）同步加一句"命令一律 forge_shell"。
- [会话↔agent 映射的表膨胀] → bounded：session.deleted 逐出（复用现有事件），表项为短字符串。
- [build/plan 复活改变 Tab cycle 习惯] → BREAKING 已在 proposal 标注；用户可用自己的 config disable 条目复原 forge-only（插件永不触碰用户写的字段），README 迁移小节写明。

## Migration Plan

先归档 `simplify-dispatch-to-static-agents`（owner 指令），再按 tasks 顺序实现；单版本发布（major 或 minor+BREAKING 标注）。回滚 = 卸载插件（无磁盘残留，README 四步）或 `agent["forge"].disable: true`。发布说明提示 Tab cycle 变化与 keepBuiltinShell/mode:native 两个行为开关。

## Open Questions

无——承重的机制假设（tools 过滤插件工具）不改变 spec 意图，只影响"不可见 vs 不可用"的实现路径，已按 R1 预置降级。
