# Verify — npm 安装实测（postpublish，两行为各一次）

日期：2026-10-09 · 包：`npm:@sorenllm/opencode-forge@0.15.1`（registry dist-tags.latest，沙盒冷缓存全新拉取）· 宿主 opencode 1.18.34 · 驱动 `scripts/npm-postpublish-e2e.mjs`（零探针插件、零 env 门控，官方安装形态）· 证据留存 `%TEMP%\npm-postpub-evidence-1791569906787.json` · 判定 **`NPM_POSTPUB A=PASS B=PASS`（exit 0）**

## 实测 A — thoughtLevel:XHigh 归一生效

- 配置（沙盒工作区 forge.json）：`scout` 钉 `anthropic/claude-opus-4-8-sandbox` + `thoughtLevel: "XHigh"`（故意混合大小写）
- 驱动：真实 task 派发 forge-scout（见 B），scout 子会话首个 LLM 请求经 catch server 全量捕获
- **线上体逐字**（29309B 请求体头部）：

```json
{"model":"claude-opus-4-8-sandbox","max_tokens":8192,"output_config":{"effort":"xhigh"},"system":[{"type":"text","text":"You are forge-scout, a readonly worker: ...
```

- 断言全过：`"effort":"xhigh"` 在场（配置边界的 trim+小写归一 **XHigh → xhigh** 后、经 adaptive-effort 通道以实证键 `options.effort` 上线，宿主映射为 adaptive 世代原生 `output_config:{effort}` 形状）；原始大小写 `XHigh` 全文绝迹（归一完整，无 verbatim 泄漏）

## 实测 B — draft 期 readonly scout 派发放行

- 前置：手写 `status: draft` plan 文件于工作区 `.opencode/plan/`（resolveActivePlan 目录兜底解析，会话级禁写生效域）
- 驱动：catch server 以脚本化 `tool_use` 轮令主 forge 会话真实执行 `task {subagent_type:"forge-scout"}`
- 结果：**派发物理放行**——scout 子会话真实运行（其独立请求即为 A 的证据载体，system 含物化 readonly 纪律 "You are forge-scout, a readonly worker"），scout 结论经 tool_result 回灌主会话，全程窗口内拒绝文案（"dispatch is denied for this target"）零出现；write 形状目标拒绝对应路径已在 e2e-recon.md（沙盒 file:// 版）先行实证

## 0.15.0 → 0.15.1 修复说明（如实）

0.15.0 的 chat.params 读 `model.modelID`，而真实宿主传 ModelInfo（模型名在 `model.id`）——adaptive 世代模型在真实宿主上静默降级 budget 通道，行为 A 在 0.15.0 上不可通过（postpublish 实测抓住）。0.15.1 双形状兼容（含 wiring 回归测试 `tests/forge-subagents-wiring.test.mjs` host-shape 断言）后，本官方实测双 PASS。
