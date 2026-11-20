# v2 宿主三探针（沙盒 2.3.2）— 执行报告

**状态：已完成（recovered）。** 探针材料全部备妥，首次执行因 forge_shell 故障
中断；2026-11-20 由 probe-execution subagent 重跑成功，P1/P2/P3 判决见文末
「## Execution results」。以下为首次执行的历史记录。

## 工具拒绝（逐字）

forge_shell 自 2026-11-20 05:20（本地）起对所有命令（含最简单的
`Write-Host ping` / `echo hi`）统一返回：

> `Tool.Error`

连续 6+ 次重试（含换命令形状、写 .ps1 文件执行）全部同错误。forge_jobs
注册表仍可用，但无 shell 即无法启动/查询 serve。

## 已完成的准备工作（文件均在沙盒内，未触碰真实配置/服务）

- 沙盒根：`.tmp/crew-probe-sandbox/`
  - `config/opencode.json` — 手写用户 config（见下）
  - `run/.opencode/plugins/probe/{package.json,index.mjs}` — 探针插件
    （零依赖单文件 ESM，`{id:"probe-v2-surface", setup}`）
  - `start-serve.ps1` — serve 启动脚本（含 OPENCODE_CONFIG_DIR 隔离）
- 探针逻辑（`index.mjs`）：
  - `ctx.agent.transform(draft)`：记录 `draft.get("build"/"vision-agent"/"p3")`
    是否 undefined → 追加 `probe-log.jsonl`；typeof 守卫后调
    `draft.default("probe-forge")`
  - setup 存 ctx，+5s/+30s 采样 `ctx.agent.get/list`（含 vision-agent 的
    model 字段）→ `probe-samples.jsonl`
  - `ctx.tool.transform` 注册探针工具 `probe_surface_tool`（仅注册）
- 用户 config：`default_agent:"build"`、`agents.vision-agent.model:"x/y"`、
  `agents.build.hidden:false`、`agents.p3.permissions:[{action:"shell",resource:"*",effect:"deny"}]`

## 故障前已实证的宿主事实（2.3.2，沙盒 serve 实测）

1. **OPENCODE_CONFIG_DIR 隔离生效**：`opencode api get /api/config` 的
   location.directory 指向沙盒 run 目录，首个 config 文档即沙盒
   `config/opencode.json`（但也合并了 `C:\.opencode`、`~/.opencode`、
   工作区 `.opencode` 的全局层——config 发现链仍会读到机器级目录）。
2. **config 键名**：顶层键是 `agents`（复数）。写 `agent`（单数）时内容虽
   被并入 `agents`，但 `p3.permissions` 被错误归一化进
   `request.body.permissions`（非 agent 级 permissions）；改用 `agents` 后
   permissions 归一化到 agent 级（正确层次）。`model "x/y"` 字符串被宿主
   折叠为 `{providerID:"x",model:"y"}`。
3. **v2 `plugins` 配置形状**：map 形状（`{"probe":"file://..."}`）被归一化
   **静默丢弃**——/api/config 的 info 里无 plugins 键，插件未加载；且 serve
   `--print-logs` 终末日志给出宿主自己的诊断（47323 运行，逐字）：
   `level=WARN message="configuration normalization diagnostic" path=$.plugins kind=invalid action="skipped malformed recognized value"`——与
   归档 change `v2-plugin-api-port` design.md L134-138 的记载一致：V2
   `plugins` 是数组，**验证过的加载路径是目录发现
   `.opencode/plugins/<name>/`（package.json `main`）**。探针已按此重构。
4. **API 鉴权**：serve 控制台打印的 password 用
   `Authorization: Bearer <pw>`（curl.exe）返回
   `{"_tag":"UnauthorizedError","message":"Authentication required"}`；
   可用通道是 `OPENCODE_PASSWORD=<pw> opencode api get <path> --server <url>`。
5. `opencode --version` → v2.3.2（PATH 中 `AppData\Roaming\npm\opencode`）。

## P1 / P2 / P3 — 无法判决

- **P1（merge-after-transform 顺序）**：探针未能在加载成功的宿主内运行
  （plugins map 形状被丢弃 + 随后 shell 故障）。静态佐证（design.md 引用）
  存在，但本任务要求的 undefined 快照 + /api/agent 最终记录对照**未采到**。
- **P2（execute 时 ctx.agent.get/list 可读性）**：延迟采样文件
  `probe-samples.jsonl` 未产生。
- **P3（deny 记录级生效 + 工具清单波及面）**：/api/agent 的 p3 记录与
  per-agent 工具清单观测均未采到。

## 沙盒卫生（收尾确认）

四次沙盒 serve（端口 47321/47322/47323/47324 尝试）全部经 forge_jobs kill
终止，注册表状态：4 个 serve job 均 `killed`，无存活沙盒进程。真实
~/.config/opencode 与 999 真实 service 全程未触碰（无安装器调用、无对真实
宿主的写操作）。端口释放未能用 shell 复核（shell 故障），但进程树均已被
kill 确认。

## 恢复指引（下次执行）

材料已就绪，重跑只需：
1. forge_shell 恢复后：`powershell -File .tmp/crew-probe-sandbox/start-serve.ps1`
   （后台，--print-logs，端口 47324）；
2. 等 ≥35s 后读 `probe-log.jsonl` / `probe-samples.jsonl`；
3. `OPENCODE_PASSWORD=<serve 打印的 pw> opencode api get /api/agent --server
   http://127.0.0.1:47324`（P1/P3 判决源）；
4. 结束 forge_jobs kill serve job。

## Execution results

**执行者：probe-execution subagent，2026-11-20 05:29–05:32Z。** 沙盒 serve 按
`start-serve.ps1` 启动（127.0.0.1:47324，OPENCODE_CONFIG_DIR 隔离，wrapper
PID 89864），证据采集后进程树全灭、端口释放（见文末沙盒卫生）。

**关键操作发现（决定本次成败）：插件是懒加载的。** serve 起来后 40+ 秒
`probe-log.jsonl` / `probe-samples.jsonl` 仍为空；首个打到服务器的 API 请求
（http.span=75，日志逐字 `msg="loading plugin" id="...run\.opencode\plugins\probe"
entrypoint=file:///...index.mjs http.span=75`）才触发插件加载与 setup。此前的
"目录发现是否有效"疑问就此闭合：**目录发现有效，`/api/plugin` 确认
`{"id":"probe-v2-surface","source":{"type":"local","path":"...run\.opencode\plugins\probe"},"features":{"server":true},"state":{"status":"active"}}`**。
（次要：`--print-logs` 结构化日志走 stderr，且 `/api/agent` 冷启动返回
`{"data":[]}`，agent 记录同样在首次相关请求时才装配。）

### P1 — merge-after-transform：**成立（config 增量在 transform 后落入最终记录；用户 default_agent 未被插件写覆盖）**

判决句：插件 transform 运行时刻，config 定义的纯增量 agent（vision-agent/p3）
在 draft 中尚不存在（`exists:false`），其配置值（`model x/y`、p3 shell-deny、
build `hidden:false`）只出现在最终 `/api/agent` 记录里——即 config 合并发生在
插件 transform 之后（或至少不在同一 draft 快照内）；插件 `draft.default("probe-forge")`
调用返回 ok 但零可观测效果：最终 registry 无 probe-forge 记录、`/api/config`
用户文档仍为 `"default_agent":"build"`、日志/事件零提及，用户 config 胜出
（就一切可观测表面而言；prompt 时的最终 default 解析未测——那需要真实 LLM 调用）。

transform 时刻快照（probe-log.jsonl 逐字，截取）：

> `{"t":"agent.transform","ts":"2026-11-20T05:29:38.323Z","draftKeys":["list","get","default","update","remove"],"get:build":{"exists":true,"record":{"id":"build","name":"Build","request":{"settings":{},"headers":{},"body":{}},"mode":"primary","hidden":false,"permissions":[{"action":"*","resource":"*","effect":"allow"},...],"description":"The default agent. Executes tools based on configured permissions."}},"get:vision-agent":{"exists":false,"record":null},"get:p3":{"exists":false,"record":null},"defaultIsFn":true,"defaultCall":"ok"}`

最终 `/api/agent` 记录（逐字，截取）：

> `{"id":"build",...,"mode":"primary","hidden":false,...}`（build 基座在 transform 时即已存在）
> `{"id":"vision-agent","name":"vision-agent","model":{"id":"y","providerID":"x"},...,"mode":"primary","hidden":false,...}`
> `{"id":"p3","name":"p3",...,"permissions":[...,{"action":"shell","resource":"*","effect":"deny"},...]}`

`/api/config` 用户文档（逐字，截取）：`"default_agent":"build","agents":{"build":{"hidden":false},"vision-agent":{"model":{"providerID":"x","model":"y"}},"p3":{"permissions":[{"action":"shell","resource":"*","effect":"deny"}]}}`

### P2 — execute 时 ctx.agent.get/list 可读性：**部分成立（方法可用、存在性可判，但读不出合并后的字段值）**

判决句：+5s/+30s 两个延迟采样里 `ctx.agent` 均有 `["get","list","transform","reload"]`，
对 build/vision-agent/p3 的 `get()` 全部 `exists:true`（不抛错、非 undefined），
但返回的 record 经 JSON 序列化只剩 `{}`（类实例/getter 形状），vision-agent 的
model "x/y" 在 execute-time 采不出来——合并值只在最终 `/api/agent` 记录可见；
`list()` 返回非数组对象（`count:null`）。

采样逐字（probe-samples.jsonl，5s 与 30s 两条完全同形）：

> `{"t":"sample.5s","ts":"2026-11-20T05:29:43.238Z","agentKeys":["get","list","transform","reload"],"get:build":{"exists":true,"record":{}},"get:vision-agent":{"exists":true,"record":{}},"get:p3":{"exists":true,"record":{}},"list":{"count":null,"ids":{}},"optionsShape":{"keys":[],"raw":"{}"}}`
> `{"t":"sample.30s","ts":"2026-11-20T05:30:08.239Z",...（同上形状）}`

### P3 — deny 的 record 级生效 + 工具清单观测面：**deny 成立；per-agent 工具清单无 HTTP 观测面**

判决句：p3 的最终 `/api/agent` 记录 permissions 数组里逐字出现
`{"action":"shell","resource":"*","effect":"deny"}`（deny 已落到 record 级；注意它
排在 `{"action":"*","resource":"*","effect":"allow"}` 之后，求值顺序/实际拦截
语义未测），而 per-agent 工具清单不存在任何 HTTP 端点（`/api/tool`、
`/api/agent/{id}/tool` 均 404），可观测面只有 `/api/plugin`（插件级 active 态）
与插件自记日志——其中 `ctx.tool.transform` 的 editor 回调触发了 **2 次**
（`{"t":"tool.registered"}` 两行，宿主对工具编辑器跑了双趟）。

p3 最终记录逐字（截取）：

> `{"id":"p3","name":"p3","request":{"settings":{},"headers":{},"body":{}},"mode":"primary","hidden":false,"permissions":[{"action":"*","resource":"*","effect":"allow"},{"action":"read","resource":"*.env","effect":"ask"},{"action":"read","resource":"*.env.*","effect":"ask"},{"action":"read","resource":"*.env.example","effect":"allow"},{"action":"shell","resource":"*","effect":"deny"},{"action":"browser","resource":"*","effect":"deny"},{"action":"skill","resource":"browser","effect":"deny"}]}`

工具观测面逐字：`GET /api/tool → HTTP 404`、`GET /api/agent/build/tool → HTTP 404`；
probe-log.jsonl 两行 `{"t":"tool.registered","ts":"2026-11-20T05:29:38.336Z"}` /
`{"t":"tool.registered","ts":"2026-11-20T05:29:38.353Z"}`。

### 新增宿主事实（本次执行发现）

1. **插件懒加载**：首次 API 触碰才 load+setup（见上）；对以后所有插件探针，
   "文件为空"≠"未加载"，必须先打一个触发请求再下结论。
2. **`--print-logs` 结构化日志走 stderr**（stdout 只有 `server listening on ...`
   与 `server password <pw>` 两行）。
3. **OPENCODE_CONFIG_DIR 只隔离 config，不隔离 data/log**：沙盒 serve 的日志
   追加进了真实 `~/.local/share/opencode/log/opencode.log`（33MB，最后写入
   时间戳与沙盒活动吻合）；config 发现链也仍读 `C:\.opencode`、`~/.opencode`
   （与首执行报告第 1 节一致）。
4. 会话对象无 agent 字段、无 `/api/agent/default` 类端点（`/api/agent/default`
   被当作 agentID 查询返回 `AgentNotFoundError`）→ default 的 prompt 时解析
   不可观测，P1 的 default 结论只覆盖 registry/config/log/event 表面。

### 沙盒卫生（本次执行收尾）

- serve 进程树（wrapper 89864 + 子进程 48200/91348）经 `taskkill /PID 89864 /T /F`
  全部终止；`Get-NetTCPConnection -LocalPort 47324` 无监听 = **端口已释放**。
- 真实宿主进程 91000（opencode）/57320（opencode-pty）全程存活、未触碰；无
  安装器调用、无对真实 config/service 的写操作。
- 例外披露（共享 data 目录副作用，均为只读或已回滚）：a) 沙盒日志行追加进真实
  共享 log 文件（见新增事实 3）；b) 为验证 default 采证创建的探针会话
  `ses_e088fe4fcffet78cnwDlDh3neB`（0 token、从未 prompt）已当场
  `DELETE /api/session/<id>` 删除。
