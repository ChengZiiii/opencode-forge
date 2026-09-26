# add-job-supervisor 实机验证结论（2026-09-26）

宿主：opencode 1.18.32（本机 Windows，真实 serve/run 进程，真实 provider
`glm-coding-worker/glm-5.3`）。沙箱姿势：`XDG_CONFIG_HOME` 指向配置副本、
插件以 file-spec（仓库路径）加载，用户真实配置与 npm-spec 注册未被触碰
（最终 8.2 才切 npm-spec）。复现负载 = #47350 形态：launcher 以
`stdio: inherit` + `detached` 起 holder 后退出，holder 持有管道写端 8 秒。

- **7.1 通过**：forge 会话 `--auto` 下 `forge_shell run_in_background` 启动
  launcher，`forge_jobs poll` 收割到 `exited exit=0`；持管道 grandchild 存在
  时调用正常返回、会话不卡死、无挂起残留。单测层另有真实 repro
  （tests/job-runner.test.mjs 3.1b：exit+grace ≈0.7s 完成，管道仍被持有）。
- **7.2 通过**：
  - run 模式无 `--auto`：`permission requested: forge_shell (*);
    auto-rejecting` + "The user rejected permission"——ask 姿态正确，未执行。
  - 唤醒注入：以 `opencode run --attach <serve> --auto --agent forge` 在
    serve 常驻会话后台启动 job 后客户端离场；holder 退出 → 会话 idle →
    插件经 promptAsync 注入 `[forge:job-complete] ... finished (exited,
    exit 0)`，且该消息实际再次驱动了会话（agent 对 wake 做了总结回复）。
    姿态说明：任务原文写 "TUI 主会话"；README 的口径是自主循环需要
    "TUI/serve 会话"，serve 会话与 TUI 会话共用同一套 session.idle /
    promptAsync 机制，故以 serve 会话完成验证（无 TUI 自动化依赖）。
- **7.3 通过，且无需降级**：task 子代理会话内 forge_shell/forge_jobs 直接
  可用（registry 层工具面下沉，与上游源码结论一致）；子代理完成
  `j-20260925-223112-fsu4ya: exited exit=0` 并回传主会话。**promptAsync 在
  子会话未异常**——wake 同样送达子代理会话并被其响应，故不启用
  "子会话降级为纯 poll 纪律"的备选。副作用观察：wake 会在子代理交卷后
  再驱动它一轮（确认已完成）；按 D5 这在语义内（notify:false 可关），
  不构成阻塞。

结论：D5/D6 预期全部满足；无 design 修订项。

## 8.1 / 8.2 — 发布与官方安装终验（2026-09-26）

- **8.1 通过**：版本 0.3.0（描述/关键词更新为四 harness 口径），`bun build`
  dist 0.53 MB 入库，`npm pack --dry-run` 3 文件 105.7 kB、无七个触发词脚本、
  双导出齐全；142/142 测试 + `tsc --noEmit` 干净后发布。发布凭据按 goal 要求
  经 Edge 浏览器闭环取得：npmjs.com 会话验证（sorenllm 登录态、当前线上版
  0.2.2、无版本冲突）→ granular token 页 sudo-auth（"Use security key" →
  浏览器 Microsoft 密码管理器同步 passkey `chengsongren6522@outlook.com` 一键
  通过，无需硬件密钥/密码）→ 30 天单包 `Read and write (publish and stage)`
  + bypass-2FA token → `npm publish --access public` →
  `+ @sorenllm/opencode-forge@0.3.0`。token 用后即删（npm Settings 页撤销，
  本地临时文件先清）。注：`~/.npmrc` 旧 token 已失效（401），whoami 对
  granular token 可用。
- **8.2 通过（硬性最终态达成）**：registry `@latest`→0.3.0 后执行完整闭环——
  卸载四步（config 条目手术式移除保留 JSONC 注释、删 `~/.cache/opencode/
  packages/@sorenllm/`、无 agent.forge 残留、清 `<tmp>/opencode-forge/` 运行时
  碎片）→ 无插件原生回归 `opencode run` 出 `NATIVE-OK`（build agent 复活）→
  同一 npm spec `opencode plugin @sorenllm/opencode-forge --global` 重装 →
  store `opencode-forge@latest` = **0.3.0**（dist 含两波定位代码）→ 冒烟：
  `--auto --agent forge` 下 forge_shell echo 出 `SMOKE-FORGE-SHELL-030`
  (exit 0)、后台 job `j-20260926-001948-u4wxnm` poll(running)→kill→list=
  killed。用户 `opencode.jsonc` 重装前后字节数一致（3406）、注释保留。
  **最终状态：用户环境为 npm plugin 模式（registry 名 `@sorenllm/opencode-forge`）
  且全部冒烟通过。**
