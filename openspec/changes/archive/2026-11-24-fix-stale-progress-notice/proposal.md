# Proposal: fix-stale-progress-notice

> **行为改动，用户已拍板。** 原话（2026-11-23）：“已完成的派发之后才
> 送达的过期进度通知，属于低危的告知时效问题，这个也要修，影响观感了”。

## Why

`[forge:dispatch-progress]` 进度通知只在会话空闲时投递。会话正忙时
通知先停靠，等下一个空闲沿——并且**排在完成 wake 之前**送（既有设计
“旧信息先落地”）。于是出现这种序列：

1. 会话正忙（比如在跑一条长命令），子代理跑到通知间隔，生成
   “still running after N min — tracking continues”，停靠；
2. 子代理在这期间**做完了**，完成 wake 排队；
3. 会话空闲：先收到那句“还在跑”，照它回应一轮（去 poll、干等、或向
   用户复述“还在运行”），然后才收到“已完成”。

“还在跑”送达时已经是假话，还白占一轮。通知本来就是可有可无的
（lossy by design），完成 wake 才是保证。

另一条路径不需要“会话正忙”：会话空闲时通知即时送达，并且照旧
**追加进该派发 job 的输出 tail**；之后子代理完成，完成 wake 的
“Final report:” 取 tail 末尾 2500 字符——于是那句过时的
“still running after N min” 原文被嵌在报告块上方。报告块里写着
“还在运行”，与同一句话开头的事实（finished）相反。

## What Changes

- 每条**针对单个派发**的进度通知带上它的任务 id；**投递那一刻**再判
  一次：该派发已不在（在飞 / 重试中 / 仍在排队）就不送，直接丢。
  完成 wake 不受任何影响。
- 中断披露（“N 个派发仍在飞”）同理：投递时已无在飞派发就不送。
- 不针对单个派发的通知（孤儿子会话披露）照旧投递。
- 被丢的通知仍留在该 job 的输出 tail 里（注册表那一行的内存输出，
  `forge_jobs poll` 读得到；派发作业没有磁盘日志），只是不再打扰会话。
- 完成 wake 的 “Final report:” 块只带报告正文：插件自己追加进 tail 的
  通知按**原文**剥离。通知本身仍留在 job 输出 tail 里；流丢失分支的
  “Last observation” 是观察记录，仍用完整 tail。

## Impact

- `plugin.ts`：`dispatchProgressQueue` 的条目从字符串变成
  `{ text, isLive? }`；`queueDispatchProgress` 多一个可选参数；
  `deliverDispatchProgress` 投递前过滤；测试面多一个只读出口
  （被丢弃的通知）。通知统一经 `appendDispatchNotice` 入 tail，
  `dispatchReportTail` 供 `jobWakeText` 的 finished 分支取报告正文。
- `tests/`：新增“子代理先完成则停靠的通知不投递”“仍在飞则照常投递”
  “重试中照常投递”“中断披露无在飞则不投递”“孤儿披露照旧”
  “完成 wake 的报告块不含进度通知原文”。
- 规格：forge-subagents 新增「Progress-notice freshness」。
- 版本：0.34.0（与 fix-stop-cancels-queued-wishes 同版）。
