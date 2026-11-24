# Proposal: fix-session-anchor-ledger-use-time-path

> 过夜自主闭环 2026-11-23 发现。属用户目标判据「typecheck / 全量测试
> 零失败且不碰真机」的直接缺口；产品行为不变，只改测试落到哪里。
> **未经用户单独批准**——依据是目标判据本身；用户可在晨间验收时否决。

## Why

会话锚定台账的路径在 `plugin.ts` **模块求值时**解析：

```ts
const sessionAnchorLedgerPath = join(process.env.FORGE_TEST_FORGE_HOME ?? tmpdir(), "opencode-forge", "session-anchors.jsonl")
```

测试文件想在跑之前把台账重定向进临时目录，写的是：

```js
import { … } from "../plugin.ts"      // ESM：import 整体提升
process.env.FORGE_TEST_FORGE_HOME = mkdtempSync(…)   // 太晚——模块已求值
```

ESM 把全部 `import` 提升到模块体最前面，所以这行赋值永远晚于
`plugin.ts` 的求值。结果是：**全套单测里凡是触发台账写入的用例，写的都
是真实的 `%LOCALAPPDATA%\Temp\opencode-forge\session-anchors.jsonl`**
（2026-11-23 实测：该文件里留有测试夹具会话的行）。

同文件其余十几处 `FORGE_TEST_FORGE_HOME` 的读取都是在**调用时**求值
（`process.env.FORGE_TEST_FORGE_HOME ?? homedir()` 写在函数体里），所以
只有台账这一处漏了。

## What Changes

- 台账路径改为**每次使用时**解析（同一个表达式，从模块顶层挪进函数）。
- 产品行为逐字节不变：生产环境不设 `FORGE_TEST_FORGE_HOME`，解析结果
  与现在完全相同；注入用的 `sessionAnchorLedgerFsFactory` 不变。
- 单测三则：测试体里（import 之后）设置 HOME 别名并触发一次绑定 → 文件
  落在测试目录；运行时目录重定向在 HOME 别名未设时带着台账走；两个都
  不设 → 生产位置。

## 后续（2026-11-24）

排查同一问题（单测写真实目录）时发现作业日志 / 注册表 / 模型缓存 /
看门狗目录也都落在真机目录——范围更大，另立
`fix-test-runtime-namespace-isolation`。它给本 change 的解析顺序补了中间
一级（HOME 别名 → `FORGE_TEST_RUNTIME_DIR` → 生产位置），并把这里的三则
用例并进了 `tests/session-anchor-resolution.test.mjs`（原计划的独立文件
`session-anchor-ledger-path.test.mjs` 未建）。本 change 的目标（单测不写
真实台账）已由两者共同达成，全量套件前后真机目录零差异可证。

## Impact

- `plugin.ts`：`sessionAnchorLedgerPath`（常量 → 函数）及其引用。
- `tests/`：`session-anchor-resolution.test.mjs` 里的三则台账用例 +
  `tests/lib/test-env-home.mjs`（import 期设置 HOME 别名）。
- 不改任何用户可见行为，不改台账格式，不迁移文件。
- 版本：并入 0.33.1（与 F / A / B 同梯，保证该梯的全量测试不碰真机）。
