# probe 1.1 — create-body task-deny 效力探针（harden-dispatch-resilience D2 前置）

日期：2026-11-21（沙盒运行 2026-11-20T20:46–20:52Z）· 宿主：opencode v2.3.2（win32）
方法：独立沙盒 serve（临时 OPENCODE_CONFIG_DIR + 临时工作区 + 目录发现探针插件），零 LLM 调用，全部确定性 API 往返 + 宿主二进制静态读证。

## 实验配置

- 沙盒根：`C:/Users/Soren/AppData/Local/Temp/opencode/probe11/`
  - `config/opencode.json` — OPENCODE_CONFIG_DIR 隔离；仅一个假 provider（`fakeprobe`，baseURL `http://127.0.0.1:9`，无真实 key，全程未调用）
  - `ws/.opencode/plugins/probe/index.js` — 目录发现探针插件（serve 日志确认加载：`loading plugin id=...ws\.opencode\plugins\probe entrypoint=file:///...`）
  - `ws/` 即会话 directory 锚
- serve 启动：`OPENCODE_CONFIG_DIR=<sandbox config> opencode serve --port 43133 --print-logs`（后台，日志 `serve.log`/`serve2.log`）
- 真实 service/config 未触碰（无 plugin installer 调用、无全局配置写入）；探测全部走本沙盒实例。

### 宿主 2.3.2 serve 认证形状（新发现，前人记录的补充）

- 无前缀路径（`/session`、`/agent`）**不存在**：`POST /session → 405`、`GET /agent → 200 但返回 SPA HTML`。API 全部在 `/api/*` 下。
- `/api/*` 需要 Basic 认证：`Authorization: Basic base64("opencode:" + <server password>)`。二进制读证（opencode.exe @184269168 附近）：`ServerAuthConfig` 默认 `username:"opencode"`，`dR` 接受 query `?auth_token=base64(user:pw)` 或 Basic 头；Bearer/x-opencode-password/cookie 均拒绝（实测 401）。密码在 serve 启动输出：`server password <pw>`。
- 插件加载 lazy：首次**已认证** `/api/agent` 请求才触发（`probe.log` 首条 setup 记录在 warm-up 之后）。

## 逐字 API 往返

### 路 a — HTTP API（POST /api/session?directory=WS）

创建（v2 形状，body 含 permissions）：

```
POST /api/session?directory=<WS>   Authorization: Basic opencode:<pw>
body: {"title":"probe11 v2shape","permissions":[{"action":"task","resource":"*","effect":"deny"}]}
-> 200
{"data":{"id":"ses_e0546d41dffeJsYUWL9krIpWSC","projectID":"46deb...","cost":0,"tokens":{...},
  "time":{...},"title":"probe11 v2shape",
  "permissions":[{"action":"task","resource":"*","effect":"deny"}],
  "location":{"directory":"C:\\Users\\Soren\\AppData\\Local\\Temp\\opencode\\probe11\\ws"}}}
```

创建（v1 形状 `permission:[{permission,action,pattern}]`，QUESTION_DENY_PERMISSION 的当前拼写）：

```
body: {"title":"probe11 v1shape","permission":[{"permission":"task","action":"deny","pattern":"*"}]}
-> 200  记录中无任何 permission/permissions 字段 —— 该键被静默丢弃
```

控制组：

```
body: {"title":"probe11 control"}
-> 200  记录无 permissions 字段
```

持久化复核（另建会话 ses_e0546914cffeGrycc2PQ8yGVNl）：

```
GET /api/session/ses_e0546914cffeGrycc2PQ8yGVNl?directory=WS -> 200
{"data":{...,"title":"probe11b v2shape","permissions":[{"action":"task","resource":"*","effect":"deny"}],...}}
control（ses_e0546913effe5AHChpvBnZbNAd）-> 无 permissions 字段
```

### 路 b — SDK/plugin 缝（v2 setup ctx → ctx.session.create 扁平形状）

setup ctx 键（完整）：`app, location, options, agent, aisdk, command, credential, event, experimental, generate, model, provider, integration, mcp, permission, plugin, reference, rpc, skill, storage, tool, vcs, websearch, worktree, session, shell`（**无 `client` 键** —— SDK client 只出现在 v1 event-hook `input.client`）。

`ctx.session` 域方法（完整 dump 见 probe-1.1-client-surface.json）：
`hook, list, create, get, remove, switchAgent, switchModel, prompt, generate, command, compact, synthetic, interrupt, update, move, wait, context, instructions.entry.{list,put,remove}`

子会话创建（探针插件实测，与 crew change 2.2 记录的扁平形状一致）：

```
await ctx.session.create({
  parentID: "ses_e0546913effe5AHChpvBnZbNAd",   // 真实父会话 —— parentID 被接受
  title: "probe11 plugin v2shape",
  directory: "C:/Users/Soren/AppData/Local/Temp/opencode/probe11/ws",  // 锚定被接受
  permissions: [{ action: "task", resource: "*", effect: "deny" }],
})
-> 裸记录（无 {data,error} 包裹）：
{"id":"ses_e05454e6fffe67t3Qoh6TmlFmk","parentID":"ses_e0546913effe5AHChpvBnZbNAd",...,
 "permissions":[{"action":"task","resource":"*","effect":"deny"}],
 "location":{"directory":"C:\\...\\probe11\\ws"}}

ctx.session.get({sessionID:"ses_e05454e6fffe67t3Qoh6TmlFmk"}) -> 记录仍含该 permissions（持久化）
v1 形状 permission:[...]  -> 记录无该字段（静默丢弃）；control -> 无 permissions
```

完整逐字日志：`probe-1.1-plugin-path.log`（本目录）。

## 生效链静态读证（补齐逻辑链，宿主二进制 @183552642 / @182804695 / @184211051 / Tool.snapshot @183396126）

宿主在 prompt/permission 解析处：

```js
let aH = AV(agentRecord.permissions ?? [], session.permissions ?? [])   // AV(...e){return e.flat()}
... tools: m.snapshot(aH, W)   // Tool.snapshot(permissions)
// snapshot: for (const [name, tool] of tools) if (Dc(tool.options?.permission ?? name, permissions)) continue
```

即：**会话记录 permissions 与 agent 记录 permissions 按此序扁平拼接（session 在后），再喂 Tool.snapshot/Permission 域**。Dc 为 findLast 语义（v2-single-agent-surface D4 已证）→ **session 侧 deny 段落在 agent 的 `{"action":"*","effect":"allow"}` 之后，最后匹配胜出 → task 工具从模型可见清单剔除**。

## 结论

**create body 的 permissions 落子会话记录：YES**（双通道、双形状、持久化、控制组对照俱全）。

1. 通道存在且生效：v2 形状 `{action:"task",resource:"*",effect:"deny"}` 经 HTTP `POST /api/session` 与 plugin `ctx.session.create`（扁平参数）都逐字落进 child 的**会话记录**并持久化；宿主把 `session.permissions` 拼在 agent.permissions 之后喂 Tool.snapshot（findLast → session deny 覆盖 agent allow）→ task 工具隐藏链闭合。D2 的 create-body 通道成立。
2. **形状勘误（对 D2 实现是硬事实）**：v1 拼写 `permission:[{permission,action,pattern}]`（QUESTION_DENY_PERMISSION 现用形状）在 2.3.2 的 session-create body 上被**静默丢弃**——QUESTION_DENY 先例的通道在当前宿主上已换字段名，`createChildSession`/`v2SessionClient` 适配层需改用 `permissions` 数组（适配层 plugin.ts:6548 转发键列表现在只含 `permission`，须加 `permissions`）。
3. 落点澄清：permissions 落的是**会话记录**（无会话域 agent 记录 HTTP 面：`/api/session/:id/agent → 404`；`/api/agent?location[directory]=` 是目录级、不随会话变化）——效力等价且更强（session 段最后拼接、findLast 胜出）。
4. 附带发现（喂 crew change 1.2）：v2 setup ctx 无 `client`；子会话创建缝 = `ctx.session.create`（扁平单对象参数、裸记录返回、parentID/directory 均生效）。

## 附件

- `probe-1.1-plugin-path.log` — 插件路逐字往返
- `probe-1.1-client-surface.json` — setup ctx 完整表面 dump（递归 describe，方法标注 fn()）

## 沙盒卫生

- serve 进程树已按 43133 端口监听 PID 精准 `taskkill /T /F`（两轮：PID 52672、73640；机器上其他 opencode 进程为用户实例，未触碰）
- `Get-NetTCPConnection -LocalPort 43133 -State Listen` → 无监听（port free）
- 全程未改任何源码；唯一写入 = 本证据文件 + 两个附件；沙盒留在 Temp（`opencode/probe11/`，可整体删除）
