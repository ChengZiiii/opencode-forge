# Tasks: fix-dispatch-dispose-kill

## 1. Specification

- [x] 1.1 四件套就绪（proposal/design/tasks/specs deltas），`npx openspec
      validate fix-dispatch-dispose-kill --strict` 绿

## 2. Implementation（crew wave 1：coder → test-coder → gate-verifier → spec-reviewer）

- [ ] 2.1 `isDispatchRow` 谓词 + dispose/出口矩阵/disposeAll 三处 skip
      过滤（host-exit killOne、job-manager disposeAll、dispose 钩子
      trigger 传参）；dispatch 行不被标记 killed、不被删行
- [ ] 2.2 `jobWakeText` killed/aborted 诚实分支（禁止 finished+空 tail
      伪报告）；`onSessionEnd` 对 dispatch 行改 terminal-evidence 自清
      （kill 后行留存至 wake 被读）
- [ ] 2.3 `abortChild` abort-less 显式检测；killTree 调用点全部消灭
      `void` 丢弃（未证实 → journal reason 附注 + wake 披露）；v2
      abort 接线按 design D3 决策树落地（E1 探针结果落档）
- [ ] 2.4 测试重议 + 新增全绿（design D4 清单）、typecheck 绿、全量套件
      909+ 绿

## 3. Sandbox E2E verification（GATE）

- [ ] 3.1 dispose 豁免 E2E：两上下文沙盒宿主，A 派发慢孩子 → 注入
      dispose → wake 块本体 `Final report:` 携带孩子原文；journal 无
      aborted 终态；零脚手架泄漏
- [ ] 3.2 杀路径诚实 E2E：owner 终结 → wake aborted 措辞+理由、无
      "(no output)"；journal 终态与 wake 同 reason

## 4. Release + install verification（GATE）

- [ ] 4.1 并入 0.33.0 合并发版：npm pack --dry-run 白名单核对 →
      publish → dist-tags 翻牌 → shasum 记录入档
- [ ] 4.2 旧物化副本隔离（`1795370347623` → `_quarantine` 改名）
- [ ] 4.3 用户重启后真机终验（Unity 三测金丝雀或探针复跑，判据同 3.1）

## 5. Wrap-up（用户明示后）

- [ ] 5.1 openspec archive + push；探针/驱动脚本归档
      `archive/<日期-主题>/`
