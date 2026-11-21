# 调研报告：opencode 插件自定义工具在子代理会话被权限层拒绝 — 源码机制 / 官方口径 / 社区生态

- 调研日期：2026-11-21
- 宿主版本：opencode v2.3.2（当前最新 release，2026-11-18 发布；其后无更新版本）
- 上游仓库：`sst/opencode` → 现已重定向到 **`anomalyco/opencode`**（GitHub 仓库迁移，`sst/opencode` 的 API/raw 链接全部 301 到 anomalyco）
- 调研方式：GitHub API + raw 源码直读（v2.3.2 tag 与 dev 分支）+ 官方文档（opencode.ai）+ issues 搜索 + 生态插件抽查。未改动任何源码。

---

## 0. 结论速览（TL;DR）

1. **源码里找到了判决性证据。** v2.3.2 的 `packages/core/src/permission.ts` 中，`assert` 评估权限前先在 `configured()` 里用 **`agents.resolve(agentID ?? session.agent)`** 解析 agent；**解析不到时兜底规则是逐字 deny-all**（`missingAgentPermissions = [{ action: "*", resource: "*", effect: "deny" }]`），且该 deny **短路在 saved rules 合并、`permission.evaluate` 插件钩子、ask 弹窗全部之前**——所以日志零痕迹、无 ask、错误消息就是裸的 `Permission denied: <action>`。你们的猜测"agent 名解析失败 → 兜底全拒（deny-all 短路，规则不进评估）"**与源码逐字吻合**。
2. **解析发生在哪个锚？** `Agent` 服务是 **location 作用域**（每个 Location 一个实例、一个内存注册表），而 `SessionStore` 是 **global 作用域**（全库共享）。插件工具里 `ctx.permission.assert` 闭包捕获的是**插件宿主（PluginHost）所在 location** 的 Permission/Agent 服务——**不是发起调用的会话所在 location**。只要"插件宿主的 location"与"md agent 注册的 location"不是同一个（典型：插件全局安装 → 宿主在全局锚；工作区 `.opencode/agent/*.md` 只注册进项目锚），子代理 agent 名就在错误的注册表里查不到 → deny-all。primary 会话的 `forge` agent 是**插件自己**用 `ctx.agent.transform` 注册进宿主锚的注册表的，所以永远解析得到——这就是不对称的根源。
3. **你们两个实验必然无效的原因也找到了**（两个独立的坑）：
   - agent md 里 `permissions: [...]`：拼写和形状**是对的**（官方 schema 就是 `permissions: Permission.Ruleset`），但这些规则挂在**项目锚注册表里的 agent** 上；assert 在宿主锚解析不到这个 agent，规则根本不进评估。
   - 用户 config `permission.forge_shell: "allow"`：**字段名错了两处**——V2 config 的字段是 `permissions`（规则数组），单数 `permission` 是 V1 对象映射，官方文档明确警告 "In V2, use `permissions` … instead of `permission`"。而且即使写对，文档级 `permissions` 是在**各 location 自己的注册表**里 push 给该锚已存在的 agent；宿主锚里不存在 md agent，规则同样到不了它。
4. **无人修过这个问题。** 截至 2026-11-21：issues/PR 里**没有**任何"插件工具 assert 在子代理被拒因 agent 跨锚解析失败"的报告（搜了 "Permission denied" + plugin tool / subagent / "permission.assert" / agent not found 等组合）；v2.3.2 之后的 release 不存在，dev CHANGELOG 也没有相关修复。最接近的亲属 issue：#57603（子代理 ask 权限无弹窗直接拒，open）、#57138（.opencode/agents md 会话中不生效，open）、#48106、#54044（后两个从侧面证实了 session/agent 规则合并顺序）。
5. **可用的官方支持杠杆（解法）**：
   - **session 级 permissions 可以压过 deny-all**：`configured()` 的合并顺序是 `merge(agent?.permissions ?? deny-all, session.permissions ?? [])`，评估用 `findLast`（最后匹配者胜）——session 规则排在最后。官方插件文档明确：`ctx.session.update({ sessionID, permissions: [...] })` **"They are evaluated after the agent's rules, and the last matching rule wins. Child sessions inherit the rules in effect when they are created."** → 插件可以在工具执行时给（子）会话补 session 级 allow，这是**当下就能落地的插件侧修复**。
   - 或：把插件配置到与 md agent 同一 config 层（项目 `.opencode/`），或把子代理 agent md 同步放全局 `~/.config/opencode/agents/`，使宿主锚能解析到。
   - 或：工具注册时声明 `options.permission`（runner 在**会话自身锚**做整工具过滤，见 §2.6），替代在 execute 里手动 assert。
   - 上游修复方向（值得提 issue）：`configured()` 应该按 session 的 location 解析 agent（有 `LocationServiceMap` 可用），或者 missing-agent 兜底不应是静默 deny-all（至少给 reason）。

---

## 1. 源码证据（v2.3.2 tag，全部逐字摘录）

### 1.1 判决性代码：`packages/core/src/permission.ts` @ v2.3.2

> https://raw.githubusercontent.com/anomalyco/opencode/v2.3.2/packages/core/src/permission.ts
> （dev 分支同文件除大小写匹配（darwin path actions）外逐字相同）

deny-all 兜底常量与 agent 解析：

```ts
const missingAgentPermissions: Permission.Ruleset = [{ action: "*", resource: "*", effect: "deny" }]
```

```ts
    const configured = Effect.fnUntraced(function* (sessionID: SessionSchema.ID, agentID?: Agent.ID) {
      const session = yield* sessions.get(sessionID)
      if (!session) return yield* new SessionErrors.NotFoundError({ sessionID })
      const agent = yield* agents.resolve(agentID ?? session.agent)
      return merge(agent?.permissions ?? missingAgentPermissions, session.permissions ?? [])
    })
```

评估入口——**deny 在钩子/ask/saved rules 之前短路**：

```ts
    const evaluateInput = Effect.fnUntraced(function* (input: AssertInput) {
      const rules = yield* configured(input.sessionID, input.agent)
      if (denied(input, rules)) return { effect: "deny" as const, rules }
      const all = [...rules, ...(yield* savedRules())]
      const effects = input.resources.map((resource) => evaluate(input.action, resource, all).effect)
      const effect: Permission.Effect = effects.includes("ask") ? "ask" : "allow"
      const event = yield* hooks.trigger("permission", "evaluate", { ... })
      ...
```

错误消息模板（就是你们看到的逐字输出）：

```ts
export class BlockedError extends Schema.TaggedError<BlockedError>()("Permission.BlockedError", {
  rules: Permission.Ruleset,
  permission: Schema.String,
  resources: Schema.Array(Schema.String),
  reason: Schema.String.pipe(Schema.optional),
}) {
  override get message() {
    return this.reason ?? `Permission denied: ${this.permission}`
  }
}
```

```ts
    const denied = function (input, rules) // 逐字：
    function denied(input: Pick<Request, "action" | "resources">, rules: Permission.Ruleset) {
      return input.resources.some((resource) => evaluate(input.action, resource, rules).effect === "deny")
    }
```

规则评估是 `findLast`（**最后匹配者胜**——session 规则排在 merge 结果末尾，能覆盖前面的 deny-all）：

```ts
export function evaluate(action: string, resource: string, ...rulesets: Permission.Ruleset[]): Permission.Rule {
  return (
    rulesets
      .flat()
      .findLast((rule) => Wildcard.match(action, rule.action) && Wildcard.match(resource, rule.resource)) ?? {
      action,
      resource: "*",
      effect: "ask",
    }
  )
}
```

**消息判别**：裸 `Permission denied: forge_shell`（无 reason）只能来自 deny 短路。如果是"ask 但无人应答"路径，消息会是 `Permission ${input.action} needs approval, and nobody is present to give it`（同文件 `Unattended` 段）。你们的现象 100% 是 deny-all 短路。

### 1.2 Agent 解析是 location 注册表查表：`packages/core/src/agent.ts` @ v2.3.2

> https://raw.githubusercontent.com/anomalyco/opencode/v2.3.2/packages/core/src/agent.ts

```ts
      resolve: Effect.fnUntraced(function* (id) {
        if (id !== undefined) return state.get().agents.get(ID.make(id))
        return selectedDefault(state.get())
      }),
```

`resolve` 只查**本服务实例**的内存 Map。而 Agent 服务是 location 节点：

```ts
export const node = makeLocationNode({ service: Service, layer, deps: [Bus.node] })
```

### 1.3 Location 体系：`location` tag 按 Location 实例化，`global` tag 全局单例

> `packages/util/src/effect/app-node.ts` @ v2.3.2

```ts
export const tags = LayerNode.tags({
  location: ["global"],
  global: [],
})
```

**不对称的关键**：`packages/core/src/session/store.ts` @ v2.3.2 的 SessionStore 是 **global** 节点：

```ts
import { makeGlobalNode } from "@opencode/util/effect/app-node"
export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node] })
```

→ `configured()` 里 `sessions.get(sessionID)` 在**任何锚都能查到会话**（所以错误不是 "Session not found"），但 `agents.resolve` 只查当前锚的注册表（所以 agent 解析得了才怪）。**会话可见性是全局的，agent 可见性是分锚的**——这正是症状只爆在"agent 解析"这一环的原因。

### 1.4 插件工具的 assert 落在**插件宿主的 location**：`packages/core/src/plugin/host.ts` + `plugin.ts` @ v2.3.2

> https://raw.githubusercontent.com/anomalyco/opencode/v2.3.2/packages/core/src/plugin/host.ts

`ctx.permission.assert` 的实现（注意它直接调用宿主上下文里的 `permission` 服务实例）：

```ts
    permission: {
      ...
      // Plain rejections stay defects, as for built-in tools, so they end the step.
      assert: (input) =>
        permission.assert(input).pipe(
          Effect.catchTags({
            "Permission.BlockedError": (error) => Effect.fail(new Tool.Error({ message: error.message, error })),
            "Permission.CorrectedError": (error) => Effect.fail(new Tool.Error({ message: error.feedback, error })),
            "Permission.Session.NotFoundError": ...
          }),
        ),
    },
```

而插件宿主本身就是 location 节点（`packages/core/src/plugin.ts`）：

```ts
export const node: LayerNode.Provider<Service, PersistentPty.UnavailableError, typeof Node.tags.values.location> =
  Node.makeLocationNode({
    service: Service,
    layer,
    deps: [PluginHost.requirements],
  })
```

`PluginHost.requirements`（host.ts 尾部）包含 `Permission.node`、`Agent.node`、`Session.node` 等——全部按宿主所在 location 连线。**工具 execute 闭包在激活时捕获这套服务；无论哪个会话调用这个工具，assert 永远在宿主锚评估。**

### 1.5 md agent 注册进**该 config 条目所属 location** 的注册表：`packages/core/src/config/plugin/agent.ts` @ v2.3.2

> https://raw.githubusercontent.com/anomalyco/opencode/v2.3.2/packages/core/src/config/plugin/agent.ts

- 扫描 `{agent,agents}/**/*.md`（`agent` 单数和 `agents` 复数目录都吃）；
- 通过 `ctx.agent.transform` 写进**本插件宿主锚**的 Agent 注册表（config 插件逐 location 激活：全局 config → 全局锚；项目 `.opencode/` → 项目锚）；
- **文档级（config 文件顶层）`permissions` 只 push 给该锚注册表里已存在的 agent**：

```ts
    yield* ctx.agent.transform((editor) => {
      const permissions = expandPermissions(
        loaded.documents.flatMap((document) => document.info.permissions ?? []),
        global.home,
      )
      ...
      for (const current of editor.list()) {
        editor.update(current.id, (agent) => agent.permissions.push(...permissions))
      }
```

→ 在宿主锚**不存在**的 agent（工作区 md 子代理）永远收不到这份规则。

md frontmatter 的原生字段名确认为 `permissions`（数组形状），`packages/schema/src/config/agent.ts` @ v2.3.2：

```ts
  disabled: Schema.Boolean.pipe(optional),
  permissions: Permission.Ruleset.pipe(optional),
```

以及 loader 的 V2 原生键判定：

```ts
// Fields only V2 understands. A file that uses any of them is read as V2, whatever else it contains.
const nativeKeys = ["permissions", "request", "system", "disabled"]
```

**结论：你们 md 里 `permissions: [{action, resource, effect: allow}]` 的写法完全正确，没生效不是拼写问题，是锚不对。**

### 1.6 会话级 permissions 的救援通道 + runner 侧门禁

`host.ts` 里 `ctx.session.update` 支持改会话规则：

```ts
        if (input.permissions !== undefined)
          yield* sessions.setPermissions({ sessionID: input.sessionID, permissions: input.permissions })
```

工具注册时可声明 `options.permission`，由 runner 在**会话锚**做整工具过滤（`packages/core/src/tool.ts` @ v2.3.2）：

```ts
          for (const [name, tool] of data.tools) {
            if (whollyDisabled(tool.options?.permission ?? name, rules)) continue
            active.set(name, tool)
          }
```

```ts
const whollyDisabled = (action: string, rules: Permission.Ruleset) => {
  const rule = rules.findLast((rule) => Wildcard.match(action, rule.action))
  return rule?.resource === "*" && rule.effect === "deny"
}
```

### 1.7 native 子代理会话的 agent 字段：`packages/core/src/tool/plugin/subagent.ts` @ v2.3.2

```ts
              const child =
                existing ??
                (yield* sessions
                  .create({
                    parentID: context.sessionID,
                    title: input.description,
                    agent: agent.id,
                    model,
                  })
```

子会话 `session.agent` = md agent 的 id；插件工具在子会话里拿到的 `context.agent` 同样是这个 id，传给 assert 后在**宿主锚**解析 → miss → deny-all。链路闭合。

### 1.8 官方测试佐证 assert 行为：`packages/core/test/plugin/permission-assert.test.ts` @ v2.3.2

测试里 `context.permission.assert({ sessionID, action, resources })` 的 BlockedError 被 host 包装成 `Tool.Error`，消息逐字断言：

```ts
    expect(blocked).toMatchObject({ message: "Permission denied: blocked" })
```

---

## 2. 官方文档口径（opencode.ai，V2 现行版）

### 2.1 Permissions 页 — https://opencode.ai/docs/permissions

字段名与 V1 警告（**直接解释了 config 实验为何无效**）：

> "V1 uses different field and action names. In V2, use `permissions`, `shell`, and `subagent` instead of `permission`, `bash`, and `task`."

规则合并顺序：

> "OpenCode combines rules in order and uses the last match. Lower-priority configuration is loaded first, global rules are appended next, and agent rules are appended last."

子代理不继承父权限：

> "A custom subagent uses its own permissions, not a subset of its parent's permissions."

V2 action 是开放字符串，插件可以自定义 action：

> "V2 action names are strings, so plugins may define more actions."

### 2.2 Agents 页 — https://opencode.ai/docs/agents

md 位置（单复数目录均可，全局/项目两层）：

```text
~/.config/opencode/agents/<name>.md
.opencode/agents/<name>.md
```

子代理权限模型：

> "The parent agent's `subagent` permissions control which agents it may launch; **the child uses its own configured permissions.**"

legacy 字段警告：

> "Do not use legacy top-level fields such as `temperature`, `top_p`, `prompt`, **`permission`**, `tools`, `disable`, or `maxSteps` in new V2 agent configuration."

### 2.3 插件开发文档（server.mdx，仓库内原文）— `services/site/src/docs/content/build/plugins/server.mdx` @ v2.3.2

`ctx.permission.assert` 的官方语义：

> "Ask for permission before performing an action. `assert` evaluates the session's permission rules, including saved approvals, and prompts the user when a rule resolves to `ask`."
>
> "`agent` selects whose rules apply and defaults to the session's agent. `source` attaches the prompt to a tool call."

官方示例（与你们的调用形状一致）：

```ts
execute: async (input, context) => {
  await ctx.permission.assert({
    sessionID: context.sessionID,
    agent: context.agent,
    source: { type: "tool", messageID: context.messageID, id: context.id },
    action: "deploy",
    resources: [input.environment],
    save: [input.environment],
  })
  return { content: await deploy(input.environment) }
}
```

**最重要的官方救援通道**（session 级规则，最后评估、子会话继承）：

> "Replace the session-scoped permission rules. **They are evaluated after the agent's rules, and the last matching rule wins. Child sessions inherit the rules in effect when they are created.**"
>
> ```ts
> await ctx.session.update({
>   sessionID,
>   permissions: [{ action: "edit", resource: "/path/to/original/checkout/**", effect: "deny" }],
> })
> ```

注意：文档**没有**说明 `ctx.permission.assert` 的 agent 解析发生在插件宿主的 location 锚——这是本次调研从源码补上的关键盲区。

---

## 3. Issues / PRs / Releases 调研

搜索面（GitHub search API，仓库 anomalyco/opencode）：`"Permission denied" plugin tool`（161 命中）、`subagent "Permission denied"`（101 命中）、`"custom tool" subagent denied`（21 命中），逐条过滤相关度。

### 3.1 没有同款报告

**没有任何 issue/PR 报告"插件自定义工具的 `ctx.permission.assert` 在子代理会话因 agent 跨锚解析失败被 deny-all 拒绝"。** 这是一个未被社区发现/上报的坑。

### 3.2 最近的亲属 issue（佐证机制，均非同一问题）

| Issue | 标题（摘意） | 状态 | 与本案的关系 |
|---|---|---|---|
| [#57603](https://github.com/anomalyco/opencode/issues/57603) | Delegated subagent write silently denied on "ask" permission (works on v1, broken on v2) | **open**（reopened） | 同族现象：子代理会话里的权限评估没有弹 ask、直接失败。v2.0.32 报告，截至 2026-11-03 仍 open |
| [#57138](https://github.com/anomalyco/opencode/issues/57138) | agent docs created in .opencode/agents/ mid-session are not discovered until session restart | open | agent 注册表的发现/时机问题（`Unknown agent: tester`） |
| [#48106](https://github.com/anomalyco/opencode/issues/48106) | Subagent description ignores session permissions | open | 报告者直接引用 `Permission.configured` 的合并语义，佐证 agent/session 规则两段合并 |
| [#54044](https://github.com/anomalyco/opencode/issues/54044) | browser tools exposed despite agent-level deny when agent has execute | open（jlongster 认领） | 逐字佐证合并顺序："**session permissions are evaluated after agent permissions (last-match-wins)**"；还展示了工具注册 `options: { permission: "browser", codemode: true }` 的 runner 侧门禁模式 |
| [#63075](https://github.com/anomalyco/opencode/issues/63075) | permissions: let deny rules carry a message to the model | open | 逐字佐证 deny 路径无钩子无理由："the model gets the fixed string `Permission denied: <action>` and no reason … `permission.evaluate` fires before the request exists, and the deny path produces no request for anything to hook" |
| [#62408](https://github.com/anomalyco/opencode/pull/62408) | fix(core): include matching deny patterns in permission errors | open PR | 未合并的改进：deny 消息带上命中的规则 pattern——合并后能让这类问题更容易诊断 |
| [#37164](https://github.com/anomalyco/opencode/issues/37164) | feat(plugin): let tool.execute.before request native permission approval | closed | 插件侧想要原生权限 UI 的早期诉求；现行 `ctx.permission.assert` 域即其后续 |

### 3.3 Releases：2.3.2 之后无修复版

- v2.3.2 = 最新 release（2026-11-18）。release notes 只有 GPT-6.2 prompt caching 与 webfetch 输出修复，无权限/子代理/插件工具修复。
- v2.3.1（2026-11-18）相关条目只有：子代理权限弹窗的**UI 展示**修复（"Permission prompts from a subagent … now appear while you view the subagent's session"，#64343）、拒绝批量撤销范围修复。
- dev 分支 CHANGELOG 最新条目为 v2.3.0，无 `missingAgentPermissions`/agent 解析相关修复；dev 的 `permission.ts` 与 v2.3.2 在该机制上逐字一致。

**结论：截至 2026-11-21 上游无人修过，也没有 pending 修复。**

---

## 4. 生态插件扫描（带自定义工具的插件怎么做门禁）

### 4.1 prevalentWare/opencode-goal-plugin（532★，V2 时代插件）— **不做任何 opencode 权限门禁**

`src/server.ts`（187 KB）注册 goal 工具：

```ts
await registerSafely("the goal tools", () => context.tool.transform((draft) => {
```

全文件 `permission` 关键词 **0 命中**。工具 execute 里不调 `ctx.permission.assert`。
> https://github.com/prevalentWare/opencode-goal-plugin/blob/main/src/server.ts

### 4.2 khalilgharbaoui/opencode-claude-code-plugin（134★）— 自管 CLI 权限旗标，不走 opencode 权限层

`src/index.ts` 管理的是 Claude Code 自己的 `permissionMode`/`permissionPreset`/`--dangerously-skip-permissions` 代理旗标，**不调 `ctx.permission.assert`**。
> https://github.com/khalilgharbaoui/opencode-claude-code-plugin/blob/master/src/index.ts

### 4.3 官方 in-repo 插件 `packages/plugins/figma` — 无自定义工具

只注册 MCP server + skills，没有工具，更没有 assert。
> https://github.com/anomalyco/opencode/blob/v2.3.2/packages/plugins/figma/index.ts

### 4.4 真正用 assert 的是内置工具（`packages/core/src/tool/plugin/*.ts`）

内置工具（webfetch/subagent/…）用 `permission.assert(Permission.invocation(context))` 或注册时 `options.permission`。它们逐 location 激活（每个锚各有一份），所以 assert 锚与会话锚天然一致——**内置工具踩不到这个坑，只有"单一锚激活的第三方插件工具 + 跨锚 agent"会踩**。这也解释了为什么社区至今没人报：绝大多数生态插件要么没工具，要么像 4.1/4.2 那样压根不做门禁（顺带绕开了这个坑）。

---

## 5. 解法清单（按落地成本排序）

### A. 插件侧立即可用（不改上游）

1. **session 级 allow 兜底（推荐）**：利用 session 规则最后评估 + findLast 覆盖 deny-all。工具 execute 里（或捕获 BlockedError 后）：

   ```ts
   await ctx.session.update({
     sessionID,
     permissions: [{ action: "forge_shell", resource: "*", effect: "allow" }],
   })
   await ctx.permission.assert({ sessionID, agent, action: "forge_shell", resources: ["*"], ... })
   ```

   注意 `session.update` 的 `permissions` 是**整体替换**会话规则（非追加），若会话已有别的 session 规则需先读回合并。子会话在创建时继承当时的 session 规则（官方文档原话，§2.3），所以也可以在父会话侧预置。
2. **门禁改走 runner**：工具注册时声明 `options: { permission: "forge_shell", codemode: false }`，由 runner 在**会话锚**用会话规则做整工具过滤（§1.6）；execute 内不再手动 assert。缺点：只有"整工具 deny"粒度，没有 ask/save 流程。
3. **降级自管门禁**：捕获 `Permission.BlockedError` 后按自己的策略放行/拒绝（生态主流事实标准就是"不做 opencode 门禁"，见 §4）。至少把错误消息换成的可诊断文案。

### B. 部署侧对齐锚

4. 把插件配置进与 md agent 同一 config 层（项目 `.opencode/opencode.json(c)` 的 `plugins` 数组），使 PluginHost 锚 = 项目锚 = md agent 注册锚。
5. 或把子代理 agent md 复制到全局 `~/.config/opencode/agents/`，让宿主锚也能解析到（代价：agent 变全局可见）。

### C. 上游修复（值得提 issue，附上本报告 §1 代码）

6. `configured()` 应按 **session 的 location** 解析 agent（`LocationServiceMap` 已有按 Location.Ref 取服务实例的能力，`host.ts` 的 `atLocation()` 就是现成用法），而不是用 Permission 服务自身所在锚。
7. 至少：missing-agent 兜底不应是静默 deny-all——给 `BlockedError.reason` 写明 `agent "<id>" not found at this location`，配合 #62408 的 pattern 披露方向。

### 诊断验证（区分"锚不匹配"与其它假设）

在插件 setup 里探针（`ctx.agent.get` 与 assert 用同一宿主锚）：

```ts
const hit = await ctx.agent.get({ agentID: "<md-agent-id>" }).catch(() => undefined)
// 子代理会话存活、但这里 miss → 锚不匹配实锤
```

---

## 6. 调研局限声明

- 未能确认你们插件的安装层（全局 vs 项目 config）——§1.4 的机制对两种几何都成立："宿主锚 ≠ md agent 注册锚"即触发；§5.B.4 是对齐手段。
- GitHub Discussions 未纳入（搜索 API 不覆盖 discussions，未认证 GraphQL）；但 issues+PR 覆盖面已足够给出"无人解过"的结论。
- grep.app（跨仓库代码搜索）被限流，生态扫描基于 GitHub 仓库/议题里出现的高星插件抽查（3 个），样本小但方向一致。

## 附：本报告引用的源码/文档坐标

| 内容 | 坐标（v2.3.2 除非注明） |
|---|---|
| deny-all 兜底 + configured + evaluateInput | `packages/core/src/permission.ts` |
| Agent.resolve（location 注册表） | `packages/core/src/agent.ts` |
| SessionStore（global 节点） | `packages/core/src/session/store.ts` |
| location/global tag 体系 | `packages/util/src/effect/app-node.ts`、`packages/util/src/effect/layer-node.ts` |
| ctx.permission.assert → 宿主锚 Permission 服务 | `packages/core/src/plugin/host.ts`、`packages/core/src/plugin.ts` |
| md agent 注册 + 文档级 permissions 注入 | `packages/core/src/config/plugin/agent.ts` |
| md frontmatter schema（`permissions`） | `packages/schema/src/config/agent.ts`、`packages/schema/src/agent.ts` |
| 子会话创建（agent=md id） | `packages/core/src/tool/plugin/subagent.ts` |
| runner 整工具过滤（options.permission） | `packages/core/src/tool.ts` |
| 插件权限域测试 | `packages/core/test/plugin/permission-assert.test.ts` |
| 官方文档 | https://opencode.ai/docs/permissions 、/docs/agents 、/docs/plugins 、仓库 `services/site/src/docs/content/build/plugins/server.mdx` |
| Releases | https://github.com/anomalyco/opencode/releases （v2.3.2 最新，2026-11-18） |
