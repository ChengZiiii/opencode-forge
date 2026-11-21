# native-first-roster — review（实现 ↔ delta 对账）

- 日期：2026-11-21 · reviewer 独立复核，只报告，未改任何源码，未 push
- 对账范围：`openspec/changes/native-first-roster/`（proposal 含 owner 三决议 / design D1-D6 / specs delta 6 场景）↔ commits `6af6f63`→`b869769`（HEAD，工作树 review 开始时 clean）
- 方法：一切源码经 `git show <commit>` / `git diff 6af6f63..b869769` 读取；探针真值 `reports/probe-native-agent-surface.md`；实现自述 `reports/implement-native-first-roster-report.md`

## 总判决：**ISSUES**（0 条代码红线违规；3 条归档前必须补的 spec/doc 同步项）

代码面（编译器、接线、门、GC、默认姿态、v1 隔离）与 delta 逐条对上且测试真锁。
问题全部集中在**规范/文档未随实现同步**：design.md 未记录两条已披露偏差、
全局兜底层编译产物写进用户 HOME 的 agent 目录未在任何规范文档声明、README
"File ledger"（自称穷尽写入面）漏登新写入点且遗留"不写任何 temp 文件"的
矛盾陈述。按 libretto 纪律（先改 delta/design 再归档，unreadable 先例），
这三项落地前**不得 archive**。

---

## §1 六场景逐条判决

### 1. Recipe compiles to namespaced native agents — **VERIFIED**

- 代码：`src/roster-compile.ts:135` `compileRosterEntry`（文件名恒 `forge-<matId>.md` 命名空间化）；`:125` `frontmatterFor`（`mode: subagent` 无条件行）；`:97` `modelStringFor`（`provider/model#variant`）；`:111` `toolsFaceFor`（NATIVE_TOOL_VOCAB 现词面）；`:135` 正文经 `materializeAgentPrompt` 编译期烘焙 mandate+形状框架+角色（含 shared）；`:87` `GENERATED_MARKER` 头指回配方；`:220` `executeRosterSync` GC。
- 测试：`roster-compile.test.mjs` — "compile: namespaced file per entry, mode ALWAYS stamped, GENERATED header names the recipe"、"compile: variant words ride the model string…"、"compile: tools face per shape in probe vocabulary"、"compile: mandates + shape frame + role prompt + shared segment are baked into the body"、"execute: GC removes orphaned GENERATED forge files, never hand-written ones"；`native-roster-wiring.test.mjs` — "gate: GC — an entry removed from the recipe has its file collected on the next sync"。

### 2. Stale artifacts refuse and recover in-band — **VERIFIED**

- 代码：`plugin.ts:472` `rosterStaleRefusal`（拒文案含 reason + 一步修复）；`:4430` crew_begin 过期预检（native 模式）；`:4606` `forgeSyncTool`（forge agent 带内调用、transcript 可见、diff 全披露）；`:440` `runRosterSync` 输出尾行明示"host hot-applies — no restart"（热应用依赖宿主，探针 §8 PASS 佐证）。
- 测试："gate round-trip: crew_begin refuses stale, forge_sync regenerates, retry passes"（断言拒→无注册→sync 落盘→重试 PENDING 全链）、"gate: recipe edit flips staleness back on, sync clears it again; a pure touch does not"。

### 3. Depth rides variant where expressible, params elsewhere — **VERIFIED**

- 代码：`src/roster-compile.ts:71` `VARIANT_DEPTH_WORDS = ["low","medium","high"]`（仅此三词）；`:97` 非变体词 model 串保持裸；chat.params 注入路径 diff 零触碰（plugin.ts 11 个 hunk 无一落在 depth/chat.params 区域，7-word 词典与翻译矩阵未动）。
- 测试："depth split: exactly low/medium/high compile into the variant channel"、"compile: variant words ride the model string; non-variant words leave it bare; Auto workers emit no model key"；既有 dispatch-depth / forge-subagents-wiring 全绿（§5）。

### 4. Recipe stays the authority; visibility follows the host — **VERIFIED**（附 1 条 nit）

- 代码（D1 diff 证据）：`git diff 6af6f63..b869769 -- src/forge-config.ts` = +42 行纯新增三个纯函数（`parseMaterializeKnob`/`parseSyncKnob`/`parseTopLevelKnobs`），池解析器/级联/合规谓词零改动；`src/dispatch-tiers.ts` 仅 `export` 既有 `MUTATING_TOOLS`（值未变）；plugin.ts 各门（会话域池闸/crew 披露/合规闸）复用基线即存在的 `resolvePools`/`sessionPoolFileOf`（`git show 6af6f63:plugin.ts` 可见），无语义 hunk。
- 测试：`hierarchical-pools` + `forge-subagents-wiring` + `v2-tool-hooks` 基线 176/0 → HEAD 全绿（§5）；"knob matrix: v2 DEFAULTS to native — no forge-* worker draft materialization"。
- Nit（N4）：场景正文"disclosed difference (nested sessions see parent agents)"的披露位于 proposal.md:56-58 与 design 探针锚，README 手册段未重述（delta 对 README 的 SHALL 清单亦未要求；非阻塞）。

### 5. Cross-machine is zero-initialization — **VERIFIED**（单测级；5.2 沙盒 E2E 明示未做）

- 代码：`src/roster-compile.ts:309` `staleCheckForPool` 内容裁决——checkout 重打 mtime 后配方/artifact 同行到达、内容一致 → NOT stale，正是"both files travelled together"成立的机制。
- 测试："staleness: content-based verdict — an mtime-newer recipe with identical compiled output is NOT stale"；README.md:742 lockfile 故事（commit 生成物、fresh machine 零初始化）。
- 注：第二目录 pull 模拟属 tasks 5.2（pending，tasks.md 如实记账）。

### 6. Runtime materialization remains available as an escape hatch — **VERIFIED**

- 代码：v1 `server()`/config-hook 物化区 **diff 为零**（plugin.ts 全部 11 个 hunk 清单：imports/-74/-108(FORGE_STATE_TOOLS)/-372(新助手块)/-3260(派发提示)/-4315(crew 门)/-4475(forgeSyncTool)/-4500(注册)/-6104(V2SetupDeps)/-7095(旋钮+auto)/-7157(native 跳过 draft)——无一在 v1 区）；`plugin.ts:391` `nativeRosterActive()` = `v2HostSeen && mode==="native"`，v1 恒 false → 门/提示/auto 全惰性；`:7243` v2 默认 `"native"`、`materialize:"runtime"` 逃生门走原 draft 块（`:7351`）。
- 测试："knob matrix: runtime escape hatch keeps the draft materialization path"；19 个既有 v2 fixture 显式钉 `materialize:"runtime"`（diff 核实：仅加钉+计数 18→19/17→18，无断言弱化）；788 基线等值（§5 独立推导）。
- Nit（N3）：delta 场景 6 正文"during the deprecation window"与 owner 决议"no deprecation window"（proposal.md:63-69、design D5）措辞相悖——归档改 delta 时顺手修。

---

## §2 D1-D6 绑定核对

| 决议 | 判决 | 证据 |
| --- | --- | --- |
| D1 配方恒语义中心 | **PASS** | forge-config diff 仅旋钮解析（见 §1 场景 4）；门/披露/合规零语义改动；plugin 复用基线 helper |
| D2 编译器输出契约 | **PASS** | 键集=探针矩阵逐键比对：仅 `description`/`mode`/`model`/`tools`——测试 "compile: frontmatter emits ONLY probe-proven keys (no permissions, no depth keys)" 断言键集恰为四键；`reasoning*`/`permissions` 零发射（grep roster-compile.ts 仅注释命中）；`mode: subagent` 恒盖章（:125+测试）；原子写 temp+rename+unlink 回退（:220；测试"NO half file"+"rename refuses → unlink+rename fallback"）；GC 只收带 `GENERATED_MARKER` 的 `forge-*.md` 孤儿（:220 尾段；测试断言手写 forge 文件与非 forge 文件双双幸存）——**红线（不碰用户手写 agent 文件）在代码与测试双侧成立** |
| D3 variant 仅 low/medium/high | **PASS** | `VARIANT_DEPTH_WORDS`(:71) 恰三词+测试；chat.params 按名注入路径 diff 零触碰 |
| D4 过期门+带内 sync+auto 缺省零写 | **PASS** | 门 :4430；派发路径提示 :489（拒文案追加 Native-roster hint，测试"dispatch hint…"）；默认姿态：唯一新写适配器 `realRosterFs`(plugin.ts:396-418) 仅喂 `executeRosterSync`，触发面=forge_sync 工具调用或 sync:"auto"（按 family 自文件 opt-in）；测试"sync auto: … without the knob nothing is written uninvited"断言 boot 后 `.opencode/agent` **目录不存在**；全 plugin.ts 写点清点：其余 writeFileSync/mkdirSync 全为基线既有台账（plan/goal/job/crew/anchor/dispatch-journal） |
| D5 v1 恒 runtime / v2 直切 native | **PASS** | 见场景 6；forge_sync 按指令双代注册，但只在被调用时写 |
| D6 NATIVE_TOOL_VOCAB 单常量+镜像 | **PASS** | 常量 :48；镜像测试逐字锁探针：`dispatchTool==="subagent"`（探针 §1/§5）、`taskKey==="task"`、`shellChannel==="execute"`（§5）、`legacyShellKeys=[shell,bash]`、`mutatingFamily ≡ MUTATING_TOOLS` |

## §3 实现者自述偏差 — design.md 同步核对

- **偏差 1（mtime 死锁→内容裁决）：design.md 未同步 — ISSUE-1**。
  `git log -- design.md`：最后一次改动是 `6af6f63`（实现开始前）。design.md:42-51（D4）仍写"recipe mtime > newest matching artifact mtime → refuse"，无内容终审半句。代码（roster-compile.ts:309-362）+ 两个测试（"content-based verdict…"/"a pure touch does not"）已按偏差实现并锁定，但规范侧滞后。该偏差还是场景 5（跨机零初始化）的承重机制，更应入档。
- **偏差 2（crew 门收窄 native-only）：design.md 未同步（同 ISSUE-1 一并修）**。
  design.md:42 的"crew_begin precheck (and draft materialize precheck)"中后者在代码里不存在（plugin.ts:4430 门体被 `nativeRosterActive()` 包裹）。实现报告已披露，design 未改。
- 修法：先改 design.md D4（mtime 为廉价触发、内容比对为终审、touch/checkout 偏斜不算过期、runtime 模式无 artifact 故门仅 native），再走归档。

## §4 红线（写入面）

1. **GC 不误删用户手写文件：PASS**（代码+测试双侧，见 D2）。
2. **`.opencode/agent/` 写仅限 forge- 前缀：PASS**——`executeRosterSync` 只写 plan.files（`forge-<ns>-<id>.md`）与同前缀 `.new` temp；GC 只删带标记 `forge-*.md`。
3. **除 sync/auto-sync/原子 temp 外无其他写点：PASS**——diff 内新增 fs 原语仅 `renameSync`/`unlinkSync` import，且只进 `realRosterFs`。
4. **ISSUE-2（新发现，实现报告偏差清单之外）：全局兜底层产物写进用户 HOME agent 目录，规范侧零声明**。
   `agentDirFor`（roster-compile.ts:163）把 global fallback family 映到 `<home>/.config/opencode/agent/`；`planRosterSync` 编译该 family（测试 "compile: description carries the pool provenance" 断言 `g.dir === "C:/home/.config/opencode/agent"`、产物 `forge-global-helper.md`）；且这是**承重路径**——`rosterStaleRefusal`（plugin.ts:472-477）对无工作区池会话回退到 global family，即"仅有全局配方的 v2 主机"上 crew_begin 会一直拒到 forge_sync 把 `forge-global-*.md` 写进 HOME。该目的地：delta 只写了 `.opencode/agent/forge-<ns>-<id>.md`（spec.md:8）、design D2 同、README 未提；仅在实现报告与测试名里出现。非安全违例（前缀+标记+GC 同样受限），但属**工作区之外的持久化扩展，必须上升给 owner 并入档**（补 design/delta/README，或收窄 sync 只编工作区池）。
5. **ISSUE-3：README "File ledger" 未更新**。README.md:279"## File ledger … What this plugin touches, exhaustively"表内无 `.opencode/agent/forge-*.md` 行、无 HOME agent 目录行，且 :300 仍断言"The plugin writes no temp files, no logs, nothing outside the table"——与 sync 的 temp+rename 写入直接矛盾（手册段 README.md:676 已写生成物，但穷尽台账没跟上）。README 文件账本是插件写入面的对用户契约，须补行并修 :300 陈述。

## §5 测试与验证（独立复核）

**新增 24 测试清单 ↔ 场景映射**（15+8+1）：

| 测试（suite: name） | 场景/决议 |
| --- | --- |
| roster-compile: vocab mirror… | D6 |
| roster-compile: depth split… | 场景3/D3 |
| roster-compile: namespaced file per entry… / variant words ride… / tools face per shape / mandates+shape+role+shared baked / description carries provenance | 场景1/D2 |
| roster-compile: frontmatter emits ONLY probe-proven keys | D2（键集红线） |
| roster-compile: creates→unchanged / GC…never hand-written / NO half file / rename-refusal fallback | 场景1/D4（含 GC 红线） |
| roster-compile: staleness fresh/stale/missing/empty / content-based verdict / agentDirFor | 场景2+5、偏差1、ISSUE-2 目的地 |
| native-roster-wiring: knobs fail-soft / v2 DEFAULTS native / runtime escape hatch | D5 旋钮矩阵 |
| native-roster-wiring: gate round-trip / recipe edit re-stales+touch not / GC via tool / dispatch hint / sync auto+default-writes-nothing | 场景2+D4 |
| forge-schema-mirror: materialize/sync enums mirror | 旋钮/schema 镜像 |

**实跑（本机，node v24.14.0）**：

- HEAD 全量（repo 内、E2E 工人开工前完成）：`node --test tests/*.test.mjs` → **812 pass / 0 fail**（88.6s）。
- 独立零回归复核（`git archive` 抽到 Temp、junction node_modules，杜绝碰工作树）：
  - 基线 `6af6f63` 受影响+近邻 8 文件（search-wiring/v2-pools/v2-setup/v2-tool-hooks/v2-tools/forge-schema-mirror/hierarchical-pools/forge-subagents-wiring）→ **176 pass / 0 fail**；
  - HEAD 同 8 文件+两新套件 → **200 pass / 0 fail**（= 176 + 24，逐一对应）；
  - 推导：812 − 200 = 612（未触碰文件），基线总量 = 612 + 176 = **788** —— 与实现报告"788+24=812"严丝合缝；176 个既有测试在 HEAD 全绿 = 零回归。
- 既有测试改动核查：5 个 v2/search 文件 + schema-mirror 的 diff 仅"显式钉 `materialize:"runtime"` + 工具计数 18→19、分区 17→18 + 新镜像测试"，无删测试、无断言弱化。
- `bun run typecheck` → exit 0（tsc --noEmit）。
- dist 含新代码：`dist/index.js` grep 命中 `NATIVE_TOOL_VOCAB`@16239、`VARIANT_DEPTH_WORDS`@16246、`GENERATED_MARKER`("<!-- GENERATED BY /forge sync")@16247、`"forge_sync"`@17656、`Roster stale refused`@17863、forge_sync description@20774。
- `openspec validate native-first-roster` → **valid**（纯 ADDED 需求带 6 场景，无 MODIFIED 场景搬运义务）。
- 环境诚实披露：Temp 副本里两次 run_in_background 跑的输出管道长时间无回流（0 字节日志），改同步执行后 ~34s/轮完成；事后 job 通知补达——基线 8 文件那次最终 **exited exit 0**（`node --test` 任一失败即非零，反向佐证 176/0），全量那次由 reviewer 主动 kill（状态 killed）。同步实跑数字为准。所有源码核对一律走 `git show`，未读 E2E 工人正在碰的工作树文件。

## §6 Nits（不阻塞）

- **N1** temp 残渣：`writeFileSync` 写 `${dest}.new` 中途失败（如 ENOSPC）可能留下 `forge-*.md.new`；GC 只匹配 `.md`，残渣不会被收（目标文件本身永不半写——真实保证成立，残渣惰性但永久）。可在 execute 失败路径补一次 best-effort unlink(tmp)。
- **N2** sync:auto 的"disclosed finding"是 setup 期 `console.warn`（彼时无会话级 findings 通道可用）——语义达成、通道降级，测试也未断言该输出；可接受，记录在案。
- **N3** delta 场景 6"deprecation window"措辞 vs owner"no deprecation window"决议（见场景 6）。
- **N4** up-tree-merge 可见性差异的 README 未重述（见场景 4）。

## §7 归档前必办（按序）

1. design.md D4 补记偏差 1（mtime 触发+内容终审及理由）与偏差 2（门 native-only 及 vacuous 理由）——ISSUE-1。
2. ISSUE-2 上升 owner：要么在 design/delta/README 明文声明"全局兜底层编译进 `<home>/.config/opencode/agent/`（含 crew 门承重语义）"，要么收窄 sync 仅工作区池；二选一落档。
3. README File ledger 补 `.opencode/agent/forge-*.md`（及 ISSUE-2 定夺后的 HOME 行、`.new` temp 说明），修 :300"writes no temp files…nothing outside the table"——ISSUE-3。
4. 顺手：N3 场景措辞、N1 temp 清理、N4 README 一句披露。
5. 之后才可 `openspec archive`；tasks 5.2（沙盒 E2E：sync→native 派发→热应用→第二目录 pull 模拟）/5.3（validate+官方安装往返+发布）仍 open，如实记账。

## 结论

实现与 delta 六场景、D1-D6、GC 红线、默认零静默写、v1 字节等值隔离**全部实证成立**，
测试锁真、812/788 数字独立复核通过。判决 **ISSUES** 仅因规范面滞后于代码面：
design.md 未同步两条已披露偏差（其一还是场景 5 的承重机制）、HOME agent 目录写入
未过 spec/owner、README 文件账本自相矛盾。补齐 §7 前三项后本 change 可 CLEAN 归档。
