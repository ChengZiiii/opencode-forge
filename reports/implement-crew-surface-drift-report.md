# implement-crew-surface-drift — fix-v2-crew-surface-drift (tasks 1.x–3.x) 实施报告

日期：2026-11-21 · 仓库：opencode-forge · 宿主沙盒：opencode v2.3.2（win32）
状态：**tasks 1.1–3.3 全部完成**；4.1（沙盒 E2E 全链）/4.2（发版）留给后续波次。

## 改动文件清单

| 文件 | 改动 |
| ---- | ---- |
| `plugin.ts` | ① 共享锚缝（task 1.1）：`AnchorClient` 类型 + `anchorClientShared` 模块态 + `sharedAnchorClient()`，种子时机=皮带今天拿到的时机——v1 `server()`（`jobClient = input.client` 处，同源一并 seed）与 v2 `v2Setup`（`v2AnchorClient(ctx)`，同值传给 `v2RegisterToolHooks`）。② crew 门锚统一（task 2.1，D1）：`crew_begin` 的 roster 解析/`ensureSession` 绑定/crew 记录路径（含 compliance 预检）全部改走 `resolveSessionAnchorForPools`，**无 client（无 `session.get`）时精确回退 `sessionAnchor(context)`=今天行为**。③ task 工具守卫（task 2.2）：`TASK_SEAM_DEGRADED_ERROR` 契约常量（指名 native task tool）+ 入口 `typeof client.session?.create` 探测；父目录（task 2.3）从权威锚链解析（无 client 时回退工具上下文锚）。④ `v2SessionClient` 适配层：映射 `ctx.session.create`——v1 `{body,query}` 信封 → 2.3.2 扁平单对象（`parentID/title/permission/permissions/directory`），裸记录响应回包成 `{data}` 信封；`V2PluginContext.session` 类型补 `create?`。v1 server() 路径除共享锚 seed（一行）外零改动。 |
| `src/dispatch-async.ts` | `TASK_CREATE_SEAM_ABSENT` 哨兵 + `createChildSession` 前置守卫缝探测（absent/null client → 哨兵，绝不裸 TypeError）；响应双形状（v1 `{data,error}` 信封 / 2.3.2 裸记录）都解析；`QUESTION_DENY_PERMISSIONS_V2`（`{action,resource,effect}` 新拼写，probe-1.1 实证旧拼写被 2.3.2 静默丢弃）——question-deny body 同时携带两代拼写，各代宿主各读各的键。 |
| `tests/lib/v2-mock-context.mjs` | mock session 域补 `create`（记录扁平入参、返回裸记录）+ `state.creates`。 |
| `tests/dispatch-async.test.mjs` | 核心守卫测试 ×1（缝缺失→哨兵精确断言；null client 同判；裸记录→sessionID 解析）。 |
| `tests/dispatch-wiring.test.mjs` | ×2：缺缝→`TASK_SEAM_DEGRADED_ERROR` 逐字契约断言；权威锚父目录（record 指向池目录、工具上下文指向无池目录 → `query.directory`=record 目录）。 |
| `tests/hierarchical-pools.test.mjs` | 3.1 锚矩阵 ×3：(a) 权威池记录赢过陈旧无池工具上下文（live 复现变回归，含 crew 记录落点断言）+空 home（无全局层）；(b) 无 client 精确今天行为（无池工具上下文→CREW IS NOT INITIALIZED；池内→注册）；(c) fresh install 仅工作区池过门（D3）。 |
| `tests/v2-tools.test.mjs` | ×1：v2 扁平 create 适配（`parentID/title/directory` 落根对象、无 body/query 信封、权威记录锚定 directory、异步 handle 返回）。 |
| `openspec/changes/fix-v2-crew-surface-drift/design.md` | D2 节替换为实测形状记录（引用 probe-1.1 证据）。 |
| `openspec/changes/fix-v2-crew-surface-drift/tasks.md` | 1.1–3.3 打勾。 |
| `dist/index.js` | `bun run bundle` 重建（入库，commit 含）。 |

## 探针观察（D2 证据，双源一致）

自跑沙盒（隔离 OPENCODE_CONFIG_DIR + `.opencode/plugins/<name>/index.js` 目录发现探针，`opencode serve` ×多轮）+ 交叉引用 `openspec/changes/harden-dispatch-resilience/probe-1.1-evidence.md`（未改动该 change 任何文件）：

- `ctx.session.create` **存在且工作**：扁平单对象参数 `{parentID?, title?, directory?, permissions?}`；`parentID` 受校验（不存在→`Session.NotFoundError`）；返回**裸会话记录**（无 `{data,error}` 信封）。
- v2 setup ctx **无 `client` 键**；SDK client 只在 v1 事件钩子 `input.client`。
- `ctx.session.get` 要求扁平 `{sessionID}`（`{path:{id}}` → SchemaError Missing key）——`v2AnchorClient`/`v2SessionClient` 既有翻译已覆盖。
- ctx.session 全方法面：`hook,list,create,get,remove,switchAgent,switchModel,prompt,generate,command,compact,synthetic,interrupt,update,move,wait,context,instructions`（**无** promptAsync/status/messages/abort——poll 面退化是另一 change 域）。
- permissions 拼写：v1 `permission:[{permission,action,pattern}]` 被 2.3.2 create body 静默丢弃；v2 `permissions:[{action,resource,effect}]` 逐字落子会话记录并持久化。
- `/api/*` 认证 = `Authorization: Basic base64("opencode:"+password)`（Bearer/其他全 401）；插件加载 lazy（首次已认证 API 请求触发）；插件内容按 id 缓存（换 id 才会重载新代码）。
- 曾因 forge_shell 后台任务未按指定 cwd 启动而在真实工作区起过一次 serve——全程只读（GET），随即按 4757 端口 PID 精准击杀；所有探针 serve 均已按端口 PID 清杀，沙盒目录已删。

## tasks 完成状态

- 1.1 ✅ 共享锚缝 hoist（种子时机=皮带拿到的时机，守卫同款）
- 1.2 ✅ 探针先行，形状记入 design D2（含 probe-1.1 交叉引用）
- 2.1 ✅ crew 门/绑定/记录路径权威锚统一；无 client=今天行为（纯严格改进）
- 2.2 ✅ task 工具守卫式形状探测 + 诚实降级契约串（`TASK_SEAM_DEGRADED_ERROR`）
- 2.3 ✅ 子会话父目录来自权威锚
- v1 约束 ✅：server() 除共享锚 seed 一行外零改动
- D0 继承 ✅：零持久化（未写任何用户 opencode config / forge.json 域外文件）
- 3.1/3.2/3.3 ✅：`bun run typecheck` 绿；`node --test tests/*.test.mjs` **742 pass / 0 fail**（735 基线 + 7 新测试，零回归）；`bun run bundle` 完成、dist 入库

## 测试名列表（新增 7）

1. `createChildSession seam guard (fix-v2-crew-surface-drift): absent session.create → the TASK_CREATE_SEAM_ABSENT sentinel (no raw TypeError); the 2.3.2 BARE-record response resolves`（dispatch-async）
2. `task client guard: absent session.create seam -> the EXACT honest degradation contract string, never a raw TypeError`（dispatch-wiring）
3. `task client guard: child creation parent directory resolves from the AUTHORITATIVE anchor (re-anchored parents -> anchored children)`（dispatch-wiring）
4. `crew anchor matrix (a): the authoritative pool-owning record beats a stale pool-less tool context (the live incident as a regression)`（hierarchical-pools）
5. `crew anchor matrix (b): with NO client the resolution is EXACTLY today's (tool-context anchor; no rescue, no regression)`（hierarchical-pools）
6. `crew anchor matrix (c): fresh install — ONLY a workspace pool, no global layer anywhere — passes the gate`（hierarchical-pools）
7. `v2 task dispatch (fix-v2-crew-surface-drift D2): the 2.3.2 promise-layer create seam adapts — FLAT create input, bare record resolved, anchored parent directory`（v2-tools）

## commits（未 push、未 publish——发版等用户批准）

- `7d7a497` plugin: unify crew gate anchor + adapt task child-session create seam to 2.3.2 (fix-v2-crew-surface-drift 1.x/2.x)
- `5f517c0` tests: anchor matrix (crew gate), task seam guard contract, v2 flat-create adaptation (fix-v2-crew-surface-drift 3.x)
- `196203c` docs: record 2.3.2 probe shapes in design D2, tick tasks 1-3 (fix-v2-crew-surface-drift)

`openspec validate fix-v2-crew-surface-drift` → valid。`reports/explore-dispatch-resilience-report.md`（另一 change 的未跟踪文件）未触碰。

## 遗留给 4.x

- 4.1 沙盒 E2E（workspace-pool-only 全 crew 闭环 + re-anchored 场景）：注意 2.3.2 的 session 域无 `status/messages/abort`——插件 task 工具的**轮询/收割面**在 2.3.2 上仍退化（poll 视图不可读 → 现有 stream-lost/timeout 诚实路径）；创建面（本 change 域）已修复。E2E 若需全链，预计还需 poll 面适配（属 harden-dispatch-resilience 或后续 change）。
- 4.2 发版流程按 AGENTS 终验（git+file → github → npm pack）。
