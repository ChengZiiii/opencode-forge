# Proposal: postrelease-hardening

## Why

发布后对抗性 crew（记录 `.opencode/crew/2026-10-10-对两个已发布-change-draft-期只读侦察派发形状闸-思.md`，4/4 PASS 交付缺陷清单）实测抓到三个产品级缺陷：**生产环境深度注入整条失效**（真实 models.dev 目录对 anthropic 裸 id 全带 `reasoning_options(type=effort)`，目录优先解析把它们路由到 effort 词通道，而该通道的 `options.reasoningEffort` 键被 1.18.34 世代 anthropic 传输静默丢弃——此前全部 E2E 恰好都用 catalog-silent id，盲区）；**readonly 形状承诺穿透面**（物化 permission 只拒 `write/edit/bash/task`，宿主 patch 族工具不在列，无 draft 期 readonly 工人可改文件）；**死角会话不冻结**（no-mapping 不入冻结表，mid-session 配置热改会翻转注入行为，违背首请求冻结声明）。

## What Changes

- **anthropic 实证通道矩阵优先于目录**：`resolveDepthChannel` 对 provider family = anthropic 的模型改按实证矩阵直接判定（adaptive 世代 → adaptive effort 键 `options.effort`；legacy 世代 → budget 档位表），不再咨询目录 `reasoning_options`；目录对**其余全部 family** 仍是形状权威。依据：本宿主世代 anthropic 传输丢弃 `reasoningEffort`、改写 `budget_tokens`——目录的 effort 声明在该 wire 上不可发声，实证可发声形态是 `output_config:{effort}` 与 thinking budget。
- **readonly 拒绝面补齐 patch 族**：`MUTATING_TOOLS` 增补 `patch/applypatch/apply/multiedit`（单一常量同时喂物化 permission 与 `effectiveReadonlyShape` 抬离判定，两面一次修齐）。
- **死角也冻结**：no-mapping 解析结果（null translation）同样写入会话冻结表——mid-session 配置编辑只影响新会话。
- **文档披露**：README budget 表注记本宿主世代 wire 改写（注入 28672 → wire 1024，FORGE_DEPTH_PROBE trace 可证）、anthropic 通道优先说明、patch 封印；AGENTS.md 同步。
- **未归档两 change 的 pre-archive 纠偏**（AGENTS.md 明文允许：实现与 spec 偏差先改 delta 再归档）：catalog delta 的 adaptive 来源措辞与「宿主无 adaptive option → finding 而非静默 no-op」不可实现场景修订；recon delta 拒文案补 return-to-forge 指引措辞；两 change tasks.md 补勾；`verify/e2e-recon.md` agent-fallback 失实声明修正；zai wiring 注释过时修正；FORGE_DEPTH_PROBE 的 `optionsAfter` 标签时机修正（apply 后序列化 + 冻结路径补 trace 行）。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `forge-subagents`：两条 requirement 变更——①「Pinned thoughtLevel injection keyed by agent name」：新增 anthropic 实证矩阵优先序语义 + no-mapping 冻结语义；②「Materialization as native subagents with a pinned model」：readonly 拒绝面从 write/edit/bash 扩为完整变异工具族（含 patch 族）。

## Impact

- 代码：`plugin.ts`（resolveDepthChannel 优先序、probe 标签时机）、`src/dispatch-tiers.ts`（MUTATING_TOOLS）、chat.params 冻结写入路径。
- 测试：`tests/forge-subagents-wiring.test.mjs`（生产目录模拟回归——抓 P0-1 的那个盲区、双形状、冻结 null）、`tests/dispatch-prompt.test.mjs`（patch 族物化断言）、`tests/partition-wiring.test.mjs`（effectiveReadonlyShape patch 抬离）。
- 文档：README.md、AGENTS.md；两未归档 change 工件（delta 措辞/tasks/verify 笔记）。
- 发布：行为变更 → minor 版本号递增（0.15.1 → 0.16.0）。
- 非目标：不做传输层能力探测（插件不拥有该面——已知限制入 README，见 design D4）；不做 `effort:"none"` 宿主拒发的绕过（宿主侧行为，文档披露）；不触碰已归档 change。
