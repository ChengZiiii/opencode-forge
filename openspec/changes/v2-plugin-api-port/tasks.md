## 1. W1 — Harness + agent materialization parity

- [x] 1.1 Build the V2 mock-context harness (mock `ctx` domains with wired and drifted shapes, mirroring the goal-mode stub-client pattern) — verify: harness unit tests pass
- [x] 1.2 Replace the simplified single-workspace pool resolution in `setup` with the complete sole-pool-ownership resolver (workspace pool + global fallback, `forge-<ns>-<id>` materialization, pinned models, provenance descriptions, shape permissions, create-only) — verify: new unit tests port the hierarchical-pools matrix to the V2 harness; V1 suite stays green

## 2. W2 — Tool surface

- [x] 2.1 Add the shared JSON Schema builder translating the `tool.schema.*` definitions; register all tools (`forge_shell`, `forge_jobs`, plan_\*, goal_\*, crew_\*, task, grep/glob) via `ctx.tool.transform` reusing the shared execute cores — verify: unit tests assert each registration (name, schema shape, execute wiring) plus drifted-domain no-op; V1 suite green

## 3. W3 — Permission belt

- [x] 3.1 Port the belt (draft write-freeze, double gates, crew pending + pool-compliance belts, worker→STATE refusals, status-file boundaries) to `ctx.permission.hook("evaluate")` with the same decision table and ask-rewrite semantics — verify: port the permission-matrix unit tests to the V2 harness (deny paths, ask paths, explicit-deny precedence); sandbox pins the real event shape before merge

## 4. W4 — Session seams + commands

- [x] 4.1 Wire `ctx.tool.hook("execute.before")` (activity marking, dispatch guards, readonly-exec seal) — verify: ported unit tests; V1 green
- [x] 4.2 Wire `ctx.session.hook("prompt")` / `ctx.session.hook("context")` / `ctx.session.hook("compaction")` (family capture, thoughtLevel injection, system injections, channel mandate, goal-brief reinjection) with the new event topology (Decision 3) — verify: ported injection tests; fail-open posture tests; V1 green
- [x] 4.3 Register `/plan` `/goal` `/crew` via the command domain — verify: unit test asserts the three registrations; template strings byte-identical to dist

## 5. W5 — Continuation engines

- [x] 5.1 Move goal idle continuation, job-wake delivery, and `session.deleted` harvest to `ctx.event.subscribe()` + session domain reads, with cleanup aborting the subscription — verify: port the goal-mode continuation scenarios and job-wake tests to the V2 harness; V1 green

## 6. W6 — Sandbox verification (real V2 binary, isolated)

- [x] 6.1 Download an opencode V2 release binary into a temp dir (installed 1.19.5 untouched) — verify: temp-dir `opencode --version` prints 2.x (sandbox bin = 2.3.2, `opencode --version` → 2.3.2)
- [x] 6.2 Load test with a hand-written sandbox config (V2 `plugins` entry → local dist): plugin id listed, no load errors — verify: recorded output (serve boot loads forge dist zero load errors; note: the loader validates `mod.default` for `{id, setup}` — forge's default export already matched)
- [x] 6.3 Full-surface checklist: agent list (forge + materialized subagents), tool registry (partition semantics visible), one permission-gate refusal and one ask-gate dialog observed, `/plan` template loads, scripted idle-continuation scenario completes a goal turn — verify: recorded host outputs; field-name realities fed back into mocks (all observed live on 2.3.2: forge + forge-live-research materialized; draft write-freeze refused a real write with the verbatim message and the file was NOT created; goal_complete ask→reply "once" twice; /plan /crew /goal registered execute-based; live-loop E2E exit=0 ×2 — continuation fired, turns incremented, goal completed, host-side check rerun OK. Field realities: session.get flat {sessionID}; session dir under location.directory; prompt send flat root-level {sessionID, text} (blocking, no promptAsync); commands EXECUTE-based (no create-only); permission reply POST /api/session/:sid/permission/:rid/reply {decision}; pool model pins not draft-settable (any spelling 500s the agent encoder) — V1-only, documented drift)
- [x] 6.4 autocontinue observation: active-goal session under compaction on V2; record whether a synthetic auto-continue exists — verify: finding recorded in this design (Decision 5 resolved) and README adjusted (binary scan: V2's only auto-continues are opt-in TUI settings — `autoContinueAtUsageLimit` and the question-dialog auto-answer (default "never"); NO default per-turn synthetic autocontinue exists on V2, nothing fights the goal loop; the compaction hook's goal-brief reinjection remains the loop-safety net)

## 7. W7 — Manifest, docs, release

- [ ] 7.1 `engines.opencode` → `^1.18.0 || ^2.0.0`; README V2 install section; AGENTS.md v1/v2 section rewritten for full parity — verify: manifest valid, docs present
- [ ] 7.2 Version bump, `bun run bundle`, dist self-containment re-check, `npm pack --dry-run` shape check — verify: recorded outputs
- [ ] 7.3 Release train per the recipe (conventional commits, push with retry, npm publish, registry cache-buster verify, store flip) — verify: recorded registry fetch + store integrity outputs
- [ ] 7.4 V1-host install regression + `openspec validate --all` green — verify: recorded outputs; archive only on the user's explicit word
