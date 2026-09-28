## 1. Config core rewrite (src/forge-config.ts)

- [x] 1.1 Extend the agent definition type to `{model, thoughtLevel?, prompt?, shape?, permission?}` and rewrite the semantic layer to field-level fail-soft (bad entry → skip agent + error finding; bad optional field type → ignore field + finding; `depths` present → deprecation finding, no behavior; broken JSONC → empty set + parse-location error finding; no seed anywhere). Verify: new unit tests in tests/forge-config.test.mjs covering each degradation path + cascade + hot-apply cache.
- [x] 1.2 Delete `PLACEHOLDER_IDENTITY`, `SEED_AGENTS`, `forgeRecipe`, and the unconfigured notice; replace with a silent inert empty result (no recipe, no AI invitation). Verify: grep shows no `GPT Luna` / recipe strings in src/; unconfigured-load test asserts empty agents + zero findings surfacing to the model path.

## 2. Prompt + depth sources (dispatch-tiers.ts → role/prompts, dispatch-depth.ts retained)

- [x] 2.1 Rework `dispatch-tiers.ts` (or its successor module) into the materialization source: discipline preamble + role prompt composition (explicit `prompt` > built-in research/review role default > generic worker), shape-derived permission map with forced `task: deny`. Verify: unit tests assert the composed prompt contains the three mandates and the permission shape for readonly/write/override cases.
- [x] 2.2 Keep `dispatch-depth.ts` translation intact; add a small helper that, given agent name + winning config, resolves the pinned `thoughtLevel` translation (or none). Verify: existing dispatch-depth tests still pass; new helper test covers absent/invalid word → no translation + finding payload.

## 3. plugin.ts rewiring (dispatch removal)

- [x] 3.1 Config hook: materialize `forge-<id>` agents with `model` from the definition, NOT hidden, `mode: subagent`, create-only (no-clobber user entries); re-run on config reload (hot-apply). Verify: hook-level test asserting injected agent shape (model present, no hidden flag, task denied) + no-clobber + disable-knob silence.
- [x] 3.2 chat.params hook: re-key injection on the agent name via task 2.2's helper; inject via existing `applyDepthTranslation`; no-mapping → inject nothing + bounded once-per-agent finding; value stable per session. Verify: hook-level test with a fake params input (agent=forge-x) asserting options written once and left stable.
- [x] 3.3 v2 `setup`: register the same subagents create-only (structured-type guards, `?.` discipline). Verify: v2-setup test (extend tests/v2-setup.test.mjs) asserts creation + skip-on-existing.
- [x] 3.4 Remove the dispatch suite wiring: forge_dispatch / forge_dispatch_config / forge_dispatch_list / forge_dispatch_kill tool registrations, engine construction, registry, wake-engine dispatch hook, and dispatch ledger sink — leaving crew tools, `/crew` command, plan/goal/job/watchdog wiring untouched. Verify: grep for `forge_dispatch|dispatchLedger|createDispatchEngine` in plugin.ts returns nothing; crew/plan/goal/job registrations intact by diff review.
- [x] 3.6 Add the routing-hint line to the plugin-authored forge agent prompt (prefer a matching `forge-*` subagent; on no match use the native task channel and tell the user; D9: prompt-level, no matcher). Verify: test asserts the hint text is present in the injected forge agent prompt.
- [x] 3.5 Delete dead modules: src/dispatch-engine.ts, dispatch-client.ts, dispatch-registry.ts, dispatch-resolver.ts, dispatch-roster.ts, dispatch-ledger.ts (crew-gate.ts stays, reworked in group 4). Verify: `bun run typecheck` passes with no dangling imports.

## 4. Crew rework onto declared-plan semantics

- [x] 4.1 `crew_begin {objective, subtasks[{title, agent?}]}`: register the declared plan in the in-memory crew state (keep: one crew per session, plan-draft refusal, restart = honest death). Verify: unit/hook tests for registration, duplicate refusal, draft refusal.
- [x] 4.2 Rework `crew-gate.ts` validation from dispatch-ledger matching to declared-plan matching: refuse missing verdict/evidence on a declared subtask, refuse renegade undeclared subtasks, require attempt+retry reports for FAIL. Verify: reworked crew-gate tests covering all three refusal classes + the honest-FAIL pass.
- [x] 4.3 Rewrite the `/crew` command template discipline: recon → register plan via crew_begin → waves of parallel native `task` calls (next wave after results return) → missing-role fallback with an explicit user notice and a configure suggestion → evidence verification → ≤1 retry per subtask → crew_close report. Verify: template text review against the crew-harness delta scenarios; no background/brief/ledger vocabulary remains.
- [x] 4.4 `crew_close`: keep ask-pinned gate; on success end the crew and emit the summary as tool output (no ledger append). Verify: hook-level test of the ask gate + summary output + post-close state reset.
- [x] 4.5 Implement the unconfigured initialization gate: `/crew` with an empty effective agent set refuses entry and presents the guidance (two file paths, embedded JSONC template, self-configure or AI-assist with the explicit-consent rule, restart/hot-apply timing); no other surface gains a configuration invitation. Verify: tests assert the refusal + guidance content on empty config, normal entry with ≥1 agent, and that tool/agent-prompt surfaces carry no config invitation.

## 5. Tests

- [x] 5.1 Remove obsolete suites (dispatch-engine/client/resolver/roster tests) and update tests/job-wiring / goal-mode if they referenced dispatch tools. Verify: `node --test tests/*.test.mjs` green with the reduced set.
- [x] 5.2 Add the static-agent suite: materialization (model pin, not hidden, discipline prompt, permission + task deny), fail-soft config degradations, chat.params agent-name injection incl. no-mapping finding, hot-apply, v2 setup parity. Verify: the new suite passes and names the spec scenarios it covers (forge-subagents spec).

## 6. Docs + ledger hygiene

- [x] 6.1 README: replace the dispatch sections with the forge-subagents guide (config shape, thoughtLevel semantics, task-tool dispatch, `shape: "write"` endpoint note, migration from `depths`, the restart-vs-hot-apply table: agent additions/model/prompt/permission need a restart, thoughtLevel edits hot-apply); rewrite the /crew section for declared-plan semantics incl. the initialization gate and the AI-assist consent rule; drop the dispatch-ledger row from the file-ledger table; update uninstall notes for `<tmp>/opencode-forge/dispatch/` debris. Verify: README read-through matches shipped behavior; no dispatch tool references remain.
- [x] 6.2 AGENTS.md: update the architecture table (plugin.ts row, deleted src files, new materialization/injection + crew rework description) and the tool inventory (19 → 15 tools). Verify: table rows match src/ tree after deletion.

## 7. Final verification

- [x] 7.1 Full gate: `bun run typecheck`, `node --test tests/*.test.mjs`, `bun run bundle`, dist self-containment check (no external requires). Verify: all four commands exit clean.
- [x] 7.2 Official-install E2E per AGENTS.md 终验: `opencode plugin "git+file:///<repo>" --global`, then on a sandbox config assert (a) no forge_dispatch tools registered, (b) task tool vocabulary lists a configured forge agent, (c) a task-spawned run of that agent carries the pinned model and (where injectable) the thoughtLevel option, (d) fail-soft findings appear for a seeded broken file, (e) `/crew` discipline loads and crew_close refuses an incomplete report against the declared plan, (f) `/crew` on an unconfigured sandbox refuses with the initialization guidance. Verify: recorded transcript/log excerpts attached to the change before archive.
