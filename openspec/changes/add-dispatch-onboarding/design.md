# add-dispatch-onboarding · Design

## Context

add-dispatch-suite 交付的派发栈（引擎/唤醒/账本/crew）不动；本 change 只重做**配置面与解析入口**。当前入口：inline plugin 元组 options（roster/tiers）+ 零配置自动生成条目 + 启动校验清单。owner 七轮裁决（见 add-dispatch-suite final-report 偏差账 #5–#7）定稿为：独立 forge.json + agents 极简形态 + 深度元语 + 报错即配方 + AI 代配主流程。

## Goals / Non-Goals

**Goals**
- 配置面：一个文件、一种形状（`agents: {id: {model, depths, prompt?, shape?, permission?}}`）、一套词汇（五档元语）
- 未配置态自解释（占位 seed → 报错即配方），AI 代配一次成功（round-trip 内省 + 热生效）
- 配置期零校验；唯一门 = depth ∈ set；provider 是档位最终裁判，错误原文回流
- legacy inline roster/tiers 不破坏现有已配置用户

**Non-Goals**
- 不动引擎管线/唤醒/kill/list/账本/crew 语义（只改文案中 tier→agent 措辞与结果对象字段名）
- 不做 forge.json 的 $schema 发布（可选后续）
- 不做配置文件迁移工具（插件永不写用户文件）
- 不做"池子"多模型自动选择（owner 已否决；legacy 路径除外）

## Decisions

### D1 配置载体 = 独立 forge.json（JSONC），三级回退单一来源
项目 `<project>/.opencode/forge.json` > 全局 `~/.config/opencode/forge.json` > seed。胜出者全量生效，**不合并**（避免半配置杂交态——上轮裁决的防陷阱规则）。
- 备选 inline 元组：被否——JSON 无注释、嵌套深（AI 改配最高危位置）、提示词长字符串不可读、无法项目级共享
- 备选自动生成模板文件：被否——插件永不写用户文件（红线）；配方在报错里，AI 代配 = 用户的会话 agent 写文件
- JSONC 解析：strip 注释后 JSON.parse（复用既有 strip-only 风格实现，禁 eval 类解析）

### D2 热生效 = 派发前 mtime 缓存重读
`stat` mtime+size 缓存，变了才重读重解析。旋钮（timeoutMs/maxConcurrent/disable）留 inline（宿主级，走 config hook 生命周期）。
- 备选监听文件变更：被否——宿主内插件无 watcher 生命周期保障；派发频率下 stat 缓存开销可忽略
- 权衡：物化 agent（forge-<agent>）随 config hook 注入，热改文件后**新 agent 的物化**要等下一次 config hook（宿主重载）——但派发时 body 里带 agent 名，物化滞后不阻塞派发正确性；README 记此边界

### D3 解析 = 纯钉扎，无备选
agents 路径模型由定义钉死；`available()` 检查 = 身份在宿主配置里；不可用 → `pin-unavailable` + 配方。B11 一次排除重试在 agents 路径**不适用**（无备选候选），legacy 路径保留。
- 理由：owner 裁决"自动选模不可行"——钉扎拿确定性换容错；坏模型诚实报错，用户换

### D4 元语翻译 = 三硬规则 + 家族表
`none/low/medium/high/max` 五档。逐字优先（元语=原生档名 → 原样传，覆盖 GLM/OpenAI 主流直合情形）；家族表只做精确概念映射：budget 家族 `low/medium/high/max → 8k/16k/32k/模型上限`（表值公开写死在 README）、`none → thinking off`；toggle 家族 on/off。无对应物 → `no-native-mapping` 报错列双方词汇，绝不插值。报告 `depthTranslation` 行披露 `canonical → native`；直合时标 "verbatim"。
- 备选每模型映射表：被否——维护地狱且 models.dev 结构化 reasoning_options 已给原生梯，逐字优先已覆盖大头
- 原生词逃生舱：depths 里写原生词（如 XHigh）→ 不在元语集 → 跳过翻译逐字传（只在注入层区分，解析层一视同仁做集合判定）

### D5 seed 与配方
内置 `research {model: "Local/GPT Luna", depths: [low, medium]}` + `review {…, [medium, high, max]}`。占位身份必不在宿主配置 → 未配置态任何派发撞 `pin-unavailable`。配方四块：检测身份**字符串清单**（无梯子——元语使梯子知识不再必要）、文件路径两处、可抄模板块（带行内注释）、验证派发 + 扩展提示。启动 findings 一条 notice。
- `Local/GPT Luna` 字面量：任何真实环境都不会撞名（虚构 provider "Local"）

### D6 物化 = 现有 tier 物化机制换数据源
`forge-<agent>` 隐藏 subagent、create-only、无 model 字段、deny 式 permission（shape 生成 + permission 覆盖 + `task: deny` 恒强制）——全部沿用 add-dispatch-suite D3 机制，仅数据源从 DEFAULT_TIERS 换成 forge.json agents。角色默认提示词：research/review 沿用现 scout/review 文案改写；自建 agent 无 prompt → 通用 worker 提示词。外层三铁律纪律模板恒包裹（dispatch-prompt.ts 不动逻辑，tier 参数改名）。

### D7 内省 = 纯 round-trip
`forge_dispatch_config` 返回 `{agents, knobs, findings}`，agents 与胜出文件逐键同形（可写回）。**禁止**发明发现类字段（vocabulary 常量/detected/在飞——上轮裁决明确清除暗层；在飞归 forge_dispatch_list）。

### D8 兼容与删除
- 删：roster.ts 自动生成条目段（217–226）、启动校验清单中的档位警察（expose 梯校验/defaultDepth 降级/profiles 引用检查）；dead-key 警告仅保留给 legacy 路径
- 留：inline roster/tiers 完整解析路径（legacy，README 高级节）；forge_dispatch 参数 `profile` → `agent` **breaking**（同工具不支持双参数——主路径唯一原则；legacy 用户改用一个词）
- 结果对象字段 `tier` → `agent`（wake brief 文案同步）；账本行 `tier` 字段保持（历史行兼容，新行加 `agent` 字段）——权衡：账本是 append-only 证据，改字段名破坏旧行可读性，**保留 tier 字段名不变、值写 agent id**

### D9 错误语义总表
| 场景 | 错误码 | 内容 |
| --- | --- | --- |
| 深度不在集合 | `depth-not-in-set` | 列 agent 允许集 |
| 元语无对应物 | `no-native-mapping` | 列模型原生梯 + 该模型可用元语 |
| 钉扎不可用（含占位） | `pin-unavailable` | 点名模型 + 完整配方 |
| 文件解析失败 | `config-parse-error` | 路径 + 语法错误位置；回退 seed 并落账本 |
| 未知 agent | `unknown-agent` | 列已定义 agent 名 |

## Risks / Trade-offs

- [JSONC 解析器自写 strip 注释有边角（字符串内 //）] → 用行级扫描 + 字符串状态机；解析失败 `config-parse-error` 回退 seed，绝不半生效
- [Windows 路径/大小写：全局目录定位] → `os.homedir()` + 显式 `.config/opencode/forge.json` 拼接；E 层冒烟覆盖
- [物化滞后（D2 权衡）：热加 agent 后 forge-<id> 未注入，宿主建会话时 agent 名不存在] → 派发 body 的 agent 字段若宿主校验失败会 400 → 现有 parentID best-effort 重试链路已有 400 兜底模式；实测若宿主拒绝未知 agent，文档明示"新 agent 首次派发可能需重载"（探针任务在 tasks）
- [钉扎无容错：单模型坏 = 该 agent 不可用] → 诚实报错 + 配方；owner 已裁决接受
- [元语家族表过时（新家族形状出现）] → 未知家族走"not injected"披露（现有 B21 语义）；表是纯数据可热修

## Migration Plan

1. 实现 + 全量测试绿 → bundle
2. 沙盒 E2E：seed 报错配方 → 写 forge.json → 热生效派发（canonical→native 披露）→ 项目级覆盖全局 → legacy inline 配置仍可派发
3. 回滚 = git revert（无数据迁移；用户 forge.json 是自有文件不受影响）

## Open Questions

（无——七轮裁决已定全部关键分叉）
