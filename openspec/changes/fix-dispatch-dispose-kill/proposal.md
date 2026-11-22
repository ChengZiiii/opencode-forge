# Proposal: fix-dispatch-dispose-kill

## Why

真机事故（2026-11-22，Unity 工作区二测金丝雀）：一个正在飞的子代理派发在
+10 秒被 journal 记为 `aborted — "registry kill (owner session ended /
dispose) — user abort"`，wake 渲染成 `finished / Final report:
(no output)`。孩子其实完整跑完了 277 行报告——没人收到。

根因（代码+账本双实锤）：

1. **dispose 连坐杀**：`jobManager` 是模块级单例（plugin.ts:1073），插件
   `dispose` 钩子（:6481-6490）无条件 `exitCleanup.trigger("dispose")` +
   `jobManager.disposeAll()`。v2 多上下文宿主上任何一处上下文回收都触发，
   **进程内所有会话的在飞派发全部被杀**——而 dispose 钩子无参数
   （`Hooks.dispose?: () => Promise<void>`），根本无法按上下文收敛。
2. **杀是纯破坏**：dispatch 行没有 pid（无本地进程树），孩子是服务端
   会话，宿主进程死活不影响它；kill 对 dispatch 行只剩两个副作用——
   journal 写 aborted（让重启恢复**跳过**还活着的孩子）+ 丢 wake。连续性
   早就由 journal+重启恢复契约承担，dispose 杀毫无收益、纯有毒。
3. **v2 abort 是哑弹**：`V2SessionClient` 只接线
   prompt/promptAsync/get/create/messages（:8504-8512）——没有
   `session.abort`；`abortChild`（dispatch-async.ts:936-943）调用即
   TypeError 被吞，全部 8 个 killTree 调用点 `void` 丢弃结果。
4. **wake 措辞撒谎**：被杀行照样以 "finished / Final report:" 措辞渲染
   （jobWakeText :1166-1170），空 tail 变 `(no output)`——对 aborted
   不诚实。

## What Changes

- **dispatch 行豁免于插件 dispose/进程出口杀**：dispose 与
  SIGINT/SIGTERM/exit 出口矩阵对 dispatch 行（无 pid、journal 托底）一律
  skip——不杀、不 abort、不写 journal 终态；poller 继续看，真进程退出由
  journal+重启恢复接力。进程型后台 job（有 pid）保持现行 dispose 契约
  不变（job-supervisor 归档行为）。
- **合法杀路径 wake 诚实化**：owner 会话终结与用户 cancel 杠杆仍是合法
  registry kill（契约不变），但其 wake 一律以 aborted 措辞+理由呈现，
  禁止空 tail 伪装 final report；abort 无法确认时披露"孩子可能还在跑"
  （孤儿披露路径）。
- **杀路径 wake 必达**：kill 后行不再被同步删除导致 queued wake 不可达
  ——改用既有 terminal-evidence/read 自清机制，wake 送达后自行消失。
- **v2 abort 真接线**：按 E1 探针结果给 `V2SessionClient` 接真 abort
  （SDK 面或宿主 HTTP abort 端点）；接线不可能时 `abortChild` 显式返回
  unavailable，调用点禁止 void 丢弃——journal+wake 披露 abort 未证实。
- 规范：`job-supervisor`（dispose 杀收敛到进程型 job + dispatch 豁免）
  + `forge-subagents`（三条 ADDED：dispose 豁免 / aborted 诚实呈现 /
  v2 abort 有效性）。

## Impact

- 代码：plugin.ts（dispose 钩子、exitCleanup 触发过滤、disposeAll skip、
  jobWakeText、onSessionEnd 自清）、src/job-manager.ts（disposeAll/
  onSessionEnd 选项）、src/host-exit.ts（killOne skip）、
  src/dispatch-async.ts（abortChild 面检测）、v2 会话适配器（abort 接线）。
- 测试重议：job-manager "dispose kills every running job"（:116-124）、
  host-exit dispose 矩阵（:34-50）→ 收敛为进程型；新增 dispose 豁免、
  killed-wake 措辞、abort-less client 披露用例。
- 兼容：v1 宿主 dispose=进程关停场景下 dispatch 行改为靠 journal 恢复
  （v1 TUI 子会话随进程死——journal 恢复探针会发现孩子没了并诚实
  terminal，行为收敛且诚实）；cancel 杠杆/owner-death 契约本身零改动。
