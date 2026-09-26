# Proposal — disclose-exec-cwd

## Why

实机边界测试（2026-09-27，用户真实配置 + npm 0.3.1，Temp 目录，自然提示词
"帮我起个本地静态服务器，就 serve 当前目录"）连续两轮出现**agent 对命令
执行目录的叙述不稳定**：第一轮 agent 回报"服务根目录
`C:\...\AgentWorkCommon`"（与事实不符），复现轮回报正确的
`C:\...\Desktop\Temp`。定向探针证明插件链路本身正确——`opencode run` 在
非 git 目录下 input.worktree="/"、plugin 的 effectiveWorktree 回落到
launch directory（Temp）；forge_shell 的 ToolContext 解析同样落 Temp
（`cmd /c cd` 实测输出 Temp）。

即：**缺陷不在 cwd 计算，而在结果不可核对**——forge_shell 的返回（exited /
succeeded / still-running / 后台句柄）只带 jobId、logPath 与输出尾部，
不带命令实际执行的工作目录。当模型叙述出错时（首轮即发生），用户没有任何
权威锚点可以核对"命令到底跑在哪"，只能采信或自行排查。

## What Changes

- `forge_shell` 的**每一种返回形态**首部增加一行 `cwd: <绝对路径>`：
  - 后台句柄返回（`[forge:job] Started in background.`）
  - exited / succeeded / still-running 三种前台返回
  - spawn 失败返回（带 cwd 便于诊断"目录不存在"类错误）
- `forge_jobs` 的 poll / log 输出不变（logPath 已是权威文件锚点）。
- README 的 forge_shell 小节补一句：结果首行即实际执行目录，agent 叙述与
  其不符时以结果为准。

## Impact

- 兼容性：纯增量输出行，无行为/参数/权限变化；不改 spec 的既有场景语义。
- 范围：`plugin.ts` 的 forgeShellTool execute 各返回点（cwd 变量已在函数
  内解析完成，直接带入返回）；单测断言四种返回形态均含 cwd 行。
- 版本：0.3.2（补丁号）。

## Capabilities

- job-supervisor (MODIFIED)
