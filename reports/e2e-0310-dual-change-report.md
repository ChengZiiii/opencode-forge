# E2E 报告：0.31.0 双 change 沙盒（真实 2.3.2 宿主全链）— **被阻断（未执行）**

- 日期：2026-11-21
- 子代理：forge-plugindev-e2e-verifier（GLM-5.3）
- 仓库：`opencode-forge/`
- 计划矩阵：9 场景（/forge 命令注册面、sync 强制杆、init 拒改、init global 惰性、builtin-override 激活全链、GC 回收、碰撞红线、CONFIG_DIR 镜像 D5、工作区 override 忽略）

## ⛔ 逐字上报：执行通道被拒

全部 shell 通道被拒。两次调用（一次裸 `command`、一次按
`search()` 返回的正式签名带 `workdir`），均逐字返回：

```
Permission denied: forge_shell
```

按治理契约（拒绝即停该线工作、不得绕过、不得即兴替代通道），
本任务的**全部 9 个场景均未执行**：

| # | 场景 | 状态 |
| --- | --- | --- |
| 1 | /forge 命令注册面（GET /api/command 或 /doc） | **BLOCKED**（未执行） |
| 2 | /forge sync 强制杆 + 不敲命令零自动写对照 | **BLOCKED**（未执行） |
| 3 | /forge init 拒改红线（REFUSE-and-review、字节不动） | **BLOCKED**（未执行） |
| 4 | /forge init global 惰性脚手架（override 全注释、内置原样） | **BLOCKED**（未执行） |
| 5 | builtin-override 激活全链（小写落地、description/model 覆盖、无重复条目） | **BLOCKED**（未执行） |
| 6 | GC 回收（general.md 消失、内置恢复） | **BLOCKED**（未执行） |
| 7 | 碰撞红线（手写文件拒改+兄弟 fail-soft） | **BLOCKED**（未执行） |
| 8 | CONFIG_DIR 镜像 D5（假 home/.config 对照） | **BLOCKED**（未执行） |
| 9 | 工作区 override 节忽略（warn finding+零发射） | **BLOCKED**（未执行） |

无沙盒搭台（无 serve 进程、无 <tmp>/ws、无隔离环境变量设置），因此也
无沙盒卫生问题、无真实面接触、无实现 bug 发现、无源码改动。本报告文件
是本次任务唯一的写入。

## 拒绝前完成的只读静态核查（非 E2E，仅旁证）

用 forge_grep（只读）确认 **dist/index.js 已包含双 change 实现**（回应
implement 报告中 "bundle 未跑" 的遗留风险）：

- `compileOverrideEntry`（dist L16343）、`globalAgentDirFor`（L16369）、
  `planOverrideSync`（L16379）在 dist 中在场；
- 发射接线在场：`planOverrideSync(resolution.overrides ?? {}, { dir:
  globalAgentDirFor({ homeDir: …, configDir: process.env.OPENCODE_CONFIG_DIR }) …})`
  （dist L17976-17977）；
- 工作区 override 忽略 warn 在场：`override-node-ignored-workspace`，
  文案含 "GLOBAL-layer-only … field ignored"（dist L16157）；
- v1 命令注册在场：`cfg.command["forge"] ??= {`（dist L21410）；
- 脚手架常量在场：`GLOBAL_RECIPE_SCAFFOLD_JSONC`（dist L17822）。

旁证 ≠ 验证：以上只说明 dist 构建已含代码，不构成任何行为判定。
9 场景的 PASS/FAIL 判定全部缺失，需 shell 通道解禁后由后续 verifier
按原 dispatch 提示（三件套 + XDG_DATA_HOME/XDG_STATE_HOME + serve
CWD=沙盒工作区 + 显式 --port）重跑。

## 现场冻结清单

- forge_shell 两次拒绝原文：`Permission denied: forge_shell`（如上）。
- 拒绝发生于任何沙盒搭台之前——无进程、无文件、无端口占用需要清理。
- 仓库源码 / git / 真实 config / 真实进程：零接触、零改动。

## 结论

**E2E 未执行（通道被拒）。9/9 场景 BLOCKED，无 PASS/FAIL 判定可给。**
唯一可信旁证：dist 已含双 change 实现（grep 行号如上）。
