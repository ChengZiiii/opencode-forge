# Design: fix-ask-door-multi-directory-host

> 2026-11-24 实施前重写：对照 opencode v2.4.0 源码把机制逐条坐实之后，
> 修法从草案的“按会话目录查表选接口 + 失效后换接口重试”改成“工具用
> 注册它的那次初始化的接口”。目标与失败关闭的要求不变；改动更小，也
> 去掉了草案里一个危险的分支（D3）。用户可否决。

## D1 机制（已坐实：opencode v2.4.0 源码，路径均在 `packages/` 下）

宿主侧：

- **一个目录一个实例。** 每个目录（Location）是一份独立编译的服务图
  （`core/src/instance.ts` L155–167；`Tool.node`、`Permission.node`、
  `Plugin.node` 都在图里，L81/L99/L100）。插件宿主每个实例各跑一份
  `PluginHost.make`（`core/src/plugin.ts` L79），所以
  **`ctx.permission.assert` 是“这一次初始化所属实例”的接口**
  （`core/src/plugin/host.ts` L458–466）。
- **一个会话的工具调用只跑它自己目录那份插件注册的闭包。** 会话路由经
  `instances.provide(session)` 落到会话自己目录的实例
  （`core/src/location-services.ts` L116 `map.get(session.location)`），
  工具注册表是实例的（`Tool.node`）。
- **待答请求登记在本实例的表里。** `assert` 把请求登进本实例的
  `pending` 并发 `permission.asked`；`forSession`/`list` 只读本实例
  （`core/src/permission.ts` 的 `assert`/`create`/`close`）。
- **会话存储与 KV 是全局的。** 会话服务在服务端 handler 组里不带位置
  上下文直接取用（`server/src/handlers/permission.ts` L20），
  `SessionStore.node` 是 `makeGlobalNode`（`core/src/session/store.ts`）；
  `KV.node` 是 `makeGlobalNode`（`core/src/kv.ts` L92）。
- **收回 = 关闭该实例，两条路是同一个调用。** 空闲清扫
  （`core/src/location-activity.ts`：默认 60 分钟 L30、每分钟一次 L79；
  有执行在跑或被终端占用的目录跳过 L93–109）在 L115 调
  `locations.invalidate(ref)`；调试路由 `DELETE /api/debug/location`
  调的是同一个函数（`server/src/handlers/debug.ts` L47–55）。`invalidate`
  先断路由再跑 `LocationLifecycle.shutdown`
  （`core/src/location-services.ts` L77–110），shutdown 里
  `permission.close`（`core/src/location-lifecycle.ts` L63）把该实例所有
  待答请求按 `DeclinedError` 结束；此后该实例上的 `assert` 一进来就
  `Effect.die(new DeclinedError())`（`core/src/permission.ts`）。
- **“用户拒绝”和“实例已关闭”是同一个错误类型**（`DeclinedError`），形状
  与文字都不带原因——插件无法区分。
- **终端按会话找待答请求。** 会话路由用会话自己实例的表
  （`server/src/handlers/permission.ts` L60–67）；请求带
  `location[directory]` 或 `x-opencode-directory` 时改用那个目录的实例
  （`server/src/location.ts` L57–65，终端带的是自己目录）。确认框组件
  用“请求所属会话 + 请求号”回复（`tui/src/routes/session/permission.tsx`
  L138）——请求在别的目录的表里，这条回复路由就找不到它。
  终端**如何得知有新请求**：有头实测（2026-11-24，0.34.0 构建，ws 会话、
  另一目录在它之后初始化）——终端**看得到确认框**。新请求是宿主事件
  （`permission.asked`）送到终端的，不经过那张按目录隔开的表，所以框
  照常弹出；点 “Allow once” 后回复路由返回 404（宿主日志
  `POST /api/session/<会话>/permission/<请求号>/reply http.status=404`），
  框随即消失（客户端按已答处理），请求仍留在另一目录的表里，门继续等。
  同一时刻按会话轮询列取路由的看门脚本（`tui-askwatch.mjs`）整轮
  没有看到过这条请求。

插件侧：

- 插件模块在一个宿主进程里只求值一次，`v2Setup` 每个目录各跑一次，
  模块级变量被“最后那次初始化”覆盖。
- 修复前：`v2PermissionAssertFn`（模块级）只被 `v2ToolContext` 的 ask
  适配器读，而六道门和 `forge_shell` 的 ask 全经这个适配器 →
  **每个目录的门都登记到最后初始化那个目录的待答表里**。
- 后果一：会话自己实例的表里没有这条请求 → 终端的确认框弹得出、答不上
  （回复 404，框消失）；门一直等到 300 秒看门狗按“无人应答”拒绝
  （`gate()`）。实测整轮 5 分 24 秒，crew 仍在（D1 末条、D7）。
- 后果二：最后初始化的目录被收回 → 那份接口进门即死 → 所有目录的门与
  `forge_shell` 立刻失败。

## D2 修法：工具用“注册它的那次初始化”的接口

`v2Setup` 注册工具时，把**这次初始化**的 `ctx.permission.assert` 作为
第三个参数交给 `v2ToolContext`（与 A 修复里的会话读取接口
`toolAnchor` 同一个做法）。模块级的 `v2PermissionAssertFn` 删除。

为什么这样就够：宿主只会用目录 X 当前实例注册的闭包去跑 X 会话的工具
调用（D1 第二条），所以闭包手里的接口永远是“会话自己目录当前实例”的
接口——请求落在会话的终端看的那张表里；请求的寿命与该会话自己的实例
一致，而宿主不会收回有执行在跑的目录。

为什么不做草案的“按会话目录查表选接口”：

- 闭包本来就知道自己的接口，查表是多余的一层。
- 宿主收回目录时不跑插件 dispose（记账 C1 D1）→ 表里的条目不会自己
  消失，又会引入“陈旧条目”问题。

单目录宿主：只有一次初始化，工具拿到的接口和原模块级变量里是同一个
函数，行为逐字节不变（单测 B3 钉住发给宿主的请求形状）。

## D3 目录被收回：不做“换实例重试”

`DeclinedError` 不带原因（D1），“用户刚拒绝”和“实例已关闭”分不开。
失败后换一个接口重试，等于可能把用户刚点过的“拒绝”再问一遍——这是
放行方向的错误，不做。失败关闭：原样失败。

修复后这件事只在“会话**自己**的目录被收回”时发生（宿主的显式收回，
或空闲清扫——后者会跳过有执行在跑的目录），与其它目录无关。

## D4 同病的其它模块级接口（审计结论）

“按实例隔离”且“收回后失效”的只有权限接口。逐个结论：

| 模块级接口 | 绑到什么 | 按实例隔离 | 该目录收回后 | 结论 |
| --- | --- | --- | --- | --- |
| `v2PermissionAssertFn` | 本目录实例的权限服务 | 是 | 进门即死 | **病根：删除，改由工具闭包持有（D2）** |
| `v2SessionRuleApi`（`ctx.session.get/update`） | 全局会话服务 | 否 | 仍可用 | 不纳入 |
| `jobClient`（`v2SessionClient`：prompt/get） | 全局会话服务 | 否 | 仍可用 | 不纳入 |
| `v2SessionWaitSeam`（`ctx.session.wait`，host.ts L608） | 全局会话服务 | 否 | 仍可用 | 不纳入 |
| `v2DispatchStorage`（`ctx.storage`，host.ts L663） | 全局 KV + 插件命名空间 | 否 | 仍可用 | 不纳入 |
| `anchorClientShared` | 全局会话服务（get） | 否 | 仍可用 | 不纳入（工具路径自 A 起已传本次初始化的客户端） |
| `hostWorktree` | 本次初始化的第一个锚目录 | 是 | — | 落到它的调用会在结果里被点名；不在本 change 范围，记待办 |
| `v2HostSeen` / `v2PostureHomeDir` / `v2MaterializeMode` | 全局配置 | 否 | 仍可用 | 不纳入 |

“全局服务在目录收回后仍可用”的依据：源码（上表）加上真机事故的现象
——最后初始化的目录被收回时，真机上失败的只有门工具和 `forge_shell`，
派发等走会话服务的功能没有一起失败。

## D5 没有确认接口时（宿主形态漂移）

初始化时宿主没给 `ctx.permission.assert`（或不是函数）→ 工具上下文里
不合成 ask；`gate()` 开头加一条分支：`ask` 不是函数就按名拒绝
（`[forge:gate] … REFUSED (fail-closed; state is unchanged, nothing was
approved).`）。修复前这里是 `TypeError: ask is not a function`（单测 B5
在旧代码上的实测）。结果类别不变（都是拒绝），文字说清了原因；不放行
任何东西。v1 宿主的 `context.ask` 一直是函数，这条分支碰不到。

## D6 不做

- 不改权限带决策表、不改门的名单、不弱化任何一道门。
- 不用绕过 ask 的办法（确认必须是真弹窗）。
- 不改宿主的收回逻辑；不改 300 秒看门狗。
- 不改 `hostWorktree` 的默认目录语义（D4）。
- 方案丙（只写文档说明“多目录下不可靠”）不做——用户的真机就是
  多目录。

## D7 验证矩阵

{会话目录 = 最后初始化 / 不是} × {最后初始化的实例在 / 被收回} ×
{单测 / HTTP 带会话目录 / 有头 TUI}。

| 格 | 验证 | 旧代码（0.34.0） | 新代码（0.34.1） |
| --- | --- | --- | --- |
| 非最后目录的门，最后初始化的实例在 | 单测 B1；E2E 21 `C1` | 红 | 绿 |
| 非最后目录的 `forge_shell` | E2E 21 `C2` | 绿 | 绿 |
| 最后初始化的目录被收回后，别的目录的 `forge_shell` | 单测 B2；E2E 21 `E1` | 红 | 绿 |
| 同上，别的目录的门 | 单测 B2；E2E 21 `E2` | 红 | 绿 |
| 被收回的目录回来（又一次成了最后初始化），别的目录的门 | 单测 B6；E2E 21 `E3`/`E4` | 红 | 绿 |
| 非最后目录被收回又回来，另一个目录的门 | E2E 21 `E5`/`E6` | 红 | 绿 |
| 最后初始化的目录自己的门（对照） | E2E 21 `C0` | 绿 | 绿 |
| 单目录：发给宿主的请求形状不变 | 单测 B3 | 绿 | 绿 |
| 没有任何模块级接口可借 | 单测 B4 | 红 | 绿 |
| 宿主没给接口 → 按名拒绝 | 单测 B5 | 红 | 绿 |
| 宿主自带 ask 时保留（v1 姿态） | 单测 B7 | 绿 | 绿 |
| 非最后目录的会话里 `crew_close` 弹确认框，回答后才执行 | 有头 TUI | 红 | 绿 |

- 单测 `tests/ask-door-multidir.test.mjs`（B1–B7）在未改的 `plugin.ts`
  上 B1/B2/B4/B5/B6 红、B3/B7 绿（2026-11-24 实测，
  `view-e2e\logs\md-0341\unit-old.out.txt`）。
- E2E `21-ask-door-multidir-e2e.mjs`：待答请求按**会话自己目录**那一路
  核对（带 `location[directory]`，等同终端带的目录），回答也走同一路；
  收回用宿主自己的调试路由（与空闲清扫同一个调用）。每格结论写进
  `logs/ask-door-multidir-e2e-verdict.json`。
  - 2026-11-24 08:09–08:14Z 在 0.34.1 构建上的首跑：21 项里 20 项过，
    唯一不过的是 `ownDirectoryDoorWorksAfterItCameBack`（E9）——不是门出错，
    是模型那一轮**没调任何工具**（23 秒结束、没有工具部分、宿主日志无错误），
    门根本没被碰到。据此驱动加了一条有界重问：整轮没有任何工具调用的
    那一格，换一个同目录的新会话再问，最多 3 次，每次都记进 verdict
    （`attempts`）；**调了工具的那一轮绝不重跑**，结果好坏都算数。
- 变异检查：工具不传自己的接口 → B1/B2/B6 红；去掉失败关闭分支 → B5
  红；适配器改坏请求形状 → B3/B4 红；覆盖宿主自带的 ask → B7 红。
- 有头 TUI 那一腿要驱动真实终端，属于沙箱到不了的部分之外单独跑；
  到不了的按 D6 记账，不冒充通过。
- 有头 TUI 的红已实测（2026-11-24 07:5x–08:0xZ，0.34.0 构建；ws 会话、
  另一目录在它之后初始化）：确认框弹出，点 “Allow once” 后回复路由
  404、框消失，门等满 300 秒看门狗后拒绝，crew 仍在（D1 末条）。
  绿的要求因此是三件事同时成立：框在会话自己的终端里弹出；在终端里
  回答后调用才执行（看门脚本在会话自己的待答表里看得到这条请求，
  宿主日志没有 404）；拒绝时 crew 保留。
