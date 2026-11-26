# 架构与机制（改 plugin.ts / 查机制前必读）

> 由仓库根 `AGENTS.md` 路由到本文件。读完就退场，不常驻上下文。
> 2026-11-26：以已批准的 `retire-plugin-runtime` 为现行目标架构。以下区分工作区源码已实现的部分、待宿主验证的部分与尚未完成的目标；不代表已发布版本或最终验收结果。详细契约、证据及剩余工作以该 change 的 `design.md`、`specs/`、`tasks.md` 为准。

## 架构总览

Forge 是主代理及 Plan / Crew / Goal 文件契约的治理层，不再承担通用执行运行时。v2 原生 shell、权限、子代理、消息与完成通知归宿主管理。三个 harness 保持既有生命周期和安全互操作，不另造宿主执行、排队、重试或监管机制。

| 边界 | 工作区现状 / 目标 |
| --- | --- |
| 执行 | 插件执行工具、作业注册/唤醒、执行封条和进程停滞看门狗的实现已移除（tasks 4.2–4.5）；原生 shell 的真实权限及后台行为待探针 A/B/C。plan/goal 冻结检查的宿主执行器仍保留，不是通用执行面。 |
| 派发 | 插件 `task` 工具及派发引擎核心模块已删除（5.1、5.3）；原生 `subagent` 是目标唯一入口，完成通知、子会话记录和消息续用由宿主负责。旧入口的兼容拦截及原生派发门迁移还未全部完成（5.2、6.x）。 |
| 搜索 | 已移除旧搜索别名及相应分区（8.5）。当前保留内建 `grep` / `glob`；仅在原授权与输出契约等价可证时做同名扩展（D9、8.x）。增强尚未完成。 |
| 停止 | **尚未完成**：当前 `/forge stop` 仅披露自动取消不可用，不能声称已经停止任何子会话或命令（D8、7.x）。 |
| 加载 | 当前仍有 `server` 和 `v2Setup` 两个入口及旧停用判断；package.json 仍导出 `./server` 且兼容 v1。最终仅支持 v2，使用宿主原生插件启停（D10、9.x）；不能宣称已删除 v1 或完成启停迁移。 |

### 文件职责

`src/` 保存逻辑核心，不依赖 `@opencode-ai`；宿主接线在 `plugin.ts`，文件系统、runner、客户端等依赖用注入缝测试。

| 文件 | 保留职责 |
| ---- | ---- |
| `plugin.ts` | 工具与命令登记、会话定位、权限确认、拦截带、模型/深度注入、Plan/Crew/Goal 状态接线。v2 `setup` 的注册与清理按宿主实例处理。 |
| `src/forge-config.ts` | JSONC 解析、字段级 fail-soft 校验（坏条目跳过+finding，兄弟生效；坏可选字段忽略+warn；坏文档仅清空本层）。`forge-` id 前缀自愈、归一碰撞 latter-skip；`thoughtLevel` trim+小写归一及 finding；无 seed。池解析、确定性命名、mtime 缓存及每次发现链重走。 |
| `src/roster-compile.ts` | 从配方生成宿主 Markdown 代理文件；探针确认的 frontmatter、角色 prompt、原子写、内容/编译契约兼容性及 marker GC。`NATIVE_TOOL_VOCAB` 为原生工具名词表。独立的 general/explore override 不与 namespaced worker 共享新权限策略。 |
| `src/dispatch-tiers.ts` / `src/dispatch-prompt.ts` | 工人定义、角色说明、提示词组合和形状纪律；保留名字中的 dispatch 不代表保留派发引擎。角色 prompt 优先级为显式 > research/review 默认 > 通用。 |
| `src/dispatch-depth.ts` / `src/models-dev.ts` | 推理档位翻译、catalog 快照与模型形状选择；非执行引擎。 |
| `src/plan-file.ts` | plan 渲染/解析、结构校验、打勾变换、状态迁移、close 校验、active 发现排序。 |
| `src/goal-file.ts` | goal 契约渲染/解析（frontmatter + 7 章节）、Check Log / Turn Ledger、预算状态、合法迁移、`carryHistory` 保留审计、live/queued 发现排序；不 import plan-file。 |
| `src/crew-gate.ts` | close 对账声明计划：漏判、缺证据、野子任务、FAIL 双报告四类拒绝；标题归一匹配，不依赖旧派发账本。 |
| `src/native-child-gate.ts` | 既有原生孩子状态观察、终态与未知区分，供 harness 判断合法等待；不创建孩子或替代宿主完成通知。 |
| `src/goal-activity.ts` | 轻量活动观测，区分真实工具执行和可比较的检查证据；目标是减少误暂停，不是模型评估器。 |
| `src/run-check.ts` / `src/proc.ts` / `src/shell-select.ts` | Plan/Goal 共用冻结检查执行、文件契约、cwd、解释器选择及检查超时清理；保留的有限检查链（4.7、6.10）。v2.4.0 公开接口无初始 merged shell 输入，按既有平台链回退且不声称与用户自定义 native shell 等价；真实解释器探针尚待 1.14/9.1。 |
| `src/search-core.ts` / `src/search-js.ts` | 搜索结果语义及双引擎实现；同名扩展仍待 8.x，不因现有引擎可用就推断原生权限等价。 |
| `tests/*.test.mjs` | node:test 纯函数、合成宿主接线及有限本地执行测试；v1 保留行为断言先迁移再删入口（1.16、9.x）。 |
| `dist/index.js` | 自包含构建产物，入库；最终产物及安装行为独立验收。 |

## 名册、原生工具及权限边界

- **sole-pool-ownership / pool-namespace-contract**：会话锚点向上最近的 `.opencode/forge.json` 是该工作区独占池，嵌套子树不扫描。仅无工作区池时整体 fallback 到 global，不合并；坏工作区文件不退 global。host materialization union（global + 已见工作区池）不是单会话 roster。池文件删除即失池，归属按磁盘真值重推。全池命名 `forge-<ns>-<id>` / `forge-global-<id>`；没有 primary 纯 id 特权。路径纯字典序确定性、namespace 撞名后缀及跨族 id 撞名先者胜，均有 finding。合法 `pool` 声明用于 crew 合规检查，单个坏工人条目不构成文件级违规。
- **物化**：native-first Markdown 代理（`mode: subagent`，description 带池来源、model 钉扎）。生成头标识配方及所有权，显式 sync 或既有 auto opt-in 才写，GC 只处理确认所有权的孤儿；手写同名文件不改不删。过期/升级兼容按内容与编译契约，不以 mtime 相同或 touch/checkout 判成功。当前已有兼容检查接线，workspace/global/override 实际热应用及权限面仍待 3.7、1.15。
- **工人形状（D2）**：缺省 shape 为 write。现有 namespaced worker 编译已转向原生工具权限：默认关闭 `subagent`、`question` 和 15 个 harness 工具，readonly 另关闭写/编辑/patch 家族及 `execute`，默认保留原生 shell。显式权限覆盖形状默认（`subagent` 禁再派不可解除；`shell`/`bash` 读作同一动作）的完整验证尚欠 3.2/探针 C。允许工人提问可能无法收到后台回答；readonly 不再具有命令级只读封条，不能当沙箱。general/explore 原有独立投影语义不因 namespaced worker 改变。
- **工具分区（D6 目标）**：15 个状态工具（6 plan、6 goal、2 crew、1 sync）仅主代理使用；工人及非 forge 调用由拦截带拒绝，不改写他人 tools/permissions；Tab picker 隐藏与实际登记可用性独立，显式用户配置优先。原生派发不按调用者族限制，而按会话及目标判门。当前旧兼容分区仍有残余，6.5/9.1 未完成。
- **钉扎**：`dispatch-depth.ts` 的七词（none/minimal/low/medium/high/xhigh/max）是词典而非白名单；不插值、词通道默认透传并披露 unverified，legacy budget 无对应词或纯 toggle 档词不注入并给 finding。Anthropic 家族传输形状优先于目录声明（adaptive effort 与 legacy budget 分开），其后 catalog / provider fallback。v2 draft 不写 model 的历史宿主差异由 context payload 钉扎承接（2.3.2 曾实证），本 change 最终实际服务模型与 catalog snapshot/cache/null fallback 仍需 1.14、11.2 验证。

### 拦截带与确认门

宿主 v2 `tool.execute.before` 能拒绝完整工具调用（含目标参数）；`permission.evaluate` 只在宿主工具请求权限时触发，不能替代调用拦截。依据 D4、D7，最终顺序为：可靠会话定位 → 草稿期写禁 → 状态文件边界 → harness 工具分区 → 原生派发池归属 / crew 暂停 / crew 合规门。Goal 暂停授权检查优先于新自主工作接纳与续跑；未知会话归属对一般池门不猜、不借默认目录，放行须披露，不等于未知 goal 授权可放行。

当前 `v2RegisterToolHooks` 已使用原生词表并接入会话定位、状态文件边界、原生目标池归属及工件过期预检；仍有旧 `task` 兼容分支，草稿侦察、crew 暂停/合规及完整顺序尚未迁完（6.1–6.8），不能把 before 放行当真实宿主成功。状态文件边界已在合成 v2 测试中覆盖直接 write/edit（主代理亦须经状态工具），读放行；未知锚不借用其他目录。

草稿期目标合同：原生 shell 和写类工具禁用；仅显式 readonly、无写权限抬离、显式禁 shell 且实际宿主权限面和生成工件合格的工人可侦察。续用按本次指定代理判，不能以旧身份绕开；其他目标拒绝并列可派名册及批准/放弃出口。真实拒绝不建孩子、合格侦察完成并回报仍待探针 D 和 11.2。

六个确认门（源码 `GATE_PERMISSION_KEYS`）：`plan_approve`、`goal_write`（arm）、`goal_complete`、`goal_resume`、`goal_discard`、`crew_close`。显式拒绝不改为 allow，其余不得自动批准；goal 治下 crew 的既定免 ask 路径保留。`plan_close` 不是确认门，冻结 checks fail-closed，失败记 Check Log 且留 approved。`plan_reopen` 是纪律层回滚窗。

历史契约（`fix-ask-door-multi-directory-host`）：v2 的 assert 按初始化目录隔离，工具上下文必须捕获本实例 assert，不使用模块级回退。旧事故中最后初始化目录覆盖 assert，导致终端回答落错表、404，卸载该目录后全局受影响。接口缺失 fail-closed；不换实例重问用户拒绝。确认门等待超时 `FORGE_GATE_ASK_WATCHDOG_MS` 独立保留，与已退役的进程看门狗无关。六门真实 allow/deny/超时、多目录及免 ask 仍须最终 E2E。

## 三个 harness 的文件与生命周期

磁盘事实源是 Plan/Goal frontmatter，会话状态绑定仅在内存；重启后按真实会话目录及文件重新定位，不跨工作区猜测。`/plan`、`/goal`、`/crew` 命令模板自含各自纪律，OpenSpec / Plan / Goal 语义独立，仅安全互操作（draft 禁写优先）。命令实际身份守卫不依工具可见性；已有合成测试，但宿主命令时身份仍待 1.13/6.9。

### Plan：决策优先

`.opencode/plan/` 文件，draft → approved → done；draft/approved 可 abandoned，done 可经 reopen 回 approved。结构经工具校验，打勾带时间戳审计，批准必须用户确认。close 使用冻结 checks 由插件检查执行链重跑，失败不完成，不新增模态门。保留真实检查执行、文件契约、失败证据；不等于允许插件提供一般执行工具。模板已改用原生词汇（3.5），真实草稿侦察门仍在迁移。

### Crew：声明与证据

`.opencode/crew/<date>-<slug>.md` 为 record-only 历史，共用 sessionAnchor 链；内存 crew 注册与武装分离：PENDING 时不授权派发；waves / goal 交接 / standby，既有 goal born-armed、abandon 及 close 语义保留。重启不从记录自动复活 crew。当前已有 native-child 观察与有界回查；完整 native round 记账和暂停门仍待 6.4、6.7、6.11。

目标合同：一波为原生派发调用轮次，收齐才推进；同 session 续用是不同轮次，重复观察不重复计。idle、消失、未知、部分/截断枚举均非成功或整波结算。等待不发正常续跑简报，诊断与宿主完成通知分离，不补发通知。close 将声明子任务、原生派发/续用轮次、fallback 与实际证据关联，子会话终态不等于任务 PASS，失败尝试不冒充 PASS；保留既定一次重试及诚实 FAIL 的证据合同，不恢复插件派发重试引擎。

### Goal：执行契约与防误暂停

`.opencode/goal/` 五态：queued → active ⇄ paused → completed/abandoned（具体合法迁移由 `goal-file.ts` 判定；paused 必带 `stop_reason`）。保留契约 revision/history、Check Log / Turn Ledger、turn/分钟预算、原确认门、完成时全部检查重跑且 fail-closed，以及既有 idle 续跑生命周期。压缩保留 goal brief；主动续跑仅在主代理及现有授权之下。没有新的 waiting 状态。

**已经局部实现**：goal brief 区分全局/局部 blocker，不再要求每轮写或检查；`goal-activity.ts` 与 after-hook 区分只读等活动、检查证据及执行计数，按 call id 去重；检查记录仍保留。现有 crew native-child 状态观察与有限回查仍在。这些不是全部 D11 已落地或真实宿主等待已验的证据。

**最终合同（D11、6.11，待完整实现及验收）**：

- **暂停优先**：`goal_pause` 原子保存具体 blocker。暂停成功撤销未接纳的 pending/debounced 续跑决定；在投递及新自主工作调用被接纳时重核当前 status/session/revision 与授权，不能由 fallback、同 session 续用、过时内存决定绕过。重复/迟到 idle、结果、重启及用户普通交谈不能自动激活；只沿原 resume 确认门。已被宿主接纳的调用可能继续，不承诺取消。goal 治下 crew 的 pause/预算耗尽/discard/complete 不自动降级 standalone；未知授权等待用户。预算耗尽的一次总结不授权工作，显式暂停优先。
- **合法等待**：按宿主可靠关联证据区分原生孩子（含非 crew）、后台 shell、可观测权限/用户等待。等待不消耗自动续跑 turn、停滞或传输失败计数；分钟硬上限照常计时，armed_at、revision、重启规则不变。未知/部分/截断不猜结算；仅全数结算且仍有授权才恢复既有生命周期。真实等待范围、轮次及迟到事件尚待 H/11.2。
- **防误暂停**：连续两轮阈值只用于明确无活动的实际工作轮。只读侦察/评审、新检查证据或失败定位、提交、非 git 工作区，不因无写操作、shell 或 diff 判停。相同检查输入（含作用域/revision）与可比较完整结果（含状态/退出码/输出及文件契约结果）且无其他新活动，才可判重复无信息并有界暂停；新活动/证据复位，截断与未知不冒充相同。具体策略及反例依 6.11 验收。局部问题尚有独立工作不判全局阻塞；全局 blocker 通过 `goal_pause` 具体落盘，不靠回复关键词。
- **无额外 LLM verifier**，无语义评分、通用进程监管或单 turn 内全部循环检测保证；Token 预算只做宿主能力探针（1.8），不实现预算或宣称硬限。活动判定不改变 plan 写禁或 standalone crew 自身既有判定。

## 尚未完成的宿主边界

- **停止（D8）**：目标为命令执行体内、与模型配合无关的有限宿主停止能力，非 forge 会话也是合法入口。范围仅确认属于本会话原生派发的孩子及其后台命令；归属未知、部分枚举、失败不能扩围。请求与确认终态分列，不触碰其他会话、其他作业或用户排队消息，不删子会话。当前只有不可用披露，不能将目标合同当作可用操作；7.x 及 E/G 未完成。
- **搜索（D9）**：目标是在宿主内建定义上保留原参数、输出 schema、授权及环境可用性约束的同名扩展，保留 follow/hidden 结果语义及去重/外部目标披露。实际外部链接目标须读取前获得原宿主授权，双引擎均须等价；无法证明则保持内建、不安装覆盖、不加别名。最终卸载恢复内建，8.x 与 F 未完成。
- **停用/卸载（D10）**：最终采用宿主原生插件启停、删除旧私有 disable 判断；代理 disable 不等同于插件停用。停用不运行 Forge 注册/门/续跑/搜索扩展，宿主配置继续生效。落盘 workspace/global 工人及 general/explore override 是独立加载的宿主工件，可能仍有效但失去 Forge 门与注入保障；不自动改写、隐藏或删除，没有 marker 或所有权不明的文件须保留。Plan/Goal/Crew 历史及 forge.json 不因停用而删除。具体启停、作用域、多目录及恢复待 K/9.x/11.3 实证。

## 历史边界与证据纪律

旧 `forge_shell`、`forge_jobs`、插件 `task` 派发、作业/看门狗、封条、派发日志和报告文件恢复通道均属于退役历史，不是现行设计。旧队列/并发上限、自动派发重试、收养、结果流补发和进程击杀保障不再承诺；子代理结果以宿主记录和实际证据为准。`dispatch-tdd-process.md`、`dispatch-wargame.md` 已在各自文首标注历史用途，不执行其旧验收或目标文本。历史设计可回查 Git 与原 OpenSpec，不能作为当前操作指令。

残留 `dispatch`、`jobs.*`、`watchdog.*` 配置及旧 `FORGE_DISPATCH_*` env 忽略并有界告警。探针 I 已在隔离 v2.4.0 开发包中实测通过（tasks 1.9），不等于最终产物验收。旧临时文件不读不删；保留 models-dev cache、会话锚点账本、探针日志。旧运行中作业升级前由用户核对；回滚不保证旧作业生命周期无损。

工作区源码及测试事实见 tasks 2–6 的记录；typecheck 和单测（即使全部通过）只是最低门槛。真实宿主探针、最终 dist 的沙箱 E2E/TUI、官方安装终验分别见 tasks 1、11，未验项不能因代码存在或 mock 通过而关闭。不得为文档更新新增运行机制。归档及主规格收尾另依授权处理。
