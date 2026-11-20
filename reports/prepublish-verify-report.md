# npm publish 前终验报告 — github 源 + tgz 两轮装卸配对循环（forge 0.28.0 / vision 0.3.1）

- 日期：2026-11-21（凌晨 03:05–03:35 本地）
- 执行通道：builtin shell（循环中 forge 插件多次消失，预期内；forge_shell 全程未用）
- Server：`http://127.0.0.1:28894`（service.json 认证，`opencode api --server` + `OPENCODE_PASSWORD`），全程未重启，靠 config 热应用
- 结论：**四循环全部 PASS；终态三面（config / /api/plugin / /api/agent）与阶段 0 快照完全一致（版本回 0.27.1 / 0.3.0）。可以 publish。**
- 重大发现：当前 opencode 构建的 `plugin add` **校验门彻底不收本地 tgz 路径**（旧构建 2026-10-01 实测可用的形态已回归失效）。tgz 两轮（B/D）改经**本地静态 npm registry** 走 arborist registry 路径完成——装到的字节与 `npm pack` 产物哈希一致，验证等效且更贴近 publish 后真实安装路径（详见循环 B）。

## 阶段 0：快照（基准）

| 面 | 基准值 |
| --- | --- |
| config `plugin` 数组 | `["opencode-vision-delegate", "@sorenllm/opencode-computer-use", "npm:@sorenllm/opencode-forge@0.27.1"]`，无复数 `plugins` key |
| config 其他 | `default_agent:"forge"`；`agent.vision-agent`：model `glm-coding-worker/glm-5.3-flash` + variant `low` + extraBody `reasoning_effort:low`；JSONC 注释完整 |
| config 备份 | `%LOCALAPPDATA%\Temp\opencode\prepublish_baseline.jsonc`，SHA256 `A7176336…7A28D8C`，5048 字节（与上轮 e2e 报告基准逐字节同源） |
| /api/plugin | 98 条；非 builtin：forge=`npm:@sorenllm/opencode-forge@0.27.1`(v0.27.1)、vision=`opencode-vision-delegate`(v0.3.0)、opencode-computer-use=v0.5.0、paseo(local)，全 active 无 failed |
| /api/agent | 22 agents：build/plan hidden=**False**、forge 无 shell deny、forge-plugindev-×5（无 task/shell deny）、forge-sorenunitylabs-×8、vision-agent model=glm-5.3-flash@glm-coding-worker/low |

命令语法沿用上轮勘误：安装器为子命令结构（`list/add/check/update/remove`），任务给的 `--global` flag 不存在，`add` 即写全局 config。

## 循环 A：forge github 源（0.28.0）— PASS

1. 手工移除 config 单数 `plugin` 数组中 `npm:@sorenllm/opencode-forge@0.27.1` 行（注释无损）→ `opencode plugin add github:ChengZiiii/opencode-forge` → installed
2. /api/plugin：`forge | github:ChengZiiii/opencode-forge | v5b7beaf6ee0eb0a7f6003cbf5cd807ddcdaebda5 | active` 无错误；commit 与本地 HEAD `5b7beaf6…`（`chore: release 0.28.0`）一致，证明装到的就是已 push 的 0.28.0
3. 冒烟（14 agents 时点快照）：

| 断言 | 结果 |
| --- | --- |
| build hidden | **PASS** `hidden=True` |
| plan hidden | **PASS** `hidden=True` |
| forge shell deny | **PASS** permissions 含 `shell:* -> deny` |
| 五工人物化+封印 | **PASS** spec-reviewer/coder/test-coder/gate-verifier/e2e-verifier 全在，`task:*=deny + shell:*=deny + browser:*=deny + skill:browser=deny` |
| forge active 无错误 | **PASS** |

4. `opencode plugin remove forge` → **拒绝**（verbatim：`Plugin "forge" is not configured`——remove 只认 specifier 不认 ID，怪癖 3 延伸）；改 `remove github:ChengZiiii/opencode-forge` 成功 → `add "@sorenllm/opencode-forge@0.27.1"` 装回
5. 复原断言全过：forge=`@sorenllm/opencode-forge@0.27.1` v0.27.1 active、build/plan hidden 回 **False**、forge 无 shell deny、五工人回 0.27.1 开放面（无 task deny）

## 循环 B：forge tgz 源 — PASS（方法变更：本地静态 registry，见「新怪癖」8/9/10）

### B1. 安装器拒绝一切本地 tgz 路径形态（verbatim 全记录）

`npm pack` → `sorenllm-opencode-forge-0.28.0.tgz`（3 文件：dist/index.js + README.md + package.json，files 白名单正确，shasum `e1a711d1…`，202.8 kB）。随后以下**五种** spec 形态全部被 `plugin add` 的前置校验拒绝，错误同为：

```
Error: Plugin target must be an npm registry package or Git package specifier
    at <anonymous> (B:/~BUN/root/chunk-87dnvnb3.js:2:1306)
    at cli.plugin.add (B:/~BUN/root/chunk-fzgysyh3.js:7:23887)
```

被拒形态：① `C:/…/sorenllm-opencode-forge-0.28.0.tgz`（正斜杠绝对路径）② `file:C:/…​.tgz`（URI）③ `./opencode-forge/….tgz`（相对路径）④ `C:\…\….tgz`（反斜杠，即 2026-10-01 构建实测可用的字面形态）⑤ `sorenllm-opencode-forge-0.28.0.tgz`（裸文件名）。避坑清单第 7 节「publish 前本地 tgz」行在当前构建（子命令版安装器）已失效。

### B2. 等效路径：本地静态 npm registry

- `%LOCALAPPDATA%\Temp\opencode\fake-registry\server.js`（node，GET-only，无 auth 无写路径）：服务 packument（`dist.integrity` = tgz 实算 sha512，与 npm pack 输出一致）+ tarball 字节；系统 `npm view --registry http://127.0.0.1:59873/` 预验通过
- `$env:NPM_CONFIG_REGISTRY="http://127.0.0.1:59873/"` + `opencode plugin add "@sorenllm/opencode-forge@0.28.0"` → **exit 0**（**内嵌 arborist 认 NPM_CONFIG_REGISTRY env**）
- 装载证据链：服务端日志 `GET /@sorenllm%2fopencode-forge` @19:23:10.777Z，store 目录 `…npm\@sorenllm\opencode-forge@0.28.0\1795202590804\`（1795202590804 = 19:23:10.804Z，毫秒吻合）；tarball 无 HTTP GET——arborist 按 packument integrity 命中**共享 npm cacache**（`npm pack` 已按同 integrity 入缓），字节来源仍为本 tgz，以下哈希为证：
  - store `…\node_modules\@sorenllm\opencode-forge\dist\index.js` SHA256 `FB15B09AD5BC91E7…`
  - 仓库 `opencode-forge\dist\index.js` SHA256 `FB15B09AD5BC91E7…`（一致）
- 零 publish、零真实 registry 写入；npmrc 未动（env 方式，进程级）

### B3. 冒烟（22 agents 时点）— 全 PASS

build/plan `hidden=True`、forge `shell:*=deny`、五工人 `taskDeny=1 shellDeny=1`、`forge | @sorenllm/opencode-forge@0.28.0 | v0.28.0 | active err=''`、vision 未受扰（0.3.0 active）。registry 路径面与 github 路径面（循环 A）完全一致。

### B4. 卸载 + 装回 + 复原 — PASS

`remove "@sorenllm/opencode-forge@0.28.0"` → `add "@sorenllm/opencode-forge@0.27.1"`（真 registry，无 env）→ forge v0.27.1 active、build/plan hidden=False、forge 无 shell deny、五工人在且无封印。清理：tgz 删、假 registry 停+删、store `@sorenllm\opencode-forge@0.28.0\` 清（怪癖 5：remove 不清 store）。

## 循环 C：vision github 源（0.3.1）— PASS

1. 移除 config 单数数组 `opencode-vision-delegate` 行 → `opencode plugin add github:ChengZiiii/opencode-vision-delegate` → installed
2. /api/plugin：`vision | github:ChengZiiii/opencode-vision-delegate | v37418cae28aede4bf2909362908946577e796fb6 | active err=''`；commit = 本地 HEAD（`chore: release 0.3.1 - installer add-appends upgrade note`，工作树干净）
3. 冒烟：vision-agent 在且 `hidden=False`、**用户 config 的 model 在 merged 面可见**（`model=glm-5.3-flash@glm-coding-worker/low`，extraBody `{"reasoning_effort":"low"}`）；vision_analyze 工具 + vision skill 随新版注册回归；forge 未受扰
4. `remove github:ChengZiiii/opencode-vision-delegate` → `add opencode-vision-delegate` 装回 → 复原：`vision | opencode-vision-delegate | 0.3.0 | active`、vision-agent model 不变；store github 残留目录已清

## 循环 D：vision tgz 源 — PASS（同循环 B 方法）

1. `npm pack`（opencode-vision-bridge/）→ `opencode-vision-delegate-0.3.1.tgz`（5 文件：LICENSE + README + SKILL.md + dist + package.json，92.1 kB，shasum `0edb98b7…`）
2. 移旧条目（`remove opencode-vision-delegate`，认复数 key 自家条目）→ 假 registry（:59874）+ `NPM_CONFIG_REGISTRY` + `add "opencode-vision-delegate@0.3.1"` → exit 0
3. 证据链同 B2：packument GET @19:26:43.838Z ↔ store 目录 1795202803873（=19:26:43.873Z）；store dist SHA256 `F9AED4C5F80BC6EE…` == 仓库 dist 同哈希
4. 冒烟：`vision | opencode-vision-delegate@0.3.1 | v0.3.1 | active err=''`、vision-agent model/variant/extraBody 完整、22 agents、forge 未受扰
5. `remove "opencode-vision-delegate@0.3.1"` → `add opencode-vision-delegate`（真 registry）→ 复原：v0.3.0 active、vision-agent model 不变；tgz/假 registry/store 0.3.1 目录全清

## 终态 diff — 全部复原

| 层 | 结果 |
| --- | --- |
| config 文件 | 基准备份逐字节回写，SHA256 `A7176336…7A28D8C` 一致（5048B），复数 `plugins` key 无残留，注释无损 |
| /api/plugin | 98 条与基准**逐项一致**：forge=`npm:@sorenllm/opencode-forge@0.27.1`(0.27.1)、vision=`opencode-vision-delegate`(0.3.0)、computer-use(0.5.0)、paseo(local)，全 active，failed=0 |
| /api/agent | 22 agents，name 集合一致，**逐 agent 零字段差异**（hidden/model/permissions 全量比对）：build/plan hidden=False、forge 无 shell deny、plugindev×5 无封印、sorenunitylabs×8、vision-agent model=glm-5.3-flash |
| 包 store | `~/.cache/opencode/npm/` 回基准三目录（`@sorenllm` / `npm_@sorenllm` / `opencode-vision-delegate@latest`）；本轮新增的 3 个目录（forge github / forge 0.28.0 / vision 0.3.1 + vision github）已全清 |
| 仓库 | 两仓 tgz 均删；forge 仓仅剩父会话预存的未跟踪 `openspec/changes/fix-v2-crew-surface-drift/`（未触碰）；vision 仓干净 |

## 安装器行为新怪癖（本轮新增 3 项，接上轮 7 项）

8. **`plugin add` 校验门禁绝本地 tgz 路径**：五种形态全拒（verbatim 见 B1）。旧顶层 `opencode plugin "<path>.tgz" --global` 语法已不存在；子命令版 add 只收 npm registry / Git specifier。避坑清单第 7 节 tgz 行对当前构建失效——publish 前 tgz 验证的可行替代：本地静态 registry + `NPM_CONFIG_REGISTRY`（见 9）。
9. **内嵌 arborist 认 `NPM_CONFIG_REGISTRY` env**：进程级注入即生效，npmrc 零改动；packument 从指定 registry 拉取，tarball 按 integrity 命中共享 npm cacache（`%LOCALAPPDATA%\npm-cache\_cacache`，`npm pack` 产物已在缓）。
10. **同版本重装复用 store 目录**：`add "@sorenllm/opencode-forge@0.27.1"` 在 store 已有同 spec 目录时不新建时间戳子目录（复用 `@sorenllm\opencode-forge@0.27.1\1795202275312\`）；另 remove 按 ID（`remove forge`）不认，仍只认 specifier（怪癖 3 的延伸）。

## 惰性池观测（非 FAIL，接上轮技术说明）

循环 A 装回 0.27.1 后一度 9 agents（plugindev×5 / sorenunitylabs×8 均未物化），且对 SorenUnityLabs location 的 /api/agent 查询**不再**触发池重建（与上轮报告观测不同——上轮 22 是累积注册表产物）。循环 B 冒烟时点起恢复 22 并保持到终态：池物化由**会话活动**驱动（本会话连续工具调用 + 可能的父会话活动），非 location 查询驱动。池文件与 session-anchors 均在磁盘，README 声明的 activity-rebind 设计行为成立；终态 22 与基准一致，无残留影响。

## 装卸配对完整性

| # | 源 | 安装 | 卸载+装回 | 复原 |
| --- | --- | --- | --- | --- |
| A | forge github 0.28.0（commit `5b7beaf6`） | active+冒烟 5/5 | remove(specifier) + add npm 0.27.1 | ✓ |
| B | forge tgz 0.28.0（经本地 registry） | active+冒烟 5/5+哈希对账 | remove + add npm 0.27.1（真 registry） | ✓ |
| C | vision github 0.3.1（commit `37418cae`） | active+冒烟 | remove + add npm 0.3.0 | ✓ |
| D | vision tgz 0.3.1（经本地 registry） | active+冒烟+哈希对账 | remove + add npm 0.3.0（真 registry） | ✓ |

## 纪律遵守

npm publish 未执行、git push 未执行、仓库除本报告与（已删的）两枚 tgz 外零触碰、FAIL 零触发（无冻结）。快照与日志存 `%LOCALAPPDATA%\Temp\opencode\prep_*.json` + 基准备份。

## 遗留给 publish 后 follow-up 的注意点

- npm 名终验安装时保留新版（0.28.0 / 0.3.1）——本轮已把复数 `plugins` key 恢复为无；届时 add 后 config 将新增该 key，属预期。
- registry 元数据/tarball CDN 传播约 10 分钟（避坑清单 4.5 第 3 条），publish 后立刻验失败先等待再判。
- 共享 npm cacache 已含两枚 tgz（按 integrity 键）：与正式发布产物同字节，不构成污染；如需彻底无菌可在终验前清 `_cacache`。

## npm-name final install (post-publish)

- 日期：2026-11-21 03:30–03:38 本地；通道同前（builtin shell + `opencode api`）
- 结论：**PASS——@sorenllm/opencode-forge@0.28.0 与 opencode-vision-delegate@0.3.1 经 npm 名（真 registry 路径）最终安装，新版保留为终态。**

### 1. 传播等待

REST dist-tags（`/-/package/<name>/dist-tags`，无客户端缓存）实测：03:30:08 双双仍 latest=0.27.1/0.3.0（且版本化 packument 404）；**03:31:09 forge→0.28.0；03:32:10 vision→0.3.1**（约 2 分钟）。`npm view` 客户端面随即跟上（双 0.28.0/0.3.1）。npmrc 确认 registry=npmjs.org 无旁路。

### 2. forge 最终安装（README 升级规程）

| 步 | 操作 | 结果 |
| --- | --- | --- |
| a 移条目 | config 单数 `plugin` 数组删 `npm:@sorenllm/opencode-forge@0.27.1` 行（注释无损） | ✓ |
| b 删旧 store | 列目录确认后删 `@sorenllm\opencode-forge@0.27.1\`（钉版拷贝）+ `npm_@sorenllm\`（npm:前缀拷贝，内仅 forge）；`opencode-computer-use@latest` 保留未动 | ✓ |
| c 安装 | `opencode plugin add "@sorenllm/opencode-forge"`（裸名→latest=0.28.0；`--global` flag 本构建不存在，同前勘误） | installed |
| 冒烟 | /api/plugin：`forge | @sorenllm/opencode-forge | v0.28.0 | active err=''`；/api/agent：build/plan hidden=**True**、forge `shell:*=deny`、五工人 `taskDeny+shellDeny` 全封印；/api/config 正常解析（default_agent="forge" 在） | 全 PASS |

安装途中 server 重启一次（外因）；重启后加载面即 0.28.0，无残留影响。

### 3. vision 最终安装（同规程）

移条目（单数数组）→ 删 `opencode-vision-delegate@latest\`（旧 0.3.0 钉版 store）→ `opencode plugin add opencode-vision-delegate` → installed。冒烟：`vision | opencode-vision-delegate | v0.3.1 | active err=''`；vision-agent 在（model=glm-5.3-flash@glm-coding-worker/low，extraBody `{"reasoning_effort":"low"}`）；vision_analyze 工具 + vision skill 随 0.3.1 注册回归。

### 4. 终态断言 — 全过

| 面 | 终态 |
| --- | --- |
| config | 单数 `plugin`=[`@sorenllm/opencode-computer-use`]；复数 `plugins`=[`@sorenllm/opencode-forge`, `opencode-vision-delegate`]——**两插件各恰一条 npm 条目，零重复、零 npm: 前缀残留** |
| store | `@sorenllm\opencode-computer-use@latest` + `@sorenllm\opencode-forge@latest`（载荷 dist=**0.28.0** 实测）+ `opencode-vision-delegate@latest`（载荷 dist=**0.3.1** 实测）；0.27.1/0.3.0/npm_ 前缀目录零残留 |
| /api/plugin | 98 条 0 failed：forge v0.28.0 active、vision v0.3.1 active、computer-use 0.5.0、paseo |
| /api/agent | build/plan hidden=True、forge shell deny、plugindev×5 全封印物化、vision-agent 用户 config model 在 merged 面可见；共 14 agents（见下方池注） |

池注：server 中途重启后惰性池清空属设计行为（RAM-only）；plugindev×5 已随 0.28.0 加载物化，sorenunitylabs×8 将按 README 的 activity-rebind 在该工作区下次会话活动时回归，不影响本终态断言。

### 纪律

零 git push、零再 publish、仓库仅本报告追加。发布链闭环完成：内环 file:// → 中环 git+file → 外环 github → tgz（registry 等效路径）→ **npm 名（本轮，终态保留新版）**。
