## 0. 前置（等用户批准后才开始）

- [x] 0.1 用户批准（整份或按编号批其中几项）—— 2026-11-24 整份批准，排 0.34.1
- [x] 0.2 实施前修订草案（对照 2.4.0 源码坐实之后）：去掉“按会话目录查表选接口”与“失效后换接口重试”，改为“工具用注册它的那次初始化的接口”；已写回 proposal/design，用户可否决

## 1. 坐实机制

- [x] 1.1 对照 opencode 2.4.0 源码：一个目录一个实例、工具注册表按实例隔离、待答请求登记在本实例、收回 = 关闭实例（空闲收回与显式收回同一条路）、关闭后的错误与用户拒绝是同一个类型 —— verify: design D1 每条都带源码路径与行号
- [x] 1.2 在 0.34.0 构建上重打 D7 的矩阵（单测红基线 + E2E 21 红基线）；每格留 verdict —— 实测：单测 `logs/md-0341/unit-old.out.txt`（未改代码上 B1/B2/B4/B5/B6 红、B3/B7 绿）；E2E 21 `logs/ask-door-multidir-e2e-verdict.json`（2026-11-24T07:18–07:22Z，宿主 2.4.0 pid 42724，被测 = 主仓库 0.34.0 构建）21 项检查 15 过 6 败，败的恰是多目录相关的 6 格：非最后初始化目录里会话的确认请求落进别的目录的表（C2、E4、E7）、最后初始化目录被收回后另一目录的 `forge_shell` 与门 `Tool.Error`（E1、E2）；对照格与“会话自己所在目录被收回后按需回来、门照常工作”（E8、E9）全绿

## 2. 实现

- [x] 2.1 `v2Setup` 注册工具时把本次初始化的 `ctx.permission.assert` 传给 `v2ToolContext`；删除模块级 `v2PermissionAssertFn` —— verify: 单测 B1/B2/B4/B6（`logs/md-0341/unit-new.out.txt` 7/7）
- [x] 2.2 `gate()`：没有确认接口 → 按名拒绝（失败关闭） —— verify: 单测 B5
- [x] 2.3 审计 D4 清单（design D4 表）：每个模块级接口都有“绑到什么、收回后是否失效、是否纳入”的结论

## 3. 测试

- [x] 3.1 单测 `tests/ask-door-multidir.test.mjs`（B1–B7）：未改的代码上 B1/B2/B4/B5/B6 红、B3/B7 绿；改后全绿
- [x] 3.2 变异检查：每个变异都有点名用例变红，源码逐字节恢复 —— 实测 13/13 KILLED、source intact（`logs/md-0341/mutation/verdict.json`）
- [x] 3.3 全量测试、typecheck —— 实测 1054/1054（`logs/wt-0341-full.tap`）、typecheck 0 错（`logs/job3-0341.out`）。**顺带改了一条既有用例**：`tests/session-anchor-resolution.test.mjs` 的 A5 原先直接调测试面的解析器、不交接口，却断言“ask 适配器和以前一样接好”——它钉的正是本次有意去掉的模块级接口；改成“交了本次初始化的接口就有适配器、没交就没有”。生产代码里唯一的调用点（注册工具处）本来就交了自己的接口

## 4. 沙箱验证（宿主 2.4.0）

- [x] 4.1 E2E `21-ask-door-multidir-e2e.mjs`：0.34.0 构建出红（已得，见 1.2）、0.34.1 构建出绿 —— 实测 **21/21 PASS**（2026-11-24T08:22:37Z–08:27:02Z，宿主 2.4.0 pid 43416，被测 = 本工作树的 0.34.1 构建，dist sha256 前 16 位 `c279590fe3b4785f`；副本 `logs/md-0341/e2e21-green-standalone-verdict.json`）：红基线上败的 6 项检查全部转绿，其余 15 项保持绿。**驱动的一处改动（用户可否决，已写进 design）**：某一格整轮零工具调用时，换同目录的新会话再问，最多 3 次，每次都记进 verdict 的 `attempts`；调了工具的那一轮绝不重跑（本次 21 格都是第 1 次就过，没用上重问）
- [x] 4.2 有头 TUI：ws 会话、另一个目录在它之后初始化的几何下 `crew_close` 弹确认框，回答后才执行（0.34.0 构建先打红、0.34.1 再打绿）
  - 红已得（2026-11-24 07:5x–08:0xZ，0.34.0 构建 sha256 前 16 位 `8c97c396fb75bcdc`，宿主 2.4.0 pid 42724，会话 `ses_df37b75fbffeUYdSiZ9eXSs0av` 在 ws，`ws-tui-md-1hw5qj` 于 07:48:06Z 在它之后初始化）：确认框在会话自己的终端里弹出；点 “Allow once”（07:58:47Z）→ 宿主日志 `…/permission/per_20c8dc620001Bp3ecvL7a4Zk7K/reply http.status=404`，框随即消失；会话自己的待答表为空、另一目录的表里有这条 `crew_close`（`logs/tui-postcheck-md-red.json`：LEAKED 1）；按会话轮询的看门脚本整轮零 ask；5 分 24 秒后 `crew_close` 以 `[gate-watchdog] no adjudication arrived within 300s … REFUSED (fail-closed; state is unchanged, nothing was approved)` 结束，crew 记录仍是 `registered (pending)`（`logs/tui-postcheck-crew-mdred.json`）。**立稿时的症状描述（“确认框不弹”）据此更正：框弹得出、答不上。**
  - 绿已得（0.34.1 构建，2026-11-24T09:26:50Z–11:13:03Z，dist sha256 前 16 位 `c279590fe3b4785f`，宿主 2.4.0）：有头 TUI 门 **13/13 PASS**（`logs/tui-gate.json`，11:20Z：F 三项、C2 两项、命令列表、`/forge stop`、锚定、md 两项、E、无意外确认框、窗口干净关闭）。md 窗口：会话 `ses_df2d3261bffetvqxwihd3Xs5PC` 在 ws，`ws-md-tui-r94k64` 于 10:37:31Z 在它之后初始化、并且直到关窗始终是最后初始化的目录（观察者 10:50:18Z–11:03:11Z 共 1509 次轮询，目录初始化 0 次）。两个 `crew_close` 确认框都弹在会话自己的终端里：允许（Enter 10:53:17.229Z）之后 0.16 秒请求才从会话自己的待答表消失、调用随后执行、crew 记录 `registered (pending)` → `abandoned`；拒绝（Right + Enter 10:59:32.222Z）之后 0.28 秒消失、crew 记录仍只有 `registered (pending)`；其他目录的表里 0 条、宿主日志 404 ×0。作废的尝试与仪器失误逐条写在证据文件的 `scopeNotes` 里
- [x] 4.3 验收门过后停在发布门前（等用户确认 0.34.0 的重启实测；不得连续两个闭环挂同一笔账）—— 实测（2026-11-24T11:36:55Z，提交前预跑）：工作树验收门 `pass:true`，**33 过 / 0 败 / 1 记账 / 0 已知缺陷**（`hardPass:false`，原因就是下面这笔记账）：有头 TUI 13 项齐、实时 typecheck 无错、实时全量单测 1054/1054、宿主 2.4.0、全部 E2E verdict 都晚于本构建；真机运行时目录 `post-0340 → post-0341` 只有 1 个文件变了、多 2 行，是真机宿主自己的会话锚点记录（Unity 目录下的两个会话），不是测试写的。**停在发布门前，没有发布。** 记账的那一笔仍是 `e2e-c1-D1`：它已经连挂四版（0.33.0 / 0.33.1 / 0.34.0 / 本版），根因已查清——宿主 2.4.0 上 v1 `server` 的清理正文不可达（默认导出 `{ id, server, setup: v2Setup }`，`v2Setup` 从不调用 `server()`，它返回的清理函数只释放会话钩子与事件循环），这条腿等的探针行只有那段正文会写，所以构造上就是 `disposeFired:false`；目录收回在 2.4.0 上不杀任何作业。处置（甲：v2 清理也走同一条作业清理函数；乙：改正注释与规格、E2E 改为断言 2.4.0 的真实行为；丙：书面豁免）等用户选定，**清掉之前本版不发布**

## 5. 文档

- [x] 5.1 README：多目录宿主下的确认门说明
- [x] 5.2 `reports/e2e/README.md` 检查项表加 E2E 21 与 TUI 新项
