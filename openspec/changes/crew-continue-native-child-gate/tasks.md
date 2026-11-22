# crew-continue-native-child-gate — tasks

## 1. Spec (this change)

- [x] 1.1 Four-piece set under `openspec/changes/crew-continue-native-child-gate/`
  (proposal / design / tasks / crew-harness delta), `npx openspec validate
  crew-continue-native-child-gate --strict` green.
- [x] 1.2 User approval gate before implementation (archive is a separate
  user-directed step).

## 2. Implementation

- [ ] 2.1 `nativeChildrenInFlight` pure core (injectable client seam):
  session.list with the proven envelope tolerance (array | `{sessions}` |
  `{data}`), keep `parentID === sessionID`; cross-read
  `client.session.status()` (unwrap `.data`, keys = busy ids); any child
  present ⇒ in flight; terminal = absent from map or status type `idle`.
  Fail-OPEN on any throw/unreadable shape (returns "no children in flight").
- [ ] 2.2 `NativeChildTracker` (pure core + event feed): `session.created`
  carrying parentID marks `(childID, parentID)`; terminal edges
  (`session.execution.succeeded|failed|interrupted`, `session.status`
  idle, `session.idle` tolerated alias) terminalize; `session.deleted`
  drops; last-child-terminal of a recently suppressed session re-arms
  `scheduleIdleContinuation` (short debounce). Advisory only.
- [ ] 2.3 Wire the tracker feed into the existing `v2SubscribeEvents` loop
  (plugin.ts:8888-9010) — no new subscription, no new stream.
- [ ] 2.4 Ceiling: `Map<sessionID, firstSuppressedAt>`; past
  `FORGE_CREW_NATIVE_CHILD_CEILING_MS` (default `900_000`) stop
  suppressing for the registration, send once, one bounded `console.warn`
  disclosure; fresh `crew_begin` clears the marker.
- [ ] 2.5 Gate hook in `continueCrewIfEligible`: after the `crewStalled`
  (plugin.ts:6046) and family re-check (:6053), BEFORE `crewPendingTurn`
  accounting (:6059) — a suppressed nudge is not a turn (no streak, no
  transport-failure count, no ledger effect).
- [ ] 2.6 Eviction: gate state (tracker entries, ceiling markers) cleared
  in `crewEngineForget` + `harvestSessionEnd`; zero disk state. Goal
  branch untouched.

## 3. Tests (`tests/crew-continue.test.mjs`, stub-client pattern)

- [ ] 3.1 Busy native child suppresses: idle + EXECUTING crew + native
  child (session.list returns child with matching parentID; status map
  contains it) ⇒ zero briefs, no no-progress increment across repeated
  idle edges.
- [ ] 3.2 Child terminal ⇒ exactly one brief after debounce (child absent
  from status map / terminal event; re-arm fires once, not once per
  suppressed edge).
- [ ] 3.3 Ceiling expiry ⇒ one brief + one bounded disclosure despite the
  child still "busy" (clock seam advanced past 900_000); fresh crew_begin
  re-arms normal gating.
- [ ] 3.4 Unreadable status view ⇒ brief sent (fail-open): list throws /
  status throws / garbage envelopes each fall through to send.
- [ ] 3.5 `session.deleted` of the parent evicts gate state (tracker +
  ceiling marker); a later crew starts clean.
- [ ] 3.6 Regression pin: goal-branch brief path byte-identical (native
  child in flight does not affect goal continuations).

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
