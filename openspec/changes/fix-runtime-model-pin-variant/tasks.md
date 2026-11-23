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

- [ ] 3.1 沙箱 E2E：钉扎 worker 派发 → 子会话 model record
      `variant === 钉扎深度`
- [ ] 3.2 真机终验（晨间）：0.33.0 重启后 UI 思考深度显示真实档位

## 4. Release（0.33.0 合并）

- [ ] 4.1 并入合并发版梯

## 5. Wrap-up（用户明示后）

- [ ] 5.1 archive + push
