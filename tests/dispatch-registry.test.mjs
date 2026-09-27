import test from "node:test"
import assert from "node:assert/strict"

// Spec: Background dispatch mode + Completion wake briefs (tasks 3.1).
// The registry is a PURE state machine (D10): no I/O, no timers.
//   queued → running → completed | timeout | killed | error
//   delivered: every terminal state is delivered to the parent EXACTLY ONCE
//   even across repeated idle events (takeUndelivered is atomic).

import { createDispatchRegistry } from "../src/dispatch-registry.ts"

const ENTRY = { sessionID: "ses_child", identity: "a/b", depth: "low", tier: "quick", parentSessionID: "ses_parent" }

test("3.1: submit returns a unique dispatchId and queued state", () => {
  const reg = createDispatchRegistry()
  const a = reg.submit(ENTRY)
  const b = reg.submit({ ...ENTRY, sessionID: "ses_child2" })
  assert.ok(a.dispatchId && b.dispatchId && a.dispatchId !== b.dispatchId, "ids are unique")
  assert.equal(reg.get(a.dispatchId).state, "queued")
  assert.equal(reg.get(a.dispatchId).sessionID, "ses_child")
  assert.equal(reg.get(a.dispatchId).parentSessionID, "ses_parent")
})

test("3.1: legal transitions queued→running→terminal", () => {
  const reg = createDispatchRegistry()
  const { dispatchId } = reg.submit(ENTRY)
  assert.equal(reg.markRunning(dispatchId).state, "running")
  const res = { tier: "quick", text: "done", tokens: { input: 1 } }
  reg.markCompleted(dispatchId, res)
  assert.equal(reg.get(dispatchId).state, "completed")
  assert.equal(reg.get(dispatchId).result.text, "done")
})

test("3.1: every terminal state is reachable and recorded", () => {
  for (const [kind, call] of [
    ["timeout", (reg, id) => reg.markTimeout(id, { error: "timed out" })],
    ["error", (reg, id) => reg.markError(id, { error: "boom" })],
    ["killed", (reg, id) => reg.markKilled(id)],
  ]) {
    const reg = createDispatchRegistry()
    const { dispatchId } = reg.submit(ENTRY)
    reg.markRunning(dispatchId)
    call(reg, dispatchId)
    assert.equal(reg.get(dispatchId).state, kind, `${kind} terminal recorded`)
  }
})

test("3.1: illegal transitions are rejected (no silent overwrite)", () => {
  const reg = createDispatchRegistry()
  const { dispatchId } = reg.submit(ENTRY)
  assert.throws(() => reg.markCompleted("missing", {}), /unknown dispatch/)
  reg.markCompleted(dispatchId, { text: "done" })
  assert.throws(() => reg.markRunning(dispatchId), /illegal/)
  assert.throws(() => reg.markKilled(dispatchId), /illegal/)
  assert.throws(() => reg.markCompleted(dispatchId, { text: "again" }), /illegal/)

  const reg2 = createDispatchRegistry()
  const e2 = reg2.submit(ENTRY)
  reg2.markRunning(e2.dispatchId)
  assert.throws(() => reg2.markRunning(e2.dispatchId), /illegal/, "running→running is not a transition")
})

test("3.1: takeUndelivered is atomic — each terminal appears in exactly one take", () => {
  const reg = createDispatchRegistry()
  const a = reg.submit(ENTRY)
  const b = reg.submit({ ...ENTRY, sessionID: "ses_child2" })
  reg.markCompleted(a.dispatchId, { text: "a" })
  reg.markTimeout(b.dispatchId, { error: "late" })

  const first = reg.takeUndelivered()
  assert.equal(first.length, 2, "both terminals in one take")
  assert.deepEqual(first.map((e) => e.state).sort(), ["completed", "timeout"])
  assert.equal(reg.takeUndelivered().length, 0, "second take is empty (delivered exactly once)")
  assert.equal(reg.takeUndelivered().length, 0, "idempotent on repeated idles")

  // a NEW terminal after the take is delivered on the next take
  const c = reg.submit({ ...ENTRY, sessionID: "ses_child3" })
  reg.markError(c.dispatchId, { error: "x" })
  const second = reg.takeUndelivered()
  assert.equal(second.length, 1)
  assert.equal(second[0].state, "error")
})

test("3.1: queued entries can be terminalled directly (submit-time failure races)", () => {
  const reg = createDispatchRegistry()
  const { dispatchId } = reg.submit(ENTRY)
  reg.markError(dispatchId, { error: "spawn failed" })
  assert.equal(reg.get(dispatchId).state, "error")
})

test("3.1: kill marks killed and records late completions honestly", () => {
  const reg = createDispatchRegistry()
  const { dispatchId } = reg.submit(ENTRY)
  reg.markRunning(dispatchId)
  reg.markKilled(dispatchId)
  assert.equal(reg.get(dispatchId).state, "killed")
  reg.noteLateCompletion(dispatchId, { text: "finished anyway" })
  assert.equal(reg.get(dispatchId).lateCompletion.text, "finished anyway", "late result is noted, not delivered")
  assert.equal(reg.takeUndelivered().length, 0, "killed dispatch produces no wake brief")
})

test("3.1: list separates in-flight from recent terminal entries", () => {
  const reg = createDispatchRegistry()
  const a = reg.submit(ENTRY)
  reg.markRunning(a.dispatchId)
  const b = reg.submit({ ...ENTRY, sessionID: "ses_child2" })
  reg.markCompleted(b.dispatchId, { text: "b" })
  const l = reg.list()
  assert.equal(l.inFlight.length, 1)
  assert.equal(l.inFlight[0].dispatchId, a.dispatchId)
  assert.equal(l.terminal.length, 1)
  assert.equal(l.terminal[0].result.text, "b")
})

test("3.1: list is bounded — oldest terminal entries drop beyond the cap", () => {
  const reg = createDispatchRegistry()
  for (let i = 0; i < 55; i++) {
    const e = reg.submit({ ...ENTRY, sessionID: `ses_${i}` })
    reg.markCompleted(e.dispatchId, { text: `t${i}` })
  }
  const l = reg.list()
  assert.ok(l.terminal.length <= 50, `terminal list bounded, got ${l.terminal.length}`)
  assert.equal(l.terminal[l.terminal.length - 1].result.text, "t54", "newest retained")
})

test("3.3: takeUndelivered scopes the drain to one parent session", () => {
  const reg = createDispatchRegistry()
  const a = reg.submit({ ...ENTRY, parentSessionID: "ses_p1" })
  const b = reg.submit({ ...ENTRY, sessionID: "ses_x2", parentSessionID: "ses_p2" })
  reg.markCompleted(a.dispatchId, { text: "a" })
  reg.markCompleted(b.dispatchId, { text: "b" })
  const p1 = reg.takeUndelivered("ses_p1")
  assert.equal(p1.length, 1)
  assert.equal(p1[0].parentSessionID, "ses_p1")
  assert.equal(reg.takeUndelivered("ses_p2").length, 1, "the other parent's terminal is untouched")
  assert.equal(reg.takeUndelivered().length, 0, "global drain sees nothing left")
})
