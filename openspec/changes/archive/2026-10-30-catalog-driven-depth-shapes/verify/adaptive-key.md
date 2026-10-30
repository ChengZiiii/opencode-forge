# Verify — 宿主 adaptive effort options 键实证（task 3.2，修订版）

日期：2026-10-09（当日两轮：首轮探针作废，修订轮端到端闭环）· 方法：沙盒 `opencode serve`（1.18.34）+ 假 Anthropic catch server 抓线上请求体 · 驱动：`scripts/adaptive-key-e2e.mjs` + `scripts/npm-postpublish-e2e.mjs`（后者含内容路由 tool_use 脚本化派发）

## 方法论更正（如实记录）

首轮实验的候选探针插件（`export async function server()` 形状 + file:// 直指 .mjs）**从未被宿主加载**——宿主要求 `export default { id, server }` 且 file:// 条目必须是带 package.json 的目录包（归档 FINDINGS 佐证 + 当日微实验复核）。因此首轮 Run B 的"候选键差分"归因无效。修订轮不再依赖外挂探针：以插件自身注入 + `FORGE_DEPTH_PROBE=1` 内置 trace（plugin.ts chat.params 内 env 门控日志）完成归因，线上体为唯一仲裁。

## 宿主形状发现（比键名更根本）

修订轮 trace 实锤：宿主 chat.params 的 `model` 是完整 ModelInfo 对象——**模型名在 `model.id`**，不是插件 SDK 测试形状的 `model.modelID`。只读 modelID 时 adaptive 世代模型在真实宿主上静默降级为 budget 通道（trace：`model= channel={"kind":"budget"}`，注入 thinking budget 28672，宿主钳制为 1024 上线）。已修复：plugin.ts 同时接受 `model.modelID`（SDK 测试形状）与 `model.id`（宿主 ModelInfo 形状），含 wiring 回归测试。

## conclusion

**可行分支成立，端到端闭环（无外挂探针，插件自身的注入上线上体）：**

- 插件在 adaptive-effort 通道盖 **顶层 `options.effort = <word>`**（`src/dispatch-depth.ts` applyDepthTranslation；effort 通道维持 `reasoningEffort`）；
- 宿主（patch 过的 @ai-sdk/anthropic）把它映射为 adaptive 世代原生线上形状 **`"output_config":{"effort":"xhigh"}`** —— scout 子会话真实请求体逐字（npm-postpublish 驱动抓取，`thoughtLevel:"XHigh"` 配置归一为 `xhigh` 后上线，原始大小写绝迹）；
- trace 佐证：`channel={"kind":"adaptive-effort"} translation=verbatim xhigh`；`reasoningEffort` 键在 anthropic 传输上不被宿主转送（本轮插件未盖该键；宿主 title-gen 自身调用证实 `output_config.effort` 即原生 adaptive 词汇 `thinking:{type:"adaptive"} + output_config:{effort:"low"}`）。

边界如实记录：catch server 逐字收下仅带 `output_config.effort`（无 thinking 块）的请求——真实 Anthropic API 是否要求 `thinking{type:adaptive}` 同场是 provider 侧事实，插件不伪造（词典非白名单公理：provider 是最终裁判）。首轮 Run B 观察到的 `effort:"low"` 来源已不可归因（探针未加载，该轮实验作废），修订轮不依赖它。
