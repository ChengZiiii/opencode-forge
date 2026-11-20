# E2E Report — fix-v2-crew-surface-drift tasks 4.1（沙盒 workspace-pool-only crew 全循环）

- 日期：2026-11-21（UTC 2026-11-20 21:15–21:42）
- 仓库：`opencode-forge` @ HEAD `196203c`（含实现；worktree 另有 `ed899ec` docs 提交，未影响 dist）
- 沙盒：`C:/Users/Soren/AppData/Local/Temp/opencode/crew-e2e/`（下称 `<T>`；工作区 `<T>/ws`，无池目录 `<T>/dirA`）
- 服务器：`opencode v2.3.2 serve`，端口 45991，Basic auth（密码见 serve 日志），**全链路无真实模型调用凭据写入、无全局 forge.json**
- 模型端点：真实可用（auth.json `glm-coding-worker` → `open.bigmodel.cn`，裸 curl 冒烟 `content=[ok] finish=stop`）。**未降级 mock。**
- 驱动脚本（留在工作区根，可复跑）：`crew-e2e-setup.mjs` / `crew-e2e-lib.mjs` / `crew-e2e-driver-a.mjs` / `crew-e2e-driver-b.mjs` / `crew-e2e-driver-b2.mjs` / `crew-e2e-driver-c.mjs` / `crew-e2e-api.mjs`
- 原始证据：`<T>/logs/`（driver-a/b/c.log、sse-a/b/c.jsonl、serve4.log）

## 0. 沙盒纪律实录（重要：两层隔离教训）

1. **`OPENCODE_CONFIG_DIR` 单独不隔离 v2.3.2 存储**：第一次 serve（仅 `OPENCODE_CONFIG_DIR=<T>/cfg`）的 `/api/session` 返回了**真实 DB 的会话**（含本派发会话自身）。当场杀掉，未向真实 DB 写入任何会话（第一时间发现并终止；真实 service 进程 97112 全程存活未动）。
2. **有效隔离配方（最终采用）**：`OPENCODE_TEST_HOME=<T>/home` + `OPENCODE_DB=<T>/home/data/opencode.db` + serve CWD=`<T>/ws`（项目锚随 CWD）。隔离验证：`/api/session` → `{"data":[],"cursor":...}`；`<T>/home` 内产生独立 DB。
3. **发现的环境事实（如实披露，非本插件问题）**：opencode.exe 二进制含 `OPENCODE_TEST_HOME`、`OPENCODE_DB` 等 env；`/api/*` 是 v2 路由前缀（旧脚本的无前缀形状已失效）；SSE 在 `/api/event`，事件载荷在 `ev.data`（旧 `properties` 形状失效）；发消息是 `POST /api/session/:id/prompt {text,...}`（`/message` 已 404）。
4. **插件加载**：目录发现 `<T>/ws/.opencode/plugins/forge/index.js`（拷贝 dist/index.js, 823181 B）✅ 懒加载成功——会话创建+首条 prompt 后 forge 工具面可用（crew_begin/task 全部实测可调）。
5. **隔离缺口（披露）**：无池目录下拒注文案引用的全局兜底路径是 **真实的** `C:\Users\Soren\.config\opencode\forge.json`（OPENCODE_TEST_HOME 不隔离该路径）。实测该文件不存在（`Test-Path ... = False`），故所有判决不受影响；但若真实用户配置存在全局 forge.json，沙盒会看到它——沙盒纪律需知。

## 场景 A：workspace-pool-only crew 全循环 — **PARTIAL**

`<T>/ws/.opencode/forge.json` = `{pool:"sbx", agents:{probe:{prompt:"你是 E2E 探针…写 crew-e2e-ok…", shape:"write"}}}`；无任何全局 forge.json（fresh-install 形状）。会话 `ses_e05237af8ffeUmdGTfasmDE2bQ`（agent `forge`，创建于 ws）。

### A-1 核心验收 A（修复验证）：crew_begin 不再 "CREW IS NOT INITIALIZED" — **PASS** ✅

crew_begin {objective:"e2e loop", subtasks:[{title:"probe-write"}]} 逐字输出（driver-a.log / P1）：

```
Crew record (inspectable history; NOT a resume mechanism): .opencode/crew/2026-11-21-e2e-loop-3.md
[forge:crew] Crew registered PENDING for this session (execution has NOT started). Objective: e2e loop
Declared plan (1):
  1. probe-write
Session roster origins — sole ownership (dispatch gated to this session's workspace pool / the global fallback); 1 pool materialized on this host:
   - DISPATCHABLE from this session — workspace pool: c:\users\soren\appdata\local\temp\opencode\crew-e2e\ws\.opencode\forge.json — forge-sbx-probe
[forge:crew] The crew is PENDING — execution has NOT started. Present the execution-mode choice …
```

- **无 "CREW IS NOT INITIALIZED"**（修复前的必拒文案）——锚链统一修复在 fresh-install（无全局 forge.json）形状下判决性通过。
- 磁盘crew 记录落盘：`<T>/ws/.opencode/crew/2026-11-21-e2e-loop-3.md`（registered (pending) + 声明计划）。

### A-2 arm waves — **FAIL（实现 bug，冻结现场，未改源码）** ❄️

模型按插件指引调用 arm-only `crew_begin {execution:"waves"}`（描述文本明确 "called with {execution} ONLY (no objective/subtasks) it ARMS"），被 **宿主 schema 校验拒绝**：

```
TOOL.SUCCESS: output=[{"type":"text","text":"Invalid arguments for tool \"crew_begin\":\n- subtasks: Missing key\n\nArguments provided:\n{\"execution\": \"waves\"}\n..."}]
```

根因（dist/index.js @ crewBeginTool args）：`subtasks: tool.schema.array(...)` **缺 `.optional()`**，与 description 的 arm-only 语义直接矛盾。后续两跳连锁：
- 重试 `{execution, subtasks}`（无 objective）→ `crew_begin requires a non-empty objective (from /crew <objective>).`（execute 内校验）
- 重试完整 `{objective, subtasks, execution:"waves"}` → `[forge:crew] crew_begin cannot self-arm outside a governing goal…`（第一次驱动）／本会话因已有 PENDING crew → `This session already has an active crew: "e2e loop" (started …)`（该文案对 PENDING crew 也称 "active"，措辞漂移，次要）

**结论：在无 governing goal 的 standalone 场景，arm-only 路径在 v2 宿主 schema 层不可达 —— waves 无法武装。** 这是 `fix-v2-crew-surface-drift` 主题内的同类 surface drift（描述/逻辑与注册 schema 不一致），建议下一 change 修 `subtasks: …optional()`。

### A-3 crew 管控下的派发 — **如实记录（按设计拒）**

crew 仍 PENDING 时模型调 task 派 forge-sbx-probe → 逐字：

```
[forge:crew] Dispatch refused: the crew "e2e loop" is PENDING (registered, not armed). Present the execution-mode choice to the user — supervised waves now / convert to a goal contract / standby — then arm per their choice with crew_begin {execution: "waves" | "goal"}. Reconnaissance task calls are free only BEFORE registration.
```

pending 拒派符合设计；因 A-2 无法武装，**crew 管控下的派发创建面未能到达**（覆盖度缺口，见下）。

### A-4 创建面验证（crew 之外，无 crew 状态时派发）— **PASS** ✅

crew_close 之后（见 A-6）同一会话直接 `tools.task({subagent_type:"forge-sbx-probe", …})`：

```
TOOL.CALLED: task input={"code":"const res = await tools.task({ subagent_type: \"forge-sbx-probe\", description: \"probe: do your job per your standing instructions\", ..."}
SESSION.CREATED (child): {"sessionID":"ses_e051c42b1ffeGHWVKzQw3pcqLS","parentID":"ses_e05237af8ffeUmdGTfasmDE2bQ","location":{"directory":"…\\crew-e2e\\ws"},"title":"probe…"}
```

- **子会话创建成功**（ctx.session.create v2 适配生效）——无 `client.session.create TypeError`、无 `TASK_SEAM_DEGRADED_ERROR`。✅

### A-5 收割：standing 报告契约（地面真相）— **PASS** ✅

- `<T>/ws/reports/crew-e2e-report.md` 内容 = `crew-e2e-ok`（探针子会话写出）✅
- 子会话还写了 per-dispatch 契约报告 `reports/j-20261120-213631-n5kunl-report.md`，子会话最终文本（经 `GET /api/session/:id/message` 可读）：

```
Job completed:
- Wrote `crew-e2e-ok` to `reports/crew-e2e-report.md` per the standing instruction in `.opencode/forge.json` (probe task).
- Final report written to `reports/j-20261120-213631-n5kunl-report.md` per the report delivery contract.
Status: done.
```

**poll 面实录（2.3.2 已知缺口的实测修正）**：父会话 task 工具的返回值为**空字符串**（`TOOL.SUCCESS: output=""`）——结果流未回收，standning 报告文件成为唯一恢复通道，与 dispatch-stream-loss 契约一致；但 REST `GET /api/session/:id/message` **可以**读到子会话全文（会话域的 messages 读面在 v2.3.2 服务端存在），缺口 narrower than "session 域无 messages"——如实修正：不可用的是**插件 task 工具侧的收割接线**，不是宿主 API。

### A-6 crew_close 对账 — **PASS（title 匹配对账通过）** ✅

P5 逐字输出：

```
[forge:crew] Crew closed: e2e loop
subtasks: 1 (PASS 0, FAIL 1)
- probe-write: FAIL — No probe result exists: the task dispatch of forge-sbx-probe was refused because the crew 'e2e loop' was registered (PENDING, not armed); the probe was never executed, so nothing was written or probed
Crew record (history): C:\Users\Soren\AppData\Local\Temp\opencode\crew-e2e\ws\.opencode\crew\2026-11-21-e2e-loop-3.md
```

对账按声明的 title（probe-write）匹配、给出 FAIL+失败陈述（符合 FAIL 需失败报告的闸门），crew 记录 append 收尾。另注：全程**未出现任何 permission.asked 事件**（crew_close 文档称 ask-gated；本环境 ask 面未触发——与旧驱动脚本注释的 permission 事件形状变化可能相关，如实存疑）。

### 场景 A 覆盖度声明

| 验收点 | 结果 |
|---|---|
| fresh-install（无全局 forge.json）crew_begin 注册 | PASS |
| 无 "CREW IS NOT INITIALIZED" | PASS（判决性） |
| arm waves（crew_begin {execution:"waves"}） | **FAIL — subtasks schema 缺 optional（实现 bug，冻结现场）** |
| crew 管控下 task 派发创建面 | 未到达（被 A-2 阻断；pending 拒派文案符合设计） |
| 无 crew 状态 task 派发创建面（ctx.session.create 适配） | PASS（子会话创建成功） |
| standing 报告文件=地面真相 | PASS（crew-e2e-ok） |
| crew_close title 对账 | PASS |
| poll 面 | task 工具返回空串（stream-lost 形状）；宿主 messages API 实际可读子会话 |

## 场景 B：re-anchored（session move 后 crew 门）— **PARTIAL（降级双判决 + 新 drift 发现）**

### B-0 API 探形

- `GET /api/session/:id` → `{id, projectID, cost, tokens, time, location}`（`location.directory` 存在；无独立 worktree 字段暴露）
- **move 端点存在且可用**：`POST /api/session/:id/move`；`PATCH` 404。
  - body `{directory:"..\\ws"}`（相对、反斜杠）→ **204，移动成功**（GET 复核 `location.directory=<T>/ws`）。
  - body `{directory:"C:/…/ws"}`（绝对、正斜杠字符串）→ **500 `Cannot read properties of undefined (reading 'slice')`**（宿主 bug，如实上报）；`{directory:{directory:…}}` → 400 `Expected AbsolutePath`。

### B-1 目录 A（无池）crew 门拒 — **PASS（拒文案指 A）** ✅

`<T>/dirA`（无 .opencode）建会话 `ses_e051b4606ffeYuj3P8SSe4Z2YT`，crew_begin 逐字（节选）：

```
[forge:crew] CREW IS NOT INITIALIZED: no forge subagent is materialized for this session's roster (neither the workspace pool nor the global fallback yields an agent). Crew orchestration is unavailable until the user sets it up.
Two layers, SOLE OWNERSHIP: the workspace pool — the NEAREST .opencode/forge.json walking up from this session's worktree (C:\Users\Soren\AppData\Local\Temp\opencode\crew-e2e\dirA\.opencode\forge.json) — IS the whole roster when it exists; the global layer (C:\Users\Soren\.config\opencode\forge.json) serves only as the fallback …
```

拒文案明确指向 dirA 的工作区池路径 ✅（此时 "CREW IS NOT INITIALIZED" 是**正确**判决——A 无池且全局兜底不存在，与 hierarchical-pools 单测矩阵一致）。

### B-2/B-3 move 到 <T>/ws 后 crew 应过 — **FAIL（re-anchor drift，冻结现场）** ❄️

move 204 成功、`location.directory` 已是 `<T>/ws`，随后同会话 crew_begin {objective:"moved probe"} **仍然被拒**，且拒文案**仍引用 dirA 的池路径**（逐字同 B-1，含 `dirA\.opencode\forge.json` 字样）。

机制指向（dist/index.js `resolveSessionAnchorForPools` L17935-… + `effectiveWorktree` L17485：`worktree` 非 rootish 时**优先于** `directory`）：宿主 move 后插件侧权威锚（`anchorClient.session.get` 的 `rec.worktree`，或 prompt 时刻的 `context.worktree`）仍解析为 dirA，mapped/authoritative 的"pooled binding wins"分支只覆盖 **authoritative 无池且 mapped 有池** 的反向组合，未覆盖 move 后 authoritative(实际)=有池/记录残留=无池的形状 → 锚不随 move 重锚。**POOL 不跟随 session move——与 "POOLS follow workspaces" 的声明在 move 路径上drift。**

降级双判决（按任务预案）：
- 目录 A（无池）crew 拒，拒文案指 A ✅（B-1）
- `<T>/ws` 原生会话 crew 过 ✅（场景 A-1，同形 forge.json）
- 引 hierarchical-pools 单测矩阵（`tests/hierarchical-pools.test.mjs`，AGENTS.md 记载 crew 池合规闸矩阵 @ ~1395）：单测覆盖"crew_begin 拒无池/派发复检/全局豁免/workspacePoolOf 接线"，**未覆盖 move 后重锚路径**——与 B-2 实测 drift 吻合，覆盖度如实标注：move-reanchor 为单测与 E2E 双缺口。

## 场景 B 覆盖度声明

| 验收点 | 结果 |
|---|---|
| GET /api/session/:id 形状 | PASS（location.directory 可用） |
| move 端点存在性 | PASS（POST 204） |
| move 绝对正斜杠路径 | 宿主 500（slice bug，如实上报） |
| 目录 A crew 门拒（文案指 A） | PASS |
| move 到 ws 后 crew 过 | **FAIL — 锚不随 move 重锚（re-anchor drift）** |
| 降级双判决（A 拒 + ws 原生过） | PASS（双证齐） |

## 沙盒卫生（结束态）

- serve 进程树已杀（taskkill tree via forge_jobs kill + 端口复核）；`Get-NetTCPConnection :45991` → free。
- 仅存的真实 opencode 进程 88164 / 97112 为派发前既有（未触碰）。
- 真实 `~/.config/opencode`：无新增 forge.json（Test-Path False）；opencode.jsonc mtime 2026-11-21 04:14:56（早于本次沙盒开始，未被写入）；未运行 plugin installer，无 config 追加条目需要剥离。
- 隔离 DB/日志全在 `<T>`（保留作证据；OS temp 自清理）。
- 真实 `~/.local/share/opencode/auth.json` 仅被读取（沙盒副本拷贝），未写。

## 总裁定

- **场景 A：PARTIAL** —— 本 change 的核心修复（锚链统一，无全局 forge.json 下 crew_begin 注册成功、不再 CREW IS NOT INITIALIZED）**判决性 PASS**；创建面（ctx.session.create）与 standing 报告契约、crew_close 对账 PASS；但 **arm-only crew_begin 被 schema 硬拒（subtasks 缺 .optional()）**，waves 武装不可达，crew 管控下派发未到达——实现 bug，现场冻结未改源码。
- **场景 B：PARTIAL** —— 门拒/原生过双判决 PASS；**session move 后锚不重锚（re-anchor drift）**，E2E 与单测双缺口。
- 建议后续 change：① `subtasks: optional()`（arm-only 路径）② move/重锚路径的锚解析 ③（次要）PENDING crew 复注文案 "active" 措辞 ④（宿主侧上报）`/api/session/:id/move` 绝对正斜杠路径 500。
