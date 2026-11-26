# Design: retire-plugin-runtime

动机见 proposal.md 的 Why；要求见 `specs/`。这里只写怎么做。证据标注同 proposal：
〔源码〕〔沙箱〕〔未验〕。宿主路径省略前缀 `packages/`。

## Context

### 宿主这一侧（〔源码〕v2.4.0，除非另注）

**能拒绝一次工具调用的钩子只有一个。** `core/src/plugin/hooks.ts:23`：「Only tool execute.before
may fail: a Tool.Error rejects the call before it runs.」插件接口那一层（`plugin/src/promise/adapter.ts:265–284`）：
回调被 `Effect.tryPromise` 等完，抛出的东西变成这次调用的 `Tool.Error`（`:726–729`：是 `Tool.Error` 就原样，
否则拿 `message` 包一个）；回调还能改写 `tool` 和 `input`。所以在这里拒绝，工具不会执行，孩子不会被建出来。

**权限钩子不是同一个东西。** `permission.evaluate` 钩子在工具自己调用 `permission.assert` 时才触发
（`core/src/permission.ts:212–238`）：配置里的静态拒绝先短路，插件钩子根本不被调用；其余情况必经插件钩子，
插件可以改写裁决；裁决是「问」而当前没人值守时直接拒绝。插件接口把它包成 `Effect.promise(...)`
（`adapter.ts:525–526`），也是等完的。所以它看得到的是「某个动作的权限求值」，不是「一次工具调用」。

**工具登记表按有效名字 keyed。** `core/src/tool.ts:255–288`：`add` 提交到 `effectiveName(tool)` 下，同名后者胜；
`update(id, fn)` 克隆当前定义、交给回调改、把 `name` / `id` / namespace 强制改回原值、再提交；找不到的 id 直接
忽略。`core/src/tool/AGENTS.md:34–45`：无效的更新保留旧定义；登记被撤销时只拿掉它这一层变换，露出它盖住的
定义。插件接口（`plugin/src/promise/tool.ts`）：`list()`、`get(id)`、`update(id, (tool) => …)`。

**内建 `grep` / `glob`**（`core/src/tool/plugin/grep.ts`、`glob.ts`）：参数 `pattern`、`path`、（grep 另有
`include`、`literal`、`caseSensitive`）、`limit`，glob 有 `hidden`（默认 false）；都是 `codemode: false`。
执行顺序：解析路径 → 检查「这个环境能不能搜索」→ 工作区外路径的外部目录授权 → `permission.assert`
（动作是工具名，资源是 pattern，带上会话号、代理名、消息号、调用号）→ 搜索。输出：给模型看的文本，加一份
结构化 `output`（声明了 schema）。grep 的文本是 `Found N matches` + `path:` + `  Line n: 文本`，glob 是每行
一个路径或 `No files found`，超过 100 条有截断提示。

**内建 shell**（`core/src/tool/plugin/shell.ts`）：`DEFAULT_TIMEOUT_MS = 2 * 60_000`（`:29`），到点前台转后台、
后台停止（`:60`）；参数 `command`、`workdir`、`timeout`、`background`（`:63–72`）；后台运行时结果里带
`shellID`，退出时通知（`:82–84`）。只有宿主开了 `full_codemode` 时 shell 才能在代码模式里调（`:416–425`）。

**原生 `subagent`**（`core/src/tool/plugin/subagent.ts`）：参数 `agent`、`description`、`prompt`、`model?`、
`sessionID?`（`:30–44`）；`codemode: false`（`:105`）；总是在后台（`:53`）；深度上限默认 1，超了报错
（`:118–125`）；带 `sessionID` 续用的必须是当前会话的孩子，并且可以换代理（`:151–162`）。

**命令就是它的执行体。** `core/src/command.ts:22–26`：`execute(input) => Effect<void>`；宿主自己的 `/init`、
`/review` 都是在 `execute` 里调 `ctx.session.prompt` 投递（`core/src/plugin/command.ts:28–54`）；`execute` 被
等完，抛错变成 `Command.ExecutionError`（`command.ts:84–92`）；插件接口同样等完（`adapter.ts:344–359`）。
命令的提示默认按 `steer` 投递（`core/src/session/command.ts:34`）。

**宿主的 HTTP 接口**（D 草案已核实，〔源码〕`protocol/src/groups/shell.ts`、`job.ts`）：`GET /api/shell?location[directory]=…`
列出某目录下正在跑的命令，`DELETE /api/shell/:id` 终止并移除，这组不标实验性；`GET /api/experimental/job`、
`POST /api/experimental/job/:id/cancel` 管所有作业，标着实验性。forge 的 v2 入口本来就有一条直连宿主的通道
（`plugin.ts:10055–10062`，读 service.json 里的地址和口令），读消息、打断后备、遍历原生孩子三条调用在用。

**权限规则的次序**（D 草案，〔源码〕`core/src/permission.ts:102–119`）：代理规则、会话规则、保存的「总是允许」
依次摊平，最后一条匹配的生效；配置里的拒绝排在保存的放行前面。带 `parentID` 建的孩子继承父会话的会话级规则。

### forge 这一侧（〔源码〕，行号是 11-25 工作区的）

- `plugin.ts` 10,944 行。v1 入口 `export const server` 在 `:7692–8772`；v2 入口 `v2Setup` 在 `:10561`。
  v2 的带子和注入与 v1 共用模块级状态，工具体（`forgeTools()`，`:6772`）是两边共用的纯函数。
- v2 现有的钩子：权限带 `ctx.permission.hook("evaluate")`（`:9278` 起）；工具钩子 `execute.before` / `execute.after`
  （`:9276–9568`）；`context` 钩子（注入、家族映射）；空闲钩子（goal / crew 续跑）。
- 工人的编译权限面（`src/roster-compile.ts:52–69`、`:115–124`）：每个工人都写 `task: false`、`shell: false`、
  `bash: false`；只读形状再关写类家族和 `execute`（代码模式）。文件头只发探针证明过的键：description、mode、
  model、tools。`v2PermissionArray`（`plugin.ts:10535–10539`）把配方 `permission` 原样当动作名发出，并总是追加
  一条内建 shell 的拒绝（`V2_SHELL_DENY`，`:10522`）。
- 写类工具名单 `WRITE_TOOLS`（`:1784`）= write、edit、bash、task、apply、applypatch、patch、multiedit。有 `task`
  和 `bash`，没有 `subagent` 和 `shell`。草稿期写禁令、goal / crew 的活跃度打分都靠它。
- 派发引擎：`plugin.ts:3145–6090` 加零散辅助函数，底下是 `src/dispatch-async.ts` 等四个模块；作业系统
  `src/job-*.ts`；看门狗 `src/watchdog.ts`、`src/proc-locate.ts`、`src/host-exit.ts`；封条 `src/exec-classify.ts`。
- 搜索引擎 `src/search-core.ts`（类型化参数 → 固定的 rg 参数向量，或 `src/search-js.ts` 的纯 JS 遍历）、
  跟随去重、外部目标披露——保留结果语义；外部实际目标读前授权须两引擎各验。
- 没有派发引擎之后，工人会话不再是插件建的：task 引擎建孩子时盖的「禁止提问」会话级规则（`src/dispatch-async.ts`
  的 `QUESTION_DENY_*`）没人盖了（〔沙箱〕原生派出的工人调提问工具会一直挂着）。
- `src/headless.ts` 是个没人引用的墓碑文件。`src/` 下物理删过文件（提交 `828b9c5`，删了 6 个旧的 dispatch 文件）。

### 同行（D 草案 2026-11-25 的对照，取材清单在那份 design 的文末）

十个支持 v2 的编排插件里五个走原生或贴着原生，五个自己建会话自己管。四家（含宿主自己的内建子代理）把
「不提问」写进代理定义。没有一家去终止孩子留在宿主那边的后台命令。

### OpenSpec 1.13 的规矩

MODIFIED 不许丢 scenario（校验和归档是同一套判定）；delta 机制管不到 `## Purpose`。

## Goals / Non-Goals

**Goals**

- forge 在 v2 宿主上只有一个 shell（内建）、一个派发面（原生 `subagent`）、一对搜索工具（内建 `grep` / `glob`）。
- 删干净执行面、作业、看门狗、封条、派发引擎、v1 入口，连同配置项、环境变量、提示词文案、测试、文档。
- 引擎没了，门一道不少：全部改挂到原生 `subagent` 的调用上。
- 保住：goal 校验命令的解释器选择；确认门不被自动裁决；草稿期写禁令；crew 的全套门和记录；plan 的落盘和确认。
- 主规格里不留指向已删能力的句子。

**Non-Goals**

- 不重做任何宿主已经做了的事（执行、通知、续跑、读子会话、续发消息）。
- 不给内建 shell、`subagent`、`grep`、`glob` 包一层或改权限规则。
- 不修宿主的跨锚点权限缺陷。
- `/forge stop` 不去取消宿主的其他类型作业（代码模式脚本、生图、视频）：它只停本会话的子代理和它们留下的
  后台命令。
- 不改 D 草案原件，不动授权治理范围外的 change；D 草案已整目录撤销移至 `openspec/cancelled/`。

## 和 D 草案的异同

| D 草案的默认 | 本 change | 关系 |
| --- | --- | --- |
| D1 留一个开关（`agent.forge.dispatchEngine`），保留一版 | 不留开关，引擎整体删 | **偏离**：答复 4「删，按你倾向」 |
| D2 插件的 `task` 不再登记，代码留着 | 代码一起删 | **偏离**：同上 |
| D3 只留最小的子代理记录，向宿主查 | 同；不落盘——运行时工件只剩 models-dev 缓存、会话锚点账本、探针日志 | 吸收 |
| D4 `/forge stop`：终止命令 → 打断 → 回访 → 取消插件作业 | 同，去掉最后一步（没有插件作业了）；放进命令自己的执行体；非 forge 会话也能用 | 吸收，两处延伸 |
| D5 草稿期禁令让权限带拦原生 `subagent` | 改挂 `execute.before`；豁免收紧到「没有 shell 的只读工人」 | 吸收，两处偏离（见 D4、D7） |
| D6 工人不提问，写进代理文件，只在 v2 上加 | 同；v1 入口没了，不存在「只在 v2 上」 | 吸收 |
| v1 入口原样不动 | v1 入口删除 | **偏离**：答复 3 |
| 不给原生派发加派发门 | 派发门一并重做 | **偏离**：业主 11-25 选「一并重做」 |

## Decisions

### D1 执行面：内建 shell，插件零干预

**选择**：forge 一族只用宿主内建 shell。`V2_SHELL_DENY`、`v2WithShellDeny`、会话补救规则 `SESSION_RESCUE_RULE`
（`:9016`，它是给 `forge_shell` 通权用的）、封条及其分类器全部删除。

**理由**：答复 1。宿主已有超时、后台、通知、`workdir`。留一个精简版执行工具，双执行面的病就没治。
补救规则必须删：它给 forge 会话种了一条 `forge_shell: allow` 的会话规则，原生孩子会继承（〔沙箱〕三次取样）。

**备选**：保留只带 `workdir` 和 `cwd:` 披露的精简 `forge_shell`。否决。

### D2 工人的编译权限面

**选择**：`src/roster-compile.ts` 的 `toolsFaceFor`（:115–124）由 namespaced worker (:148) 和内建 override (:191) 共享，先分离策略，只给 namespaced forge 工人应用下表；general/explore 的原有独立 shape/model/prompt/permission 语义及 marker GC 保持，既有生成文件按独立投影核对，显式 sync/原 auto 才写；手写同名文件不改不删。——

| 形状 | 关掉 | 留着 |
| --- | --- | --- |
| 写（含没写 shape 的默认） | `subagent`（禁再派，配方不能解除）、`question`、15 个 harness 工具 | 其余全部，内建 shell 在内 |
| 只读（显式 `shape: "readonly"`） | 上面那些 + `write` / `edit` / patch 家族 + `execute`（代码模式） | 内建 shell、`grep`、`glob`、读类工具 |

- `question` 关掉是待确认 5：配方 `permission` 里显式写 `question` 可以放开，其余工具显式条目一律赢过形状默认；
  只有 `subagent` 的拒绝配方解除不了。README 写明「允许工人提问，它就会等一个后台孩子永远等不到的回答」。
- 15 个 harness 工具关掉是待确认 6：工人模型面里看不到它们，漏网的调用还有拦截带兜底（D6）。
- 只读面继续关 `execute`：`full_codemode` 打开时 shell 可以经代码模式调到，关掉代码模式才关得着这条路；
  这和「只读工人保留内建 shell」不矛盾——内建 `shell` 工具本身不再关（待确认 1）。
- `NATIVE_TOOL_VOCAB`（`:52–69`）改：`legacyShellKeys` 不再「对每个工人关」，只用来读配方（`shell` 和 `bash`
  两个键都读作 shell 动作）；加 `shell: "shell"`、`question: "question"`。
- `v2PermissionArray` 不再追加 shell 拒绝。

**要探针先验的**（探针 C）：`tools` 里写 harness 工具名和 `question: false`，宿主认不认；`task` / `subagent` 两个键
宿主怎么归一；只读面不关 shell 后工人实际拿到哪些工具；`full_codemode` 开和关两种。

### D3 派发：原生 `subagent` 唯一，引擎整体删除

**选择**：删 `task` 工具、派发段（`plugin.ts:3145–6090` 及零散辅助函数）、`src/dispatch-async.ts`、
`dispatch-gate.ts`、`dispatch-journal.ts`、`dispatch-retry.ts`。模型直接调原生 `subagent`；完成通知、重启续跑、
读子会话、续发消息全用宿主的。插件不再为派发引擎轮询、不补发宿主完成通知、不重试、不收养；crew 自身调度观察仍保留有界状态回查。

**保留下来的**：`src/dispatch-tiers.ts`（工人的定义来源）、`src/dispatch-prompt.ts`（纪律提示词）、
`src/dispatch-depth.ts`（深度词翻译）——名字里带 dispatch，但它们是「工人是什么」，不是「怎么派人」。
`dispatchProviderFamily`（:885）保留：:919–935 resolveDepthChannel 和 :9651–9665 v2 pin/深度注入仍在用。模型钉在代理文件里，钉不住的那部分走 `chat.params` 注入，都是现有能力，不动。

**残留配置**：forge.json 的 `dispatch` 节点、13 个 `FORGE_DISPATCH_*` 环境变量，忽略并各出一条有上限的提示
（待确认 14）。

**代价**：见 proposal「丢掉的保证」。

### D4 派发门挂 `execute.before`，不挂权限钩子

**选择**：forge 原来挂在自己 `task` 工具上的门，全部放进 v2 已有的 `execute.before` 拦截带里，在工具名为
`subagent` 的调用上判。

**理由**：

1. 拦截带拿到的是一次完整的调用：工具名、全部入参、会话号、代理名。派发门要按**目标**判（`input.agent` 是不是
   `forge-*`、属于哪个池、是不是只读形状），入参只有这里有。
2. 权限钩子只在工具自己调 `permission.assert` 时触发。原生 `subagent` 对哪个动作、带什么 metadata 调 assert，
   是宿主的事；按目标判的门把正确性押在这上面不稳。
3. 在这里拒绝，宿主不建孩子（〔沙箱〕权限带拒绝后不建子会话的可行性已验；`execute.before` 的同一保证〔未验〕，
   探针 D）。拒绝的文案就是模型看到的报错。

**拦截带里的次序**（一次调用从上往下，先命中先拒）：

1. 会话定位——从宿主的会话记录把这个会话绑到它自己的目录（`fix-unknown-session-anchor-seed` 的那条链；
   读不到记录就不猜，也不拿默认目录顶替）。
2. 草稿期写禁令：写类工具拒；`subagent` 调用交给 D7 按目标判。
3. 状态文件边界：往 `.opencode/plan/`、`.opencode/goal/` 等状态目录写，拒；读，放行。
4. harness 工具的分区拒绝（D6）。
5. `subagent` 且目标带 `forge-` 前缀：池归属门 → crew 暂停门 → crew 合规门。目标不是 `forge-*`：只有 crew 暂停门
   （它按会话判）。
6. 定位不了会话：放行并披露（现有的 fail-open 姿态）。

**暂停优先**：D11 的 goal 授权检查在新自主工作调用接纳及续跑投递前生效，不能被旧 in-memory 决策、fallback 或未知事件绕过。已接纳调用不承诺取消。

**`execute.after`**：保留执行账本——写类工具和 `plan_tick` 记写，`goal_check` 和内建 shell 记检查，每个获宿主接纳的 `subagent` 轮次记派发，重复 observation 不重复计。goal 的活动判定与写类工具词表分离，执行过检查不等于产生新信息；观察只读侦察、评审等活动及重复证据按 D11。

### D5 单一原生工具词表和漂移镜像测试

**选择**：`NATIVE_TOOL_VOCAB` 是唯一一份宿主工具名的表（`shell`、`subagent`、`question`、`grep`、`glob`），
`WRITE_TOOLS` 改成从它读：write、edit、patch 家族、`shell`、`subagent`。`isWriteTool` 里「名字含 patch 就算」的
匹配保留。漂移镜像测试加两项：宿主登记表里这五个名字都在；`WRITE_TOOLS` 含 `shell` 和 `subagent`。

**理由**：名单里没有 `subagent`，草稿期禁令就拦不住原生派发（〔沙箱〕实测：草稿期调原生 `subagent` 建出了子会话）；
没有 `shell`，草稿期写禁令和 goal / crew 的活跃度打分都漏掉内建 shell。`GATE_PERMISSION_KEYS`（`:2086`）去掉
`forge_shell`，剩六个确认门。

### D6 分区的切口

**选择**：

- 15 个 harness 工具（`plan_*`、`goal_*`、`crew_begin`、`crew_close`、`forge_sync`）仍只归 forge 主代理。工人那边
  写进编译权限面（D2）；非 forge 代理那边由拦截带拒绝，拒绝语写明入口是 forge 代理（待确认 3）。
- 派发不设限：门只看调用会话和目标，不看调用方是什么代理（待确认 4）。
- 工具分区不往任何不是自己的代理记录里写 tools/permissions；既有可配置 Tab picker 隐藏独立保留（记录可用不等于可见；默认仅 probe-confirmed ordering，显式用户配置优先），不注入 tools 映射，不压权限规则；v1 时代的 `NATIVE_PARTITION_FALLBACKS`
  兜底带（`:139`，只服务 v1 入口）随 v1 入口删除。非 forge 代理的保证就是「拒绝」本身。
- 内建 shell 和内建 `grep` / `glob` 对所有代理敞开。

**理由**：plan / goal / crew 是 forge 主代理的编排状态机，工人和别的代理直接写状态会绕开门和账本；而这三样
的入口（`/plan` `/goal` `/crew`，以及 `/forge sync/init/init global`）继续先按实际调用身份判定 forge 主代理，未知身份或非主代理先重定向，不从工具可见性推断；stop 是待确认 8 的例外。探针 J 验宿主命令执行能取得身份；若不行先改约定。goal 循环也不在非 forge 代理下续跑。
业主删的是「别的代理看不到 forge 工具」这半边，没说要放开编排本身。

命令注册保留用户同名配置的证据：v2.4.0 `promise/command.ts:19–26` 的 editor 只有 add，外层 domain list 并非重建中候选查询；`core/command.ts:62–83` 按同名 Map.set，`core/plugin/internal.ts:312–318` 将配置命令放在外部插件之后。独立宿主 command-collision-20261126 用两个惰性 marker 验证最终同名 description 为配置的值，另一插件命令保留；未执行命令，不等于探针 J 的身份验证。

### D7 草稿期的派发门按目标判

**选择**：会话有草稿时，原生 `subagent` 调用只在目标同时满足三条时放行：

1. 配方显式写了 `shape: "readonly"`（没写 shape 默认是写，不算）；
2. 配方的 `permission` 没有把 `write`、`edit` 或 patch 家族从 `deny` 上拿下来；
3. 配方显式关了 shell（`permission` 里 `shell` 或 `bash` 是 `deny`）。

其余一律按写类工具拒，拒绝语列出当前可派的名单（名单为空时指向「在 forge.json 里定义一个只读工人」）和出口
（`plan_approve` / discard）。带 `sessionID` 的续用调用，按它这次点名的代理判——宿主续用时会照着换代理。

第 3 条是这次新加严的：只读工人有了 shell，草稿期就不该再派它（待确认 2）。名单只列三条都满足、生成定义与配方一致且宿主实际权限面合格的工人。探针 D 必须到真实子会话运行和回报，不能把 before 放行当成功；正常宿主授权拒绝照旧。

**备选**：有 shell 的只读工人也放行。否决——草稿期能借工人跑命令，写禁令等于开了口子。

### D8 `/forge stop`

**选择**：在 `/forge` 命令自己的执行体里做，不等模型调工具（待确认 7、8）：

1. 按 `parentID` 走宿主会话列表只取候选；必须同时有归属本会话的亲缘链和宿主原生派发证据才纳入。未知跳过披露；探针 E 同父非目标作对照。
2. **先终止**这一家子留在宿主那边的后台命令：列出本会话目录下正在跑的命令，只留启动会话属于这一家子的
   （`metadata.sessionID`），逐条终止。别的会话的、用户自己在界面上敲的命令不碰。
3. **紧接着打断**每个孩子（插件接口的 `session.interrupt`）。
4. **回访**几轮、前后几秒钟：又被叫醒的孩子再打断一次，中途新出现的孩子须重新独立确认亲缘与原生派发证据才纳入。
5. 用 `session.prompt` 把回执投给会话。

回执逐个孩子说清楚：已请求打断、已确认终态、本来 idle（非成功）、已确认终止的命令及失败步骤，未知数量不猜。失败只会让停的范围变小，
不会被藏起来：通道不可用时照旧打断每个孩子，回执标明枚举不可用、剩余数量未知；已请求与有终态证据分列。任何枚举不可达、截断、超时或未知归属都不得扩大范围；仅对确认归属者发请求。宿主 interrupt 对其他作业的连带影响未验，探针 E 验并披露，不主动取消其他作业。不删子会话（它的记录是它做过什么的
账），不主动动用户排给本会话的消息，不碰家族以外的任何东西。没有孩子时如实回「没什么可停的」。宿主的其他类型
作业（代码模式脚本、生图、视频）不去碰（见 Non-Goals）：旧的 `/forge stop` 从来没管过它们，这次也不新加这份承诺。

**理由**（〔沙箱〕，D 草案探针 ④ 和 ⑧）：只终止命令不接着打断，孩子会被叫醒再答一轮，父会话收到「已完成」；
终止之后紧接着打断，孩子记为被打断，父会话收到「已取消」。只打断一个已经收工、名下还留着后台命令的孩子是
空操作，命令跑完孩子会「复活」。今天的 `/forge stop` 对原生子代理完全看不见。

**为什么放进命令的执行体**：命令的 `execute` 被宿主等完，里面可以直接做事再把回执投出去；靠模型调工具的话，
停不停得看模型配不配合。

**通道**：forge 已有的那条直连通道。它在真机上的现状，D 草案记的是「旧调用的注释里写着验证过，那天没有重新验」
——探针 E 顺带验。

### D9 `grep` / `glob` 同名覆盖

**选择**：在 `ctx.tool.transform` 里对内建的 `grep`、`glob` 各做一次 `editor.update`：

- 先 `editor.get(name)` 取内建定义当底。取不到（宿主没有这个工具）就披露、跳过。
- 参数：内建的每个参数原样保留，只做两处字段级改动——两个工具各加一个 `follow`（默认 `true`）；`glob` 的
  `hidden` 默认改成 `true`。描述相应更新。
- `execute`：先做内建工具原来那两道权限检查——搜索动作的权限（动作是工具名、资源是 pattern，带上会话号、代理名、
  消息号、调用号）和工作区外路径与实际外部链接目标的外部目录授权（目标读取前）——都通过插件接口的 `ctx.permission.assert`；然后才交给现有的
  搜索引擎（`search-core.ts`：有 ripgrep 走固定的参数向量，否则 `search-js.ts`），结果按内建的文本格式输出，
  外加 forge 原来就有的去重汇总行、外部目标披露和引擎脚注。
- 会话的工作区用插件已有的会话定位链解析。显式 `path` 或实际链接目标在工作区外：双引擎读目标前均取得原有 host 外部目录授权；无法确认或拒绝则不跟随、不读。无法保证等价则保持内建，不安装覆盖。
- `output` schema：保留并满足；尊重传入 limit 和宿主实际截断语义。若不能兼容先回修规格。
- 宿主拒绝这次更新：内建定义照旧，插件披露「搜索能力没装上」，不起别名。
- 插件卸载：宿主露出原来的内建定义。

**权限等价是硬条件**：内建环境可用性检查（`ToolSearch.available`，`core/src/tool/search.ts:9–12`）插件接口等价输入尚未证实。探针 F 验其与原授权上下文、顺序、拒绝/ask 的等价性；不能证实则不安装覆盖，先回修规格。不降低访问约束。两个引擎以实际 literal/regex、caseSensitive、limit（含显式非默认值）、include/path/hidden、输出和截断结果对比，不仅查参数表。

**理由**：答复 5。用 `update` 而不是同名 `add`，是为了以内建定义为底——参数、描述、输出契约都是宿主的，
插件只加两样。`follow` / `hidden` 的默认值是 forge 搜索工具原来的，原样搬过来，对所有代理生效（待确认 10）。

**备选**：同名 `add` 整体替换。否决——宿主一改内建参数就漂。

### D10 删 v1 入口

**选择**：删 `export const server`（`:7692–8772`）和只为它服务的代码（`NATIVE_PARTITION_FALLBACKS`、v1 的配置
钩子（先迁移仍有依赖的输入）、v1 的 `session_start` 钩子等）；`package.json` 删 `./server` 导出、`engines.opencode` 收成 `^2.0.0`、
description 改写（待确认 16）。`v2Setup` 用到的工具体和纯函数留在原处。

**停用决策（2026-11-26，业主恢复目标后明确选择）**：使用 v2 宿主原生插件启停，而不是迁移 `agent["forge"].disable` / `forgeDisabled` 私有开关。代理的 disable 只影响宿主代理定义，不代表插件停用。〔源码〕v2.4.0 的 `plugin/supervisor.ts`、`config/plugin/source.ts` 支持原生插件停用指令；`config/plugin/agent.ts` 独立加载 Markdown 并处理代理 disabled。〔未验〕具体启停配置及作用域、重启/恢复行为仍须探针 K 核实。宿主停用后不再执行 Forge setup、注册/注入、工具钩子、权限/派发门、续跑或搜索覆盖；宿主/用户自己的配置仍生效。删除 `forgeDisabled` 及仅服务该旧开关的判断（含 :7437–7444），不新增并行停用开关，不从代理缺失推断插件停用，不自造配置合并器。

**生成工件独立生命周期**：已落盘的 workspace/global worker Markdown（`forge-<ns>-<id>.md`、`forge-global-<id>.md`）及 global `general.md` / `explore.md` override 是宿主独立加载的代理文件，不由停用/恢复/卸载自动清理或隐藏；留在加载路径中的文件可能仍有效，但没有 Forge 运行时门及注入的保障。README 须给出用户显式管理方式：列出实际生效作用域与文件路径（含自定义 global config dir），备份后逐文件核对 `<!-- GENERATED BY forge_sync` 所有权 marker 及对应 worker/override 文件名，用户自行移出宿主扫描目录或删除确认的生成文件（可恢复备份或启用后按原显式 sync / auto opt-in 规则再生成）；无 marker、来源不明、手写同名文件原样保留，禁止通配或按前缀清理。显式 `default_agent`、用户代理定义等也由用户自行核对调整，不改主配置。单纯停用/卸载不删除 plan/goal/crew 历史与 forge.json。启用后原有兼容性检查和授权 sync 语义继续生效。

**先迁后删**：v1 config :7835–7844 的 setHostShell 仅在 v2 公开接口提供可证明的等价初始输入时迁移；否则按 goal-harness 已明确的现有平台链运行 plan/goal 共用校验。不得假定存在未证实的 HTTP 通道或自行合并宿主配置。〔v2.4.0 源码核对〕官方 `packages/plugin/src/promise/plugin.ts:27–60` 无 merged config domain，`promise/shell.ts` 的 create.before 只描述实际创建的 shell，不提供首个验证前的初始配置。goal-harness 已补充无初始输入的场景：按既有平台链执行校验，不宣称与用户配置的内建 shell 等价，不从其它会话事件推断，不自造配置合并器；业主随后明确不再要求追求自定义 shell 等价输入：当前公开 v2 接口按既有平台链履行合同，保留实际校验 runner 的退出码、cwd、超时、冻结检查验收，不再把不存在的初始配置输入当作实现前提。modelsDevCatalog 的 v1 snapshot 加载 :8025–8035 迁实际 v2 setup，保留 cache/null fallback；:927–938 深度选择实际消费；测试经 setup 加载本地 fixture，不用注入 catalog 代替。26 个走 v1 入口的测试文件及其他涉及删项的文件先逐个列行为断言，混合文件保留有效断言迁到 `v2Setup`，只删除退役行为；先迁移再删入口与模块。迁移用的
`v2Setup` 夹具，已有 17 个文件在用，不另起一套。

**理由**：答复 3，和「完全支持 v2、放弃 v1」的原则。v1 入口留着的唯一理由是回退，而这次删的东西 v1 入口里
也没有回退可言。

### D11 三个 harness 的改动边界

| | 代码上动什么 | 不动什么 |
| --- | --- | --- |
| plan | `PLAN_COMMAND_TEMPLATE`（`:171`）改写：侦察和派发走原生 `subagent`，写工具和内建 shell 草稿期禁用，可派的只有没有 shell 的只读工人；草稿门加 `subagent` 分支（D7）；`isWriteTool` 认内建 shell | 落盘格式、`plan_approve` 门、打勾、关闭自检 |
| goal | 校验命令本来就由插件自己跑（`src/run-check.ts` 的 `runChecks` → `src/proc.ts` 的 `shellSpawn`，不经作业系统），原样保留；解释器选择（`src/shell-select.ts`）原样保留，它的规格从 `job-supervisor` 搬进 `goal-harness`，由 plan 的冻结 checks 和 goal 的 check/complete 共同承接，文件头注释跟着改；活动检测区分真实工作、合法等待、明确无活动和可证重复无信息；暂停优先，Token 仅探针 | 五态、契约落盘、四个确认门、完成证据、空闲续跑、无进展暂停 |
| crew | `/crew` 纪律文本里的成波定义（一波 = 一起发出去的那几个原生调用，收齐再发下一波）；暂停门、合规门改挂拦截带；活跃度计数认 `subagent`；原生孩子在飞时压住续跑简报（`src/native-child-gate.ts`，现有能力） | `crew_begin` / `crew_close`、落盘记录、证据核对、空闲续跑 |

独立 crew 和 goal 治下 crew 共用在飞观察：以调用轮次（含续用 session）记账，同轮重复事件去重，idle/消失不是成功；未知结局披露。等待不发正常续跑、不推进波、不扣自动续跑 turn 或无进展/传输失败计数；原有 wall-clock 分钟硬上限照常计时（armed_at、重启、revision 不变），等待中耗尽照常暂停。状态不可读或到观察 ceiling 只发一次有界诊断，不授权下一波；只有全部轮次核实结算才恢复原 owner；部分、截断、未知枚举不是结算。close 关联 declared subtask、派发/续用轮次、fallback 和实证，子会话终态不等于子任务 PASS，失败尝试不冒充 PASS，保留一次重试与诚实 FAIL。goal 治下 crew 的 pause/预算耗尽/discard/complete 均不得自动降级 standalone；内存授权来源保留，重启 crew 照旧死亡，只用现有 goal 文件 status/session/revision/armed_at 等及明确用户授权确认，未知等待用户，不新增落盘格式/接口。宿主完成通知与 harness 调度观察是两条链，不重复完成通知。

**2026-11-26 业主明确批准的 goal 修订（只立约定，未验）**：

- 保留 queued / active / paused / completed / abandoned 五态，不引入 waiting 状态。`goal_pause` 使用现有原子落盘和 `stop_reason` 保存具体 blocker；暂停成功后撤销尚未接纳的续跑决策，在投递及新自主调用接纳点重新核对当前 status/session/revision 与授权，确保先暂停就不再接纳新工作；重复/迟到 idle、结果、重启不唤醒暂停 goal。宿主已接纳的调用可能继续完成，不承诺取消；goal 治下 crew 的 fallback 和同 session 续用也不能绕过。用户普通交谈不自动激活；原 resume、discard、complete 门及证据不变。预算耗尽的一次 handoff 只总结，不授予工作权，先发生的显式暂停优先。模型必须区分全局外部 blocker 与局部故障：尚有独立任务可做则继续，否则 call `goal_pause`，不以回复中某个词推断暂停。
- 合法等待：复用已有 native round 观察，探针 H 另验非 crew 子代理、后台 shell 与宿主等待权限/用户响应等可见事实。只用宿主可靠的关联与状态证据，事件缺失/截断/未知不猜，等待不产生模型空转，不扣轮次/停滞/传输失败，分钟硬上限不变；结算后在当前授权下只续一次。沿用有界诊断/回查，不重造通用进程监管。
- 轻量检测：保留账本中实际 tool execution 与 check log，另区分活动与信息增量。只在确定无活动的实际 goal work turns 上用现有连续两轮阈值；读/搜侦察与评审、有新证据的验证及失败定位、提交、非 git 工作区均不因缺写操作或 diff 判停。明确相同 check 输入（含作用域、revision）与可比较的完整结果（含状态/退出码与输出、文件契约结果）且无其它新活动时，才记录重复无信息并有界暂停；具体轻量边界/重复次数依 6.11 设计并验收，不将两轮无活动阈值机械用于不确定事件或重复检查。相同结果有新证据/真实活动就打断重复；截断/未知不冒充相同。只比较可确定的观测，不做 LLM verifier、语义评分、跨进程监控，也不承诺识别单个模型 turn 内全部循环。goal 活动判定不改变 plan 写禁令或 standalone crew 自身既有判定。
- Token 预算先做宿主能力探针 H，不实现预算：记录 host API/hook 可见的计量粒度、归属范围（父/子、续用轮次）、输入/输出/缓存/推理覆盖、迟到/缺失/重复/重启一致性及能否在调用前有效阻止超额；不能证明则明确不可用/未知。即使证据充分也仅记录，后续预算实现另立约定；不宣称 Token 硬限或以估算冒充准确计量。

**社区案例（2026-11-26 查阅 issue 原文；用户报告/请求，不是 Forge 或当前 v2.4.0 实测）**：

- https://github.com/anomalyco/opencode/issues/60860 — v2.2.5 的 `/goal` idle judge 未必看到插件侧后台工作；说明 idle 不等于无任务，等待应依实际 host 可见证据而非猜测。
- https://github.com/anomalyco/opencode/issues/45442 — 报告旧版本后台子代理 364 次相同 grep，约 50 分钟；说明重复调用不等于进展，但该例发生在子代理内部，不作为本次跨 turn 轻量检测覆盖单 turn 的承诺。
- https://github.com/anomalyco/opencode/issues/60278 — 报告外部使用者缺稳定机器可读计量与 turn 边界；说明先探针再考虑预算，不逆向数据库或另造计量运行时。

上述原因支持业主本次选择：真实暂停优先、宿主等待不空转、轻量防无进展及重复、避免误停，非新增运行时。

系统注入里和作业、执行通道有关的句子（作业指导、通道指令）删除。工人提示词（`src/dispatch-prompt.ts`）和
工人描述（`src/dispatch-tiers.ts`）按规格 `Worker prompts and descriptions name the native dispatch path` 改写：
不提 `task`、`forge_shell`、报告文件；写明自己是后台子代理、最后一条消息就是报告、不能向用户提问、长命令用
`background` 且不轮询不 sleep、提交用 `-m` / `--no-edit`。

### D12 残留配置和旧文件

`dispatch` 节点、`jobs.*`、`watchdog.*`、`FORGE_DISPATCH_*`：忽略，各出一条有上限的提示，不报错、不剥离用户的
文件。`<os-tmp>/opencode-forge/` 下旧的 `jobs`、`watchdog` 目录和派发日志：不读、不删——多一处删文件的逻辑
就多一处风险，README 升级说明里写一句可以手动删。

生成工件升级：同一配方、同时间戳的旧编译工件也按内容/编译契约判不兼容，crew/dispatch（含侦察）前拒绝不兼容投影；workspace pool 独占（含坏文件不退 global），host union 仅物化；workspace、global fallback 与独立 general/explore override 分别验显式 sync、有 auto opt-in、无授权不写。host materialization union 不是每会话独占 roster。探针 L 核热应用与真实权限面。升级前用户核对旧存活作业并决定等待或停止；旧临时文件不读不删，不保证回滚作业生命周期无损。

### D13 探针先行

开工第一件事是探针，都要起沙箱，按规矩先问业主。结果和这里的推断不符，回来改约定，不硬着头皮往下做。

| 探针 | 要回答的问题 | 决定什么 |
| --- | --- | --- |
| A | 内建 shell：孙进程握住输出管道时命令算不算结束、通知何时到；`git commit` 的编辑器和分页器行为 | 升级说明、工人提示词 |
| B | 原生 forge 工人在内建 shell 上会不会被跨锚点权限缺陷拒掉（`worker-shell-session-allow` 记的那个） | 只读工人保留 shell 是否真可用 |
| C | 代理文件的权限面：`question: false`、harness 工具名 `false`、`task` / `subagent` 键归一；只读面不关 shell 后的实际工具面；`full_codemode` 两种 | D2 |
| D | `execute.before` 拒绝原生 `subagent` 调用：孩子没建出来、文案原样到模型；build 代理派 forge 工人过门；续用调用按点名的代理判 | D4、D6、D7 |
| E | `/forge stop` 整套配方在插件里跑通（forge 工人、留着后台命令的 `general` 孩子、通道不可用三种，同父未原生派发/未知证据对照）；放进命令执行体后回执投递正常；直连通道在真机的现状 | D8 |
| F | 同名覆盖：宿主接受对内建的 `update`；`output` schema 保留时通过校验；用户的 grep 权限规则照常生效；工作区外路径及实际链接目标在双引擎读前授权，允许/拒绝/未知对照；卸载后复原 | D9 |
| G | ESC 打断父会话时原生子代理是不是继续跑 | 父会话被打断时的披露文案 |
| H | crew：一波里孩子的完成通知叫醒编排会话几次；部分结果是否压住续跑；goal 非 crew 的 native child、后台 shell、权限/用户响应可见等待及结算证据、重复/迟到事件；Token 仅记录宿主计量范围、粒度、可靠性及限制（D11） | crew 文案、goal 等待和续跑门；Token 不实现预算 |
| J | 命令执行身份来源与工具可见性解耦 | D6 |
| K | v2 原生插件停用/重启/恢复及实际作用域，多目录的注册表、钩子、续跑、搜索覆盖与独立生成/手写工件边界；v2 等价 merged config shell 输入及多目录、真实 setup catalog snapshot/cache/null fallback 与深度选择 | D10，实证前不删旧入口；shell 输入缺失先修规格 |
| L | 旧工件同时间戳、workspace/global 独占、override 生成/手写冲突、auto/显式 sync/无授权及热应用实际权限 | D12 |
| I | 配置里残留 `dispatch` / `jobs.*` / `watchdog.*` / `FORGE_DISPATCH_*` 时的加载行为 | D12 |

D 草案「还没验的」清单里和这次有关的几条并入：真实的上游超时或限流造成的异常结束父会话收不收得到通知；
同时停多个孩子时父会话被叫醒几轮。

### D14 规格写法：含义变了的要求用 REMOVED + ADDED

场景有删有换的要求，用旧名 REMOVED + 新名 ADDED，Reason / Migration 写明承接关系。主规格里不会留下
「名字叫 `forge_shell`、内容是内建 shell」的条款。整份退役的两份规格归档后删目录；7 份 Purpose 归档时直改
（待确认 18）。

## Risks / Trade-offs

- [孙进程握住输出管道，内建 shell 的调用迟迟不返回] → 探针 A。真有问题就在 README 写明用 `background: true`
  或把输出重定向到文件，并报给业主；不在插件里包一层。
- [非交互环境丢失：模型跑 `git commit` 弹编辑器] → 工人提示词加一句；探针 A 实测。
- [只读工人失去命令级封条，可以在 shell 里跑破坏性命令] → 待确认 1；`explore` 也一样。备选是不给 shell。
- [工人卡在提问上] → D2 的 `question` 关掉；探针 C 验编译面真的生效。
- [`execute.before` 的拒绝到不了模型，或者孩子已经被建出来] → 探针 D；不通就回来改约定。
- [权限面写了宿主不认的键] → 探针 C；不认的话退回「只靠拦截带拒绝」，并披露。
- [`/forge stop` 多依赖一样东西：直连通道] → 通道可用也仅按证据确认结果；不可用只请求打断确认归属的孩子并披露未知数量。
  宿主以后把作业接口暴露给插件接口，这条依赖就能去掉——要不要向宿主提请求是业主的授权域。
- [只终止、不接着打断，会报「已完成」] → 配方里两步连着做，之后回访。
- [通道不在时，带后台命令的孩子会「复活」] → 已知残缺口，回执里说。
- [没有并发上限：模型一次派出很多孩子] → 业主已接受；宿主的深度上限管着嵌套。
- [派发不再有日志和报告文件，事后不好查] → 宿主的会话记录里有父会话号、目录、结局；README 写明去哪看。
- [所有代理的 `grep` / `glob` 行为变了（多搜出东西）] → 待确认 10；可传参关掉。
- [26 个走 v1 入口的测试要迁，容易漏或迁错] → 先出逐文件表；迁完 `grep` 确认没有残留的 v1 入口调用。
- [goal 误把真实只读工作/等待当停滞，或把重复相同检查当进展] → D11 区分活动、信息增量、等待与未知；6.11 / 11.2 分别验证反例与暂停竞态，不以写类工具词表替代活动判断。
- [与其他会话在 `plugin.ts` 上冲突] → 开工前确认没有别的会话在动它；删除集中在一小段提交里完成。
- [归档顺序反了，把先归档的 change 冲掉] → 依赖写进 proposal 的 Depends on，顺序在 proposal 里写明；归档前核对主规格里那几条是否已是最新版本。
- [规格里还留着指向已删能力的句子] → 归档后对主规格全量扫一遍旧名字。

## Migration Plan

1. 业主已于 2026-11-26 批准四件套、A 组全部默认产品项及独立治理授权；全量校验未绿不进 apply。
2. 按 proposal 的治理记录：五个硬依赖已先归档，三份取消 change 的原件已移出活动集、不合入 delta；forge-commands 经授权仅修现行行为 delta 后归档，本 change 承接未实现的可靠身份守卫和 stop 例外。核对 strict、基线场景及 tasks 0.3 后进入探针。
3. 探针 A–L（业主同意后起沙箱）。
4. 按 tasks.md 实现；typecheck、全量单测、bundle、pack 全绿——这只是最低门槛。
5. 沙箱 E2E（③ GATE），到不了的腿按 D6 记账。
6. 发版 `0.35.0` + 官方安装终验（④ GATE，业主授权域）。
7. 对应收尾阶段按业主授权归档 → 清理两份空壳、7 份 Purpose 及残余旧 task 语义、更新 AGENTS.md 双 harness 描述 → 最终严格全量校验；已撤销的 D 草案不并入主规格、不改原件。

**回滚**：回退提交并按授权重装旧版；plan/goal/crew 格式不改，但工件需按目标版本授权同步，旧作业的生命周期、接续与终态不保证无损。

## 没采纳的做法（备查）

- **留回退开关 / 引擎代码留着不登记**（D 草案 D1、D2）：业主定了删。
- **保留自己的编排层，底下程序化调内建 `subagent`**（opencode-nexus）：能留着队列、依赖图、重试，但业主明确
  不要同步派发和排队。
- **插件级钩子拒绝一切后台孩子的提问**（opencode-workflows）：会盖过用户在代理配置里的显式选择。
- **提问超时兜底**：先不做；真机上出现「盖了印还挂着」再加。
- **停的时候把子会话整个删掉**：命令跟着没了，但子会话的记录也没了。要不要做成可选项由业主定，默认不做。
- **把 v2 入口改走 effect 接口**（那套接口的类型里有作业接口）：一次大得多的迁移，不该为 `/forge stop` 做。
- **`/forge stop` 走宿主的实验性作业接口，尽力取消代码模式脚本、生图、视频**：旧的 `/forge stop` 没管过这些，
  是新承诺，不在「能停掉 subagent」的范围里；规格评审也指出它没有任务承接。删。
- **派发门挂权限钩子**：见 D4。
- **同名 `add` 整体替换内建搜索工具**：见 D9。
- **只读工人不给 shell / 保留精简封条 / 保留精简 `forge_shell`**：见 D1、D2。
