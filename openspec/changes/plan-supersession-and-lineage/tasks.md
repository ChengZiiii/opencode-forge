# Tasks: plan-supersession-and-lineage

## 1. Spec

- [x] 1.1 Delta review pass: MODIFIED requirements carry all live scenarios verbatim (crew discipline ×11, crew_close ×5, plan layout ×2, discard exit ×3); ADDED narrative requirement has the five scenarios
- [x] 1.2 `openspec validate plan-supersession-and-lineage --strict` passes

## 2. plan-file core (src/plan-file.ts)

- [x] 2.1 `PlanStatus` gains `superseded`; TERMINAL and LEGAL_TRANSITIONS extended (draft/approved → superseded); illegal-transition message updated
- [x] 2.2 `appendTerminalSection(text, kind, {reason, successor, checks})` pure helper: dated `## <iso> — closed/abandoned/superseded` section appended end-of-file; returns the new file text (caller writes once, atomically, together with the status flip)
- [x] 2.3 Parser-inertness pinned: status from frontmatter only, ticks from the Task List section only — add tests that a terminal section containing `- [ ]`-like or `status:`-like text never changes parse results

## 3. plan tools (plugin.ts)

- [x] 3.1 `plan_discard` gains optional `supersede` arg (string); persists the dated abandon/superseded section (reason or `(none given)`; successor when present) in the same write as the status flip; output mentions the section
- [x] 3.2 `plan_close` appends the dated close section (per-criterion pass/evidence) in the same write as the done flip
- [x] 3.3 `/plan discard` command template + tool description updated (supersede usage: when work moves to crew/goal)

## 4. crew surfaces (plugin.ts)

- [x] 4.1 `crew_begin` registration output reordered: record path line in the first block (before objective summary / declared plan); roster-origin disclosure follows
- [x] 4.2 PENDING pause text (crewPendingChoiceLines) instructs relaying the crew record path to the user
- [x] 4.3 `crew_begin` optional `lineage` arg → `lineage:` line in the crew record header (writeCrewRecord) and surfaced in the registration output
- [x] 4.4 Draft-gate error names all three exits (approve — approved plans do not block /crew; discard; discard {supersede})
- [x] 4.5 /crew command template: registration step mentions `lineage` when descending from a plan artifact

## 5. Tests

- [x] 5.1 plan-file suite: superseded transitions, narrative appends (close/discard/supersede), missing-reason marker, parser-inertness
- [x] 5.2 crew wiring suite: record path leads output, lineage in record header, draft-gate error text, PENDING relay instruction
- [x] 5.3 Full suite green (`node --test tests/*.test.mjs`), typecheck, bundle

## 6. Verify

- [x] 6.1 README: plan 文件账本/生命周期段落补 superseded 状态与终态叙事；crew 章节补 lineage；**apply-timing 表改写（实测修正 2026-10-01）**：物化触发器=宿主 boot / 首次配置构建 / opencode 配置文件重载——**常驻共享宿主（paseo 类 serve）上新开会话不触发重建**，池变更须等下一次真实重建或重启；新进程（独立 CLI）boot 即读
- [x] 6.2 手工冒烟（沙盒）：draft → discard{supersede} → crew_begin{lineage} 检查三份工件的链条叙事完整
- [x] 6.3 官方安装模式终验（git+file:// → 四步卸载干净）
