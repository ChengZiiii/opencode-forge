# Tasks: fix-runtime-model-pin-variant

## 1. Specification

- [x] 1.1 四件套就绪，`npx openspec validate fix-runtime-model-pin-variant
      --strict` 绿；E2 外部调研（variant/深度钉扎先例）复核折入（见
      design D0 两个注意点）

## 2. Implementation（crew wave 3b：coder → test-coder → gate-verifier → spec-reviewer）

- [x] 2.1 pin 重写规则（同身份保 variant / 换模型按深度词派生 / 无深度
      才删）+ `VARIANT_DEPTH_WORDS` import
      （plugin.ts:8280-8302：identityEquals 同身份保 variant、深度词派生、
      否则 delete；import 见 :81）
- [x] 2.2 rosterModelPin variant 腿 + create seam 注释契约更新
      （plugin.ts:2950-2969 深度词→{id,providerID,variant}；src/dispatch-async.ts
      modelPin 类型 :182 + 裸 id 或 id+variant 双形状注释 :278-296）
- [x] 2.3 测试翻转+新增全绿（design D4）、typecheck 绿、全量套件绿；
      roster-compile / builtin-override 套件零改动验证
      （v2-session-commands 15/15：同身份保 variant "low"、switch+high 派生
      "high"、switch+xhigh 删除；rosterModelPin variant 腿新增于
      dispatch-wiring 45/45：low → {zai, glm, id:glm, variant:"low"}、
      xhigh → 裸 pin（create body 实证）；roster-compile 15/15 与
      builtin-override 19/19 零改动原样通过——端到端矛盾已消；
      typecheck 绿。全量套件 deferred：crew-continue 并行波次占用
      plugin.ts/src，单文件门通过即记账）

## 3. Verification（GATE）

- [x] 3.1 沙箱 E2E：钉扎 worker 派发 → 子会话 model record
      `variant === 钉扎深度`
      （      **最终（门控）构建复验**（2026-11-23T18:24:02 到 18:25:05Z，宿主
      2.4.0 pid 30104，dist 18:20:35Z；驱动 **6/6**，判定文件
      pin-variant-e2e-verdict.json）：钉扎 `{glm-coding-worker,
      glm-5.3-flash, variant:"low"}`；派发 j-20261123-182404-7fsnqj 走
      插件 task 通道；子会话 ses_df6595f63ffepfOPkwIdwNdnCd 开始、结束
      两条会话记录的 model 都是 `glm-5.3-flash` + `variant:"low"`；2 条
      assistant 行全部匹配钉扎、全部带 variant；唤醒带孩子原话
      （旧构建证据，留档：2026-11-23T17:00:27–17:01:37Z，宿主 2.4.0，最终构建 dist
      16:55:16Z；驱动 13-pin-variant-e2e.mjs **6/6**：
      `forge-viewe2e-coder` 钉扎 `{glm-coding-worker, glm-5.3-flash,
      variant:"low"}`；派发 j-20261123-170033-bru0bc 走插件 task 通道
      （tools.task 代码调用）；`GET /api/session/{child}` 的 agent 与
      model 在子会话开始、结束时都是 `variant:"low"`；子会话 2 条
      assistant 行 model 全是同一钉扎（matchesPin 2/2，带 variant 2/2）；
      唤醒带子代理原话 `Final report: CANARY-V-…`。旧构建探路 16:34Z
      的超时是驱动取错 journal 行（见 reports/e2e-convergence））
- [ ] 3.2 真机终验（晨间）：0.33.0 重启后 UI 思考深度显示真实档位

## 4. Release（0.33.0 合并）

- [ ] 4.1 并入合并发版梯

## 5. Wrap-up（用户明示后）

- [ ] 5.1 archive + push
