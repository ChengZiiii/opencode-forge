# add-dispatch-suite · 战役日志（红绿证据 + verdict + 轮报）

> 断点续跑锚点之一：中断后先读本文件与 `../tasks.md` 的 tick 状态再继续。
> 记录纪律（见 `../../../dispatch-tdd-process.md` §2 R1/R6 与 §5）：
> - 每个 task 的"红"必须贴真实失败输出摘要（命令 + 关键行），然后才是绿；
> - 每条边界一个 `### Bxx` 段，verdict 四选一 + 证据；
> - 修复任何缺陷前先在本文件登记回归测试（红），修完补绿证据。

## 统计（每次 verdict 变更后更新）

```
战役Ⅰ（B01–B33）：PASS 29 / FIXED 3 / LIMITATION 1 / BLOCKED 0 / OPEN 0
战役Ⅱ（B34–B48）：PASS 0 / FIXED 0 / LIMITATION 0 / BLOCKED 0 / OPEN 15
npm test: 227/227 pass (阶段C末全量)   typecheck: 0 errors
FIXED：B11（spec 排除重试缺失，红→绿→活体）、B14（回合同步 POST 吞掉 deadline，race 修复）、B31（子会话挂起类，deadline 兜住）
LIMITATION：B27（keyless×受限 tier 确定性空响应，外因；守卫与诚实性已证）
```

## 轮报

### 阶段 E（2026-09-27，tasks 4.1–4.2 全绿，门 E 通过）

- 范围：/crew 命令（no-clobber 注册 + 纪律模板：分解→波次随 brief 节奏→逐子任务证据验收→至多一次重试）；crew_begin/crew_close 工具（内存会话态、诚实重启死亡、系统态标记防第二 crew、draft 拒绝）；crew_close 硬门（纯函数 validateCrewReport：verdict/evidence/背景派发引用、账本对照零丢子任务、PASS-压-失败派发拒绝、FAIL 必须双报告；ask 级确认；摘要 crew-summary 入账本）。引擎账本行补 dispatchId+parentSessionID 归因。
- 全量绿证据：npm test → 259/259；typecheck → 0 errors。提交：0ef5ae3→febbc59→cab51f7。
- 设计落定：账本为唯一事实源（D13）——账本行按 parentSessionID+ts(≥crew.startedAt)+dispatchId 归属本 crew；重启后 registry 死、账本活、新 crew 新起点（旧行被 ts 过滤）。refuse 先于 ask（缺证据不打扰用户）。
- E 层：/crew 端到端（真模型跑完一个 crew）属 G 阶段 6.3 E2E 的一部分；B44–B48 战役Ⅱ覆盖。

### 阶段 D（2026-09-27，tasks 3.1–3.5 全绿，门 D 通过）

- 范围：dispatch-registry 纯状态机（3.1）；引擎后台路径（3.2：runAttempt 提取、急解析、fire-and-forget 管线、共享槽池、kill abort-race、后台终态→registry+账本映射、后台同享一次排除重试）；唤醒引擎（3.3：父会话作用域 takeUndelivered、idle 驱动+终态驱动双去抖、单条合并 brief、恰一次、传输失败回滚 delivered、goal brief 同 idle 合并=先 drain 后发）；forge_dispatch background 分支 + forge_dispatch_list（compaction 恢复，有界）+ forge_dispatch_kill（诚实 kill-failed 包装）（3.4）；run/TUI 披露进工具描述与 background 参数（3.5）。
- 全量绿证据：npm test → 248/248；typecheck → 0 errors。提交：59b7429→f89fb79（3.2）、074ab9e→dec8381（3.3/3.4）。
- 关键设计落定（与 design 一致）：kill 先标 killed 再 fire abort（挂死的 fetch 由 abort-race 解缠）；「结果晚于 kill 到达」记 kill-late-completion 且永不唤醒；brief 合并顺序=派发结果在前、goal brief 在后；同 idle 双定时器（goal 先注册先触发，goal 发送前 drain 使派发定时器变 no-op——单次再提示）。
- 仪器注意：wiring 套件共享进程内 registry 实例——用唯一 id + 断言包含，不假设精确计数。
- 已知 flake（非本 change）：job-registry 5.2 relay 真实进程测试在全量并发负载下偶发（本阶段 2 次：阶段 C 末 1 次、加测试后 1 次；单跑/重跑均绿）。留 G 阶段 §6 自审裁决：加宽其时序预算或标注 flaky。
- E 层待 G：3.5 的免钥 run 冒烟与 6.3 E2E（同步+后台唤醒各一）合并执行。

### 阶段 C（2026-09-27，战役Ⅰ B01–B33 全 verdict，0 OPEN，门 C 通过）

- 范围：U/S 层条目以单测为证据逐条对账；E 层在真 serve（1.18.32，沙盒 43931，config `C:/tmp/forge-stage-c`，roster `opencode/ling-3.0-flash-fin-free` expose=[low] profiles=[scout,quick]）跑活体探针 `scripts/dispatch-probe-c.mjs`。
- 全量绿证据：npm test → 227/227；typecheck → 0 errors。提交：1aeb117→28a4d7a（S7a/S7b deadline race）、94f0b88→c14620f（B11 排除重试）。
- E 层活体证据（dispatch ledger `<tmp>/opencode-forge/dispatch/ledger.jsonl`）：
  - quick 成功路径：诚实报告全套字段（model/depth/sessionID/tokens/cost/durationMs）+ 文件落盘 + `completed` 行（costUsd=0 为 models.dev 真实零价，非缺失折叠；reducer 原样透传已核）。
  - scout 只读：**确定性**空响应 ×2（各 ~6.5s）→ 诚实报错 ×2，模型如实上报并自行降级完成 → B27 升级为 LIMITATION（系统性模式：keyless × 任何工具集缩减 → 必空；write tier 全量工具集则正常）。
  - 超时：config timeoutMs=30000 → 三次 `timeout` 行全部 **30013–30019ms** 触发；诚实超时报告以 tool error 到达父模型（`[forge:dispatch:timeout] timed out after 30013ms (deadline 30000ms)`）；子会话按 spec「留给宿主回收」在后台跑完 sleep 90s 并建出 done-late*.txt（行为级证明）。
  - depth-required 真实纠错环：`resolve-error depth-required` 行 → 模型自补 depth 显式重试 → `completed` 行。
  - B11 活体：单候选 scout 空 → 替代候选预检失败 → **不重试**，原始 keyless 诚实错误原样到达模型（无 retry-excluded 行）——「保留原始错误」分支的实弹验证。
  - 子会话权限 ask 携**子会话自己的 sessionID**浮现在 SSE（forge_shell/external_directory），沙盒驱动器代答后子会话正常推进。
- 宿主版本约束（记入 final-report 偏差账，待你裁决）：**宿主工具调用硬超时 ~262s**（实测 261,936ms "The operation timed out."）。spec 默认 deadline 600000ms 在此宿主上永远轮不到引擎先到 → 按冻结律保持 spec 原文实现，E 层以 timeoutMs=30000 验证 S7 语义全通；建议你裁决把默认改为 240000（低于宿主上限，诚实报告可落地）。
- 仪器教训（驱动器侧，非插件缺陷）：(1) 权限 ask 必须答**所有**会话（子会话挂起 = B31 签名）；(2) 宿主 message POST 回合同步 → 驱动器 fire-and-forget + 轮询判停；(3) 判停必须排除「有 in-flight tool part」的假稳定。
- 偶发记录：job-registry 5.2 relay 全量跑挂过一次（真实进程时序），单跑与重跑全量均绿、不复现——非本 change 代码路径，留 G 阶段自审复核。
- 沙盒清理：serve 已杀，43930–43939 无监听（netstat 验证）。沙盒目录 `C:/tmp/forge-stage-c` 留待 G 阶段 6.5 终清。

### 阶段 B（2026-09-27，tasks 2.1–2.6 + 5.1 全绿，门 B 通过）

- 范围：tier 物化接线、chat.params 注入（幂等重应用 + 档位冻结）、forge_dispatch 工具、draft 禁派（before 钩子 + 工具内 belt）、dispatch 账本（有界 JSONL）、worker 模板、models.dev 拉取。
- 全量绿证据：npm test → 218/218；typecheck → 0 errors。提交 c056b3e（接线）+ 后续 fix。
- 门 B 冒烟（沙盒 43930，OPENCODE_CONFIG_DIR + file:// plugin + 元组 options）：校验发现全部落账本——expose 拼错 "hihg" 被判 error 且合法梯正确列出（low, high, max）、死键 warn、无候选 tier 正确降级 depth-required、scout 默认档保留。沙盒外零写入（仅 <tmp>/opencode-forge/*）。
- 首次冒烟教训：file:// 插件加载的是 dist/index.js——改动后必须 bun run bundle 再冒烟（已入流程记忆，G 阶段 6.2 会正式做）。

## 证据区 · 红绿记录（新增）

#### gate-B 冒烟发现 models.dev 形状 bug — 红
- models.dev reasoning_options 实为结构化数组：{"type":"effort","values":[...]} / {"type":"toggle"} / {"type":"budget_tokens"}；旧 reducer 按 string[] 过滤 → 全部滤空。
- 门 B 首冒烟真实输出：`exposes unknown level(s) "low", "hihg"; legal ladder: `（空梯 + 正确档被判非法）。

#### — 绿（FIXED）
- reduceModelsDev 按 namedLevels 归并 effort.values；toggle/budget → []。
- roster：已知身份 + 空梯 → expose 逐字接受 + "unnamed-levels-accepted" notice（用户给 toggle 命名，§2.2）；非空梯 → 拼错剥离 fail-closed。
- 回归：tests/models-dev.test.mjs（结构化三形状）+ tests/dispatch-roster.test.mjs :: "toggle/budget models…verbatim with a notice"。serve 复测输出：`"hihg"; legal ladder: low, high, max` ✓

## 轮报

### 阶段 A（2026-09-27，tasks 1.1–1.3 全绿）

- 范围：dispatch-roster（身份键/曝光表/五条校验）、dispatch-resolver（精确匹配/钉扎/exclude 重试/菜单错误）、dispatch-client（完成度判定/tokens 聚合/成本 null 语义）。
- 全量绿证据：`npm test` → tests 200 / pass 200 / fail 0；`npm run typecheck` → 0 errors。
- 提交对：395a28c→389a8f6（roster）、cd0389e 前 test 对（resolver）、1.3 test→feat 对（client）、50af8e0（tick+矩阵）。
- 设计落定：完成度判定语义 = 基线后连续 2 次不变转移（stable-x2，探针驱动同款）；空文本终态判 `empty` 而非 complete（B27 守卫前置到纯函数层）；成本公式 = input + (output+reasoning)×output价 + cache 分项，缺任一所需价目 → null + note（绝不 0）。
- 遗留：无阻塞。S5/S7/S14 的 S/R 层在阶段 B/G 补。

## 轮报

（每阶段门通过后追加一节：范围、命令真实输出摘要、tick 进度、遗留）

## 证据区 · 红绿记录

（格式：`#### <task号> <模块> — 红` 贴失败输出；`— 绿` 贴通过计数；提交 hash 附后）

## 战役条目

（格式见下，逐条追加；B01–B33 属战役Ⅰ/阶段 C，B34–B48 属战役Ⅱ/阶段 F）

```
### B01 死键 — <verdict>
- 触发：
- 观测：
- 期望 vs 实际：
- 处置：
- 回归：
```

### B01 死键 — PASS
- 触发：roster 身份未在配置出现。
- 观测：tests/dispatch-roster.test.mjs dead-key 用例 warn 不炸；门 B 冒烟真实 warn 落账本。
- 处置：按名警告，启动继续。回归：roster 套件。
### B02 expose 越界值 — PASS
- 触发：expose:["hihg"]。观测：单测 fail-closed 剥离 + 冒烟输出 `exposes unknown level(s) "hihg"; legal ladder: low, high, max`。
- 处置：error 级发现 + 合法梯列出。回归：roster 套件 + models-dev 回归（1c27ee8）。
### B03 catalog 未知 provider — PASS
- 观测：单测逐字接受 + "unverified" 提示，不拒启动。回归：roster 套件。
### B04 死默认档 — PASS
- 观测：单测（quick 降级 depth-required，defaultDepth 移除不替换）；活体：启动 warn 行 `dead-default-depth tier "quick"...` 三连（00:26 ledger）。
- 处置：降级 + 无深度调用报菜单（见 B13）。回归：roster 套件。
### B05 自定义 tier 无 shape — PASS
- 观测：单测默认 readonly（宁紧勿松）。回归：roster 套件。
### B06 tier id 字符集 — PASS
- 观测：单测 tier-id-charset warn。回归：roster 套件。
### B07 profiles 引用不存在 tier — PASS
- 观测：单测 unknown-tier-ref warn。回归：roster 套件。
### B08 同名双身份独立 — PASS
- 观测：单测两 provider 各挂同名模型、expose 不同 → 独立候选互不干扰。回归：roster 套件。
### B09 无人曝光请求档 — PASS
- 观测：单测结构化错误带全候选曝光与不可用原因，零派发。回归：resolver 套件。
### B10 钉扎不可用 — PASS
- 观测：单测点名报错 + 建议，无回退。回归：resolver 套件。
### B11 中途失败一次重试 — FIXED（94f0b88→c14620f）
- 触发：对账发现 spec「One retry after a mid-dispatch failure」场景引擎未实现（只解析一次，失败即掷）。
- 观测：3 条红（host-error 重试 / empty 重试 / 恰一次上限）→ 有界两attempt循环（期限 t0 跨attempt共享；仅 host-error/empty-response 可重试；替代候选预检失败则保留原始诚实错误）→ 全绿 → 活体：单候选 scout 空响应不重试，原始 keyless 错误原样到达模型。
- 处置：实现 + retry-excluded 账本事件。回归：dispatch-engine 套件 B11×3。
### B12 无钳制回归 — PASS
- 观测：单测 expose={low,max} 请求 medium → 报错，绝不静默换档。回归：resolver 套件。
### B13 depth-required 无深度调用 — PASS
- 观测：单测错误带菜单；活体纠错环：`resolve-error depth-required` → 模型自补 depth → `completed`（23:46 ledger）。回归：engine+resolver。
### B14 子会话超时 — FIXED（1aeb117→28a4d7a）
- 触发：宿主 message POST **回合同步**（子回合结束才返回）；旧引擎 deadline 检查只在该 await 之后的轮询循环 → 首回合卡死型子会话永远到不了 deadline（probe-3 实测宿主 262s 击杀工具、无报告无账本）。
- 观测：红 S7a（POST 300ms 时才超时）S7b（POST 永不返回 → 挂死）→ race 修复 + elapsed 复核（假时钟兼容）→ 91ms 触发 → 活体三次 `timeout` 行 30013–30019ms、诚实报告以 tool error 到达父模型、子会话后台跑完建文件。
- 处置：deadline race message POST。回归：S7/S7a/S7b + 活体 ledger。
### B15 并发上限 — PASS
- 观测：单测第 5 个拒绝带在飞数与重试提示（S8）；E 层免钥 4 慢派发按计划标注可选，未跑（免钥端点慢派发成本高，S 层语义完备）。回归：engine 套件。
### B16 一键关 — PASS
- 观测：wiring 单测 agent["forge"].disable → 工具不注册/tier 不物化。回归：wiring 套件。
### B17 tokens 真实性 — PASS
- 观测：wiring result-passthrough 单测；活体 ledger tokens（input 15811/output 236/reasoning 96/cache read 62336）与宿主 message info 同源。回归：wiring 套件。
### B18 无价目 — PASS
- 观测：单测缺身份/缺 cache 价 → costUsd null + "price unavailable" note，绝不 0；活体零价模型 costUsd=0 为真零（快照实价 0，reducer 原样透传）。回归：client 套件。
### B19 价目源失败降级 — PASS
- 观测：单测 fetch→cache→empty 降级链；wiring FORGE_TEST_NO_DISPATCH_FETCH → 空目录 + models-dev-degraded 账本行路径。回归：models-dev+wiring。
### B20 首回合恰好一次 — PASS
- 观测：wiring S12：同会话每次请求重应用**同一**档位（options 每请求重建，注入幂等）+ 档位冻结。回归：wiring 套件。
### B21 未知形状披露 — PASS
- 观测：wiring "unknown provider family is disclosed" + result.depthInjected = "not injected (unknown provider shape)"。回归：wiring 套件。
### B22 会话稳定 — PASS
- 观测：wiring 注入后改档被拒（queueDepth 返回 false，档位注册后不可变）。回归：wiring 套件。
### B23 sessionID 隔离 — PASS
- 观测：wiring 新增断言：无关会话同族 provider 的 options 分毫不动（无跨会话深度泄漏）；深度表按 sessionID 键控。回归：wiring 套件。
### B24 注入形状 — PASS
- 观测：wiring/tiers 单测：forge-<tier> hidden、mode subagent、无 model 字段、deny 式 permission 含 task deny。回归：wiring 套件。
### B25 不覆盖用户条目 — PASS
- 观测：wiring S10 no-clobber：用户自带 forge-build 原样保留。回归：wiring 套件。
### B26 draft 禁派 — PASS
- 观测：wiring before 钩子分支 + 工具内 belt 双层，消息指向 plan_approve/discard；run 模式同样生效。回归：wiring 套件。
### B27 免钥 × 受限 tier — LIMITATION（外因，守卫已证）
- 触发：keyless zen 端点 × 任何工具集缩减（readonly tier）。
- 观测：**确定性**空响应（scout ×2 各 ~6.5s，0 token 无 parts；write tier quick 全量工具集正常完成）→ 空完成检测 → 诚实报错（"known quirk of keyless endpoints...NOT counted as success"）+ 账本行 + 模型如实上报。
- 处置：不可修复的外部怪癖；守卫保证绝不静默成功。README 记坑（G 阶段 5.2）。回归：engine B27 单测 + 活体双探针。
### B28 真实 provider × 受限 tier — PASS
- 观测：deny 式 permission 形状单测；前期 wargame probe 已证 deny 生效；本端点受限 tier 因 B27 无法产出生成内容，活体复验以 deny 配置 + scout 子会话零写入侧证。回归：tiers 单测。
### B29 宿主退出 — PASS（S 层；E 层残余风险记录）
- 观测：S19 单测 dispose → 在飞记 lost-on-exit；dispose 已接插件钩子。E 层注：Windows 控制台进程无法可靠投递优雅 SIGINT，强杀下宿主不调用 dispose（进程生命周期限制，非插件可解）——记 final-report 已知边界。回归：engine 套件 S19。
### B30 账本有界轮转 — PASS
- 观测：dispatch-ledger 套件（有界 + 轮转 + 字段齐）；活体各行字段完整（ts/event/tier/identity/depth/sessionID/outcome/tokens/costUsd/durationMs）。回归：ledger 套件。
### B31 子会话绝对路径写（P3-d 回归）— FIXED（随 B14）
- 触发：probe-3 实弹：quick 子会话往绝对路径写文件 → 权限 ask 无人应答 → 子会话挂起 → 旧引擎无 deadline 兜底 → 宿主 262s 击杀。
- 观测：B14 race 修复后同类「首回合永不返回」由 S7b 在 91ms 兜住；活体 30s deadline 行为准。
- 处置：deadline 全程管辖。回归：S7b。
### B32 parentID best-effort — PASS
- 观测：单测 400 on parent-bearing create → plain 重试，派发照常。回归：engine 套件 B32。
### B33 worker 提示三条款 — PASS
- 观测：wiring S20：相对路径强制/拒绝原文上报/证据引用三条齐备，readonly 与执行模板可断言差异。回归：wiring 套件。
