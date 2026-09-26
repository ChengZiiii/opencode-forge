# add-dispatch-suite · 边界战役目录（B01–B48，不可变目录）

> 战役Ⅰ（阶段 C）探 B01–B33（派发核心），战役Ⅱ（阶段 F）探 B34–B48（waves+crew）并复验回归。目录本身只读；结论全部记到 `battle-log.md`。
> 层：U=单元 / S=stub / E=沙盒（OPENCODE_CONFIG_DIR + serve + 免钥模型 + 驱动轮询，复用 probe 手法）/ R=真实 provider（限量、预约）/ M=人工。
> 期望以 `specs/dispatch/spec.md` 与 `specs/crew-harness/spec.md` 当前 delta 文本为准。

## A 组 · 配置与校验（多为 U 层，B 轮启动路径复验）

- **B01 死键**：roster 里的身份用户并未配置 → 按名警告，不炸启动。U。
- **B02 expose 越界值**：catalog 已知身份的 expose 写了 `"hihg"` → 启动报错并列出该身份合法梯。U。
- **B03 catalog 未知 provider**：roster 写了 catalog 没有的 provider/model → 逐字接受 + "unverified" 提示，不因拉不到梯而拒绝。U。
- **B04 死默认档**：quick tier 默认 off、无任何 quick 候选曝光 off → tier 降级 depth-required（默认移除不替换）；无深度调用 → 错误带菜单。U+S。
- **B05 自定义 tier 无 shape** → 默认 readonly（宁紧勿松）。U。
- **B06 tier id 违反 `[a-z0-9-]`** → 警告。U。
- **B07 profiles 引用不存在的 tier** → 警告。U。
- **B08 同名双身份独立性**：两个 provider 各挂 glm-5.3、expose 不同 → 互不干扰的独立候选。U。

## B 组 · 解析语义

- **B09 无人曝光请求档**：build/medium 无人曝光 medium → 结构化错误带每个候选的曝光与不可用原因，零派发。U。
- **B10 钉扎不可用**：pin 的身份当前不可用 → 点名报错 + 建议（修 pin 或解 pin），无回退。U。
- **B11 中途失败一次重试**：解析命中者派发中失败 → 排除它重解析一次，结果报告实际服务身份。U+S。
- **B12 无钳制回归**：某身份 expose={low,max}，请求 medium → 必须报错，绝不静默换 high/max。U。（防"好心钳制"复发）

## C 组 · 工具契约

- **B13 depth-required 无深度调用** → 错误带菜单（不是猜一个默认）。S。
- **B14 子会话超时**：慢任务超过 deadline → 超时报告（sessionID/elapsed/部分转录指针），会话留给宿主回收，主会话不挂死。S+E。
- **B15 并发上限**：4 在飞 + 第 5 个 → 拒绝并报当前在飞数与重试提示；4 个内正常并行。S（E 层可选：免钥开 4 慢派发）。
- **B16 一键关**：`agent["forge"].disable` → 工具不注册、tier 不物化，Tab 循环仍只有 forge。S。
- **B17 tokens 真实性**：结果 tokens 与宿主 message info 一致（input/output/reasoning/cache 五项），不许编。S+R。
- **B18 无价目**：快照里没有的身份 → costUsd null + "price unavailable"，绝不是 0。S。
- **B19 价目源失败降级**：models.dev 拉取失败（注入 fetcher 模拟断网）→ 派发照常、成本 null、启动提示降级。S。

## D 组 · 档位注入

- **B20 首回合恰好一次**：OpenAI 兼容族派发 → 该会话 options.reasoningEffort 首回合写入一次。S+E。
- **B21 未知形状披露**：map 外的 provider → 不注入 + 结果里 "depth not injected (unknown provider shape)"。S。
- **B22 会话稳定**：多回合 worker 会话，档位中途绝不重写。S+E。
- **B23 sessionID 隔离（TUI 污染回归）**：同一 serve 上普通会话与被派发会话并存 → 注入只改被派发会话的 options，普通会话分毫不动。E（chat.params 打点对比，probe P1 手法）。

## E 组 · 物化与权限

- **B24 注入形状**：forge-\<tier\> hidden、mode subagent、无 model 字段、deny 式 permission 含 task deny。S。
- **B25 不覆盖用户条目**：用户自带 agent["forge-build"] → 跳过注入，内容原样。S。
- **B26 draft 禁派**：活动 draft 期 forge_dispatch 被拒（信息指向 plan_approve/discard）；批准后放行；run 模式同样生效。S+E。
- **B27 免钥 Zen × 受限 tier（已知怪癖）**：任何工具集缩减 → 空响应（0 token 无 parts）。期望：空完成检测 → 诚实报告"空响应（免钥端点已知怪癖）"，绝不当作成功带空文本；README 记坑。E（大概率 LIMITATION）。
- **B28 真实 provider × 受限 tier**：deny 式权限真实生效（write 从模型工具集消失、文件未建、会话健康）。R（probe 已证，D 前复验一次即可）。

## F 组 · 生命周期与账本

- **B29 宿主退出**：在飞派发时杀 serve → ledger 记 lost-on-exit、无孤儿 node 进程。E。
- **B30 账本有界轮转**：超上限截断/轮转，字段齐（事件/身份/档位/outcome/tokens/成本/timeout/lost-on-exit）。S。
- **B31 子会话绝对路径写（P3-d 回归）**：诱导 worker 往"workspace root 写绝对路径文件" → per-dispatch deadline 兜住，返回超时报告而非永久挂起。E。
- **B32 parentID best-effort**：宿主不支持 parentID 时派发照常成功（不因可选字段缺失而败）。S。
- **B33 worker 提示三条款**：组装后的子提示必含 相对路径强制 / 拒绝原文上报 / 证据引用；readonly 与执行模板有可断言差异。U。

## G 组 · 后台与唤醒（战役Ⅱ）

- **B34 活跃回合竞态**：完成落在父会话活跃回合中 → brief 等下一 idle，不打断回合。E。
- **B35 合并与恰一次**：多个终态 → 单条 brief；每终态恰一次（重放/重复 idle 不重复交付）。E。
- **B36 goal 共存合并**：同 idle 上派发完成 + goal 续跑都要发 → 合并为单次再提示，不双唤醒。E。
- **B37 完成风暴防抖**：快速连串完成只出一条 brief（同 goal debounce 手法）。E。
- **B38 compaction 恢复**：压缩后 forge_dispatch_list 找回在飞与近期结果（dispatchId 齐）。E。

## H 组 · 后台并发/超时/生命周期（战役Ⅱ）

- **B39 共享槽双向**：4 个后台占满 → 第 5 个**同步**派发也被拒（同一槽池）。S+E。
- **B40 后台超时**：deadline 到 → 超时 brief（同对象形状）+ 账本 timeout，会话留给宿主。E。
- **B41 kill 全路径**：在飞 kill → 停轮询/抑制唤醒/账本 killed；无中止 API 时晚到结果丢弃并记 kill-late-completion；kill 不存在的 id → 报错。S+E。
- **B42 宿主退出批量标记**：后台多个在飞时杀 serve → 全部 lost-on-exit、无孤儿进程。E。
- **B43 run 模式后台**：run 会话结束后完成仅入账本；工具描述披露"后台面向 TUI，run 建议同步"。E+M。

## I 组 · crew 工作流（战役Ⅱ）

- **B44 crew 入口互操作**：draft 期 /crew 拒绝（指向 plan_approve/discard）；goal 活动 crew 期间 goal brief 与派发 brief 合并共存。S+E。
- **B45 子任务失败路径**：一次有界重试 → 仍败则 FAIL 进终报（两次失败报告都可见），无静默丢失。E。
- **B46 crew_close 门**：缺 verdict/证据、或账本有派发而报告无对应 → 拒关点名缺口；ask 确认后才关；按账本交叉核对不以会话记忆为准。S+E。
- **B47 crew 中途宿主重启**：状态死、账本留痕、新 /crew 干净开始（无残留 crew 态）。E。
- **B48 波次节奏**：波大小超过 cap → 自动分批随 brief 推进，绝不一次性洪水提交被槽位拒绝刷屏。E。

## 统计口径

verdict ∈ {PASS, FIXED, LIMITATION, BLOCKED}；OPEN = 尚无 verdict。出口：48/48 有 verdict 且 OPEN=0（战役Ⅰ覆盖 B01–B33，战役Ⅱ覆盖 B34–B48 + B01–B33 回归抽查）。
