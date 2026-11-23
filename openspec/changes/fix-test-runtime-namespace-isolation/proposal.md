# Proposal: fix-test-runtime-namespace-isolation

> 过夜自主闭环 2026-11-24 发现并实施。属用户目标判据「typecheck / 全量测试
> 零失败且不碰真机」的直接缺口：**全套单测一直在写真机宿主正在用的运行时
> 目录**。**未经用户单独批准**——依据是目标判据本身；产品路径逐字节不变；
> 用户可在晨间验收时否决。
> 过程中挖出的一个生产缺陷（注册表首跑 ENOENT）单独拆在
> `fix-job-registry-first-run-enoent`，便于分别追认。

## Why（2026-11-24 实测）

插件的每类运行时产物都落在 `<os-tmp>/opencode-forge/`——也就是**此刻真机
宿主插件正在用的那个目录**。全量单测跑一遍，往里写了：

| 真机路径（`%LOCALAPPDATA%\Temp\` 下） | 单测做了什么 | 根因 |
| --- | --- | --- |
| `opencode-forge\jobs\*.log` | 每轮新增十几份作业日志，真机宿主自己的旧日志被轮转删除（`DEFAULT_LOG_KEEP=50`） | `jobLogDir` 在 `plugin.ts` **模块加载时**定死 |
| `opencode-forge\jobs\registry.json` | 被测试进程覆写；`ensureJobLifecycle` 把真机宿主活着的幸存作业**收养进测试进程** | 同上 |
| `opencode-forge\models-dev\snapshot.json` | 每个调 `config` 钩子的用例都真实访问 models.dev 并改写它 | 调用点不传 `cacheDir`，落到助手默认值 |
| `opencode-forge\watchdog\` | 被 `watchdog-wiring.test.mjs` 3.2 **读完后整个删掉** | 同上（看门狗台账） |
| `opencode-forge\session-anchors.jsonl` | 测试夹具会话的绑定行 | 已由 `fix-session-anchor-ledger-use-time-path` 处理 |
| `forge-watchdog-probe.log`（临时目录根） | 被同一个测试删掉重写 | 诊断探针日志直写 `tmpdir()` |

没有实际损害（当晚真机注册表为空、日志只是诊断），但它正撞在目标判据上，
且「测试进程覆写真机注册表 / 读到真机状态」会让测试结果随真机状态漂移。

## What Changes

- **一个用时解析的 `<os-tmp>` 层**：`forgeRuntimeTmp()` / `forgeRuntimeRoot()`。
  新增测试专用变量 `FORGE_TEST_RUNTIME_DIR`，只替换 `<os-tmp>` 这一层；
  生产不设 → 每条路径逐字节不变。
- **`FORGE_TEST_FORGE_HOME` 含义一字不变**：它仍是 HOME 别名（配置发现），
  外加台账的历史开关；它**不**搬作业 / 缓存 / 看门狗目录（以前也不搬）。
  台账的解析顺序：HOME 别名 → `FORGE_TEST_RUNTIME_DIR` → 生产位置。
- **三个具名生产函数**（作业目录 / 模型缓存根 / 看门狗目录）+ 探针日志目录
  `probeTmp()`；生产调用点用的就是它们，测试面导出的也是它们。
- **规范测试入口带预加载**：`node --import ./tests/lib/test-runtime-namespace.mjs
  --test tests/*.test.mjs`（`package.json` / README / dev-loop / 验收门同改）。
  预加载模块给每个测试进程设一个私有临时目录并在退出时删除。
- 4 个会真实起作业的测试文件（我方所有的）各加一行同款导入，直接单跑也隔离。
- 单测 6 则（N1–N6）；沙箱宿主启动脚本同走该变量（harness 侧，不入库）。

## Impact

- `plugin.ts`：运行时目录解析（约 25 处引用改为经具名函数）；新增仅测试用
  导出 `__runtimeNamespaceTestSurface`。
- `tests/`：新增 `tests/lib/test-runtime-namespace.mjs`、
  `tests/runtime-namespace.test.mjs`；4 个既有文件各加一行导入；
  `tests/lib/test-env-home.mjs` 改为复用预加载并在退出时清理。
- `package.json` `test` 脚本、`README.md`、`docs/dev-loop.md`、
  `reports/e2e/acceptance-gate.mjs`（验收门自己跑的那遍全量单测也走预加载，
  超时由 30 分钟收到 10 分钟）、`reports/e2e/README.md`。
- 不改任何用户可见行为、不改文件格式、不迁移文件。版本：并入 0.33.1。

## 不在本 change 内

- `tests/worker-shell-session-allow.test.mjs` 属于别人在飞的 change，未动；
  规范入口下已由预加载覆盖，**单独直跑该文件**仍会把作业日志写进真实目录，
  待其属主加一行同款导入。
