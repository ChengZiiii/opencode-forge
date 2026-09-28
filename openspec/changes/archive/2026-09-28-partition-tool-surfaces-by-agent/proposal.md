# Proposal — partition-tool-surfaces-by-agent

## Why

当前 forge 面与非 forge 面的执行边界是概率性的：原生 shell 只在 stage 0 被隐藏（探测到宿主 `run_in_background` 后即放回，本机 1.18.32 已处于 stage 1），forge-* write 子代理的原生 bash 从未隐藏；同时 `[forge:job-guidance]` 注入进**每一个**会话（包括 build/general 等非 forge agent）。结果：forge 会话仍可能走上内置 shell（无输出可见性，只能靠 watchdog 10 分钟盲杀兜底），非 forge 会话却被灌进用不了的 forge 工具指导。用户要求把行为**定死**：forge 家族（主 agent + 全部派生子代理）一律走 forge_shell 自有体系；非 forge agent（原生 build/plan/general/explore 及用户自定义）一律纯原生，双方工具面互不可见。

## What Changes

- **forge 面 shell 强制（无条件化）**：forge 主 agent 与全部 forge-* 子代理（readonly/write 两种形状）的 runtime 注入统一携带 `tools: { shell: false, bash: false }`——不再依赖 stage 0 探测；**用户自定义的 `agent["forge"]` 条目同样注入**（仅合并写入内置 shell 关闭项，其余字段一律不碰——这是对现有"用户自定义条目不注入"场景的明确反转，`jobs.keepBuiltinShell` 成为唯一逃生门）；`STAGE1_NOTE`（"优先原生 run_in_background"注记）随之移除。`jobs.mode: "native"` 仍是 supervisor 整体退役+原生回归的唯一路径（退役时隐藏同步撤销，避免 forge 无 shell 可用）。
- **非 forge 面 forge 工具隔离**：config hook 对除 forge/forge-* 外的所有 agent 条目注入 `tools` 隐藏全部插件注册的 forge 工具（forge_shell、forge_jobs、crew_begin、crew_close、11 个 plan_*/goal_*）——覆盖原生 build/plan/general/explore（不存在于 config 的原生条目按 build/plan 同款机制物化）与一切用户自定义 agent；用户对该工具显式 `true` 的条目尊重不覆盖（no-clobber 纪律）。
- **build/plan 复活（BREAKING 于 forge-agent spec）**：插件不再对原生 build/plan 注入 `disable: true`——Tab cycle 从"forge 唯一 primary"变为 forge 与原生 primary 共存，非 forge agent 恢复完全原生行为。
- **forge 系统注入按 agent 门控**：`[forge:job-guidance]`（以及 plan-notice / goal-notice / crew-active / goal-brief）只注入 agent 为 forge / forge-* 的会话；信号源为 `chat.message` / `chat.params` 采集的 sessionID→agent 映射，未知不注入（fail-silent）。goal 续跑引擎在检测到会话当前 agent 非 forge 族时跳过本轮续跑（避免续跑 turn 跑在无 goal 工具的 agent 下空转）。
- **forge-* 派发护栏**：宿主 task 工具的 agent 词汇表是全局的（无法按父 agent 隐藏 forge-* 条目），非 forge agent 对 forge-* 子代理的派发调用在工具层硬拒绝（引导性报错，不创建子会话）。
- **watchdog 管辖域收缩（零溢出）**：watchdog 是本插件自有能力（非 opencode 原生）。按"forge 功能不溢出"要求，标记/计时/介入收缩到 forge 族会话——非 forge 会话零标记、零计时、零强杀，内置 shell 行为完全原生。
- **forge 族内部分层（全量审计新增）**：harness 状态工具（plan_*/goal_*/crew_*）收敛为 forge 主 agent 专属——forge-* 子代理只保留 forge_shell/forge_jobs（执行+监督），杜绝工人会话触碰状态机。
- **命令入口重定向（全量审计新增）**：/plan、/goal、/crew 模板加 fail-fast 护栏——非 forge 族会话（自检工具面缺失）立即停止并引导切换 forge，不执行任何纪律步骤。
- **状态文件边界（全量审计新增）**：非 forge 会话对 `.opencode/plan/`、`.opencode/goal/` 的写操作在工具层拒绝（读不限），forge 自有状态防越界改动。
- **compaction autocontinue 抑制随族门控（全量审计新增）**：仅当会话当前 agent 为 forge 族时才抑制宿主压缩后续跑。
- **draft 写禁保持会话级（显式声明的唯一越界）**：draft 期写禁对会话内任何 agent 生效——被动保护共享状态的互操作；设计原则"被动防护可达，主动驱动不可达"（forge 永不驱动非 forge 轮）。
- **明确不改变的**：watchdog 的介入分级/阈值/模式语义本身（只缩管辖域）；plan/goal/crew 的会话级状态语义与门（ask 确认框）不变；`agent["forge"].disable` 一键回原生语义不变。

## Capabilities

### New Capabilities

- `tool-partition`: 按 agent 家族硬分区工具面与系统注入——forge 家族（forge 主 agent 与 forge-* 子代理）执行面强制为 forge_shell/forge_jobs、内置 shell/bash 隐藏；非 forge agent 隐藏全部 forge 注册工具、零 forge 系统注入；含逃生门（keepBuiltinShell、用户显式 tools 覆盖、mode:native 退役）与混合会话边界语义。

### Modified Capabilities

- `forge-agent`: 「Register the single general-purpose forge agent」的"Tab cycle 唯一 primary"与「Hide the native build/plan agents」需求修订为共存——forge 与原生 primary 并存，插件不再禁用 build/plan；「One-knob return to native」措辞随注入面改写；disable 旋钮与卸载自愈语义不变。
- `job-supervisor`: 「Capability probe and staged degradation」修订——探测不再驱动隐藏的撤销：`auto`/`forge` 两档等价（隐藏恒成立），仅 `native` 退役；「Model-facing guidance injection」从"所有会话"修订为"仅 forge 族会话"。
- `hang-watchdog`: 「Marking and timing of built-in shell calls across all sessions」重写为 forge 族管辖——非 forge 会话不标记、不计时、不介入（watchdog 是插件自有功能，零溢出）。

## Impact

- `plugin.ts`：config hook（build/plan 复活、非 forge 条目遍历注入、原生 build/plan/general/explore 物化、探测退役）、`experimental.chat.system.transform`（门控）、event/chat.message（agent 映射表）、goal 续跑引擎守卫（agent 族检查）、`tool.definition`（STAGE1_NOTE 移除）、`tool.execute.before`（task 派发护栏；draft 写禁不变）、`shell.env` + watchdog 接线（forge 族门控）。
- `src/dispatch-tiers.ts`：`forgeAgentDef` 增加执行面隐藏字段。
- `src/watchdog.ts` 零改动（纯逻辑引擎不动，管辖域由接线层门控）。
- 核心机制假设需 E2E 验证：host 的 agent `tools` 过滤对**插件注册工具**与 forge_shell 同样生效（对内置 shell 已在生产验证）；若宿主忽略，降级路径为 tool.execute.before 硬拒绝（design 记录）。
- 测试：job-wiring（隐藏三态改写）、forge-subagents-wiring（物化带 tools）、新增 partition wiring 测试（非 forge 隔离/门控/映射表）、v2-setup 对等守卫。
- 文档：README（共存说明、行为标准表、stage 表退役）、AGENTS.md 架构行。
- 顺序依赖：建议先归档 `simplify-dispatch-to-static-agents`（已完成 21/21 未归档，其 delta 含 dispatch/forge-subagents/crew-harness 基线），使 spec 基线与已实现代码一致后再 apply 本 change（本 change 的 delta 不直接触碰该 change 的能力文件）。
