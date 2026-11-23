# Tasks: command-surface-v2-cleanup

## 1. Specification

- [x] 1.1 四件套就绪，`npx openspec validate command-surface-v2-cleanup
      --strict` 绿；E2 外部调研（命令面实践）复核折入（无反例——见
      design D0）

## 2. Implementation（crew wave 3a：coder → test-coder → gate-verifier → spec-reviewer）

- [x] 2.1 四条 hyphen 命令删除（v1+v2+模板常量）+ `/forge` 路由表
      stop 路由 + help 四形态 + no-clobber 存续
      （v1 `cfg.command["forge"] ??=` 仅存 /forge plugin.ts:6715；v2
      addTemplateCommand 同 plugin.ts:8525；四个 FORGE_*_LEVER_TEMPLATE
      常量已删；STOP_LEVER_BODY :298 入路由表 :313，help 四形态 :289）
- [x] 2.2 forge_jobs `stop` 动作（工具层 context.sessionID 作用域、
      串行 cancelDispatch）+ `all` 分支与 cancelAllDispatches 删除 +
      per-id 逃生舱保留
      （stop 分支 plugin.ts:2745-2765，jobId 校验之前；cancel 动作
      per-id 化、`all` 显式拒绝 :2767-2783；cancelAllDispatches 已删，
      全库 grep 零引用）
- [x] 2.3 用户可见文案（中断披露/孤儿披露/工具描述/README）
      （中断披露 :3718；孤儿披露 :4134/:4138；forge_jobs 描述 :2727 起；
      README 命令段 :634-659 + Cancellation 段 :1029-1054）
- [ ] 2.4 测试重议+新增全绿（design D4）、typecheck 绿、全量套件绿

## 3. Verification（GATE）

- [ ] 3.1 沙箱 E2E 双会话作用域：A×2 + B×1 → A 会话 stop → A 终结
      （wake 诚实 aborted）、B 完整跑完 wake 携带原文；`/api/command`
      无 hyphen 命令
- [ ] 3.2 有头 TUI 顺带验证（与 C2 有头窗口同跑）：命令列表、
      `/forge stop` 可用

## 4. Release（0.33.0 合并）

- [ ] 4.1 并入合并发版梯（pack 白名单 → publish → dist-tags →
      shasum → 旧副本隔离）

## 5. Wrap-up（用户明示后）

- [ ] 5.1 archive + push
