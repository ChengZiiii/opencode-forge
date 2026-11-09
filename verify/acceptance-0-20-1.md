# 验收报告 — 0.20.1 锚点修复（anchor-pool-preference）+ 四单批次收尾

- **日期**：2026-11-09 深夜自主批次（用户指令：先修 bug → 完整修复/提交/npm/测试流程 → 完整测试无异常）
- **版本**：0.20.0 → **0.20.1**（patch，bug 修复）
- **状态**：npm 已发布（`+ @sorenllm/opencode-forge@0.20.1`）；REST dist-tags 已翻 latest=0.20.1

---

## 1. 事故复盘（2026-11-08 晚，0.20.0 实机首夜）

**现象**：重启后续开的本会话，派发 `forge-plugindev-e2e-verifier` 被池闸拒：`not dispatchable from this session … This session's dispatchable roster is the global fallback`——而全局兜底文件根本不存在（名册=空）。同一波并行的 spec-reviewer 派发却过了闸（它过闸时宿主会话记录尚未可取，走了内存映射 fallback=真实工作区，fail-open 放行——两源分歧的活证据）。

**根因**：`resolveSessionAnchorForPools`（plugin.ts 池闸+crew 合规闸的唯一锚点缝）**权威优先无条件信宿主会话记录**——重启续开的会话，宿主记录携带的是**新启动目录**（无池文件、非根目录），而非会话真实工作区；插件内存映射却持着正确的工作区绑定（由会话自身活跃行为持续刷新佐证：forge_shell cwd、工具上下文）。0.18.0 事故修了「映射劣化→权威记录救回」；本次是其**镜像**：权威记录劣化→好映射被压死。规格（forge-subagents「Workspace pool ownership and global fallback」）只有单向场景，无此镜像条款——规格级缺口，不止代码缺口。

**副产物发现**：`[vision:dropped-image]` 非故障——vision-delegate 对纯文本模型的设计路径（落盘+委托），`vision_analyze` 委托链实测可用（已成功读取用户截图）。另：原生 general 子代理在原生 shell 上卡死被用户取消——`forge_shell`+job 监督面（四条件竞速/有界等待/树杀）对比原生 shell 的活证，已记入观察。

## 2. 修复（anchor-pool-preference，openspec 全流程）

- **规格**：MODIFIED「Workspace pool ownership and global fallback」——锚点段新增镜像消解条款：**权威锚点有效但无池文件、且内存绑定是不同的非退化工作区并持有池文件 → 池化绑定胜出**，每会话一次有界披露记录替换；其余形状权威记录保持优先（0.18.0 语义不动）。新增场景「A pool-less resume-rebound record yields to the pooled in-memory binding」（own-pool 放行 + 跨池仍拒 + 有界披露），既有 12 场景逐字全量携带。
- **设计（D1-D4）**：双源皆取→同径即权威；冲突且「权威无池+映射有池」→映射胜（两种真实冲突形状下均取真：会话没搬走=映射对；真搬走=活跃行为已把映射刷到新工作区，冲突自消）；拒绝的备选：冲突即 fail-open（重新打开跨池泄漏）、映射有池即优先（复发 0.18.0 事故）、回写映射（破坏只读缝契约）。披露集 `anchorPrefNotes`（session.deleted 逐出），只读缝不回写。
- **代码**：plugin.ts `resolveSessionAnchorForPools` 冲突分支 + 披露集 + 逐出接线。**其余闸逻辑/拒文案/映射写入零改动**。
- **测试**：hierarchical-pools 权威锚点矩阵新 case (e)：记录携无池启动目录+映射持池化工作区 → own-pool 放行（修复前被拒）、跨池仍拒（偏好≠泄漏）、披露恰一次且文案前缀钉死；既有 (a)(b)(c)(d) 全绿不动。
- **门禁**：typecheck 0 错误；全套件 **474/474**（473 基线+1，零回归）；bundle 0.69MB 自包含；pack 恰 3 文件。

## 3. 审查 nit 收尾（同夜）

- **NIT-1**（exec-seal design 的 env-prefix 措辞与实现不符）：按审查 accept 路径——design.md 删子句并注记「与 `cmd /c` 同类的已披露 fail-open 类」。
- **NIT-2**（crew auto-advance 文案无测试钉）：crew-continue 首例加 `assert.match(armed.output, /auto-advance on session idle until crew_close/)`。
- **NIT-3**（验收报告未入库）：`verify/acceptance-0-20-0.md` 已提交（commit 8bc229c）。

## 4. 发布与本地更新（0.20.1）

| 项 | 证据 |
|---|---|
| 提交 | 8 条 conventional（plugin:/tests:/docs:×3/chore:×2 + README docs），工作区净 |
| 版本 | 0.20.0 → 0.20.1（node -e 写 JSON） |
| 发布 | `+ @sorenllm/opencode-forge@0.20.1`，token 仅进程级 env 零入库 |
| 注册表 | REST dist-tags latest=0.20.1（发布后数分钟翻转） |
| 本地 store | 删目录重装 + 后台重试循环（job j-20261108-201946-lomugy）→ 04:21:24 UTC `STORE-AT-0.20.1`：deps package.json=0.20.1、dist 内层=0.20.1，与 REST latest=0.20.1 双源一致 |
| 归档 | 五单全部 `openspec archive --yes`（forge-search-tools、exec-seal-o-precision、crew-autonomous-waves、crew-native-fallback、forge-prompt-shared），合并后 `validate --all` 10/10，归档移动已提交 |

## 5. 实机测试（serve 沙盒，0.20.1 商店产物）

三轮 serve 沙盒（真实用户配置 + 本地 store 0.20.1 产物；沙盒工作区 forge.json `pool=livetest`，shared marker + probe(write) + scout(readonly)）：

- **Feature A（池物化+共享段）三实例全真**：`/agent` 由 9（内置）→ 11（+forge-livetest-probe/+scout），probe 的 prompt 内嵌 `LIVE-SHARED-MARKER-7f3a`（A=True ×3：端口 43911/43914/43915）。
- **Feature B（readonly 封印，真模型回合，43914）**：scout 对「在 opencode-forge 仓库跑 `rg -o "v1\.2\.3" package.json` + `curl -o seal-probe.txt …`」**整单拒执、零命令执行**，理由链逐字在案：目标为**工作区根外绝对路径**（沙盒逃逸防护）+ `curl -o` 是**对 readonly 角色的写操作** + 「from this scout, executing them would breach the containment this role is designed to enforce」；事后核验仓库 `seal-probe.txt` 不存在。
- **写形对照（同服）**：probe（write）会话正常执行工具并回报（列目录/状态汇报）——封印只锁 readonly 形状，通道本身畅通。
- **工作区内补验（43915，诚实记录）**：scout 接受「own workspace 内 `rg --files` + `curl -o wsdemo.txt`」任务并发出 **2 个工具调用**（transcript tool parts 实证）、`wsdemo.txt` 未创建；但其文字回报未在 7.5 分钟窗口内落笔（模型回合慢），该轮以**工具级证据**记录，不作文字级强断言——对应精确矩阵（工作区内读放行/写拒文案前缀）由 474/474 单测覆盖（hierarchical-pools/exec-seal 用例）。
- **serve 协议发现**（后续复用）：prompt 投递 = `POST /session/{sid}/prompt_async`（2xx 空体即受理）；transcript 读取 = `GET /session/{sid}/message`（**单数**）；`POST /session/{sid}/message` 是**同步阻塞**端点（占连接至回合结束）；`/messages`（复数）不是列表端点（恒空，勿用）。
- **环境清障**：两枚僵尸 `opencode serve`（用户取消的原生任务残留；其一 cwd 锁死沙盒临时目录致 `rmSync` EPERM）经亲缘核验（父进程已死/orphan vs 用户 Paseo 桌面后端——后者免杀）后定向清除。

## 6. 遗留与晨间事项

1. **重启 opencode 后 0.20.1 生效**——本会话运行中的宿主仍载 0.20.0 dist；重启后锚点修复即刻保护续开会话（明早你重启即实测路径）。
2. **anchor-pool-preference 未归档**（今日新单，无独立审查轮）——明早你验收后指示归档。
3. 未 push 远端（维持既定口径）。
4. serve E2E 对 crew 自动推进未做 serve 级驱动（需 idle 引擎+模型回合，成本高）——11 条接线级测试覆盖，如需补 serve 级明早说。
