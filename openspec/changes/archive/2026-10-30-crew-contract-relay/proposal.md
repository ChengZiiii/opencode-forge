# Proposal: crew-contract-relay

## Why

crew 的 lineage 只是记录在 crew record 头部的一行字——**没有任何机制把它送进派发 prompt**。Unity 侧实证：派 179 次的工人从未见过 spec/artifact 原文，全靠编排会话转述（转述即失真）。工具描述里写了 lineage 字段，但 dispatch prompt 纪律没有要求携带。

## What Changes

- /crew 模板纪律硬性要求：**宏契约来自磁盘工件时（lineage 指名 plan 工件 / spec change 目录 / goal 契约），每个子任务的派发 prompt 必须显式携带该工件路径或其确切切片**——让工人自己读契约原文；close 报告的每条 evidence 必须点名所依契约（或切片）。
- `crew_begin` 注册输出在 lineage 存在时提示此中继规则（提醒编排 AI）。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `crew-harness`：MODIFIED「/crew command discipline」（契约中继条款 + roster 会话域化——后者与 sole-pool-ownership 是同一超集文本，两 change 逐字同份，归档顺序无关收敛）

## Impact

- 代码：`plugin.ts` /crew 模板纪律文本 + crew_begin 输出提示行（纯文案，无新闸）。
- 测试：`forge-subagents-wiring` 模板断言（lineage→relay 句存在）+ crew_begin 输出断言。
- 定位诚实：这是**模板硬纪律**（纪律文本写死 SHALL），不是机械强制（机械化的选项——crew_close 校验 evidence 点名契约——记入设计文档备选，本期不做）。
- 发布并入 0.17.0（四 change 合并落地，统一终验官方安装链）。
