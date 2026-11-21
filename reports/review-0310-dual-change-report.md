# Review 报告：0.31.0 双 change（forge-commands + builtin-override）实现对账

- 日期：2026-11-21
- 审查人：forge-plugindev-spec-reviewer（GLM-5.3）
- 仓库：`opencode-forge/`（HEAD = `0867679` "chore: schema override node + dist rebuild"，经 `.git/logs/HEAD` L368-372 确认五笔实现提交在序：`179ffeb` → `12ec0c9` → `5f48306` → `4ea75a4` → `0867679`）

## 总判决：**CLEAN**（静态审查全绿；3 项 NIT、2 项披露、E2E 仍 BLOCKED 为已知遗留）

### ⚠️ 审查通道披露（逐字）

本审查者的全部 shell 通道被宿主拒绝，`tools.forge_shell` 七次调用均逐字返回：

```
Permission denied: forge_shell
```

按治理契约（拒绝即停该线、不绕过），**未执行**任何 `git show` / typecheck / `node --test` /
`openspec validate`。证据来源与补偿措施：

- 实现侧证据取自**工作树 @ HEAD 0867679**，并与**已提交的 `dist/index.js`**（0867679
  "dist rebuild" 产物）逐串交叉核验 —— 双 change 全部新表面（FAMILY GUARD 模板、
  GLOBAL 脚手架、Levers 行、碰撞拒文案、`override-id-unknown`、`globalAgentDirFor`
  接线）在 dist 中逐字在场（dist L15844 / L16439 / L17824 / L17857 / L20704 /
  L16369 / L17977），即工作树源码与已提交构建一致，E2E 工人借用工作树未污染实现源。
- 提交序列/信息经 `.git/logs/HEAD`（纯文本读取）核实；五笔提交与 dispatch 所列一致。
- 父会话补跑的绿门（typecheck 0、840/840、bundle、五笔 conventional commits）按
  dispatch 陈述采信，本审查未重跑。
- spec 侧（openspec/changes/、openspec/specs/、reports/）为 docs 提交（4ccf30cb /
  79c1a41 / 4ea75a4）内容，直接读取。

---

## A. forge-commands — delta 5 场景逐条

delta：`openspec/changes/forge-commands/specs/forge-subagents/spec.md` — 纯
`## ADDED`（无 MODIFIED/REMOVED ⇒ 无档案场景逐字携带义务），1 需求 5 场景，全部
WHEN/THEN 合式。

| # | 场景 | 判决 | 代码证据（file:line） | 测试（tests/forge-commands.test.mjs） |
|---|------|------|------------------------|----------------------------------------|
| 1 | `/forge sync forces an immediate sync`（含自动化零变化） | **VERIFIED** | `plugin.ts:263`（"call the forge_sync tool NOW … report its output verbatim … manual force lever … sync:\"auto\" opt-in) is unchanged"）；`plugin.ts:4694-4706`（forge_sync 工具→`runRosterSync`）；`plugin.ts:269`（Boundaries 行重申三态不动）；注册双域 `plugin.ts:5432-5436`（v1 `cfg.command["forge"] ??=`）/ `plugin.ts:7045-7049`（v2 execute 型） | L70-76（"instructs an immediate forge_sync call with a verbatim diff report; automation posture unchanged (D5)"） |
| 2 | `/forge init scaffolds the project recipe`（起草+拒改只给看） | **VERIFIED** | `plugin.ts:264`（已存在 → "REFUSE to change it … present a review … NEVER overwrite or rewrite"；不存在 → 访谈/上下文起草，"write it ONLY on the user's explicit go-ahead — the write goes through the normal write tool"；hot-apply + crew retry 通过） | L78-85（recipe 路径 / REFUSE / NEVER overwrite / explicit go-ahead / hot-applies 全断言） |
| 3 | `/forge init global scaffolds the global layer inert`（override 节全注释） | **VERIFIED** | `plugin.ts:265-266`（global 流 + 内嵌脚手架）；`plugin.ts:225-255`（`GLOBAL_RECIPE_SCAFFOLD_JSONC`：`override` 节与 general/explore 两两条目全部 `//` 注释，L248-253；Auto 语义、wholesale 替换、marker GC、碰撞红线均在注释内 L236-247） | L87-96（COMMENTED OUT + 逐行注释正则）+ L98-106（"scaffold: inert by default"：无激活 override 节、无激活条目、Auto/wholesale 文案在场） |
| 4 | `The net still teaches the levers`（未配置拒文案指路杆） | **VERIFIED** | `plugin.ts:4418`（unconfigured-crew 拒绝新增一行 "Levers: … /forge init … /forge init global …"）；门语义其余零动（L4411-4417 原指导体逐行保留） | L163-188（断言 /forge init 与 /forge init global 双在场 + `Levers:` + 原门语义未动："SOLE OWNERSHIP"、"only on their explicit go-ahead" 仍断言） |
| 5 | `Family guard holds` | **VERIFIED** | `plugin.ts:260`（step-0：无 forge_sync 工具即 STOP，告知 /forge 属 forge agent、切 agent 重跑——与 /plan L169 / /goal L201 / /crew L4294 同款 step-0 纪律，D3"identical to /plan /goal /crew"成立） | L63-68（"FAMILY GUARD step-0 names the forge agent and the forge_sync tool"） |

路由矩阵与注册面补充：`plugin.ts:262-267`（sync/init/init global/empty-unknown→help 四
路 + $ARGUMENTS），测试 L54-61（四路全断言）、L118-139（v1 注册+no-clobber：用户自有
`command.forge` 不被覆写）、L145-157（v2 execute 型发送同一常量模板，byte-identical）、
L108-112（"the commands never write — every write rides a tool, transcript-visible"）。

## B. builtin-override — delta 3 场景逐条

delta：`openspec/changes/builtin-override/specs/forge-subagents/spec.md` — 纯
`## ADDED`，1 需求 3 场景。探针证据 `reports/probe-builtin-override.md`：身份键 =
id stem（大小写敏感），仅小写 `general.md`/`explore.md` 真覆盖（§2e/§5b），大写 =
歧义重复（§2b/§3a/§5a，判 NEGATIVE 分支）。

| # | 场景 | 判决 | 代码证据 | 测试（tests/builtin-override.test.mjs） |
|---|------|------|----------|----------------------------------------|
| 1 | `The scaffold arrives only on ask, inert by default`（含"不请不写"） | **VERIFIED（静态）** | 脚手架全注释：`plugin.ts:225-255`；投递面仅 /forge init global（`plugin.ts:265`）与 crew 拒文案 in-band ask+Levers（`plugin.ts:4417-4418`）；**不请不写**：override 发射只经 `runRosterSync`（`plugin.ts:498-511`，唯一调用方 = forge_sync 工具 `plugin.ts:4700`——工具仅在 agent 调用时写，`plugin.ts:4692-4693` 注释明示）；sync:"auto" 会话启动路径（`plugin.ts:7365-7394`）**只计划 family、不含 override plan**——即使全局文件声明 auto 也不会自动写 override 文件 | forge-commands.test.mjs L98-106（inert）+ 本套 L195-196（"planOverrideSync: no overrides → null"，未配置=零发射）+ L132-138（无 override 节 → 空 overrides 零 finding） |
| 2 | `An activated override pins the built-in machine-wide`（激活→落地→再注释→marker GC；小写发射机广覆盖） | **VERIFIED（静态+探针）** | 发射机：`src/roster-compile.ts:184-197` `compileOverrideEntry`（fileName=`<id>.md` 无前缀、mode:subagent 恒盖、model#variant、tools 面、GENERATED 头）；`planOverrideSync` `src/roster-compile.ts:259-268`（遍历 `BUILTIN_OVERRIDE_IDS`=["general","explore"]（`src/forge-config.ts:300`）——两内置 id 广覆盖、无激活条目→null）；接线：`plugin.ts:500-510`（`resolution.overrides` → `planOverrideSync(dir: globalAgentDirFor(…OPENCODE_CONFIG_DIR…))` 并入 plans——无论会话是否有工作区池，全局文件 override 都随 host 级 resolution 发射=机器级）；GC：`src/roster-compile.ts:388-403`（override plan 的 GC 谓词仅枚举 `general.md`/`explore.md` 且删前必查 in-content GENERATED marker）。机器级遮蔽语义本身 = 探针 §2e/§5b 宿主实证 | L144-162（小写发射：marker/mode/model#low/按 shape 封 seal/显式 prompt 逐字）；L170-173（Auto override 无 model 键）；L202-214（发射→再注释→GC marker-keyed、幸存条目文件保留）；L117-122（GLOBAL 文件 override 进 resolution） |
| 3 | `Hand-written same-name files are never clobbered`（碰撞红线：字节不动+兄弟照常） | **VERIFIED** | `src/roster-compile.ts:342-349`：override plan 且目标已存在且**无 GENERATED marker** → 记 error（文案含 "collision refused — a hand-written file of this exact name already exists; sync never overwrites it…"）+ `continue`（不写=字节不动），兄弟条目照常；被拒文件仍在 wanted 集中 ⇒ GC 跳过（L397-398），不会"拒写后反被 GC 收走"；条目日后移除+手写文件在场 ⇒ marker 检查（L401）兜底不删 | L216-225（手写文件 byte-identical + error 点名碰撞 + 兄弟 explore.md 照常 created）；L227-240（手写 general.md 不被 GC、同目录 `forge-global-old.md` 对 override plan 不可见、被弃条目 explore.md marker-GC）；L242-251（带 marker 的旧产物正常 update，非碰撞） |

## C. Design 绑定核对

### forge-commands（D1-D5）

- **D2 模板永不写盘：VERIFIED。** 模板全文（`plugin.ts:257-271`）无任何"直接写文件"
  指示：sync=调工具；init/init global="write it ONLY on the user's explicit
  go-ahead — the write goes through the normal write tool so it lands in the
  transcript"（L264）、"refuse-and-review"（L265）；Boundaries 行（L269）"this
  command never writes anything by itself — every write goes through forge_sync
  or the normal write tool … transcript-visible"。测试 L108-112 锁定。无 bash/绕道
  写指示。
- **D5 自动化零变化：VERIFIED（静态核验，见披露）。** staleness gate
  （`plugin.ts:537-548` rosterStaleRefusal、`src/roster-compile.ts:416-429+`
  staleCheckForPool）与 sync:"auto" 路径（`plugin.ts:7361-7394`：per-family 声明
  才重编、console.warn 披露、best-effort）区域不含任何本 change 新逻辑；auto 路径
  的 plans 仅 `planRosterSync` families（L7376/7389），**不含 override plan**——
  /forge sync 与 override 发射只经 forge_sync 工具（L4700）。字节级 diff 因
  forge_shell 被拒不可得（见披露）；行为面与 0.30.0 语义一致。

### builtin-override（D1-D6）

- **D1 仅全局层合法：VERIFIED。** `src/forge-config.ts:949-962`：仅
  `path === globalPath` 时 `validateOverrideNode`；工作区池 override 节 → warn
  finding code **`override-node-ignored-workspace`**（L961，文案
  "GLOBAL-layer-only … field ignored"）+ 忽略。测试 L124-130（含 finding 点名工作区
  文件路径）。fail-soft 矩阵：未知 id（含大写负形）warn+skip（L426-433，
  `override-id-unknown`）、半对 error+skip、非对象节点 warn（L417-422）——测试
  L55-111。
- **D2 case-lock 铁证：VERIFIED。** `src/roster-compile.ts:187`
  `if (!(BUILTIN_OVERRIDE_IDS as readonly string[]).includes(input.id)) return null`
  ——JS `includes` 大小写敏感，`"General" ∉ ["general","explore"]` ⇒ 返回 null 永不
  发射。**大写测过**：测试 L164-168（`General`/`Explore`/`GENERAL`/`coder`/`build`/
  `""` 全部断言 `=== null`，"capitalized ids are NEVER emitted (case-lock, probe
  negative form)"）+ L77-93（`General` 键在 validateOverrideNode 即被
  `agent-id-invalid` error+skip，"capitalized negative form never survives"）——
  上游（校验）与下游（编译器）双重锁。
- **D4 碰撞红线：VERIFIED**（见 B#3）。
- **D5 globalAgentDirFor 两分支+接线：VERIFIED。**
  `src/roster-compile.ts:221-230`：`OPENCODE_CONFIG_DIR` 设（trim 后非空）→
  `$CONFIG_DIR/agent`（分隔符风格保留、尾分隔符吸收）；未设/null/空白 →
  `<home>/.config/opencode/agent`。测试 L179-187（两分支+斜杠风格+尾分隔+空白
  CONFIG_DIR）。接线：`plugin.ts:502`
  `globalAgentDirFor({ homeDir: process.env.FORGE_TEST_FORGE_HOME ?? homedir(),
  configDir: process.env.OPENCODE_CONFIG_DIR })`，与探针修正 1（probe §修正1：
  CONFIG_DIR 设时假 home `.config` 不读）一致；dist L17977 同串在场。
- **D6 脚手架注释态：VERIFIED**（见 A#3 / B#1；`plugin.ts:236-253` 全注释）。

### schema

- `schema/forge.schema.json:41-49`：`override` 节在场，`propertyNames.enum` 恰为
  **`["general","explore"]`**（L45），description 含 GLOBAL-only / 小写身份键 /
  wholesale 替换 / 碰撞红线全套；条目复用 `#/definitions/agent`（原子对等）。
- **镜像一致**：`dist/forge.schema.json` 与 `schema/forge.schema.json` 在 L41/43/71/81
  逐字相同（override 节、agent 定义、permission 描述）；锁定测试
  `tests/builtin-override.test.mjs:258-266`（enum == `BUILTIN_OVERRIDE_IDS` 深比较 +
  description 关键词）与既有 `tests/forge-schema-mirror.test.mjs`（旧锁全保留：枚举/
  模式/原子对/shape-invalid 文案/$schema 容忍，无弱化）。

## D. 红线核对

1. **GC 枚举仅 general.md/explore.md 且按 marker：VERIFIED。**
   `src/roster-compile.ts:388-392`（override plan 谓词 = 名字恰为
   `${id}.md`∈内置两 id；family plan 谓词 = `forge-` 前缀——双向不可见）+
   L401（删除前 `readFile(dest).includes(GENERATED_MARKER)`，两类 plan 共用）。
   同目录 `forge-global-*` 产物对手写文件均不可见；测试 L227-240 直证
   （`forge-global-old.md` 原样、手写 general.md 原样、marker explore.md 被收）。
   family 侧旧红线（`tests/roster-compile.test.mjs:219-227`：手写 forge 文件、
   非 forge 文件均幸存）未弱化。
2. **命令模板对非 forge 会话的守卫：VERIFIED。** step-0（`plugin.ts:260`）+ 与
   /plan（L169）/goal（L201）/crew（L4294/L4326）同款句式；dist L17857 逐字在场；
   测试 L63-68。
3. **无任何新增非用户触发的 fs 写点：VERIFIED。** 全量写点清点：`plugin.ts` 直接
   fs 写仅诊断账本（731/751）、job 账本（943/944）、session-anchor 账本
   （1127/1131，0.25.6 既有）、env 门控探针日志（1227/4784/5304/…）、plan/goal/
   crew 用户门控工具写（1541-1764 等）——全部既有；roster 写仅经
   `realRosterFs()`（462）→ `executeRosterSync`，触发面 = forge_sync 工具
   （agent 调用、transcript 可见）+ 既有 sync:"auto" opt-in（families-only）。
   `src/roster-compile.ts`、`src/forge-config.ts` **零直接 fs 写**（纯核、fs 注入）。
   README File ledger 新行（`README.md:301`：override 产物行——"forge_sync output
   when … activates an entry"、GC 按 marker、碰撞拒写、global agent 目录解析）与
   实际写点一一对应，无未声明写点。/forge 命令零写（模板+工具走带）。

## E. 探针对齐（frontmatter 键集）

- 发射文件 frontmatter 由唯一入口 `frontmatterFor`（`src/roster-compile.ts:129-136`）
  生成：键集恰为 **description / mode / model（可选，Auto 省）/ tools**；
  override 与 worker 同入口同键集。文件头注释（L8-31）明示：permissions **故意不
  发**（tools 面表达封印；probe §3 陷阱——permissions 在场时未知键 WARN+丢弃）、
  深度走 model variant 串（probe §2/§3）而非裸 reasoning 键。测试 L144-162 断言
  mode/model#variant/seal。**无 reasoning 类、无 permissions 类新键** ⇒ 与
  `reports/probe-native-agent-surface.md` 证实键集一致。

## F. 测试基线与断言漂移

- **新增 28 = forge-commands 10 + builtin-override 18**（两文件逐 test 清点；
  实现报告写 9/16 但其自注"实数以文件为准"，总数 28 与 dispatch 一致——NIT-3）。
- **v2-session-commands.test.mjs 命令清单断言 = 扩展而非放松**：L249-253
  `assert.deepEqual([...state.commands.keys()].sort(), ["crew","forge","goal","plan"])`
  ——精确集合断言，新增 `"forge"` 后该断言**更强**（必须含新命令且不得多）；同测试
  L254-258 进一步逐命令断言 execute 型。另一处 L316-327（v2 无 get → forge 后写
  覆盖用户定义的 documented drift）为既有行为断言，未动。
- **其余两处漂移修正（.md 后缀 / 脚手架内嵌正则）未在任何老文件中找到弱化痕迹**；
  结合实现报告 812 基线风险自析（plan 新增 `kind` 判别式——旧测试仅按 `.files`/
  `.dir` 索引；`PoolResolution.overrides` 纯增字段——hierarchical-pools 仅 deepEqual
  `.families`；`validateAgentSet` 新参带默认值），判读为新增套件内部修正，非老断言
  放松。
- **老测试抽查 8 文件，无弱化**：①`tests/v2-session-commands.test.mjs`（如上）；
  ②`tests/roster-compile.test.mjs`（L207-263：family GC 红线/原子写/内容裁决全保留，
  手写+非 forge 文件幸生断言在）；③`tests/native-roster-wiring.test.mjs`
  （L104/147/177：staleness gate、GC、sync:auto 产物路径断言在）；④
  `tests/hierarchical-pools.test.mjs`（L442 命名空间化、L1416-1561 crew 门矩阵在）；
  ⑤`tests/forge-subagents-wiring.test.mjs`（L562-577 crew 模板两形态+硬门文案在，
  Levers 行为 match 型正则不受 appended 行影响）；⑥`tests/v2-setup.test.mjs`
  （L108 命名空间注册在）；⑦`tests/v2-pools.test.mjs`（L128-190 池共存/撞名在）；
  ⑧`tests/forge-schema-mirror.test.mjs`（L20-95 旧 schema 锁全保留）。

## G. NIT（不阻塞）

1. **NIT-1（陈旧注释）**：`plugin.ts:492-494` 称 `runRosterSync` "Shared by the
   forge_sync tool and the sync:\"auto\" session-start path"——实际 sync:"auto" 路径
   （L7365-7394）有自己的 plan/execute 循环且不含 override plan；`runRosterSync`
   唯一调用方是 forge_sync 工具（L4700）。纯注释失真，行为反而更保守（override
   文件永不自动写）。
2. **NIT-2（姿态披露，非违规）**：sync:"auto" 不覆盖 override 产物——已激活条目
   被再注释/修改后，即使全局文件声明 auto，override 文件也保持旧态直到手动
   forge_sync。两 change 文本均以 "forge_sync runs"/"forge_sync compiles" 为键
   （delta 场景 2、脚手架注释 L244-246、README L815），无 auto 覆盖 override 的
   规范要求，故合 spec；作为已知姿态披露。
3. **NIT-3（计数）**：实现报告两套件分别写 9/16 tests，实为 10/18（总数 28 无误）。
4. **NIT-4（测试矩阵小缺口）**："手写同名 override 文件不在 wanted 集 → marker 检查
   使其免于 GC"这一腿未作为 override-plan 直接用例（现有覆盖：碰撞拒写后 GC 不补刀
   L216-225+L397-398；family plan 同谓词直测 roster-compile.test.mjs:221-226）。
   谓词为两类 plan 共用代码，风险低。

## H. 遗留与未决（非本判决扣分项）

- **沙盒/live E2E：9/9 BLOCKED**（`reports/e2e-0310-dual-change-report.md`——该工人
  同被拒 forge_shell，逐字同款拒绝）。两 change tasks 3.1 均诚实未勾
  （`forge-commands/tasks.md` L29-31、`builtin-override/tasks.md` L42-43）。
  小写落地/机器级遮蔽/GC/碰撞的 live 宿主判定仍待 shell 解禁后补跑；本报告的
  VERIFIED 判决为静态代码+既有探针证据级。
- `openspec validate --all` 未由本审查运行（通道被拒）；人工结构核验通过（双 delta
  纯 ADDED、每需求带 WHEN/THEN 场景、场景标题未被改动——均为新增标题）。
- 父会话补跑绿门（typecheck 0 / 840/840 / bundle / 五笔提交）按 dispatch 采信。

## 结论

双 change 实现与规范逐条对上：forge-commands 5/5 场景 VERIFIED、builtin-override
3/3 场景 VERIFIED（静态），设计绑定 D1-D6（含双 change 的 D2/D5）全部核验，四条
红线（GC 枚举+marker、族守卫、零新增非用户写点、探针键集对齐）+ schema enum/镜像
全部通过，老测试抽查 8 文件无弱化（v2 命令清单为加强型扩展）。**CLEAN**——建议
shell 解禁后补跑 9 场景沙盒 E2E 与 `openspec validate` 以关闭 tasks 3.1。
