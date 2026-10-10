# Design — postrelease-hardening

## Context

0.15.0/0.15.1 已发布（npm 实测 A+B PASS），发布后对抗性 crew（4/4 PASS）产出缺陷清单：P0-1 生产目录优先级压垮 anthropic 实证通道、P0-2 readonly 拒绝面缺 patch 族、P0-3 宿主 budget 改写（插件侧不可修，披露）、P1×3 spec 语义缺口、P2 卫生项。实证基础：`verify/adaptive-key.md`（reasoningEffort 被 anthropic 传输丢弃、`options.effort` → wire `output_config:{effort}`）、深度矩阵 L1-L6（宿主改写 budget_tokens→1024、目录原生写法透出、冻结、双形状）。

## Goals / Non-Goals

**Goals**：生产宿主（目录可达）上 anthropic 钉扎深度真实上 wire；readonly 形状的拒绝面与宿主写工具族对齐；冻结语义完整覆盖死角；实证限制全部落 README 披露；未归档两 change 的工件与实现对齐。
**Non-Goals**：不做传输层能力探测（D4）；不做 `effort:"none"` 宿主拒发的绕过（宿主行为，披露）；不改通道词典/档位表数值；不触碰已归档 change；不新增 capability。

## Decisions

### D1 — anthropic 实证矩阵优先于目录（家族门前置）
`resolveDepthChannel`：family=anthropic 时**先于目录咨询**直接按矩阵判定——`isAdaptiveAnthropic(modelID)` 为真 → adaptive-effort 通道；否则 → budget 档位表。目录对其余家族（openai/zai/未知中继）保持权威，链其余不动。
- 依据：1.18.34 世代 anthropic 传输丢弃 `options.reasoningEffort`（实证）、`output_config:{effort}` 可发声（实证）、thinking budget 结构可发声但值被改写（四组对照）。目录对 anthropic 的 effort 声明在该 wire 上不可发声——按它路由等于静默失效。
- 弃选 A「只豁免 adaptive 世代」：legacy（4-6、无次版本号）在生产目录下同样被路由到被丢弃的 effort 键——今天就是死的；矩阵化后走 budget（thinking 结构可发声，值被宿主改写为 1024——README 披露）。严格优于现状。
- 弃选 B「保留目录、仅对 anthropic 换键为 options.effort」：把「通道选择」与「键选择」搅在一起——目录 effort 梯子的原生大小写在该 wire 上无从验证，且 budget_tokens 形状的目录条目仍会落进被改写的 budget 路径，语义不一致。
- 风险与边界：矩阵硬编码了「当前宿主世代」的传输实证。未来宿主若原生支持目录 effort 形态，需要一个新 change 重新让位给目录——spec 措辞刻意写为 "empirically verified transport matrix of the current host generation"，矩阵隔离在单一函数（`resolveDepthChannel` 头部），README 注记。`-sandbox` 后缀等非目录 id 行为不变（矩阵同样适用，与既有 E2E 兼容）。

### D2 — 死角也冻结
no-mapping 解析结果（`translation: null`）写入会话冻结表，键/逐出语义与既有冻结完全一致（sessionID 键、session.deleted 逐出）。冻结路径补一行 probe trace。弃选「spec 注明例外」：mid-session 翻转违背已声明的首请求冻结不变量，且修法是一行。

### D3 — patch 族封印，单常量双面
`MUTATING_TOOLS` 增补 `patch/applypatch/apply/multiedit`，该常量同时喂 `forgeAgentDef` 物化 permission 与 `effectiveReadonlyShape` 抬离判定——两面一次修齐，不可能再漂移。抬离语义不变（override 值 ≠ deny 即抬离，fail-closed）。

### D4 — 不做传输层探测，改披露
插件在 chat.params 面上无法观测宿主传输层的键映射能力。弃选「运行时 canary 探测」：新失败面 + 成本 + 仍无法区分「传输丢弃」与「provider 拒绝」。落法：catalog change delta 的「宿主无 adaptive option → finding 而非静默 no-op」场景修订为「实证前提入 README 文档化限制」；本 change 的 MODIFIED requirement 已按此改写（"patched-host presumption … not a runtime-detectable condition"）。

### D5 — README/AGENTS 披露面
README：budget 表注记（本宿主世代 anthropic 传输把注入的 budget_tokens 统一改写为 1024——表值经 `FORGE_DEPTH_PROBE` trace 可证，wire 值以宿主为准）；anthropic 通道优先说明；`effort:"none"` 在 adaptive 通道被宿主传输拒发的注记；patch 封印行。AGENTS.md 架构行同步。

### D6 — 未归档 change 的 pre-archive 纠偏（一次性卫生）
catalog delta：adaptive 来源措辞（「来自目录数据」→ 家族矩阵实证，本 change 已吸收语义，其原文措辞同步修正防误读）+ 不可实现场景修订；recon delta：拒文案补 return-to-forge 指引措辞；两 change tasks.md 补勾（实现已完成且验证齐）；`verify/e2e-recon.md` agent-fallback「单测已覆盖」失实声明修正；zai wiring 注释过时修正。

## Risks / Trade-offs

- **矩阵绑宿主世代**（D1 已述）：单点函数隔离 + spec 措辞留了重新让位的口。
- **冻结死角可能掩盖 mid-session 修复**：与钉扎对语义一致（热应用承诺按 load 边界，新会话生效）；probe trace 可诊断。
- **patch 封印收紧了 override 语义面**：曾用 `permission:{patch:"allow"}` 显式抬离 readonly 的配置会在形状闸处失去豁免资格——与 write/edit/bash 同待遇，spec 场景已言明。
