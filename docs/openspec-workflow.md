# OpenSpec 规格工作流（delta 细则）

> 由仓库根 `AGENTS.md` 路由到本文件；闭环总流程见 `../../docs/workflow-loop.md`。



所有**行为改动**走完整流程，禁止直接改代码：

```
explore → propose → 用户批准 → apply → verify → archive
```

- `openspec new change <kebab-name>`，按 CLI `instructions --json` 依次写
  proposal / specs(deltas) / design / tasks。
- delta 规则：只写变化（`## ADDED/MODIFIED/REMOVED`）；MODIFIED 必须带全量
  场景；场景 `####` + WHEN/THEN；需求 SHALL。
- 校验 `openspec validate --all`；实现与 spec 偏差时**先改 delta 再归档**。
- 归档需用户明确指示：`openspec archive <name> --yes`。
