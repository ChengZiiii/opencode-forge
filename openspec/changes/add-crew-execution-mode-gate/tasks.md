# Tasks — add-crew-execution-mode-gate

## 1. Implementation

- [x] 1.1 plugin.ts: extend the crews map state with `mode` (pending / executing / converted); `crew_begin` registers PENDING; add the dual-purpose arm call (`{execution}` only, refuses non-pending crews); implement `goal` conversion (end crew, conversion record, fold-into-goal-contract directive, no ask) and `waves` arming (belt lift)
- [x] 1.2 plugin.ts: `crew_close` gains ask-gated `{abandon: true, reason}` — no verdict requirements, abandonment record, frees the session for a fresh `crew_begin`
- [x] 1.3 plugin.ts: tool-execute interception belt — while the session's crew is PENDING, refuse any `task` call with the three-choice message; no fire before registration / after arming or end
- [x] 1.4 plugin.ts: rewrite `crew_begin` success output and the `/crew` command template registration step: roster confirmed → three-choice presentation → STOP (end turn); scope the wave text to the armed state; keep the source-agnostic framing (no plan-precedence wording); wave guidance gains two lines — GUI/computer-use subtasks are mutually exclusive within a wave (the desktop is a singleton; non-GUI subtasks still parallelize freely), and GUI walkthroughs prefer the `computer` tool over DIY shell screenshot pipelines (field evidence: a ux worker burnt 12 minutes on PowerShell GDI before returning to computer)

- [x] 1.5 plugin.ts: crew plan disk record — write `.opencode/crew/<date>-<slug>.md` under the session anchor at registration (declared subtask plan); append arm / convert / abandon / close records; record-only, no resume path (restart still kills the crew honestly)
- [x] 1.6 plugin.ts: host-pool origin disclosure — registration output names the forge.json path the dispatchable set materialized from (launch anchor); mismatch disclosure pairs with the remediation (restart-from-workspace-anchor for workspace roles; `~/.config/opencode/forge.json` for cross-host pools)

- [x] 1.7 plugin.ts: goal-delegated self-orchestration — one-call `crew_begin {…, execution:"waves"}` legal only under a governing live active goal (born EXECUTING, never pends; refused otherwise); `crew_close` report/abandon drop the ask gate under a governing goal; `execution:"goal"` refused under a governing goal; goal continuation brief carries the own-the-crew-layer directive

## 2. Tests

- [x] 2.1 Crew lifecycle: register → pending; arm waves → executing; arm goal → ended-as-converted; arm on non-pending refuses; second concurrent /crew still refuses; belt states (fires pending only)
- [x] 2.2 Abandon path: ask-gate retained, no verdict demands, abandonment record emitted, fresh crew_begin after abandon works from both pending and executing states
- [x] 2.3 Template/surface text: crew_begin output presents three choices and the stop mandate; no plan-precedence wording anywhere in the crew surfaces
- [x] 2.4 Record lifecycle: registration writes the crew record file; arm / convert / abandon / close append; a stale record after restart is inert (no resume side effects)
- [x] 2.5 Origin disclosure: registration output carries the host pool's origin path; mismatch disclosure carries the remediation lines
- [x] 2.6 Full suite green (`npm test`), `bun run typecheck` clean, `bun run bundle` clean
- [x] 2.7 Goal-delegated self-orchestration: one-call arm under governing goal (no pending, belt silent, close/abandon ask-free); execution-at-register refused without governing goal; execution:"goal" refused under governing goal; continuation brief carries the crew-layer directive

## 3. Docs

- [x] 3.1 README: workflow section — the two-phase crew lifecycle, the mode gate, the re-shard exit, and the decoupling note (plan / spec / inline are equal macro-contract sources); artifact anchoring rules for plan/goal/crew (git-repo session → repo root; plain-folder session → the folder itself via the rootish guard; anchor follows the session workspace, not the objective scope)
- [x] 3.2 AGENTS.md: note the pending belt in the tool-partition row (interception family) and the crew lifecycle change

## 4. Verification & release (gated on user go)

- [x] 4.1 `openspec validate add-crew-execution-mode-gate --strict` passes; archive only on explicit user instruction
- [x] 4.2 Sandbox E2E on the built plugin: pending belt refusal → arm waves → waves flow; arm goal → conversion record; abandon → re-crew
- [x] 4.3 Version bump, CHANGELOG, commit, push (proxy), npm publish, switch local global install, live-env smoke
