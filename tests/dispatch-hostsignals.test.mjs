import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"

// Host-signal completion + persisted registry (dispatch-v2-hostsignals):
// ① unit — the create body carries agent/model and the read-back assert
// classifies binding-lost (src core, no plugin import); ② the signal-core
// inboxes; ③ adoption re-arms a persisted row and a durable terminal event
// settles the dispatch with ZERO REST polls (status never called); ④ the
// reconcile pass settles a missed event from the child's real state; ⑤ the
// stream-lost verdict is WITHHELD while execution activity flows and fires
// only after both channels go silent; ⑥ the v2 subscription routes durable
// execution events and re-subscribes after a stream break.
// (Plain JS — .mjs files are not type-stripped; the imported .ts cores are.)

process.env.FORGE_TEST_NO_FENCE = "1"
process.env.FORGE_GOAL_DEBOUNCE_MS = "10"
process.env.FORGE_DISPATCH_POLL_INTERVAL_MS = "10"
process.env.FORGE_DISPATCH_POLL_SLICE_MS = "20"
process.env.FORGE_DISPATCH_RETRY_BACKOFF_MS = "20"
process.env.FORGE_DISPATCH_NOTIFY_INTERVAL_MS = "150"
process.env.FORGE_TEST_FORGE_HOME = mkdtempSync(join(tmpdir(), "forge-hostsignals-home-"))

import { createChildSession } from "../src/dispatch-async.ts"
import {
  adoptPersistedDispatchRows,
  noteDispatchChildActivity,
  noteDispatchTerminalSignal,
  recentDispatchChildActivity,
  setDispatchStorageForTests,
  setDispatchWaitSeamForTests,
  takeDispatchTerminalSignal,
  forgetDispatchSignals,
  v2WiringSeam,
  v2Setup,
} from "../plugin.ts"

const tmpDirs = []
const newWs = () => {
  const d = mkdtempSync(join(tmpdir(), "forge-hostsignals-ws-"))
  tmpDirs.push(d)
  return d
}
process.on("exit", () => {
  for (const d of [...tmpDirs, process.env.FORGE_TEST_FORGE_HOME]) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {}
  }
})

const settle = async (taskId, timeoutMs = 8000) => {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (!v2WiringSeam.dispatchTasks.has(taskId)) return true
    await sleep(25)
  }
  return !v2WiringSeam.dispatchTasks.has(taskId)
}

const assistantMsg = () => ({
  info: { id: "msg_1", role: "assistant", finish: "stop", time: { created: 1 } },
  parts: [{ type: "text", text: "final report" }],
})

// A structural dispatch client: session.get always answers (the child is
// observable), status/messages/abort are COUNTER-PROVIDED so tests assert
// exactly which REST seams were touched.
function fakeClient(opts = {}) {
  const counts = { status: 0, messages: 0, abort: 0 }
  return {
    counts,
    session: {
      get: async () => opts.record ?? { id: "ses_child", time: { updated: Date.now() } },
      status: async () => {
        counts.status++
        if (!opts.status) throw new Error("status unreadable")
        return opts.status()
      },
      messages: async () => {
        counts.messages++
        if (!opts.messages) throw new Error("messages unreadable")
        return opts.messages()
      },
      abort: async () => {
        counts.abort++
        return { ok: true }
      },
      create: async () => {
        throw new Error("create not expected in this leg")
      },
      prompt: async () => {
        throw new Error("prompt not expected in this leg")
      },
    },
  }
}

const rowOf = (over) => ({
  taskId: "task_x",
  childSessionID: "ses_child",
  agent: "forge-ns-worker",
  ownerSession: "ses_owner",
  workspace: "/w",
  description: "leg",
  prompt: "p",
  questionDeny: true,
  attempts: 1,
  startedAt: Date.now(),
  updatedAt: Date.now(),
  ...over,
})

// ---------------------------------------------------------------------------
// ① Create body carries agent/model; read-back assert classifies binding-lost

test("create body: pinned model rides {providerID, modelID, id} and the agent id (host subagent contract shape)", async () => {
  const bodies = []
  const client = {
    session: {
      create: async (args) => {
        bodies.push(args.body)
        return { data: { id: "ses_bound", agent: "forge-ns-worker" } }
      },
    },
  }
  const res = await createChildSession(client, {
    parentSessionID: "ses_owner",
    parentDirectory: "/w",
    agentID: "forge-ns-worker",
    description: "d",
    modelPin: { providerID: "openai", modelID: "gpt-x" },
    assertBinding: true,
  })
  assert.equal(res.ok, true)
  const body = bodies[0]
  assert.equal(body.agent, "forge-ns-worker", "the target agent rides the create body")
  assert.deepEqual(
    body.model,
    { providerID: "openai", modelID: "gpt-x", id: "openai/gpt-x" },
    "the pinned model rides the probe-proven {providerID, modelID, id} shape",
  )
})

test("create body: an Auto worker (no pin) sends NO model key", async () => {
  const bodies = []
  const client = {
    session: {
      create: async (args) => {
        bodies.push(args.body)
        return { data: { id: "ses_auto", agent: "forge-ns-worker" } }
      },
    },
  }
  const res = await createChildSession(client, {
    parentSessionID: "ses_owner",
    parentDirectory: "/w",
    agentID: "forge-ns-worker",
    description: "d",
    modelPin: null,
    assertBinding: true,
  })
  assert.equal(res.ok, true)
  assert.equal("model" in bodies[0], false, "no model key for Auto workers (host precedence applies)")
})

test("read-back assert: mismatch and missing binding fail loud as binding-lost; assertBinding off (v1 posture) passes", async () => {
  const mk = (record) => ({
    session: { create: async () => ({ data: record }) },
  })
  const mismatch = await createChildSession(mk({ id: "ses_x", agent: "some-other-agent" }), {
    parentSessionID: "p",
    parentDirectory: "/w",
    agentID: "forge-ns-worker",
    description: "d",
    assertBinding: true,
  })
  assert.equal(mismatch.ok, false)
  assert.match(mismatch.ok === false ? mismatch.error : "", /binding-lost/, "mismatch class is binding-lost")
  assert.match(mismatch.ok === false ? mismatch.error : "", /refusing to prompt/, "the refusal names the unsent prompt")

  const naked = await createChildSession(mk({ id: "ses_y" }), {
    parentSessionID: "p",
    parentDirectory: "/w",
    agentID: "forge-ns-worker",
    description: "d",
    assertBinding: true,
  })
  assert.equal(naked.ok, false)
  assert.match(naked.ok === false ? naked.error : "", /binding-lost/, "a record with no agent binding fails loud")

  const v1posture = await createChildSession(mk({ id: "ses_z" }), {
    parentSessionID: "p",
    parentDirectory: "/w",
    agentID: "forge-ns-worker",
    description: "d",
    assertBinding: false,
  })
  assert.equal(v1posture.ok, true, "assertBinding off (v1) does not assert the record")
})

// ---------------------------------------------------------------------------
// ② Signal core: first-terminal-wins, consume-on-take, activity window

test("signal core: first terminal wins, take clears, activity window + forget", () => {
  const child = "ses_sig_core"
  forgetDispatchSignals(child)
  noteDispatchTerminalSignal(child, "failed", "boom")
  noteDispatchTerminalSignal(child, "succeeded") // late second terminal: ignored
  const s = takeDispatchTerminalSignal(child)
  assert.equal(s?.kind, "failed")
  assert.equal(s?.detail, "boom")
  assert.equal(takeDispatchTerminalSignal(child), null, "consume-on-take")
  assert.equal(recentDispatchChildActivity(child, 10000), true, "a terminal event pings activity")
  forgetDispatchSignals(child)
  assert.equal(recentDispatchChildActivity(child, 10000), false, "forget clears the ledger")
})

// ---------------------------------------------------------------------------
// ③ Adoption: persisted row → re-arm → durable event settles with zero polls

test("adoption: a persisted row re-arms watch-only, and the durable terminal event settles the dispatch with ZERO status polls", async (t) => {
  const ws = newWs()
  const taskId = "task_adopt_zero_poll"
  const child = "ses_adopt_child"
  const rows = new Map()
  setDispatchStorageForTests({
    get: async (k) => rows.get(k),
    set: async (k, v) => {
      rows.set(k, v)
    },
    remove: async (k) => {
      rows.delete(k)
    },
    scan: async () => ({ entries: [...rows].map(([key, value]) => ({ key, value })) }),
  })
  // The reload gap already carried the terminal event: pre-arm the inbox
  // (the adopted watcher consumes it at its FIRST loop top).
  noteDispatchTerminalSignal(child, "succeeded")
  const client = fakeClient({
    record: { id: child, agent: "forge-ns-worker", parentID: "ses_owner", time: { updated: Date.now() } },
    messages: () => ({ data: [assistantMsg()] }),
  })
  rows.set(`forge-dispatch/${taskId}`, rowOf({ taskId, childSessionID: child, workspace: ws, description: "adopted leg", prompt: "the original prompt" }))
  const adopted = await adoptPersistedDispatchRows(client, ws)
  assert.equal(adopted, 1, "one row adopted")
  assert.equal(v2WiringSeam.dispatchTasks.has(taskId), true, "the adopted row is in the active watcher set")
  assert.equal(v2WiringSeam.dispatchTasks.get(taskId)?.childSessionID, child, "the SAME child is watched (no second child)")
  t.after(() => {
    setDispatchStorageForTests(null)
    forgetDispatchSignals(child)
  })
  const settled = await settle(taskId)
  assert.equal(settled, true, "the dispatch settled from the durable signal")
  assert.equal(client.counts.status, 0, "ZERO status polls — the signal settled it (spec: settles without any status polling)")
  assert.equal(rows.has(`forge-dispatch/${taskId}`), false, "the terminal removed the persisted row (journal choke point)")
})

// ---------------------------------------------------------------------------
// ③b wait latch (task 3.2): the one-shot ctx.session.wait settles the child

test("wait latch: the one-shot host wait settles the dispatch when the agent loop goes idle (view unreadable)", async (t) => {
  const ws = newWs()
  const taskId = "task_wait_latch"
  const child = "ses_latch_child"
  const rows = new Map()
  setDispatchStorageForTests({
    get: async (k) => rows.get(k),
    set: async (k, v) => {
      rows.set(k, v)
    },
    remove: async (k) => {
      rows.delete(k)
    },
    scan: async () => ({ entries: [...rows].map(([key, value]) => ({ key, value })) }),
  })
  const client = fakeClient({
    record: { id: child, agent: "forge-ns-worker", time: { updated: Date.now() } },
    messages: () => ({ data: [assistantMsg()] }),
    // status UNREADABLE — alone this holds/stream-losts; the latch beats it.
  })
  setDispatchWaitSeamForTests(async (id) => {
    if (id !== child) throw new Error("wrong child")
    return null // 204 NoContent equivalent: the agent loop is idle
  })
  rows.set(`forge-dispatch/${taskId}`, rowOf({ taskId, childSessionID: child, workspace: ws, description: "latch leg" }))
  await adoptPersistedDispatchRows(client, ws)
  assert.equal(v2WiringSeam.dispatchTasks.has(taskId), true)
  t.after(() => {
    setDispatchStorageForTests(null)
    setDispatchWaitSeamForTests(null)
    forgetDispatchSignals(child)
  })
  const settled = await settle(taskId, 10000)
  assert.equal(settled, true, "the latch settled the dispatch")
  assert.ok(client.counts.status <= 3, "the settle came from the latch, not the 30-tick blind-view streak")
  assert.equal(rows.has(`forge-dispatch/${taskId}`), false, "terminal removed the row")
})

// ---------------------------------------------------------------------------
// ④ Reconcile settles a MISSED event from the child's real state

test("reconcile: a missed terminal event is covered by the reconcile pass reading the child's real state", async (t) => {
  const ws = newWs()
  const taskId = "task_reconcile_settle"
  const child = "ses_reconcile_child"
  const rows = new Map()
  setDispatchStorageForTests({
    get: async (k) => rows.get(k),
    set: async (k, v) => {
      rows.set(k, v)
    },
    remove: async (k) => {
      rows.delete(k)
    },
    scan: async () => ({ entries: [...rows].map(([key, value]) => ({ key, value })) }),
  })
  // NO signal armed — the event was lost in the gap; the child's real state
  // (idle in the status map + a textful final assistant message) settles it.
  const client = fakeClient({
    record: { id: child, agent: "forge-ns-worker", parentID: "ses_owner", time: { updated: Date.now() } },
    status: () => ({ data: {} }), // the host's idle signal: the child is missing from the map
    messages: () => ({ data: [assistantMsg()] }),
  })
  rows.set(`forge-dispatch/${taskId}`, rowOf({ taskId, childSessionID: child, workspace: ws, description: "reconcile leg" }))
  const adopted = await adoptPersistedDispatchRows(client, ws)
  assert.equal(adopted, 1)
  t.after(() => {
    setDispatchStorageForTests(null)
    forgetDispatchSignals(child)
  })
  const settled = await settle(taskId, 15000)
  assert.equal(settled, true, "the reconcile pass settled the missed-event dispatch")
  assert.ok(client.counts.status >= 3, "the reconcile pass actually read the child's state (3 stability ticks)")
  assert.equal(rows.has(`forge-dispatch/${taskId}`), false, "terminal removed the row")
})

// ---------------------------------------------------------------------------
// ⑤ stream-lost verdict: withheld while execution activity flows

test("stream-lost verdict requires reconcile confirmation: execution activity holds the verdict; silence settles it", async (t) => {
  const ws = newWs()
  const taskId = "task_hold_verdict"
  const child = "ses_hold_child"
  const rows = new Map()
  setDispatchStorageForTests({
    get: async (k) => rows.get(k),
    set: async (k, v) => {
      rows.set(k, v)
    },
    remove: async (k) => {
      rows.delete(k)
    },
    scan: async () => ({ entries: [...rows].map(([key, value]) => ({ key, value })) }),
  })
  const client = fakeClient({ record: { id: child, agent: "forge-ns-worker", time: { updated: Date.now() } } })
  rows.set(`forge-dispatch/${taskId}`, rowOf({ taskId, childSessionID: child, workspace: ws, description: "hold leg" }))
  await adoptPersistedDispatchRows(client, ws)
  assert.equal(v2WiringSeam.dispatchTasks.has(taskId), true)
  t.after(() => {
    setDispatchStorageForTests(null)
    forgetDispatchSignals(child)
  })
  // Keep the child's execution channel alive: step pings every 40ms for
  // ~1100ms while the synchronous view stays unreadable. The verdict must
  // NEVER fire while the pings flow ("a child that host signals show to be
  // alive SHALL NOT be declared lost") — asserted at 900ms, while pings
  // are STILL flowing.
  const pingUntil = Date.now() + 1100
  const pinger = setInterval(() => {
    if (Date.now() < pingUntil) noteDispatchChildActivity(child)
    else clearInterval(pinger)
  }, 40)
  await sleep(900)
  assert.equal(v2WiringSeam.dispatchTasks.has(taskId), true, "the verdict is WITHHELD while execution activity flows")
  // Pings stopped — both channels silent now; the last-resort verdict fires
  // (stream-lost/unknown, exit-null — never an exit-1 death certificate).
  const settled = await settle(taskId, 20000)
  assert.equal(settled, true, "the verdict fires once signals AND the reconcile view are both silent")
  assert.equal(rows.has(`forge-dispatch/${taskId}`), false, "terminal removed the row")
})

// ---------------------------------------------------------------------------
// ⑥ v2 subscription: durable events route into the inbox; stream break → re-subscribe

test("v2 subscription routes session.execution.* into the signal core and re-subscribes after a stream break", async () => {
  const ws = newWs()
  const child = "ses_route_child"
  forgetDispatchSignals(child)
  let subscribeCount = 0
  const makeStream = (idle) => {
    let nextCount = 0
    return {
      async next() {
        nextCount++
        if (!idle && nextCount === 1) {
          return { done: false, value: { id: "e1", type: "session.execution.failed", data: { sessionID: child, error: { message: "boom-route" } } } }
        }
        if (!idle && nextCount === 2) {
          return { done: false, value: { id: "e2", type: "session.step.started", data: { sessionID: child } } }
        }
        if (!idle && nextCount === 3) throw new Error("stream broke")
        // Idle stream: real waits between ticks (a hot next() loop would
        // starve the event loop).
        await sleep(60)
        return { done: false, value: { id: `e-tick-${nextCount}`, type: "server.heartbeat", data: {} } }
      },
      async return() {
        return { done: true }
      },
    }
  }
  const ctx = {
    event: {
      subscribe: () => {
        subscribeCount++
        // First stream: routes the events then breaks; second stream: idles.
        return { [Symbol.asyncIterator]: () => makeStream(subscribeCount > 1) }
      },
    },
  }
  const cleanup = await v2Setup(ctx, { anchors: [ws] })
  // The subscription is a detached loop — give it a beat to route.
  await sleep(150)
  const s = takeDispatchTerminalSignal(child)
  assert.equal(s?.kind, "failed", "the durable execution event routed into the signal core")
  assert.equal(s?.detail, "boom-route", "the failed event's error message rides the signal detail")
  assert.equal(recentDispatchChildActivity(child, 10000), true, "the step ping landed in the activity ledger")
  // Stream break → re-subscribe (1s backoff).
  await sleep(1400)
  assert.ok(subscribeCount >= 2, "the lost event stream was re-subscribed (task 3.4)")
  if (typeof cleanup === "function") cleanup()
  forgetDispatchSignals(child)
})
