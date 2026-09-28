# E2E — job-terminal-evidence (0.7.0, npm mode, 2026-09-28)

Environment: real `opencode serve` (port 43121), workspace
`C:\Users\Soren\AppData\Local\Temp\opencode\job-wake-e2e\ws`, global config
npm plugin mode → cached `@sorenllm/opencode-forge@0.7.0` (dist verified to
contain the new logic: `terminalEvidence` / `already consumed` /
`self-cleared` strings present). Driver:
`scripts/job-wake-e2e.mjs` (SSE consumer: idles + permission auto-approve +
assistant text parts). Model: `opencode/ling-3.0-flash-fin-free`.

## Phase A — negative path (synchronously consumed command)

Prompt: run `node -e "console.log('quick-e2e-ok')"` via forge_shell
(foreground), report the result verbatim, then `forge_jobs list`.

- Tool return captured verbatim in the transcript (new 0.7.0 wording):

  ```
  [forge:job] Command finished (exit=0).
  cwd: C:\Users\Soren\AppData\Local\Temp\opencode\job-wake-e2e\ws
  jobId: j-20260928-110607-7la2gf
  Output was delivered in full above — terminal evidence: the job self-cleared from the registry (no wake fires, no forge_jobs clear needed).
  output:
  quick-e2e-ok
  ```

- `forge_jobs list` right after two idles → `(no jobs)` — zero registry
  litter, no `clear` turn needed.
- Wake counter after the whole phase: **0** — no `[forge:job-complete]`
  ever arrived (under 0.6.0 this exact probe produced a wake + a manual
  clear turn, every time).

## Phase B — positive path (background job still wakes, exactly once)

Prompt: start `node -e "setTimeout(()=>{console.log('bg-e2e-done')},8000)"`
with `run_in_background=true`, poll it to completion, report, stop.

- The turn stayed busy through the polls; on its end-idle the deferred wake
  fired within ~3 s.
- Exactly **one** new `[forge:job-complete]` message; total wakes in the
  session: 1 (asserted `== before + 1`); the wake carried the job output
  (`bg-e2e-done` present in the session text).

## Verdict

PASS — negative path clean (no wake, no litter, self-cleaning return
text live), positive path intact (background completion still wakes the
idle owner exactly once, with output). Unit-level coverage of the full
resolution-form matrix (261/261 + 262/262 with forge-shell-mandate) carries
the remaining states (idle-return, success keep-alive/kill, spawn failure,
background spawn failure).

Ops note (recurring): publish → tarball CDN lag ~3.5 min this round
(`npm view` flipped at try 10 of 20 s polling; tarball E404 until install
try 7 of 30 s polling). The double-publish guard (409 "previously staged
version") remains the earliest truth signal.
