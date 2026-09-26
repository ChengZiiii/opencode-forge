# add-dispatch-suite · 战役日志（红绿证据 + verdict + 轮报）

> 断点续跑锚点之一：中断后先读本文件与 `../tasks.md` 的 tick 状态再继续。
> 记录纪律（见 `../../../dispatch-tdd-process.md` §2 R1/R6 与 §5）：
> - 每个 task 的"红"必须贴真实失败输出摘要（命令 + 关键行），然后才是绿；
> - 每条边界一个 `### Bxx` 段，verdict 四选一 + 证据；
> - 修复任何缺陷前先在本文件登记回归测试（红），修完补绿证据。

## 统计（每次 verdict 变更后更新）

```
战役Ⅰ（B01–B33）：PASS 0 / FIXED 1 / LIMITATION 0 / BLOCKED 0 / OPEN 32
战役Ⅱ（B34–B48）：PASS 0 / FIXED 0 / LIMITATION 0 / BLOCKED 0 / OPEN 15
npm test: 218/218 pass (阶段B末全量)   typecheck: 0 errors
```

## 轮报

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
