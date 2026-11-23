# Design: fix-runtime-model-pin-variant

## D0 — 调研加固状态

内部调研（C4 报告）实锤丢失点与测试矛盾。外部调研（E2）印证与两个
注意点：

- variant 在子会话被丢弃是**已知上游 bug 类**（#21632 "subagent model
  variants are parsed but not applied"；#25126/#18634 UI 显示默认档
  而非生效档）——我们修的是自己 pin 层的丢失，不是上游的锅。
- **官方钉死通道**：agent/command 的 `model: provider/model#variant`
  与 per-model variant 设置；根配置不保留 variant（文档明示）。
- 注意点 1（D3 已记账）：options 注入的键名要对照 2.3.2 vendored
  provider 包核实（`thoughtLevel` vs `effort`/`reasoningEffort`——
  公开 AI SDK 已改名 effort）；本轮不动注入腿，但 coder 落地 D1 时
  以本地包为准。
- 注意点 2：生效深度的**显示**是上游未解题（#58809）；我们修 model
  record 的 variant（UI 读的正是它），若显示仍 Default 则按上游已知
  限制记录，不硬扛。

## D1 — pin 重写规则（plugin.ts :8138-8169 段）

```
identityEquals = m.providerID === pinned.providerID
  && (m.modelID ?? m.id) === pinned.modelID
if (identityEquals) {
  // 隐形 no-op：只改拼写，不动 variant —— 宿主解析的 #low 存活
} else if (recipeDepth ∈ VARIANT_DEPTH_WORDS) {
  m.variant = recipeDepth        // 换模型：从钉扎深度派生
} else {
  delete m.variant               // 换模型且无深度词：旧 variant 无意义
}
```

- `VARIANT_DEPTH_WORDS` 从 src/roster-compile.ts import（plugin→src
  依赖方向合法；plan-file 纯核心红线不涉及）。
- recipe 语义权威不变（spec :903-907）：pinnedDef 从 forge.json 现解析
  （hot-apply 契约保持）。

## D2 — 创建期 modelPin 腿

`rosterModelPin` 增 variant：recipe thoughtLevel ∈ VARIANT_DEPTH_WORDS
时 `{id, providerID, variant: depth}`，否则维持裸 id。dispatch-async
create seam（:257-271）裸 id 契约注释同步更新为"裸 id 或 id+variant"。
两腿（创建期 + context 钩子）一致后，无论宿主是否预解析 .md，UI 都拿到
真实 variant。

## D3 — 明确不动：options 深度注入

`applyDepthTranslation` 往 `o.options` 注 reasoningEffort 的腿保留——
与 `#variant` 同值双通道投递（"low" 双送）无害；收束单通道是独立决策，
涉及 provider 面差异，本轮不碰（记账：未来若统一，需按 provider 能力
矩阵另立 change）。

## D4 — 测试

| 用例 | 断言 |
| --- | --- |
| 同身份 pin（.md 解析出 #low + recipe 同模型） | `m.variant === "low"` 存活 |
| 换模型 + recipe thoughtLevel:"high" | `m.variant === "high"` 派生 |
| 换模型 + 无深度词 | `delete`（旧行为保留） |
| rosterModelPin variant 腿 | 深度词→{id,providerID,variant}；无→裸 id |
| roster-compile / builtin-override | 不动（端到端矛盾消除） |

## D5 — 验证

1. 单测+typecheck 全绿。
2. 沙箱 E2E：钉扎 worker 派发 → 子会话 message 的 model record
   `variant === 钉扎深度`（真机同判据，晨间用户复查 UI 显示）。
3. 真机终验（晨间）：用户重启 0.33.0 后派发一个 `#low` worker，UI 思考
   深度显示 Low 而非 Default。

## D6 — 版本

并入 0.33.0 合并发版。
