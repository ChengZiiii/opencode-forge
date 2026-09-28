# E2E — job-read-consumption (0.9.1, npm mode, 2026-09-28)

Environment: real `opencode serve` (port 43121), workspace
`C:\Users\Soren\AppData\Local\Temp\opencode\job-wake-e2e\ws`, global config
npm plugin mode → cached `@sorenllm/opencode-forge@0.9.1`. Driver:
`scripts/job-wake-e2e.mjs` (phase B rewritten for this change: B1 =
poll-to-terminal suppression, B2 = canonical unread notification).
Model: `opencode/ling-3.0-flash-fin-free`.

## Phase A — foreground quick command (unchanged, regression guard)

Inline delivery with the self-clearing return text; `forge_jobs list` →
`(no jobs)`; wakes so far: 0.

## Phase B1 — polled completion consumes itself (the change)

Background job (`bg-polled-done`, 3 s), the model polled repeatedly until a
poll reported exited:

- The terminal poll delivered the exit status and consumed the entry —
  the follow-up `forge_jobs list` → `(no jobs)`, no manual clear.
- No `[forge:job-complete]` fired during an 8 s idle observation window
  after the session went idle (double-notify suppressed).
- Model's final report quoted the terminal state (`exit 0`).

## Phase B2 — an unread completion still wakes, now pushed at completion time

Background job (`bg-unread-done`, 6 s); the model reported only the jobId
and ended its turn. Turn-end idle fired BEFORE the job exited.

- Live finding (recorded as design D6): under the old idle-edge-only
  delivery this wake had NO future trigger — it sat queued until the
  delivery window abandoned it (first 0.9.0 run failed exactly here).
- With 0.9.1's queue-time push: the wake arrived at completion time
  (11:59:56, ~2 s after exit) **without any subsequent idle edge**, exactly
  once, carrying the output.

## Verdict

PASS — the wake now fires only for completions never read (B2), poll-read
completions stay silent and self-clean (B1), inline deliveries unchanged
(A). 0.9.0 was published before D6 was discovered and is superseded by
0.9.1 (the change's release); unit coverage 268/268 carries the matrix.

Ops note: tarball CDN lag ~3 min (install try 6-7 of a 30 s retry loop)
for both 0.9.0 and 0.9.1.
