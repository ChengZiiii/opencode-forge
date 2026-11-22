# crew-continue-native-child-gate

## Why

The crew-waves idle-continuation engine nudges `[forge:crew-continue]` on
session idle, but its in-flight accounting only sees OUR dispatch registry.
Subagents dispatched through the HOST-NATIVE task/subagent channel are
invisible to it (the native channel is not intercepted by the plugin —
re-confirmed live on 2026-11-23; `docs/pending-2026-11-22-user-items.md` §7
first bullet). So while a native child runs, the orchestrator session goes
idle between its own turns, the engine sees idle + an empty registry, and
every idle turn gets a spurious continuation brief. Practical impact today
is noise (the child's completion report independently re-wakes the parent,
and ordering belongs to the parent), but the engine is factually wrong
about the world and the design should be fixed.

Research (`reports/research-crew-wave-visibility.md`, decision basis) ranked
five candidate mechanisms against the user's decision rule (multiple
independently-verified v2 plugins + official surfaces only). The pick is
the **M2+M1 hybrid** — the literal architecture of the
`@prevalentware/opencode-goal-plugin`'s production `defer_while_tasks_active`
(own real-host v2 smoke), independently corroborated by `opencode-navigator`
(CI-verified on hosts 2.2.6 AND 2.3.2 — our host family), with every touched
surface officially documented (`session.list` + `parentID`, the
active/status map, `ctx.event.subscribe`), and the decision-time walk shape
already proven in this repo (`findChildByParentWalk` plugin.ts:3857-3879,
`detectOrphanDispatchChildren` plugin.ts:4008-4061, both on 2.3.2).

## What Changes

- **Gate (authoritative):** a decision-time session-tree walk inside
  `continueCrewIfEligible` — `session.list` entries with
  `parentID === orchestrator sessionID`, cross-read against the host's
  active/status map. ANY non-idle/non-terminal native child ⇒ the nudge is
  suppressed.
- **Warm set (advisory):** a `NativeChildTracker` fed by the existing
  `v2SubscribeEvents` loop (plugin.ts:8888-9010): `session.created` with a
  `parentID` marks a child; terminal edges (`session.execution.succeeded/
  failed/interrupted`, `session.status` idle, `session.idle` tolerated
  alias) terminalize; `session.deleted` drops; last-child-terminal re-arms
  the idle continuation. On disagreement between tracker and walk, the walk
  wins.
- **Fail-open polarity:** an unreadable list/status view is treated as
  "no children in flight" ⇒ send. A false in-flight strands the crew; a
  false idle costs one redundant brief — exactly today's noise.
- **Bounded ceiling:** per-session `firstSuppressedAt`; past
  `FORGE_CREW_NATIVE_CHILD_CEILING_MS` (default `900_000`, mirroring the
  goal-plugin's `max_task_block_seconds: 900`) the engine sends once and
  discloses one bounded `console.warn`. A fresh `crew_begin` clears the
  marker.
- **Suppressed nudges are not turns:** the gate hooks BEFORE the crew
  no-progress accounting — no streak, no transport-failure count, no ledger
  effect.
- **Zero disk state;** gate/tracker state is in-memory, evicted by
  `crewEngineForget` + `harvestSessionEnd`.
- **Scope:** crew branch only. The goal branch stays byte-identical (its
  own no-progress machinery is separate; adopting the same gate there is a
  possible future spec-first change, noted in design).

## Impact

- `specs/crew-harness/spec.md` — MODIFIED requirement "Waves-armed crews
  auto-advance on session idle": the native-child gate, ceiling, fail-open
  polarity, and not-a-turn semantics woven into the requirement prose; five
  NEW scenarios (busy child suppresses, terminal → one brief, ceiling
  expiry disclosure, fail-open on unreadable view, session.deleted
  eviction) alongside all six existing scenarios verbatim.
- `plugin.ts` — `nativeChildrenInFlight` walk (pure core + injectable
  client seam), `NativeChildTracker` extension of `v2SubscribeEvents`,
  ceiling map + disclosure, gate hook in `continueCrewIfEligible` after the
  stalled/family checks and before `crewPendingTurn` accounting; eviction
  wiring in `crewEngineForget`/`harvestSessionEnd`.
- `tests/crew-continue.test.mjs` — five new stub-client scenarios + a
  regression pin that the goal-branch brief path is unchanged.
- Release: rides the coordinated 0.33.0 combined release train (no version
  bump in this change's own tasks beyond that train).
