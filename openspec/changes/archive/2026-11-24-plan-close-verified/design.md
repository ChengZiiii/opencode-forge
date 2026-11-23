# Design: plan-close-verified

## D0 — 调研加固状态

内部调研（C2 报告，全 file:line 实锤）已折入下列决策。外部调研
（E2，reports/research-community-competitors.md）**全部印证设计 A**：

- 完成期模态 ask 不可辩护：opencode 自家 issue 区满是 ask 楔死
  （#13715 嵌套会话 ask 永悬、#28312/#30136/#55678 TUI 对话框 stale/
  循环/404），非交互模式 ask 自动拒绝（官方文档）；Claude Code 的答案
  = 确定性 deny-with-reason，永不挂等人。
- **插件验证式 close 有直接先例**：spec-kit `/speckit.implement` 只读
  checkbox 状态、未勾即拒；Claude Code Stop-hook "测试不过不许结束"；
  社区 opencode 插件在 tool.execute.before 里抛 "先跑测试"。
- 转换点门保留 = 全行业同构（Claude Code plan mode / goose /plan /
  Coder propose_plan 都只在计划→执行边界留一道交互）。
- plan_reopen 平庸且被预期：所有被调查 harness 的 plan 都是文件
  （spec-kit/OpenSpec/opencode 原生），可编辑可回滚是常态。

无反例。D1-D6 维持原设计。

## D1 — 结构化 checks：goal 同构，文件即冻结态

- `plan_write` 增可选 `checks: [{shell} | {containsFile, containsText},
  timeoutSec?]`——形状/语义与 goal harness 验证项**逐字同构**
  （goal_write 的 coerceChecks 语义，plugin.ts:2136-2153）。
- 渲染进计划文件 `## Verification Checks` 节；`src/plan-file.ts` 纯
  string→string 解析/渲染（parseChecks/renderChecks）——**冻结态就是
  文件本体**：close 从文件读检查集，不从工具参数读——模型在 close 时
  无法换题（R2 的答案：声明期决定，批准期冻结，关闭期只执行）。
- 无 checks 节的旧计划走 legacy 自检路径（closeCheckFailures 原样）。

## D2 — verified close：逐字镜像 goal_complete 语义

plan_close 核心（plugin.ts:1999-2043 重写）：

1. status 必须 approved（不变）；
2. 全任务打勾（不变）；
3. **新**：文件带冻结 checks → `runChecks(doc.checks, worktree)`
   （src/run-check.ts:150-157，plugin 层 import——**绝不**import 进
   plan-file，R5 单向耦合红线）；任一失败 → 失败 run 追加进计划文件
   `## Check Log` 节 + throw（状态留 approved）——镜像
   goal_complete 的 fail-closed（plugin.ts:2330-2338）；
4. 无 checks → closeCheckFailures 自检（不变）；
5. ~~ask 门~~（删除，见 D4）；
6. 终写：transitionStatus(done) + 证据摘要终节，**单次原子写**
   （temp+rename；沿用 goal 的 atomicWrite 模式，plugin 层组合）；
   reason 串改 `completion gate passed (plugin-verified)`。

超时/spawn 失败按 goal 语义 refuse（R7）：验证器自身失败 ≠ 通过。

## D3 — 证据摘要终节

- 结构化路径：每 check 一行 `OK|FAIL (ms)` + 截断输出
  （单 check ≤2048 字符，run-check OUTPUT_LIMIT；Check Log 行明细
  ≤400，goal-file 同款常量）。
- legacy 路径：现行 per-criterion PASS/evidence 行。
- 截断常量经 plugin 层传入 plan-file 渲染函数（保持纯核心无 import）。

## D4 — ask 门拆除：四层 + 文案

| 层 | 位置 | 动作 |
| --- | --- | --- |
| 真门 | plugin.ts:2025 gate 调用 | 删 |
| config 门重写 | GATE_PERMISSION_KEYS :1803 | 去 plan_close（七门→六门） |
| v1 belt | :7201 门清单 | 去 plan_close |
| v2 belt | V2_PERMISSION_DOORS :7859 | 去 plan_close |

指引文案同步（R1，防模型期待不存在的框）：/plan 模板 step5(:188)、
plan_tick 输出(:1701)、plan_approve 输出(:1994)、工具描述
(:2000-2001)、plan-notice 规则 v1/v2(:7390/:8224)、agent 描述
(:6521/:9039)、README(:14-15,53-56,1092-1095)、AGENTS.md:7、
docs/architecture.md:48-50。`plan_approve` 的 ask 门**保留**（转换点
门，竞品同构）。

## D5 — plan_reopen

- LEGAL_TRANSITIONS 增 `done → approved`（唯一 done 出口；
  plan-file.ts:72-78）；appendReopenSection（dated `— reopened`，
  parser-inert，:369-381 契约自动覆盖）。
- 会话重绑：reopen 后显式设 state.planPath（resolveActivePlan 跳过
  terminal 文件，:1608-1619，必须显式接线）。
- 纯纪律层：模型仅在用户明示指令下调用（工具描述钉死），无模态。
- 再关产生第二个 dated close 节；frontmatter status 是唯一现行真相
  （inertness 契约保证可读性）。

## D6 — 测试重议

| 现有 pin | 处置 |
| --- | --- |
| goal-mode:958-1009 close 字节等价 + ask 恰一次 | 重做：零 ask + 新证据摘要内容字节等价 + reason 新串 |
| goal-mode:91-124 cfg.permission.plan_close==="ask" | 删该断言（plan_approve 等保留） |
| goal-mode:1040-1069 终态输出 relay | close 节标题保留断言，内容改证据摘要 |
| v2-permission:61-74 门强制 ask 迭代 | 去 plan_close 项 |
| search-wiring:127-142 七门重写 | 六门 |
| headless-gate:134 | 同步六门 |
| plan-file:226-257 done 终态 | 增 done→approved 合法迁移用例 |

新增：声明 checks 渲染往返 / 冻结集 close 重跑（改文件不改行为）/
失败重跑拒关+Check Log / legacy 路径 / reopen 迁移+重绑+二次 close 节 /
截断边界。

## D7 — 验证阶梯

1. 单测+typecheck 全绿（最低门槛）。
2. 无头 E2E（沙盒宿主）：draft→approve→失败 check 拒关（状态不变+
   Check Log 落盘）→修复→close 过（证据节落盘、零 ask 事件）→reopen。
3. **有头 TUI 验证（用户点名）**：PowerShell 启有头 opencode（沙盒
   workspace）+ computer use 驱动：plan_close 全程**无确认框弹出**、
   close 完成、磁盘证据节可读、plan_reopen 可回滚——楔死复测。

## D8 — 版本

与 C3/C4 合并发布 0.33.0（行为契约变化，minor）；发版梯统一走
（pack 白名单 → publish → dist-tags → shasum → 旧副本隔离）。
