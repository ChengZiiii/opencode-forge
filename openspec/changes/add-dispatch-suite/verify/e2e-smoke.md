# add-dispatch-suite · 沙盒 E2E 冒烟存档（task 6.3）

- 日期：2026-09-27
- 驱动：`scripts/dispatch-probe-g.mjs`（SSE 自动应答权限 ask + 回合稳定检测 + 逐条断言，exit code = 0/1）
- 沙盒：`OPENCODE_CONFIG_DIR=C:/tmp/forge-stage-g/config`（专用目录，含 dispatch roster/tuple options），
  serve `opencode serve --port 43932 --hostname 127.0.0.1`，工作区 `C:/tmp/forge-stage-g/ws`（全新）
- 模型：`opencode/ling-3.0-flash-fin-free`（免钥端点）；dispatch `timeoutMs: 60000`，roster expose `["low"]`，profiles `["scout","quick"]`
- 插件：`file://C:/Users/Soren/Desktop/AgentWorkCommon/opencode_plugin_dev/opencode-forge`（dist 已 6.2 重打包）
- 结果：**SMOKE-G PASS: 10/10**（2026-09-27T01:47:27.655Z，父会话 ses_f1f757988ffemuphyVvAhE95lq）

## 断言与真实观测（10/10 PASS）

| # | 断言 | 观测摘录 |
| --- | --- | --- |
| 1 | scout 同步只读在免钥端点诚实失败（B27 已知坑，绝不假成功） | 模型上报原文：`[forge:dispatch:empty-response] child session ses_f1f756e90f…` |
| 2 | quick 同步返回完整结果报告（实际模型/深度 + tokens/cost + worker 报告） | `[forge:dispatch] completed in 13672ms tier: quick model: opencode/lin…` + Cost + Depth injected |
| 3 | quick 同步 worker 真实落盘 | `smoke-sync.txt` 存在（内容 sync-ok，worker 自证 write+read 校验） |
| 4 | 后台提交返回句柄 | 模型上报 `Dispatch ID: bg-2`（含 tier/model/depth/queuedAt） |
| 5 | 空闲父会话收到唤醒 brief | `[forge:dispatch-complete] 1 background dispatch(es) reached terminal state:` |
| 6 | 唤醒 brief 携带完整结果对象 | `- bg-2 · tier quick · opencode/ling-3.0-flash-fin-free @low · COMPLETED · session …` + `result: {"tier":"quick","requested":{…}}` |
| 7 | 后台 worker 真实落盘 | `smoke-bg.txt` 存在 |
| 8 | 账本：本轮有 empty-response 行（scout） | `{"ts":"2026-09-27T01:46:19.469Z","event":"empty-response","tier":"scout",…,"durationMs":6755}` |
| 9 | 账本：completed 行带 tokens/costUsd/durationMs | 两条 completed（同步 + 后台）字段齐全 |
| 10 | 账本：后台行带 dispatchId + parentSessionID 归因 | `…"dispatchId":"bg-2","parentSessionID":"ses_f1f757988ffemuphyVvAhE95lq"` |

## 覆盖映射

- 同步派发全链路（S6 结果对象语义）+ 免钥×受限 tier 已知坑（B27，LIMITATION 的活体复验）
- 后台派发 + 终态驱动唤醒 brief（B40/B34 后的唤醒语义活体复验：父会话空闲时单条合并 brief 携带完整结果）
- 账本落盘与归因字段（B30 延伸：dispatchId/parentSessionID 在真 serve 写入）

## 过程记录

- 首轮驱动 7/10：三处失败全部为**驱动自身缺陷**，非插件缺陷——
  1. dispatchId 正则 `d\d+` 不匹配真实格式 `bg-N`（引擎/registry 实际用 `bg-<seq>`）；
  2. 账本断言按字节偏移取增量，但账本实现是**整文件重写 + 200 条轮转**，偏移切片在轮转后错位（盘上三行本身全对，直接 tail 验证）→ 改为按行内 `ts >= smokeStart` 过滤；
  3. 唤醒扫描把模型回合回复里**引用的** `[forge:dispatch-complete]` 字样误当 brief → 改为只扫回合结束后新增消息。
  修复后二轮 10/10 PASS。
- 清理：serve 进程（PID 94524）taskkill 终止，43930-43939 端口段复查无监听（仅客户端 TIME_WAIT 自灭）；沙盒目录保留至终局清理（G 自审后删除）。
- 安全红线：全程未写用户 opencode 配置；未触碰 41593/41595 与用户 opencode 进程；真实密钥未回显。
