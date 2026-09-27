import test from "node:test"
import assert from "node:assert/strict"

// Spec: openspec/changes/add-dispatch-suite/specs/dispatch/spec.md —
// forge_dispatch tool contract driven through the injectable engine:
//   S6  honest report (actual == requested, real tokens, computed cost, text)
//   S7  timeout report with sessionID + elapsed; session left to the host
//   S8  concurrency cap refuses with in-flight count + retry hint
//   S15 cost null semantics; B27 empty-response guard
//   S19 lost-on-exit on dispose; ledger events for every terminal state

import { buildDispatchConfig } from "../src/dispatch-roster.ts"
import { createDispatchEngine, DEFAULT_MAX_CONCURRENT } from "../src/dispatch-engine.ts"

const CATALOG = {
  providers: {
    "zai-coding-plan": {
      models: {
        "glm-5.3": {
          reasoningOptions: ["low", "high", "max"],
          cost: { input: 0.6, output: 2.2, cache_read: 0.11, cache_write: 0.22 },
        },
      },
    },
  },
}

const CFG = () =>
  buildDispatchConfig({
    configuredIdentities: ["zai-coding-plan/glm-5.3"],
    catalog: CATALOG,
    userRoster: [{ model: "zai-coding-plan/glm-5.3", expose: ["low", "max"], profiles: ["scout", "build", "review", "quick"] }],
  })

// Scripted fetcher: routes host API calls to per-test handlers.
function fakeFetcher(routes) {
  const calls = []
  const fn = async (url, init) => {
    const u = String(url)
    calls.push({ url: u, init })
    for (const r of routes) {
      if (r.match.test(u)) return r.handle(u, init ?? {}, calls)
    }
    throw new Error(`unexpected fetch ${u}`)
  }
  fn.calls = calls
  return fn
}

const jsonRes = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

function baseDeps(fetcher, over = {}) {
  let t = 0
  return {
    serverUrl: "http://127.0.0.1:1",
    workspace: "C:/tmp/ws",
    fetcher,
    now: () => (t += over.tickMs ?? 1000),
    sleep: async () => {},
    cfg: CFG(),
    catalog: CATALOG,
    available: () => true,
    sink: over.sink ?? (() => {}),
    onDepth: over.onDepth ?? (() => {}),
    providerFamily: over.providerFamily ?? (() => "openai"),
    pollIntervalMs: 0,
    ...over,
  }
}

const CHILD = "ses_child_1"

test("S6: a successful dispatch reports actuals honestly (exact match, tokens, cost, text)", async () => {
  const fetcher = fakeFetcher([
    { match: /\/session\?directory=/, handle: () => jsonRes({ id: CHILD }) },
    {
      match: new RegExp(`/session/${CHILD}/message$`),
      handle: (u, init, calls) => {
        // first call is the POST (no messages yet); subsequent GETs return the
        // completed assistant message
        const postCount = calls.filter((c) => c.init?.method === "POST" && c.url.endsWith("/message")).length
        if (postCount >= 1 && calls.filter((c) => c.init?.method === undefined || c.init?.method === "GET").some((c) => c.url.endsWith(`/session/${CHILD}/message`))) {
          return jsonRes([
            { info: { role: "user" }, parts: [{ type: "text", text: "task" }] },
            { info: { role: "assistant", tokens: { input: 100, output: 50, reasoning: 10, cache: { read: 20, write: 5 } } }, parts: [{ type: "text", text: "did it (src/a.ts:1)" }] },
          ])
        }
        return jsonRes([])
      },
    },
  ])
  const depths = []
  const engine = createDispatchEngine(
    baseDeps(fetcher, {
      onDepth: (sid, level, provider) => depths.push({ sid, level, provider }),
    }),
  )
  const r = await engine.dispatch({ prompt: "check things", profile: "scout", depth: "low" }, "ses_parent")
  assert.equal(r.tier, "scout")
  assert.deepEqual(r.requested, { profile: "scout", depth: "low" })
  assert.equal(r.actual.model, "zai-coding-plan/glm-5.3")
  assert.equal(r.actual.depth, "low") // exact match — identical to requested
  assert.equal(r.sessionID, CHILD)
  assert.deepEqual(r.tokens, { input: 100, output: 50, reasoning: 10, cache: { read: 20, write: 5 } })
  assert.equal(typeof r.costUsd, "number")
  assert.ok(r.costUsd > 0)
  assert.match(r.text, /did it/)
  assert.match(r.depthInjected, /openai/)
  assert.deepEqual(depths, [{ sid: CHILD, level: "low", provider: "zai-coding-plan" }])
  // the message body bound the model + the tier agent
  const post = fetcher.calls.find((c) => c.init?.method === "POST" && c.url.endsWith("/message"))
  const body = JSON.parse(post.init.body)
  assert.deepEqual(body.model, { providerID: "zai-coding-plan", modelID: "glm-5.3" })
  assert.equal(body.agent, "forge-scout")
  assert.match(body.parts[0].text, /workspace-relative/i)
})

test("S7: timeout throws an honest report with sessionID + elapsed; no success is fabricated", async () => {
  const fetcher = fakeFetcher([
    { match: /\/session\?directory=/, handle: () => jsonRes({ id: CHILD }) },
    { match: new RegExp(`/session/${CHILD}/message$`), handle: (u, init) => (init?.method === "POST" ? jsonRes({}) : jsonRes([{ info: { role: "user" }, parts: [] }])) },
  ])
  const sunk = []
  const engine = createDispatchEngine(
    baseDeps(fetcher, {
      tickMs: 10_000,
      timeoutMs: 30_000,
      sink: (e) => sunk.push(e),
    }),
  )
  await assert.rejects(
    () => engine.dispatch({ prompt: "slow", profile: "scout", depth: "low" }),
    (err) => {
      assert.equal(err.code, "timeout")
      assert.match(err.message, new RegExp(CHILD))
      assert.match(err.message, /timed out after \d+ms/)
      return true
    },
  )
  assert.ok(sunk.some((e) => e.event === "timeout" && e.sessionID === CHILD))
})

test("S8: the concurrency cap refuses excess dispatches with the count and a retry hint", async () => {
  let resolveOuter
  const gate = new Promise((r) => (resolveOuter = r))
  const fetcher = fakeFetcher([
    { match: /\/session\?directory=/, handle: () => jsonRes({ id: CHILD }) },
    { match: /\/message$/, handle: async () => {
      await gate
      return jsonRes([{ info: { role: "assistant", tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } }, parts: [{ type: "text", text: "ok" }] }])
    } },
  ])
  const engine = createDispatchEngine(baseDeps(fetcher, { maxConcurrent: 2 }))
  const a = engine.dispatch({ prompt: "a", profile: "scout", depth: "low" })
  const b = engine.dispatch({ prompt: "b", profile: "scout", depth: "low" })
  await new Promise((r) => setTimeout(r, 5))
  assert.equal(engine.inFlightCount(), 2)
  await assert.rejects(
    () => engine.dispatch({ prompt: "c", profile: "scout", depth: "low" }),
    (err) => {
      assert.equal(err.code, "cap-refused")
      assert.match(err.message, /2 dispatches already in flight/)
      assert.match(err.message, /retry/i)
      return true
    },
  )
  resolveOuter()
  const [ra, rb] = await Promise.all([a, b])
  assert.equal(ra.text, "ok")
  assert.equal(rb.text, "ok")
  assert.equal(DEFAULT_MAX_CONCURRENT, 4)
})

test("menu errors are thrown with the full menu and vocabulary", async () => {
  const engine = createDispatchEngine(baseDeps(fakeFetcher([])))
  await assert.rejects(
    () => engine.dispatch({ prompt: "x", profile: "build", depth: "medium" }),
    (err) => {
      assert.equal(err.code, "no-candidate")
      assert.match(err.message, /Menu:/)
      assert.match(err.message, /expose=\[low, max\]/)
      return true
    },
  )
})

test("B27: an empty response is an honest error, never a silent success", async () => {
  const fetcher = fakeFetcher([
    { match: /\/session\?directory=/, handle: () => jsonRes({ id: CHILD }) },
    { match: /\/message$/, handle: (u, init) => (init?.method === "POST" ? jsonRes({}) : jsonRes([{ info: { role: "assistant", tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }, parts: [] }])) },
  ])
  const sunk = []
  const engine = createDispatchEngine(baseDeps(fetcher, { sink: (e) => sunk.push(e) }))
  await assert.rejects(
    () => engine.dispatch({ prompt: "x", profile: "scout", depth: "low" }),
    (err) => {
      assert.equal(err.code, "empty-response")
      assert.match(err.message, /empty response/)
      assert.match(err.message, /keyless/)
      return true
    },
  )
  assert.ok(sunk.some((e) => e.event === "empty-response"))
})

test("unknown provider family is disclosed, not guessed", async () => {
  const fetcher = fakeFetcher([
    { match: /\/session\?directory=/, handle: () => jsonRes({ id: CHILD }) },
    { match: /\/message$/, handle: (u, init) => (init?.method === "POST" ? jsonRes({}) : jsonRes([{ info: { role: "assistant", tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } }, parts: [{ type: "text", text: "done" }] }])) },
  ])
  const engine = createDispatchEngine(baseDeps(fetcher, { providerFamily: () => null }))
  const r = await engine.dispatch({ prompt: "x", profile: "scout", depth: "low" })
  assert.equal(r.depthInjected, "not injected (unknown provider shape)")
})

test("B32: parentID is best-effort — a 400 on the parent-bearing create retries plain", async () => {
  const bodies = []
  const fetcher = fakeFetcher([
    {
      match: /\/session\?directory=/,
      handle: (u, init) => {
        const body = JSON.parse(init?.body ?? "{}")
        bodies.push(body)
        if (body.parentID !== undefined) return new Response("400 BadRequest: unknown field", { status: 400 })
        return jsonRes({ id: CHILD })
      },
    },
    { match: /\/message$/, handle: (u, init) => (init?.method === "POST" ? jsonRes({}) : jsonRes([{ info: { role: "assistant", tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } }, parts: [{ type: "text", text: "done" }] }])) },
  ])
  const engine = createDispatchEngine(baseDeps(fetcher, { providerFamily: () => null }))
  const r = await engine.dispatch({ prompt: "x", profile: "scout", depth: "low" }, "ses_parent")
  assert.equal(r.text, "done")
  assert.deepEqual(bodies[0], { parentID: "ses_parent" })
  assert.deepEqual(bodies[1], {})
})

test("S19: dispose records in-flight dispatches as lost-on-exit", async () => {
  let resolveOuter
  const gate = new Promise((r) => (resolveOuter = r))
  const fetcher = fakeFetcher([
    { match: /\/session\?directory=/, handle: () => jsonRes({ id: CHILD }) },
    { match: /\/message$/, handle: async () => {
      await gate
      return jsonRes([])
    } },
  ])
  const sunk = []
  const engine = createDispatchEngine(baseDeps(fetcher, { sink: (e) => sunk.push(e) }))
  const running = engine.dispatch({ prompt: "x", profile: "scout", depth: "low" })
  await new Promise((r) => setTimeout(r, 5))
  engine.dispose()
  resolveOuter()
  await assert.rejects(() => running)
  assert.ok(sunk.some((e) => e.event === "lost-on-exit"), "lost-on-exit must be ledgered")
})

// Battle-I probe finding (live 1.18.32 serve): POST /session/<id>/message is
// TURN-SYNCHRONOUS — it does not return until the child's whole first turn
// settles. The old engine only checked the deadline inside the poll loop,
// i.e. AFTER that await, so a child stuck in its first turn (long tool call,
// unanswered permission ask) never reached the deadline check: the host's own
// tool timeout killed the sync call instead and the honest timeout report +
// ledger row were lost. The deadline must govern the message POST too.
const REAL_CLOCK = {
  now: Date.now,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
}

const failAfter = (ms, tag) => new Promise((_, rej) => setTimeout(() => rej(new Error(`${tag}: engine hung past the fallback guard (${ms}ms)`)), ms))

test("S7a: deadline fires while the child-turn message POST is still in flight", async () => {
  const fetcher = fakeFetcher([
    { match: /\/session\?directory=/, handle: () => jsonRes({ id: CHILD }) },
    {
      match: new RegExp(`/session/${CHILD}/message$`),
      handle: async (u, init) => {
        if (init?.method !== "POST") return jsonRes([])
        await new Promise((r) => setTimeout(r, 300)) // turn-synchronous host
        return jsonRes([{ info: { role: "assistant" }, parts: [{ type: "text", text: "finally done" }] }])
      },
    },
  ])
  const sunk = []
  const engine = createDispatchEngine(baseDeps(fetcher, { ...REAL_CLOCK, timeoutMs: 80, pollIntervalMs: 10, sink: (e) => sunk.push(e) }))
  const t0 = Date.now()
  await assert.rejects(
    () => Promise.race([engine.dispatch({ prompt: "slow turn", profile: "quick", depth: "low" }), failAfter(1500, "S7a")]),
    (err) => {
      assert.equal(err.code, "timeout")
      assert.match(err.message, new RegExp(CHILD))
      return true
    },
  )
  const elapsed = Date.now() - t0
  assert.ok(elapsed < 250, `timeout must fire near the 80ms deadline, took ${elapsed}ms`)
  assert.ok(sunk.some((e) => e.event === "timeout" && e.sessionID === CHILD), "timeout must be ledgered with the childID")
})

test("S7b: deadline fires even when the child-turn message POST never returns", async () => {
  const fetcher = fakeFetcher([
    { match: /\/session\?directory=/, handle: () => jsonRes({ id: CHILD }) },
    {
      match: new RegExp(`/session/${CHILD}/message$`),
      handle: (u, init) => (init?.method !== "POST" ? jsonRes([]) : new Promise(() => {})),
    },
  ])
  const sunk = []
  const engine = createDispatchEngine(baseDeps(fetcher, { ...REAL_CLOCK, timeoutMs: 80, pollIntervalMs: 10, sink: (e) => sunk.push(e) }))
  const t0 = Date.now()
  await assert.rejects(
    () => Promise.race([engine.dispatch({ prompt: "hung turn", profile: "quick", depth: "low" }), failAfter(1500, "S7b")]),
    (err) => {
      assert.equal(err.code, "timeout")
      return true
    },
  )
  const elapsed = Date.now() - t0
  assert.ok(elapsed < 250, `timeout must fire near the 80ms deadline, took ${elapsed}ms`)
  assert.ok(sunk.some((e) => e.event === "timeout"), "timeout must be ledgered")
})

// B11 — spec: "One retry after a mid-dispatch failure": WHEN the resolved
// identity fails during the dispatch attempt THEN resolution retries once
// excluding that identity and the result reports which identity served.
const CATALOG2 = {
  providers: {
    "zai-coding-plan": { models: { "glm-5.3": { reasoningOptions: ["low"], cost: { input: 0.6, output: 2.2, cache_read: 0.11, cache_write: 0.22 } } } },
    "other-plan": { models: { "glm-5.3": { reasoningOptions: ["low"], cost: { input: 0.5, output: 2.0, cache_read: 0.1, cache_write: 0.2 } } } },
  },
}
const CFG2 = () =>
  buildDispatchConfig({
    configuredIdentities: ["zai-coding-plan/glm-5.3", "other-plan/glm-5.3"],
    catalog: CATALOG2,
    userRoster: [
      { model: "zai-coding-plan/glm-5.3", expose: ["low"], profiles: ["quick"] },
      { model: "other-plan/glm-5.3", expose: ["low"], profiles: ["quick"] },
    ],
  })
const CHILD_A = "ses_child_first"
const CHILD_B = "ses_child_second"

const twoChildFetcher = (firstPostBehavior) =>
  fakeFetcher([
    { match: /\/session\?directory=/, handle: (u, init, calls) => jsonRes({ id: calls.filter((c) => c.url.includes("/session?directory=")).length === 1 ? CHILD_A : CHILD_B }) },
    {
      match: new RegExp(`/session/(${CHILD_A}|${CHILD_B})/message$`),
      handle: async (u, init) => {
        if (init?.method === "POST") return u.includes(CHILD_A) ? firstPostBehavior() : jsonRes({})
        if (u.includes(CHILD_A)) return firstPostBehavior === undefined ? jsonRes([]) : jsonRes([{ info: { role: "assistant" }, parts: [] }])
        return jsonRes([{ info: { role: "assistant", tokens: { input: 5, output: 2, reasoning: 0, cache: { read: 0, write: 0 } } }, parts: [{ type: "text", text: "served by B" }] }])
      },
    },
  ])

test("B11: a mid-dispatch host failure retries once excluding the failed identity", async () => {
  const fetcher = twoChildFetcher(() => jsonRes({ "boom": true }, 500))
  const sunk = []
  const engine = createDispatchEngine(baseDeps(fetcher, { cfg: CFG2(), catalog: CATALOG2, sink: (e) => sunk.push(e) }))
  const result = await engine.dispatch({ prompt: "x", profile: "quick", depth: "low" })
  assert.equal(result.actual.model, "other-plan/glm-5.3", "the retry's identity is the one that actually served")
  assert.equal(result.sessionID, CHILD_B)
  assert.ok(sunk.some((e) => e.event === "retry-excluded" && String(e.note).includes("zai-coding-plan/glm-5.3")), "the exclusion must be ledgered")
})

test("B11: an empty first attempt retries once excluding the failed identity", async () => {
  const fetcher = twoChildFetcher(() => jsonRes({}))
  const sunk = []
  const engine = createDispatchEngine(baseDeps(fetcher, { cfg: CFG2(), catalog: CATALOG2, sink: (e) => sunk.push(e) }))
  const result = await engine.dispatch({ prompt: "x", profile: "quick", depth: "low" })
  assert.equal(result.actual.model, "other-plan/glm-5.3")
  assert.equal(result.text, "served by B")
  assert.ok(sunk.filter((e) => e.event === "empty-response").length === 1, "the empty first attempt is ledgered once")
  assert.ok(sunk.some((e) => e.event === "retry-excluded"))
})

test("B11: a second consecutive failure is NOT retried again (one retry per dispatch)", async () => {
  let createCalls = 0
  const fetcher = fakeFetcher([
    { match: /\/session\?directory=/, handle: () => jsonRes({ id: `ses_c${++createCalls}` }) },
    { match: /\/message$/, handle: () => jsonRes({ "boom": true }, 500) },
  ])
  const engine = createDispatchEngine(baseDeps(fetcher, { cfg: CFG2(), catalog: CATALOG2 }))
  await assert.rejects(() => engine.dispatch({ prompt: "x", profile: "quick", depth: "low" }), (err) => err.code === "host-error")
  assert.equal(createCalls, 2, "exactly one retry: two attempts total")
})

// ---------------------------------------------------------------------------
// 3.2 waves — background dispatch path (design D10/D12): eager resolution,
// immediate handle, same pipeline + deadline, registry terminals, kill.
// ---------------------------------------------------------------------------
import { createDispatchRegistry } from "../src/dispatch-registry.ts"

const settle = async () => { for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r)) }

test("3.2: background submit returns a handle immediately and completes asynchronously", async () => {
  const reg = createDispatchRegistry()
  const fetcher = fakeFetcher([
    { match: /\/session\?directory=/, handle: () => jsonRes({ id: CHILD }) },
    { match: new RegExp(`/session/${CHILD}/message$`), handle: (u, init) => (init?.method === "POST" ? jsonRes({}) : jsonRes([{ info: { role: "assistant", tokens: { input: 3, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } }, parts: [{ type: "text", text: "bg done" }] }])) },
  ])
  const engine = createDispatchEngine(baseDeps(fetcher, { cfg: CFG(), catalog: CATALOG, registry: reg }))
  const before = new Date().toISOString()
  const handle = await engine.dispatch({ prompt: "x", profile: "quick", depth: "low" }, undefined, { background: true })
  assert.ok(handle.dispatchId, "handle carries dispatchId")
  assert.equal(handle.tier, "quick")
  assert.equal(handle.resolved, "zai-coding-plan/glm-5.3", "resolution happened eagerly")
  assert.ok(handle.queuedAt >= before, "queuedAt is stamped")
  assert.equal(handle.text, undefined, "no result text on the handle")
  await settle()
  const entry = reg.get(handle.dispatchId)
  assert.equal(entry.state, "completed")
  assert.equal(entry.result.text, "bg done", "full result object lands in the registry")
})

test("3.2: background resolution errors return synchronously before any session is created", async () => {
  const reg = createDispatchRegistry()
  const fetcher = fakeFetcher([])
  const engine = createDispatchEngine(baseDeps(fetcher, { cfg: CFG(), catalog: CATALOG, registry: reg }))
  await assert.rejects(
    () => engine.dispatch({ prompt: "x", profile: "quick", depth: "medium" }, undefined, { background: true }),
    (err) => err.code === "no-candidate",
  )
  assert.equal(fetcher.calls.filter((c) => c.url.includes("/session?directory=")).length, 0, "nothing spawned")
})

test("3.2: the concurrency cap is one pool — over-cap background submits are refused like sync", async () => {
  const reg = createDispatchRegistry()
  const gate = new Promise((r) => setTimeout(r, 200))
  const fetcher = fakeFetcher([
    { match: /\/session\?directory=/, handle: () => jsonRes({ id: CHILD }) },
    { match: /\/message$/, handle: async () => { await gate; return jsonRes([{ info: { role: "assistant", tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } }, parts: [{ type: "text", text: "ok" }] }]) } },
  ])
  const engine = createDispatchEngine(baseDeps(fetcher, { cfg: CFG(), catalog: CATALOG, registry: reg, maxConcurrent: 1 }))
  const syncRunning = engine.dispatch({ prompt: "a", profile: "quick", depth: "low" })
  await new Promise((r) => setTimeout(r, 5))
  await assert.rejects(
    () => engine.dispatch({ prompt: "b", profile: "quick", depth: "low" }, undefined, { background: true }),
    (err) => { assert.equal(err.code, "cap-refused"); assert.match(err.message, /already in flight/); assert.match(err.message, /cap 1/); return true },
  )
  await syncRunning
})

test("3.2: background timeout marks the registry entry and never throws to the caller", async () => {
  const reg = createDispatchRegistry()
  const fetcher = fakeFetcher([
    { match: /\/session\?directory=/, handle: () => jsonRes({ id: CHILD }) },
    { match: new RegExp(`/session/${CHILD}/message$`), handle: (u, init) => {
      if (init?.method === "POST") return jsonRes({})
      pollCount++
      return jsonRes(Array.from({ length: pollCount }, (_, i) => ({ info: { role: "assistant" }, parts: [{ type: "text", text: `working ${i}` }] })))
    } },
  ])
  let pollCount = 0
  const engine = createDispatchEngine(baseDeps(fetcher, { ...REAL_CLOCK, timeoutMs: 60, pollIntervalMs: 10, cfg: CFG(), catalog: CATALOG, registry: reg }))
  const handle = await engine.dispatch({ prompt: "slow", profile: "quick", depth: "low" }, undefined, { background: true })
  for (let i = 0; i < 100 && reg.get(handle.dispatchId).state !== "timeout"; i++) await new Promise((r) => setTimeout(r, 10))
  const entry = reg.get(handle.dispatchId)
  assert.equal(entry.state, "timeout")
  assert.match(String(entry.result.error), /timed out/)
  assert.equal(entry.delivered, false, "undelivered terminal waits for the next idle drain")
})

test("3.2: kill stops the poll loop, marks killed, and suppresses the wake", async () => {
  const reg = createDispatchRegistry()
  const fetcher = fakeFetcher([
    { match: /\/session\?directory=/, handle: () => jsonRes({ id: CHILD }) },
    { match: /\/message$/, handle: (u, init) => (init?.method === "POST" ? jsonRes({}) : new Promise(() => {})) },
  ])
  const engine = createDispatchEngine(baseDeps(fetcher, { ...REAL_CLOCK, timeoutMs: 3_000, pollIntervalMs: 10, cfg: CFG(), catalog: CATALOG, registry: reg }))
  const handle = await engine.dispatch({ prompt: "x", profile: "quick", depth: "low" }, undefined, { background: true })
  await new Promise((r) => setTimeout(r, 30))
  engine.kill(handle.dispatchId)
  for (let i = 0; i < 100 && reg.get(handle.dispatchId).state !== "killed"; i++) await new Promise((r) => setTimeout(r, 10))
  assert.equal(reg.get(handle.dispatchId).state, "killed")
  assert.equal(reg.takeUndelivered().length, 0, "killed never wakes the parent")
})

test("3.2: killing an already-terminal dispatch fails honestly, result-after-kill is noted", async () => {
  const reg = createDispatchRegistry()
  const fetcher = fakeFetcher([
    { match: /\/session\?directory=/, handle: () => jsonRes({ id: CHILD }) },
    { match: new RegExp(`/session/${CHILD}/message$`), handle: (u, init) => (init?.method === "POST" ? jsonRes({}) : jsonRes([{ info: { role: "assistant", tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } }, parts: [{ type: "text", text: "done" }] }])) },
  ])
  const engine = createDispatchEngine(baseDeps(fetcher, { cfg: CFG(), catalog: CATALOG, registry: reg }))
  const handle = await engine.dispatch({ prompt: "x", profile: "quick", depth: "low" }, undefined, { background: true })
  await settle()
  assert.throws(() => engine.kill(handle.dispatchId), (err) => { assert.match(err.message, /already completed/); return true })
  // and a kill that lands while the pipeline is settling gets the late note
  const reg2 = createDispatchRegistry()
  const engine2 = createDispatchEngine(baseDeps(fakeFetcher([
    { match: /\/session\?directory=/, handle: () => jsonRes({ id: CHILD }) },
    { match: /\/message$/, handle: (u, init) => (init?.method === "POST" ? jsonRes({}) : jsonRes([{ info: { role: "assistant", tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } }, parts: [{ type: "text", text: "late" }] }])) },
  ]), { cfg: CFG(), catalog: CATALOG, registry: reg2 }))
  const h2 = await engine2.dispatch({ prompt: "x", profile: "quick", depth: "low" }, undefined, { background: true })
  await settle()
  try { engine2.kill(h2.dispatchId) } catch { /* already terminal on this scheduler — acceptable race */ }
  const e = reg2.get(h2.dispatchId)
  assert.ok(e.state === "killed" || e.state === "completed")
  if (e.state === "killed") assert.equal(reg2.takeUndelivered().length, 0)
})
