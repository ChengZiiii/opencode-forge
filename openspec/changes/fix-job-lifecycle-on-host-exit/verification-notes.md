# Verification notes — fix-job-lifecycle-on-host-exit

## 1.1 探针复现（2026-09-26 22:02，probe/run.mjs against pre-fix 0.3.0 source）

- 宿主 = headless node 进程加载当前 `src/job-runner.ts`，`run_in_background` 起
  `python -m http.server <port> --bind 127.0.0.1`，HTTP 200 探活通过后
  **process.exit(0) 正常退出**（不调 dispose —— 模拟 `opencode run` 一轮一退路径）。
- 结果（findings.txt / host-events.log）：
  - host exit code 0；`process exit` 事件**有触发**（host-events.log 记录），但
    0.3.0 没有任何退出钩子接线 → 无人执行 kill。
  - python http.server 进程存活（pid 138728）。
  - 宿主死后的 HTTP 请求 `fetch failed`（连接可开、handler 死于写已断管道）——
    与上午实机 directed 实验（curl exit 52，job `j-20260926-120857-w4jic4`）同因
    同象：**存活但坏死的僵尸**。
- 结论（单测过、实机不过的确切出口缺口）：0.3.0 的清杀只挂在
  `dispose`（plugin.ts dispose 钩子）与 `session.deleted`（事件）两条路径上；
  `opencode run` 正常退出**两者都不触发**，进程级 `exit`/信号出口完全没接线。
- 探针过程副产品（记入避坑）：python 3.12 `http.server` 的 banner
  "Serving HTTP on ..." 写 **stdout**，管道/文件形态下块缓冲不落地；请求日志写
  stderr（无缓冲）→ 探活必须用 HTTP fetch，不能用 banner 正则。

## 1.2 代码走查：现有 kill 路径在宿主退出时序下的可达性

- `plugin.ts` dispose → `jobManager.disposeAll()`：仅当宿主调用插件 dispose。
  实机 `opencode run`（1.18.32）退出路径无 dispose 调用证据（1.1 探针 + 上午
  实机一致）。
- `session.deleted` 事件 → `onSessionEnd`：TUI 会话删除才发；headless run 的
  会话不产生该事件。
- 进程级出口（SIGINT/SIGTERM/exit/uncaughtException/unhandledRejection）：
  **0 处接线** —— 这就是缺口本体。D2 的出口矩阵即补此层。
- `opencode run` 下的正常退出为 `process.exit` 路径 → `exit` 事件必发（探针
  证实），同步 taskkill 可达。

## 实施过程中的活体发现（全部已修复并回归）

1. **shell 包装 pid 短命**：`shell:true` 的 cmd.exe 随宿主退出而死，真实命令进程
   （孙进程）成孤儿——registry 记 pid、exit-handler taskkill、fence assign 全部
   指向短命 wrapper。修复：结构重定位（`structuralRelocate`，按 ParentProcessId
   链找活后代，不做命令行匹配）+ fence reinforce（spawn 后 50/400/1500ms 异步
   重定向 job.pid 并补 assign）+ adopt-kill 杀前重定位。
2. **fence watcher C# 编译失败**：Windows PowerShell 5.1 的 Add-Type 用 C# 5
   编译器，`out var`（C# 7）直接编译错误 → watcher 带病退出、job object 从未
   建立，一切 fence 兜底静默失效。修复：C# 5 兼容写法；手工 `powershell -File`
   验证编译 + 退出码 0。
3. **只 assign wrapper 不够**：真实孙进程在 watcher Add-Type 编译（~1-2s）完成
   前出生，错过 job-object 继承窗口。修复：watcher 升级为持续收养——C# 侧 400ms
   CreateToolhelp32Snapshot 扫描，把已跟踪 pid 的全部后代（深度 ≤4，防 pid 复用
   误收）assign 进 job；与 JS 侧 reinforce 双保险。
4. **幂等闩吞掉 'exit' 兜底**：单一 done 闩使"SIGINT handler 被中途击毙"后
   'exit' 事件的强杀被跳过。修复：双闩（sequenced / forceIssued）。
5. **exit 路径不该关 fence**：fence watcher 的主动 dispose（after 钩子）只在
   plugin dispose 路径跑；exit/信号路径让 stdin 随宿主死亡自然断开——内核链正是
   这些路径的兜底。
6. **日志读取无界**：`Buffer.allocUnsafe(新增字节数)` 单次分配无上限（输出洪峰
   直接打爆宿主内存，实测触发过一次用户机器内存事故）；`readJobLog` 全文件读。
   修复：tail 分片 4MB/次；log 读取 8MB 窗口化。
7. **检测层假阴性/假阳性**：CIM（Get-CimInstance）进程数据滞后秒级——判定一律
   以 HTTP fetch 端口死活为准，CIM 仅作信息性补充。
8. **taskkill 异步落地**：kill 后宿主立即退出可能不给 taskkill 执行窗口——
   adopt-kill 路径加有界等待（2.5s）。

## 实机验证结果（probe/verify-fixed.mjs，2026-09-26，全部 127.0.0.1 + headless）

| 场景 | 结果 |
|---|---|
| 2.2 survive 健康性：宿主 exit(0) 后 survivor 存活且 HTTP 200（无 broken-pipe 僵尸） | PASS |
| 3.2a 正常退出：exit 事件强杀 | PASS（3ms 端口死） |
| 3.2b 信号终止（跨进程 SIGTERM=TerminateProcess 单点，无 /T 无 JS handler——纯 fence 链隔离验证） | PASS（26ms，内核链） |
| 3.2c WM_CLOSE（taskkill 无 /F 杀宿主） | PASS（1ms） |
| 3.3 强杀（taskkill /F /T 宿主） | PASS（2.4s：fence 链 + 树杀双通道） |
| 5.3 跨宿主接力：run A 起 survivor→退出→run B 扫描收养（结构重定位）→poll 见日志→kill 树灭→registry 清 | PASS |

已知边界（README 同步记录）：
- 真实 Ctrl-C 无法跨进程安全模拟（CTRL_C_EVENT 是 console 级广播）；实测以
  SIGTERM 单点终止代替隔离验证 fence。真实 Ctrl-C 下同 console 的 job 子进程
  还会**自行**收到 CTRL_C_EVENT——比实测多一层保障。
- 宿主在 job 启动后 ~1s 内被杀（watcher 尚在 Add-Type 编译、sweep 未跑、
  reinforce 未落）的窗口内，孙进程可能漏杀；正常使用（服务跑起来后再退出）不
  受影响。
- Chromium 系显式 breakaway 进程不受 fence（设计取舍：不设 BREAKAWAY_OK）；
  本机未实测（用户正在使用浏览器，不触碰），按设计记录为已知边界。
- fence 每宿主进程一个 powershell 看守（~40-80MB 常驻，懒启动：首个 job 才拉起；
  退出即回收）。spawn 失败降级为"仅 JS 出口矩阵"并记 ledger（fence-degraded）。

## 沙箱回归（guard 串行，内存峰值 ≤120MB/进程树）

13 个测试文件全绿（job-fence 5、host-exit 8、job-runner 14、job-registry 6、
job-manager、job-wiring 13、proc、v2-setup、plan-file、goal-file、watchdog、
watchdog-wiring、goal-mode 33）+ `tsc --noEmit` + bundle 通过。
（内存事故后的纪律：测试一律经 guard-run.mjs 串行跑——堆封顶 256MB、进程树
内存监控、90s 总时限。）

## 6.2 实机冒烟（真实 opencode run + 临时 OPENCODE_CONFIG + --auto，2026-09-26）

- Round 1（默认杀语义）：自然中文提示词 → 模型自主调 forge_shell
  （run_in_background）起 `python -m http.server 26100` → run 结束宿主退出 →
  python 进程 0 存活、端口无响应 → **PASS（无僵尸）**。
- Round 2（survive 跨宿主）：run A 以 survive:true 起服务（27100/26200 端口轮）
  → A 退出后 python 存活且 HTTP 200 → run B 自然提示词 → 模型自主
  forge_jobs list 看到 `previous-run` 作业 → poll（running）→ kill → 进程灭、
  registry 清 → **PASS**。
- 过程修正：CIM 查询偶发热空导致 B 启动时把活 survivor 误判死（ledger 留痕
  "previous-run survivor pid ... is dead"）——structuralRelocate 加一次 300ms
  有界重试后两轮全绿。
