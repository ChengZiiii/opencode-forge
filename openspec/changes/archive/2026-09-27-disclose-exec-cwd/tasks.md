# Tasks — disclose-exec-cwd

## 1. 实现

- [x] 1.1 `plugin.ts` forgeShellTool：四种返回形态（后台句柄 / exited / succeeded / still-running）与 spawn 失败返回首部拼 `cwd: <绝对路径>`（`cwd` 变量已在函数内）；验证：接线单测断言每种形态含 cwd 行且路径为解析后的绝对路径（含 workdir 相对→绝对解析）→ `tests/exec-cwd.test.mjs`（独立进程避免与 job-wiring 共享 server 模块状态），五形态断言全过
- [x] 1.2 README forge_shell 小节补口径：结果首行即实际执行目录，agent 叙述与其不符时以结果为准；验证：README 小节实际包含该表述

## 2. 回归与发布

- [x] 2.1 全量回归：`node --test --test-timeout=20000 tests/*.test.mjs` + `tsc --noEmit` + bundle（既有测试无回归）；验证：全绿输出 → 串行 14 文件 164/164 pass，TSC-OK，bundle index.js 0.56 MB
- [x] 2.2 实机复验：Temp 目录自然提示词"起个静态服务器 serve 当前目录"；验收只断言结果首行 cwd=Temp（叙述一致性作为观察项记录，不作验收条件——模型叙述可能出错，锚点即为此存在）；验证：脚本化记录 → 本地构建（0.3.2 未发布，npm 缓存为 0.3.1）+ 临时 OPENCODE_CONFIG 走 `opencode run --auto`；会话 part 表中 forge_shell 后台句柄输出第二行实测 `cwd: C:\Users\Soren\Desktop\Temp`（验收 PASS）；观察项：模型叙述"服务目录 C:\Users\Soren\Desktop\Temp（当前目录）"与锚点一致；附带确认 opencode 退出后默认 host-exit 清理已杀掉 python 服务器（端口探测 000）；残留清理完成（marker/out.log/临时配置已删）
- [x] 2.3 发布车 0.3.2：pack 检查 → npm 发布（token 口径沿用 granular automation token，临时文件用后即删）→ npm 模式终验 + 归档；验证：registry 0.3.2 + 缓存拉取 + 冒烟 → registry version=0.3.2 dist.shasum=26b7e28c…（与发布一致）；注意缓存有两个形态（`opencode-forge` 与 `opencode-forge@latest` shim，shim 的 dependencies 才是锁版本处），两者都清后重拉 shim+嵌套 package.json 均 0.3.2；npm 模式冒烟（用户真实配置、Temp、后台服务器自然提示词）会话 part 表 forge_shell 后台句柄第二行实测 `cwd: C:\Users\Soren\Desktop\Temp` PASS，CLI 退出后默认清理已杀服务器（端口 000）；归档完成
