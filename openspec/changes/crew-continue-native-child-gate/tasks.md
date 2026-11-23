# crew-continue-native-child-gate — tasks

## 1. Spec (this change)

- [x] 1.1 Four-piece set under `openspec/changes/crew-continue-native-child-gate/`
  (proposal / design / tasks / crew-harness delta), `npx openspec validate
  crew-continue-native-child-gate --strict` green.
- [x] 1.2 User approval gate before implementation (archive is a separate
  user-directed step).

## 2. Implementation

- [x] 2.1 `nativeChildrenInFlight` pure core (injectable client seam):
  session.list with the proven envelope tolerance (array | `{sessions}` |
  `{data}`), keep `parentID === sessionID`; cross-read
  `client.session.status()` (unwrap `.data`, keys = busy ids); any child
  present ⇒ in flight; terminal = absent from map or status type `idle`.
  Fail-OPEN on any throw/unreadable shape (returns "no children in flight").
  Evidence: src/native-child-gate.ts:31-73 (`nativeChildrenInFlight`).
- [x] 2.2 `NativeChildTracker` (pure core + event feed): `session.created`
  carrying parentID marks `(childID, parentID)`; terminal edges
  (`session.execution.succeeded|failed|interrupted`, `session.status`
  idle, `session.idle` tolerated alias) terminalize **with the terminal
  OUTCOME recorded (succeeded/failed/interrupted)**; `session.deleted`
  drops; last-child-terminal of a recently suppressed session re-arms
  `scheduleIdleContinuation` (short debounce) **and the re-armed brief
  carries a one-line digest per terminal child (child id + outcome) — an
  interrupted child is disclosed as dead the moment the plugin knows**.
  Advisory only.
  Evidence: src/native-child-gate.ts:76-152 (tracker + outcome
  classification + digest line); plugin.ts:6148-6209
  (`crewNoteNativeChildTerminal` re-arm + digest, `noteCrewNativeChildEvent`
  feed); brief digest plugin.ts:6216-6228 + 6329-6334 (rides the brief,
  cleared on delivery).
- [x] 2.3 Wire the tracker feed into the existing `v2SubscribeEvents` loop
  (plugin.ts:8888-9010) — no new subscription, no new stream.
  Evidence: plugin.ts:9123-9126 (single `noteCrewNativeChildEvent` call
  inside the existing event loop, after `v2EventFields`).
- [x] 2.4 Ceiling: `Map<sessionID, firstSuppressedAt>`; past
  `FORGE_CREW_NATIVE_CHILD_CEILING_MS` (default `900_000`) stop
  suppressing for the registration, send once, one bounded `console.warn`
  disclosure; fresh `crew_begin` clears the marker.
  Evidence: plugin.ts:6120+6127 (ceiling const + map), 6263-6287 (expiry →
  send-once + bounded warn + stop-suppressing); cleared by fresh
  crew_begin via `crewEngineForgetSession` (plugin.ts:5817 → 6102-6104).
- [x] 2.5 Gate hook in `continueCrewIfEligible`: after the `crewStalled`
  (plugin.ts:6046) and family re-check (:6053), BEFORE `crewPendingTurn`
  accounting (:6059) — a suppressed nudge is not a turn (no streak, no
  transport-failure count, no ledger effect).
  Evidence: plugin.ts:6255-6287 — after the family re-check (6250-6254),
  before the `crewPendingTurn` block (6288+); the suppressed `return`
  (6283) precedes all accounting.
- [x] 2.6 Eviction: gate state (tracker entries, ceiling markers) cleared
  in `crewEngineForget` + `harvestSessionEnd`; zero disk state. Goal
  branch untouched.
  Evidence: plugin.ts:6093-6105 (`crewEngineForgetSession` clears tracker
  rows via `forgetParent`, ceiling marker, digest); harvestSessionEnd
  calls it at plugin.ts:6665; child `session.deleted` drops its tracker
  row via the feed (plugin.ts:6179-6183). All state in-memory (no fs
  writes in the new code); goal branch (`continueIfEligible` goal leg)
  unmodified.

## 3. Tests (stub-client pattern; wiring in tests/native-child-gate-wiring.test.mjs, pure cores in tests/native-child-gate.test.mjs)

- [x] 3.1 Busy native child suppresses: idle + EXECUTING crew + native
  child (session.list returns child with matching parentID; status map
  contains it) ⇒ zero briefs, no no-progress increment across repeated
  idle edges.
  Evidence: tests/native-child-gate-wiring.test.mjs — "busy native child
  suppresses the crew brief — zero briefs, suppression is not a turn"
  (4 suppressed idle edges, then gate-open briefs on the very next idle —
  no stall, no transport cap).
- [x] 3.2 Child terminal ⇒ exactly one brief after debounce (child absent
  from status map / terminal event; re-arm fires once, not once per
  suppressed edge).
  Evidence: tests/native-child-gate-wiring.test.mjs — "last child terminal
  re-arms exactly ONE brief carrying the digest line" (3 suppressed edges
  → 1 re-armed brief with the digest; digest cleared on delivery).
- [x] 3.3 Ceiling expiry ⇒ one brief + one bounded disclosure despite the
  child still "busy" (clock seam advanced past 900_000); fresh crew_begin
  re-arms normal gating.
  Evidence: tests/native-child-gate-wiring.test.mjs — "suppression past
  the ceiling sends once with ONE bounded disclosure; fresh crew_begin
  re-arms gating" (setCrewNativeChildClockForTests, warns===1, fresh
  registration suppresses again).
- [x] 3.4 Unreadable status view ⇒ brief sent (fail-open): list throws /
  status throws / garbage envelopes each fall through to send.
  Evidence: tests/native-child-gate-wiring.test.mjs — "unreadable host
  view fails OPEN" (5 subcases: list throws, status throws, garbage list
  envelope, unreadable status body, session.list missing); pure-core
  fail-open cases in tests/native-child-gate.test.mjs ("walk: … ⇒ fail
  OPEN" ×6).
- [x] 3.5 `session.deleted` of the parent evicts gate state (tracker +
  ceiling marker); a later crew starts clean.
  Evidence: tests/native-child-gate-wiring.test.mjs — "session.deleted
  evicts tracker rows, ceiling marker and digest; a later crew starts
  clean" (v2WiringSeam map assertions + a clean-gate brief on a new
  session).
- [x] 3.6 Regression pin: goal-branch brief path byte-identical (native
  child in flight does not affect goal continuations).
  Evidence: tests/native-child-gate-wiring.test.mjs — "goal-branch brief
  path unchanged" (busy native child + goal-governed session ⇒ exactly
  the [forge:goal-continue] brief, no crew brief); baseline
  tests/crew-continue.test.mjs stays 11/11 green untouched.
- [x] 3.7 Aborted-child disclosure: child reaches terminal with outcome
  `interrupted` while suppression was active ⇒ re-arm brief fires promptly
  and carries the one-line digest (child id + `interrupted`) — the dead
  child is surfaced, never silently stranded.
  Evidence: tests/native-child-gate-wiring.test.mjs — "an INTERRUPTED
  child wakes the crew — re-arm brief names the child dead" (brief names
  the child id + interrupted + DEAD); digest wording pinned in
  tests/native-child-gate.test.mjs ("digest line: an INTERRUPTED child is
  named DEAD …").

## 4. Verification

- [ ] 4.1 `bun run typecheck`, full `node --test` suite green, `bun run
  bundle`, dist committed.
- [ ] 4.2 Sandbox E2E (armed crew + native child): (a) native child in
  flight ⇒ briefs suppressed across idle edges; (b) child terminal ⇒
  exactly one brief; (c) ceiling ⇒ one brief + the disclosure line in the
  host log; (d) goal branch unaffected alongside.

## 5. Release & wrap

- [ ] 5.1 Rides the coordinated 0.33.0 combined release train (no
  independent version bump; publish is the owner's authorization domain).
- [ ] 5.2 Archive on user instruction (`openspec archive
  crew-continue-native-child-gate --yes`) after the ③/④ gates close.
