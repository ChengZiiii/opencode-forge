# Tasks: fix-runtime-model-pin-variant

## 1. Specification

- [x] 1.1 四件套就绪，`npx openspec validate fix-runtime-model-pin-variant
      --strict` 绿；E2 外部调研（variant/深度钉扎先例）复核折入（见
      design D0 两个注意点）

## 2. Implementation（crew wave 3b：coder → test-coder → gate-verifier → spec-reviewer）

- [ ] 2.1 pin 重写规则（同身份保 variant / 换模型按深度词派生 / 无深度
      才删）+ `VARIANT_DEPTH_WORDS` import
- [ ] 2.2 rosterModelPin variant 腿 + create seam 注释契约更新
- [ ] 2.3 测试翻转+新增全绿（design D4）、typecheck 绿、全量套件绿；
      roster-compile / builtin-override 套件零改动验证

## 3. Verification（GATE）

- [ ] 3.1 沙箱 E2E：钉扎 worker 派发 → 子会话 model record
      `variant === 钉扎深度`
- [ ] 3.2 真机终验（晨间）：0.33.0 重启后 UI 思考深度显示真实档位

## 4. Release（0.33.0 合并）

- [ ] 4.1 并入合并发版梯

## 5. Wrap-up（用户明示后）

- [ ] 5.1 archive + push
