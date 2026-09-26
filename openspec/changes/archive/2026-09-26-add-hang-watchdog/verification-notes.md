# add-hang-watchdog 实机验证结论（2026-09-26）

宿主：opencode 1.18.32（Windows 11，真实 run/serve 进程，provider
`glm-coding-worker/glm-5.3`）。沙箱姿势与 add-job-supervisor 相同：
`XDG_CONFIG_HOME` 指向配置副本（file-spec 插件 + `[spec, options]` 元组传
`watchdog` 选项），用户真实配置零触碰。复现负载：launcher 以
`stdio: inherit + detached` 起 holder 后退出（#47350 形态）；实机参数
`stallMs 60000`（默认 600s 太长，不影响语义验证）。插件选项经配置元组
传入已实证（故意传 `mode: "BOGUS"` → 账本出现 config-fallback 回退条目）。

## 6.1 kill / dry-run 双模式 — 通过

- **kill**：vision-agent（builtin bash 可用、forge 工具在沙箱中对其关闭）
  经 bash 跑 launcher-long；60s 处置时 bash/launcher 已退出、唯一活进程是
  detached holder —— 波 1（子树∪needle）为空，直接降入波 2 工作区范围，
  账本 `kill | workspace scope (call's own chain already exited)`，击杀
  列表恰为 holder node.exe 一个；卡死的 bash 调用随即解锁，run 正常完成
  （exit 0），agent 汇报了退出状态与捕获输出。会话不再卡死 ✓。
- **dry-run**：同复现，账本记 `dry-run-candidate`（含候选清单），目标
  holder 全程存活（事后枚举确认），run 保持挂死由外层 timeout 收
  尾 —— 只记录不误杀 ✓。

## 6.2 双平台定位器 — 通过（POSIX 为机制轮，Linux 原生轮缺席）

- **Windows 推算**：实机 6.1 的击杀即真实定位器输出（命中恰为目标、无
  误杀）；另有外部自测：宿主子孙树+时间窗命中真实子进程、未来窗为 0。
- **POSIX environ**：本机无 WSL 发行版、无 Linux 宿主 → 以 Git Bash
  (MSYS2) 的真实 `/proc/<pid>/environ` 做机制轮：精确命中带标记进程
  （1/1）、后缀诱饵键不匹配（0）、异 callID 进程不匹配（0）——NUL 分隔
  精确匹配语义与真实 environ 布局一致。Linux 原生轮待有 Linux 宿主时
  补做（定位器路径无平台魔法，风险低）。

## 6.3 子代理路径 — 通过

父会话经 task 工具派子代理，子代理内 bash 跑同复现挂死；哨兵击杀
holder 后子代理交卷（"Exit status: 0 … process finished"），父层 task
调用返回、run 整体 exit 0。附注：账本 kill 条目的 sessionID 记为父会话
id（1.18.32 的 before 钩子对子代理 bash 的 session 归属如此上报），
不影响"子代理内挂死被解锁"的结论。

## 实机驱动的设计修订（已回写 design D3/D4 与 spec delta）

1. CIM `ParentProcessId` 对宿主起的 shell 子进程不可靠（同复现两次运行
   报告不同父级）→ 纯子树闭包漏杀；加入命令 token 匹配分支（波 1）。
2. #47350 类在处置时刻自身链已退出，唯一活进程是 detached 管道持有者
   → 增加波 2 工作区目录范围（波 1 空手或证明不足后触发；此后不再升
   级，unresolved 诚实上报）。
3. conhost.exe 永不作为目标（杀 conhost 会瘫痪后续 PowerShell 探测，
   实测踩过）。
4. PowerShell 探测须 `execFileSync("powershell", [...])` 直调（execSync
   默认 shell 是 cmd.exe）；不可用 `-AsArray`（PS 5.1 无）。
5. 时间窗 2s 宽限（CIM 秒级取整 + before→spawn 延迟）。

结论：spec 全部 requirement 的场景在实机成立；无阻塞项。

## 7.1 / 7.2 — 发布与官方安装终验（2026-09-26）

- **7.1 通过**：与 add-job-supervisor 同车 0.3.0 发布（同一 tarball，dist 含
  两波定位与 needle 代码）；发布凭据链与 token 撤销见其 8.1 备注。
- **7.2 通过（与 8.2 同一发布列车）**：npm spec 重装 0.3.0 后零干扰冒烟——
  forge 会话常规命令与 build agent 内置 bash 命令（`BUILTIN-WATCHED-OK-030`）
  均正常完成；`<tmp>/opencode-forge/watchdog/` 目录未出现：标记计时全部在
  内存完成，零预警、零处置、零落账。内置 shell 路径的干预行为本体已在 6.1
  kill/dry-run 实机验证；本轮验证的是"装上官方包后正常使用完全不感知"。
