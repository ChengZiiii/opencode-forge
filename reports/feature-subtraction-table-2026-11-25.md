# 功能减法对照表（2026-11-25）

对应 `reports/handoff-2026-11-25.md` §4。回答一个问题：forge 的每块功能，当初是为了 v1 宿主的什么毛病做的；宿主 2.4.0 治没治；同类插件怎么做；该删、该留，还是改用宿主的。

## 判断口径

业主 11-25 定的几条（原话在交接归档里，这里不复述）：

- 现在做功能减法。`forge_shell` / `forge_jobs` 是为了「内建 shell 卡住没人知道」，`forge_grep` / `forge_glob` 是为了「v1 搜不了符号链接」，goal 模式是因为 v1 没有。v2 解决了或提供了方案，就保留 v2 的方案。
- 不必再兼容 v1，完全支持 v2、放弃 v1 也可以。
- 兼容 opencode v2 推荐的做法，不打破它的优秀设计。
- forge 是 opencode 的功能拓展，不是画地为牢的工具。

## 这次做了什么、没做什么

- 只读：forge 源码 / README / 规格 / D 草案，宿主 2.4.0 源码镜像，13 个同类插件的源码。
- 没做：没起沙箱、没跑测试、没立 change、没改代码、没动 D 草案。新增的只有这一份文件，没有提交。
- 所以表里**没有一条是实测**。宿主的结论全部来自读源码；需要沙箱或真机才能定的标了〔未验〕，汇总在第五节。

## 怎么读

- 证据标签：〔源码〕读过源码；〔他人文档〕对方 README 的自述；〔未验〕推断，要沙箱或真机才能定。
- 路径：不带前缀的是本仓库内路径；`host/` 是宿主 2.4.0 源码镜像的 `packages/` 目录；`peers/<仓库>` 是同类插件。
- 行数来自 `wc -l`，测试数来自数文件名，都是近似分组，不是精确账。
- 标了「子代理查的」的条目来自后台子代理的扫描，没有逐条复核。支撑建议的几条都自己复核过。

## 一、总表

| # | 功能 | 建议 | 一句话理由 | 体量（约） |
| --- | --- | --- | --- | --- |
| A1 | `forge_shell` + `forge_jobs`（作业监管） | 改用宿主的 | 内建 shell 现在到点自动转后台并回话，不再卡死没人知道 | `src/` 2,039 行 + `plugin.ts` 约 215 行；测试约 12 个 |
| A2 | 卡死看门狗（hang watchdog） | 删 | 自己写的退休条件已满足；v2 入口里本来就没接它 | `src/` 575 行；测试 2 个 |
| A3 | 工具分区里「其他代理看不见 forge 工具」这半边 | 删半边 | 和「不做画地为牢的工具」相反；同类只拦「工人再派人」 | 行数没量；规格 300 行 |
| A4 | v1 入口（`server()`） | 删 | v2 宿主不读这个键；13 家同类里 9 家只支持 v2 | `plugin.ts` 约 1,078 行；21 个测试从它进 |
| A5 | `task` 派发引擎 | 待你定 | 新派发已定走原生；引擎本体删不删要定 | 约 4,900 行；测试 11 个起 |
| B1 | `forge_grep` / `forge_glob` | 留 | 内建 grep / glob 至今不跟符号链接 | `src/` 849 行 + `plugin.ts` 约 255 行；测试 4 个 |
| C1 | goal 模式 | 待你定，倾向留 | 宿主有原生 `/goal`，但是模型自己判完成，没有检查命令、文件、队列 | `src/` 818 行 + `plugin.ts` 约 430 行；测试 2 个 |
| C2 | plan 模式 | 待你定 | 宿主 Plan 是只读讨论型；这个工作区从没生成过一份 plan 文件 | `src/` 585 行 + `plugin.ts` 约 650 行；测试 1 个 |
| C3 | crew | 待你定，倾向留 | 宿主没有「一波人」这层；这个工作区有 20 份记录 | `src/` 68 行 + `plugin.ts` 约 405 行；测试 2 个 |
| D1 | 子代理体系（`forge.json` → 原生代理文件） | 留 | 生成原生代理记录是 v2 同类的标准做法 | `src/` 约 1,765 行 |
| D2 | forge 主代理、藏原生 build / plan、默认代理 | 留 | v2 有官方字段（`hidden`、`model`、`permissions`） | 配置 |
| D3 | `/forge sync` `init` `init global` `stop` | 留 | 没有替代 | 小 |
| D4 | 派发确认门（gate-asks） | 留 | 同类有先例 | 小 |
| D5 | 运行时工件命名空间 | 留 | A1、A2 删后自动缩小 | 小 |

A1 + A2 + A4 + A5 粗算约 8,800 行（分项直接相加，没去重，也没扣新路线还要复用的部分）。其中在 2.4.0 上本来就是死代码的：A2 的 575 行、A4 的 1,078 行。

## 二、逐项证据

### A1 `forge_shell` + `forge_jobs`（作业监管）

| 列 | 内容 |
| --- | --- |
| 当初为什么做 | v1 的内建 shell 只有「输出流到头」这一个结束信号，命令卡住就永远挂着，没人知道（README 424–430，引了上游 issue #47350 / #50316 / #49169）。所以 forge 自己做了 `forge_shell`（超时、整树杀、`success_pattern`、`survive`、`idle_ms` 提前返回）和 `forge_jobs`（给模型用的列出 / 查看 / 终止后台命令）。规格：`job-supervisor`。 |
| 宿主 2.4.0 现在怎样 | 〔源码〕病基本治了。<br>1. 默认超时 2 分钟，到点「还在跑的命令转后台」（`host/core/src/tool/plugin/shell.ts:29、52`）。一次调用不会一直等（`:432–433、508–525`）。<br>2. 命令结束能自动往会话里回一条消息（`:165–198、541–547`）。<br>3. 结束判定是「进程退出」（`host/core/src/shell.ts:1108、1136–1150`）。<br>4. 界面上有 Shell 标签页，能看正在跑的命令、能 Kill（`host/tui/src/routes/session/composer/shell-tab.tsx:20–22、96–105`）。<br>〔未验〕5. 宿主重启后，上一个进程接管的命令会重新挂回会话（`shell.ts:271–301`）。<br>宿主没有的：给模型用的「列出 / 终止我的后台命令」的工具。模型只能让命令转后台（`background` 参数，`:70–73`）。 |
| 同类插件有没有对应物 | 没有。13 家里没有一家自己注册 shell / bash 类的工具（按工具名扫过）。<br>相反的先例：slim 在 v2 上默认 `backgroundJobs.mode: "native"`，子命令的生命周期交给宿主（`peers/alvinunreal__oh-my-opencode-slim/README.md:233–237`）。agnusdei 也是把 shell 和子会话交回宿主（`peers/agnusdei1207__opencode-orchestrator/README.md:14、16`）。 |
| 建议 | **改用宿主的**，也就是删掉这两个工具。删之前补两条沙箱探针：<br>探针一：孙进程握着输出管道时，命令退出了但终态要等输出写完才发布（`host/core/src/shell.ts:1153–1155`）。可能出现在后台列表里一直显示在跑。不影响工具调用本身。<br>探针二：模型侧停不掉自己转后台的命令，只能靠人在界面上 Kill，或者 `/forge stop`（D 草案 D4）。看用起来碍不碍事。 |
| 删了牵动什么 | 1. 工人的 shell 出路。生成出来的工人代理文件里写着 `shell: false` / `bash: false`（`src/roster-compile.ts:115–124`），v2 入口又给 forge 一族压了一条拒绝内建 shell 的权限（`plugin.ts:10522`；README 217–221）。这两处不撤，工人在 v2 下没有任何 shell 可用。<br>2. v2 上现在没有开关能提前关掉这两个工具。`jobs.mode` 只在 v1 入口里被读（`plugin.ts:7721–7723`），`v2Setup` 不收这份配置（`:10561`）。规格自己也记着这是 v2 上的漂移（`openspec/specs/tool-partition/spec.md:10`）。<br>3. 只读执行封条（`plugin.ts:9485–9492`；`src/exec-classify.ts` 416 行；README 1416 一节）是给 `forge_shell` 这条通道做的，通道没了它就没有对象。但「只读工人不能改东西」这件事要换一种办法表达（v2 权限规则），这是一个要单独立约定的小设计点。<br>4. goal 的活跃度打分点名 `forge_shell`（README 392–395）；工人提示词里「所有命令走 `forge_shell`」的硬规定（README 118–122）；`SESSION_RESCUE_RULE`（`plugin.ts:9016`）。<br>5. 要留的：`src/proc.ts`（172 行）、`src/shell-select.ts`（139 行）、`src/run-check.ts`（165 行）。goal / plan 的检查命令自己起进程，不走 `forge_shell`，也不走宿主的 shell 服务（`src/run-check.ts:43–48`）。<br>6. 测试约 12 个（文件名带 exec / job / shell 的 11 个，加 `host-exit`）。其中 `worker-shell-session-allow` 属于交接文档点名的「别人的 change」，动之前要打招呼。 |

### A2 卡死看门狗（hang watchdog）

| 列 | 内容 |
| --- | --- |
| 当初为什么做 | `forge_shell` 自己不会卡，但在 `jobs.mode: "native"` 或 `jobs.keepBuiltinShell: true` 这两条出路下，forge 一族又用回内建 shell，会卡。看门狗是给这两条出路兜底的（README 1658–1663）。 |
| 宿主 2.4.0 现在怎样 | 〔源码〕结束判定已经是进程退出，一次调用最多等 2 分钟。「卡住没人知道」这个前提在 v2 上不成立。<br>更要紧的是：**v2 入口里根本没接看门狗**。`plugin.ts:9249–9250` 的注释写着 v1 的看门狗块在这里被刻意省略，看门狗实例只在 `server()` 里创建。`plugin.ts:9393、9545` 也各有一处「watchdog 除外」。所以它在 2.4.0 上已经是死代码，只在 v1 入口里活着。 |
| 同类插件有没有对应物 | 没有一家做「卡死的 shell」看门狗。沾边的几个都不是：Omacode 的 `watchdog.ts` 是防模型原地打转；nexus 的 `src/orchestrator.ts:3587–3631` 是派子代理超时；DeadSno 的 `src/core/ps-wrapper.ts:548–584` 是单条命令的超时退出码。slim 老的 managed 模式里有一个 wall-clock 看门狗（`peers/alvinunreal__oh-my-opencode-slim/src/config/schema.ts:576`），v2 上默认不走那个模式。 |
| 建议 | **删**。插件自己写的退休条件是「上游给内建 shell 做到按退出判定完成」（README 1707–1709、1783–1786），现在已经满足。和 A1 一起定。 |
| 删了牵动什么 | `src/watchdog.ts`（370 行）、`src/proc-locate.ts`（205 行）、`plugin.ts:74` 的 import；v1 入口的接线（`plugin.ts:8077–8088、8628–8654`）；测试 `watchdog.test.mjs`、`watchdog-wiring.test.mjs`；README 1656–1717 一节、文件账本一行（README 332）、配置项 `watchdog.mode` / `watchdog.stallMs`（README 283–286）。<br>v2 上的行为不变，本来就没接。 |

### A3 工具分区里的「画地为牢」半边

| 列 | 内容 |
| --- | --- |
| 当初为什么做 | v1 没有按代理分工具的官方办法，forge 用工具层的拒绝带把两边隔开：forge 一族只用 forge 的工具，其他代理（原生 build / plan / general / explore 和用户自己的代理）完全看不到 forge 的工具（README 102–114）。规格 `tool-partition` 的 Purpose 原话是「neither side can see or be influenced by the other's tooling」。 |
| 宿主 2.4.0 现在怎样 | 〔源码〕代理记录上有 `permissions` 规则，没有 `tools` 字段（`host/schema/src/agent.ts:23–35`）。「某个代理能不能用某个工具」在 v2 里就是一条权限规则，宿主有了正路，不需要靠拒绝带。`ctx.tool.transform` 是全局的，不分代理（`host/plugin/src/effect/tool.ts:8–23`）。 |
| 同类插件有没有对应物 | 没有一家做双向隔离。ahetzm 在 v2 上只拦「子代理再派子代理」（`peers/ahetzm__opencode-orchestrator/src/index.ts:261–267`）。Omacode 把自己的管理代理设成 `hidden: true`（`peers/RentschlerTobias__Omacode/packages/micromanager/src/agents.ts:34`）。 |
| 建议 | **删半边**。删的是「其他代理看不见、也调不了 forge 工具」这一条。留两条：<br>1. 工人碰不了主代理专用的状态工具（`plan_*` / `goal_*` / `crew_begin` / `crew_close`，README 126–128）。<br>2. 工人不能再派人。<br>forge 一族自己的权限面（比如藏内建 shell）不在这条里，跟 A1 走。 |
| 删了牵动什么 | README 102–145 一节重写。规格 `tool-partition`（300 行）改写，它的第一条 Requirement（「Forge family runs exclusively on the forge exec surface」）整条和 A1 联动。拒绝带的第 2 款（非 forge 代理调 forge 工具被拒，README 124–126）删掉。测试 `partition-wiring.test.mjs`。<br>〔未验〕连带的变化：用户在别的项目里用原生 build 时，就能直接调 `forge_grep` / `forge_glob`。 |

### A4 v1 入口（`server()`）

| 列 | 内容 |
| --- | --- |
| 当初为什么做 | 一份插件同时装在 v1 和 v2 宿主上：v1 认 `server`，v2 认 `setup`，所以导出两个入口（`plugin.ts:10944`；README 148–149）。 |
| 宿主 2.4.0 现在怎样 | 〔源码〕模块结构只认 `{ id, effect }` 或 `{ id, setup }`（`host/core/src/plugin/module.ts:81–94`），加载时只看这两个键（`:169–183`）。`server` 这个键在 v2 上没人读。`plugin.ts:7692–8769` 这约 1,078 行在 2.4.0 上是死代码。 |
| 同类插件有没有对应物 | 13 家里 9 家只支持 v2：Omacode、mission-control、agnusdei、courier、dynamic-workflows、kimaki、nexus、rphang、smart-subagents。v1 和 v2 都支持的是 DeadSno、ahetzm、slim。Omacode、mission-control、ahetzm、DeadSno 四家的声明复核过原文，其余几家是子代理查的。 |
| 建议 | **删**。前提是确认其他机器都升到 v2 了（11-21 业主提过别的机器还在 v1）。 |
| 删了牵动什么 | 1. 21 个测试文件是从 v1 入口进 `plugin.ts` 的；走 v2 入口的是 `v2-*.test.mjs` 9 个。这 21 个里，goal、crew、搜索、分区的接线测试（`goal-mode`、`crew-continue`、`search-wiring`、`search-behavior`、`partition-wiring`、`forge-subagents-wiring` 等）测的是要留的功能，得改走 `setup`，不是删掉。<br>2. `materialize: "runtime"` 是 v1 的运行时挂载方式（README 800–803）。<br>3. D 草案里「v1 入口原样不动」的条款（proposal 59、66、116；design 248、459、513）作废。动 D 草案要业主点头。<br>4. 版本号要进位，README 148 的安装要求要改。<br>5. A1 的 `jobs.mode` 开关、A2 的看门狗本来就只在 v1 入口里，随它一起没了。 |

### A5 `task` 派发引擎

| 列 | 内容 |
| --- | --- |
| 当初为什么做 | v1 自带的 `task` 满足不了业主定的几条：不要同步派发，要有并发上限和排队，要逐次授权（11-25 01:36）。forge 写了一整套自己的引擎，挂在原生的 `task` 工具名下（README 963「task — the single dispatch surface (native name, forge engine)」）。v1 的 `task` 具体行为没有查 v1 源码。 |
| 宿主 2.4.0 现在怎样 | 〔源码〕原生 `subagent` 工具永远在后台跑，调用立刻返回 sessionID（`host/core/src/tool/plugin/subagent.ts:19–23、53、217`），做完自己叫醒父会话。所以 D 草案把新派发改走原生（D1）。宿主没有的是并发上限、排队、逐次授权。D 草案对这几条怎么处理（D2 到 D6）没有逐条核对，这里不下结论。 |
| 同类插件有没有对应物 | 都用宿主原生的 `subagent`。agnusdei README 14 写明用宿主自己的 `subagent` 工具起帮手。ahetzm 只拦嵌套派发。 |
| 建议 | **待你定**。方向已经定了走原生，问题是引擎本体删不删。<br>(a) 直接删，不留开关。<br>(b) 按 D1 留开关一个版本再删。<br>倾向 (a)，前提是 A4 也删：v1 没了，引擎唯一剩下的用途就是这个回退开关。 |
| 删了牵动什么 | 1. 体量约 4,900 行（`plugin.ts` 约 2,930 行，`src/` 1,977 行）。门和记录在新路线上还要复用一部分（D3、D5），实际能删的比这少，没细分。`src/native-child-gate.ts`（254 行）是新路线的，不算在内。<br>2. 深度词要先安排好。`max` / `xhigh` / `none` / `minimal` 现在靠每次派发时往 `chat.params` 里注入（`src/roster-compile.ts:71–75`），因为原生代理文件只认 `low` / `medium` / `high`。宿主的模型引用支持 `#variant`（`host/schema/src/model.ts:17–40`），但业主用的模型有没有定义这几个 variant〔未验〕。<br>3. 测试：文件名带 `dispatch` 的 11 个。<br>4. D 草案的 D1、D2 整条重写，D3 的「留一份最小的子代理记录」变成唯一来源。<br>5. 工人生成文件里的 `task: false` 和描述文字里的「dispatch via the task tool」要改，D 草案 proposal 99–100 已经列了。 |

### B1 `forge_grep` / `forge_glob`

| 列 | 内容 |
| --- | --- |
| 当初为什么做 | 内建 grep / glob 看不见符号链接和 junction 后面的内容，也搜不到点开头的目录（README 578–591）。forge 自己包了 ripgrep，`follow` 和 `hidden` 默认开。规格：`search-tools`。 |
| 宿主 2.4.0 现在怎样 | 〔源码〕符号链接这半边**没治**。grep 工具的参数里没有 `follow`（`host/core/src/tool/plugin/grep.ts:17–38`），调用时写死 `--hidden`（`host/core/src/ripgrep.ts:243`），从不传 `--follow`。glob 工具只有 `hidden`，默认还是 false（`host/core/src/tool/plugin/glob.ts:23–25、86–93`）。<br>点目录这半边，grep 已经默认搜了。<br>底层其实支持 `follow`（`host/core/src/ripgrep.ts:66–67、77–78、190–191、219–220`），只是工具层没露出来。上游改几行就能让这对工具退休。 |
| 同类插件有没有对应物 | 没有一家做自己的 grep / glob。各家提到 symlink 的地方是沙箱逃逸加固或 worktree 配置，和搜索无关。 |
| 建议 | **留**。业主说的那个问题 v2 还在。<br>可选的小减法：纯 JS 备用引擎（`src/search-js.ts` 458 行，测试 `search-js.test.mjs`）。它存在的理由是「机器上可能没装 rg」。宿主 2.4.0 自己会下载 ripgrep 15.1.0（`host/core/src/ripgrep/binary.ts:15、132`），但放在它自己的目录里，forge 现在不去那儿找（引擎链是 `search.rgPath`，然后 PATH 上的 `rg`，最后 JS，README 610–613）。所以要先让 forge 能借用宿主那份 rg，JS 引擎才谈得上删。<br>给不给上游提「grep / glob 露出 follow」由业主定。 |
| 删了牵动什么 | 不建议删。真删的话，符号链接目录又搜不到；`search.rgPath` 配置项（README 263–298）和测试 4 个（`search-core`、`search-behavior`、`search-js`、`search-wiring`）跟着没了。 |

### C1 goal 模式

| 列 | 内容 |
| --- | --- |
| 当初为什么做 | v1 没有 goal 模式。forge 的做法：一份 goal 文件（约定、Check Log、Turn Ledger），检查命令由宿主进程执行而不是模型自报，能排后续 goal，有预算上限（README 349–423）。规格：`goal-harness`。 |
| 宿主 2.4.0 现在怎样 | 〔源码〕有原生 `/goal`，子命令 `<objective>` / `pause` / `resume` / `clear`（`host/core/src/plugin/goal.ts:38、347–350`）。做法是空转时让模型当裁判，判做没做完（`:104–136、209–220`）。上限 50 轮，连续 3 轮没进展就停，等待上限 30 分钟（`:15–19`）。宿主重启后自动暂停（`:146–147`）。<br>宿主没有的：检查命令、goal 文件、队列。forge 的 `/goal` 现在是盖住原生那个在跑（README 197–199）。 |
| 同类插件有没有对应物 | 有类似的「朝目标循环」，做法不同：courier 用了 `onIdle`（`peers/ivopogace__opencode-courier/src/tree/nudge.ts:53`），agnusdei 有 `src/hooks/features/mission-loop.ts:12`。有没有哪家做「宿主执行检查命令」，子代理说没有，这条没复核。 |
| 建议 | **待你定，倾向留**。业主在用：这个工作区 12 份 goal 文件，11 份完成，1 份排队。「检查命令由宿主跑」正是原生没有的那块。 |
| 删了牵动什么 | `src/goal-file.ts`（653 行）、`src/run-check.ts`（165 行）、`plugin.ts` 约 430 行（2523–2949）；测试 `goal-file`、`goal-mode`；README 349–423；规格 `goal-harness`（270 行）。plan 也删的话 `run-check.ts` 就没人用了。那 1 份排队中的 goal 成了没人执行的文件。 |

### C2 plan 模式

| 列 | 内容 |
| --- | --- |
| 当初为什么做 | 做一套「短周期、单任务」的规格流：plan 文件落盘、草稿期禁写、审批门。规格 `plan-harness` 的 Purpose 原话是「a "short-horizon, single-task spec workflow"」。README 164–166 提醒不要和 opencode 的实验性 plan 模式一起开。v1 那个模式具体缺什么没有查 v1 源码，是从规格反推的。 |
| 宿主 2.4.0 现在怎样 | 〔源码〕原生 Plan 是一个只读代理，提示词是「Discuss the plan with the user directly in the conversation」（`host/core/src/plugin/plan.ts:14–21`），除了 `~/.opencode/plan/*` 之外不许改文件（`:36–40`）。也就是「plan 的时候不许动手」宿主自己做实了。<br>宿主没有的：plan 文件、`plan_close` 那一步确认、和派发门的联动。 |
| 同类插件有没有对应物 | 两家做法接近（子代理查的，没复核）：mission-control 有 `plan` / `plan-approve` 两个工具；Omacode 把 plan 做成一个模式。 |
| 建议 | **待你定**。一个事实：这个工作区根下没有 `.opencode/plan/` 目录，一份 plan 文件都没生成过。做插件开发的「先约定」走的是 OpenSpec。如果别的项目也不靠它，它可以删：它和 OpenSpec 是两套并行的约定机制。 |
| 删了牵动什么 | `src/plan-file.ts`（585 行）、`plugin.ts` 约 650 行（1875–2522）；测试 `plan-file`；规格 `plan-harness`（263 行）；README 相关段落。<br>连带变小：确认门（plan 草稿出现时拦派发的那条）、goal 里「plan 草稿出现就暂停」（README 388–392）、D 草案 D5（草稿期禁止派发）就不用做了；原生 plan 代理的隐藏（README 209–212）要解除。<br>别的项目里已有的 `.opencode/plan/` 文件变成没人读的文件。 |

### C3 crew

| 列 | 内容 |
| --- | --- |
| 当初为什么做 | 宿主没有「一波工人并行干活、收齐了再汇总」这一层。规格：`crew-harness`。 |
| 宿主 2.4.0 现在怎样 | 〔源码〕原生 subagent 后台跑、做完自己叫醒父会话，但「一波」这个概念没有：没有登记，没有收尾汇总。定时自动化有（`host/core/src/tool/plugin/automation.ts:84–102`），那是定时跑，不是一波人。 |
| 同类插件有没有对应物 | Omacode 有「wave」：按计划里任务的依赖链算波次，同一波可以并行（`peers/RentschlerTobias__Omacode/packages/micromanager/src/plan.ts:156–167`、`runner.ts:1010–1015`）。它怎么收尾没有读。其余没有。 |
| 建议 | **待你定，倾向留，随 D 草案瘦身**。业主在用：这个工作区 20 份 crew 记录。 |
| 删了牵动什么 | `src/crew-gate.ts`（68 行）、`plugin.ts` 约 405 行（6352–6757）；测试 `crew-continue`、`crew-gate`；README 1517–1655；规格 `crew-harness`（356 行）；20 份记录变成没人读的文件。<br>留下的话：crew 里那套「空转时催工人继续」的引擎（README 1565–1578）在原生路上大概率多余，因为原生 subagent 自己会叫醒父会话。这条是从源码推的〔未验〕。 |

### D 组（建议都留）

| # | 功能 | 当初为什么做 | 宿主 2.4.0 | 同类插件 | 备注 |
| --- | --- | --- | --- | --- | --- |
| D1 | 子代理体系：`forge.json` 经 `/forge sync` 编译成原生代理文件（README 646–664、774–829；`src/roster-compile.ts`） | 用一份配置管多个工作区的工人 | 代理记录有官方字段 `model` / `hidden` / `permissions`（`host/schema/src/agent.ts:23–35`） | Omacode 也是往代理层加记录 | README 192–196 说「模型钉定只在 v1 有效」，和生成出来的文件对不上（生成的工人文件带 `model:`）。README 该改；v2 运行时是否真按它钉〔未验〕 |
| D2 | forge 主代理；v2 上藏原生 build / plan、新会话默认落到 forge（README 204–240） | forge 一族要有自己的系统提示词和权限面 | 有 `hidden` 字段，代理层的改动可以只留在运行时 | Omacode 用 `hidden: true` 藏管理代理 | 不想藏可以在全局 `forge.json` 里关（`hideNativeAgents: false`）。原生 plan 代理藏不藏，跟 C2 一起定 |
| D3 | `/forge sync` `init` `init global` `stop` | 维护入口 | 没有替代 | 没有对应物 | 连字符写法的旧命令已经退役（README 686–688） |
| D4 | 派发确认门（gate-asks） | 派发前问一句；卡住超时按「没回答」处理 | 宿主没有 | mission-control 也是超时处理，120 秒（`peers/nigel-dev__opencode-mission-control/src/lib/job-permissions.ts:16`） | C2 删的话小一圈 |
| D5 | 运行时工件命名空间 | forge 起的子进程和文件用独立前缀，卸载时不误删用户文件 | 宿主没有 | 没有对应物 | A1、A2 删后文件账本自动少两行 |

## 三、没盘的

- **会话锚点 / 多工作区池门**（「会话认错目录」那套）。原本以为只给 `task` 引擎用，但 `v2Setup` 开头就在给每个目录播种锚点（`plugin.ts:10562–10590`），v2 上是活的。A5 定了再盘，不能跟着引擎一起删。
- `headless-gate.test.mjs` 测的是什么（`src/headless.ts` 已经是没有引用的墓碑文件）。
- 内建代理覆盖（`builtin-override`，别人的 change）和 forge 主代理权限面的重叠。
- `/forge` 各命令逐条去留（规格 `command-surface`）。
- `forge-agent`、`forge-subagents`、`command-surface` 三份规格里有多少条款只为 v1 服务。
- README 1,800 多行随上面各项的增删。文档工作量不小。

## 四、没验的（要沙箱或真机）

1. A1 探针一：孙进程握着输出管道时，后台命令会不会一直显示在跑。
2. A1 探针二：模型侧停不掉转后台的命令，用起来碍不碍事。
3. 宿主重启后命令重新挂回会话（`host/core/src/tool/plugin/shell.ts:271–301`）。
4. v2 运行时是否真按生成文件里的 `model:` 钉模型。
5. 业主用的模型有没有定义 `max` / `xhigh` / `none` / `minimal` variant。
6. 原生 subagent 做完自己叫醒父会话，所以 crew 的催工引擎多余。
7. forge 一族去掉「拒绝内建 shell」之后，工人在 v2 下用内建 shell 的实际体验，比如长跑的服务器命令怎么管。

## 五、等你圈定

1. A1 + A2：一起删？删之前要不要先跑那两条探针？
2. A3：删「其他代理看不见 forge 工具」这半边？
3. A4：放弃 v1？其他机器都在 v2 上了吗？
4. A5：`task` 引擎直接删，还是按 D1 留开关一个版本？前提是先把深度词安排好。
5. C1 goal：留？
6. C2 plan：删还是留？
7. C3 crew：留，随 D 草案瘦身？
8. 排队中的那份 goal（11-23 16:45，「执行完成所有 change，直到插件完美运行在 opencode v2 上」）范围怎么定。减法定了之后它的清单会变。
9. 可选：JS 备用搜索引擎（要先能借用宿主的 rg）；给不给上游提 follow。

圈定之前不立 change、不改代码、不动 D 草案。

## 六、取材

- forge：`README.md`、`plugin.ts`、`src/`、`openspec/specs/*/spec.md`（12 份）、`openspec/changes/adopt-native-subagent-dispatch/`（D 草案）、`tests/`（65 个测试文件，只看了文件名和 import，没跑）。
- 宿主：`%LOCALAPPDATA%\Temp\opencode\research\tag-2.4.0\full\packages\`（2.4.0 源码镜像）。
- 同类：`%LOCALAPPDATA%\Temp\opencode\research-clones2\` 下 13 个仓库。

## 七、圈定结果（11-25，业主逐条答复）

| # | 事项 | 决定 | 备注 |
| --- | --- | --- | --- |
| 1 | `forge_shell` / `forge_jobs` + 看门狗 | 一起删 | 两条沙箱探针没有单独答复，作为该 change 的首批任务执行 |
| 2 | 工具分区 | 删半边：其他代理看不见 forge 工具这一边 | |
| 3 | v1 入口 | 删 | |
| 4 | `task` 派发引擎 | 删，不留回退开关 | |
| 5 | `forge_grep` / `forge_glob` | 留，并倾向改成同名覆盖内建 `grep` / `glob` | 可行性见下 |
| 6 | goal 模式 | 留 | 落盘留档 |
| 7 | plan 模式 | 留 | plan、crew、goal 是互相解耦、紧密结合的编排层，都靠文件落盘防漂移 |
| 8 | crew | 留 | 「瘦身」的含义见下 |

### 第 5 条：同名覆盖可行吗

〔源码〕可行，是宿主的正式机制。

- `host/core/src/tool/AGENTS.md:34`：内建工具、插件、MCP 都通过同一个 `Tool.Service.transform` 注册。
- `:40`：「The latest valid active registration for the same effective name wins.」
- `:41`：`update` 和 `remove` 以有效名为目标；更新保留名字和命名空间，无效的更新保留原定义。
- `:42`：注销插件的注册后，露出被它覆盖的更早定义。停用插件，内建的原样回来。
- `:45`：明确提到「later plugin overrides」。
- 内建的 grep / glob 自己也是这样装的（`host/core/src/tool/plugin/grep.ts:72–74`、`glob.ts:54–56`）。
- 同类先例：courier（`peers/ivopogace__opencode-courier/src/person/question/relay.ts:253`）和 dynamic-workflows（`peers/malhashemi__opencode-dynamic-workflows/packages/plugin/src/host/plugin.ts:490`）都用 `editor.update("question", …)` 改内建的 `question` 工具。没有哪家覆盖 grep / glob。
- 没核实的：「官方推荐」这个说法的出处。镜像里只有源码，没有文档站。

两种做法：`update("grep", …)` 打补丁（补丁无效时内建定义保留），或 `add({ name: "grep", … })` 整件替换。在设计里定，并用沙箱探针确认。

### 第 8 条：crew 的「瘦身」是什么

读完代码后的更正：crew 自己的功能一项都不删。登记、暂停三选一、波次、合同接力、核验、重试一次、关闭门、落盘记录、goal 委派编排，全部保留。

会变的是 crew 底下的连接件，这部分本来就在第 4 条的范围里：

- 波次的定义。现在是「一波并行的 `task` 调用，结果在当轮返回」（`plugin.ts:6400`）。原生 `subagent` 立刻返回，结果稍后由宿主送回。「上一波结果到齐才开下一波」这条规矩，改由「原生子会话在飞」那道门来守。
- 暂停带、池合规门：从拦 `task` 改成拦 `subagent`。
- 结果运送。插件自己那套「把孩子结果推回会话」的机制（`deliverDispatchProgress` / `deliverJobWakes`，`plugin.ts:10328` 一带）由宿主的 background-result 取代。
- 催工那一下（`[forge:crew-continue]`）：先原样留着。宿主自己会叫醒父会话之后它还需不需要、触发条件要不要收紧，要在沙箱里看一轮才能定〔未验〕。

### 立约定时要定的设计点

只读工人删掉 `forge_shell` 之后怎么办。

- 〔源码〕宿主自己的只读代理 `explore`：先拒绝全部，再放行 `shell`、`grep`、`glob`、`webfetch`、`websearch`、`read`（`.env` 要问），拒绝 `subagent`（`host/core/src/plugin/agent.ts:74–92`）。宿主的「只读」只锁改文件的工具，shell 是放开的。
- forge 的只读执行封条（`src/exec-classify.ts`）按 README 1416–1460 自己的定位是「belt-in-depth, NOT a sandbox」，失败时放行。
- 建议：向 `explore` 看齐。只读工人拒绝写文件一族和派发，内建 shell 放开，封条随 `forge_shell` 一起删。代价是只读工人技术上能通过 shell 改东西，和宿主的 `explore` 一样。

### 立约定的经过（11-25）

1. 我先按自己的判断把减法拆成三批，立了第一批的 change（`retire-supervised-exec`）。业主否了拆分：「一批做完」。
2. 于是那件 change 就地扩成整件，改名 `retire-plugin-runtime`，三批并成一批。
3. 同一天业主另定了三件：D 草案「吸收后废弃」（它核实过的事实并进本 change 的 design，草案目录原样不动）；在现有 change 上扩，不另起一件；派发门（暂停带、池合规门、草稿期禁派、工人不许提问）一并重做，全挂到原生 `subagent` 工具上。
4. 前一轮规格评审（1 条 MAJOR、8 条 MINOR、1 条 NIT，均已修）是针对三批时的第一稿做的。并成一批后四件套整体重写，那一轮的结论不再代表现状。

现状（多轮复审修订后）：`openspec/changes/retire-plugin-runtime/`，四件套齐——82 项 tasks 均未勾选、12 份 delta（ADDED 16、MODIFIED 34、REMOVED 57）。单 change strict 通过；全仓 strict 21 过 1 挂（D 草案没有 delta），仍是开工硬阻断，须业主授权处理。另有 builtin-override 待先归档，CLI 提示当前不能直接归档本 change。二轮 Review 发现的 harness 承接、升级及依赖问题已修订；第三轮定点复核仅剩两条规格冲突，已补齐坏 workspace pool 的 fail-soft 基线、统一 fallback 与 crew_close 实证校验，主会话核对全部基线场景标题及重复场景并重跑 strict。实际宿主行为仍待探针验证。批准与前置授权之前不 apply、不改代码、不起沙箱、不跑测试。下文第一轮评审记录为历史。

规格评审（spec-reviewer 子代理，只读）：通过，无 blocker；4 条 major、4 条 minor、4 条 nit。我逐条对过原文，都成立，都已处理。修后重跑严格校验通过，没有做第二轮评审。

- major 四条：
  1. 内建 shell「不推 deny、不拒绝」写成了绝对句，和本 change 自己的两个例外冲突（plan 草稿期的写禁令照样拒它；配方里显式写的 shell 拒绝照写）。改成分句，相关场景加了前提。
  2. `/forge stop`「尽力取消宿主的其他类型作业」没有任务承接。没有按评审建议补任务，而是删了这条承诺——它是我在新稿里加的，旧的 `/forge stop` 从来没管过这些，也不在「能停掉 subagent 就行」的范围里。
  3. proposal 写着「没有必须先落地的 change」，实际有四个交叠的 change 必须先归档。写进了 Depends on。其中 `fix-unknown-session-anchor-seed` 是硬依赖：`Session directory resolved per session…` 那条要求带 14 个场景，9 个是它加的（脚本核过）。OpenSpec 1.13.0 不解析 Depends on，顺序不会被工具拦住，靠 tasks 12.1 归档前核对。
  4. 「原生调用解不开模型钉定」这条新场景没有验证项。补进沙箱腿。
- minor 和 nit 八条：非 forge 代理的保证是两条不是一条（编排状态工具、forge 状态文件）；补一个 `subagent: allow` 解不开再派禁令的场景；只读工人调 `grep` 进沙箱腿，纯 JS 引擎过联接写明只靠单测；一处引用了不存在的测试名，改成 `proc.test.mjs`；删两个空规格目录并入待确认 18；gate-asks 的落点在任务里点名；拿 `explore` 作依据的地方改成陈述宿主出厂的默认（`builtin-override` 落地后用户可以改掉它）；测试计数换成可复现的口径（点名被删模块或符号的是 38 个，按 12 个待删模块的文件名加符号名搜，大小写敏感；原来的 32 是没记下模式的数）。

我替业主选的默认值都列在 proposal 的「需要你确认的默认项」里，保留编号 1–20 便于对照；产品取舍剩 1–8、10、11，治理授权为 12、18（另含 D 草案及依赖处理），其余为技术约束、计划或披露，不以沉默代替批准。批准时可以逐条改。上一版问过没等到答复的三件事，现在的写法：

| 事 | 现在的写法 | 谁定的 |
| --- | --- | --- |
| 拆分 | 不拆，一批做完 | 业主 |
| 只读工人 | 跟宿主 `explore` 一样保留内建 shell；只读形态下 code-mode 入口 `execute` 仍拒绝 | 我（待确认 1） |
| 分区的切口 | 整个删掉「其他代理看不见 forge 工具」这一边；派发不再分 forge 和非 forge。15 个 plan / goal / crew 状态工具归 forge 主代理，工人和非 forge 代理都用不了 | 业主定删（第 2 条）；状态工具的归属是我（待确认 3） |

立约定时新查到的事实：

- 〔源码〕作业系统被派发引擎共用：`plugin.ts` 派发段（3166–6095）有 19 处引用，派发用 `jobManager.create` 记账并挂清理钩子（`plugin.ts:6039–6049`）。所以第一批只删「进程执行」这一半，「派发记账」留到第二批。
- 〔源码〕工人子会话创建时带业主目录（`src/dispatch-async.ts:317`），子会话的权限数组里只有 question / task 的拒绝项（`:300–315`），没有 shell 的拒绝项。换成内建 shell 后「工人在业主工作区里跑命令」这条保证还在。
- 〔源码〕宿主 2.4.0 内建 shell：`timeout` 默认 2 分钟、到点前台转后台后台停止、`workdir`、`background`、退出时通知会话，模型输入里没有 kill 参数（`host/core/src/tool/plugin/shell.ts:29, 60, 65–72, 84`）。插件接口的事件里没有给内建 shell 塞环境变量的钩子（`host/plugin/src` 全量查到的事件：`execute.before` / `execute.after`、`session.prompt` / `session.context`、`catalog.updated`、`create.before`、`setup.prompt`）。
- 三个已做完、未归档的 change 与第一批改到同一条规格：`worker-shell-session-allow`（13/0）、`fix-unknown-session-anchor-seed`（15/0）、`doc-plugin-unload-v2`（13/0）。归档顺序：它们先，第一批后。
- OpenSpec 1.13 不允许 MODIFIED 丢 scenario（校验与归档同一套判定），含义变了的要求写成「旧名 REMOVED + 新名 ADDED」。
- 65 个测试文件里 32 个点名了被删的符号（grep 计数，上限）。
