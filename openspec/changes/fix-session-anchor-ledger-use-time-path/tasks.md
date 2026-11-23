# Tasks: fix-session-anchor-ledger-use-time-path

## 1. Specification

- [x] 1.1 草案成文；`openspec validate fix-session-anchor-ledger-use-time-path --strict` 绿
- [ ] 1.2 用户知悉（未经单独批准，依据目标判据；晨间验收时可否决）

## 2. Implementation

- [x] 2.1 台账路径改为用时解析（design D1）
- [x] 2.2 单测三则（design D3）+ typecheck + 全量套件全绿 + 变异检查
      （`ledger-1` 被杀）

## 3. Verification（GATE）

- [x] 3.1 全量套件前后比对真实运行时目录：零差异（design D4 第 2 条）

## 4. Release

- [ ] 4.1 并入 0.33.1
