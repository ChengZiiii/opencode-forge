# Tasks: fix-test-runtime-namespace-isolation

> **未经用户单独批准**（依据：目标判据「全量测试不碰真机」）；晨间验收时
> 可否决。否决的代价：全套单测恢复写真机运行时目录。

## 1. Specification

- [x] 1.1 草案成文；`openspec validate fix-test-runtime-namespace-isolation --strict` 绿
- [ ] 1.2 用户知悉 / 追认（晨间验收）

## 2. Implementation

- [x] 2.1 `<os-tmp>` 层用时解析 + `FORGE_TEST_RUNTIME_DIR`（design D1）
- [x] 2.2 三个具名生产函数 + `probeTmp()`；测试面导出它们（design D3）
- [x] 2.3 预加载模块 + 规范入口（`package.json` / README / dev-loop /
      验收门 / e2e README）+ 4 个文件的单跑对等导入（design D2）
- [x] 2.4 单测六则（design D4）

## 3. Verification（GATE）

- [x] 3.1 typecheck + 全量套件全绿
- [x] 3.2 全量套件前后比对真机运行时目录：零差异（design D5 第 2 条）
- [x] 3.3 变异检查 10 则全部被杀，源码按字节还原（design D5 第 3 条）
- [x] 3.4 沙箱 E2E 全套在新布局下通过（design D6）
      （0.33.1 的全部无头腿与有头 TUI 门都跑在
      `FORGE_TEST_RUNTIME_DIR=<沙箱>\sbx-tmp` 的宿主上：C1–C5、腿 C、
      完整 crew、F、A、B、C2；验收门 27 过 / 0 败）

## 4. Release

- [x] 4.1 并入 0.33.1
      （2026-11-24T00:57Z 发布，sha1 `d53d9e7d7d8f7749…`）

## 5. Wrap-up（用户明示后）

- [ ] 5.1 archive + push
- [ ] 5.2 `worker-shell-session-allow.test.mjs` 单跑隔离——交其属主（一行导入）
