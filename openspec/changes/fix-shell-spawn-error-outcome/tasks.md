# Tasks: fix-shell-spawn-error-outcome

> 用户已批准（2026-11-23「A+B我都批」），按草案实施。

## 1. Specification

- [x] 1.1 用户批准草案；
      `openspec validate fix-shell-spawn-error-outcome --strict` 绿

## 2. Implementation

- [x] 2.1 `forgeShellExecute` 前台 `exited` 分支按 `spawnError` 分叉
      （design D1）
- [x] 2.2 `forge_jobs poll` 终态文案对齐（design D2；手段 = `Job.spawnError`，
      见 design D6）
- [x] 2.3 单测三则（design D3）+ typecheck + 全量套件全绿 + 变异检查
      （b-1 / b-2 / b-3 全部被杀）

## 3. Verification（GATE）

- [ ] 3.1 沙箱 E2E：不存在的 cwd → 工具返回原文逐字比对（design D4）

## 4. Release

- [ ] 4.1 并入 0.33.1

## 5. Wrap-up（用户明示后）

- [ ] 5.1 archive + push
