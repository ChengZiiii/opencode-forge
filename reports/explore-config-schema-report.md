# explore：forge.json 配置工程化勘察（schema 随包 + $schema 引导 + 迁移记账）

- 基线：HEAD `ed899ec`（2026-11-21）。全部源码事实经 `git show HEAD:<path>` 取证，行号即 HEAD 行号；工作树 src/ 改动（Block C dispatch 节）未读、未碰。
- 参照：`reports/omo-subagent-research-report.md` 第 6 亮点（L201）与建议动作 3（L205）、Q2 节（L33-84）。
- 方法：`git show` 逐文件精读（src/forge-config.ts 全文 922 行、package.json、AGENTS.md、README.md 相关节、tests/forge-config.test.mjs 测试名清单）+ `git grep` 全仓库概念清零验证。
- 产出性质：只读勘察报告，本文件是唯一新增物。

---

## Q1：forge.json schema 面 —— 字段清单与手写 JSON Schema 可行度

### 1.1 顶层键（代码实际消费的全部）

两个活消费器读同一份文件，但读键集合不同：

| 顶层键 | 类型与约束 | 消费位置（HEAD src/forge-config.ts） | 违规 finding |
| --- | --- | --- | --- |
| `agents` | object：id → agent 定义 | 级联 loader `readCandidate` 只读 `top.agents`（L542）；池解析器 `readPool` 读 `top.agents`（L754） | 非 object → error `agents-not-object`（L298-301） |
| `pool` | string，trim 后 1..24 字符，`^[a-z0-9-]+$` | 仅池解析器读 `top.pool`（L771），`validatePoolField`（L663-668）校验 | 无效 → warn `pool-field-invalid` + 池目录名兜底（L835-842）；**全局兜底文件上声明 pool → warn `pool-field-ignored-global`，ns 固定 "global"**（L830-833，L864-866） |
| `shared` | string，trim 非空，载入时 trim | 仅池解析器读 `top.shared`（L762-770） | 无效 → warn `shared-invalid`（L768） |

- 文档级错误：JSONC 解析失败 → error `config-parse-error` 带行/列（级联 L514-530，池 L737-749）；顶层非 object → error `config-not-object`（L533-540 / L750-751）。
- **不对称事实**：级联 loader（`createForgeConfigLoader`）**不读** `pool`/`shared` —— 同一份文件走级联路径时这两个顶层键静默不消费。接线面（plugin.ts HEAD）：池解析器是物化真源（L352 v1 / L6824 v2），级联 loader 每 anchor 一个（L368-376），crew 合规闸用 `poolFileCompliance`（L432 ← forge-config.ts L678-687）。
- 未配置态：惰性且无声，零 finding（L572-575）。

### 1.2 agents 条目字段（`validateAgentSet`，L294-394）

| 字段 | 约束（代码事实） | 违规后果 |
| --- | --- | --- |
| 条目 id（object key） | `AGENT_ID_RE = /^[a-z0-9-]+$/`（L284，判于 L314）；`forge-` 前缀全部重复剥除（自愈，L310-313）；归一后碰撞 first-wins（L318-323） | 无效 id → error `agent-id-invalid` 跳条目；前缀剥除 → warn `agent-id-forge-prefix`；碰撞 → error `agent-id-collision` |
| 条目本身 | 必须是 object（L324-327） | error `agent-not-object` 跳条目 |
| `model` | string，trim 非空（L334-340） | warn `model-invalid`，**计为缺失参与配对** |
| `thoughtLevel` | string，trim 非空 + 强制小写归一（L342-356） | warn `thoughtlevel-invalid`（计为缺失）/ warn `thoughtlevel-normalized`（改写披露） |
| **model/thoughtLevel 原子对** | 双全=pinned，双无=Auto，恰一=error `agent-half-configured` 跳条目（L357-364） | README L887-896 有逐格表格 |
| `prompt` | string，trim 非空（L370-376） | warn `prompt-invalid` 忽略字段 |
| `shape` | enum `"readonly" \| "write"`（类型 L20，判于 L377-383） | warn `shape-invalid` 忽略字段 |
| `permission` | `Record<string,string>`（值全 string，L384-390） | warn `permission-invalid` 忽略字段 |
| `depths`（弃用） | 存在即 warn `depths-deprecated`，零行为（L328-330） | 不参与任何逻辑 |

- **发现一处文案漂移（供 change 顺手修或单列）**：`shape-invalid` 消息说 "defaulting to readonly"（L381），但无效值时代码不设 `def.shape`，下游 `dispatch-tiers.ts` L106 `def.shape ?? "write"`（shape-default-open）——**实际落 write，消息说 readonly**。行为正确、文案错。

### 1.3 手写 JSON Schema 可行度：高，估算 100-150 行

- 全部字段是 string / object / string-record，enum 仅 `shape` 两个值；pattern 现成：id key（`propertyNames` + `^[a-z0-9-]+$`）、pool（`^[a-z0-9-]{1,24}$`）。
- **不要收窄**的两处：`thoughtLevel` 是开放词表（dispatch-depth 词典 7 词非白名单，README L871 "or any word — write lowercase"）→ schema 只给 type+minLength+examples，禁 enum；`model` 是自由 "provider/model" 串（README L870）→ 同理。
- 原子对可表达：`anyOf: [{required:["model","thoughtLevel"]}, {not:{anyOf:[{required:["model"]},{required:["thoughtLevel"]}]}}]`——VS Code json 语言服务支持。
- **顶层禁设 `additionalProperties:false`**（保 `$schema`、未来可选键、用户注释键的顺容忍）；`depths` 收录但打 `"deprecated": true` + 指路 `thoughtLevel`。
- 已知取舍：代码对 pool 先 trim 再验长（L665-666），schema 的 pattern/minLength 作用于原串——含首尾空格的边缘值会 schema 报错而代码通过。手写文件场景下 schema 严于代码是可接受方向，change 里声明即可。
- 对比 OMO 94KB schema（categories/team_mode/background 全家桶，报告 L4）——我们的字段面小两个数量级，**手写远优于生成**：校验器是手写命令式 TS（fail-soft/原子对语义不可 zod 化而不复制逻辑），强行 codegen = 双真相源漂移风险；plugin.ts L5801-5812 的 `z.toJSONSchema` 是 v2 工具参数域（宿主 zod），与配置域无关，不能复用。

---

## Q2：发布面 —— files/exports 现状与合规发布通道

package.json（HEAD）事实：

- `files: ["dist", "README.md"]`（L14-17）；`exports` 仅 `.` 与 `./server`，都指 `./dist/index.js`（L6-13）；scripts 仅 `bundle`/`test`/`typecheck`（L18-22）；版本 0.28.0。
- AGENTS.md 打包红线（硬性）：scripts 只许 bundle/test/typecheck 三个安全名；`files` 白名单 = dist + README.md，发布前 `npm pack --dry-run` 核对；dist 入库。

**合规发布方案（不破任何红线）**：

1. **schema 源文件入库**（如 `forge.schema.json` 放仓库根或 src/，作为 commit 真相源）。
2. **随 `bundle` 脚本拷入 dist**：红线约束的是脚本**名**不是脚本体——在既有 `bundle` 命令尾部追加 `&& node -e "…copyFileSync('forge.schema.json','dist/forge.schema.json')…"`，名字仍是 `bundle`。`files` 里 `dist` 是目录白名单，**dist 内的一切随包发布**，白名单零改动。
3. **`exports` 加 `"./schema.json": "./dist/forge.schema.json"`**：与 OMO 同形（报告 L39）。技术上 unpkg/jsdelivr 直链原始文件不依赖 exports；但 exports map 存在时 Node 子路径解析会封未列路径——加这条让 `require('@sorenllm/opencode-forge/schema.json')` 类消费与自文档化都成立。
4. dist 入库纪律照旧：拷贝产物随 `dist/index.js` 一起 commit（与现行 dist 入库一致）。
5. `$schema` URL 形态：`https://unpkg.com/@sorenllm/opencode-forge@latest/dist/forge.schema.json`（README 可同时给钉主版本写法）。

---

## Q3：迁移现状 —— 零版本概念（已确认），_migrations 最小映射与取舍

### 3.1 现状：什么都没有，且是刻意立场

- `git grep -i '$schema|json schema|_migrations|migrat|schemaVersion|configVersion' HEAD -- src plugin.ts tests README` → **配置域零命中**。命中的全是无关项：plugin.ts L5801（v2 工具参数 zod shim）、src/dispatch-async.ts L333（注释）、README L917/985（onboarding 历史叙述）、crew 测试标题。
- 无版本字段消费、无迁移钩子、无 schema 发布——确认。
- **只读是公开承诺**：README L898-899 "The plugin only ever reads this file. It never creates, writes, or migrates it"；L299 文件账本 "the plugin only reads them, never writes or migrates them"；forge-config.ts 头注 L14-16 "NO seed and NO fallback … only ever READS the file"。

### 3.2 OMO `_migrations` 要点（报告 Q2 节 L39、示例 L49/82）

- 配置文件带 `_migrations: string[]` 记账已施迁移 id；启动 `startup-migration` **自动改写用户文件**（连用户 opencode.json 里的 legacy 插件条目都改写）。

### 3.3 对我们形态的最小映射

- forge.json 无版本字段 → "需迁移"只能靠**内容指纹**（如出现 `depths` 即旧纪元文件）或**引入顶层 `version` 键**。引入是零后向代价的：未知顶层键被所有已部署版本静默忽略（同 Q4 机制）——但这只是"可以"，不是"需要"。
- **史实**：配置格式从未发生过破坏性变更，只单调加可选键（`pool`、`shared`）+ 弃用告警（`depths`）。fail-soft 弃用 finding（warn + 指路文案）就是现行迁移故事，零机器成本。
- OMO 式启动自动迁移 = **写用户文件**，与 forge 只读承诺正面冲突（spec/README 双重钉死）。若未来真有破坏性改名，forge 形状的答案也是"error/warn finding 给出逐字修复指引"（depths 先例），而非静默改写。
- **结论：`_migrations` 现在不做**。记账机制只在"反复自动化改写"里回本，而我们已承诺永不改写。

---

## Q4：$schema 引导可行性 —— 今天就零改动可用

- forge.json 是 JSONC：`sanitizeJsonc`（L54-127）剥注释/尾逗后 `JSON.parse`（L269）是真解析器。`$schema` 作为**顶层键**是普通 JSON 数据，不是注释——解析后完整保留。
- 两条消费路径都只取已知键：级联 `readCandidate` 只读 `top.agents`（L542）；池 `readPool` 只读 `top.agents`/`top.pool`/`top.shared`（L753-771）。**全文件不存在任何 unknown-key 检查**（顶层和条目内都没有）→ `$schema` 被静默容忍，不产生 finding，不影响任何行为，零代码改动。
- 测试侧印证：tests/forge-config.test.mjs 无任何 unknown-key 用例（因为没有该处理路径）；"mistyped optional fields … degrade per field" 等用例锁的是已知字段的 fail-soft，不锁未知键。
- 编辑器侧：VS Code 对 .json 文件的 `$schema` 键有原生支持（补全/hover/校验）。一个 README 级注意点：文件扩展名是 `.json` 而非 `.jsonc`——注释/尾逗在纯 json 关联下会有**编辑器自身**的波浪线（与 schema 无关）；README 建议一行 `files.associations` 或 `json.schemas` 映射可双修（schema 校验对 jsonc 关联同样工作，OMO 用 .jsonc 扩展名规避了这一点，我们不需要改扩展名）。

---

## change 打包建议（schema 工程化最小切口）

**值得做的部分（一个小 change 的完整清单）**：

1. **手写 `forge.schema.json`**（不生成）：Q1.3 的字段面全部现成——shape 两值 enum、id/pool 正则、原子对 anyOf/not 表达、顶层不设 additionalProperties:false、`depths` 打 deprecated、`thoughtLevel`/`model` 开放串 + examples。估算 100-150 行 + 描述文案（description 里顺手带上"pool 字段是 crew 合规必需"这类 README 级语境，Q1.1 的 crew 闸语义正愁没处安放）。
2. **发布通道**：源文件入库 → `bundle` 脚本尾部加拷贝（脚本名不变，红线只管名字）→ dist 内随目录白名单发布 → `exports["./schema.json"]` 指向 dist 副本 → `npm pack --dry-run` 核对照旧。
3. **README 双行**：示例顶部加 `"$schema": "https://unpkg.com/@sorenllm/opencode-forge@latest/dist/forge.schema.json"`（OMO 同款引导，报告 L49）；补一句 .json 扩展名下注释波浪线的关联建议。
4. **漂移防线（关键）**：新增（或扩展）测试断言 schema 的 enum/pattern/required 与代码常量镜像——`AgentShape`（L20）、`AGENT_ID_RE`（L284）、`validatePoolField` 正则与长度（L663-668）逐项对照。手写 schema 唯一的风险就是与校验器漂移，一条测试锁死。
5. **顺手修**：`shape-invalid` 文案 "defaulting to readonly" → "defaulting to write"（L381 vs dispatch-tiers.ts L106 的 shape-default-open 事实）。行为正确文案错，一行修，schema 的 description 别复刻这个错。

**不做（诚实评估）**：

- **`_migrations` / 启动自动迁移：不做**。Q3 已论证：无版本字段、史上零破坏性变更、只读是 README 公开承诺、OMO 的价值前提（写用户文件）与我们立场相反。现有 fail-soft 弃用通道（depths 先例）已覆盖可预见未来。何时重访：真发生一次破坏性字段改名，且 finding 文案 + 文档不足以引导用户时——即便那时，答案多半仍是 finding 而非改写。
- **从代码生成 schema：不做**。校验器是命令式 fail-soft TS，zod 化=复制语义=双真相源；字段面之小让手写+镜像测试的总成本低于任何生成管线。
- **收益定位（是否值得做的诚实评估）**：字段面已稳定（近五周高强度迭代只加过 pool/shared 两个可选键，agents 条目五字段未动）、用户群小——schema 的现实收益就是**编辑器补全 + 拼写防线**（`shape:"read-only"`、漏 thoughtLevel、pool 超长这类错误在落盘前被编辑器截住，而不是等重载后翻 diagnostics log，README L910），外加 crew 合规语义（pool 必填性）有了可发现的安放处。是 DX 改良不是正确性需求：值得作为一个小 change 排队，不紧急、不阻塞任何线。

---

## 附：本报告事实源清单

| 事实 | 来源（HEAD ed899ec） |
| --- | --- |
| 字段面/校验/finding 全表 | src/forge-config.ts L20-34, L284, L294-394, L418-423, L542, L663-687, L753-771, L830-842, L898 |
| 双消费器接线 | plugin.ts L77, L311, L352, L368-376, L432, L6824 |
| shape 默认值漂移 | src/forge-config.ts L381 ↔ src/dispatch-tiers.ts L106, L140-141 |
| 发布面 | package.json L6-22；AGENTS.md 打包红线节 |
| 迁移概念清零 | git grep 全仓库（见 Q3.1 命中清单） |
| $schema 容忍 | src/forge-config.ts L54-127, L269, L542, L753-771（无 unknown-key 检查） |
| 用户文档现状 | README.md L577-674（池语义）、L852-919（字段参考/原子对/只读承诺/fail-soft）、L299（文件账本） |
| OMO 机制参照 | reports/omo-subagent-research-report.md L4-5, L33-39, L46-84, L201, L205 |
