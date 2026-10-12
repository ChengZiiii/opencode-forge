# Release 0.17.0 — 四 change 落地闭环验证

日期：2026-10-12 ｜ 发布人：primary（goal 2026-10-12-落地四个-change-shape-default-open-r，rev3）

## 变更内容（四 change，commits 40cd38e / 6f0e89a / 6bf7bc3 / 1cb2359 / 3694b8d / bffb310）

1. **shape-default-open**：缺省 shape 默认=write（开放写权限）；readonly 必须显式声明；`effectiveReadonlyShape` 基准改显式 readonly（无 shape 的 scout 不再豁免 draft 侦察闸）；/crew 未配置门教学面强制每 agent 显式 shape；两旧 change delta 措辞纠偏。
2. **readonly-exec-seal**：新增 `src/exec-classify.ts` 纯函数分类器（读类/写类/不可分类→读类）；forge_shell 对**显式 readonly** 会话挂闸（拒绝 finding 点名形状/指标/`shape: "write"` 出路，有界）；README 封禁指标表+绕过面逐字披露（belt-in-depth，非沙箱）。
3. **sole-pool-ownership**：池解析器重构——工作区 `.opencode/forge.json` 独占 roster + 全局层兜底（**不合并**）+ 嵌套 forge.json 忽略（MCP 同款）+ 删文件失池（mtime 热应用）；append-only 锚点并集与子树 BFS 扫描废除；task 派发护栏会话域闸——跨工作区目标拒，文案逐字 `not dispatchable from this session` + 来源池路径 + 三出口；/crew roster 会话域化 + 未配置门 sole-ownership 文案。
4. **crew-contract-relay**：/crew 模板 CONTRACT RELAY 硬纪律——lineage 工件时每个派发 prompt **must explicitly carry** 工件路径或确切切片；close evidence 必点名契约；crew_begin 注册输出 lineage 提醒行。

## 门禁（gate-verifier 独立复核，7/7 PASS）

- `bun run typecheck` exit 0 零错误
- `node --test tests/*.test.mjs`：**tests 377 / pass 377 / fail 0**
- `bun run bundle`：92 modules，0.66 MB，`git status --porcelain` 零漂移
- `openspec validate --all`：15 passed / 0 failed
- dist 锚点：`NOT dispatchable from this session` ×4、`explicitly carry` ×2、`READ-CLASS` ×1
- tasks.md：A 6/6、B 5/5、C 6/6 全勾；D 1-4 勾（第 5 项本 note 收口）
- 提交链在位，工作区干净

## 发布链

- `npm pack --dry-run`：3 files（dist + README + package.json），155.3 kB
- tgz 全局安装验证：`opencode plugin <tgz> --global` 成功（Scope: global）
- `npm publish --access public`：`+ @sorenllm/opencode-forge@0.17.0`（11:34 UTC+8）
- 版本提交：`bffb310 chore: release 0.17.0`

## postpublish A=PASS B=PASS

- **A（注册表可查）**：`npm view "@sorenllm/opencode-forge@0.17.0" version` → `0.17.0`；`dist-tags.latest` → `0.17.0` ｜ PASS（发布后 ~1min 生效；tarball CDN 就位耗时 ~7min，重试循环第 2 轮取得）
- **B（注册表包体锚点扫描）**：npm pack 注册表 tarball 解包，dist 662123 B，锚点命中：
  - `NOT dispatchable from this session` => 4 hits（C：会话域闸+roster）
  - `explicitly carry` => 2 hits（D：契约中继）
  - `READ-CLASS` => 1 hit（B：分类器术语）
  - 与本地 dist 逐字一致 ｜ PASS

## 插件切最新 npm（闭环实证）

- 全局 `opencode.jsonc` plugin 数组：本地 tgz 路径条目已移除，回归 `npm:@sorenllm/opencode-forge`
- **npm 缓存 shim 实测**：`~\.cache\opencode\packages\npm_@sorenllm\opencode-forge\node_modules\@sorenllm\opencode-forge\package.json` → **0.17.0**；其 dist 三锚点命中（4/2/1，与注册表体一致）；mtime 2026-10-12 19:41（本地时）= 沙盒 serve 启动时 `npm:` 源解析 latest 现场拉取——切换链路真实走通，非手工摆放
- 本地仓库 tgz 构建产物已清理；当前 dev 会话（host 启动于 0.16.0 时期）内存中保持 0.16.0 直到宿主重启——预期行为，非缺陷

## 本地终测（沙盒 serve）

- 沙盒宿主（`OPENCODE_CONFIG_DIR` 指向临时配置，含 `npm:@sorenllm/opencode-forge` 单插件）`opencode serve` 启动：监听正常、`/app` 端点 OK、serve 日志零 forge 错误行——插件加载无初始化故障（该次启动触发了上述 npm 0.17.0 现场拉取）
- 已知局限（诚实披露）：OPENCODE_CONFIG_DIR 未完全隔离（vision-agent 等全局配置条目漏入该沙盒），`/agent` 端点未列 task 词汇表工人——派发级行为（exec 封禁拒文案、跨工作区拒）本轮未做活体 E2E，其行为正确性由 377 项 hook 级测试矩阵 + 注册表包体锚点背书；后续如需活体 E2E 可复用 scripts/sandbox-e2e-setup.mjs 模式扩展

