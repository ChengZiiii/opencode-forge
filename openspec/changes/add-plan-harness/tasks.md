## 1. 仓库脚手架

- [x] 1.1 建 package.json（脚本仅 bundle/test/typecheck、双 exports、engines.opencode ^1.18.0、files 白名单）、tsconfig、.gitignore（不含 dist），验证：`npm pack --dry-run` 白名单只含 dist/SKILL.md/README.md，manifest 无七个触发项
- [x] 1.2 建 plugin.ts 双入口骨架（`export default { id: "forge", server, setup }`，两入口先空壳）与 src/ 目录，验证：`bun run typecheck` 通过

## 2. plan 文件纯函数核心

- [x] 2.1 实现 src/plan-file.ts：frontmatter 解析/渲染、slug 与文件名生成（含同日后缀）、章节结构校验、任务行解析与打勾变换（时间戳注释）、状态迁移（draft→approved→done / →abandoned），验证：tests/plan-file.test.mjs 覆盖落盘布局、缺章节拒绝、tick 成功/编号不存在/重复勾、状态机非法迁移拒绝
- [x] 2.2 实现 active plan 发现函数（扫 `.opencode/plan/` 非终态、按 updated 排序），验证：单测含多文件混合状态排序与空目录用例
- [x] 2.3 `node --test tests/*.test.mjs` 全绿、`bun run typecheck` 通过（src 无 @opencode-ai 依赖，grep 确认）

## 3. v1 hooks（server）

- [x] 3.1 config hook：注册 forge primary agent（prompt/description/全工具）、原生 build/plan 置 disable、包目录 push 进 skills.paths；`agent["forge"].disable` 用户旋钮生效时全部注入跳过，验证：沙盒（OPENCODE_CONFIG_DIR 临时目录）下 `opencode agent list` 出现 forge、无 build/plan；设旋钮后反转；退出后确认临时配置目录无插件写入
- [x] 3.2 tool hook 注册 plan_write/plan_tick/plan_approve/plan_close，参数 schema 完整（close 必带逐条验收自检数组），内部调 src/plan-file 纯函数并维护 `Map<sessionID, planPath>`，验证：沙盒冒烟各工具成功/失败路径各一例（报错信息含指引）
- [x] 3.3 permission.ask：draft 期对 edit/write/bash 类 deny（工具名按优先级链取，缺失字段保守放行）；plan_approve/plan_close 任何 allow 改写为 ask、显式 deny 保持，验证：单测纯函数决策表 + 沙盒实测 draft 期 write 被拒、批准后放行
- [x] 3.4 command hook 注册 /plan <目标>、/plan resume、/plan discard 与无参列表（模板含 `!`ls`` 注入），event.session.start 输出非终态 plan 提示，验证：沙盒实测四条命令与带半程 plan 的新会话提示

## 4. SKILL.md（bundled）

- [x] 4.1 写规划纪律 skill：只读侦察→澄清→plan_write→呈批停等、完成即 tick、resume 规则、OpenSpec 分层边界（跨会话/多轮评审→建议 spec 流程），frontmatter 触发条件与 /plan 命令协同，验证：沙盒内 skill 从包目录被发现且配置目录无镜像副本；/plan 冒烟走完 draft→approve→tick→close 全链

## 5. v2 setup（前向兼容）

- [x] 5.1 setup 防御式注册 forge agent（system 字段、mode subagent 视域而定、只创建不覆盖）与 skill，全程 `?.` 守卫，验证：构造 draft 已存在场景不覆盖；宿主形状 stub 为空时静默跳过不抛错（单测）

## 6. 构建与验证梯度

- [x] 6.1 `bun run bundle` 产出自包含 dist（无 --packages external）并提交，验证：dist/index.js 存在且 grep 无 external 残留、`npm pack --dry-run` 含 dist
- [x] 6.2 中环验证：`git add -A && git commit` 后 `opencode plugin "git+file:///<仓库绝对路径>" --global` 安装，agent list + /plan 冒烟通过，随后四步卸载还原
- [x] 6.3 终验（合并前门槛）：push 后 `opencode plugin github:<owner>/opencode-forge --global` 安装 → 注册验证 → 全链冒烟（draft 禁写、批准门、tick、完成门、discard、session 提示）→ 四步卸载 + 重装确认环境还原

## 7. 文档

- [x] 7.1 README：安装三模式、四步卸载（含 agent 配置块、store 目录）、文件账本（包外仅 `.opencode/plan/`，用户数据卸载不删）、与 experimental plan mode 互斥说明、禁写高于 allow 的设计立场，验证：按 README 在干净沙盒从零走通安装与卸载
- [x] 7.2 AGENTS.md：照 vision-bridge 体例（架构表、v1/v2 分工、开发循环、openspec 工作流、提交规范），验证：新人按文档可在 15 分钟内完成改码→重建→沙盒冒烟循环
