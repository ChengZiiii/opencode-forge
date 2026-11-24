# Proposal: gate-native-subagent-dispatch

> **草案（2026-11-24），只写了 proposal，等你选方案。** 立稿时没动代码。
> 这是一个需要你定方向的行为改动：下面的甲 / 乙决定了规格 delta 怎么写，
> 所以 specs / design / tasks 三件等你一句话再补——不把没定的假设写进任务清单。
> 与 `fix-unknown-session-anchor-seed` 相互独立，谁先做都行。

## Why

插件整套派发控制建立在一个假设上：插件把派发实现注册成名为 `task` 的工具，
**在宿主范围内遮蔽原生的 task 工具**，所以模型每次派发都会落到插件手里。
规格原文（`forge-subagents`）：

> The plugin SHALL register its dispatch implementation under the tool name
> `task`, shadowing the native task tool host-wide …
> （场景）no `forge_dispatch` tool exists; `task` is the single dispatch surface

五道派发门全部写在这个名字上——拦截带里 `if (tool === "task")`：家族分区
（非 forge 代理不得派发 forge-* worker）、会话域池门、crew 待定拒绝、crew 合规；
外加草稿期的派发形状门（`task` 在写类清单里，目标不是只读 scout 就拒）。
规格对它们的要求分别写在 `tool-partition`（“a non-forge agent's attempt to
dispatch a forge-* subagent SHALL be refused at the tool layer … and no
subagent session SHALL be created”）、`plan-harness`（“every other `task` call …
SHALL be denied”）、`crew-harness`（PENDING 时拒绝任何 `task` 调用）。

**宿主 2.4.0 上这个假设不成立。** 原生派发工具在这一代宿主上叫 `subagent`，
名字不同，遮不到；插件的 `task` 只出现在代码模式的目录里（`tools.task`），
而原生 `subagent` 是模型直接可调的工具——模型伸手就能够到。

证据（沙箱，0.34.1 构建，宿主 2.4.0）：

| 观测 | 结果 |
| --- | --- |
| 插件钩子眼里的原生派发（探针，13:47Z） | `v2-before tool="subagent"`、`v2-evaluate name="subagent"`——不是 `task` |
| **arm7：`build` 会话用原生 `subagent` 派发 `forge-viewe2e-probe`** | **成功**。子会话 agent = `forge-viewe2e-probe`，父会话 = 发起者，已回答 |
| arm7 对照：同一会话改走 `tools.task` | 被拒：`[forge:partition] Dispatch refused: "forge-viewe2e-probe" is a forge-family worker and the current agent ("build") is outside the forge family…` |
| 原生派发在插件派发日志里的行数 | 0 |

也就是规格场景“A non-forge dispatch of a forge worker is refused”对插件的
`task` 成立、对原生 `subagent` 不成立。按同一条件判断（`tool === "task"`、
`isWriteTool("subagent")` 为假）、同样不被检查的还有：草稿期的派发形状门、
会话域池门、crew 待定、crew 合规——**这四项没有单独做拒绝实验**，是由探针
的工具名加代码条件推出来的。

真机上的实际情况，有三条彼此独立的证据：forge 会话的直接工具表里只有原生
`subagent`、没有 `task`（插件 `task` 只在代码模式目录里）；派发日志 11-24
一行都没有；09:59Z 那个 `general` 子会话创建时没有被绑定——插件自己创建的
子会话会在创建时绑定，所以那一次是原生派发。我没有逐条清点真机上今天一共
派发了多少、各走的哪条路。所以这不是理论问题——**此刻这五道门对 forge
会话的原生派发都不生效**。这是 v1 → v2 的对等缺口：按规格的描述，v1 宿主上
原生工具就叫 `task`、被插件遮蔽，没有这第二条路（v1 路径本次未实测）。

## What Changes

**两个方案共有的部分：**

拦截带把宿主自己的派发工具认作派发——工具名是 `task` **或** `subagent`，
目标取 `subagent_type`，没有则取 `agent`。五道门照常裁决。效果：

- 非 forge 会话的原生派发受分区带约束——规格场景恢复成立（arm7 的形状会被拒）。
- forge 会话的原生派发受池门、crew 待定、crew 合规、草稿期形状门约束。

**甲——只做到这里。** forge 会话仍然可以用原生 `subagent`，但这类派发不进
插件的派发引擎：没有派发日志、并发门、排队、唤醒通知，`/forge stop` 也不会
连带取消它们。

**乙——甲，再加上 forge 家族会话的唯一派发面。** forge 家族会话调用原生
`subagent` 被拒，文案指向代码模式的 `tools.task`。于是 forge 会话的派发全部
进引擎。代价：模型伸手去拿直接工具时会先吃一次拒绝再改道（可以在 forge
代理的提示里提前说明，减少这种来回）。

**我的建议是乙。** 规格原文就是“`task` 是唯一派发面”；并发门、排队、stop
连带取消、创建即绑定、重启后的收养——这些只对引擎里的派发生效，而它们管的
正是你 goal 里点名的“子代理失去连接或误判死亡”“crew 失败”。甲只把安全门
堵上，留着两套生命周期并存。

**不改：** 非 forge 会话的原生派发照旧可用（受分区带与草稿门约束）；
`tools.task` 自己的行为；crew 中途原生退出口的文案；v1 宿主（原生工具名就是
`task`，行为逐字节不变）。

## Capabilities

### New Capabilities

（无——乙也只是把既有需求延伸到第二个派发面，不引入新概念。）

### Modified Capabilities

- `tool-partition`：“Non-forge agents are isolated from forge tooling”的派发拒绝
  覆盖宿主自己的派发工具；“Session-scoped safety interop for active drafts”
  的形状门同理。
- `plan-harness`：“Hard write ban during draft”的派发门覆盖原生派发。
- `crew-harness`：PENDING 拒绝与合规带覆盖原生派发。
- `forge-subagents`（仅乙）：新增“forge 家族会话只经 `task` 派发”的需求；
  “遮蔽原生 task”的表述按 v2 宿主更正。

具体 delta 的写法取决于你选甲还是乙。

## Impact

- **代码**：v2 执行前接缝里派发分支的条件（工具名 + 目标解析）；（乙）一条
  针对 forge 家族会话的拒绝与文案；（乙）forge 代理提示里的一句。加单测、
  变异检查；arm7 的形状转成回归腿。
- **规格**：3–4 个 capability。
- **不影响**：v1 宿主、npm 依赖、配置项、文件账本格式、工具接口。
- **上线前的现状（请知悉）**：在本 change 落地前，上面五道门对真机上 forge
  会话的原生派发都不生效。
