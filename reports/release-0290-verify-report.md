# 0.29.0 发布后官方安装终验报告 — npm 名升级往返（真机终态=运行 0.29.0 并保留）

- 日期：2026-11-21（本地 13:20–13:2x 时段）
- 执行通道：builtin shell（升级中 forge 插件两度摘除/回归——config 热应用，预期内；forge_shell 全程未用）
- Server：`http://127.0.0.1:28894`（service.json 认证，`Basic base64("opencode:"+password)`），全程未重启，装卸靠 config 热应用
- 结论：**PASS——@sorenllm/opencode-forge 经 npm 名（真 registry 路径）由 0.28.0 升级至 0.29.0，新版保留为真机终态；冒烟四面全过，config/store/装载字节三账全清。**

## 阶段 1：CDN 传播等待

REST dist-tags（`/-/package/@sorenllm%2Fopencode-forge/dist-tags`，无客户端缓存）逐 20s 轮询：

| 时点（本地） | latest |
| --- | --- |
| 13:20:03 – 13:21:47（6 次） | 0.28.0 |
| **13:22:08** | **0.29.0** ✅ |

传播距首次轮询约 2 分钟（与 prepublish 报告避坑 4.5 第 3 条一致）。随后 `npm view` 客户端面跟上：`version='0.29.0'`、`dist-tags.latest='0.29.0'`（npm warn 为既有 npmrc 装饰性问题，无关）。

## 阶段 2：快照（升级基线）

| 面 | 基准值 |
| --- | --- |
| config 文件 | `%USERPROFILE%\.config\opencode\opencode.jsonc`，5028 字节，SHA256 `CB76F824…DCC263`（= gitfile roundtrip 终态逐字节同源）；单数 `plugin`=[`@sorenllm/opencode-computer-use`]（L8–10），复数 `plugins`=[`@sorenllm/opencode-forge`, `opencode-vision-delegate`]（L127–130），13 行 JSONC 注释完整；备份 `%LOCALAPPDATA%\Temp\opencode\release_0290_baseline_config.jsonc` |
| /api/plugin（location=plugindev 工作区，bracket 记法） | 98 条 0 failed：forge=`@sorenllm/opencode-forge` **v0.28.0 active**（npm 名形态）、vision v0.3.1 active outdated:true（基准即如此）、computer-use v0.5.0、paseo(local) |
| /api/agent（同 location） | 14 agents：Build/Plan hidden=true、forge `shell:*=deny`、forge-plugindev-×5 物化（`task:deny + shell:deny + browser:deny + skill:browser=deny`）、vision-agent model=`glm-coding-worker/glm-5.3-flash@low` hidden=false |
| 包 store | `~/.cache/opencode/npm/`：`@sorenllm\{opencode-computer-use,opencode-forge}@latest` + `opencode-vision-delegate@latest`；无 git-* 残留目录 |

快照全量存 `%LOCALAPPDATA%\Temp\opencode\release_0290_baseline_{config.jsonc,plugin.json,agent.json}`。

## 阶段 3：升级（remove → 删 store → add 裸名）

| 步 | 操作 | 结果 |
| --- | --- | --- |
| a 移条目 | `opencode plugin remove "@sorenllm/opencode-forge"`（specifier 形态，认复数 `plugins` 自家条目） | `removed from …opencode.jsonc`，exit 0；forge 工具面随即从会话摘除（Code Mode 目录变更确认，热应用预期）；config 4996B，复数数组余单条 vision |
| b 删旧 store | 删 `~/.cache/opencode/npm/@sorenllm/opencode-forge@latest/`（0.28.0 钉版拷贝；computer-use/vision store 未动；怪癖 5：remove 不清 store，手工清） | ✓ `@sorenllm\` 下仅余 `opencode-computer-use@latest` |
| c 安装 | `opencode plugin add "@sorenllm/opencode-forge"`（裸名→latest=**0.29.0**，真 registry，无 env 旁路） | `installed and added to …opencode.jsonc`，exit 0；store 重建 `@sorenllm\opencode-forge@latest\1795238588372\` |
| d lazy load | GET /api/plugin（plugindev location）打一次 | ✓ forge 工具面回归会话（Code Mode 目录变更二次确认） |

## 阶段 4：冒烟（0.29.0 面）— 四项全 PASS

| # | 断言 | 结果 | 证据 |
| --- | --- | --- | --- |
| a | forge active 无错误，版本面 | **PASS** | /api/plugin：`forge \| source={type:package, target:@sorenllm/opencode-forge, version:0.29.0} \| state={status:active}`，err 无；98 条 0 failed |
| b | hidden/deny 面 | **PASS** | Build hidden=true、Plan hidden=true、forge `shell:*\|browser:*\|skill:browser` deny；forge-plugindev-{coder,test-coder,spec-reviewer,gate-verifier,e2e-verifier} 全在（mode=subagent，`task:deny + shell:deny` 各五条全中）；vision-agent model=`glm-coding-worker/glm-5.3-flash@low` 不受扰；14 agents 与基线 name 集合一致 |
| c | store 包版本 | **PASS** | `…\node_modules\@sorenllm\opencode-forge\package.json`：`"version": "0.29.0"`（name=@sorenllm/opencode-forge）；dist/ 2 文件：index.js 841600B + forge.schema.json 4667B |
| d | schema 发布面 | **PASS** | `dist/forge.schema.json` 存在，4667 字节，SHA256 `73D0516C…`（与仓库 HEAD 工作树同哈希，见下节） |

### 装载字节对账（npm 名路径零行尾归一）

| 文件 | store（installed） | 仓库 `opencode-forge\` | 一致 |
| --- | --- | --- | --- |
| dist/index.js | 841600B，`B537CC3D…` | 841600B，`B537CC3D…` | **raw SHA256 逐字节相等** |
| dist/forge.schema.json | 4667B，`73D0516C…` | 4667B，`73D0516C…` | **raw SHA256 逐字节相等** |
| package.json | 2253B，`C59C8DA8…` | 2253B，`C59C8DA8…` | **raw SHA256 逐字节相等** |

与 git+file 路径的 CRLF 归一差异（怪癖 11）对照：npm 发布面 tarball 保留仓库 LF 字节，**装到的载荷与本地发布工作树逐字节等价、无需行尾归一**——两哈希 `b537cc3daa7b…`/`73d0516c2073…` 恰为 gitfile 报告 HEAD blob 的 LF 侧值，即 npm 名路径装到的就是发布字节本体。仓库 package.json version=0.29.0（发布已 bump）。

## 阶段 5：终态断言 — 全过

| 面 | 终态 |
| --- | --- |
| config | 5028 字节，SHA256 `979DA334…A2857E`；单数 `plugin`=[`@sorenllm/opencode-computer-use`] 原样；复数 `plugins`=[`opencode-vision-delegate`, `@sorenllm/opencode-forge`]——**forge 条目恰好一条（npm 名 spec），零重复、零 npm: 前缀、零 git+file 引用**（grep 计数 FORGE_ENTRY_COUNT=1 / GITFILE_REF=0） |
| JSONC 注释 | 与基线逐行 diff：128 行对 128 行，唯一差异=复数数组两行顺序对调（怪癖 1「add 追加尾部」自然结果，语义等价）；**注释 13 行==13 行逐行无损** |
| 包 store | `@sorenllm\{opencode-computer-use,opencode-forge}@latest`（forge 载荷 dist=**0.29.0** 实测）+ `opencode-vision-delegate@latest`；**无 git-opencode-forge-* / npm_ 前缀残留目录** |
| /api/plugin | 98 条 0 failed：forge **v0.29.0 active**、vision 0.3.1 active（outdated:true 基准即如此）、computer-use 0.5.0、paseo |
| /api/agent | 14 agents：Build/Plan hidden=true、forge shell deny、plugindev×5 全封印物化、vision-agent 用户 config model 在 merged 面可见 |
| 会话面 | 装后 forge 工具面（plan_*/goal_*/crew_*/job/task/forge_*）已回归本会话——0.29.0 在跑的直接运行时证据 |

**真机终态 = 0.29.0 运行并保留**（既定模式：npm 名终装保留新版）。

## 观察注记

- 热应用双程全程零重启：remove 摘工具面 → add 回归，均由 config 变更驱动（Code Mode 目录两次系统级确认）。
- 复数 `plugins` 数组序变为 [vision, forge]（尾部追加）：与 gitfile 报告顺序注记同构，语义等价零重复；本轮任务无「终态=初始态」逐字节要求（终态本就是新版），**未做顺序复原**，保留 installer 原生写序。
- npm 名路径 vs git+file 路径字节面：前者零行尾归一（LF 本体）、后者全 CRLF（怪癖 11）；两路径归一后同字节，互为发布面一致性佐证。

## 纪律遵守

npm publish 未执行、git push 未执行、仓库零触碰（本报告为唯一新增文件）、FAIL 零触发（无冻结）。真实 service/config 仅执行本任务声明的装卸动作（remove ×1 / add ×1 / store forge 目录删 ×1）。快照与载荷日志存 `%LOCALAPPDATA%\Temp\opencode\release_0290_*`。

发布链再进一环：0.28.0（npm 名终态）→ **0.29.0（npm 名升级，本轮，终态保留）**。
