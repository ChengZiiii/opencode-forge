# Tasks — readonly-exec-seal

- [x] 1. 新增 `src/exec-classify.ts`：纯函数分类器（读类/写类/不可分类→读类）——重定向（含 PowerShell 等价）、变异 cmdlet 表、git 变父子命令、包管理写命令、工作区显式路径写入解析（零 fs，命令串解析）
- [x] 2. `plugin.ts`：forge_shell `tool.execute.before` 挂闸——sessionID→agent 族映射查 effectiveReadonlyShape（显式 readonly），写类拒绝 + 有界 finding（点名形状/指标/shape: write 出路）；primary 永不封
- [x] 3. 测试：`exec-classify` 全指标矩阵（含不可分类→读类）；wiring 级三态（显式 readonly 拒并出 finding / write 与无 shape 放行 / primary 不封）；draft 姿态不叠加变化；finding 有界性
- [x] 4. README：封禁指标表 + 绕过面逐字披露（belt-in-depth 定位声明）；AGENTS 工具面分区段补执行通道封禁
- [x] 5. `bun run typecheck` + `node --test tests/*.test.mjs` 全绿 + `bun run bundle`；openspec validate --all 通过
