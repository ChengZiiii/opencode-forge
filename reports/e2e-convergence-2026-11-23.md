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

**TRIGGER A (process death + relaunch recovery): PASS (journal-recovery legs)**
- Session A dispatched `j-20261123-052623-u9qddc` (child
  `ses_df9215cc9ffew52hblIbboA2qB`, a deterministic 150 s shell-sleep canary).
- The sandbox host tree (pid 92516 — the port-47911 sandbox ONLY, killed via a
  scheduler-launched supervisor reading service.json; the user's real host was
  never touched) was SIGKILLed at 2026-11-23T05:28:01Z — journal at kill time:
  rows 31/32 `dispatched`→`started`, NO terminal (mid-flight kill verified:
  `logs/supervisor2.log` lines 1-5; host down ECONNREFUSED immediately after).
- Relaunch (same isolation layout + `FORGE_CREW_NATIVE_CHILD_CEILING_MS=60000`,
  verified live via `$env:FORGE_CREW_NATIVE_CHILD_CEILING_MS` inside the new
  host's own forge_shell child → `CEIL=[60000]`): new host pid 1912, new
  service id `16bd24a0-…`.
- Recovery: journal rows 33/34 (1795411687519) — the NEW host re-armed the
  non-terminal row watch-only (same task id, same child session id, no
  re-spawn). Honest settle + wake outcome recorded in the S3 addendum below.

## S3 — C5 crew-continue-native-child-gate sandbox E2E (tasks 4.2)

Setup: parent `ses_df927c9f2ffeZ7enHSURMFsczp`, agent forge; crew registered
PENDING + ARMED (waves) via two crew_begin calls (the one-call register+arm is
correctly refused: "cannot self-arm outside a governing goal" — that gate
works); crew "active … started 2026-11-23T05:20:04" confirmed.

**Leg (a) busy native child suppresses [forge:crew-continue]: FAIL (genuine
gate defect on live v2 hosts — not a driver artifact).**
- Deterministic busy child: `ses_df9241dccffeGZsorRvcgVqpwV` (parentID set,
  created via POST /api/session per the E3-verified surface) running a 75 s
  shell-sleep; verified executing (no idle row; host `GET /api/session/active`
  showed the child `{type:"running"}` and the list carries its parentID).
- During the busy window, TWO `[forge:crew-continue]` briefs were injected
  into the parent (user rows at 1795411428865 ≈ +25 s and 1795411444054 ≈ +40 s
  of the child's execution) — the suppression contract of task 3.1/4.2a was
  violated twice, with runtime proof the child was running.
- Root cause (code evidence): the gate calls
  `nativeChildrenInFlight(client, sessionID)` (dist/index.js:22146) which
  needs `client.session.list` and `client.session.status`
  (dist/index.js:15143/15158). The idle path passes the v2 goalClient =
  `v2SessionClient(ctx)` (plugin.ts:9580-9583), whose session domain exposes
  only prompt/promptAsync/get/create/messages/abort (plugin.ts:8780-8795) —
  **no `list`, no `status`** → `list?.({})` is undefined → children=[] →
  returns false (fail-open) → the gate is a structural no-op on live v2 hosts.
  The wiring tests (3.1-3.7) pass because their fake client stub PROVIDES
  list+status; the real v2 client never does.
- Secondary observation: the brief after the first probe child's terminal
  carried NO "Native child outcomes" digest line — consistent with the design
  (digest rides only a re-armed brief after active suppression), but it is a
  cascade of the same dead gate.

**Leg (b) child terminal ⇒ exactly one brief + digest: CASCADE-NA.** The
"one brief per idle edge" half held (no duplicates), but the digest half is
untestable because suppression never engages (leg (a) root cause).

**Leg (c) ceiling (60 s, env verified =60000): CASCADE-NA.** The ceiling only
fires from INSIDE an active suppression streak (`firstSuppressedAt` is set
only when the gate suppresses, dist:22156-22157) — with the gate no-op, no
ceiling can ever fire on a live v2 host. (Also D6: the relauncher's stderr
redirect did not materialize a log file, so the `console.warn` disclosure
line was not capturable regardless.)

**Leg (d) goal branch unaffected: D6 (blocked by design, not by the gate).**
`goal_write arm=true` from a plain session prompt is refused by the /goal
flow gate ("Only used inside the /goal flow … — never self-initiate"); the
sandbox has no headed /goal command surface, so this leg is unreachable
here. Backfill: drive `/goal` via the host command API or a goal-delegated
crew; deterministic coverage of record = tests 3.6 regression pin.

**Verdict: C5 E2E gate 4.2 = FAIL — the native-child gate needs a live v2
capability path (e.g. service.json HTTP `GET /api/session?parentID=` +
`GET /api/session/active`, the same discovery the dispatch view already
uses) or an event-tracker feed; until then suppression/digest/ceiling are
inert on real hosts. Unit layer (3.1-3.7) stays green — a wiring/capability
gap the stubs masked.**

## S4 — Final-build E2E (the build that goes to npm)

**Build identity.** `dist/index.js` 2026-11-23T16:55:16Z, newer than every
source it bundles (`plugin.ts` 16:50:10Z, `src/host-exit.ts` 16:49:51Z).
Typecheck green; full unit suite **1001/1001** at 16:52Z (996 + the five
kill-path regression tests of S5). No product code changed after the build.
Every verdict below was produced on this build by a host 2.4.0 sandbox started
at 16:55:57Z (pid 38344, port 47911). Evidence from earlier builds is kept
under the sandbox `logs\pre-final-build\` and is **not** counted. Drivers ran
strictly one at a time (`chain.mjs`).

| Change | Driver | Window (UTC, 2026-11-23) | Result |
| --- | --- | --- | --- |
| C4 fix-runtime-model-pin-variant | 13-pin-variant-e2e.mjs | 17:00:27–17:01:37 | **PASS 6/6** |
| C2 plan-close-verified | 14-plan-close-headless-e2e.mjs | 17:01:38–17:02:58 | **PASS 11/11** |
| C3 command-surface-v2-cleanup | 12-command-stop-e2e.mjs | 17:08:44–17:13:27 (run 2) | **PASS 16/16** |
| C1 fix-dispatch-dispose-kill | 11-dispose-e2e.mjs, legs K1 + K2 | 17:14:07–17:15:40 | **PASS** (both) |
| C1, leg D1 | 11-dispose-e2e.mjs | 17:16:18–17:19:37 | **BOOKED** — no dispose happened |

### C3 — command-surface-v2-cleanup: 16/16

- `GET /api/command` lists `forge`; no `forge-*` hyphen command exists.
- `POST /api/session/A/command {name:"forge", text:"stop"}` → 204. The template
  the host delivered carried `Argument: "stop"`; the model made the code call
  `tools.forge_jobs({action:"stop"})`; its output ended `… is confirmed idle
  (the cancellation is REAL, not bookkeeping)`.
- A's two dispatches: journal terminal `aborted`, reason `cancelled by the user
  lever (/forge stop) — the child was aborted and the dispatch is never
  retried` — the same string verbatim in both A wakes (`— ABORTED (task …)`),
  no "Final report:", no scaffolding, zero re-dispatch after terminal.
- B: `dispatched → started → terminal (completed)`, wake `Final report:
  CANARY-B-…`, zero aborted blocks; the children went idle soon after.
- Observation: `cancel "all"` is refused honestly and points at `stop`.

**Run 1 (16:56:25–17:00:27Z) — premise not met, not a product verdict.**
Owner A's turn never returned: 240 s, zero tool calls, zero journal rows. B,
created the same second on the same path, dispatched in 11 s, and C4 / C2
passed on the same build minutes later. Classified as an upstream model stall
and re-run on fresh sessions (run 2 above). The stalled session was retired by
the driver before its state was captured, and 2.4.0 keeps no trace of a
deleted session, so the stall itself cannot be post-mortemed; the driver now
snapshots the owner at timeout before retiring it (runbook lesson ⑫).

### C1 — fix-dispatch-dispose-kill: K1 PASS, K2 PASS, D1 BOOKED

- **K1 — owner deleted while the child is busy.** Journal terminal `aborted`,
  reason `registry kill (owner session ended / dispose) — user abort`; the
  ledger keeps the row (`owner session ended; registry kill issued (row kept
  for wake delivery …)`) and records the child's command tree going down
  (`owner session ended; tree killed …`); child session 404 afterwards. The
  wake half is not observable on a live host — the owner no longer exists, so
  the ABORTED wake has no inbox. Its wording is pinned by the dispatch-journal
  unit test; the same `jobWakeText` branch is observed live by K2.
- **K2 — the cancel lever.** Cancel output `… is confirmed idle (the
  cancellation is REAL, not bookkeeping)`; wake `— ABORTED (task …): cancelled
  by the user lever (/forge stop) — the child was aborted and the dispatch is
  never retried`; journal `aborted`, its reason verbatim equal to the wake,
  kill category `cancel` on both sides; no fake report, no scaffolding. This is
  the leg that fell on the previous build with `error` + `[object Object]`
  (S5).
- **D1 — evict the owner location mid-dispatch: the behaviour held, the
  premise did not.** Evict → 204 at 17:16:22Z. Inside the leg's 195 s window:
  the control process trees of the evicted location (B) and of another
  location (C) both ran to their natural end; zero ledger lines since the
  evict; the dispatch was not disturbed — the wake arrived with
  `Final report: CANARY-D1…`, journal terminal `completed`, zero scaffolding,
  `F1_otherLocationTreeKilled: false`. But the plugin's own dispose hook
  **never ran**: `disposeHookProbe.ranInWindow: false`, zero probe lines — and
  zero dispose-hook / exit-matrix lines in the whole probe log for the
  final-build host's lifetime (read at 17:18:39Z). On host 2.4.0 the evict
  closes the location and re-bootstraps it at once (the owner location was
  loaded again 11 s later) while the old instance's shutdown stays held by one
  holder. With no dispose to exempt the row from there is **no verdict on the
  dispatch exemption: BOOKED** (workspace rule D6) — not a pass.

## S5 — Kill-path rework inside the approved contracts (C1 / C3)

**Symptom (previous build).** A cancelled or killed dispatch ended as `error`
with the reason `[object Object]`, was fed to the retry breaker, and its wake
did not name the lever. C3's probe run (16:27Z) fell at
`aAbortedWithLeverReason`; C1's K2 fell the same way.

**Root cause.** After the plugin aborts the child session, host 2.4.0 emits
`session.execution.failed` whose `error` is an object without `message`. The
old poll loop settled on `error` first and handed that object to the breaker;
`String(object)` rendered `[object Object]`.

**Fix** (`plugin.ts`, `src/host-exit.ts`):

- R1 — the kill ruling wins: `settleKilled()` settles a cancelled / killed
  dispatch as `aborted` before the poll's error branch can call it `error`.
- R2 — readable nested errors: `executionErrorDetail()` digs nested error
  objects (strings pass through, Error-likes read `Name: message`, an empty
  object yields the caller's fallback).
- R3 — v2 idle confirmation through the host's active-session view
  (`GET /api/session/active`; `activeSessionView`,
  `assertChildIdleAfterAbort`): v2 clients have no `session.status`.
- R4 — the wake names the lever: `USER_LEVER_ABORT_REASON` /
  `REGISTRY_KILL_ABORT_REASON`; journal reason and wake share one string.
- A read-only diagnostic probe, active only with `FORGE_GOAL_PROBE` set: the
  plugin dispose hook and the exit matrix each leave one line when they run.
  It produced the direct "the hook never ran" fact of D1 above.

**Tests** (5 new, suite 996 → 1001, all green):

1. cancel engine on a v2 client (no session.status): the idle assertion reads
   the host's HTTP active-session view — idle / resisted / unresolved
2. user cancel + the poll reads the child as ERROR: journaled ABORTED with the
   lever reason (never `error`); the wake names the lever
3. user cancel + the child looks FINISHED: still journaled ABORTED — a
   cancelled dispatch never reports completion
4. host terminal signal with a NESTED error object: the journal reason names
   the error (never [object Object])
5. executionErrorDetail: strings pass through, Error-likes read
   "Name: message", nested objects dig, an empty object yields the fallback

**Live, final build, host 2.4.0:** C3 16/16 and C1 K1 + K2 PASS (S4).


