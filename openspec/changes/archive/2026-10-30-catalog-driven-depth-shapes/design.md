# Design — catalog-driven-depth-shapes

## 公理（用户裁决）

**词表是词典，不是白名单。** 翻译层的工作是把"常见词"翻成协议形状；翻不过去的词在词通道上原样透传，provider 是最终裁判；插件自己永不做那个沉默杀手——静默吞掉用户配置是最坏的结局。透传后 API 的 400 属于请求自身的错误，原样上浮，不违反 fail-soft（打断会话的是 provider，不是插件）。

事故起点：`High` 大小写手滑 → 三种协议三种结局（anthropic/zai 静默不注入、openai 盲传 `"High"`）。本 change 之后：归一 → 目录/词典翻译 → 透传，只剩一种确定路径。

## 决策

### D1 解析链：目录 → 前缀回退 → 默认词通道

- **models.dev `reasoning_options` 有数据**：形状与词表全按目录（effort values / toggle / budget_tokens；anthropic adaptive 世代走 effort 直通）。梯子匹配大小写不敏感，线上发**目录记录的原生写法**（目录说 `XHigh` 就发 `XHigh`）。
- **目录静默 + provider 前缀已知**（如 zai/zhipuai——实测 2026-10 models.dev 的 glm-5.3/5.2 条目仅 `reasoning = true`）：回退到现有前缀家族（zai→toggle 等，即现状行为保底）。
- **两头都没有**（自定义中转/任意端点）：**默认按 effort 词通道透传**——用户矩阵（任意家模型 × chat/anthropic/responses）里词通道占三分之二，默认赌它是最通用形状；错的话 provider 报错上浮。

每次 chat.params 查找现解析（复用既有热应用契约），会话首请求冻结翻译（不变）。

### D2 归一在配置边界，线面用目录写法

`forge-config` 读入时 `trim + toLowerCase`；改变了原值 → 一条 warn finding（"已归一为 xhigh"）。社区证据：五家参考实现全部精确小写、无一家接受混合大小写；唯一做归一的是社区项目 openclaw。归一后 `High`/`XHigh` 的事故类直接灭绝。原生大小写由目录透出，用户永远不用猜。

### D3 词典 7 词：none/minimal/low/medium/high/xhigh/max

社区收敛集（OpenRouter enum = Vercel portable = LiteLLM anthropic 集 = models.dev 审计词表 = Codex 去掉自留词）。`ultra/persistent` 是 Codex 自留词，不进词典、走透传。词典词的价值仅是跨形状翻译语义（见 D5/D6），不是准入门槛。

### D4 透传默认与死角收窄

- 词通道（openai chat/responses、adaptive anthropic、目录 effort 模型、未知端点默认）：词典/梯子对不上的词 → verbatim 注入 + unverified 披露（现有 effort 兜底分支的语义推广到全部词通道）。
- **死角只剩两个**：legacy budget-only（词变不成数字）与纯 toggle（没有词接口）→ 不注入 + 有界 finding（带双向词表，现行为）。这不是"未知词的命运"，是形状事实。

### D5 anthropic adaptive 通道

LiteLLM/Vercel/zcode 三家共同的新路径：adaptive 世代 Claude 走 `thinking {type:adaptive} + effort` 词直通，不再编 budget 数字；预算表只服务 legacy 模型。**宿主实证点**：opencode patch 过 @ai-sdk/anthropic，chat.params 需要宿主实际接受的 options 键——apply 期沙盒实测；宿主若无此键 → 出 finding（不静默），如实记录 verify 笔记。

### D6 budget 表补槽（无社区共识，选一组并公布）

四家四张表，唯一共识数字是 1024（Anthropic API 硬下限）。决策：保留现有 8192/16384/24576/32768 不动（README 已公布，不折腾存量），补 `minimal → 1024`（API 语义锚点）、`xhigh → 28672`（high/max 间半步、不越已发布上限）。README 逐字公布 + 注明"本表为本插件选定，无社区标准"。

### D7 实现形状：Vercel 式 effortMap 纯表

`dispatch-depth.ts` 重写：每形状一张 `Partial<Record<词典词, 目标>>` 显式映射表 + 警告当数据（`{type:'unsupported'|'compatibility'}` 风格的 finding 载荷，绝不 throw）——与既有 resolvePinnedDepth fail-soft 语义同构；加词 = 加表行，不是加分支。

### D8 明确不抄

CEL/fetch-patch（插件不拥有 fetch 边界——zcode 最漂亮的件结构上拿不到，教训收下：翻译收单点、形状进数据）；shotgun 多参数齐射（zcode 方言鲁棒性的代价是发出后端可能拒绝的字段，与极简 fail-soft 相反）；就近钳制（OpenRouter 的圆滑 = 替用户做未授权决定）。

## Non-Goals

- **不加 per-agent 形状覆盖配置**（如 `depthShape: "effort"`）：回退链已覆盖真实场景（自定义端点默认透传）；已知前缀但端点实际吃词的情况（GLM-5.3 via z.ai 官方 anthropic 传输）出路是 models.dev 数据修复，不是再加配置面。实测撞墙再立后续 change。
- 不做双向翻译（budget→effort 反向）、不做比例式 budget（需要每请求 max_tokens，静态钉扎不匹配）、不抄任何形式的请求期钳制。

## 风险与缓解

| 风险 | 缓解 |
| ---- | ---- |
| models.dev 滞后（zhipuai 现状即如此） | 回退链：前缀家族保底 = 现状行为，零回退 |
| 宿主无 adaptive effort options 键 | 降级为 finding（不静默），verify 笔记如实记录 |
| 透传引发 provider 400 | 设计内结局：错误上浮即需求满足；disclosure 已标 unverified |
| GLM-5.3 z.ai 官方传输落 toggle 死角，用户预期"深度调优"落空 | zcode 实证该传输确实只收 toggle——是 API 事实不是插件缺陷；finding 文案明确指出该端点无词接口；数据修复路径见 Non-Goals |
| 归一 finding 刷屏 | 有界（每 agent 一次，沿用 depthFindingNotes 模式） |
