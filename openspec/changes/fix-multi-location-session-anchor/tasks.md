# Tasks: fix-multi-location-session-anchor

> 用户已批准（2026-11-23「A+B我都批」），按草案（方案甲）实施。

## 1. Specification

- [x] 1.1 用户批准草案（含方案甲 / 乙的取舍）；
      `openspec validate fix-multi-location-session-anchor --strict` 绿
- [x] 1.2 实现前探针：坐实 design D0 两条未证项（结论见 D0）

## 2. Implementation（design D1 方案甲）

- [x] 2.1 task 建孩子后登记 `孩子 → owner 已解析目录`
      （建出即绑定：`bindChildToDirectory` / `createChildSessionBound` /
      `registerDispatchTask`，见 design D7）
- [x] 2.2 `v2ToolContext` 在 `hostWorktree` 之前加“查宿主会话记录”一级
      （会话目录 → `parentID` 上溯）
- [x] 2.3 回落默认目录时在工具结果里点名
- [x] 2.4 单测五则（design D3）+ typecheck + 全量套件全绿 + 变异检查
      （a-1 / a-2 / a-3 全部被杀）

## 3. Verification（GATE）

- [ ] 3.1 多目录沙箱 E2E（design D5 第 2 条）
- [ ] 3.2 真机终验（用户重启后，design D5 第 3 条）

## 4. Release

- [ ] 4.1 并入 0.33.1

## 5. Wrap-up（用户明示后）

- [ ] 5.1 archive + push
- [ ] 5.2 方案乙（按目录保存初始化接口）另立 change 草案，交用户排序
      ——已另有真机证据坐实其必要（确认门失效），见 overnight-status
