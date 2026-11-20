# review — harden-dispatch-resilience Block A+C 实现与 spec delta 对账

日期：2026-11-21 · 审查对象：`57aba9d`（A）/ `0f75c4b`（C 核心）/ `5a7810f`（接线）/ `06fa941`（tests）/ `3b219b2`（dist）vs `openspec/changes/harden-dispatch-resilience/`（proposal + design D1/D3 + specs delta）· 只报告，未改任何代码，未 push。

## 总判决：ISSUES（代码零阻塞；1 项归档前必改的 design 同步偏差 + 若干报告/台账小错）

- **实现本体：CLEAN。** A/C 两个 requirement 的全部 5 个场景均有代码+测试落点（全部 VERIFIED）；D1/D3 的绑定决策逐条成立；三条红线（Block B 零触碰 / D0 零持久化 / dispatch-gate 零 @opencode-ai）全部通过；774 pass / 0 fail（742+32，算术与实测一致）；typecheck 绿。
- **ISSUES-1（唯一必须处理项，归档前）**：实现者自述的设计修正（unreadable 状态映射不推进 `activeTextfulTicks`）**未同步回 design.md D1**——按本仓规则「实现与 spec 偏差时先改 delta 再归档」，须先补 design 再 archive。
- ISSUES-2/3（文档小错，随手修）：实现报告表格两处计数偏差；tasks.md 1.1 勾选状态与证据事实不符。

---

## 1. Requirement 场景 → 实现落点

### Requirement A — Active-textful completion override

| 场景 | 判定 | 证据 |
| ---- | ---- | ---- |
| **Stuck-active status with the final report already out** | **VERIFIED** | 核心分支 `src/dispatch-async.ts:712-728`：`active && statusMap !== undefined && finished && textful` 连续 `TERMINAL_STABILITY_TICKS`（=3，与 not-active 路径同一常量 `src/dispatch-async.ts:530`）→ `{status:"completed", via:"active-textful"}`。测试：`tests/dispatch-async.test.mjs` "status stuck busy + finished textful message → COMPLETE at the same 3-tick window, via=active-textful"（断言 `poll.polls === TERMINAL_STABILITY_TICKS`——无快路径）+ `tests/dispatch-gate-wiring.test.mjs` sync（工具输出含 `ACTIVE_TEXTFUL_OVERRIDE_NOTE`）与 async（journal reason 含该 note）两测试。"no timeout path runs" 由 override 先于 timeout 达成（3 tick ≪ 超时预算），async wiring 测试以 `dispatchTasks().length === 0` 验证 poller 经 override 落定 |
| **Stuck-active with no text stays honest** | **VERIFIED** | override 条件强制 `textful`（`src/dispatch-async.ts:712`）；无 text 落入 else 分支重置两条 streak（:729-734），textless-idle floor（:735-742 起）与 stale 处理照旧。测试：module 侧 "stuck-active with NO text stays honest (existing timeout semantics govern)"（断言 timeout 且 `via === undefined`）+ "a flapped run resets"（两次 override tick 后一次无 text 观察即重置）+ wiring 侧 "stuck-active with NO text stays honest — no completion invented（Sync wait budget governs）"（断言 `/Sync wait budget ended/` 且输出不含 override note） |

### Requirement C — Provider-dimension dispatch gate and circuit breaker

| 场景 | 判定 | 证据 |
| ---- | ---- | ---- |
| **Provider concurrency gate refuses and admits** | **VERIFIED** | 计数器+限额 `src/dispatch-gate.ts:154-168`（provider 先、provider/model 后，absent key = unlimited）；admit 在子会话创建**之前**（`plugin.ts:3236-3248`，`createChildSession` 在 :3308）；terminal 释放/进给 `plugin.ts:2488-2503`（`journalTerminalRecord` 对 admitted 记录 `recordTerminal`）。测试：module "provider concurrency: boundary refusal is VERBATIM; release re-admits" + wiring test 5（拒文案与 `concurrencyRefusal("provider","zai",1,1)` **逐字相等**；`calls.create` 无增量证明未创建 child；完成后第三个派发放行） |
| **Breaker opens, half-opens, and closes** | **VERIFIED** | 状态机 `src/dispatch-gate.ts:141-153`（open 冷却期满→half-open 放行一个 probe；half-open 且 probe 在飞→`breakerHalfOpenRefusal`）+ `:182-214`（probe 成功→closed+streak 清零；失败→failures++、重开、`openedAt=now` 冷却重置——streak 保留）。测试：module "breaker: closed → open at N consecutive failed terminals…"（含 msLeft 逐字缩进）+ "breaker: half-open admits exactly ONE probe; failure re-opens with the cooldown re-armed; success closes"（fake clock 999ms/1ms 边界全覆盖）+ "neutral outcomes … never feed the streak；success resets it"；wiring test 7（2 个 error terminal 后 `breakers.zai.state === "open"`，第三次派发 reject 且 `calls.create` 零增量） |
| **Absent or malformed dispatch node is fail-soft** | **VERIFIED** | `src/forge-config.ts` `validateDispatchNode`：absent/null → `config:null`（无限）；非 object → 整节点丢弃+1 warn（`dispatch-node-invalid`）；map 内逐条、breaker 逐字段丢弃+warn（`dispatch-map-value-invalid` 等），永不 throw；loader 逐层解析+`mergeDispatchNodes` 级联（global base + project override，per map key / per breaker field）。`plugin.ts:2145-2156` `gateFor` 拿 null → `updateConfig(null)` → 空配置。测试：module "unconfigured gate admits without limits" + `tests/forge-config.test.mjs` 8 条 dispatch-node 测试（absent/非 object/合法/坏 map 值/坏 breaker 字段/merge/级联/loader fail-soft）+ wiring test 8（`{zai:"oops"}`+坏 breaker 字段并发双派发均放行） |

**Spec 要求但未落 scenario 的条款逐条**（requirement 正文 SHALL）：

- "counters … fed at the terminal-recording seam" → `journalTerminalRecord` `plugin.ts:2488-2503` ✓（completed→success；error/stream-lost→failed；aborted/stale→neutral，与实际 call site 的 outcome 词表（`plugin.ts:2562-3602` 26 处）一致）
- "Queued dispatches SHALL re-check the gate at dequeue time" → `pumpDispatchQueue` `plugin.ts:2338-2351`，拒则 `failQueuedWishHonestly`（honest error wake，reason 含 "spawn refused at queue pump" + 逐字 gate 串）；wiring test 6（热收紧 zai:1 后 dequeue 拒，journal reason 断言 `2/1 live dispatch children already run on provider "zai"`）✓
- "cascade-merged across config layers" → loader 级联 + `mergeDispatchNodes`，config 测试 "the loader cascade-merges global base + project override" ✓
- "breaker refusals … SHALL NOT trigger the provider retry path" → gate admit throw 在 `createChildSession` 之前（`plugin.ts:3240`），`classifyDispatchError`（dispatch-retry.ts）只在子会话已存在的 poller/respawn 路径被咨询；wiring test 7 断言 reject 为 plain error 且零 create ✓

## 2. design D1/D3 绑定核对

### D1（Block A）

| 设计决策 | 判定 | 证据 |
| ---- | ---- | ---- |
| 3-tick 同款稳定窗 | VERIFIED | 同一 `TERMINAL_STABILITY_TICKS` 常量（`src/dispatch-async.ts:530`），override 与 not-active 共用（:709/:726）；测试断言 `polls === TERMINAL_STABILITY_TICKS` |
| 无 text 绝不虚构 | VERIFIED | `textful` 是 override 的硬条件（:712）；无 text 走 else 重置；flap 测试证明单次断档即清零 |
| sync+async 共享分支 | VERIFIED | 分支在 `pollChild` 内部、streak 挂在共享 `TerminalStabilityState.activeTextfulTicks`（:545-552）；async `runAsyncDispatchPoller` 与 sync `syncWait` 都以各自 stability state 驱动同一函数；测试 "the streak survives poll-slice boundaries via the shared stability state"（slice 1 结束时 `activeTextfulTicks===1`，slice 2 完成） |
| wake 披露文案 | VERIFIED | `ACTIVE_TEXTFUL_OVERRIDE_NOTE = "completion established from the message stream while the status view lagged"`（`src/dispatch-async.ts:562-564`）落三处：sync 工具输出（`plugin.ts:3584-3596`）、async 文本尾注（`plugin.ts:2848-2850`）+ journal reason（`plugin.ts:3095-3101`）；wiring 测试以 import 的常量断言包含 |
| **（偏差）unreadable 状态映射不推进 run** | **design.md 未同步** | 实现侧：pollChild 对 status fetch 失败的旧约定是 `active=true`（`src/dispatch-async.ts:651-653`），实现者在 override 条件加 `statusMap !== undefined` 守卫（:712），保住既有 soundness 测试「status fetch FAILING every tick → honest timeout」——实现报告 :24 自述为 "Design correction applied"。**但 design.md D1（`openspec/changes/harden-dispatch-resilience/design.md:25-32`）仍是原表述「ticks where the status map still says active」，无 unreadable 字样**（git log 证实 design.md 最后一次改动是 da1375b，早于全部 A/C 实现 commits；全文 grep "unreadable" 零命中）。spec delta 本身与实现不冲突（scenario 写的是 "status map reports active on every poll tick"，可读报告才谈得上 reports），故这是 **design 文档同步缺口，非 spec 违例** → 按规则先改 design.md 再归档 |

### D3（Block C）

| 设计决策 | 判定 | 证据 |
| ---- | ---- | ---- |
| 缺节点=无限 | VERIFIED | `validateDispatchNode` absent→null；`gateFor`→`updateConfig(null)`→空 maps + `consecutiveFailures:0`（breaker 禁用，`dispatch-gate.ts:127-135`）；module 测试 "unconfigured gate admits without limits" |
| 字段级 fail-soft | VERIFIED | map 逐条目、breaker 逐字段 warn+drop，永不 throw（`forge-config.ts` validateDispatchNode 全体）；loader 侧 config 测试 8 断言 findings code/level |
| 排队 dequeue 复检 | VERIFIED | `plugin.ts:2338-2351` + wiring test 6 |
| 拒文案逐字（机制+维度+当前值+恢复条件） | VERIFIED | `concurrencyRefusal`（`dispatch-gate.ts:49-55`：gate 名/`live/limit` 当前值/frees-a-slot 恢复）/`breakerRefusal`（:57-63：breaker 名/failures+threshold/msLeft/cooldown 恢复）/`breakerHalfOpenRefusal`（:65-71）；module 测试以函数值**逐字相等**断言（dispatch-gate.test.mjs:45/61/76/98/152/156-163），wiring test 5 对工具错误 message 也做逐字相等 |
| 熔断拒绝绝不进 provider-retry | VERIFIED | throw 先于 `createChildSession`（`plugin.ts:3240` vs :3308）；wiring test 7 断言零 create；dequeue 拒走 `failQueuedWishHonestly`（不 respawn） |
| 半开语义（放行一个；成功关、失败重开重置冷却） | VERIFIED | `dispatch-gate.ts:141-153`（open→冷却满→half-open，admit 时 `probeInFlight=true`；probe 在飞时他人拒）+ `:185-198`（成功→closed+failures=0；失败→failures++→open→`openedAt=now`）；module 测试 5 全链（含 999ms 仍拒/1000ms 放行重开验证） |

## 3. 红线

| 红线 | 判定 | 证据 |
| ---- | ---- | ---- |
| **Block B 文件零触碰** | **PASS** | `git diff f696ecf..3b219b2`（A/C 全部 5 commits 的累计范围）非 dist 文件中 grep `QUESTION_DENY`：零命中。`src/dispatch-async.ts` 三个 hunk 全在 :264/:542/:686-733（`createChildSession` 位于 :116-146 区域，零 diff）。v2 转发键列表（现 `plugin.ts:6767` `["parentID","title","permission","permissions","directory"]`）在 A/C 范围零 hunk——其中 `permissions` 键系更早的 crew commit `7d7a497` 引入（`git log -L 6761,6775:plugin.ts` 唯一来源），非本次改动 |
| **D0 零持久化（gate 纯内存）** | **PASS** | A/C diff（plugin.ts + src/ 四文件）grep `writeFile\|appendFile\|mkdir\|fs\.\|node:fs`：零命中。gate 状态全部在模块级 `Map`/`Set`（`plugin.ts:2116-2131` sessionModels/dispatchGate/admittedGate/gateProvidersSeen）；`createForgeConfigLoader` 只读 forge.json（mtime 缓存）；journal 追加是既有 dispatch-log 机制且记的是派发结局而非 gate 状态 |
| **dispatch-gate.ts 零 @opencode-ai import** | **PASS** | `git grep -n 'opencode-ai' 3b219b2 -- src/dispatch-gate.ts` 唯一命中是 :4 注释「no @opencode-ai imports」；全文（224 行）零 import 语句，clock 注入（`GateClock`） |

## 4. 测试对账

- **32 新增测试**（`git show 06fa941` 逐文件计数）：`dispatch-async.test.mjs` **6**（A poller）+ `dispatch-gate.test.mjs` **10**（C module）+ `dispatch-gate-wiring.test.mjs` **8**（A wiring 4 + C wiring 4）+ `forge-config.test.mjs` **8**（dispatch node）= **32** ✓；既有测试零删除零改动（forge-config.test.mjs 唯一删行是被扩写的 import 行）。
- **774 基线零回归**：本机 HEAD 实跑 `node --test tests/*.test.mjs` → **`pass 774 / fail 0`**（job j-20261120-213239，duration 14.4s），与报告的 742+32=774 一致。
- 场景映射：A1→poller 测试 1/6 + wiring 1/2；A2→poller 测试 2/3 + wiring 3；C1→module 2/3 + wiring 5；C2→module 4/5/6 + wiring 7；C3→module 1 + config×8 + wiring 8；dequeue 复检→wiring 6；健康路径不回归→poller 测试 4 + wiring 4。**无场景缺测试，无测试无场景。**
- `bun run typecheck`（tsc --noEmit）exit 0；`openspec validate --all` 13/13 通过（仅 INFO 级「requirement text 过长」提示，非本次引入的阻塞项）。

## 5. 实现报告自述边界 vs 实际 diff

| 报告自述 | 核对结果 |
| ---- | ---- |
| Block B（createChildSession / QUESTION_DENY 两代拼写 / v2 转发列表）NOT touched | **一致**（见第 3 节证据） |
| No push / no publish / no npm pack | **一致**：`git status -sb` → `main...origin/main [ahead 7]`（5 个 A/C commits + 2 个 docs commits 未推送） |
| 基线 742 → 774（+32）、typecheck 绿、bundle 已提交 | **一致**（实跑 774/0；dist/index.js@3b219b2 含 `ACTIVE_TEXTFUL_OVERRIDE_NOTE`/`createDispatchGate`/`activeTextfulTicks`） |
| 表格 "+7 Block A poller tests" | **不一致（小）**：实际 6，报告自己的测试名清单也是 6 条——仅表格数字错 |
| 表格 "11 module tests" | **不一致（小）**：实际 10，报告自己的清单也是 10 条——仅表格数字错 |
| 任务勾选 2.1/3.1-3.3/5.1/5.2/5.4 | **一致**（06fa941 内 tasks.md diff 核对） |
| 报告文件本身未入库（untracked） | 事实记录：`reports/implement-dispatch-resilience-ac-report.md` 为 untracked——不影响对账，归档/提交时注意补上 |

## 6. 汇总清单

**必改（归档前，delta 同步）**

1. **design.md D1 补记 unreadable 修正**：`openspec/changes/harden-dispatch-resilience/design.md:25-32` 加一句（大意：override 仅在**可读**状态映射报告 active 时推进；status fetch 失败沿用 `active=true` 约定但**不**推进 `activeTextfulTicks`，保住「双失败 streak → honest timeout」soundness 姿态——对应 `src/dispatch-async.ts:712` 的 `statusMap !== undefined` 守卫与测试 "an UNREADABLE status map never advances the run"）。

**建议顺手修（文档台账，非代码）**

2. 实现报告表格两处计数：+7→6（dispatch-async）、11→10（dispatch-gate module）；总数 32 不变。
3. `tasks.md:5` 任务 1.1 仍未勾选，但其交付物（probe-1.1-evidence.md + 两附件）已在 `da1375b` 入库——证据在、勾选缺，补勾或在归档前处理。

**观察项（记录即可，不要求改动）**

4. `dispatchModelIdentity`（`plugin.ts:2174`）的 `childSessionID?` 参数当前无任何 caller 传入（仅 :2342/:3237 两处调用均只传 ownerSession）——预留缝，terminal 进给用的是 admit 时快照的 identity（admit/release 同 key，计数自洽；对未钉扎且 child 实跑模型 ≠ owner 会话模型的极边缘场景，计数维度按 owner 记）。
5. 多锚点/热移除边缘：host 单例 gate 的 `updateConfig(null)`（某锚点无 dispatch 节点时）会清零 breaker 配置；若彼时有 breaker 处于 open，`admit` 的冷却判定 `cooldownMs > 0 && consecutiveFailures > 0`（`dispatch-gate.ts:143`）永假 → 该 provider 在 null 配置持续期间拒文案会显示「cooldown 0ms left」却持续拒（恢复文案与实际不符）。单锚点典型用法（每次派发前 `gateFor(anchor)` 重应用本锚配置）不触发此象；如实记录为已知边缘。

## 结论

Block A 与 Block C 的实现**忠实覆盖 spec delta 的全部场景与 design 决策**，红线全部通过，测试证据链完整（32 新测试、774/0 实跑复现）。唯一归档前硬项是 **design.md D1 的 unreadable 修正同步**（先改 design 再 archive，符合本仓「实现与 spec 偏差时先改 delta 再归档」规则）；其余为报告/台账层小错与边缘观察，不构成代码阻塞。
