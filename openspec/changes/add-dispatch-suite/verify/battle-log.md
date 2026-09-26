# add-dispatch-suite · 战役日志（红绿证据 + verdict + 轮报）

> 断点续跑锚点之一：中断后先读本文件与 `../tasks.md` 的 tick 状态再继续。
> 记录纪律（见 `../../../dispatch-tdd-process.md` §2 R1/R6 与 §5）：
> - 每个 task 的"红"必须贴真实失败输出摘要（命令 + 关键行），然后才是绿；
> - 每条边界一个 `### Bxx` 段，verdict 四选一 + 证据；
> - 修复任何缺陷前先在本文件登记回归测试（红），修完补绿证据。

## 统计（每次 verdict 变更后更新）

```
战役Ⅰ（B01–B33）：PASS 0 / FIXED 0 / LIMITATION 0 / BLOCKED 0 / OPEN 33
战役Ⅱ（B34–B48）：PASS 0 / FIXED 0 / LIMITATION 0 / BLOCKED 0 / OPEN 15
npm test: (未跑)   typecheck: (未跑)
```

## 轮报

（每阶段门通过后追加一节：范围、命令真实输出摘要、tick 进度、遗留）

## 证据区 · 红绿记录

（格式：`#### <task号> <模块> — 红` 贴失败输出；`— 绿` 贴通过计数；提交 hash 附后）

## 战役条目

（格式见下，逐条追加；B01–B33 属战役Ⅰ/阶段 C，B34–B48 属战役Ⅱ/阶段 F）

```
### B01 死键 — <verdict>
- 触发：
- 观测：
- 期望 vs 实际：
- 处置：
- 回归：
```
