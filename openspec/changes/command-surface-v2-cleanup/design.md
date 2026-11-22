# Design: command-surface-v2-cleanup

## D0 — 调研加固状态

内部调研（C3 报告）已折入。外部调研（E2）印证：

- 单 `/forge` 命令+参数路由**匹配平台形态**：v2 插件命令收到原始
  prompt 自行解析参数（官方文档），`$ARGUMENTS` 只属 Markdown/JSON
  命令；命令管道跨客户端是反复出 bug 的类（#41339/#22255/#41245），
  一条命令处处被踩到比四条更容易活；同名静默替换的碰撞语义下，命令
  越少碰撞面越小。
- **会话作用域 stop 镜像 opencode 自家语义**：权限 reject 官方定义即
  "拒绝该会话内所有 pending 请求"；interrupt/remove 都是会话作用域
  API；**未找到任何先例**把"杀别家会话的在飞工作"当特性——只作为
  bug 类出现（#55678 等）。纯副作用命令（无 LLM prompt）是被社区要
  求的模式（#30268）——但 v2 命令面仍走 prompt 投递，stop 路由指示
  模型调 forge_jobs 是现契约下的正确形态。

无反例。D1-D5 维持。

## D1 — 删除面（两代宿主对称）

- v1：config 钩子 :6580-6602 四条 `??=` 注册块整体删除。
- v2：`addTemplateCommand` 四处调用（:8424-8443）删除。
- 模板常量 FORGE_SYNC/INIT/INIT_GLOBAL/CANCEL_LEVER_TEMPLATE 删除；
  `/forge` 路由表（FORGE_COMMAND_TEMPLATE :288-302）增 `stop` 路由 →
  STOP_LEVER_BODY（新常量：指示模型调用 forge_jobs {action:"stop"}，
  family guard 同款）；FORGE_HELP_ROUTE_LINE 列出四形态
  sync / init / init global / stop。
- no-clobber 契约不变：插件只创建 `/forge`，从不碰用户同名条目
  （删除=不再注册，非删除用户条目）。

## D2 — stop 语义：工具层作用域（不信模板层）

- `forge_jobs` 新 action `stop`：execute 内
  `inFlightAsyncDispatches(context.sessionID)`（:2870-2882 现成过滤器）
  → 逐个 `cancelDispatch`（串行——并发 abort 会与 idle 断言竞态，
  :2657-2659 既有注释）。
- **作用域判定只在工具 execute 层**（context.sessionID）：C3 报告
  caveat——v1 config 命令路径经模型转手 forge_jobs，模板层指示不可信；
  被派发 agent 伪造 action 参数也扩不大爆炸半径。
- `cancel` 动作删 `all` 分支（:2662-2671）；`cancelAllDispatches`
  （:3645-3653）删除；显式 task-id 单发 cancel 原样保留（跨会话逃生
  舱；`cancelDispatch` 无所有权检查是**有意的**显式意图语义，spec 写明）。
- stop 的取消 wake 措辞自动受益于 C1 的 aborted 诚实化（同轮发布）。

## D3 — 文案清单

中断披露 :3569（`/forge-cancel <task-id> or all` → `/forge stop` 与
per-id 逃生舱）、孤儿披露 :3998/:4002、forge_jobs 描述 :2595、
README :1024-1043、FORGE_HELP_ROUTE_LINE。账本 reason 串里
"cancelled by the user lever" 措辞通用，保留（测试正则同步改命令名）。

## D4 — 测试重议

| 现有 pin | 处置 |
| --- | --- |
| command-surface:71 专用杠杆（own guard/共享体/无 $ARGUMENTS） | 改：四名缺席断言（v1+v2）+ no-clobber 存续 |
| command-surface:116 v2 注册 hyphen 族 | 改：v2 命令集= forge/plan/goal/crew |
| forge-commands:54 help 三形态 | 改：四形态含 stop |
| v2-session-commands:249-262 精确键集 | 改：`[crew, forge, goal, plan]` |
| dispatch-cancel:229 cancel all（串行 count=2） | 改：双会话夹具——A 两行 + B 一行，stop(A) → A 消失、B 不动 |
| dispatch-cancel:250/315 reason 正则 `/forge-cancel` | 改 `/forge stop` |

新增：stop 空手（该会话无在飞→no-op 报告）；显式 id 跨会话 cancel 仍
可用（逃生舱钉住）。

## D5 — 沙箱 E2E（③ GATE）

双会话沙盒宿主：A 派发×2 + B 派发×1（慢孩子）→ A 会话走 `/forge
stop` → 判定：A 的两行 aborted 终结 + wake 诚实措辞（C1 判据）；B 的
孩子继续跑完、wake `Final report:` 携带原文；v2 `/api/command` 列表
无 hyphen 命令。有头 TUI 顺带验证命令列表与 `/forge stop` 可用（与
C2 有头测试同一会话窗口跑）。

## D6 — 版本

并入 0.33.0（与 C1/C2/C4 合并发版，一次重启完成全部验收）。
