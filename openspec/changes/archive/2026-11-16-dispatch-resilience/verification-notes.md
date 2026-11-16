# Verification notes — dispatch-resilience

Archived: 2026-11-16. Releases: **0.24.0** (fold A) → **0.25.0/0.25.1** (fold B) →
**0.25.2** (fold B probe fix + fold C) → **0.25.3** (folds D+E) → **0.25.4**
(recovery D6 parity belt + TASK_DESCRIPTION queue copy). Full suite green at
every gate (578 → 611 → 630 tests, tsc exit 0).

## Per-fold acceptance evidence

### Fold A — headless ask liveness (0.24.0)
- Unit/wiring: serve→headless, run→NOT headless, env forces both ways; READ
  proceeds / WRITE refuses; explicit allow skips in all three modes; doors
  never auto-resolve; seal-before-headless ordering.
- Live (sandbox serves): read-class `forge_shell` completed headlessly; write-class
  returned the verbatim `[forge:headless-denied]` refusal with the file NOT
  created (negative proof); explicit-allow carve-out created the file
  (positive proof).
- Cross-fold regression (0.25.4, F27): read-class forge_shell ran headlessly
  in the five-fold happy-path session (FOLD-A-OK, exit 0, REST-verified).

### Fold B — activity-stale reap (0.25.0-0.25.2)
- Unit: 20 pure-core tests (threshold/refresh/floor/observe/anchor/abort-fail).
- Live: THREE independent reps on 0.25.2 (ses_e1cb66543 / ses_e1cb1e29 /
  ses_e1cac75e) — each silent sleeper reaped at the 60 s floor (env 15 s
  clamps UP) with the honest `stale: aborted after 1 min without activity`
  wake + task id.
- **0.25.2 fix**: the probe invoked `client.session.get` DESTRUCTURED (lost
  `this._client` → TypeError → probe null → fail-safe skip forever — the
  sweep was dead in production). Found via the `FORGE_DISPATCH_DEBUG=1` seam;
  fixed by bound-method invocation. Debug seam shipped (behavior-neutral).

### Fold C — retry with resume preamble (0.25.2)
- Unit: 20 pure-core classifier tests + 13 wiring tests (respawn/preamble/
  notice/attempt disclosure/cap/no-retry exclusions).
- Live FINDING (3.6, honestly left UNTICKED): on host 1.19.5 the agent loop
  ABSORBS transient errors (ai-sdk 2 stream retries per step + step-level
  looping — a malformed mock looped to step 2529), so a child never TERMINATES
  in an error message and the plugin retry branch has nothing to act on. The
  live play proved the recovery arc instead (dispatch completed honestly
  across a staged 503 outage, ses_e1c9eed0). Live trigger deferred until a
  host surfaces terminal child errors.

### Fold D — cap queueing (0.25.3)
- Unit: 20 queue tests (`tests/dispatch-queue.test.mjs`) + the cap/queue
  wiring test in `tests/dispatch-wiring.test.mjs`.
- Live (FORGE_DISPATCH_QUEUE_MAX=1, real glm children): 4 near-simultaneous
  dispatches → 3 ran (cap 3), the 4th got the verbatim `QUEUED (queue
  position 1)` handle and its journal went queued→started→terminal (pumped
  when a slot freed; all five reports delivered by wake); a 5th call inside
  the pressure window got the verbatim full-queue refusal listing all
  in-flight + queued ids + `queue is full (bound 1)` (REST/DB-verified,
  session ses_e1c64100cffenliY32l7ItDSSD).

### Fold E — persisted journal + restart recovery (0.25.3/0.25.4)
- Unit: 11 tests (`tests/dispatch-journal.test.mjs`) — pure core (parse/dedupe/
  corrupt-skip/rotation-keeps-non-terminal/knob matrix) + wiring through real
  server() boots with the journal seeded on the real disk (running re-arm +
  late-finish wake; finished-while-down exactly-one wake; gone honest
  terminal; queued both ways; retry-pending both ways; live-transition
  journaling + terminal prompt redaction; lazy per-workspace scope).
- Live: serve killed mid-flight, restarted on the same workspace → the journal
  survived, init recovery re-armed the running child, and the report
  (`JOURNAL-RECOVERY-REPORT`) arrived on the new host EXACTLY ONCE without
  re-dispatch (wake at +55 s post-restart). The instant-fetch branch stays
  unit-covered (its live trigger needs the kill inside the sub-poll-window
  after child completion — unreachable with real-model latency).
- 0.25.4 hardening: the recovery path now delivers the recovered wake
  immediately when the owner exists and is not mid-turn (a fresh host has no
  idle-edge memory; a failed send re-queues to the standard path). The normal
  dispatch path keeps its idle-edge contract untouched (two existing tests pin
  it; the belt was deliberately NOT added there).

## Umbrella close
- 6.1: pitfalls doc §4.6 (config-hook re-presentation root cause; SDK method
  destructuring loses `this`; host absorbs transient errors; driver-collection
  gremlins always lose to journal/DB/REST ground truth).
- 6.2: full suite 630/630 + one-session five-fold happy-path live replay on
  the flipped 0.25.4 store build (driver verdict FAILed on the `seen`
  early-skip gremlin while the DB truth was green — the §4.6 lesson, live).
- Honest ledger notes: 3.6 untriggerable live on host 1.19.5 (wiring-verified
  only); the F27/REP driver verdict lines are collection artifacts — all
  acceptance claims above cite REST/DB/journal evidence.
