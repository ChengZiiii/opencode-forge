# Verify — npm 0.16.0 官方安装形态抽测（postpublish）

日期：2026-10-10 · 包 `npm:@sorenllm/opencode-forge@0.16.0`（无版本号=拉 latest，registry 实拉；dist-tags 首查 0.15.1 未传播，30s 窗口后轮询即 0.16.0）· 宿主 opencode 1.18.34 · 驱动 `scripts/npm-postpublish-e2e.mjs` 原样（端口 43260/43261）+ 补充全量 wire 取证跑（43262/43263，因仓库脚本仅留存 wire 头 600B，补跑复刻逻辑全量留存 body）· 证据 `%TEMP%\forge-postpub-016\`（主跑 25KB + 全量 29306B scout wire body + 双跑 stdout）· 判定 **`NPM_POSTPUB A=PASS B=PASS`（双跑一致，exit 0）**

## A — thoughtLevel:"XHigh" 归一 + adaptive 键上 wire（PASS）

钉 `claude-opus-4-8-sandbox` + `thoughtLevel:"XHigh"`（混合大小写，`-sandbox` 后缀=非目录 id——0.16.0 的 anthropic 实证矩阵对非目录 id 同样适用；生产目录形态的行为级验证见 e2e-prod-catalog.md）：

```json
{"model":"claude-opus-4-8-sandbox","max_tokens":8192,"output_config":{"effort":"xhigh"},"system":[{"type":"text","text":"You are forge-scout, a readonly worker: ...
```

- `output_config:{"effort":"xhigh"}` 逐字命中（strict/tolerant 正则双过）
- **全量 29306B body 扫描：`reasoningEffort` 大小写敏感/不敏感均 0 命中、`budget_tokens` 0 命中、原大小写 `XHigh` 0 命中**、小写 `xhigh` 恰 1 处（output_config 值，无幽灵重复注入）

## B — draft 期 readonly scout 派发物理放行（PASS）

draft plan 目录兜底落盘 → 事件流实证：task pending → scout 子会话 `session.created`（parentID 链正确）→ 自有 catch 请求 → `session.idle` → task `completed`（输出含 Scout report）→ 主会话收尾；**拒绝文案双侧 0 出现**（事件流 113 条 `denied|refus` 扫描 0 命中）。

## 清理确认

4326x 四端口全空、无残留 opencode.exe；沙箱根双跑自删；真实 `~/.config/opencode/opencode.jsonc` SHA256 跑前跑后不变（零污染）。
