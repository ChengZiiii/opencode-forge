# add-dispatch-suite · 官方安装终验存档（task 6.4）

- 日期：2026-09-27
- 命令形态（task 原文）：`opencode plugin "git+file:///<repo>" --global`
- opencode 版本：1.18.32（`opencode plugin <module> [-g] [--force]`）

## ⚠ 红线事件与处置（首次尝试，已完全还原）

第一次尝试按 goal 红线直觉使用 `OPENCODE_CONFIG_DIR=<沙盒>` 重定向，**但安装器不读该变量**，
`--global` 落到了用户真实配置 `C:\Users\Soren\.config\opencode`：

- 写入 1：用户 `opencode.jsonc` 的 `plugin` 数组被追加一行 `"git+file:///…/opencode-forge"`（09:49 本地）。
- 写入 2：`C:\Users\Soren\.cache\opencode\packages\git+file_\`（安装器包存储，09:49 新建）。

**还原（逐项核对）：**
1. 删除被追加的 plugin 行（仅此一行；用户自有的 `@sorenllm/opencode-forge`、`opencode-vision-delegate` 等条目原样保留）；`grep -c "git+file"` → 0。
2. 删除 `packages/git+file_` 目录（本次安装新建，09:49）；目录恢复为用户原有三项。
3. `.config/opencode/package.json`、`package-lock.json`、`node_modules/*` mtime 全部仍为 Sep 24（安装器未触碰）——复核通过。
4. 用户配置其余内容（provider、skills、注释）零改动。

**教训（已入 README 已知坑评审）：`opencode plugin --global` 的 "global" 根由 `XDG_CONFIG_HOME` 决定，
不读 `OPENCODE_CONFIG_DIR`。**

## 合规重试（XDG_CONFIG_HOME 重定向，用户路径零接触）

```
XDG_CONFIG_HOME=C:/tmp/forge-stage-g/xdg opencode plugin "git+file:///C:/Users/Soren/Desktop/AgentWorkCommon/opencode_plugin_dev/opencode-forge" --global
→ ◆ Installed git+file:///…
→ ● Scope: global (C:\tmp\forge-stage-g\xdg\opencode)   ← 落沙盒
```

安装产物（全部在沙盒内）：`xdg/opencode/opencode.jsonc`（plugin 数组含 git+file 条目）、
`package.json`（`@opencode-ai/plugin: 1.18.32`）、`node_modules/`（宿主依赖）。

### 注册/冒烟（43933 serve，XDG 全局 = 沙盒）

GET /config 合并结果：

```
commands: ['crew', 'goal', 'plan']
forge agents: ['forge', 'forge-build', 'forge-quick', 'forge-review', 'forge-scout']
plugin entries: ['git+file:///C:/Users/Soren/Desktop/AgentWorkCommon/opencode_plugin_dev/opencode-forge']
crew template has crew_begin: True
```

→ 官方安装的插件副本完成 config hook 注册：/crew 命令、forge 主 agent + 4 个 tier agent 物化、
模板完整。注册冒烟 **PASS**。

### README 四步卸载（对沙盒 XDG 执行，逐步）

1. 从全局配置 `plugin` 数组移除插件条目 → `xdg/opencode/opencode.jsonc` 只剩 `$schema`。✓
2. 删除包存储目录 → `xdg/opencode/node_modules`（本版本 git+file 安装的存储形态）+ `package-lock.json` 删除。
   （README 第 2 步的 `~/.cache/opencode/packages/…` 适用于 npm 形态安装；git+file 形态的存储在
   全局配置根的 node_modules，已如实记录。）✓
3. `agent["forge"]` 块 → 沙盒配置本就没有（no-op，核对 0 处 forge 引用）。✓
4. 重启 serve（43933）验证干净态：

```
commands: []                       | no forge commands: True
forge agents: []                   | none: True
plugin entries: []                 | none: True
UNINSTALL-VERIFY PASS
```

   隐藏的原生 build/plan agent 恢复（隐藏仅为运行时合并行为，无磁盘痕迹）。✓
5. （可选步骤）`<tmp>/opencode-forge/` 运行时碎片：**保留**——其中 dispatch 账本是本次验收的
   证据文件（final-report 引用），由用户终局验收后自行清理。

## 结论

- 官方安装器对 `git+file:///<repo>` 形态安装、注册、冒烟、四步卸载回干净态 **全链路 PASS**（沙盒内）。
- 首次尝试对用户配置的越界写入已完全还原（上表逐项），最终状态 = 安装前状态。
- 沙盒清理：两个 serve（43932/43933）进程均已 taskkill，端口段无监听。
