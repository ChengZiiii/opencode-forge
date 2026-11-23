# Design: fix-multi-location-session-anchor

> 草案，待用户批准。未证之处在 D0 明示，实现前先用探针坐实。

## D0 — 已证 / 未证

已证（代码 + 真机只读取证，证据见 proposal）：

- 多目录宿主按目录各初始化一次插件；
- 四处模块级状态每次初始化被重写（plugin.ts:9823-9831、:10069、
  :10074-10081、:10089）；
- `v2ToolContext` 三级回落到 `hostWorktree`（:8511-8513）；
- 后果：goal 契约落错目录、子代理 shell cwd 不存在、会话锚定来回切、
  派发 journal 落到主目录。

未证（实现前的探针）：

- 子代理错绑具体走哪一支：`v2ToolContext` 第三级回落，还是 task 建孩子
  时的锚定解析。时序与前者吻合。
- 插件手里的 `session.get` 在多目录宿主上能否读到别的目录下会话的
  `location.directory`——决定“查宿主会话记录”这一级能否成立。真机
  `GET /api/session/<id>` 能读到（只读探针已证）；插件内部客户端同
  待证。

## D1 — 方案

- **方案甲（最小修，本 change）**：
  1. task 建孩子成功后立刻登记 `孩子 → owner 的已解析目录`；
  2. `v2ToolContext` 在回落到 `hostWorktree` 之前加一级：查宿主会话记录
     （会话自己的目录，取不到则沿 `parentID` 上溯）；
  3. 真的什么都没有才回落，并在工具结果里点名默认目录。
- **方案乙（结构修，另立 change）**：初始化时捕获的接口按目录存进
  `Map<directory, Seams>`，按会话解析出的目录选用。
- **方案丙（不改代码）**：文档写明“多目录宿主下绑定不可靠”。不推荐
  ——用户的真机就是多目录。

## D2 — 兼容性

- 单目录宿主：初始化只跑一次，三级解析结果与现状相同。
- 多目录宿主：会话绑定目录可能变化——这是修正，不是回归。
- 不迁移、不删除任何历史文件。

## D3 — 测试

| 用例 | 断言 |
| --- | --- |
| 无内存绑定 + 宿主记录带目录 | 绑到记录里的目录，不碰 `hostWorktree` |
| 宿主记录只有 `parentID` | 沿 `parentID` 上溯到父会话的目录 |
| 宿主记录也给不出 | 回落 `hostWorktree`，且工具结果点名默认目录 |
| task 建孩子 | 孩子在创建时就带 owner 的目录 |
| 单目录初始化 | 行为逐字节不变 |

## D4 — 历史错位文件（不自动处理，列清单交用户）

- `F:\UNITY_Project\SorenUnityLabs\.opencode\goal\2026-11-23-opencode-forge-在-opencode-v2-活宿主.md`
  ——本工作区的目标契约，误落在 Unity 项目里；
- `C:\Users\Soren\.opencode\forge\dispatch-log.jsonl`——2026-11-20 的
  派发行，误落在用户主目录。

## D5 — 验证

1. 单测 + typecheck + 全量套件；变异检查（拆掉新的一级 → 新用例恰好
   变红，还原后 SHA256 一致）。
2. 多目录沙箱 E2E：ws 的 owner 派发子代理 → 初始化第三个目录（让
   最后初始化的目录 ≠ owner 目录）→ 子代理第一笔 `forge_shell` 的
   `cwd:` 在 ws 下；`goal_write` 落在 ws 的 `.opencode/goal/`。
3. 真机（用户重启后）：新派发一个子代理，会话锚定台账绑定到本工作区。

## D6 — 版本

并入 0.33.0 之后的下一次发版。
