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
| `plugin.ts` | 双入口：`server`（v1 hooks 全功能：config 注册 agent/命令、tool 注册 5 个 plan_* + 6 个 goal_* + 2 个 job 工具、permission.ask 禁写+钉门+forge_shell 门、event 播种会话与 idle 续跑调度+job 唤醒投递+session.deleted 收割、tool.execute.after 活动标记、tool.definition 能力探测（stage 1 锁存）、system transform 注入 plan+goal+job 提醒、compaction 钩子）+ `setup`（v2 防御式只注册 agent）。纪律载体：`/plan`、`/goal` 命令模板各自自含全量纪律（hermes 式：进入轮即规则书，系统提示词零纪律），无捆绑 skill |
| `src/plan-file.ts` | plan 纯函数核心：slug/文件名、渲染/解析、结构校验、打勾变换、状态机、close 校验、active 发现排序。**无 @opencode-ai 依赖、无副作用** |
| `src/goal-file.ts` | goal 纯函数核心：契约渲染/解析（frontmatter+7 章节）、Check Log（runId 幂等追加）/Turn Ledger、预算状态、迁移状态机（paused 必带 stop_reason）、`carryHistory`（修订保留审计轨迹）、live/queued 发现排序。**无 @opencode-ai 依赖、无副作用、不 import plan-file（解耦红线）** |
| `src/run-check.ts` | 宿主验证执行器：shell（tree-kill 超时：win32 taskkill /T、POSIX 进程组）、file-contract（工作区内路径逃逸拒绝）、可注入 runner 测试缝 |
| `src/proc.ts` | 共享进程肌肉（自 run-check 抽出）：`shellSpawn`（shell:true、env 合并、detached 按 POSIX 默认）、`killTree`/`treeKillPlan`（win32 taskkill /pid /F /T、POSIX 进程组 SIGKILL，pid 缺失/组杀失败回退 child.kill）。**无 @opencode-ai 依赖、spawn 可注入**；run-check 与 job-runner 共用 |
| `src/job-manager.ts` | job 注册表纯逻辑：job 表/环形 tail/outLen 游标、终态 first-wins + 完成量上限逐出、所有权（session 级创建、session.deleted 杀活 job+账本记 orphan、handoff 转全局+重绑根会话、dispose 全清）、唤醒队列（单次投递、窗口期放弃、notify:false）、有界账本 JSONL。**无 @opencode-ai 依赖、时钟/sink 可注入** |
| `src/job-runner.ts` | job 执行器：四条件 race（exit 事件绑定完成——对 stdio-EOF 挂死 #47350 结构免疫；success_pattern；idle_ms 归还 still-running 不杀；max_wait_ms 硬顶不杀）、管道捕获+磁盘 tee+日志轮转（keep 50）、`FORGE_JOB_ID` env 标记（≠ watchdog 的 `FORGE_WATCHDOG_MARK`）、run_in_background 立即返回、pollJob ≤30s 有界等待 |
| `src/watchdog.ts` | 内置 shell 停滞哨兵引擎（纯逻辑）：计时表（before/after 生命周期、markerSeen 集——shell.env 先于 before 触发也不会误判）、单例 interval 扫描器（off 模式完全惰性）、分级处置（80% warn / 阈值 locate→杀树→账本 / 无进程或击杀后无 after → unresolved 诚实上报 / marker 缺失自动降级 dry-run）、`acted` 单次标志、有界 JSONL 账本（200 条轮转）。**无 @opencode-ai 依赖，时钟/sink/locate/kill 全注入** |
| `src/proc-locate.ts` | 跨平台进程定位：POSIX `/proc/*/environ` NUL 分隔精确匹配标记；Windows 宿主子孙树闭包 × CreationDate ≥ t0 推算（CIM JSON 注入 fake 可测）；两路统一 `locate(callID, t0)` 接口 |
| `tests/*.test.mjs` | node:test 单测：`plan-file` / `goal-file`（纯函数）、`goal-mode`（stub client + 可注入 runner 覆盖全部工具与续跑引擎；`FORGE_GOAL_DEBOUNCE_MS=10` 须在 import plugin.ts 前设置）、`v2-setup`（v2 形态守卫）、`proc` / `job-manager` / `job-runner`（FakeChild + 可注入 spawn，覆盖四条件/所有权/唤醒/轮转）、`job-wiring`（server() hooks 级：ask 两件套与 deny 短路、config 三态 hide、transform 幂等、探测三源与矩阵三档、idle 唤醒单次投递）、`watchdog`（分级处置/单次性/降级/账本/双平台定位器）、`watchdog-wiring`（shell.env 标记注入、before/after 生命周期（FORGE_WATCHDOG_PROBE 探针）、配置回退记账、job 互斥断言） |
| `dist/index.js` | 自包含构建产物（含 @opencode-ai/plugin + zod），**入库** |

## 关键机制（改行为前必读）

1. **会话状态**：`Map<sessionID, {worktree, planPath?, goalPath?}>` 仅内存；
   磁盘事实源是 plan/goal 文件 frontmatter。重启失忆 → 禁写软降级（spec
   声明行为），下次工具调用经目录兜底自动重绑（这就是 /plan resume、
   goal 工作区可见性的实现）。
2. **禁写**：permission.ask 里 draft 期对 write/edit/bash/task/patch 类
   无条件 deny，**高于用户 allow**（README Design stance 有声明）；字段
   取名按优先级链 `metadata.tool → permission → id → type`，未知会话保守
   放行（宁漏禁不误杀）。
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
6. **一键回原生**：`agent["forge"].disable = true` → 全部注入跳过（含隐藏
   build/plan），工具经 getter 摘除。插件永不写用户 `model` 字段。

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
