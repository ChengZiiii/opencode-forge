# Research: crew-wave visibility into host-native subagents (in-flight gate for the idle-continuation engine)

**Date:** 2026-11-23 · **Repo:** `opencode-forge` · **Status:** research only — no code changed
**Question:** while a host-native `task`/`subagent` child of the orchestrator session is running, the crew-waves engine sees idle+empty (our dispatch registry doesn't cover native children) and keeps sending `[forge:crew-continue]` briefs every idle turn. Which mechanism should make the engine aware "native children are still in flight"?

---

## 0. Executive summary

**Pick: M1+M2 hybrid — an event-fed native-child tracker (M2) reconciled against a decision-time session-tree walk (M1), with a bounded suppression ceiling.** This is not a compromise: it is the *literal architecture* of the most-verified v2 plugin that solves the identical problem (`@prevalentware/opencode-goal-plugin`'s `defer_while_tasks_active`), it is independently corroborated by `opencode-navigator` (verified against host 2.2.6 **and 2.3.2** — our host family), every surface it touches is officially documented (`ctx.event.subscribe`, `session.list` + `parentID` filter, `session.active`/status map), and M1's walk is already proven in our own codebase (`findChildByParentWalk`, `detectOrphanDispatchChildren`). M3 is dead (host-internal, verified in host source). M4 is restart-recovery only, not a live gate. The claim that per-session SSE endpoints exist (`/api/session/{id}/events`) is **false for our live host** (build 232, 142 paths — no such path); v2 events flow over one global `/api/event` stream that our plugin already consumes.

---

## 1. Per-candidate evidence

### M1 — Host session-tree walk (`session.list` filtered by `parentID` + active/status map)

**Official surface (documented, live-host verified):**
- `GET /api/session` (operationId `session.list`) supports a **`parentID` query parameter**: "Filter by parent session." — `C:\Users\Soren\AppData\Local\Temp\opencode\openapi-232.json` → `paths./api/session.get.parameters[name=parentID]`.
- `Session.Info` carries `parentID`, `agent`, `time.{created,updated,busy,idle,viewed}` and `outcome {succeeded|failed|interrupted}` — same file, `components.schemas.Session.Info`.
- `GET /api/session/active` (operationId `session.active`): returns map `sessionID → SessionActive{type:"running"}`; "Retrieve foreground Session drains currently owned by this OpenCode process. **Sessions absent from the result are inactive.**" — same file.
- Plugin docs: the plugin context "is essentially an OpenCode server client. Its read and action methods use the same inputs and responses as the client." — https://opencode.ai/v2/docs/build/plugins/server.md (§ Sessions).

**Community verification:**
- **opencode-goal-plugin (533★, 42 forks, npm 0.1.101, CI-published since 0.1.1, dedicated `bun run smoke:v2` against a real private v2 server)** runs an M1 walk **at every continuation decision**, not on a timer alone: `taskBlockStatus()` → `await taskTracker.refreshLiveChildren(client, sessionID)` (lists children, reads the status map, marks busy→running / idle→terminal / absent→short-lived "snapshot idle hold") before evaluating `hasBlockingTasks()` — shipped code, `dist/server.js` lines 3473–3507 and 4023–4031 of the published tarball (https://registry.npmjs.org/@prevalentware/opencode-goal-plugin/-/opencode-goal-plugin-0.1.101.tgz). README: "A deferral re-checks child sessions on a short timer, so a goal deferred by a task never depends on a further idle event to resume."
- **opencode-navigator** (npm `opencode-navigator` 1.1.0; dual 1.x/2.x; CI floors **2.2.6**, latest verified endpoint **2.3.2** — same host family as ours) documents in `HOST_API.md` (https://github.com/St1ggy/opencode-navigator/blob/main/HOST_API.md, § Focused Navigator Implementations): "**Subagent child discovery** — Published TUI Data caches sessions but has no complete children-sync operation. Initial/manual/reconnect discovery uses **the public paginated API** and syncs unknown IDs into the host cache." Its subagent panel is built from "Native session cache/status, execution start time and typed execution events" (§ Host-Owned Services).
- **Our own plugin** ships the same walk shape in production: `findChildByParentWalk` (`plugin.ts:3857-3879`, list-shape tolerance `array | {sessions} | {data}`, newest-created wins, proven on 2.3.2 per its comment) and `detectOrphanDispatchChildren` (`plugin.ts:4008-4061`): one `session.list` walk + `client.session.status()` active-map read as the ONLY streaming classifier.

**Race-freedom for an idle-gate:** a snapshot walk is a point-in-time read taken *at the decision point* — that is precisely what makes it race-free *enough*: any child that started before the walk is visible, and the check runs after the idle edge (the parent's turn already ended, so no new native child can be spawned by that turn afterwards). The residual race (child created between idle-edge and walk) closes on the *next* idle edge, because the host **wakes the parent when a child reports** (see §2 "wake semantics"). The goal-plugin belt-and-braces this with a re-check timer; the wake semantics make that optional for us.

### M2 — Event subscription (`ctx.event.subscribe` to `session.created` / `session.execution.*` / `session.status` / `session.idle`)

**Official surface:** `ctx.event.subscribe({types?, signal?})` returns an `AsyncIterable` of typed server events — https://opencode.ai/v2/docs/build/plugins/server.md (§ Events). Event schemas exist in the live-host snapshot: `session.created` (with `parentID` on the session payload), `session.execution.{started,succeeded,failed,interrupted}`, `session.status` (`SessionStatusUpdated.data = {sessionID, status:{type: idle|busy|retry}}`), `session.idle` (`{sessionID}`) — `openapi-232.json` `components.schemas`.

**Correction to the mission premise:** there is **no `/api/session/{id}/events` path** in the live-host snapshot (all 142 paths enumerated; the only SSE endpoint is the **global** `GET /api/event`, described as "Volatile by contract: a slow consumer overflows and fails the stream, and events during disconnection are missed"). Per-session SSE is not the v2 mechanism; the plugin-context subscription (which our `v2SubscribeEvents`, `plugin.ts:8888-9010`, already consumes with self-healing re-subscribe, task 3.4) is the one true stream. Volatility ⇒ an event-fed set alone is NOT race-free — it must be reconciled by M1 at decision time. (Our own host notes: `session.idle` exists in the schema but is not emitted on 2.3.2; `session.execution.succeeded` is the observed idle edge — `plugin.ts:8871-8876`.)

**Community verification:**
- **opencode-goal-plugin, V2 event wiring** (`dist/server.js:5323-5419`, `handleV2Event`): `session.created` with `data.parentID` → `taskTracker.observeSessionCreated` → `markRunning(parentID, childID)` — **this is how a native subagent spawn is first seen, including cross-location**; `session.execution.started` → busy; `session.execution.succeeded/failed/interrupted` + `session.idle` → idle/terminal; `session.status` → status; `session.deleted` → cleanup. The tracker (`dist/server.js:3337-3602`) keeps per-child `{state: running|terminal, runningSince, terminalAt, terminalUnreconciled}`; `hasBlockingTasks(parent, maxBlockMs)` (`:3445-3461`) returns true while any child is `running` **or terminal-but-unreconciled** (child finished, parent hasn't produced an assistant turn after it), with a wall-clock ceiling `taskBlockExpired` (`:3289-3294`) = `max_task_block_seconds` (default 900s). README (https://github.com/prevalentWare/opencode-goal-plugin): "when enabled, goal auto-continuation waits for active OpenCode Task child sessions and their orchestrator reconciliation before sending the next goal prompt"; the gate is applied **both at schedule time and immediately before delivery** (`:4089`, `:4337-4350`).
- **opencode-navigator**: "typed execution events" + native status for the live subagent panel (HOST_API.md, above); "The prior execution's `idle`/`outcome` never completes a currently running execution" — i.e. events maintain the set, status/time-busy arbitrate.

**Wake semantics (why suppression is safe — no stall-by-suppression):** official docs, https://opencode.ai/v2/docs/agents (§ Modes): "Subagents … always run in the background: **the parent receives a report when a child goes idle, and again after each later round of work.**" Same statement in the host API: `POST /api/session` `parentID` description ("the child sends a `<subagent>` report to the parent's inbox and wakes the parent unless it has a staged revert"), and the host tool itself returns "You will receive a `<background-result kind="subagent">` message when it goes idle" (`packages/core/src/tool/plugin/subagent.ts`, anomalyco/opencode@dev, blob sha `07a4cfb`). So when the last native child finishes, the host re-wakes the parent ⇒ a fresh execution ⇒ a fresh idle edge ⇒ our engine re-evaluates. Suppressing the nudge while children run removes noise, not the resume path.

### M3 — Host-native SubagentJob service (`jobs.block` + `{kind:"subagent", parentSessionID, childSessionID}` recovery)

**Verdict: host-internal. Dead for a third-party plugin.** Verified in host source (github.com/anomalyco/opencode, branch `dev`):
- `packages/core/src/session/subagent-job.ts` (blob sha `3e0d40a`): `SubagentJob.Service` is an Effect `Context.Tag("@opencode/SubagentJob")` built on internal `Job.Service` and `SessionExecution.Service`; `start(recovery)` = `jobs.start({id: childSessionID, type:"subagent", background: true, run: execution.resume(id)...})`.
- `packages/core/src/tool/plugin/subagent.ts` (blob sha `07a4cfb`) constructs exactly the recovery record named in the mission — `{kind:"subagent", parentSessionID: context.sessionID, childSessionID: child.id, agent, description}` — and returns `backgroundResult(child.id)` immediately.
- None of this appears on the public plugin context: the documented `SessionContext` reference (server.md § Sessions) has create/get/remove/context/switchAgent/switchModel/update/move/prompt/generate/command/compact/synthetic/interrupt/**wait** — no jobs domain, no subagent domain, no `session.children`. Navigator's HOST_API.md independently confirms the boundary posture: "internal host components are not plugin APIs." (First-party tools get Effect services; we run on the Promise client.)

### M4 — Transcript/message replay of the child (deferral state from persisted history)

**What the goal-plugin actually does (quote verified in README):** "After a plugin or server restart, V2 rebuilds Task-subagent deferral state by **replaying each non-closed goal session's persisted transcript**, because the V2 plugin context exposes no live child-session query; children that leave no finalized tool entry in the transcript are only observed through live events." Code: `TaskTracker.recoverFromTranscript` (`dist/server.js:3420-3443`) — parses finalized `task`/`subagent` tool entries for status markers; streaming/running entries are skipped.

**Assessment:** M4 is the community answer to a *different* question — cold-start reconstruction after a restart, explicitly acknowledged as lossy ("children that leave no finalized tool entry … only observed through live events"). As a live idle-gate it is strictly worse than M1 (heavier: transcript reads vs two API calls; lossier: no finalized entry ⇒ invisible). Keep as a possible future recovery leg for the crew engine only if we ever persist in-flight state; not the pick. (Our engine state is deliberately in-memory and the journal already recovers our OWN dispatches — native children need no journal because M1's walk sees them cold, any time, which is exactly what the goal-plugin's README laments not having on the v1 client but we DO have on v2 via `session.list?parentID` + `session.active`.)

### M5 (bonus, found during research) — `ctx.session.wait({sessionID})` / `POST /api/experimental/session/{sessionID}/wait`

"Wait for a session agent loop to become idle" (204 on success) — **documented on the plugin context**: "Rename, interrupt, or **wait** for a session … `await ctx.session.wait({ sessionID })`" (server.md § Sessions; `SessionContext.wait(input: ExperimentalSessionWaitInput)`). The goal-plugin uses it in production — but for a different job: holding `/goal` commands pending across continuations on ACP ("registered `/goal` … commands use the host's public session-wait API to remain pending across automatic continuations", `dist/server.js:5076-5085, 5201-5207, 5739-5742`). **No community precedent found** for using `wait()` as an idle-gate inside a debounced idle handler (it parks a promise per child; our engine's shape is guard-then-send, not await-then-send). Noted as the documented alternative for the "resume edge" if we ever want to replace the re-check timer, not as the gate itself.

---

## 2. Community targets — who was actually verified

| Target | Status | Mechanism found | Relevance |
| --- | --- | --- | --- |
| `@prevalentware/opencode-goal-plugin` (github.com/prevalentWare/opencode-goal-plugin, 533★; npm 0.1.101) | **Verified, production, v2-validated (own `smoke:v2` against a real v2 server)** | `defer_while_tasks_active` = M2 event tracker + M1 decision-time reconcile + 900s ceiling + M4 restart replay + `session.wait` for ACP command lifetime | **The direct precedent for our exact gap** — same host behavior, same idle-continuation engine shape. Note: README banner says opencode ≥2.2.1 ships native `/goal`; the deferral machinery remains the reference implementation. |
| `opencode-navigator` (github.com/St1ggy/opencode-navigator; npm 1.1.0) | **Verified, production; CI-checked on hosts 2.2.6 and 2.3.2** (README + HOST_API.md; e2e `smoke-opencode-v2.sh` since 0.15.0) | Live subagent panel from native session cache/status + typed execution events + public paginated session list for child discovery | **Second independent v2 confirmation of the same surfaces** (client-side observer, not a gate). |
| awesome-opencode list (github.com/awesome-opencode/awesome-opencode) | Scanned in full | Lists neither goal-plugin nor the three niche targets below; does list Subagent Reporter (`raisebeka/opencode-subagent-output` — repo 404 at research time, **not verified**) and orchestration plugins (Ensemble, Mission Control, Swarm) whose READMEs were not reachable for mechanism verification in this pass | No additional idle-gate precedent found on the list. |
| `beremaran/opencode-agent-tree` (npm unscoped name shows 0.1.0 unpublished; scoped `@beremaran/opencode-agent-tree` 0.9.1 exists per packages.ecosyste.ms; GitHub README fetch 404'd from this environment) | **Partially verified** (via third-party comparison doc `jcarlosrodicio/opencode-agent-orchestration-kit/docs/comparison.md`) | "An orchestrator-only agent decomposes every request and delegates all hands-on work through a configurable tree; the orchestrator reviews subagent reports" | Delegation inside model turns (tool-call/return driven) — **no idle-gate engine, different problem class**. No precedent for our gap. |
| `spoons-and-mirrors/subtask2` (npm 0.3.5, Jan 2026) | Verified to exist | "/command orchestration: queue prompts/commands/subagents with flow control" — v1-era (`"plugin": [...]` config, `@opencode-ai/plugin` v1 line) | Queueing/chaining, not idle-gating on v2. **No v2 idle-gate precedent.** |
| `spoons-and-mirrors/pocket-universe` (WIP) | Verified to exist | "extends the native opencode subagent paradigm … closed loop, resilient, async agents, **blocking main thread execution**" — v1-era | Await/blocking style — the opposite of an idle-gate. **No v2 idle-gate precedent.** |
| `opencode-navigator` (already above) | — | — | — |

**Explicit "no precedent found" callouts:**
1. **No plugin found that gates an idle-continuation engine on native children other than the goal-plugin** — i.e., the crew-waves application is novel, but its mechanism is squarely precedented (goal-plugin's `defer_while_tasks_active`).
2. **No per-session SSE endpoint** on our live host (`/api/session/{id}/events` does not exist among the 142 paths of `openapi-232.json`) — any design assuming it is wrong for build 232.
3. **No community use of `ctx.session.wait` as an idle-gate** (only as a command-lifetime hold).
4. **No public exposure of the SubagentJob/Job services** to plugins (M3 dead; host source + docs + Navigator's boundary doc all agree).
5. **raisebeka/opencode-subagent-output and the Ensemble/Mission Control/Swarm mechanism claims: unverified** (repos unfetchable from this environment in this pass) — flagged, not counted as evidence.

---

## 3. Ranked recommendation

| Rank | Candidate | Verification strength | Race-freedom for an idle-gate | Cost | Fit with our code |
| --- | --- | --- | --- | --- | --- |
| **1** | **M2+M1 hybrid (event-fed tracker, snapshot-reconciled at decision time, bounded ceiling)** | **Highest** — goal-plugin in production with real-host v2 smoke; navigator independently on 2.2.6/2.3.2; both surfaces officially documented | **Best** — events keep the set warm; the walk re-anchors truth *at the moment of decision*; ceiling bounds a lying view; host wake-on-child-report guarantees the resume edge | One subscription (already exists) + 2 API calls per idle decision | **Best** — reuses `v2SubscribeEvents`, `findChildByParentWalk` list-tolerance, and the exact `session.list`+`status` read of `detectOrphanDispatchChildren` |
| 2 | M1 alone (walk at decision time, no tracker) | High (goal-plugin does the walk at decision time too; our orphan walk is proven; documented surfaces) | Good — point-in-time read at the decision point; residual child-created-after-walk race closes on the next idle/wake | 2 API calls per idle decision; no per-child memory | Best — literally our existing walk |
| 3 | M2 alone (events only) | Medium-high (surfaces documented; goal-plugin feeds events) | **Poor alone** — `/api/event` is "volatile by contract"; our own code notes `session.idle` is not emitted on 2.3.2; a missed terminal event suppresses forever without a ceiling | Cheapest steady-state | Medium — extends `v2SubscribeEvents` we already run |
| 4 | M5 `ctx.session.wait` per child | Documented + goal-plugin production use (different purpose) | Good per child, but parks open promises; wrong shape for guard-then-send; N children ⇒ N waits | Low | Low — new pattern for us |
| 5 | M4 transcript replay | Goal-plugin uses it **only** for restart recovery, and calls out its blind spot | N/A as live gate | Heavy (transcript reads) | Low |
| ✗ | M3 SubagentJob / jobs.block | Host-internal (verified in source) — **no path for a third-party plugin** | — | — | — |

**Decision rule check (user-mandated):** the M1+M2 hybrid is used by **multiple independently-verified v2 plugins** (goal-plugin — server-side gate, own real-host v2 smoke; navigator — same surfaces for subagent visibility, CI-verified on 2.2.6 and 2.3.2) **and** every surface it touches is **officially documented** (`ctx.event.subscribe`, `session.list`/`parentID`, `session.active`/status, `Session.Info.parentID`). The pick satisfies the rule; M1-only is the acceptable minimal subset if we want the smallest possible change.

---

## 4. Integration sketch for the crew engine

**Scope:** `continueCrewIfEligible` only (`plugin.ts:6035-6118`). The goal branch keeps its semantics byte-identical (it has its own no-progress machinery; adopting the same gate there is a separate, spec-first change).

### 4.1 Where the check hooks

In `continueCrewIfEligible`, after the `crewStalled` (line 6046) and send-time family re-check (line 6053), **before** the crew no-progress accounting (line 6059) — a suppressed nudge must never be evaluated as a turn:

```
6046  if (crewStalled.has(sessionID)) return
6053  if (!sessionIsForgeFamily(sessionID)) return
      + // Native in-flight gate (this change):
      + if (await nativeChildrenInFlight(client, sessionID)) {
      +   goalProbe(`crew skip: native child in flight session=${sessionID}`)
      +   return   // BEFORE crewPendingTurn accounting — a suppressed nudge is
      +            // not a turn: no no-progress streak, no transport-failure count
      + }
6059  if (crewPendingTurn.has(sessionID)) { ... }
6081  // idle busy re-check (unchanged)
```

### 4.2 What it reads (two sources, M1 anchored on M2)

**Source A — decision-time walk (authoritative, the gate):** `nativeChildrenInFlight(client, sessionID)`:

1. `session.list({})` with the proven envelope tolerance (`plugin.ts:4013-4024` shape, same as `detectOrphanDispatchChildren`); keep entries with `parentID === sessionID`. (Host also supports server-side `?parentID=`; the tolerant client-side filter is what's already proven in this repo — use it.)
2. Read the active/status map exactly like `plugin.ts:4026-4035` (`client.session.status()`, unwrap `.data`, keys = busy session ids). **No child ids from step 1 present in the map ⇒ nothing in flight ⇒ gate open.** Any child present ⇒ suppressed.
3. **Fail-open, not fail-silent:** if `session.list` or the status read throws/unreadable → treat as *no children in flight* and send the nudge. Rationale: polarity differs from the orphan detector (there, a false "orphan" cries wolf; here, a false "in-flight" strands the crew — and a false "idle" costs only one redundant brief, the exact noise we already emit today). Ceiling (below) bounds even the pathological case.
4. **Bounded ceiling:** keep `Map<sessionID, firstSuppressedAt>`; while suppression persists past `FORGE_CREW_NATIVE_CHILD_CEILING_MS` (default `900_000`, mirroring goal-plugin's `max_task_block_seconds: 900`), stop suppressing for this crew registration, send once, and disclose one bounded `console.warn` (`[forge:crew-continue] native-child ceiling …`) — "a child that stays listed but never reports a terminal state … stops blocking once the ceiling passes" is the goal-plugin's exact anti-strand clause (README, `max_task_block_seconds`). A fresh `crew_begin` clears the marker (it already clears `crewStalled`).

**Source B — event-fed set (warm cache, optional accelerator + resume edge):** extend the existing `v2SubscribeEvents` loop (`plugin.ts:8888-9010`, currently routing `session.deleted` / `session.moved` / execution-terminal signals) with a small `NativeChildTracker`:
- `session.created` whose fields carry `parentID` → `mark(childID, parentID)` (goal-plugin `observeSessionCreated`, `dist/server.js:3368-3373, 5395-5400`);
- terminal edges for a known child (`session.execution.succeeded|failed|failed|interrupted`, `session.status` idle, `session.idle`) → mark terminal; `session.deleted` → drop;
- **resume edge:** when the last non-terminal native child of a session that the gate recently suppressed goes terminal, re-arm `scheduleIdleContinuation(client, sessionID)` (short debounce) — the goal-plugin's "a deferral … never depends on a further idle event to resume". This is belt-and-braces: the host's wake-on-child-report already produces a fresh idle edge (docs: "the parent receives a report when a child goes idle"; `POST /api/session` parentID description). The tracker is advisory only — **the walk (Source A) is the gate**; if the tracker disagrees with the walk, the walk wins.

### 4.3 Dampen semantics (exact rule)

> **The `[forge:crew-continue]` nudge is suppressed while ANY session whose `parentID` equals the orchestrator session id is present in the host's active/busy status map (non-idle, non-terminal); suppression is fail-open on unreadable views and bounded by a wall-clock ceiling after which one nudge is sent with a bounded disclosure. Suppressed nudges are not turns: they accrue no no-progress streak, no transport-failure count, and no crew ledger effect. When the last native child reaches a terminal state (event or walk), the idle continuation re-arms.**

Terminal = absent from the active map (host contract: "Sessions absent from the result are inactive") or `SessionStatus.type === "idle"`. We do **not** adopt the goal-plugin's stronger "terminal-but-unreconciled" hold (waiting for the parent's next assistant turn) — the host's native wake already delivers that turn to the parent; holding for it would duplicate the host's job.

### 4.4 State, spec, and tests

- **Zero disk state** — tracker + ceiling markers in-memory, matching the crew engine's discipline (`plugin.ts:5988-5994`); evicted by `crewEngineForgetSession` and `harvestSessionEnd` (session.deleted), which already clear crew state.
- **OpenSpec first** (repo rule): delta against `openspec/specs/crew-harness/spec.md` (the crew-continue paragraph, line ~235) adding the native-child gate, the ceiling, and the fail-open polarity.
- **Tests** — extend `tests/crew-continue.test.mjs` (stub-client pattern already stubs `session.status`, see `plugin.ts:6081-6092` usage): (1) idle + executing crew + busy native child (`session.list` returns a child with `parentID`; status map contains it) → **zero** briefs, no no-progress increment; (2) child terminal (absent from map) → exactly one brief after debounce; (3) ceiling expiry → one brief + one disclosure despite child still "busy"; (4) unreadable status view → brief sent (fail-open); (5) `session.deleted` of the parent evicts gate state; (6) goal-branch brief path unchanged (regression pin).

### 4.5 Risks / notes

- The status map only marks **running** sessions of *this* OpenCode process (`/api/session/active`: "foreground Session drains currently owned by this OpenCode process"); a native child queued-but-not-yet-started may be absent from the map for a moment. Consequence: one extra nudge in a rare window — identical to today's behavior, self-correcting on the next idle edge; not worth additional machinery.
- `session.idle` is schema-present but not emitted on our host (`plugin.ts:8871-8876`); keep it as a tolerated alias, never a dependency.
- The v1 port (`plugin.ts:7299, 7334` v1 handlers) can adopt the same tracker feed later; the walk itself is host-agnostic and already runs on both.

---

## 5. Source index

**Local (read-only):**
- `opencode-forge/plugin.ts:3857-3879` (`findChildByParentWalk`), `:4008-4061` (`detectOrphanDispatchChildren`), `:6035-6118` (`continueCrewIfEligible` — idle-nudge site), `:6181-6260` (`continueIfEligible` guard chain + crew branch), `:8849-8864` (`v2HandleIdle`), `:8888-9010` (`v2SubscribeEvents`), `:7299/7334` (v1 event ports)
- `C:\Users\Soren\AppData\Local\Temp\opencode\openapi-232.json` — `paths./api/session.get[parameters parentID]`, `paths./api/session/active`, `paths./api/experimental/session/{sessionID}/wait`, `paths./api/event`; `components.schemas.{Session.Info, SessionStatus, SessionStatusUpdated, session.idle}`; 142 paths enumerated — **no per-session events path**

**Host source (github.com/anomalyco/opencode, branch dev):**
- `packages/core/src/tool/plugin/subagent.ts` (blob `07a4cfb`) — background-result contract, recovery record, internal services
- `packages/core/src/session/subagent-job.ts` (blob `3e0d40a`) — `SubagentJob.Service` = internal `Context.Tag`

**Official docs:**
- https://opencode.ai/v2/docs/build/plugins/server.md — § Sessions (`ctx.session.list`/`wait`), § Events (`ctx.event.subscribe({types})`)
- https://opencode.ai/v2/docs/agents — § Modes: background subagents + parent-report-on-idle

**Community:**
- https://github.com/prevalentWare/opencode-goal-plugin (README: `defer_while_tasks_active`, `max_task_block_seconds`, transcript-replay sentence, session-wait usage) + `dist/server.js` of npm 0.1.101 (`TaskTracker` `:3337-3602`, `taskBlockStatus` `:4023-4031`, gates `:4089/:4337-4350`, `handleV2Event` `:5323-5419`, `recoverFromTranscript` `:3420-3443`)
- https://github.com/St1ggy/opencode-navigator (README + `HOST_API.md`: subagent discovery/observation on 2.2.6 & 2.3.2)
- https://github.com/jcarlosrodicio/opencode-agent-orchestration-kit/blob/master/docs/comparison.md (agent-tree pattern)
- https://github.com/spoons-and-mirrors/subtask2 · https://github.com/spoons-and-mirrors/pocket-universe (v1-era, no idle-gate precedent)
- https://github.com/awesome-opencode/awesome-opencode (full list scanned; no further idle-gate precedent)
