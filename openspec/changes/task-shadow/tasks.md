# Tasks: task-shadow

## 1. Specification

- [ ] Deltas (REMOVE two async-dispatch requirements, ADD task-shadow surface + dispatch lifecycle) written; strict validation passes

## 2. Engine extension (`src/dispatch-async.ts`)

- [ ] Abort-signal hook: sync dispatch aborts the child on tool-context abort; unit tests (abort during poll → child aborted + disclosed)

## 3. Tool surface (`plugin.ts`)

- [ ] Register dispatch implementation under `task`: args {description, prompt, subagent_type, run_in_background}; metadata published mirroring native/OMO keys (agent, sessionId, taskId, run_in_background, description, prompt); forge_dispatch registration removed (getter/count 18 → 17)
- [ ] Target routing: forge-* targets → existing gate chain (pool gate, crew belts, cap, draft interop); non-forge targets → same engine, pool gate skipped, question policy mode-keyed (sync: questions available; async: question-deny)
- [ ] Gates stay keyed on the `task` name in execute-before; worker recursion ban unchanged

## 4. Tests

- [ ] Parity matrix: forge target sync/async; non-forge target sync/async (no pool gate, question policy per mode); draft readonly pass / write deny both modes; cap; sync abort parity; metadata keys asserted; forge_dispatch absence asserted
- [ ] Full suite green (existing dispatch tests ported to the `task` surface); typecheck 0

## 5. Docs

- [ ] README: dispatch section rewritten around `task` (run_in_background, question policy per mode, native panel note); breaking-note: do not co-install with oh-my-opencode (both shadow `task`); forge_dispatch references removed

## 6. Release

- [ ] Version 0.23.0, typecheck, full suite, bundle, pack = 3 files, publish, store update (dual-layer + marker), push
- [ ] Live TUI verification WITH THE USER WATCHING: forge dispatch under `task` shows the native live subagent panel (the acceptance moment for the whole shadow); async wake + parentID linkage re-verified; evidence in verify/acceptance-0-23-0.md
