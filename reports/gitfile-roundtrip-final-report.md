# git+file 官方安装终验报告 — 三 change 全部实现后的 HEAD 装卸往返（forge，终态=初始态）

> **并行注明**：本报告由独立子会话撰写。任务首选目标 `reports/gate-final-all-changes-report.md`（标题 "## git+file roundtrip"）在本报告落笔时尚不存在（gate 工人可能并行撰写中），故按任务预案独立成文于本文件。若 gate 报告后到，本文不与之合并，冲突面以两文并存为准。

- 日期：2026-11-21（本地 06:0x–06:2x 时段）
- 执行通道：builtin shell（往返中 forge 插件两度消失/回归——config 热应用，预期内；forge_shell 全程未用）
- Server：`http://127.0.0.1:28894`（service.json 认证，`Basic base64("opencode:"+password)`），全程未重启，config 热应用驱动装卸
- 被验 HEAD：`1d998f2`（`docs: crew E2E fixes review CLEAN …`；三 change 全部落地后的 HEAD，工作树对 dist/ 干净——HEAD blob 与工作树 raw SHA256 一致）
- 结论：**装卸往返全 PASS；终态三面（config / /api/plugin / /api/agent）与快照完全一致（config 逐字节、plugin/agent 面归一化比对零差异）。**

## 阶段 1：快照（基准）

| 面 | 基准值 |
| --- | --- |
| config 文件 | `%USERPROFILE%\.config\opencode\opencode.jsonc`，5028 字节，SHA256 `CB76F824…DCC263`；单数 `plugin`=[`@sorenllm/opencode-computer-use`]（L8–10），复数 `plugins`=[`@sorenllm/opencode-forge`, `opencode-vision-delegate`]（L123–126），JSONC 注释完整；备份 `%LOCALAPPDATA%\Temp\opencode\gitfile_roundtrip\baseline_config.jsonc` |
| /api/plugin（location=plugindev 工作区） | 98 条 0 failed；forge=`@sorenllm/opencode-forge` v0.28.0 active（npm 名形态）、vision=`opencode-vision-delegate` v0.3.1 active **outdated:true**（基准即如此）、computer-use v0.5.0、paseo(local) |
| /api/agent（同 location） | 14 agents：Build/Plan **hidden=true**、forge `shell:*=deny`、forge-plugindev-×5 物化（mode=subagent，`task:deny + shell:deny + browser:deny + skill:browser=deny`，tools=[]）、vision-agent model=`glm-5.3-flash@glm-coding-worker/low` hidden=false |

快照全量存 `%LOCALAPPDATA%\Temp\opencode\gitfile_roundtrip\baseline_{config.jsonc,plugin.json,agent_plugindev.json,agent_summary_plugindev.json}`。

> 查询语法注记：`/api/plugin`、`/api/agent` 的 location 参数当前构建收 **bracket 记法** `?location[directory]=<path>`（URL 编码 `location%5Bdirectory%5D=…`）；裸 JSON 对象值（`?location={"directory":…}` 无论是否转义）报 `Expected object at ["location"]`。无 location 参数时返回默认根目录视图（本次实测 agent 集与 plugindev 视图内容等价，仅序列化顺序差异 47B）。

## 阶段 2：git+file 安装

| 步 | 操作 | 结果 |
| --- | --- | --- |
| a 移条目 | config 复数 `plugins` 数组删 `"@sorenllm/opencode-forge"` 行（注释无损，纯 ASCII 块编辑） | ✓ forge 工具面随即从会话摘除（热应用，预期） |
| b 删旧 store | 删 `~/.cache/opencode/npm/@sorenllm/opencode-forge@latest/`（npm 0.28.0 钉版拷贝；computer-use/vision store 未动） | ✓ |
| c 安装 | `opencode plugin add "git+file:///C:/Users/Soren/Desktop/AgentWorkCommon/opencode_plugin_dev/opencode-forge"`（子命令版，无 `--global` flag——沿用 prepublish 报告勘误） | `installed and added to …opencode.jsonc`，exit 0 |
| d lazy load | GET /api/plugin（plugindev location）打一次 | ✓ forge 工具面回归会话 |

装载证据：store 新目录 `git-opencode-forge-0954a942677a\1795213184351\`（怪癖 5 延伸：**store 目录按 specifier 拼写命名**——git+file 源落成 `git-opencode-forge-<hash>` 而非 `@sorenllm\…`）；包本体在 `…\node_modules\@sorenllm\opencode-forge\`（4 文件：package.json + README.md + dist/index.js + dist/forge.schema.json）。

## 阶段 3：冒烟 — 四项全 PASS（本 HEAD 含三 change 新面）

| # | 断言 | 结果 | 证据 |
| --- | --- | --- | --- |
| a | forge active 无错误，版本面 | **PASS** | `/api/plugin`：`forge | git+file:///C:/…/opencode-forge | 1d998f285c90637a9045341b139908382cf150df | active`，err 无；version 字段=git commit，**与本地 HEAD `1d998f2` 一致**；store 包 package.json version=**0.28.0**（未 bump 属预期） |
| b | hidden/deny 面 | **PASS** | Build hidden=true、Plan hidden=true、forge `{"action":"shell","resource":"*","effect":"deny"}`、forge-plugindev-{coder,test-coder,spec-reviewer,gate-verifier,e2e-verifier} 全在（mode=subagent，`task:deny + shell:deny` 各五条全中）、vision-agent model=glm-5.3-flash@glm-coding-worker/low 不受扰；14 agents |
| c | crew 面（本 HEAD 新修：arm-only crew_begin schema，subtasks optional） | **PASS（会话内观察面）** | HTTP 工具面不存在：`/api/tool`、`/api/tools`、`/api/tool/crew_begin` 全 404 → 按任务预案改用**会话内可观察面**：装后 Code Mode 目录 search 返回 `crew_begin` 签名，`subtasks?: Array<{title, agent?}>` **`?` 可选已物化**，description 载明 arm-call（`{execution}` 单独出现=武装 PENDING）与 one-call born-armed 语义——目录 schema 由 git+file 载荷在装后注册供给，即修复面在已装构建上的直接证据（单测+E2E 另有覆盖） |
| d | store 内 `dist/forge.schema.json` | **PASS** | 存在，4744 字节，SHA256 `167ED847…5E0EF`（schema 发布面证据：git+file 装到的包内含新 schema 文件） |

### 装载字节对账（CRLF 归一化发现）

store 与仓库 dist 原始哈希**不相等**，逐字节排查结论（良性，新观察）：

| 文件 | HEAD blob（=工作树 raw） | installed | 归一化（CRLF→LF）后 |
| --- | --- | --- | --- |
| dist/index.js | 841600B，全 LF，sha `b537cc3daa7b…` | 863830B，全 CRLF（22230 处） | **normSha 逐字节一致**（`b537cc3daa7b…`） |
| dist/forge.schema.json | 4667B，全 LF，sha `73d0516c2073…` | 4744B，全 CRLF（77 处） | **normSha 逐字节一致**（`73d0516c2073…`） |

即：**git+file 在 Windows 上经 git clone 检出时按 autocrlf 把文本文件 LF→CRLF，npm 按检出字节打包**——装到的载荷与 HEAD 内容在行尾归一化意义下逐字节等价（差异仅行尾，无任何语义差异）；冒烟 b/c 的行为面证据与此互洽。HEAD blob 与工作树 raw 完全一致（repo 侧无人动过 dist）。

## 阶段 4：卸载配对

1. `opencode plugin remove "git+file:///C:/Users/Soren/Desktop/AgentWorkCommon/opencode_plugin_dev/opencode-forge"`（**specifier 形式**，认复数 `plugins` 自家条目）→ `removed from …opencode.jsonc`，exit 0；config 复数数组回到单条 vision（forge 工具面再度摘除——热应用，预期）
2. 手工清 store 残留 `git-opencode-forge-0954a942677a\`（怪癖 5：remove 不清 store）→ 无残留
3. `opencode plugin add "@sorenllm/opencode-forge"`（裸名→latest=0.28.0，真 registry）→ installed；store 重建 `@sorenllm\opencode-forge@latest\1795213295818\`，包 package.json version=0.28.0；forge 工具面回归

## 阶段 5：终态三面断言 — 全过

| 面 | 终态 | 与快照比对 |
| --- | --- | --- |
| config 文件 | SHA256 `CB76F824…DCC263` | **逐字节一致**（见下方顺序注记） |
| /api/plugin | 98 条 0 failed；forge=`@sorenllm/opencode-forge` v0.28.0 active；vision 0.3.1 active outdated:true；computer-use 0.5.0；paseo | 归一化（id/type/target/version/outdated/status 排序串）**完全一致** |
| /api/agent | 14 agents，Build/Plan hidden=true、forge shell deny、五工人封印、vision-agent model 不变 | 全量 summary（name/hidden/model/mode/tools/permissions 逐 agent）**零字段差异** |
| 包 store | `@sorenllm\{opencode-computer-use,opencode-forge}@latest` + `opencode-vision-delegate@latest`（与基准同构） | **无 git+file 残留目录**（`git-opencode-forge-*` 已清） |

**config 顺序注记**：installer `add` 把 forge 条目**追加到复素数组尾部**（怪癖 1「add 追加不替换」的自然结果），装回后数组序为 [vision, forge]（基准 [forge, vision]），语义等价、零重复零残留；为满足「终态=初始态」逐字节标准，做了一次两行顺序复原（纯 ASCII 注释无损编辑），复验 SHA256 与基准一致。**终 config 与往返前逐字节同源，JSONC 注释全程无损。**

## 安装器行为观察（接 prepublish 报告怪癖 8/9/10）

11. **git+file 装载经 git clone autocrlf 行尾归一**：Windows 上 store 内文本文件全 CRLF、仓库/HEAD 全 LF，CRLF→LF 归一后逐字节等价（本轮两文件实证）；对账 git+file 载荷时**必须做行尾归一**再比哈希，否则误报不一致。
12. **store 目录名按 specifier 拼法落盘**：git+file 源 → `git-opencode-forge-<8hex>`（非包名 `@sorenllm\…`）；卸载清理时按 specifier 形状找目录，remove 本体不清 store（怪癖 5 在 git 源上同构成立）。
13. **location 查询参数收 bracket 记法**：`?location[directory]=<path>` 生效；JSON 对象值形式（转义与否）一律 `Expected object at ["location"]`（400）。

## 纪律遵守

npm publish 未执行、git push 未执行、仓库零触碰（本报告为唯一新增文件）、FAIL 零触发（无冻结）。快照与日志存 `%LOCALAPPDATA%\Temp\opencode\gitfile_roundtrip\`（baseline_*、after_install_*、final_*、hashcmp.mjs 等）。装卸往返闭环：npm 0.28.0（初始）→ **git+file HEAD `1d998f2`（三 change 面）→ npm 0.28.0（终态）**，全程热应用零重启。
