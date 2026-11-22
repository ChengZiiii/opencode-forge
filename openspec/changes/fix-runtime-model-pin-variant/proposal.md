# Proposal: fix-runtime-model-pin-variant

## Why

钉扎 worker 的子会话在宿主 UI 里思考深度显示 **Default**。真机排查实锤
丢失点：v2 context 钩子的 runtime model pin 重写 payload.model 后显式
`delete m.variant`（plugin.ts:8159）——把宿主从编译产物 `.md` 的
`provider/model#low` 原生解析出的 variant 删掉了。

历史脉络：归档设计（2026-11-20-v2-runtime-model-pin）当时裁定"variant
删除无妨——没有 v2 用户有 variant 契约"——**写在 roster 编译把
`#variant` 钉进 .md 之前**。如今编译侧已是"variant 通道 = 运行时实证
的稳健深度面"（roster-compile.ts:17-20 头注 + spec
"Native roster compilation" :911/:927-929 场景钉死），运行时 pin 却
把它删了——**两套测试各自钉住矛盾的端到端真相**（roster-compile 发射
`#low`；v2-session-commands:178 断言 variant 被删），矛盾即 bug。

## What Changes

- pin 重写规则（替换 :8159 的无条件 delete）：
  1. **钉扎身份 == 当前解析身份**（providerID+modelID 相等，含"重写成
     同一个模型"的隐形 no-op 情形）→ **保留 `m.variant`**——宿主原生
     解析的 `#low` 存活，UI 恢复真实深度显示；
  2. **真换模型** → variant 从 recipe 的 `thoughtLevel` 派生
     （`VARIANT_DEPTH_WORDS` ∈ {low, medium, high} 时
     `m.variant = depth`），否则才删除（旧模型的 variant 对新模型无
     意义）。
- 创建期 modelPin 补腿：`rosterModelPin`（:2808-2814 现为裸 id）在
  recipe 深度是 variant 词时携带 variant（record 形状已支持，
  dispatch-async.ts:155-161）——SDK 子会话路径不依赖宿主预解析也拿到
  正确 variant。
- 深度 options 注入（applyDepthTranslation → options.reasoningEffort）
  **保持不动**：`#low` 与 `options` 双通道同值投递无害，本轮不扩爆炸
  半径（design D3 记账）。
- 规范：forge-subagents "Runtime model pin on v2 hosts" 的
  "variant dropped" 措辞修正为"匹配保留/换模型派生"。

## Impact

- 代码：plugin.ts（pin 重写段 :8138-8169、rosterModelPin :2808-2814）、
  从 roster-compile import `VARIANT_DEPTH_WORDS`。
- 测试：v2-session-commands:163-195 断言翻转（同身份保 variant /
  换模型派生 / 非深度换模型才删）；rosterModelPin variant 腿新用例；
  roster-compile / builtin-override 套件**不动**（此后两套真相一致）。
- 兼容：非 `forge-` 前缀的编译 override（general/explore）本就不进 pin
  块，不受影响；无 thoughtLevel 的 recipe 行为不变（换模型才删
  variant，与旧行为一致）。
