# Probe Report — 2.3.2 原生子代理面测绘（native-first-roster 前置事实收集）

- 日期：2026-11-21（UTC 2026-11-21 05:47–06:01）
- 宿主：`opencode v2.3.2 serve`（127.0.0.1:47431，Basic auth）
- 沙盒：`C:/Users/Soren/AppData/Local/Temp/opencode/probe-native-agent/`（下称 `<T>`；serve CWD=`<T>/wsA`）
- 驱动：HTTP API 直连（fetch + Basic auth），SSE 未用；模型端点真实可用（glm-5.3-flash 实派 4 次）
- 驱动脚本（留在工作区）：`probe-native-agent-setup.mjs`、`.tmp/probe-native-agent/start-serve.ps1`、`.tmp/probe-native-agent/readlog.mjs`
- 原始证据：`<T>/logs/serve.log`（ stitched 摘录：`.tmp/probe-native-agent/loglines.json`）
- 未改任何源码；未装任何插件（纯原生面）

## 0. 沙盒纪律实录

1. **新隔离缺口（重要披露）**：第一次 serve 只用 `OPENCODE_TEST_HOME`+`OPENCODE_DB` → `/api/config` 返回了**真实的** `C:\Users\Soren\.config\opencode\opencode.jsonc`（vision-agent 等内容可见）。**当场杀掉，未向真实 config 写入任何东西**（config 端点只读）。`OPENCODE_TEST_HOME` 隔离 DB/数据，**不隔离 config 文档解析**。
2. **最终有效配方**：`OPENCODE_TEST_HOME=<T>/home` + `OPENCODE_CONFIG_DIR=<T>/home/.config/opencode` + `OPENCODE_DB=<T>/home/data/opencode.db` + serve CWD=`<T>/wsA`。隔离验证：`/api/config` 首文档 path=`<T>\home\.config\opencode\opencode.json`；`/api/session` → `{"data":[],...}`；独立 DB 落在 `<T>/home/data/`。
3. `/api/config` 的 directory 扫描链会列出 `C:\.opencode`、`C:\Users\Soren\.opencode`（只读扫描，二者不存在内容）。
4. 收尾：serve job 经 forge_jobs kill + taskkill 树杀；端口 47431 终态仅剩 TIME_WAIT（OwningProcess=0）；真实 opencode 进程（88164/97112，04:12 启动的真实 service）全程未动；`C:\Users\Soren\.config\opencode\forge.json` 实测前后均为不存在。

## OpenAPI 事实（GET /openapi.json，142 条路径）

- `GET /api/agent?location[directory]=<abs>`：deepObject query，返回 `{location, data:[Agent.Info]}`。
- `Agent.Info` 字段：`id,name,model(Model.Ref),request(Provider.Request{settings,headers,body}),system,description,mode(subagent|primary|all),hidden,color,steps,permissions(Permission.Ruleset)`。
- `Permission.Rule`：`{action:string, resource:string, effect:allow|deny|ask}`（additionalProperties:false）。
- 无 `/api/tool` 面；会话内工具面无 HTTP 枚举端点（工具可见性经子会话实测观察，见 §5）。

---

## 1. 最小原生 agent — **PASS**

frontmatter 原文（`<T>/wsA/.opencode/agent/test-scout.md`）：

```yaml
---
description: Probe scout agent for surface mapping
---
```

落记录（GET /api/agent?location[directory]=<T>/wsA，节选）：

```json
{"id":"test-scout","name":"test-scout","system":"You are test-scout. Answer with the single word SCOUT-OK.",
 "description":"Probe scout agent for surface mapping","mode":"primary","hidden":false,
 "permissions":[{"action":"*","resource":"*","effect":"allow"},...env ask 三条...browser/skill browser deny]}
```

- 无 model 键 → 记录无 model 字段（回落宿主默认模型 `opencode/tidepool-alpha-free`，实测子会话如此）。
- **默认 mode 是 `primary`**（不是 subagent）——原生文件的工人默认进主会话可选面，不进 task 派发面（见 §6）。
- 派发面：宿主 2.3.2 的派发工具叫 **`subagent`**（不是 `task`；父会话模型原话 "There's no tool named \"task,\" but the `subagent` tool is my equivalent"）。无独立 HTTP 工具枚举面。

## 2. model 钉扎 — **PASS**

三种写法全部生效，frontmatter ↔ 落记录：

| frontmatter | 落记录 model |
| --- | --- |
| `model: glm-coding-worker/glm-5.3-flash` | `{"id":"glm-5.3-flash","providerID":"glm-coding-worker"}` |
| 对象 `{providerID, model, variant: low}` | `{"id":"glm-5.3-flash","providerID":"glm-coding-worker","variant":"low"}` |
| `model: glm-coding-worker/glm-5.3-flash#low` | 同上，`variant:"low"` |

**运行时证据**（真实派发，父会话 ses_e035633deffewLNn0T5gUHPRiX）：

- pin-sub（`mode: subagent` + model 串写）子会话 ses_e03549f16ffeHphw7nQpDs8pRV 助手消息：`"agent":"pin-sub","model":{"id":"glm-5.3-flash","providerID":"glm-coding-worker","variant":"default"}`，text=`PINSUB-OK` ✅
- variant-sub（`#low`）子会话 ses_e0353e0fdffeynPtnsTZu2SD47 助手消息：`"model":{...,"variant":"low"}`，text=`VARIANT-OK` ✅（variant 全链路到运行时）

## 3. reasoning/思考深度旋钮 — **PARTIAL**（关键陷阱）

**宿主没有一等旋钮键**。实测五种拼写（`reasoningEffort` / `reasoning:{effort}` / `thinking` / `effort` / `thoughtLevel`）**全部**以「未知键」身份**透传进 `request.body`**（记录级）：

```json
// knob-re.md（仅 description + reasoningEffort: high）落记录：
"request":{"settings":{},"headers":{},"body":{"reasoningEffort":"high"}}
// reasoning:{effort:high} → body:{"reasoning":{"effort":"high"}}，其余同理
```

**陷阱（v1 permission 拼写教训的镜像）**：同一 frontmatter 里**只要出现 `permissions` 键，未知键处理从「透传 body」翻转为「WARN + 丢弃」**：

```json
// x-knob-perm.md（reasoningEffort + permissions 数组）→ body 为空 {}，且 serve 日志：
timestamp=...06:00:04.347Z level=WARN message="ignored unsupported agent fields"
  path="...wsA\.opencode\agent\x-knob-perm.md" fields="[\"reasoningEffort\"]"
// combo.md（model#low + reasoningEffort + permissions）同样丢：body:{} + 同款 WARN
```

无 permissions 的 pin-sub（model + reasoningEffort）body 保留 `{"reasoningEffort":"high"}`，且子会话 `tokens.reasoning=5`（>0，发生了思考；但 wire 级是否按 high 生效未获决定性证据）。

- 结论：深度旋钮的**健壮原生通道是 model variant**（`glm-5.3-flash#low/high/max`，变体 settings 里带 `reasoningEffort`，全链路实测生效）；裸 extra-body 透传是**脆弱通道**（与 permissions 互斥、拼写不被校验、静默翻脸）。

## 4. permissions 面 — **PASS**（含硬失败语义）

frontmatter（v2 数组拼写，probe-1.1 的 create body 形状）：

```yaml
permissions:
  - action: task
    resource: '*'
    effect: deny
  - action: write
    resource: '*'
    effect: deny
```

落记录（perm-good，节选，deny 生效顺序在默认 baseline 之后）：

```json
"permissions":[...默认 baseline...,{"action":"task","resource":"*","effect":"deny"},{"action":"write","resource":"*","effect":"deny"}]
```

**坏拼写（v1 式 `permission:` 映射表）不是静默丢——是整个 agent 文件被跳过**，带 WARN：

```json
timestamp=...05:50:15.942Z level=WARN message="agent file skipped"
  filepath="...wsA\.opencode\agent\perm-bad.md" reason=frontmatter
  issue="ExpectedPermissionActionConfig\n  at [\"permission\"][0][1][0][1]..."
```

perm-bad 在 /api/agent 全程 ABSENT。文件定义与 create body 同构（同一 Permission.Ruleset schema）。

## 5. 工具面控制（readonly 纯原生表达）— **PASS**

原生 `tools:` 键（布尔映射）→ 逐键转成 permission deny 规则，实测映射词汇表：

| frontmatter tools 键 | 落 permission action |
| --- | --- |
| `write:false` | `edit` |
| `bash:false` | `shell` |
| `task:false` | `subagent`（即 2.3.2 派发工具真名） |
| `apply` / `applypatch` / `multiedit` / `read` / `glob` / `grep` / `list` / `ls` / `webfetch` | 同名透传 |
| 未知键（如 `task2:false`） | 原样透传为 deny action |

**deny 不只是规则——工具从该 agent 的工具面整体消失**。ro-sub（write/edit/bash/apply/applypatch/multiedit 全 false，mode subagent）实派（ses_e0353a9d2ffeSlT8EZsmtTiiuV，agent=ro-sub），子会话最终报告 verbatim：

```
**Write attempt:** no write or edit tool is available in this session (this is the readonly
native subagent toolset — read/glob/grep plus the Code Mode `execute` runtime, but no
file-writing tool). The file was not written. ... read 验证 ro-test.txt → File not found
**Bash attempt (`echo hi`):** no bash tool is available. The closest tool is `execute`, which
is the Code Mode JS runtime, not a shell. Attempt `execute` with code `echo hi` returned:
SyntaxError: Unexpected token...
```

→ **readonly 形状可纯原生表达**（隐藏而非运行时拒）。注意：本宿主构建的 shell 通道是 Code Mode `execute`（JS runtime），`bash:false → shell deny` 对它不适用——原生 `tools` 词汇表与宿主工具名之间存在代差（task→subagent 的映射说明宿主做过改名兼容，execute 未覆盖）。

## 6. mode: subagent 语义 — **PASS**（默认 primary 是陷阱）

- `mode: subagent` 落记录 `"mode":"subagent"`；未写时默认 `"primary"`。
- **mode 决定派发可达性**：实派对照——
  - `mode-sub`（subagent）：子会话 ses_e03551993ffeuCWiP4JZz8UNbQ `"agent":"mode-sub"`，text=`SUBMODE-OK` ✅
  - `model-str`（默认 primary）：task 调用**静默回落 general**（子会话 ses_e0355dfd9ffefYPrGBcZs3G1s0 `"agent":"general"`，text=`PIN-OK`）——primary 模式 agent 不进 subagent 名册，且**派发端无报错**（回落而非拒绝）。
- HTTP `POST /api/session {agent:"mode-sub"}` 仍 200 建会成功（ses_e03563a21ffehHvMYM5C6mPewK）——排除是选择面/客户端语义，API 层不拒。
- 工人生成配方应固定写 `mode: subagent`，否则不可派。

## 7. 目录作用域 — **PASS**（是「向上全合并」不是「最近独占」）

- 项目层 `<T>/wsA/.opencode/agent/`：以 `location[directory]=<T>/wsA` 查询全部可见。
- 全局层 `<T>/home/.config/opencode/agent/test-scout.md`（=真实机 `~/.config/opencode/agent/`，被 OPENCODE_CONFIG_DIR 重定向）：在 `<T>/dirB`（无项目层）查询可见（`"description":"GLOBAL layer same-name agent"`），built-in 面也在。
- 嵌套 `<T>/wsA/sub/.opencode/agent/nested-agent.md`：`location=wsA/sub` 查询同时看到 **nested-agent + 父层全部 agent**（向上逐级合并，非 forge 式「最近 forge.json 独占」）；父层 `location=wsA` 查询**看不到** nested-agent（不下扫）。
- 冷目录首查竞态：dirB 文件已存在，第一次 GET 仍返回 `[]`（`location` 缓存冷启动），第二次起正常——编排层做按名 keying 时需重试/预热。

## 8. 热应用 — **PASS**

- 改 description 存盘 → **下一次 GET 即新值**（`"HOT-UPDATED description v2"`，未重启 serve；serve 日志全程可见 watcher/重解析活动）。
- 删文件 → **下一次 GET 即消失**（mode-sub 删除后 ABSENT，perm-bad 删除后 warn 停止）。
- 前提：带 `--print-logs` 的 serve 常驻进程内 watcher 生效；粒度是「文件级立即」，无 TTL。

## 9. 合并配置可见性（编排层数据源）— **PARTIAL**

- `GET /api/config` 输出 = 配置文档数组（document + directory 条目），**无 `agents` 键——原生 .md agent 完全不出现在 /api/config**。v2 插件 config 钩子若只看 config 对象，看不到原生名册（本沙盒未装插件，钩子侧未直接验证）。
- 可用数据源是 `GET /api/agent?location[directory]=<ws>`（含 mode/model/permissions 全形状，支持按名 keying）。
- `/api/experimental/config` → 404（不存在）。

## 10. 同名层叠（项目 vs 全局）— **PARTIAL**（合并语义非独占）

同名 `test-scout` 双层并存时，`location=wsA` 的记录是**混合体**：

- 标量（description/system）：**项目层赢**（`"Probe scout agent..."`/本地正文，非全局 "GLOBAL layer..."）。
- permissions：**全局层 `tools: bash:false` 产生的 `shell:* deny` 持续混入项目层记录**——本地文件重写（去掉一切键）后 shell deny 仍在 → **权限规则跨层 concat，不是整体覆盖**。
- `location=dirB`（无项目层）：全局定义原样可见。

→ 与 forge 的 `forge-<ns>-<id>` 全池命名空间防撞语义**不同**：原生层同名靠「标量项目赢+权限拼接」裁决，无命名空间隔离；native-first 编排若同名跨层会得到意外拼接的权限面。

---

## 对 native-first-roster 的判定

| 能力 | 判定 | 一句话结论 |
| --- | --- | --- |
| **模型钉扎** | 原生完全可行 | frontmatter `model: provider/model[#variant]` 三种写法全链路生效（记录+子会话运行时双证），无缺口。 |
| **深度旋钮** | 原生部分可行、有陷阱 | 无一等键；健壮通道是 model variant（`#low/high/max`，运行时实证），extra-body 透传（五拼写皆进 `request.body`）在 frontmatter 含 `permissions` 时被 WARN 丢弃——编译器应产出 variant 钉扎而非裸 reasoning 键。 |
| **封印（readonly/工具面）** | 原生完全可行 | `tools: {write:false, edit:false, bash:false, task:false, ...}` 原生表达 deny+隐藏（工具从 agent 面整体消失，实测 readonly 子会话无写工具）；但词汇表有代差（宿主 shell 已更名 `execute`，`bash:false→shell deny` 覆盖不到），必要时补 `permissions` 数组按宿主真名 deny。 |
| **作用域** | 原生可行、语义不同 | 项目层+全局层+嵌套向上全合并（非 forge 的最近独占），同名靠「标量项目赢+权限拼接」无命名空间防撞——编排层如需池隔离仍要自己在 id 前缀上做，或接受全局层共名册。 |
| **热应用** | 原生完全可行 | 存盘即生效、删文件即失（watcher 文件级立即，无重启无 TTL），与 forge mtime 缓存对等；注意冷目录首查可能返回空，keying 前需预热/重试。 |

**附送环境事实**（对 forge 有直接冲击）：
1. 2.3.2 派发工具名是 `subagent`（不是 `task`）；permission action 也是 `subagent`（`tools.task:false` 被映射到它）。
2. `OPENCODE_TEST_HOME` 单独不隔离 config 文档解析（会读到真实 opencode.jsonc）——沙盒配方必须三件套（TEST_HOME+CONFIG_DIR+DB）。
3. 未钉扎 agent 的宿主默认模型是 `opencode/tidepool-alpha-free`（免费档），非沙盒 config 里的 glm。
4. mode 默认 `primary`：不写 mode 的原生工人默认**不可派**（task 静默回落 general）。
