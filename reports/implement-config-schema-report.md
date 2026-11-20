# implement：forge-config-json-schema（apply 阶段执行报告）

- 基线：`84111e2`（HEAD at start），测试基线 **774 pass / 0 fail**（本任务开始时实测确认）。
- 并行声明：Block B 工人同期编辑 `src/dispatch-async.ts` + `plugin.ts`（工作树 M 状态全程可见）；本任务**零触碰**这两个文件。
- 参照：design.md D1-D4、tasks.md 1.1-3.4、explore 报告 `reports/explore-config-schema-report.md`（Q1 字段面 / Q2 发布通道 / Q4 $schema 容忍）。

## 文件清单（本任务产出/修改）

| 文件 | 动作 | 内容 |
| --- | --- | --- |
| `schema/forge.schema.json` | 新增（74 行） | 手写 draft-07 schema：顶层 `$schema`/`pool`/`shared`/`agents`；条目 `model`+`thoughtLevel`（开放串+examples，**无 enum**——词典非白名单）、原子对 anyOf/not、`shape` enum readonly\|write、`permission` string-record、`depths` deprecated+指路 thoughtLevel；id propertyNames `^(?:forge-)*[a-z0-9-]+$`（forge- 前缀容忍=代码自愈剥除语义）；pool `^[a-z0-9-]{1,24}$`；顶层**不设** additionalProperties:false |
| `package.json` | 修改 2 处 | bundle 尾部追加 `copyFileSync('schema/forge.schema.json','dist/forge.schema.json')`（脚本名不变——红线只管名字）；`exports` 增 `"./schema.json": "./dist/forge.schema.json"`。scripts 名单/files **零改动** |
| `README.md` | +14 行 | snippet 顶部 `$schema` 两形态（unpkg URL + node_modules 本地相对路径）+ 波浪线注意点块（.json 扩展名下编辑器自身纯 JSON 关联的注释波浪线，`files.associations` 一行双修） |
| `src/forge-config.ts` | 1 行 | shape-invalid finding 文案 `defaulting to readonly` → `defaulting to write (absent shape is write)`（对齐 dispatch-tiers.ts L106 shape-default-open 事实） |
| `tests/forge-schema-mirror.test.mjs` | 新增（6 tests） | 见下 |

## tasks 状态

- 1.1 schema ✅（commit `0c08bbf`）
- 2.1 发布通道 ✅（同 commit；npm pack 验证见下）
- 2.2 README ✅（commit `9bdd7df`）
- 3.1 文案修正 ✅（commit `18d031e`）
- 3.2 漂移镜像 ✅、3.3 $schema 容忍 ✅（commit `54156e0`）
- 3.4 验收 ✅ **全部通过**（Block B 编辑完成后终验，见下）
- tasks.md 1.1-3.3 已勾

## 测试名（tests/forge-schema-mirror.test.mjs，6/6 pass）

1. `mirror: shape enum equals the code's accepted shape set (both directions)` — 8 探针双向断言（enum 成员 ⇔ validateAgentSet 保留 shape）
2. `mirror: agent-id propertyNames pattern accepts exactly what the id rule accepts` — 10 探针（含 forge-x / forge-forge-x 前缀自愈路径）；"forge-" 单独串是 schema 过/代码拒的歧义边，测试内注释声明不探
3. `mirror: pool pattern equals validatePoolField's accept set (unpadded values)` — 10 探针 + **修剪不对称声明测试**（代码先 trim，schema 见原串——design/explore 已声明的可接受严向偏差）
4. `mirror: atomic pair constraint is expressed as both-or-neither (anyOf/not)` — schema anyOf 结构 deepEqual + 三态行为（双全 pinned/双无 Auto/恰一 agent-half-configured）
5. `finding text: shape-invalid states the WRITE default (shape-default-open)` — match `/defaulting to write/` + doesNotMatch readonly
6. `tolerance: a $schema top-level key parses clean in both consumption paths` — parseForgeJsonc+validateAgentSet 与级联 loader（fake fs）双路径零 finding

域内回归：`forge-config.test.mjs` + mirror = 38 pass / 0 fail。

## 验收（3.4）——全部通过（Block B 语法稳定后终验）

- `bun run typecheck`：**exit 0**（此前失败全部指向 Block B 编辑中途的 `src/dispatch-async.ts` L202-225 语法错误，与本任务无关——Block B 提交 f0ca2ef 后恢复）。
- 全量 `node --test tests/*.test.mjs`：**784 pass / 0 fail**（774 基线 + 本任务 6 + Block B 同期 4——零回归，以最终总数为准）。
- `bun run bundle`：产出 `dist/forge.schema.json`（Test-Path True）+ `dist/index.js`（0.84 MB）。
- `npm pack --dry-run` 尾部（tarball 4 files，含 schema）：

  ```
  npm notice 4.7kB dist/forge.schema.json
  npm notice 839.3kB dist/index.js
  npm notice 2.3kB package.json
  npm notice Tarball Details
  npm notice total files: 4
  ```

  （README.md 4.7kB 上一行截取；files 白名单零改动生效——dist 目录白名单自动携带 schema。）

## 遗留给 verify 阶段（4.1，未在本任务范围）

- dispatch-async.ts 恢复后重跑：typecheck、全量测试（774+6=780 期望，若 Block B 加测试以最终总数为准零回归）、`bun run bundle` 产出 schema、`npm pack --dry-run` 列表含 `dist/forge.schema.json`、重建 dist 入库 commit。
- `openspec validate --all`、官方安装验证、版本/publish（用户批准后）。

## Commits（4 个，conventional，未 push）

```
0c08bbf chore: hand-written forge.json JSON schema + publication channel (forge-config-json-schema 1.1/2.1)
9bdd7df docs: forge.json $schema usage snippet + .json/jsonc squiggle caveat (forge-config-json-schema 2.2)
18d031e src: shape-invalid finding states the write default — shape-default-open (forge-config-json-schema 3.1)
54156e0 tests: schema drift-mirror + $schema tolerance + finding-text lock (forge-config-json-schema 3.2/3.3)
14d9d5f chore: dist schema copy + tick forge-config-json-schema tasks 1.1-3.4 + implement report
```

（5 个；未 push、未 publish。tasks.md 勾选与 dist/forge.schema.json、本报告随 `14d9d5f` 落盘；dist/index.js 由 Block B 的 `f0ca2ef chore: rebuild dist` 重建，本任务终验 bundle 与其内容一致——工作树干净。）
