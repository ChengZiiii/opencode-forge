## 1. goal 纯函数核心

- [x] 1.1 实现 `src/goal-file.ts`：frontmatter 解析/渲染（status: queued/active/paused/completed/abandoned、revision、stop_reason、session owner、max_turns/turns_used/max_minutes）、**原子写助手**（tmp+rename）、slug 与文件名生成（同日后缀）、章节结构校验（Goal / Success Criteria / Verification Checks[shell+contains] / Constraints / Non-Goals）、状态迁移（queued→active、active⇄paused、→completed/abandoned，非法迁移拒绝）、预算判定（turns/wall-clock）、revision 递增变换、Check Log 与 Turn Ledger 追加变换（均带 revision 戳、同轮重复追加幂等），验证：tests/goal-file.test.mjs 覆盖落盘布局、缺章节拒绝、迁移非法拒绝、预算耗尽判定、revision 递增与旧证据戳、双 Log 幂等追加、原子写（模拟 rename 前 tmp 残留不污染目标）
- [x] 1.2 实现 `src/run-check.ts`：两类执行器——shell（spawn + shell:true、cwd=worktree、每命令超时含覆盖上限 600s、输出合并截断 ~2KB、退出码/超时/spawn 失败三态）与文件契约（resolve 后必须落在 worktree 内、字面子串断言、文件缺失/文本缺失/路径逃逸三态），runner 可注入，验证：单测 fake runner 覆盖两类全部分支 + 截断 + 路径逃逸拒绝，真实 runner 冒烟 `echo ok` / `exit 1` / sleep 超时 / contains 命中与未命中各一例
- [x] 1.3 `node --test tests/*.test.mjs` 全绿、`bun run typecheck` 通过（src 两文件无 @opencode-ai 依赖，grep 确认）

## 2. goal_* 工具与门

- [x] 2.1 `goal_write`：创建（`arm:true` 过 ask 武装门、会话已有 live goal 拒绝并指路 edit/add/discard、draft 期拒绝武装；`arm:false` 造 queued 免门）与修订（revision 递增、不重过门）两分支，SessionState 扩展 goalPath，验证：单测武装/排队/修订/重复 live 拒绝/draft 拒绝五路径
- [x] 2.2 `goal_check`：执行验证项（或子集，两类）、Check Log 追加（revision 戳）、返回逐项结果与截断输出，验证：单测 + 沙盒实测 `true`/`false` 命令与 contains 命中/未命中各一例且 Log 落盘
- [x] 2.3 `goal_complete`：现场重跑全部验证项（fail-closed：shell 非零/超时/spawn 失败、contains 缺失/逃逸，任一即 PlanError 附输出）+ 逐条成功标准自证数组校验（当前 revision、逐条匹配、任一 ✗ 拒绝）+ context.ask 门 → completed + 终局 Log；全程不读 plan 状态（grep 断言 goal 工具路径无 plan-file 引用），验证：单测失败路径（伪 runner 非零 / 自证缺条）与门交互路径；沙盒实测失败续干 → 修复 → 过门全链
- [x] 2.4 `goal_pause`（免门，任意时刻可停，记 stop_reason）/ `goal_resume`（ask 门 + 可选 addTurns 受硬顶 + 提升 queued（`/goal next` 同工具路径）+ owner 换绑当前会话）/ `goal_discard`（ask 门，终态留档），验证：单测状态机与 stop_reason 全枚举 + 沙盒实测 pause 后 idle 不再续跑、resume 过门后续跑恢复、next 提升 queued 过门
- [x] 2.5 config hook 扩展：permission 注入 `goal_write/goal_complete/goal_resume/goal_discard = "ask"`（尊重显式 deny）；`permission.ask` 带子对四键钉 ask；forgeDisabled 旋钮下六工具与命令全部不注册，验证：沙盒 `opencode agent list` + 工具面正反两例

## 3. 续跑引擎与压缩协同

- [x] 3.1 idle 续跑：event 钩子处理 `session.idle`（2s 防抖 → client.session.status 复核 idle → 守卫链：goal active / event.sessionID == goal.session / 预算未尽 / in-flight 互斥）→ client.session.prompt 注入紧凑 brief（目标、标准、未决验证项、预算余量、指令集，不带 agent 覆盖）→ turns_used+1 与 Turn Ledger 原子写回，验证：FORGE_GOAL_PROBE 探针 + 沙盒双轮续跑观察 prompt 进 transcript、预算耗尽自动暂停并产出一次 wrap-up handoff
- [x] 3.2 未知 session 惰性补种：idle 时 session map 未命中 → client.session.get 取 directory → effectiveWorktree → 扫 `.opencode/goal/` 判 owner，验证：重启 opencode 后 `-c` 续会话仍能续跑（sessionID 保持），全新会话不续跑，queued 永不触发续跑
- [x] 3.3 无进展自停 + 投递失败自停：`tool.execute.after` 活动标记（写类工具/goal_check 清零计数，仅计续跑轮），连续 2 轮零活动 → 自动 pause（no-progress）；client.session.prompt 连续 3 次失败 → 自动 pause（transport-failures），验证：沙盒构造模型空转两轮观察自停；断开 server 模拟投递失败观察 3 次后自停
- [x] 3.4 压缩协同：`experimental.session.compacting` 注入 goal brief（守卫降级）、`experimental.compaction.autocontinue` 对 goal 会话置 false，验证：沙盒构造长会话压缩后 brief 在场、无双重续跑（探针日志只有一条 continue 来源）
- [x] 3.5 draft 抢占（安全互操作，非语义耦合）：arm 拒绝 + 续跑守卫链发现会话 active draft → 自动 pause（draft-conflict）+ notice，验证：沙盒 goal active 时 /plan 造 draft，观察 goal 自停且禁写行为与无 goal 时逐字一致；goal 工具全程无 plan 状态读取（grep 回归）

## 4. 命令、提示与 notice

- [x] 4.1 `/goal` 命令族注册（不覆盖用户同名命令）：无参列表（`!`ls .opencode/goal/`` 注入 + 状态/revision/预算呈报，含 queued）、pause/resume/discard（含 stop/cancel 别名）、add <text>（排队免门）、next（提升过门）、文本参数新 goal（模板指引解析 `--success/--constraint/--non-goal/--check/--contains/--max-turns/--max-minutes` 契约标记进结构化字段，检查项原文呈报），验证：沙盒实测六条路由 + flag 解析进结构化字段
- [x] 4.2 FORGE_PROMPT 增补 goal 纪律段（英文）：goal 与 plan/openspec 正交、武装即自主、brief 指令服从、goal_check 自证、goal_complete 过门、卡住即 pause 带 blocker、暂停时显式续跑语路由 goal_resume、预算与自停语义，验证：grep 无中文残留
- [x] 4.3 system.transform 增补 `[forge:goal-notice]`（路径、状态、stop_reason、turns_used/max、下一动作、relay 规则；paused 时附显式续跑语指引），与 plan-notice 并存互不覆盖，验证：单测双 notice 共存 + 沙盒新会话观察注入

## 5. 构建与验证梯度

- [x] 5.1 `bun run bundle` 产出自包含 dist（grep 无 external 残留、npm pack 白名单仍为 dist/SKILL.md/README.md）、typecheck、全量 node:test 通过
- [x] 5.2 中环验证：commit 后本地 `file://` 装载冒烟（沿用 add-plan-harness 6.2 流程），goal 全链：武装门 → 排队/提升 → 续跑两轮 → goal_check 两类验证项 → 完成门 fail-closed 与通过（含自证缺条拒绝）→ pause/resume 显式续跑语 → 无进展自停 → 投递失败自停 → draft 抢占 → 解耦回归（plan 五工具行为逐字一致）
- [x] 5.3 终验（合并前门槛）：npm 发布 0.2.0 后实机 `--force` 升级，重复 5.2 全链 + plan 回归（禁写/两门/tick 零行为变化）

## 6. 文档

- [x] 6.1 README：goal 模式章节（三工作流正交定位与解耦边界、/goal 用法与契约 flag、两类验证项、预算与自停语义、排队/提升、run 模式限制、卸载不删 goal 目录）、文件账本加 `.opencode/goal/`、卸载说明补 goal 目录处置、检查项安全边界说明（权限等同模型 bash、长驻服务型命令不适合、契约原文在武装门可见）
- [x] 6.2 AGENTS.md：架构表加 goal-file/run-check 与续跑引擎行、v1/v2 分工不变声明、开发循环补 goal 冒烟步骤
