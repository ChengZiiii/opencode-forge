# Tasks: fix-job-registry-first-run-enoent

> **未经用户单独批准**（依据：目标「不会有任何 bug」）；晨间验收时可否决。

## 1. Specification

- [x] 1.1 草案成文；`openspec validate fix-job-registry-first-run-enoent --strict` 绿
- [ ] 1.2 用户知悉 / 追认（晨间验收）

## 2. Implementation

- [x] 2.1 `createJobRegistry` 构造时确保注册表目录存在（design D1）
- [x] 2.2 回归测试两则（design D3）

## 3. Verification（GATE）

- [x] 3.1 typecheck + 全量套件全绿
- [x] 3.2 变异检查 `reg-1` 被杀，源码按字节还原（design D4）

## 4. Release

- [ ] 4.1 并入 0.33.1

## 5. Wrap-up（用户明示后）

- [ ] 5.1 archive + push
- [ ] 5.2 待办转出：`ensureJobLifecycle` 初始化中途失败后该进程永久无围栏
      （design D2）——是否重排置位顺序 / 加失败复位，另立 change
