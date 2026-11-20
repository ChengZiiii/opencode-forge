# review — Block B（harden-dispatch-resilience）× forge-config-json-schema 对账报告

日期：2026-11-21 · reviewer：spec-reviewer（只报告，未改码，未 push）
审查基线：HEAD = `fa60337`；全部源码经 `git show <commit>:<path>` / `git grep <pattern> <commit>` 读取，未读工作树（并行工人 `M plugin.ts` 全程在场，`git status --porcelain` 实证）。两 change 的 delta 场景标题逐一对照，无重命名。

---

## 对账 1：harden-dispatch-resilience Block B — 总判决 **CLEAN**

### 事实更正（dispatch 侧）

派发简报称该 requirement「3 场景」；HEAD delta 实文（`git show HEAD:openspec/changes/harden-dispatch-resilience/specs/forge-subagents/spec.md`）中 "Nested-dispatch tool guard on non-forge child sessions" 只有 **2 个场景**：

1. `Non-forge anthropic target denies the task tool in the child`
2. `Forge family and other families are untouched`

按实有 2 场景对账（简报的 3 大概把 requirement 正文的三分支 WHEN 误记为场景数）。

### 场景逐条

**Scenario 1: Non-forge anthropic target denies the task tool in the child — VERIFIED**

- 规则函数 `nestedTaskDenyFor`（`git show HEAD:plugin.ts`，定义位于 :2196-2200）：`id === "forge" || id.startsWith("forge-")` 恒 false；否则 `dispatchModelIdentity(...) !== null && dispatchProviderFamily(identity.provider) === "anthropic"` 才 true。`dispatchProviderFamily`（HEAD:plugin.ts:564）显式三集合，unknown provider → null → 不加 guard（保守，符合「其他 family 不碰」）。
- 承载通道：`CreateChildInput.taskDeny`（49b70d0，src/dispatch-async.ts）→ create body `permissions` 数组拼入 `TASK_DENY_PERMISSIONS_V2 = [{action:"task",resource:"*",effect:"deny"}]`；`questionDeny ∧ taskDeny` 时合并进单一 `permissions` 键（question 在前、task 在后），v1 `permission` 键仅 question。
- 接线级测试（e82dc36，tests/dispatch-guard.test.mjs，真 `task` 工具驱动）：`non-forge + anthropic → the task deny RIDES the create body (both modes)` — sync 断言 `body.permissions` deepEqual `[TASK_DENY]` 且 `body.permission === undefined`；async 断言 `[QUESTION_DENY_V2, TASK_DENY]` 合并且 v1 键并存。**双模式都盖**（主派发位 `taskDeny: nestedTaskDenyFor(target, context.sessionID)` 不随 `runInBackground` 分叉，仅 `questionDeny` 模式键控）。
- 「child cannot dispatch further subagents」依赖宿主消费 deny —— requirement 自己锚定「proven effective by a sandbox probe before the guard ships」，`probe-1.1-evidence.md` + `probe-1.1-client-surface.json` 已在 change 目录入库（da1375b 起可见，`git ls-tree HEAD` 实证）。插件侧可测部分全部有测。

**Scenario 2: Forge family and other families are untouched — VERIFIED**

- 非 anthropic family：`guard matrix (D2): non-forge + NON-anthropic family → the create body is UNTOUCHED`（zai/glm-4.7，断言无 task 条目、`permissions` 仅 `[QUESTION_DENY_V2]`）。
- **forge-* 钉 anthropic 模型也不加 guard（简报点名核查项）**：`guard matrix (D2): forge-* targets are untouched by THIS guard (even when the pinned model is anthropic)` — forge.json 池里 `scout` 钉 `anthropic/claude-sonnet-4-5`，派发 `forge-g-scout`，断言 create body 无 task deny、仅 question seal。结构性 deny 另有其主：`src/dispatch-tiers.ts:101/111`（HEAD grep 实证）`permission.task = "deny"` 对每个 forge worker 强制、「an override never lifts the recursion ban」——测试断言文字也点名 materialized permission map，两机制不相混。

### 4.1「无缺口」结论核实 — **VERIFIED（独立复核成立）**

- `git grep QUESTION_DENY_PERMISSIONS_V2 7d7a497` → `7d7a497:src/dispatch-async.ts:36`（常量定义）与 `:163`（create body 接线）：v2 数组拼写确在 crew commit 已落地。
- 转发键列表：`git show 7d7a497 -- plugin.ts` 中 flat-create 适配器整段为 `+` 新增，含 `for (const key of ["parentID","title","permission","permissions","directory"])` —— `permissions` 键就是该 commit 加的。HEAD 现位于 plugin.ts:6802。
- 结论：block B 无需补迁移，「no gap」成立；本次仅加 payload 断言。

### 五 spawn 位接线 — **VERIFIED（1:1 无遗漏）**

`git grep createChildSession\( HEAD -- plugin.ts` = 5 个调用位（:2370 / :2702 / :2924 / :3331 / :3475）；`git grep nestedTaskDenyFor HEAD -- plugin.ts` = 5 个接线位（:2379 / :2708 / :2930 / :3342 / :3481）+ 1 处定义。逐一对应：

| spawn 位 | 接线 | childSessionID（死参消费） |
| --- | --- | --- |
| 主派发（sync+async 同位，:3342） | ✅ | 不传（新子尚不存在） |
| queue pump（:2379） | ✅ spawn 时重解析（注释言明） | 不传（wish 无前子） |
| async retry respawn（:2930） | ✅ | 传前子 id |
| recovery retry-pending（:2708） | ✅ | 传 `rec.childSessionId`（类型守卫后） |
| sync retry respawn（:3481） | ✅ | 传前子 id |

「guard lives at the single child-creation funnel」：五站全走 `createChildSession`（单一漏斗），规则经共享 `nestedTaskDenyFor` 在调用侧计算 —— 与 design D2 的 caller-side rule 表述一致。`dispatchModelIdentity` 第三参（design "known leftovers" 点名的死参）由三个 respawn 位消费，未删除。

### 红线

- **B 零 QUESTION_DENY 语义变化 — PASS**：49b70d0 的 spread 重构在 `taskDeny` 缺省时逐字节等价（四种组合枚举核对：qd=true,td=false → `{permission:QDP, permissions:[...QDP_V2]}` 与旧码完全一致；两 false → `{}`）。e82dc36 对既有断言**零修改**（diff 中旧 deepEqual 全为 context 行，纯新增断言）。
- **D0 零持久化 — PASS**：guard 仅加 create-body 键；`setSessionModel` 测试缝操作内存 Map（sessionModels），无任何 fs 写。
- dist：f0ca2ef 重建，`git grep -c TASK_DENY_PERMISSIONS_V2 f0ca2ef -- dist/index.js` = 2（源+接线均在产物内）。

### 独立复核（本 reviewer 实跑）

`node --test tests/dispatch-async.test.mjs tests/forge-schema-mirror.test.mjs`（两文件仅 import 干净的 src/dispatch-async.ts / src/forge-retry / src/forge-config.ts，工作树 `git status` 实证干净）→ **71 pass / 0 fail**，含 taskDeny 三态 payload 矩阵与 QUESTION_DENY v2 断言。`tests/dispatch-guard.test.mjs` import `../plugin.ts`（工作树 M，在改）**未实跑**，其 3 个测试经静态逐行审阅，断言与实现一致；全量 784 的声明沿用工人报告（与 schema 报告的最终总数、B=4+schema=6 新增拆分互洽）。

### Nits（不阻断）

- implement 报告「774 基线 + 10 新增」把自己 change 之外的新增也计入「本次」（实际 B 新增 4 个 test case，10 是两 change 合计）；两报告最终总数一致，无实质错误。
- 派发简报「3 场景」与 delta 实有 2 场景不符（见上）。

---

## 对账 2：forge-config-json-schema — 总判决 **CLEAN**（一处镜像局限如实记录）

### 场景逐条（requirement: "JSON Schema publication for forge.json"，3 场景）

**Scenario 1: Editor completion and typo defense — VERIFIED**

- `schema/forge.schema.json`（0c08bbf，77 行，draft-07）对照 design D1 字段面逐项核对：
  - 顶层三键 `pool` / `shared` / `agents`（另加 `$schema` passthrough 条目，属文档化容忍）✅
  - 条目五字段 `model`+`thoughtLevel`（开放串+examples，无 enum——词典非白名单，与代码语义一致）、`prompt`、`shape`、`permission`（string-record）✅
  - `shape` enum 恰好 `["readonly","write"]` ✅
  - id/pool 规则：propertyNames `^(?:forge-)*[a-z0-9-]+$`（forge- 前缀容忍=代码自愈剥除）、pool `^[a-z0-9-]{1,24}$` ✅
  - 原子对 `anyOf:[{required:[model,thoughtLevel]}, {not:{anyOf:[单独 required]}}]` —— 半对必然 fail validation ✅
  - `depths` `deprecated:true` + 指路 thoughtLevel ✅
- 发布通道：`exports["./schema.json"] = "./dist/forge.schema.json"`；`dist/forge.schema.json` 入库（5662845），blob `b548eeb` 与 `schema/forge.schema.json`（0c08bbf）**同哈希=逐字节一致**；本 reviewer 实跑 `npm pack --dry-run` → `npm notice 4.7kB dist/forge.schema.json`、total files: 4。README（9bdd7df）含 unpkg 与 node_modules 两种 `$schema` 形态 + `.json` 扩展名下编辑器纯 JSON 关联的注释波浪线 caveat（`files.associations` 一行双修）。schema `$id` 的 unpkg 路径与 `package.json` name（`@sorenllm/opencode-forge`）一致。
- 场景本身是编辑器侧行为，本次核到「机制全部落位」为止——schema 半对/错拼 shape 会在编辑器侧报错是 anyOf/not + enum 的直接推论，属合理验证深度。

**Scenario 2: Schema and validator cannot drift silently — VERIFIED（含一处如实记录的局限）**

简报点名问题：**断言对象是代码 import 还是硬抄？** 答案：**混合且不是硬抄**——

- schema 侧：`readFileSync(join(repoRoot,"schema","forge.schema.json"))` 读**真文件**，非手抄副本；
- 代码侧：`import { validateAgentSet, validatePoolField, parseForgeJsonc, createForgeConfigLoader } from "../src/forge-config.ts"` —— 通过**导出的校验函数行为**镜像，非硬抄常量字面量；
- 唯一硬编码字面量是 schema 侧锚点（enum `["readonly","write"]` 的 deepEqual、anyOf 结构 deepEqual）——而代码侧本就**不存在可 import 的运行时常量**：`AgentShape` 是 type-only union（运行时擦除），id 正则 `AGENT_ID_RE` 是模块私有（HEAD:src/forge-config.ts:285，未导出），pool 规则是 `validatePoolField` 内联正则。行为探针是不新增导出前提下的最强锁。
- 覆盖：shape 8 探针双向（enum 成员 ⇔ 代码保留）；id 10 探针（含 `forge-x`/`forge-forge-x` 前缀自愈、UPPER/下划线/空格/点/空串；`"forge-"` 单独串为 schema 过/代码拒的歧义边，测试内注释声明不探——诚实）；pool 10 探针含长度边界 24/25，且**修剪不对称被显式断言**（代码先 trim、schema 见原串——严向偏差，schema description 亦写明）；原子对三态行为（双全 pinned / 双无 Auto / 恰一 skip + `agent-half-configured`）。失败消息带 `schema=… code=…` 与探针值——「naming the drifted pair」成立。
- **局限（如实判）**：代码侧**加宽**方向的漂移靠探针电池——e.g. 代码新增第三个接受 shape 值（"admin"）不在电池内，会静默漂移；id/pool 字符集的每个自然类别（大写/下划线/空格/点）与长度界均已探，但任意未探新类别同理。删/改名/收窄与 schema 侧任意漂移全部会被抓住。判 VERIFIED 而非 PARTIAL 的依据：requirement 文字「assert … against the code constants they mirror」在常量运行时不存在的前提下，import-函数行为镜像是等效实现，且「failing when either side drifts」对全部现实漂移类（rename/remove/schema-side）成立；建议后续导出一个运行时 `SHAPE_VALUES` 常量把加宽方向也锁死（follow-up，不阻断）。

**Scenario 3: $schema stays tolerated and the finding tells the truth — VERIFIED**

- 容忍：`tolerance: a $schema top-level key parses clean in both consumption paths` —— `parseForgeJsonc`+`validateAgentSet` 与级联 loader（fake fs 注入）双路径零 finding、roster 完整；schema 自身声明 `$schema` "Ignored by the plugin"。
- 文案：18d031e 将 `src/forge-config.ts:382` 的 `shape-invalid` 文案 `defaulting to readonly` → `defaulting to write (absent shape is write)`；测试 `finding text: …` 断言 `match(/defaulting to write/)` + `doesNotMatch(/defaulting to readonly/)` + `agents.a.shape === undefined`（下游 `def.shape ?? "write"`）。
- **文案修正确实进了产物**：`git grep -c "defaulting to write (absent shape is write)" HEAD -- dist/index.js` = 1，旧文案 0 命中（block B 的 f0ca2ef 重建晚于 18d031e，顺带携带——schema change 自身未重建 dist/index.js，时间线核对无陈旧包）。

### bundle 尾步合规 — **PASS**

`package.json` diff（0c08bbf）：copy 步**追加在 `bundle` 内部**（`… && node -e "…copyFileSync('schema/forge.schema.json','dist/forge.schema.json')"`），scripts 名单仍是 bundle/test/typecheck 三件，零新名；`files` 白名单零改动（dist 已含，pack 实证 4 files）；`exports` 仅增一行。与 design「publication red line」逐条吻合。

### 红线

- **schema 不碰 dispatch-async/plugin.ts — PASS**：五 commit 文件面逐一核对：0c08bbf=package.json+schema/forge.schema.json；9bdd7df=README.md；18d031e=src/forge-config.ts；54156e0=tests/forge-schema-mirror.test.mjs；5662845=dist/forge.schema.json+tasks.md+implement 报告。plugin.ts / src/dispatch-async.ts 零触碰（且 schema 报告自述工作树 M 状态全程可见下避让，与 git 历史一致）。
- **D0 零持久化 — PASS**：schema 是入库静态资产；运行时改动仅一行 finding 文案；parser 对 forge.json 只读（schema description 明言 "The plugin only ever READS this file"）。

### 独立复核（本 reviewer 实跑）

`tests/forge-schema-mirror.test.mjs` 6/6 pass（含在上述 71 pass 内，import 链全干净）；`npm pack --dry-run` 见上。

### Nits（不阻断）

- implement 报告引用 commit `14d9d5f`（rebase 前哈希，对象悬空存在，实际落地为 `5662845`）；报告正文称「tasks 1.1-3.3 已勾」而落地 tasks.md 3.4 也已勾（其 commit message 自称 1.1-3.4）；「74 行」实为 77 行。均报告内文不一致，不影响交付物。
- 镜像测试读 `schema/`（源），不读 `dist/` 副本——dist 一致性由 bundle 步 + 入库哈希保证，当前逐字节一致；若未来手改 dist 侧不会被测试抓住（低风险，记录备查）。

---

## 总表

| 对账 | 判决 | 场景 | 红线 | 遗留 |
| --- | --- | --- | --- | --- |
| Block B（nested-dispatch guard） | **CLEAN** | 2/2 VERIFIED（delta 实有 2 场景，非简报所称 3） | D0 ✅ / QUESTION_DENY 零语义变化 ✅ / 4.1 无缺口独立复核成立 ✅ | dispatch-guard 测试未实跑（plugin.ts 在改），静态审阅通过；全量 784 沿用工人数（互洽） |
| forge-config-json-schema | **CLEAN** | 3/3 VERIFIED | 不碰 plugin.ts/dispatch-async ✅ / scripts 名单零改动 ✅ / D0 ✅ / pack 含 schema（实跑）✅ | 镜像对代码侧「加宽」漂移探针依赖（建议后续导出运行时常量）；报告三处小笔误 |

两 change 均可进入 verify 阶段（openspec validate --all / 官方安装验证在 tasks 4.1、6.1 未勾，属后续阶段）。
