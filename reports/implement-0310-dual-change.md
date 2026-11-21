# 实现报告：0.31.0 双 change（forge-commands + builtin-override）

- 日期：2026-11-21
- 子代理：forge-plugindev-coder（GLM-5.3）
- 仓库：`opencode-forge/`（apply 已由 owner 批准，2026-11-21）

## ⚠️ 验证被拒（逐字上报）

本子代理的全部 shell 通道被拒，两次调用（相对 workdir 与绝对 workdir 各一次）均返回：

```
Permission denied: forge_shell
```

按治理契约（拒绝即停该线工作、不得绕过），以下步骤**均未执行**，需
父会话/verifier 补跑：

- `bun run typecheck`
- `node --test tests/*.test.mjs`（812 基线确认 + 新增测试）
- `bun run bundle`（dist 入库重建）
- `openspec validate --all`
- conventional commits / 不 push / 不 publish（同样未做）

代码经逐段人工复读核验（语法/类型判别式/测试断言与模板逐字对齐），
但**未经机器验证**——上列表绿之前不得视为完成。

## forge-commands — tasks 状态

| task | 状态 | 证据 |
| --- | --- | --- |
| 1.1 /forge sync | ✅ | `plugin.ts` `FORGE_COMMAND_TEMPLATE`（~L257-271）：`Argument "sync"` → 调 forge_sync NOW + 逐字上报 diff + "manual force lever…unchanged"；v1 注册 `cfg.command["forge"] ??=`（~L5432）；v2 `addTemplateCommand("forge", …)`（~L7044-7049）；FAMILY GUARD step-0 以 forge_sync 工具在手为判（~L260） |
| 1.2 /forge init | ✅ | 模板 `Argument "init"` 行（~L264）：访谈/项目上下文起草 .opencode/forge.json；已存在 → "REFUSE to change it…NEVER overwrite or rewrite"（拒改只给看）；写仅限显式 go-ahead、走正常写工具、热应用 |
| 1.3 /forge init global | ✅ | 模板 `Argument "init global"` 行（~L265）+ 内嵌 `GLOBAL_RECIPE_SCAFFOLD_JSONC`（~L225-255，override 节全注释） |
| 1.4 crew 拒文案指路 | ✅ | `plugin.ts` ~L4418 新增一行 `Levers: … /forge init … /forge init global …`；门语义其余零动（仅加行） |
| 2.1 测试矩阵 | ✅ | `tests/forge-commands.test.mjs`（9 tests，见下） |
| 2.2 README | ✅ | "no /forge command family" 注（原 L694）替换为 /forge 家族表（sync/init/init global 三行）；File ledger merged-config 行加 `command.forge` |

## builtin-override — tasks 状态

| task | 状态 | 证据 |
| --- | --- | --- |
| 1.1+1.2 全局脚手架（注释 override 节） | ✅ | `GLOBAL_RECIPE_SCAFFOLD_JSONC`（plugin.ts）——override 节与两条目全为 JSONC 注释、Auto worker 语义、"REPLACES the built-in's prompt wholesale（绝不抄官方文本）"均在注释内；经 /forge init global 与 crew 拒文案 Levers 行交付 |
| 1.3 编译器 | ✅ | `src/roster-compile.ts`：`compileOverrideEntry`（**case-lock**：仅 `general`/`explore` 小写 stem 出 `<id>.md`，大写/未知 id 返回 null 永不发射；marker、mode:subagent、model#variant 同工人规则、tools 面按 shape）；`planOverrideSync`；`executeRosterSync` 判别式 `kind:"override"` → **碰撞红线**（存在同名且无 GENERATED marker → 拒+披露，字节不动，兄弟条目照常）+ **GC 按 marker 且仅枚举 general.md/explore.md**（forge-* 产物对该 plan 不可见，反之 family plan 也收不走 override 文件）；`FamilySyncPlan` 加判别式 `kind:"family"` |
| — 配方键（D1） | ✅ | `src/forge-config.ts`：`BUILTIN_OVERRIDE_IDS`、`validateOverrideNode`（未知 id warn+skip、半对 error+skip、fail-soft）；池解析器 `readPool`：global 文件 override → `PoolResolution.overrides`；**工作区 override 节 → warn `override-node-ignored-workspace` + 忽略**（工作区池恒命名空间化） |
| — agentDirFor 镜像（D5） | ✅ | `globalAgentDirFor({homeDir, configDir})`：`OPENCODE_CONFIG_DIR` 设 → `$CONFIG_DIR/agent`；未设/空白 → `<home>/.config/opencode/agent`（分隔符风格保留）；单测锁两分支（含斜杠风格/尾分隔符/空白） |
| — 发射接线 | ✅ | `plugin.ts` `runRosterSync`：`planOverrideSync(resolution.overrides, {dir: globalAgentDirFor(…OPENCODE_CONFIG_DIR…), recipeFile: globalPoolPathOf()})` 并入 plans → forge_sync 工具与 /forge sync 共用；无任何 override → plan 为 null，零发射 |
| — schema | ✅ | `schema/forge.schema.json` 新增 `override` 节（propertyNames enum 锁 `[general, explore]`，描述含 GLOBAL-only/lowercase/wholesale/碰撞红线）；`bun run bundle` 会再拷贝进 dist（**未跑**） |
| 2.1 测试矩阵 | ✅ | `tests/builtin-override.test.mjs`（15 tests，见下） |
| 2.2 README 手册 | ✅ | 新小节 "Built-in subagent overrides (general/explore)"（identity key 小写、**激活=连 prompt 一起换（绝不抄官方文本）——写你自己的 general/explore**、默认惰性=官方逐字节、global-only、碰撞红线、marker GC、全局 agent 目录解析、脚手架路径）；File ledger 加 override 产物行（无前缀、marker 键 GC）；字段参考顶层清单加 `override` |

自动化零变化（forge-commands D5）：staleness gate、纯派发 sync 提示、
`sync:"auto"` 路径（plugin.ts ~L7355 起）逐字节未动——override 产物只经
forge_sync 工具//forge sync 手动杆更新。

## 新增测试清单

`tests/forge-commands.test.mjs`（9）：
1. /forge template: one command, $ARGUMENTS routing — all three forms plus the help fallback
2. /forge template: FAMILY GUARD step-0 names the forge agent and the forge_sync tool
3. /forge sync: instructs an immediate forge_sync call with a verbatim diff report; automation posture unchanged (D5)
4. /forge init: names the workspace recipe, the interview/context drafting flow, and the refuse-if-exists guard
5. /forge init global: same flow for the global recipe with the override entries COMMENTED (inert by default)
6. scaffold: inert by default — the override node and every entry are JSONC comments, no active override
7. /forge template: the commands never write — every write rides a tool, transcript-visible
8. v1 config hook registers command.forge (template constant, no-clobber on a user-defined entry)
9. v2 command domain registers the forge command (execute-type, sends the same template)
10. crew_begin unconfigured refusal names the /forge init levers alongside the in-band ask (gate semantics untouched)

`tests/builtin-override.test.mjs`（16）：
1. override node: absent/null node is inert
2. override node: known lowercase ids validate like agent defs
3. override node: unknown ids warn + skip; capitalized negative form never survives
4. override node: half-configured pair skips the entry, siblings still apply
5. override node: non-object node warns and is ignored
6. resolver: the GLOBAL file's override node surfaces on the resolution
7. resolver: a WORKSPACE override node is ignored with a warn finding
8. resolver: no override node anywhere — empty overrides, zero findings
9. compileOverrideEntry: lowercase stems emit with marker, mode:subagent, model#variant, tools face per shape
10. compileOverrideEntry: capitalized ids are NEVER emitted
11. compileOverrideEntry: Auto override (no pair) emits no model key
12. globalAgentDirFor: both branches (+separators/trailing/blank)
13. planOverrideSync: no overrides → null; valid → files in builtin order
14. executeRosterSync (override): emits lowercase files; re-plan without the entry GCs them marker-keyed
15. executeRosterSync (override): collision redline（拒+披露+字节不动+兄弟照常）
16. executeRosterSync (override): hand-written never GC'd；forge-* 同目录互不可见
17. executeRosterSync (override): marker-carrying file updates normally
18. schema mirror: override propertyNames enum == BUILTIN_OVERRIDE_IDS

（个别文件内编号连排，实数以文件为准。）

## Commits

**未产生**——git 命令被 forge_shell 拒绝通道阻断。建议提交切分：
- `plugin: /forge command family (sync/init/init global) + crew refusal lever line`
- `src: builtin-override recipe key + case-locked compiler + collision redline + globalAgentDirFor mirror`
- `tests: forge-commands + builtin-override suites`
- `docs: README /forge family inventory + built-in override handbook + file ledger`
- `chore: schema override node`

## 812 基线确认

**未确认**——`node --test` 未运行（forge_shell 被拒）。风险点已人工排查：
- `planRosterSync` 产物新增 `kind:"family"` 判别式——现有测试仅按
  `.files`/`.dir` 索引，无 deepEqual 整个 plan 对象；
- `PoolResolution` 新增 `overrides` 字段——hierarchical-pools 仅 deepEqual
  `.families`（空数组断言），不受影响；
- `validateAgentSet` 新参带默认值——默认调用消息逐字节不变；
- executeRosterSync 的 GC 谓词在 family 路径与原 `forge-` 前缀判定等价。

## 沙盒/live E2E

未执行（同上）；按 dispatch 提示留给后续 verifier：三件套 +
`XDG_DATA_HOME`/`XDG_STATE_HOME`；显式 `--port` 不写 service.json；
`OPENCODE_CONFIG_DIR` 设定时全局 agent 目录=$CONFIG_DIR/agent。
