# Design: fix-multi-location-session-anchor

> 用户已批准（2026-11-23「A+B我都批」，方案甲）。实现落地记录见 D7。

## D0 — 已证 / 未证

已证（代码 + 真机只读取证，证据见 proposal）：

- 多目录宿主按目录各初始化一次插件；
- 四处模块级状态每次初始化被重写（plugin.ts:9823-9831、:10069、
  :10074-10081、:10089）；
- `v2ToolContext` 三级回落到 `hostWorktree`（:8511-8513）；
- 后果：goal 契约落错目录、子代理 shell cwd 不存在、会话锚定来回切、
  派发 journal 落到主目录。

未证（实现前的探针）——**结论（2026-11-23/24 沙箱实证）**：

- 子代理错绑具体走哪一支：**`v2ToolContext` 第三级回落**。会话没有内存
  绑定（新建的孩子、宿主重启后的任何会话）时直接落到 `hostWorktree`
  ——多目录宿主上即最后初始化的目录。
- 插件手里的 `session.get` 在多目录宿主上**能**读到别的目录下会话的
  `location.directory`——「查宿主会话记录」这一级成立（A1–A2 单测 +
  沙箱多目录腿）。

## D6 — 版本

并入 0.33.0 之后的下一次发版（= 0.33.1）。

## D7 — 实现落地记录（2026-11-24）

- **建出即绑定（一条绑定，三种入口）**：`bindChildToDirectory(id, dir)`
  （空值 / 根目录值不绑；`ensureSession` 不让退化值覆盖已有绑定）。
  - 此处新建 → `createChildSessionBound(client, input)`：建完立刻绑到
    `parentDirectory`；五处新建调用全部改走它；
  - 收养 / 重新武装 → `registerDispatchTask`（七处登记）：按派发自己的
    目录绑。
  - 设计依据：`dispose` 不动派发行（`fix-dispatch-dispose-kill` D1）。
- **查宿主会话记录**：`hostSessionDirectory(anchorClient, sessionID)` 读
  `{worktree, directory | location.directory}`，沿 `parentID` 上溯，上限 8
  层、防环；取不到一律回落。
- **`v2ToolContext`** 改为 async，返回 `{ context, defaultDirectory }`；
  解析顺序：入参 / 别名 → 内存绑定 → **宿主会话记录** → 插件级默认
  （此时 `defaultDirectory` 非空）。工具注册包装器改用
  `v2AnchorClient(ctx)`；仅文本结果且真的回落时追加点名句
  （`V2_DEFAULT_DIRECTORY_NOTE`）。
- **测试面** `__sessionAnchorTestSurface`：`hostSessionDirectory` /
  `resolveToolContext` / `worktreeOf` / `bindChildToDirectory` /
  `sessionAnchorLedgerPath` / `noteLedgerBinding`。
- **测试**：`tests/session-anchor-resolution.test.mjs`，A1–A5 对应 D3 五行。
- **变异检查**（`mutate-batch.mjs`）：`a-1` 拆掉「查宿主会话记录」一级 →
  A1、A2 红（A5 也红——它断言的是没用到默认目录，属正当敏感）；`a-2`
  拆掉建出即绑定 → A4 红；`a-3` 拆掉点名句 → A3 红、A5 仍绿。全部被杀，
  还原后 SHA256 一致。
- **顺带加固**（同批，纯测试）：`tests/dispatch-journal.test.mjs` 第 8、9
  条原先是零余量写法（从 `create` 推断 `started`）；包装函数多一个微任务
  tick 后偶发红。改为等 `started` 落账 + 文件级收尾排空。

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

