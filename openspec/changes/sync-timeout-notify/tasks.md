# Tasks: sync-timeout-notify

## 1. Specification

- [x] Delta (MODIFIED Dispatch lifecycle — sync-timeout scenario gains the armed wake; arming + env knob SHALLs) written; strict validation passes
- [x] Fold #2 delta (never-die tracking + progress notices + textless-idle floor + `FORGE_DISPATCH_NOTIFY_INTERVAL_MS`) written; strict validation passes

## 2. Engine (`src/dispatch-async.ts`)

- [x] `DEFAULT_POLL_TIMEOUT_MS` tunable via `FORGE_DISPATCH_POLL_TIMEOUT_MS` (parse + clamp like the interval knob; default 600000 unchanged)
- [x] Terminal-inference soundness in `pollChild`: status fetch failure / session missing from map ⇒ treated as ACTIVE; completed requires stable consecutive ticks (busy reading resets the counter; depth 3); finished message must have truthy `finish` AND non-empty text parts, else keep polling (ends as honest timeout)
- [x] `resolveNotifyIntervalMs`: `FORGE_DISPATCH_NOTIFY_INTERVAL_MS` parse + clamp (default 600000; independent of the sync-wait knob)

## 3. Tool surface (`plugin.ts`)

- [x] Sync timeout path: arm completion tracking (jobManager.create + dispatchTasks.set + runAsyncDispatchPoller) before throwing; timeout finding text discloses the armed wake; arming unconditional (cap bypass); metadata carries the task id as in the async path
- [x] `runAsyncDispatchPoller`: drop the deadline break — the loop ends only on completed / error / registry kill / textless-idle floor (continuous not-active streak ≥ notification interval with a textless latest finished message; busy readings reset)
- [x] Progress notices: at each notify-interval boundary while still running, append a `[forge:dispatch-progress]` notice to the job tail and park it on a plugin-side pending-progress queue flushed on owner idle edges (enqueue-while-idle delivers immediately); notices never touch markTerminal/wakeState; delivery failure-tolerant (progress is lossy)
- [x] Copy: task description + async handle text + ARMED sync-timeout text mention interim progress notices and the guaranteed final wake however long the child takes
- [x] README: rewrite the env-knob row that still calls the sync window "the async poller's overall watch deadline"; document `FORGE_DISPATCH_NOTIFY_INTERVAL_MS` and the progress-notice behavior in the dispatch section

## 4. Tests

- [x] Sync timeout arms the wake: short-timeout poller expires → throw observed → child completes later → exactly one `[forge:dispatch-complete]` wake with the final report (fake client, deterministic)
- [x] Arming bypasses the cap (async dispatches at cap + timed-out sync still arms)
- [x] Timeout finding text names the child session id AND discloses the wake
- [x] Env knob: unset → 600000; set → parsed value (clamped)
- [x] Soundness matrix: status fetch failure mid-poll → no completion while a finished message exists (keeps polling, then real completion or timeout); session missing from map → same; receipt-then-busy-again → stability resets, no false completion; stable idle + finished textful message → completed after exactly the stability depth; idle + finished but textless message → polls to timeout; async wake inherits (completion detected only after stability)
- [x] K3-shape regression (long child): child completes after ≥1 notify-interval boundary → ≥1 progress notice delivered AND the final `[forge:dispatch-complete]` wake with the real report arrives; exactly one terminal wake; progress notices carry no report text
- [x] K1b-shape regression (near-boundary race): child completes just inside a notification-interval boundary → report wake still arrives (no deadline break to lose the race against)
- [x] Textless-idle floor: idle + textless for one notify interval → honest no-reportable-final-message finding naming the child; busy re-appearance resets the streak
- [x] Notify knob: unset → 600000; set → parsed (clamped); independent of `FORGE_DISPATCH_POLL_TIMEOUT_MS` (sync wait unchanged)
- [x] Full suite green; typecheck 0

## 5. Docs

- [x] README: dispatch section timeout paragraph rewritten (armed wake on timeout); env knobs table gains `FORGE_DISPATCH_POLL_TIMEOUT_MS`

## 6. Release

- [x] Version 0.23.1, typecheck, full suite, bundle, pack = 3 files, publish, store update (dual-layer + marker), push
- [x] Live minimal repro (the E plan): sandbox serve with `FORGE_DISPATCH_POLL_TIMEOUT_MS=5000` + a child that sleeps ~15s → timeout finding at ~5s naming the child session, `[forge:dispatch-complete]` wake with the final report at ~15s — markers recorded in verify/acceptance-0-23-1.md
- [ ] Version 0.23.3, typecheck, full suite, bundle, pack = 3 files, publish, store update (dual-layer + markers), push
- [ ] Live repro (fold #2): sandbox serve with `FORGE_DISPATCH_NOTIFY_INTERVAL_MS` small + a child that runs past it → progress notice(s) observed while running, then the `[forge:dispatch-complete]` wake with the final report at completion — markers recorded in verify/
