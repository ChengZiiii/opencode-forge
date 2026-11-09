# 验收报告 — 0.21.0 search-js-fallback（rg 缺机兜底引擎）

- **日期**：2026-11-09（用户指令：实现+审查收尾后，本波只交付与证明）
- **版本**：0.20.1 → **0.21.0**（minor，新能力：内置 JS 搜索引擎兜底链）
- **状态**：npm 已发布（`+ @sorenllm/opencode-forge@0.21.0`）；REST dist-tags 已翻 latest=0.21.0；本地 store 双层已更新；**字段级复现实机沙盒全绿**

---

## 1. 事故复盘（字段报告 2026-11-09 + 复现）

**字段报告**：rg-less 机器（rg 在 WinGet 路径下、部分会话 PATH 不含）上，forge_glob/forge_grep 直接 fail-soft 死亡；救济文案引导用户改用内建 glob/grep——而字段场景恰恰是**指向工作区外的 junction**（`Assets/SorenLibs` → `Documents/BeyondLibs`）：内建 glob 对 junction 结构性失明（正是本搜索对 founding scenario）→ forge_shell 探测也漏 → 用户最终手写递归 PowerShell 才找到。插件处处零依赖自含，唯搜索对例外——规格级缺陷。

**复现**：PATH 剥离（仅 `C:\Windows\System32;C:\Windows`，`where.exe rg` 确认无解析）→ 0.20.1 搜索对报 fail-soft；内建 glob 列不出 junction 内文件。零依赖自含保证被打破，确认与字段报告同链。

## 2. 修复（search-js-fallback，openspec 全流程）

- **规格**（specs/search-tools delta，commit 9bf3576 入库）：REMOVED「无 rg 即 fail-soft」需求（救济文案把调用方引进内建对的结构性盲区）→ ADDED 引擎链要求（rg 可解析用 rg，否则内置 JS 引擎，无机器级依赖）；readonly-by-construction 措辞引擎无关化 + 新增 JS 引擎 junction 场景（junction 相对路径列出 + 外部目标披露 + 引擎脚注）。
- **实现**（commits e39bfea / 5277be9 / 7d6699d）：`src/search-js.ts` 内置 JS 走查引擎——glob 方言匹配器（字符类加固，B1 never-throw：类解析失败降级 `re = /$^/` 永不匹配而非抛错）、cycle-guarded（realpath seen-set）follow 走查、记录上限+通知、二进制跳过、grep 扫描；plugin.ts 引擎链接线（rg → JS spawn fall-through）+ 引擎脚注；版本 0.21.0 + dist 重建。产物喂既有 dedupe/格式化后处理不动——link 路径报告、realpath 合并、工作区外目标披露白得。
- **输出契约**：与 rg 引擎逐字节一致，仅尾部多一行引擎脚注 `(engine: builtin-js — ripgrep not found; install ripgrep or set search.rgPath for the faster engine)`。
- **门禁**：typecheck 0 错误；全套件 **502/502**（474 基线 + 28）；pack 恰 3 文件（README.md / dist/index.js / package.json）。

## 3. 审查发现处置（B1 + N1-N6）

| 项 | 内容 | 处置 |
|---|---|---|
| B1 | glob 字符类解析对畸形模式可能抛错（blocker） | c64ad73：类解析失败降级永不匹配 `re = /$^/`（dist 内 marker 实证，见 §4）+ 专项测试腿 |
| N1-N3 | 记录上限到达无通知 / 元字符模式无测试腿 / readonly 形状无搜索测试腿 | c64ad73：cap notice + metachar/readonly 测试腿（search-js + search-wiring 双侧） |
| N4-N5 | 互指 symlink 环走查无双向测试腿 / README 未披露 rgPath 引擎链 | c64ad73 mutual-cycle 腿 + 2beb991 README rgPath 链注释 |
| N6 | dist 未随修复重建 | 2beb991：dist 重建（含 B1 marker + 脚注常量） |

## 4. 发布与本地更新（0.21.0）

| 项 | 证据 |
|---|---|
| 提交 | e39bfea / 5277be9 / 7d6699d / c64ad73 / 2beb991 + 9bf3576（change artifacts），工作区净 |
| 发布 | `+ @sorenllm/opencode-forge@0.21.0`，tarball 3 文件（169.7 kB），shasum ac46f94d…，token 仅进程级 env 零入库零日志 |
| 注册表 | REST `/-/package/@sorenllm%2Fopencode-forge/dist-tags` latest=0.20.1 → **0.21.0 翻转于 15:07:43**（发布 ~15:04 后约 3.5 分钟） |
| 本地 store | 删 `npm_@sorenllm` 目录 + 精确 spec `npm:@sorenllm/opencode-forge` 重装（"Already configured"，config 条目仍恰 1 条）；**首轮即达**（CDN 已追上）：store 根 package.json dependencies `@sorenllm/opencode-forge` = **0.21.0**、内层 node_modules 同包 version = **0.21.0** |
| dist marker | 内层 dist 含 `ENGINE_FOOTNOTE_MISS = "(engine: builtin-js — ripgrep not found; …"` 与 B1 never-throw `re = /$^/;`（各 1 处实证） |

## 5. 字段级验收（rg 剥离 serve 沙盒 — 核心证据）

**布置**：`Temp/opencode/sjf-accept/{ws,outside}`；ws 池文件 `{"pool":"sjf","agents":{probe:write,scout:readonly}}`（[IO.File]::WriteAllText 无 BOM）；`outside/BeyondLibs/needle.txt` 含标记 `SJF-FIELD-NEEDLE-7f3a`；junction `ws/Assets/SorenLibs` → `outside/BeyondLibs`（无管理员 Junction）。serve 以**剥离 PATH**（仅 System32+Windows；起前 `where.exe rg` 实证无解析）spawn（完整 exe 路径 + WorkingDirectory=ws，端口 43921，cmdline+pid 亲缘核验）。真实用户配置 + store 0.21.0 产物。会话 `agent=forge-sjf-scout`（readonly 形状，搜索对按 tool-partition D6 对工人保留）。**serve 在剥离 PATH 下无降级**（boot/安装器/工具全正常）。

**四断言（transcript tool parts 原文，em-dash 为 U+2014 实证）**：

- **(a) glob 列出 junction 相对路径 — PASS**：forge_glob `**/*.txt` 输出首行 `Assets\SorenLibs\needle.txt`（盲区案现为可见）。
- **(b) grep 命中 needle 行 — PASS**：forge_grep `SJF-FIELD-NEEDLE` 输出 `Found 1 matches` + `Assets\SorenLibs\needle.txt: Line 1: field parity probe line: SJF-FIELD-NEEDLE-7f3a marker`。
- **(c) 双输出均带引擎脚注 — PASS**：两输出尾行逐字 `(engine: builtin-js — ripgrep not found; install ripgrep or set search.rgPath for the faster engine)`。
- **(d) 工作区外目标披露 — PASS**：两输出均含 `outside-workspace target searched via link: C:\Users\Soren\AppData\Local\Temp\opencode\sjf-accept\outside\BeyondLibs\needle.txt`（解析后 junction 目标全名）。

**判定**：字段失败链（rg-less 机 + 外指 junction）完整重放、全绿——0.19.0 起的死路（fail-soft → 内建盲区）已闭合。工具输出直接取自 transcript tool parts（state.output，status=completed），未依赖模型转述。清理：serve 树亲缘核验后 taskkill /T（仅 pid 63692 及其子）、沙盒目录已删净。

## 6. 遗留

1. **search-js-fallback 未归档**——按用户指示另行安排（本波单不归档）。
2. 远端 push：本波执行（5093b45 之后全部提交），见 push 输出。
3. 宿主 opencode 重启后 0.21.0 生效（运行中宿主仍载 0.20.1）。
