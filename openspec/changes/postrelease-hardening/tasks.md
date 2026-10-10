# Tasks — postrelease-hardening

## 1. src: anthropic 实证矩阵优先

- [x] `resolveDepthChannel`（plugin.ts）家族门前置：family=anthropic 时先于目录判定——adaptive 世代 → adaptive-effort、legacy → budget；其余家族目录权威不变
- [x] `isAdaptiveAnthropic` 保持既有边界（major>4 或 4.7+；无次版本号=legacy）

## 2. src: MUTATING_TOOLS 补 patch 族

- [x] `src/dispatch-tiers.ts` `MUTATING_TOOLS` 增补 `patch/applypatch/apply/multiedit`（单常量喂物化 permission 与 `effectiveReadonlyShape` 两面）

## 3. src: 死角冻结

- [x] chat.params：no-mapping 解析结果（null translation）写入会话冻结表，冻结语义覆盖「不注入」的稳定性；冻结路径补 probe trace 行

## 4. plugin: probe 标签时机

- [x] `FORGE_DEPTH_PROBE` 的 `optionsAfter` 在 apply 之后序列化（或在 apply 前命名为 `optionsBefore`），排障不再误判

## 5. tests: 回归面

- [x] wiring 生产目录模拟：目录带 `reasoning_options(type=effort)` 的 anthropic id（4-7/4-8）仍走 adaptive 键、legacy（4-6/无次版本）走 budget 表——P0-1 的盲区回归
- [x] 物化断言：readonly permission 枚举含 patch 族；override 抬离 patch 任一员即失豁免（形状闸）
- [x] 冻结死角：首解析 no-mapping → mid-session 配置修复不改变本会话、新会话重解析
- [x] `task {subagent_type, agent}` both-fields 名册解析缝测试（宿主 schema 挡 agent-only，代码缝保留）

## 6. docs: 披露与同步

- [x] README：anthropic 通道优先说明、budget 宿主改写注记（表值 trace 可证、wire 以宿主为准）、`effort:"none"` 宿主拒发注记、patch 封印
- [x] AGENTS.md 架构行同步

## 7. hygiene: 未归档两 change 的 pre-archive 纠偏

- [x] catalog delta：adaptive 来源措辞修正 + 「无 adaptive option → finding」不可实现场景修订（对齐 D4）
- [x] recon delta：拒文案 return-to-forge 指引措辞补齐
- [x] 两 change tasks.md 补勾；`verify/e2e-recon.md` agent-fallback 失实声明修正；zai wiring 注释修正

## 8. gate: 全量验证与发布

- [x] `bun run typecheck` + `node --test tests/*.test.mjs` + `bun run bundle` + `openspec validate --all`
- [x] 沙盒 E2E：`OPENCODE_MODELS_URL` 供生产形态目录（anthropic 真实 id 带 effort reasoning_options）→ 实测 4-7/4-8 钉扎 wire 出 `output_config:{effort}`、4-6 出 thinking 结构——P0-1 的行为级验证
- [x] 版本 0.16.0（行为变更）、npm publish、postpublish 行为抽测（官方安装形态）
