# add-dispatch-suite · 终局报告（final-report）

> G 阶段净室复验后由代理定稿；你的终局验收第一读物。
> 顶部三行是给赶时间的人看的；证据在下面各节，全部必须来自真实命令输出（带时间戳与 git hash）。

## 顶部结论

```
终态：A/B/C/D/E/F/G 七阶段门 全过（门 A–F 见 battle-log 各阶段轮报；门 G = 本报告 + §6 自审）
矩阵：35/35（S8/S18 的 E 层按战役计划可选未跑、S19 的 E 层受宿主限制——三行均以 S 层闭环 PASS）
战役：48/48（战役Ⅰ 33 + 战役Ⅱ 15；PASS 43 / FIXED 4 / LIMITATION 1 / BLOCKED 0 / OPEN 0）
tasks：23/23
git：c7aec49a0e1ad01f87c1d185d3fbb0f48211e94c（代码终态；本报告提交紧随其后）
净室复验时间：2026-09-27T02:07:04.707Z   一键验收：scripts/accept-dispatch-suite.mjs → ACCEPTANCE PASS (4/4 stages)
```

## 偏差账（spec/设计 与实现现实的出入；均按当前 spec 文本实现，裁决权在你）

| # | 出处 | 偏差内容 | 处置 |
| --- | --- | --- | --- |
| 1 | spec `dispatch.timeoutMs` 默认/上限 600000 | 活体实测 1.18.32 宿主对同步工具调用有 ~262s 硬上限（B14：261,936ms 击杀）；插件 deadline 600s 在极端首回合卡死型子会话上会被宿主先行击杀，诚实报告可能到不了父模型 | 已按 spec 逐字实现（600000 默认/上限）；**建议你裁决**：默认值降到 ≤240000 或上限收紧（S 沙盒用了 30000/60000 均工作正常） |
| 2 | tasks 6.4 `opencode plugin --global` | 安装器不读 `OPENCODE_CONFIG_DIR`，"global" 根随 `XDG_CONFIG_HOME` 走；首次尝试落到用户真实配置（已逐项完整还原，见 install-verify.md 事件记录），合规重试以 XDG 重定向在沙盒内全链路通过 | 已按 spec 命令形态验证通过；README 已记录该坑 |
| 3 | 战役Ⅱ e2e 驱动首轮 7/10 | 三处失败全为驱动自身缺陷（dispatchId 真实格式 `bg-N`；账本整文件重写+轮转使字节偏移增量失效；模型回复引用 brief 标记词造成假阳性）——非插件缺陷 | 驱动修正后 10/10（二轮），过程记录在 e2e-smoke.md |
| 4 | tasks.md 记账 | 阶段 E 提交信息声称 "tick 4.1-4.2" 但文件实际漏勾（工作本身有完整测试证据且门 E 已过） | 阶段 G 补勾至 23/23 |
| 5 | roster.ts 自动生成条目（零配置 scout/quick 自动服务） | **用户已裁决：自动选模不可行**——配置≠可用（available() 仅查在册，B27 活体实证 keyless 空响应）；静默选模违反本插件"绝不静默替换"原则；且工具无 model 参数、失败恢复弱 | 后续 change 落地（裁决细化）：出厂 = seed 层两个 readonly tier——scout（调研，low/medium）+ review（medium/high/max），占位 pin `Local/GPT Luna`（必不存在）；用户任何 dispatch 配置出现 → seed 整体让位；新增 per-tier 档位白名单 tier.depths 机械化档位意图；错误=机器可执行配方；**主流程=用户让 session AI 代配**（只读内省工具 + 启动 notice + 生效时机探针）；本 change 按冻结 spec 保留现状 |

## LIMITATION 清单（知情项，验收时逐条过目）

1. **B27 免钥端点 × 受限 tier**：keyless zen 端点对任何工具集缩减（readonly tier）返回**确定性**空响应（0 token 无 parts）。插件侧保证绝不静默成功（empty-response 诚实报错 + 账本行 + 模型如实上报）；外因不可修复。E2E 冒烟断言 1 即此坑的活体复验。
2. **S19-E 宿主优雅退出**：Windows 控制台进程无法可靠收到优雅 SIGINT，强杀场景宿主不调用 dispose → lost-on-exit 依赖宿主生命周期，非插件可解（S 层 dispose 语义完备且有测试）。
3. **job-registry 5.2 既有 flake**（非本 change 代码）：Windows 上 taskkill 异步、子进程 fd 短暂存活于 pid 死后，清理 rmSync 撞 EPERM——已根治（重试清理，20×100ms 仅 EPERM），阶段 D 轮报记档的间歇失败就此闭环。

## BLOCKED 与补救路径

无（48/48 战役 0 BLOCKED、0 OPEN）。

## 净室复验记录（一键验收脚本真实输出，2026-09-27T02:07:04.707Z）

- typecheck：`tsc --noEmit` → **0 errors**
- 全量测试：**266 pass / 0 fail**（阶段 B 末 218 → 阶段 C 227 → D 248 → E 259 → G 266）
- bundle：`bun run bundle` → dist/index.js 重建（净室 rm 后重建，自包含无 --packages external）
- 沙盒冒烟：**SMOKE-G PASS 10/10**（全新沙盒 serve，免钥模型：scout 诚实空响应 / quick 同步全字段结果 / 后台 bg-N 唤醒 brief 携完整结果 / 账本三行断言）——详见 `verify/e2e-smoke.md`
- 官方安装 + 四步卸载：git+file 形态 **注册冒烟 PASS + 卸载回干净态 PASS**（XDG 沙盒；含首次尝试越界写入的完整还原记录）——详见 `verify/install-verify.md`

## 自审清单结果（§6 五项）

1. **安全红线**：全程未写用户 opencode 配置（唯一例外 = 6.4 首次尝试的安装器越界，当场逐项还原并双存档）；端口仅用 43930-43939 且终态 netstat 复查无监听；用户 opencode 进程（41593/41595 及其余）零接触；真实密钥零回显（沙盒全程免钥端点，auth.json 未读取）。
2. **D1–D14 符合性**：D1 子会话走 input.client（engine fetcher 注入）；D2 chat.params 按 sessionID 打标幂等+冻结（S12/B20/B22/B23）；D3 tier 权限 = deny 列表 agent（S9/B24/B28）；D4 纯函数解析器+菜单错误（B06-B13）；D5 成本自算（B17/B18/B19）；D6 全量 catalog 发现（B05/B06）；D7 有界轮转账本（B30）；D8 派发无 ask 门、成本靠披露（工具描述含真实 token/cost）；D9 v1 双入口防御注册（wiring）；D10 后台 = 同管线+注册表（3.2 套件）；D11 唤醒 = idle 驱动同款手法 + B34 状态门加固（wiring 3.3/B34）；D12 kill best-effort 永远如实（B41）；D13 crew 零文件持久化、单 ask 门（4.1/4.2/B47）；D14 run 模式披露（B43）。
3. **零 TODO**：`grep TODO|FIXME|XXX|HACK` 于 src/ plugin.ts scripts/ tests/ 仅命中探针/夹具的自然语句（"check for TODOs"），无任何未完成标记。
4. **文档同步**：README dispatch/waves/crew 章节（5.2）中路径、默认值（timeoutMs 600000 / maxConcurrent 4 / 轮转上限）、卸载步骤均对照实现核准；文件账本表新增 dispatch ledger 行与 `<tmp>/opencode-forge/dispatch/ledger.jsonl` 实测一致。
5. **沙盒清理**：`C:/tmp/forge-stage-c`、`C:/tmp/forge-stage-g` 已删除；accept 脚本沙盒自清理；43930-43939 无监听。

## 战役与回归统计

- 回归测试新增（对应 4 项 FIXED）：7 条 —— B11×3（一次排除重试）、S7a/S7b（回合同步 POST 的 deadline race，B31 同此兜底）、B34×1（busy 会话不投递）。
- 全套件增量：218（阶段 B 末）→ 266（终态），+48 条（registry/engine/wiring/crew-gate 套件 + 战役Ⅱ 回归护栏 6 条：B34/B39反向/B42批量/B43披露/B47重启/B48模板）。
- 战役Ⅰ回归抽查（阶段 F 门 F）：全量套件绿即回归抽查通过；抽牙复核 5 例——B11 重试排除、S7a/S7b deadline race、B27 免钥空响应、B32 parentID 400 回退、S19 lost-on-exit——终态全量运行中全部绿。
