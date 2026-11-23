# Proposal: fix-multi-location-session-anchor

> **草案，待用户批准。** 只读调查结论 + 拟议方案；未经批准不改代码。
> 过夜自主闭环 2026-11-23 发现（宿主 2.4.0）。

## Why

多目录宿主上，插件判断“这个会话属于哪个项目目录”时，靠的是**最后
初始化的那个目录**。

真机服务（pid 35748，2.4.0）同时加载四个目录：本工作区、
`C:\Users\Soren`、`C:\Users\Soren\Desktop\AgentWorkCommon`、
`F:\UNITY_Project\SorenUnityLabs`。v2 初始化按目录各跑一次，每次重写
模块级状态：

| 位置 | 每次初始化重写的东西 |
| --- | --- |
| plugin.ts:9823-9831 | `hostWorktree` = 本次初始化目录（非根时） |
| plugin.ts:10069 | `v2PermissionAssertFn`（权限确认） |
| plugin.ts:10074-10081 | `v2SessionRuleApi`（会话规则读写） |
| plugin.ts:10089 | `anchorClientShared`（读会话记录、解析锚定） |

:9819 的注释写着前提“每个宿主进程只进一次（only ONE entry ever runs
per host process）”——在多目录服务宿主上不成立（沙箱宿主日志：每个目录
启动各有一行 “loading plugin”）。

会话目录的解析（`v2ToolContext`，:8511-8513）是三级回落：

```
上下文自带目录 → 内存里的会话绑定 → hostWorktree
```

v2 的工具上下文不带目录；内存绑定在两种情况下是空的——**刚建出来的
子代理**、**宿主重启后的任何会话**。这时的第一笔 forge 调用就把会话
绑到最后初始化的目录。之后所有按这个绑定落盘或拼路径的东西都去错
地方：shell 的 cwd、`forge_shell` 的相对 workdir、plan / goal / crew
记录、派发 journal、池闸门。

### 真机实证（全部只读取证，2026-11-23）

1. **目标契约写进了 Unity 项目**：本工作区会话 `ses_e0ad3069…` 用
   `/goal add` 建的目标，文件落在
   `F:\UNITY_Project\SorenUnityLabs\.opencode\goal\2026-11-23-opencode-forge-在-opencode-v2-活宿主.md`
   （created 08:51:25Z）。
2. **子代理的 shell 全部启动失败**：worker 子会话 `ses_df69bff0…`
   （17:11Z 由上述会话创建）。宿主会话记录的 `location.directory`
   是本工作区——**宿主侧是对的**；插件的会话锚定台账却在
   17:11:40.728Z 把它绑到 Unity 目录。同一秒它的三笔 `forge_shell`
   的 cwd 成了 `F:\UNITY_Project\SorenUnityLabs\opencode-forge`，
   `spawn error: ENOENT`（j-20261123-171140-z0af81 / -xz02he /
   -0iwu0p）。
3. **本工作区会话自己的锚定在两个目录间来回切**：会话锚定台账四天里
   在本工作区与 Unity 目录之间切换约 20 次（只在变化时写）。
4. **派发 journal 也落错过目录**：2026-11-20 同一 owner 的一次派发记在
   `C:\Users\Soren\.opencode\forge\dispatch-log.jsonl`
   （`workspace: C:\Users\Soren`），两天后被重启恢复重新拉起、以模型
   不可用收场。

已证：多目录初始化 + 模块级重写（代码 + 宿主日志）；错绑的后果
（磁盘与台账）。

未证（实现前先坐实，见 design D0）：子代理错绑具体走的是哪一支
（时序与 `v2ToolContext` 第三级回落吻合：子会话建立后数秒，台账绑定
与三笔 forge_shell 同秒）。

## What Changes

- **会话目录按会话解析**，不再“最后初始化者胜”：
  1. 派发建出子会话的那一刻，就用 owner 已解析的目录登记孩子的绑定；
  2. 没有内存绑定的会话（新子代理、宿主重启后的会话）先查宿主的会话
     记录——会话自己的目录，取不到则沿 `parentID` 上溯——查到才绑；
  3. 只有宿主记录也给不出目录时才回落到插件级默认，并在工具结果里
     **点名**“本次按默认目录 X 执行”。
- 初始化时捕获的接口（权限确认、会话规则、锚定客户端）按目录保存，
  按会话解析出的目录选用，不再被后初始化的目录覆盖——**结构性修，
  建议另立 change**；本 change 只做上面三条最小修。

## Impact

- `plugin.ts`：`v2ToolContext`、`ensureSession` 的绑定入口、task 建孩子处。
- 行为：单目录宿主逐字节不变（初始化只跑一次，解析结果相同）；多目录
  宿主上会话的绑定目录由“错”变“对”。
- 风险：动的是所有 forge 工具的入口路径，需全量单测 + 多目录沙箱 E2E。
- 不迁移任何历史文件（design D4 列清单，交用户处置）。
- 版本：并入 0.33.0 之后的下一次发版。
