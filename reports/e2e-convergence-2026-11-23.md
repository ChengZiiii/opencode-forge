# E2E Convergence Wave — 2026-11-23 (S2 continuation → S4)

Worker: continuation subagent (prior worker died mid-S2 triage inspection).
Repo HEAD at start: `82cf4a9` (S1 = `1472a05`, 962 tests green).

Environment note (recorded verbatim): this worker's own `forge_shell` is broken —
every foreground call returns `spawn error: ENOENT: no such file or directory,
uv_spawn 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'`, and
`run_in_background` jobs are reaped instantly ("killed", empty log; the file
redirect proves the process never ran). The builtin shell is not in this
worker's toolset. Workaround used: all driver legs run over plain HTTP against
the sandbox host (fetch), and the few process-control/git commands are routed
through a `forge` session ON the sandbox host (whose plugin `forge_shell`
works), with every outcome independently re-verified from files/HTTP by this
worker — the model is transport only, never judge.

## S2 — Triage of the mixed 3-driver verdict

Prior worker's mixed verdict, quoted: "3-driver done but verdict is mixed —
worker report WAS written, TURN #3 fired, yet no `forge:dispatch-complete`
message found. Inspecting the session".

**Verdict: (b) STALE DRIVER EXPECTATION — a driver parsing bug, NOT a
regression from this release's five changes. Evidence:**

1. The parent session transcript (`ses_df9587d37ffeTwXYUs8oVprHEF`, sandbox
   host 127.0.0.1:47911, `/api/session/<sid>/message?limit=100`) contains
   msg index [2], a `user`-role row whose **top-level `text` field** reads:

   ```
   [forge:dispatch-complete] task dispatch to forge-viewe2e-probe finished (task j-20261123-042802-adfd0x, child session ses_df956c84effeQTMvWYHfj34f2Y).
   Final report:
   VIEW-E2E-OK

   Done: wrote `VIEW-E2E-OK 2026-11-23T04:28:02` to `reports/view-report.md`, and delivered the task report to `reports/j-20261123-042802-adfd0x-report.md` (both workspace-relative).
   The dispatch is complete — read the report above; no polling, no re-dispatch needed.
   ```

2. The wake was delivered exactly once, idle-only (created 1795408123990,
   immediately after TURN #2's idle edge; it triggered the follow-up assistant
   turn msg[1]), and carries the child's ACTUAL final report — the exact
   contract of `openspec/changes/fix-dispatch-view-capability/specs/forge-subagents/spec.md`
   lines 68-74 ("v2 wake carries the child's final report text … no
   `(final message unavailable: …)` scaffolding"). No scaffolding present.

3. Plugin journal ground truth `ws\.opencode\forge\dispatch-log.jsonl` line 12:
   `j-20261123-042802-adfd0x … state=terminal, outcome=completed,
   reason=VIEW-E2E-OK` — the dispatch honestly completed; C1's wake-path
   rework did not break the happy path (wake fired once, on idle, with the
   real report).

4. Why the driver missed it (`3-driver.mjs` bug, two folds):
   - Line 92: it extracts text only from `mm.parts ?? mm.content` filtered by
     `p.type === "text"` — but plugin-injected promptAsync user rows and the
     native synthetic row carry their text in the **top-level `text` field**
     (`keys=id,time,text,type`), so every user/synthetic row extracted as "".
   - Line 93: it then required `text.includes("forge:dispatch-complete")` on
     that always-empty string → `wakeBlock` stayed null for the full 300s poll
     (`logs/driver.log` line 17: "WAKE BLOCK: NOT DELIVERED within 300s";
     `logs/verdict.json`: `wakeDelivered:false` — a false negative).
   - Same class of bug as the driver's own ancestor note
     (acceptance-0-23-3.md pitfall 1: substring/shape traps in wake scanning).

5. TURN #3 (msg[3], 1795408096) was triggered by the HOST's native
   `<subagent state="completed">` synthetic (msg[4]) — a parallel, legal
   channel; the plugin wake (msg[2]) arrived seconds later on its own idle
   edge. Both channels observed, exactly one plugin wake.

Disposition: driver assertion fixed (top-level `text` fallback, same `textOf`
shape as `4-dispose-driver.mjs` line 34-40) and 3-driver re-run — outcome in
the next section.
