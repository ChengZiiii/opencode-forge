## Why

opencode 原生 plan agent 是一个薄预设：去掉写工具再加一段提示词，plan 只存在于对话上下文中——不落盘、无结构保证、无完成度追踪、向实现阶段的交接完全依赖模型自觉。我们需要把 plan 变成磁盘上的一等公民：结构由工具校验、进度由打勾驱动、阶段切换由权限门把关，并以"单一通用 agent + 斜杠命令切阶段"（而非多 agent 人格切换）的现代编排形态交付。

## What Changes

- 新插件 `opencode-forge`：通过 v1 config hook 注册单一通用 agent **forge**（primary、全工具），并在运行时把原生 `build` / `plan` 两个 agent 置 `disable: true`（注入只存在于合并配置对象、不落盘，卸载插件即自愈恢复）。
- 新增 4 个 harness 工具（v1 tool hook，工具层保证而非提示词约束）：
  - `plan_write`：创建/修订 plan 文件，模板结构由工具校验（目标/非目标、上下文发现、方案与备选、编号任务 checkbox、风险、验收标准）；
  - `plan_tick <n>`：勾掉编号任务（校验任务存在且未勾，原子写入 + 完成时间戳注释）；
  - `plan_approve`：批准门，draft → approved；
  - `plan_close`：完成门，要求逐条验收自检（✓/✗ + 证据）后 approved → done。
- 权限硬禁（v1 permission.ask hook）：当前会话存在 active draft 期间，写类工具（edit/write/bash/patch 类）一律 deny；`plan_approve` / `plan_close` 钉死为 ask——TUI 的用户确认框本身就是批准/关闭动作，模型无法自行翻状态位。
- plan 文件落盘于工作区 `.opencode/plan/YYYY-MM-DD-<slug>.md`，frontmatter 维护状态机 `draft → approved → done`（含 `abandoned` 出口）。
- bundled SKILL.md 经 `config.skills.paths` 单通道分发（遵循避坑文档 §3，禁止镜像复制）：规划纪律（只读侦察、先澄清后规划）、与 OpenSpec 长流程的分层边界（预估跨会话/需多轮评审 → 建议 spec 流程）、resume 规则。
- 新命令：`/plan <目标>`（进入规划阶段）、`/plan resume`（恢复最近未完成 plan）、`/plan discard`（放弃当前 draft）。
- session_start 钩子：检测到未完成（非 done/abandoned）的 plan 时在会话开头提示。
- **BREAKING**（对本机使用者而言）：Tab 循环里不再出现原生 build/plan，只剩 forge——这是本插件的设计目标本身；卸载即恢复。

## Capabilities

### New Capabilities

- `forge-agent`: 单一通用 agent 身份管理——forge agent 的注册、原生 build/plan 的运行时隐藏与卸载自愈、v2 前向兼容注册（setup 只创建不覆盖）。
- `plan-harness`: plan 文件生命周期与阶段门——4 个 harness 工具的契约、draft 期禁写硬约束、打勾纪律与时间戳、批准/完成双权限门、`.opencode/plan/` 落盘布局、会话提示与恢复、bundled skill 的规划纪律与分层边界。

### Modified Capabilities

（无——新仓库，`openspec/specs/` 尚无存量能力。）

## Impact

- **本仓库（新建）**：`plugin.ts`（双入口：v1 `server` 全功能 + v2 `setup` 防御式）、`src/plan-file.ts` 等纯函数核心（无 @opencode-ai 依赖，可单测）、`tests/*.test.mjs`（node:test）、`SKILL.md`、`README.md`（含四步卸载说明与文件账本）、`AGENTS.md`。
- **宿主 opencode**：`engines.opencode: ^1.18.0`；用到 v1 hooks 的 config / tool / permission.ask / command / event(session_start) 域（v2 @1.18 无 tool 与 permission.ask，故这些只能走 v1，依据 `../opencode-plugin-dev-pitfalls.md` §2）。
- **用户工作区**：新增 `.opencode/plan/` 目录——插件在包外写入的唯一位置，README 文件账本必须覆盖。
- **打包红线**（依据避坑文档 §1/§8）：manifest 严禁七个 git 准备触发项，构建脚本名 `bundle`，dist 自包含且入库，发布走 npm registry 优先。
