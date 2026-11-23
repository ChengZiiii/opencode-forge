# Proposal: plan-close-verified

## Why

`plan_close` 的完成门今天钉死在宿主 ask 模态上（四处代码层 + 三份规范）。
真机实测该通道不可靠：TUI 弹一次确认框后无裁定（300 s 看门狗拒绝），
Paseo auto 模式直接卡死。一个会楔死的模态门比没有门更糟——它卡住整个
plan 循环。竞品对照（2026-11-23 检索）：Claude Code 只有 ExitPlanMode
一道转换点门，完成后无第二道模态；Cursor/background agents 同构；
OpenCode 原生 plan 是权限模式不挡关。完工以证据呈现、用户异步审是
行业共识。

用户裁决（2026-11-23）：按推荐方案 A 执行——砍 close 模态，close 由
插件在宿主重跑验证项把关（fail-closed，goal harness 同款机制），完工
给证据摘要 + `plan_reopen` 回滚窗口。

## What Changes

- `plan_write` 增加可选结构化 `checks`（与 goal 完全同构：
  `shell` 或 `containsFile`+`containsText`，`timeoutSec`），渲染进计划
  文件的 `## Verification Checks` 节；**approve 时冻结**（close 只重跑
  冻结集，模型不能在 close 时换题）。
- `plan_close` 移除 ask 门（全部四层：gate 调用、`GATE_PERMISSION_KEYS`、
  v1 belt、`V2_PERMISSION_DOORS`——七门变六门）：
  - 声明了 checks 的计划：close 在宿主**重跑冻结集**，fail-closed（任一
    失败 → 失败证据追加进 `## Check Log` + throw，状态留在 approved——
    逐字镜像 `goal_complete` 语义）；
  - 未声明 checks 的计划：close 仍要求逐条验收自检（现状
    `closeCheckFailures` 不变），产出证据摘要；
  - 两条路径都追加**证据摘要终节**（结构化 check 结果 + 模型 evidence，
    复用 goal 截断常量 2048/400；终写改 `atomicWrite`）。
- 新工具 `plan_reopen`：`done → approved` 成为合法迁移；追加
  `— reopened` 节；重新绑定会话活跃计划。模型仅凭用户明示指令调用
  （纪律层，无模态）。
- `plan_approve` 的 ask 门**保留**（转换点门，竞品同构）。
- 全部"会弹确认框"的指引文案同步改写（plugin.ts 五处 + README +
  AGENTS.md + docs/architecture.md）。

## Impact

- 规范：`plan-harness`（完成门重写 + 终态叙述 + 新增 checks/reopen 需求）、
  `gate-asks`（七门→六门）、`tool-partition`（门枚举去 plan_close）。
- 代码：plugin.ts（plan 工具族 + 四层 ask 面 + 指引文案）、src/plan-file.ts
  （checks 节解析/渲染 + reopen 迁移 + 截断）、src/run-check.ts 复用
  （plugin.ts 层接线，**不**import 进 plan-file——纯核心保持 string→string）。
- 测试：五个测试文件的 ask 断言重做（goal-mode 91-124/958-1009、
  v2-permission 61-74、search-wiring、headless-gate），新增 verified-close /
  冻结 / reopen / 截断 / 无 checks 路径用例。
- 兼容：既有计划文件无 checks 节 → 走无 checks 路径（行为=旧自检+证据
  摘要，仅少一道会楔死的模态）；`done` 计划仍终态（reopen 是显式动作，
  不是自动复活）。
