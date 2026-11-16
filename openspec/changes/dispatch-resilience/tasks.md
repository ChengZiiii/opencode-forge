# Tasks: dispatch-resilience

## 0. Umbrella setup

- [x] 0.1 DONE — `sync-timeout-notify` archived as `2026-11-16-sync-timeout-notify` (its deltas are live in the spec)
- [x] 0.2 Validate this change `bunx openspec validate dispatch-resilience --strict` (re-run after every artifact revision)

## 1. Fold A — headless ask liveness (tool-partition + job-supervisor carve-out)

- [x] 1.1 Read the gate region (`plugin.ts:1640`), the classifier (`src/exec-classify.ts`), AND the config hook (`plugin.ts:3415-3428`) + permission.ask belt (`plugin.ts:3906-3911`) to pin the snapshot seam and the re-read trap (the hook mutates a merged config object that may be re-presented — never re-capture the plugin's own injected `ask`)
- [x] 1.2 Implement headless detection: serve mode from host process argv + `FORGE_HEADLESS` override (1/0); `opencode run` mode is NOT headless (its auto-reject ask semantics unchanged); unit tests: serve→headless, run→NOT headless, env forces both ways
- [x] 1.3 Implement the resolution order: config-hook snapshot of user-explicit values BEFORE posture rewriting; explicit allow skips the ask in both modes, explicit deny refuses; TUI default posture dialog unchanged; headless → READ-class proceeds, WRITE-class `[forge:headless-denied] <command head>`; doors = exactly the `gate()` call-site set (plan_approve, plan_close, goal_write arm, goal_complete, goal_resume, goal_discard, crew_close) never auto-resolved; seal finding lands before the headless denial
- [x] 1.4 Tests: read-class proceeds headlessly; write-class refuses honestly; explicit allow skips the ask in TUI AND headless AND run mode (deny refuses everywhere); doors (incl. goal_discard) never auto-resolve; run mode keeps auto-reject for the default posture; seal-before-headless ordering; TUI default posture byte-identical (existing tests green)
- [x] 1.5 Full suite + typecheck green (578/578, tsc exit 0)
- [x] 1.6 Live sandbox replay on the published build: REP-A headless read-class `forge_shell` ran to completion with output returned (the previously-hanging shape); REP-B write-class returned the verbatim `[forge:headless-denied]` refusal and the child still produced its final report (file NOT created — negative proof); REP-C explicit-allow carve-out ran the write-class command headlessly (file created — positive proof)
- [x] 1.7 Docs: README `FORGE_HEADLESS` knob row + the headless bypass-surface disclosure (unclassifiable commands flow for write-shape workers); the job-supervisor carve-out ships with this fold's delta
- [x] 1.8 Release the fold (0.24.0: publish, REST flip attempt 9, store install with cache clean, dual-layer verify 0.24.0 + `headless-denied`×1, push synced `7bcce57..9857851`)

## 2. Fold B — activity-stale reap (forge-subagents / Dispatch resilience)

- [x] 2.1 Extend the `DispatchClient` seam with `session.get`; activity anchor = `time.updated` (part-level refresh), no-message anchor = dispatch start time
- [x] 2.2 Implement the reap: `FORGE_DISPATCH_STALE_MS` (default 2700000, clamped to the 60 s floor), runtime floor, pre-kill re-read (refresh resets), existence probe (unresolved → skip sweep, missing → finalize), abort-failure posture (failed abort + session exists → skip and re-arm), honest terminal wake `stale: aborted after N min without activity` — plus the 0.25.2 fix: the probe must invoke `client.session.get` as a BOUND method (destructured call lost `this`, every probe resolved null, the sweep skipped forever — found via the `FORGE_DISPATCH_DEBUG` seam on a live serve)
- [x] 2.3 Implement `FORGE_DISPATCH_STALE_MODE` = kill (default) | observe (ONE notice per threshold crossing, no kill)
- [x] 2.4 Tests: reap after threshold with confirmed inactivity; refresh resets; observe notifies once per crossing without killing; floor blocks early reap; no-message child anchors at start; failed abort skips + re-arms; stale wake is the single terminal wake; textless-idle floor vs stale reap stay distinct (busy-missing vs busy-silent)
- [x] 2.5 Full suite + typecheck green (611/611, tsc exit 0)
- [x] 2.6 Live replay (env-shortened threshold): a silent sleeper child is reaped with the honest wake — THREE independent reps on 0.25.2, each reaped at the 60 s floor (requested 15 s clamps UP to it) with `stale: aborted after 1 min without activity` + task id (REST-verified task parts ses_e1cb66543/ses_e1cb1e29/ses_e1cac75e); the continuously-producing-child-untouched half is covered by the refresh-rail unit tests (live reps ran sleeper children only)
- [x] 2.7 Docs: README rows for `FORGE_DISPATCH_STALE_MS` / `FORGE_DISPATCH_STALE_MODE` (invalid → default; floor clamp)
- [x] 2.8 Release the fold (0.25.0 core + 0.25.1 sync-window coverage + 0.25.2 probe fix: publish, REST flips (0.25.1 attempt 7, 0.25.2 attempt 14), store install with cache clean + pin bump, dual-layer verify each)

## 3. Fold C — retry with resume preamble (forge-subagents / Dispatch resilience)

- [x] 3.1 Port the error classifier (`src/dispatch-retry.ts`) with the vocabulary ENUMERATED: retryable = transient transport/5xx/overload/rate-limit patterns; deterministic = provider-configuration, auth, model-not-supported, contract patterns (ported terminal classes); unknown → not retried
- [x] 3.2 Implement respawn: same agent, original prompt + inspect-then-continue preamble, `FORGE_DISPATCH_MAX_ATTEMPTS` default 2, fixed 10 s backoff, progress notice per retry, final wake discloses the attempt count, exactly one terminal wake; retry inherits the dying child's registry slot; dispatch-time policies (draft/crew mode-keyed denies) re-applied — sync dispatches covered too (the sliced sync wait runs the same classifier/respawn; a recovery discloses `recovered on attempt N/M`)
- [x] 3.3 Implement the no-retry exclusions: stale kills, user aborts, textless-idle floor, deterministic terminal classes
- [x] 3.4 Tests: transient-class error respawns with preamble + notice + attempt disclosure; provider-config-class error does NOT retry; attempt cap honored; stale/abort/floor never retry; armed-sync retry's final wake names the new child session id (20 pure-core + 13 wiring tests)
- [x] 3.5 Full suite + typecheck green (611/611, tsc exit 0)
- [ ] 3.6 Live replay: FINDING (0.25.2 live serve) — a real transient outage was staged through a one-shot-503→pass-through proxy in front of the true upstream: the 503 window was absorbed by the HOST's agent loop (1.19.5 retries failed steps internally — a malformed-mock child was observed looping step 2529), so the child never TERMINATED in an error message and the plugin-level retry branch had nothing to act on; the dispatch recovered across the outage window with an honest completion (ses_e1c9eed0). The retry branch itself stays wiring-verified (classifier matrix + respawn/discovery tests); a live trigger needs a host that surfaces terminal error messages (revisit at 6.2 or on host upgrade)
- [x] 3.7 Docs: README `FORGE_DISPATCH_MAX_ATTEMPTS` row
- [x] 3.8 Release the fold (same train as 2.8)

## 4. Fold D — cap queueing (forge-subagents / Dispatch lifecycle)

- [ ] 4.1 Implement the per-session FIFO queue (bound `FORGE_DISPATCH_QUEUE_MAX` default 10), queued handles carrying `queued: true` panel metadata until spawn, and the pump (spawns on slot release)
- [ ] 4.2 Gate semantics: belts evaluate at CALL time; spawn-time re-checks = target roster + draft gate + crew belt (tightening → honest error wake, never silent)
- [ ] 4.3 Owner death flushes queued wishes without spawning and terminalizes their journal records
- [ ] 4.4 Tests: 4th+ wish queues and spawns on slot release; bound refusal lists in-flight AND queued ids; roster-vanish honest wake; draft-tighten and crew-belt block at spawn; owner flush; queued-start emits a progress notice; cap number unchanged (3 running); retry×queue interplay (retry keeps its slot; queued wishes stay behind)
- [ ] 4.5 Full suite + typecheck green
- [ ] 4.6 Live replay: dispatch 5 essay sleepers from one session → 3 run + 2 queue → all 5 deliver their reports without human pacing
- [ ] 4.7 Docs + copy: TASK_DESCRIPTION and async-handle text rewritten (the hard-coded cap-3 refusal copy goes); README `FORGE_DISPATCH_QUEUE_MAX` row
- [ ] 4.8 Release the fold

## 5. Fold E — persisted journal + restart recovery (forge-subagents / Dispatch resilience)

- [ ] 5.1 Implement `src/dispatch-journal.ts`: append-only JSONL at workspace `.opencode/forge/dispatch-log.jsonl`, bounded at `FORGE_DISPATCH_JOURNAL_MAX` (default 200); rotation compacts TERMINAL records only and never removes a non-terminal record; per-state record fields; prompt retained while a record is non-terminal (journal = only prompt source after restart), redacted on terminal; corrupt lines tolerated (skip + continue)
- [ ] 5.2 Emit journal entries on every state transition (dispatched, queued, started, retry-pending, terminal); owner-death queue flush terminalizes queued records
- [ ] 5.3 Implement per-state init recovery, scoped to the launch-anchor workspace at init + lazy per-workspace on first session: running (alive → re-arm; done → fetch + wake; gone → honest terminal), queued (owner resolves → re-enter queue; else terminal + ledger), retry-pending (attempts remain → respawn; else terminal); corrupt JSONL line tolerated (skip + continue)
- [ ] 5.4 Tests: transitions journaled; the three running branches; queued branch both ways; retry-pending branch both ways; rotation keeps non-terminal records; corrupt line tolerated; owner flush terminalizes queued records; lazy per-workspace recovery scope (non-anchor workspace recovers on its first session)
- [ ] 5.5 Full suite + typecheck green
- [ ] 5.6 Live replay: dispatch a long sleeper, kill the serve process mid-flight, restart with the same workspace config → the report arrives on the new host without re-dispatch
- [ ] 5.7 Docs: README fixes the "dispatch ledger — no longer written" row, adds the journal ledger entry + uninstall-residue note + `FORGE_DISPATCH_JOURNAL_MAX` knob row
- [ ] 5.8 Release the fold

## 6. Umbrella close

- [ ] 6.1 Update `../opencode-plugin-dev-pitfalls.md` with the headless-gate root cause (config hook clobbers explicit allow — :3427/:3910) and new serve-protocol lessons
- [ ] 6.2 Cross-fold regression pass: full suite, live replay of the five-fold happy path in one session
- [ ] 6.3 Acceptance document + archive this change (user-confirmed) — the declared end of the per-fold deviation window
