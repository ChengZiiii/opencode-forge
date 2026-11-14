# Spec-conformance review: task-shadow (commit dbd7b13)

Reviewer: forge-plugindev-spec-reviewer · 2026-11-15
Scope: openspec/changes/task-shadow/ 全组 × plugin.ts / src/dispatch-async.ts / tests/{dispatch-async,dispatch-wiring,forge-subagents-wiring,search-wiring}.test.mjs / README.md（工作树 = dbd7b13，干净）。

**总裁定：APPROVE-WITH-NOTES**（无 blocker；7 条 Note 见文末；1 处契约文字澄清已改并单独列明）。

## 0. 验证命令与结果

| 命令 | 结果 |
| --- | --- |
| `bun run typecheck` | exit 0 |
| `node --test tests/*.test.mjs` | **541 pass / 0 fail**（duration 13.7s） |
| `openspec validate --all` | 10 passed / 0 failed |
| `openspec validate task-shadow`（契约编辑后复验） | Change 'task-shadow' is valid |

---

## 1. 两条 ADDED 需求 × 10 个 Scenario 逐场景判定

### Requirement A: Task shadow surface (native name, forge engine)

| # | Scenario | 判定 | 实现证据 | 测试证据 |
| --- | --- | --- | --- | --- |
| A1 | A forge dispatch renders in the native task panel | **PASS（机制层）+ 已披露的实机递延** | 注册名 `task`（plugin.ts:2706）；metadata 6 键（plugin.ts:1958-1965）；native 标题格式（src/dispatch-async.ts:87-89 `"<desc> (@<agent> subagent)"`） | dispatch-wiring:154-179（注册+描述）、217-225（6 键逐键断言）；forge-subagents-wiring:209-228。TUI 实机面板 = tasks.md §6.2（发布阶段，未勾）——proposal.md:37-39/design.md:72-73 本就将其定义为 live acceptance 场景，按审查指示不算缺口 |
| A2 | Non-forge targets keep native dispatch parity | **PASS** | 非 forge 路径走同一引擎、跳过池闸（plugin.ts:1916-1924）；`knownHostAgents` 每次 config pass 刷新（plugin.ts:3390-3396，native fallbacks 恒在） | dispatch-wiring:376-390（sync：parentID/native title/无 question-deny/agent 上 body）、392-402（async：seal 照带）、404-413（非 forge speaker → 非 forge target 通）、415-429（未知目标 honest 拒） |
| A3 | Question policy is mode-keyed | **PASS** | `questionDeny: runInBackground`（plugin.ts:1949）→ create body 条件 seal（src/dispatch-async.ts:117-122） | dispatch-async:92-121（sync 无 `permission` 键 / async 带 `QUESTION_DENY_PERMISSION`）；wiring:211、368、400（forge/非 forge 两类目标 × 两模式） |
| A4 | Sync abort parity | **PASS** | `signal: context.abort`（plugin.ts:1971，类型面：@opencode-ai/plugin tool.d.ts:16 `abort: AbortSignal`）；poll 每片检查 signal（src/dispatch-async.ts:255-259）→ aborted 变体 → `abortChild` + 披露解析（plugin.ts:1973-1985，abort 调用失败也如实披露） | dispatch-async:294-324（pre-aborted / MID-POLL / 无 signal 三例）；wiring:434-448（实调 `session.abort` + 输出披露 + 子会话 id 点名） |
| A5 | forge_dispatch is retired | **PASS** | `forgeTools()`（plugin.ts:2676-2709）无 forge_dispatch 注册；禁用旋钮下 `task` 随全家摘除（3435-3437） | dispatch-wiring:170/176-177（工具面+词汇+worker `task:"deny"` 三断言）；forge-subagents-wiring:220-223（连 `_config/_list/_kill` 旧家族一起断言不存在）；search-wiring:50-52 |

### Requirement B: Dispatch lifecycle (wake, cap, harvest)

| # | Scenario | 判定 | 实现证据 | 测试证据 |
| --- | --- | --- | --- | --- |
| B1 | Async handle and single completion wake | **PASS** | 立即句柄（task id/agent/child session，plugin.ts:2025-2035）；poller 切片守望（1824-1856）；wake 走 job-supervisor 队列（idle-only/at-most-once/窗口期，3831 `deliverJobWakes`）；最终报告 2500 字符尾（plugin.ts:738 `job.tail.slice(-2500)`） | dispatch-wiring:484-517：idle 前零 wake、idle 后恰一条、子报告内联、再 idle 无重发；句柄含 END YOUR TURN 纪律 |
| B2 | Concurrency cap | **PASS** | `ASYNC_DISPATCH_CAP = 3`（plugin.ts:1792）；拒文案带在飞 task ids + 指引（1928-1936）；计数按 registry running 态真值（1799-1811） | dispatch-wiring:453-473：3 个在飞 → 第 4 拒、逐 id 点名、`without run_in_background` 指引 |
| B3 | Owner death harvests children | **PASS** | `session.deleted` → `jobManager.onSessionEnd`（3839）→ kill 行 → `killTree: () => abortChild`（2017-2019）+ orphan 记账；handle map 跟随排空（3845-3847） | dispatch-wiring:476-481：3 次 `session.abort`、3 条 `orphan-job` 账目、`dispatchTasks` 排空 |
| B4 | Sync timeout is honest | **PASS（引擎级）**，wiring 级无直测（Note N2） | 引擎 timeout 变体带 sessionID/timeoutMs（src/dispatch-async.ts:295-297）；wiring 层 throw 点名子会话 id + 不自动转 async（plugin.ts:1987-1992） | dispatch-async:218-228（timeout 命名 session id + 预算）。比对 b80da91 旧套件：0.22.0 本就无 wiring 级 timeout 用例——移植无覆盖丢失 |
| B5 | Draft interop unchanged | **PASS** | `draftDispatchRefusal`（plugin.ts:903-925）单源共享：execute.before 主闸（3540-3548）与工具内 belt（1926-1927）同谓词同文案；readonly 显式形状豁免、write 拒、双模式；拒文案带 readonly 名册+指引 | dispatch-wiring:326-353：readonly sync+async 双通、write sync+async 双拒、名册点名 `forge-dp-research` |

### 设计决策可测试性（design.md D1-D5）

D1 shadow（A5 测试）、D2 非 forge 全对等（A2 四测）、D3 metadata 镜像（A1/wiring:217-225 逐键）、D4 sync abort（A4 双层）、D5 退役单面（A5 三文件）——全部可测且已测。

---

## 2. REMOVED 是否干净

- **标题逐字匹配**：delta REMOVED 的 `forge_dispatch surface (SDK child sessions)` / `Async dispatch lifecycle` 与 live spec 标题（openspec/specs/forge-subagents/spec.md:287 / :343）逐字一致——归档匹配键无漂移。
- **不可达**：注册 getter → `forgeTools()` 无该键；三份测试文件断言 `h.tool.forge_dispatch === undefined`（dispatch-wiring:170、forge-subagents-wiring:220、search-wiring:50）。
- **无幽灵引用**（全库 grep）：
  - plugin.ts：恰 3 条 RETIRED 注释（:102 / :1780 / :2705，见披露项）+ env 旋钮名 `FORGE_DISPATCH_POLL_INTERVAL_MS`/`FORGE_DISPATCH_POLL_SLICE_MS`（:1825/:1826/:1970，旋钮名保留——测试直接消费，dispatch-wiring:22-23）。
  - src/dispatch-async.ts:2 一条历史注释（"formerly forge_dispatch"）——刻意沿革披露。
  - README:501 一处（"the old `forge_dispatch` tool is retired"）——退役声明本身。
  - 其余命中全部位于 `openspec/changes/archive/**` 与历史文档（dispatch-wargame.md、DISPATCH-TIMEOUT-INCIDENT-*.md）——史料，不在清理范围。
  - live specs：forge_dispatch 仅出现在将被 REMOVED 的两条需求内；其余 spec（tool-partition/crew-harness 等）只泛引 task 派发——proposal "Other specs … hold" 成立。
- **语义随 task 面延续**：wake 纪律原封（job-manager 队列 + `deliverJobWakes` + 2500 尾）；cap 3（:1792）；收割（killTree→abortChild + orphan 账本 + handle 排空）——三条生命周期 scenario 在 `task` 面下全数有测（B1-B3）。
- **闸键迁移到 task 名**：execute.before 以 `input.tool === "task"` 键控（3468），与工具内执行共享同一组谓词函数（poolGateRefusal / crewPendingRefusal / crewComplianceRefusalFor / draftDispatchRefusal）——"Gates carry over keyed on the task name"（proposal.md:44）落实为同源双闸。worker 递归禁令不变：物化 permission `task: "deny"`（dispatch-tiers，dispatch-wiring:177 断言）+ 工具内 primary-only 拒（1886-1890）。

---

## 3. 新增语义边角

### 3.1 crew pending 闸 × 非 forge 目标 —— 实现自洽（已做契约澄清）

- 实现：pending 闸在两处都**先于目标分流**执行（工具内 plugin.ts:1896-1899；belt plugin.ts:3493-3494），对**任何**目标类拒绝——注释明示 "both target classes — same copy as the belt"。
- 判定依据：crew-harness live spec 正文（openspec/specs/crew-harness/spec.md:137）"while the session's crew is PENDING, the `task` tool SHALL be refused"，场景（:141-142）"attempts **any** `task` call → the belt refuses"——pending 闸是**会话态**闸，不按目标键控；proposal "Gates carry over keyed on the `task` name" 的措辞与此一致（键在工具名/会话，不在目标）。
- 对照：compliance 闸是**目标**键控（crew-harness:176 "targeting a `forge-*` worker"；实现 plugin.ts:887 非 forge 直接 return null）——非 forge 目标不受 compliance 拦，语义正确（池合规是池文件的事，非 forge 目标无池）。
- delta 原句 "non-forge host targets dispatch through the same engine without the forge pool gate" 只点名池闸被跳过，对 pending 闸作用域存在误读空间（归档合并后单读该需求文本的读者可能以为非 forge 目标全不带 crew 闸）——**已做最小契约澄清**（见 §7 契约编辑）。
- 残留措辞张力（不改实现，Note N1）：工具描述（plugin.ts:1863）"Non-forge host targets dispatch with native parity (no forge gates)" 与 pending 闸实际拦一切目标之间有字面张力；README crew 节（:964 "every `task` dispatch is refused"）是精确的。

### 3.2 draft 互操作 × 非 forge 目标 —— native parity 保持

draft 期内非 forge 目标被拒（draftDispatchRefusal 的 else 文案："native agents wait for approval"，plugin.ts:924）。这与 pre-shadow 行为一致：native task 本就在写禁类（`WRITE_TOOLS` 含 "task"，:928），且豁免只键于 forge 目标的显式 readonly 形状（allow-readonly-recon，spec 措辞 "an effective-readonly **forge** target"）。delta scenario B5 只裁 forge 目标——无契约缺口；行为判 native parity。permission.ask 侧带 fail-closed 不跟随豁免（3804-3809）为既有声明行为，未动。（测试只覆盖 forge 目标两模式——Note N5。）

### 3.3 未知目标报错路径 —— 双路齐全且有测

- 未知 forge 目标（`forge-*` 前缀但未物化）：`not a materialized forge subagent on this host` + 名册/forge.json 指引（plugin.ts:1904-1908）；测 dispatch-wiring:314-324。
- 未知非 forge 目标（不在 `knownHostAgents`）：OMO 风格 `Agent not found: "…" is neither a materialized forge-* subagent nor a configured host agent`（plugin.ts:1920-1924）；测 dispatch-wiring:415-429。
- 目标词汇真值每次 config pass 热刷新（3390-3396），native fallbacks（build/plan/general/explore）恒在集内。

### 3.4 其它边角核过

- 未知 speaker 会话：族闸 fail-open（1885/1891 均以 `speaker !== undefined` 为前提），pending/draft 会话态闸照常生效，池闸 fail-open + 有界披露（842-856）——与既声明 belt 姿势一致。
- 非 forge async 也计入 cap（1928-1936 在目标分流之后、模式判定时执行，目标无关）——spec 措辞 "per session" 无目标限定，一致。
- belt 与工具内的闸序在「cross-pool + pending crew」叠加态下文案不同（belt 池闸先、工具内 pending 先）——两者皆拒、皆如实，无场景依赖顺序，不构成问题。

---

## 4. metadata 6 键 × 三路径

`taskMetadata` 单点构造（plugin.ts:1958-1965：`agent`/`sessionId`/`taskId`/`run_in_background`/`description`/`prompt`），三路径全部经 `context.metadata({...})` **和** 返回对象 `metadata` 双发布：

| 路径 | context.metadata | return metadata | 测试 |
| --- | --- | --- | --- |
| sync complete | plugin.ts:1998 | :2001 | dispatch-wiring:217-225（**恰好 6 键** deepEqual 断言，:225） |
| abort | plugin.ts:1977 | :1980 | wiring:434-448（输出断言；6 键未逐键断言——Note N4） |
| async handle | plugin.ts:2024 | :2027 | wiring:497-502（5 键显式 + taskId 存在性） |

timeout/error 路径 throw 不带 metadata——native task 同形（错误 tool part 无任务元数据可渲染），spec 亦只裁三路径，判一致。

---

## 5. README 与 forge_dispatch 清理

- **派发节（README:579-646）逐句核对实现**：shadow 声明/禁用旋钮回收、SDK child+parentID、metadata 6 键清单、sync 默认+abort parity+10 分钟 honest timeout+不自动转 async、async 句柄三标识+单 wake+2500 尾+cap 3+turn-abort 存活+owner-death 收割、question policy mode-keyed（含 seal 的逐字 JSON 与「无人应答降级为 poll-timeout」的 fail-closed 声明）、gates 清单、"unknown target → Agent not found"——全部与代码一致。crew 节 :964 "every `task` dispatch is refused"（pending 期）与 :1006 "the belt gates `forge-*` dispatch only"（compliance）两处分别精确对应两闸的作用域。
- **breaking-note（:644-646）**：不与 oh-my-opencode 共装、双双 shadow `task`、注册序决定——与 proposal Impact/design 风险逐字对应。✓
- **清理彻底性**：§2 已列——plugin.ts 恰 3 条 RETIRED 注释 + env 旋钮名（均在披露许可内）；src 1 条沿革注释；README 1 条退役声明；其余全在 archive/史料。dist/index.js 与源同步（含 `tools.task`、questionDeny、TASK_DESCRIPTION，dist:16562/17949/18018/18584）。✓

---

## 6. 已知披露核实（均非缺口）

| 披露项 | 核实 |
| --- | --- |
| 注册映射 18 键 swap | `forgeTools()` = 11 plan/goal + 2 job + 2 search + 3（crew×2 + task）= **18**（plugin.ts:2676-2709）；测 search-wiring:52 `Object.keys(h.tool).length === 18` |
| 分区词汇 18→17 | `FORGE_ALL_TOOLS` = 13 state（forge_dispatch 移除）+ 2 exec + 2 search = **17**，`task` 刻意不入列（plugin.ts:87-113）；测 search-wiring:112-114（17 键 + forge_dispatch 离场 + task 不隐藏） |
| TUI 实机验收留发布后 | tasks.md §6.2 未勾（release 阶段项，含 evidence 落点 verify/acceptance-0-23-0.md）；proposal/design 均将其定义为 live acceptance——按审查指示不计缺口 |

---

## 7. 契约编辑（单独列明）

**1 处，已复验 `openspec validate task-shadow` 通过**：

`specs/forge-subagents/spec.md`（Requirement: Task shadow surface 正文）——原句 "non-forge host targets dispatch through the same engine without the forge pool gate." 补明确义："— the crew pending belt stays SESSION-keyed (it refuses ANY `task` call per the crew-harness pause semantics, target class notwithstanding) while the pool-compliance belt stays forge-*-keyed."

理由：见 §3.1——实现与 crew-harness live spec 正文一致，但 delta 单读可误读为非 forge 目标不带任何 crew 闸；归档合并后该需求文本将独立存在，补一句消除歧义。纯澄清，无语义变更。

---

## 8. Notes（无 blocker，逐条）

- **N1（措辞，工具描述）** plugin.ts:1863 "Non-forge host targets dispatch with native parity (no forge gates)" —— pending 闸实际拦一切目标、draft 写禁也拦非 forge 目标（native parity 地拦）。README 两处是精确的；建议下次文档触碰时把这句收窄为 "no forge target gates"。
- **N2（测试覆盖）** sync timeout 无 wiring 级用例（引擎级 dispatch-async:218-228 已裁 sessionID/预算命名）；wiring 层 throw 分支（plugin.ts:1987-1992）未被直接执行到。0.22.0 套件本就如此（比对 b80da91），非移植丢失。
- **N3（测试覆盖）** crew pending 闸 × 非 forge 目标：实现拦（1896-1899），测试只用 forge 目标裁过（dispatch-wiring:251-262）。
- **N4（测试覆盖）** abort 路径 metadata 6 键已发布（1977-1985）但 abort 测试只断言输出文本，未逐键断言（sync/async handle 两路径已逐键）。
- **N5（测试覆盖）** draft × 非 forge 目标（判拒、native parity）无直接测试；spec scenario 本就只裁 forge 目标，无契约缺口。
- **N6（措辞，README）** :202 dispatch ledger 行括注 "(the dispatch engine was removed)" 是 dispatch-suite 退役时代的措辞——现役引擎已回归（task-shadow），真实情况是「新引擎不写该文件（orphan 记账走 jobs ledger）」。文件断言本身仍真，括注易误读。
- **N7（0.22.0 遗留死字段，非本变更回归）** async 派发 job 的 `logPath` 指向 `dispatch/<jobId>.txt`（plugin.ts:2013）但目录从不创建、`appendOutput` 纯内存（job-manager.ts:191-197）——`forge_jobs log` 对 dispatch 行会拿到不存在路径。不影响 file ledger 穷尽性（无文件写盘）；随手续项记下。

## 9. 裁定

两条 ADDED 需求 10 个场景全部有实现+测试证据（B4 为引擎级证据 + N2 备注；A1 的 TUI 实机属既定 live acceptance 递延）；REMOVED 干净（标题逐字、不可达、无幽灵引用、生命周期语义全延续）；边角语义（pending 闸作用域 / draft × 非 forge / 未知目标双路）与 live spec 族自洽；metadata 三路径齐发；README 与清理彻底性达标；三项披露全数核实。**APPROVE-WITH-NOTES**。
