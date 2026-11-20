# review — fix-v2-crew-surface-drift 实现与 spec delta 对账报告

日期：2026-11-21 · 仓库：opencode-forge（HEAD = `196203c`）· 审阅者：spec-reviewer subagent · 只报告，未改任何代码/spec。

## 总判决

**ISSUES（1 项）— 但仅限流程红旗；spec ↔ 实现 ↔ 测试三方对账轴本身 CLEAN，零阻塞偏差。**

| # | 判定 | 事项 |
| --- | --- | --- |
| 红旗 | **ISSUES** | **三个实现 commits 已被 push 到 GitHub（origin/main = `196203c`），实现报告自述"未 push、未 publish"已失实。** reflog 铁证：`git reflog show origin/main` → `196203c ... @2026-11-21 05:00:20 +0800: update by push`；三个 commits 创建于 04:59:05，push 发生在 1 分钟后。`git branch -r --contains 7d7a497` → `origin/main`。npm 侧无版本 bump（package.json 仍 0.28.0），publish 大概率未发生。处置权在主会话（tasks 4.2 写明发版等用户批准；报告落盘时点的自述与仓库最终状态不一致）。 |
| 对账轴 | **CLEAN** | 两个 MODIFIED requirement 全部 14 个场景（10 承接 + 4 新增）逐场景 VERIFIED；D1-D3 绑定决策全落实；三条红线（D0 零持久化 / v1 server() 最小改动 / stateForBan 坑）核实通过；7 新测试与 delta 场景一一对应；`node --test` 实测 **742 pass / 0 fail**，`tsc --noEmit` exit 0，`openspec validate` valid。 |

---

## 0. 对账对象与方法

- 规范侧：`openspec/changes/fix-v2-crew-surface-drift/`（proposal/design/tasks/两份 delta spec），live specs（`openspec/specs/crew-harness/spec.md`、`openspec/specs/forge-subagents/spec.md`）。
- 实现侧：commits `7d7a497`（plugin）/`5f517c0`（tests）/`196203c`（docs），逐 hunk 读全；实现报告 `reports/implement-crew-surface-drift-report.md`。
- 探针交叉：`openspec/changes/harden-dispatch-resilience/probe-1.1-evidence.md`（只读核对）。
- 方法：forge_shell（PowerShell）逐 hunk 比对 + forge_grep 落点定位 + 场景块 verbatim 逐字 diff（whitespace 归一）+ 测试套件/typecheck/openspec validate 实跑。
- delta 完整性前置检查：**两个 MODIFIED requirement 均携带全部 live 场景且逐字一致**（crew-harness 5/5、forge-subagents 5/5 全部 VERBATIM，含场景标题未改名）；新增场景各 2 个。forge-subagents 需求正文与 live 的差异仅两处预期改写（父目录"resolved from the authoritative session anchor"插入语 + guarded shape probing/诚实降级新条款），live 原有条款零丢失。

## 1. crew-harness — "Unconfigured crew initialization gate"（7 场景）

| 场景 | 判定 | 证据（代码位置 / 测试名） |
| --- | --- | --- |
| Unconfigured /crew refuses with initialization guidance（承接） | VERIFIED | 门输出文案 `plugin.ts:3939-3944`（两层/同意规则/hot-apply）+ /crew 纪律文案 `plugin.ts:3823-3830`；测试 `forge-subagents-wiring.test.mjs:555`（"unconfigured is a HARD gate with initialization guidance"）、`:637`（"HARD initialization gate — empty agent set refuses with guidance"）、`hierarchical-pools.test.mjs:1457`（matrix b 无 client 拒绝路径断言） |
| AI-assisted configuration writes short role prompts（承接） | VERIFIED | 指导文案逐要素齐：SHORT prompt（"one or two sentences; long only on explicit request"）+ 显式 shape + 顶层 `pool` namespace + 同意规则，`plugin.ts:3944` 与 `:3830`；测试 `forge-subagents-wiring.test.mjs:555/:637` 断言指导存在 |
| A workspace file the host cannot see is disclosed, not masked（承接） | VERIFIED | `crewBeginTool` 会话锚定发现与 residual mismatch 披露路径（`plugin.ts:3899-3990` 区段）；测试 `forge-subagents-wiring.test.mjs:681`（"a workspace forge.json the host cannot see is DISCLOSED, not masked"）、`:708`（mismatch-explaining refusal） |
| The configuration invitation lives only in the /crew gate（承接） | VERIFIED | 邀请文案仅存在于门/模板两处字符串（`plugin.ts:3823-3830`、`3939-3944`；全库无其他表面携带"configure it yourself"邀请）；工具描述内容被 `dispatch-wiring.test.mjs:173`（registration 测试）钉死为决策指导/防轮询纪律、无配置邀请 |
| A configured crew bypasses the gate（承接） | VERIFIED | 门仅在 roster 空时触发（`plugin.ts:3907` resolvePools → 空才拒）；测试 `hierarchical-pools.test.mjs:578`（注册输出会话域 roster）、`forge-subagents-wiring.test.mjs:952`（crew record 正常注册）、matrix (a)/(c) 注册通过即隐含 |
| **A re-anchored session resolves its roster from the authoritative record（新增）** | VERIFIED | `plugin.ts:3918-3922`：`sharedAnchorClient()` 有 `session.get` → `resolveSessionAnchorForPools(anchorClient, sessionID) \|\| sessionAnchor(context)`，否则纯 `sessionAnchor(context)`；绑定 `ensureSession` `:3925`；crew 记录路径 `anchorDir = anchor \|\| hostWorktree` `:4052`；测试 `hierarchical-pools.test.mjs:1395` matrix (a)（live 事故回归：record 指池目录/工具上下文指无池 launch 目录 → 注册通过 + `.opencode/crew` 落权威工作区 `:1427-1428`） |
| **A fresh install with only a per-project pool enters crew（新增）** | VERIFIED | 测试 `hierarchical-pools.test.mjs:1467` matrix (c)：空 `FORGE_TEST_FORGE_HOME`（机器无全局 forge.json）+ 仅工作区池 → 过门注册 + 断言全局层文件不存在（D3）；matrix (a) 亦跑空 home 轴 |

## 2. forge-subagents — "Task shadow surface (native name, forge engine)"（7 场景）

| 场景 | 判定 | 证据 |
| --- | --- | --- |
| A forge dispatch renders in the native task panel（承接） | VERIFIED | `task` 名下注册 `taskDispatchTool`（`plugin.ts:2978+`）；测试 `dispatch-wiring.test.mjs:173`（"task is OUR dispatch surface..."）、metadata 断言 `:1402`（`r.metadata.agent === "forge-dp-research"`） |
| Non-forge targets keep native dispatch parity（承接） | VERIFIED | 非 forge 分支 `plugin.ts:3034-3042`（同引擎、无池闸、未知 host agent 诚实拒）；测试 `dispatch-wiring.test.mjs:396/:412/:424`（sync 无 question-deny / async 带 deny / 非 forge 调用者对等） |
| Question policy is mode-keyed（承接） | VERIFIED | `createChildSession` questionDeny 分支（`src/dispatch-async.ts:155-160`，双拼写 `permission`+`permissions`）；测试 `dispatch-wiring.test.mjs:230`（sync 无 deny）、`:412`（async deny）、`dispatch-async.test.mjs:142-146` |
| Sync abort parity（承接） | VERIFIED | `abortChild`/poll 环路（`dispatch-async.test.mjs:329-378` 引擎侧）；测试 `dispatch-wiring.test.mjs:454-467`（"abort parity: a sync dispatch aborted mid-flight aborts the child via the SDK..."）。注：2.3.2 v2 面的 abort 缺口是范围外前存问题，见 §6 |
| forge_dispatch is retired（承接） | VERIFIED | 测试 `dispatch-wiring.test.mjs:173/189`、`forge-subagents-wiring.test.mjs:209-223`、`search-wiring.test.mjs:53`（`h.tool.forge_dispatch === undefined` + 词表剔除） |
| **A moved child-creation seam adapts by probing（新增）** | VERIFIED | 守卫式探测 + 适配层：`v2SessionClient` create 适配 `plugin.ts:6539-6569`（`typeof s.create === "function"` 探测 → v1 `{body,query}` 译扁平单对象 → 裸记录回包 `{data}` 信封）；类型面 `V2PluginContext.session.create?` `plugin.ts:5748-5752`；`createChildSession` 双形状响应解析（信封/裸记录，`src/dispatch-async.ts` 改后体）；父目录权威锚 `plugin.ts:3078-3083`。测试 `v2-tools.test.mjs:160`（扁平入参落根对象、无 body/query 信封、权威 directory、裸记录解析）+ mock 缝 `tests/lib/v2-mock-context.mjs:146-153` |
| **An absent create seam degrades honestly（新增）** | VERIFIED | 入口守卫 `plugin.ts:3072`：`typeof client.session?.create !== "function"` → `throw new Error(TASK_SEAM_DEGRADED_ERROR)`（先于任何 client 解引用，绝无裸 TypeError）；契约常量 `plugin.ts:2967-2968`；引擎侧哨兵 `src/dispatch-async.ts:142`（`TASK_CREATE_SEAM_ABSENT`）+ `:151` 前置守卫（absent/null client 同判）。测试 `dispatch-wiring.test.mjs` 新增（文件尾，"task client guard: absent session.create seam -> the EXACT honest degradation contract string..."）+ `dispatch-async.test.mjs:179`（哨兵精确断言） |

## 3. design D1-D3 绑定决策核对

### D1 — 锚统一 + 无 client 精确回退（守卫链逐行）

- 共享锚缝：`AnchorClient` 类型 + 模块态 `anchorClientShared` + `sharedAnchorClient()`，`plugin.ts:766-780`（diff hunk `@@ -763,6 +763,15`）；种子时机=皮带今天拿到的时机：v1 `server()` `plugin.ts:4753`（`jobClient = input.client` 同源一并 seed）、v2 `v2Setup` `plugin.ts:6937`（`v2AnchorClient(ctx)` 同值喂 `v2RegisterToolHooks`）。
- crew 门守卫链 `plugin.ts:3918-3922`：`anchorClient && typeof anchorClient.session?.get === "function" ? (await resolveSessionAnchorForPools(...)) || sessionAnchor(context) : sessionAnchor(context)`。**无 client 分支与被替换的旧行 `const anchor = sessionAnchor(context)`（diff `-3867` 原文）逐字等价** — "精确回退今天行为"成立。
- task 工具守卫链 `plugin.ts:3078-3083`：无 client 分支 `sessionAnchor(context) || context.worktree` ≡ 旧 `worktreeFor(context)`（`plugin.ts:1201-1204` 的定义就是 `sessionAnchor(context) || context.worktree`）；旧调用经 `worktreeFor` 携带的 `noteToolAgent` 副作用仍保留在入口 `plugin.ts:2987`。
- 语义不变量：`resolveSessionAnchorForPools`（`plugin.ts:981-1022`）即 dispatch 皮带同一函数（belt 调用点 `:1061`、`:1104`），pooled-map 偏好（`:1006-1020`）与 ledger rebind（`:1033-1050`）原样携带 — 门与皮带同链同输入同判决。

### D2 — 缺缝契约串（逐字）

- 常量 `plugin.ts:2967-2968`：`"[forge:dispatch] child-session creation is unavailable on this host (the client exposes no session.create seam) — use the NATIVE task tool as the dispatch surface for subagent dispatches."` — 指名 native task tool ✓。
- 契约测试（`dispatch-wiring.test.mjs` 新增）：`assert.equal(String(err?.message ?? err), TASK_SEAM_DEGRADED_ERROR)`（与导出常量逐字相等——错误消息无包装/前缀）**加** `assert.match(..., /NATIVE task tool/)`（语义锚，防常量文本漂移）。见 §7 观察 O1：测试未把完整字面量硬编码（identity 断言 + 语义正则的组合）。
- 绝不裸 TypeError：入口守卫（`:3072`）与引擎前置守卫（`dispatch-async.ts:151`）都在任何 `client.session.create(...)` 调用之前；测试以 absent seam / null client 两个形状断言哨兵路径。

### D3 — fresh-install 验收形状

- 单测级：matrix (c)（空 home + 仅工作区池过门 + 全局层文件不存在断言）+ matrix (a) 的空 home 轴 — VERIFIED。
- 提案级 "Acceptance shape"（沙盒 E2E 全 crew 闭环 + re-anchored 场景）= tasks 4.1，**公开未打勾**，留给后续波次 — 非偏差（任务状态与报告一致）。

## 4. 红线核对

| 红线 | 判定 | 证据 |
| --- | --- | --- |
| D0 零持久化继承（不写用户 config/forge.json 域外） | VERIFIED | `git diff da1375b..196203c -- plugin.ts src/dispatch-async.ts` 中新增行扫描 `writeFile/appendFile/mkdirSync/rmSync/unlinkSync/writeSync` → **零命中**（三 commits 未新增任何 fs 写原语；本改动唯一磁盘写入仍是既有 crew 记录路径，工作区 `.opencode/crew/` 域内）；工作区状态仅两个未跟踪报告文件 |
| v1 server() 路径除共享锚 seed 外零改动 | VERIFIED | `git show 7d7a497 -- plugin.ts` 全部 hunk 逐一如数：server() 函数体内仅 `@@ -4695,6 +4747,10 @@` 一处（1 行代码 `anchorClientShared = ...` + 3 行注释）。其余 hunk 均在模块层共享物：import（行 1）、锚缝模块态（763）、契约常量（2963）、`taskDispatchTool`（3064，v1/v2 双注册的共享工具——本 change 的改造主体，spec 明文要求权威父目录与守卫作用于该表面）、`crewBeginTool`（3905，同上）、v2 类型/适配器/v2Setup（5748/6501/6519/6933）。server() 初始化路径本身零行为改动 |
| stateForBan 预绑定坑守卫 | VERIFIED（结构成立）+ 出处存疑（O3） | 排序：`crewBeginTool` 先 `stateForBan(context.sessionID)`（`plugin.ts:3889`，draft 检查，可能把未知会话 seed 到 `hostWorktree`）→ 再权威解析（`:3918-3921`，resolver 读 `sessions` map 的 `mapped`，即可能刚被 seed 的 launch 目录——**与皮带在 tool.execute.before 里读到的同一 map 同一输入**，门/皮带判决一致正是 D1 目标）→ 终态 `ensureSession(context.sessionID, anchor)`（`:3925`）以非退化锚**覆写**预绑定（`ensureSession` 覆写语义 `plugin.ts:1173-1174`：非退化 worktree 必覆盖既有绑定）。pooled-map 偏好仅当 `mapped` **拥有池**才可能胜出（`:1006-1011`），launch 目录 seed 只在 launch 目录本身有池时起作用——同皮带。matrix (a)/(b) 双向钉死。task 工具侧同构（`:2987` noteToolAgent → `:3083` ensureSession 重绑） |
| probe-1.1 证据只读引用（另一 change 域） | VERIFIED | `git log -- openspec/changes/harden-dispatch-resilience/probe-1.1-evidence.md` 最后触达 = `da1375b`（该 change 自己的 commit），三个实现 commits 零触碰；实现报告对 probe 形状的转述（create 存在/扁平单对象/裸记录/双拼写 permissions/ctx 无 client/无 status·messages·abort）与证据文件逐点一致（`probe-1.1-evidence.md:59-82, 100-105`） |
| 未 push / 未 publish | **VIOLATED（红旗）** | 见总判决。reflog：origin/main 于 2026-11-21 05:00:20 +0800 `update by push` 至 `196203c`（commits 创建于 04:59:05）；`origin/main == main == 196203c`，`git branch -r --contains 7d7a497/196203c` → origin/main。实现报告"未 push"自述在落盘时点为真、现已被后续 push 事件否定——报告自述与仓库终态失实 |

## 5. 测试覆盖对账

**7 新测试名（`git show 5f517c0` 的 `+test(` 精确 7 条）↔ delta 场景映射：**

| # | 测试（文件:行） | 对应 delta 场景 |
| --- | --- | --- |
| 1 | `createChildSession seam guard ... TASK_CREATE_SEAM_ABSENT sentinel ... BARE-record response resolves`（dispatch-async.test.mjs:179） | absent-seam（引擎层哨兵 + null client + 裸记录解析） |
| 2 | `task client guard: absent session.create seam -> the EXACT honest degradation contract string, never a raw TypeError`（dispatch-wiring.test.mjs 文件尾） | **absent-seam（工具层契约串逐字）** |
| 3 | `task client guard: child creation parent directory resolves from the AUTHORITATIVE anchor`（dispatch-wiring.test.mjs 文件尾；`calls.create[0].query.directory === dir` :1402 区） | moved-seam 的权威父目录半边 + task 2.3 |
| 4 | `crew anchor matrix (a): the authoritative pool-owning record beats a stale pool-less tool context`（hierarchical-pools.test.mjs:1395） | **crew-harness re-anchored 场景**（live 事故回归化） |
| 5 | `crew anchor matrix (b): with NO client the resolution is EXACTLY today's`（hierarchical-pools.test.mjs:1432） | D1 无 client 精确回退（re-anchored 场景的反向保障：无 client=今天判决） |
| 6 | `crew anchor matrix (c): fresh install — ONLY a workspace pool, no global layer anywhere`（hierarchical-pools.test.mjs:1467） | **crew-harness fresh-install 场景（D3）** |
| 7 | `v2 task dispatch ... the 2.3.2 promise-layer create seam adapts — FLAT create input, bare record resolved, anchored parent directory`（v2-tools.test.mjs:160） | **moved-seam（适配层全链：扁平入参/裸记录/权威 directory）** |

**基线与零回归（实测）：**
- `npm test`（node --test tests/*.test.mjs，job j-20261120-210431）→ **pass 742 / fail 0 / cancelled 0 / skipped 0**，duration 14.3s。742 = 735 基线 + 7 新测试（`5f517c0` 恰好 7 条 `+test(`，无删除——`git show --stat` 各文件纯新增），全量绿即零回归。
- `npx tsc --noEmit` → exit 0（仅 npm config 无关警告）。
- `npx openspec validate fix-v2-crew-surface-drift` → "Change 'fix-v2-crew-surface-drift' is valid"。

## 6. 实现报告遗留的归类（对账要求 5）

**遗留表述**：2.3.2 session 域无 `status/messages/abort`，task 工具的轮询/收割面在 2.3.2 上仍走既有诚实退化（stream-lost/timeout），创建面（本 change 域）已修复；poll 面适配属 harden-dispatch-resilience 或后续 change。

**归类：范围外（且三处文档自洽）。** 依据：
- 两个 MODIFIED requirement 的 4 个新增场景全部是 crew 门锚（2）与 create 缝（2）——**无一触及 poll/status/messages/abort**；live 需求里涉及 poll 的条款被逐字承接、未修改（§0 的正文 diff：仅权威父目录插入语 + guarded-probe 两处改写）。
- 边界在案：design.md:69-74 明文记录 2.3.2 ctx.session 方法面"NO promptAsync, NO status, NO messages, NO abort — dispatch polling stays on the existing degraded paths; that is a separate change's domain"；probe-1.1-evidence.md:63-64 的方法面 dump 佐证；实现报告"遗留给 4.1"如实披露。
- 附带注记（范围外、前存）：承接场景 "Sync abort parity" 的 SDK abort 调用在 2.3.2 v2 面（`ctx.session` 无 `abort`，仅 `interrupt`）同样受此缺口影响——该条款本 delta 未触碰、缺口先于本 change 存在、且已被 design/implement 报告划入 harden-dispatch-resilience 域。主会话如需可将其显式记入该 change 的 proposal。

## 7. 观察项（非阻塞，处置权在主会话）

- **O1 契约串断言形态**：absent-seam 契约测试断言"错误消息 === 导出常量 + /NATIVE task tool/ 正则"，未把完整字面量硬编码进测试。identity 断言保证了消息无包装逐字回传（满足场景的 "exact string"），正则锚住"指名 native task tool"语义；但常量文本本身的漂移只能靠正则兜底。可选加固：测试内联完整字面量。实现报告"逐字契约断言"的表述对 identity 断言成立，但读者可能理解为字面量硬编码——措辞略强。
- **O2 承接场景的测试粒度**："The configuration invitation lives only in the /crew gate" 无专门负向测试（依赖全表面文案巡检）；现有 registration/description 断言间接覆盖。前存状态，非本 change 引入。
- **O3 stateForBan 出处**：dispatch prompt 称"reporter 提到的 stateForBan 预绑定坑守卫"，但全库 `*.md`（含实现报告、change 目录、reports/）grep `stateForBan|预绑定|pre-bind` **零命中**——该"提到"无可定位的书面出处。守卫本身经代码级分析成立（§4 红线表）；若主会话确有此记载，建议补进实现报告以免口径漂移。
- **O4 报告时点性失实**：实现报告"commits（未 push、未 publish）"在报告落盘时点为真，现已被 05:00:20 的 push 否定（红旗详证见 §4）。若保留报告原貌，建议主会话补一行勘误注记而非改写历史自述。

## 8. 结论

1. **spec ↔ 实现对账：CLEAN**。两个 MODIFIED requirement 携带全部 live 场景逐字一致 + 各 2 新场景全部有实现落点与测试；D1（含无 client 精确回退守卫链）、D2（契约串指名 native task tool、双守卫绝不裸 TypeError、扁平/裸记录/双拼写适配）、D3（fresh-install 单测级）全落实；红线 D0/v1 server()/probe 只读全部核实。
2. **测试：CLEAN**。7 新测试 ↔ 4 新场景 + 3 守卫半边一一对应；742/0 实测零回归；typecheck/validate 双绿。
3. **遗留归类：poll 面范围外**，design/report/probe 三处自洽；"Sync abort parity" 的 2.3.2 v2 缺口为前存范围外项，建议随 harden-dispatch-resilience 显式立案。
4. **唯一 ISSUES：push 红旗**——origin/main 已含三个实现 commits（reflog 实证 05:00:20 push），与实现报告"未 push"自述及 tasks 4.2"发版等用户批准"的流程姿态相悖。是否追认/回滚/补流程，处置权在主会话。

## ���Ự���������쳷����

push ʱ���߳��壺����ʵ�� commits �����Ự�� 05:00:16��job j-20261120-210016���� da1375b ͳһ������Զ�ˡ�����ʱ������ commit ����㱨��04:59 ǰ����ʵδ push������Ϊʱ����ᣬ�ǳ������⣬������O3��stateForBan �������ʣ�Ϊ�۲켶��ʵ���������Ѻ�ʵ���������ĵ����ʲ��ɶ�λ����׷��
