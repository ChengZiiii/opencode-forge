## Purpose

把单任务计划变成磁盘上的一等公民：plan 文件落盘与结构由工具校验保证、draft 期禁写与批准/完成双权限门把关阶段切换、编号任务打勾追踪完成度、会话级提示与恢复，形成"短期单任务版 spec 工作流"。

## ADDED Requirements

### Requirement: plan 文件落盘布局

plan 文件 SHALL 创建于工作区 `.opencode/plan/` 目录（插件在包外的唯一写入位置），文件名形如 `YYYY-MM-DD-<slug>.md`，slug 由任务目标派生（kebab-case，长度截断）。frontmatter SHALL 至少包含 `status`（取值 draft / approved / done / abandoned）、`created`、`updated`。同日 slug 冲突时 SHALL 追加数字后缀。

#### Scenario: 生成合规 plan 文件

- **WHEN** `plan_write` 以目标"修复登录超时"成功落盘
- **THEN** `.opencode/plan/` 下生成形如 `2026-09-25-fix-login-timeout.md` 的文件，frontmatter 含 `status: draft` 与时间戳字段

#### Scenario: 同日同 slug 冲突

- **WHEN** 同日已有同名 plan 文件且再次 `plan_write` 产生相同 slug
- **THEN** 新文件名追加 `-2` 后缀，不覆盖既有文件

### Requirement: 结构化模板校验

`plan_write` SHALL 校验写入内容并生成固定章节：目标、非目标、上下文发现（含 `file:line` 证据引用）、方案与备选（含被否方案及原因）、编号任务清单（`- [ ]` checkbox，全局唯一编号）、风险、验收标准。任一必备章节缺失或为空时，工具 SHALL 报错并拒绝落盘。

#### Scenario: 完整内容成功落盘

- **WHEN** 规划内容包含全部必备章节
- **THEN** 落盘成功，工具返回文件路径与任务数量

#### Scenario: 缺验收标准被拒

- **WHEN** 规划内容缺少验收标准章节
- **THEN** 工具报错指明缺失章节，不创建文件

### Requirement: draft 期写操作硬禁

当前会话存在 active draft（经 `/plan` 新建或 `/plan resume` 绑定且 status 为 draft）期间，权限钩子 SHALL 对写类工具（edit、write、bash 及其他变更类）无条件 deny，用户配置中的 allow SHALL NOT 放行；读类工具与 harness 工具（`plan_*`）SHALL 放行。`plan_approve` 批准或 discard 放弃后禁写 SHALL 即时解除。

#### Scenario: draft 期写文件被拒

- **WHEN** 会话存在 active draft 且模型调用 write/edit 类工具
- **THEN** 调用被权限层拒绝，拒绝信息指引先经 `plan_approve` 或放弃

#### Scenario: draft 期 bash 被拒

- **WHEN** 会话存在 active draft 且模型调用 bash
- **THEN** 调用被拒绝，理由同上

#### Scenario: 批准后禁写解除

- **WHEN** `plan_approve` 经用户确认执行成功后模型再次调用写类工具
- **THEN** 写操作按正常权限流程放行

#### Scenario: 进程重启后软降级

- **WHEN** opencode 进程重启且磁盘上仍存在 status 为 draft 的 plan
- **THEN** 权限禁写不再自动生效（会话绑定状态已丢失），skill 纪律仍引导先批准或恢复；session_start 提示该未完成 plan

### Requirement: 批准门权限确认

`plan_approve` SHALL 将 active plan 的 status 由 draft 迁移到 approved；该工具调用 SHALL 被钉死为 ask 级确认（不自动放行、不受用户 allow 配置豁免），用户的确认框操作即批准动作。status 非 draft 时调用 SHALL 报错。

#### Scenario: 用户确认后进入执行

- **WHEN** 模型呈报 plan 要点后调用 `plan_approve` 且用户在确认框选择允许
- **THEN** status 变为 approved，draft 期禁写解除

#### Scenario: 重复批准被拒

- **WHEN** status 已为 approved 时模型调用 `plan_approve`
- **THEN** 工具报错说明当前状态不可批准

### Requirement: 编号任务打勾

`plan_tick` 接收任务编号 n，SHALL 校验该编号任务存在且未勾选，然后原子地置为 `- [x]` 并在同一行追加完成时间戳的 HTML 注释；编号不存在或已勾选时 SHALL 报错且不修改文件。bundled skill SHALL 规定每个编号任务完成后立即打勾，禁止批量事后补勾。

#### Scenario: 勾掉已完成任务

- **WHEN** 任务 3 已实际完成且未勾选，模型调用 `plan_tick(3)`
- **THEN** 文件中任务 3 变为勾选态并追加完成时间戳注释，工具返回剩余未勾数

#### Scenario: 勾不存在的编号被拒

- **WHEN** plan 中不存在编号 7 的任务，模型调用 `plan_tick(7)`
- **THEN** 工具报错，文件无任何改动

#### Scenario: 重复打勾被拒

- **WHEN** 任务 2 已处于勾选态，模型再次调用 `plan_tick(2)`
- **THEN** 工具报错且文件不变

### Requirement: 完成门验收自检

`plan_close` SHALL 仅在全部编号任务已勾选且调用参数携带逐条验收自检（每条验收标准给出 ✓/✗ 及证据引用）时，将 status 由 approved 迁移到 done；存在未勾任务或自检含 ✗ 项时 SHALL 报错拒绝。该工具调用 SHALL 被钉死为 ask 级确认。

#### Scenario: 全勾全过后关闭

- **WHEN** 全部任务已勾、自检每条验收标准均为 ✓ 且附证据，用户确认 `plan_close`
- **THEN** status 变为 done，工具返回最终摘要

#### Scenario: 存在未勾任务被拒

- **WHEN** 尚有任务未勾选时模型调用 `plan_close`
- **THEN** 工具报错并列出未勾任务编号

#### Scenario: 验收不通过被拒

- **WHEN** 自检中某条验收标准为 ✗
- **THEN** 工具报错拒绝关闭，指引修正实现或先修订 plan

### Requirement: 放弃出口

`/plan discard` SHALL 将当前会话绑定的 active draft 置为 abandoned 并解除禁写；终态（done/abandoned）plan 文件 SHALL 保留在 `.opencode/plan/` 作为历史记录。

#### Scenario: 放弃后恢复自由

- **WHEN** 用户执行 `/plan discard`
- **THEN** 该 plan 的 status 变为 abandoned，写操作恢复正常

### Requirement: 阶段命令不切主体

插件 SHALL 注册 `/plan <目标>`、`/plan resume`、`/plan discard` 命令：`/plan` 进入规划纪律（只读侦察 → 澄清 → `plan_write` → 呈批等待 `plan_approve`），`/plan resume` 绑定最近一个非终态 plan 继续执行，无参数的 `/plan` SHALL 列出非终态 plan 及进度。命令 SHALL NOT 触发 agent 切换（单主体原则）。

#### Scenario: 进入规划阶段

- **WHEN** 用户执行 `/plan 修复登录超时`
- **THEN** forge 在当前会话进入规划纪律，最终产出落盘 plan 并等待批准，期间未发生 agent 切换

#### Scenario: 恢复未完成 plan

- **WHEN** 存在 status 为 approved 的半程 plan 且用户执行 `/plan resume`
- **THEN** 会话绑定该 plan，从剩余任务继续

#### Scenario: 列出进行中 plan

- **WHEN** 用户执行无参数 `/plan`
- **THEN** 列出所有非终态 plan 的路径、状态与勾选进度

### Requirement: 会话启动提示

session_start 钩子 SHALL 检测工作区非终态 plan，存在时在会话开头以一条提示给出路径与勾选进度，供用户决定是否 resume。

#### Scenario: 存在未完成 plan 时提示

- **WHEN** `.opencode/plan/` 下存在 status 为 approved 的 plan（3/7 已勾）且用户开启新会话
- **THEN** 会话开头出现提示：该 plan 路径与 `3/7` 进度

### Requirement: bundled skill 单通道分发与规划纪律

SKILL.md SHALL 经 `config.skills.paths` 指向包目录的方式被 opencode 发现（SHALL NOT 复制到用户配置目录），内容 SHALL 覆盖：规划纪律（先只读侦察与澄清问题再落盘、呈批后执行）、完成即打勾纪律、以及分层边界——预估跨会话、多文件长期改动或需多轮需求评审的任务，SHALL 建议转用 OpenSpec spec 工作流而非 plan。

#### Scenario: skill 单通道被发现

- **WHEN** 插件经官方安装模式安装后查看 skill 发现来源
- **THEN** SKILL.md 由包目录经 skills.paths 扫描发现，用户配置目录无镜像副本

#### Scenario: 长任务被引导至 spec 流程

- **WHEN** 用户以 `/plan` 提交一个预估跨多个会话的大型改造任务
- **THEN** forge 依据 skill 的分层边界向用户说明该任务更适合 OpenSpec spec 工作流，由用户决定是否继续 plan
