# 开发循环（构建 / 测试 / 沙盒 / 日常迭代前必读）> 由仓库根 `AGENTS.md` 路由到本文件。沙箱环境纪律与宿主现实见> `../../docs/sandbox-verification.md`；本文件只留仓库特有内容。## 命令与流程

```powershell
bun run typecheck
node --import ./tests/lib/test-runtime-namespace.mjs --test tests/*.test.mjs
bun run bundle        # dist 自包含重建（严禁 --packages external）
# 常驻：bun build ./plugin.ts --outfile ./dist/index.js --target node --format esm --watch
```

- 纪律改动（/plan、/goal 模板文本）零手动：模板随 dist 打包，重启 opencode 即生效。
- 沙盒隔离测试：`OPENCODE_CONFIG_DIR=<临时目录>` 后跑 opencode，不污染真实配置。
- goal 全链 E2E：`scripts/sandbox-e2e-setup.mjs` 写沙盒配置；
  `scripts/live-loop-e2e.mjs <baseUrl> <absWorkspace>` 对 `opencode serve`
  驱动确定性闭环（手写 active goal → idle 续跑 → 权限端点过门 →
  completed）；`FORGE_GOAL_PROBE=1` 诊断日志在 OS temp。
- 排错：`opencode --print-logs`；改动不生效先清 `~/.cache/opencode/packages/`。
- **终验强制官方安装模式**（内环 file:// 不算验证）：阶梯与命令以
  `../../docs/npm-release-verification.md` 为唯一事实源——npm pack →
  publish → dist-tags 轮询 → `opencode plugin add <npm 包名>` → 开箱
  核对 → 用户重启实测，闭环才关闭。CLI 2.3.2 实测语法：子命令式
  `plugin add|remove|list`，**tgz 目标被拒**（只收 npm/git specifier），
  旧 `opencode plugin <target> --global` 语法已失效。
  文件布局变动加一轮 README 四步卸载+重装。
- 通用避坑清单：`../../docs/pitfalls.md`（打包红线、触发器
  名单、卸载四步等）。
## 工作区级文档索引- 沙箱验证（③ GATE）：`../../docs/sandbox-verification.md`- npm 终验（④ GATE）：`../../docs/npm-release-verification.md`- 运维红线：`../../docs/ops-redlines.md`