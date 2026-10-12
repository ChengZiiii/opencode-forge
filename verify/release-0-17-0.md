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

## 本地终测（沙盒 serve，活体证据）

- 沙盒宿主（临时配置 + `npm:@sorenllm/opencode-forge`）`opencode serve` 启动：监听正常、`/app` OK、日志零 forge 错误——该启动触发了上述 npm 0.17.0 现场拉取
- **首轮探针失败根因**：探针 forge.json 违反原子对规则（钉 model 未钉 thoughtLevel）→ 插件按 spec fail-soft 跳过两条目并出 `[forge:config] error` finding（本身即 0.17.0 池发现+校验链工作的证据）
- **修正探针后活体物化实测**（`/agent` 端点）：
  - `forge-worker-bare [subagent]`：denies = task + STATE 族，**无 write/edit/bash**——缺 shape 默认开放写权限（change A 翻转）✔
  - `forge-scout-ro [subagent]`：denies = task + **write,edit,bash,patch,applypatch,apply,multedit**——显式 readonly 封全变异族 ✔
  - 两工人自工作区池物化（sbx 主池纯 id）——workspace-pool-ownership 发现链 ✔

## 深度活体 E2E（2026-10-12 下午，密闭沙盒三轮）

**环境**：XDG_CONFIG/CACHE/DATA_HOME 三重定向 + `FORGE_TEST_FORGE_HOME` 测试缝（plugin.ts:302），真实全局配置/paseo home/真实 npm 缓存/auth 全程零接触（隔离验证：vision-agent 等全局条目不泄漏；测毕沙盒整体删除，auth 副本销毁）。模型链路：glm-5.3-flash 真调用（第一轮 baseURL 笔误 404 修正后全通）。

**第一轮（物化矩阵 + 行为面）**：
- 物化五工人全中：bare=开放 / write=开放 / readonly=全族封 / **readonly+bash:allow override→bash 被抬离 deny 面** / 钉扎 model+depth 对合法 ✔
- 嵌套 forge.json（nested-deep）**未物化**——子树忽略 ✔
- **T1 exec 封印活体命中**：readonly scout 经 forge_shell 执行 `echo seal > sealtest.txt` → belt 拒绝，finding 逐字：`[forge:seal] Exec refused ... (explicit "shape": "readonly") ... classified WRITE-CLASS — indicator "redirect" (>) ... set "shape": "write" ...`，工人逐字上报回传，`sealtest.txt` 未创建 ✔
- **T4 开放工人放行**：bare 工人同命令经 forge_shell 成功（exit=0），`baretest.txt` 创建 ✔（封印不误伤）
- 跨工作区（ws-c 池）：serve 宿主为单锚进程（`rememberHostAnchor` 仅 server() 初始化时执行，plugin.ts:2207），ws-c 不进词汇表 → 派发以"unknown agent type"拒绝——**fail-closed 更强形式**；belt 拒文案路径由 25 项 wiring 测试背书并在第二轮经全局层活体打出（见 R2-T1）✔

**第二轮（全局层 + belt 拒文案，FORGE_TEST_FORGE_HOME）**：
- 全局层与工作区池**并集物化**：`forge-globaltest-global-ro [subagent]`（命名空间）与 ws-a 池纯 id 工人并存 ✔
- **R2-T1 belt 拒活体命中**：从有池的 ws-a 派全局工人 → 拒，文案逐字含 `not dispatchable from this session` + 来源池路径 + 本会话可派 roster + **三出口** ✔
- **R2-T2 兜底放行**：无池 ws-b 派同一全局工人 → 成功回复 `globalok`（fallback 不合并语义的正反面双向实证）✔

**结论**：四 change 全部行为在真实宿主+真实模型链路活体验证通过。已知边界（如实）：serve 型宿主单锚（跨池物化需宿主在多目录初始化过，TUI 每工作区一进程的常态下跨派在词汇表层即不可能）；全局层路径按 spec 字面读 `~/.config/opencode/forge.json` 不随 XDG 走（沙盒需专用测试缝重定向，非缺陷）。

