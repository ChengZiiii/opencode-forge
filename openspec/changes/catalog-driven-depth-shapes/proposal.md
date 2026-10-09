# Proposal — catalog-driven-depth-shapes

## Why

一次真实事故：forge.json 里 `thoughtLevel` 写成 `High`（大小写手滑），翻译层精确小写匹配三连失手——anthropic/zai 家族静默不注入（深度没生效、无报错），openai 家族掉进原生词逃生舱把 `"High"` 盲发给 API。三种协议三种结局，两种是"静默失效"。

根因有三层：

1. **词表当白名单用**：5 词元表（none/low/medium/high/max）之外一律 noMapping 静默吞掉，而社区已收敛 7 词标准（`minimal`/`xhigh` 已是 OpenRouter/Vercel/LiteLLM/models.dev/Codex 的通行词）；
2. **大小写近失无处理**：配置面不归一、线面敏感匹配；
3. **协议家族靠 provider ID 前缀猜**：用户的真实用法（任意家模型 × openai chat / anthropic / responses-codex 三协议任意组合，官方 provider 与自定义端点混用）必然踩中猜错的那天——zcode 目录证明 GLM-5.3 现在也是词表模型（low/high/max），而 models.dev 的 zhipuai 条目还只有 `reasoning = true` 一行，目录滞后于现实。

用户裁决的设计原则（本 change 的公理）：**词表是词典，不是白名单——翻不过去的词原样透传，provider 是最终裁判**（透传后 API 的 400 原样上浮，插件自己永不做那个沉默杀手）。这是 Codex CLI `Custom(String)` 的哲学，也终结了 noMapping 静默吞配置的行为。

## What Changes

- **元词表 5 → 7**：加 `minimal`、`xhigh`（社区收敛集；与 models.dev 审计词表对齐）。`ultra` 等非社区词仍走透传，不进词表。
- **配置边界归一**：`thoughtLevel` 读入时 trim + 小写归一，`High`/`XHigh` 行为等同 `high`/`xhigh`；归一改变了原值时记一条 warn finding。配置面从此全小写，用户不用猜大小写。
- **形状数据链（家族判定重做）**：models.dev 目录带 `reasoning_options` 的模型按目录形状翻译（effort 词表 / toggle / token budget；adaptive 世代 Anthropic 走 effort 直通通道），梯子匹配大小写不敏感、线上发目录记录的原生写法；目录静默的模型回退 provider 前缀家族（现行为）；两头都没有的自定义端点**默认按 effort 词通道透传**。
- **透传默认**：词典外或梯子对不上的词，在词通道（openai chat/responses、anthropic adaptive、目录 effort 模型）上**逐字透传** + unverified 披露；provider 拒绝就让它拒绝，错误原样浮给请求方。
- **死角收窄为两个**：只有"线上根本没有词接口"的形状（legacy budget-only 模型、纯 toggle 端点）维持不注入 + 有界 finding（带双向词表）。这不再是"未知词"的通用命运，只是形状事实。
- **budget 表补槽**：legacy 预算模型维持现有 8192/16384/24576/32768，补 `minimal → 1024`（Anthropic API 硬下限，社区唯一共识数字）与 `xhigh → 28672`（high 与 max 之间半步，不越已发布上限）；README 逐字公布。
- **冻结语义不变**：会话首请求冻结翻译，改 forge.json 只对新会话生效。
- **明确不做**：CEL/fetch-patch 机制（插件不拥有 fetch 边界，zcode 的漂亮件结构上拿不到）、shotgun 多参数齐射（违反极简 fail-soft）、就近钳制（违反 no-interpolation，OpenRouter 的圆滑不学）。

## Capabilities

### New Capabilities

（无——重做既有注入需求的内部语义，不开新能力域。）

### Modified Capabilities

- `forge-subagents`: 「Pinned thoughtLevel injection keyed by agent name」修订——7 词词典 + 配置边界归一（带 finding）+ 目录驱动形状（前缀家族为回退、未知端点默认词通道）+ 透传默认与死角收窄（仅 legacy budget / 纯 toggle 不注入）+ budget 表补 minimal/xhigh 槽；场景从 3 个扩到覆盖归一、透传、目录形状、adaptive、死角。

## Impact

- `src/dispatch-depth.ts`：重写为 effortMap 式纯函数表（Vercel 形状：映射表 + 警告当数据不抛异常）；7 词表；透传分支成为词通道默认；死角 finding。
- `src/models-dev.ts`：快照切片扩出 `reasoning_options`（type + values + adaptive 判定），供形状解析。
- `src/forge-config.ts`：thoughtLevel 归一（trim+lowercase）+ 归一 finding。
- `plugin.ts`：chat.params 形状解析链（目录 → 前缀回退 → 未知透传）；冻结表不动。
- 测试：dispatch-depth 单测（归一后词表/透传/死角/目录写法透出）、forge-config 归一单测、wiring 断言（catalog-silent 透传、High 归一 finding、budget minimal→1024、toggle 死角 finding、adaptive 直通——后者依赖宿主 @ai-sdk/anthropic 实际接受的 options 键，apply 期实证后落测试，宿主若无此键则降级为 finding 并如实记录）。
- 文档：README budget 表更新、AGENTS.md 架构行。
- 风险与实证点：models.dev 数据滞后（回退链覆盖）；宿主 adaptive effort options 键可用性（apply 期验证，失守则死角 finding 而非静默）；透传引发 provider 400 是设计内结局（错误上浮即需求满足）。
