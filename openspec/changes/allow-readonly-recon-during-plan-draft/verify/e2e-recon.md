# Verify — 沙盒 E2E：draft 期只读侦察派发两路径（task 4.1）

日期：2026-10-09 · 执行：forge-plugindev-e2e-verifier 波次派发（crew 记录 2026-10-10-两-change-收尾验证波次）· 宿主 opencode 1.18.34 · 插件 `file://<repo>`（dist 含最新形状闸，拒绝文案与 plugin.ts 逐字一致）· 证据原文留存 `%TEMP%\forge-recon-e2e\run3-1791567517723\evidence.json`

## 环境

- 沙盒（OPENCODE_CONFIG_DIR + XDG 三件套）：anthropic 覆盖 → 假端点 catch server（43241），serve 43240
- 工作区 forge.json：`scout`（readonly 缺省形状，钉扎模型）+ `coder`（`shape:"write"`，补 thoughtLevel 原子对后物化）
- draft：手写 `ws\.opencode\plan\2026-10-10-e2e-recon-probe.md`（renderPlan 同构，`status: draft`），resolveActivePlan 目录兜底解析——两路径共用同一 draft
- 确定性驱动：catch server 返回脚本化 `tool_use` 轮（name "task"）→ 宿主真实执行 task 工具 → 闸真实生效

## 路径 A — 放行（draft 下派 readonly scout）

主会话 `ses_ede40e5daffenVOZLbC4iLdZvp` 派 `forge-scout`：task part `state.status:"completed"`，输出含 scout 结论（workspace root = .opencode/ + README.md）。**scout 子会话真实运行的铁证**：catch #2 独立请求（29328B）system 开头即物化纪律 "You are forge-scout, a **readonly** worker: you gather, read, run read-only checks, and REPORT…"，wire 模型为钉扎的 sandbox 模型；子会话 `session.created`（`ses_ede40ded0ffexlpBa4LHieMRNO`）；scout 结论回灌主会话第 2 轮 tool_result；窗口内无任何拒绝文案。

## 路径 B — 拒绝（同一 draft 下派 write 形状工人）

主会话 `ses_ede40da25ffe936FOzuoCLie3P` 派 `forge-coder`：task part `state.status:"error"`，错误消息逐字全文：

```
[forge] A plan is in draft; dispatch is denied for this target. Readonly recon scouts ARE dispatchable during draft: forge-scout. Write-shaped workers and native agents wait for approval (plan_approve); /plan discard to abandon the plan.
```

含名册（`forge-scout`——恰为当前有效 readonly 物化名，write 形状的 forge-coder 正确不在册）与双出口（plan_approve / /plan discard）。dispatch 在闸处物理中止：write 工人从未 spawn（窗口内无 forge-coder 子会话创建、无其纪律请求）。

## 偏差与发现（如实）

1. **宿主坑（非本插件）**：`OPENCODE_CONFIG_DIR` 单独不足以隔离插件清单——真实全局 `~/.config/opencode/opencode.jsonc` 的 plugin 列表泄入沙盒（携带 10/1 旧发布副本，其旧版整类禁写文案先抛）。修复：XDG_CONFIG/DATA/CACHE_HOME 三件套指进沙盒。**后续所有沙盒 E2E 必带 XDG 三件套**（已同步进 adaptive-key 实验脚本）。
2. 宿主 task 工具必填 `description`（SchemaError）；且 schema 校验发生在插件 `tool.execute.before` 之后——无 description 的输入仍先撞形状闸（B 拒 A 过闸后撞 schema），反证闸位与行为正确。
3. 未覆盖（超出本 task，单测已覆盖）：空名册文案分支、override 抬离拒绝、`agent` fallback 字段、无 draft 放行——见 `tests/partition-wiring.test.mjs` recon gate 测试组。

## 判定

**两路径均 PASS**（`E2E-RESULT pathA=PASS pathB=PASS`，驱动 exit 0），与 delta 场景「Draft-plan interop is inherited」一一对应。
