import test from "node:test"
import assert from "node:assert/strict"

// Pure-core unit coverage for src/native-child-gate.ts (change
// crew-continue-native-child-gate, tasks 2.1/2.2 → test wave item 8):
// nativeChildrenInFlight envelope tolerance + parentID filter + status-map
// cross-read + terminal=absent-or-idle + FAIL-OPEN polarity, and the
// NativeChildTracker mark / terminalize-with-outcome / drop / forgetParent
// transitions. No plugin.ts import — these cores are pure by contract.
const { nativeChildrenInFlight, createNativeChildTracker, nativeChildEventOutcome, nativeChildDigestLine } = await import("../src/native-child-gate.ts")

const PARENT = "ses_parent-1"
const CHILD = "ses_child-1"
const OTHER_CHILD = "ses_child-2" // belongs to a DIFFERENT parent
const STRANGER = "ses_stranger"

// ---------------------------------------------------------------------------
// nativeChildrenInFlight — envelope tolerance (array | {sessions} | {data}).
// ---------------------------------------------------------------------------
test("walk: bare-array session list envelope — busy child with matching parentID ⇒ in flight", async () => {
  const client = {
    session: {
      list: async () => [{ id: CHILD, parentID: PARENT }],
      status: async () => ({ data: { [CHILD]: { type: "running" } } }),
    },
  }
  assert.equal(await nativeChildrenInFlight(client, PARENT), true)
})

test("walk: {sessions:[…]} envelope — busy child ⇒ in flight", async () => {
  const client = {
    session: {
      list: async () => ({ sessions: [{ id: CHILD, parentID: PARENT }] }),
      status: async () => ({ data: { [CHILD]: { type: "running" } } }),
    },
  }
  assert.equal(await nativeChildrenInFlight(client, PARENT), true)
})

test("walk: {data:{sessions:[…]}} double-wrapped envelope — busy child ⇒ in flight", async () => {
  const client = {
    session: {
      list: async () => ({ data: { sessions: [{ id: CHILD, parentID: PARENT }] } }),
      status: async () => ({ data: { [CHILD]: { type: "running" } } }),
    },
  }
  assert.equal(await nativeChildrenInFlight(client, PARENT), true)
})

test("walk: parentID filter — children of OTHER parents and id-less entries never match", async () => {
  const client = {
    session: {
      list: async () => [{ id: OTHER_CHILD, parentID: "ses_someone-else" }, { parentID: PARENT }, { id: STRANGER }],
      status: async () => ({ data: { [OTHER_CHILD]: { type: "running" }, [STRANGER]: { type: "running" } } }),
    },
  }
  assert.equal(await nativeChildrenInFlight(client, PARENT), false, "no entry with parentID === sessionID ⇒ gate open")
})

// ---------------------------------------------------------------------------
// Status-map cross-read; terminal = absent from the map OR type "idle".
// ---------------------------------------------------------------------------
test("walk: child present in the status map with a non-idle type ⇒ in flight (suppressed)", async () => {
  const client = {
    session: {
      list: async () => ({ sessions: [{ id: CHILD, parentID: PARENT }] }),
      status: async () => ({ data: { [CHILD]: { type: "running" } } }),
    },
  }
  assert.equal(await nativeChildrenInFlight(client, PARENT), true)
})

test("walk: child ABSENT from the active status map ⇒ terminal ⇒ gate open", async () => {
  const client = {
    session: {
      list: async () => ({ sessions: [{ id: CHILD, parentID: PARENT }] }),
      status: async () => ({ data: { [STRANGER]: { type: "running" } } }),
    },
  }
  assert.equal(await nativeChildrenInFlight(client, PARENT), false)
})

test("walk: child in the status map with type idle ⇒ terminal ⇒ gate open", async () => {
  const client = {
    session: {
      list: async () => ({ sessions: [{ id: CHILD, parentID: PARENT }] }),
      status: async () => ({ data: { [CHILD]: { type: "idle" } } }),
    },
  }
  assert.equal(await nativeChildrenInFlight(client, PARENT), false)
})

// ---------------------------------------------------------------------------
// FAIL-OPEN polarity (design D2): any throw / unreadable shape / missing
// method ⇒ false (no children in flight → send the nudge).
// ---------------------------------------------------------------------------
test("walk: session.list throws ⇒ fail OPEN", async () => {
  const client = { session: { list: async () => { throw new Error("host list boom") }, status: async () => ({ data: { [CHILD]: { type: "running" } } }) } }
  assert.equal(await nativeChildrenInFlight(client, PARENT), false)
})

test("walk: session.status throws ⇒ fail OPEN", async () => {
  const client = { session: { list: async () => ({ sessions: [{ id: CHILD, parentID: PARENT }] }), status: async () => { throw new Error("host status boom") } } }
  assert.equal(await nativeChildrenInFlight(client, PARENT), false)
})

test("walk: unreadable status shape (no .data object) ⇒ fail OPEN", async () => {
  const client = { session: { list: async () => ({ sessions: [{ id: CHILD, parentID: PARENT }] }), status: async () => "garbage" } }
  assert.equal(await nativeChildrenInFlight(client, PARENT), false)
})

test("walk: garbage list envelope (no array, no .sessions) ⇒ no children ⇒ fail OPEN", async () => {
  const client = { session: { list: async () => ({ unexpected: true }), status: async () => ({ data: {} }) } }
  assert.equal(await nativeChildrenInFlight(client, PARENT), false)
})

test("walk: session.list absent ⇒ fail OPEN (the baseline stub-client posture)", async () => {
  const client = { session: { status: async () => ({ data: { [CHILD]: { type: "running" } } }) } }
  assert.equal(await nativeChildrenInFlight(client, PARENT), false)
})

test("walk: session.status absent while children are listed ⇒ fail OPEN", async () => {
  const client = { session: { list: async () => ({ sessions: [{ id: CHILD, parentID: PARENT }] }) } }
  assert.equal(await nativeChildrenInFlight(client, PARENT), false)
})

test("walk: empty sessionID ⇒ gate open without any host call", async () => {
  let called = false
  const client = { session: { list: async () => { called = true; return [] }, status: async () => ({ data: {} }) } }
  assert.equal(await nativeChildrenInFlight(client, ""), false)
  assert.equal(called, false)
})

// ---------------------------------------------------------------------------
// NativeChildTracker — mark / terminalize-with-outcome / drop / forgetParent.
// ---------------------------------------------------------------------------
test("tracker: mark + runningChildren; terminalize records the outcome and reports lastChildTerminal", async () => {
  const tr = createNativeChildTracker()
  tr.mark(CHILD, PARENT)
  tr.mark(OTHER_CHILD, PARENT)
  assert.deepEqual([...tr.runningChildren(PARENT)].sort(), [CHILD, OTHER_CHILD])
  const first = tr.terminalize(CHILD, "succeeded")
  assert.deepEqual(first, { parentID: PARENT, lastChildTerminal: false }, "one child still running")
  assert.equal(tr.runningChildren(PARENT).length, 1)
  const last = tr.terminalize(OTHER_CHILD, "interrupted")
  assert.deepEqual(last, { parentID: PARENT, lastChildTerminal: true }, "last non-terminal child gone")
  assert.equal(tr.runningChildren(PARENT).length, 0)
  // Outcome recorded per row.
  assert.equal(tr.rows().get(CHILD).outcome, "succeeded")
  assert.equal(tr.rows().get(OTHER_CHILD).outcome, "interrupted")
})

test("tracker: terminal verdicts are STICKY — a re-mark after terminalize never resurrects the row", async () => {
  const tr = createNativeChildTracker()
  tr.mark(CHILD, PARENT)
  tr.terminalize(CHILD, "failed")
  tr.mark(CHILD, PARENT) // late session.created replay: must not reset
  const row = tr.rows().get(CHILD)
  assert.equal(row.terminal, true)
  assert.equal(row.outcome, "failed")
  assert.deepEqual(tr.runningChildren(PARENT), [])
})

test("tracker: terminalize of an UNKNOWN child ⇒ null (flight-miss no-op)", async () => {
  const tr = createNativeChildTracker()
  assert.equal(tr.terminalize(STRANGER, "succeeded"), null)
})

test("tracker: terminalize is idempotent on the same outcome", async () => {
  const tr = createNativeChildTracker()
  tr.mark(CHILD, PARENT)
  const a = tr.terminalize(CHILD, "succeeded")
  const b = tr.terminalize(CHILD, "succeeded")
  assert.deepEqual(a, { parentID: PARENT, lastChildTerminal: true })
  assert.deepEqual(b, { parentID: PARENT, lastChildTerminal: true })
})

test("tracker: drop removes one child row (session.deleted of the child)", async () => {
  const tr = createNativeChildTracker()
  tr.mark(CHILD, PARENT)
  tr.mark(OTHER_CHILD, PARENT)
  tr.drop(CHILD)
  assert.equal(tr.rows().has(CHILD), false)
  assert.deepEqual(tr.runningChildren(PARENT), [OTHER_CHILD])
})

test("tracker: forgetParent evicts every row bound to the parent, keeps other parents' rows", async () => {
  const tr = createNativeChildTracker()
  const otherParent = "ses_parent-2"
  tr.mark(CHILD, PARENT)
  tr.mark(OTHER_CHILD, otherParent)
  tr.forgetParent(PARENT)
  assert.equal(tr.rows().has(CHILD), false)
  assert.equal(tr.rows().has(OTHER_CHILD), true, "other parents untouched")
})

test("tracker: empty/guard inputs — mark with empty ids is a no-op", async () => {
  const tr = createNativeChildTracker()
  tr.mark("", PARENT)
  tr.mark(CHILD, "")
  assert.equal(tr.rows().size, 0)
})

// ---------------------------------------------------------------------------
// Outcome classification + digest line (D7 defect-B).
// ---------------------------------------------------------------------------
test("outcome classification: the three durable execution-terminal edges, null otherwise", async () => {
  assert.equal(nativeChildEventOutcome("session.execution.succeeded"), "succeeded")
  assert.equal(nativeChildEventOutcome("session.execution.failed"), "failed")
  assert.equal(nativeChildEventOutcome("session.execution.interrupted"), "interrupted")
  assert.equal(nativeChildEventOutcome("session.idle"), null)
  assert.equal(nativeChildEventOutcome("session.created"), null)
  assert.equal(nativeChildEventOutcome("whatever"), null)
})

test("digest line: succeeded/failed children get the terse id + outcome line", async () => {
  assert.equal(nativeChildDigestLine(CHILD, "succeeded"), `native child ${CHILD} succeeded`)
  assert.equal(nativeChildDigestLine(CHILD, "failed"), `native child ${CHILD} failed`)
})

test("digest line: an INTERRUPTED child is named DEAD the moment the plugin knows (D7 defect-B)", async () => {
  const line = nativeChildDigestLine(CHILD, "interrupted")
  assert.ok(line.includes(CHILD), "child id named")
  assert.match(line, /interrupted/, "outcome named")
  assert.match(line, /DEAD/, "dead disclosed")
})
