# Tasks — fix-dispatch-transport-timeout

## 1. Red tests (engine)

- [x] 1.1 `tests/dispatch-engine.test.mjs`：注入 fetcher 使 turn POST 在 child 流式中途以 `DOMException("The operation timed out.","TimeoutError")` 拒绝、GET /message 轮询随后可见 child 完成 → 断言 background dispatch 终态 completed、report 完整（tokens/text/sessionID）、ledger 先 `transport-interrupted`（含 sessionID/dispatchId）后 `completed`
- [x] 1.2 同 harness：turn POST 传输拒绝 + child 永远 0 条 assistant 消息 → 断言 deadline 到期终态 timeout（非 error、非 empty-response），timeout 报告含 child sessionID 与 child-alive 提示
- [x] 1.3 同 harness：turn POST 返回 HTTP 500 → 断言不进恢复（无 transport-interrupted 事件），保持既有 host-error 语义
- [x] 1.4 同 harness：恢复轮询进行中调用 kill → 断言终态 killed、无 brief、slot 归还
- [x] 1.5 sync 路径 1.1 同型：传输拒绝后轮询完成 → `engine.dispatch` 正常返回 result（非 throw）
- [x] 1.6 `tests/dispatch-engine.test.mjs`：任意终态后（error/timeout）registry result 的 `sessionID` == 真实 child id；bgTerminal error ledger 行含 dispatchId/parentSessionID/sessionID/durationMs

## 2. Green implementation

- [x] 2.1 `src/dispatch-engine.ts` runAttempt：turn POST 的 race 包 try/catch——非 DispatchError 拒绝且 childID 非空 → sink `transport-interrupted` + 落入轮询循环（不重发 POST）；DispatchError 与 deadline 命中保持现有路径 → 全部 1.x 测试转绿
- [x] 2.2 `src/dispatch-engine.ts` bgTerminal：report.sessionID 取 `reg.get(dispatchId).sessionID`；error sink 行补齐 dispatchId/parentSessionID/sessionID/durationMs；timeout note 明示 child 留存宿主侧 → 1.6 转绿
- [x] 2.3 `src/crew-gate.ts` 非结局事件白名单加 `transport-interrupted`，`tests/crew-gate.test.mjs` 加一行用例（该事件不得制造 gap）→ 该文件测试全绿

## 3. Suite + build

- [x] 3.1 `bun run typecheck` 通过；`node --test tests/*.test.mjs` 全绿（328 pass + 新增 TI 用例；watchdog-wiring 1 例为存量失败，stash 原树复跑证实与本 change 无关）
- [x] 3.2 `bun run bundle` 重建 dist（自包含），`npm pack --dry-run` 核对 files 白名单不变

## 4. Live acceptance (serve sandbox)

- [x] 4.1 沙盒 `opencode serve`（OPENCODE_CONFIG_DIR 指向临时目录 + file:// 本仓 + 免费 keyless 模型）驱动 background dispatch，在 turn POST 的 fetch 边界注入传输中止（复刻事故签名）→ 实测：`transport-interrupted` @1523ms → 恢复轮询 → `completed` @9608ms（同一 child、真实 token、报告完整）ACCEPTANCE PASS（job j-20260927-150250-uhx8g4）。注：~281s 自然中止无法在本沙盒复现（keyless 会话拒绝 bash，构造不出 >281s 回合），修复语义对中止来源免疫，定源留作后续观测
- [x] 4.2 对照复跑 review 型任务（无中断）→ completed @10.9s、证据引用齐全、零 transport-interrupted、无回归 ACCEPTANCE PASS（job j-20260927-150321-uvd2wy）

## 5. Postmortem + docs

- [x] 5.1 更新 `DISPATCH-TIMEOUT-INCIDENT-2026-09-27.md`：根因链定稿（bg-1 实为 background、bg-2 为主会话 LLM 自发重发、身份翻转 = Task 通道 resume）、缺陷 1-7 逐条裁定（已修/非缺陷/移交 Non-goals）
- [x] 5.2 README dispatch 章节补传输中断恢复语义一段 + ledger 新事件 + host tool ceiling 条目更新（262s/281s 同族观测）
