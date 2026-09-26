# forge 多模型派发推演报告（wargame）

> 2026-09-27。输入：上一轮 OmO 调研结论 + 本轮四路子代理社区调研（推理档位归一化 /
> 子代理最小权限 / 成本可见性 / 嵌套派发机制）+ 本地 1.18.32 SDK 复核。
> 本文是设计推演，不是实现承诺；行为落地仍走 OpenSpec change 流程。

## 0. 执行摘要

- **方向维持不变**：能力标注模型名册（roster）+ `forge_dispatch` 派发工具（agent 无关，
  像 forge_shell 一样常驻）+ 编排纪律做成第三个 harness 命令（`/crew`），**不新建
  agent mode**。
- **架构被调研结果升级了一级**：上一轮我建议 v1 先做"加载时物化带模型的 tier agent"
  （静态绑定），调研证明这一步可以整个跳过——1.18.32 的会话消息请求体已支持**按调用
  指定模型**（本地 SDK 复核 ✅），推理档位可用 `chat.params` 钩子**按会话注入**
  （本地插件类型复核 ✅，oh-my-openagent 生产环境同款模式）。**每派发动态绑定
  (model, depth) 在当前宿主版本上就可行**——这是你原始设想（"主 agent 派活前自己判断
  选什么模型配什么深度"）的全量实现，不需要任何静态中间层。
- **四个风险项的社区验证情况**：推理档位归一化 ✅ 已解决（复用 opencode variant 体系
  + models.dev 能力数据）；嵌套派发机制 ✅ 已解决（`input.client` 宿主内开子会话，
  零新进程）；子代理权限 ⚠️ 方案明确 + 两个已知上游坑要绕；成本可见性 ⚠️ token 可靠、
  cost 字段上游不可靠 → 自算。

## 1. 推演事实基础

以下事实是本报告推理的地基。✅ = 有本地文件/源码/官方文档出处；⚠️ = 推断或仅 dev 分支验证。

| # | 事实 | 验证 |
| --- | --- | --- |
| F1 | 消息请求体支持 `model {providerID, modelID}` + `agent` + `system`，**1.18.32 无 `variant` 字段**（dev 分支才有） | ✅ 本地 `@opencode-ai/sdk` types.gen.d.ts L2244-2258；`opencode run --help`（1.18.32）无 `--variant` |
| F2 | `PluginInput` 自带 `serverUrl: URL` 和现成的 `client`（宿主实例的 SDK client） | ✅ 本地 `@opencode-ai/plugin` dist/index.d.ts L37/L44 |
| F3 | `chat.params` 钩子：按 `{sessionID, agent, model, provider}` 改写 `output.options: Record<string, any>` —— 推理参数可按会话/按消息注入 | ✅ 本地 plugin dist/index.d.ts L203-215 |
| F4 | omo 在 1.18.x 上正是用 `chat.params` 把归一化档位写进 `options.reasoningEffort/thinking`，wire 形状委托给 opencode 自己的转换层 | ✅ omo dev 分支 `packages/omo-opencode/src/plugin/chat-params.ts` |
| F5 | models.dev（opencode 同源镜像 models.opencode.ai）的模型 schema 含 `reasoning_options`（各模型支持的档位/预算形状）+ 结构化价目 | ✅ models.dev/api.json 实测（调研代理） |
| F6 | `message.updated` 事件带 `info.tokens{input,output,reasoning,cache}`；`info.cost` 不可靠（v2 管线硬编码 0、cache_read 低估 2-3x） | ✅ 本地 SDK 类型 + opencode dev 源码 + issues #28494/#17223 |
| F7 | 子代理权限继承：规则 last-match-wins；父会话 deny 会泄进子会话压过子的 allow（#26700 回归，PR #27201 修）；此前曾完全不继承（#26514） | ✅ opencode issues/PR |
| F8 | 子代理会话里 MCP/插件工具"可见不可执行"（#16491，closed as not planned） | ✅ opencode issue |
| F9 | `POST /session` CreateInput 支持 `parentID` 与 `permission` 规则集（派发时预授权） | ✅ opencode dev 分支 server 路由源码（1.18.32 待 probe P3） |
| F10 | agent 配置的 permission 覆盖顺序：agent 侧 > 全局；`permission.task` glob 按子代理名匹配，deny 的子代理从 task 工具描述移除 | ✅ opencode 文档 |
| F11 | 社区嵌套编排并发经验值 3-10 封顶 | ⚠️ 社区经验，非官方 |
| F12 | 模型推理梯子高度异构（models.dev 实测 2026-09-27，5992 条带 reasoning_options）：Qwen3.8 `low/medium/xhigh`（无 high）、Kimi K3 与 GLM-5.3-Flash `low/high/max`（无 medium）、GLM-5.2 `low..xhigh`、GLM-4.x/5.x 与 DeepSeek V3.x 仅 toggle、DeepSeek V4.1-Flash 含 `none` 档；档名集合按模型开放（另有 ultra 等变体） | ✅ models.dev/api.json 本机实测 |

## 2. 目标架构（三层）

```
┌─ L2  /crew 命令（编排纪律：分解 → 分波派发 → 证据验收 → 门）
│      命令模板自含纪律（hermes 式），与 /plan /goal 同构，互不绑定
│
├─ L1  forge_dispatch 工具（动态会话工厂，agent 无关，常驻）
│      resolve(tier, depth) → (model, clampedDepth)
│      input.client 开子会话（parentID + tier 预授权 permission）
│      请求体带 model + agent；chat.params 钩子注入推理档位
│      完成后聚合 tokens、自算 cost、如实披露
│
└─ L0  能力标注名册（roster）+ 解析器（纯函数）
       模型 → {可承担的 tier, 支持档位(取自 models.dev), 成本档}
       插件默认 + 用户经 plugin options 覆盖；可用性看全量 catalog
```

**关键解耦（本设计的中心命题）**：tier agent 定义只承载**行为与权限面**（纪律 prompt +
permission 形状，静态、插件注入、hidden）；**大脑与档位**（model + reasoning depth）由
roster 在**每次派发时动态解析**进请求体。omo 的"category 绑链条"被替换成"tier 绑纪律、
模型走标注"——配置面从一张绑定矩阵缩成一份标注表，且默认值全自动。

### 2.1 名册 schema 草案

```jsonc
// 插件默认内置；用户经 plugin 元组覆盖：["@sorenllm/opencode-forge", { "dispatch": {...} }]
{
  "dispatch": {
    // 无全局词表：请求词汇 = roster 全部 expose 档名的并集（§2.2），渲染进工具描述
    "maxConcurrent": 4,          // 派发并发上限（社区经验 3-10）
    "tiers": {
      "scout":  { "shape": "readonly", "defaultDepth": "low"  },  // 检索侦察：快、便宜
      "build":  { "shape": "write",   "defaultDepth": "high" },   // 实现主力
      "review": { "shape": "readonly", "defaultDepth": "high" },  // 评审/验收
      "quick":  { "shape": "write",   "defaultDepth": "off"  }    // 机械小改
    },
    "roster": [
      // model 必填：完整 provider/model 身份（opencode 的唯一派发键）——不做裸名
      // 匹配；同名模型不同 provider 就是不同条目，曝光/优先级/成本分别策展
      {
        "model": "zai-coding-plan/glm-5.3",
        "expose": ["low", "max"],                  // 官方 low/high/max，藏掉 high
        "profiles": ["build", "review"]
      },
      {
        "model": "opencode-go/glm-5.3",            // 同名模型的另一 provider 副本
        "expose": ["low", "medium"],
        "profiles": ["build"]
      },
      {
        "model": "anthropic/claude-haiku-4-5",
        "profiles": ["scout", "quick"]             // expose 缺省 = 原生梯全量
      }
      // 未列出的已配置 provider/model 身份：插件逐身份生成默认记录
      //（profiles 默认 quick/scout；expose 默认该身份原生梯全量；价目按该身份取）
      // 数组顺序 = 声明序 = 解析优先级（显式，无魔法）
    ]
  }
}
```

### 2.2 曝光表与精确匹配解析（纯函数，进 src/ 单测）

**原则：不翻译、不钳制、不代言。** 每个模型在 roster 里有一张**曝光表**（`expose`）——
它对派发开放的档位，用**原生档名**声明。插件缺省曝光 = models.dev 发现的原生梯子
全量逐字收录；用户裁剪（如 GLM-5.3 官方 low/high/max 只开 low/max、GPT-5.6 只开
low/medium/max）是在做经济学决策，不是在翻译。主 agent 的请求词汇 = 全部曝光档名
的并集，**渲染在 `forge_dispatch` 的工具描述里**——菜单可见，永不盲选。

```
resolve(tier, depth, exclude = []) → {model, depth} | {error, menu}
  cands = roster 中 profiles 含 tier、可用（全量 catalog + config，pitfalls §9）、
          不在 exclude、且 expose ⊇ {depth} 的模型        // ★ 精确匹配，唯一入门
  按 (roster 声明序, cost 档) 排序，取首位原样返回
  cands 为空 → error + 完整菜单（每个 tier 候选模型的 expose 表与不可用原因）
```

- **错即错**：请求了无人曝光的档位 → 结构化错误报告（含菜单），主 agent 自己决定
  换档 / 换 tier / 上报用户——与 goal harness 的 fail-closed 同哲学。**系统内不存在
  任何自动钳制路径**：无 clampPolicy、无档位插值、无 fit 排序。F12 的异构梯子问题
  （Qwen 无 high、Kimi 无 medium、ultra 等未知名）被结构性消灭——一个档位要么在
  菜单里、要么不在，没有第三种状态。
- **配置期校验清单**（启动时全量执行，这类歧义全部在加载期暴露，不留到运行期）：
  1. `roster[].model` 必须是**已配置的完整 provider/model 身份**——死键（配置里没有
     该身份）启动告警点名；不做裸名匹配，同名跨 provider 歧义结构性不存在。
  2. `expose` ⊆ 该身份的原生梯（models.dev 已知时）——拼写错（如 "hihg"）报错并列
     出合法值；models.dev 未收录的自定义/自托管 provider 档名**逐字接受** + 附
     "未验证"告警（不拦截自建模型，但明示无法校验）。
  3. `tier.defaultDepth` 必须被该 tier 至少一条候选曝光，否则：启动告警 + 该 tier
     在菜单中降级为 **depth-required**（默认被摘除，派发必须显式给档）——绝不静默
     换成别的档、绝不猜。派发未给档且无默认 → 运行期错误 + 菜单。
  4. 自定义 tier 未声明 `shape` → 默认 **readonly**（最小权限；放开写权限必须显式
     `"write"`）。
  5. `profiles` 引用不存在的 tier、或 tier id 不符 `[a-z0-9-]`（要进 `forge-<tier>`
     agent 命名空间）→ 告警。
- **"off" 不是普适档名**：OpenAI/DeepSeek 叫 `none`、toggle 型模型是关开关、Gemini 3
  与部分 Anthropic 模型物理关不掉思考——曝光表里 `off` 只是个普通名字，该身份没有
  就没有，由校验第 3 条兜底（quick tier 默认 off 而候选全都不曝光 off → 启动告警 +
  depth-required，运行期报错带菜单）。
- **钉扎通道**：tier 钉扎的 depth 直接写原生档名，按被钉模型的原生梯校验（§2.3）。
- **toggle-only 模型**：原生梯即 [关, 开]，以模型自己的开档名出现在曝光表里（用户
  不想曝光就删——老模型本就少用于派发）。
- **models.dev 角色收窄**：能力发现（原生梯超集）+ 价目，**运行期不再承担任何档位
  换算**。
- **同模型多 provider 梯子不一致**（罕见）：曝光表按落点 provider 的原生梯校验，
  不一致即报错点名。

### 2.3 用户自定义 tier 与模型钉扎（吸收 ZCode 模式）

三种系统把两条正交轴以不同方式耦合在一起：**绑定由谁策展**（官方 / 用户 / 派发时动态）
与**绑定挂在什么上**（纪律与大脑捆绑的 agent / 纪律与大脑分离）。

| 系统 | 策展者 | 挂载形态 | 起步配置 | 换模型时 |
| --- | --- | --- | --- | --- |
| omo | 官方链条 + 用户覆盖 | 捆绑（category 绑模型链） | 高（理解链条/门控） | 改链条或覆盖 |
| ZCode | 用户（自带仅两个） | 捆绑（agent 绑 model+思考深度） | 中（每个 agent 手动定） | 逐个重绑 |
| forge 动态 | 插件默认标注 + 用户覆盖 | **分离**（tier=纪律，roster=大脑） | **零** | 标注跟 models.dev 自动走 |

**判断：值得持久化的是纪律，不是模型绑定。** 一个沉淀过评审清单、项目缺陷模式、
工具限制的 agent 定义（比如我们自己那两个 ZCode 自定义评审 agent）是反复迭代的资产；
而模型绑定只是当时当地的经济学——模型月月换，绑定随时过期。ZCode 把两者捆在一起
持久化，于是换来灵活性的同时把重绑成本留在用户手上；omo 官方捆死，配置面爆炸；
forge 的分离式让"持久化纪律、动态绑大脑"两者兼得。

**机制：tier map 开放 + 可选钉扎。** `dispatch.tiers` 是开放 map，默认四个 tier 之外
用户可任意添加；新 tier 可选带 `model` + `depth` 钉扎——**钉扎即 ZCode 模式**（持久、
用户策展、纪律+大脑捆绑），不钉即动态解析：

```jsonc
"tiers": {
  "spec-review": {
    "shape": "readonly",
    "model": "anthropic/claude-opus-5-5",   // 钉扎：跳过 roster 解析（"Pins win"，omo 同规）
    "depth": "max",
    "prompt": "{file:./review/openspec-checklist.md}",  // 纪律外置成文件，独立于插件迭代
    "permission": { "*": "deny", "read": "allow", "grep": "allow", "glob": "allow" }
  }
}
```

配套规则：
- **解析优先级：tier 钉扎 > roster。**（与 omo "Your explicit configuration always
  wins" 同构。）钉扎 `depth` 可直接写**原生档名**（如 `"xhigh"`、`"ultra"`）——按被钉
  模型自己的梯子原样校验，这是异构档名进入系统的唯一入口（专家通道）。
- **钉扎不回退**：钉扎模型不可用时报错并点名（提示改钉扎或去钉），不静默滑到别的
  模型——与动态解析的 §4.1 回退**刻意相反**：钉扎是明确意志，动态是启发式。
- **决策词汇保持二维稳定**：ZCode 靠富 description 让主 agent 在 N 个命名 agent 里挑；
  tier 化把这 N 个收敛进一张表，`forge_dispatch` 的工具描述里渲染完整 tier 目录
  （名称 + 职责 + 默认深度 + 是否钉扎），主 agent 的选择面同样丰富但词汇不随用户
  配置漂移成任意命名空间。
- **与原生用户 agent 共存**：用户在 opencode config 里自定义的 `agent.<id>` 走原生
  task 工具照旧可用，forge 不隔离它们；tier 是"派发层"的词汇，原生 agent 是"任务层"
  的词汇，两套并存各走各的门。

## 3. 一次派发的完整时序推演

以 `/crew 给 auth 模块补集成测试并修掉超时` 为例：

```
[命令层]
1. /crew 模板进场（进入轮即规则书）：侦察 → 分解 → 声明派发计划 → 分波执行 → 证据验收
2. 主 agent 先派 2 个 scout（后台并行）：forge_dispatch{profile:"scout", depth:"low", background:true}

[派发层 —— 每个派发内部]
3. 工具校验：plan draft 期拒绝（见 §5）；并发槽位检查；参数白名单
4. resolve("scout","low") → 如 (claude-haiku-4-5, low)；登记 期望表[sessionID→(model,depth)]
5. input.client.session.create({
     parentID: 当前会话,                    // F9：父子关系 + 派发归属
     permission: TIER_PREAUTH["scout"]      // 只读白名单式预授权（§4.4）
   })
6. input.client.prompt(sessionID, {
     model: {providerID, modelID},          // F1：按调用指定模型
     agent: "forge-scout"                    // 插件注入的 tier 定义：纪律 prompt + permission 面
   })
7. 宿主为该子会话调 LLM → 插件 chat.params 钩子命中期望表
   → output.options 按 provider 写 reasoningEffort / thinking / thinkingConfig  // F3/F4
8. 等完成：同步派发 = HTTP 响应；后台派发 = SSE message.updated + session.idle
9. GET /session/:id/messages 聚合 tokens（F6）；按 models.dev 价目缓存自算 cost
10. 返回结果对象；占用的并发槽释放；有界账本落 <tmp>/opencode-forge/dispatch/（风格同现有 ledger）

[结果对象 —— 如实披露的最小字段集]
{
  tier: "scout",
  requested: { profile: "scout", depth: "low" },
  actual:    { model: "anthropic/claude-haiku-4-5", depth: "low" },   // 精确匹配下恒等
                                                                     // 于 requested（无钳制）
  sessionID, durationMs,
  tokens: { input, output, reasoning, cacheRead, cacheWrite },
  costUsd: 0.0123,            // 自算，标注 "models.dev@快照时间"；缺价目 → null + 说明
  text: <结论尾段>
}

[命令层收尾]
11. 波内全部返回 → 主 agent 验收证据（/crew 纪律：结论必须带 file:line 证据）
12. 下一波（build ×2 并行 + review 串行尾波）→ 完成门（用户确认框，风格同 plan_close）
```

**TUI / run 模式差异**：派发本身经 HTTP 驱动宿主实例，两模式同路径；差异只在**门**——
run 模式 permission.ask 不触发（pitfalls §4.5.3），所以 /crew 的完成门在 run 模式靠
`--auto` 语义，无 `--auto` 则 auto-reject（与 goal 的既有行为一致，无新增语义）。

## 4. 失败模式与对策

| # | 失败模式 | 对策 | 依据 |
| --- | --- | --- | --- |
| 4.1 | 选中模型中途不可用/请求失败 | roster `exclude` 重试下一候选（一次），结果如实报告实际用者；再失败如实报错 | omo 链条滑档的简化版 |
| 4.2 | 请求档位无人支持（异构梯导致的错配） | **精确匹配 fail-closed**：expose 不含该档 → 结构化错误 + 完整菜单，主 agent 自行换档/换 tier/上报用户；系统内无任何自动钳制路径。配置期校验 tier defaultDepth 有候选可承载，错配在启动告警即暴露 | F12 实测数据 + §2.2 |
| 4.3 | Anthropic 档位变更破坏 prompt cache | worker 会话首消息定档后**会话内保持稳定**，禁止中途回改 | 调研 R1 坑 ⑤ |
| 4.4 | 子会话权限继承坑（父 deny 压死子 allow） | 主 agent 的 deny 面只收 `task`/`forge_dispatch`；tier 权限全部写在 tier 定义 + CreateInput 预授权里，不依赖继承 | #26700/#26514（F7） |
| 4.5 | 子会话里插件工具不可执行 | tier 设计上只用原生工具（read/glob/grep/bash/write/edit）；build tier 若确需 forge_shell → probe P2 通过才放开 | #16491（F8） |
| 4.6 | 子会话挂死 | 派发带 HTTP 侧超时（默认 10min，可调）；其内部 builtin shell 由 watchdog 兜底（已覆盖全部会话含子代理） | 现有 watchdog + 新超时 |
| 4.7 | cost 字段不可靠 | tokens 用事件真值；cost 自算（models.dev 缓存 + opencode 同款公式），缺价目报 `null (price unavailable)` 而非 0 | F6 |
| 4.8 | 宿主退出 | 子会话是宿主内存对象，随之消失——无需 OS fence（比 survive job 简单一个量级）；进行中派发在账本标 `lost-on-exit` | 架构性质 |
| 4.9 | 主 agent 滥派（把该自己干的活派出去） | /crew 纪律约束 + dispatch 结果的 tokens/cost 全披露（滥用可见）；可选 `dispatch.budget` 会话级 token 预算，超了拒绝新派发 | omo"稀缺模型放哪"指南的机械化 |
| 4.10 | 并发压垮 provider | `maxConcurrent`（默认 4）+ 每 provider 子上限（后续项） | F11 |

## 5. 与现有部件的交互矩阵

| 部件 | 关系 | 推演结论 |
| --- | --- | --- |
| plan harness | draft 期禁写扩展 | `forge_dispatch` 与 `task` 同属 spawn 类：draft 期 `tool.execute.before` 抛错拒绝（TUI/run 双模式生效的既定模式），批准后可用（/plan 执行期 fan-out 是明确受益场景） |
| goal harness | 加速器 | goal 循环里可用派发 fan-out；续跑 brief 无需改语义。后续可把派发 tokens 计入 goal 预算（本期不做） |
| job supervisor | 平行的两套监督 | 进程型（forge_shell：四条件 race、OS fence、survive）与会话型（forge_dispatch：HTTP 超时、随宿主消亡）语义对齐但机制分立；**唤醒复用同一机制**（`[forge:dispatch-complete]` 经 promptAsync，单次投递，同 `[forge:job-complete]` 风格） |
| watchdog | 免费覆盖 | 子会话的 builtin shell 停滞由 watchdog 全会话覆盖（README 已声明含 delegated subagents），零新代码 |
| v1/v2 双入口 | 能力边界 | dispatch 依赖 tool + chat.params + event 三类 hook → **v1 `server` 独占**；v2 `setup` 只注入 tier agent 定义（结构化守卫式，与 forge agent 现有注入同款）。v2 宿主上 dispatch 工具摘除（getter 模式，同现有降级） |
| tier agent 注入 | no-clobber | config hook 里只在用户未定义 `agent["forge-scout"]` 等时注入；`hidden: true`；**不写 model 字段**（模型每派发动态给）。顺带迁移项：现有 builtin shell 隐藏用的 `tools` 字段已废弃，择机迁 `permission: {shell:"deny", bash:"deny"}` |

**tier 权限形状（scout 白名单式为范本）**：

```jsonc
"forge-scout": {
  "mode": "subagent", "hidden": true,
  "permission": { "*": "deny", "read": "allow", "glob": "allow",
                  "grep": "allow", "list": "allow", "lsp_*": "allow" }
}
// build：可写 + "task":"deny"（物理禁递归派生）+ bash 收敛白名单
// review：只读 + npm test*/git diff* 放行
// "*"必须写最前——last-match-wins（F10）
```

每个 tier 自身 `task: "deny"` —— 递归派发在权限层物理禁止，比 prompt 约定可靠（调研 R2
核心建议）。`hidden` 只影响 @ 补全 UX，不是安全边界（文档明示），安全靠 permission。

## 6. 风险项 × 社区验证方案对照

### R1 推理档位跨厂商差异 —— ✅ 已解决，且有两条现成轮子

| 方面 | 社区方案 | forge 采用 |
| --- | --- | --- |
| 档位词表 | omo：`[off,minimal,low,medium,high,xhigh,max]`；Vercel AI SDK：`provider-default…xhigh` | **无全局词表**：请求词汇 = 用户曝光表的并集（原生档名透传，缺省=原生梯全量）；异构档名结构性免疫（§2.2） |
| 能力数据 | models.dev `reasoning_options`（含每模型支持档位/预算形状，实测可用） | roster 运行时拉取 + 本地缓存；家族启发式仅离线 fallback |
| wire 映射 | **opencode 本体的转换层已内置全套归一化**（OpenAI 日期门控、Anthropic effort/budget 双轨、Gemini thinkingLevel、GLM 按 SDK 分路）；omo 的做法是 chat.params 写 options 后**委托给它**（约 60 行） | 同款：chat.params 写 `options`，不自己拼 wire 参数 |
| 已知坑 | OpenAI 档位随模型/日期变化；Anthropic budget 必须 < max_tokens；GLM/DeepSeek 档位稀疏；Gemini 3 关不掉思考；Anthropic 顶档变更破坏 cache | 坑清单降级为"曝光裁剪的背景知识"（用户据此定 expose）；运行期只保留"会话内档位稳定"一条纪律（§4.3）；错配不再钳制而是报错（§4.2） |

来源：[OpenAI reasoning](https://developers.openai.com/api/docs/guides/reasoning) ·
[Anthropic effort](https://platform.claude.com/docs/en/build-with-claude/effort) ·
[Gemini thinking](https://ai.google.dev/gemini-api/docs/thinking) ·
[Z.ai GLM-4.6](https://docs.z.ai/guides/llm/glm-4.6) ·
[models.dev api.json](https://models.dev/api.json) ·
[AI SDK reasoning](https://ai-sdk.dev/docs/ai-sdk-core/reasoning) ·
[LiteLLM effort](https://docs.litellm.ai/docs/providers/anthropic_effort) ·
opencode dev 分支 transform.ts/provider-options.ts · omo chat-params.ts 等四文件

### R2 子代理最小权限与继承 —— ⚠️ 方案明确，绕两个上游坑

- **范本**：omo 的 explore/librarian 用 deny 黑名单（write/edit/apply_patch/task 全 deny）；
  调研建议 forge 反着用**白名单式**（`"*":"deny"` 打头）——黑名单对新工具默认放行，漏一个
  就是越权面（调研 R2 结论，Claude Code 的 disallowedTools 黑名单模式同理有此弱点）。
- **坑 1（#26700）**：父会话 deny 泄进子会话压过子的 allow（1.14.46 回归，已修但说明
  继承语义反复摇摆）→ 对策：主 agent deny 面极窄（只 task/forge_dispatch），tier 权限
  自带齐全不依赖继承。
- **坑 2（#16491）**：子代理会话里插件工具可见不可执行（closed as not planned）→ 对策：
  tier 只用原生工具；forge_shell 依赖留 probe。
- **拓扑纪律**：tier 名统一 `forge-*` 前缀；主 agent `permission.task: {"*":"deny",
  "forge-*":"allow"}`；每 tier `task:"deny"` 物理禁递归。

来源：[agents 文档](https://opencode.ai/docs/agents) ·
[permissions 文档](https://opencode.ai/docs/permissions) ·
[#26700](https://github.com/anomalyco/opencode/issues/26700) ·
[#26514](https://github.com/anomalyco/opencode/issues/26514) ·
[#16491](https://github.com/anomalyco/opencode/issues/16491) ·
[omo permission-compat.ts](https://github.com/code-yeongyu/oh-my-openagent/blob/dev/packages/omo-opencode/src/shared/permission-compat.ts) ·
[Claude Code sub-agents](https://code.claude.com/docs/en/sub-agents)

### R3 成本可见性 —— ⚠️ token 可靠、cost 自算

- 事件面：`message.updated` 带 tokens（真值）+ cost（**不可信**：v2 管线硬编码 0，
  cache_read 低估 2-3x，无价目模型 $0——issues #28494/#17223，ccusage 文档印证）。
- 先例：ccusage 读本地 message JSON、token 真实、cost 自算（LiteLLM 价表）—— forge 走
  同路但数据源用 models.dev（与 opencode 同源，含 cache_read/write 价）。
- 归因：子会话 ID 即归因键，收尾 `GET /session/:id/messages` 聚合即可，无需轮询。
- 披露：`tokens + costUsd(自算+价表快照标记) + 实际 model/depth`；缺价目 `null` 不编 0。
- 推理档位无事件级字段 → 披露 forge 请求的档位（clamp 后实际值）。

来源：[docs/server](https://opencode.ai/docs/server) ·
[#28494](https://github.com/anomalyco/opencode/issues/28494) ·
[#17223](https://github.com/anomalyco/opencode/issues/17223) ·
[ccusage opencode](https://ccusage.com/guide/opencode) ·
[models.dev](https://models.dev/api.json) · 本地 SDK types.gen.d.ts

### R4 嵌套派发机制 —— ✅ 已解决（优于预期）

| 机制 | 验证程度 | 结论 |
| --- | --- | --- |
| **(b) `input.client` 宿主内开子会话** | PluginInput.serverUrl/client 本地 ✅；create(parentID+permission)/prompt(model+agent)/SSE/permission 应答全链路被本仓库 live-loop-e2e.mjs 在 1.18.32 实测 ✅ | **主干**。零新进程、单实例、ask 可应答 |
| (a) `opencode run` 子进程 | CLI 形状 ✅（但 1.18.32 无 --variant）；run 模式 ask auto-reject 源码确证 ✅；每调用完整冷启 | 后手：隔离型一次性任务；`--agent` 只收 primary、冷启贵 |
| (c) sdk-next 进程内嵌宿主 | v1.18.32 tag 已存在但自称 transitional | 观望：出 v2 正式版再看 |
| 参考：omo senpi-task | InProcessRunner 进程内建子会话、深度上限 4、独立 transcript | 先例证明进程内路线可行（注意它是另一引擎） |

新发现的迁移红利：dev 分支 PromptInput 已长出 `variant` 字段 + run.ts `--variant` 旗标
（"provider-specific reasoning effort"）——上游正在把档位升为一等公民。等它进 release，
chat.params 注入可整体换成请求体 `variant` 字段（probe P6 记录迁移路径）。

## 7. 分期落地（OpenSpec change 切分建议）

> **2026-09-27 用户裁决修订：三期合并为单一 change `add-dispatch-suite` 一次交付**
> （阶段门内部仍按 core→waves→crew 推进，见仓库根 `dispatch-tdd-process.md`；
> 下表保留为原始切分推演的历史记录）。原 `openspec/changes/add-dispatch-core/`
> 已改名归并为 `openspec/changes/add-dispatch-suite/`（含 probe 材料）。

| 期 | change（历史切分） | 内容 | 验收要点 |
| --- | --- | --- | --- |
| 1 | `add-dispatch-core` | roster 数据模型 + 解析器（src/ 纯函数）+ tier 定义注入 + `forge_dispatch` v1（同步单派发：resolve → create → prompt → chat.params → 聚合）+ 账本 | 单测覆盖解析/clamp/回退；probe P1-P3 过；真实 provider 冒烟（含一个仅 high/max 的模型验证 clamp） |
| 2 | `add-dispatch-waves` | 后台派发 + SSE 完成 + `[forge:dispatch-complete]` 唤醒 + 并发上限 + 超时 + run 模式行为 | 并发 4 波次冒烟；kill/超时/宿主退出账本标记 |
| 3 | `add-crew-harness` | `/crew` 命令模板（分解/波次/证据验收/完成门）+ plan draft 禁派联动 | 官方安装模式终验（pitfalls 第 7 节梯度） |

每期独立可用、独立可退（`dispatch.disable` 一键关，风格同现有 watchdog.mode）。

## 8. probe 清单与结果（2026-09-27 实机执行，1.18.32；复现材料见 openspec/changes/add-dispatch-suite/probe/FINDINGS.md）

| # | 问题 | 结果 |
| --- | --- | --- |
| P1 | `chat.params` 是否对 HTTP API 创建的子会话触发 | ✅ **通过**——含 `agent` 参数的会话全部触发；title 调用的 options 已带 `reasoningEffort`（注入通道畅通） |
| P2 | 子会话里插件工具可否执行（#16491 适用范围） | ✅ **通过**——`probe_ping` 完整执行、无需权限应答；真实配置下子会话工具集可见 `forge_shell`。#16491 仅覆盖 task 派生的会话，不影响 HTTP 会话 |
| P3 | CreateInput 预授权与 agent 定义 permission 的合成顺序 | ⚠️ **问题变形**：1.18.32 的 `POST /session` 不收 `permission` 字段（400，dev 分支特性）→ tier 权限载体唯一化为 agent 定义。agent 级 deny（permission 或 tools 布尔）在真实 provider 上**均强制生效**（write 从工具集移除）；**但免钥 Zen 端点对任何缩减工具集的请求返回空响应**（会话假死）——免钥模型 × 受限 tier 是已知坑组合 |
| P4 | 子会话可见性 | 部分：`GET /session` 列表可见（6 条）；TUI 呈现未测（需实机） |
| P5 | models.dev 离线行为 | 未测（设计已含本地缓存 + 缺价目报 null） |
| P6 | dev 分支 `variant` 迁移 | 跟踪项（上游 release 后开小 change） |

probe 副产物（已并入设计）：消息响应 `info.tokens` 含 reasoning/cache 真值、`cost` 恒 0（自算路线坐实）；模型可能把 "workspace root" 理解为文件系统根并触发无事件可答的外部目录挂起 → **worker 提示纪律硬性要求相对路径 + 子会话独立 deadline 必要**（§4.6 已有）。

## 9. 相对上一轮建议的修订记录

1. v1"加载时物化带模型的 tier agent"**取消**——按调用指定模型 + chat.params 档位注入
   已在 1.18.32 验证可行，静态绑定阶段没有存在必要。
2. tier agent 定义保留但职责收窄：只承载纪律 prompt + permission 面，**永不写 model**。
3. `forge_dispatch` 的实现机制从"三选一待定"定为 `input.client` 单一主干（run 子进程
   降为后手）。
4. 档位词表从 6 档（含 xhigh）收敛为 5 档 + auto（社区双先例）。
5. 新增风险 4.9（滥派可见性/预算）与 4.10（并发上限）两条。
6. **吸收 ZCode 模式（§2.3）**：tier map 开放用户自定义，可选 `model`/`depth` 钉扎——
   钉扎即 ZCode 式"用户策展的持久捆绑"，缺省即动态解析；钉扎优先于 roster 且不可用
   时报错不回退；原生用户 agent 与 tier 两套词汇共存互不接管。
7. **档位词表重构为两层（§2.2，2026-09-27 修订）**：封闭的请求锚点（off/low/medium/
   high/max + auto，其中 off/max 为相对端点）× 开放的物化档位（按模型梯子发现，
   支持未知名按梯内位置插值——ultra/xhigh 无需全局认识）。解析从"选模型后钳制"改为
   **fit-first 选择**（适配度是第一排序键，错配在选择时规避）；残余钳制默认向上取整
   且必披露；性质变化（降智 ≥2 档 / 落 off）直接出局报错。动因：models.dev 实测梯子
   高度异构（F12），原"5 档封闭枚举 + clamp-down"会在无 high/无 medium 的梯子上
   产生双向皆错的钳制。
8. **废除自动钳制，改为曝光表 + 精确匹配（§2.2 二次修订，2026-09-27 用户裁决）**：
   思考档位错配就应该是错误（主 agent 自主收到错误报告并决策），不应被代理层消化。
   roster 每模型声明 `expose`（原生档名子集；缺省 = 原生梯全量逐字收录），请求词汇 =
   曝光并集（渲染进 forge_dispatch 工具描述，菜单可见），解析 = 精确过滤 + 声明序/
   成本排序，无候选即报错带完整菜单；同步删除 clampPolicy / 档位插值 / fit-first
   排序全部机制；新增配置期 defaultDepth 校验告警（错配提前到启动期暴露）。
   models.dev 角色收窄为能力发现 + 价目，运行期零档位换算。
9. **roster 键改为完整 provider/model 身份 + 配置期校验清单（§2.1/§2.2，2026-09-27
   用户审阅）**：废除 `match` 裸名匹配——多 provider 同名模型是 opencode 常态，裸名
   键有歧义；roster 条目以 `model: "provider/model"` 精确键，同名跨 provider = 独立
   条目（曝光/优先级/成本分别策展），数组顺序即显式优先级。新增五条启动期校验：
   死键告警、expose ⊆ 原生梯（拼写错报错；未知 provider 逐字接受 + 未验证告警）、
   defaultDepth 死档 → tier 降级 depth-required（绝不静默换档）、自定义 tier 缺
   shape 默认 readonly、tier id 字符集与 profiles 引用检查。

10. **三期合并为单一 change `add-dispatch-suite`（§7，2026-09-27 用户裁决）**：为配合
    ZCode goal 单闸门制一夜交付（用户只做终局验收），core/waves/crew 三期并入同一
    change；spec delta 扩为 dispatch（+后台模式/完成唤醒/kill·list·run 披露三需求）
    与 crew-harness（/crew 纪律 + crew_close 完成门）双 capability；设计新增 D10–D14
    （注册表状态机/唤醒引擎/kill 语义/crew 零持久化/run 披露）；tasks 23 项、场景 35、
    边界 48，执行流程见仓库根 `dispatch-tdd-process.md`（v3 七阶段）。
