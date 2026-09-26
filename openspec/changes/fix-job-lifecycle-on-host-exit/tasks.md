# Tasks — fix-job-lifecycle-on-host-exit

## 1. 诊断定因（先定位再修）

- [ ] 1.1 复现并埋探针：沙箱 run 起 `python -m http.server` 后台 job，宿主正常退出；探针记录 dispose/session.deleted/exit 钩子谁实际触发、job-kill 回调是否被调；结论写入 verification-notes；验证：实机探针日志给出"单测过、实机不过"的确切出口缺口
- [ ] 1.2 复核 job-runner 现有 kill 路径在宿主退出时序下的可达性（dispose 时 event loop 状态）；验证：代码走查记录 + 单测模拟对应时序

## 2. stdio 文件化（地基）

- [ ] 2.1 `src/job-runner.ts`：spawn stdio 改 `["ignore", logFd, logFd]`，输出捕获改文件增量读；exitGrace 机制保留但预期不再触发；验证：单测改造后全绿（含 #47350 repro 3.1b 仍过）
- [ ] 2.2 存活健康性测试：起逐请求写 stdout 的假服务 job，宿主（测试进程）退出后子进程仍能正常响应（无 broken-pipe 僵尸）；验证：新增集成测试实机脚本化断言
- [ ] 2.3 poll/log 语义回归：newOutput 增量、logPath 不变、ring buffer 截断行为保持；验证：单测覆盖文件 tail 增量与截断

## 3. 退出全出口清杀

- [ ] 3.1 出口矩阵接线：SIGINT/SIGTERM/exit/uncaughtException/unhandledRejection + dispose，幂等守卫，优雅（SIGTERM/`taskkill` 无 /F）→ 3s 宽限 → 强杀；验证：单测注入多出口触发断言只杀一次、进程组内全灭
- [ ] 3.2 实机验收：三个出口各跑一遍（正常退出 / Ctrl-C 模拟 SIGINT / taskkill 宿主），job 树灭、端口不响应、无 node/python 残留；验证：脚本化三出口实测记录
- [ ] 3.3 宿主强杀（Windows）兜底实测：`taskkill /F` 宿主后 200ms 量级内 job 灭（Job Object 生效）；POSIX 无内核兜底路径的孤儿检出由 5.2 注册表扫描覆盖；验证：Windows 实测记录 + 5.2 单测断言 ledger 孤儿报告

## 4. OS 级兜底

- [ ] 4.1 `src/proc.ts`：Windows CreateJobObject + KILL_ON_JOB_CLOSE + AssignProcessToJobObject（不设 BREAKAWAY_OK），仅默认 kill 模式启用；POSIX 确认 detached 进程组 + 组杀路径；验证：单测 fake + Windows 实机（4.1b）
- [ ] 4.1b 实机：Chromium 系进程的逃逸边界记录（spawn `chrome --headless` 类 job 的 fence 行为）；验证：实测记录进 notes（允许记录"此类逃逸"为已知边界）

## 5. 显式存活 + 注册表

- [ ] 5.1 `forge_shell` 参数 `survive?: boolean` + 配置 `jobs.survive`（默认 never，显式 deny 不可被参数覆盖）；schema 与 permission 无新增键；验证：接线单测三态（never/always/参数覆盖）
- [ ] 5.2 注册表持久化 `<tmp>/opencode-forge/jobs/registry.json`（文件锁 + 有界），启动扫描合并 survivor（pid 复活检测、死者清理记 ledger），list 输出标 "previous run" owner；验证：单测两宿主接力（起 survivor → 新 manager 实例 → poll/kill 可用）
- [ ] 5.3 survive job 不入 Job Object fence、退出不清杀；实机跨 `opencode run` 接力（run A 起 survivor → 退出 → run B list/poll/kill）；验证：实机记录
- [ ] 5.4 README：survive 配置、注册表文件账本行、卸载口径补 registry.json；验证：避坑 §6 口径核对

## 6. 回归与发布

- [ ] 6.1 全量回归：`node --test --test-timeout=20000 tests/*.test.mjs` + `tsc --noEmit` + bundle；wake/审批/stage 矩阵不回归；验证：全绿输出
- [ ] 6.2 实机冒烟（真实 opencode + 真驱动姿态同 7.x）：自然提示词起服务 → 宿主退出 → 端口死、无残留；survive 流程一轮；验证：实机记录
- [ ] 6.3 发布车 0.3.1：pack 检查（同 forge 8.1 口径）→ 浏览器密钥 npm 发布 → npm spec 安装终验 + 冒烟（最终态 npm plugin 模式）；验证：forge 8.2 同款闭环
