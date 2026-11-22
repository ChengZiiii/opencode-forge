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
