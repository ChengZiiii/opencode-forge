# review-deltas — v2-single-agent-surface（实现 ↔ spec delta 对账）

Repo: opencode-forge · Change: `v2-single-agent-surface` (approved, not archived)
Reviewed at HEAD `4fa0c1c`; implementation commits `670c629` (plugin + dist) / `d26a2c4` (tests) / `4fa0c1c` (docs + verdicts). `plugin.ts` unchanged between `670c629` and HEAD (verified: `git diff 670c629 HEAD -- plugin.ts` empty).

## 总判决：CLEAN（可进下一波）— 无 spec↔实现阻塞项

Delta 的全部 Requirement/Scenario 均有实现落点与对应测试；MODIFIED 需求逐字携带全部存量场景；D0 零持久化红线与 D4 never-deny-execute 硬规则均核实成立。以下非阻塞跟进项（处置建议）在归档/发布波处理：

| # | 发现 | 建议 |
| --- | --- | --- |
| N1 | 探针报告文件 `reports/probe-v2-surface-report.md` 缺失（design.md:79 与 vision-bridge design.md:107 均引用它；`git log --all --diff-filter=A` 无任何提交含此文件，reports/ 下只有 implement 报告） | 按派发指示以 design.md 记录（P1/P3 CONFIRMED，:81-95）为准；归档前补回该探针报告文件或修正引用 |
| N2 | tasks.md 3.1/3.2 复选框仍开（tests/v2-setup 矩阵已提交且全绿、typecheck 干净、全量 728 pass——本次复核实测） | 纯记账滞后：主会话勾掉即可 |
| N3 | 验证腿仍开：1.1 live leg、1.3 action 名+blast-radius live leg、4.1 沙盒 E2E、4.2 官方安装/发布 | 归档与发布门（见下 PARTIAL 项），不是 delta-实现偏差 |
| N4 | D5 疗效在真实宿主未证实：P1 探针里 `draft.default("probe-forge")` 返回 ok 但**零可观察痕迹**（design.md:84-89）；"fresh session defaults to forge" 的端到端落在未跑的 4.1 | 4.1 E2E 判定；代码注释已标 revert-ready（plugin.ts:6776-6786） |
| N5 | 工作树存在**未跟踪**的新 change 目录 `openspec/changes/fix-v2-crew-surface-drift/`（他人 WIP，非本 change 范围） | 提请主会话知悉：树非干净 |

## 1. delta → 实现

### forge-agent delta（specs/forge-agent/spec.md — ADDED "v2 single-agent surface"，7 场景）

| Scenario | 判定 | 证据 |
| --- | --- | --- |
| Native primaries disappear from the picker on v2 | **VERIFIED**（记录级；picker 端到端待 4.1） | plugin.ts:6689-6702 守卫式 hide-only；测试 `v2 setup: hides native build/plan primaries (hide-only, other fields and non-natives untouched)`（tests/v2-setup.test.mjs，矩阵区自 :195 起）断言 build/plan hidden:true、`system:"NATIVE"`/`mode:"primary"` 不动、general/explore 不动 |
| Uninstalling the plugin restores the natives | **VERIFIED**（由构造成立：零持久化 → agent-layer 重建即还原） | 唯一写面是 `draft.update`/`draft.default`（运行时 agent 层，plugin.ts:6676/6695/6783）；全插件对 opencode config 无任何写路径；无专门卸载测试（结构不可能残留） |
| Nothing is written to the user's config | **VERIFIED** | `v2ReadHideNatives` 只读 global forge.json（plugin.ts:6626-6640，readFileSync+parseForgeJsonc）；旋钮走插件自有配置域（forge.json）；delta 允许的 plugin ledgers 属既有机制 |
| Existing native-agent sessions keep working | **VERIFIED**（hide-not-remove） | 代码只写 `hidden`，从不 `draft.remove` 原生记录（plugin.ts:6690-6697）；hide 测试断言 mode/system 原样 |
| The opt-out knob restores the natives | **VERIFIED** | plugin.ts:6689 `if (v2ReadHideNatives(deps))`；测试 `v2 setup: hideNativeAgents:false in the GLOBAL forge.json leaves natives untouched` + `an unreadable global layer keeps the default (hide on)` |
| A user's explicit config still wins where ordering allows | **VERIFIED**（宿主侧合并序，P1 探针证据） | 插件只在 transform 期一次性写 hidden，宿主 config→agent merge 后跑（P1 CONFIRMED，design.md:81-89）→ 用户 `agent.build.hidden:false` 后合并胜出；插件无再断言路径 |
| Fresh sessions default to forge under the confirmed ordering | **VERIFIED**（单测级；宿主疗效待 4.1，见 N4） | plugin.ts:6782-6786 `typeof draft.default === "function"` 守卫 + try/catch；类型缝 plugin.ts:5640-5643；测试 `default setter called with forge under the typeof guard` / `no default setter … silently skipped` / `a throwing default setter never escapes` |

### tool-partition delta（specs/tool-partition/spec.md — MODIFIED "Forge family runs exclusively on the forge exec surface"）

先核**逐字携带**：live spec（openspec/specs/tool-partition/spec.md:8-30）该需求下 4 个存量场景标题与 WHEN/THEN 同 delta（delta:9-27）逐字一致（比对通过）；delta 仅扩展需求正文（v2 permission-形交付机制）+ 新增 2 个 v2 场景。合规。

| Scenario | 判定 | 证据 |
| --- | --- | --- |
| A write-shape forge subagent has no builtin shell（存量） | **VERIFIED**（v2 侧为 permission 形） | plugin.ts:6765 `agentDraft.permissions = v2PermissionArray(v1def.permission)`——shape map+shell deny 同落 v2 permissions 数组；测试 `v2 setup: registers forge subagents …`（断言数组形 task:deny、无单数 permission 键）+ v2-pools `readonly shape denies the mutating family` |
| A forge worker carries only the exec toolset（存量） | **VERIFIED**（v1 既有；v2 无 tool 域，工具面经权限形） | 既有 suites（forge-subagents-wiring / hierarchical-pools）全绿；v2-setup 断言 `sub.tools === undefined`（"v2 performs no tools-map injection"） |
| A crew wave runs on the forge exec surface（存量） | **VERIFIED**（既有，未动） | 全量 728 pass 含 crew/hierarchical-pools；本 change 无该路径改动 |
| Native backgrounding does not restore the builtin shell（存量） | **VERIFIED**（既有，未动） | deny 不区分 host 能力：v2 deny 常量 `V2_SHELL_DENY`（plugin.ts:6603）无条件 append |
| **The v2 model surface never offers the builtin shell**（新增） | **VERIFIED**（记录级；模型面端到端 = 未跑的 4.1/1.3 live leg → 记 PARTIAL 亦可） | 主记录 deny plugin.ts:6675-6681（幂等 append）；工人 deny :6765；测试 `primary + worker records carry the shell-deny front door (never execute)` |
| **v2 worker records carry the front door alongside their shape map**（新增） | **VERIFIED** | v2PermissionArray 恒 push deny（:6616-6621），write 与 readonly 形都覆盖；测试断言 research(Write)+scout(readonly) 双形态携带 deny、readonly seal（write/edit/bash/patch）与 task:deny 同数组 |

## 2. 实现 → delta（scope creep / 缺漏盘点）

1. **permissions 数组字段名修复**（worker 物化从错误的单数 `permission` 记录形改为 v2 `permissions` 数组，d790b4d 类似修复在 forge 为 670c629）：副作用是 readonly seal / task:deny **首次真正到达宿主**。判定：**delta 覆盖**——MODIFIED 需求的交付机制句（"delivered as a deny permission … pushed onto … every materialized forge-* record at registration"）+ 存量场景 1 的 "keeping its shape-derived permission map" 条款即为此而设；tasks.md 2.2 明文记录该修复。处置：无需补 delta。
2. **hideNativeAgents 旋钮**（读 global forge.json）：D0/D3 明文允许（插件自有配置域）；非 creep。
3. **`FORGE_TEST_FORGE_HOME` 测试缝**（:6629）：沿用既有模式（:6720 同款），测试专用，非行为面。
4. **用户自定义同名 `forge-*` 记录不获 deny**（create-only：`if (draft.get(id) !== undefined) continue`，:6738）：与 create-only 契约一致（测试 `never clobbers a user-defined forge-* entry` 仍在），belt 仍在下层兜底；delta 措辞限定 "materialized" 记录。处置：**记限制**（README/design 未逐字写明此边界，可在归档前于 design 补一句，非必须）。
5. 未发现其他 delta 外行为（README 章节为 proposal 明文交付项；dist 重建为打包契约）。

## 3. design 决策核对（D0-D5）

| 决策 | 判定 | 证据 |
| --- | --- | --- |
| D0 零持久化（不写用户 opencode config） | **成立** | 新代码写面仅 `draft.update/default`（agent 层运行时）；`v2ReadHideNatives` 只读 forge.json（:6626-6640）；README "Zero pollution" 段（4fa0c1c）与 delta 场景 3 对齐 |
| D1 hide 不 remove | **成立** | :6690-6697 仅写 `hidden:true`；全插件对原生记录无 remove 调用 |
| D2 机制/守卫/fail-soft/不碰其他字段 | **成立** | :6690-6701（absent skip :6693、already-hidden skip :6694、per-record try/catch :6691/6698）；测试矩阵四态齐 |
| D3 旋钮 = global forge.json `hideNativeAgents:false`，默认开，fail-soft | **成立** | :6626-6640（仅显式 false 关；解析失败保持默认）；README 路径 `%USERPROFILE%\.config\opencode\forge.json` 与 `forgeConfigPaths`（src/forge-config.ts:419-424）一致；用户显式 `agent.build.hidden:false` 经 P1 合并序胜出（README 已写明） |
| D4 deny 前门 + **never deny action "execute"** 硬规则 + 用户后合并 allow 可胜 | **成立** | deny 常量仅 `action:"shell"`（:6603）；`v2PermissionArray` 只映射 shape map 键（MUTATING_TOOLS 族 + task，无 "execute"）；幂等 append 不覆盖既有 shell 条目（用户 allow 在数组时插件不再压 deny，:6605-6610）；测试断言 `never denies action "execute"` |
| D5 default 受 1.2 探针门 + revert-ready | **成立**（实现侧） | :6782-6786 typeof 守卫独立 try/catch，注释含 revert 条款；P1 CONFIRMED 回写 design.md:81-89；**宿主疗效待 4.1**（N4） |

探针判决引用核对：design.md "Probe verdicts"（:79-104）P1/P3 CONFIRMED、P2 informational——与实现一致（P1→D5 落船、P3→deny 以数组形 append 于 global allow 之后、findLast 胜出＝append 末位）。P2 记录（execute 时 records 序列化为 `{}`）正是 vision-bridge 侧 change 的输入，互引一致。

## 4. 测试覆盖（delta 场景 → 测试名清单）

tests/v2-setup.test.mjs（矩阵区 :195 起，全部隔离 `FORGE_TEST_FORGE_HOME`）：

- `hides native build/plan primaries (hide-only, other fields and non-natives untouched)` → 场景 1
- `absent native records are skipped, never created` / `an already-hidden native record is left untouched` / `one native record throwing never blocks the other (per-record fail-soft)` → 守卫矩阵
- `hideNativeAgents:false in the GLOBAL forge.json leaves natives untouched` / `an unreadable global layer keeps the default (hide on)` → 场景 5 + D3 fail-soft
- `primary + worker records carry the shell-deny front door (never execute)` → 新增 v2 场景 ×2（记录级）
- `a user-defined forge entry keeps its fields but gains the shell deny` → tools-merge 语义
- `default setter called with forge under the typeof guard` / `no default setter on the draft → silently skipped` / `a throwing default setter never escapes` → 场景 7 + D5 守卫
- 改写：`registers forge subagents …`（permissions 数组断言替换单数键）

tests/v2-pools.test.mjs：`workspace pool materializes NAMESPACED …`（task:deny+shell deny 数组断言）、`readonly shape denies the mutating family; absent shape defaults …`（seal 数组形 + every worker carries the shell-deny front door）、`pool-less workspace falls back to the GLOBAL layer`（数组形断言）。

无对应测试的场景（判定）：场景 2（卸载还原）/3（config 零写）为构造性成立、场景 6（用户 config 胜出）为宿主合并序（P1 探针）——均无单测可写层面，接受。

## 5. 复核实测（只读命令）

- `node --test tests/v2-setup.test.mjs tests/v2-pools.test.mjs` → **30 pass / 0 fail**
- `node --test tests/*.test.mjs`（全量）→ **728 pass / 0 fail**（v1 套件零回归）
- `bun run typecheck` → exit 0
- `npx openspec validate --all` → **11 passed / 0 failed**（仅既有 INFO 长文本提示）
- `dist/index.js` 已含新面（:21611-21630，V2_SHELL_DENY / v2WithShellDeny / v2PermissionArray / hideNativeAgents）
- 唯一 `hidden` 记录写点全插件仅 :6694-6699（v2Setup 内）——v1 loader 路径零触碰（grep 全文核实）

## 6. 结论

CLEAN：delta↔实现双向对账无阻塞项；D0-D5 全部成立；存量场景逐字携带；测试/typecheck/validate 全绿。跟进项 N1-N5（探针报告文件补回、tasks 记账、1.1-live/1.3/4.1 验证腿、D5 宿主疗效确认、未跟踪 WIP 目录）交主会话在归档/发布波裁决。
