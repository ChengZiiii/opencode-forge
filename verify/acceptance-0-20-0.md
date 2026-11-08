# 验收报告 — 0.20.0 四变更批（exec-seal-o-precision / crew-autonomous-waves / crew-native-fallback / forge-prompt-shared）

- **日期**：2026-11-09（过夜自主批次，goal 契约 `.opencode/goal/2026-11-09-一夜完成-forge-四变更批-exec-seal-o-prec.md`）
- **版本**：0.19.0 → **0.20.0**（npm `@sorenllm/opencode-forge`，REST dist-tags `latest=0.20.0` 确认）
- **总账**：473/473 测试绿（442 基线 + 31 新增，零回归）· typecheck 0 错误 · dist 自包含 0.69MB · tarball 恰 3 文件（shasum `ba56250c524834380a2e43625adf2f2269414bd5`）· 12 条 conventional commits 工作区净 · 本地官方模式 store 双层 0.20.0 · forge + 5 工人注册在册 · token 零入库零日志

---

## 1. exec-seal-o-precision（readonly 执行闸 `-o` 精确化）

**问题**：`workspace-write` 指标把裸 `-o` 当输出目标标志，两个已复现假阳性把纯读搜索判成 WRITE——`rg -o "v1\.2\.3" package.json`（引号剥离后 `-o` 错绑到读目标）与 `rg -o needle.v2 src/`（模式带点过 pathLike 守卫），readonly 侦察兵被冤拒还被误导设 `shape: "write"`。

**落地**：写者二进制白名单 `O_FLAG_WRITER_BINARIES`（gcc/g++/cc/c++/clang/clang++/ld/rustc/go/curl/sort/psql/dotnet，导出表+no-drift 测试迭代）；`tokenizeCommand` 引号感知取值绑定（引号 token 绑为 flag 值，消灭错位重绑类）；长旗标（--out/--outfile/--dest…）不受白名单约束不变。README workspace-write 行加限定、绕过面逐字披露「已知写者集之外的 `-o` 放行（fail-open，已披露）」。

**证据**：两个假阳性 → READ、gcc/curl/go 捕获保持 WRITE（编排者亲跑 7 判全对）；新测试 6 例 + 表迭代 no-drift 断言；全套件 448/448；spec delta = tool-partition MODIFIED（+3 场景：非写者 `-o` 放行/写者 `-o` 拒/引号目标正确绑定），validate 通过。

**偏差**：表迭代测试拆分长旗标与 `-o` 轨道（旧行为下 `-o`+node 头是 WRITE，新设计就是 READ——规格内变化非范围漂移）；`resolveHeadBinary` 保持内部（表与 tokenizeCommand 已导出，头解析经分类路径覆盖）。

## 2. crew-autonomous-waves（waves 武装后 idle 自动推进）

**问题**：无 goal 治下的 waves crew，session 一 idle 就停摆——每波之间必须用户手推「继续」，长时/过夜 crew 不可行。

**落地**：续跑引擎加 crew 分支（`continueCrewIfEligible`，排在 live-goal 检查之后——goal 治下归 goal 引擎，双 brief 结构性不可能）；`[forge:crew-continue]` brief 内嵌 objective + 声明子任务标题（close 门自己的数据源，永不相悖）；复用共享守卫（禁用钮/debounce/in-flight/发送前后家族门/busy 复查/传输失败上限）；crew 侧活动计数（task 派发算活动，goal 引擎语义字节不变）；连续 3 个零活动 turn → 引擎停 + 一次有界披露（**crew 本身不动**——不自动弃船、不自动关账，用户始终掌舵）；零新增磁盘态。附带修复：`session.deleted` 现在清理 crews 条目与引擎态。

**证据**：tests/crew-continue.test.mjs 11 例覆盖全部 7 个 spec 场景（编排者亲跑 11/11）；全套件 459/459；/crew 模板与三个武装文案各加一句自动推进条款；README crew 节新增「Auto-advance on idle」条目。

**偏差**：goal-brief 的 crew 层行措辞顺带声明了 goal 治下不发独立 crew brief（场景 4 的诚实性），仍在 D5 一句话授权内。

## 3. crew-native-fallback（无可用 forge 工人时的原生 task 回退）

**问题**：两个真实场景让 crew 拿不到 forge 工人——池里没有适配角色的工人（如纯 coder 池要跑验证子任务）、池文件中途劣化（compliance 闸拒一切 forge-* 派发直到修复）；机制上原生 task 通道本就不被任何闸拦，但纪律文案与拒文案都没告诉模型这条路——crew 停摆或模型无记录地即兴。

**落地**：纯文案+披露，**护栏逻辑零 diff**——中途 compliance 拒文案加原生出口句（该闸只管 forge-* 派发，不管 crew 生死）；`crew_begin {execution:"waves"}` 全部武装变体（独立/出生武装/goal 委派）与 /crew 模板加一行回退规则（无适配 forge 工人或 forge 派发被阻 → 原生 general 子代理走同一 RELAY 契约，**并记录**——wave 笔记点名、close 证据写明 ran native）；注册预检拒文案与跨池拒文案刻意不动（D3/D4：注册守的是池契约，跨池是配置错误不是覆盖缺口）；close 门零改动（标题/判词/证据照旧治理）。

**证据**：中途拒文案断言原生出口句逐字在场、注册文案断言 `doesNotMatch /Native exit/`；crew-gate 新例——证据写「ran native」的子任务正常关账；全套件 460/460；README crew 节「Native fallback lane」条目。

**偏差**：plugin.ts/README/两个混合测试文件无法按变更逐文件拆分——合并提交以 slug 命名（12 条而非预估 8 条）。

## 4. forge-prompt-shared（forge.json 池级 shared 共享段）

**问题**：池作者在每个 agent 的 prompt 里重复同一段项目上下文——逐 agent 漂移、文件膨胀。

**落地**：forge.json 顶层可选 `shared`（字符串）——该文件物化的**每个** agent 继承；分层契约 = 严格前置 `shared + "\n\n" + 既有三层链`（显式 prompt > research/review 内置 > 通用一句话），shared 是池公共**基底**，不压不删任何层，无 shared 时物化 prompt 与旧版字节相同；fail-soft（非字符串/trim 空 → 一次 `shared-invalid` warn 点名文件、字段忽略、agents 照常物化）；**按文件作用域**（两个池各自的 shared 各归各，零跨池渗透）；全局兜底文件的 shared 照常继承（`pool` 命名空间被忽略的规则不外延到内容）；mtime 缓存热应用白得。角色库扩展维持拍板否决——reference-only，不新增具名角色。

**证据**：hierarchical-pools +8 例（三种组合/无效值单 warn/全局继承/双池隔离/无 shared 字节相同/热应用）、dispatch-prompt +4 例（严格前置逐字、mandate 层包裹不变）、forge-subagents-wiring +1 例（server 级物化）；全套件 473/473。

**偏差**：无（设计 D1-D5 全遵守）。

---

## 发布与本地更新证据

| 项 | 证据 |
|---|---|
| 版本 | 0.19.0 → 0.20.0（node -e 写 JSON，未触 Set-Content） |
| 提交 | 12 条 conventional（src:/plugin:/tests:/docs:/chore:），工作区净（porcelain 空），未 push |
| 发布 | `+ @sorenllm/opencode-forge@0.20.0`；token 仅进程级 env，零入库零日志 |
| 注册表 | REST dist-tags `{"latest":"0.20.0"}`（发布后约 5.5 分钟翻转，CDN 传播预期内） |
| 本地更新 | store `npm_@sorenllm/opencode-forge` 删后重装，根 deps 与内层 package 双 0.20.0；config 恰一条 `npm:@sorenllm/opencode-forge`；agent list：forge 主代理 + 5 个 plugindev 工人 |
| tarball | 恰 README.md + dist/index.js + package.json（3 文件，红线守住） |

## 遗留与后续（明早验收后由你定）

1. **四张变更单未归档**（含此前的 forge-search-tools 共五张）——按约归档需你明确指示（`openspec archive <name> --yes`）。
2. **未 push 远端、未做 github 源终验**——本轮闭环口径为 npm+本地，github 环节留待后续。
3. **重启生效**：本会话/运行中宿主仍是 0.19.0 工具面——重启 opencode 后 0.20.0 生效（shared 字段、crew 自动推进、原生回退文案、`-o` 精确化全部在线）。
4. spec-reviewer 独立审查未在本批逐单跑（四单实施期间的编排者亲验 + 全套件门替代）；如需补一轮独立规格审查，明早说一声即可按 forge-search-tools 的口径补。
