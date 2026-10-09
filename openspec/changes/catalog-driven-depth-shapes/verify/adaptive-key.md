# Verify — 宿主 adaptive effort options 键实证（task 3.2）

日期：2026-10-09 · 方法：沙盒 `opencode serve`（1.18.34）+ 假 Anthropic catch server 抓线上请求体 · 驱动脚本 `scripts/adaptive-key-e2e.mjs` + 候选探针 `scripts/adaptive-key-probe-plugin.mjs`（可复现：`node scripts/adaptive-key-e2e.mjs`，dump 留存 `%TEMP%\adaptive-key-catch-*.json`）

## 实验设计

- 沙盒（OPENCODE_CONFIG_DIR + XDG 三件套隔离）：provider id `anthropic` 覆盖 → baseURL 指向本机 catch server；模型 `claude-opus-4-8-sandbox`（目录必然静默的伪 id，插件前缀回退 → anthropic 家族 → 世代启发 `4.8 ≥ 4.7` → **adaptive-effort 通道**）。
- 工作区 forge.json：`scout` 钉 `thoughtLevel:"xhigh"`（插件注入标记词 **xhigh**）。
- 候选探针插件（第二次运行挂载）注入三个可区分标记：
  - `options.reasoningEffort`（无——这是插件当时的既有注入，标记词 **xhigh**）
  - 顶层 `options.effort = "low"`（标记词 **low**）
  - 名字空间 `options.anthropic.output_config.effort = "medium"` + `thinking:{type:"adaptive"}`（标记词 **medium**）
- 三个标记词互不相同、且都不是宿主默认值的可能取值之外的歧义来源（对照运行排除默认值假说，见下）。

## 线上证据（两次运行差分）

**Run A（无探针，只有插件自身的 `reasoningEffort:"xhigh"` 注入）**——scout 轮请求体头部：

```json
{"model":"claude-opus-4-8-sandbox","max_tokens":8192,"system":[...]}
```

无 `thinking`、无 `output_config`、无任何 effort 字段 → **`options.reasoningEffort` 被 anthropic 传输静默丢弃**。

**Run B（探针挂载，三候选同时在场上）**——scout 轮请求体头部：

```json
{"model":"claude-opus-4-8-sandbox","max_tokens":8192,"output_config":{"effort":"low"},"system":[...]}
```

- 线上出现 `output_config:{effort:"low"}`——标记词是 **low** → **顶层 `options.effort` 存活**，宿主把它映射为 adaptive 世代原生的 `output_config.effort` 线上形状。
- 名字空间候选死亡：线上是 `low` 不是 `medium`，且无 `thinking` 块 → `options.anthropic.output_config.*` 整体被丢弃。
- 默认值假说排除：Run A 同一调用（无任何注入存活时）线上**没有** output_config——若宿主对该传输默认填 `effort:"low"`，Run A 也应出现；没有，故 Run B 的 low 只能来自注入。
- `reasoningEffort` 双重死亡：Run A 证明它单独不上线；Run B 线上是 low 不是 xhigh，证明它在三候选同场时也不上线。

**宿主原生词汇佐证**——宿主自己的 title-gen 调用（claude-haiku-5-5，宿主目录已知 adaptive 世代）线上形状：

```json
"thinking":{"type":"adaptive","display":"summarized","block_binding":{...}},"output_config":{"effort":"low"}
```

即 patch 过的 @ai-sdk/anthropic 的 adaptive 原生词汇就是 `thinking{type:adaptive} + output_config.effort`——`options.effort` 正好落进这条通道。

## conclusion

**可行分支成立：宿主 chat.params 接受顶层 `options.effort` 键并把它送上 anthropic 线（映射为 `output_config:{effort:<word>}`）；`options.reasoningEffort` 与名字空间 `options.anthropic.output_config` 均被静默丢弃。** 已按实证调整实现：adaptive-effort 通道注入 `options.effort = <word>`（`src/dispatch-depth.ts` applyDepthTranslation，effort 通道维持 `reasoningEffort` 不变），wiring 断言与单测同步（`tests/forge-subagents-wiring.test.mjs` adaptive 分支、`tests/dispatch-depth.test.mjs` 键契约测试）。

边界如实记录：catch server 逐字收下了仅带 `output_config.effort`（无 `thinking` 块）的请求——真实 Anthropic API 是否要求 `thinking{type:adaptive}` 同时在场是 provider 侧事实，插件不伪造（词典非白名单公理：provider 是最终裁判，错误上浮即设计内结局）。本实证回答的是"宿主接受并传输哪个 options 键"这一问题本身。
