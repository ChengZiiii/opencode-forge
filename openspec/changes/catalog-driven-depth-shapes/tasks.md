# Tasks — catalog-driven-depth-shapes

## 1. 纯函数核心

- [ ] 1.1 `src/dispatch-depth.ts` 重写为 effortMap 纯表：7 词词典（META_DEPTHS 扩 minimal/xhigh）、每形状一张 Partial 映射表、词通道透传分支成为默认、死角（legacy budget / toggle）出 finding 载荷（不 throw）、budget 表补 `minimal: 1024` 与 `xhigh: 28672`、大小写不敏感梯子匹配 + 目录原生写法透出。验证：单测——7 词各形状翻译、透传词（ultra）词通道注入 + unverified 披露、死角词不注入 + 双向词表 finding、目录写法透出（ladder `XHigh` + 请求 `xhigh` → 发 `XHigh`）、budget 补槽数字、no-interpolation（绝不改词重映射）

## 2. 配置与目录切片

- [ ] 2.1 `src/forge-config.ts`：thoughtLevel 归一（trim + toLowerCase）+ 归一改变原值时 warn finding（有界每 agent 一次沿用 findings 通道）。验证：单测——`High`/`XHigh`/`  high ` 归一后与 `high`/`xhigh` 等价、finding 文案含原值与归一值、不改原子对语义（half-pair 校验不受影响）

- [ ] 2.2 `src/models-dev.ts`：快照切片扩出 `reasoning_options`（type: effort/toggle/budget_tokens + values + adaptive 判定），快照不可用时 null 降级（现状语义）。验证：单测——有/无 reasoning_options 条目解析、effort values 逐字透出、toggle/budget 类型识别、快照缺失 fail-soft

## 3. 宿主接线

- [ ] 3.1 `plugin.ts` chat.params 形状解析链：目录 reasoning_options → provider 前缀家族回退 → 未知端点默认 effort 词通道；冻结语义保持（首请求冻结、热应用只对新会话）；resolvePinnedDepth 消费新表。验证：wiring 单测——目录 effort 模型按词表注入、目录静默 + zai 前缀回退 toggle（xhigh → 死角 finding）、自定义 provider 未知 → 透传 `reasoningEffort`、`High` 归一后正常注入且 finding 触发一次

- [ ] 3.2 宿主 adaptive effort 键实证：沙盒 `opencode serve` + 实测宿主（含其 patch 过的 @ai-sdk/anthropic）chat.params 接受的 adaptive options 键；可行 → adaptive 通道注入 + wiring 断言；不可行 → 死角式 finding 降级。验证：verify 笔记（`verify/adaptive-key.md`）记录实测请求形状与结论，任一分支有对应测试

## 4. 文档与回归

- [ ] 4.1 README：budget 表更新（补 minimal/xhigh 行 + "本插件选定，无社区标准"注记）、thoughtLevel 全小写书写指引、透传语义说明。验证：文档与 dispatch-depth 常量逐字一致（人工核对）

- [ ] 4.2 AGENTS.md 架构表 dispatch-depth/models-dev 行同步。验证：与实现一致

- [ ] 4.3 全量回归：`bun run typecheck` + `node --test tests/*.test.mjs` + `bun run bundle` + `openspec validate --all` + 官方安装模式终验（`opencode plugin "git+file://<仓库绝对路径>" --global`），装好后钉 `thoughtLevel: "XHigh"` 实测归一 finding 与注入各一次。验证：全绿 + 实测记录
