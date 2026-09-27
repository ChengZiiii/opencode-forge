# add-dispatch-onboarding · Proposal

## Why

add-dispatch-suite 交付的派发能力配置面过重：roster/expose/profiles/tier 四个概念、inline plugin 元组深嵌套、零配置自动选模不可靠（配置≠可用，B27 活体实证）——人与 AI 都容易配错。owner 经七轮裁决收敛为极简形态：独立 forge.json 文件 + ZCode 式 agent 定义 + 统一深度元语。

## What Changes

- **新增独立配置文件 `forge.json`（JSONC，可注释）**：项目 `<项目根>/.opencode/forge.json`（进仓库、团队共享）> 全局 `~/.config/opencode/forge.json` > 内置 seed，三级回退、单一来源不合并；**热生效**（每次派发前 mtime 缓存重读，无需重启宿主）；插件**只读永不写**该文件。
- **agent 定义极简形态**：`{model, depths, prompt?, shape?, permission?}`——model 用户钉死（AI 无权换、坏模型诚实报错不回退）；depths 用统一元语，第一个元素=缺省深度；prompt 省略用角色默认（外层 worker 纪律模板恒包裹不可配）；shape 默认 readonly、`"write"` 需显式；permission 进阶覆盖（`task: deny` 恒强制防递归）。
- **深度元语统一**：默认五档 `none/low/medium/high/max`，插件按 provider 家族翻译（effort 直传/查表；budget → 预算档位表；toggle on/off）；三硬规则：**逐字优先**（元语恰为原生档名则直传零风险）、**绝不插值**（无对应物即报错，列双方词汇，不猜）、**全程披露**（报告 depthInjected 行升级 `canonical → native`）。原生词（如 XHigh）作为逃生舱逐字透传。
- **BREAKING · 移除零配置自动服务**：未列入配置的身份不再自动生成可派发条目（owner 裁决：自动选模不可行）。
- **BREAKING · forge_dispatch 参数 `profile` → `agent`**；报错即配方。
- **BREAKING · 出厂 seed 重定义**：仅 `research`（depths `[low, medium]`）与 `review`（`[medium, high, max]`）两个 readonly agent，占位 pin `Local/GPT Luna`（必不存在）——未配置时任何派发撞 `pin-unavailable`，错误内嵌机器可执行配置配方（检测身份字符串、文件路径、模板块、验证法）；原 scout/build/review/quick 出厂 tier 移除，写 agent 由用户自建。
- **新增工具 `forge_dispatch_config`**：只读内省，纯 round-trip（agents + knobs + findings），读什么形状就改什么形状，服务"用户让 session AI 代配"主流程。
- **配置期零校验**：唯一校验 = 派发时 depth ∈ 该 agent 的集合（报错列集合）；配错档名 → 逐字透传 → provider 错误原文回流，AI 检测后指引用户改。models.dev 目录降级为价目来源，不再做档位警察。
- **legacy 兼容**：现有 inline roster/tiers 配置继续生效（README 高级节）；wake/ledger/kill/list/crew 全部不动。
- 全局旋钮（timeoutMs/maxConcurrent/disable）留在 opencode.json plugin 元组（宿主级配置）。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `dispatch` —— 本 change 大幅修订该 capability 的配置/解析/物化/校验需求。

> **归档顺序依赖**：`dispatch` capability 当前仅存在于未归档的 `add-dispatch-suite` delta（基线 `openspec/specs/` 尚无该路径）。本 change 的 delta 按合并后基线书写（MODIFIED/REMOVED 引用 add-dispatch-suite 的需求名）。**归档顺序必须 add-dispatch-suite 在先、本 change 在后**，由 owner 在终局验收 add-dispatch-suite 后执行。

## Impact

- `plugin.ts`：config hook（forge.json 加载/回退/notice）、工具注册（参数名、描述、forge_dispatch_config）、错误文本、wake brief 文案中 tier→agent 措辞。
- `src/dispatch-roster.ts`：删除自动生成条目段；seed 常量。
- `src/dispatch-resolver.ts`：agents 钉扎路径（per-agent 深度集合判定）+ 配方错误。
- `src/dispatch-tiers.ts`：agent 物化（prompt/shape/permission）。
- 深度注入层（chat.params 家族分支）：家族翻译表 + 披露。
- 新 `src/forge-config.ts`：JSONC 解析、三级回退、mtime 缓存。
- `README.md`：dispatch 章节重写 + 文件账本表（forge.json 为用户数据，插件只读）。
- 测试套件：配置加载/回退/热生效、解析与配方、翻译三规则、物化、内省、legacy 兼容回归。
- 不动：dispatch-engine 管线、registry、wake 引擎、crew 门、账本结构。
