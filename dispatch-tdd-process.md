# add-dispatch-suite · TDD 循环迭代开发流程（ZCode goal 模式 · 单闸门制）

> 2026-09-27 定稿（v3：范围扩为三合一 change `add-dispatch-suite` = 派发核心 + waves 后台唤醒 + /crew 编排）。
> 驱动器：**ZCode 的 goal 模式**。你贴一段主目标文本开 goal 后不再介入；代理自主跑完 A→G 七个阶段与全部自检，你回家只做**终局验收**。

---

## 0. 定位与单闸门原则

三层治理不变：OpenSpec 管**建什么**、goal 循环管**怎么推进**、TDD 管**每步纪律**。

因为过程中没有任何人工把关，"代理自报全绿"绝不能作为信任基础。本流程用五道机器可复核的机制替代人工闸门：

1. **git 提交链**——每个红绿循环一个提交对（先 test 后 feat/fix），`git log --oneline` 即审计轨迹；
2. **全量绿律**——任何"绿"的论断只能来自**当次全量** `npm test` + `npm run typecheck`（禁止只跑单文件报绿、禁止引用早前输出），真实输出摘要进 battle-log；
3. **阶段自检门**——每阶段末自动重跑全量梯子 + 该阶段专属复验，不过门不放行下一阶段；
4. **终局净室复验**——G 阶段末从零重建（rm dist → bundle → 全量测试 → 全新沙盒冒烟 → 官方安装+卸载），一切输出带时间戳与 git hash 存档 `verify/final-report.md`；
5. **一键验收命令**——`node scripts/accept-dispatch-suite.mjs`：你回家跑这一条，它当场重新执行整个机器可查梯子并给出单一 PASS/FAIL；不信任任何存档输出。

**Round 0（前置）**：change 停在 propose（已过 validate）。你把 §4 的**主目标文本**贴进 goal 开跑，即视为批准（apply）。

**spec 冻结律**：实施期间不改 `specs/proposal/design` 文本。实现撞上 spec 缺口（探针证伪某条场景语义）→ 记入 final-report 的「偏差账」并**按当前 spec 文本实现**，验收时由你裁决修订 delta 还是接受偏差；不许为了让测试变绿而悄悄改语义。

**规模预警（诚实说）**：三合一后工作量约为此前 core 的 2.5 倍（23 个任务、35 个场景、48 条边界、7 个阶段）。一次 goal 很可能触预算上限——这是**设计内情形**，不是失败：全部状态在盘上（tasks tick + battle-log + 矩阵），用 §4 的续跑文本重开 goal 从断点继续即可。**禁止为赶进度跳过任何阶段门或战役条目**——宁可分三次跑完，不可少探一条边界。

---

## 1. 流程总览

```
你贴主目标文本开 goal（= Round 0 批准）── 之后你不再介入
   │
   ▼
阶段 A：纯函数核心（tasks 1.1–1.3）── 内循环×3：红→绿→重构→提交→tick→记矩阵
   ▼ 门 A：全量梯子绿 + 矩阵 S1–S5/S16/S17 有映射 + git 审计链完整
阶段 B：宿主接线（tasks 2.1–2.6 + 5.1）── stub 先红后绿
   ▼ 门 B：全量梯子绿 + 沙盒内坏 roster 冒烟 + 矩阵核心 S 层行闭环
阶段 C：战役Ⅰ（边界目录 B01–B33：核心痛点全量探针）── 缺陷→回归红→修绿→重探
   ▼ 门 C：B01–B33 全 verdict、0 OPEN、全量梯子绿、沙盒清理
阶段 D：waves（tasks 3.1–3.5）── 注册表状态机/后台路径/唤醒引擎/kill+list/run 披露
   ▼ 门 D：全量梯子绿 + 免钥后台冒烟（提交/唤醒/超时/kill 各一）+ 矩阵 S21–S28 的 S 行
阶段 E：crew（tasks 4.1–4.2）── /crew 命令纪律模板 + crew_close 完成门
   ▼ 门 E：全量梯子绿 + crew 门 stub 测试 + 矩阵 S30/S31/S34 的 S 行
阶段 F：战役Ⅱ（B34–B48：唤醒竞态/后台生命周期/crew 工作流 + 战役Ⅰ回归抽查）
   ▼ 门 F：48/48 累计 verdict、0 OPEN、全量梯子绿、沙盒清理
阶段 G：终验交付（tasks 5.2 + 6.1–6.5）── README/bundle/沙盒冒烟/官方安装/accept 脚本
   ▼ 自审（§6 清单）→ 终局净室复验 → verify/final-report.md 定稿
   ▼
你 ══ 终局验收（§7）：一条命令 + 四件上手项 + 读终报，约 40 分钟
   ├─ 接受 → 你说 "archive add-dispatch-suite"
   └─ 不接受 → 差异清单 → 回炉（新 goal 或 /plan）
```

**内循环（每个 task 一圈）**：读 spec 场景+任务验证栏 → 写测试 → 跑红（真实失败输出记 battle-log）→ 实现 → 全量跑绿 → 重构 → 仍绿 → 提交（带任务号+场景号）→ tick tasks.md → 填矩阵行。

**预算耗尽/中断**：goal 预算跑完或会话中断不必慌——全部状态在盘上，用 §4 续跑文本重开 goal 即从断点继续。

---

## 2. TDD 七条铁律

**R1 先红后绿**。每任务先写测试、跑出真实失败（非零退出码/断言计数可见），失败输出摘要记入 battle-log 证据区，然后才写实现。禁止"测试和实现一起写完再跑"。

**R2 场景即用例**。两份 spec delta 的 **35 个场景**（dispatch 28 + crew-harness 7）与测试一一映射，落在 `verify/scenario-matrix.md`，终态 35/35。

**R3 缺陷回归律**。任何缺陷：先固化失败测试（红）→ 修（绿）→ battle-log 记根因。禁止只修不测、禁止删测试/弱化断言保绿。

**R4 重构不省略**。绿后立即做该做的小清理，重构后必须重跑仍绿。禁止囤积。

**R5 提交即审计**。每红绿循环一个提交对：`test(dispatch-suite): <任务号> 红测试` → `feat/fix(dispatch-suite): <任务号> 实现`，信息带场景号（如 `S3/S23`）。

**R6 全量绿律**。"绿"只能指**当次全量** `npm test`（suite 里所有文件）+ `npm run typecheck` 双双通过，输出摘要（pass/fail 计数、退出码）进 battle-log。禁止局部跑报绿、禁止引用历史输出。

**R7 最高标准律**（你只验收一次，质量必须一次到位）：新代码零 TODO/FIXME 债；测试断言行为而非实现细节；错误信息可操作（带菜单/建议）；README 与实现同步；G 阶段末执行 §6 自审清单并留档。

---

## 3. 通用安全约束（主目标文本必带，逐字粘贴）

```
安全约束：
- 不写用户的任何 opencode 配置文件（项目红线）；一切注入仅运行时。
- 不碰用户正在运行的 opencode 进程与端口（41593/41595 是用户自己的）。
- 沙盒一律专用 OPENCODE_CONFIG_DIR + 端口段 43930-43939，探针结束清理 serve 进程与端口。
- 真实密钥永不回显到任何输出；真实 provider 差分仅在免钥端点覆盖不了的条目上做，且限量（预约制）。
- 只写：src/ tests/ scripts/ README.md、openspec/changes/add-dispatch-suite/、<tmp> 账本目录。
- 不改 specs/proposal/design 文本；spec 与现实冲突 → 按 spec 实现 + 记入偏差账。
```

---

## 4. 目标文本（贴进 goal 即开跑）

### 主目标文本（一段覆盖 A→G，含自动阶段门）

```
在 opencode-forge 仓库执行 openspec change add-dispatch-suite 全量实施（tasks 1.1–6.5 全部勾选为终点），
按 dispatch-tdd-process.md 的单闸门制流程跑七个阶段 A→G，每阶段末执行该阶段的自动阶段门，不过门不放行。
铁律（R1–R7）：先红后绿（真实失败输出记 verify/battle-log.md）、全量绿律（任何"绿"= 当次全量 npm test
+ npm run typecheck 双过，输出摘要入 battle-log）、缺陷先回归后修、每红绿循环一个提交对（信息带任务号+场景号）、
重构不省略、新代码零 TODO 债。
阶段与门：
A 纯函数核心（tasks 1.1–1.3）→ 门：全量梯子绿 + 矩阵 S1–S5/S16/S17 行有测试映射 + git 审计链完整；
B 宿主接线（tasks 2.1–2.6 + 5.1）→ 门：全量梯子绿 + 沙盒内坏 roster 冒烟（expose 拼错→启动报错列合法梯，
且不写沙盒外任何文件）+ 矩阵核心 S 层行闭环；
C 战役Ⅰ（verify/battle-plan.md B01–B33 逐条：触发→观测→对照 spec→verdict+证据）→ 门：33 条全 verdict、
0 OPEN、全量梯子绿、沙盒进程与端口清理（netstat 验证 43930-43939 无监听）；
D waves（tasks 3.1–3.5：注册表状态机/后台路径/唤醒引擎/kill+list/run 披露）→ 门：全量梯子绿 + 免钥后台
冒烟（提交/唤醒/超时/kill 各一）+ 矩阵 S21–S28 的 S 行；
E crew（tasks 4.1–4.2：/crew 命令纪律 + crew_close 完成门）→ 门：全量梯子绿 + crew 门 stub 测试 +
矩阵 S30/S31/S34 的 S 行；
F 战役Ⅱ（B34–B48：唤醒竞态/后台生命周期/crew 工作流 + 战役Ⅰ回归抽查）→ 门：48/48 累计 verdict、0 OPEN、
全量梯子绿、沙盒清理；
G 终验交付（tasks 5.2 + 6.1–6.5）→ 自审清单 → 终局净室复验（rm dist → bundle → 全量测试 → 全新沙盒冒烟
存档 verify/e2e-smoke.md → 官方安装+四步卸载存档 verify/install-verify.md）→ verify/final-report.md 定稿
（含：命令真实输出、矩阵 35/35、战役 48/48、偏差账、LIMITATION 清单、git hash）。
<逐字带上 §3 安全约束>
停滞规则：单条边界死磕 >20 分钟记 BLOCKED 跳下一条；连续 2 个内循环无进展或单阶段 >90 分钟无新绿 →
把状态写全到 battle-log 后暂停 goal（带 blocker 说明），绝不空转烧上下文。
预算耗尽不是失败：状态全在盘上，暂停后由用户用续跑文本重开。
非目标：archive 归档（用户终验后亲自裁决）；跨会话 crew 续跑；档位钳制（设计禁止）。
```

### 续跑文本（预算耗尽/中断后重开 goal 用）

```
继续 openspec change add-dispatch-suite 实施（单闸门制）：先读 openspec/changes/add-dispatch-suite/tasks.md
的 tick 状态、verify/battle-log.md（证据与断点）、verify/scenario-matrix.md（进度），从断点按
dispatch-tdd-process.md 继续当前阶段与阶段门；全部约束与铁律同主目标文本。
```

---

## 5. 边界战役协议

- **目录**：`verify/battle-plan.md`，B01–B48 九组（配置校验/解析语义/工具契约/档位注入/物化权限/生命周期账本/后台唤醒/后台生命周期/crew 工作流），每条带触发、期望（对照 spec）、探针方法、层（U/S/E/R/M）。战役Ⅰ（阶段 C）探 B01–B33，战役Ⅱ（阶段 F）探 B34–B48 并对战役Ⅰ做回归抽查。
- **verdict 语义**：`PASS` 一次过（证据=测试或探针输出）；`FIXED` 缺陷→回归红→修绿→重探（记根因）；`LIMITATION` 宿主怪癖无法修（如免钥 Zen 空响应）→ 加守卫（诚实报告/预检）+ README 记坑；`BLOCKED` 无法探（如缺真实 provider 授权）→ 记原因与补救路径，**跳过继续下一条**（验收时你裁决补探）。
- **处置四选**：修实现 / 加守卫 / 记 LIMITATION / 记偏差账（spec 层问题按 spec 实现并上报）。
- **记录格式**（battle-log 每条一段）：

```
### B27 免钥×受限 tier 空响应 — LIMITATION
- 触发：<一句>
- 观测：<真实输出摘要>
- 期望 vs 实际：<差异>
- 处置：加空完成检测 → 诚实报告"空响应（免钥端点已知怪癖）"；README 记坑
- 回归：tests/dispatch-client.test.mjs :: 空响应不判成功
```

- **出口**：48/48 有 verdict、OPEN=0、全量梯子绿、沙盒清理干净。

---

## 6. 自审清单（G 阶段末，结果入 final-report）

1. **红线核查**：diff 全量过一遍——无任何写用户配置的代码路径；无密钥/隐私回显；无碰 forge_shell/goal/plan 既有行为（除明确接线点）；`agent["forge"].disable` 与 `dispatch.disable` 两个关都真实生效（工具/命令/唤醒引擎/tier 全摘）。
2. **设计符合性**：对照 design.md D1–D14 逐条勾，偏离处必须在偏差账里有一行。
3. **零债核查**：`grep -rn "TODO\|FIXME\|XXX"` 于新增文件 = 0 命中；无被注释掉的测试；无 `skip`/`todo` 标记的用例。
4. **测试有牙核查**：抽 5 个测试改坏实现确认会红（自审时做过即记入 final-report，附抽到的用例名）。
5. **文档同步**：README dispatch/waves/crew 章节语义与实现一致；文件账本表与真实路径一致；已知坑（免钥×受限 tier、run 模式后台）两条都在。

---

## 7. 终局验收（你，回家后，约 40 分钟）

**第一件：一条命令。** `node scripts/accept-dispatch-suite.mjs`——它当场净室重跑机器可查梯子（typecheck → 全量测试 → bundle 重建 → 全新沙盒冒烟 → 报告），输出单一 PASS/FAIL 与各环节摘要。FAIL 直接回炉，不看别的。

**第二件：四件上手项**（机器替代不了的体感）：

1. **官方安装 + roster 实配**：按 README 装 plugin，个人配置实配 2–3 条（含一条 expose 裁剪、一条 pin），启动看校验输出可读、无误报。
2. **真实派发×2 + 错误体验**：scout 只读 + build 写文件各一次，核对结果对象（actual==requested、tokens 合理、costUsd 或 null、text 有结论）；再故意请求无人曝光的档位看菜单错误、draft 期派发看拒绝信息。
3. **/crew 小跑**：给一个小目标（拆成两波、3–4 个子任务），看分解质量、波次节奏（不洪水）、完成报告与 crew_close 确认门。
4. **读 `verify/final-report.md`**：偏差账是否可接受、LIMITATION 清单（尤其免钥怪癖与 run 模式限制）是否知情、矩阵 35/35 与战役 48/48 的证据抽 2 条看看是不是真输出。顺手 `git log --oneline` 扫红绿提交对。

**裁决**：全部满意 → 你说 "archive add-dispatch-suite"（走 openspec 归档）；任何一条不过 → 差异清单开回炉（小修：修+回归+重验该条；大改：/plan 或新 goal）。

---

## 8. 文件地图

| 文件 | 角色 | 生命周期 |
| --- | --- | --- |
| `dispatch-tdd-process.md`（本文件） | 流程契约 | 验收后随项目保留 |
| `openspec/changes/add-dispatch-suite/tasks.md` | 任务 tick 状态（断点锚点①，23 项） | 随 change 归档 |
| `openspec/changes/add-dispatch-suite/verify/scenario-matrix.md` | 35 场景 ↔ 测试映射 | 随 change 归档 |
| `openspec/changes/add-dispatch-suite/verify/battle-plan.md` | 48 条边界目录（只读） | 随 change 归档 |
| `openspec/changes/add-dispatch-suite/verify/battle-log.md` | 红绿证据 + verdict + 轮报（断点锚点②） | 随 change 归档 |
| `verify/e2e-smoke.md` / `install-verify.md` / `final-report.md` | G 阶段存档与终报 | 随 change 归档 |
| `scripts/accept-dispatch-suite.mjs` | 一键验收（净室重跑梯子） | 随项目保留 |
