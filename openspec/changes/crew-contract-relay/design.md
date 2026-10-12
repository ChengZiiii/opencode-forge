# Design — crew-contract-relay

## 决策

1. **模板硬纪律而非机械强制**：纪律文本写死 SHALL（每个派发 prompt 必带契约路径或切片；close evidence 必点名契约），crew_begin 注册输出在 lineage 存在时加一行提醒。执行者是编排会话的模型——纪律是 hermes 式"进入轮即规则书"，这正是本插件 crew 纪律的既有载体，不新增闸门。
2. **机械化备选（本期不做，记录在案）**：crew_close 门校验"evidence 是否点名 lineage 契约"——技术上一行正则，但会把"诚实描述证据"变成"格式填空"（模型会为了过门而凑路径字符串，不等于真读了契约）。若模板纪律在实战中仍失守，再上机械版。
3. **切片语义**：工件很大时允许传"确切切片"（如 spec change 的某个 delta 文件路径、goal 契约的 criteria 段引文）——防止"路径太长就干脆不传"的偷懒路径。
4. **与 sole-pool-ownership 的叠加**：同一 requirement，两 change 携带逐字相同超集文本，归档顺序无关收敛（openspec 归档是文本替换，相同文本幂等）。

## 影响面

- `plugin.ts`：/crew 模板纪律段两句 + crew_begin 注册输出 lineage 提醒行。
- 测试：`forge-subagents-wiring` 模板断言（relay 句、lineage 提醒）；无新运行时闸。
