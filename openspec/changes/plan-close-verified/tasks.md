# Tasks: plan-close-verified

## 1. Specification

- [x] 1.1 四件套就绪，`npx openspec validate plan-close-verified
      --strict` 绿；E2 外部调研结论复核折入（无反例，设计 A 全部获
      先例印证——见 design D0）

## 2. Implementation（crew wave 2：coder → test-coder → gate-verifier → spec-reviewer）

- [ ] 2.1 plan-file：checks 节解析/渲染（parse/render，纯
      string→string）+ Check Log 节渲染 + done→approved 迁移 +
      reopened 节
- [ ] 2.2 plan_close verified：冻结集 runChecks fail-closed（失败 run
      入 Check Log + throw）+ 证据摘要终节 + 原子写 + reason 新串；
      legacy 自检路径保持
- [ ] 2.3 ask 门四层拆除（gate 调用/KEYS/v1 belt/v2 belt，七门→六门）
      + 全部指引文案同步（design D4 清单）
- [ ] 2.4 plan_reopen 工具（迁移+节+会话重绑+纪律层描述）
- [ ] 2.5 测试重议+新增全绿（design D6）、typecheck 绿、全量套件绿

## 3. Verification（GATE）

- [ ] 3.1 无头 E2E（沙盒宿主）：失败 check 拒关（状态留 approved +
      Check Log 落盘）→ 修复 → close 过（证据节落盘、零 ask 事件
      断言）→ reopen 回滚 → 再关
- [ ] 3.2 有头 TUI 验证（computer use）：plan_close 无确认框、close
      完成、磁盘证据可读、reopen 可用——原楔死场景不复现

## 4. Release（与 C3/C4 协调 0.33.0）

- [ ] 4.1 合并发版：pack 白名单核对 → publish → dist-tags → shasum
      入档 → 旧物化副本隔离

## 5. Wrap-up（用户明示后）

- [ ] 5.1 archive + push；有头测试记录归档
