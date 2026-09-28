# Tasks — partition-tool-surfaces-by-agent

## 1. 机制首验（承重假设前置）

- [x] 1.1 E2E 探针：在沙盒配置（`OPENCODE_CONFIG_DIR` 临时目录）里给一个非 forge agent 条目注入 `tools: { forge_shell: false }`，`opencode run` 实测该 agent 会话的工具面——验证宿主 `tools` 过滤对插件注册工具生效；同时验证最小条目（仅 `tools`）按名合并不丢失原生定义（general/explore）。失败则按 design R1 停下：改走降级路径并先修订 delta 场景措辞（"不可见"→"不可用"），经用户确认后继续。

## 2. forge 族执行面强制

- [x] 2.1 `src/dispatch-tiers.ts`：`forgeAgentDef` 物化条目统一携带 `tools: { shell: false, bash: false }`（readonly/write 两形状一致）。验证：forge-subagents-wiring 测试断言两种形状的物化条目都含该 tools 键、permission 形状不变。
- [x] 2.2 `plugin.ts` config hook：forge 主 agent 的隐藏条件改为 `jobStage() < 2 && !jobsKeepBuiltinShell`（去掉探测条件与 `userDefinedForge` 豁免；用户条目按键级合并只写 shell/bash）。验证：job-wiring 测试改写——auto/forge/native 三态、keepBuiltinShell、用户自定义条目合并（其余字段不被触碰）各一断言。
- [x] 2.3 移除 `nativeBackgroundSeen` 探测两处（config experimental 正则、tool.definition 参数表）与 `STAGE1_NOTE` 注入；`jobStage()` 简化为 `native` 退役/其余同档。验证：全测试套通过，grep 无 `nativeBackgroundSeen`/`STAGE1_NOTE` 残留。
- [x] 2.4 harness 状态工具 primary 专属（D9）：config pass 对 forge-* 条目键级合并注入 plan_*/goal_*/crew_* `false`，工人只留 forge_shell/forge_jobs。验证：forge-subagents-wiring 测试断言工人条目无状态工具、主 agent 不受影响。

## 3. 非 forge 面隔离

- [x] 3.1 `plugin.ts` config hook：遍历 `cfg.agent` 除 `forge`/`forge-*` 外全部条目，键级合并注入 15 个插件工具的 `false`（用户显式 `true` 不覆盖）；对缺席的 `build`/`plan`/`general`/`explore` 物化最小条目；删除 build/plan 的 `disable: true` 注入。验证：partition wiring 测试——非 forge 条目隐藏、用户显式 true 保留、build/plan 不再 disable、 forge/forge-* 不被注入。
- [x] 3.2 v2 setup 对等守卫：v2 无 tool 域，确认 setup 路径无隔离注入且测试声明该边界。验证：v2-setup 测试通过。
- [x] 3.3 default_agent 钉回 forge（D13，apply 期发现）：config hook 注入 `default_agent ??= "forge"`，尊重用户显式配置。验证：partition wiring 测试断言注入与 `??=` 语义；E2E 裸 run 头部为 forge。

## 4. 注入门控

- [x] 4.1 `plugin.ts`：sessionID→agent 有界映射表（chat.message 与 chat.params 双源 upsert，session.deleted 逐出）；`experimental.chat.system.transform` 的全部 forge 注入（job-guidance、plan-notice、goal-notice、crew-active）与 `experimental.session.compacting` 的 goal-brief 加 forge 族门控，未知不注入。验证：partition wiring 测试——forge 族会话注入齐全、非 forge 会话零 `[forge:*]` 文本、未知 agent 不注入、表随 session.deleted 逐出。
- [x] 4.2 goal 续跑引擎守卫：`scheduleIdleContinuation` 调度时即查映射（非 forge 族 idle 连 session.get 探测都不发），`continueIfEligible` 发送前二次复核；非 forge 族 skip（不记 turn、goal 保持 active）。验证：goal-mode 测试新增场景——非 forge agent 下 idle 不发续跑、预算不变；forge 族照常。
- [x] 4.3 `src/dispatch-prompt.ts` worker 纪律补一句"命令一律经 forge_shell 执行"。验证：dispatch-prompt 测试断言新句存在。
- [x] 4.4 `plugin.ts` tool.execute.before 派发护栏：非 forge 会话（按映射表，未知放行给 forge 面）对目标为 `forge-*` 的 task 调用抛引导性错误（点名 partition），不创建子会话；forge 族派发不受影响。验证：partition wiring 测试——build 会话派发 forge-research 被拒、forge 会话照常、错误文案含 partition 字样。
- [x] 4.5 watchdog 管辖域收缩：`shell.env` 标记注入与 `watchdog.track` 按 D4 映射门控——非 forge 族与未知会话不注入、不计时（引擎 `src/watchdog.ts` 零改动）。验证：watchdog-wiring/partition 测试——非 forge 会话无标记无计时无介入、forge 会话（keepBuiltinShell 场景）照常管辖。
- [x] 4.6 命令入口重定向（D10）：PLAN/GOAL/CREW 三个模板头部加 fail-fast 自检护栏（entry 工具不在工具表 → 停止并引导切 forge）。验证：模板文本测试断言护栏存在且在纪律步骤之前。
- [x] 4.7 状态文件边界（D11）：tool.execute.before 对非 forge 会话（按映射表）write/edit 目标前缀检查，命中 `.opencode/plan/`、`.opencode/goal/` 拒绝；读不拦。验证：partition wiring 测试——build 会话写 plan 目录被拒、forge 会话照常（draft 外）、read 不受影响。
- [x] 4.8 compaction autocontinue 抑制随族门控：`experimental.compaction.autocontinue` 仅在会话当前 agent 为 forge 族时 `enabled=false`。验证：goal-mode 测试——非 forge agent 下压缩续跑恢复原生、forge 族照常抑制。
- [x] 4.9 draft 写禁文案 agent 无关化（D12）：tool.execute.before 的拒绝信息从"call plan_approve"改为对任何 agent 可执行的说法（"切回 forge 完成 plan_approve，或 /plan discard"），因非 forge agent 看不到 plan_* 工具。验证：partition/goal-mode 测试断言新文案；被拒的 build 会话错误信息含 forge 切换指引。
- [x] 4.10 R1 降级落地（E2E 实证宿主无视注入 tools map）：tool.execute.before 双 belt——forge 族 bash/shell 硬拒绝（引导 forge_shell；keepBuiltinShell/退役放行）+ 非 forge 族 forge 工具硬拒绝（点名 partition）；unknown fail-open；draft 期 bash 由写禁先拦（语义更准）。验证：partition wiring 测试四向断言；E2E 模型报告拒绝与引导。

## 5. 回归与文档

- [x] 5.1 全套回归：`bun run typecheck`、`node --test tests/*.test.mjs` 全绿。
- [ ] 5.2 README：行为标准表（forge 族 vs 非 forge 面）、build/plan 共存与 Tab cycle 变化、keepBuiltinShell/mode:native 开关、混合会话小节、合并 config 键级注入说明、卸载自愈复核。验证：通读与实现一致，文件账本无新增残留路径。
- [ ] 5.3 AGENTS.md 架构总览行与关键机制（第 2/6 条）随行为更新。验证：与代码一致性通读。
- [x] 5.4 打包与终验：`bun run bundle`（自包含重建）、`npm pack --dry-run` 核对 files、官方安装模式 E2E（`opencode plugin "git+file:///<绝对路径>" --global` + 沙盒配置）实测：forge 会话无 bash 有 forge_shell、build 会话有 bash 无 forge_shell 且系统提示零 `[forge:*]`、general 派生子代理同隔离、build 派发 forge-* 被拒、goal 会话切非 forge agent 后 idle 不续跑、非 forge 会话内置 shell 无 watchdog 标记。验证：transcript/日志摘录附到本 change verify 记录。
- [ ] 5.5 归档时直接编辑 `openspec/specs/hang-watchdog/spec.md` 的 Purpose 行（"in any session" → forge 族管辖表述；delta 不承载 Purpose 修改）。验证：归档后 `openspec show hang-watchdog --type spec` 首段与新管辖域一致。
