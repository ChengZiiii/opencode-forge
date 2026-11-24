# Design: fix-test-runtime-namespace-isolation

## D1 — 两轴模型，严格增量

生产有两条互相独立的轴：HOME（配置发现）和 `<os-tmp>`（运行时产物）。

| 变量 | 替换哪一层 | 影响的产物 |
| --- | --- | --- |
| `FORGE_TEST_FORGE_HOME`（既有） | HOME | 配置发现；外加会话锚定台账（历史开关，不变） |
| `FORGE_TEST_RUNTIME_DIR`（新增） | `<os-tmp>` | 作业日志 / 幸存者注册表 / 作业台账、模型目录缓存、看门狗台账、诊断探针日志；台账在 HOME 别名未设时随它走 |

```ts
function forgeRuntimeTmp(): string | undefined {
  return process.env.FORGE_TEST_RUNTIME_DIR || undefined   // 生产：undefined
}
function forgeRuntimeRoot(): string {
  return join(forgeRuntimeTmp() ?? tmpdir(), "opencode-forge")
}
```

**取舍**：曾考虑让 `FORGE_TEST_FORGE_HOME` 顺手搬走整个命名空间（隔离更
“默认”）。否决：它在插件里是 12 处共用的 HOME 别名，语义是配置发现；扩
含义会连带改变沙箱布局和 29 个既有测试文件的假设。新增一个变量是严格增量。

三个助手对 `base` 的语义不一致，必须各按其约定传参：

| 助手 | `base` 是哪一层 | 生产调用点 |
| --- | --- | --- |
| `jobsLogDir(base)` | `opencode-forge` 根 | `jobsLogDir(forgeRuntimeRoot())` |
| `modelsDevCacheDir(base)` | `opencode-forge` 根 | 由 `loadModelsDevSnapshot({ cacheDir })` 内部再调一次 |
| `watchdogLogDir(base)` | `<os-tmp>` 层 | `watchdogLogDir(forgeRuntimeTmp())` |

诊断探针日志（`FORGE_*_PROBE` 开关，生产不开）原本 14 处直写
`join(tmpdir(), "forge-…-probe.log")`，统一改走 `probeTmp()`（= 同一个
`<os-tmp>` 层，不进 `opencode-forge/` 子目录）。

## D2 — 预加载，而不是逐个文件加导入

`tests/lib/test-runtime-namespace.mjs` 由规范入口 `--import` 进每个测试进程
（Node 的测试运行器把该旗标传给每个子进程），在任何测试模块求值之前设好
变量。隔离因此**按构造**成立，不靠任何人记得去改哪个文件。给会真实起作业的
4 个文件各加一行同款导入（带幂等守卫），是为了单独直跑时同样隔离。

不在这里设 `FORGE_TEST_FORGE_HOME`：一个测试是否看真实 `~/.config` 是它自己
的决定；预加载只决定产物写到哪里。

## D3 — 测试面导出生产函数本身

`__runtimeNamespaceTestSurface` 导出的是生产调用点用的**同一个**函数
（`jobLogDir` / `modelsDevCacheRoot` / `watchdogLogHome` / `probeTmp` /
`sessionAnchorLedgerPath`），没有平行的公式。

**教训（本 change 自己踩的）**：初版测试面里模型缓存目录是一句平行公式
`modelsDevCacheDir(forgeRuntimeRoot())`，而生产调用点把它的结果又传给了
`loadModelsDevSnapshot({ cacheDir })`——加载器内部会再拼一层 `models-dev`，
生产路径因此多套了一层目录。N1 比的是平行公式，没发现；是变异检查
（ns-3「调用点不传根目录」没有任何用例变红）把它暴露出来的。修正：调用点
传**根**（加载器自己追加 `models-dev`），并补一条走真实 `config` 钩子的
行为用例（N6）。

## D4 — 测试

| 用例 | 断言 |
| --- | --- |
| N1 | 四种环境下六个目录的解析结果；生产形态下与各 `src` 助手自己的默认值逐字节相等；同进程连问四次答案不同 = 用时解析 |
| N2 | 经 `server()` 真实起一个作业：日志与注册表只落在重定向命名空间，真实目录无痕 |
| N3 | 销毁时仍在跑的作业：被杀**且**台账行写在重定向命名空间，真实作业台账里没有它 |
| N4 | 预加载模块本身：任何加载它的进程都被重定向、目录建在 `<os-tmp>` 直下、退出即删；继承来的重定向原样保留且不被删 |
| N5 | 每个规范入口都带预加载（`package.json` / 验收门 / README / dev-loop） |
| N6 | 走真实 `config` 钩子（网络用桩）：模型快照落在重定向命名空间、只有一层 `models-dev`、真机那份快照的修改时间不变 |

## D5 — 验证

1. typecheck + 全量套件全绿。
2. **真机侧只读证明**：全量套件前后对 `%LOCALAPPDATA%\Temp\opencode-forge\`
   逐文件快照（相对路径 | 大小 | 修改时间），排除发起命令自己的作业文件，
   差异必须为零。
3. 变异检查（`mutate-batch.mjs`，每个变异改真实文件、跑对应测试、按字节
   还原并比对 SHA256；变异运行期间进程的 `TEMP`/`TMP` 指向私有目录）：

| 变异 | 必须变红 |
| --- | --- |
| ns-1 作业目录无视重定向 | N1 N2 N3 |
| ns-2 看门狗目录无视重定向 | N1 + watchdog-wiring 3.2 |
| ns-3a 调用点不传模型缓存根 | N6 |
| ns-3b 把已拼好的目录再传给加载器（双层 `models-dev`） | N6 |
| ns-3c 模型缓存根无视重定向 | N1 N6 |
| ns-4 台账去掉运行时目录回落 | N1 + 台账「随运行时目录走」 |
| ns-6 预加载模块变空操作 | N4 |
| ns-7 `package.json` 丢预加载 | N5 |
| ns-8 验收门丢预加载 | N5 |
| ns-9 探针日志无视重定向（又写回真实临时目录根） | N1 + watchdog-wiring 1.2 |

2026-11-24 实测：**19/19 全部被杀**（含台账 1 则、A 3 则、B 3 则、注册表 1 则），
六个被改文件按字节还原（SHA256 前后一致），变异运行前后真机目录零差异。

## D6 — 沙箱侧（harness，不入库）

沙箱宿主此前同样与真机宿主**共用**真实的作业注册表（靠文件锁互不踩，
但互相可「收养」对方的后台作业），并把探针日志写进真机临时目录根。现启
动时设 `FORGE_TEST_RUNTIME_DIR=<view-e2e>/sbx-tmp`，读取这些文件的 E2E 脚本
（23 个）同批改路径（`sbx-isolate-paths.mjs`，原件留 `.pre-sbx-tmp.bak`）。

## D7 — 已知边界

- 预加载把所有测试文件进程的产物汇到**同一个**私有目录（运行器父进程
  创建、退出时删）；运行器被强杀时该目录会残留（`%TEMP%\forge-test-ns-*`）。
- 模型目录缓存的网络抓取没有离线化（既有行为）：调 `config` 钩子的用例仍会
  真实访问 models.dev，只是缓存写进了私有目录。
