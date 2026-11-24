## 1. 实现

- [x] 1.1 `queueDispatchProgress(sessionID, text, isLive?)`；队列条目 `{ text, isLive? }`
- [x] 1.2 `dispatchStillLive(jobId)`；`deliverDispatchProgress` 投递前过滤并记账
- [x] 1.3 各调用点接上判定：轮询器的 `flushProgress` / 节拍通知、三处 `announceQueuedStart`、
      中断披露；孤儿披露不接
- [x] 1.4 测试面：`dispatchProgressDropped`
- [x] 1.5 `appendDispatchNotice` / `dispatchReportTail`；`jobWakeText` 的 finished 分支取剥离后的
      tail（stream-lost 分支不动）

## 2. 测试

- [x] 2.1 单测：停靠后派发终态 → 不投递、无 promptAsync；仍在飞 → 照常投递且先于 wake；
      重试中 → 照常投递；中断披露无在飞 → 不投递；孤儿披露照旧；完成 wake 的报告块不含进度
      通知原文（K3）；被取消的排队 wish 不再被“已重新入队”通知点名；在途 wish 的通知照常投递
- [x] 2.2 全量测试、typecheck、变异检查（去掉投递过滤 → 用例必须红；去掉报告块剥离 →
      K3 的“不含 still running”断言必须红）
      —— 实测：typecheck 0 错；全量 1047/1047；变异 e-1（去掉投递过滤）、e-2（去掉报告块
      剥离）均 KILLED（`reports/e2e/evidence/0.34.0/mutation-verdict.json`）
- [x] 2.3 README 环境变量表 `FORGE_DISPATCH_NOTIFY_INTERVAL_MS` 一行补注

## 3. 沙箱验证（宿主 2.4.0）

- [x] 3.1 旧构建（0.33.1）跑 `20-stale-progress-e2e.mjs` 出红（基线）
      —— 实测：11 项里正好 4 项红（过期通知被送达、过期的 owner 不只收到 wake、两份 wake 的
      报告块都夹着进度通知），7 条时间前提全绿
      （`reports/e2e/evidence/0.34.0/stale-progress-old-build-verdict.json`）
- [x] 3.2 新构建同一条驱动出绿（含：完成 wake 的报告块不含 “still running”）
      —— 实测：11/11（`stale-progress-e2e-verdict.json`）
- [x] 3.3 验收门全绿、有头 TUI 门通过后发版 0.34.0
      —— 实测：验收门 31 过 / 0 败 / 1 记账；有头 TUI 门 9/9（过期通知一项 10/10：会话忙
      98.9 秒，只送达 1 条完成通知、0 条“还在跑”）；0.34.0 于 2026-11-24T05:17:47Z 发布并验证
