# Tasks — allow-readonly-recon-during-plan-draft

## 1. 纯函数核心

- [x] 1.1 `src/dispatch-tiers.ts` 新增导出 `effectiveReadonlyShape(def)`：`shape !== "write"`（缺省 readonly）且定义无 permission override 把 `write`/`edit`/`bash` 抬离 `"deny"`（`"ask"` 算抬离，fail closed）；`task` 不参与（恒 deny）。验证：单测覆盖——缺省 shape（豁免）、`shape:"write"`（不豁免）、逐工具 override `allow`（不豁免）、override `"ask"`（不豁免）、override 仅 `forge_shell` 等无关工具（仍豁免）、override `write:"deny"` 显式确认（仍豁免）

## 2. 宿主接线（plugin.ts）

- [x] 2.1 `tool.execute.before` 形状闸：在 write-class draft ban 之前、族分区护栏之后插入——`task` 调用且会话 active draft 时，按 `output.args.subagent_type`（fallback `agent`）经 `resolvePools()` 现解析（热应用）目标定义；`effectiveReadonlyShape` 成立 → 放行（跳过写类 ban）；否则抛拒绝，文案列当前有效 readonly 物化名清单 + 空名册指引（forge.json 定义 readonly worker）+ 双出口（plan_approve / /plan discard）。验证：wiring 单测——draft+readonly 目标放行、draft+write 形状拒且文案含名册、draft+原生/缺失/`task_id`-only 目标拒、无 draft 时全部放行、override 抬离后拒、无 forge.json 时空名册文案

- [x] 2.2 `permission.ask` 侧带回归：写类（含 task）在 draft 期仍无条件 deny（侧带不跟随豁免——fail-closed 降级语义）。验证：现有 job-wiring / goal-mode 相关断言全绿 + 新增 task 在 ask 侧带被 deny 的直接断言

- [x] 2.3 `/plan` 模板第 1 步侦察句改写：write 工具与 bash 仍禁；侦察（pre-draft 与 draft 迭代期）可派 effective-readonly scout；write 形状工人等批准。验证：wiring 单测断言模板文本含豁免句与 deny 句（write/bash 禁用语义不回退）

## 3. 第二层 belt 实证

- [x] 3.1 task 子会话 ambient 禁写：同一 worktree 内 task 派生的子会话（独立 sessionID）经 `session.created` 播种 + `resolveActivePlan` 目录兜底仍解析到 active draft，其 write/edit/bash 调用被 session 级禁写拒绝；readonly scout 的 forge_shell 调用走 ask 门（非 deny，与主 agent 同姿态）。验证：stub 驱动 wiring 测试（伪造子会话 sessionID + 目录内 draft 文件）覆盖 write 拒 / forge_shell 不被写禁拦截两条断言

## 4. E2E 与文档

- [x] 4.1 沙盒 E2E（官方安装模式）：`OPENCODE_CONFIG_DIR` 沙盒 + seed forge.json（一个 readonly、一个 write 工人）→ 起 draft → 驱动 task 派发 readonly（成功返回结论）与 write（拒且含名册）各一次；输出存档 `verify/e2e-recon.md`。验证：两路径行为与 delta 场景一一对应

- [x] 4.2 文档：README Design stance 禁写条目补形状豁免段（含 fail-closed 边界与空名册指引）；AGENTS.md 架构表 plugin.ts 行与关键机制 2 同步。验证：README 四步卸载重装冒烟（文件账本无新增路径——本 change 零新文件位置）

- [x] 4.3 全量回归：`bun run typecheck` + `node --test tests/*.test.mjs` + `bun run bundle`（dist 自包含）+ 官方安装模式终验（`opencode plugin "git+file://<仓库绝对路径>" --global`）。验证：全绿 + 终验装好后 draft 期 readonly 派发实测一次
