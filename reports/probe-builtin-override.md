# Probe 报告：用户同名 agent 文件能否遮蔽 opencode 2.3.2 内置子代理（builtin-override 生死判定 · 任务 0.1）

- 日期：2026-11-21
- 对象：opencode v2.3.2（`C:\Users\Soren\AppData\Roaming\npm\node_modules\@opencode\cli\bin\opencode.exe`，npm 全局安装，二进制内确认含 `OPENCODE_TEST_HOME` / `OPENCODE_CONFIG_DIR` / `OPENCODE_DB` / `location[directory]` 字符串）
- 沙盒根：`C:\Users\Soren\AppData\Local\Temp\probe-builtin-override`（下文记 `$sb`）
- 方法：隔离环境起 `opencode serve --port 47321 --hostname 127.0.0.1`（CWD=`$sb\ws`），Basic auth（`opencode:<password>`，password 取自 serve stdout 日志），全程只查 `GET /api/agent`，零会话派发、零 LLM 调用。所有原始响应留档于 `$sb\step*.json` / `final-withparam.json`。
- 响应形状：`{"location":{"directory":...},"data":[...agents]}`，agents 在 `.data`。

## 隔离配方（含两处对父会话配方的实证修正）

```
OPENCODE_TEST_HOME   = $sb\home
OPENCODE_DB          = $sb\db.sqlite          # 实证生效：db.sqlite/-shm/-wal 全部落沙盒
OPENCODE_CONFIG_DIR  = $sb\config             # 实证生效：真实 config 的 vision-agent 等条目从未出现
XDG_DATA_HOME        = $sb\home\.local\share  # ★ 补充项（见"卫生"节：三件套不覆盖 log 路径）
XDG_STATE_HOME       = $sb\home\.local\state  # ★ 补充项
```

**修正 1（全局 agent 目录的真实位置）**：设了 `OPENCODE_CONFIG_DIR` 后，全局层 agent 目录是 **`$sb\config\agent\`**（CONFIG_DIR 下），`$sb\home\.config\opencode\agent\` **完全不读**（大写/小写文件均无任何效果，Step 2/2d 实证）。父会话配方中"写 `$sb\home\.config\opencode\agent`"的猜测不成立。真实环境（无 CONFIG_DIR）下等价目录即 `~/.config/opencode/agent/`——加载机制相同，结论可迁移。

**修正 2（service.json）**：显式 `--port` 启动时 serve **不写** service.json（假 home 与真实 home 均未出现新文件）；url+password 从 serve stdout 日志读取即可。

**观测异常（已定性，不影响结论）**：serve 启动后**首次** `GET /api/agent?location[directory]=<ws>` 返回 `data:[]`，且首次 no-param 响应里 permissions 尚无默认 browser-deny 追加项；约 2 秒后自愈（with-param 与 no-param 均返回完整 7 条且相互一致，终态复验确认）。判定为 agent 配置链惰性初始化的首触伪影。

---

## Step 1 — 基线（干净沙盒）

`GET /api/agent`（no-param，location 默认 echo `$sb\ws`）→ `data` 共 **7** 条：

```
Build        mode=primary    hidden=False
General      mode=subagent   hidden=False
Explore      mode=subagent   hidden=False
Compaction   mode=primary    hidden=True
Title        mode=primary    hidden=True
Summary      mode=primary    hidden=True
Plan         mode=primary    hidden=False
```

（逐字记录以 `$sb\step1-noparam.json` 为准。）

内置 `General` 关键字段逐字（完整记录见 step1-noparam.json）：

```json
{ "id": "general", "name": "General", "mode": "subagent", "hidden": false,
  "description": "General-purpose agent for researching complex questions and executing multi-step tasks. Use this agent to execute multiple units of work in parallel.",
  "model": <无此字段>,
  "permissions": [ {"*","*","allow"}, {"read","*.env","ask"}, {"read","*.env.*","ask"}, {"read","*.env.example","allow"}, {"question","*","deny"}, {"subagent","*","deny"} ] }
```

内置 `Explore` 关键字段逐字：

```json
{ "id": "explore", "name": "Explore", "mode": "subagent", "hidden": false,
  "description": "Fast agent specialized for exploring codebases. Use this when you need to quickly find files by patterns (eg. \"src/components/**/*.tsx\"), search code for keywords (eg. \"API endpoints\"), or answer questions about the codebase (eg. \"how do API endpoints work?\"). When calling this agent, specify the desired thoroughness level: \"quick\" for basic searches, \"medium\" for moderate exploration, or \"very thorough\" for comprehensive analysis across multiple locations and search approaches.",
  "system": "You are a file search specialist. ...",
  "model": <无此字段>,
  "permissions": [ 16 条：allow-all、env 三连 ask、deny-all + shell/grep/glob/webfetch/websearch/read 只读放行集、subagent deny、external_directory allow ] }
```

**Step 1 verdict**：基线成立；无任何真实 config 条目泄漏（无 vision-agent）→ 隔离有效。

---

## Step 2 — 全局层同名文件 vs 内置

### 2a. 按父配方写 `$sb\home\.config\opencode\agent\General.md`

frontmatter：`description: PROBE-OVERRIDE-MARKER-GLOBAL` / `mode: subagent` / `model: glm/glm-5.3-flash`。

结果（step2-noparam.json）：**无任何变化**。7 条、General 仍为内置原文、无重复、无 model。→ 该目录不被读取。

### 2b. 写 `$sb\config\agent\General.md`（CONFIG_DIR 下全局层，大写文件名）

frontmatter：`description: PROBE-OVERRIDE-MARKER-GLOBAL-CFGDIR`，其余同。

结果（step2b.json）：**总数 7→8，出现两个 "General"，内置原样不动**：

```
id=general  model=          desc=General-purpose agent for researching complex questions ...（内置，未动）
id=General  model=glm-5.3-flash  desc=PROBE-OVERRIDE-MARKER-GLOBAL-CFGDIR（新条目）
```

用户条目完整记录（逐字）：`{ "id":"General", "name":"General", "model":{"id":"glm-5.3-flash","providerID":"glm"}, "system":"You are the probe override body (config-dir variant).", "description":"PROBE-OVERRIDE-MARKER-GLOBAL-CFGDIR", "mode":"subagent", "hidden":false, "permissions":[allow-all + env 三连 ask + browser deny + skill:browser deny] }` —— permissions 是"用户文件(无)⊕默认值"，**不含**内置特有的 question/subagent deny，证明与内置条目零合并。

### 2c. 删除对照：删 `$sb\config\agent\General.md` → 回到 7 条单 General（step2c）。第 8 条确由该文件引起。

### 2d. `$sb\home\.config\opencode\agent\general.md`（小写）→ 仍无效果（step2d）。home 目录彻底不参与。

### 2e. **关键变体：`$sb\config\agent\general.md`（小写，id 与内置 `general` 精确一致）**

frontmatter 原文：

```
---
description: PROBE-OVERRIDE-MARKER-LOWERCASE-ID
mode: subagent
model: glm/glm-5.3-flash
---
You are the probe override body (lowercase id variant).
```

结果（step2e-lowercase.json，逐字关键部分）：**总数回落 7，唯一一条 General 被覆盖**：

```json
{ "id": "general", "name": "General",
  "model": { "id": "glm-5.3-flash", "providerID": "glm" },
  "system": "You are the probe override body (lowercase id variant).",
  "description": "PROBE-OVERRIDE-MARKER-LOWERCASE-ID",
  "mode": "subagent", "hidden": false,
  "permissions": [ allow-all, env×3 ask, question deny, subagent deny, browser deny, skill:browser deny ] }
```

→ description ✓ model 钉上 ✓ system ✓；permissions = **内置 6 条（含 question/subagent deny）+ 默认 browser 2 条追加** = 以内置为基底做标量覆盖 + 权限并集。

**Step 2 verdict**：全局层同名文件**可以覆盖内置**，但**仅当文件名 stem 与内置 id 精确一致（全小写 `general.md`）**；大写 `General.md` 不覆盖、只产生并存重复条目（歧义形态）。

---

## Step 3 — 项目层同名文件 vs 内置

（预清理：删全局文件，回到 7 条基线，step3-pre。）

### 3a. `$sb\ws\.opencode\agent\General.md`（大写，`description: PROBE-OVERRIDE-MARKER-PROJECT`）

结果（step3a-project-Upper.json）：**8 条，重复条目**，与全局层大写行为一致：

```
id=general  model=          desc=General-purpose agent ...（内置，未动）
id=General  model=glm-5.3-flash  desc=PROBE-OVERRIDE-MARKER-PROJECT
```

### 3b. 改名 `$sb\ws\.opencode\agent\general.md`（小写）

结果（step3b-project-lower.json）：**7 条，General 被覆盖**：`desc=PROBE-OVERRIDE-MARKER-PROJECT`、`model=glm-5.3-flash`、`system="You are the probe override body (project layer)."`、permissions=内置 6 + browser 2。

**Step 3 verdict**：项目层与全局层机制**完全一致**——小写覆盖 ✓，大写重复 ✗。

---

## Step 4 — 双层叠加 vs 内置

### 4a. 双层均小写 `general.md`（全局 `config\agent\` + 项目 `ws\.opencode\agent\`，marker 分别 GLOBAL-CFGDIR / PROJECT）

结果（step4a-both-lowercase.json）：**7 条，单一 General**：

```
id=general  model=glm-5.3-flash  desc=PROBE-OVERRIDE-MARKER-PROJECT  sys=You are the probe override body (project layer).
```

→ **项目层赢**。已知"项目>全局"规则在内置 id 碰撞下依旧成立。

### 4b. 双层均大写 `General.md`（两用户文件同 id=`General`）

结果（step4b-both-uppercase.json）：**8 条**：内置 `general` 原样 + **仅一条**重复 `id=General`（**项目层 marker 赢**，全局条目被同 id 顶掉）。

**Step 4 verdict**：跨层同 id 去重（不会 9 条）；层间优先级项目>全局，对内置的处置（覆盖或重复）仅取决于 id 是否撞上内置。

---

## Step 5 — Explore 复验（非 General 特例确认）

预清理回 7 条基线后：

### 5a. `$sb\ws\.opencode\agent\Explore.md`（大写，`description: PROBE-MARKER-EXPLORE`）→ **8 条重复**：

```
id=explore  model=           desc=Fast agent specialized for exp…（内置，未动）
id=Explore  model=glm-5.3-flash  desc=PROBE-MARKER-EXPLORE
```

### 5b. 改名 `explore.md`（小写）→ **7 条，Explore 被覆盖**（step5b-explore-lower.json 逐字）：

```json
{ "id": "explore", "name": "Explore",
  "model": { "id": "glm-5.3-flash", "providerID": "glm" },
  "system": "You are the explore probe override body.",
  "description": "PROBE-MARKER-EXPLORE", "mode": "subagent", "hidden": false,
  "permissions": [ 内置 Explore 全集 16 条（保序）+ browser deny + skill:browser deny ] }
```

**Step 5 verdict**：两分支在 Explore 上完整复现 → 结论可复制，非 General 特例。

### 终态 with-param 复验（final-withparam.json）

`GET /api/agent?location%5Bdirectory%5D=<ws>` 与 no-param 解析一致：`explore` 已覆盖（marker+model），`general` 已随预清理回内置。

---

## 机制小结（五步合流）

1. **agent 身份键 = id = 文件名 stem，大小写敏感精确匹配**。内置 id 为全小写（`general`/`explore`）。
2. id 撞上内置（`general.md`/`explore.md` 小写）→ **真覆盖**：用户标量（description/system/model…）替换内置值，permissions 走"内置基底 ∪ 用户（本实验为空）∪ 默认追加（browser/skill deny）"，name 保留内置的 "General"/"Explore"。热应用约 ≤2 秒，无需重启。
3. id 撞不上（`General.md`/`Explore.md` 大写）→ 内置不动，用户文件作为**同名异 id 的并存新条目**出现（客户端将看到两个 "General"——派发歧义形态）。
4. 层间规则不因内置碰撞改变：项目 > 全局；跨层同 id 后写者（项目）顶替前者，总数不膨胀。
5. 真实环境迁移：全局层等价目录为 `~/.config/opencode/agent/`（本实验因 CONFIG_DIR 指向 `$sb\config` 而用 `$sb\config\agent`，机制同一）。

## 判定

**POSITIVE（change 活）——带一个硬性实现约束**：任一层（全局/项目）的用户同名文件**能够**把自己的 description/model 覆盖到内置 General/Explore 条目上（列表里显示我们的 marker，model 钉上），双层叠加时项目层赢——builtin-override 设计成立。**硬约束：文件名必须用与内置 id 精确一致的全小写 `general.md` / `explore.md`**；若按直觉写 `General.md`/`Explore.md`（大写），得到的是同名重复条目而非覆盖（歧义形态，那一分支判 NEGATIVE）。生死结论：**builtin-override 存活，落地时钉死小写文件名即可**。

附注（未测、超矩阵范围）：用户文件自带 `permissions` 时的并集细节沿用前一轮"标量项目赢+全局 permissions 拼接"规则与否，未在本探针重验。

---

## 沙盒卫生确认

- **进程**：两个 serve 实例均已树杀（serve#1 wrapper PID 94664 及子进程 75500/71892；serve#2 wrapper PID 29376 及子进程 91964/8540，`taskkill /T /F`）。终检 `Get-NetTCPConnection -LocalPort 47321` → **无任何连接**（连 TIME_WAIT 都已消失）。
- **真实 home**：
  - `~/.local/state/opencode/service.json` mtime 全程未动（2026-11-21T04:12:42，与探针前快照一致）；
  - `~/.local/share/opencode/auth.json` mtime 未动（2026-09-29T01:27:47）；
  - `~/.config/opencode/agent/` 探针前后均不存在（真实全局 agent 目录零接触）；
  - 真实应用日志 `~/.local/share/opencode/log/opencode.log`：今日新增**恰好一行** `cli starting`（08:40:11Z，serve#1）——三件套不覆盖 log 路径所致（XDG 数据目录默认仍指真实 home）；发现后立即树杀 serve#1 并在 serve#2 补 `XDG_DATA_HOME`/`XDG_STATE_HOME`，serve#2 的应用日志全程落在 `$sb\home\.local\share\opencode\log\opencode.log`，真实日志再无新增。这是本次探针唯一一处沙盒外写入，已修复并如实记录。
- **真实 config**（`~/.config/opencode/opencode.jsonc`）：探针后 mtime 为 16:36:41（早于 serve#1 启动的 16:40:11，无法完全归因——该时刻前后我唯一的真实环境 opencode 调用是最初的 `opencode --version` 检查，宿主会话也在并行运行）；**内容已逐块比对（glm-coding-worker/forge 插件/vision-agent/lan-relay/skills 路径全在，4716 字符 129 行结构完整），零内容变化**。我未执行任何针对真实 config 的写操作。
- **真实进程**：零接触（探针全程只读端口检查与日志 grep）。
- **仓库/源码/git**：零改动（唯一写入为本文报告文件）。
- **沙盒留档**：`$sb`（step1~step5 全部原始 JSON、serve 日志、沙盒 config 与 agent 文件）保留供父会话复核；如需清除可直接删除该目录。
