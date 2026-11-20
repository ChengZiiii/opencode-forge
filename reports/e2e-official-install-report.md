# e2e-official-install 终验报告 — 双插件官方安装模式装卸循环

- 日期：2026-11-21
- 执行通道：builtin shell（原生 pty；forge 插件消失期间照常工作，已实证）
- Server：`http://127.0.0.1:28894`（service.json 认证），全程未重启，靠 config 热应用 + lazy reload
- 结论：**双插件 git+file 官方安装模式终验 PASS**；装卸配对完整；终态三层（config / API 面 / 包 store）全部复原至初始态。安装器存在 7 项行为怪癖（见下），其中「add 追加不替换」使**裸 add 同 ID 插件必然 Duplicate ID 失败**，官方升级规程必须是「先移旧条目（README 卸载第 1 步）→ add → 冒烟 → remove → add npm 装回」。

## 阶段 0：初始快照（基准）

| 项 | 基准值 |
| --- | --- |
| config `plugin` 数组 | `["opencode-vision-delegate", "@sorenllm/opencode-computer-use", "npm:@sorenllm/opencode-forge@0.27.1"]` |
| config `default_agent` | `"forge"`（用户配置） |
| config `agent.vision-agent` | model `glm-coding-worker/glm-5.3-flash`，variant `low`，extraBody `reasoning_effort: low` |
| /api/plugin 包插件 | forge=`npm:@sorenllm/opencode-forge@0.27.1`(v0.27.1)、vision=`opencode-vision-delegate`(v0.3.0)、opencode-computer-use=v0.5.0、paseo(local)，全 active |
| /api/agent @ plugin_dev location | 22 agents：build.hidden=False、plan.hidden=False、forge 无 shell deny、forge-plugindev-* 五工人在（无 task/shell deny）、vision-agent 在（model=glm-5.3-flash@glm-coding-worker/low）、forge-sorenunitylabs-* 八工人在 |
| 基准备份 | `$env:TEMP\opencode_baseline.jsonc`，SHA256 `A7176336…7A28D8C`，5048 字节 |

## 阶段 1：forge git+file 终验 — PASS

命令语法勘误：任务给的 `opencode plugin <path> --global --force` 不存在；安装器为子命令结构（list/add/check/update/remove），`add` 即装到全局 config，无 `--global`/`--force` flag。

### 1a. 裸 add（任务原文路径）→ Duplicate ID（安装器行为，非插件 FAIL）

- `opencode plugin add "git+file:///C:/Users/Soren/Desktop/AgentWorkCommon/opencode_plugin_dev/opencode-forge"` → "installed and added"
- 但 /api/plugin 出现**两个** forge：npm 0.27.1 仍 active + git+file `83df0b92` **failed**
- verbatim 错误：`Duplicate plugin ID: forge`
- 根因：add 把新条目**追加**到新写入的复数 key `"plugins": []`，与用户既有单数 key `"plugin"` 数组里的 npm 条目并存，两 key 均被 server 读取，同 ID 后注册者失败。agent 面此时仍 0.27.1 旧面（新版从未加载，server 运行不受影响）。

### 1b. 官方规程安装（先移旧条目再 add）

- README 卸载第 1 步（手工移除 config `plugin` 数组条目）移除 `npm:@sorenllm/opencode-forge@0.27.1` 行
- git+file 条目单独在位 → /api/plugin：`forge | git+file:///…/opencode-forge | v83df0b9207c61610a2bfaffca84ff4f157efc890 | active`（无错误）

### 1c. 冒烟断言（新版面，14 agents @ plugin_dev location）

| 断言 | 结果 | 证据 |
| --- | --- | --- |
| D1 `build` hidden | **PASS** | `hidden=True` |
| D2 `plan` hidden | **PASS** | `hidden=True` |
| D4 `forge` shell deny | **PASS** | permissions 含 `shell:* -> deny` |
| 五工人物化+封印 | **PASS** | spec-reviewer/coder/test-coder/gate-verifier/e2e-verifier 全在，permissions = `task:* deny + shell:* deny + browser:* deny + skill:browser deny`（4 条纯封印族，无 `*:*:allow`），taskDeny/shellDeny 全 True |
| 5b default_agent | 记录 | config `default_agent:"forge"` 为用户配置，未动（D5 与用户配置不可区分） |
| 5c forge active 无错误 | **PASS** | state=active，error 空 |
| 新面清单 | 记录 | Build/Plan(hidden)/General/Explore/Compaction/Summary/Title/forge/五工人/vision-agent，共 14 |
| 版本号 | 预期未 bump | git 源显示 commit `83df0b92…`（发版留给 bump） |

### 1d. 卸载还原 + 复原断言 — PASS

- `opencode plugin remove "git+file:///…/opencode-forge"` → 成功（server 热重载后 forge 条目消失，本会话 forge_* 工具命名空间同步消失——原生 shell 通道不受影响，符合预期）
- 装回：`add "npm:@sorenllm/opencode-forge@0.27.1"` 被拒（verbatim：`Error: Plugin target must be an npm registry package or Git package specifier`）；改用 `add "@sorenllm/opencode-forge@0.27.1"` 成功，forge 0.27.1 active，forge_* 工具回归
- 复原断言全过：build/plan hidden 回 **False**、forge/五工人无 shell deny（0.27.1 旧面）、五工人仍在、vision-agent 正常
- config 用基准备份逐字节还原（SHA256 一致）

## 阶段 2：vision git+file 终验 — PASS

### 2a. 裸 add → 同模式 Duplicate（复现确认）

- `opencode plugin add "git+file:///C:/Users/Soren/Desktop/AgentWorkCommon/opencode_plugin_dev/opencode-vision-bridge"` → "installed and added"
- /api/plugin 两个 vision：npm 0.3.0 active + git+file `0edb739f` failed，verbatim：`Duplicate plugin ID: vision`（forge 同款失败的跨插件复现）

### 2b. 官方规程安装 + 冒烟

- 移除 `plugin` 数组 `opencode-vision-delegate` 行 → git+file 条目单独在位：`vision | git+file:///…/opencode-vision-bridge | v0edb739f6af10f3d537140036545e7ea79f4cc89 | active`
- 冒烟：vision-agent 物化；**用户 config 的 model 配置在 merged 面可见**：`model.id=glm-5.3-flash, providerID=glm-coding-worker, variant=low`（fix 对象生效，hidden=False）

### 2c. 卸载 + npm 装回 + 复原 — PASS

- `remove "git+file:///…/opencode-vision-bridge"` 成功；`add "opencode-vision-delegate"` 成功
- 复原：vision=`opencode-vision-delegate` v0.3.0 active；vision-agent.model=glm-5.3-flash@glm-coding-worker/low；config 逐字节还原（SHA256 一致）

## 阶段 3：终态 diff — 全部复原

| 层 | 结果 |
| --- | --- |
| config 文件 | 与基准**逐字节一致**（SHA256 `A7176336…7A28D8C` 同），无追加条目残留 |
| /api/plugin | forge=`npm:@sorenllm/opencode-forge@0.27.1`(0.27.1)、vision=`opencode-vision-delegate`(0.3.0)、opencode-computer-use(0.5.0)、paseo(local)，全 active，无 failed 条目 |
| /api/agent | 22 agents，与基准**全字段深度一致**（name/hidden/permissions/model 逐项比对零差异）：build/plan hidden=False、forge 无 shell deny、plugindev×5、sorenunitylabs×8、vision-agent.model=glm-5.3-flash |
| 包 store | `~/.cache/opencode/npm/` 下本次产生的 3 个目录已清（2×git+file 残留 + 1×`@sorenllm\opencode-forge@0.27.1` 重装拷贝）；基准已有的 3 个目录原样保留 |

清理后终验：4 包插件全 active、22 agents 面不变 —— store 清理无副作用。

## agent 面复原的技术说明（非 FAIL）

中途一次快照曾为 14 agents（缺 sorenunitylabs 八工人）。定位：八工人是 `F:\UNITY_Project\SorenUnityLabs\.opencode\forge.json` 池的 **lazy 物化**（RAM-only，插件重载即清空，per-location 重建）。池文件与 session-anchors 记录均在磁盘；按该 location 查询 `/api/agent?location…=F%3A%5CUNITY_Project%5CSorenUnityLabs` 即返回 22 agents 含全部八工人。终态（累积注册表）= 基准 22。README 明示此为设计行为（restart-resumed session 由活动重绑 own pool）。

## 安装器行为怪癖清单（7 项，如实记录）

1. **add 追加不替换**：同 ID 已在任一 key 时，新条目注册 failed（`Duplicate plugin ID: <id>`）。升级必须先移旧条目。
2. **写入复数 key `plugins`**：add 不追加到用户既有的单数 `plugin` 数组，而是新建/追加 `"plugins": []`；两个 key 并存且都被 server 读取。
3. **remove 只认自家条目**：对 `plugin` 单数 key 里用户手写的条目 remove 报 `Plugin "npm:@sorenllm/opencode-forge@0.27.1" is not configured`；只 `plugins` 复数 key（安装器写入）的条目可 remove。
4. **add 不收 `npm:` 前缀**：`add "npm:@sorenllm/opencode-forge@0.27.1"` 报错（见 1d verbatim）；`@scope/name@version` 可用（该格式写入 config 后 server 正常加载）。
5. **remove 不清包 store**：git+file 卸载后 store 目录残留；README 卸载第 2 步（手工删 `~/.cache/opencode/packages/`，本机实际为 `~/.cache/opencode/npm/`）必要。
6. **specifier 格式决定 store 路径**：`npm:@sorenllm/…` → `npm_@sorenllm\…`；`@sorenllm/…` → `@sorenllm\…`。同版本两种格式并存时有两份拷贝（本次已清多余份）。
7. **`plugin list` 数据源混合**：remove 后仍显示已卸载的 git 条目（读 store）；npm 装回后 list 反而不显示 forge（读 config 单数 key + 部分源）。仅显示层怪癖，/api/plugin 实际状态始终正确。

## 装卸配对完整性

| # | 安装 | 卸载+装回 | 复原 |
| --- | --- | --- | --- |
| 1 | forge git+file（裸 add，Duplicate） | remove git+file 条目 + 移旧 npm 条目重装路径 | ✓ |
| 2 | forge git+file（规程路径，active） | remove git+file + add `@sorenllm/opencode-forge@0.27.1` | ✓ |
| 3 | vision git+file（裸 add，Duplicate） | remove git+file 条目 + 移旧条目 | ✓ |
| 4 | vision git+file（规程路径，active） | remove git+file + add `opencode-vision-delegate` | ✓ |

结束态 = 初始态：config 逐字节、API 双面（plugin/agent）全字段、包 store 三基准目录，全部与初始态一致。无 FAIL，无需中止。仓库文件、npm publish、git push 全程未触碰。
