# OmO（oh-my-opencode）子代理派发机制调研报告

- 调研日期：2026-11-21
- 调研对象：npm `oh-my-opencode@5.1.79`（最新，2026-11-19 发布）
- 仓库：https://github.com/code-yeongyu/oh-my-openagent（已从 oh-my-opencode 改名）
- 方法：`npm view` + `npm pack` 临时解包（系统临时目录，用后已删净）直读 `dist/index.js`（7.8MB 主 bundle）+ `dist/oh-my-opencode.schema.json`（294KB 配置 schema）+ GitHub releases/issues API
- 对照基线：我们的 opencode-forge（独立文件 `.opencode/forge.json` → 原生物化 `forge-<ns>-<id>` → task 工具 SDK 子会话 + 会话域池闸 + crew 两段式编排），宿主 opencode 2.3.2

---

## TL;DR

1. **OMO 已经"跳出"opencode 插件形态**：5.0.0（2026-09-26）起主力是独立 `omo` 二进制（senpi 引擎，pi-mono 的 fork）；opencode 插件版进入官方口径的 "degraded support"，**且在 opencode v2 宿主上是空壳**（插件能加载但 agents/tools/hooks 全不激活，弹提示劝你装 OmO Native）。对我们（宿主 2.3.2）来说，OMO 在这条赛道上实质退赛了。
2. 插件版仍是"独立配置文件 + 运行时物化"路线（`~/.omo/omo.jsonc` + 项目 `.omo/omo.jsonc`，最近者胜），**没有迁到 opencode config 的 agents map**，也没有比我们更先进的"落盘定义→物化"机制。
3. 派发仍是自建 SDK 子会话（`client.session.create` + parentID + 父会话 directory 锚），不走宿主原生 task 工具——和我们同代设计，但它在工程细节上沉淀了一堆我们值得抄的坑位经验（Anthropic 嵌套派发 400、poller 卡死、provider 维度并发闸、熔断器等）。
4. build/plan demote（`{mode:"subagent", hidden:true}`）**原样保留**到 5.1.79。

---

## Q1：最新版本号 + 发版节奏 + 架构级重写

**版本与节奏**（证据：`npm view oh-my-opencode version time`）：

- 最新 `5.1.79`，2026-11-19T06:12Z 发布。dist-tags：`latest=5.1.79`、`beta=5.1.0`。
- 首发 2025-12-04（0.1.0），至今约 500 个版本。5.1.x 自 2026-09-28 起 8 周约 80 版，**经常一日多版**；GitHub release 由 github-actions[bot] 自动切版（v5.1.79 release 页）。

**用户离开至今的架构史**（用户上次使用约为 2026 年 3–4 月，即 3.14–3.17 时代），此后有 **两次架构级重写**：

| 大版本 | 日期 | 性质 |
|---|---|---|
| 4.0.0 | 2026-05-07 | 插件内大重写（monorepo 化、多引擎支持雏形） |
| 5.0.0 | 2026-09-26 | **OmO Native 转向**：独立 `omo` 二进制（senpi = [badlogic/pi-mono](https://github.com/badlogic/pi-mono) 的 fork），npm 包 `omo-ai`；opencode 插件版降级维护 |

5.0.0 release notes 原文（关键证据）：

> "PLEASE REMOVE OPENCODE V1 FOR OMO, LAZYCODEX, IMMEDIATELY. … The OmO plugin for OpenCode v1 and LazyCodex keep running, but from here on they get **degraded support: new features land in OmO Native first, and some never reach the plugins because the hosts cannot carry them**."
>
> "### OpenCode v2 — We know about OpenCode v2. Our answer to it is coming, and it takes time. Until then, please run OmO Native."

链接：https://github.com/code-yeongyu/oh-my-openagent/releases/tag/v5.0.0

---

## Q2：子代理配置机制现状

**仍是独立文件，未迁 opencode config，未运行时化。**

### 文件与发现逻辑（证据：`dist/index.js` 行 96255–96286，源路径注释 `omo-config-core` / `packages/omo-opencode/src/config`）

- 用户级：`~/.omo/omo.jsonc`（回落 `omo.json`）
- 项目级：`<project>/.omo/omo.jsonc`（回落 `.json`），**最近者胜**（closest wins，README "Configuration" 节）
- 防投毒细节：`.omo` 目录若是 symlink 直接拒绝加载（`isSymlinkedProjectPath` 检查）；项目发现向上走祖先目录，带 worktree 检测（`detectWorktreePath` / `findGitMarkerAncestor`）
- 配置文件带 `_migrations: string[]` 数组做迁移记账，启动时 `startup-migration` 自动迁移（还有自动改写用户 opencode.json 里 legacy 插件条目的 `legacy-plugin-toast/auto-migrate.ts`）
- 随包发布完整 JSON Schema（`exports["./schema.json"]` → `dist/oh-my-opencode.schema.json`，294KB），zod schema 与之镜像

### 配置结构：**覆盖语义，不是定义语义**

与 forge.json「定义子代理池」不同，omo.jsonc 的 `agents` 是对内置/已有 agent 的**覆盖 map**；新增 agent 走 `agent_definitions`（路径数组，.md frontmatter / .json，claude-code-compat-core 还能直接吃 `.claude/agents/` 的 Claude Code agent 格式）。

完整示例条目（取自 schema + zod 定义，`agents."librarian"` 覆盖 + `categories` 类别路由）：

```jsonc
// .omo/omo.jsonc
{
  "$schema": "https://unpkg.com/oh-my-opencode@5.1.79/dist/oh-my-opencode.schema.json",
  "agent_order": ["sisyphus", "oracle", "librarian"],
  "default_run_agent": "sisyphus",
  "disabled_agents": ["momus-gpt-5-6"],
  "agent_definitions": ["./agents/my-worker.md"],          // 新定义走路径
  "agents": {                                              // 覆盖已有 agent
    "librarian": {
      "model": "openai/gpt-5.6-sol",
      "fallback_models": [
        { "model": "anthropic/claude-sonnet-4.8", "reasoning": "medium", "variant": "..." },
        "google/gemini-3-pro"
      ],
      "models_distribution": "sequential",                 // 或 "round_robin"
      "temperature": 0.2,
      "thinking": { "type": "enabled", "budgetTokens": 8192 },
      "reasoningEffort": "medium",
      "tools": { "edit": false, "bash": true },            // 工具白/黑名单
      "prompt_append": "…额外系统提示…",
      "max_prompt_tokens": 32000,
      "is_unstable_agent": true,                           // 触发不稳代理监督逻辑
      "disable": false,
      "warn_unavailable": true
    }
  },
  "categories": {                                          // delegate_task 的类别路由
    "deep-low": {
      "description": "深度推理车道",
      "model": "openai/gpt-5.6-sol-fast",
      "models": [                                          // 与 model 二选一/组合
        { "model": "openai/gpt-5.6-sol-fast", "reasoning": "medium" }
      ],
      "fallback_models": ["openai/gpt-5.6-sol", "anthropic/claude-opus-4.8"],
      "models_distribution": "sequential"
    }
  },
  "_migrations": ["2026-05-07-config-rename"]
}
```

### 物化方式（证据：`dist/index.js` 行 184815 附近，`assembleSisyphus…Config`）

运行时改写 opencode v1 的 `config.agent` map，合并顺序：

```
builtin agents（sisyphus / sisyphus-junior / hephaestus / atlas / oracle / librarian /
               metis / momus / prometheus / explore / multimodal-looker）
+ orderedCustomAgentSources（agent_definitions / claude-code agents，按 agent_order 排序）
+ config agents（用户 opencode config 里的，过滤受保护名后强制 subagent mode）
+ build: { …migratedBuild, mode: "subagent", hidden: true }   ← demote
+ plan: { mode:"subagent", hidden:true, …modelSettings }      ← 可选 demote
```

另有 display-name 隐藏别名机制（行 186057：`agentMap[configKey] = { …displayEntry, hidden: true }`）。

---

## Q3：派发实现

### 注册的工具（证据：`dist/tools/**` 目录结构 + bundle 内工具名字符串）

| 工具 | 职责 |
|---|---|
| `delegate_task` | 主力派发：按 **category**（类别路由模型链）或 `subagent_type`（指定 agent） |
| `call_omo_agent` | 按 `subagent_type` 直呼指定 omo agent（plan 家族直通） |
| `background_task` / `background_output` / `background_cancel` | 后台三件套（异步派发 + 取果 + 取消） |
| `look_at` | 多模态看图（自建子会话） |
| `task_create/get/list/update` | 新任务清单系统（`new_task_system_enabled` 门控，todo 同步） |
| monitor_* / grep / glob / hashline_edit / interactive_bash / skills … | 工具箱 |

### 派发通道：**自建 SDK 子会话，不用宿主原生 task 工具**

四处 `client.session.create` 调用点（`dist/index.js` 行 147870 / 148967 / 151201 / 158998，源注释 `packages/omo-opencode/src/tools/call-omo-agent|look-at|delegate-task/sync-session-creator|features/background-agent`）形状一致：

```js
const parentSession = await ctx.client.session.get({ path: { id: parentSessionID } }).catch(() => null);
const parentDirectory = parentSession?.data?.directory ?? ctx.directory;   // 锚：父会话目录
await client.session.create({
  body: {
    parentID: parentSessionID,
    title: `[${category}] ${description} (@${agentToUse} subagent)`,
    permission: QUESTION_DENIED_SESSION_PERMISSION,   // 子会话自动拒 question，防卡死省 token
    model: { id, providerID, variant }                // 每子会话模型覆盖（含 reasoning/variant）
  },
  query: { directory: parentDirectory }
});
```

同步路径靠 poller 轮询（`sync-session-poller`，含 5s 宽限 + 消息流双信号完成判定），后台路径靠 `BackgroundManager`（`background-agent/manager.ts`）。

### 踩坑 issue 证据（对我们最有价值的部分）

- **Anthropic 嵌套派发 400**：[PR #3630](https://github.com/code-yeongyu/oh-my-openagent/pull/3630)（open）——Anthropic 把"子代理再调 `call_omo_agent` 工具"判为第三方计费违规返回 HTTP 400；修法是 `providerID === "anthropic"` 的子代理不下发再派发工具（4 处源文件 7 个 guard 点）。
- **poller 卡死**：[PR #5293](https://github.com/code-yeongyu/oh-my-openagent/pull/5293)——`session.status()` 停在 `running/retry` 但 assistant 文本已出，同步 poller 干等 5+ 分钟超时；修法：状态活跃但消息流已有产出时 5s 宽限后强制完成。
- **晚到 session.error 桥接**：[PR #5294](https://github.com/code-yeongyu/oh-my-openagent/pull/5294)——异步 `session.error` 事件晚于 poller 检查到达，加 `sync-session-error-store` 存储并在 poll 消费。
- **模型继承**：[PR #2738](https://github.com/code-yeongyu/oh-my-openagent/pull/2738)——未配置模型的 subagent/category 继承父会话当前模型（优先级：用户覆盖 > 继承父 > 类别默认 > 内置 fallback 链）。
- **turn 级去重编排**：[PR #4609](https://github.com/code-yeongyu/oh-my-openagent/pull/4609)——同 turn 派发了 plan 时，主会话的 explore/librarian 后台任务先 hold（零 token pending），turn 结束后丢弃或放行，180s 安全阀。

### v2 SDK 形状变化怎么处理的

**没处理——弃疗，转自家引擎。** 证据：

- 包同时携带 `@opencode-ai/plugin@1.18.31`（v1）与 `@opencode/plugin@2.0.32`（v2）双依赖（package.json devDependencies）。
- v2 入口是空壳（`dist/index.js` 行 98447，`packages/omo-opencode/src/opencode-v2/server-entry.ts`）：

```js
var OPENCODE_V2_NOTICE_MESSAGE = [
  "OpenCode 2 support is limited: the plugin loads, but its agents, tools and hooks are not active here.",
  `For the full omo, use OmO Native: run ${NATIVE_EDITION_INSTALL_COMMAND}, then omo.`,
  …
].join("\n");
var opencodeV2Server = define({ id: "oh-my-openagent", setup: () => {
  log2("[opencode-v2] loaded without the V1 runtime", { notice: OPENCODE_V2_NOTICE_MESSAGE });
}});
```

- 唯一 v2 兼容尝试是 skills 发现的鸭子类型探测（行 186462：`client._client` → `isV2GeneratedClient()` → `OpencodeClient2.app.skills()`），即 v2 SDK 的 session/task 派发面它从未适配。
- 没找到"client.session.create 消失"类公开 issue——因为整个 v2 适配没做，5.0.0 notes 明说 "Our answer to it is coming"（截至 5.1.79 仍未落地在插件上）。

**含义：我们的宿主 opencode 2.3.2 上，装 oh-my-opencode 等于装了个提示弹窗。**

---

## Q4：工作区语义

- **子会话锚**：`parentID`（父会话 id）+ `directory = parentSession.directory ?? ctx.directory`（先查父会话记录，失败回落插件上下文目录）；后台路径额外允许 `input.cwd` 覆盖子目录（行 158998：`const childDirectory = input.cwd ?? parentDirectory`）。
- **配置锚**：项目 `.omo/omo.jsonc` 祖先目录上溯，带 worktree 检测与 git marker 停止条件（`detectWorktreePath4(startDirectory) ?? findGitMarkerAncestor(startDirectory)`，`.opencode/commands` 发现同款逻辑，行 147315）。
- **项目内状态**：大量 `.omo/` 路径（bundle 内 170 处）——mailbox、plan 文件（`.omo/*.md`，prometheus 只准写这里）、team 状态等都在项目域内。
- 内置 agent 的 skills 解析带 per-directory 概念（`agents/agent-skill-resolution`、`resolve-file-uri`），未见"每个 workspace 一套不同子代理池"的显式配置面——agent 集合是全局的，workspace 只影响配置文件选择与会话目录锚。

---

## Q5：多代理编排

### 插件版：Team Mode（`packages/team-core` + `team_mode` config）——P2P mailbox 模型

与我们 crew 的"中央两段式"是不同范式：成员之间通过**收件箱文件互发消息**，轮询消费。

- 成员定义（`member-parser.ts`，行 11833）：`{kind:'category', category, prompt}` 或 `{kind:'subagent_type', subagent_type}`，二选一判别式，缺/冲突给出结构化校验错误。
- **成员资格闸**（行 12056–12076）：只读 agent 硬拒入队——oracle/librarian/explore/metis/momus/multimodal-looker（写不了 mailbox inbox 文件），hephaestus 需显式 `teammate: "allow"` 权限，prometheus 是 plan-only 也拒。
- 闸门与限额（schema `team_mode`）：`max_parallel_members` 1–8（默认 4）、`max_members` 8、`max_messages_per_run` 10000、`max_wall_clock_minutes` 120、`max_member_turns` 500、`message_payload_max_bytes` 32KB、`recipient_unread_max_bytes` 256KB、`mailbox_poll_interval_ms` 3000、`tmux_visualization`（tmux 可视化面板）、`base_dir`。
- hook 注入器：`teamMailboxInjector` / `teamModeStatusInjector`（向成员提示 mailbox 状态）。

### 后台任务并发闸（`background_task` config）——比我们会话域池闸更细的维度

```jsonc
{
  "defaultConcurrency": 4,
  "providerConcurrency": { "anthropic": 2, "openai": 3 },   // per-provider 配额
  "modelConcurrency":    { "openai/gpt-5.6-sol": 2 },        // per-model 配额
  "maxDepth": 3,                                             // 派发深度
  "maxLiveDescendantsPerRoot": 8,                            // 每根会话活后代数
  "staleTimeoutMs": …, "sessionGoneTimeoutMs": …, "taskTtlMs": …,
  "maxToolCalls": …,
  "circuitBreaker": { "enabled": true, "consecutiveThreshold": 5 }  // 连续失败熔断
}
```

另有 `sync-spawn-reservation`（同步派发的 spawn 预约）与 `cancel-unstable-agent-task`（不稳代理自动取消）。

### Native 版（senpi 引擎）才有 DAG/波次编排

5.0.0 notes："**mass ulw**: a DAG of nodes routed to different models, fed through workpools with retries and recovery"，"Subagents run as sessions inside one shared daemon instead of one engine process each"。但这不在 opencode 插件形态里——是它自家引擎的能力。**插件版没有我们的 register→arm waves→dispatch→close 式中央波次编排等价物。**

---

## Q6：原生 agent 抑制（demote）

**仍用 `{mode:"subagent", hidden:true}` demote，与 opencode issue 3443 时代同款。** 证据（`dist/index.js` 行 184600 / 184815）：

```js
function buildPlanDemoteConfig(prometheusConfig, planOverride) {
  // …收集 modelSettings…
  return { mode: "subagent", hidden: true, ...modelSettings };
}
// 物化处：
params.config.agent = {
  …,
  build: { ...migratedBuild, mode: "subagent", hidden: true },   // build 恒 demote
  ...planDemoteConfig ? { plan: planDemoteConfig } : {}           // plan 可选（受 prometheus/plan 覆盖控制）
};
```

配套：delegate 侧有 `isDemotedPlanAgent()` 识别被 demote 的 plan（`subagent-discovery.d.ts` 行 14），`shouldDemotePlan` 开关会把用户 config 里的 plan 条目过滤后以 demote 形态重注（行 184815 上方 `key === "plan" && shouldDemotePlan → 排除`）。

---

## Q7：对比结论

### OMO 有、我们没有的亮点（值得抄）

1. **类别路由层（categories）**：`delegate_task` 的"任务类别 → 模型链（含 fallback_models、round_robin/sequential 分布、每模型 reasoning/variant/temperature 细调）"，与"agent 身份"正交。我们的 forge.json 是"一个 agent 一个 model"；加一个可选的类别/车道层能让"同 prompt 不同档模型"表达力上一个台阶。
2. **provider/model 维度并发闸 + 熔断器**：`providerConcurrency`/`modelConcurrency` map + `maxLiveDescendantsPerRoot` + circuitBreaker（连续 N 次失败熔断）。我们的池闸是会话域单维度；按 provider 限流能直接防"一家 API key 被自己打爆"。
3. **Anthropic 嵌套派发防御**（PR #3630）：按 `providerID` 决定是否给子代理下发再派发工具。我们迟早会踩同款 400——建议在 forge task 工具的工具下发面加同款 guard。
4. **poller 反卡死双信号**（PR #5293/#5294）：完成判定 = session.status() ∨ 消息流已出 assistant 文本（5s 宽限）+ 晚到 session.error 桥接。我们的 dispatch 轮询如果有"只信 status"的实现，同款修复值得预防性抄。
5. **turn 级去重编排**（PR #4609，hold-then-decide）：派发了 plan 就 hold 主会话重复的研究型派发，turn 末端统一裁决，180s 安全阀。对 crew 波次间隙里的重复派发是种廉价去重。
6. **配置工程化**：随包 JSON Schema（`exports["./schema.json"]`）+ `$schema` 引导 + `_migrations` 迁移记账 + 启动自动迁移（连用户 opencode.json 里的 legacy 插件条目都自动改写）。forge.json 目前没有 schema 与迁移故事。
7. **子会话 permission 注入**：`QUESTION_DENIED_SESSION_PERMISSION` 让子会话自动拒 question——防子代理卡在提问上浪费整次派发。
8. **成员资格静态闸**（team-mode）：编排前按"能否写 mailbox"硬拒只读 agent，错误信息直接给出替代方案（"改用 delegate-task"）。crew register 阶段可以加同款资格校验。
9. **模型路由自省**：`omo.modelRouting.resolve`（v5.1.79 release notes）——外部可查询"每个类别/agent 实际会跑哪个模型、来自配置还是默认"。可解释性对调试 forge 池很有用。
10. **防 symlink 投毒**：`.omo` 目录 symlink 直接拒载。`.opencode/forge.json` 若支持目录形式定义，同款检查值得加。

### 我们已领先项（OMO 插件版没有的）

1. **opencode 2.x 全功能运行**：OMO 在 v2 宿主是空壳劝退（它选择 fork 宿主自建引擎）；我们在 2.3.2 上原生跑。这是最实质的差距——它用脚投票承认了插件形态的天花板，而我们的目标恰恰是把这条插件路线做深。
2. **中央两段式 crew 编排**（register→arm waves→dispatch→close + 生命周期门）：插件版 OMO 只有 P2P mailbox 的 team-mode，没有波次/DAG 编排；DAG（mass ulw）只在它自家 senpi 引擎里。
3. **定义式独立文件 → 原生物化**：forge.json 的"定义池（prompt/model/shape）→ 物化 `forge-<ns>-<id>`"比 omo.jsonc 的"覆盖 map + 路径引用"更直接、更好做静态校验；OMO 没有更先进的落盘机制，它只是把语义做成了"覆盖+类别"两层。
4. **shape 概念**（per-agent 工具面/形态）：OMO 最接近的是 `tools: {name: bool}` 开关和 team-mode 资格闸，表达力弱于显式 shape。

### 建议动作（只建议，不动手）

1. 【高】给 forge task 工具加 **provider 维度嵌套派发 guard**（对齐 PR #3630 的 anthropic 拦截），并在派发轮询里实现**双信号完成判定 + 晚到错误桥接**（#5293/#5294）。
2. 【高】池闸扩展：在会话域闸之上加 `providerConcurrency`/`modelConcurrency` map 与连续失败熔断。
3. 【中】forge.json 增加 `$schema` 发布 + `_migrations` 记账；若 forge.json 未来支持目录化定义，加 symlink 拒载检查。
4. 【中】评估"类别/车道"可选层（模型链 + fallback + 分布策略），作为 agent 定义之上的路由维度。
5. 【低】crew register 阶段加成员资格静态闸（按 shape 判断能否承担该 wave 的工作类型）。
6. 【情报】OMO 的转向说明 opencode 2.x 插件生态出现真空窗口——坚持 v2 插件形态本身就是竞争位。
