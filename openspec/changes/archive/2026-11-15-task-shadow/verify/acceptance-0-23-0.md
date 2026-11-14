# Acceptance: 0.23.0 (task-shadow)

Date: 2026-11-15 (session after restart, host loaded store 0.23.0)

## Acceptance moment — TUI native task panel (user-witnessed)

Dispatch: sync `task {subagent_type: "forge-plugindev-spec-reviewer",
description: "0.23.0 霸名活体验证", prompt: <readonly scout — count src .ts
files + dispatch-async.ts lines>}` from the 0.23.0 session.

User witnessed in the TUI (screenshot verified):

- `✓ Forge-Plugindev-Spec-Reviewer Task – 0.23.0 霸名活体验证` — the
  native Task block with the agent name and our description
- `3 toolcalls · 34.2s` — live child progress rendered natively
- `ctrl+x down  view subagents` — the native subagent view affordance;
  the user expanded it and saw the child transcript (可以点进去的)

Verdict: the dispatch renders through the native task panel, not a
generic tool-call block. **Marker: TASK-SHADOW-TUI-PANEL-CONFIRMED.**

## Engine evidence (same dispatch)

- Child session `ses_e23c4df9fffe24XtZbX1U0nGTS` ran via the SDK engine;
  final report `SHADOW-LIVE-0230 22 307` (22 .ts = 21 from 0.22.0 +
  dispatch-async.ts — self-consistent; dispatch-async.ts = 307 lines).
- Tool surface in the fresh session: single `task` tool with
  `run_in_background`; no `forge_dispatch` anywhere.

## Pre-release chain (recorded)

- Tests 541/541 (533→541), typecheck 0, `openspec validate
  task-shadow --strict` valid.
- Review APPROVE-WITH-NOTES (10/10 scenarios judged; 7 notes, no
  blockers; N1/N6 fixed pre-release; contract clarification added to the
  delta — session-keyed crew pending belt). Report:
  `openspec/changes/task-shadow/verify/review-task-shadow.md`.
- Published `+@sorenllm/opencode-forge@0.23.0`; REST flip observed
  (`latest=0.23.0`); store dual-layer verified (layer1 0.23.0, layer2
  `tools.task` + `run_in_background` markers, forge_dispatch functional
  refs 0).
- Commits `dbd7b13` (implementation) + `8edb7eb` (release); GitHub push
  was blocked by network resets — survive-mode retry loop
  j-20261114-224340-wu53lv (status checked separately).

## Known disclosures carried

- Registration map: 18 keys via swap (`task` replaces
  `forge_dispatch`); forge partition vocabulary for non-forge agents:
  18 → 17 (task intentionally shared).
- Sync dispatches may ask questions (native parity) — a behavior change
  vs 0.22.0 sync forge dispatches (question-deny), per design D3.
- README breaking-note: do not co-install with oh-my-openagent (both
  shadow `task`).
