# Design: fix-stop-cancels-queued-wishes

## D1 顺序：先出队，后取消在飞

`pumpDispatchQueue` 在本会话每一行 settle 时被调用（“kill settle
included”）。`cancelDispatch` 是逐个 await 的：第一个在飞派发一 settle，
队列头就 spawn 了。所以 stop 必须在任何 cancel 之前把本会话的队列整队
摘走（`dispatchQueues.delete(sessionID)` 先于取消循环）。

## D2 journal 句子（与在飞那句区分开）

在飞取消的句子是 “cancelled by the user lever (/forge stop) — the child
was aborted and the dispatch is never retried”。排队 wish 没有子会话可
abort，沿用那句会撒谎。新句子保持同一个杠杆前缀（按前缀识别的消费者
不受影响）：

    cancelled by the user lever (/forge stop) — the wish was still queued:
    nothing was spawned and the dispatch is never retried

D5 的“在途被取消”再有一句（同样是杠杆前缀，说的是实情：从未被提示）：

    cancelled by the user lever (/forge stop) — the wish was leaving the
    queue when stop arrived: it was never prompted and the dispatch is never
    retried

owner 死亡那条 flush 的句子不变（它不是 stop）。

## D3 没有 wake、没有 ledger 行

没有子会话、没有注册表行 → 没有可结算的 job，`deliverJobWakes` 无物
可送。回执就是给用户的报告；journal 是给重启恢复看的记录（终态
`aborted` → 永不重入队列）。D5 里“子会话已建、尚未提示”的那种wish
同理（空会话不产出任何东西，abort 只作清理）。

## D4 停靠中的进度通知

“queued wish X re-entered the queue after host restart” 可能还停在
`dispatchProgressQueue` 里。fix-stale-progress-notice 的“投递时仍然为
真”门会把它丢掉（“还在排队、在途或在飞”才投递）。两件同版发布；单独
看本 change，那条通知最多是一句晚到的过期话，不会触发任何 spawn。

## D5 在途窗口（泵取走之后、登记之前）

`pumpDispatchQueue` 取走队列头到 `registerDispatchTask` 之间隔着两次
`await`（建子会话、发提示词）。这段时间该 wish 既不在队列里，也不在注
册表里：只看这两处的 stop 会漏掉它——用户刚敲完 stop，它才启动。

做法与重试重生窗口（2026-11-23 规格评审发现 ③）“空壳”规则同形：

- **stop 记一个纪元**：每次 stop 把本会话的 `stopEpochs` +1。泵在出队
  时读一次纪元，每次 `await` 回到主线程后核对，纪元变了 = 有 stop 落在窗口
  里。窗口里有三处 await：crew 合规带的锚点读取、建子会话、发提示词。落在
  第一处 → 连子会话都不建；落在第二处 → 见下。
- **泵登记“在跑的泵”**（`PumpRun`：手里拿着哪个 wish、何时结束）。
  stop 清完队列后**有界等待**这些泵落地（默认 15 秒，
  `FORGE_STOP_SETTLE_MS` 供测试），再读注册表。
- 落在哪一侧，由 stop 落在窗口的哪一半决定：
  - **子会话还没建完**：建完后不提示词。空壳子会话 abort 只作清理（空会
    话不可能在运行，清理失败也不构成“可能还在跑”，不额外披露）；journal
    记终态 `aborted` + D5 句子；泵把 id 交给回执，计入“排队取消”那一组
    （只有杠杆还在等时才留便条；第一个恢复的杠杆取走便条，同时等同一个泵
    的第二个 stop 不会重复报）。
  - **提示词已经在路上**：照常登记（它就是在飞派发了），由 stop 的取消
    循环像别的在飞派发一样取消——回执列在“在飞”一组。
- **stop 等不到**（宿主调用卡过 15 秒）：回执写明“有 N 个排队 wish 当时
  还在启动、落地即取消”。之后落地的wish 由泵自己取消——条件是 stop
  已经不在等（`stopWaiting` 在读注册表的同一同步段里清掉，所以不会出现
  “两边都以为对方会取消”或“两边都不取消”）。
- **取消一律串行**（并发 abort 会跟 idle 断言抢）：stop 的取消与泵的
  自取消共用每会话一条链 `stopSerialCancel`。
- 顺带收掉一个同源缺口：并发上限的判定现在把“在途的 wish”也算作占着
  槽位（它马上就会登记），两个泵同时被触发时不会超发。

`dispatchStillLive` 同步认“在途”：针对一个在途 wish 的通知（例如恢复
路径的 “re-entered the queue”）不会因为窗口而被当成过期。

## D6 范围外

- 按 id `cancel` 一个还在排队的 wish：不在本次范围（照旧报注册表里
  没有）。
- 别的会话的排队 wish：stop 只动本会话（规范既有约束）。
- **owner 死亡落在在途窗口**：会话结束时泵正在建的wish 照旧会登记并跑
  完（既有行为，与 stop 无关）。同纪元的办法可以收它，但那是另一件行为
  改动，记为待办，不借本 change 的名义做。

## D7 测试

- 单测（`tests/dispatch-wiring.test.mjs`）：改写「queue pump ②」的旧
  断言；新增“只有排队 wish”“stop 后队列头不补位”“journal 句子”
  “重启恢复不重入”“回执形状”。
- D5 四则，把泵停在窗口里，不靠真实时间（唯一的时间量是 stop 自己的
  等待上限，经旋钮调短；“stop 已开始取消”用观察而不是计时）：crew 合规带
  读取时 stop（连子会话都不建）/ 建子会话时 stop（用 mock 的 `onCreate`
  缝）/ 发提示词时 stop（`onPromptAsync` 缝）/ stop 先等不到（杠杆的第一个
  取消放慢，晚落地的 wish 由泵经串行链取消，abort 窗口两两不重叠）。
- 沙箱 E2E（`19-stop-queued-e2e.mjs`，宿主 2.4.0）：并发上限 + 2 个
  后台派发 → stop → 排队 id 从未出现子会话、25 秒内无补位、journal
  终态、回执两段。在途窗口在实况里撞不出确定性的时刻，由单测覆盖。
