## Purpose

管理 opencode 会话的单一通用 agent 身份：注册 forge、在插件存活期间运行时隐藏原生 build/plan、提供一键回原生的用户旋钮与卸载自愈，以此替代"多 agent 人格切换"的编排形态。

## ADDED Requirements

### Requirement: 注册单一 forge 通用 agent

插件加载后，系统 SHALL 在 opencode 中注册 id 为 `forge` 的 primary 通用 agent（完整读写执行工具面），作为 Tab 循环中的唯一主主体。用户不经任何规划流程直接下达的实现类任务，forge SHALL 直接承接执行。

#### Scenario: 官方安装后 forge 出现在 agent 列表

- **WHEN** 插件经 `opencode plugin` 官方安装模式安装并加载，用户执行 agent 列表查看
- **THEN** 列表中出现 `forge`，且其为 primary 属性的通用 agent

#### Scenario: 未经规划的直接任务由 forge 执行

- **WHEN** 用户在 forge 会话中直接下达一个实现类任务（未使用 `/plan`）
- **THEN** forge 直接执行该任务，全程无需切换到其他 agent

### Requirement: 插件存活期间隐藏原生 build/plan

插件加载期间，系统 SHALL 将原生 `build` 与 `plan` 两个 agent 置于禁用状态，Tab agent 循环 SHALL 不再提供二者。该隐藏 SHALL 以运行时配置注入方式实现（不写入用户配置文件）。

#### Scenario: Tab 循环只剩 forge

- **WHEN** 插件加载成功后用户循环切换 agent
- **THEN** 循环中仅有 `forge`，不出现原生 `build` 与 `plan`

#### Scenario: 隐藏不落盘

- **WHEN** 插件注入禁用后用户查看其 opencode 配置文件
- **THEN** 配置文件中不存在由插件写入的任何 agent 禁用条目

### Requirement: 一键回原生旋钮

用户配置 `agent["forge"].disable: true` 时，插件 SHALL 整体静默：不注册 forge agent、撤回对原生 build/plan 的隐藏注入、不注册 harness 工具、命令与 skill，系统回到原生形态。

#### Scenario: 设旋钮后恢复原生

- **WHEN** 用户在配置中设置 `agent["forge"].disable: true` 并重启 opencode
- **THEN** agent 列表中无 `forge`，原生 `build` 与 `plan` 恢复可用，无 harness 工具与命令注册

### Requirement: 卸载自愈

完成 README 记载的卸载步骤后，系统 SHALL 无插件残留：forge 消失、原生 build/plan 恢复。已生成的 `.opencode/plan/` 下的 plan 文件属于用户数据，卸载 SHALL NOT 删除。

#### Scenario: 卸载后恢复原生

- **WHEN** 用户按 README 四步卸载插件并重启 opencode
- **THEN** agent 列表恢复为原生 `build`/`plan`，无 `forge`

#### Scenario: 卸载保留 plan 数据

- **WHEN** 工作区存在历史 plan 文件且用户卸载插件
- **THEN** `.opencode/plan/` 目录及其文件保持原样

### Requirement: v2 前向兼容注册

在 v2 loader 下，插件 SHALL 经 `setup` 以"只创建不覆盖"方式注册 forge agent 与 skill（目标条目已存在即跳过，字段使用 v2 形状）；v2 侧 SHALL NOT 尝试注册工具、权限钩子或命令（v2 @1.18 无对应域能力）。宿主 API 形状漂移时注册 SHALL 静默跳过而非抛错。

#### Scenario: v2 下已存在同名条目不覆盖

- **WHEN** v2 loader 调用 `setup` 且 agent 草稿中已存在 `forge` 条目
- **THEN** 插件跳过创建，既有条目内容保持不变
