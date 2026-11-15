# Tasks: sync-timeout-notify

## 1. Specification

- [ ] Delta (MODIFIED Dispatch lifecycle — sync-timeout scenario gains the armed wake; arming + env knob SHALLs) written; strict validation passes

## 2. Engine (`src/dispatch-async.ts`)

- [ ] `DEFAULT_POLL_TIMEOUT_MS` tunable via `FORGE_DISPATCH_POLL_TIMEOUT_MS` (parse + clamp like the interval knob; default 600000 unchanged)
- [ ] Terminal-inference soundness in `pollChild`: status fetch failure / session missing from map ⇒ treated as ACTIVE; completed requires stable consecutive ticks (busy reading resets the counter; depth 3); finished message must have truthy `finish` AND non-empty text parts, else keep polling (ends as honest timeout)

## 3. Tool surface (`plugin.ts`)

- [ ] Sync timeout path: arm completion tracking (jobManager.create + dispatchTasks.set + runAsyncDispatchPoller) before throwing; timeout finding text discloses the armed wake; arming unconditional (cap bypass); metadata carries the task id as in the async path

## 4. Tests

- [ ] Sync timeout arms the wake: short-timeout poller expires → throw observed → child completes later → exactly one `[forge:dispatch-complete]` wake with the final report (fake client, deterministic)
- [ ] Arming bypasses the cap (async dispatches at cap + timed-out sync still arms)
- [ ] Timeout finding text names the child session id AND discloses the wake
- [ ] Env knob: unset → 600000; set → parsed value (clamped)
- [ ] Soundness matrix: status fetch failure mid-poll → no completion while a finished message exists (keeps polling, then real completion or timeout); session missing from map → same; receipt-then-busy-again → stability resets, no false completion; stable idle + finished textful message → completed after exactly the stability depth; idle + finished but textless message → polls to timeout; async wake inherits (completion detected only after stability)
- [ ] Full suite green; typecheck 0

## 5. Docs

- [ ] README: dispatch section timeout paragraph rewritten (armed wake on timeout); env knobs table gains `FORGE_DISPATCH_POLL_TIMEOUT_MS`

## 6. Release

- [ ] Version 0.23.1, typecheck, full suite, bundle, pack = 3 files, publish, store update (dual-layer + marker), push
- [ ] Live minimal repro (the E plan): sandbox serve with `FORGE_DISPATCH_POLL_TIMEOUT_MS=5000` + a child that sleeps ~15s → timeout finding at ~5s naming the child session, `[forge:dispatch-complete]` wake with the final report at ~15s — markers recorded in verify/acceptance-0-23-1.md
