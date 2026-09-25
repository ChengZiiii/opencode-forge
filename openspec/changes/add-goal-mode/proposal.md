## Why

forge 的 plan harness 解决了「怎么干」的决策问题（结构化落盘、批准门、打勾纪律），但「干到 verified 为止」仍然靠会话内人肉推动：一轮回复结束模型就停下等用户说 continue，完成与否取决于模型自称。对标 Claude Code `/goal` + validator、Codex goal mode 与社区插件（@bybrawe/opencode-goal 的 host-verified 语义、prevalentware 的空闲续跑与安全状态语义），opencode 官方没有对应能力（上游 PRD issue #27339 仍在跟踪）。用户定位是把 forge 做成高集成度工作台，goal 模式作为**与任何工作流正交的执行层**内置：不管用户在用 plan、OpenSpec 还是裸干，goal 都只回答一件事——把一个显式目标驱动到宿主可验证的完成。

**设计立场（用户明示）：goal 与 plan 不耦合。** 工作区里同时存在 openspec 工作流与 plan 工作流，goal 必须是独立可用的第三种纪律：goal 的完成证明完全自持（自己的成功标准 + 检查命令/文件契约），不读 plan 状态、不绑定 plan 文件、plan 的 done 不构成 goal 证据。唯一交集是安全边界：plan harness 的 draft 禁写是权限层事实，goal 续跑撞上它就自停（借用 prevalentware 的 Plan-mode safety 与 bybrawe 对 native Todo 的边界模式：「plan/openspec 状态永远不是 goal 证据，但安全约束永远优先于自主循环」）。

## What Changes

- 新增 6 个 harness 工具（v1 tool hook）：
  - `goal_write`：创建/修订 goal 契约（目标、编号成功标准、编号验证项、约束、非目标、预算），结构由工具校验渲染；`arm=true` 创建（`/goal <text>` 路径）**过 ask 武装门**，`arm=false` 创建为排队中的惰性契约（`/goal add` 路径，免门）；修订 = revision 递增（旧 revision 的证据不作数）；会话已有 live goal 时拒绝再建；draft 期拒绝武装；
  - `goal_check`：在宿主机上实际执行验证项（shell 命令 + `file::text` 文件契约两类），结果与时间戳追加进 Check Log（仅供参考，无门控效力）；
  - `goal_complete`：完成门。**现场重跑全部验证项**（fail-closed），并要求逐条成功标准的结构化自证（✓/✗ + 证据，同 plan_close 纪律）；全过后用户 ask 确认 → completed；
  - `goal_pause`：随时可停（免门），记录 stop_reason（user / blocker / no-progress / budget-turns / budget-time / draft-conflict / transport-failures）；
  - `goal_resume`：重新武装或把排队 goal 提升为 active（钉 ask 门），可选预算补充，owner 换绑当前会话；
  - `goal_discard`：放弃（钉 ask 门，终态留档）。
- 自主续跑引擎：`session.idle` → 防抖 → 空闲复核 → 守卫链 → `input.client.session.prompt()` 注入紧凑 brief；turns + wall-clock 双预算（默认 25 轮/60 分钟，硬顶 200/480），耗尽自动暂停并发一次 wrap-up handoff；**连续 3 次续跑投递失败 → 自动暂停**（借鉴 prevalentware max_prompt_failures）。
- 无进展自停：仅统计续跑轮（借鉴 prevalentware 的 no-progress 只计 continuation turns），连续 2 轮零活动（无写类工具/无 goal_check）→ 自动暂停；每轮活动记入 Turn Ledger（借鉴 bybrawe 的逐轮审计，防「一口气批量完成」的取证基础）。
- 压缩协同：`experimental.session.compacting` 注入 goal brief；`experimental.compaction.autocontinue` 在 goal 会话关闭合成续跑（单一续跑所有权，两插件同款结论）。
- goal 文件落盘 `.opencode/goal/YYYY-MM-DD-<slug>.md`，frontmatter 状态机 `queued → active ⇄ paused → completed / abandoned`（queued 为惰性排队，active/paused 为 live）；**原子写**（tmp+rename，借鉴两插件）；revision / stop_reason / session owner / 预算字段齐备。
- 暂停的显式恢复：短促明确的续跑语（"continue" / "resume"）经模型路由到 `goal_resume` 过门恢复（bybrawe 同款语义：任意聊天不复活 goal，只有显式意图过生命周期链）。
- 新命令 `/goal`：无参 = 状态列表；`pause` / `resume` / `discard`；`add <text>` 排队、`next` 提升；其余文本 = 新 goal（模板指引解析 `--success/--constraint/--non-goal/--check/--contains/--max-turns/--max-minutes` 契约标记，bybrawe 同款 flag 面）。
- 系统提示注入 `[forge:goal-notice]`（路径、状态、预算余量、下一步 + relay 规则），与 plan-notice 并存。
- 权限层：config 注入 `goal_write/goal_complete/goal_resume/goal_discard = ask`（尊重显式 deny）。
- FORGE_PROMPT 增补 goal 纪律段（不新增 skill 文件，理由见 design D9）。
- 版本 0.2.0，npm 发布（`@sorenllm/opencode-forge`，流程沿用 0.1.0）。

## Capabilities

### New Capabilities

- `goal-harness`：goal 契约生命周期与自主执行——6 个工具契约、武装/提升/完成/恢复/放弃门、宿主验证 fail-closed（shell + 文件契约现场重跑 + 逐条自证）、空闲续跑引擎与双预算、投递失败与无进展自停、stop_reason 分类、排队与提升、revision 隔离、原子写、压缩存活与单一续跑所有权、`/goal` 命令族、goal-notice、与 plan/openspec 的解耦边界（仅安全互操作）、`.opencode/goal/` 落盘布局。

### Modified Capabilities

（无——`openspec/specs/` 基线仍为空：add-plan-harness 尚未归档，其 delta 不在本 change 的基线内。本 change 全部为 ADDED Requirements；两 change 按序归档即可干净合并。）

## Impact

- **本仓库**：`plugin.ts`（6 个 goal_* 工具、idle 续跑引擎、压缩钩子、config 扩展、命令、notice）、新 `src/goal-file.ts`（解析/渲染/状态机/revision/预算/Log 变换/原子写，无 @opencode-ai 依赖）、新 `src/run-check.ts`（shell/contains 两类执行器，可注入 fake）、`tests/goal-file.test.mjs` + `tests/goal-mode.test.mjs`、README（goal 模式章节、文件账本加 `.opencode/goal/`）、AGENTS.md 架构表。
- **宿主 opencode API 面**（1.18.32 类型确认存在）：`event(session.idle)`、`PluginInput.client`（`session.prompt` / `session.get` / `session.status`）、`experimental.session.compacting`、`experimental.compaction.autocontinue`、既有 `tool.execute.before/after`、`context.ask`、`config.permission`。
- **用户工作区**：新增 `.opencode/goal/` 目录（包外写入点从 1 个变 2 个，README 文件账本更新）；续跑 prompt 以用户消息形式进入 transcript（可审计）；卸载不删 goal 状态目录（两社区插件同款立场）。
- **发布**：0.1.0 → 0.2.0，`npm publish --access public`，用户侧 `opencode plugin @sorenllm/opencode-forge --global --force` 升级。
