# Tasks — crew-contract-relay

- [x] 1. `plugin.ts` /crew 模板纪律：契约中继硬性条款（lineage 指名工件时，每个派发 prompt 必带工件路径或确切切片；close 报告每条 evidence 点名所依契约/切片）
- [x] 2. `plugin.ts` crew_begin 注册输出：lineage 存在时输出中继规则提醒行
- [x] 3. 测试：`forge-subagents-wiring` /crew 模板断言（relay 句存在）+ crew_begin 输出 lineage 提醒断言
- [x] 4. `bun run typecheck` + `node --test tests/*.test.mjs` 全绿 + `bun run bundle`；openspec validate --all 通过
- [x] 5. 四 change（shape-default-open / readonly-exec-seal / sole-pool-ownership / 本 change）合并落地后统一发布 0.17.0：npm pack tgz 预检 + 官方安装链终验（tgz 全局安装 → npm publish → 注册表核对+包体锚点扫描 → npm: 源现场拉取实证）；证据 verify/release-0-17-0.md
