# Proposal: command-surface-v2-cleanup

## Why

hyphen 命令族（forge-sync / forge-init / forge-init-global / forge-cancel）
是 v2 参数管道断裂时代的临时绷带（归档 change
`2026-11-22-v2-command-surface`：v2 命令域不做 `$ARGUMENTS` 替换，生产
事故 `/forge sync` 丢参数）。**同一发版里 `composeCommandPrompt` 已把根
因修掉**（v2 execute 读 `prompt.text` 组装，spec "Argument delivery on
v2 commands" 钉死，测试 command-surface.test.mjs:93-137 绿）——绷带失去
存在理由，只剩菜单拥挤。

`forge-cancel` 的 `all` 变体另有实质问题：`cancelAllDispatches`
（plugin.ts:3645-3653）**无会话过滤**，一次调用杀掉宿主上所有会话的在飞
派发——与本轮 dispose 连坐杀事故同一类跨会话连带风险。

用户裁决（2026-11-23）：删四条 hyphen 命令；forge-cancel → `forge
stop`——只停**当前会话**的在飞派发；砍 `all` 变体。

## What Changes

- 删除 `forge-sync` / `forge-init` / `forge-init-global` /
  `forge-cancel` 四条命令注册（v1 config 钩子 + v2 command 域 + 各自
  LEVER 模板）；`/forge` 单命令路由器为唯一 forge 命令面，路由表增
  `stop`，help 行同步。用户自有的同名条目照旧不 clobber 不删除。
- `forge_jobs` 增会话作用域 `stop` 动作：取消**调用会话**名下的全部在飞
  派发（逐个串行走既有 cancelDispatch 语义：abort 引擎 + aborted 终结
  + 账本 + wake）；**工具层强制作用域**（execute 里以 `context.sessionID`
  过滤，不信模板层——被派发的 agent 传什么参数都扩不大爆炸半径）。
- `cancel` 动作砍 `all` 变体（`cancelAllDispatches` 删除）；**显式
  task-id 的单发 cancel 保留**为跨会话逃生舱（显式 id = 显式意图）。
- 用户可见文案全面改写：中断披露（:3569）、孤儿披露（:3998/:4002）、
  forge_jobs 工具描述（:2595）、README 命令章节。
- 规范：`command-surface`（dedicated levers 需求删除，新增单命令面
  需求）、`forge-subagents`（取消杠杆语义改会话作用域 stop，无 all）。

## Impact

- 代码：plugin.ts 命令注册（v1 :6580-6602 / v2 :8424-8443）、
  FORGE_*_LEVER_TEMPLATE 常量、FORGE_COMMAND_TEMPLATE 路由表+help、
  forge_jobs cancel 分支、cancelAllDispatches、文案字符串。
- 测试重议：command-surface（:71 专用杠杆→缺席断言、:116/:155 v1+v2
  hyphen 族）、v2-session-commands（:249-262 命令键集合→
  `[crew, forge, goal, plan]`）、forge-commands（help 三形态→含 stop）、
  dispatch-cancel（:229 "cancel all"→双会话 stop 作用域夹具；:250 账本
  reason 正则）。
- 兼容：习惯 `/forge-sync` 的用户输入会落 help 引导（不是静默失败）；
  依赖 `all` 的旧习惯需改 stop（本会话）或逐 id（跨会话）。
