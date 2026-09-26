# Tasks — disclose-exec-cwd

## 1. 实现

- [ ] 1.1 `plugin.ts` forgeShellTool：四种返回形态（后台句柄 / exited / succeeded / still-running）与 spawn 失败返回首部拼 `cwd: <绝对路径>`（`cwd` 变量已在函数内）；验证：接线单测断言每种形态含 cwd 行且路径为解析后的绝对路径（含 workdir 相对→绝对解析）
- [ ] 1.2 README forge_shell 小节补口径：结果首行即实际执行目录，agent 叙述与其不符时以结果为准；验证：避坑口径核对

## 2. 回归与发布

- [ ] 2.1 全量回归：`node --test --test-timeout=20000 tests/*.test.mjs` + `tsc --noEmit` + bundle（既有测试无回归）；验证：全绿输出
- [ ] 2.2 实机复验：Temp 目录自然提示词"起个静态服务器 serve 当前目录"，结果首行 cwd=Temp 且 agent 叙述与锚点一致；验证：脚本化记录
- [ ] 2.3 发布车 0.3.2：pack 检查 → npm 发布（token 口径沿用 granular automation token，临时文件用后即删）→ npm 模式终验 + 归档；验证：registry 0.3.2 + 缓存拉取 + 冒烟
