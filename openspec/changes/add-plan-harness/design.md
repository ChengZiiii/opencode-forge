## Context

新仓库，无存量代码。工程约束全部来自两个上游事实源，设计不得违背：

1. `../opencode-plugin-dev-pitfalls.md`（opencode 1.18.32 实机验证）：v1/v2 双入口分工（v2 @1.18 无 tool / permission.ask / messages 域）、skill 单通道 `skills.paths`、七个打包触发器红线、官方安装模式为终验门槛、文件账本纪律。
2. 兄弟项目 `../opencode-vision-bridge/`：已验证的工程骨架（plugin.ts 双入口 + src/ 纯函数 + node:test + `bundle` 脚本 + dist 入库 + `engines.opencode`），本插件直接继承该骨架。

需求背景见 proposal.md「Why」。行为契约见 specs/ 下 `forge-agent` 与 `plan-harness` 两个 delta，本文不重述。

## Goals / Non-Goals

**Goals:**

- 单一 forge 通用主体 + 命令切阶段，plan 文件是唯一的状态载体与交接物。
- 阶段纪律的"硬"部分（禁写、批准、关闭）落在权限层与工具层，提示词只承担"软"引导。
- 与 vision-bridge 同级的工程质量：纯函数核心可单测、零触发脚本打包、卸载自愈。

**Non-Goals:**

- 不做 plan 的 TUI 侧栏/看板/图表渲染（复用 opencode 原生 markdown 渲染，plan 文件路径在会话中可见即可）。
- 不做长周期 spec 管理（那是 OpenSpec 的领地，本插件只做单向引导）。
- 不做多 plan 并行/依赖编排（单会话单 active plan）。
- 不做跨 agent 兼容（skill 专为 forge 服务，不发布为独立跨平台技能包）。

## Decisions

### D1. 双入口分工照抄 vision-bridge 模式

- v1 `server`：全功能——config hook（disable build/plan、注册 forge、push `skills.paths`）、tool hook（4 个 `plan_*` 工具）、`permission.ask`（禁写 + 钉门）、command hook（`/plan` 族）、`event.session.start`（未完成提示）。
- v2 `setup`：仅防御式注册 forge agent 与 skill（`?.` + typeof 守卫、只创建不覆盖、字段用 v2 形状 `system`）。不注册工具与权限——v2 无此域。
- 备选「纯 v2」被否：核心能力（工具、权限门）v2 @1.18 不存在，详见避坑文档 §2。

### D2. forge agent 经 config hook 以运行时注入注册，不走 markdown agent 文件

注入 `config.agent.forge = { prompt, description, mode: "primary", ... }`，与隐藏 build/plan 同一钩子内完成，保证"装即单主体、卸即自愈"，不向用户配置目录写任何文件。
备选「发布 `.opencode/agent/forge.md`」被否：文件安装模式会产生包外落盘与卸载残留，违反文件账本纪律；config 注入只存在于合并配置对象。

### D3. 阶段状态的事实源是 plan 文件 frontmatter，会话绑定在内存

- 磁盘：`status` 字段（draft/approved/done/abandoned）+ `updated` 时间戳，任何工具调用都读写它，崩溃后仍可 `/plan resume`。
- 内存：`Map<sessionID, planPath>` 记录"该会话的 active draft"，权限禁写与两门只对本会话生效。进程重启即失忆——禁写软降级（spec 已声明该行为），skill 纪律兜底。
- 备选「纯内存状态机」被否：崩溃即丢，resume 无从谈起；备选「纯磁盘轮询」被否：权限钩子每工具调用读文件，浪费且慢。

### D4. 禁写实现：`permission.ask` 钩子内按工具名单 deny

draft 期对 `edit` / `write` / `bash` / 补丁类工具直接返回 deny（含说明文字指引 `plan_approve` / discard 出口），读类与 `plan_*` 放行。此 deny 高于用户 config 的 allow——阶段纪律由插件定义，逃生门只有批准与放弃两条。
工具名字段按避坑文档 §4 的优先级链取（`metadata.tool` → `permission` → `id` → `type`），只影响 draft 期，不做全局改写。
备选「skill 软约束」被否：这正是原生 plan 模式"看模型自觉"的老问题；备选「注册一个只读临时 agent」被否：引入主体切换，违背单主体原则。

### D5. 批准/完成门 = 把 `plan_approve` / `plan_close` 钉死为 ask

`permission.ask` 对这两个工具：任何来源的 allow 都改写为 ask（用户显式 deny 保持 deny）。效果：TUI 必弹确认框，用户的"允许"就是批准/关闭动作——门不需要额外命令、不依赖模型诚实。
`plan_tick` / `plan_write` 不钉（draft 期本来就要频繁使用），普通权限即可。
备选「专门 `/plan approve` 命令」被否：多一次交互且模型仍需先停下；备选「模型自行翻状态」被否：不可审计。

### D6. plan 文件格式：frontmatter 状态机 + 固定章节 + 行内时间戳注释

```markdown
---
status: draft          # draft → approved → done；出口 abandoned
created: 2026-09-25T10:00:00+08:00
updated: 2026-09-25T10:05:00+08:00
goal: 修复登录超时
---
## 目标 / ## 非目标 / ## 上下文发现（file:line）/ ## 方案与备选 / ## 任务清单 / ## 风险 / ## 验收标准
```

任务行：`- [ ] 1. 描述…`；打勾后：`- [x] 1. 描述… <!-- ticked: ISO -->`。
解析/渲染/打勾/状态迁移全部放 `src/plan-file.ts` 纯函数（无 @opencode-ai 依赖），plugin.ts 只做钩子胶水——与 vision-bridge 的 `src/vision-http.ts` 同构，node:test 直接覆盖。

### D7. 命令族用 v1 command hook 注册，模板内嵌 skill 触发

`/plan <目标>` 的模板 = 阶段指令（侦察→澄清→落盘→停等批准）+ 引用 bundled skill。命令不路由 agent（当前主体就是 forge）。`/plan`（无参）用模板内 `!`ls .opencode/plan/`` shell 注入列出文件，进度由 `plan_status` 逻辑读取（同纯函数，命令模板 shell 注入仅列路径，状态细节交给 agent 读文件）。

### D8. 打包与分发完全沿用已验证清单

`scripts` 仅 `bundle` / `test` / `typecheck`（触发器黑名单外）；dist 自包含入库；`files` 白名单 = dist + SKILL.md + README.md；`engines.opencode: ^1.18.0`；`exports["."]` 与 `exports["./server"]` 双导出。发布 npm 优先。

## Risks / Trade-offs

- [权限钩子字段兼容性随版本漂移] → 沿用避坑文档 §4 优先级链 + 每版本 `--print-logs` 冒烟；钩子内任何字段缺失走保守放行（宁漏禁不误杀正常会话），漏禁由 skill 软纪律兜底。
- [draft 期 bash 全禁可能挡住"只读 shell 侦察"（如 `git log`）] → 有意为之：探索用内置 read/grep/glob；确需 shell 的场景先批准 plan（批准成本远低于误写成本）。若实践中证明太严，作为后续 change 放行只读命令白名单——不为本版引入 bash 语义分析的复杂度。
- [重启后 draft 悬挂、禁写失忆] → spec 已声明为软降级 + session_start 提示 + `/plan resume` 重绑；文件状态机保证磁盘事实不丢。
- [原生 experimental plan mode 未来转正造成双重机制] → forge 不启用 `OPENCODE_EXPERIMENTAL_PLAN_MODE`，README 注明互斥；若上游转正且能力重合，届时以 change 决定取弃。
- [禁写 deny 高于用户 allow，可能让高级用户不快] → 这是设计立场（阶段纪律不可绕过）；出口明确：`/plan discard`。README 写明。
- [v2 未来补齐 tool/permission 域导致双入口职责重叠] → 按 vision-bridge 既定路线：届时把工具/权限迁移进 `setup`，v1 `server` 保留至 v1 退役；AGENTS.md 记为架构演进项。

## Migration Plan

新插件首发，无迁移。回滚 = README 四步卸载（删 plugin 数组条目 → 删 store 目录 → 删 agent 配置块 → 确认 `.opencode/plan/` 保留与否由用户决定），build/plan 自动恢复。

## Open Questions

- plan 文件的中文章节标题是否需要支持英文标题（i18n）：不影响契约与结构校验（按章节序校验而非标题文案），实现期可定为中文标题 + 按位置/正则双匹配，后续再加语言包。
- slug 生成的具体截断长度（8~12 词）：实现期定，写进纯函数单测即可。
