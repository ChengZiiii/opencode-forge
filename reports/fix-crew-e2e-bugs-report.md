# Fix Report — fix-v2-crew-surface-drift tasks 4.1 appendage（E2E 发现的两实现 bug）

- 日期：2026-11-21（UTC 2026-11-20 21:46–22:08）
- 仓库：`opencode-forge`（HEAD 起 `fa60337`）
- 沙盒：`C:/Users/Soren/AppData/Local/Temp/opencode/crew-e2e/`（沿用 E2E 隔离配方：`OPENCODE_TEST_HOME` + `OPENCODE_DB` + serve CWD=ws；模型端点真实可用）
- 新驱动脚本（留工作区根可复跑）：`crew-e2e-driver-zz.mjs` / `crew-e2e-driver-zz2.mjs` / `crew-e2e-driver-b3.mjs` / `crew-e2e-driver-b4.mjs` / `crew-e2e-driver-final.mjs`
- 原始证据：`<T>/logs/`（driver-*.log、anchor-probe.jsonl、sse-*.jsonl、serve-final.log、msgs-raw.json）

## Bug 1 — arm-only `crew_begin {execution}` 被宿主 schema 拒

**根因**：`plugin.ts` crewBeginTool 的 `subtasks: tool.schema.array(...)` 缺 `.optional()`（E2E A-2 逐字证据："Invalid arguments for tool crew_begin - subtasks: Missing key"），与工具描述 "called with {execution} ONLY (no objective/subtasks) it ARMS" 直接矛盾——arm-only 路径在 v2 宿主 schema 层不可达。

**修法**（`plugin.ts` crewBeginTool args）：`subtasks` 加 `.optional()`，describe 文本补明 "REQUIRED on registration, ABSENT on the arm call"。现在 crew_begin 无任何 required 参数（注册期 objective/subtasks 语义仍在 execute 内强制，E2E 已证）。

**测试**：`tests/v2-tools.test.mjs` 新增——`crew_begin` 的 v2 JSON Schema 翻译（即宿主校验所对的形状）断言 `subtasks`/`objective`/`execution`/`lineage` 全部不在 required、`required` 为空。

**复测（真机）**：driver-final F6 — arm-only `crew_begin {execution:"waves"}` 通过宿主 schema 并实际武装，逐字输出：

```
[forge:crew] Crew ARMED for supervised waves: moved back
Waves auto-advance on session idle until crew_close …
```

## Bug 2 — session move 后锚不重解析

### 诊断（真机逐层探针）

本轮用只读探针工具（沙盒专用 zz-probe 插件）+ 仓库内 env 门控诊断缝（`FORGE_ANCHOR_PROBE=<file>`，`resolveSessionAnchorForPools` 落盘原始输入）实测 2.3.2：

1. **`ctx.session.get` 不反映 move**（判决性方向探针 zz2 + E2E 事件流比对）：REST `GET /api/session/:id` 反映 move（B0/各 driver 均复核），但插件可用的 `ctx.session.get({sessionID})` 在真实 `POST /api/session/:id/move` 之后仍返回 **pre-move** 的 `location.directory`（zz2：REST=dirA，get 返回 ws）。即"权威记录"锚链的最高层在 moved 会话上是**陈旧**的——这正是 E2E B-2/B-3 拒文案仍引 dirA 的根因。
2. **宿主 emits `session.moved` 事件，载荷含新 location**（sse 日志逐字：`type:"session.moved", data:{sessionID, location:{directory:<新>}}`）——插件进程内唯一可见的"当前工作区"实时声明，但插件此前从未消费它。
3. 澄清两点 E2E 时的误判：(a) E2E B-1 的 dirA 拒绝来自 B0 的 move（绝对正斜杠 500-but-applied），不是创建参数；(b) move 到无插件目录时宿主会**卸载会话的工具面**（driver-final F3 逐字："crew_begin is no longer available… I have worktree_create / session_move"）——宿主面行为，如实记录。
4. `effectiveWorktree` 的 worktree-priority 分支**不是**根因：2.3.2 记录无 worktree 字段（GET 形状 `{id,projectID,cost,tokens,time,location}`），锚取自 `location.directory`。

### 修法（`plugin.ts`，最小修复）

- 新增模块态 `sessionMovedAnchors: Map<sessionID, movedDirectory>`（`session.deleted` 随 `harvestSessionEnd` 逐出，bounded disclosure `anchorMovedNotes` 同步逐出）。
- 事件接线**双侧**：v1 `event` 钩子与 v2 `v2SubscribeEvents` 各加 `session.moved` 分支（容错解析 v1 properties / v2 flat-data 两种载荷形状；`noteSessionMoved` 同时按非退化规则刷新内存 session map 绑定，使无 client 回退路径同享重锚）。
- `resolveSessionAnchorForPools` 新增最高优先分支：**moved 声明存在且与记录锚不同 → moved 赢**（有界披露一次），且该分支**不走 ledger 复活**（deliberate move 不得被 resume ledger 拉回旧池——那是 restart-resume 形状的机制）。双向语义一致（POOLS follow workspaces：移入池获得池权、移出池失去池权）。无 move 事件时链路与今天逐字节等价（matrix (f)）。
- 附带：`v2WiringSeam` 暴露 `sessionMovedAnchors`（测试缝）；诊断缝 `FORGE_ANCHOR_PROBE` 保留（env 门控，默认关）。

### 测试（真机形状回归矩阵，`tests/hierarchical-pools.test.mjs`）

- **matrix (d)**（E2E B-2/B-3 形状的回归）：session.get 记录与工具上下文都仍是旧的无池目录、只有 `session.moved` 事件知道新池目录 → crew 注册过、名册=新池、crew 记录落新工作区、无 "CREW IS NOT INITIALIZED"。
- **matrix (e)**：记录与内存绑定都是有池目录、moved 事件指向无池目录 → 拒（诚实失权），拒文案不含被弃池——**pooled-preference/ledger 不复活旧池权**。
- **matrix (f)**：无 move 事件 → record-first 链路逐字节今天行为（(a) 语义不动）。

### 复测（真机，场景 B 判决）

driver-final（新 dist，`ses_e05028672ffeYowZRvhBtJKXss`）：ws 建会话 → 真实 move 到 dirA（204，REST 复核 dirA）→ move 回 ws（204，REST 复核 ws）→ **F5 crew_begin 注册成功，名册逐字 `DISPATCHABLE from this session — workspace pool: …\ws\.opencode\forge.json — forge-sbx-probe`**（Bug 2 验收 PASS）；F6 arm-only 武装成功（Bug 1 PASS，见上）。crew 记录落 `<T>/ws/.opencode/crew/2026-11-21-moved-back.md`。

如实披露：本轮真机上 get 缝在 move 回 ws 后恰好返回 ws（会话创建锚=ws，与目标一致），故 stale-read 本身未在复测轮重演；该形状的正确行为由 matrix (d)/(e) 在解析器层钉死（mock 正是"get 返回 move 前 location"的真机形状），且 `session.moved` 偏好使解析器对该陈旧形状免疫。另一披露：move 到无插件目录时宿主卸载工具面（F3），故"在 dirA 内被拒"这半判决在当前宿主面上表现为工具不可用而非插件拒文案——插件侧语义由 matrix (e) 覆盖。

## 验收清单

| 项 | 结果 |
|---|---|
| `bun run typecheck` | PASS |
| `node --test tests/*.test.mjs` | **788/788 全绿**（784 基线 + 新增 4：matrix (d)/(e)/(f) + crew_begin schema；零回归） |
| `bun run bundle` | PASS（dist 重建入库） |
| 场景 B 复测（driver-final） | PASS（F5 注册 + F6 arm-only 武装） |
| 并行边界 | 未触碰 src/forge-config.ts / schema / package.json / README |

## Commits

- `plugin: arm-only crew_begin schema (subtasks optional) + post-move anchor re-resolution via session.moved`（plugin.ts + dist + 两测试文件 + tasks.md 4.1 注记 + 本报告）
