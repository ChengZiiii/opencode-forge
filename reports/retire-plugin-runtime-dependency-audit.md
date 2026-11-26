# retire-plugin-runtime 实现报告：4.1 依赖审计

日期：2026-11-26。依据当前工作树源码（包含已迁移的 modelsDevCatalog 初始化），不是 design 中 11-25 的历史行号，也不是 dist。依据已批准 change 的 tasks 4.1、4.4–4.7、5.2–5.3、9.1 和 design D1、D3、D10、D11。已读仓库及工作区 AGENTS、workflow-loop、architecture；architecture 的历史描述不代替源码。

## 1. 口径及结论

〔源码〕只读扫描 `plugin.ts`、`src/` 的导出与模块导入（含 type-only），再交叉核对符号实际使用点、v2 注册入口、共享调用链；测试、脚本、归档探针、文档、生成的 dist 不算生产引用。仓库生产源码为 `plugin.ts` + `src/*.ts`；`package.json:6–7` 指向构建入口。未运行任何脚本、测试、宿主、网络或模型；没有修改源码、测试、规格或任务勾选。本报告不是 GATE 或动态行为证据。

分类：**E** = 旧进程执行/作业监管/看门狗/封条；**D** = 旧插件派发引擎；**V** = 保留的 plan/goal 验证及其共享进程/解释器链；**V-depth** = 保留的模型钉扎和深度通道（保留类的独立支链，不是 shell check）；**E+D** = 两个旧子系统共享。`—` 明确表示无定义模块之外的生产符号引用，括号列模块内用途或无外部消费。`仅 import` 表示只有导入语句、无实际调用/类型使用；`测试缝` 不计生产，用于指出编译残余。表中 P = `plugin.ts`，`P:行` 即 `plugin.ts:行`；S = 本节标题所示 `src/文件.ts`，`S:行` 即该文件对应行。生产引用列写实际调用/类型使用点（同一文件多次使用列关键处或集合），非机械仅列 import。声明行和外部引用按当前工作树编号。模块内引用可为类型或值使用。

**候选全集：13 个文件、165 个导出，逐一列于下表（headless 0 个）。** 无候选导出直接被保留验证链或深度链消费；但 `job-manager` 的表和 `plugin.ts` 多处 v2 接线仍在用，不能先删文件；保留 `proc`/`shell-select`/`run-check`、`models-dev`/`dispatch-depth`，不要按名称批量删除。共享保留/退役的区分见第 3–4 节。

## 2. 候选导出逐项表

### src/exec-classify.ts（16，E）

外部导入 P:79；目前 v1 + v2 的调用与 shell 工具体共享。

| 导出（声明行） | 生产引用 file:line / 无外部引用 | 分类 |
|---|---|---|
| ExecKlass :16 | —（S:17–18,22） | E |
| READ_CLASS :17 | —（S:317,330） | E |
| WRITE_CLASS :18 | P:8210,8228,9501,9517；S:319–329 | E |
| ExecClassification :20 | —（S:316） | E |
| REDIRECT_INDICATOR :37 | —（S:113,319） | E |
| MUTATING_CMDLETS :42 | —（S:114,320） | E |
| GIT_MUTATING_SUBCOMMANDS :54 | —（S:115,229） | E |
| PKG_MUTATING_COMMANDS :68 | —（S:116） | E |
| WRITE_TARGET_FLAGS :78 | —（S:117,282） | E |
| O_FLAG_WRITER_BINARIES :95 | —（S:117,271） | E |
| EXEC_SEAL_INDICATORS :112 | —（无生产消费者） | E |
| CommandToken :153 | —（S:158–159,201） | E |
| tokenizeCommand :158 | —（S:269） | E |
| classifyExecCommand :316 | P:8209,8227,9500,9516 | E |
| KNOWN_INTERACTIVE_COMMANDS :344 | —（S:400） | E |
| interactiveBanner :392 | P:2978 | E |

### src/job-fence.ts（3，E）

外部导入 P:61；`src/proc.ts` 的 `JobFenceLike` 是独立结构类型，不 import 本文件。

| 导出（声明行） | 生产引用 file:line / 无外部引用 | 分类 |
|---|---|---|
| JobFence :188 | P:969,974 | E |
| FenceOptions :197 | —（S:204） | E |
| createJobFence :204 | P:992 | E |

### src/job-manager.ts（13，E+D）

外部导入 P:59、`src/job-runner.ts:21`、`src/host-exit.ts:30`；这里的 LedgerEntry 与 goal-file、watchdog 同名但不是同一符号。表中 E+D 表示共享表及间接内部实现。

| 导出（声明行） | 生产引用 file:line / 无外部引用 | 分类 |
|---|---|---|
| JobState :9 | —（S:28,204,264） | E+D |
| LedgerKind :11 | —（S:15,101） | E+D |
| LedgerEntry :13 | —（S:75,99,102,384） | E+D |
| Job :21 | P:1174–1175,1231,1260–1262,1275–1287,3122,3531,3719,4021,4053,4145,4419,4689,4859,4892,4980,5118–5119,5176,5344,6009,6063；`src/job-runner.ts:74,139,403`；`src/host-exit.ts:54,76–77,93` | E+D |
| JobManagerOptions :61 | —（S:90） | E+D |
| DEFAULT_MAX_FINISHED_JOBS :78 | —（S:92） | E+D |
| DEFAULT_MAX_TAIL_CHARS :79 | —（S:93） | E+D |
| DEFAULT_MAX_REGISTRY_CHARS :80 | —（S:94） | E+D |
| DEFAULT_WAKE_WINDOW_MS :81 | —（S:95） | E+D |
| DEFAULT_MAX_LEDGER_ENTRIES :82 | —（S:96） | E+D |
| JobManager :84 | `src/job-runner.ts:143,379,382,400`；`src/host-exit.ts:69` | E+D |
| createJobManager :90 | P:1045（模块级单例，运行时消费者见第 3 节） | E+D |
| newJobId :409 | P:5404,6050；`src/job-runner.ts:147` | E+D |

### src/job-registry.ts（8，E）

外部导入 P:62、`src/job-runner.ts:22`。

| 导出（声明行） | 生产引用 file:line / 无外部引用 | 分类 |
|---|---|---|
| REGISTRY_KEEP :17 | —（S:181,213） | E |
| SurvivorEntry :19 | `src/job-runner.ts:401` | E |
| JobRegistry :29 | P:970,974；`src/job-runner.ts:59,402` | E |
| structuralRelocate :54 | P:981,983,2888；S:102 | E |
| structuralRelocateAsync :100 | P:2888 | E |
| createJobRegistry :184 | P:977 | E |
| registryPathFor :253 | P:977 | E |
| registryExists :258 | —（无生产消费者） | E |

### src/job-runner.ts（18，E；日志路径亦供 D）

外部导入 P:60。派发 job 不走 `startJob`，但与执行 job 共用 manager 和日志根。

| 导出（声明行） | 生产引用 file:line / 无外部引用 | 分类 |
|---|---|---|
| DEFAULT_IDLE_MS :24 | —（S:144） | E |
| DEFAULT_MAX_WAIT_MS :25 | —（S:145） | E |
| HARD_MAX_WAIT_MS :26 | 仅 import P:60；S:145 | E |
| POLL_WAIT_MAX_MS :27 | 仅 import P:60；S:385 | E |
| DEFAULT_LOG_KEEP :28 | —（S:496） | E |
| JOB_ENV_MARKER :29 | —（S:227） | E |
| jobsLogDir :33 | P:1029（执行日志 P:2881；旧派发日志 P:3527,3715,4017,4049,4141,4685,6003,6057） | E+D |
| StartOptions :37 | —（S:143） | E |
| ForegroundResult :68 | —（S:76,158–159） | E |
| StartedJob :73 | —（S:143） | E |
| FileTail :90 | —（S:92,137） | E |
| createFileTail :92 | —（S:318,431） | E |
| flushJobOutput :139 | —（S:389,391） | E |
| startJob :143 | P:2876 | E |
| pollJob :378 | P:3078（共享 job 上的旧 poll 工具） | E+D |
| adoptSurvivor :399 | P:983 | E |
| readJobLog :454 | P:3105（旧 job 工具） | E |
| rotateLogs :496 | —（S:342,441） | E |

### src/watchdog.ts（14，E）

外部导入 P:65–73、`src/proc-locate.ts:4`；仅 v1 的内建 shell 哨兵接线，不是确认门的等待超时。

| 导出（声明行） | 生产引用 file:line / 无外部引用 | 分类 |
|---|---|---|
| WATCHDOG_ENV_MARK :10 | P:8645；`src/proc-locate.ts:74` | E |
| WatchdogMode :12 | —（S:26,51,81,86,96,113,298） | E |
| WatchdogEventType :14 | —（S:20,120） | E |
| LocatedProc :16 | `src/proc-locate.ts:16,75`；S:27,29,62,188,231 | E |
| LedgerEntry :18 | P:7796；S:61,120,331–332,337,359,364 | E |
| TimingRecord :33 | —（S:114,120,150） | E |
| WatchdogOptions :50 | —（S:100） | E |
| clampStallMs :76 | P:7754；S:102 | E |
| parseMode :81 | P:7749；S:101 | E |
| Watchdog :85 | P:7788；S:100 | E |
| createWatchdog :100 | P:7788 | E |
| watchdogLogDir :325 | P:1451 → P:7759（P:1471 仅测试缝） | E |
| FileLedger :330 | —（S:336） | E |
| createFileLedger :336 | P:7759 | E |

### src/proc-locate.ts（10，E）

外部导入 P:74；别与保留 `proc.ts` 混同。

| 导出（声明行） | 生产引用 file:line / 无外部引用 | 分类 |
|---|---|---|
| Locator :16 | —（S:49,132,203） | E |
| commandNeedle :24 | P:8089,8092 | E |
| PosixDeps :32 | —（S:49,203） | E |
| WinProc :38 | —（S:93,101） | E |
| WindowsDeps :40 | —（S:132,203） | E |
| markerValue :45 | P:8645；S:74 | E |
| createPosixLocator :49 | —（S:204） | E |
| parseWindowsProcs :93 | P:7777；S:148 | E |
| createWindowsLocator :132 | —（S:204） | E |
| createLocator :203 | P:7760 | E |

### src/host-exit.ts（3，E）

外部导入 P:63。注册位置是共享 job 初始化，不是 v2 setup 返回的清理函数。

| 导出（声明行） | 生产引用 file:line / 无外部引用 | 分类 |
|---|---|---|
| ExitCleanupOptions :32 | —（S:69） | E |
| ExitCleanup :62 | P:971 | E |
| createExitCleanup :69 | P:997 | E |

### src/headless.ts（0，E 墓碑）

S:1–6 全部是注释，没有任何 export 或 import；`plugin.ts`、其他 `src` 都没有导入它。不存在待迁符号；删除边界是该文件本身。

### src/dispatch-async.ts（50，D）

外部导入 P:86；无其他 src 模块引用。当前仍有 v2 调用、类型使用及适配器，不能把 v1 删除视为此模块自然不可达。

| 导出（声明行） | 生产引用 file:line / 无外部引用 | 分类 |
|---|---|---|
| QUESTION_DENY_PERMISSION :32 | —（S:303） | D |
| QUESTION_DENY_PERMISSIONS_V2 :49 | —（S:311） | D |
| TASK_DENY_PERMISSIONS_V2 :63 | —（S:312） | D |
| SessionLike :72 | —（S:98,235,265,334） | D |
| MessageInfoLike :74 | —（S:84） | D |
| PartLike :82 | —（S:84） | D |
| SessionMessageLike :84 | P:10217,10287,10290,10302（v2 消息适配） | D |
| StatusMapLike :86 | —（S:117,793） | D |
| DispatchClient :93 | P:1228,3361,3555,3581,3599,3940,3960,4168–4169,4340,4362,4403,4651,4677,4716,4802,4858,7732,8565,10471,10897,10908 | D |
| TimeSeams :152 | —（S:764） | D |
| childSessionTitle :164 | —（S:270） | D |
| CreateChildInput :168 | P:3361 | D |
| CreateChildResult :213 | P:3361 | D |
| TASK_CREATE_SEAM_ABSENT :223 | 仅 import P:86；S:263 | D |
| createChildSession :256 | P:3362 | D |
| SendPromptInput :342 | —（S:351,368） | D |
| SendPromptResult :349 | —（S:369） | D |
| buildPromptArgs :351 | —（S:370） | D |
| sendPrompt :366 | P:3699,4126,5138,5619,5820 | D |
| PollInput :385 | —（S:763） | D |
| PollResult :414 | —（S:765） | D |
| DEFAULT_POLL_INTERVAL_MS :421 | P:4863,5639 | D |
| DEFAULT_POLL_TIMEOUT_MS :422 | —（S:438,440,455,457,769） | D |
| MAX_POLL_TIMEOUT_MS :425 | —（S:441,458） | D |
| resolvePollTimeoutMs :436 | P:5641 | D |
| resolveNotifyIntervalMs :453 | P:4884 | D |
| DEFAULT_STALE_MS :472 | —（S:488,490） | D |
| MIN_STALE_RUNTIME_MS :475 | —（S:491,513,515） | D |
| StaleMode :477 | P:4887,5643 | D |
| resolveStaleMs :486 | P:4886,5642 | D |
| resolveStaleMode :500 | P:4887,5643 | D |
| resolveStaleFloorMs :511 | P:4888,5644 | D |
| SessionGetResult :520 | —（S:568,637,655） | D |
| sessionGet :568 | P:3988,4069,4748,5278,5299,5894,5927 | D |
| StaleSweepState :602 | P:4920,5648 | D |
| staleAnchor :605 | —（S:617,667） | D |
| staleThresholdCrossed :610 | P:5280,5897 | D |
| StaleSweepDecision :620 | —（S:658） | D |
| applyStaleProbe :637 | P:5279,5895 | D |
| decideStaleSweep :654 | P:5281,5898 | D |
| staleSilentMinutes :666 | P:5283,5291,5294,5900,5906,5914,5920,5929,5935 | D |
| TERMINAL_STABILITY_TICKS :681 | —（S:878,895） | D |
| TerminalStabilityState :693 | P:4916,5647 | D |
| ACTIVE_TEXTFUL_OVERRIDE_NOTE :713 | P:5035,5367,5970,5974 | D |
| DEFAULT_VIEW_LOSS_TICKS :725 | —（S:851） | D |
| pollChild :761 | P:5027,5741 | D |
| FinalMessageResult :921 | —（S:927） | D |
| fetchFinalMessage :924 | P:4010,5018,5033,5962 | D |
| AbortResult :962 | —（S:964） | D |
| abortChild :964 | P:1238,5295,5722,5751,5912 | D |

### src/dispatch-gate.ts（11，D）

外部导入 P:88；本模块的旧并发/熔断器不是保留的 harness 决策门或池归属门。

| 导出（声明行） | 生产引用 file:line / 无外部引用 | 分类 |
|---|---|---|
| ModelIdentity :24 | P:3197,3205,3255（v2 P:9603 写 sessionModels） | D |
| DispatchGateConfig :26 | —（S:86,88,107–108） | D |
| GateOutcomeClass :35 | —（S:101） | D |
| AdmissionResult :37 | —（S:93） | D |
| GateClock :39 | —（S:107） | D |
| modelKey :41 | —（S:162,179） | D |
| concurrencyRefusal :49 | —（S:159,167） | D |
| breakerRefusal :57 | —（S:148） | D |
| breakerHalfOpenRefusal :65 | —（S:152） | D |
| DispatchGate :84 | P:3201,3231 | D |
| createDispatchGate :107 | P:3232 | D |

### src/dispatch-journal.ts（10，D）

外部导入 P:91–96。

| 导出（声明行） | 生产引用 file:line / 无外部引用 | 分类 |
|---|---|---|
| DispatchJournalState :27 | —（S:35） | D |
| DispatchJournalRecord :29 | P:3869,3891,3944,3960 | D |
| DEFAULT_JOURNAL_MAX :61 | —（S:66,68,184） | D |
| resolveJournalMax :64 | P:3852 | D |
| JournalFs :73 | P:3845,3851（实际 journal 创建使用该工厂的结果；工厂赋值 P:8425–8426 仅测试缝）；S:83,176,181 | D |
| defaultJournalFs :83 | —（S:183） | D |
| parseJournalLines :116 | —（S:186） | D |
| compactJournalRecords :151 | —（S:195） | D |
| DispatchJournal :168 | P:3844,3847 | D |
| createDispatchJournal :179 | P:3852 | D |

### src/dispatch-retry.ts（9，D）

外部导入 P:87。

| 导出（声明行） | 生产引用 file:line / 无外部引用 | 分类 |
|---|---|---|
| DispatchErrorClass :17 | —（S:144） | D |
| classifyDispatchError :144 | P:5042,5768 | D |
| RESUME_PREAMBLE :159 | —（S:164） | D |
| buildRetryPrompt :163 | P:4129,5141,5823 | D |
| DEFAULT_MAX_ATTEMPTS :168 | —（S:176,178） | D |
| MAX_ATTEMPTS_CEILING :171 | —（S:179） | D |
| resolveMaxAttempts :174 | P:4097,4890,5645 | D |
| RETRY_BACKOFF_MS :183 | —（S:191,193） | D |
| resolveRetryBackoffMs :189 | P:4891,5646 | D |

## 3. 现在的 v2 生产接线（不是旧 v1 行号推断）

| 路径 | 当前证据 | 退役边界 |
|---|---|---|
| 共享工具注册 | P:10565 v2Setup → P:10799–10835 注册 `forgeTools()`，P:10829–10830 适配上下文、执行工具。P:6785–6822 factory：P:6800–6802 条件注册 shell/jobs，P:6819 注册 task；P:948 默认 jobsMode=auto，P:1019–1022 判 stage；P:436 forgeDisabled 初始 false。 | 4.2/5.1 删除旧工具支路，不能删整 factory；P:6787–6798 plan/goal，P:6809–6813 crew/sync 是保留端。 |
| 旧 shell/job 生命周期 | P:2833,2874–2888 工具执行→ensureJobLifecycle P:974–1000（registry/fence/cleanup）；P:2963–2978 交互提示；P:2985–3150 作业工具→poll/log/取消等。P:1045 单例→P:1056、1331–1344 唤醒。 | E；v2 通过相同工厂真实可达，不仅是 v1。 |
| 旧封条 | P:10872 → v2RegisterToolHooks P:9394 → P:9500–9517 分类器；v1 另有 P:8209–8228。 | E；退役封条不意味着删除整个 v2 before/after 或其它 harness 钩子。 |
| v1 独有 shell 看门狗 | P:7705 server → P:7749–7796 建哨兵、locator、账本；P:8089,8092 活动登记；P:8645 环境标记。v2 setup 无 createWatchdog/createLocator 接线。 | E；4.5 删除对应 v1 接线。P:2082 确认门的 `resolveGateAskWatchdogMs` 独立，不是此模块。 |
| v2 自建派发 | P:6819→P:5388 taskDispatchTool → P:5404–5405 ID/report prompt、P:5485 client、P:5515 gate、P:5619 prompt；P:5741 sync poll、P:4858–4863 async watcher、P:5027 poll、P:5141 retry、P:5278–5281 stale、P:5350 terminal。共享 manager 的 P:3522,3710,4012,4044,4136,4680,5998,6052 登记旧派发行。 | D 或 E+D；需同步退役 engine/queue/journal/wake，不是删 `dispatch-*` 前缀所有文件。 |
| v2 初始化恢复 | P:10878–10881 共用 client 接线；P:10887–10891 会话 wait/storage；P:10897 `recoverWorkspaceDispatches`（P:3940→3960→journal/gate/retry），P:10908 `adoptPersistedDispatchRows`（P:4716→P:4748,4782）。P:10471 事件侧另恢复。 | D；删旧恢复/持久化/收养。GoalClient 的 prompt/get 和 native child walker 仍需保留。 |
| v2 生命周期与 idle | P:10921 注册 session hooks、P:9805–9808 idle→P:10328–10333；goal 调度 P:10332 与旧派发进度/作业 wake P:10333 分列。P:10933 事件订阅→P:10406 harvestSessionEnd（P:7649,7655–7656 旧 job/dispatch，P:7676 旧模型表）；P:10430,10436,10443,10454 旧结果信号/披露；P:10398 独立 native crew 观察。 | 拆 E+D 支路，不删续跑、crew native 观察及必要会话状态回收。P:10934–10952 setup cleanup 只拆自身注册，不是 host-exit job 清理；不能以它判断旧 job 已无 v2 使用。 |
| v2 模型捕获 vs 钉扎 | P:9603 `sessionModels` 写 ModelIdentity 表（P:3197，消费 P:3263–3264，删旧派发捕获及对应 harvest）；P:9617 `parseIdentity` 及 P:9655–9675 是独立 pin/depth。 | 前者 D，后者 V-depth；详见第 4 节。 |
| v2 session adapter | P:10120–10270 同一 client 含 P:10127–10140 prompt/get（goal）、P:10154–10187 create、P:10197–10221 messages/normalize（旧派发）、P:10239–10269 abort；P:10270 另挂 P:10093 nativeChildWalker。 | 不可把整个 adapter/共用宿主通信辅助随派发删掉；保留 prompt/get、native child walker；旧派发专用消息类型/规范化调用清除，stop 等新需求按各自任务承接。 |

注意：P:10515 `v2WiringSeam`、P:1464–1474 `__runtimeNamespaceTestSurface`、v1 P:8396–8494 的测试缝不是生产调用，仍需后续编译/测试迁移清理。`HARD_MAX_WAIT_MS`、`POLL_WAIT_MAX_MS`、`TASK_CREATE_SEAM_ABSENT` 只有外部 import；不能误报为 v2 实际调用。

## 4. 保留链逐项核对

### 4.1 plan/goal 真实共用 check runner（V）

- P:2299 `planCloseTool` → P:2333 `runChecks(active.doc.checks, state.worktree)` → P:2334 `outcomesAllOk`、P:2338 `formatOutcomes`、P:2349 `OUTPUT_LIMIT`。使用冻结 checks，非旧 job runner。
- P:2653 `goalCheckTool` → P:2668 `runChecks`、P:2678 `outcomesAllOk`、P:2684 `formatOutcomes`；P:2691 `goalCompleteTool` → P:2711 独立重跑、P:2717 格式化失败。两条 goal 工具和 plan_close 均由 v2 factory P:6790,6794–6795 经 P:10818–10830 注册执行。
- `src/run-check.ts:150–154` 分派 shell/file contract；shell `:105–108` 使用 runner、`:44–48` 默认 runner `shellSpawn`、`:58` 超时 `killTree`；`:126` 文件检查。`src/proc.ts:54–55` 默认 `resolveShell()`、`:66` 非交互 env、`:85–94` killTree/treeKillPlan；`src/shell-select.ts:94` 解释器选择。没有任何从 run-check/proc/shell-select 指回候选模块的 import。`src/run-check.ts:12` 是对 proc 的依赖，不是 job 系统。

| 保留文件 | 导出与生产引用（声明 → 使用） | 分类 |
|---|---|---|
| `src/run-check.ts` | CheckOutcome :19→:105,126,150–163；ShellRunner :28→:44,87；OUTPUT_LIMIT :33→:77,80,94、P:2349；defaultShellRunner :44→:87,89；setShellRunnerForTests :88 仅测试；runChecks :150→P:2333,2668,2711；outcomesAllOk :159→P:2334,2678；formatOutcomes :163→P:2338,2684,2717 | V |
| `src/proc.ts` | SpawnFn :8→:54,87（另旧 `job-runner.ts:52,149`、`job-fence.ts:198`）；ShellSpawnOptions :14→:54；NON_INTERACTIVE_ENV :34→:66；shellSpawn :54→`run-check.ts:48`、旧 `job-runner.ts:224`；treeKillPlan :78→:94,142；killTree :85→`run-check.ts:58`、旧 `job-runner.ts:209,304,416`、P:7793 | V（部分 E 共用） |
| `src/proc.ts` 旧用途余项 | SpawnSyncFn :9→:131、旧 `host-exit.ts:35`；JobFenceLike :12→旧 `job-runner.ts:61`（独立结构类型）；pidAlive :113→:167、P:981、旧 `job-runner.ts:411,434`；terminateTreeSync :129→旧 `host-exit.ts:98`。这些特定导出无直接 check 消费，但 task 4.7 明定 proc 文件原样保留，本审计不建议扩围删除。 | E 辅助，文件保留 |
| `src/shell-select.ts` | ShellFamily :15→:20；ResolvedShell :17→:35,49,94,103,114、`src/proc.ts:6`（类型导入）、旧 `src/job-runner.ts:20,54`；ShellSelectDeps :25→:94；setHostShell :37→P:7857（v1 config）；resolveShell :94→`src/proc.ts:55`；resetShellMemo :137 无外部生产调用。 | V |

**尚需迁移的输入而非候选依赖：** 当前 `setHostShell` 的唯一生产外部调用仍是 v1 config P:7857；v2Setup 没有等价调用。`forgeDisabled` 同样只在 P:7851 赋用户配置，P:436 初值，v2 的 P:9584,9714,9733,9777 及共享 P:6808,7454,7619 等仍消费。task 9.1/探针 K 的 v2 等价输入、多目录核实仍需完成；不能删 v1 后用默认值冒充等价。静态审计不确认宿主合并配置的真实行为。

### 4.2 models-dev 与 dispatch-depth（V-depth，已迁移 catalog 初始化）

- 当前 P:10565–10571 **真实 v2Setup** 先 `await refreshModelsDevCatalog(...)`，再注册消费钩子。P:1437–1447 共享加载函数：skip 分支 P:1439 置 null；正常 P:1443 `loadModelsDevSnapshot({cacheDir: modelsDevCacheRoot()})`，P:1444 挂 snapshot.catalog；异常 P:1446 置 null。v1 也调用 P:8040（已不再是旧 design 中的独占 P:8025–8035）。`modelsDevCacheRoot` P:1429–1434 返回 runtime root，不是已嵌套 models-dev 的目录。
- `src/models-dev.ts:130–135` 解析 URL/cache path；`:146–153` 正常快照规约/缓存；`:156–161` last-good cache 或空 providers。空 catalog 和 null 都能使 modelDepthShape 无命中，但不是完全相同的状态。P:10569–10571 测试默认离线、显式 fetch switch 可改变；本次没有加载/访问网络。现有 `tests/models-dev.test.mjs:108–136` 覆盖路径、catalog 快照/缓存/空/null 的断言（仅阅读，不宣称执行结果）。P:10515 暴露只读测试缝不能替代真实 setup 证据。
- P:10921→P:9751 session hooks→P:9787 `v2ContextInjection`：P:9615–9617 热解析 pinnedDef/parseIdentity，P:9635–9643 pin model/variant；P:9655–9659 已冻结档位复用；P:9664–9668 读 pin 后模型、调用 resolveDepthChannel 与 resolvePinnedDepth，P:9669–9675 保存 session depth/应用/披露。
- **`dispatchProviderFamily` P:884 是保留符号**：P:923 的家族判定先于 P:926 `modelDepthShape(modelsDevCatalog, …)`；P:932 再走 provider family fallback（整个 P:918–940 区域）。旧 nested 派发用途 P:3325 可以退役，但 P:923、932 仍在真实 v2 深度链上（P:9667），另 v1 P:8356，不能随旧派发 helper 删除。`sessionDepths` P:876（DepthTranslation）与旧 `sessionModels` P:3197（ModelIdentity）无依赖等价关系。

| 保留文件 | 导出与生产引用（声明 → 使用） | 分类 |
|---|---|---|
| `src/models-dev.ts` | DEFAULT_MODELS_DEV_URL :15→:133；CatalogCost :20、ReasoningShape :21、CatalogModel :22、CatalogSnapshot :23、ModelsDevResult :25→模块自身规约和载入，CatalogSnapshot 另 P:861；parseIdentity :33→:43,59、P:9617（另旧 P:3259,3283）；nativeLadder :41→仅 import P:75，实际无外部生产使用；ModelDepthShape :55→:57；modelDepthShape :57→P:926；modelsDevCacheDir :69→:134（P:1470 测试缝）；reduceModelsDev :105→:141,148；loadModelsDevSnapshot :130→P:1443 | V-depth |
| `src/dispatch-depth.ts` | META_DEPTHS :36→:73,75；BUDGET_TIERS :41→:120,124；DepthChannel :51→P:918；DepthTranslation :57→P:876；translateDepth :88→:165 (`resolvePinnedDepth`)；applyDepthTranslation :140→P:8340,8366,9659,9672；resolvePinnedDepth :161→P:8357,9668。无指向候选模块的 import。 | V-depth |

### 4.3 其它易被误删的保留邻居

- `src/dispatch-tiers.ts`、`src/dispatch-prompt.ts` 是工人定义、描述、提示词编译，`src/roster-compile.ts:42–43` 真实依赖；P:10744 v2 runtime 物化使用 `forgeAgentDef`，P:10625–10639 v2 native sync 路径使用编译计划。仅旧报告附加符号 `withReportDelivery`（`src/dispatch-prompt.ts:37` → P:5405）及其专用 `REPORT_DELIVERY_LINE` 可随 5.2 的旧引擎消费者退役；不要删文件。
- `src/native-child-gate.ts` 由 P:77 导入，P:7132、7152、7271–7272、7349 和 P:10398 是独立 crew/goal 观察；P:10093–10118 的 native walker 和 P:10270 的挂载不能仅因位于旧 client 附近而误删。`src/crew-gate.ts` 与原生池/草稿 gate 亦不来自 `dispatch-gate.ts`。任务 6 后续有专门迁移，不在本审计更改范围。
- runtime root/anchor ledger/probe paths P:1412–1458 与旧 `jobsLogDir`/`watchdogLogDir` 分开：retire 旧日志目录引用，不删除 models-dev、session-anchor、probe 共用路径。旧磁盘工件依 D12 不读不删。

## 5. 完整性及签收条件

| 候选 | 导出数 | 证据覆盖 |
|---|---:|---|
| exec-classify | 16 | 16/16 |
| job-fence | 3 | 3/3 |
| job-manager | 13 | 13/13 |
| job-registry | 8 | 8/8 |
| job-runner | 18 | 18/18 |
| watchdog | 14 | 14/14 |
| proc-locate | 10 | 10/10 |
| host-exit | 3 | 3/3 |
| headless | 0 | 0/0（墓碑，无导出） |
| dispatch-async | 50 | 50/50 |
| dispatch-gate | 11 | 11/11 |
| dispatch-journal | 10 | 10/10 |
| dispatch-retry | 9 | 9/9 |
| 合计 | 165 | 165/165；13/13 文件 |

每个候选导出均有独立行，已注明外部生产调用/类型使用、仅 import、或无外部引用；同名非同源符号不混算。保留 chain 及 v2 当前实际接线已核对，modelsDevCatalog 以当前迁移后源码重新定位。**task 4.1 的静态引用表交付完整，可供主会话复核并勾选**；这里没有勾 tasks.md。没有声明 4.2–4.8/5/9.1 已实现，没有以静态扫描代替探针、构建、类型检查或 E2E。仍需主会话按批准顺序协调迁移、验证及删除，特别是 shell/disable 等价输入与 v2 实际宿主证据。

## 6. 1.16 测试行为迁移盘点（2026-11-26，静态初审；当前状态见 §7）

下列是直接 v1 入口的 26 个文件，按行为组区分保留、迁移、退役。列出的 v2 文件是相关断言位置，不是已证明逐条等价；不得根据本表整删混合文件。

| 测试文件（均在 tests/） | 保留或需迁移的行为；v2 对照 | 退役行为 |
|---|---|---|
| command-surface | 模板、参数替换、路由、旧命令负向契约；同文件 v2 测试，no-clobber 等价待查 | v1 config 接线 |
| crew-continue | idle、终态、pending、goal 优先、停滞、传输、删除；v2-crew-lifecycle，speaker 切换及原生轮次计数待迁 | 旧 task 计数形状 |
| dispatch-cancel | 确认门 watchdog、迟答、超时；新 stop 另验 | 旧派发 ID、队列和 job stop |
| dispatch-gate-wiring | 无独立保留组 | 旧容量、排队重检、breaker |
| dispatch-guard | 原生递归约束按新规格另验 | 自建会话 task guard |
| dispatch-journal | 旧磁盘工件不读不删；runtime-namespace 待迁 | journal 轮转、恢复、重试、旧通知 |
| dispatch-queue | draft、crew pending、pool 合规；v2-tool-hooks（旧调用形状待迁） | 容量、占槽、出队、旧唤醒 |
| dispatch-wiring | 跨池、crew pending、draft、身份；v2-tool-hooks，stop 独立验，错误辅助函数查调用方 | task 注册、自建会话、轮询、队列、重试、日志、旧取消 |
| exec-cwd | 原生 cwd 由宿主验 | 旧 shell 返回 cwd 行 |
| exec-seal-wiring | draft 禁写；v2-tool-hooks | 旧命令分类封条、finding |
| forge-commands | sync/init/帮助、文件保护、crew 未配置提示；同文件 v2 与 v2-session-commands，实际 stop/身份待迁 | v1 注册 |
| forge-subagents-wiring | 物化、兄弟隔离、用户条目、depth、crew 注册/关闭/放弃、记录、lineage、报告；v2-pools、v2-session-commands、v2-crew-lifecycle，close verdict 与证据待迁 | 旧 task shadow |
| goal-mode | Goal 全生命周期、Plan 丢弃/关闭/重开、冻结检查及真实 runner；v2-goal-lifecycle、v2-continuation，非 owner/未知目录、disable、合规及真实 runner 待补 | 旧执行/派发活动形状 |
| headless-gate | plan_approve 确认门；v2-permission mock，真实 UI 另验 | 旧 shell banner、posture、封条 |
| hierarchical-pools | namespace、物化、兄弟隔离、shared、顺序、手写保护、坏 pool 不回退、锚点；v2-pools 部分覆盖，中途损坏、ledger 重绑、move 矩阵待迁 | 旧 task 出队形状 |
| job-registry-first-run | 无独立保留组 | 首次 job registry、锁、启动 |
| job-wiring | 确认门、用户规则优先、非 forge 记录不污染；v2-permission、v2-setup 部分 | shell/jobs 注册、唤醒、轮询、生命周期、旧分区兜底 |
| native-child-gate-wiring | busy、终态、超时、不可读、删除、去重、未核实摘要；native-child-walker 相关合成 adapter，ceiling/goal/去重待核 | 无整文件退役依据 |
| native-child-recheck-timer | 定时重查、删除、ceiling、重新登记、清理；native-child-walker 部分 | 无整文件退役依据 |
| native-child-walker | walker 状态、响应形状、过滤、失败、crew 恢复；同文件 v2 adapter | 仅 v1 接线 |
| partition-wiring | harness 分区、draft、身份、模板、session 清理；v2-tool-hooks、v2-permission、v2-session-commands，身份/状态不变和用户记录待核 | v1 兜底、旧 task/shell 规则 |
| runtime-namespace | models-dev、anchor ledger、probe，旧工件不读不删；models-dev v2 setup，目录断言待迁 | jobs/watchdog 创建与旧 job 清理 |
| search-behavior | 链接、隐藏目录、结果语义；原生搜索更新与真实宿主待验 | 旧 forge_grep 执行链（先查其它消费者） |
| search-wiring | editor.update、缺失/拒绝披露、卸载恢复；v2-setup-cleanup 仅一般清理 | 旧别名注册及行为 |
| shell-spawn-error-outcome | 保留 Plan/Goal run-check 失败报告；v2-goal-lifecycle 部分，真实故障待核 | 旧 job spawn/poll 表述 |
| watchdog-wiring | 确认门 watchdog 不得误删，v2 待核 | 旧 shell marker、进程 watchdog |

其他受影响文件：`dispatch-async`（旧创建/通知/轮询/重试退役，abort 新 stop 另验）、`dispatch-gate`（旧并发与 breaker 退役）、`dispatch-hostsignals`（旧派发信号退役，独立事件/模型 pin 查消费者）、`dispatch-prompt`（角色/shared/shape/provenance 保留，旧 report wrapper 退役）、`exec-classify`（旧封条退役，draft 分类独立）、`host-exit`、`job-fence`、`job-registry`、`job-runner`、`watchdog`（旧执行生命周期退役，共用 check/确认门不删）、`ask-door-multidir`（多目录、fail-closed、重初始化、原生 ask 优先保留，v2 完整对照待核）、`roster-compile`（物化、新鲜度、原子写、工件保护保留，旧 face 待迁）、`session-anchor-resolution`（目录、亲缘、fallback 披露、ledger 保留，v2 lazy seed 部分覆盖）、`worker-shell-session-allow`（旧 rescue 退役，用户显式权限必须保留）。

混合 v2 文件同样不可整删：`v2-permission` 保留确认门与 draft；`v2-tools` 保留注册/schema/fail-soft；`v2-session-commands` 保留命令与 pin；`v2-tool-hooks` 保留 draft/pool/crew/边界/活跃度；`v2-continuation` 保留 Goal/seed/预算/清理；`v2-setup` 保留 setup、用户定义、模型及仍有消费者的 adapter。各文件旧 job/task/shell 特有断言按新约定迁移或退役，不能作为新版覆盖证据。

本盘点尚非完整逐断言等价证明。必须先核实保留断言，再删入口和模块。当前明确缺口包括 Crew 记录/报告/close、pool 重绑/move、child 重查/去重、搜索 editor、确认门多目录、真实 runner、新 stop 与配置等价输入；间接调用及动态符号删除前须复查。新增 draft Plan 阻止 Goal 武装但允许 inert queued 的 v2 mock 回归后，v2-goal-lifecycle 36/36（`reports/retire-runtime-v2-goal-lifecycle-test.log`）；未运行全量。1.16 未勾。

## 7. 1.16 普通行为增量复核（当前工作树）

§2–6 为迁移前快照，不代表现存引用。`git diff --name-only --diff-filter=D -- tests` 实际显示 18 个已删除文件：`dispatch-{async,gate-wiring,gate,guard,hostsignals,journal,queue}`, `exec-cwd`, `host-exit`, `job-{fence,manager,registry-first-run,registry,runner,wiring}`, `shell-spawn-error-outcome`, `watchdog{,-wiring}`（均 `.test.mjs`）。删除的事实不等于全部旧断言已迁：特别是 job-wiring、watchdog-wiring、dispatch-queue 的混合行为仍由确认门/原生门任务验收；shell-spawn-error-outcome 的共用 runner 由 6.10 承接。dispatch-cancel、dispatch-wiring 尚在但已改写，不列为删除；exec-classify 及 exec-seal-wiring 也尚在。

普通行为现有迁移证据（静态断言位置；运行结果以各任务既有日志为准）：

- `v2-goal-lifecycle.test.mjs:182–242,341–398,735–864`：discard reason/supersede、日期 section relay、冻结 checks、失败保留 approved、重开再 close、实际 runner；:121–173,242–328,543–559 revision/账本/history/queue/owner。6.10 既有定向 23/23（含 proc）。
- `v2-crew-record.test.mjs:34–153`：声明、重复拒绝、lineage有/无、输出次序、append-only arm/close、非法 report 不修改文件、PASS/FAIL 规范化、abandon/conversion/fail-soft。不是原生轮次证据；`v2-crew-lifecycle.test.mjs:33–133` 承接续跑、goal 治理、stall、transport、删除。
- `v2-pool-anchor-lifecycle.test.mjs:42–134`：坏 owner、删除重建/同 stat cache、ledger rebind/move、完整用户记录；`v2-pools.test.mjs:112–290`：global、collision、稳定顺序、坏兄弟、prefix/shared。`runtime-namespace.test.mjs:65,223` 保留路径与旧工件 sentinel；5.5 已有定向成功。`models-dev.test.mjs:110` v2 setup snapshot，真实宿主仍待 K。
- `command-surface.test.mjs:101–147,194–215` 纯参数替换、v2 router/漂移；`v2-session-commands.test.mjs:299–355` plan/crew 模板及原有 contract relay；:361 的空 roster 指引补入 consent、hot apply、model/depth 字段、prompt、plain id、global/namespace 等普通模板断言。本次未运行测试。

当前 `rg -l '\\bserver\\s*\\(' tests` 共 15 个文件；以下按仍需处理的具体断言归类，所有混合文件保留：

| 现存 v1 文件 | 普通差额 / 已覆盖边界 |
|---|---|
| command-surface、forge-commands | 纯模板及替换已独立，v1 no-clobber 与 v2 editor 无 get 的差异明确（v2-session-commands:388）；不能宣称等价。未初始化 crew_begin 错误指向两个 init lever（forge-commands:172）仍需独立对照。 |
| crew-continue | lifecycle 已迁主干；speaker 切换、轮次/重复事件按 6.11，不迁旧 task 形状。 |
| forge-subagents-wiring | record/relay/close 已迁；:684–733 host 不见 workspace 文件的 mismatch 文案、:996 global origin、:266–528 深度 channel/freeze 的完整 v2 矩阵尚未逐项对应。:558 init 模板普通部分已补；shape/permission 文字及 gate 另验。 |
| goal-mode | 普通 persistence/runner 已有上述对应；缺逐项对照非 owner/未知目录与 disable 的旧入口差异，后者归 9.1；不迁旧派发计数。 |
| hierarchical-pools | :79–373、1249–1371 多为纯 parser/compiler 断言，不依赖 v1，不必搬；:1154 ledger FIFO cap/last-entry、:1111 IO failure、:1068 deleted pool ledger hit 尚缺完整 v2 断言。:1395–1568 move/crew gate 矩阵归 6.4/6.8。 |
| runtime-namespace | :181 v1 config snapshot 对照 models-dev:110；旧文件不读不删已覆盖。 |
| native-child-gate-wiring、native-child-recheck-timer、native-child-walker | v2 walker :93,207,472 已有真实 adapter 的合成宿主断言；ceiling/重新登记/删除/重复及 goal wait 仍需 6.11 对照。 |
| search-behavior、search-wiring | 纯引擎语义保留：empty file、默认 hidden/follow、明确 path 及 include、rg/JS fallback、结果去重；旧 alias 的执行层不能当新 editor.update 覆盖，按 8.x 迁。 |
| exec-seal-wiring、headless-gate、partition-wiring | 普通模板有 v2-session-commands 对照；确认门、用户记录、状态文件、draft、身份及其它 permission/dispatch 行为不在本次增量范围（6.x、9.1）。旧封条专属断言按 4.4 退役。 |

未勾 1.16：上述普通差额与其它受保护行为仍需逐项核验；不以标题、静态存在或旧日志冒充完整覆盖。本次无实现变更、无删除、无全套执行。

### §7 增量处置（普通数据与命令）

- `command-surface`、`forge-commands`：退役 v1 config 注册断言；v2 已覆盖注册、完整模板、参数/下发与 retired 名字缺席。v1 create-only/no-clobber 的接口差异继续由 `v2-session-commands` 的无 get 测试明确记录，非等价承诺。未初始化 crew_begin 拒绝完整文案（两个 init lever、所有权及显式同意）迁到 v2 mock，未删约束。
- `runtime-namespace`：N6 迁至 v2 setup，显式 mock fetch，保留 snapshot 内容、单层路径、原路径未变；N7 使用 v2 event + cleanup，保留旧工件 sentinel 与目录断言。
- `search-behavior`：现有六个执行场景迁到 v2 mock 注册的暂存 alias，使用真实 fixture/rg/JS 和 v2 content 结果；不冒充 8.1 native editor.update 或权限等价验证。`search-wiring` 原授权断言及 override 参数链保留；当前诊断 non-forge fallback 隐藏 alias 失败（undefined vs false），不得以删除 permission 回归解决。
- `session-anchor-seed-multidir`：末尾多余空行去除（diff --check）；权限/旧 task body 回归保留，本次未修授权。定向执行仍见 primary identity 未建立及已移除 task execute 的失败。
- 其余混合文件仍按上表处理，特别是实际授权、native child、pool/crew gate、disable；不删混合断言，不实现派发。

定向结果（canonical `node --import ./tests/lib/test-runtime-namespace.mjs --test`）：command-surface + forge-commands + runtime-namespace 25/25；search-behavior 7/7，session-anchor-seed-multidir 同跑仍失败；先行 search-wiring 14/15（上述 permission 断言）。`rg -l 'server\s*\(' tests` 现 12 个文件（上次 §7 的 15 为历史值）：crew-continue、exec-seal-wiring、forge-subagents-wiring、goal-mode、headless-gate、hierarchical-pools、native-child-gate-wiring、native-child-recheck-timer、native-child-walker、partition-wiring、search-wiring、v2-setup-cleanup。无全量执行，1.16 未勾，未变更生产实现。

### §8 后续迁移（2026-11-26，按批次保留历史快照；最新状态见节末）

- `forge-subagents-wiring`：六个物化测试改走 v2 注册/生成工件，model pin 与 thoughtLevel 以授权 sync 生成的 Markdown 为准，不伪造 v2 draft model 字段；保留用户完整记录、形状限制、兄弟 fail-soft、Auto、shared 诊断。定向 45/45。
- `goal-mode`：四个 goal_check 用例走 v2，包括 revision log、subset/非法编号、无 live goal、真实退出码/文件契约/超时。进一步五个持久化与确认回归使用 mock permission.assert 而非旧 ask：arm、revise、失败完成不询问、resume 拒绝/允许与上限、discard 拒绝/允许与历史留存。五条专项 5/5，其余旧测试未删除。
- `v2-pool-anchor-lifecycle`：账本 IO 故障拒绝、move/recipe deletion 后 crew 记录与诊断。v2 专用 reset 清理 v2HostAnchors；账本测试 seam 独立于 server()，原 v1 测试复用同一 seam。尚欠 move 前明确绑定和删除后 global fallback 实际行为的逐断言核对，旧 hierarchical-pools 完整保留。
- 搜索：此前暂存 alias 已移除，原生定义保留，纯引擎测试仍在；真实 metadata update 不能证明执行或权限等价，增强相关执行测试差额仍未迁完。
- 当批直接 server 调用扫描（历史快照，非最新状态）：8 个文件（crew-continue、goal-mode、forge-subagents-wiring、native-child-walker、native-child-recheck-timer、native-child-gate-wiring、partition-wiring、hierarchical-pools）。当时 1.16 未完成，不删入口；当前扫描与入口状态见节末。
- 后续 `goal-mode` 的普通持久化测试继续迁至 fileHarness（真实 v2 mock permission.assert 记录，不传旧 ask）：排队无询问、单 live、暂停、修订保留 blocker、成功完成，以及全部 10 个 Plan 文件场景（终态叙事、frozen checks、拒绝/再跑、reopen 与重新绑定、superseded discovery）。随后另迁草稿冲突、修订审计历史、无效 attestation、paused 完成拒绝、最早 queued 提升五例，定向 5/5。全量 759/759 已覆盖此前 10 个 Plan 场景及大部分 Goal 迁移，最后五例为随后专项结果；旧续跑与跨行为测试仍保留。
- 再核 8 文件：`hierarchical-pools` 保留 legacy anchors reset 及未对等的旧门断言；v2 补 shared 更新、删除后注册和 move record 落点。`forge-subagents-wiring` 前缀自愈、主代理路由提示迁 v2，深度/crew 旧接口差额保留。`partition-wiring` worker metadata 与用户字段增强，默认代理和删除身份清理旧例保留。`crew-continue` closed/abandoned/pending 三例迁入已有 v2 对照，旧删除前已建立 continuation 状态的用例保留。三份 native-child 文件仍含仅旧入口或未证等价的等待、计时、结算测试，不能删除。`goal-mode` 尚余旧配置及生命周期组合测试。定向 pool 66/66、worker 45/45、partition 22/22、crew 两套 18/18，均无失败/跳过。worker 工人完成时全量 759/759；此后 crew 去掉三项重复旧例；独立闸口工人中间全量 756/756（零失败/跳过/取消/todo），typecheck exit 0，原始日志已字节核验归档。
- 第三批定向：移除一例已由 v2 前后注册断言完整覆盖的旧 pool 删除测试；新增 v2 family 路径变体去重及 reset 后旧 family 消失的可观察测试（内部 anchors 精确断言仍保留），两套 66/66。v2 context 增补同 session pin 重施覆盖被篡改的 options、fresh session 相同 pin；实际 setup mock catalog 增补旧数值边界 xhigh=28672、minimal=1024，worker/context 两套 65/65。未移除旧深度断言，finding 接口及独立场景尚未逐项等价。此批均无失败/跳过，未跑全量。
- 第四批：forge-subagents-wiring 的 PENDING 注册输出顺序、显式 lineage/relay 正反例、落盘 header 顺序、relay-first 提示四例迁至 v2 mock，不 arm 或启动自主工作，45/45。Goal interpreter smoke 已为纯 runner，普通验证已为 v2，无重复迁移；尝试迁移 promotion clock 组合例时 prompt 断言实际 1 预期/0 获得，恢复原用例；三个专项 3/3，不宣称组合行为已等价。
- 第五批 v2 depth matrix 新增未知 provider low、OpenAI XHigh 归一及 catalog-silent GLM finding。首次 64/65（fixture ID 大写不合法），修正到小写后两个目标套件 65/65、零失败/跳过；migration-depth-latest.log 字节核验归档。旧 modelID 形状与 depthFinding seam 等未对等断言保留。
- 第六批：将原 crew_begin roster 输出测试直接迁至 v2 PENDING fixture，保留双方 origin 路径和显示标签（66/66）；旧命令模板及内部 anchor 数量仍保留。删除三个已等价覆盖的旧 depth metadata 用例：pin 注入/篡改重施/fresh session、Auto/非 Forge 无注入、toggle dead end 与有界 finding；两个套件从 65 减为 62，62/62 通过。两份原始日志 migration-roster-display.log、migration-depth-dedup.log 字节核验归档，strict 通过。
- 第七批：合并旧空配置初始化/两个未物化工作区/global origin 到 v2 初始化 fixture，补诊断文案及无记录断言；根目录退化 Plan 放置场景迁 v2，验证真实本地文件落 session 而非 launch 目录。原五个旧例移除，新增一个 v2 放置例，定向两套 49/49，migration-record-diagnostics.log 字节核验归档。最新独立 typecheck exit 0，canonical preload 全量 749/749、零失败/跳过/取消/todo。第一次 bare node --test 漏隔离 preload，其 749 仅为非规范回归，不作为有效证据；规范重跑日志 migration-batch-7-canonical-20261126-163243-1201.log，已逐字节归档。
- 跨会话增量：旧 production-catalog P0-1 矩阵的完整行为转入 `v2-session-commands.test.mjs` 的实际 setup + mock fetch 测试，补 4-8 adaptive、4-7 high、GLM catalog control 及实际 reducer 产出原始 Anthropic ladder 的精确断言；已有 4-7 xhigh、4-6 xhigh、bare 4 minimal、无额外 finding 断言保留。定向 1/1 通过后仅退役对应旧例及其独占 fixture/import。未调用真实模型，非宿主 E2E，不删其余旧深度/配置断言。8 个旧入口文件仍在。
- 集中迁移：v2 depth fallback 补 `id`/`modelID` 两形状及有效配置无 finding，catalog 矩阵补精确 ladder 匹配/不匹配，freeze 补 agent 名和 bounded finding；三个变更用例 3/3，七条等价旧深度用例退役。v2 命令文本补旧 Crew 完整纪律和初始化说明，两项定向 2/2 后去除两项重复旧场景。Crew record fixture 去掉旧 `ask`，令合成 v2 permission.assert 实际接收确认；拒绝 abandon 保留 pending/executing 原字节，转换文案完整，五项 5/5。未删未对等的旧入口或全量复跑。
- 后续普通 Crew 文件合同：草稿拒绝的三个出口与批准后注册、无 governing goal 的非法注册、PENDING close 的缺漏/未声明/诚实 FAIL、跨目录记录落点、arm/close 记录及文案均在 v2 fixture 补齐。仅移除已有等价证据的旧案例；仍含独立断言的旧混合用例保留。canonical preload 全量 746/746（之后新增跨目录记录一例），最新定向 25/25（Crew record、proc、native search fallback、stop scope），typecheck 通过。旧入口尚未完成迁移。
- `forge-subagents-wiring.test.mjs` 的最后旧入口调用已退役：保留 file-anchor fail-soft、注册/arm/转换文案与原生 PENDING 拒绝回归；旧私有 disable 合同按 D10 改为代理 metadata 不影响插件注册，用户同名 Crew 命令按已实证的 host post precedence 迁至 v2 命令 fixture。原生 PENDING 拒绝测试先红（Missing expected rejection），补原生工具拒绝，保持 pool → pending → compliance 次序；合跑 36/36、补充双目标拒绝 1/1、typecheck 通过，最终该文件 16/16。此处仅合成 hook，不执行子代理；不宣称真实宿主拒绝结果或完整 D4/D11 已验。剩余旧入口依赖尚未删除。
- Goal/Plan 文件合同对等迁移：`v2-goal-lifecycle` 补 arm/revise/pause/resume/discard/complete 的精确确认序列、拒绝原始字节、冻结 checks、终态历史、草稿拒绝无工件。`goal-mode` 对应重复例退役，保留独立组合场景。全量 717/717。随后 `partition-wiring` 中默认设置、删除身份、15 工具的分区、普通 native 工具 preflight、相对/绝对状态边界、草稿期身份切换及旧 family 模板（已被明确身份入口取代）去重。原生非 forge 身份拒绝、跨池拒绝补回归，不扩大派发面；仍保留独立旧侦察/续跑/锚点案例。全量 707/707、strict 13/13；追加跨池拒绝后定向 21/21、typecheck 通过。余 7 个直接旧入口文件不变，1.16/9.x 未完成。
- 当批普通注册与锚点迁移（历史快照）：`v2-pool-anchor-lifecycle` 补缺失/非法 pool 声明的原样拒绝与无记录、修配方热应用、权威记录优先、session lookup 不可用时的 tool context 回退、move 事件胜过旧 record/context/内存 binding、abandon 原记录落点。仅退役 `hierarchical-pools` 中已对应的 8 个旧配置/注册场景；同文件独立断言仍保留。两套 canonical preload 合跑 62/62，零失败/跳过，日志 `intermediate-regression/pool-record-migration-20261126.log`。当时没有新增派发或取消执行，旧入口仍在。

#### 最新状态补记（2026-11-26，文档核对时点）

- 测试迁移工人回报：Goal、partition、hierarchical-pools 与四份 native-child 测试（gate、gate-wiring、recheck-timer、walker）已迁，扫描全部 tests 无 `server()` 调用或 server import。本次独立文本扫描 `tests/` 的 `\bserver\s*\(` 与 `import.*\bserver\b` 同样无命中；只证明静态入口依赖消失，不是逐断言等价或 E2E 签收。
- 本次独立核对当前树：`plugin.ts` 已无 `server` 导出，默认入口为 v2 `setup`；`package.json` 已无 `./server` export，旧 `forgeDisabled` 开关也已移除。上文“8 个文件”“不删入口”“旧入口仍在”等均属对应批次历史，不再描述当前树。未据此宣称最终包或发布完成。
- 工人早先回报的 pool 52/52、child 37/37 是新增 dispatch 活动红断言之前的中间绿结果；新增断言随后出现 `0 != 1`（预期活动计数 1、实际 0）。本次静态核对见 `v2-tool-hooks.test.mjs` 保留 dispatches=1 断言，`plugin.ts` 活动计数分支已包含原生 `subagent`。随后协调会话转述最新工人结果：child 四 suite 37/37，包含原 dispatch 红例已转绿；stop/scope/v2commands/crew 组合 37/37、typecheck exit 0。后一个 child 37/37 与前一个同数字结果属于不同验证时点，不混算；本次未运行测试或独立核验这些最新运行日志。
- 协调会话另转述 D10 工人结果：已删除 643 行旧入口块，default 仅 id/setup，package 无 `./server` 且 engines 限 v2，typecheck exit 0。协调会话随后转述 agent 结果：D10 独立定向 `v2-crew-lifecycle` 当时 10 例复现 6 pass、4 fail，交 coder 修复；上文两组 37/37 不能映射为相关行为全部全绿。后续协调会话转述修复结果：fixture 补齐视图后，该 suite 10/10，解决上述四红；保留先红后绿时间线，不据此扩展为相关全部行为通过。不以 typecheck 或入口静态删除代替完整卸载/安装 E2E；本次未独立复跑。
- 协调会话转述的 agent 结果另列 D11 未完成项：Goal 非 Crew child 等待、paused 拒绝新的自主调用、Crew close 派发轮次实证；均已派工修复，尚未验收。不能以既有 child 或组合定向绿结果覆盖这些缺口。
- 搜索最新源码已通过 `editor.update` 对 builtin `grep` / `glob` 做同名增强，保留 native schema 基础并加入默认 true 的 `follow` / glob `hidden`，不再是仅 native fallback。搜索工人回报：真实隔离 host 加载 staged build，实际 grep/glob 已证明 hidden、junction、dedup。协调会话随后转述两项真实 host 执行期负对照：已暴露 grep 按具体 pattern deny 返回 `Permission denied:grep`，显式外部根 deny 返回 `Permission denied:external_directory`。这些均为 staged 构建，且并发期间 hash 不同，不是同一最终包验收。本次只独立核对源码，未复验上述宿主运行；两个 deny 不等于完整权限等价矩阵。最终包、完整宿主可用性/权限等价（含外部链接真实目标）及 disable/uninstall 恢复 E2E 仍待，不把 mock 或 staged 结果当完整 GATE，不声称已发布。
- 上一轮仅更新 README 与本报告；不改代码/tasks、不新增文档、不运行测试、不提交。1.16 与整体 change 的验收状态仍以独立验证及用户验收为准。

#### 冻结候选独立复核（2026-11-26，替代旧“最新全量未通过”状态，不抹去失败历史）

进度短记（2026-11-26，按时点保留历史；不新增勾项）：

- 上次 2 P1 + 文案 P2 + reconnect P2 四 finding，主控报告已独立 closed；协调者转述 plugin 指纹前缀 66db5604、定向 53/53、pool fixture 隔离 1/1。本轮未独立读这些定向日志；此前“正在修四项”为历史状态，不编作用户授权。
- 真实 Crew 曾见 CREW_LIST_RAW 一行 succeeded、active{} 仍带 next，native-child-gate 将非空 next 当 unreadable。协调者转述分页 core + adapter 初修 92/92，但新 review 的双层 partial/cursor P1 尚未关闭，作者修中；不能用初修绿代替关闭结论。
- 新冻结中间回归：workspace archive/2026-11-26-retire-plugin-runtime/intermediate-regression/20261126-231916-6501-tap.log 本轮独立核读 :4374–4396、:5215–5223，756 tests / 755 pass / 1 fail，0 cancelled/skipped/todo。唯一失败为 v2-pool-anchor-lifecycle.test.mjs:192，坏 pool 预期 Pool compliance refused，却由 missing roster（not a materialized forge subagent）先拒绝；协调者报告作者正按已批准门序修复。typecheck.log 仅载 $ tsc --noEmit、无错误，exit 0 为闸口工人报告/协调者转述；主控已独立读本轮原始日志。本轮未 bundle/pack，不签当前全量或 E2E。
- 搜索验证仍被路径限制阻断；主控排查结论经协调者转述：公开 v2.4.0 未发现 CLI/env/API 的关闭入口，不能 patch 宿主绕过。旧 a8cd71be 产物仅 grep 一腿，不是完整搜索矩阵。
- 旧 a8cd71be 产物的 Plan 完整流程、pinned worker、Goal shell/question 预检由协调者报告；这些不等于新 artifact E2E。旧 747/747 只属于先前冻结候选，不代表后续源码树绿；最终包、完整 E2E/发布/安装/用户验收保持未签收。本轮仅文档记账，未运行测试。

最新候选补记（2026-11-26，232439/232625；以下覆盖前述“修中/未 bundle-pack”的现状口径，失败历史保留）：

- 主控经协调者报告：最终修复 review 均 closed，分页两追加 P1 与 pool 门序亦已独立关闭，迁移 review 无剩余 finding。本轮未独立读取其完整逐断言映射/评审原件；不据转述伪造先迁后删时间顺序。
- 独立核读 intermediate-regression/20261126-232439-6699-tap.log:5207–5215：758 tests、758 pass、0 fail/cancelled/skipped/todo（755 顶层项）；同前缀 typecheck.log 为 $ tsc --noEmit、无错误。typecheck exit 0、canonical natural exit 0 来自闸口工人报告/协调者转述，日志自身未载退出码。主控报告已独立核对 plugin 41b8505...、src 5da40... 指纹；source aggregate=91e861d7163db25fd411ab6b15dd53c7feb8bb94d07960ea0672574541a6c3b7 来自 gate 报告，本轮未复算聚合算法。此前 755/756、747/747 及其他失败/修复记录均保留为各时点历史，不再把 755/756 当最新候选状态。
- 独立读 intermediate-regression/20261126-232625-6750-bundle.log：92 modules；同前缀 pack.json 为真实 pack 清单，0.34.1、entryCount=4。以内存只读 tarfile 核 candidate-tgz-20261126-232625-6750/sorenllm-opencode-forge-0.34.1.tgz：仅 README.md、dist/index.js、dist/forge.schema.json、package.json。包内 version=0.34.1、exports 无 ./server、engines.opencode=^2.0.0、description 为 native worker agents；schema 顶层 jobs/watchdog/dispatch 缺席。tgz SHA-256=fadbd423c682b22029e65ee27124b5fb9b17398467c0a4a1f47348efca904367，包内 index SHA-256=e3ec8e47a38bf183543961f63651fb572e8d6e32a85344d5b186c1813f1e330a，与本次当前 dist 实算一致。静态外部 import 扫描仅 node:child_process/crypto/fs/os/path/path/posix，不把静态扫描冒称运行期全依赖探针。
- 裁定：新 e3ec 候选最低门槛绿，11.1 仍是 candidate 而非最终 0.35.0，不勾。1.16/5.2/9.3 的 review 无剩余 finding 按主控报告记账，但完整逐断言保留/迁移/退役及先迁后删顺序尚无本轮可独立签收的完整证据，仍未勾；不拿 758 全绿替代过程证据，不新增勾项。9.2 既有勾项补充新真实包证据。
- 新 e3ec artifact E2E 正由主控安排复跑，不能继承旧 a8cd 的 Plan/pinned worker/Goal shell-question 预检；搜索仍受路径限制阻断，不 patch 绕过、不勾搜索整项。完整 E2E、发布/安装/用户验收继续未勾。本轮只读既有日志/包并改两文档，未运行测试、构建或 pack。

同 hash 实机局部增证（candidate2，非最终 0.35.0；不新增勾项）：本轮逐日志独立读取 workspace archive/2026-11-26-retire-plugin-runtime/loopback-smoke-driver/ 下列日志，均明载 BUNDLE_SHA256=e3ec8e47a38bf183543961f63651fb572e8d6e32a85344d5b186c1813f1e330a，ARTIFACT_COPY 来自 source bundle 的 dist/index.js，不称 npm 安装终验。

- 6.11 / 11.2⑧：candidate2-crew.log:132–168 原生 general fallback child succeeded、宿主 background-result，crew_close 经真实确认门后 PASS 1/FAIL 0；candidate2-crew-negative.log:214 独立核到不披露 fallback 的 PASS 被拒（native fallback must be disclosed）、crew stays active。仅一项声明/一轮及披露对照，非完整波次/复用/失败/部分枚举矩阵。
- 1.5 / 7.1–7.3 / 11.2⑦：candidate2-shell-stop-3.log:95–145 有原生派发+parentID 双证，停止前 target 与独立非目标 shell 均 running，/forge stop 后 target shell 不再列出，非目标仍 running，SHELL_STOP_SCOPE_PASS；这是该腿实测，不外推完整取消矩阵或所有终态。
- 6.10 / 11.2⑬：candidate2-plan.log:142–180 实际 plan_write draft → plan_approve permission/reply → plan_tick 1/1 → plan_close done，回执明确全部 1 项冻结 check 在宿主重跑通过。仅此 Plan 配方完整链，不升级为所有 Plan 边界验收。
- 6.11 / 11.2⑨：candidate2-goal-wait.log:155–190、:256–359、:367–408 核到 Goal arm 后 shell permission pending/active running；观察窗内 provider counts 3→3、GOAL_WAIT_UNCHANGED true、turns_used 0→0，回复后 shell exit 0、active{}。约 6.5 秒观察窗来自驱动/协调者报告，原始事件亦见 pending 到 reply 时间线；不把有限窗无变动当全部等待/暂停/分钟预算已验。
- 11.2③：candidate2-worker.log:122–146 实际 forge-sandbox-worker 原生派发，孩子 succeeded，孩子被服务的 assistant 消息 model=dummy/dummy-model、variant=low，宿主完成通知到父；pin 证据来自消息而非仅注册 metadata。仍为隔离确定性 provider 的候选链，不冒充真实上游模型质量验收。
- 6.3 / 11.2⑤：candidate2-scout.log:117–146 核到 draft 建立后实际 subagent 创建 forge-sandbox-worker 孩子并 succeeded、回报父会话；孩子工具面快照无 shell/write/edit/question/subagent。该 qualified scout 正向不再只是 before 放行；本轮已独立读，主控在交接时尚未独立读，不混写核验主体；拒绝/续用等其余对照仍待。

后续拒绝、复用、goal_complete 等由主控继续实跑，本轮不据目录里新日志名推断通过。搜索隔离仍 blocked，完整矩阵未齐，1.5/6.3/6.11/7.x/11.2 等大项维持未勾；npm 未发布、本机未更换为候选包（协调者状态报告）。本轮只增两文档证据，未运行测试、宿主、构建或 pack。

2026-11-27 短追加（仅新增局部实证，不勾大项）：以下均为上述 loopback-smoke-driver/ 下 candidate2-*.log，本轮逐日志独立核读同一 e3ec8e47...f1e330a 指纹与原始消息/工具结果；主控已独立读 Goal complete、retry 双终态及 outsider/reuse 标记的范围按协调者转述，不冒称其已独立核所有细节。

- 6.10 / 11.2⑨：goal-complete-2.log:460,494–534，goal_check 实际 shell exit 0；goal_complete 真正确认门、回复后重跑 1 check 通过并关闭，记录 1 attestation。
- 11.2⑭：worker-reuse-context.log:174–179，完成后同 sessionID 续用，孩子上下文同时有原任务与 FOLLOWUP_TOKEN_72，child count=1；running-followup-full.log:117–136，运行中同 ID 追加，release 后孩子实际返回唯一 RUNNING_FOLLOWUP_REPLY_83，父收到完成通知、child count=1。两腿不等于完整 crew 轮次/重复事件矩阵。
- 6.2 / 6.3 / 11.2④⑤：outsider.log:127–131，宿主独立 forge-intruder 调用被 pool 拒绝、child count=0；scout-deny.log:128–130，draft 中 general 被拒并列出 qualified scout 与 plan_approve/discard 出口。仅对应拒绝分支，不勾整项。
- 6.11 / 11.2⑧：crew-retry-unique.log:141,171,197–198，隔离本地 provider 真实 HTTP 400 首次失败，同 child 重试成功、两个宿主 background-result，含两 attempts 的报告关闭 PASS 1；不是上游真实限流/超时证据。crew-retry-double-fail-2.log:142,162,198–199，两次注入 400 后两 attempts 如实关闭 FAIL 1。crew-false-pass.log:135,155,193–208，两失败伪 PASS 被拒（PASS requires verified successful round evidence），随后如实 FAIL 关闭。未披露 attempts 的拒绝亦有各日志 RETRY_MISSING_ATTEMPTS_PASS；不把标记名中的 PASS 误作子任务成功。

上述仅 source-bundle 候选实机增证，不是 0.35.0 最终产物/官方安装终验；6.11、整项 11.2 及其他未满足整条的任务保持未勾。剩余矩阵工人仍在跑（协调者状态），搜索 blocked，有头/发布/本机终验未完成；本轮未运行测试或宿主，未改源码/包。

2026-11-27 证据分层及最小剩余账（不新增勾项）：

- 固定 e3ec 候选：本轮独立核 candidate2-goal-pause-resume.log:463,494,534，goal_pause 保存 SANDBOX_BLOCKER 的实际工具回执，goal_resume 的实际 permission action/reply 及预算 25→27 回执；标记 GOAL_COMPLETE_ASK 在此日志实际 action=goal_resume，不能误称完成门。尚非暂停竞态/迟到事件/重启完整矩阵，亦未凭回执独立证明落盘字节。
- candidate2-readonly-actions-2.log:127–156：真实孩子 read 命中 readonly.txt、grep 得 1 match、shell printf READONLY_SHELL_OK exit 0，孩子 succeeded；没有 write/edit/question 工具面不等于实际写调用拒绝，此日志也不证明 shell 只能执行只读命令。candidate2-cross-pool-2.log:119,121,210–213：B 池 sync 生成 forge-beta-worker.md，B 宿主 registry 实有 forge-beta-worker；A 调该名被 pool 拒绝、child count 0，不再仅是不存在目标的 outsider 对照。两日志及 pause/resume 均内载同一完整 e3ec 指纹。
- 续用/运行中追加、retry/false-PASS 的固定 e3ec 日志已在前一短追加独立核过，本轮不重复膨胀证据；仅声明它们是 scripted local provider 驱动真实宿主、真实 session/tool/permission/notification 记录。注入 400 是本地 HTTP 故障对照，不是实际商业上游超时/限流；模型 token 响应不证明模型自主遵守纪律。
- 旧主控 TUI 留档独立核读 tui-worker-readonly-evidence.json、tui-draft-readonly-evidence.json：worker/scout 孩子消息 model=dummy-model variant=low、succeeded，父收到完成通知；draft 的 general/shellscout 被拒，after_shell_probe 的原生 shell 被 draft 写禁令拒绝。TUI 真正键盘/视觉操作归主控报告，本轮只独立核宿主导出记录，JSON 无内嵌 bundle hash，不把它本身当独立 e3ec 指纹证明。TUI_WRITE 文本当时实际调用 shell，不是 truewrite。⑤ truewrite、⑦ TUI stop 当前待跑；11.3 不勾。

未勾项目分类（“待签”不等于可自动勾；不把未知缺证说成只差签字）：

| 类别 | 条目 / 最小处置 |
|---|---|
| 既有证据整理/历史复核优先，不应先重跑全部 | 1.11 对照探针与设计；1.12 清单及归档残留核对；1.16/5.2/9.3 取回完整逐断言保留/迁移/退役映射与 review 原件，记录已确认的删除后补测过程偏差，现态 review 与过程要求分开；不得把不可逆顺序偏差列为待技术补跑可消除。3.2/3.3、6.1/6.5/6.7/6.8 等先逐验收分支对照既有 fixture/日志，缺哪条补哪条，尚不能统称仅缺签字。10.1/10.2 是文档逐条复核（依赖 K/搜索事实），不是默认缺一次测试。 |
| 已有部分真实证据，仍真正缺适用矩阵 | 1.1–1.8/1.10/1.13–1.15、3.6/3.7、6.2–6.4/6.9/6.11、7.x/9.1：shell 管道/编辑器/分页与只读写拒绝，工具归一/命令身份，暂停/迟到/重启/预算/部分枚举及 goal 治下 crew 等完整时间线，stop 各失效/归属/终态和 ESC 对照，K/L 启停/恢复/工件与升级矩阵、catalog 真 setup；不能因一腿已过整项勾选。具体以各原条目未覆盖断言为准。 |
| 正式阻塞，不是可静默豁免的缺签 | 1.6/8.2–8.4/8.6 与 11.2⑩：搜索正式访问路径限制，公开 v2.4.0 未发现关闭入口的结论按主控调查报告；不 patch/绕过。当前 read-only grep 正向只补一腿，双引擎外链目标授权/环境等价/停用卸载复原仍欠，按 D6 记录缺口、原因、合法补跑条件。 |
| 最终版本/用户与授权门，而非候选再全绿即可签 | 10.5 用户升级前旧作业决定；11.1 当前仅 0.34.1 candidate 最低门槛；11.2/11.3 完整 E2E/有头与最终产物；11.4 0.35.0 发布、官方安装、本机及用户确认；12.x 收尾按原明示授权边界，不因本轮记账执行。 |

最小剩余执行顺序：①先收齐迁移/fixture 旧证据，形成逐断言差额，不重复已签实测；②同一 e3ec 候选只补尚缺⑤ truewrite 和⑦ TUI stop，保留宿主记录+TUI转录/截图+artifact指纹；③按差额合并一套真实 pause/crew 等待与重启/权限/预算/枚举失效、stop 归属与失败、K/L/命令身份多目录矩阵，完成或逐腿 D6，不用局部绿抵充；④搜索仅在合法可达环境恢复后跑缺腿及复原，否则保持正式 blocked；⑤修订与事实相符的现有文档，才安排最终 0.35.0 的新闸口/产物绑定及安装用户验收。后续有源码变化必须重新绑定新产物与适用回归，不把 e3ec 证据转贴为新树全绿。本清单是待执行建议，不是起宿主/改配置/发布授权；本轮未运行测试、宿主、构建、pack，未改源码、不归档/push/发布。

2026-11-27 过程偏差裁定与新 TUI 记录（覆盖先前“历史待核即可补签”的口径）：

- 独立 review agent13e 的 26 套现态审查结论按主控转述记账：5.2 现态实现可签；当前唯一具体 P2 测试缺口为用户自有 forge-sync 模板/description 保留，已委派 test-coder 补 v2 fixture、不改 production。此 P2 尚待补测与 reviewer 关闭，不复述为全部无 finding。当前会话没有 SendMessage 工具，已向协调者索取完整报告；未收到前不编造 26 套逐套结论或冒称本轮独立读取 review 原件。
- 1.16/5.2/9.3 整项仍未勾。原因不再只是“历史签字待补”：重连行为是在删除之后发现缺口并补测试关闭，原文“先迁保留断言并核对，再删”的过程要求已发生偏差；后来的现态实现正确、review 关闭及 758 绿不能逆转时间顺序。应永久保留该偏差与后补关闭事实，现态覆盖与过程遵约分开签收；不是重新跑技术测试就能抹除的债，也不自行改验收标准。
- TUI⑦增证：本轮独立核 loopback-smoke-driver/tui-stop-before-evidence.json 与 tui-stop-after-evidence.json；after 内载 artifactSHA256=e3ec8e47a38bf183543961f63651fb572e8d6e32a85344d5b186c1813f1e330a。before 的目标孩子 ses_de744a180... running 且有目标后台 shell；after 孩子 idle outcome=interrupted、assistant aborted，父收到 state=cancelled 的 background-result，目标 shell 不再列出；非目标及 preflight 两条后台 shell 仍 running。注意 after active 不含 preflight session，只能说其 shell 仍 running，不虚称该 session 仍 active。TUI 点击/键盘执行归主控报告，本轮独立读的是前后宿主记录；该腿已补证但不是 stop 完整矩阵/最终版本 GATE，不新增整项勾选。
- ⑤实际 write/worker 主控报告刚运行，尚待 verifier 原始记录；本轮不因文件名出现即签收，不提前勾。最小清单更新：先收 agent13e 原件归整 26 套现态与过程偏差账，并等唯一 forge-sync P2 fixture/复核关闭；⑤等 verifier 证据，⑦已有本腿前后证据不盲目重跑，剩余只补未覆盖的 stop/等待/权限/K/L 等矩阵。搜索正式访问继续 blocked；0.34.1 candidate≠最终0.35.0，有头完整门/发布/本机验收仍未完成。不归档、不 push、不发布，本轮未运行测试或改源码。

reviewer 原件摘要后续转发（主控/协调者转述 agent13e，不冒称本轮重审）：26 是旧直接入口 suite，分组 2+5+6+7+3+3；相对 f2c8284 的 20 个整删 test files 是另一口径，不混算。

| 旧 suite 分组（tests/，省略 .test.mjs） | reviewer 现态结论摘要 |
|---|---|
| command-surface、forge-commands（2） | 注册/参数/路由/init 有断言；唯一具体 P2 为用户自有退休命令名 forge-sync 的模板/description 保留 fixture，已派补，未签已关闭。 |
| crew-continue、forge-subagents-wiring、goal-mode、hierarchical-pools、partition-wiring（5） | speaker 前后切换、stagnation/delete、坏兄弟、Auto/Crew、queuedGoal 实际续发、pool move/FIFO/IO、scout before→permission 原 effect 有覆盖。 |
| dispatch-cancel、gate-wiring、guard、journal、queue、wiring（6，后五带 dispatch- 前缀） | 容量/breaker/队列/重试/收养/旧 ID 取消按约退役；保留 ask timeout、recursion、pool/PENDING/compliance。 |
| exec-cwd、exec-seal-wiring、headless-gate、job-registry-first-run、job-wiring、shell-spawn-error-outcome、watchdog-wiring（7） | 旧输出/封条/registry/poll/wake/proc watchdog 退役；六门、多目录、runChecks cwd/exit/timeout/frozen 保留。 |
| native-child-gate-wiring、native-child-recheck-timer、native-child-walker（3） | busy 不推进、终态一次、unknown 不 settle、timer cleanup、cursor 编码/空尾/nested 警告保留。 |
| runtime-namespace、search-behavior、search-wiring（3） | 旧工件字节/snapshot 保留；别名/旧工具数/引擎文案退役；授权/去重/hidden/follow/explicit dir/空文件列举有覆盖，但不签搜索实机。 |

明确历史反例：dispatch-hostsignals 旧 :438,465–467 断流重订阅，在旧 suite/server 删除后才由 v2-event-reconnect:24–93 补回并独立关闭；其余仅部分先迁后删可追溯。故上述现态覆盖结论不能转写为原文过程已全部遵守。

⑤ verifier 新回报（主控转述，本轮不冒称独立再审）：tui-write-worker-deny-evidence.json 新 parent=ses_de743862fffeeD4ojMGAmt8qv8、hash=e3ec；plan_write draft completed 后实际 write 带 path/content 被 draft(write) 拒绝、目标文件不存在；写形状 worker dispatch denied、children=0。该局部可记通过，覆盖前段“刚跑待 verifier”的状态，但 6.3/11.2/11.3 完整矩阵仍未签，不新增勾项。

主控后续独立核验更新：主控已直接解析 tui-stop-after 与 tui-write-worker-deny 原始证据，确认 e3ec、目标不在 active/shell list、非目标与 preflight shell 仍 running，以及 write error 原文、children=[]、targetFileExists=false；不再仅归因 verifier 转述。本轮文档工人独立核过 stop JSON，write 原件独立核验主体为主控。唯一 P2 fixture 已补至 v2-session-commands:470–499，定向 21/21（工人报告/主控转述），现已获 reviewer 独立 review 正式关闭（主控转述）：fixture 先于 v2Setup 预置，strictEqual 保对象身份并以字面量断言防原地篡改，同时确认 forge 正常注册；后置 replay 明确只是模拟、不是 E2E。此最新关闭结论覆盖前文 P2 待补/待复核状态，不代表完整矩阵通过；production/dist 未改。

最新刷新全量须单独记失败：本轮独立读取 intermediate-regression/20261127-004437-2404-canonical.log，最终 758 total、755 pass、3 fail；失败为 v2-crew-lifecycle:56（complete declared plan）、:146（transport failure cap discloses once）与 v2-goal-native-wait:137（reused child settle/pause/cleanup）。自然 exit 1、typecheck 0 来自主控转述；此前 758/758 仅历史冻结候选，不能冒充本轮绿。主控另报告 isolated 3/3 仅诊断，不覆盖全量失败；test-coder 已定位 fixed70ms/reads 到达与 issue 同步问题，正仅修两 test 同步、不改 production/不放宽断言，尚待修复后 target/full。bundle 前后仍 e3ec；本轮 src aggregate 报告仅给 5b102bc... 且新增 tests scope 不同，不补造完整值、不与旧 91e861... 直接比较。主控运行 openspec validate --all --strict 为 13 pass/0 fail、定向 diffcheck 通过，均非本工人执行。

新增确认门局部证据按主控报告记账（本轮未独立完整解析）：candidate2-goal-complete-deny/resume-deny 日志显示拒绝后仍 active25/paused25、6500ms provider 6→6；candidate2-crew-close-deny 显示 ask reject、toolCalls error 无 closed 且 crew 文件仍存在。仅局部有限窗口，不替代完整确认/竞态/重启矩阵。最小剩余执行项：修复并重新签 target/full；补未覆盖 stop/等待/权限/K/L 等矩阵；搜索正式访问仍 blocked；已获 npm 0.35 发布/本机升级授权，但待全部适用质量闸口，用户重启验收不能代签；官方安装与用户验收仍待完成，不再询问 routine 授权。本轮不执行这些步骤。

K 正式边界补记（K worker 结论经主控转述；JSON 尚在保存，本工人未独立读取）：workspace archive/native-disable-boundary-20261127/sandbox 全隔离，installed 2.4 的 --version/--help/plugin/debug/serve/agent help 均 exit 0，未激活 serve。CLI 无 disable 命令；官方 config/plugin/source:116–122 的 '-target' 为 remove、:161 显式配置最后处理，agent.disabled 与 plugin 开关独立，不混用。project.ts:429 的 fs.up 无 stop，仍不能保证 workspace 访问边界，故 K 真实矩阵继续 blocked；未换 D 盘或 embedding 绕行，不把 help 探查当真实矩阵通过。

Plan watchdog 局部证据（主控已独立解析日志，本工人未重审原件）：short 1000ms 为 REFUSED 且保持 draft，但旧 pending ask 仍留；zero 2500ms 仍 pending 且 draft，随后 reject 清理。只确认这些有限窗口与清理结果，不推断完整 watchdog/权限矩阵通过，不新增勾项。

D6 增量：本工人已独立读取 archive/2026-11-26-retire-plugin-runtime/native-disable-boundary-20261127/results.json（不是直接位于 workspace archive 根），其记录确认 K matrixStatus=blocked、完整缺项及合法补跑条件；未独立重跑探针或复核每份底层源码。须有公开宿主机制证明全部 discovery/文件访问限于授权 workspace，或用户明示授权完整可读写 discovery 环境，再针对同一 e3ec artifact 补 loaded/agent-only-disabled/plugin-disabled/restart/restore、registry/picker/default、工具门/续跑、生成及手工工件字节、多目录矩阵；不得补丁宿主、embedding/委派绕行或换 D 盘。结果还保留初始 fetch ECONNRESET 与 curl exit 28 历史，未将探查完成写作 K 通过。

Token D6 只读能力核查（主控转述，本工人未独立重读原始两日志）：native-search-baseline/run.out:4 的 CLI step_finish 为 input13024/output86/reasoning96/cache0；:7 为 input333/output156/reasoning59/cache.read12992，但原始缺 host 版本，不能严格绑定 v2.4 或当作 HTTP 聚合证据。candidate2-worker-reuse-context:145–150 的真实 HTTP session/message tokens 在 dummy 下全0；:128/156 after、:134/164 idle 与 parentID 关联及 :175–178 same-child followup 仅证字段/关联/轮次行为，不证非零 aggregate 或轮次计费。maxTokens 只是输出选项、不等于总 budget，未实现 token 预算；迟到/缺失/重复/重启及调用前硬限仍未证，1.8 整项不勾。补跑须版本可归属的真实非零 usage 和异常/重启/调用前硬限矩阵，不能用全0或输出上限替代。

2026-11-27 最终本轮候选记账（覆盖前文仍修/待 review/full 的即时状态，但不删除历史）：

- 闸口时间线保留：20261127-004437-2404 为 755/758、3 fail；20261127-005025-1288 中间 full 758/758、typecheck 0，source 仅获 a59ac...、bundle e3ec 前后一致（主控转述），只是 Goal 后续测试修改前快照，不替代最终轮。本轮独立读取 intermediate-regression/20261127-005256-298-canonical.log:1416–1423，确认 758 tests/758 pass、0 fail/cancelled/skipped/todo、37434.4277ms；typecheck.log 仅含 `$ tsc --noEmit`。canonical 自然 exit 0、typecheck exit 0 以及 source86 前后同值 be31697c164849c859fd5748144f010932f2bebe169b62a50d7f14ee23df8607、bundle 前后同值 e3ec8e47a38bf183543961f63651fb572e8d6e32a85344d5b186c1813f1e330a，按 gate 报告/主控转述记，不冒称日志内载退出码或本工人复算聚合。
- Crew 与 Goal reviewer 均已独立正式关闭（主控转述，不再记 review 进行中）。Crew controlled 150ms 旧 0/2→新 2/2、file 10/10。Goal P2 二次修复：revoke 前冻结 URL 序列起点，仅容许 exact [active]、零 list；Set 内层 finally 释放全部 barrier 并恢复 fetch；受控额外 list 被捕 exit 1，移除注入后 file 18/18。120ms 仅有限观察，不 claim body/tasks 全完成。均为测试同步/断言修复，不改 production，现态 review 关闭不抹除原迁移顺序偏差。
- 新局部宿主证据归因：gate-goal-discard allow→abandoned、deny→active 两日志由主控独立解析；EPE71Z expiry 自动清理 log 与 exists=false 由 verifier 核实，本工人未重审原件。multi-cwd 正向由主控独立核；reverse 的 candidate2-multi-cwd-reverse.log 先 A 后 B sync，主控亦已独立解析 parent ses_de739e36affe7DpNCjV6nC8WQF / child ses_de739de70ffepR2cG1rsG9CFSj 的 parentID 匹配、both projectB，实际 shell completed exit 0、pwd /d/forge-search-e2e-VJpuWH/projectB、hash e3ec、cleanup=true。仅签双方向各自独立隔离 run 内同一 host 两 workspace；两 run 不同 host，不称同一 host 连续互换。这些均不扩签完整 E2E/确认/expiry/multi-cwd 矩阵。
- 版本仍 0.34.1 candidate，非最终 0.35.0；search/K 正式 blocked，token D6 与剩余矩阵保持未完成，发布/官方安装/用户验收不签。相关整项（含 1.8/1.16/5.2/9.3/6.11/11.1/11.2/11.3）不新增勾选。最新 target/full 与 review 已补齐本轮测试同步问题，前文最小清单中的此待办现已关闭；剩余只补未覆盖矩阵/边界，再按授权处理最终版本及发布安装用户验收。本轮仅文档记账与 strict validate/格式检查，不重跑测试、构建或 pack。

六门确认/超时局部矩阵增量（主控转述 verifier 完整核结论；新十条 short/zero 另经主控独立读取，本工人本轮未重审原始日志）：Plan approve、Goal arm/complete/resume/discard、Crew close 六门均已有 allow/deny/short/zero 对应证据；仅汇总各日志实际断言，不据此签完整整项。新日志位于 loopback-smoke-driver/gate-{arm,complete,resume,discard,crew}-{short,zero}.log，Plan 沿用旧名。verifier 已逐项核目标 key、WATCHPASS、artifact e3ec、root delete，未见 STOP_ERROR；complete/resume/discard 前置 GOAL_ARM_REPLY_ONCE 已核，不把 prerequisite 的确认混作目标门。

short：具体 gate-watchdog key 对应 REFUSED，arm 无文件（pending 同时有 shell，仅局部 nofile/拒绝，不证明 stable idle）、complete 保持 active、resume 保持 paused、discard 保持 active、crew 文件保留；Plan 仍 draft。zero：仅 2500ms 有限窗口内 running/pending 且对应状态不变，随后 reject 清理；各 run cleanup/root deletion 已核。超时 short 的旧 pending ask 可残留，不能称已消失；late click 未测。多目录确认门矩阵、Goal-governed Crew 两项免 ask 分支均未做，不扩签；verifier 后续 Goal/Crew 核查未出结论部分仍待补。search/K blocked、版本 0.34.1、发布/最终安装验收及其余历史偏差边界不变，不新增勾项。

Goal paused restart 局部证据（主控已独立解析 candidate2-goal-restart.log，含实际 tool/status 与新 host 加载；本工人未重审原件）：artifact e3ec，owned 旧 PID54780 taskkill exit0→新 PID54344，同 root/原 session ses_de733ddaeffefgBUjgWPcQ3GYT，GET location 相同。activated location 后 7s provider 6→6，Goal SHA-256 前后同为 0edbf423b7b71e8d938b82c4bfe43ce7adbe076bba8f5fc81f8beb99fa0f108d、messages unchanged、active={}，paused blocker SANDBOX_BLOCKER 保留；显式 goal_resume ask once 后 active、max25→27，root removed=true。仅签暂停跨真实重启有限窗口，不扩 late events/最小预算或完整重启矩阵。

README 最终定点签收：五项 finding 及 :677–681 窄 user-entered commands 范围措辞均经独立 reviewer 正式关闭（主控转述）；纠正 gate 并行报告里的旧待 review 状态。早期 README f5bf...及 d617 中间包不代表当前文案，不逐包追加状态。本工人已读完整当前 README，逐条件核对旧执行面/作业/进程看门狗/封条/派发引擎章节退役（历史、升级/卸载说明及丢失保证保留），shape/原生派发/搜索/stop/config 已改写；FORGE_GATE_ASK_WATCHDOG_MS 的 gated-ask 完整段落与 git HEAD 字节相同，不把保留确认门 watchdog 当退役进程 watchdog 残留。10.1 据文案条件及 review 关闭签收；10.2 仍因 K blocked 不勾，不扩签实机矩阵。

最终对应包 candidate-tgz-20261127-010248-1991/sorenllm-opencode-forge-0.34.1.tgz 已由本工人 Python -I 内存只读 tar 独立核验，主控亦独立对账：恰四文件 README.md、dist/index.js、dist/forge.schema.json、package.json；包内 README SHA-256=f03ef51863438b52c8f124fc95abaeba9fd1e114ae31f7263e09d875d323fba2、index=e3ec8e47a38bf183543961f63651fb572e8d6e32a85344d5b186c1813f1e330a、schema=68677e3bc63fab1ad9f4a1089abecef2cf993ab2023be15c369f0816422dd6b9，三者均与当前树字节相同；manifest version=0.34.1、仅根入口与 schema.json 两项 exports、无 ./server。tgz SHA-256=6036f5bab4968e4e928f937deb2ae4b02e8b1aa951349c09d0dcda789e9e1f09，shasum=54d8beb6855d21dd3ff63bf5d2d0e393f19097d9，integrity=sha512-6nEQ2IxlyymBeD9XvlO27JJexyJI5hXaT81GmzXhtimdLJzlJ+6Soh9rcGnuZiu2ZB5hlw03dJv9lprnSrf5yQ==，均独立实算。intermediate-regression/20261127-010248-1991-pack.json 的四文件/shasum/integrity 与实包相符；dry/actual exit0 按 pack 工人报告/主控转述，不冒称 JSON 内载退出码。旧 tgz 仅历史快照、不代表新 README；runtime bundle 未变，未重跑测试/构建/pack。版本仍 0.34.1 candidate，不称 0.35.0，不签发布/官方安装/用户验收；search/K blocked、其余未完成及过程偏差均保留。

Partial-wave 局部签收（主控转述 reviewer 正式结论，主控亦已独立解析 raw；本工人本轮未重审原日志）：candidate2-partial-wave-2 的旧 expect1 fail 保留，属 fixture 将 settle once 误作此后 7s 全程 only once；:176 父完整消息中的三 brief 分别由不同 parent idle 后 2017/2019/2017ms 触发，首条有 child digest，后两条是纯文本/no activity 后的新 idle，非同一 terminal 重放；未见最终 stall 告警，不能签 stall 停机。candidate2-partial-wave-3 经 reviewer 独立核 :151–160 为真实两 child、首 success 另一 running，held6500ms brief0→0、req10→10；:165–172 释放第二 child 后有两 native completions，held 首次 parent response 为一次 continuation，没有混计后续父 idle，root deleted。仅签部分波等待与单次恢复有限观察，不签 crew closed/full lifecycle。预算首 turn run 误 ask 未进入 idle、首 minute run 误 hold parent 的失败 fixture 日志均保留，不删除、不改写为产品失败；修正实跑的局部结论见下段。

Goal 最小预算局部实测（主控已独立解析原日志，以下按主控报告归因；本工人未重审原件）：loopback-smoke-driver/candidate2-goal-turn-budget-2.log 对应 e3ec，max_turns=1、turns_used=1 后 paused、stop_reason=budget-turns；消息为一次 normal continuation 后一次 handoff-only wrapup，root removed=true。candidate2-goal-minute-budget-2.log 的 armed_at=2026-11-26T17:08:20.929Z、updated=17:09:20.931Z，自然经过 60.002s；before active/max_minutes=1/used=0，after paused/budget-time/used=0，provider5→5、permissions=[]，同一真实 child 仍 active/running（accepted work 未取消），root removed=true。仅签本候选 turn1/minute1 的上述局部预算转换及观察，不扩签所有预算 race、调用前硬限、token 总预算、Goal/Crew 组合或完整生命周期，不新增整项勾选。

Goal-governed Crew 与 stop 本批局部签收（主控已独立解析 raw，以下按主控报告记账；本工人未重审原件）：同 e3ec 的 candidate2-governed-{report,abandon}.log 为 active goal + born armed，实际 crew_close completed，分别 closed PASS1 / ABANDONED，无 pending、无新增 crew_close ask，root removed=true；仅覆盖这两免 ask 分支，更新前文尚未做的即时状态，不扩签 Goal/Crew 全矩阵。candidate2-governed-{report,abandon}-deny-2.log 外层 CodeMode completed，但内层 Unknown tool crew_close、error=true/toolCalls=[]，close 未执行，不是插件执行后拒绝；GOV_DENY_CREW_FILE 未写关闭/放弃段，Goal 仍 active（没有 byte hash，不能称全文件字节不变），root removed=true，exit0 来自 worker 报告而非本工人日志核验。首 deny 脚本误预期成功导致 exit1/STOP_ERROR 的历史保留，既不是 production 失败，也不是免 ask 成功。

stopempty-2 的 children-before 为完整 empty、next=null，实际 receipt 为 No native children、active={}，root removed=true；首 empty fixture 意外派 child 的历史保留，不以重跑抹除。unknown-scope 通过公开 session create 设置真实 parentID，但父 before messages=[]、无 native dispatch 证据；真实 child held/running，stop 后同 child 仍 running，receipt 明示 child scope not confirmed，root removed=true。仅签空枚举及仅 parentID 不足以确认 scope 的这两腿，不扩签 fault enumeration、late events、所有归属/取消失败路径或完整 stop 矩阵。预算两腿另获 reviewer 独立正式签收（主控转述），仍仅有限观察，60.002s 是该次实测而非普遍时延保证。相关整项在全部条件满足前不新增勾选；search/K blocked、发布质量门及用户重启验收边界不变。

stopdegrade2 局部降级证据（e3ec，主控已独立解析 raw；本工人未重审原件）：实际 owned descriptor 已备份后改为不可达 loopback，出现 ECONNREFUSED，属本地注入、不是用户故障。native child 从 running 经 ctx interrupt confirmed/cancelled，raw actual host active={}；receipt 同时披露 shell enumeration unavailable/remaining unknown、active enumeration unavailable/terminal unknown。先 confirmed interrupt、后 interrupted=false 的各阶段记录均保留，不把 confirmed 请求、cancelled 或实际 active={} 当任务 success，也不抹去最终未知披露。exit0/root removed=true 来自 worker 报告；首次 degrade regex 误判 exit1 的 fixture 历史保留。仅签该注入下的中断与保守披露，不覆盖其余 fault enumeration、late events 或完整 stop 条件。reviewer 已独立正式签收 stopempty/unknown-scope/governed/deny 上述局部（主控转述），不新增整项勾选。

Probe J 局部事实（主控已 raw marker 核对，按主控报告归因；本工人未重审原日志）：loopback-smoke-driver/candidate2-identity-unknown-2.log 中，build 以及通过合法 API 保存的 nonexistent 身份，四命令均为 HTTP500 guard、session messages 空；两批结束后 .opencode 名单仅预置 forge.json，不声称零读写或文件 hash 不变。forge 身份的四命令均 HTTP204，实际模板已投递，forge_sync completed 并生成 worker。restricted：驱动配置了 shell:deny；该受限配置下四条命令投递、sync 实际完成；无实际 shell 尝试或运行时 deny 证据，不称真正 shell 拒绝已验。build 的 stop 例外复用 stopdegrade2 既有局部证据，不另称本日志证明。catalog 差额已补：candidate2-identity-catalog.log 在同 host/location 下以 build/forge 各自真实 session 普通提示取得 provider 原始 CATALOG_CAPTURE，各含14个完整工具定义；主控独立 parse 两份、按名 sort 后 assert.deepEqual 通过，证明仅本 fixture 下实际定义相同，不外推其他权限配置/版本。cleanup=true、exit0 按工人报告记；本工人未独立解析该原件。review 已发现上述证据措辞 P2，本轮据此收窄；reviewer 已独立核14项完整 catalog 相同、真实 sync 及 stop/governed 措辞一致（主控转述）。reviewer 已定点复读 tasks:231/audit:566，正式关闭本次措辞 P2，本次局部范围无 open finding（主控转述）；不签完整 Probe J、11.2、11.3 或 release，不新增整项勾选。仅记上述身份/路由局部事实，不新增整项勾选，不扩签完整 Probe J 或其他未完成矩阵。

Goal-governed 状态退出局部签收（主控 raw 初核，reviewer 已正式签 pause/discard/complete 三条局部，按主控转述记；本工人未重审）：candidate2-governed-{pause,discard,complete}.log 的 actual arm once/born armed 与 paused/abandoned/completed 转换已核；pause 本身无另一次 ask，不能把前置 arm ask 混作 pause ask。6500ms 限定窗口无 standalone continuation、provider7→7/messages unchanged/active={}，随后新 general 实际拒绝，empty tail 无 child，cleanup 已核，exit0 仍按工人报告记。仅签上述有限窗口，不当无限保证。新增 candidate2-governed-budget.log 由主控 raw 初核：未写盘干预、自然耗尽 max_turns1/used1 后 paused/budget-turns；窗口 provider7→7、deepEqual、active={}，actual general error、kids=[]/next=null、cleanup=true。budget reviewer 已正式局部签收、无 finding（主控转述）：actual arm once + born armed 在先，driver 仅轮询、不写盘或调用 goal_pause；一次 goal-continue 后一次 handoff-only goal-wrapup，ledger 仅 turn1，wrapup 不是第二工作轮。6500ms 窗口基线已含 wrapup，provider7→7、完整 before/after 一致，new general error/empty tail 已核。仅签上述局部，不覆盖 minute/reuse/late events/restart，不新增整项勾选或扩签完整 Goal/Crew 生命周期。

D6：stop child partial/truncated 的 real-host 腿未执行（只读 worker 结论经主控转述，本工人未重审源码）：plugin.ts:4736–4740 优先原生 ctx.session.list，仅 throw 才 descriptor fallback，现有自有 descriptor 代理无法作用于优先通道；shell 解析 array 标 partial 不构成 child partial。未启动新 host/注入，未改 host 或做内部拦截（超本次授权）；已有 stopdegrade2 unavailable 不能充作 partial。合法补法为公开 host 实际提供 partial 条件，或明确授权相应测试能力后，补原始响应、receipt 与独立 host 副作用核验。保持未通过、不新增整项勾选；readonly worker 实写后续局部签收见下段。

Readonly 实写局部签收（主控已独立 parse candidate2-readonly-write-probe-2.log，按主控报告记；本工人未重审原件）：reviewer 已核真实 readonly 配置与 native child 归属，两次 actual catalog 各22项、均无 write/execute，actual child 的 write attempt 带 input path/content，executed=false、state=error，原文 No tool named write is currently available...；target exists=false、cleanup=true，exit0 来自工人报告。这是 host 未暴露工具而拒绝，不是工具执行后的权限拒绝。首版 candidate2-readonly-write-probe.log exit1、未发送 attempt 的 fixture history 保留。独立 reviewer 已正式签上述局部（主控转述）。driver:38 对全消息匹配 denied 可能被目标名满足，不能依靠其 PASS；本次主控/reviewer 独立 parse 真实工具 error 的结论有效，driver 精确断言现已获独立 review：原 raw 正例匹配，删除 state=error 但保留 denied 文件名的负例不匹配，driver 缺陷正式关闭；这是 raw 断言复核，不是新 E2E，未重跑 host。首版失败历史保留；不新增整项勾选，不扩签全部 readonly 权限矩阵。

Init 身份/模板局部签收（candidate2-init-identity-2.log，主控已独立 JSON parse；本工人未重审原件）：build/unknown 的 init/init global 各 HTTP500 guard、messages empty；forge 实际 user 模板已投递，含 REFUSE/review/NEVER overwrite/explicit go-ahead 等纪律。全隔离 home 的 global 与 workspace 均预置 ASCII recipe（含换行），before/after bytes 与三个采样目录的条目相同，经 reviewer 局部签收；cleanup=true、exit0 来自工人报告。reviewer 已正式局部签收 init/init global guard 与新 user 模板实际投递（主控转述）；仅证模板纪律，不签模型实际执行审阅、mechanical 写 gate 或 recipe 不存在后 consent 写入创建。首版 mkdir ENOENT/exit1 的 fixture 历史保留，不新增整项勾选。

Upgrade 首轮局部签收（candidate2-upgrade-{manual,auto}.log，主控已独立 parse，reviewer 正式局部签收，按主控转述记；本工人未重审原件）：初始 load 的 BEFORE/AFTERLOAD 快照未变，manual 的 BEFORE_SYNC 亦相同；AFTER 的 worker bytes 改变、marked gone 删除、无 marker 手写文件 bytes 相同。默认 dispatch 先命中 orphan stale 拒绝；manual 实际 forge_sync updated/GC 后 retry child succeeded。auto host log:61–62 明示 stale roster regenerated at session start，created0/updated1/GC1，早于 :113 provider subagent；首次 dispatch 前已修复，不是 dispatch 触发 auto 更新。mtime 仅 recipe 与 worker 相同，不含 orphan/手写文件。default/manual/orphan 路径正式局部签；首轮不能证明 projection 检测。后续 candidate2-upgrade-projection-{manual,auto}.log 已由主控独立 parse（本工人未重审）：BEFORE 无 gone，recipe/worker mtime 同为1704067200000；AFTERLOAD unchanged，后续 worker 升级、handwritten same，manual error 明确 compiled differs what compiles to，auto 在 session start updated1/GC0，cleanup=true。该无 orphan 对照已获 reviewer 正式局部签收、无新增 finding（主控转述）：同 e3ec，manual 实际 differs 拒绝/empty kids/前字节保留，实际 sync updated 后 retry succeeded；auto 在 session start created0/updated1/GC0，首次 dispatch 前修复，手写文件 same。两 host exit0、roots removed=true、无 running host 均按 worker 最终报告归因。不扩签 global fallback、override 或完整 upgrade。不新增整项勾选或扩签升级兼容完整矩阵。

Global upgrade 局部签收（candidate2-global-upgrade-{manual,auto,handwritten}.log，e3ec；主控已独立 parse，以下按主控/worker 报告归因，本工人未重审原件）：全隔离 global recipe、无 workspace pool，含实际 config agent；三 run 的 BEFORE/AFTERLOAD deepEqual，oldSibling before/after deepEqual，后续 worker 改变；generated general/explore 改变，handwritten 同名文件不变。worker 报实际 manual sync updated3，auto session start worker1 + override2，handwritten collision refused、只更新 worker；cleanup=true/exit0 均按 worker 报告记。reviewer 已正式局部签收三腿、无 finding（主控转述）：default/manual worker differs 拒绝、kids 为空，并单独披露 stale override；实际 sync 更新3。handwritten 为逐文件 collision，不等于整次 sync 失败，worker 重试 success；auto 在首次 dispatch 前更新 worker1/override2。sibling 仅签 bytes/list 保留，不称底层未读；worker policy 隔离仅签 generated 声明/prompt，不签 runtime general/explore 权限。早期 driver 换行 syntax failure 已修，保留为 fixture history，不作权限 D6。手写 auto 已正式局部签收、无 finding（reviewer 结论经主控转述）：candidate2-global-upgrade-auto-handwritten.log 经主控独立 raw JSON 核 BEFORE/AFTERLOAD equal、general/explore before/after 相同、oldSibling 相同、worker changed；实际 host session start worker updated1，override collision updated0/GC0，cleanup=true，exit0 按工人报告记。reviewer 已核 session-start worker updated1、override collision updated0/GC0，actual childID/parent/location 匹配 forge-global-worker、outcome succeeded，handwrites/oldSibling 相同；本工人未重审原件。不签 general/explore runtime 权限/卸载，不扩签完整 global/override/upgrade，不新增整项勾选。

Native followup/reuse 正式局部签收（主控已核 raw markers/child context，reviewer 已正式局部通过，按主控转述记；本工人未重审原件）：旧 e3ec candidate2-running-followup-full.log 为 running 时同 sessionID native 追加，实际 running/accepted，child context 含原任务 + followup + reply，host notice 含 reply，child count1；运行中追加为不同 parent message、同 callID 且同 child，实际 reply/notice/1 child 已核，不能以此声称唯一一次调用。新 e3ec candidate2-worker-reuse-quote.log 在实际完成后由 callprobe2/3 同 ID 续发，child context 有原 marker + FOLLOWUPTOKEN + QUOTED 回复、host 两 round notice、child count1；两轮两 notice 以 child messages 及父两条不同 msgID、source=subagent/state=completed 核实，不按 REUSE_PROVIDER_CONTEXT_CONFIRMED 计数（该 marker 也会在 parent 触发）。新 run exit0/cleanup=true 按 worker 报告记。确定性 scripted provider 仅证明上下文/宿主轮次链路，不证明理解能力；不签 Crew 重复轮记账，不新增整项勾选。

Governed reuse/pause 正式局部签收（candidate2-governed-reuse-pause-4.log，主控已 raw assert，reviewer 已正式局部签收，按主控转述记；本工人未重审）：reviewer 已核真实 arm/born armed/child complete/goal_pause completed、max50/used0 后的 same-ID reuse error；CHILD_BEFORE/AFTER 完整 JSON 相同，CHILDREN 相同且仅1；callgov5 的 native same-ID reuse 实际 error Autonomous work refused，真实 Goal file 为 paused/blocker、max50/used0。cleanup=true/exit0 按工人报告记。前三次 exit1 与 cleanup 记录保留：首 run 模式错误、无 roster；2/3 实际 Goal 已 paused，与失败断言矛盾经 reviewer 独立核实；旧 regex 具体误写的历史代码归因工人，不伪称 reviewer 看过旧版本代码。2/3 未执行 reuse，不能写作产品未 paused。第4次在主控 stop 消息送达前已完成，不再跑。仅签上述第4次局部，四轮历史保留，不签 running reuse/其他 lifecycle/restart/late events，不新增整项勾选。

Governed minute-cross 正式局部签收（candidate2-governed-minute-cross.log，固定 e3ec；主控已核 raw MINUTE markers，reviewer 正式局部签收，按主控转述记，本工人未重审）：actual arm max_minutes1/max_turns50、born-armed crew + general child held/running；armed_at17:52:01.276→updated17:53:01.279 自然60.003s 后 paused/budget-time（未改盘按 worker 报告归因）。arm→updated 为60.003s；MINUTE_BEGIN→EXPIRED 实际采样55.920s，used0→0/provider8→8 仅指该采样窗，不从 arm 起算。实际新 fallback native error，active 仍见原 child running；children 查询仅返回页1原 child，但 next 非空、未翻页，不能称全量列表或证明无其他孩子。不称 child cancel 或 wrapup。单 host exit0/cleanup=true 按 worker 报告记。prep anchor error 在 host 前已修，仅 fixture history、非 D6 阻塞；只记该次有限观察，不作普遍时延保证，不新增整项勾选。

Crew reuse-wave review 分类（candidate2-crew-reuse-wave.log；review 结论经主控转述，本工人未重审）：唯一 host exit1、cleanup=true 来自工人报告；为独立 Crew PENDING→waves，非 born armed。首 brief1，same-child round2 pending6500ms 内 briefs1→1/provider13→13。driver includes SECOND 会匹配 SECOND_DONE 完成通知，高度支持 release 后父请求被误 hold，但 raw 无归属、不能坐实。release 后7秒 snapshot 仍1 brief，无 parent reply/idle，active 仅在 release 前查询，不能称父 idle 等待7秒。虽有两 native completed，second settlement 仍未建立，不以 completed 充 settlement；保留未通过，不写产品 bug，不作权限 D6 阻塞。worker 修精确单次 child hold、回包不含 trigger 后已重验1 host：candidate2-crew-reuse-wave-2.log 经主控 raw 核，e3ec、same-child round2 accepted/running，6500ms 窗口 brief1→1/provider13→13；release 后 ROUND_TWO_COMPLETE host notice→真实 parent idle timestamp + active={}→新 brief 含该 child succeeded digest，brief1→2，以 parent held 隔开 ordinary idle。cleanup=true/exit0 按 worker 报告记；本工人未重审原件，reviewer 已正式局部签收（主控转述）：exact-once hold 实际成立，6500ms 内 brief1→1/provider13→13；第二次 notice→parent assistant→idle/active={}，2014ms 后新 brief 含该 child succeeded，随后 hold 父请求以避免 ordinary idle 混计。children 返回页含该 child succeeded，但 next 非空且未翻页，不称全量无新 child。原 exit1 历史保留，不能定性 product bug；仅签该局部，不签 duplicate event 或完整 Crew，不新增整项勾选。

Goal 停滞两腿正式局部签收（独立 reviewer 已实际签收、无 finding，按主控转述记，本工人未重审原件）：candidate2-goal-stall-{empty,read}.log 与 goal-stagnation-probe.cjs，固定 e3ec，两 run exit0/清理=true。A：真实 arm→恰两次 continuation 纯 text、无 tool→paused/no-progress，turns_used2，ledger 两条 activity=no/writes0/checks0；另一次 handoff wrapup 不算第三工作轮。B：首两已结算 round 实际 read completed、读取自有 fixture 且同输出，ledger 两条 activity=yes/writes0/checks0；snapshot 为 active/turns_used3，第三次 continuation/read 已发生，但仅两轮结算 ledger，不把第三轮当已结算。驱动只预置 read fixture、观察/read poll，无代写 Goal。仅签上述有限停滞观察与 read 反例，不签重复 check、新信息判定或长期行为，不新增整项勾选。

Goal 重复 check 新增未通过验收（按主控/worker 交接记，本工人未重审原件，不覆盖上述停滞历史）：candidate2-goal-check-repeat.log，固定 e3ec，真实 execute→tools.goal_check items[1] 连续10次相同输入/exit0 GOAL_CHECK_OK；Check Log10、ledger10 activity=yes/checks1/writes0，snapshot active/turns11，driver exit1/expectation not met，cleanup0/remove=true。这是实链规范不符、待定位，不能记通过或作访问 D6。execute 外层误记活动仅为源码假设；observer 未记录 execute，尚未证实。candidate2-goal-check-changed.log exit0，2→1→2 不同项与输出、三条 ledger=yes，仅有限正例；wrapper 混淆未排除，不签检测正确。两 host 均清理，主控正派单 host 扩 observer 核因，尚无结论，不新增整项勾选。

2026-11-27 Goal CodeMode 修复集中 chronology 与 stop 局部签收（以下归因主控 raw 核验/独立 reviewer 结论及工人报告；本工人本批未重审原件或重跑，前段未通过事实保留为历史）：

- 原重复 check 已获独立 review 正式 P1 生产缺陷判定：第11续轮 compaction failure 不能解释此前10条已结算错误 ledger；同 e3ec 的 observed.log 再失败，观察到10 inner/10 outer check + arm outer，inner 先、outer 后，同 messageID 异 id，含真实 content text parts 与 output.toolCalls。原 source 红例复现第二轮 activity=true、期望 false，不再仅留最初未证源码假设。首修定向55/55、全量761/761、typecheck/build/pack0，仅对应中间 bundle36dedbd59791906eefe3fe731bcdf43b9288eafe5a18740ed4fc3f8b3fbbe954；intermediate-regression/20261127-021535-1281-typecheck、021542-1628-canonical、021626-1138-bundle、021632-1758-pack 各 .log 为该轮历史。review 随后发现缺 outer/seen-id 冲突2P1及 error/input 负例，退回未签、不能冻结；pure6 tests/1pass/5fail、wiring 缺 input 1fail 均保留。
- 返工 intermediate-regression/codemode-activity-retest-20261127.log 为61 tests/59pass/2fail、exit1：recognized npm test truncated 仍 other，P2 后修 uncertain；旧 completion fixture 无真实 result 却期待活动，补 fake-runner 真 check output、保留 activity=yes，单 test 通过。四原 CodeMode finding 静态闭合后，经最后 P2/fixture 窄复审与 codemode-activity-retest-p2-20261127.log 61/61 exit0，仍不当 whole 签收。随后全量20261127-022308-646-canonical.log 为767/766/1fail，native-wait:192 actual1/expect2；022300-1629-typecheck exit0，build/pack 未执行。通用 dedup 被未知事件先占 native id 引入回归，修为先 accepted 证据再登记、unknown 不占；review 窄 closure，codemode-native-wait-retest-20261127.log 三文件79/79 exit0。
- 最终本轮 gate 四项 exit0（主控报告并已核 raw）：intermediate-regression/20261127-022559-1852-typecheck.log、022606-732-canonical.log、022653-649-bundle.log、022659-1157-pack.log；767/767，零 fail/cancelled/skipped/todo，40668.9262ms。bundle SHA-256=5798a04452b0cb003efd8cc020f2518aa3d9f936659b8153f85a6687e78dc941，schema68677...不变、version0.34.1；pack dry-run 恰4 files、shasum3a81ff6333f98e6bb461049ab4aa4bfaf6ec805d，仅 dry 清单，不是实际 tgz 核验。旧 e3ec/6036 实包及其实机证据不转贴为新 bundle 完整验收。
- candidate3 repeat/changed 已由主控 raw parse 并经独立 reviewer 实际局部签收：5798 bundle、normal wrapper 实际 arm ask/reply204/arm completed。repeat 三次 same check completed，Check Log3、ledger yes/no/no（checks1），paused/no-progress、turns3；一次 handoff wrapup 明示 Repeated identical，不是第4工作轮。changed 前三项 #2→#1→#2、三条 yes，active/turns4，第4 outer running；仅签不同项，不签同 input 的 output 变化。均为条件触发 snapshot，不称额外静置窗；driver exit0 按 verifier 报告归因，taskkill0 仅 cleanup、非自然 host exit。原 P1 复现场景可局部关闭，不扩 whole6.11；第三 same-input/result-change host 正跑，尚未签。
- 旧 e3ec candidate2-stop-two-child.log 已获独立 reviewer 局部签收：单 build、无 Goal/Crew，双 native completed metadata running + parentID + active，A owned shell，一 command204；receipt1/2 cancelled 同 t3077→parent assistant3086/idle3101→receipt3515→assistant3523/idle3536；返回后5s窗口双 interrupted、active={}、shell=[]。raw cursor GET 空 tail/next=null 完整走完，仅据 raw 签收、不逐通知归因。driver empty page 带 next 可能误 complete、DONE 未 assert 的 fixture 缺陷修中，本 raw 未走捷径；不称 duplicate event/完整 stop 通过。

仅上述局部与候选 gate 进展，不新增 whole checkbox；保留所有失败/中间绿/返工历史、1.16/5.2/9.3 顺序偏差，search/K 仍 blocked，发布适用质量门/官方安装/用户重启验收未签，版本仍0.34.1。

Candidate3 same-input/result-change 第三腿已获独立 reviewer 实际局部签收（主控已核行为，以下按主控/reviewer 交接记，本工人未重审）：resultchange-2 在5798 bundle、normal wrapper 下，同 items[1]/command 三次 completed 输出 A/B/A，前三已结算 ledger3 activity=yes/checks1，active、snapshot turns4。随后第四次 inner/outer 又 completed RESULT_B，但没有第四条 ledger file；不能称 counter3 为终值，也不能写第四次仅已起。只签前三结算的新结果进展，不签整体 Goal。driver exit0 按工人报告记，不由 taskkill 证明；实际 cleanup128/root removed=true，后续只读 CIM 对所有日志 owned PID 及父集合为空，root/port 命令行仅查询自身、未见当前 owned 残留（verifier 报告），不倒推原 cleanup 成功或原因；原 UTF8/GBK 字节未保留，不能确定确因，不猜 denied/race。首 result-change run 的 fixture wrong 保留：--changed 交替 items2/1 而 Goal 仅1项，exit1/cleanup=true；三次有效同命令 node check counter A/B/A，但六 ledger no/yes/no/yes/no/yes，不签连续三 yes，非产品 bug 或访问 D6。仅局部签收，不新增整项勾选。

Candidate3 unknown check 正式局部签收（candidate3-goal-check-unknown.log，5798；独立 reviewer 已实际局签，主控已 parse，以下按交接记，本工人未重审）：六次同 items[1]/command completed，5000X 输出实际显示2048X + …，无 comparable；outer truncated=false 表示已截断 check 的完整传输，两层不矛盾。六条 Check Log exit0、六 ledger no/checks1，active/turns7；no 仅 ledger 布尔值，不作确认无活动或进展。第7 continuation 后 compaction failed/idle failed，无第7 completed/ledger。driver 误继承 changed yes 断言导致 exit1 的历史保留，不改 PASS，非产品失败或访问 D6；现 unknown 独立断言与 node check 已修，offline 原 raw=true、删除截断=false、改 paused=false，仅离线复核，未新 host、不改 raw。cleanup0、原 bytes base64 正确 GBK 解码、stderr 空、root removed=true；不据本局部扩签整体，whole6.11 仍不勾。

双项目 gate/late 本方案失败 chronology 与未执行缺口（固定5798，按主控/worker 交接记，本工人未重审原件）：准备期生成 who 未定义；offline 误跑复制版缺 artifact，已创建 root 清理，均为 fixture history。首单 host candidate3-gate-two-project-late.log 遇 execute unavailable/provider callback throw 绕 finally，未 ask；原 PID15840 taskkill128/not found，后经 CIM 直接定位 owned child56948、taskkill0/root removed=true，cleanup.log 保留原 bytes，不倒推首次 cleanup 成功。该 raw 缺 catalog，session/prompt forge、cfg 与成功 fixture 相同；agent 初查 data=[] 早于 plugin load 的时序差异未证因果，不写产品缺陷。driver 后补 catch provider error 入 finally 与 catalog 记录，离线4 routes/6 negatives 通过，不当实机验收。

最后一次 candidate3-gate-two-project-late-2.log：5798 注册 forge 成功；首 provider toolsPresent=false 被 driver 当 error，后续实际 catalog 含 execute，A plan_write completed/draft。主控保首错退出，B 未建，双 ask、reject/late once、B once 均未执行；不能称 host 始终无 execute 或产品 bug。cleanup PID57184 tree exit0、保 bytes/GBK、root removed=true。该方案3次尝试上限已到、停止，不第4次；缺口属 driver 缺陷，不作权限 D6，重新安排前须先区分无 tool 辅助请求与真实工具请求。相关矩阵保持未通过，不新增整项勾选；已有授权与发布质量闸口不变，本轮无 npm 发布、本机升级、commit/push/archive。

主控报告已 Ctrl+C 正常退出专用 TUI、用户原 tab 未触碰。历史顺序偏差仍保留，整项 1.16/5.2/9.3 不勾。

本轮只编辑 tasks.md 与本既有报告；未运行测试、构建、pack 或宿主，未改生产源码/tests/package/dist。证据根为 workspace `archive/2026-11-26-retire-plugin-runtime/`。

### 2026-11-27 业主本轮收窄验收与发布准备授权

用户明确「提，可以闭环了，git push npm提交本地拉最新插件」，接受此前已披露未覆盖项，授权 commit/push/npm publish/本机官方安装。本决定覆盖历史段落中以旧未覆盖项一概禁止本轮发布的即时口径，不改变规格，不把 search/K blocked、stop partial、双项目 late 缺口、Token 未证与先迁后删过程偏差写成已通过；失败历史、D6 原因与合法补跑方式继续保留，未满足整条的 tasks 不勾选，不 whole-check、不 archive。

本工人只执行发布准备：版本0.35.0（lock 历史根版本0.27.1仅同步版本）、typecheck/canonical npm test/bundle/pack dry-run及真实tgz、只读范围核查。证据位于 workspace archive/2026-11-26-retire-plugin-runtime/release-0.35.0/；不 stage/commit/push/publish/本机安装，不改配置、不读取npm token。最终实包E2E由主控另派；用户重启及重启实测未发生，不能代签官方安装终验或用户验收。授权与实际执行/验证结果严格分开。

本工人本轮实际准备结果：release-0.35.0/commands.json记录typecheck、canonical npm test、bundle、pack dry-run/actual五命令均exit0；全量767/767、零fail/cancelled/skipped/todo，39715.8359ms，stdout/stderr完整分档。source-before/after完全一致（plugin.ts+src/*.ts），sourceAggregate算法及每文件Git blob见build-summary/source清单；plugin.ts blob=f58f5352201b74ea770cb78e774e8d2dbd4dece4。bundle784182 bytes、SHA-256=5798a04452b0cb003efd8cc020f2518aa3d9f936659b8153f85a6687e78dc941，与旧5798字节一致。真实tgz187064 bytes、SHA-256=5e2d45fb26e365dbc1a23793f28e3d4a8c7882d0ec19c7322d42ad029723e7b5、shasum=06fcc1f4e6e5aa3b0c2dde3f96606448385b97ce、integrity=sha512-dra8lNCC+IEgILiB75jn1EHTvpVGTgqDo5UdiOSGwL6Jh3QaKxvlgZ57VP+CT4RfOijB4jhQr4cnf4989jXnTQ==；Python -I只读核恰四文件README/index/schema/manifest且均与树字节相同、manifest0.35.0、无server export、engine^2.0.0，schema三退休顶层字段缺席。实算与dry/actual清单一致；不冒称最终实包E2E/发布/安装通过。

拟提交只读安全核：suggested-staging.json精确241项，excluded-files.json为250个.sandbox-isolation临时文件，均未stage；指定凭据模式0命中（非普遍无秘密证明），未读npm token/用户配置。新增4源码实际引用链在plugin.ts及stop-native→stop-scope；新增tests为本次迁移/权限/goal/crew/search/stop/工件回归，三reports为本次减法依据、授权记录、实现审计。既有OpenSpec取消/依赖归档44文件属0.2治理：39字节相同；fix-ask-door四份仅换行差异；forge-commands规格含既有单路由/模板守卫基线修订，不称全为纯移动。git diff --check exit2仅生成dist/index.js:4003/4004/4012/15371空白；保持已绑定bundle不手修。未改规格、未whole-check、未archive/publish/安装，用户重启未发生。

最终实包局部smoke增证（2026-11-27，主控核验回报）：同一0.35.0 tgz SHA-256=5e2d45fb26e365dbc1a23793f28e3d4a8c7882d0ec19c7322d42ad029723e7b5，release-0.35.0/release-goal-smoke.log与release-stop-smoke.log两run均exit0、owned cleanup0、root removed=true。本工人已读两raw的smoke-staging-unique/package/dist/index.js artifact/5798及cleanup0；Goal ledger yes/no/no→paused/no-progress、stop双native child局部链与exit/root结果按主控核验归因，不冒称本工人重跑或完整矩阵通过。dist仍5798a04452b0cb003efd8cc020f2518aa3d9f936659b8153f85a6687e78dc941，全量767/767。owner明确接受披露限制并放行，原缺口/过程偏差/D6继续保留，不新增whole checkbox、不archive。发布/官方安装/用户重启实测尚待。本轮只改tasks/audit，不动package/README/dist，保持实包对应；此前文件由主控已stage，本增量由主控再stage，本工人不修改index。

发布收尾凭据追加（覆盖前述尚未发布的历史时点）：用户明确授权提交/push/npm/本地升级并接受已披露未覆盖项；commit `0742759b27b6c85376ab3875bcd9655f6ab96661` 已推 `origin/retire-plugin-runtime` 按主控报告记账。本工人已独立读release-0.35.0/registry-verification-20261126T190312Z.json：publish_exit=0、verified、latest=0.35.0，registry独立下载SHA-256=5e2d45fb26e365dbc1a23793f28e3d4a8c7882d0ec19c7322d42ad029723e7b5、shasum=06fcc1f4e6e5aa3b0c2dde3f96606448385b97ce及integrity均匹配同一发布tgz；publish一次归因主控报告，不称本工人执行或重下。官方安装凭据release-0.35.0/local-install-verification-0.35.0.json（脱敏命令记录local-install-commands-0.35.0.log）：本机0.35.0、新cache1795720132680，四文件equal=true与测试包相同（index SHA-256=5798a04452b0cb003efd8cc020f2518aa3d9f936659b8153f85a6687e78dc941）；config与backup字节相同且parsed=true，service运行28894、list单forge0.35.0，旧cache已改名1795516668114.stale-0.34.0-pre-0.35.0。userTuiRestartConfirmed=false，用户重启确认仍待。未测矩阵、D6及过程偏差保留，不整勾11.4或其他whole checkbox，不archive active change；本轮仅改两既有文档，不执行git、不改生产文件。

用户验收确认（2026-11-27）：用户对上述0.35.0发布、本机安装及待验收报告明确回复「全部通过」，仅关闭本次owner验收，覆盖前述用户确认仍待状态；不推断具体TUI重启步骤，既有JSON中userTuiRestartConfirmed=false保留为历史快照。未覆盖矩阵、D6及过程偏差不改写为实测通过，不整勾11.4全部历史条件、不archive、不改源码。

### 历史快照 20261126-225726，非当前 e3ec

| 核验项 | 独立读取/实算证据与边界 |
|---|---|
| typecheck | `intermediate-regression/20261126-225726-4587-typecheck.log:1` 为 `$ tsc --noEmit`，无错误；exit 0 来自闸口工人报告、由协调者转述，日志自身没有退出码，不伪称独立读到退出状态。 |
| 全量 | 同前缀 `tap.log:5132–5140` 完整 TAP：747 tests、747 pass、0 fail/cancelled/skipped/todo；1..744 为顶层项数，不是总 tests。package.json scripts.test 使用 canonical namespace preload；该日志无启动命令，canonical 身份按闸口工人报告、协调者转述。旧 222409 未完整退出及 224348 的 716/724、8 fail 仍为历史，不能再称最新候选未通过全量。 |
| bundle / 指纹 | 同前缀 `bundle.log:1–4` 明载 bundle 命令、92 modules、index.js 0.78 MB。当前 dist/index.js 实算 SHA-256=`a8cd71be028f93d611ed9e6d9567bd325cd6dfd7c049fc3acf3068375ff0b5e5`。source aggregate=`74c274fdbec6b211b571424e1ed8147eb0a835bdf3bef8ee5587f9ff88d4d1f0` 为闸口工人报告、协调者转述的冻结标识，本次未复算聚合算法，不扩张到其他树。 |
| pack 清单 | 同前缀 `pack.json` 为 0.34.1，entryCount=4：README.md、dist/forge.schema.json、dist/index.js、package.json。`pack-stderr.log` 仅未知用户配置警告。该 JSON 本身不含包内 manifest 内容，按 dry-run 清单边界使用。 |
| 真实包 / 9.2 | 随后独立以内存只读 tarfile 检查 `candidate-tgz-20261126-230159-5041/sorenllm-opencode-forge-0.34.1.tgz`，确为上述四文件。包内 manifest：version=0.34.1，exports 仅 `.`→import `./dist/index.js` 与 `./schema.json`→`./dist/forge.schema.json`，无 ./server；engines.opencode=^2.0.0；description 点名 native worker agents、Plan/Goal/Crew，无作业监管/看门狗。tgz SHA-256=`35dcc7a294ec63d222e00be1aaf5e0324ad0194ee1e71dbcfde00e0894311a64`；包内 index hash 与上述 dist 相同；schema 顶层 jobs/watchdog/dispatch 缺席。凭真实包内容签收 9.2，不是仅凭 dry-run，更非发布或安装终验。 |
| 残留 / 9.4 | 本次独立 `rg` 扫描 tests 的 `\bserver\s*\(` 与 `import.*\bserver\b` 均零命中；plugin.ts/src 的 `export const server|\.server\b|forgeDisabled|NATIVE_PARTITION_FALLBACKS` 零命中。结合本候选 747/747，仅签收 9.4 的静态残留及全量条件。 |

任务裁定：本轮新增勾选 **9.2、9.4**。**1.16、9.3** 仍欠逐断言保留/迁移/退役映射、混合文件完整性及先迁后删顺序签收，全绿不能替代这些证据。**11.1** 可记冻结 candidate 最低门槛绿，但版本仍为 0.34.1，最终 0.35.0 尚未到位，保持未勾。**11.2–11.4** 以及发布、最终包 E2E、安装与用户验收均不据此勾选；既有 staged 局部宿主证据不升级为完整 GATE。未提交、push 或 archive。
