## 1. 实现

- [x] 1.1 `forge_jobs` 的 stop 分支：先出队（journal 终态 + stop 句子），再取消在飞；回执分两段；只有排队 wish 时也取消并回执
- [x] 1.2 文案：`/forge stop` 下发的提示词、工具描述、“cancel all 已退役”拒文案 → “in-flight and queued”
- [x] 1.3 README 的 `/forge stop` 段落
- [x] 1.4 在途窗口（design D5）：stop 纪元；在跑的泵登记在案；清队后有界等待落地；
      建子会话一半 → 不提示词（空壳 abort 只作清理 + D5 句子 + 计入回执排队组）；
      提示词一半 → 照常登记、由 stop 取消；等不到 → 泵自取消并经回执披露；
      取消串行链；并发上限计入在途 wish
- [x] 1.5 规格落法：该要求按 REMOVED + ADDED（新名）整条重写（见 proposal「Impact」）；
      `openspec validate --all --strict` 全过（24/24）；用 OpenSpec 自己的合并函数
      在临时副本上预演过归档结果

## 2. 测试

- [x] 2.1 改写 `tests/dispatch-wiring.test.mjs`「queue pump ②」（旧断言按新约定）
- [x] 2.2 新增单测：只有排队 wish / 队列头不补位 / journal 句子 / 重启恢复不重入 / 回执形状；
      另加“并发上限计入在途”“泵一轮连发两个”“被拒的队列头不占槽”。测试收尾统一走
      `endOwnerAtTeardown`：断言半路失败也会先放开停靠的泵、再结束 owner 会话、最后才
      dispose（之前这种失败会让整份测试进程永不退出）
- [x] 2.3 D5 四则单测（crew 合规带读取时 stop / 建子会话时 stop / 发提示词时 stop / stop 先等不到），
      把泵停在窗口里（mock 的 `onCreate` / `onPromptAsync` 缝 + 锚点读取）
- [x] 2.4 全量测试、typecheck、变异检查（出队顺序、句子、回执各杀一个；D5：去掉合规带读取后
      的纪元检查、去掉建子会话后的纪元检查、去掉有界等待、去掉“杠杆已不在等”的条件、
      去掉泵自取消的串行链，各须有用例变红）
      —— 实测：typecheck 0 错；全量 1047/1047；变异 19/19 KILLED
      （c-1…c-5 + d5-1…d5-12 + e-1/e-2；`reports/e2e/evidence/0.34.0/mutation-verdict.json`）
- [x] 2.5 `tests/forge-commands.test.mjs`：`/forge` 帮助行里 stop 那一句的断言跟着改

## 3. 沙箱验证（宿主 2.4.0）

- [x] 3.1 E2E `19-stop-queued-e2e.mjs` 基线：同一驱动在 0.33.1 构建上出红——正好红在
      4 条该红的检查项上（`logs/base0331b-19-verdict.json`）
- [x] 3.2 新构建同一条驱动出绿
      —— 实测：9/9（`stop-queued-e2e-verdict.json`；全套 E2E 复跑仍是 9/9）
- [x] 3.3 验收门全绿、有头 TUI 门通过后发版 0.34.0
      —— 实测：验收门 31 过 / 0 败 / 1 记账（C1 的 D1，老账）；有头 TUI 门 9/9（宿主 2.4.0，
      `/forge stop` 连排队一项 10/10）；0.34.0 于 2026-11-24T05:17:47Z 发布并验证
      （shasum `228419ce339aff6920dc6b0c6a078ef1e4b353ea`）
