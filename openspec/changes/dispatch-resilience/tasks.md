# Tasks: dispatch-resilience

## 0. Umbrella setup

- [x] 0.1 DONE — `sync-timeout-notify` archived as `2026-11-16-sync-timeout-notify` (its deltas are live in the spec)
- [ ] 0.2 Validate this change `bunx openspec validate dispatch-resilience --strict` (re-run after every artifact revision)

## 1. Fold A — headless ask liveness (tool-partition + job-supervisor carve-out)

- [ ] 1.1 Read the gate region (`plugin.ts:1640`), the classifier (`src/exec-classify.ts`), AND the config hook (`plugin.ts:3415-3428`) + permission.ask belt (`plugin.ts:3906-3911`) to pin the snapshot seam and the re-read trap (the hook mutates a merged config object that may be re-presented — never re-capture the plugin's own injected `ask`)
- [ ] 1.2 Implement headless detection: serve mode from host process argv + `FORGE_HEADLESS` override (1/0); `opencode run` mode is NOT headless (its auto-reject ask semantics unchanged); unit tests: serve→headless, run→NOT headless, env forces both ways
- [ ] 1.3 Implement the resolution order: config-hook snapshot of user-explicit values BEFORE posture rewriting; explicit allow skips the ask in both modes, explicit deny refuses; TUI default posture dialog unchanged; headless → READ-class proceeds, WRITE-class `[forge:headless-denied] <command head>`; doors = exactly the `gate()` call-site set (plan_approve, plan_close, goal_write arm, goal_complete, goal_resume, goal_discard, crew_close) never auto-resolved; seal finding lands before the headless denial
- [ ] 1.4 Tests: read-class proceeds headlessly; write-class refuses honestly; explicit allow skips the ask in TUI AND headless AND run mode (deny refuses everywhere); doors (incl. goal_discard) never auto-resolve; run mode keeps auto-reject for the default posture; seal-before-headless ordering; TUI default posture byte-identical (existing tests green)
- [ ] 1.5 Full suite + typecheck green
- [ ] 1.6 Live sandbox replay on the published build: headless child runs a read-class `forge_shell` command to completion (the previously-hanging shape); a write-class call returns the honest denial and the child still produces a final report; run-mode spot check unchanged
- [ ] 1.7 Docs: README `FORGE_HEADLESS` knob row + the headless bypass-surface disclosure (unclassifiable commands flow for write-shape workers); the job-supervisor carve-out ships with this fold's delta
- [ ] 1.8 Release the fold (version bump, publish, store install with cache clean, dual-layer verify, push)

## 2. Fold B — activity-stale reap (forge-subagents / Dispatch resilience)

- [ ] 2.1 Extend the `DispatchClient` seam with `session.get`; activity anchor = `time.updated` (part-level refresh), no-message anchor = dispatch start time
- [ ] 2.2 Implement the reap: `FORGE_DISPATCH_STALE_MS` (default 2700000, clamped to the 60 s floor), runtime floor, pre-kill re-read (refresh resets), existence probe (unresolved → skip sweep, missing → finalize), abort-failure posture (failed abort + session exists → skip and re-arm), honest terminal wake `stale: aborted after N min without activity`
- [ ] 2.3 Implement `FORGE_DISPATCH_STALE_MODE` = kill (default) | observe (ONE notice per threshold crossing, no kill)
- [ ] 2.4 Tests: reap after threshold with confirmed inactivity; refresh resets; observe notifies once per crossing without killing; floor blocks early reap; no-message child anchors at start; failed abort skips + re-arms; stale wake is the single terminal wake; textless-idle floor vs stale reap stay distinct (busy-missing vs busy-silent)
- [ ] 2.5 Full suite + typecheck green
- [ ] 2.6 Live replay (env-shortened threshold): a silent sleeper child is reaped with the honest wake; a continuously-producing child runs past the threshold untouched
- [ ] 2.7 Docs: README rows for `FORGE_DISPATCH_STALE_MS` / `FORGE_DISPATCH_STALE_MODE` (invalid → default; floor clamp)
- [ ] 2.8 Release the fold

## 3. Fold C — retry with resume preamble (forge-subagents / Dispatch resilience)

- [ ] 3.1 Port the error classifier (`src/dispatch-retry.ts`) with the vocabulary ENUMERATED: retryable = transient transport/5xx/overload/rate-limit patterns; deterministic = provider-configuration, auth, model-not-supported, contract patterns (ported terminal classes); unknown → not retried
- [ ] 3.2 Implement respawn: same agent, original prompt + inspect-then-continue preamble, `FORGE_DISPATCH_MAX_ATTEMPTS` default 2, fixed 10 s backoff, progress notice per retry, final wake discloses the attempt count, exactly one terminal wake; retry inherits the dying child's registry slot; dispatch-time policies (draft/crew mode-keyed denies) re-applied
- [ ] 3.3 Implement the no-retry exclusions: stale kills, user aborts, textless-idle floor, deterministic terminal classes
- [ ] 3.4 Tests: transient-class error respawns with preamble + notice + attempt disclosure; provider-config-class error does NOT retry; attempt cap honored; stale/abort/floor never retry; armed-sync retry's final wake names the new child session id
- [ ] 3.5 Full suite + typecheck green
- [ ] 3.6 Live replay: transient outage (proxy down for attempt 1, up for attempt 2) → recovered final report in ONE wake disclosing attempts; a provider-config-broken dispatch terminates honestly WITHOUT retrying
- [ ] 3.7 Docs: README `FORGE_DISPATCH_MAX_ATTEMPTS` row
- [ ] 3.8 Release the fold

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
