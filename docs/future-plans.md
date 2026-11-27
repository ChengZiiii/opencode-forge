# Forge 未来计划

这里记录用户希望保留、但尚未批准实施的方向。不是已实现功能，也不是当前任务的隐含范围。

## 浏览器 WebUI 子代理设置页

- **记录日期**：2026-11-28。
- **状态**：未来计划；尚未立实施约定、未开发，暂无交付日期。
- **用户意图**：在浏览器中管理 Forge 子代理配置，缓解 TUI 窄窗口的排版和交互限制；网页与 TUI 共用后端，并能双向核对配置读写和同步结果。
- **实际使用环境**：用户通过 OpenCode TUI 的 `pair` 连接官方浏览器 WebUI，没有安装 OpenCode Desktop。Desktop-only 设置页不能替代这个需求。
- **优先方向**：在官方 pair WebUI 中提供原生设置入口；复用现有 Forge server Plugin RPC、配置来源、草稿校验和保存／同步协议，不另造配置后端。
- **调查基线**：官方 OpenCode v2.4.2 的 pair 网页由 CLI 服务提供，第三方 `gui-experimental` 加载依赖 Desktop bridge；该版浏览器前端缺少对应加载入口。此结论仅针对已核实版本，后续必须重查，不能长期当作宿主限制。
- **上游跟踪**：[issue #60976](https://github.com/anomalyco/opencode/issues/60976)、[PR #62608](https://github.com/anomalyco/opencode/pull/62608)。2026-11-28 查询时 PR 为开放 Draft、未合并；链接不代表已发布支持。
- **可参考实现**：[opencode-quota](https://github.com/slkiser/opencode-quota) 的设置页、[opencode-super-sessions](https://github.com/arthurfiorette/opencode-super-sessions) 的 GUI 扩展结构。调查时二者均不是 pair 网页内设置页的已发布先例。
- **备选建议，未获实施批准**：若宿主仍不支持加载，考虑独立浏览器设置页复用同一后端；必须明确不是 pair 网页内嵌入口，不能擅自替换用户的优先方向或 patch 正式宿主。
- **双向验证目标**：网页保存→TUI 刷新读回、TUI 保存→网页刷新读回、交错编辑时旧快照拒绝、单次提交与回执恢复、保存／同步／生效状态一致。上述均为待验证目标，不是已有实测结果；不能替代 TUI 窄窗视觉验收。
- **实施边界**：保留显式保存和同步两次确认、服务器绑定、冲突检测及 UNKNOWN 不重放；实施前按工作区 OpenSpec 流程立约定并取得用户批准。

## 本次收尾保留的验证义务（2026-11-28）

用户授权归档和 push，不代表以下未实测项目通过。详见归档 change `forge-tui-subagent-config` 的 tasks 第 1–8 节及发布 receipt；复测时逐项对账，不用基础测试代替真实链路。

- **真实 TUI 宽／窄窗完整交互**：含 active dialog 尺寸、关闭恢复、编辑／草稿／保存／同步／回执呈现。缺口原因：官方桌面控制对隔离窗口返回 `independent_surface_requires_association`，主控停止，未绕过。补跑：取得合法窗口关联后，在新七轴隔离环境由主控实测，或取得用户明确的手工实测结果；不运行旧冻结驱动。用户后续仍反馈窄窗缩进问题，不能宣称全部视觉问题解决。
- **两项 symlink 安全测试**：`tests/config-rpc-review.test.mjs` 的 R7 与 `tests/forge-config-edit.test.mjs` 的 symlinked destination 测试。当前 Windows 缺 file symlink 权限，两项 skip 不算 pass；在 symlink-enabled 环境补跑，不以 junction/hardlink 冒充，不得连续两个闭环挂同一笔账。
- **真实宿主回归与交付终验**：归档 tasks 中未勾的 RPC 生命周期、事件／重连、远程误用、同步观测及 Plan/Crew/Goal 回归仍按原任务逐项核对；0.36.4 的正式安装副本核对和完整用户验收未由 agent 落证。发布到账不能替代这些检查，收尾授权也不能替代实测。

## 后续 AI 如何提醒

1. 每次开始 Forge 修复或新增功能任务时，先读本文件，在首轮实质回复中简短披露这项计划的状态及与当前任务的相关性；同一任务不反复提醒。
2. 涉及设置界面、TUI、子代理配置、Plugin RPC 或 OpenCode 升级时，核实相关宿主能力是否已变化；未核实就明确说未核实，不沿用旧版本结论冒充现状。
3. 若上游已提供可用入口，主动告知用户，并建议将本计划转为正式提案；不要自动开工、发布、修改正式配置或阻塞当前无关任务。
4. 用户明确决定延期、替换或完成后，更新本文件的状态和依据，停止把已完成或已取消的事项当待办提醒。
