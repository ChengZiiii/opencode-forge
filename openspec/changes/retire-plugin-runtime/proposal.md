# retire-plugin-runtime

> **状态（2026-11-26）：业主已批准四件套、A 组产品默认项 1–8、10、11（全部按表默认，一批完成），并明确授权前置治理 12、18。** 授权记录见 `reports/goal-retire-plugin-runtime-2026-11-26.md`。技术项按既定范围由后续探针证据约束，不代表已实现或已验。前置治理仅文档/OpenSpec；0.3 由主会话确认，未进入 apply。
> 定点复核：架构 6/7 已闭合，规格 blocker 4/6、nit 3/3 已闭合；剩余两项（坏 workspace pool 的 fail-soft 基线、fallback 与 crew_close 证据校验的冲突，其中后者也是架构复审唯一未闭合项）已直接修正，并由规格评审员定点复核两项均 CLOSED，结论 PASS / 0 blockers。主会话核对基线 scenario、任务承接及 strict 校验。此结论限于规格复审，不代表实现或宿主实测通过。
> 批准前 strict 历史记录：单 change 通过，但 builtin-override 未归档导致 archive 预测拒绝；全量 strict 21 通过、1 失败（D 草案无 delta）。2026-11-26 已依批准处置，见下方归档顺序与治理记录。二轮发现按三组处理：① harness 入口身份、等待预算与轮次证据、共享校验、实际侦察及组合验收；② 保留依赖与先迁测试、旧工件升级、stop 诚实回执、搜索权限及参数语义、picker；③ 多目录 ask 基线、依赖与归档/清理治理、确认编号。第三轮修正 pool/override、goal 权限与分钟硬上限、crew evidence、picker、catalog、stop 双证、链接授权、deny 侦察、重复与 watchdog；此处不代表再次评审通过或用户批准。
> 每条事实后面标了它是怎么知道的：〔源码〕读过宿主 v2.4.0（提交 `44aed4f`）或 forge 的源码，没有实跑；
> 〔沙箱〕D 草案那两轮沙箱里实际跑过（原件在工作区根 `archive\2026-11-25-d-native-probes\`、
> `archive\2026-11-25-d-peer-survey\`）；〔未验〕只有推断。本轮立约定没有起任何沙箱。

## Why

forge 现在自带一整套运行时：自己的执行面（`forge_shell` / `forge_jobs`）、自己的 `task` 派发引擎、
作业监管、卡死看门狗。这些是给 opencode v1 宿主补的——那时候内建 shell 会挂着不返回，宿主也没有
好用的子代理派发。宿主 2.x 自己把这些做了（〔源码〕宿主 2.4.0，`packages/core/src/tool/plugin/` 下）：

- 内建 shell：默认 2 分钟超时，到点「前台转后台、后台停止」；有 `workdir`、`background` 参数；
  后台命令退出时通知会话（`shell.ts:29, 60–72, 82–84`）。
- 原生 `subagent`：调用立刻返回，孩子在后台跑；孩子每次空闲，宿主把结果送达父会话；
  带 `sessionID` 可以续用同一个孩子（`subagent.ts:30–44, 53, 105`）。
- 工具登记表：同一个有效名字，后登记的生效；插件可以更新内建工具的定义（`core/src/tool.ts:266–284`）。

插件再背一套，就是两套并存：模型要学两个 shell、两个派发工具，每次调用多几道插件自己的门和通知，
底下还拖着排队、轮询、补发唤醒、重启收养一整套。原生路是通的（〔沙箱〕D 草案：真机的 forge 会话
原生派发整条链路走通；沙箱里续用、取消通知、子会话目录都实测过）。

业主 11-25 的八条答复（原话）：

1. 「一起删」——执行面 `forge_shell` / `forge_jobs` 和卡死看门狗。
2. 「删半边」——分区里「其他代理看不见 forge 工具」那半边。
3. 「删」——v1 入口 `server()`。
4. 「删，按你倾向」——`task` 派发引擎，不留回退开关。
5. 「grep/glob可以留，但我觉得是不是可以直接同名覆盖？我记得这是opencode官方推荐的形式」
6. 「goal 留，我的goal是可以落盘形的留档」
7. 「plan 留，你看我们的plan、crew、goal是互相解耦但紧密结合的牛逼编排Harness，都是文件落盘式防漂移的牛逼功能」
8. 「 crew 留，瘦身是怎么瘦？」

同日另定三件：D 草案（`adopt-native-subagent-dispatch`）吸收后废弃，原件完整保留（11-26 授权移出活动集）；在现有 change 上
扩成**一批做完**（不拆三批）；派发门一并重做到原生的 `subagent` 上。

## What Changes

按八条答复落位。

**1. 执行面和看门狗一起删（答复 1）。** `forge_shell`、`forge_jobs` 两个工具不再存在；作业监管、
卡死看门狗、只读执行封条（命令分类器）连同 `jobs.*`、`watchdog.*` 两组配置项一起删。forge 一族
（主代理和全部 `forge-*` 工人）改用宿主内建 shell；插件不额外隐藏、不拒绝、不替换它（已有 picker 配置不变），也没有选项能把它
藏回去。两个例外都不是插件自作主张：plan 草稿期的写禁令照样拒它；你或工人配方里显式写的 shell 拒绝
照写。只读工人（`shape: "readonly"`）保留内建 shell，照样禁写类文件工具〔待确认 1〕。

**2. 分区删掉「其他代理看不见 forge 工具」这半边（答复 2）。** 具体是：

- `forge_grep` / `forge_glob` 两个工具不再存在，搜索能力搬到宿主内建的 `grep` / `glob` 上（见第 5 条），
  所有代理都能用。
- 非 forge 代理也能派 `forge-*` 工人，过和 forge 主代理一样的会话门（池归属、草稿期、crew）〔待确认 4〕。
- 工具分区不再往别人的代理定义里写 tools/permissions；既有可配置 Tab picker 隐藏（hideNativeAgents）独立保留。非 forge 代理的保证剩两条：调 forge 的编排状态工具会被拒
  （见待确认 3）；往 forge 的状态文件（`.opencode/plan/`、`.opencode/goal/`）里写会被拒，读不受限。
- 「forge 一族只能走 forge 的执行面」这半边随执行面一起消失。

**3. 删 v1 入口（答复 3）。** 包只剩一个入口（默认导出的 `setup`）；删 `./server` 导出；
`engines.opencode` 从 `^1.18.0 || ^2.0.0` 收成 `^2.0.0`。v1 宿主上插件不再加载。2026-11-26 业主恢复目标后明确决定停用采用宿主原生插件启停，而不迁移旧 `agent["forge"].disable` 全插件开关；宿主独立加载的生成 worker/override Markdown 有自己的生命周期，停用或卸载不自动删除或隐藏它们，手写文件及历史数据保持不动。README 说明识别、备份、逐文件显式管理和恢复方法及停用后 Forge 运行时保障缺失的边界。依据为 v2.4.0 源码调查，真实启停、作用域和文件行为仍待探针 K；不代表已验证。

**4. 删 `task` 派发引擎，不留回退开关（答复 4）。** 宿主原生的 `subagent` 是唯一的派发面。引擎连带的
同步派发、并发上限加排队、按次下发的权限、派发日志、报告文件、进度通知、插件补发的唤醒、失败自动重试、
重启后的收养，全部不再有，也没有任何配置能把它们带回来。forge.json 里残留的 `dispatch` 节点、
13 个 `FORGE_DISPATCH_*` 环境变量：忽略，各出一条有上限的提示〔待确认 14〕。

插件原来挂在自己 `task` 工具上的每道派发门，改挂到原生 `subagent` 的调用上（宿主的 `execute.before`
工具钩子），一道不少：跨工作区池的拒绝、plan 草稿期的派发门、crew 登记后等你选执行方式的暂停门、
crew 的 pool 合规门。`/forge stop` 重做：只对同时确认亲缘归属和原生派发证据的子代理及其后台命令提出停止请求，回执区分请求与已证终态，未知范围/数量披露（做法见 design）。

**5. grep / glob 同名覆盖（答复 5）。** 插件不再登记 `forge_grep` / `forge_glob`，而是通过宿主的工具
登记表更新内建 `grep` / `glob` 的定义：内建定义是底，名字、参数都保留，只加两样——`follow` 参数
（默认 `true`：搜索穿过符号链接和目录联接）、`glob` 的 `hidden` 默认改成 `true`（点目录纳入）。
传 `follow: false` / `hidden: false` 就是内建原来的行为〔技术 9、待确认 10〕。

**6、7、8. goal、plan、crew 都留。** 三个 harness 的纪律、落盘文件、确认门、空闲续跑，一样不少。
瘦的只是它们底下那层执行和派发的管线，见下一节。入口身份守卫与工具可见性解耦，独立和 goal 治下 crew 仍保留必要调度观察；等待不消耗自动续跑轮数、无进展计数，不推进波；原有 wall-clock 分钟硬上限照常计时（不变的默认保障，armed_at/重启/revision 不变）。goal 治下 crew 在 pause、预算耗尽、discard、complete 后不自动转 standalone；仅原有明确授权机制恢复，未知则等用户。close 关联 declared subtask、轮次、fallback 与核实证据，未知不当 PASS。plan/goal 共用校验与解释器链，合格侦察须实走宿主权限链并核实生成定义。

**2026-11-26 业主补充批准（本轮只立约定）**：保留 goal 五态与既有确认门、完成证据；明确 `goal_pause` 持久化具体 blocker，先暂停就不再接纳新自主调用或续跑，迟到/重复 idle 与结果、重启均不自动恢复，已接纳的在飞调用不承诺取消，goal 治下 crew 不退 standalone。合法宿主等待不空转、不扣轮次/停滞，分钟上限仍生效，事件不确定不猜；局部问题尚有独立任务则继续。仅轻量检测明确无活动（既有两轮）及可证相同检查无信息的重复，避免因只读侦察、评审、新验证/失败定位、提交、非 git 工作区误停；不按自然语言关键词暂停，不要求每轮写或 shell。Token 只探针宿主可见计量能力与可靠性，不实现预算或虚称硬限；不新增运行时、LLM verifier、语义打分、通用进程监管，不承诺覆盖单模型 turn 内一切循环。社区动机与已查阅的少量真实案例链接见 design D11（仅社区报告，不是宿主探针结果）；验收落现有 1.8、6.11、11.2 等任务，82 项总数与既有勾选不变（11 已勾、71 未勾）。此次批准不是开工、测试、恢复旧 ZCode Goal 或发布授权。规格复核：严格全量 13/13、单 change strict 通过；39 个 MODIFIED 完整保留 live 208 个 scenario 标题（delta 共 229 个 MODIFIED 场景），ADDED 16 / REMOVED 57 目标合法；仅核规格与任务，不构成实现验收。

## 三个 harness 各自瘦在哪（回答「瘦身是怎么瘦」）

| | 不变的 | 变的 |
| --- | --- | --- |
| **plan** | `/plan` 纪律；计划落盘；`plan_approve` 确认门；草稿期写禁令；逐项打勾；关闭时的自检 | 写禁付认的工具名字多了内建 `shell`，派发门改认原生 `subagent`；草稿期侦察只能派「配方里明确关掉 shell 的只读工人」〔待确认 2〕；`/plan` 模板里的措辞改了（不再提 `task`、`forge_shell`） |
| **goal** | 五态、契约落盘；`goal_write` / `goal_complete` / `goal_resume` / `goal_discard` 四个确认门；空闲续跑；无进展自动暂停；完成校验 | 真实暂停与宿主等待优先；轻量识别明确无活动、可证重复无信息并防误停；校验解释器保证从作业监管搬来；Token 仅探针 |
| **crew** | `/crew` 纪律；`crew_begin` 登记和落盘记录；登记后的暂停门；pool 合规门；孩子在飞时不发续跑简报；空闲续跑；`crew_close` 的证据核对 | 「一波」的定义变了：一波是编排会话一起发出去的那几个原生 `subagent` 调用，上一波全部轮次核实结算再发下一波（未知/截断/部分不结算）——发的人是编排会话自己，不是插件；门从插件的 `task` 改挂到原生 `subagent`；缺角色时走原生 `subagent` 派非 forge 代理（这条原来就有） |

一句话：以前是插件替模型派、替模型等、替模型叫醒；以后是模型直接派，宿主负责跑完叫醒，插件只管
「该不该派」和三个 harness 自己的账。

## 不做的

- 不同步派发，不做并发上限和排队，不做按次授权，不自己封装「主代理读子代理 / 给子代理再发消息」
  （你已表态不要，交给宿主）。
- 不给内建 shell、内建 `subagent` 包一层，不改它们的参数和权限规则。
- 不修宿主自己的问题。
- `/forge stop` 不去取消宿主的其他类型作业（代码模式脚本、生图、视频）：它只主动请求停止确认归属本会话的子代理和它们留下的后台命令；宿主 interrupt 的连带影响未验。
- 不改 plan / goal / crew 的落盘格式。
- 不改 D 草案原件，不动授权治理范围以外的 change（见「与在途 change 的交叠」）。
- 不做「让非 forge 代理也能用 `/plan` `/goal` `/crew`」——那是新功能，不是减法（见待确认 3）。

## 需要你确认的默认项

A 组保留原审批问卷以便对照，业主已于 2026-11-26 明确批准全部默认产品项（1–8、10、11）；goal 等待保留原分钟硬上限及不自动转 standalone 是现有授权保障的默认，不新增产品取舍；重启不能确认授权则等待用户。B 组为技术修订、探针与授权事项；9、13–17、19、20 属技术约束/实现计划，12、18 已另获治理授权，不能代替产品批准。

### A 组：产品取舍

| 编号 | 题目 | 默认怎么做 | 选另一边会怎样 |
| --- | --- | --- | --- |
| 待确认 1 | 只读工人有没有 shell | **有**，和宿主出厂的只读代理 `explore` 一样；写类文件工具照样禁；命令级封条删除 | 「不给」：只读工人跑不了 `git diff`、测试、管道，审查类工人基本废掉。只改一处编译逻辑和规格里两段话 |
| 待确认 2 | plan 草稿期能派谁 | 只放行**配方里明确关掉 shell** 的只读工人；有 shell 的只读工人、写形状工人、非 forge 代理一律拒 | 「有 shell 的只读工人也放行」：草稿期可以借工人跑命令，写禁令等于开了个口子 |
| 待确认 3 | 15 个插件工具归谁 | 仍只归 forge 主代理（`plan_*` 6 个、`goal_*` 6 个、`crew_begin`、`crew_close`、`forge_sync`）；工人和非 forge 代理调用会被拒，拒绝语引导切到 forge | 「全部放开」：`/plan` `/goal` `/crew` 现在本来就把非 forge 会话引导去切 forge，goal 循环也不在非 forge 代理下续跑，只开工具不开这三样是半截子。要放开得连那几道门一起重做，是另一个 change |
| 待确认 4 | 非 forge 代理能不能派 forge 工人 | **能**，过同样的会话门，不看调用方是谁 | 「不能」：和你说的「如果用户用 build，用上了 forge 的一些工具也没问题」相反，也和「不画地为牢」相反 |
| 待确认 5 | 工人能不能向用户提问 | **不能**：写进编译出的工人定义，和宿主出厂的 `general` / `explore` 一样（后台孩子提问没人答，会一直挂着）；配方里显式写 `permission: {question: allow}` 可以放开 | 「用钩子一刀切」：会盖过用户在代理配置里的显式选择 |
| 待确认 6 | 工人能不能调编排状态工具 | **不能**：15 个工具在工人的编译权限面上也拒绝 | 不写的话只靠插件拒绝带兜底，工人模型面里还看得见这些工具 |
| 待确认 7 | `/forge stop` 怎么停孩子留下的后台命令 | 走宿主的 HTTP 接口（`GET /api/shell` 列出、`DELETE /api/shell/:id` 终止，这组不标实验性），用 forge 已有的那条直连通道；通道不可用时退回「只对双证确认目标请求打断」，回执如实标明枚举不可用/未知数量，区分请求和确认终态；宿主的其他类型作业（代码模式脚本、生图、视频）不去碰 | 「不走」：已收工的孩子留下的后台命令停不掉，停完还会「复活」答一轮（〔沙箱〕实测）。这是 D 草案留给你的问题 |
| 待确认 8 | `/forge stop` 在非 forge 会话里能不能用 | **能**，不过家族守卫。停的是同时证实本会话亲缘和原生派发的孩子，和待确认 4 配套 | 「不能」：非 forge 会话派得出工人，却停不了 |
| 待确认 10 | `follow` 默认 `true`、`glob` 的 `hidden` 默认 `true` | **改**。这是 forge 搜索工具原来的默认值，原样搬到内建名字上。注意：**所有代理**（build、general、你自己定义的）的 `grep` / `glob` 都会跟着多搜出东西 | 「不改」：默认和内建一致，想穿链接、看点目录要每次显式传参 |
| 待确认 11 | 删掉规格里名存实亡的「bundled skill」要求 | **删**。forge 从来没带过 skill 文件，纪律一直在 `/plan` 命令模板里（〔源码〕仓库里没有 SKILL.md，`plugin.ts:7890` 的注释也这么写） | 这超出了八条答复的范围，属顺手清理；不想动就留着，不影响代码 |

### B 组：技术修正与独立授权（沿用编号）

| 编号 | 题目 | 默认怎么做 |
| --- | --- | --- |
| 9（技术修正） | 同名覆盖权限等价 | 保留内建访问约束（环境可用性、搜索动作、外部目录（包括实际外部链接目标，读前授权）及上下文）；探针 F 若无法证明等价则不安装并回修规格，不属产品放宽选项 |
| 12（治理已授权） | 两个在途的派发 change 怎么办 | `forge-dispatch-lanes`（0/9，已 PARKED）、`fix-dispatch-view-capability`（12/14，4.4、4.5 未完成）及 D 草案经业主授权撤销，原件移至 `openspec/cancelled/`，不合并 delta、不虚勾；主规格保留原基线直到本 change 删除 |
| 13（技术） | 派发门挂哪 | 挂宿主的 `execute.before` 工具钩子（拒绝即这次调用的报错，孩子不会被建出来），不挂权限钩子。依据见 design D4 |
| 14（技术） | 旧配置和旧文件 | `dispatch` 节点、`FORGE_DISPATCH_*`、`jobs.*`、`watchdog.*`：忽略并各出一条有上限的提示，不报错。`<os-tmp>/opencode-forge/` 下旧的 `jobs`、`watchdog` 目录和派发日志：不读、不删 |
| 15（技术） | 没有 ripgrep 时的纯 JS 搜索引擎 | 保留。它不是被删的东西的一部分 |
| 16（技术） | 版本和包 | `0.34.1` → `0.35.0`（破坏性变更）；`engines` 收成 `^2.0.0`；删 `./server` 导出；description 去掉作业监管、看门狗，改成原生派发 |
| 17（技术） | 源码文件 | 物理删除（先例：提交 `828b9c5` 删过 6 个旧的 dispatch 文件）；顺手删掉早就没人引用的墓碑 `src/headless.ts` |
| 待确认 18 | 归档与授权清理 | ① 归档顺序见下文和 Depends on；② 7 份主规格的 Purpose 还点名已删的能力，OpenSpec 的 delta 机制管不到 Purpose，要在归档时直改——需要你授权（crew-harness、command-surface、search-tools、forge-subagents、tool-partition、runtime-artifact-namespace、gate-asks）；③ 核查仍存旧 `task` 工具语义、直接主规格清理（仅用户另授权；场景标题保留规则不变）；归档后删掉 `openspec/specs/job-supervisor/`、`openspec/specs/hang-watchdog/` 两个空目录——校验器把零要求的规格判为错 |
| 19（披露） | 一处早就对不上的规格 | plan-harness 主规格的 `Session-start notice` 写的是 v1 时代的钩子，和现状对不上。本次不动，只在这里披露 |
| 20（技术） | 测试迁移 | 26 个走 v1 入口的测试文件改走 `v2Setup`；只删退役行为断言；有效行为先迁移再删除，即使同一文件兼有两类断言（tasks 1.16） |

## Capabilities

规格 delta 共 12 份：新增（ADDED）16 条、改写（MODIFIED）39 条（含 D10 停用/卸载两条、D11 暂停与账本两条）、删除（REMOVED）57 条。两份规格整份退役；tasks 共 82 项，前置治理据实留痕，其余未勾选。

| 规格 | 增 / 改 / 删 | 要点 |
| --- | --- | --- |
| `forge-subagents` | 5 / 11 / 21 | 原生 `subagent` 是唯一派发面；派发门挂到它上面；工人不能提问；草稿期派发门；工人提示词改写。删掉派发生命周期、韧性、结果诚实性、报告文件、取消、进度通知、派发注册表与重启收养、按提供方熔断等 21 条 |
| `tool-partition` | 3 / 2 / 7 | forge 一族跑在内建 shell 上；非 forge 代理只和编排状态工具、forge 状态文件隔离；草稿期写禁令对会话里每个代理生效 |
| `forge-agent` | 2 / 5 / 2 | 主代理注册在内建 shell 上；包只有一个 v2 入口；宿主原生插件启停、生成工件独立生命周期与显式管理 |
| `crew-harness` | 0 / 7 / 0 | 成波定义、暂停门、合规门改认原生 `subagent`；其余不动 |
| `command-surface` | 1 / 2 / 0 | `/forge stop` 停本会话的原生子代理，在命令自己的执行里做 |
| `search-tools` | 2 / 2 / 3 | 同名覆盖；删掉 `forge_grep` / `forge_glob` 的接口要求和「工人优先用 forge 搜索」 |
| `plan-harness` | 1 / 3 / 1 | 写禁令认内建 shell 和原生 `subagent`；纪律在 `/plan` 命令里；删「bundled skill」 |
| `goal-harness` | 1 / 5 / 0 | 校验解释器迁入；暂停优先、真实等待、轻量活动与重复检测、账本和原确认门 |
| `gate-asks` | 1 / 0 / 0 | 用户确认门永不被插件自动裁决（从分区规格搬来） |
| `runtime-artifact-namespace` | 0 / 2 / 0 | 运行时工件只剩 models-dev 缓存、会话锚点账本、探针日志 |
| `job-supervisor` | 0 / 0 / 17 | 整份退役 |
| `hang-watchdog` | 0 / 0 / 6 | 整份退役 |

含义变了、场景有删有换的要求，按 OpenSpec 的规矩（MODIFIED 不许丢 scenario）用旧名 REMOVED + 新名
ADDED，Reason / Migration 里写明承接关系。

## Impact

### 代码

行号是 11-25 工作区的，apply 时以实际为准。

整体删除候选（`src/` 下 13 个文件，约 4,220 行）：

| 文件 | 行数 | 原职责 |
| --- | --- | --- |
| `src/dispatch-async.ts` | 977 | `task` 派发引擎本体 |
| `src/dispatch-gate.ts` | 224 | 派发并发门、熔断 |
| `src/dispatch-journal.ts` | 206 | 派发日志 |
| `src/dispatch-retry.ts` | 195 | 失败重试 |
| `src/job-runner.ts` | 518 | 进程执行、轮询、日志、幸存者收养 |
| `src/job-manager.ts` | 414 | 作业表 |
| `src/job-registry.ts` | 260 | 幸存者注册表 |
| `src/job-fence.ts` | 262 | 作业围栏 |
| `src/exec-classify.ts` | 416 | 封条用的命令分类器 |
| `src/watchdog.ts` | 370 | 卡死看门狗 |
| `src/host-exit.ts` | 169 | 退出清理 |
| `src/proc-locate.ts` | 205 | 看门狗用的进程定位 |
| `src/headless.ts` | 6 | 没人引用的墓碑 |

保留：`src/dispatch-tiers.ts`、`src/dispatch-prompt.ts`（工人的定义来源和纪律提示词，内容要改写）、
`src/dispatch-depth.ts`（深度词翻译，注入模型参数时还在用）、`src/roster-compile.ts`（工人编译，
权限面要改）、`src/shell-select.ts`、`src/run-check.ts`、`src/proc.ts`（goal 校验命令在用）、
`src/search-core.ts`、`src/search-js.ts`（搜索引擎，改由内建 `grep` / `glob` 调用）、
`src/native-child-gate.ts`、`src/crew-gate.ts`（crew 自己的门）；`dispatchProviderFamily`（:885）保留，:919–935 深度选择及 :9651–9665 v2 pin 注入仍依赖它。v1 加载 `modelsDevCatalog`（:8025–8035，:927–938 消费）迁至实际 v2 setup 保留 snapshot/cache/null fallback；v1 config 钩子的 `setHostShell`（:7835–7844）要先迁移到可证明的 v2 等价输入；`forgeDisabled`（含续跑 :7437–7444）改由宿主原生插件启停替代，待实测后删旧开关及其专用判断（D10）。

`plugin.ts`（现在 10,944 行）的落点：

- v1 入口 `export const server`（`:7692–8772`，约 1,080 行）整体删。
- 派发段（`:3145–6090`，约 2,900 行）和零散的派发辅助函数（`:1082`、`:1229`、`:1276`）。
- 作业、看门狗、封条的选项和接线（`:1020`、`:8077–8088`、`:8628–8654`、`:9485`）。
- `SESSION_RESCUE_RULE`（`:9016`，给 `forge_shell` 用的会话补救规则）、`V2_SHELL_DENY`（`:10522`）。
- `WRITE_TOOLS`（`:1784`）加入 `shell`、`subagent`——不然草稿期写禁令和 goal / crew 的活跃度打分都漏掉内建
  shell 和原生派发。
- `GATE_PERMISSION_KEYS`（`:2086`）去掉 `forge_shell`；`FORGE_EXEC_TOOLS`、`FORGE_SEARCH_TOOLS`（`:127–134`）删。
- `PLAN_COMMAND_TEMPLATE`（`:171`）、`src/dispatch-prompt.ts`、`src/dispatch-tiers.ts` 里的提示词改写。
- `forgeTools()`（`:6772`）只剩 15 个工具；`v2Setup`（`:10561`）新增：`grep` / `glob` 的更新、
  挂在 `execute.before` 上的派发门、重做的 `/forge stop`。

### 测试

65 个测试文件里（grep 计数，两数有重叠）：26 个走 v1 入口 `server(`；38 个点名了被删的模块或符号——
按待删模块的文件名（`dispatch-async`、`job-runner`、`exec-classify`、`watchdog` 等 12 个；`headless` 这个词
太常见，没算）加 `forge_shell`、`forge_jobs`、`jobStage` 一类的符号名搜，大小写敏感。逐个文件是删还是迁，
删除前先出行为级迁移表（tasks 1.16），保留每个仍有效的行为断言，即使同一文件兼有退役断言。两类：

- 整份随功能删除：作业、看门狗、封条、派发引擎各自的测试（如 `job-wiring`、`exec-seal-wiring`、
  `exec-classify`、`watchdog`、`watchdog-wiring`、`job-runner`、`job-fence`、`host-exit`、`job-registry*`、
  `dispatch-async`、`dispatch-gate*`、`dispatch-journal`、`dispatch-queue`、`dispatch-cancel` 等）。
- 改写并迁到 `v2Setup`：分区、权限带、工具钩子、工人编译、goal、crew、命令面、搜索等。

### 文档、配置 schema 与脚本

- README（1,824 行，39 处点名旧工具）：执行面、作业、看门狗、封条、派发引擎各节删除；工人 shape、
  派发、搜索、配置项各节改写；新增升级说明。`FORGE_GATE_ASK_WATCHDOG_MS` 不在删除范围——那是确认门
  的插件侧超时，名字里带 watchdog 而已。
- `package.json`：见待确认 16。配置 schema `schema/forge.schema.json` 和构建产物 `dist/forge.schema.json`
  去掉 `jobs.*`、`watchdog.*`、`dispatch` 节点。
- `docs/architecture.md`；根目录 `dispatch-tdd-process.md`、`dispatch-wargame.md`。
- `scripts/`：`job-wake-e2e.mjs`、`shell-mandate-e2e.mjs` 随功能删除；`mixed-agent-e2e.mjs` 和名字里带
  dispatch 的脚本逐个判断。

升级前用户核对旧存活作业并决定等待或停止；插件不读不删旧文件，不保证回滚生命周期无损。生成定义以当前编译内容/契约判断兼容，即使配方和时间戳未变也识别旧版；原有显式 sync/auto 规则保留，无授权不写且不默默使用不兼容工件。内建 general/explore override 与 namespaced worker 编译分离，既有独立语义、生成文件授权和手写同名文件保护不变。workspace pool 独占（坏文件不退 global），host union 仅物化可见集合。

### 你会感觉到的变化

- 模型那边没有 `forge_shell`、`forge_jobs`、`task`、`forge_grep`、`forge_glob` 了；命令走内建 shell，
  派人走原生 `subagent`，搜索用内建 `grep` / `glob`。
- 派发只有后台，没有排队；一次派多少个由模型和你决定。
- 孩子的完成通知由宿主投递（插件不再补发）；次数、异常和续用轮次按实测披露，harness 调度简报另计。
- `/forge stop` 能停掉原生派出的子代理了（现在它对原生子代理是看不见的，〔沙箱〕）。
- 所有代理的 `grep` 默认穿过获授权的链接、`glob` 默认看点目录（待确认 10）。
- v1 宿主上插件不再加载。

### 丢掉的保证

| 原来 | 之后 |
| --- | --- |
| 每条命令结果带 `cwd:` 行 | 没有。工作目录由宿主定；子会话建在父会话的目录里（〔沙箱〕3 次），「工人在你的工作区里跑命令」还在 |
| 非交互环境（`EDITOR=:`、`GIT_PAGER=cat`） | 没有。工人提示词加一句「提交用 `-m` 或 `--no-edit`」；编辑器、分页器的行为归宿主 |
| 模型自己 `list` / `kill` 后台命令 | 没有。宿主的 Shell 面板能停；`/forge stop` 能终止本会话一家的后台命令 |
| 命令成功即返回、空闲即返回 | 以内建 shell 的超时为准 |
| 只读工人的命令级封条 | 没有（待确认 1）。封条本来就不是沙箱 |
| 同步派发；并发上限加排队；按次下发的权限 | 没有（你已表态不要） |
| 报告文件、进度通知、插件补发的唤醒（含中止原因、结果流丢失那几种） | 没有。结果在宿主的完成消息里；取消和异常结束宿主都会通知（〔沙箱〕）。真实的上游超时、限流造成的异常结束通不通知：〔未验〕 |
| 失败自动重试 | 没有。父会话收到错误，由模型决定要不要再派 |
| 重启后插件把没跑完的派发续起来 | 宿主自己的续跑（〔源码〕`core/src/session/subagent-job.ts`；〔沙箱〕未实测） |
| 派发日志 | 没有。宿主的会话记录里有父会话号、目录、结局（〔沙箱〕） |
| 取消排队中的派发 | 没有排队，也就没有这项；在飞的用 `/forge stop` |
| v1 宿主支持 | 没有 |
| `agent["forge"].disable` 全插件静默、单一插件开关隐藏所有生成代理 | 改用宿主原生插件停用；仅停止 Forge 运行时贡献。生成 agent Markdown 与用户配置独立存在，须由用户显式管理；手写文件不动。 |

### 与在途 change 的交叠（归档顺序）

| change | 进度 | 它改的 | 和本 change 的关系 | 顺序 |
| --- | --- | --- | --- | --- |
| `fix-unknown-session-anchor-seed` | 15/15 | 改写 `Session directory resolved per session on multi-location hosts` | 本 change 对同一条也有改写，**以它的文本为基线** | 它先归档 |
| `doc-plugin-unload-v2` | 13/13 | 改写 `Job ownership and lifecycle` | 本 change 整条删、整份规格退役 | 它先归档 |
| `worker-shell-session-allow` | 13/13 | 改写 `Exec posture pass-through on the exec surface` | 本 change 整条删；它加的会话补救规则也删 | 它先归档 |
| `fix-dispatch-view-capability` | 12/14 | 改写 `Dispatch outcome honesty on result-stream loss` | 本 change 整条删；4.4、4.5 未完成 | 已授权撤销，原主规格保留 |
| `forge-dispatch-lanes` | 0/9，已 PARKED | 新增 `Optional dispatch lanes` | 它的对象（派发泵）没了 | 已授权撤销，不合入 delta |
| `forge-commands` | 8/8 | 新增 `User-facing /forge command family` | 旧措辞经授权仅修 delta：单 `/forge` 参数路由、现有共用模板的工具可见性守卫，五个场景标题保留；本 change MODIFIED 承接可靠身份守卫及 stop 例外 | 五个硬依赖归档后，先归档其已实现行为；新行为不提前合入 |
| `builtin-override` | 8/8 | 新增 `Built-in subagent override via the global recipe` | 与共享 toolsFaceFor、同步与旧 general/explore 工件有语义交叠，本 change 以其 ADDED 块为 MODIFIED 基线（先归档才可合并）；内建 override 独立规则不套 worker 专属政策 | 先经授权归档，核对其主规格场景与同名文件保护 |
| `fix-ask-door-multi-directory-host` | 15/15 | 改写 `Every user-confirmation door raises its dialog under v2` | 本 change 承接它完整 MODIFIED 块（仅去旧 forge_shell 内容） | 它先归档 |
| `adopt-native-subagent-dispatch`（D 草案） | 没有 delta | — | 吸收后废弃 | 已授权撤销，不归档 |

**2026-11-26 前置治理记录（仅历史证据核查，未重跑测试/宿主）：**

1. 按顺序用 OpenSpec 1.13.0 `archive --yes --json`（不跳过校验）归档五个已批准完成的硬依赖，落 `openspec/changes/archive/2026-11-26-<change>/`：`fix-unknown-session-anchor-seed`（15/15，C00cf99/59eb84f，0.34.2 计划构建验收 34/0/0/0，1068/1068）、`doc-plugin-unload-v2`（13/13，同一验收；原 3.3 全量的唯一失败为 D 草案，现已处置；其原记账仍保留）、`worker-shell-session-allow`（13/13，1b6c313、adea1cb、cf49db6，历史 859/859、0.31.0 正式包实测）、`fix-ask-door-multi-directory-host`（15/15，29fa34d，21/21 E2E；历史 D1 欠账由 doc-plugin-unload-v2 清除）、`builtin-override`（8/8，92fc059、cf49db6，历史 860/860、9/9 E2E）。依赖自身 strict 及所承接/退役要求的基线核查通过。不把计划版证据当成新的发布或验收。
2. 三份撤销原件完整移至 `openspec/cancelled/{forge-dispatch-lanes,fix-dispatch-view-capability,adopt-native-subagent-dispatch}`，逐文件 SHA-256 相同（6、6、3 文件），没有合并废弃 delta，无任务被勾选。`Dispatch outcome honesty on result-stream loss` 原主规格仍存在，退役 change REMOVED 承接；无 `Optional dispatch lanes` 要求进入主规格。
3. `forge-commands` 8/8 的 0.31.0 历史验收（860/860、9/9 E2E，1–4 场景，cf49db6）及后续单路由提交 a77132d、现代码 `FORGE_COMMAND_TEMPLATE`、`forgeFamilyGuard`、两宿主注册和既有测试断言共同证明当前基线。仅修其 `forge-subagents` delta 的三命令说法及 guard 实际语义，保留五个 scenario 标题，strict 通过后归档至 `openspec/changes/archive/2026-11-26-forge-commands/`。现在主规格仍为旧的模板级工具可见性守卫，stop 仍由旧 command-surface 规定；不能把未来真实身份守卫及 native stop 例外冒充已实现。本 change 的同名 MODIFIED 保留五场景并新增 stop 例外，与 command-surface delta 一起承接，待 1.13、6.9、7.2 等实际验证及最终归档才进入主规格。
4. 严格校验：`openspec validate --all --strict` 13/13（12 主规格 + 本 change），`openspec validate retire-plugin-runtime --strict --type change` 通过，无 archive 预测拒绝。35 个 MODIFIED 保留主规格全部 200 个基线 scenario 标题；16 个 ADDED 不与主规格重名、57 个 REMOVED 目标均存在。其余 change 不动。开工前 0.3 仍由主会话确认。后续 Purpose/空规格目录/AGENTS.md 清理仅在对应收尾阶段执行。

### 归档后的收尾

`openspec archive` 会把 `job-supervisor`、`hang-watchdog` 两份规格留成只有 Purpose 的空壳，而校验器把
零要求的规格判为错——归档后要删掉 `openspec/specs/job-supervisor/` 和 `openspec/specs/hang-watchdog/`
（待确认 18 ③）。7 份主规格的 Purpose 直改见待确认 18 ②。

## Depends on

- `fix-unknown-session-anchor-seed`：先归档；本 change 的多目录 session 定位保留其全部场景。
- `doc-plugin-unload-v2`、`worker-shell-session-allow`：先归档；待删要求须仍存在，本 change 整条退役。
- `fix-ask-door-multi-directory-host`：先归档；本 change 以其完整 MODIFIED 块为基线，保留全部场景标题和多目录确认门，删除旧执行工具内容。
- `fix-dispatch-view-capability`：已按业主授权撤销，主规格原要求仍在，由本 change 删除；不要求撤销后出现未归档文本。
- `builtin-override`：已先归档；本 change 承接其完整场景，保留内建覆盖独立语义、生成 marker 和手写碰撞保护，核对授权 sync/auto 条件。
- `forge-commands`：已归档修正后的现行行为，仅本 change 承接未来可靠身份守卫、stop 例外；最终归档须确保旧模板守卫不残留。
- `forge-dispatch-lanes`、D 草案：已按业主授权撤销，原件不改、不归档、不豁免校验。

OpenSpec 不自动约束上述依赖，tasks 0.2 / 12.1 核对。业主已授权对应收尾时归档与 Purpose/空目录及项目说明更新、旧 task 语义清理；本轮不改 AGENTS.md 或直接改主规格。所有直接主规格清理完成后再做最终严格全量校验。
