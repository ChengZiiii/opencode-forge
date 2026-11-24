# Design: fix-session-anchor-ledger-use-time-path

## D1 — 改法

```ts
// 改前（模块顶层，求值一次）
const sessionAnchorLedgerPath = join(process.env.FORGE_TEST_FORGE_HOME ?? tmpdir(), "opencode-forge", "session-anchors.jsonl")

// 改后（每次取用都重新解析）
function sessionAnchorLedgerPath(): string {
  return join(process.env.FORGE_TEST_FORGE_HOME ?? tmpdir(), "opencode-forge", "session-anchors.jsonl")
}
function sessionAnchorLedgerFs(): SessionAnchorLedgerFs {
  const filePath = sessionAnchorLedgerPath()
  if (sessionAnchorLedgerFsFactory) return sessionAnchorLedgerFsFactory(filePath)
  return { read: …readFileSync(filePath)…, write: …, append: … }
}
```

`sessionAnchorLedgerFs()` 一次调用内只解析一次路径，读 / 写 / 追加三个
闭包共用同一个值（一次 FIFO 压缩里的读 + 写不会跨到两个文件）。

最终表达式多了一级（由 `fix-test-runtime-namespace-isolation` 补上，生产
值不变）：

```ts
join(process.env.FORGE_TEST_FORGE_HOME ?? forgeRuntimeTmp() ?? tmpdir(), "opencode-forge", "session-anchors.jsonl")
```

## D2 — 为什么不挨个改测试文件

给每个测试文件加一个「先执行的环境准备模块」也能修，但要动十几个文件，
而且下一个新测试文件还会再踩。改在读取点上一处生效，且与同文件其余
十几处「调用时读取」的写法一致。

## D3 — 测试

| 用例 | 断言 |
| --- | --- |
| 测试体里设置 HOME 别名后触发绑定 | 台账文件出现在该目录下，内容含该会话 |
| 只设运行时目录重定向（`FORGE_TEST_RUNTIME_DIR`） | 台账跟着走（`fix-test-runtime-namespace-isolation` 补的一级） |
| 两个都不设（生产形态） | 解析结果是 `<os-tmp>/opencode-forge/session-anchors.jsonl` |

不断言真实台账文件「没被写」——那需要测试去读真机文件，本身就违背本
change 的目的。真机侧的证明放在验证里（跑全量套件前后比对真实台账目录，
只读）。

用例落在 `tests/session-anchor-resolution.test.mjs`（与 A 同文件，共用
测试面）。

## D4 — 验证（2026-11-24 完成）

1. typecheck + 全量套件全绿（1032/1032）。变异检查 `ledger-1`：把路径改回
   模块加载期解析 → 三则台账用例恰好全部变红、A5 仍绿；还原后 SHA256
   一致（`mutate-batch.mjs`）。
2. 全量套件前后比对 `%LOCALAPPDATA%\Temp\opencode-forge\` 逐文件的
   大小与修改时间（只读，排除发起命令自己的作业文件）：**零差异**。
