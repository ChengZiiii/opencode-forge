# 0.31.0 双 change 沙盒 E2E — 重发轮报告（e2e-0310-dual-change）

- 日期：2026-11-21（重发轮；forge_shell 自检通过后全矩阵重跑）
- 仓库：`opencode-forge` @ HEAD `80cf2c61c03064a647b1315f4ea5eebced4ffd9f`（dist 入库，dist/index.js 875,403 B）
- 插件装载方式：目录发现（`<ws>/.opencode/plugins/forge/index.js`，字节拷贝自 dist/index.js）
- 结果总览：**7 PASS / 1 FAIL（实现 bug，现场冻结如实报）/ 1 PARTIAL**
- **定向重测轮（2026-11-21，HEAD `92fc059`）**：场景 6 与场景 9 已修复并复测通过，见底部"定向重测"两节；下文原始 FAIL/PARTIAL 记录保留作历史现场。**终态：沙盒 9/9 全 PASS**。
- **场景 10（列车新增腿）**：worker-shell 救援为**生产几何**验证（沙盒构不出该缺陷几何——探针 13 臂实证），见底部"场景 10"。

## 沙盒纪律（三件套 + XDG + 隔离密码）

```
OPENCODE_TEST_HOME = <T>/home
OPENCODE_DB        = <T>/db/oc.db
OPENCODE_CONFIG_DIR= <T>/cfg
XDG_DATA_HOME      = <T>/data          # log 落 <T>/data/opencode/log/opencode.log（实测确认）
XDG_STATE_HOME     = <T>/state
serve CWD          = <T>/ws            # 随机端口 47317，hostname 127.0.0.1
FORGE_TEST_FORGE_HOME = <T>/home       # 插件自身的测试钩子（见"重大发现"）
OPENCODE_PASSWORD  = e2e0310-pw-7f3k   # serve 进程环境变量注入，进程内存内，未落任何盘
```
`<T> = C:\Users\Soren\AppData\Local\Temp\opencode\e2e0310`

- 密码获取方式偏离说明：loopback 非 service 模式下 `opencode serve` **不向 stdout 打印随机密码**（exe 内逻辑 `if(...listening..., o&&!v) console.log("server password "+b)`，非 TTY/loopback 下 o 为假）。采用 `OPENCODE_PASSWORD` 环境变量注入 serve 进程 + 同值客户端认证（HTTP Basic, user `opencode`），密码全程不落盘（service.json 未创建——state/opencode 下无该文件），满足"不落 service.json"的实质要求。
- serve 驱动方式：`POST /api/session`（directory=<ws>）→ `POST /api/session/{id}/model`（fake-glm/glm-5.3-flash）→ `POST /api/session/{id}/prompt`（text="/forge ..."，prompt 解析器正确替换 $ARGUMENTS；`/api/session/{id}/command` 端点不替换 $ARGUMENTS，勿用）。

## 假 provider（指真实端点，key 只读引用真实 auth）

- `fake-glm`（npm @ai-sdk/openai-compatible，baseURL `https://open.bigmodel.cn/api/coding/paas/v4`，模型 glm-5.3-flash 全元数据克隆自真实 glm-coding-worker 条目）
- key 只读拷贝自真实 `auth.json` 的 `glm-coding-worker` 条目（真实文件 lastwrite 2026-09-29 未动）
- 坑位记录（复现者注意）：PS5.1 `Set-Content -Encoding UTF8` 写出 BOM → opencode 报 "Skipped legacy credential file that is not a JSON object"，auth.json/opencode.json 必须 `[IO.File]::WriteAllText` 无 BOM 写；且 openai-compatible 的 apiKey 最终以 provider `options.apiKey` 显式写入沙盒 config 才生效。

## 重大发现（影响 D5/D6 判读，非本插件的 bug 但决定测试姿势）

**全局配方（forge.json）的发现路径不读 OPENCODE_CONFIG_DIR**：`dist/index.js:15953` `global = ${homeDir}/.config/opencode/forge.json`，homeDir 来自 `process.env.FORGE_TEST_FORGE_HOME ?? homedir()`（dist:17928/18052/19397）。`OPENCODE_CONFIG_DIR` 只用于**产物目录**：`globalAgentDirFor({homeDir, configDir})` 在 configDir 非空时返回 `$CONFIG_DIR/agent`（dist:17977、16369-16378）——这正是 D5 行为，实测吻合。因此本轮以插件自带测试钩子 `FORGE_TEST_FORGE_HOME=<T>/home` 隔离配方发现面；任务书"全局配方目录=沙盒 $CONFIG_DIR"的前提与实现不符，判读按实现语义（配方=HOME/.config/opencode，产物=CONFIG_DIR/agent）执行并如实记录。

---

## 场景矩阵

### 1. /forge 命令注册面 — **PASS**
`GET /api/command`（serve 起来后）：
```json
{"location":{"directory":"...\\e2e0310\\ws"},"data":[
 {"name":"init","description":"guided AGENTS.md setup"},
 {"name":"review",...},
 {"name":"goal","description":"forge goal harness (autonomous, host-verified)..."},
 {"name":"plan","description":"forge plan harness..."},
 {"name":"crew","description":"forge crew orchestration — NOT INITIALIZED..."},
 {"name":"forge","description":"forge roster levers: sync forces an immediate forge_sync and shows the diff; init drafts the workspace forge.json in-band (refuses when one exists — review instead); init global drafts the global forge.json with the built-in override entries commented out"}]}
```
`forge` 在场（goal/plan/crew 同批注册）。execute 型证据：模板命令经 prompt 解析执行成功（场景 2-7 全部通过该通道驱动），`/api/session/{id}/command` 亦接受 `{name:"forge"}`。注意 `/api/command` 响应体不含 type 字段（服务端面如此）。

### 2. /forge sync 强制杆 — **PASS**（含对照断言）
前置：`<ws>/.opencode/forge.json` = `{"pool":"nfr31","agents":{"probe":{"model":"fake-glm/glm-5.3-flash","thoughtLevel":"low","prompt":"E2E probe worker for scenario 031"}}}`（SHA256 C143B8FB…A4FCD）。

对照断言（无命令零自动写）：配方落盘后静置 8s → `NO agent dir after 8s (control PASS)`。

staleness gate 姿势不变（crew_begin 应拒）：配方内容变更（新增 scout 条目）**不 sync** 后 crew_begin 逐字拒绝：
```
[forge:crew] Roster stale refused: this session's native roster artifacts are out of date with the recipe — missing artifact(s): forge-nfr31-scout.md — the recipe has agents but no compiled file for them. One-step fix: call the forge_sync tool NOW ...
```
（补充：纯 mtime touch 不触发——dist:16536 "recipe mtime is newer but the compiled content is current (touch/skew, not a change)"，内容相等优先，符合设计。）

`/forge sync` 回复（摘录，driver 会话 agent=forge，模型 fake-glm/glm-5.3-flash）：
```
[forge:sync] Compiled 1 roster file(s) across 1 pool(s):
  created: c:\users\soren\appdata\local\temp\opencode\e2e0310\ws\.opencode\agent\forge-nfr31-probe.md
```
产物 frontmatter 原文：
```
---
description: "forge subagent \"nfr31-probe\" (write, pinned fake-glm/glm-5.3-flash) — dispatch via the task tool with subagent_type \"forge-nfr31-probe\". Pool 'nfr31' — origin c:\...\ws\.opencode\forge.json; dispatchable only from sessions whose workspace pool is this file."
mode: subagent
model: "fake-glm/glm-5.3-flash#low"
tools:
  task: false
  shell: false
  bash: false
---
<!-- GENERATED BY forge_sync — edit the recipe (...forge.json), not this file. -->
```
`/api/agent` 出现 `forge-nfr31-probe`（model `{id:glm-5.3-flash, providerID:fake-glm, variant:low}`）。

### 3. /forge init 拒改红线 — **PASS**
已有 forge.json 的会话发 `/forge init`，回复开头逐字：
```
`.opencode/forge.json` **already exists** — per the init contract I won't touch or rewrite it. Here's the review of the recipe as it stands:
```
随后给出 pool/roles/shapes 审阅表 + "each needs your explicit go-ahead"。文件逐字节不动：内容与前置写入串完全一致（`{"pool":"nfr31","agents":{probe…scout CHANGED-CONTENT}}`），事后 SHA256 `EB9F07F64823A8C810D5AA2370A9D9B446233711FD166BCCA798463DD4543F8E`。

### 4. /forge init global 惰性脚手架 — **PASS**
全局 forge.json 不存在时 `/forge init global`：draft-in-band → 显式 go-ahead 后落盘。本轮落盘点经我方指定为沙盒 `cfg/forge.json`（如上"重大发现"：插件发现面在 HOME/.config/opencode，模型写盘点按指令钉在沙盒内，真实面零接触：`REAL home forge.json exists: False`）。落盘内容 override 节**全注释**（逐字摘录）：
```jsonc
  // OPTIONAL built-in overrides: uncomment and fill an entry to pin the
  // host's built-in General/Explore subagents machine-wide. ...
  // "override": {
  //   "general": { "model": "provider/model", "thoughtLevel": "low",
  //     "prompt": "You are my general-purpose worker. ..." },
  //   "explore": { ... },
  // },
```
`/api/agent` 内置 General/Explore 原样（General desc = "General-purpose agent for researching complex questions…"，Explore desc 原文；无 override 描述、无钉模）。

### 5. builtin-override 激活全链（判决性）— **PASS**
全局配方（`<T>/home/.config/opencode/forge.json`）激活 override.general（uncomment，model fake-glm/glm-5.3-flash，thoughtLevel low，自写 prompt 含 MARKER-OVERRIDE-31）→ `/forge sync`：
```
[forge:sync] Compiled 1 roster file(s) across 2 pool(s):
  created: C:/Users/Soren/AppData/Local/Temp/opencode/e2e0310/cfg/agent/general.md
```
三重断言全中：
- `$CONFIG_DIR/agent/general.md` **小写**落地（506 B；目录内大写变体计数 = 0）
- `/api/agent` 内置 general（id=general，单一入口）：
```json
{"id":"general","name":"General","model":{"id":"glm-5.3-flash","providerID":"fake-glm","variant":"low"},
 "desc":"Built-in general override — pinned by the global forge.json \"override\" node (pinned model)."}
```
  （override 描述按 dist:16347 固定文案生成；MARKER-OVERRIDE-31 在 prompt 体内，正文首行即 `MARKER-OVERRIDE-31 You are the pinned general worker…`）
- **无第二个 General 条目**：`/api/agent` 中含 "general" 的 id 仅 `["general"]`

### 6. GC 回收 — **FAIL（实现 bug，现场冻结如实报）**
操作：general 条目重新注释（override 节整体注释，agents:{}）→ `/forge sync`。
逐字输出：
```
[forge:sync] Compiled 0 roster file(s) across 1 pool(s):
The host hot-applies the files — no restart. ...
```
**无 gc'd 清单**；实测：`cfg/agent/general.md` 仍存在（506 B 未删）；`/api/agent` 内置 General 仍为 override 态（pinned model + override 描述），未恢复原样。
代码级根因（dist/index.js）：
- `planOverrideSync`（dist:16379-16389）`files.length > 0 ? {kind:"override",...} : null` —— override 全部停用后 plan 为 null；
- GC 只在 `executeRosterSync` 的 per-plan 循环里跑（dist:16465-16486，`gcEligible` 仅扫 plan.dir），override plan 不存在 → `$CONFIG_DIR/agent/general.md` 永远不被扫到；
- `runRosterSync`（dist:17976-17987）仅在 `overridePlan !== null` 时 push 该 plan。
即**停用（re-comment）路径不存在任何 GC 通道**，与脚手架注释自己的承诺"re-comment the entry and sync again to garbage-collect it"（dist:17841 附近）直接矛盾。判 FAIL。修复方向（供上游，非本任务改动）：override 集合为空但全局配方可读时仍构造空 files 的 override plan（或独立 sweep `$CONFIG_DIR/agent` 内 BUILTIN_OVERRIDE_IDS 文件）。

### 7. 碰撞红线 — **PASS**
手写 `$CONFIG_DIR/agent/general.md`（无 GENERATED marker，74 B，内容 `HANDWRITTEN-NO-MARKER general.md for collision scenario 7. Do not touch.`），配方同时激活 general+explore → `/forge sync` 逐字：
```
[forge:sync] Compiled 2 roster file(s) across 2 pool(s):
  created: C:/Users/Soren/AppData/Local/Temp/opencode/e2e0310/cfg/agent/explore.md
  errors: C:/Users/Soren/AppData/Local/Temp/opencode/e2e0310/cfg/agent/general.md: collision refused — a hand-written file of this exact name already exists; sync never overwrites it. Fold your changes into the global recipe's "override" entry, or rename/remove the hand-written file.
```
- 手写文件逐字节不动：内容与我方写入串完全一致，事后 SHA256 `12138D927CB079769CB0A245E920C5A18DABDCF6FE522DEB08A422E4D7E7AAA0`
- 兄弟 fail-soft：explore.md 照常落地（533 B，readonly 面全封：task/shell/bash/write/edit/patch/applypatch/apply/multiedit/execute 全 false，prompt=MARKER-OVERRIDE-31-EXPLORE scout worker.）

### 8. CONFIG_DIR 镜像 D5 — **PASS**（按实现语义，见"重大发现"）
- 全局产物落在 `$CONFIG_DIR/agent/`（场景 5 的 general.md、场景 7 的 explore.md 均在此目录生成，路径逐字见上）
- 假 home 镜像：`<T>/home/.config/opencode/agent/` 存在但**为空**（目录树列出仅 forge.json 263 B，agent/ 0 文件）——符合"不存在或为空"
- 真实面：`C:/Users/Soren/.config/opencode/agent` 不存在、`forge.json` 不存在
- 判读注意：D5 覆盖的是**产物目录**；配方文件本体从 HOME/.config/opencode/forge.json 发现（FORGE_TEST_FORGE_HOME/homedir），不走 CONFIG_DIR

### 9. 工作区 override 节忽略 — **PARTIAL**
`<ws>/.opencode/forge.json` 塞 override.general 节（pool nfr31 保留）→ `/forge sync`：
```
[forge:sync] Compiled 1 roster file(s) across 2 pool(s):
  unchanged: 1 file(s) already current
```
- 零发射 ✓：工作区 override 未产生任何 `general.md`/大写变体/新 General 条目（cfg/agent 与 /api/agent 均无变化；唯一 unchanged 是 forge-nfr31-probe.md）
- **warn finding 未披露 ✗**：dist:16157 生成的 `override-node-ignored-workspace`（"the top-level \"override\" field is GLOBAL-layer-only (workspace pools always compile namespaced as forge-<ns>-<id>) — field ignored"）在 sync 输出、serve stdout、`data/opencode/log/opencode.log` 三处均未出现（log 全文 grep 'override' 0 命中）——findings 被算出但 `runRosterSync` 不打印 resolution.findings（dist:17976-17998 只打 created/updated/unchanged/gc'd/errors）。D1 的忽略行为正确，披露缺失，判 PARTIAL。

---

## 沙盒卫生确认

- 进程树：serve 后台作业 j-20261121-141740-26z4as tree-kill；端口 47317 复查无存活监听（仅 TIME_WAIT/PID 0）。唯一残留 opencode 进程 PID 43308 启动于 21:47:59，早于本轮沙盒（21:53 起），系宿主会话服务器，未触碰。
- 真实面零接触：`C:/Users/Soren/.config/opencode/opencode.jsonc` lastwrite **21:50:40**（早于本轮），SHA256 `979DA33455822E1E6B754C77F20EBE936EA966996EAAB993295D539038A2857E`；真实 home 无 forge.json/agent；真实 auth.json lastwrite 2026-09-29 未动。目录发现装载，插件安装器从未运行，真实 opencode.jsonc 无新增条目需剥离。
- 日志隔离：全部 opencode 日志在 `<T>/data/opencode/log/opencode.log`；`<T>/state/opencode` 为空（未生成 service.json——密码全程内存态）。
- 改动面：仅新增/覆盖本报告文件；未改任何源码；沙盒目录 `<T>` 留存现场供复核（含 cfg/agent 冻结态：explore.md 533 B + 手写 general.md 74 B，即场景 7/6 bug 现场）。

## 结论

| # | 场景 | 判定 |
|---|---|---|
| 1 | /forge 命令注册面 | PASS |
| 2 | /forge sync 强制杆 + 对照 | PASS |
| 3 | /forge init 拒改红线 | PASS |
| 4 | /forge init global 惰性脚手架 | PASS |
| 5 | builtin-override 激活全链 | PASS |
| 6 | GC 回收 | **PASS（retest @92fc059，见"重测腿 A"）** |
| 7 | 碰撞红线 | PASS |
| 8 | CONFIG_DIR 镜像 D5 | PASS（产物目录语义；配方发现走 HOME，已披露） |
| 9 | 工作区 override 节忽略 | **PASS（retest @92fc059，见"重测腿 B"）** |

0.31.0 双 change 的核心正向链路（命令面、强制 sync、拒改、惰性脚手架、override 激活、碰撞防护、D5 镜像）全部实测通过；两处缺口：override 停用后的 GC（场景 6，FAIL）与 findings 的 in-band 披露（场景 9，PARTIAL）。

---

# 定向重测轮（retest @92fc059）

- 日期：2026-11-21；HEAD `92fc059dfcddeb9736f53b50991d147fd9315cb5`（"fix(builtin-override): scenario-6 deactivation GC channel + scenario-9 findings disclosure"）；dist/index.js 875,874 B，字节拷贝到 `<ws>/.opencode/plugins/forge/index.js`（目录发现装载）。
- 沙盒：`<T> = C:\Users\Soren\AppData\Local\Temp\opencode\e2e0310r`，三件套 + XDG_DATA/STATE_HOME + `FORGE_TEST_FORGE_HOME=<T>/home` + 随机端口 47319 + `OPENCODE_PASSWORD` 环境变量注入（HTTP Basic `opencode:<pw>`，serve stdout 不打印、state 目录 0 文件无 service.json）。假 provider `fake-glm` 同前轮（真实端点 + 只读引用 `glm-coding-worker` key，显式 `options.apiKey`）。
- 修复接线确认（dist 静态证据）：`dist/index.js:17985` `plans.push(overridePlan ?? {kind:"override", dir, files:[]})` —— 空 override 计划恒随 sync（GC 通道前提）；`dist/index.js:17998-17995/18001` findings 进 sync 回复（`  finding [warn] <code>: <message>`）；`dist/index.js:18002-18003` `override-node-ignored-workspace` 额外走 `console.warn("[forge:sync] warn: …")`。

## 重测腿 A — 场景 6 GC 停用通道 → **PASS（retest @92fc059）**

**A1 基线复刻（激活）**：全局配方 `<T>/home/.config/opencode/forge.json` 激活 override.general（model fake-glm/glm-5.3-flash、thoughtLevel low、prompt 带 MARKER-OVERRIDE-31R）→ `/forge sync` 工具原始输出（session ses_e01790ab…，逐字）：
```
[forge:sync] Compiled 1 roster file(s) across 1 pool(s):
  created: C:/Users/Soren/AppData/Local/Temp/opencode/e2e0310r/cfg/agent/general.md
The host hot-applies the files — no restart. Edit the RECIPE (forge.json), never the generated files; forge_sync re-emits.
```
`$CONFIG_DIR/agent/general.md` 落地（458 B）；`/api/agent` general 单一 id、override 态：`model {id: glm-5.3-flash, providerID: fake-glm, variant: low}`、description `"Built-in general override — pinned by the global forge.json \"override\" node (pinned model)."`、system 首行 `MARKER-OVERRIDE-31R You are the pinned general worker…`。

**A2 停用 + GC**：先手写对照文件 `$CONFIG_DIR/agent/explore.md`（124 B，marker-less：`HANDWRITTEN-NO-MARKER explore.md control file for e2e0310r leg A (scenario 6 retest @92fc059). GC must not touch this file.`）→ 配方 override 节整体注释（agents:{}）→ `/forge sync`（session ses_e01753fb…，逐字）：
```
[forge:sync] Compiled 0 roster file(s) across 0 pool(s):
  gc'd (entries removed from the recipe): C:/Users/Soren/AppData/Local/Temp/opencode/e2e0310r/cfg/agent/general.md
The host hot-applies the files — no restart. Edit the RECIPE (forge.json), never the generated files; forge_sync re-emits.
```
- `$CONFIG_DIR/agent/general.md` **消失**（目录列出仅 explore.md 124 B）
- `/api/agent` 内置 General **恢复原样**：`model: null`（去钉扎）、description 回内置原文 `"General-purpose agent for researching complex questions and executing multi-step tasks. Use this agent to execute multiple units of work in parallel."`
- 手写 explore.md **原样保留**：内容与我方写入串逐字节一致，SHA256 `362F70BAE7339E9AB112B1CB4F435B3B96A525B32ACC06D3C9C60469C721D737`，mtime 22:37:43.386 前后不变（GC 只收 GENERATED 文件，marker 神圣性成立）

**A3 无副作用通过**：无 override + 无残留（仅手写 explore.md）→ `/forge sync`（session ses_e0172b18…）输出逐字 `Compiled 0 roster file(s) across 0 pool(s):` + 热应用尾行，无 created/updated/gc'd/errors；agent 目录 readdir 前后完全一致（explore.md|124|22:37:43.386，mtime 未动，零写入），不报错。

## 重测腿 B — 场景 9 工作区 override 节 warn 披露 → **PASS（retest @92fc059）**

工作区 `<ws>/.opencode/forge.json` 塞 pool `nfr31r` + probe 条目 + 顶层 override.general（prompt 带 MARKER-WS-OVERRIDE-31R）→ `/forge sync`（session ses_e01723ec…，工具原始输出逐字）：
```
[forge:sync] Compiled 1 roster file(s) across 1 pool(s):
  created: c:\users\soren\appdata\local\temp\opencode\e2e0310r\ws\.opencode\agent\forge-nfr31r-probe.md
  finding [warn] override-node-ignored-workspace: c:\users\soren\appdata\local\temp\opencode\e2e0310r\ws\.opencode\forge.json: the top-level "override" field is GLOBAL-layer-only (workspace pools always compile namespaced as forge-<ns>-<id>) — field ignored
The host hot-applies the files — no restart. Edit the RECIPE (forge.json), never the generated files; forge_sync re-emits.
```
- **finding 通道披露 ✓**：`  finding [warn] override-node-ignored-workspace: …` 行逐字在场（dist:18001 接线生效）；会话最终回复亦以 ⚠️ 段落转述该 warn
- **零发射 ✓**：该 override 节未产生任何 agent 文件 —— `$CONFIG_DIR/agent` 仅剩手写 explore.md；`<T>/home/.config/opencode/agent` 空；全目录 grep `MARKER-WS-OVERRIDE` 0 命中；`/api/agent` general 仍内置态（model null + 内置 description），无第二 General 条目（唯一 created 是池自身的 forge-nfr31r-probe.md，与 override 无关）
- **console 诊断通道 ✓**：serve 进程 stdout（后台作业日志）出现逐字行：
```
[forge:sync] warn: c:\users\soren\appdata\local\temp\opencode\e2e0310r\ws\.opencode\forge.json: the top-level "override" field is GLOBAL-layer-only (workspace pools always compile namespaced as forge-<ns>-<id>) — field ignored
```
  （附注：`<T>/data/opencode/log/opencode.log` grep 该串 0 命中——宿主 logger 不收插件 console.warn，诊断走 serve 进程 stdout，属设计内通道。）

## 重测轮沙盒卫生

- 进程树：serve 后台作业 j-20261121-143254-37ehkq tree-kill；端口 47319 复查零监听；唯一在册 opencode 进程 PID 43308（21:47:59 启动，宿主会话服务器，早于本轮，未触碰）。
- 真实面零接触：真实 `opencode.jsonc` 事后 SHA256 `979DA33455822E1E6B754C77F20EBE936EA966996EAAB993295D539038A2857E`、lastwrite 21:50:40（与轮前基线一致，未动）；真实 auth.json SHA256 `668F963F771B0785D66DEC2A1A1592E8FC7BF811AA941DDBC8CCD0EC8EE51D4B` 未动；真实 home 无 forge.json、无 agent 目录；`<T>/state` 0 文件（无 service.json，密码全程内存态）。
- 改动面：未改任何源码；本报告为唯一新增文本产物；沙盒 `<T>` 留存现场供复核（cfg/agent 冻结态：手写 explore.md 124 B；ws/.opencode/agent/forge-nfr31r-probe.md）。

---

# 场景 10 — worker-shell 救援（生产几何腿，change `worker-shell-session-allow`）→ **PASS**

> 该场景不在沙盒跑：缺陷几何是"宿主 permission 层在插件宿主 location 解析不到工作区注册的 agent → missingAgentPermissions 字面 deny-all 短路"（源码级根因见 `reports/research-plugin-tool-permission.md`），13 臂探针实证沙盒构不出（`reports/probe-native-worker-shell-denial.md`）——必须在生产几何里验。

- 日期：2026-11-21；被测面：真实宿主 server（重启后 PID 43308，21:47:59 起；forge 插件加载 run=0793a9cf @ 21:48——**晚于** 21:37 铺进生产缓存 dist 的补丁，加载即补丁版）。
- **PASS 腿**：plugindev 工人 `forge_shell echo RESCUE-VERIFIED-OK` → exit=0、输出逐字；第二跑 `git log --oneline -1`（workdir=本仓库）→ `188ecca chore: dist rebuild (worker-shell-session-allow)` exit=0。宿主日志 `session-rescue` 0 命中 = **session 规则注入静默成功**（主会话播种 + 工人首调 belt 双点位），兜底 belt 未出场——设计最优路径。
- **DENY 腿（deny 神圣门）**：真实 `opencode.jsonc` 注入 v2 数组形状 `permissions: [{action:"forge_shell", resource:"*", effect:"deny"}]`（无 legacy map）→ 工人收到**插件显式拒绝文案**逐字：`[forge] forge_shell is explicitly denied by user configuration (permission forge_shell: "deny"). Nothing was executed. Remove or change the deny rule to re-enable the exec surface.`（非宿主裸 deny）→ 双形状姿态解析器真实磁盘判读正确 + deny 先于注入短路。事后配置逐字节还原（SHA256 前缀 `979DA33455822E1E` = 基线）。
- 判定依据全文：`openspec/changes/worker-shell-session-allow/tasks.md` 3.2（勾账证据）。
