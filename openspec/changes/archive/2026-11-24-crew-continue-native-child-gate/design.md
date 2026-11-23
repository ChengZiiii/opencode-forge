# crew-continue-native-child-gate — design

- Evidence base: `reports/research-crew-wave-visibility.md` (§1 per-candidate
  evidence, §2 verified community targets, §3 ranking, §4 integration sketch,
  §5 source index) and `docs/pending-2026-11-22-user-items.md` §7 first
  bullet (the live-confirmed defect). Every mechanism claim below is anchored
  there; this design folds the research's §3 ranking and §4 sketch as its
  basis.

## D1. Mechanism pick — M2+M1 hybrid (research §3, rank 1)

| Rank | Candidate | Verification strength | Race-freedom | Cost | Fit |
| --- | --- | --- | --- | --- | --- |
| **1** | **M2+M1 hybrid (event-fed tracker, snapshot-reconciled at decision time, bounded ceiling)** | Highest — goal-plugin in production with real-host v2 smoke; navigator independently on 2.2.6/2.3.2; both surfaces officially documented | Best — events keep the set warm; the walk re-anchors truth at the decision moment; ceiling bounds a lying view; host wake-on-child-report guarantees the resume edge | One subscription (already exists) + 2 API calls per idle decision | Best — reuses `v2SubscribeEvents`, the `findChildByParentWalk` list-tolerance, and the exact `session.list`+`status` read of `detectOrphanDispatchChildren` |
| 2 | M1 alone (walk at decision time) | High | Good — residual child-created-after-walk race closes on next idle/wake | 2 API calls; no per-child memory | Best — literally our existing walk |
| 3 | M2 alone (events only) | Medium-high | Poor alone — `/api/event` is volatile by contract; `session.idle` not emitted on 2.3.2; a missed terminal suppresses forever without a ceiling | Cheapest | Medium |
| 4 | M5 `ctx.session.wait` per child | Documented, different purpose | Good per child; wrong shape (parks promises; guard-then-send engine) | Low | Low |
| 5 | M4 transcript replay | Goal-plugin uses it only for restart recovery, lossy | N/A as live gate | Heavy | Low |
| ✗ | M3 SubagentJob / jobs.block | Host-internal (verified in source) — no plugin path | — | — | — |

Decision-rule check: the hybrid is used by multiple independently-verified
v2 plugins (goal-plugin — server-side gate with its own `smoke:v2` against a
real v2 server; navigator — same surfaces for subagent visibility, CI-checked
on 2.2.6 and 2.3.2) and every surface it touches is officially documented
(`ctx.event.subscribe`, `session.list`/`parentID`, `session.active`/status
map, `Session.Info.parentID`). The pick satisfies the user's rule; M1-only is
the acceptable minimal subset if we ever need to shrink.

## D2. The gate — decision-time walk (authoritative)

`nativeChildrenInFlight(client, sessionID)` in `continueCrewIfEligible`:

1. `session.list({})` with the proven envelope tolerance (array | `{sessions}`
   | `{data}` — the `findChildByParentWalk` shape, plugin.ts:3857-3879, and
   `detectOrphanDispatchChildren` plugin.ts:4008-4061); keep entries with
   `parentID === sessionID`. The host also supports server-side `?parentID=`;
   the tolerant client-side filter is what is already proven in this repo.
2. Read the active/status map exactly like plugin.ts:4026-4035
   (`client.session.status()`, unwrap `.data`, keys = busy session ids).
   No child ids present in the map ⇒ nothing in flight ⇒ gate open. Any
   child present ⇒ suppressed. Terminal = absent from the active map (host
   contract: "Sessions absent from the result are inactive") or
   `SessionStatus.type === "idle"`.
3. **Fail-open, not fail-silent:** if `session.list` or the status read
   throws/unreadable ⇒ treat as no children in flight ⇒ send the nudge.

**Why fail-open here vs fail-closed in the orphan detector (polarity
asymmetry):** the two consumers pay opposite error costs. The orphan
detector's false positive cries wolf (kills/disposes a live child); its
fail-closed posture exists to never act on a child that might be healthy.
This gate's false positive (claiming children in flight when the view is
unreadable) STRANDS the crew — the engine would wait forever on a phantom
child, which is strictly worse than the defect being fixed. Its false
negative (claiming idle when a child is actually running) costs exactly one
redundant brief — the noise we already emit today. So the unreadable case
must resolve toward sending, and the ceiling (D4) bounds even the
pathological case where the view lies persistently in the other direction.

Race-freedom: the walk is a point-in-time read taken AT the decision point.
Any child started before the walk is visible; the check runs after the idle
edge, so the parent's just-finished turn cannot spawn a new native child
afterwards. The residual race (child created between idle edge and walk)
closes on the next idle edge because the host wakes the parent when a child
reports (official docs, agents § Modes: "the parent receives a report when a
child goes idle"). Suppression removes noise, never the resume path.

## D3. The warm set — NativeChildTracker (advisory)

Extend the existing `v2SubscribeEvents` loop (plugin.ts:8888-9010 — already
self-healing re-subscribe, already routing `session.deleted` /
`session.moved` / execution-terminal signals):

- `session.created` whose payload carries a `parentID` ⇒ mark
  `(childID, parentID)` running (goal-plugin `observeSessionCreated`
  precedent);
- terminal edges for a known child — `session.execution.succeeded | failed
  | interrupted`, `session.status` idle, `session.idle` (tolerated alias)
  ⇒ terminalize; `session.deleted` ⇒ drop;
- **resume edge:** when the last non-terminal native child of a session the
  gate recently suppressed goes terminal, re-arm
  `scheduleIdleContinuation(client, sessionID)` (short debounce) — the
  goal-plugin's "a deferral never depends on a further idle event to
  resume". Belt-and-braces: the host's wake-on-child-report already
  produces a fresh idle edge.
- The tracker is ADVISORY. On any disagreement between tracker and walk,
  the walk wins (the event stream is volatile by contract; a missed
  terminal event must never suppress forever — that is what the ceiling
  and the walk are for).

We do NOT adopt the goal-plugin's stronger "terminal-but-unreconciled" hold
(waiting for the parent's next assistant turn): the host's native wake
already delivers that turn to the parent; holding for it would duplicate
the host's job.

## D4. Bounded ceiling

`Map<sessionID, firstSuppressedAt>`; while suppression persists past
`FORGE_CREW_NATIVE_CHILD_CEILING_MS` (default `900_000` ms, mirroring the
goal-plugin's `max_task_block_seconds: 900`), stop suppressing for this
crew registration: send once + one bounded `console.warn` disclosure
(`[forge:crew-continue] native-child ceiling …` — "a child that stays
listed but never reports a terminal state stops blocking once the ceiling
passes" is the goal-plugin's exact anti-strand clause). A fresh `crew_begin`
clears the marker (it already clears `crewStalled`).

## D5. Hook site — suppressed nudges are not turns

In `continueCrewIfEligible` (plugin.ts:6035-6118), after the `crewStalled`
check (line 6046) and the send-time family re-check (line 6053), BEFORE the
crew no-progress accounting (`crewPendingTurn`, line 6059):

```
6046  if (crewStalled.has(sessionID)) return
6053  if (!sessionIsForgeFamily(sessionID)) return
      + if (await nativeChildrenInFlight(client, sessionID)) {
      +   goalProbe(`crew skip: native child in flight session=${sessionID}`)
      +   return   // BEFORE crewPendingTurn accounting — a suppressed nudge
      +            // is not a turn: no no-progress streak, no transport-
      +            // failure count, no crew ledger effect
      + }
6059  if (crewPendingTurn.has(sessionID)) { ... }
6081  // idle busy re-check (unchanged)
```

Rationale: a suppressed nudge never started a crew turn; counting it
toward the no-progress streak could stall a healthy crew purely because a
native child was running.

## D6. State, scope, and eviction

- Zero disk state — tracker + ceiling markers in-memory, matching the crew
  engine's discipline (plugin.ts:5988-5994). Evicted by
  `crewEngineForgetSession` and `harvestSessionEnd` (session.deleted),
  which already clear crew state.
- **Crew branch only.** The goal branch keeps its semantics byte-identical
  (own no-progress machinery; adopting the same gate there is a separate,
  spec-first change — noted as a possible future change, not done here).

## D7. Risks / notes (research §4.5)

- The status map only marks running sessions of THIS OpenCode process; a
  native child queued-but-not-yet-started may be absent from the map for a
  moment ⇒ one extra nudge in a rare window — identical to today's
  behavior, self-correcting on the next idle edge; not worth machinery.
- `session.idle` is schema-present but NOT emitted on host 2.3.2
  (plugin.ts:8871-8876 notes `session.execution.succeeded` as the observed
  idle edge): keep `session.idle` as a tolerated alias, never a dependency.
- The v1 ports (plugin.ts:7299, 7334 v1 handlers) can adopt the same
  tracker feed later; the walk itself is host-agnostic and already runs on
  both — v1 adoption is deferred, not designed here.

## D8. Live-host repair of the hollow gate (sandbox E2E 2026-11-23; host 2.3.2 → re-verified on 2.4.0)

Task 4.2's first live run failed: two `[forge:crew-continue]` briefs landed
while a native child was verifiably running, and the brief that did land
carried no outcome digest. Two independent root causes, both proven on the
live host before any code moved.

### D8.1 The walk was structurally empty — dedicated `nativeChildWalker`

The promise-layer `ctx.session` domain exposes neither `session.list` nor
`session.status`, so the adapter handed to the gate always walked an empty
view and failed OPEN (D2). Fix: the v2 adapter carries a DEDICATED walker
(`nativeChildWalker`) over the host's own HTTP surfaces, on the same
service.json channel the messages reader and the interrupt fallback already
ride:

- `GET /api/session?parentID=<id>&limit=500` — `session.list`; every row
  carries `parentID`. The default page is "the newest 50 sessions" and that
  cap applies to a parentID-filtered page TOO (a real 85-child parent
  answered 50 rows by default, all 85 with `limit=500`), hence the wider
  page; the client-side `parentID` filter in the pure core stays the
  semantic authority.
- `GET /api/session/active` — `session.active`: the bare map
  `{sessionID: {type:"running"}}`; a session absent from it is inactive.

Deliberately NOT `session.list`/`session.status` on the shared adapter:
other call sites probe those names with v1-shaped expectations, and adding
them there would silently change their behavior. Discovery is lazy per call
and every failure THROWS — the pure core fails OPEN (D2).

### D8.2 The digest lost every child created before the crew was armed

The digest authority was the event tracker alone, while a fresh
`crew_begin` registration wipes that parent's tracker rows
(`crewEngineForgetSession` → `forgetParent`) — so a child that was already
running when the crew was armed could never be named (live Leg B, round 1:
one brief, no digest; the engine log had `crew skip: native child in flight`
and no terminal line at all). Fix — **the walk is the single authority**:

- at each decision the walked in-flight children enter a per-registration
  watch set;
- when a watched child leaves the in-flight view, its outcome is read from
  its own session row (`outcome`: succeeded / failed / interrupted) and
  goes into the pending digest — first report wins, so an event and the
  walk observing the same child never name it twice;
- a row that is gone or carries no outcome (child deleted mid-run) is
  disclosed as UNVERIFIED, never given a verdict;
- terminal events are accelerators only: they can settle a watched child
  early; they can no longer be the only source.

### D8.3 Suppression re-check (bounded timer)

While the gate holds a crew, an unref'd interval (default
`FORGE_CREW_NATIVE_CHILD_RECHECK_MS=5000`) re-walks the view and schedules
the shared continuation when no child is in flight or the ceiling (D4) has
passed. The resume therefore never depends on a further idle edge or on an
event reaching the plugin: a child deleted mid-run (no terminal edge, and
the host need not wake the parent) and the ceiling are both covered. The
timer is stopped on send and evicted with the rest of the registration.

### D8.4 Send-time busy check on a host without `session.status`

The busy re-check before send used the session status surface, which the v2
adapter does not have. It now reads the orchestrator's own entry in the
walker's active map: a brief is never injected into a session that is
mid-turn; an unreadable map leaves the prior behavior unchanged.

### D8.5 Aborted-child disclosure (defect B — found by the user in the night of 2026-11-23/24)

This section restates and extends the earlier "defect B coverage" note that
closed D7 (its text had been corrupted by an encoding accident and is
replaced by this one; nothing of it is dropped).

The 7-hour stall was two defects stacked. Defect A (the core of this
change): every suppressed nudge counted as a zero-action turn, and the
no-progress accounting stalled the engine for good (D1–D5). Defect B: a
wave child whose dispatch frame timed out was **aborted**, the completion
carried only an error, and the engine stalled again — both dispatch chains
died at once. The abort itself is host/harness territory the plugin cannot
prevent; what the plugin owes is that it is **never silent**: detection,
wake and disclosure. The tracker records each child's terminal **outcome**
(succeeded / failed / interrupted; terminal event, and the session row's
`outcome` on re-walk) and the re-armed brief carries one digest line per
terminal child — an `interrupted` child is named dead the moment the plugin
knows. Net effect with the gate active: child aborted → child leaves the
in-flight view → re-arm brief names `child ses_x interrupted — DEAD` → the
orchestrator re-dispatches. The harness-side visible-job chain remains
defense in depth. Out of scope: preventing a caller-initiated timeout abort.

### D8.6 Live evidence

Host 2.3.2, final dist, legs on `7-serve-gate.mjs` (ceiling 60 s,
`FORGE_GOAL_PROBE=1`); every leg uses its own parent and creates its child
BEFORE the crew is armed (the order that exposed D8.2):

| Leg | Result (2026-11-23 07:25–07:29 UTC) |
| --- | --- |
| B' child interrupted | PASS — 0 briefs before the abort; the first brief (33 s later) names `native child ses_… interrupted — DEAD`; exactly one brief names it |
| C ceiling 60 s | PASS — 8 completed idle edges before the ceiling, 0 briefs; with no further prompt from the driver the re-check resumed the crew 11.9 s after the ceiling; one disclosure in the host log |
| D child deleted mid-run | PASS — `DELETE` 204, no nudge and no idle edge from the driver; a brief 16.7 s later names the child; the host had woken the parent |
| A / B | round 1 not evaluable: the driver's arm prompt let the model register with `execution:"waves"` (refused — no governing goal), so no crew existed; re-run with the engine-verified arm on host 2.4.0 — see the task 4.2 evidence |

Host 2.4.0 baseline (2026-11-23): the OpenAPI diff 2.3.2 → 2.4.0 is +5
operations (job cancel, machine link/list/create/delete), 0 removed, 0
parameter changes; every route the walker, the messages reader and the E2E
driver use is unchanged.

### D8.7 Test hermeticity

The suite must never reach the user's real host. `discoverServiceHttp` used
to fall back to the real `~/.local/state/opencode/service.json` whenever a
test set neither `FORGE_SERVICE_FILE` nor `XDG_STATE_HOME` — on 2026-11-23
the full suite issued real GETs through that fallback. Inside the Node test
runner (`NODE_TEST_CONTEXT`, or `--test` in `execArgv` for
`--experimental-test-isolation=none`) the default location is now never
read: an unisolated test observes "no service", exactly what a machine
without opencode yields. Explicit fixtures stay honored and are never
shadowed by the refusal (it is not cached). There is deliberately NO
opt-out switch: a diagnostic that legitimately needs the real host runs
under plain `node`. Proof: `tests/service-discovery-hermetic.test.mjs` —
a counting fake host registered at the default location of a temp HOME
receives ZERO requests from the runner (all three channel users: messages
reader, walker, interrupt fallback) and exactly ONE from a plain `node`
child reading the same location — the control that keeps the guard honest
and confined.
