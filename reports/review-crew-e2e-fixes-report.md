# Review — fix-v2-crew-surface-drift 4.1 E2E 双 bug 修复对账（commit `5518dfe`）

- 日期：2026-11-21
- 审阅人：spec-reviewer（只报告；未改任何源码，未 push）
- 方法：一切源码经 `git show 5518dfe` / `git show 5518dfe^` / `git show HEAD:<path>` / `git grep <pat> 5518dfe` 取证（HEAD == `5518dfe`，`git status` 仅两份未跟踪报告，源码与 HEAD 一致）；测试在仓库实跑。
- 对账对象：`5518dfe` + reports/fix-crew-e2e-bugs-report.md；delta = openspec/changes/fix-v2-crew-surface-drift/specs/crew-harness/spec.md 的 re-anchored 场景 + tasks.md 4.1 注记；实测证据 = reports/e2e-crew-surface-drift-report.md + 修复报告 F5/F6 复测引用。

## 总判决：**CLEAN**（附 1 条非阻断建议）

五个核对要点全部通过；语义判定为**实现细化而非偏差**（见下节），无需先改 delta 即可归档。测试独立复核 788/788 属实。

---

## 1. 语义判定（关键）：**实现细化（implementation refinement），非 delta 偏差**

**判定：delta 的 "authoritative record" 意图 = 会话的最新真实位置；`session.moved` 事件层是其实现手段。三层优先级（moved 事件 > session.get 记录 > 工具上下文/内存绑定）是对 delta 规范意图的兑现与加强，不是对 delta 文本的偏离。无需先改 delta 再归档。**

理由（四条，均有证据）：

1. **delta 用语是需求层的，未绑定具体 RPC 缝。** 场景文本说 "the host session record now carries a pool-owning directory"（openspec/changes/fix-v2-crew-surface-drift/specs/crew-harness/spec.md，delta 场景 "A re-anchored session resolves its roster from the authoritative record"）。真机探针（fix 报告 §Bug 2 诊断 1）证明：宿主 session **store** 反映 move（REST `GET /api/session/:id` 显示 moved 目录，B0/各 driver 复核），陈旧的是**插件可用的 `ctx.session.get` 缝**——它是权威记录的一个 stale 投影，不是权威记录本身。因此 delta 所说 "authoritative record"（宿主对会话的权威记录 = 真实当前位置）在 move 后**确实**携带新目录；`session.moved` 事件（fix 报告诊断 2：sse 逐字 `type:"session.moved", data:{sessionID, location:{directory:<新>}}`）正是插件进程内读到该权威记录最新值的活传输。**"authoritative 意图=最新真实位置，事件层是实现手段" 的读法成立。**
2. **矛盾检验通过：delta 场景所述形状在实现后仍为真、仍被测试。** delta 场景的形状 = 记录带池目录 + 工具上下文陈旧无池、无 move 事件 → 这正是 matrix (f)/(a) 的形状（tests/hierarchical-pools.test.mjs:1568 / :1395），record-first 链原样解析、场景断言全过。实现新增的 fresh-move 形状（记录陈旧、事件新鲜）是 delta 未提及的**覆盖扩展**，与 delta 无任何语句矛盾——delta 没有说"move 只能通过记录反映"，也没有说事件不得参与解析。
3. **规范内容被完整兑现并加强。** 场景 THEN 的两点——"the workspace pool IS the roster"、"the same verdict the dispatch belts give for that session"——在实现里由共享解析器 `resolveSessionAnchorForPools` 一次保证（plugin.ts:1062-1072：moved 声明与记录锚不同 → moved 赢，双向一致）；gate 与 belts 用同一链，判决必然一致。
4. **归档完整性机械检查全过**（详见 §6）：MODIFIED 需求携带 live spec 全部 5 场景**逐字**（标题+正文体，脚本比对 VERBATIM-OK ×5），新增 2 场景，标题零改名。

**非阻断建议（归档前可选，未应用）**：moved-event 层的优先级、双向语义、no-ledger-resurrection、`session.deleted` 驱逐目前只被单测矩阵治理（tests/hierarchical-pools.test.mjs:1498/:1532/:1568），delta 尚无场景直接治理该层。若欲让归档 spec 完全治理已实现行为，可加一个 sibling 场景（建议措辞，**不改现有场景标题/正文**）：

```markdown
#### Scenario: A freshly moved session's roster follows the host's live move statement

- **WHEN** the host emits `session.moved` carrying the session's new directory while the plugin-facing session record seam still reports the pre-move location — the move being into a pooled workspace or out of one
- **THEN** the gate resolves the roster from the moved workspace (the live move statement outranks the stale record seam; moving into a pool gains its roster, moving out loses it with the honest unconfigured refusal) — neither the pooled-map preference nor the resume ledger resurrects the abandoned workspace's pool
```

## 2. Bug 1（arm-only `crew_begin` schema）：✅ 通过

- `subtasks` 加 `.optional()` + describe 澄清：plugin.ts:4158（`})).optional().describe("The declared subtask plan (REQUIRED on registration, ABSENT on the arm call) — …")`）。
- 与工具描述 arm-only 语义一致：plugin.ts:4151 描述原文 "called with {execution} ONLY (no objective/subtasks) it ARMS the pending crew"；schema 现在放行该调用形状；注册期的 objective/subtasks 强制仍在 execute 内（描述 "Refuses: … missing/duplicated subtasks"，plugin.ts:4151；E2E A-1/F5 已证注册路径强制在位）。
- schema 断言测试：tests/v2-tools.test.mjs:99-114 —— `subtasks.type === "array"`、`required` 不含 `subtasks`/`objective`/`execution`/`lineage`、`required.length === 0`（v2 翻译即宿主校验所对形状）。实跑通过。
- 真机复测引用：fix 报告 §Bug 1 复测（driver-final F6 逐字 "Crew ARMED for supervised waves: moved back"）。

## 3. 回归矩阵 (d)/(e)/(f)：✅ 全部真断言、实跑通过

三测试位于 tests/hierarchical-pools.test.mjs:1498 / :1532 / :1568，均 mock 真机形状（`recordInput` 的 session-get 记录返回 **move 前**位置——正是 fix 报告诊断 1 实测的 stale-get 形状）：

- **(d) :1498**（move 进池）：记录与工具上下文都是 dirPlain（无池、move 前），`session.moved` 事件 → dirPool。断言：输出匹配 `/forge-crewd-research/`、**不含** "CREW IS NOT INITIALIZED"、crew 记录落在 `<dirPool>/.opencode/crew`（existsSync 实查）。✅ 注册成功 + 名册=新池 + 落盘位置=新工作区。
- **(e) :1532**（move 出池）：记录 + `bindSession` 内存绑定都是 dirPool（陈旧有池），事件 → dirPlain。断言：`crew_begin` **rejects**，错误匹配 `/CREW IS NOT INITIALIZED/` 且**不含** "crewe"（被弃池的 namespace 不出现在拒文案）。✅ 诚实失去资格，pooled-preference/ledger 零复活。
- **(f) :1568**（无 move 事件）：记录=dirPool、上下文=launchDir、无事件。断言：名册 `/forge-crewf-research/`（record-first 链 = matrix (a) 语义原样）。✅ "字节等价旧行为"双证：结构上无事件时 `sessionMovedAnchors.get(sessionID) ?? ""` 得 `""`，新分支（plugin.ts:1062-1072）整体短路；其余新增行仅 env 门控 probe（默认 no-op）——无事件代码路径与修前逐字节等价（代码检视），行为等价由 (f) 实跑钉死。
- 实跑：`node --test tests/hierarchical-pools.test.mjs tests/v2-tools.test.mjs` → **tests 64 / pass 64 / fail 0**；(d)/(e)/(f) 三条单独可见 pass 标记。

## 4. 红线：✅ 全部在位

| 红线 | 证据 | 判定 |
|---|---|---|
| FORGE_ANCHOR_PROBE env 门控默认关 | 全部调用点门控：plugin.ts:1046、:1049（`if (process.env.FORGE_ANCHOR_PROBE)`），函数体 :1023-1029 仅在被门控调用时落盘；全仓引用仅 plugin.ts + dist/index.js:17962-17979 + fix 报告三处（`git grep FORGE_ANCHOR_PROBE 5518dfe`）——tests/README/schema 零引用 | ✅ 不污染正常面 |
| moved 锚 map 的 session.deleted 驱逐 | `harvestSessionEnd`（plugin.ts:4958）内 :4996-4997 删除 `sessionMovedAnchors` + `anchorMovedNotes`；v1 钩子 :5841、v2 :6988 均将 deleted 路由进 `harvestSessionEnd`（commit diff 上下文：两个 deleted 分支紧邻各自新增 moved 分支之前） | ✅ 在位 |
| 双向 move 披露 + 不复活 ledger | 新分支在 `resolveAnchorViaLedger` 可达之前 `return moved`（plugin.ts:1062-1072），注释明示 "No ledger consult on this branch"；入池 (d) 过、出池 (e) 拒；披露为一次性 `console.warn`（`anchorMovedNotes` 有界，:1064-1069） | ✅ 双向一致 |
| D0 零持久化 | `sessionMovedAnchors`/`anchorMovedNotes` 纯内存 Map/Set（:259-260）；`noteSessionMoved`（:265-277）只 `Map.set` + 按非退化规则刷新既有内存绑定；diff 无任何新增落盘 | ✅ |
| 并行边界 | `git show 5518dfe --stat` 仅 6 文件：dist/index.js、tasks.md、plugin.ts、fix 报告、两测试文件——forge-config/schema/package.json/README 零触碰 | ✅ |

另：fix 报告的两条如实披露（复测轮 get 缝恰返回 ws 故 stale-read 未重演、由 (d)/(e) 在解析器层钉死；move 到无插件目录时宿主卸载工具面 F3）与 E2E 报告（reports/e2e-crew-surface-drift-report.md:87-119，B-2/B-3 FAIL 冻结现场 → 本 commit 修复）相互印证，证据链闭合。

## 5. 788/788 独立复核：✅ 属实

- **全量实跑**：`npm test`（= `node --test tests/*.test.mjs`，package.json scripts.test）→ `# tests 788 / # pass 788 / # fail 0`（duration 16132ms）。
- **受影响文件实跑**：两文件 64/64（见 §3）。
- **784+4 佐证**：`git diff 5518dfe^ 5518dfe --stat -- tests/` = 纯增量 124 行、零删除；`^test(` 声明计数 hierarchical-pools 54→57（+3 matrix）、v2-tools 6→7（+1 schema），全仓 782→786，**差值恰 +4**（与 runner 784/788 的恒差 2 为 grep 模式对非行首声明的固定偏差，两侧一致）。788 − 4 = 784 基线成立，零回归。

## 6. delta 归档完整性（角色职责附加检查）：✅

- MODIFIED 需求 "Unconfigured crew initialization gate" 携带 live spec（openspec/specs/crew-harness/spec.md）该需求全部 **5 个场景逐字**（标题 + 正文体，逐行规范化后脚本比对，VERBATIM-OK ×5：Unconfigured /crew refuses…、AI-assisted configuration…、A workspace file the host cannot see…、The configuration invitation lives only…、A configured crew bypasses the gate）。
- 新增 2 场景：A re-anchored session resolves its roster from the authoritative record；A fresh install with only a per-project pool enters crew。标题零改名（归档键完好）。
- 需求 ≥1 WHEN/THEN 场景 ✅（7 个）；设计决策可测 ✅（moved 层由 (d)/(e)/(f) 实测治理，schema 修复由 v2-tools:99 治理）。
- tasks.md 4.1 注记（openspec/changes/fix-v2-crew-surface-drift/tasks.md，5518dfe +7 行）与实现/报告陈述一致。

## 结论

**CLEAN。** 双 bug 修复与 delta 意图语义对账成立（实现细化，事件层是 "authoritative=最新真实位置" 的实现手段）；Bug 1、矩阵 (d)/(e)/(f)、五条红线全部核实；788/788 独立复跑属实。唯一建议为非阻断的可选 delta 加强（§1 的 sibling 场景措辞，未应用）。

— 审阅过程副产品：临时比对脚本 `C:/Users/Soren/AppData/Local/Temp/opencode/spec-diff-check.ps1`（预批准 temp 目录，仓库外）。仓库内唯一写入 = 本报告文件。
