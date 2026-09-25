## Context

现有代码基线：plugin.ts（v1 `server` 全功能 + v2 `setup` 防御式；plan 五工具、draft 禁写 `tool.execute.before` 主执法、`context.ask()`+config ask 规则的门配方、`effectiveWorktree` 全局项目修正、system.transform notice）、`src/plan-file.ts` 纯函数核心、node:test、dist 自包含入库。工程约束沿用 `../opencode-plugin-dev-pitfalls.md` 与 add-plan-harness 的全部设计立场（单主体、硬约束在工具/权限层、文件账本、卸载自愈、英文文案）。

本 change 的 API 面已在 node_modules 1.18.32 类型中逐一确认存在：

- `session.idle` 事件（`EventSessionIdle { sessionID }`）——续跑触发器；
- `PluginInput.client`（`createOpencodeClient`）：`session.prompt({ path:{id}, body:{ parts:[{type:"text",text}] } })`、`session.get`、`session.status`——续跑通道与重启恢复；
- `experimental.session.compacting`（注入 context 数组）与 `experimental.compaction.autocontinue`（可关闭合成续跑）——压缩协同；
- 既有 `tool.execute.after`（活动标记）、`context.ask`、`config.permission`。

两个社区插件（@bybrawe/opencode-goal、prevalentware/opencode-goal-plugin）README 已通读，可取设计逐条评估见下表；行为契约见 specs/goal-harness delta。

### 社区插件借鉴清单（采纳 / 有意不采纳）

| 来源 | 设计 | 处置 |
|---|---|---|
| bybrawe | 契约 flag 面（--success/--constraint/--non-goal/--check/--max-turns/--max-minutes） | **采纳**：/goal 模板解析同款标记进结构化字段 |
| bybrawe | `--contains "file::text"` 文件契约（插件重读文件验证内容） | **采纳**：验证项第二类型，零 shell 成本的内容断言 |
| bybrawe | revision 隔离（编辑产生新 revision，旧证据不作数） | **采纳**：frontmatter revision + 证据全部带 revision 戳；完成门现场重跑天然满足，Check Log/Turn Ledger 同步盖章 |
| bybrawe | 逐轮 workspace 变更指纹（防「最后一口气批量完成」） | **降级采纳**：Turn Ledger 记录每轮活动（工具级观测），作为门上可见的审计面；硬性 cadence 强制（要求 N 轮各自变更）不做——fail-closed 现场重跑已封死假完成，指纹只补审计 |
| bybrawe | 完成审计流水线（shell→文件→语义→引用→时效，逐项证明） | **结构采纳、语义层缓**：shell + 文件契约现场重跑 + 逐条自证 + 用户门；LLM 语义 verifier 记 Open Questions |
| bybrawe | verifier 超时一次有界重试再暂停 | **不采纳**：本地命令无网络抖动语义，重试只掩盖真失败；超时即 fail |
| bybrawe | goal 队列（一个 live、其余排队惰性，/goal next 提升） | **采纳**：status `queued` + `/goal add` + `/goal next`（提升过武装门） |
| bybrawe | 暂停后仅显式短续跑语（continue/resume）经生命周期链恢复，任意聊天不复活 | **采纳**：notice 指引模型把显式续跑语路由到 `goal_resume` 过 ask 门；门本身就是「不静默复活」的保证 |
| bybrawe | 原子写 + 损坏 fail-closed | **采纳**：tmp+rename；解析失败报错不自愈（与 plan 同策略）。租约/CAS/世代锁不采纳（单 owner 模型用不上） |
| bybrawe | .opencode/goals/ + sequences/ + locks/ 三目录 | **不采纳**：单目录 + frontmatter 状态机（与 plan 同构），文件账本更干净 |
| bybrawe | token/cost 预算（默认关） | **暂缓**：跨重启记账不可靠；若将来加，沿用其「默认不设」姿态 |
| prevalentware | Plan-mode 安全边界（plan 相位内建的 goal 只能 paused；续跑不逃逸相位/不切 agent） | **语义采纳**：draft 期拒绝武装 + 续跑撞 draft 自停（draft-conflict）；续跑 prompt 不带 agent 覆盖（单主体 forge 本就无切换面） |
| prevalentware | 区分 budgetLimited/usageLimited/paused 停机原因 | **采纳**：stop_reason 分类（user/blocker/no-progress/budget-turns/budget-time/draft-conflict/transport-failures） |
| prevalentware | 预算耗尽发一次 wrap-up prompt（handoff） | **采纳**（原设计已有） |
| prevalentware | max_prompt_failures（续跑投递连续失败上限） | **采纳**：3 次连续失败 → transport-failures 自停 |
| prevalentware | no_progress 只计续跑轮 | **采纳**：活动标记仅挂在 goal 续跑轮上 |
| prevalentware | min_continue_interval 防抖 | **采纳**（原设计 2s） |
| prevalentware | TUI 侧栏（状态/耗时/token） | **不采纳**：与 plan 同立场，markdown 文件 + notice 即界面；记 Open Questions |
| prevalentware | 状态存 XDG_DATA_HOME 全局 JSON | **不采纳**：workspace 本地 `.opencode/goal/`（按项目隔离、可 git、可迁移，与 plan 一致） |
| prevalentware | busy-stuck 看门狗（单轮超时重试一次） | **暂缓**：Open Questions |
| prevalentware | /goal history/contract/audit/doctor 检视命令族 | **合并采纳**：无参 /goal 已列状态与预算；审计细节 = 模型读 Check Log/Turn Ledger（notice 指路），不另设命令 |

## Goals / Non-Goals

**Goals:**

- goal 是与 plan、OpenSpec 正交的第三种纪律：独立可用、自持验证、零语义耦合；用户在 plan 里、openspec change 里或裸干时都能套一层 goal 驱动。
- 完成判定 fail-closed：验证项由插件在宿主真实执行（shell + 文件契约），`goal_complete` 现场重跑 + 逐条成功标准自证，两层都过才见用户门。
- 自主性有边界：武装/提升/完成/恢复/放弃五个跃迁全部门控，双预算 + 无进展自停 + 投递失败自停 + 硬顶；续跑 prompt 以用户消息进 transcript（可审计）。

**Non-Goals:**

- 不做 goal↔plan 绑定（用户明示立场）：无绑定字段、无 plan 状态读取、plan done 不构成 goal 证据；「在 goal 里干 plan 的活」是模型层的约定行为，不是机制耦合。
- 不做独立 LLM verifier 会话（validator model）：宿主命令/文件契约验证确定性强、零成本；语义核验记 Open Questions。
- 不做 token/cost 预算：v1 用 turns + wall-clock；`chat.params` 钳制记后续。
- 不做 TUI 侧栏/看板（与 plan 同立场）。
- 不做多 live goal 并行：单会话单 live；多出的排队（queued）。
- 不做硬性 cadence 强制（逐轮变更指纹的强制版）：Turn Ledger 只做审计面。
- 不做 goal 专用 skill 文件（D9）。

## Decisions

### D1. 解耦边界：三条正交纪律，goal 只拥有「循环 + 验证」

工作流分三层：OpenSpec（跨会话、需多轮评审的决策管理）、plan（单任务决策契约：用户批准做什么怎么做）、goal（常设执行契约：驱动到宿主验证完成）。goal 对前两者零感知——完成证明完全自持（成功标准 + 验证项 + 自证），不读 plan/openspec 任何状态。唯一交集是安全：draft 禁写是权限层的环境事实，goal 撞上即自停（arm 拒绝 + draft-conflict 自停），这是「约束优先于自主」，不是语义耦合。此边界借鉴 bybrawe 对 native Todo 的处理（Todo 状态永远不是 goal 证据）与 prevalentware 的 plan-mode 安全层，套用到 forge 的 plan + openspec 全家。

备选「goal 可选绑定 plan（frontmatter plan: 字段 + 完成门硬校验 plan done）」被否（用户明示：三种工作流不该耦合；绑定会把 goal 变成 plan 的执行器，失去独立价值）。备选「goal 内嵌任务清单」被否：任务结构是 plan/openspec 的职责，goal 只需要成功标准与验证项。

### D2. 两层验证：机器现场重跑 + 结构化自证，都过才见用户门

- 验证项两类：shell 命令（child_process、cwd=worktree、shell:true、每命令默认 120s 超时可覆盖上限 600s、输出截断 ~2KB）与文件契约（`file::text`：插件在项目边界内重读文件、字面子串断言；路径逃逸与工作区外读取拒绝）。`goal_check` 与 `goal_complete` 同一执行器。
- `goal_complete` 忽略一切历史记录、自己重跑全部验证项（fail-closed：非零/超时/spawn 失败/文件缺失/文本缺失即报错附证据），并要求逐条成功标准的自证数组（✓/✗ + 证据，同 plan_close 纪律——把 plan 完成门的纪律搬进 goal，但不读 plan 文件）。两层全过才走到 ask 门。
- 备选「时间戳新鲜度门控」被否：需要工作区指纹（无 git 目录下昂贵且脆），现场重跑一步到位且更强。备选「只跑命令不要自证」被否：纯命令覆盖不到「目标本身的语义达成」（bybrawe 立场：检查只加证明义务，不替代目标语义）。

### D3. 续跑机制：session.idle → 防抖 → 空闲复核 → client.session.prompt

- 触发链：`event` 钩子收到 `session.idle` → 2s 防抖（prevalentware min_continue_interval 同款）→ `client.session.status` 复核仍 idle（防用户抢先把对话续上）→ 守卫链全过 → `client.session.prompt` 注入紧凑 brief（目标、成功标准、未决验证项、预算余量、指令集）。
- brief 以**用户消息**进入会话：transcript 天然留痕；不追求隐藏式系统注入（`system.transform` 只做常驻 notice，不驱动循环）。续跑不携带 agent 覆盖——单主体原则下没有切换面。
- 备选「chat.message 改写用户消息」被否（侵入真实输入）；备选「外层 Ralph 式 while 循环」被否（进程外方案，idle 驱动即可达同等效果且共享会话上下文）。

### D4. 单 live + 排队：状态机 queued → active ⇄ paused → completed/abandoned

- 单会话至多一个 live goal（再建报错，指路 edit/add/discard）；`/goal add` 造 queued 惰性契约（无 owner、无循环、免门）；`/goal next` 取工作区最老 queued 过武装门提升为 active 并换绑当前会话。goal 文件按创建序即队列序，不另设队列清单。
- 重启语义：磁盘为准；idle 处理器对未知 sessionID 走 `client.session.get` 惰性补种（directory → effectiveWorktree → 扫 `.opencode/goal/`）；`-c` 续会话保持原 sessionID 天然仍是 owner；`goal_resume` 是显式换绑动作（用户在哪续就归谁）。
- 备选「多 live goal 并行」被否：双循环在同一工作区互相踩写，预算与审计面全乱；要并行就开第二个会话（owner 判定天然支持每会话一个 live）。

### D5. 停机面：双预算 + 三类自停 + stop_reason 分类

- 预算：turns（默认 25、硬顶 200）+ wall-clock（默认 60 分钟、硬顶 480）；`turns_used` 每次续跑 +1 写回文件（磁盘记账，重启不丢账）。任一轨耗尽 → 自动 pause（budget-turns / budget-time）+ 注入一次 wrap-up 指令（handoff 总结），绝不静默续转。`goal_resume` 可带 `addTurns` 补充（受硬顶约束，且重新武装必过门——补预算不可能绕过用户）。
- 自停三源：预算耗尽、无进展（连续 2 轮零活动，仅计续跑轮）、投递失败（3 次连续 prompt 发送失败 → transport-failures）。每次暂停记 stop_reason（user/blocker/no-progress/budget-turns/budget-time/draft-conflict/transport-failures）。
- 备选「token 预算」暂缓（跨重启记账不可靠）；备选「只在内存记账」被否（重启即洗白）。

### D6. 门配方完全复用 plan 的 D5 结论

武装（goal_write arm 分支）、提升与恢复（goal_resume）、完成（goal_complete）、放弃（goal_discard）调 `context.ask()`，config 注入对应 permission key = `ask`（尊重用户显式 deny），`permission.ask` 带子钉 ask。继承已实测结论：插件工具绕过 permission 求值、`context.ask` 请求按 config 规则求值、run 模式 ask 一律 auto-reject（headless 无法静默武装/完成，TUI-first，README 声明）。`goal_pause` 不设门：暂停永远是安全方向。显式续跑语（"continue"/"resume"）由 notice 指引模型路由到 `goal_resume` 过门——门本身保证「任意聊天不复活」（bybrawe 同款语义，实现面更薄）。

### D7. 落盘与纯函数核心：原子写 + revision + 双 Ledger

`.opencode/goal/YYYY-MM-DD-<slug>.md`。所有变更走 tmp+rename 原子替换（goal 每轮续跑都写文件，崩溃暴露面远大于 plan；两社区插件同款立场）。frontmatter 状态机 + revision + stop_reason + session owner + 预算。Check Log（每次 goal_check/完成门结果，带 revision 戳）与 Turn Ledger（每续跑轮一行：轮号 + 是否有写/check 活动）只追加。解析/渲染/校验/状态迁移/预算判定/revision 递增/Log 变换进 `src/goal-file.ts`；执行器（shell/contains、超时、截断、路径边界）进 `src/run-check.ts`（runner 可注入，单测用 fake）。损坏文件 fail-closed 报错（与 plan 同策略）。断电最坏丢最后一条 Log（原子写保证状态机完整）。

### D8. 压缩协同：goal brief 进 compaction context，合成续跑关闭

- `experimental.session.compacting`：live goal 时 push 压缩上下文（目标/标准/预算/revision）；`experimental.compaction.autocontinue`：goal 会话置 `enabled=false`——压缩后只有 goal 引擎续跑，杜绝双发（两社区插件同款结论）。
- 两个钩子都是 experimental 域：结构化类型 + `typeof` 守卫，宿主形状漂移静默降级（压缩存活退化为 notice 兜底）。

### D9. 不新增 skill 文件：goal 纪律进 FORGE_PROMPT + 命令模板 + 续跑 brief

plan 需要独立 skill 是因为规划有「只读侦察→澄清→分层边界」这套按需加载的方法论；goal 的纪律很短且**总是随 brief/notice 在场**（继续、验证、过门、卡住即停带 blocker），放在 agent prompt 一段 + `/goal` 模板 + 每次续跑 brief 指令集已全覆盖。若后续 goal 纪律膨胀（多阶段验证策略、cadence 强制），再拆 `goal` skill 并重构 skill 目录为 `skills/{plan,goal}/`——记为 revisit 条件。

### D10. 与 draft 禁写的互操作：约束优先于自主，零语义耦合

武装时拒绝：arm 分支发现会话 active draft → 报错指路 plan_approve / /plan discard（自主执行不该顶着一面写禁令起跑，prevalentware plan-mode 安全层同款语义）。运行期抢占：续跑守卫链发现 draft → 自动 pause（draft-conflict）。禁写本身一行不改，goal 工具不读 plan 状态——「draft 存在」是会话级环境事实检查，不是 goal→plan 依赖。反向完全无感知：plan 体系不知道 goal 的存在（单向环境感知）。

### D11. 宿主执行边界

- 检查命令是用户/模型共同拟定的 shell 命令，权限面与模型自带 bash 完全等同（同用户身份），不做提权也不做额外收紧——goal 模式的增益在「完成判定不靠嘴」，不是新沙箱。`/goal` 模板要求呈报检查命令原文，武装门前用户可见可否（防永真式契约的第一道闸）。
- 文件契约限项目边界内读取（resolve 后必须落在 worktree 内，拒绝逃逸与工作区外路径）；shell 超时 kill 直属进程，Windows 下孙进程残留记为已知局限（Risks），v1 不做进程树追踪。

### D12. 无进展检测：活动标记仅挂续跑轮

`tool.execute.after` 对 owner 会话记录「本轮发生过写类工具 / goal_check」即清零计数；连续 2 轮续跑零活动 → 自动 pause（no-progress）。普通助手回复（非续跑轮）永不计入（prevalentware 同款边界）。每轮活动同时写 Turn Ledger，作为完成门上可见的审计面（bybrawe 防批量完成的可观测版）。备选「git diff 指纹」被否：非 git 工作区（本插件明确支持）无 diff 可取。

## Risks / Trade-offs

- [session.idle / client.session.prompt 契约随版本漂移] → 结构化类型守卫 + 守卫链任何一步异常即静默跳过本次续跑（宁停勿乱）+ 3 次连续投递失败自停（transport-failures）；FORGE_GOAL_PROBE 探针沿用 FORGE_PERM_PROBE 模式，冒烟固化 idle→续跑链路。
- [双发/重入：idle 抖动或 prompt 未落账又 idle] → 2s 防抖 + status 复核 + 「本会话续跑 in-flight」内存互斥；最坏多跑一轮，预算轨道封顶。
- [模型拟永真式契约（check 写 `true`）] → 契约原文在武装门前呈报给用户是第一道闸；Turn Ledger + Check Log 全程留痕可审计；不做命令语义分析（与 plan 期不做 bash 白名单同立场）。
- [模型擅自建 goal] → 武装 ask 门是第一道闸；误过门后 25 turns/60min 默认预算 + 无进展自停 + 硬顶封顶损害；续跑以用户消息留痕可事后审计。
- [Windows 进程树残留] → 超时 kill 直属进程，孙进程残留记已知局限；README 提示长驻服务型命令不适合做检查项。
- [run 模式（headless）] → ask 门 auto-reject 使武装/完成在 run 模式不可达，goal 实际只在交互会话生效；与 plan 门行为一致，README 明示。
- [goal 文件被手改坏] → 解析失败 fail-closed 报错指路（与 plan 同策略），不自愈改写。
- [experimental 压缩钩子转正/改名] → 守卫降级 + 每版本 --print-logs 冒烟（既有惯例）。
- [queued 积压无人提升] → 无害（惰性零成本）；无参 /goal 列出 queued 提醒用户。

## Migration Plan

- 版本 0.1.0 → 0.2.0，纯增量：新工具、新命令、新 ask 权限键、新 `.opencode/goal/` 目录；无 breaking（不用新功能即无感知，禁写与 plan 行为零改动）。
- 发布沿用 0.1.0 流程：bundle → test/typecheck → pack 校验 → `npm publish --access public`（2FA 用户侧）→ 实机 `--force` 升级 → 沙盒全链冒烟（武装门、排队/提升、续跑两轮、goal_check 两类验证项、完成门 fail-closed 与通过、pause/resume 显式续跑语、无进展自停、投递失败自停、draft 抢占、解耦边界回归：plan 行为逐字一致）。
- README 文件账本更新：包外写入点 = `.opencode/plan/` + `.opencode/goal/`（卸载不删，用户数据）。
- 回滚 = 降级 0.1.0（`opencode plugin @sorenllm/opencode-forge@0.1.0 --global --force`）；`.opencode/goal/` 留档不删。

## Open Questions

- token/cost 预算与 `chat.params` 钳制：等上游 token 记账 API 稳定再议（若加，默认不设——bybrawe 姿态）。
- 独立语义 verifier（validator model / 只读验证会话）：命令与文件契约覆盖不到的「文档类目标」可能需要；观察使用再立项。
- 硬性 cadence 强制（逐轮变更指纹的强制版）：Turn Ledger 审计先用起来，确有「批量假完成」逃逸案例再考虑。
- busy-stuck 看门狗（单轮超长占用）：暂缓。
- TUI 侧栏目标状态卡：与 plan 看板同批考虑。
- goal 专用 skill 拆分：见 D9 revisit 条件。
