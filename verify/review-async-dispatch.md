# Review: async-dispatch 实现符合性审查

- 日期：2026-11-15
- 审查员：spec 审查员（只读审查；除本报告外未改任何文件）
- 对照契约：`openspec/changes/async-dispatch/`（proposal.md / design.md 含 Spike 结论 / specs/forge-subagents/spec.md / tasks.md）
- 实现切片：`src/dispatch-async.ts`、`plugin.ts`（forge_dispatch 相关全部改动）、`tests/dispatch-async.test.mjs`、`tests/dispatch-wiring.test.mjs`、`tests/forge-subagents-wiring.test.mjs`（禁令测试改写）、`README.md` 派发节
- 测试运行证据：`node --test tests/dispatch-async.test.mjs tests/dispatch-wiring.test.mjs tests/forge-subagents-wiring.test.mjs tests/search-wiring.test.mjs` → **85/85 pass**；`node --test tests/hierarchical-pools.test.mjs tests/job-manager.test.mjs tests/job-wiring.test.mjs` → **81/81 pass**（原生路径回归零失败）

---

## 1. spec delta 十个场景逐项成立性（读码确认，非仅"有测试"）

### Requirement: forge_dispatch surface (SDK child sessions) — 6 场景

| # | 场景 | 结论 | 证据（行为 + 测试） |
|---|------|------|---------------------|
| 1.1 | wait dispatch returns the child's final message | **PASS** | `plugin.ts:1931-1951`：wait 路径 `pollChild` 到终态 → `fetchFinalMessage` → 返回 `${target} finished (child session ${id})` + `Final report:` 全文（agent 身份+子会话 id+最终消息三要素齐）；`parentID` 于 `src/dispatch-async.ts:108-115` 进 create body。测试 `tests/dispatch-wiring.test.mjs:175-196`：断言 `parentID === "ses_wait1"`（L189）、title 原生格式（L191）、`query.directory` 锚定父目录（L192）、prompt body 带 materialized agent id（L195）、output 含 agent 身份/子会话 id/最终报告（L185-187） |
| 1.2 | async dispatch accepts every shape and never blocks on questions | **PASS** | execute 全程无 shape 闸（`plugin.ts:1859-1914` 唯一目标判别是 draft 闸与池闸）；question-deny 封印 `src/dispatch-async.ts:17-21` + `:112` 进 create body。测试 `tests/dispatch-wiring.test.mjs:321-337`：write-shape builder 以 async 派发成功（L331），且 **write 子会话同样带 question-deny**（L334 deepEqual 断言） |
| 1.3 | Cross-pool target refused identically to native task | **PASS** | 逐字节一致是**构造性保证**：`plugin.ts:840-865` `poolGateRefusal` 单一函数同时被原生 belt（`plugin.ts:3422`，client）与 forge_dispatch execute（`plugin.ts:1898`，jobClient——同为 `input.client`，`plugin.ts:3091/3096`）调用；拒文案含 `not dispatchable from this session` + 来源池路径 + 三出口（`plugin.ts:859-861`）。测试双侧：dispatch 侧 `tests/dispatch-wiring.test.mjs:201-219`（L213-215 三要素断言）；原生侧未改动的 `tests/hierarchical-pools.test.mjs:469,481,532,540,774,828,853,940` 同锚文案断言全部通过 |
| 1.4 | Workers cannot dispatch | **PASS** | `plugin.ts:103` `forge_dispatch` 入 `FORGE_STATE_TOOLS` → 分区注入对工人隐藏（`plugin.ts:3313`）+ belt（`plugin.ts:3568-3572`）+ execute 内同规则拒绝（`plugin.ts:1882-1886`，同句式 `reserved for the primary forge agent ... calls forge_dispatch at the gate`）。测试 `tests/dispatch-wiring.test.mjs:262-278`：工人（L268-272）与非 forge agent（L273-277）双向拒；分区注入断言 `tests/dispatch-wiring.test.mjs:156-157` |
| 1.5 | Draft-plan interop is shape-gated as on native task | **PASS** | 共享谓词 `draftDispatchRefusal`（`plugin.ts:901-924`）被 belt（`plugin.ts:3483`）与 execute（`plugin.ts:1904`）同源调用；readonly 放行/其他目标拒+名册指引同文案。测试 `tests/dispatch-wiring.test.mjs:292-319`：wait 与 async **两模式同判**——readonly 双模式放行（L303-306），write 双模式拒且文案断言 `Readonly recon scouts ARE dispatchable during draft: forge-dp-research`（L314，与原生同款 roster 指引） |
| 1.6 | Disable knob removes the tool | **PASS** | `plugin.ts:2644-2651`：`forge_dispatch` 仅在 `!forgeDisabled` 时注册；getter `plugin.ts:3371-3373` disable 下返回 `{}`。测试 `tests/dispatch-wiring.test.mjs:161-170` |

### Requirement: Async dispatch lifecycle — 4 场景

| # | 场景 | 结论 | 证据 |
|---|------|------|------|
| 1.7 | Async handle and single completion wake | **PASS** | 句柄三要素（task id/agent/child session）+ END YOUR TURN 纪律：`plugin.ts:1972-1981`；wake 走 job-wake 队列（`jobWakeText` dispatch 分支 `plugin.ts:731-739`，终消息内联）→ idle-only（`plugin.ts:3761-3768` + `deliverJobWakes` `plugin.ts:753-763`）、at-most-once（`src/job-manager.ts:340-350` queued→delivered 单向翻转 + read-consumption `:262-267` 丢弃排队 wake）。测试 `tests/dispatch-wiring.test.mjs:373-399`：**idle 前断言 0 条 wake**（L388，证明 idle-only）→ idle 后恰好 1 条（L390）→ 第二次 idle 边沿后仍 1 条（L396-398，证明 at-most-once），wake 正文含子会话最终报告与 agent 身份（L392-394） |
| 1.8 | Concurrency cap | **PASS** | `ASYNC_DISPATCH_CAP = 3`（`plugin.ts:1777`）；在途统计按 registry `state === "running"`（`plugin.ts:1784-1796`）；拒文案含**在途 task ids 逐个列出** + 指引（等 wake 或 `mode: "wait"`）：`plugin.ts:1906-1913`。测试 `tests/dispatch-wiring.test.mjs:342-362`：3 个 busy 子会话在途，第 4 个拒；L357 `cap 3`、L358 每个在途 id `includes` 断言、L359 `mode: "wait"` 指引断言 |
| 1.9 | Owner death harvests children | **PASS** | `session.deleted` → `jobManager.onSessionEnd`（`plugin.ts:3775`）→ `kill()` 调注入的 `killTree`（`src/job-manager.ts:245-253`）= `abortChild`（SDK abort，`plugin.ts:1964-1966`，**D3：killTree=SDK abort 成立**）+ `orphan-job` 账本（`src/job-manager.ts:318`）；句柄表随收（`plugin.ts:3781-3783`）。测试 `tests/dispatch-wiring.test.mjs:365-370`：`calls.abort.length >= 3`（SDK abort×3）+ 账本 `orphan-job` 恰 3 条（按 jobId 对账）+ 句柄表排空 |
| 1.10 | Wait-mode timeout is honest | **PASS**（附注） | 核心层 `pollChild` timeout 返回 `{status:"timeout", sessionID, timeoutMs}`（`src/dispatch-async.ts:273-275`），超时**不杀**子会话；接线层 `plugin.ts:1936-1941` 抛出文案含**子会话 id**、`inspect or abort it natively in the host TUI`、以及 `No auto-convert to async happened`（**D7 成立**）；默认 600000ms=10 分钟（`src/dispatch-async.ts:186`，README L590 "default 10 minutes" 一致）。测试：核心层 `tests/dispatch-async.test.mjs:205-215` 断言 `poll.sessionID === "ses_stuck"` 与预算值；接线层无超时专项测试（throw 是对 poll 结果的直接插值组合，`created.sessionID` 必然入文）——**附注**：建议发布前补一条 wiring 级超时断言（见发现 N5） |

**小计：10/10 PASS**（1.10 带附注）。

---

## 2. REMOVED 需求（旧禁令）是否被干净取代

**结论：PASS**

- 旧禁令测试已改写而非删除：`tests/forge-subagents-wiring.test.mjs` diff——`native-task surface: no forge_dispatch family is registered anywhere` 改名为 `dispatch surface: forge_dispatch registers under the forge family; the old dispatch-suite family stays gone`，断言从 `tools.forge_dispatch === undefined` 反转为 `assert.ok(tools.forge_dispatch)`，同时保留旧 dispatch-suite 辅助工具（`forge_dispatch_config/_list/_kill/_status`）恒 undefined 的退役断言。
- 无残留禁令逻辑：旧禁令本就是 spec 级要求（无对应实现代码）；全库 grep 无任何 "禁止注册 dispatch 工具" 类残留。live spec `openspec/specs/forge-subagents/spec.md` 的旧需求文本按工作流在**归档时**才移除（AGENTS.md L142-143：先改 delta 再归档、归档需用户明确指示）——当前未归档是正确状态，非残留。
- 原生 task 路径语义零改动：belt 谓词抽公共函数为**纯搬移**——diff 显示拒文案模板字面量逐字相同（removed 行与 `poolGateRefusal`/`crewPendingRefusal`/`draftDispatchRefusal` 内文案 byte 级一致），闸门次序不变（belt：非 forge speaker → 池闸 → crew pending → crew compliance → draft 形状闸，`plugin.ts:3404-3490`）；`draftDispatchRefusal` 的 readonly 判定逻辑与被删除的内联版本逐行等价（diff hunk @@ -3172,40 对照）。**未改动**的原生路径测试套（`tests/hierarchical-pools.test.mjs` 8 处 `not dispatchable` 文案断言、81/81 pass）是行为不变的最强证据。

---

## 3. design.md D1-D7 与实现一致性

| 决策 | 结论 | 证据 |
|------|------|------|
| D1 SDK child sessions（弃 `opencode run` 子进程，无双传输） | **PASS** | 全部生命周期走 `client.session.*`（`src/dispatch-async.ts:47-72`）；无任何 spawn/子进程 fallback（`src/dispatch-async.ts` 零 child_process、零 @opencode-ai import） |
| D2 One tool, two modes（同闸同路径） | **PASS** | 单一 `forgeDispatchTool`，`mode` 参数分流于闸门之后（`plugin.ts:1906/1931`）；两模式过完全相同的闸链（L1898-1905） |
| D3 Job-registry 仅复用生命周期（kind=dispatch 注册行、in-plugin interval poller、非 job-runner 进程、forge_jobs list 集成 non-goal） | **PASS**（附注） | 注册行带 `dispatch` meta（`plugin.ts:1968`）；poller 为 in-plugin 分片循环（`plugin.ts:1809-1841`），无进程；killTree=SDK abort（L1964-1966）。**附注**：dispatch 行天然出现在 `forge_jobs list`（同一 registry 的 `list()` 不分 kind）——设计说"belt stays untouched"指零集成工作量，涌现可见性可接受，但 `forge_jobs log` 对 dispatch 行会指向从不落盘的 logPath（L1960 路径无写入者）——见发现 N4 |
| D4 All-shapes async + question-deny（无阶段拆分；写权限=物化权限表） | **PASS** | 见场景 1.2；draft 互操作不变（readonly-only、双模式，场景 1.5） |
| D5 Primary-only（与 STATE 工具同拒） | **PASS** | 见场景 1.4 |
| D6 Wake 全文内联终消息（无 output-fetch 工具、无 pre-wake 轮询） | **PASS**（附注） | wake 正文 `Final report:
${job.tail.slice(-2500)}`（`plugin.ts:736`）；工具描述含 `NEVER poll ... pre-wake polling is a BLOCKING anti-pattern`（L1846，OMO 教训逐字采纳）。**附注**：`slice(-2500)` 是尾部 2500 字符截断，D6 文字是 "full final message"——dispatch mandates 强制简洁终报，实践中够用，但截断未在设计/README 披露（见发现 N3） |
| D7 wait 超时不自动转 async | **PASS** | 超时文案明示 `No auto-convert to async happened (the dependency structure did not change)`（`plugin.ts:1939`）+ README L590-593 同款披露 |

Spike 结论（design.md L131-179）与实现逐条对得上：create body `{parentID,title,permission}` + `query.directory`（含 OMO 式 untyped `permission` 走 `Record<string, unknown>` duck-typed seam）；`promptAsync` 优先、`prompt` 回退（`src/dispatch-async.ts:159-165`）；终态推断 active={busy,retry,running}（`:24`，OMO parity 含 running 容忍）；终消息=最新 assistant 按 `time.created` 取、text parts 连接（`:192-204,300-304`）；`session.abort`（`:313-319`）。

---

## 4. 边界违例扫描

**结论：PASS（无越界）**

- `package.json`：未改动（git status 干净；版本仍 `0.21.2`——与 tasks.md 第 8 节 release 未勾选一致，版本属 release 阶段）。
- `dist/`：未重建未改动（git status 无 dist 条目；AGENTS 打包红线未触碰）。
- 归档：`openspec/changes/archive/` 无任何改动；变更目录仅含 5 个预期文件（proposal/design/tasks/specs/forge-subagents/spec.md + openspec CLI 自生成的 `.openspec.yaml` 元数据，无害）。
- 工具计数：**实际 18**（5 plan + 6 goal + 2 crew + 1 dispatch + 2 job + 2 search，`plugin.ts:87-111/2622-2653`），与 `tests/search-wiring.test.mjs:40-45` 断言 `Object.keys(h.tool).length === 18` 一致（本次运行通过）；README 未声明数字总数（无矛盾）。**但 `proposal.md:58` 写 "tool count 15 → 16"——算术过时**（搜索对已把基线抬到 17，见 `openspec/changes/archive/2026-11-09-forge-search-tools/tasks.md:13`），与实现/测试的 18 不符（见发现 N1）。
- 契约外文件触碰：`tests/search-wiring.test.mjs` 被改（计数 17→18）——不在声明的实现契约文件清单内，但属本变更的必然连带（计数断言必须更新），改动最小且自证（注释 `15 prior + search pair (17) + forge_dispatch = 18`）。可接受，如实披露。

---

## 5. 测试诚实性抽查（3 个最关键断言）

| 断言 | 结论 | 读码确认 |
|------|------|----------|
| question-deny 进 create body | **真实** | `tests/dispatch-wiring.test.mjs:190` `assert.deepEqual(create.body.permission, [{permission:"question",action:"deny",pattern:"*"}])`——**deepEqual 精确数组**，非 match 子串、非存在性；且 fake client 的 `create`（L50-55）原样记录入参，无伪造路径。write-target 测试 L334 同强度断言；核心层 `tests/dispatch-async.test.mjs:104` 第三处独立复验 |
| 跨池文案与原生一致 | **真实** | `tests/dispatch-wiring.test.mjs:209-218`：断言链含 `not dispatchable from this session`（L213）+ **目标来源池路径小写包含**（L214，`join(dirB,".opencode","forge.json")`）+ `Exits: `（L215）；一致性由共享函数构造性保证（两路径同一 `poolGateRefusal`），原生侧 8 处未改动断言（hierarchical-pools）双保险。非空转：fake client `get` 返回锚定记录（L204），池归属真实解析 |
| wake at-most-once | **真实** | `tests/dispatch-wiring.test.mjs:387-398`：`wakesTo(sid)` 按 `promptAsync` 实际调用体过滤（路径 id + 正文含 `dispatch-complete`）——**计数的是 fake client 收到的真实投递**；三段式：idle 前 0（L388）→ idle 后 1（L390）→ 再触发 idle + 100ms 让步后仍 1（L396-398）。若 at-most-once 破坏（第二次 idle 重复投递），L398 必然失败。且 `waitFor` 前置等待 poller 落定（L386），排除"还没投递"假阳性 |

---

## 6. busy-window 账本溢出覆盖的披露可接受性

**判断：可接受（Acceptable）。**

- 机制归属：投递窗口/溢出弃投是 job-manager 层机制（`src/job-manager.ts:352-360` `abandonStaleWakes` → `wake-timeout` 账本），由**未改动的机制级测试**覆盖——`tests/job-manager.test.mjs:217-226`（注入时钟 `wakeWindowMs:1000`，断言 `wakeState==="abandoned"` + 账本 `wake-timeout` 条目含 `delivery window` 细节）。dispatch 行是普通注册行，溢出语义对它自动成立。
- 接线级为何难覆盖：wiring 的 `jobManager` 在模块作用域以默认 `wakeWindowMs=600000` 创建（`plugin.ts:699-709`），无 env/构造缝可缩窗——wiring 级溢出测试要么等真实 10 分钟，要么为本测试单开一条 test-only 缝（违背"测试缝最小化"的现有风格）。
- 组合路径已被覆盖：dispatch 特有的组合环节（`markTerminal`→`onWakeQueued`→idle-believed 推送 or idle 边沿投递→`jobWakeText` dispatch 分支）由 wake 测试（1.7）与 owner-death 测试（1.9）覆盖；溢出分支不触碰 dispatch 专属代码。
- 建议（非阻塞）：若未来给 wake window 加 env 缝，顺手补一条 dispatch 行的 wiring 级溢出断言即可闭环。

---

## 总判定：**APPROVE-WITH-NOTES**

无阻塞级问题。十条场景全部在实现中真实成立、共享谓词保证双面逐字节一致、原生路径语义零改动有未改动测试套背书、边界（版本/dist/归档）干净、关键断言诚实非空转。

### 发现清单（全部非阻塞）

| # | 级别 | 发现 | 证据 | 建议 |
|---|------|------|------|------|
| N1 | Note（契约文档失准） | `proposal.md:58` "tool count 15 → 16" 过时——搜索对归档后基线已是 17，本变更后实际 18（`tests/search-wiring.test.mjs:40-45` 断言通过） | proposal.md:58；archive/2026-11-09-forge-search-tools/tasks.md:13 | 归档前把 proposal 数字修正为 17 → 18（proposal 属契约文本，避免归档后留下永久性错误陈述） |
| N2 | Note（README 枚举不全） | Agent partition 表的 forge tools 枚举行未列 `forge_dispatch`（派发节已完整描述，但该行枚举 `plan_*, goal_*, crew_*, forge_shell, forge_jobs, forge_grep, forge_glob` 缺新工具） | README.md:73 vs README.md:577-628 | 在该枚举行补 `forge_dispatch` |
| N3 | Note（D6 "full" vs 截断） | dispatch wake 终报截断为尾部 2500 字符（tail 环 8192），design D6 措辞是 "wake carries the full final message"，截断行为未在 design/README 披露 | plugin.ts:736；design.md:90-94 | 或在 design/README 披露上界，或说明 mandates 下 2500 足容 |
| N4 | Note（非目标涌现面） | dispatch 注册行会出现在 `forge_jobs list`（registry 共享），其 `logPath`（`<jobLogDir>/dispatch/<id>.txt`）无写入者——`forge_jobs log` 对 dispatch 行将报文件缺失；async 10 分钟看护到期后 wake 头行说 "finished" 而子会话仍在跑（正文诚实注明 still running） | plugin.ts:1960,1833-1835,735 | 低优先：README 或工具输出加一句 dispatch 行的 belt 语义披露即可 |
| N5 | Note（测试覆盖缺口） | wait 超时场景只有核心层测试（`tests/dispatch-async.test.mjs:205-215`），接线层 throw 组装（含子会话 id 插值与 no-auto-convert 文案）无 wiring 断言 | plugin.ts:1936-1941 | tasks.md 第 8 节 live verify（wait 超时真实宿主）落地时顺带闭环，或补一条 env 缩窗 wiring 测试 |
| N6 | Minor（微竞态，无需行动） | owner 会话在 believed-idle 状态被删除的瞬间，`markTerminal(killed)` 同步触发 `onWakeQueued` → 可能向已删除会话投一条 dispatch-complete wake（onSessionEnd 的 `jobs.delete` 在 kill 之后） | plugin.ts:706-708；src/job-manager.ts:311-323 | 实际后果：发送失败→re-queue→窗口弃投→账本，无害；记录在案即可 |
| N7 | Minor（既有陈旧，非本变更引入） | `AGENTS.md:21` 工具计数 "共 15 个" 在搜索对时期已过时（应为 18） | AGENTS.md L21 | 下次 AGENTS.md 例行维护时修正 |

### 契约切片路径（对照清单）

- `openspec/changes/async-dispatch/proposal.md`、`design.md`（含 Spike conclusions L131-179）、`tasks.md`、`specs/forge-subagents/spec.md`（REMOVED 1 + ADDED 2，共 10 场景）
- `src/dispatch-async.ts`、`src/job-manager.ts`（复用机制证据）
- `plugin.ts`：L80（import）、L87-111（STATE 集）、L729-763（wake 文本/投递）、L782-924（共享闸谓词）、L1766-1983（forge_dispatch 工具）、L2622-2653（注册/disable）、L3091-3096（client seam）、L3404-3490（原生 belt）、L3770-3783（owner-death 收割）
- `tests/dispatch-async.test.mjs`、`tests/dispatch-wiring.test.mjs`、`tests/forge-subagents-wiring.test.mjs`（diff）、`tests/search-wiring.test.mjs`（diff，计数 18）、`tests/hierarchical-pools.test.mjs`（原生回归背书）、`tests/job-manager.test.mjs`（溢出机制背书）
- `README.md` L577-628（派发节）、L796-806（双面共存）、L1125-1149（draft 互操作）
