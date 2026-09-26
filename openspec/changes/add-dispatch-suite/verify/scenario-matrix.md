# add-dispatch-suite · 场景矩阵（spec 35 场景 ↔ 测试映射）

> 关卡抽查材料。每行由执行阶段填「测试落点」与「verdict」；终态必须 35/35。
> 层：U=单元（node --test 纯函数）/ S=stub 宿主（注入 fake client/hook）/ E=沙盒 E2E（serve+免钥）/ R=真实 provider / M=人工。
> 轮：A=核心纯函数 / B=核心接线 / C=战役Ⅰ / D=waves / E=crew / F=战役Ⅱ / G=终验。

## 派发核心（dispatch，S1–S20）

| # | 需求 | 场景（一句话） | 层 | 轮 | 测试落点（文件::用例） | verdict |
| --- | --- | --- | --- | --- | --- | --- |
| S1 | 完整身份键 | 同名模型挂两个 provider = 两条独立候选（独立 expose/顺序/价格） | U | A | dispatch-roster.test.mjs :: "S1: same model name on two providers stays two independent roster entries" + dispatch-resolver.test.mjs :: "S1 through the resolver…" | PASS(A) |
| S2 | 完整身份键 | 未列入 roster 的已配置身份生成默认条目（默认 tier+全原生梯） | U | A | dispatch-roster.test.mjs :: "S2: an unlisted configured identity is appended as a generated default entry" + "zero config: every configured identity gets a default entry" | PASS(A) |
| S3 | 精确匹配 | 请求档位无人曝光 → 结构化错误带全菜单，零派发 | U | A | dispatch-resolver.test.mjs :: "S3: requested depth nobody exposes…" + "B12 regression: no clamping…" | PASS(A) |
| S4 | 精确匹配 | 钉扎模型不可用 → 点名报错，绝不回退他人 | U | A | dispatch-resolver.test.mjs :: "S4: pinned tier with unavailable model errors naming the pin…" (+pin resolves/mismatch 两用例) | PASS(A) |
| S5 | 精确匹配 | 中途失败 → 排除该身份重试一次，报告实际服务者 | U+S | A+B | U: dispatch-resolver.test.mjs :: "S5: exclude drops a failed identity…"；S 层待 B | PASS(A/S待B) |
| S6 | 工具契约 | 成功派发诚实报告 actual（model/depth/tokens/cost/text） | S+E | B+C | | |
| S7 | 工具契约 | 超时 → 超时报告（sessionID/elapsed/部分转录指针），会话留给宿主 | S+E | B+C | U 层：dispatch-client.test.mjs :: completion 稳定判定（deadline 由 B 层接线驱动，B/C 补） | U PASS |
| S8 | 工具契约 | 第 5 个并发被拒 + 在飞数 + 重试提示 | S+E | B+C | | |
| S9 | tier 物化 | forge-\<tier\>：hidden、mode subagent、无 model 字段、task deny | S | B | | |
| S10 | tier 物化 | 用户自定义 forge-\<tier\> 条目不被覆盖 | S | B | | |
| S11 | tier 物化 | agent forge disable 一键关：无 tier、无工具 | S | B | | |
| S12 | 档位注入 | OpenAI 兼容族 → options.reasoningEffort 首回合恰好一次 | S+E | B+C | | |
| S13 | 档位注入 | 未知 provider 形状 → 不注入 + 结果披露 | S | B | | |
| S14 | 成本报告 | tokens 取宿主 info、成本快照自算带标签 | S+R | B+G | U: dispatch-client.test.mjs :: sumTokens/computeCost 计价（reasoning 计 output）；接线待 B/G | U PASS |
| S15 | 成本报告 | 无价目身份 → costUsd null + 说明，绝不 0 | S | B | U: dispatch-client.test.mjs :: "S15: unpriced identity…" + cache 缺价两用例 | U PASS |
| S16 | 启动校验 | 死 defaultDepth（quick→off 无人曝光 off）→ tier 降级 depth-required | U | A | dispatch-roster.test.mjs :: "S16: dead defaultDepth degrades…" + "S16 positive: quick keeps its default…" | PASS(A) |
| S17 | 启动校验 | expose 拼错（catalog 已知身份）→ 快错列出合法梯 | U | A | dispatch-roster.test.mjs :: "S17: expose typo on a catalog-known identity errors fast…" | PASS(A) |
| S18 | draft 互操作 | draft 活动期派发被拒 → 指向 plan_approve/discard | S+E | B+C | | |
| S19 | 账本 | 宿主退出在飞派发 → lost-on-exit 记录、无孤儿进程 | E | C | | |
| S20 | worker 纪律 | 组装提示含三条款；readonly 与执行形状有差异 | U | B | | |

## waves（dispatch，S21–S28）

| # | 需求 | 场景（一句话） | 层 | 轮 | 测试落点 | verdict |
| --- | --- | --- | --- | --- | --- | --- |
| S21 | 后台模式 | background:true 急解析（错误同步返回零派发）+ 立即返回 dispatchId 句柄 | S+E | D+F | | |
| S22 | 后台模式 | 共享并发槽：4 在飞（同步/后台混合）→ 第 5 个被拒带在飞数 | S+E | D+F | | |
| S23 | 完成唤醒 | 多终态合并为一条 [forge:dispatch-complete] brief（每终态恰一次） | E | F | | |
| S24 | 完成唤醒 | 活跃回合期间完成 → 等下一 idle，不打断当前回合 | E | F | | |
| S25 | 完成唤醒 | compaction 后 forge_dispatch_list 恢复在飞与近期结果 | S+E | D+F | | |
| S26 | kill/run/退出 | kill：停轮询、抑制唤醒、账本 killed（或 kill-failed 原因） | S+E | D+F | | |
| S27 | kill/run/退出 | run 模式会话结束后完成仅入账本；工具描述披露建议同步 | S+M | D+验收 | | |
| S28 | kill/run/退出 | 宿主退出时后台在飞批量 lost-on-exit | E | F | | |

## crew（crew-harness，S29–S35）

| # | 需求 | 场景（一句话） | 层 | 轮 | 测试落点 | verdict |
| --- | --- | --- | --- | --- | --- | --- |
| S29 | /crew 纪律 | 分解为波次、按完成 brief 节奏推进（不洪水过 cap） | E | F | | |
| S30 | /crew 纪律 | draft 活动期 /crew 被拒 → 指向 plan_approve/discard | S+E | E+F | | |
| S31 | /crew 纪律 | 每会话单 crew：已有活动 crew 再 /crew 被拒 | S | E | | |
| S32 | /crew 纪律 | 宿主重启 → crew 状态死、账本留痕、新 /crew 干净开始 | E | F | | |
| S33 | crew_close 门 | 全证据 + 账本交叉核对通过 + ask 确认 → 摘要入账本、crew 结束 | S+E | F | | |
| S34 | crew_close 门 | 缺 verdict/证据、或账本有而报告无 → 拒关点名缺口 | S | E | | |
| S35 | crew_close 门 | 失败两次 → 报告标 FAIL 可见，允许带 FAIL 关闭（不静默丢） | S+E | F | | |

## 进度小结（每阶段自动门通过后由代理更新）

- 阶段 A（目标：S1–S5、S16、S17 共 8 行有映射）：
- 阶段 B（目标：S5/S6–S15/S18/S20 的 S 层行填完）：
- 阶段 C（目标：S6/S7/S8/S12/S18/S19 的 E 层行闭环）：
- 阶段 D（目标：S21–S28 的 S 层行填完）：
- 阶段 E（目标：S30/S31/S34 的 S 层行填完）：
- 阶段 F（目标：S21–S28、S29–S35 的 E 层行闭环）：
- 阶段 G（目标：S14 的 R 层闭环；终态 35/35）：
