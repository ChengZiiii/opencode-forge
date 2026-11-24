# 调研：在 opencode v2 上做子代理编排——别人怎么做、官方怎么设计、我们该怎么选

> 2026-11-25。只调查，没改任何行为。宿主的结论以 **v2.4.0 源码**为准（GitHub
> 提交 `44aed4f`，和本机装的版本一致）。本机只有编译好的 exe，源码是从公开仓库按
> 版本标签逐文件拉的。社区插件的结论以它们自己的文档和 issue 为准，没装没跑。
>
> 证据标注：【源码】读到代码 ·【文档】官方文档 ·【社区】社区插件自己的文档 ·
> 【实测】沙箱里跑过 ·【issue 正文】读过正文 ·【issue 标题】只看了标题和标签 ·
> 【判断】我的解读，不是事实。
>
> 局限：宿主 issue 用的是 GitHub 搜索结果的前 40 条（标题带 subagent 的开放 issue
> 一共 83 条），按更新时间排序，不是全量。slim 的控制工具源码和 smart-subagents 的
> 协调器源码拉下来了但没读，对它们的结论只基于设计文档。

## 结论

- **D（派发走哪条路）：建议保留 `tools.task`，不重写成原生。** 你要的功能原生在
  2.4.0 上给不了（同步派发、并发上限加排队、按次权限、报告文件）；而“混合”这条路
  并不会错过宿主的好处——**宿主给父会话送完成消息、重启后接着跑，这两件事对插件
  自己建的孩子同样生效**（前者有源码和沙箱实测，后者只读了源码）。这不等于现在
  就没问题：调研发现四处值得下一步处理，都还没设计，见第五节 D。
- **A（老账 D1）：选乙**（把注释和规格改成如实描述 2.4.0 的行为）。官方设计和社区
  同行是一致的：清理函数只拆插件实例自己的东西，作业不随插件卸载被杀。
- **B（会话认错目录）：你已批甲，可以开工，不难。** v1 没出问题不是因为代码写得好，
  是 v1 一个插件进程只有一个目录；v2 这个前提没了。
- **C（原生派发绕过派发门）：你的前提成立**——`build`、`plan` 在 2.4.0 上根本不能被
  原生 `subagent` 派出去。按你的定位，建议撤掉 change #2 的草案。

## 一、宿主 2.4.0 是怎么设计的

### 1. 原生 `subagent` 工具【源码】`packages/core/src/tool/plugin/subagent.ts`

- 入参：`agent`、`description`、`prompt`，可选 `model`、`sessionID`（给同一个孩子追加
  指令，孩子还在跑就并入当前这一轮）。
- **只有后台模式**。工具说明原话："Subagents always run in the background: the call
  returns immediately with a sessionID"。同步（前台）执行在 v2 里没有了，社区在
  要求恢复（宿主 issue #64073，26 条讨论，开放）【issue 标题】。
- 不限并发数。
- **`primary` 模式的代理不能被派**，直接报错 `Agent X cannot run as a subagent`；
  `hidden` 的代理不进“可用子代理”清单。
- **它本身就是用插件接口写的**：`ctx.tool.transform` 里 `editor.add({ name: "subagent",
  options: { codemode: false }, … })`，再加 `ctx.tool.hook("execute.before")` 和三个
  会话钩子。也就是说，“建一个带 `parentID` 的子会话、发提示词”就是官方自己的
  积木。
- 派发前查深度（`session/subagent-depth.ts`）：上限默认 1，从当前会话沿 `parentID`
  往上数。**所以任何带 `parentID` 的会话默认都不能再派原生子代理**，不管这个会话是
  谁建的。想放开要改 `experimental.subagent_depth`。
- 派发时在宿主作业表里登记一条子代理作业，注释原话："Jobs outlive the plugin that
  launched them."

### 2. 完成通知：宿主做，和谁建的孩子无关【源码】`session/execution/subagent-report.ts`

一个会话的**每一轮执行结束**时（成功、失败、被用户中断；因关机被打断的那类走第 3
节的重启恢复），宿主自己做完下面一串：

1. 看这个会话有没有 `parentID`。有就继续；没有、也不是宿主登记的子代理作业，就什么都不发。
2. 定正文：失败 → 错误信息；被用户中断 → "Subagent cancelled"；否则取**这一轮**最后
   一条助手消息。这一轮没有助手消息、又不是宿主作业 → 不发。
3. 报告和“执行结束”事件在**同一个数据库事务**里写进待投递表，所以重启后还能补投。
4. 以合成消息投进父会话收件箱，投递方式是 `steer`：父会话正忙就等它到下一步，闲着就
   开新一轮。父会话已经不存在就不投。消息里还附带这个孩子自己剩了哪些后台活没干完。

这和沙箱实测对得上【实测】：我们引擎自己建的孩子，完成消息是宿主送的（5.5–7.3 秒
内），插件 4.5–6.1 秒后又补了一条 `[forge:dispatch-complete]`，父会话因此多跑一轮
（3 次）。社区插件的文档也是这个说法："The host also reports later direct child
prompts, not only calls through the subagent tool"（oh-my-opencode-slim）【社区】。

### 3. 重启恢复：也是宿主做【源码】`session/execution/restart.ts`

- 开机时宿主扫一遍“上一轮没跑完”的会话（执行认领没被释放的），**不需要上一个进程
  配合**——源码注释说崩溃、强杀、正常重启留下的记号都一样。
- 给它发一条消息："The server restarted while you were working. Continue from where
  you left off without repeating completed work."，然后恢复执行。
- 同一轮最多自动续 10 次，超过就判失败，不再自动续。
- 原生子代理作业另有恢复记录；源码注释写明 "A directly driven child can also settle
  and wake its parent"——**插件自己建的孩子也在这套恢复里**，续跑完照常给父会话送
  报告。
- 语义是“至少一次”（注释原话 "Recovery is at-least-once"）：崩溃之后，对外的副作用
  可能重复。
- **没实测**，只读了代码。

### 4. 插件的生命周期和多位置【源码】+【文档】

- `setup` **每个位置（目录）各跑一次**。清理函数就是 `setup` 返回的那个函数——加载器
  注释原话 "only a function is a cleanup"。插件作用域关闭时它才运行：重载配置、位置被
  驱逐、服务关停。
- 文档原话：`ctx.location` 是 "the plugin instance's location, **not the location of
  every session it can access or event it receives**"。
- **npm 包插件的模块每个进程只求值一次**，模块级变量被所有位置共享（forge 属于这种）；
  本地路径插件则每个位置各求值一次（宿主 issue #62438）【issue 正文】。
- **配置里加载的插件会收到所有位置的事件**：加载时宿主把上下文削到只剩作用域和日志
  器，位置过滤没了。会话级钩子（`session.prompt`、`tool.execute.*`）却只在会话所属
  位置的那个实例里触发。**倍数 = 宿主里加载的目录数。** 维护者已复现，11-23 仍在
  更新，没修（#56290）【issue 正文】。
- 事件信封一定带 `id`；`location` 是可选字段【源码】`schema/event.ts`。所以“按事件
  id 去重”对每种事件都做得到，“按位置过滤”不保证。
- 位置驱逐：每分钟扫一次，闲置超时且没有在跑的执行、没有后台作业、没有终端占着，
  才卸载。**宿主不会驱逐有活干的位置。**
- 位置是按需加载的：没有客户端碰那个目录，它的插件不会跑【社区】smart-subagents
  文档的 Gotchas 一节；和我们真机上观察到的 Paseo 行为一致。

### 5. 官方给插件留的口子，和 forge 现在用了哪些【文档】+【源码】+ forge 架构文档

| 接缝 | 能做什么 | forge 的用法 |
| --- | --- | --- |
| `ctx.agent`、`ctx.tool.transform` | 注册代理、增删改工具。文档明文：后注册的覆盖同名 | 注册 forge 和池里的子代理、全部 15 个工具 |
| `ctx.tool.hook("execute.before" / "execute.after")` | 执行前改入参或拒绝，执行后看结果 | 活动标记、派发护栏、状态文件边界、plan 草稿期禁写 |
| `ctx.permission.hook("evaluate")` | 把 allow / ask 改成 deny | 变更拦截带、决策门 |
| `ctx.session.create` / `prompt` | 建子会话（带 `parentID`）、发提示词 | 派发建孩子、发提示词（走同一个公开接口） |
| `ctx.session.hook`（`prompt` / `context` / `compaction`） | 每次模型请求前后介入 | `context` 钩子改写模型钉扎；`compaction` 钩子随族门控 |
| `ctx.session.hook("experimental.idle")` | 会话没有任何待办、即将闲置时才触发。**没写进公开文档** | goal 续跑的主空闲边（plugin.ts L9640）；宿主事件 `session.execution.succeeded` 当兜底 |
| `ctx.event.subscribe` | 全服务器事件流 | 播种会话表、收 `session.execution.*`、收割已删会话 |
| `ctx.command` | 注册斜杠命令 | `/plan` `/goal` `/crew` |

大类上逐项对过，用的都是文档里的接缝；唯一例外是 `experimental.idle`——宿主自带的
`/goal` 用的是同一个钩子，forge 在 2.4.0 上已经在用，并且有兜底。参数级没核。

## 二、社区怎么做：三种模式

| 模式 | 做法 | 代表 |
| --- | --- | --- |
| A 原生 + 薄策略层 | 模型直接调宿主 `subagent`；宿主管执行、完成投递、重启恢复；插件只加代理预设、任务状态和几个现查现答的薄工具 | oh-my-opencode-slim（3.0.8 起）、opencode-orchestrator、Omacode、opencode-nexus（首选） |
| B 换掉原生工具，插件自管 | 同名覆盖 `subagent` 或另起一个工具；插件自己建孩子、跟踪、投递；加上前台等待、按次权限、隔离工作区、双向消息 | opencode-smart-subagents、**我们的 forge** |
| C 不做插件了 | 自带运行时 | oh-my-opencode → OmO Native |

**最值得看的是 oh-my-opencode-slim，它走完了 B → A 的全程**【社区】+【issue 正文】：

- 3.0.7 是模式 B：插件自己有“完成发布器”、看板、租约。多位置时每个目录一份插件
  实例，结果父会话给出最终回答后又被叫醒 **20 次**，多花 50 万输入 token（#1937、
  #1940）。
- 修法（#1902，3.0.8）：**把插件自己的发布器整个删掉**，完成投递全交给宿主，设计
  文档写的是 "Submission is not completion; use native completion delivery rather
  than polling"。修完验证：3 个位置、3 份事件订阅，父会话每次执行只收到 1 条完成
  通知、只被唤醒 1 次。
- 代价也写在它的文档里，明确没有的东西：可复用会话池、并发队列、墙钟看门狗、周期性
  空闲唤醒、短别名、看板注入。它另外保留了不限并发的原生子代理。

**opencode-smart-subagents**（模式 B，和 forge 最像）【社区】`docs/ARCHITECTURE.md`：

- 协调器状态放 `globalThis`（进程里唯一），每个孩子的记录镜像到插件存储（跨重启）。
- 看护孩子用 `session.wait`；事件按 id 去重（"Every instance receives every event"）；
  用 `context` 钩子按会话给工具。
- **不限并发**（"matching the built-in tool"）。
- 完成消息由**插件自己投递**。按宿主源码，带 `parentID` 的孩子宿主也会投；两者会不会
  重复，它的文档没说，我没验证。
- 文档里专门列了一张“依赖的 OpenCode 内部实现，每次升级要复查”的清单。
- 它记录的两个坑：重启后插件按位置惰性加载，没人碰那个项目，它的孩子就没人管；
  重启后宿主不会因为有待处理的收件消息而叫醒会话。

**模式 C 的背景**：oh-my-opencode 是最大的编排插件，维护者公开表示“不打算把
OpenCode 版延伸到 v2”，主推自带的运行时（#7903）。插件接口从 v1 到 v2 整个重来，
是它直接退出的原因【issue 正文】。

## 三、社区反馈：踩过的坑

### 宿主侧（`anomalyco/opencode`）

读过正文的：

- **#56290 多位置事件倍数**。维护者复现；社区通的绕法三种：认领状态放 `globalThis`、
  按 `event.id` 去重、按 `event.location` 过滤。
- **#62438**（已关闭并归入 #56290）：每个位置一份插件实例、事件到所有实例、会话钩子
  只到所属实例。
- **#3815** 官方答复："do not infer completion from `session.idle`; use
  `client.v2.session.wait`"。
- **#55358** `session.idle` 在事件清单里声明但从不发出（已复现，开放）。
- **#60245** 孤儿后台孩子的完成消息没人消费（开放）。
- **#36349** 重启后保留父子完成关系（已关闭）。PR #58508 想加空闲钩子，**已关闭未
  合并**。

只看了标题和状态的（目前都开放；除 #60004、#61131、#55168 外，11 月 11 日之后还有更新）：

| 编号 | 标题说的 | 和我们的关系 |
| --- | --- | --- |
| #64073 | 要求恢复前台（同步）子代理执行，26 条讨论 | 原生路给不了同步派发 |
| #63894 | 后台子代理每一轮内部回合都唤醒父会话（报于 2.3.0） | 多唤醒 |
| #65316 | 孩子还在跑，父会话就报告完成 | 父会话抢跑 |
| #64352 | 注入的子代理完成消息把父会话的模型切成孩子的模型（报于 2.2.6，Windows） | 完成消息的副作用 |
| #64840 | 续用的孩子保留过期的父权限；“可用子代理”清单不看会话权限 | 原生路没有按次权限 |
| #59293 | 用 `sessionID` 续用孩子总是报找不到 | 追加消息 |
| #64733 | 会话和子代理没有默认的步数 / 时间 / 费用上限（有人 2–3.5 小时花了约 35 美元） | 预算 |
| #57157 | 希望有钩子能推迟或抑制中间的子代理失败通知 | 进度通知 |
| #66093 | 子代理里的工具调用卡在“运行中”，没有超时也没有取消 | 误判死活 |
| #56862 / #56907 | 子代理在上下文压缩时反复失败；查看子代理时权限确认卡住（都已复现） | 原生子代理自身的稳定性 |
| #65277 / #63785 | 父模型在孩子还在跑时自己编出“已完成” / 没有独立工作时也派后台 | 模型行为 |
| #51213 | 后台服务会去续跑另一个共用数据库的服务仍在跑的会话（已复现） | 重启恢复 |
| #60004 | 桌面端不带位置调 `plugin.list()`，在共享服务里建出一个 `$HOME` 位置并加载全部全局插件（已复现） | 和我们真机上多出一个目录是同一类问题 |
| #61131 | 多个位置同时装同一个 npm 插件，锁超时 | forge 是 npm 插件 |
| #54654 / #55168 | 冷位置第一次 `plugin list` 说没插件；删了重建的目录留着旧配置 | 多位置 |

### 插件侧

- **supermemory**（PR #99）：插件“假设每个进程一个实例”，新目录一加载就把旧目录的
  实例清掉。修法是按目录区分所有权。**和 forge 认错目录是同一类病。**
- **opencode-antigravity-auth**（#610）：一个位置被驱逐，它的清理函数把全局注册一起拆了。
  **这就是 A 那笔老账里“接通清理会连坐”的现实版。**
- **oh-my-opencode**：宿主换 SDK 后钩子静默失效（#5575）；给子会话注入的“禁提问”
  权限和宿主冲突，子代理全成僵尸（#1711）。
- **opencode-orchestrator**（8–9 月，均已关闭）：会话池在宿主还在落盘时删会话，外键
  报错丢任务（#41）；“模型正干活时一直被打断”（#38）。
- **opencode-nexus**（9 月，均已关闭，只看标题）：`goal.status` 等三个工具各注册了两次，
  第二个悄悄盖掉第一个（#87）；完成的工人没被标成结束而是直接从表里删了（#100）。
- **opencode-smart-subagents** 一共 1 个 issue，**Omacode** 0 个——这两个的社区反馈
  还很少。

## 四、两条路对我们的功能够不够用

“官方原生路”= forge 会话直接用宿主的 `subagent`；“混合”= 保留 `tools.task`。

| 我们要的功能 | 官方原生路 | `tools.task` 混合（forge 现状） |
| --- | --- | --- |
| 后台子代理 | 宿主原生 | 插件建子会话（带 `parentID`）再发提示词 |
| 同步派发 | **没有** | 有（不带 `run_in_background` 就是同步） |
| 每会话并发上限 + 排队 | **没有**，原生不限并发；钩子只能拒，做不到“先收下、空出名额自动派”【判断】 | 有（`ASYNC_DISPATCH_CAP`，满了排队） |
| 按次权限（异步工人禁提问等） | **没有**，只有按代理的权限 | 有 |
| 报告 | 孩子最后一条消息；报告文件契约要另想办法 | 报告文件 + 唤醒里带最后 2500 字 |
| 进度通知 | 每轮结束送一次；中间进度靠事件流转发 | 有（`[forge:dispatch-progress]`） |
| 完成通知 | 宿主，一条 | 宿主送一条，插件再补一条【实测】 |
| 完成判定 | 宿主 | 宿主事件 + 轮询视图 + 结果流，三路合判 |
| 给孩子追加消息 | 原生 `sessionID` 参数 | 有 |
| 重启后续跑 | 宿主 | 宿主也会做；插件自己的收养逻辑和它有没有重叠，没对过 |
| `/forge stop` | 在跑的能停；没有排队 | 有，连排队的一起取消 |
| 派发日志 | 靠执行前后钩子，多位置要去重 | 有（`dispatch-log.jsonl`） |
| 多位置去重 | 得自己做 | 得自己做；现在是否幂等没核对 |

**兼容性：**

- 混合路不比原生路“不官方”。宿主自己的 `subagent` 就是“建带 `parentID` 的子会话 +
  发提示词”拼出来的，forge 走的是同一块积木；同名覆盖也是文档明文的机制。
- 两条路都躲不开的上游问题：多位置倍数、重启后按需加载、通知是“至少一次”、第三节
  那一串原生唤醒相关的开放 issue。
- 走原生多拿到的：代码少一大截，上游以后改进了自动受益。多丢掉的：同步、排队、按次
  权限、报告文件。

## 五、四个问题的建议

### D：保留 `tools.task`，不重写；下一步处理调研发现的四件事

每一件都要单独立 change、沙箱验证后再发。**下面只说“发现了什么”，没设计“怎么改”。**

1. **完成时父会话收到两条消息**【实测 + 源码】。宿主送 `<background-result>`，插件
   再送 `[forge:dispatch-complete]`，父会话多跑一轮。
   **不能整条删**：这条唤醒在插件代码里出现 16 处，绝大多数是写给模型的提示词和唤醒
   文案，是契约的一部分（“结束本轮，等这一条，别轮询”）；它还分三种文案——正常完成、**中止及原因**、**结果流丢失**——后
   两种宿主的消息里没有。要收窄到“正常完成时不重发报告正文”这一种情形，并且同步改
   提示词。
2. **多位置倍数**【issue 正文】。forge 的状态本来就是全进程一份（npm 包插件的模块只
   求值一次），这点和 smart-subagents 的 `globalThis` 方案等价。**没核对的是**：同一
   个事件被每个目录的实例各处理一遍时，我们的处理器是否幂等。沙箱只有 1 个位置，看
   不见这个问题。建议先加一条多位置的沙箱腿，再谈改。
3. **重启**【源码，未实测】。宿主会自己续跑被打断的那一轮，也会在续跑后给父会话送
   报告。forge 的重启收养逻辑要和它逐段对一遍，避免两边都做或者互相打架。
4. **看守循环里的轮询视图和结果流**。宿主现在自己送完成消息了，这两路还要不要、是不
   是“误判死亡 / 失去连接”的来源——**要拿具体事故的证据来回答，这次调研没有结论**。

什么时候该选原生：愿意放弃同步派发和排队、接受“报告 = 最后一条消息”。那样能删掉
引擎的大半。

### A：选乙

老账 D1 的来历：状态页原话——“宿主 2.4.0 只把 `setup` 返回的函数当清理函数，所以
插件里‘目录被驱逐时清理作业’那段代码永远执行不到；连挂四版。”

选乙的理由：

- 宿主自己的原则是“作业比启动它的插件活得久”；forge 的架构文档第 9 条也写着“插件
  dispose 不是击杀触发器，在飞的派发照跑”。所以那段执行不到的代码，**效果上正好和
  该有的行为一致**，错的只是注释和规格的说法【判断】。
- 接通它（甲）和官方设计相反；antigravity-auth 就是清理函数拆了全局注册，把别的
  目录一起弄坏。
- 驱逐这条路本来就不会带着活作业触发——宿主不驱逐有活干的位置。

乙要做的事：改注释和规格，如实写“2.4.0 上卸载不触发这段清理；作业归宿主管；下次
加载时对账认领”。那段执行不到的代码删不删，你定。

### B：为什么 v1 没问题，难不难

- v1 时插件的启动目录就是它唯一的目录，代码注释里写的也是“单项目情形”。v2 改成一个
  后台服务同时托管所有打开的项目：`setup` 每个目录跑一次，模块级变量却只有一份，后
  初始化的目录把前面的覆盖掉。
- **不难。** 修法是不再拿那个共享变量当答案，改成向宿主查这个会话属于哪个目录。
  change #1 的任务清单 15 项。我之前讲得复杂，是在数“有多少处代码读了那个变量”
  （波及面），不是难度。
- 只有一处要小心：有一道检查是同步的、不能等查询结果。设计里让它不抢先拒、交给先
  触发的那道门，并且要有一条沙箱腿钉住。

### C：前提成立，建议撤掉 change #2

- 沙箱里查过：forge 的配置下 `build`、`plan` 是 `primary` + 隐藏【实测】。
- 源码里：`primary` 的代理不能被原生 `subagent` 派发，隐藏的不进清单。所以“build 借
  原生派发派 forge 工人”这条路在 2.4.0 上走不通，除非有人用接口硬建一个 build 会话。
- 按你的定位（forge 是 opencode 的扩展，不是画地的围栏），这个 change 不该立。等你
  一句“撤”我就删草案。
- 残留影响只有一条：别的代理直接派 forge 工人时不经过池上限，可能撞限流。这是记账
  问题，不是安全问题。
- 顺带核了那道“子会话禁再派发”的封印（`src/dispatch-async.ts` L63）：它拒的动作名是
  `task`，而 2.4.0 原生工具的权限动作名是 `subagent`，**所以它拦不住 2.4.0 的原生
  `subagent`**。实际拦住孩子再派的是宿主自己的深度检查（第一节“派发前查深度”那条）。
  这段规则对名字还叫 `task` 的工具有意义，不需要为 2.4.0 改它【判断】。
- 以后如果想让原生 `subagent` 也经过 forge 的并发上限和排队，文档给的办法是同名覆盖，
  smart-subagents 就是这么做的。这是另一个 change，我没评估过可行性。

## 六、没验证的

1. **多位置下 forge 的事件处理会不会重复**（第五节 D 第 2 件）。
2. 插件自己建的孩子，服务重启后是否真的被宿主续跑（源码如此）。
3. 完成通知的双份投递只在沙箱 1 个位置下测过（n=3）；多位置下会不会变成更多份，没测。
4. 真机的 forge 会话没有原生 `subagent`、沙箱里有，原因仍没查到。
5. 第三节标了【issue 标题】的那些，我没读正文，标题可能有夸大或已经变化。

## 七、更正

1. 我说过“插件用同名 `subagent` 注册能顶掉原生的，但靠的是没写进文档的行为”。**错**：
   文档明确写着后注册的覆盖同名，宿主自己的内建 `subagent` 就是这么注册的。
2. 状态页（11-25 00:40 版）写过“病根是插件还在自己轮询、再补发一遍”。**“补发一
   遍”成立**（实测 + 源码）；**“轮询是病根”说早了**——forge 的看守本来就是“宿主事件
   + 轮询视图 + 结果流”三路合判，宿主的完成信号我们一直在收；轮询是不是某起误判的
   原因，我没有取过证。状态页已同步更正。

## 来源

- 宿主源码，标签 `v2.4.0`（提交 `44aed4f`）：`tool/plugin/subagent.ts`、
  `session/subagent-depth.ts`、`session/subagent-job.ts`、`session/background.ts`、
  `session/subagent-completion.ts`、`session/execution/subagent-report.ts`、
  `session/execution/restart.ts`、`session.ts`、`session/run-coordinator.ts`、
  `job.ts`、`job/recovery.ts`、`location-activity.ts`、`location-services.ts`、
  `location-service-map.ts`、`location-lifecycle.ts`、`plugin.ts`、`plugin/host.ts`、
  `plugin/goal.ts`、`plugin/plan.ts`、`plugin/hooks.ts`、`plugin/service.ts`、
  `packages/plugin/src/promise/adapter.ts`、`packages/schema/src/event.ts` 与
  `session-event.ts`。
- 官方文档（同版本在仓库 `services/site/src/docs/content/build/plugins/server.mdx`）：
  `opencode.ai/docs/build/plugins/server/`、`/permissions/`、`/tools/`、
  `/build/plugins/migrate-v1/`、`/build/plugins/rpc/`、`/sdk/`、`/client/`。
- forge 自身：`docs/architecture.md` 第 8、9 条和“v1 / v2 双入口”一节；`plugin.ts`
  L1287–1317（唤醒文案）、L9640（`experimental.idle`）、L10255–10290（事件路由）；
  `src/dispatch-async.ts` L55–67。
- 社区：`alvinunreal/oh-my-opencode-slim`（`docs/background-orchestration.md`，issue
  #1899、#1902、#1937、#1940、#1947）、`shariqriazz/opencode-smart-subagents`
  （`docs/ARCHITECTURE.md`）、`code-yeongyu/oh-my-openagent`（#5575、#7903、#1711）、
  `agnusdei1207/opencode-orchestrator`（#38、#41）、`serkanalgur/opencode-nexus`（#87、
  #100）、`RentschlerTobias/Omacode`、`supermemoryai/opencode-supermemory`（PR #99）、
  `NoeFabris/opencode-antigravity-auth`（#610）、`nagisanzenin/omniplugin`。
- 宿主 issue：#56290、#62438、#60004、#63894、#64840、#64352、#59293、#56862、
  #56907、#64733、#57157、#60245、#55358、#3815、#36349、#64073、#65316、#66093、
  #65277、#63785、#51213、#61131、#54654、#55168，PR #58508。
- 抓取脚本、清单（URL 钉在版本标签或提交号上）和读过的原文，归档在工作区的
  `archive/2026-11-25-research-v2-subagent-orchestration/`（归档前做了密钥扫描）。
