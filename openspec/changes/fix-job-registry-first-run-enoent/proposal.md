# Proposal: fix-job-registry-first-run-enoent

> 过夜自主闭环 2026-11-24 **发现的生产缺陷**，在给单测做运行时目录隔离
> （`fix-test-runtime-namespace-isolation`）时被一个「干净命名空间」的用例
> 炸出来的。这是一个真实的行为修复，**未经用户单独批准**——依据是目标
> 「不会有任何 bug，持续测试和迭代直到完美运行」；用户可在晨间验收时否决。

## Why

触发条件只有一个：宿主的 `<os-tmp>/opencode-forge/jobs` 目录**还不存在**
——全新安装后的第一次使用，或者临时目录被清理之后。

第一次起作业时的调用链：

```
ensureJobLifecycle()
  jobsLifecycleStarted = true                 ← 先置真
  createJobRegistry(<jobs>/registry.json)
  registry.rescan(…)                          ← 无条件先拿锁
    acquireLock(<jobs>/registry.json.lock)      openSync(lock, "wx")
      → ENOENT（目录不存在）
```

`writeRaw` 确实会建目录，但排在拿锁**之后**。锁文件和注册表并排放在
`jobs\` 里，目录不存在时第一次 `openSync` 就失败，而此前没有任何代码会去
建这个目录。

后果不止「第一次调用失败」：

1. 第一次 `forge_shell` 以 ENOENT 失败；
2. `jobsLifecycleStarted` 已经是 true，后续调用直接
   `return { registry, fence: jobFence }`——而 `jobFence` 从未被赋值；
3. 于是**该宿主进程余生**：没有 Windows 作业对象围栏、没有退出清理
   （`exitCleanup` 未创建）、不再收养 / 记账幸存作业。第二个作业起能跑
   （作业运行器会建日志目录），但**无围栏**，直到宿主重启。

开发机上该目录一直存在，所以从未暴露。

## What Changes

- `createJobRegistry()` 构造时先确保注册表所在目录存在（幂等；建不了则
  由后面的锁 / 打开报出自己的错）。一处，`src/job-registry.ts`。
- 回归测试两则（自成文件，独占进程，保证「本进程第一个作业」就是首跑场景）：
  - R1：目录不存在时注册表的第一次 `rescan` 不抛错，注册表落盘，锁已释放；
  - R2：运行时目录完全不存在的宿主上，第一个真实作业跑通，注册表已写入。

## Impact

- `src/job-registry.ts`：`createJobRegistry` 开头一处 `mkdirSync`。
- `tests/job-registry-first-run.test.mjs`（新增）。
- 目录已存在的宿主：行为逐字节不变（`mkdirSync` recursive 对已存在目录是
  空操作）。
- 版本：并入 0.33.1。
