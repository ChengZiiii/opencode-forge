# add-dispatch-core 承重假设探针结论（2026-09-27，opencode 1.18.32 实机）

沙盒：`OPENCODE_CONFIG_DIR` 隔离配置 + `file://` 加载 `probe-plugin.mjs`（见本目录），
驱动脚本对 `opencode serve` 走 HTTP。免钥模型 `opencode/ling-3.0-flash-fin-free`；
终判差分用真实 provider `glm-coding-worker/glm-5.3`（经 workspace 级
`.opencode/opencode.json` 注入同款 agent 定义）。

## 结论矩阵

| # | 假设 | 结果 | 证据 |
| --- | --- | --- | --- |
| P1 | `chat.params` 对 HTTP API 创建的会话触发（含 `agent` 参数） | ✅ **通过** | chat-params.log：每个 HTTP 会话的 title + 主调用均触发；probe-scout / probe-builder / forge 三种 agent 名均出现；title 调用的 options 已含 `reasoningEffort`（注入通道畅通） |
| P2 | 插件工具在 HTTP 子会话可执行 | ✅ **通过** | `probe_ping` 的 `tool.execute.before` + `execute` 均触发、无需权限应答；真实配置下 scout 的工具集里可见 `forge_shell`（forge 插件工具对子会话可见）。#16491 的限制仅覆盖 task 工具派生的会话，不影响 HTTP 会话 |
| P3a | `POST /session` CreateInput 带权限预授权 | ❌ **1.18.32 不支持**（dev 分支特性）：`permission` 字段直接 400 BadRequest | driver2 输出 |
| P3b | agent 定义 permission 的 deny 条目在子会话强制生效 | ✅ 真实 provider 上生效（**工具从模型工具集中移除**，模型如实报告 "no write tool exists"，文件未落盘）；⚠️ 免钥 Zen 端点上会话直接死掉（assistant 0 token 零 parts，连 "say ok" 都空） | driver3 + 真实差分 |
| P3c | 废弃的 `tools` 布尔字段（forge stage-0 同款机制） | ✅ 真实 provider 上同样生效（write 不可用）；⚠️ Zen 端点上会话活但**不生效**（write 照常执行，p3-z.txt 落盘） | scout4 双端测试 |
| R3 附带 | 消息响应携带 usage | ✅ `POST /session/:id/message` 返回 `info.tokens{input,output,reasoning,cache}` 真值；`info.cost` 恒 0（自算成本路线必要） | usage.log |
| P4-lite | HTTP 会话可见性 | 会话出现在 `GET /session` 列表（长度 6）；TUI 可见性未测（需实机） | driver2 |

## 对设计的修正输入

1. **tier 权限载体 = tier agent 定义**（1.18.32 无 CreateInput.permission）。deny 式
   permission 与 `tools` 布尔在真实 provider 均被强制执行，二选一皆可；推荐文档化的
   `permission` deny 列表（omo 同款）。
2. **免钥 Zen 端点对"缩减工具集"的请求返回空响应**（无论经哪层缩减）——派发层遇
   免钥模型 + 受限 tier 的组合会表现为子会话超时。设计已有 §4.6 超时与如实报错路径
   兜底；roster 文档应标注该组合为已知坑，或对免钥模型仅配不受限 tier。
3. **worker 提示纪律必须含"相对路径"约束**：观察到模型把 "workspace root" 理解为
   文件系统根（`/p3-d.txt`），触发外部目录权限后调用挂起且无 permission 事件可答。
   派发 prompt 模板硬性要求 workspace 相对路径。
4. **子会话独立超时必要**（§4.6）：挂起既无 SSE 事件也无 permission.ask 钩子信号，
   唯一出口是派发侧 deadline。

## 复现

```bash
# 沙盒（免钥）
mkdir -p /tmp/fdp-config && cp sandbox-config.example.json /tmp/fdp-config/opencode.json
# 编辑其中的 file:// 路径指向 probe-plugin.mjs 所在目录（需带 package.json）
OPENCODE_CONFIG_DIR=/tmp/fdp-config opencode serve --port 43917 &
node driver2.mjs http://127.0.0.1:43917   # P3 矩阵（driver3.mjs 为聚焦版）
# 真实 provider 差分：工作区 .opencode/opencode.json 注入同款 agent，
# 不设 OPENCODE_CONFIG_DIR 直接 serve，MODEL 换 {providerID:"glm-coding-worker",modelID:"glm-5.3"}
```
