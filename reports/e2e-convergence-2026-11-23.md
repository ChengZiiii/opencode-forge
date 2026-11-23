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

## S2 — 3-driver re-run with the fixed assertion: **PASS**

Fresh parent `ses_df9331c07ffei7WZYf22tE4qRB` (same sandbox host 127.0.0.1:47911,
agent forge): P1 forge_sync OK → P2 async dispatch. First P2 attempt (r2)
exercised the PURE NATIVE task lane (no plugin dispatch row in the journal,
native `<subagent state="completed">` synthetic only — a legal alternative
channel, not a defect); P2b with an explicit `run_in_background=true`
instruction armed the PLUGIN lane: task `j-20261123-050908-hmm4hx`, child
`ses_df931273cffeoNbMU4FUqWgomI` (journal rows 13/14 dispatched→started).

Wake observed in the parent transcript (bare user row, top-level `text`):

```
[forge:dispatch-complete] task dispatch to forge-viewe2e-probe finished (task j-20261123-050908-hmm4hx, child session ses_df931273cffeoNbMU4FUqWgomI).
Final report:
VIEW-E2E-OK

Done: wrote "VIEW-E2E-OK 2026-11-23T05:09:08Z" to reports/view-report.md and delivered the final report to reports/j-20261123-050908-hmm4hx-report.md.
The dispatch is complete — read the report above; no polling, no re-dispatch needed.
```

- markerSeen=true, scaffoldSeen=false (zero `final message unavailable` /
  `is not a function` strings), report file written, exactly one plugin wake.
- Driver artifact `3-driver.mjs` patched in place (temp sandbox infra, not
  repo); verdict snapshot `logs/verdict-r2.json`.
- Confirms the fix-dispatch-view-capability ③ judgment channel AND that C1's
  wake-path rework left the happy path intact.

## S2 — 4-dispose-driver (C1 fix-dispatch-dispose-kill ③ GATE, D5 scenarios)

Executed leg-by-leg over HTTP against the same sandbox host (the driver's
`trigger` mode decomposed; every assertion re-verified from the journal file
and transcripts by this worker):

**TRIGGER B — dispose exemption (D5.1 / tasks 3.1): PASS**
- Session A `ses_df930bb6affejE7tcBt1M2nlAz` dispatched slow canary
  `j-20261123-050951-jrt0cj` (child `ses_df93080aeffe81n051LBbH0sze`,
  agent forge-viewe2e-coder, ~45 s).
- Second-context session B `ses_df92ffa89ffenxEvTChH4fBVDu` (directory
  `ws/ctx-b`) created → one turn → `DELETE /api/session/<B>` → **204**
  (context recycle / dispose trigger).
- After the dispose: A's dispatch SURVIVED. Wake in A's transcript:

  ```
  [forge:dispatch-complete] task dispatch to forge-viewe2e-coder finished (task j-20261123-050951-jrt0cj, child session ses_df93080aeffe81n051LBbH0sze).
  Final report:
  DISPOSE-E2E-OK-1795410700
  ...
  ```

- Journal line 18: `state=terminal, outcome=completed,
  reason=DISPOSE-E2E-OK-1795410700` — **no aborted terminal**, zero
  scaffolding. `Final report:` carries the child's own marker verbatim.

**Kill-path honesty (D5.2 / tasks 3.2): PASS (journal + ledger legs)**
- Session D `ses_df92d3c70ffeuJ930EsTYgDNt0` dispatched
  `j-20261123-051337-pgvi0g` (child `ses_df92d0de0ffebOssl3yCF0kCiv`,
  ~90 s); owner session DELETEd mid-flight (204).
- Journal line 24: `state=terminal, outcome=aborted, reason="registry kill
  (owner session ended / dispose) — user abort"` — honest aborted wording,
  no "(no output)", no fake `Final report:`.
- Ledger (`%TEMP%\opencode-forge\jobs\ledger.jsonl` line 3431):
  `"owner session ended; registry kill issued (row kept for wake delivery —
  was: dispatch forge-viewe2e-coder: owner death canary)"` — exactly C1's
  keep-semantics (the wake row is kept for delivery, not silently dropped).
- Wake delivery itself is structurally impossible to a deleted owner
  (promptAsync → gone session); the journal+ledger pair is the honest
  ground truth, matching the unit-suite owner-death pin semantics.

**Out-of-contract FINDING (recorded, not a gate failure): child session
deleted by a third party mid-flight**
- Probe: session C `ses_df92ec41effeBf8zTAAXe2Mp1c` dispatched
  `j-20261123-051208-w7pr81`; I DELETEd the CHILD
  `ses_df92e6b3bffebpcSeQT0I79HGO` mid-flight (204).
- Observed wake (in C): `… finished (task j-…-w7pr81 …).\nFinal report:\n
  (final message unavailable: session.messages failed: HTTP 404)` and
  journal line 21 `outcome=completed, reason="(final message unavailable:
  session.messages failed: HTTP 404)"`.
- Root cause: plugin.ts:4260-4263 — a host terminal signal of kind
  `succeeded` settles the dispatch, and an unreadable final-message read
  degrades to the `(final message unavailable: …)` scaffold text under a
  "finished" verdict. The native channel reported the child as
  `state="cancelled"`.
- Classification: NOT one of the D5 gate scenarios (neither dispose
  exemption nor plugin-routed kill; a host-side child DELETE never reaches
  `dispatchKillTreeHook`). It predates-nothing/changes-nothing in this
  release's five changes' paths, but the wording arguably brushes against
  fix-dispatch-view-capability's "no `(final message unavailable: …)`
  scaffolding" intent and C1's "never finished with a fake report"
  honesty rule. → Logged as a follow-up defect candidate (suggest: a 404
  on the final-message read after a `succeeded` signal should classify
  stream-lost/unknown or disclose cancellation, not "finished").

**TRIGGER A (process death + relaunch recovery): executed with the S3
ceiling relaunch — see S3 section.**

