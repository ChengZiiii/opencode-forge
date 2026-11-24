# Design: fix-stale-progress-notice

## D1 在投递时判，不在入队时判

入队那一刻通知都是真的；变假只可能发生在停靠期间。队列是唯一知道
“此刻还该不该送”的地方。

## D2 “仍然为真”的判定

- 针对单个派发：`dispatchStillLive(jobId)` = 注册表里该行存在且
  `running`，**或者**该 id 还在某个会话的排队队列里。注册表里没有行且
  不在队列 = 从未 spawn 或已终态 → 不为真。
- 重试链：子代理死掉等重试时，注册表行保持同一行、非终态 → 仍为真，
  “attempt 2/2 starting” 照常投递。
- 中断披露：`inFlightAsyncDispatches(sessionID).length > 0`。
- 孤儿披露：不针对单个派发，不给判定（照旧投递）。

## D3 丢，不改写

不把过期通知改写成“其实已完成”——终态只有完成 wake 一个来源，永远
不让两个来源各说各话。job 输出 tail 在入队时已经追加过一份
（`appendOutput`，只进内存环、不落盘——派发作业没有磁盘日志），
`forge_jobs poll` 仍读得到。

## D4 对既有测试面的兼容

`__forgeSubagentsTest.dispatchProgress(sessionID)` 继续返回字符串数组
（既有断言 `.some((s) => s.includes(...))` 不动）。新增只读出口
`dispatchProgressDropped(sessionID)`：被判定为过期而丢弃的文本（每
会话有界）。

## D5 完成 wake 的报告块剥离进度通知

通知进 tail 是既有设计（`forge_jobs poll` 要读得到），不动写的一侧，
改读的一侧：wake 组装报告块时，按**追加过的通知原文**把通知从 tail 里
切掉。

- `appendDispatchNotice(job, notice)`：进度 / 停靠通知统一走它——
  append 的同时把原文记在 `job.progressNotices`（留最近 30 条）。记在
  job 对象上而不是派发 meta 上：重试会重绑 meta，不能把更早的通知
  忘掉。
- `dispatchReportTail(job)`：取 tail 里最后一个仍找得到的通知之后的
  内容。tail 截断把某条通知挤掉了，就当它不存在——切口落在更晚的
  一条之后，或者不切（此时与改动前的行为完全一致）。
- 只有 `finished` 分支用剥离后的 tail；`stream-lost/unknown` 的
  “Last observation” 是观察记录，继续用完整 tail。
- 不靠前缀匹配剥离：报告正文里合法出现 `[forge:dispatch-progress]`
  字样也不会被误删，只切我们自己追加过的那几段原文。

## D6 实况验证

沙箱宿主以 `FORGE_DISPATCH_NOTIFY_INTERVAL_MS=15000` 启动（默认 10
分钟没法在测试窗口里触发）。会话一次 code call：后台派发一个子代理
（子代理跑 25 秒 shell）+ 前台连续三次 12 秒 shell 占住会话。期望：
15 秒处生成进度通知并停靠；约 35 秒子代理完成；约 50 秒会话空闲。
修前：先收到“still running after 1 min”再收到完成 wake；修后：只有
完成 wake。同一条驱动先在 0.33.1 构建上跑出“红”，再在新构建上跑出
“绿”。同一条驱动还断言完成 wake 的 “Final report:” 块里不含
“still running”原文（通知在生成时就已入 tail，所以这条在“会话空闲、
通知即时送达”的路径上同样成立）。
