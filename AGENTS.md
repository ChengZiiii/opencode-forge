# AGENTS.md — OpenCode Forge 开发规则

## 项目简介

单一通用 agent **forge** + 双正交 harness 的 opencode 插件。**plan
harness**（决策优先）：plan 落盘 `.opencode/plan/`、结构由工具校验、
draft 期写操作权限层硬禁、`plan_approve` / `plan_close` 钉死 ask（用户
确认框即批准/完成门）、`plan_tick` 打勾带时间戳审计。**goal harness**
（执行优先）：目标契约落盘 `.opencode/goal/`、idle 续跑引擎在
turn/分钟预算内自主推进、完成门由插件**在宿主机上重跑全部验证项**
（fail-closed）、无进展/传输失败/预算耗尽/草稿冲突自动暂停。三工作流
（OpenSpec / plan / goal）语义零耦合，仅安全互操作（draft 禁写优先）。

- 行为规范：`openspec/specs/`（改行为前必读）
- 用户文档：`README.md`（安装/卸载/文件账本/goal 章节）

## 架构总览

| 文件 | 职责 |
| ---- | ---- |
| `plugin.ts` | 双入口：`server`（v1 hooks 全功能：config 注册 forge agent + 静态 `forge-<id>`/`forge-<ns>-<id>` 子代理（带钉扎 model；**append-only 锚点集合**——hierarchical-pool-materialization：server() 目录追加式入集、首个=primary 永不移除，共享宿主 re-init 只增池不翻转，物化取并集快照；主锚根池纯 id，其余池族 `forge-<ns>-<id>` 命名空间化）+ `/plan` `/goal` `/crew` 命令、tool 注册 5 个 plan_* + 6 个 goal_* + 2 个 job + 2 个 crew 工具（共 15 个）、permission.ask 禁写+钉门+forge_shell/crew_close 门、event 播种会话与 idle 续跑调度+job 唤醒投递+session.deleted 收割（会话深度表+agent 族表逐出）、chat.message/chat.params/工具上下文三源采集 sessionID→agent 族映射、tool.execute.before 活动标记+派发护栏+状态文件边界+draft 会话级写禁+crew pending 闸带（crew-harness：注册未武装即拒一切 task 派发）、chat.params 按 agent 名注入钉扎 thoughtLevel（池集合查表、每次现解析热应用）、system transform 全量 forge 注入按族门控（含 forge_shell 通道 mandate：hide 持有时硬命令、keepBuiltinShell 时偏好措辞、native/v2 无 mandate）、compaction 钩子随族门控）+ `setup`（v2 防御式注册 forge agent 与静态子代理（cwd 单锚池解析），create-only，无 tool 域）。**工具面按 agent 族硬分区**（tool-partition spec）：forge 族 shell/bash 隐藏+forge_shell 强制，forge-* 工人只留执行对（状态工具 primary 专属），非 forge agent 全部 forge 工具隐藏+原生物化，watchdog 管辖收缩至 forge 族。纪律载体：`/plan`、`/goal`、`/crew` 命令模板各自自含全量纪律+族护栏（hermes 式：进入轮即规则书，系统提示词零纪律）；/crew 模板按配置组合。crew 两段式生命周期（add-crew-execution-mode-gate：`crew_begin` 注册即 PENDING→三选一停点，`{execution:"waves"}` 武装 / `{execution:"goal"}` 转交 goal 契约 / standby；goal 治下（本会话 active goal）一次性 born-armed 合法且 close/abandon 免 ask、转交被拒；`crew_close {abandon}` 弃船口；crew 记录 `.opencode/crew/<date>-<slug>.md` record-only 共用 sessionAnchor 链；注册输出披露宿主池来源）。无捆绑 skill |
| `src/forge-config.ts` | forge.json 纯函数核心：JSONC 解析（保留空白/报错定位）、**字段级 fail-soft** 语义校验（坏条目跳过+error finding、坏可选字段忽略+warn、`depths` 弃用告警、坏文档仅清空**本层**+定位错误——另一层照常生效；`forge-` id 前缀自愈剥除+warn、归一后碰撞 latter-skip；无 seed、无 recipe）、**opencode 对齐级联**（全局打底 + 锚点向上遍历最近 `.opencode/forge.json` 按 agent id 整体覆盖合并，`project+global` 源 + `projectPath`）、mtime 热应用缓存（发现链每次 load 重走——文件增删也热应用）。**层级池解析器 `createPoolResolver`**（hierarchical-pool-materialization）：append-only 锚点集→池族（每锚点=向上链根池+有界 BFS 子树扫描子池：lex 兄弟序、依赖 skip-list 闭表、每锚 2000 目录预算、目录 mtime 缓存）；池身份=绝对路径跨锚去重；确定性序=主锚根池先+其余按路径字典序；主锚根池纯 id、其余族 `forge-<ns>-<id>`（ns=可选 `pool` 字段 fail-soft 校验 ≤24 字符 `[a-z0-9-]`，否则目录名清洗——小写/非法字符段折叠/修剪/`pool` 兜底）；ns 撞名递增后缀+error finding、跨族物化 id 撞名先者胜后者跳+finding；坏池文件仅清空本族；global-only 宿主全局层为纯 id 池兜底。**无副作用（fs 可注入）** |
| `src/dispatch-tiers.ts` | 静态子代理物化源：角色 prompt 分层（显式 prompt > research/review 内置默认 > 通用）、形状权限（readonly deny write/edit/bash；task: deny 恒强制）、`forgeAgentDef` 物化定义（**写 model**、不 hidden、task 词汇表可见、**带执行面 tools 隐藏 shell/bash**——tool-partition） |
| `src/dispatch-prompt.ts` | 常驻纪律 prompt：四条 mandate（相对路径/命令一律 forge_shell/原样上报拒绝/证据结论）+ 形状框架（readonly 报告型 / write 执行型）+ 角色文内嵌组合 |
| `src/dispatch-depth.ts` | 思考档位翻译（纯函数）：canonical 词表 verbatim-first / 不插值 / 全披露；三族 wire 形状（openai effort / anthropic budget / zai toggle）；`resolvePinnedDepth` 包装（不可译词 → 注入 nothing + finding，绝不打断会话） |
| `src/crew-gate.ts` | crew_close 门纯逻辑：报告对账**声明计划**（crew_begin 注册）——漏判/缺证据/野子任务/FAIL 双报告四类拒绝，标题归一化匹配。**无 ledger 依赖** |
| `src/models-dev.ts` | models.dev 快照切片：reasoning ladder + 价目（价目现仅备查）、parseIdentity/nativeLadder（档位校验用；快照不可用 → null → verbatim 透传） |
| `src/plan-file.ts` | plan 纯函数核心：slug/文件名、渲染/解析、结构校验、打勾变换、状态机、close 校验、active 发现排序。**无 @opencode-ai 依赖、无副作用** |
| `src/goal-file.ts` | goal 纯函数核心：契约渲染/解析（frontmatter+7 章节）、Check Log（runId 幂等追加）/Turn Ledger、预算状态、迁移状态机（paused 必带 stop_reason）、`carryHistory`（修订保留审计轨迹）、live/queued 发现排序。**无 @opencode-ai 依赖、无副作用、不 import plan-file（解耦红线）** |
| `src/run-check.ts` | 宿主验证执行器：shell（tree-kill 超时：win32 taskkill /T、POSIX 进程组）、file-contract（工作区内路径逃逸拒绝）、可注入 runner 测试缝 |
| `src/proc.ts` | 共享进程肌肉（自 run-check 抽出）：`shellSpawn`（shell:true、env 合并、detached 按 POSIX 默认）、`killTree`/`treeKillPlan`（win32 taskkill /pid /F /T、POSIX 进程组 SIGKILL，pid 缺失/组杀失败回退 child.kill）。**无 @opencode-ai 依赖、spawn 可注入**；run-check 与 job-runner 共用 |
| `src/job-manager.ts` | job 注册表纯逻辑：job 表/环形 tail/outLen 游标、终态 first-wins + 完成量上限逐出、所有权（session 级创建、session.deleted 杀活 job+账本记 orphan、handoff 转全局+重绑根会话、dispose 全清）、唤醒队列（单次投递、窗口期放弃、notify:false、terminal-evidence 抑制——exit 事件同步交割的 job 不发 wake 且完成即自清理）、有界账本 JSONL。**无 @opencode-ai 依赖、时钟/sink 可注入** |
| `src/job-runner.ts` | job 执行器：四条件 race（exit 事件绑定完成——对 stdio-EOF 挂死 #47350 结构免疫；success_pattern；idle_ms 归还 still-running 不杀；max_wait_ms 硬顶不杀）、管道捕获+磁盘 tee+日志轮转（keep 50）、`FORGE_JOB_ID` env 标记（≠ watchdog 的 `FORGE_WATCHDOG_MARK`）、run_in_background 立即返回、pollJob ≤30s 有界等待、terminalEvidence 打标（foregroundWatch && 未 settle 时该次终态即内联交割；后台启动永不打标） |
| `src/watchdog.ts` | 内置 shell 停滞哨兵引擎（纯逻辑）：计时表（before/after 生命周期、markerSeen 集——shell.env 先于 before 触发也不会误判）、单例 interval 扫描器（off 模式完全惰性）、分级处置（80% warn / 阈值 locate→杀树→账本 / 无进程或击杀后无 after → unresolved 诚实上报 / marker 缺失自动降级 dry-run）、`acted` 单次标志、有界 JSONL 账本（200 条轮转）。**无 @opencode-ai 依赖，时钟/sink/locate/kill 全注入** |
| `src/proc-locate.ts` | 跨平台进程定位：POSIX `/proc/*/environ` NUL 分隔精确匹配标记；Windows 宿主子孙树闭包 × CreationDate ≥ t0 推算（CIM JSON 注入 fake 可测）；两路统一 `locate(callID, t0)` 接口 |
| `tests/*.test.mjs` | node:test 单测：`plan-file` / `goal-file`（纯函数）、`goal-mode`（stub client + 可注入 runner 覆盖全部工具与续跑引擎；`FORGE_GOAL_DEBOUNCE_MS=10` 须在 import plugin.ts 前设置）、`forge-config`（fail-soft/级联/热应用/惯性未配置）、`hierarchical-pools`（池解析器 fake-fs 全链：纯 id/命名空间/skip-list/预算确定性/撞名两类/跨锚去重/global 兜底/文件热应用 + 接线级冻结回归（14:24/14:26 撕裂）与花名册池分组；wiring 测试以 startServer 重置锚点集模拟新宿主）、`crew-gate`（声明计划四类拒绝）、`dispatch-prompt`（mandate 组合/物化定义）、`dispatch-depth`（三族翻译 + resolvePinnedDepth 降级）、`forge-subagents-wiring`（server() hooks 级：物化带 model/不 hidden、task 词汇面、chat.params 冻结注入、no-mapping finding、/crew 模板两形态、crew_begin/close 门）、`v2-setup`（v2 形态守卫 + 子代理 create-only 对等）、`proc` / `job-manager` / `job-runner`（FakeChild + 可注入 spawn）、`job-wiring`（ask 两件套、config 三态 hide、探测三源）、`watchdog` / `watchdog-wiring`（哨兵全链） |
| `dist/index.js` | 自包含构建产物（含 @opencode-ai/plugin + zod），**入库** |

## 关键机制（改行为前必读）

1. **会话状态**：`Map<sessionID, {worktree, planPath?, goalPath?}>` 仅内存；
   磁盘事实源是 plan/goal 文件 frontmatter。重启失忆 → 禁写软降级（spec
   声明行为），下次工具调用经目录兜底自动重绑（这就是 /plan resume、
   goal 工作区可见性的实现）。
2. **禁写**：permission.ask 里 draft 期对 write/edit/bash/task/patch 类
   无条件 deny，**高于用户 allow**（README Design stance 有声明）；字段
   取名按优先级链 `metadata.tool → permission → id → type`，未知会话保守
   放行（宁漏禁不误杀）。**会话级**（D12）：draft 禁写对会话内任何 agent
   生效——被动防护可达、主动驱动不可达，是分区下唯一声明的越界。
3. **双门**：`plan_approve` / `plan_close` / `goal_write(arm)` /
   `goal_complete` / `goal_resume` 在 permission.ask 里除显式 deny
   外一律改写为 ask——用户确认框即门，模型无法自翻状态。
4. **状态机**：plan draft→approved→done；draft/approved→abandoned。goal
   queued→active⇄paused→completed/abandoned（paused 必带 stop_reason；
   迁移非法一律拒绝，`src/*.ts` LEGAL_TRANSITIONS）。
5. **goal 续跑引擎**：session.idle → 防抖（`FORGE_GOAL_DEBOUNCE_MS`，
   默认 2s）→ 全链守卫（in-flight / 懒播种 / live+active / 归属 /
   无进展核算+记账 / draft 冲突 / 预算 / status idle 复查）→
   `[forge:goal-continue]` brief + turns 计数。压缩安全：goal-brief 进
   compaction 上下文、autocontinue 对 active-goal 会话关闭。
6. **一键回原生**：`agent["forge"].disable = true` → 全部注入跳过（含
   工具面分区注入与命令注册），工具经 getter 摘除。插件永不写用户
   `model` 字段。
7. **工具面分区**（tool-partition）：sessionID→agent 族映射三源采集
   （chat.message 主 / chat.params 辅 / 工具上下文最强），族门控覆盖全部
   forge 系统注入、goal 续跑（调度时+发送前双闸）、watchdog（标记+计时）、
   task 派发护栏（非 forge 派 forge-* 硬拒绝）、状态文件边界（非 forge 禁
   写 .opencode/plan|goal）；未知会话对注入 fail-silent、对拒绝 belt
   fail-open。stage 探测已退役：`auto`≡`forge`，仅 `native` 退役
   supervisor（隐藏同撤）。

## v1 / v2 双入口

- npm/github 安装（`opencode plugin`）→ v1 loader 只读 `server`，全功能。
- v2 loader 只调 `setup`：仅注册 agent（结构化类型 + `?.` 守卫，
  只创建不覆盖；字段用 v2 的 `system`）。**v2 @1.18 无 tool/permission 域**，
  禁写与双门只能 v1 实现。上游补齐后按 vision-bridge 既定路线迁移。

## 开发循环

```powershell
bun run typecheck
node --test tests/*.test.mjs
bun run bundle        # dist 自包含重建（严禁 --packages external）
# 常驻：bun build ./plugin.ts --outfile ./dist/index.js --target node --format esm --watch
```

- 纪律改动（/plan、/goal 模板文本）零手动：模板随 dist 打包，重启 opencode 即生效。
- 沙盒隔离测试：`OPENCODE_CONFIG_DIR=<临时目录>` 后跑 opencode，不污染真实配置。
- goal 全链 E2E：`scripts/sandbox-e2e-setup.mjs` 写沙盒配置；
  `scripts/live-loop-e2e.mjs <baseUrl> <absWorkspace>` 对 `opencode serve`
  驱动确定性闭环（手写 active goal → idle 续跑 → 权限端点过门 →
  completed）；`FORGE_GOAL_PROBE=1` 诊断日志在 OS temp。
- 排错：`opencode --print-logs`；改动不生效先清 `~/.cache/opencode/packages/`。
- **终验强制官方安装模式**（内环 file:// 不算验证）：提交前
  `opencode plugin "git+file:///<仓库绝对路径>" --global`；push 后
  `opencode plugin github:ChengZiiii/opencode-forge --global`；publish 前
  `npm pack` 后用 tgz 装一遍。文件布局变动加一轮 README 四步卸载+重装。
- 通用避坑清单：`../opencode-plugin-dev-pitfalls.md`（打包红线、触发器
  名单、卸载四步等）。

## 打包红线（硬性）

- `scripts` 只允许 `bundle` / `test` / `typecheck`（七个 git 准备触发器
  名单外的安全名）；**严禁** `workspaces` 字段。
- dist 入库（.gitignore 不含 dist），构建自包含。
- `files` 白名单 = dist + README.md；发布前 `npm pack --dry-run`
  核对。

## 提交规范

conventional 风格：`plugin:` / `src:` / `tests:` / `docs:` / `chore:`。

## OpenSpec 规格工作流（libretto）

所有**行为改动**走完整流程，禁止直接改代码：

```
explore → propose → 用户批准 → apply → verify → archive
```

- `openspec new change <kebab-name>`，按 CLI `instructions --json` 依次写
  proposal / specs(deltas) / design / tasks。
- delta 规则：只写变化（`## ADDED/MODIFIED/REMOVED`）；MODIFIED 必须带全量
  场景；场景 `####` + WHEN/THEN；需求 SHALL。
- 校验 `openspec validate --all`；实现与 spec 偏差时**先改 delta 再归档**。
- 归档需用户明确指示：`openspec archive <name> --yes`。
