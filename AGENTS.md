# AGENTS.md — OpenCode Forge 开发规则

## 项目简介

单一通用 agent **forge** + 双正交 harness 的 opencode 插件。**plan
harness**（决策优先）：plan 落盘 `.opencode/plan/`、结构由工具校验、
draft 期写操作权限层硬禁、`plan_approve` 钉死 ask（用户
确认框即批准门）、`plan_close` 插件验证式完成门（冻结 checks 宿主
重跑，fail-closed，无模态）、`plan_tick` 打勾带时间戳审计。**goal harness**
（执行优先）：目标契约落盘 `.opencode/goal/`、idle 续跑引擎在
turn/分钟预算内自主推进、完成门由插件**在宿主机上重跑全部验证项**
（fail-closed）、无进展/传输失败/预算耗尽/草稿冲突自动暂停。三工作流
（OpenSpec / plan / goal）语义零耦合，仅安全互操作（draft 禁写优先）。

- 行为规范：`openspec/specs/`（改行为前必读）
- 用户文档：`README.md`（安装/卸载/文件账本/goal 章节）

## 动态加载纪律（防漂移、防上下文垃圾）

本文件是仓库路由层——细则按下表动态加载：进入哪个阶段才读哪个文件，
做完不恋战、不把整包文档常驻上下文：

| 你正在做 | 先读（必读，不预读其他） |
| --- | --- |
| 闭环总流程：立约定 / 开工 / 收尾 | `../AGENTS.md` + `../docs/workflow-loop.md` |
| 改 plugin.ts / 查机制 / 查架构 / v1-v2 对等 | `docs/architecture.md` |
| 构建 / 测试 / 沙盒 / 日常开发循环 | `docs/dev-loop.md` |
| 行为改动立约定（OpenSpec 四件套与 delta 规则） | `docs/openspec-workflow.md` |
| ③ 开发后沙箱验证（GATE） | `../docs/sandbox-verification.md` |
| ④ npm 发布 + 安装终验（GATE） | `../docs/npm-release-verification.md` |
| 通用避坑 / 迁移约定 | `../docs/pitfalls.md` / `../docs/v2-migration-conventions.md` |


## 打包红线（硬性）

- `scripts` 只允许 `bundle` / `test` / `typecheck`（七个 git 准备触发器
  名单外的安全名）；**严禁** `workspaces` 字段。
- dist 入库（.gitignore 不含 dist），构建自包含。
- `files` 白名单 = dist + README.md；发布前 `npm pack --dry-run`
  核对。

## 提交规范

conventional 风格：`plugin:` / `src:` / `tests:` / `docs:` / `chore:`。
