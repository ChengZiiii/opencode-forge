# Tasks: add-dispatch-suite

## 1. 纯函数核心（派发核心）

- [x] 1.1 实现 `src/dispatch-roster.ts`：类型（RosterEntry/TierDef/ValidationFinding）、默认 roster 生成（全量 catalog + config 身份枚举，免钥可见）、五条启动校验（死键/expose⊆原生梯（未知 provider 逐字接受+未验证标记）/defaultDepth 死档→depth-required/自定义 tier 缺 shape→readonly/tier id 与 profiles 引用）。验证：`tests/dispatch-roster.test.mjs` 覆盖每条校验的通过/告警/报错三分支
- [x] 1.2 实现 `src/dispatch-resolver.ts`：`resolve()` 精确匹配过滤 + 声明序/成本排序 + exclude 重试语义 + 钉扎优先（不可用报错点名不回退）+ 菜单序列化错误。验证：`tests/dispatch-resolver.test.mjs` 覆盖精确命中/无候选菜单错误/钉扎/重试/同身份多 provider 独立性
- [x] 1.3 实现 `src/dispatch-client.ts` 纯逻辑部分：完成度轮询判定（消息数+文本稳定）、tokens 聚合、成本计算（价目快照 + cache 计价 + 缺价目 null）。验证：`tests/dispatch-client.test.mjs` 用注入 fetcher/fake 消息序列覆盖稳定判定/超时/无价目 null

## 2. 宿主接线（plugin.ts，派发核心）

- [x] 2.1 config hook：tier agent 物化（hidden、mode subagent、无 model 字段、deny 式 permission 含 task deny、no-clobber、`agent["forge"].disable` 与 `dispatch.disable` 时全部跳过）+ plugin options `dispatch` 块解析与回退记账。验证：`tests/dispatch-wiring.test.mjs` 断言注入形状/用户条目不覆盖/一键关
- [x] 2.2 `chat.params` 档位注入：sessionID→level 内存表、provider 形状映射（reasoningEffort/thinking 三族）、首回合写入后冻结、未知族不注入。验证：wiring 测试以 stub chat.params 输出对象断言写入与冻结
- [x] 2.3 `forge_dispatch` 工具注册（同步路径）：参数 schema、resolve→`input.client` 建会话（parentID best-effort）→消息体 model+agent→轮询→聚合→结果对象（requested/actual/tokens/costUsd|null/披露注入状态）；并发槽位（默认 4）拒绝与提示；结构化错误全部带菜单。验证：wiring 测试以 stub client 覆盖成功/菜单错误/钉扎错误/槽位拒绝
- [x] 2.4 plan draft 禁派：`tool.execute.before` 对 forge_dispatch 在活动 draft 期抛错（消息指向 plan_approve/discard），run 模式同样生效。验证：wiring 测试断言 draft 期拒绝与批准后放行
- [x] 2.5 账本与退出：`<tmp>/opencode-forge/dispatch/ledger.jsonl` 有界追加（事件/身份/档位/outcome/tokens/成本/timeout/lost-on-exit），dispose/host-exit 路径把 in-flight 记为 lost-on-exit。验证：单测注入 sink 断言轮转上限与退出标记
- [x] 2.6 worker 提示纪律模板：tier 形状差异化（readonly 报告式 vs 执行式），必含相对路径/拒绝原文上报/证据引用三条款。验证：模板单测断言三条款与形状差异

## 3. waves：后台派发与唤醒

- [ ] 3.1 实现 `src/dispatch-registry.ts`：后台注册表纯状态机（dispatchId 生成、deadline、`queued→running→completed|timeout|killed|error`、非法迁移拒绝、`delivered` 恰一次交付标记）。验证：`tests/dispatch-registry.test.mjs` 覆盖全迁移/非法迁移/交付幂等
- [ ] 3.2 plugin.ts 后台路径：`background:true` 急解析 + 立即返回句柄 `{dispatchId, resolved, queuedAt}`；全局并发槽同步/后台共享；每派发轮询循环终态入账本。验证：stub client 覆盖后台提交/共享槽拒绝/后台超时/后台错误终态
- [ ] 3.3 唤醒引擎：`session.idle` 监听 + `[forge:dispatch-complete]` brief 合成（自上 idle 全终态合并为一条/防抖/owner 检查/活跃回合不打断/每终态恰一次）+ 与 goal 续跑 brief 共存合并（单次再提示）。验证：注入 fake idle 事件断言单条 brief、合并行为、goal 共存合并
- [ ] 3.4 `forge_dispatch_list`（在飞 + 近期结果，compaction 恢复）与 `forge_dispatch_kill`（best-effort：停轮询/标记 killed/抑制唤醒/晚到结果丢弃记账）。验证：stub 覆盖 list 恢复/kill 账本与唤醒抑制/kill-failed 原因记录
- [ ] 3.5 run 模式披露：工具描述注明后台面向 TUI 会话、run 模式建议同步；run 下完成仅入账本不唤醒。验证：描述断言 + 免钥 run 冒烟

## 4. crew：/crew 编排

- [ ] 4.1 `/crew <objective>` 命令注册 + 纪律模板（分解→波次（prompt/tier/depth/验收证据）→按 brief 节奏推进不洪水→逐子任务证据验收→失败至多一次重试→完成报告；draft 期拒绝；每会话单 crew；无参 usage；重启诚实死说明）。验证：命令注册测试 + draft 拒绝 + 单 crew 拒绝路径
- [ ] 4.2 `crew_close` 工具：ask 级确认；按账本交叉核对（每子任务 verdict+证据、账本里有而报告里无 → 拒关、失败两次必须标 FAIL）；通过后摘要（逐子任务 verdict/账本引用/tokens 成本合计）入账本并结束 crew。验证：stub 覆盖全证据关闭/缺证据拒关/漏子任务拒关/FAIL 可见允许关

## 5. 数据源与文档

- [x] 5.1 models.dev 拉取与缓存：启动 GET（尊重 `OPENCODE_MODELS_URL`）、失败降级无价目、缓存目录命名空间。验证：单测注入 fetcher 覆盖成功/失败降级
- [ ] 5.2 README：dispatch+waves+crew 章节（roster/曝光表/精确匹配语义/后台与唤醒/crew 工作流/已知坑：免钥×受限 tier、run 模式后台限制）、文件账本追加、卸载步骤核对。验证：人工审阅 + 文件账本表与实现一致

## 6. 验证闭环

- [ ] 6.1 `bun run typecheck` + `node --test tests/*.test.mjs` 全绿
- [ ] 6.2 `bun run bundle` 重建 dist（自包含，无 --packages external）
- [ ] 6.3 沙盒 E2E 冒烟：复用 probe 模式（`OPENCODE_CONFIG_DIR` + serve + 驱动脚本）对免钥模型跑同步 forge_dispatch（scout/低档只读）与后台派发唤醒各一次，断言结果对象字段、唤醒 brief、账本落盘。验证：脚本与输出存档 verify/e2e-smoke.md
- [ ] 6.4 官方安装终验：`opencode plugin "git+file:///<repo>" --global` 安装 → 注册/冒烟 → README 四步卸载回干净态（pitfalls 第 7 节梯度）。验证：过程存档 verify/install-verify.md
- [ ] 6.5 一键验收脚本 `scripts/accept-dispatch-suite.mjs`：净室重跑 typecheck → 全量测试 → bundle → 全新沙盒冒烟，输出单一 PASS/FAIL 与各环节摘要。验证：以脚本自身跑通为准（G 阶段自验）
