# Tasks — shape-default-open

- [x] 1. `src/dispatch-tiers.ts`：物化默认翻转（absent shape → 开放写权限，readonly 显式才封 MUTATING_TOOLS 族）；`effectiveReadonlyShape` 判定基准同步改为 `shape === "readonly"`（显式）
- [x] 2. `plugin.ts`：/crew 未配置门模板示例给每个 agent 加 shape 字段；字段披露文案（absent 默认 write，readonly 显式封禁）；AI 代写规则加"每个 agent 必须带显式 shape（readonly 给只读角色 / write 给实现与构建驱动角色）"；缺角色指引同步
- [x] 3. 测试：物化默认矩阵翻转断言；draft 侦察闸三态（显式 readonly scout 豁免 / 无 shape scout 不豁免 / write 拒且文案不变）；/crew 模板 shape 断言
- [x] 4. 两未归档 change（allow-readonly-recon-during-plan-draft、catalog-driven-depth-shapes）delta 中 "shape defaults to readonly" 类措辞 pre-archive 纠偏为显式 readonly 语义
- [x] 5. README（权限段默认语义翻转 + 教学面强制）与 AGENTS（§2 豁免基准）更新
- [x] 6. `bun run typecheck` + `node --test tests/*.test.mjs` 全绿 + `bun run bundle`；openspec validate --all 通过
