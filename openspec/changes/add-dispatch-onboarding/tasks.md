# add-dispatch-onboarding · Tasks

> TDD：每任务红→绿；提交对 `test(dispatch-onboarding): N red` → `feat(dispatch-onboarding): N`；全量绿 + typecheck 才可勾。

## 1. 配置加载层（forge-config）

- [x] 1.1 `src/forge-config.ts`：JSONC strip 注释解析（字符串状态机，字符串内 `//` `/* */` 不误伤）+ 类型 `ForgeConfig {agents: Record<string, {model, depths, prompt?, shape?, permission?}>}`。验证：单测覆盖注释/尾逗号容忍/字符串含注释符/坏 JSON 报错定位
- [x] 1.2 三级回退与单一来源：project `.opencode/forge.json` > global `~/.config/opencode/forge.json` > seed 常量（research/review 钉 `Local/GPT Luna`）。验证：单测三级各取胜出、不合并、双文件并存时项目全量生效
- [x] 1.3 热生效：mtime+size 缓存，`loadForgeConfig()` 变更才重读；解析失败回退 seed 并产出 `config-parse-error` finding（路径+定位）。验证：单测改文件后重读、未改走缓存、坏文件回退+finding
- [x] 1.4 seed 常量 + 未配置启动 notice（findings 一条，指向配方）。验证：wiring 单测未配置态 config hook 后 findings 含 notice

## 2. 解析与错误语义

- [x] 2.1 agents 解析路径：`resolveAgent(cfg, {agent, depth})` —— depth 缺省取 depths[0]；集合成员判定；`unknown-agent`/`depth-not-in-set`/`pin-unavailable`（含占位）错误码与文本。验证：单测五错误场景 + 缺省取首元素
- [x] 2.2 配方（recipe）生成纯函数：检测身份字符串清单（宿主 configuredIdentities，无梯子）+ 双路径 + 模板块（带行内注释）+ 验证派发 + 扩展提示。验证：单测断言配方四块齐备、身份清单来自注入的检测函数
- [x] 2.3 移除 roster 自动生成段 + legacy 保留：未列身份不再生成条目；inline roster/tiers 解析路径回归全绿。验证：roster 套件删自动生成用例、legacy 用例（S 层既有测试改造）通过

## 3. 元语翻译层

- [x] 3.1 翻译核心纯函数：`translateDepth(depth, nativeLadder)` —— 逐字优先（depth∈ladder → verbatim）；原生词直传；元语家族映射表数据；无对应物 → `no-native-mapping`（列双方）。验证：单测直合/翻译/逃生舱/无映射四类
- [x] 3.2 注入层接线：chat.params 家族分支按翻译结果注入（effort/budget 表/toggle）；`depthTranslation` 披露字段（`canonical low → native XHigh` / `verbatim`）。验证：wiring 单测注入值+报告披露行
- [x] 3.3 未知家族维持 "not injected (unknown provider shape)" 披露（B21 语义回归）。验证：既有 wiring 测试改造后通过

## 4. 物化与工具契约

- [ ] 4.1 agent 物化：forge-<agent> 隐藏 subagent，prompt（显式/角色默认 research/review/通用兜底）、shape→deny 列表、permission 覆盖、`task: deny` 恒强制、create-only、无 model 字段。验证：wiring 单测四提示词来源 + 权限形状 + no-clobber
- [ ] 4.2 forge_dispatch 参数 `profile` → `agent`：args/描述/错误码包装；结果对象 `{agent, requested, actual, depthTranslation, …}`；背景句柄 `{dispatchId, agent, …}`；wake brief 文案 tier→agent。验证：wiring 全套改造回归 + 引擎测试参数同步
- [ ] 4.3 `forge_dispatch_config` 工具：`{agents, knobs, findings}` round-trip；无发现类字段。验证：wiring 单测已配置/未配置（seed）两态形状
- [ ] 4.4 worker 提示组装：外层三铁律恒包裹 + 内层角色提示词（prompt 键 → 角色默认 → 通用兜底）。验证：单测三层来源 + 纪律条款不可剥离

## 5. 集成与交付

- [ ] 5.1 README dispatch 章节重写（forge.json 优先/模板/元语表与 budget 表/配方截图式示例/legacy 高级节/热生效与物化滞后边界）+ 文件账本表加 forge.json（用户数据，只读）。验证：人工核对路径/默认值/表值与实现一致
- [ ] 5.2 全量绿 + typecheck + bundle。验证：`npm test` 0 fail、`npm run typecheck` 0 errors、`npm run bundle`
- [ ] 5.3 沙盒 E2E 冒烟（沙盒红线：专用 OPENCODE_CONFIG_DIR + 43930-43939 + 清理）：seed 首派报错含配方 → AI 代配写 forge.json → 下一派发热生效（探针记录宿主对未物化新 agent 名的接受/拒绝行为并存档） → 报告含 canonical→native 披露 → 项目级文件覆盖全局 → legacy inline 配置仍可派发。输出存档 `verify/`。验证：驱动脚本断言全 PASS
