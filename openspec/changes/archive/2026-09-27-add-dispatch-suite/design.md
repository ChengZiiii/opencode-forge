# Design: add-dispatch-suite

## Context

推演与验证材料：仓库根 `dispatch-wargame.md`（设计全文 + 事实地基 F1-F12）、本目录
`probe/FINDINGS.md`（1.18.32 实机探针矩阵）。承重事实：`PluginInput` 自带
`serverUrl` + `client`（宿主实例 SDK client）；消息请求体支持 `model {providerID,
modelID}` + `agent`（1.18.32 无 `variant` 字段）；`chat.params` 钩子对 HTTP 创建的
会话触发（含 agent 参数）；`POST /session` 不收 `permission` 字段（400）；agent 级
deny 在真实 provider 强制生效（工具从模型工具集移除），免钥 Zen 端点对缩减工具集
返回空响应；消息响应 `info.tokens` 真值、`cost` 恒 0。现有代码资产：plugin.ts 的
config hook no-clobber 注入、ask 门两件套、tool.execute.before 禁写、有界账本模式
（job/watchdog）、`src/*` 纯函数 + 注入缝的测试风格。

## Goals / Non-Goals

**Goals:**

- roster（曝光表 + 精确匹配解析）、forge_dispatch（同步 + 后台 + 如实披露）、完成唤醒
  引擎（合并 brief、与 goal 共存）、kill/list 辅助工具、tier 物化、chat.params 档位注
  入、启动期校验、有界账本、`/crew` 编排纪律 + `crew_close` 完成门——一个 change 交付
  完整套件（原三期路线合并，见 proposal 头注）。
- 解析/名册/注册表逻辑为纯函数（无 @opencode-ai 依赖、可注入），延续 src/ 测试风格。
- 唤醒引擎复用 goal 续跑机制的同款手法（idle 事件 + brief 注入 + 防抖 + owner 检查）。

**Non-Goals:**

- 档位翻译/钳制（设计上禁止存在）；goal 预算联动（仅 brief 合并共存）；`opencode run`
  子进程派发路径；跨会话 crew 续跑（crew 状态内存化，重启即诚实死亡，未来有需要再立
  change）；crew 文件持久化（不做第三个文件格式）。
- TUI 内子会话呈现优化（P4 未测完，只记录 sessionID 供用户追溯）。

## Decisions

- **D1 子会话工厂走 `input.client`（宿主内单实例）**。备选 `opencode run` 子进程
  （每次冷启、ask 自动拒绝、`--agent` 仅收 primary——探针/调研双重否决）与 sdk-next
  进程内嵌（transitional，观望）。完成检测用**轮询** `GET /session/:id/message`
  （探针实证 idle 事件在驱动侧不可靠，轮询稳定）。`POST /session` 的 `parentID`
  为 best-effort（dev 分支语义，1.18.32 接受度未探——被拒则省略并照常派发，仅影响
  归属展示）。
- **D2 档位注入 = chat.params 钩子按 sessionID 打标**（omo 生产同款）。内存表
  `Map<sessionID, {level, injected}>`；首回合写入 provider 形状选项后置 injected，
  会话内不再改写（档位稳定，避免 Anthropic 顶档变更破坏 cache）。provider 映射表
  初始三族：OpenAI 兼容 `reasoningEffort`、Anthropic `thinking`、Z.ai `thinking`；
  未知族不注入并披露。上游 dev 分支 `variant` 落地后整体切换为请求体字段（小 change
  迁移，P6 跟踪）。
- **D3 tier 权限载体 = agent 定义 deny 列表**（探针：真实 provider 强制生效，工具从
  工具集移除）。备选 CreateInput.permission（1.18.32 400，排除）、`tools` 布尔
  （同样生效但已废弃，且 Zen 端点两态皆坑）。已知坑：免钥 Zen 端点 × 缩减工具集
  → 空响应 → 表现为派发超时，由超时路径如实上报；README 标注该组合。
- **D4 解析器纯函数 + 错误带菜单**。`resolve(tiers, roster, catalog, {profile,
  depth, exclude})` 无副作用；错误对象内置菜单序列化（供工具直接返回）。
- **D5 成本自算**：启动拉取 models.dev（`OPENCODE_MODELS_URL` 同源尊重）缓存至
  `<tmp>/opencode-dispatch/`（只读 GET，失败降级为无价目模式）；价格快照标签随结果
  披露。cache_read/write 计价沿用 opencode 同款公式。
- **D6 可用性发现查全量 catalog + config**（pitfalls §9 免钥教训），不过可用性门控。
- **D7 账本/目录风格**：`<tmp>/opencode-forge/dispatch/ledger.jsonl`（有界，轮转，
  同 job ledger 参数）；models.dev 缓存独立命名空间目录。
- **D8 门控取舍**：派发**不设 ask 门**（不是状态翻转；成本可见性靠结果披露 + 
  maxConcurrent 槽位 + 后续 waves 期的预算）；plan draft 禁派经 `tool.execute.before`
  抛错（TUI/run 双模式生效，与禁写同路径）。
- **D9 v1/v2 双入口**：dispatch 全部能力挂 v1 `server`；v2 `setup` 仅防御式注册
  tier agent（create-only，结构化守卫），不注册工具。
- **D10 后台派发 = 同步管线 + 内存注册表**。`background:true` 复用同一解析/建会话/
  轮询路径，差别仅在"等待结果"还是"登记后立即返回句柄"。`src/dispatch-registry.ts`
  纯状态机：`Map<dispatchId, {sessionID, deadline, state, delivered}>`，状态
  `queued→running→completed|timeout|killed|error`，`delivered` 保证每终态恰一次唤醒。
  备选 SSE 事件驱动完成检测（探针实证驱动侧 idle 事件不可靠，轮询已验证）——否决。
- **D11 唤醒引擎 = goal 续跑机制同款手法**：`session.idle` 事件 → owner 检查 →
  防抖 → brief 注入。合并规则：自上一 idle 以来的全部终态合成**一条**
  `[forge:dispatch-complete]` brief；同 idle 若 goal 续跑 brief 也要发，则二者合为单次
  再提示（顺序：派发结果在前、goal brief 在后）。活跃回合期间终态只入队不注入。
- **D12 kill 语义 = best-effort + 永远如实**。1.18.32 未探得可靠的会话中止 API
  （`DELETE /session/:id` 未验证）——设计上不依赖它：调用即停止轮询、标记 killed、
  抑制唤醒、账本记 killed；若宿主无中止 API，子会话自然跑完但结果被丢弃并记
  kill-late-completion。安全（无孤儿进程——会话本就是内存对象）且诚实。
- **D13 crew = 纪律模板 + 单 ask 门工具，零文件持久化**。否决"crew 文件格式"（plan/
  goal 已两套，第三套翻倍维护面）与"零工具纯纪律"（族模式需要硬完成门，纯提示不可
  校验）。`crew_close` 按派发账本交叉核对（账本是唯一事实源，不信任会话记忆，天然
  抗 compaction），通过后摘要作为账本事件追加——不新增用户数据目录。
- **D14 run 模式披露而非模拟**。后台唤醒需要活会话；`opencode run` 会话即结束，完成
  只能入账本。工具描述明示"后台面向 TUI 会话，run 模式建议同步"，不做 run 下的伪
  唤醒（阻塞等待会吃满超时且违背 run 语义）。

## Risks / Trade-offs

- [免钥 Zen 端点 × 受限 tier → 子会话空响应] → 超时路径如实上报 + README 已知坑
  标注；后续可在 roster 校验里对免钥身份 × 受限 shape 给启动告警。
- [chat.params 注入被宿主忽略/漂移] → 结果披露注入状态（injected / not-injected
  原因）；P1 探针脚本入库可复验。
- [models.dev 档位数据与 provider 实际不符] → expose 校验只在"已收录"时执行；用户
  曝光表永远胜过目录（不阻断自定义模型）。
- [子会话列表污染 TUI] → sessionID 在结果中披露，title 由派发方带 `[forge:dispatch]`
  前缀；P4 观察留待实机验收。
- [并发槽位与宿主自身工具并行叠加] → maxConcurrent 默认 4（社区经验 3-10 下沿），
  可配；waves 期再引入每 provider 子上限。
- [唤醒 brief 与宿主 idle 事件竞态/风暴] → 防抖 + owner 检查 + `delivered` 幂等
  （每终态恰一次）；与 goal brief 合并避免同 idle 双唤醒。
- [kill 无宿主中止 API 可用] → D12：停轮询 + 账本如实 + 晚到结果丢弃记账，不悬挂。
- [crew 纪律不被模型遵守（波次洪水/漏验收）] → 纪律模板写死节奏规则；`crew_close`
  以账本为准硬校验，缺 verdict/漏子任务拒关。
- [长 crew 会话 compaction] → 结果与核对都以账本为事实源（D13），会话记忆丢失不影
  响完成门判定。

## Migration Plan

纯新增能力：安装即有（零配置默认 roster 生效）；回退 = plugin options
`dispatch.disable: true`（工具/注入/账本全摘，风格同 watchdog.mode）；卸载四步照旧，
README 文件账本追加 `<tmp>/opencode-forge/dispatch/` 与 models.dev 缓存目录。

## Open Questions

- models.dev 缓存 TTL 与强制刷新入口（可后定：先随宿主进程生命周期缓存）。
- 子会话 title 约定（`[forge:dispatch] <tier>/<model>` 初版，实机观察后可调）。
