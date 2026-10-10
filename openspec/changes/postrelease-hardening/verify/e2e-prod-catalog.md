# Verify — 生产形态目录下 anthropic 深度上 wire（P0-1 行为级终验）

日期：2026-10-10 · 被测件：postrelease-hardening 实现副本（robocopy + 副本内 bun build，仓库零写入）· 宿主 opencode 1.18.34 · 沙盒 XDG 三件套 + `OPENCODE_MODELS_URL` 供生产形态目录 · `FORGE_DEPTH_PROBE=1` · 端口 43500/43501 已清 · 证据 `%TEMP%\forge-hardening-e2e\evidence-L1|L2|L3|CTRL.json` · 驱动 `drive-leg.mjs`

## 目录形态（刻意还原 P0-1 的生产数据面）

`claude-opus-4-6 / 4-7 / 4-8` 各带 `reasoning_options:[{type:"effort",values:["low","medium","high"]}]`——梯子**不含 xhigh**。若目录当权威，xhigh 只能 verbatim 落 `reasoningEffort`，被本宿主 anthropic 传输静默丢弃（生产失效根因）。

## 四腿判定

| 腿 | 钉扎 | wire 逐字 | 判定 |
|---|---|---|---|
| L1 | `anthropic/claude-opus-4-7` + `"XHigh"` | `"output_config":{"effort":"xhigh"}` 精确单键；`reasoningEffort` 0 命中、`thinking` 0 命中、`XHigh` 原大小写 0 命中（归一上线） | **PASS** |
| L2 | `anthropic/claude-opus-4-8` + `"XHigh"` | 同上形态 | **PASS** |
| L3 | `anthropic/claude-opus-4-6` + `xhigh` | `"thinking":{"type":"enabled","budget_tokens":1024}` 结构在；插件注入 28672（probe：`channel={"kind":"budget"} budgetTokens:28672`），宿主改写 1024 上线（README 已声明） | **PASS** |
| CTRL | `zai-coding-plan/glm-x` + `high`（目录 effort ladder 含 high） | `"reasoning_effort":"high"`，probe `ladder:["low","medium","high"]` confirmed | **PASS**（目录权威不回归） |

probe trace 逐腿确认通道：L1/L2 `channel={"kind":"adaptive-effort"}`，L3 `{"kind":"budget"}`，CTRL `{"kind":"effort"}`。

## 结论

anthropic 实证传输矩阵家族门前置（`resolveDepthChannel`）在生产形态目录下成立：**目录对 anthropic 的 effort 声明不再压垮实证矩阵**——adaptive 世代经 `options.effort` 上 wire `output_config:{effort}`，legacy 出 thinking 结构；非 anthropic 家族仍由目录定形状。P0-1 关闭。工具层发现（宿主目录 Schema 硬要求、`OPENCODE_MODELS_URL` 双消费者语义）已记录于工人报告，不改产品面。
