## 1. 约定与事实

- [x] 1.1 对照 opencode 2.4.0 源码查清机制：加载器只读 `default.setup|effect`；异步 setup 是正式契约；清理函数是 setup 解析出来的值 —— 依据：`packages/core/src/plugin/module.ts`、`packages/plugin/src/promise/plugin.ts`、`packages/plugin/src/promise/adapter.ts`（v2.4.0 标签）
- [x] 1.2 查清 v1 契约：`Hooks.dispose` 存在于 `@opencode-ai/plugin` 1.x 的类型声明；官方迁移指南把 v1 的 `dispose` 钩子对应到 v2 的 setup 清理函数
- [x] 1.3 更正状态页里“只认同步返回的函数”那句错误解释，并在汇报里点明

## 2. 规格与文档

- [x] 2.1 `job-supervisor` 需求 “Job ownership and lifecycle”：写明 v1 `dispose` 的身份与 v2 清理函数的范围；原场景触发条件改成 v1 宿主；新增场景 “A plugin unload on a v2 host terminates no job”。改动只在本 change 的 delta 里（`specs/job-supervisor/spec.md`，MODIFIED，6 个场景全文）；主规格 `openspec/specs/job-supervisor/spec.md` 不在这里动——和本仓库每一笔 archive 提交一样，归档时才合并。（初稿曾直接改了主规格，已还原；还原前机械核对过 delta 与那份改过的主规格逐字一致）
- [x] 2.2 `plugin.ts` 两处注释（v1 `dispose` 钩子、`v2Setup` 末尾的清理函数）；可执行语句不变
- [x] 2.3 两处测试注释（`tests/dispatch-wiring.test.mjs`、`tests/dispatch-journal.test.mjs`），只动注释
- [x] 2.4 README “Ownership” 段、`docs/architecture.md` 第 9 条

## 3. 测试

- [x] 3.1 新增 `tests/v2-setup-cleanup.test.mjs`（3 条）：setup 解析出清理函数；拆掉本实例的注册与事件订阅；不终止作业和派发行
- [x] 3.2 E2E 腿 D1（`11-dispose-e2e.mjs`）改断言真实行为；验收门 `e2e-c1-D1` 去掉记账分支，通过须由 `hostContract` 支持
  —— 完成。驱动断言的是 2.4.0 上实际发生的事（控制进程活着并跑到底、钩子的探针行没出现、派发行没被碰）；探针不活算前提不成立。
  **第一次主链判红之后补了一条前提**（design D2）：发驱逐前先等子作业成为活进程（最多 240 秒，成为之后再等 3 秒），等不到就抛
  `PremiseError`、自动重试一次，两次落空记“结论不明”；结论文件新增 `childJobLiveBeforeEvict` 和 `secondsFromDetectionToEvict`，
  驱动的通过条件要求前者为真。验收门去掉记账分支：通过 = 驱动 `pass === true` 且七个被记录的事实齐全
  （`hostContract` 的六个加 `childJobLiveBeforeEvict`，design D3）。
- [x] 3.3 `openspec validate --all` 全过；`npm run typecheck` 0 错；全量单测全绿（实际：validate 是 20 过 / 1 败，败的是 D 的草案，见下）
  - `openspec validate --all`：20 过 / 1 败（21 项，2026-11-24，在上面这些文档改动之后重跑）。本 change 和 change
    `fix-unknown-session-anchor-seed` 都过；败的一项是另一份 change 草案 `adopt-native-subagent-dispatch`（只有提案和设计，
    有意还没写规格 delta），不是本 change 造成的。所以严格说这一项不是“全过”，是“本 change 的部分全过”，照实记在这里。
  - `npm run typecheck`：退出码 0（2026-11-24T21:02Z）。
  - 全量单测：1068 / 1068 通过，0 失败、0 取消、0 跳过（2026-11-24T21:03Z，全套回归结束之后跑）。

## 4. 沙箱验证（GATE ③，宿主 2.4.0）

- [x] 4.1 C1（K1、K2、D1）在带本 change 的构建上：D1 通过，`hostContract` 六个事实齐全（探针活着、控制进程驱逐后存活并跑到底、钩子没跑、派发行没被碰）
  —— 构建 `f767eedbe8015a66…`（版本号 0.34.1 的开发构建，同时带着 change `fix-unknown-session-anchor-seed`；本 change 自己不改运行时代码），
  宿主 2.4.0，2026-11-24T20:03:39Z–20:13:32Z：K1、K2 通过；D1 17 项检查全真——驱逐被接受、探针活着、两个控制作业都起来了
  （`controlsStarted: [B, C]`）且驱逐后存活并跑到底、钩子的探针行没出现、驱逐后立刻派发行仍是 `started`、台账里没有 dispose 行、
  恰好一次唤醒且带金丝雀和最终报告、日志终态 `terminal/completed`。发驱逐前子作业是活进程（`childJobLiveBeforeEvict=true`），
  从看到子作业到发出驱逐 4 秒，一次通过、没有重试。目录驱逐后立刻不在已加载列表里、腿结束时又回来了（只记录，不断言）。
- [x] 4.2 同一场景换 `reload` 触发（只观察，不作门）：确认重载同样不杀作业
  —— 同一台宿主上紧接着跑的观察轮（2026-11-24T20:09:43Z 起）：触发被接受、探针活着、两个控制作业重载后存活并跑到底、钩子没跑、
  重载后立刻派发行没被碰、恰好一次唤醒、日志终态 `terminal/completed`。如实记一点：观察轮不等子作业起来，结论里没有记录重载那一刻
  子作业是否在飞，所以这一轮“重载同样不杀作业”的证据落在两个控制作业上，派发那部分比门变体弱。
- [x] 4.3 全套沙箱 E2E + 验收门：相对 0.34.1 基线（33 过 / 0 败 / 1 记账）无回归，`e2e-c1-D1` 由记账变为通过
  - 全套回归已跑完（2026-11-24T20:13:32Z–20:59:31Z，构建 `f767eedbe8015a66…`，宿主 2.4.0）：17 份结论文件顶层通过标志全为真；
    与 0.34.1 基线逐个布尔事实比对，14 份完全相同、1 份有变化（就是 4.1 的 K1、K2、D1：`verdict.D1`、`verdictAll` 由假转真，
    新增 11 个记录字段）、2 份基线里没有（主链自己的 `c1-verdict` 和 4.2 的 `reload` 观察轮）。明细见 change
    `fix-unknown-session-anchor-seed` 的 4.3。
  - 验收门已过（2026-11-24T22:30:09Z，同一构建，宿主 2.4.0）：**34 过 / 0 败 / 0 记账 / 0 已知缺陷**。相对 0.34.1 基线（33 / 0 / 1）无回归；
    从 0.33.0 起每一版都挂着的 `e2e-c1-D1` 这次是实打实的一项：通过（驱逐回 204、探针活着、两个控制作业驱逐后存活并跑到底、
    钩子没跑、派发没被碰、唤醒 1 次）。有头 TUI 门 13 项也全过（2026-11-24T21:26:38Z–22:08:51Z）。
    报告 `reports\e2e\acceptance-gate-latest.md`，快照在 `reports\e2e\evidence\0.34.2\`；明细见 change `fix-unknown-session-anchor-seed` 的 4.3。
    本 change 不改运行时代码，所以这份证据是和那个 change 共用同一构建取得的。

## 记账（未做、原因、怎么补）

- v1 宿主上 `dispose` 会被调用：只有文档依据，本仓库没有 v1 宿主。补法：在 opencode 1.x 宿主上卸载插件，看探针行出现且进程型作业被结束。
- 空闲清扫驱逐带活作业的目录之后，作业完成的唤醒能否补送：没验。补法：沙箱起一台 `experimental.location_idle_timeout` 调短的宿主，起一个长作业，等清扫驱逐，再回目录里发一句话看唤醒。
