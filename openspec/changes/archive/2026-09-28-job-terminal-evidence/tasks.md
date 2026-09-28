# Tasks — job-terminal-evidence

## 1. Supervisor core

- [ ] 1.1 `src/job-runner.ts`: the foreground resolution path stamps `terminalEvidence: true` on the job record when (and only when) the call returned because of the exit event; idle/max-wait/success/background starts leave it false. Verify: job-runner unit test — resolution-form → stamp mapping.
- [ ] 1.2 `src/job-manager.ts`: on completion of a `terminalEvidence` job — (a) remove it from the registry (fire-and-forget), (b) skip wake scheduling entirely; on completion of any other job — existing wake + retention semantics; `poll`/`kill`/`clear` on a removed id fail with "already consumed (output delivered with the original return)". Verify: job-manager unit tests — completion matrix (exit-consumed / idle-return / success-pattern / background), stale-id verbs.

## 2. Wiring

- [ ] 2.1 `tests/job-wiring.test.mjs`: hook-level coverage — a foreground exit-consumed forge_shell call produces no `[forge:job-complete]` injection and leaves `forge_jobs list` empty; an idle-returned job that completes while the session is idle still wakes once; success-pattern-then-exit still wakes. Verify: full suite green.

## 3. Docs

- [ ] 3.1 README: the forge_shell section gains the return-form → completion-behavior table (exit-consumed: no wake, self-cleared; still-running/background/success: wake + retained until clear); the `forge_jobs` clear verb note updates ("only early-returned/background jobs need clearing"). Verify: read-through matches implementation.

## 4. Verification

- [ ] 4.1 Full regression: `bun run typecheck` + `node --test tests/*.test.mjs` all green; `openspec validate --all` clean.
- [ ] 4.2 E2E (real environment, npm channel after release): positive path — a background job in an `opencode run` still delivers `[forge:job-complete]` to the idled session; foreground quick commands in the same run produce no wake lines in the transcript. Suppression itself is carried by unit evidence (2.1). Evidence appended to verify/e2e.md.
