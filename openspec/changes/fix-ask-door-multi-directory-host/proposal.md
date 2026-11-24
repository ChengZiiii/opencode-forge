# Proposal: fix-ask-door-multi-directory-host

> **已批准（2026-11-24，整份批准），排 0.34.1，在 0.34.0 之后实施。**
> 这是行为改动，不在任何已批准的 change 里（A「会话认准自己的目录」
> 只修了目录解析，没碰确认门）。立稿时没动代码。

## Why

宿主（opencode 2.4.0）每在一个目录里初始化插件，就多一个“实例”。
插件的初始化代码却在模块级只留**一份**宿主接口，每初始化一次就覆盖
一次。于是多目录宿主上：

1. **确认框不弹。** 在“不是最后初始化的那个目录”的会话里，
   `plan_approve`、`goal_write`（arm）、`goal_complete`、`goal_resume`、
   `goal_discard`、`crew_close` 这些门工具打开确认门后，会话的终端里
   看不到确认框，工具一直等。
2. **一起失败。** 最后初始化的那个目录被宿主收回（evict）之后，所有
   目录里的门工具和 `forge_shell` 立刻失败（断言直接抛错）。

为什么一直没被 E2E 拦住：E2E 驱动走 HTTP，不带目录范围的
`GET/POST /api/session/<id>/permission` 仍能查到并作答；只有真终端
（TUI）是按“会话所在实例”找待答请求的，所以只有人工看终端才发现。

你的真机就是多目录宿主，这个缺陷直接影响日常使用。

## What Changes

1. **按目录保存初始化接口。** 每次初始化捕获的宿主接口按目录登记
   （`Map<目录, 接口>`），不再“最后一次初始化覆盖前面所有”。
2. **确认请求按会话选接口。** 每次确认请求按“会话自己的目录”（沿用 A
   的解析：宿主会话记录 → 父会话上溯 → 默认）选对应目录的接口。
3. **接口失效时有确定的降级。** 目录被收回后：失效条目作废、退到仍
   可用的接口重试一次；仍不行就原样报错——**失败关闭**，绝不放行。
4. **审计同病的其它接口**（只审计、按证据决定纳不纳入）：
   `v2SessionRuleApi`、`v2SessionWaitSeam`、`v2DispatchStorage`、
   `jobClient` / `anchorClientShared`。
5. **补验证。** 新增多目录确认门的 E2E（HTTP 按目录范围核对），外加
   有头 TUI 在“非最后目录”的会话里实弹确认一次。

## Impact

- `plugin.ts`：`v2Setup` 的接口捕获、`v2ToolContext` 的 ask 适配器。
- 规格：`forge-agent`「Every user-confirmation door raises its dialog
  under v2」加多目录两幕（MODIFIED）。
- 测试：单测（多初始化夹具）+ 变异检查 + E2E `21` + 有头 TUI 门加一项。
- 不改：权限带决策表、门的名单、A 已修好的目录解析。
