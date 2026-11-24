# Design: fix-job-registry-first-run-enoent

## D1 — 在注册表构造里建目录，而不是在调用点

候选位置：

| 位置 | 取舍 |
| --- | --- |
| `acquireLock` 里建 | 锁是通用原语，不知道自己属于哪个目录；且 `rescan` 与 `mutate` 两处都要拿锁 |
| `ensureJobLifecycle` 调用前建 | 修了 `plugin.ts` 这一个调用方，`src/job-registry.ts` 的其它使用方（测试 / 脚本）仍会踩 |
| **`createJobRegistry` 构造时建**（采用） | 一处，对所有使用方生效；注册表路径在构造时即已知 |

```ts
try {
  mkdirSync(dirname(registryPath), { recursive: true })
} catch {
  // Unwritable location: the lock/open below reports it with its own error.
}
```

建不了（只读位置等）不在这里报错：随后的锁 / 打开会带出真实的系统错误，
不改变既有的失败形态。

## D2 — 为什么不顺手修 `jobsLifecycleStarted` 的置位顺序

缺陷的根因是「目录不存在」；置位顺序只是放大了后果。本 change 只修根因，
不重排 `ensureJobLifecycle`（它牵涉围栏 / 退出清理的建立时序，属结构性改动）。
「初始化中途失败后该进程永久无围栏」仍是理论上的残余路径（例如围栏创建
自身抛错），记入待办，不在本 change 内。

## D3 — 测试

| 用例 | 断言 |
| --- | --- |
| R1 | 全新临时目录下 `createJobRegistry` + `rescan` 不抛错；返回 `{adopted:[], dead:[]}`；`registry.json` 已写入；目录里没有残留的 `.lock` |
| R2 | `plugin.ts` 的生命周期状态在模块级——该文件独占进程，**第一个**作业在运行时目录完全不存在时跑通（输出含标记、标题 `exit 0`、无 ENOENT），`registry.json` 已写入 |

R2 不断言「围栏已装上」：真实围栏需要真实进程树，且该文件为不挂住事件循环
设了 `FORGE_TEST_NO_FENCE=1`（围栏行为由 `job-fence.test.mjs` 覆盖）。围栏
未装是**代码阅读**得出的后果（proposal Why 第 2–3 条），不是本测试直接证明的。

## D4 — 验证

1. 单测 + typecheck + 全量套件全绿。
2. 变异检查 `reg-1`：去掉构造里的 `mkdirSync` → R1、R2 以及
   `runtime-namespace` 的 N2、`shell-spawn-error-outcome` 的 B1 全部变红；
   还原后 SHA256 一致。（ns-5 已做过同款变异，本次以独立文件再确认。）
