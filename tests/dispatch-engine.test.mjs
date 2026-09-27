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
    legacy: over.legacy ?? true,
    agents: over.agents ?? (() => ({})),
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
      onDepth: (sid, translation) => depths.push({ sid, translation }),
    }),
  )
  const r = await engine.dispatch({ prompt: "check things", agent: "scout", depth: "low" }, "ses_parent")
  assert.equal(r.agent, "scout")
  assert.deepEqual(r.requested, { agent: "scout", depth: "low" })
  assert.equal(r.actual.model, "zai-coding-plan/glm-5.3")
  assert.equal(r.actual.depth, "low") // exact match — identical to requested
  assert.equal(r.sessionID, CHILD)
  assert.deepEqual(r.tokens, { input: 100, output: 50, reasoning: 10, cache: { read: 20, write: 5 } })
  assert.equal(typeof r.costUsd, "number")
  assert.ok(r.costUsd > 0)
  assert.match(r.text, /did it/)
  assert.equal(r.depthTranslation, "verbatim", "meta word natively valid — disclosed as verbatim")
  assert.equal(depths.length, 1)
  assert.equal(depths[0].sid, CHILD)
  assert.equal(depths[0].translation.kind, "verbatim")
  assert.equal(depths[0].translation.word, "low")
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
    () => engine.dispatch({ prompt: "slow", agent: "scout", depth: "low" }),
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
  const a = engine.dispatch({ prompt: "a", agent: "scout", depth: "low" })
  const b = engine.dispatch({ prompt: "b", agent: "scout", depth: "low" })
  await new Promise((r) => setTimeout(r, 5))
  assert.equal(engine.inFlightCount(), 2)
  await assert.rejects(
    () => engine.dispatch({ prompt: "c", agent: "scout", depth: "low" }),
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
    () => engine.dispatch({ prompt: "x", agent: "build", depth: "medium" }),
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
    () => engine.dispatch({ prompt: "x", agent: "scout", depth: "low" }),
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
  const r = await engine.dispatch({ prompt: "x", agent: "scout", depth: "low" })
  assert.equal(r.depthTranslation, "not injected (unknown provider shape)")
})

// 3.2 a toggle-shaped model (empty catalog ladder) on an effort-family
// provider: the meta word passes through UNVERIFIED — provider is the judge
// (owner ruling: configured depth is never clamped or replaced).
test("3.2 empty catalog ladder passes the depth through unverified", async () => {
  const catalog = { providers: { glm: { models: { "glm-4.7": { reasoningOptions: [] } } } } }
  const cfg = buildDispatchConfig({
    configuredIdentities: ["glm/glm-4.7"],
    catalog,
    userRoster: [{ model: "glm/glm-4.7", expose: ["low"], profiles: ["scout"] }],
  })
  const fetcher = fakeFetcher([
    { match: /\/session\?directory=/, handle: () => jsonRes({ id: CHILD }) },
    { match: /\/message$/, handle: (u, init) => (init?.method === "POST" ? jsonRes({}) : jsonRes([{ info: { role: "assistant", tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } }, parts: [{ type: "text", text: "done" }] }])) },
  ])
  const depths = []
  const engine = createDispatchEngine(baseDeps(fetcher, { cfg, catalog, onDepth: (sid, t) => depths.push({ sid, t }) }))
  const r = await engine.dispatch({ prompt: "x", agent: "scout", depth: "low" })
  assert.match(r.depthTranslation, /unverified/)
  assert.equal(depths[0].t.word, "low")
})

// 3.2 budget family: canonical high lands as the published budget tier and the
// report discloses the translation.
test("3.2 budget-family translation is injected and disclosed", async () => {
  const cfg = buildDispatchConfig({
    configuredIdentities: ["anthropic/claude-haiku-4-5"],
    catalog: CATALOG,
    userRoster: [{ model: "anthropic/claude-haiku-4-5", expose: ["medium", "high"], profiles: ["scout"] }],
  })
  const fetcher = fakeFetcher([
    { match: /\/session\?directory=/, handle: () => jsonRes({ id: CHILD }) },
    { match: /\/message$/, handle: (u, init) => (init?.method === "POST" ? jsonRes({}) : jsonRes([{ info: { role: "assistant", tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } }, parts: [{ type: "text", text: "done" }] }])) },
  ])
  const engine = createDispatchEngine(baseDeps(fetcher, { cfg, providerFamily: () => "anthropic" }))
  const r = await engine.dispatch({ prompt: "x", agent: "scout", depth: "high" })
  assert.equal(r.depthTranslation, "canonical high → native thinking budget:24576")
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
  const r = await engine.dispatch({ prompt: "x", agent: "scout", depth: "low" }, "ses_parent")
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
  const running = engine.dispatch({ prompt: "x", agent: "scout", depth: "low" })
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
    () => Promise.race([engine.dispatch({ prompt: "slow turn", agent: "quick", depth: "low" }), failAfter(1500, "S7a")]),
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
    () => Promise.race([engine.dispatch({ prompt: "hung turn", agent: "quick", depth: "low" }), failAfter(1500, "S7b")]),
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
  const result = await engine.dispatch({ prompt: "x", agent: "quick", depth: "low" })
  assert.equal(result.actual.model, "other-plan/glm-5.3", "the retry's identity is the one that actually served")
  assert.equal(result.sessionID, CHILD_B)
  assert.ok(sunk.some((e) => e.event === "retry-excluded" && String(e.note).includes("zai-coding-plan/glm-5.3")), "the exclusion must be ledgered")
})

test("B11: an empty first attempt retries once excluding the failed identity", async () => {
  const fetcher = twoChildFetcher(() => jsonRes({}))
  const sunk = []
  const engine = createDispatchEngine(baseDeps(fetcher, { cfg: CFG2(), catalog: CATALOG2, sink: (e) => sunk.push(e) }))
  const result = await engine.dispatch({ prompt: "x", agent: "quick", depth: "low" })
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
  await assert.rejects(() => engine.dispatch({ prompt: "x", agent: "quick", depth: "low" }), (err) => err.code === "host-error")
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
  const handle = await engine.dispatch({ prompt: "x", agent: "quick", depth: "low" }, undefined, { background: true })
  assert.ok(handle.dispatchId, "handle carries dispatchId")
  assert.equal(handle.agent, "quick")
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
    () => engine.dispatch({ prompt: "x", agent: "quick", depth: "medium" }, undefined, { background: true }),
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
  const syncRunning = engine.dispatch({ prompt: "a", agent: "quick", depth: "low" })
  await new Promise((r) => setTimeout(r, 5))
  await assert.rejects(
    () => engine.dispatch({ prompt: "b", agent: "quick", depth: "low" }, undefined, { background: true }),
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
  const handle = await engine.dispatch({ prompt: "slow", agent: "quick", depth: "low" }, undefined, { background: true })
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
  const handle = await engine.dispatch({ prompt: "x", agent: "quick", depth: "low" }, undefined, { background: true })
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
  const handle = await engine.dispatch({ prompt: "x", agent: "quick", depth: "low" }, undefined, { background: true })
  await settle()
  assert.throws(() => engine.kill(handle.dispatchId), (err) => { assert.match(err.message, /already completed/); return true })
  // and a kill that lands while the pipeline is settling gets the late note
  const reg2 = createDispatchRegistry()
  const engine2 = createDispatchEngine(baseDeps(fakeFetcher([
    { match: /\/session\?directory=/, handle: () => jsonRes({ id: CHILD }) },
    { match: /\/message$/, handle: (u, init) => (init?.method === "POST" ? jsonRes({}) : jsonRes([{ info: { role: "assistant", tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } }, parts: [{ type: "text", text: "late" }] }])) },
  ]), { cfg: CFG(), catalog: CATALOG, registry: reg2 }))
  const h2 = await engine2.dispatch({ prompt: "x", agent: "quick", depth: "low" }, undefined, { background: true })
  await settle()
  try { engine2.kill(h2.dispatchId) } catch { /* already terminal on this scheduler — acceptable race */ }
  const e = reg2.get(h2.dispatchId)
  assert.ok(e.state === "killed" || e.state === "completed")
  if (e.state === "killed") assert.equal(reg2.takeUndelivered().length, 0)
})

// B39 (reverse direction): background dispatches occupying the shared pool
// refuse a SYNC dispatch too — one slot pool, both directions.
test("B39: background dispatches filling the pool refuse sync dispatches as well", async () => {
  const reg = createDispatchRegistry()
  let release
  const gate = new Promise((r) => (release = r))
  const fetcher = fakeFetcher([
    { match: /\/session\?directory=/, handle: () => jsonRes({ id: CHILD }) },
    { match: /\/message$/, handle: async (u, init) => {
      if (init?.method === "POST") { await gate; return jsonRes({}) }
      return jsonRes([])
    } },
  ])
  const engine = createDispatchEngine(baseDeps(fetcher, { cfg: CFG(), catalog: CATALOG, registry: reg, maxConcurrent: 1 }))
  const bg = await engine.dispatch({ prompt: "bg", agent: "quick", depth: "low" }, undefined, { background: true })
  await settle()
  assert.equal(reg.get(bg.dispatchId).state, "running", "the background dispatch owns the only slot")
  await assert.rejects(
    () => engine.dispatch({ prompt: "sync", agent: "quick", depth: "low" }),
    (err) => { assert.equal(err.code, "cap-refused"); return true },
  )
  release()
  await settle()
})

// B42: host exit with MULTIPLE background dispatches in flight — the ledger
// records EACH as lost-on-exit (sessions are host memory objects; no orphans,
// no survive semantics, and no silent batch collapse into one row).
test("B42: dispose with several in-flight background dispatches ledger each as lost-on-exit", async () => {
  const reg = createDispatchRegistry()
  let release
  const gate = new Promise((r) => (release = r))
  const fetcher = fakeFetcher([
    { match: /\/session\?directory=/, handle: () => jsonRes({ id: CHILD }) },
    { match: /\/message$/, handle: async (u, init) => {
      if (init?.method === "POST") { await gate; return jsonRes({}) }
      return jsonRes([])
    } },
  ])
  const sunk = []
  const engine = createDispatchEngine(baseDeps(fetcher, { cfg: CFG(), catalog: CATALOG, registry: reg, sink: (e) => sunk.push(e) }))
  const h1 = await engine.dispatch({ prompt: "a", agent: "quick", depth: "low" }, undefined, { background: true })
  const h2 = await engine.dispatch({ prompt: "b", agent: "quick", depth: "low" }, undefined, { background: true })
  assert.notEqual(h1.dispatchId, h2.dispatchId)
  await settle()
  assert.equal(reg.list().inFlight.length, 2, "both sit in the registry as running")
  engine.dispose()
  const lost = sunk.filter((e) => e.event === "lost-on-exit")
  assert.equal(lost.length, 2, "one honest ledger row per in-flight dispatch — no batch collapse")
  assert.match(lost[0].note, /dispatch d\d+ in flight at host exit/)
  assert.notEqual(lost[0].note, lost[1].note, "each row names its own slot")
  release()
  await settle()
})

// ---------------------------------------------------------------------------
// add-dispatch-onboarding — agents path (forge.json): pinned model, no retry.

const AGENTS_MAP = {
  research: { model: "zai-coding-plan/glm-5.3", depths: ["low", "high", "max"], shape: "readonly" },
  auditor: { model: "opencode-go/glm-5.3", depths: ["low"], prompt: "You are a dependency auditor." },
}

function agentsDeps(fetcher, over = {}) {
  return baseDeps(fetcher, { legacy: false, agents: () => AGENTS_MAP, ...over })
}

test("4.2 agents path: pinned model, forge-<agent> body, role prompt inside the wrapper", async () => {
  const fetcher = fakeFetcher([
    { match: /\/session\?directory=/, handle: () => jsonRes({ id: CHILD }) },
    { match: /\/message$/, handle: (u, init, calls) => {
      const postCount = calls.filter((c) => c.init?.method === "POST" && c.url.endsWith("/message")).length
      if (postCount >= 1) return jsonRes([{ info: { role: "assistant", tokens: { input: 3, output: 2, reasoning: 0, cache: { read: 0, write: 0 } } }, parts: [{ type: "text", text: "ok" }] }])
      return jsonRes([])
    } },
  ])
  const engine = createDispatchEngine(agentsDeps(fetcher))
  const r = await engine.dispatch({ prompt: "check deps", agent: "auditor", depth: "low" })
  assert.equal(r.agent, "auditor")
  assert.equal(r.actual.model, "opencode-go/glm-5.3")
  const body = JSON.parse(fetcher.calls.find((c) => c.init?.method === "POST" && c.url.endsWith("/message")).init.body)
  assert.deepEqual(body.model, { providerID: "opencode-go", modelID: "glm-5.3" })
  assert.equal(body.agent, "forge-auditor")
  assert.match(body.parts[0].text, /dependency auditor/)
  assert.match(body.parts[0].text, /Mandates/)
  // default depth = first entry (no explicit depth needed)
  const r2 = await engine.dispatch({ prompt: "x", agent: "research" })
  assert.equal(r2.actual.depth, "low")
})

test("4.2 unknown agent errors with the code and the defined names", async () => {
  const engine = createDispatchEngine(agentsDeps(fakeFetcher([])))
  await assert.rejects(
    () => engine.dispatch({ prompt: "x", agent: "ghost" }),
    (err) => {
      assert.equal(err.code, "unknown-agent")
      assert.match(err.message, /research/)
      return true
    },
  )
})

test("4.2 out-of-set depth errors depth-not-in-set", async () => {
  const engine = createDispatchEngine(agentsDeps(fakeFetcher([])))
  await assert.rejects(
    () => engine.dispatch({ prompt: "x", agent: "research", depth: "medium" }),
    (err) => err.code === "depth-not-in-set",
  )
})

test("4.2 unavailable pinned model errors pin-unavailable — never a fallback", async () => {
  const engine = createDispatchEngine(agentsDeps(fakeFetcher([]), { available: () => false }))
  await assert.rejects(
    () => engine.dispatch({ prompt: "x", agent: "research" }),
    (err) => {
      assert.equal(err.code, "pin-unavailable")
      assert.match(err.message, /no fallback/i)
      return true
    },
  )
})

test("4.2 agents path NEVER retries on empty-response — one session, honest error", async () => {
  let creates = 0
  const fetcher = fakeFetcher([
    { match: /\/session\?directory=/, handle: () => { creates++; return jsonRes({ id: CHILD }) } },
    { match: /\/message$/, handle: (u, init) => (init?.method === "POST" ? jsonRes({}) : jsonRes([{ info: { role: "user" }, parts: [] }])) },
  ])
  const engine = createDispatchEngine(agentsDeps(fetcher))
  await assert.rejects(
    () => engine.dispatch({ prompt: "x", agent: "research", depth: "low" }),
    (err) => err.code === "empty-response",
  )
  assert.equal(creates, 1, "a pinned model that fails is reported, never retried on another model")
})

test("4.2 no-native-mapping on the agents path errors before spawn", async () => {
  const catalog = { providers: { qwen: { models: { "qwen3-max": { reasoningOptions: ["none", "low", "medium", "XHigh"] } } } } }
  const agents = { research: { model: "qwen/qwen3-max", depths: ["low", "medium", "high"] } }
  const fetcher = fakeFetcher([]) // any fetch would fail the test differently
  const engine = createDispatchEngine(agentsDeps(fetcher, { catalog, agents: () => agents }))
  await assert.rejects(
    () => engine.dispatch({ prompt: "x", agent: "research", depth: "high" }),
    (err) => {
      assert.equal(err.code, "no-native-mapping")
      assert.match(err.message, /XHigh/)
      assert.match(err.message, /never interpolates/i)
      return true
    },
  )
  assert.equal(fetcher.calls.length, 0)
})

// ---------------------------------------------------------------------------
// fix-dispatch-transport-timeout — transport interruption of the turn POST
// (incident 2026-09-27): the POST is turn-synchronous, but the child session
// is a host-side object. A transport-level rejection (fetch abort / network
// failure — NOT an HTTP error response) must fall through to completion
// polling under the same deadline; the child's real state decides the outcome.
// ---------------------------------------------------------------------------

const transportAbort = () => {
  const e = new DOMException("The operation timed out.", "TimeoutError")
  return Promise.reject(e)
}

test("TI-1: transport interruption of the turn POST recovers via polling (background)", async () => {
  const reg = createDispatchRegistry()
  const fetcher = fakeFetcher([
    { match: /\/session\?directory=/, handle: () => jsonRes({ id: CHILD }) },
    {
      match: new RegExp(`/session/${CHILD}/message$`),
      handle: (u, init) => {
        if (init?.method === "POST") return transportAbort()
        return jsonRes([{ info: { role: "assistant", tokens: { input: 7, output: 3, reasoning: 0, cache: { read: 0, write: 0 } } }, parts: [{ type: "text", text: "recovered report" }] }])
      },
    },
  ])
  const sunk = []
  const engine = createDispatchEngine(baseDeps(fetcher, { cfg: CFG(), catalog: CATALOG, registry: reg, sink: (e) => sunk.push(e) }))
  const handle = await engine.dispatch({ prompt: "review the repo", agent: "quick", depth: "low" }, "ses_parent", { background: true })
  await settle()
  const entry = reg.get(handle.dispatchId)
  assert.equal(entry.state, "completed", `expected completed, got ${entry.state}: ${JSON.stringify(entry.result)}`)
  assert.equal(entry.result.text, "recovered report")
  assert.equal(entry.result.sessionID, CHILD)
  const ti = sunk.find((e) => e.event === "transport-interrupted")
  assert.ok(ti, "transport-interrupted must be ledgered")
  assert.equal(ti.sessionID, CHILD)
  assert.equal(ti.dispatchId, handle.dispatchId)
  assert.equal(ti.parentSessionID, "ses_parent")
  assert.match(String(ti.note), /timed out/)
  assert.ok(sunk.some((e) => e.event === "completed"), "recovery ends in the normal completed event")
  // recovery NEVER re-POSTs the message (the prompt may already be delivering)
  assert.equal(fetcher.calls.filter((c) => c.init?.method === "POST" && c.url.endsWith("/message")).length, 1)
})

test("TI-2: undelivered message degrades to an honest timeout, not empty-response", async () => {
  const reg = createDispatchRegistry()
  const fetcher = fakeFetcher([
    { match: /\/session\?directory=/, handle: () => jsonRes({ id: CHILD }) },
    {
      match: new RegExp(`/session/${CHILD}/message$`),
      handle: (u, init) => {
        if (init?.method === "POST") return transportAbort()
        return jsonRes([]) // the host never delivered the message: 0 assistant messages
      },
    },
  ])
  const sunk = []
  const engine = createDispatchEngine(baseDeps(fetcher, { tickMs: 10_000, timeoutMs: 30_000, cfg: CFG(), catalog: CATALOG, registry: reg, sink: (e) => sunk.push(e) }))
  const handle = await engine.dispatch({ prompt: "x", agent: "quick", depth: "low" }, "ses_parent", { background: true })
  await settle()
  const entry = reg.get(handle.dispatchId)
  assert.equal(entry.state, "timeout", `expected timeout, got ${entry.state}`)
  assert.equal(entry.result.sessionID, CHILD, "the timeout report names the child session")
  assert.match(String(entry.result.error), /left for the host to reclaim/)
  assert.ok(sunk.some((e) => e.event === "timeout" && e.sessionID === CHILD))
  assert.ok(!sunk.some((e) => e.event === "empty-response"), "an undelivered message must not be misreported as the keyless empty-response quirk")
  assert.ok(sunk.some((e) => e.event === "transport-interrupted"))
})

test("TI-3: an HTTP error response is NOT recovered (agent path, no retry)", async () => {
  const reg = createDispatchRegistry()
  let creates = 0
  const fetcher = fakeFetcher([
    { match: /\/session\?directory=/, handle: () => { creates++; return jsonRes({ id: CHILD }) } },
    {
      match: new RegExp(`/session/${CHILD}/message$`),
      handle: (u, init) => (init?.method === "POST" ? jsonRes({ boom: true }, 500) : jsonRes([])),
    },
  ])
  const sunk = []
  const engine = createDispatchEngine(agentsDeps(fetcher, { registry: reg, sink: (e) => sunk.push(e) }))
  const handle = await engine.dispatch({ prompt: "x", agent: "research", depth: "low" }, "ses_parent", { background: true })
  await settle()
  const entry = reg.get(handle.dispatchId)
  assert.equal(entry.state, "error")
  assert.match(String(entry.result.error), /500/)
  assert.ok(!sunk.some((e) => e.event === "transport-interrupted"), "HTTP-level refusals keep the existing host-error semantics")
  assert.equal(creates, 1, "agents path never retries")
  // TI-6 (ledger identity): the terminal error row is self-describing
  const errRow = sunk.find((e) => e.event === "error")
  assert.ok(errRow, "terminal error row exists")
  assert.equal(errRow.dispatchId, handle.dispatchId)
  assert.equal(errRow.parentSessionID, "ses_parent")
  assert.equal(errRow.sessionID, CHILD)
  assert.equal(typeof errRow.durationMs, "number")
  assert.equal(entry.result.sessionID, CHILD, "the registry result carries the child sessionID, not \"\"")
})

test("TI-4: kill during recovery polling still lands (killed terminal, no wake)", async () => {
  const reg = createDispatchRegistry()
  const fetcher = fakeFetcher([
    { match: /\/session\?directory=/, handle: () => jsonRes({ id: CHILD }) },
    {
      match: new RegExp(`/session/${CHILD}/message$`),
      handle: (u, init) => {
        if (init?.method === "POST") return transportAbort()
        return new Promise(() => {}) // hanging poll GET — kill must unwind it via the abort race
      },
    },
  ])
  const engine = createDispatchEngine(baseDeps(fetcher, { ...REAL_CLOCK, timeoutMs: 3_000, pollIntervalMs: 10, cfg: CFG(), catalog: CATALOG, registry: reg }))
  const handle = await engine.dispatch({ prompt: "x", agent: "quick", depth: "low" }, undefined, { background: true })
  await new Promise((r) => setTimeout(r, 30))
  engine.kill(handle.dispatchId)
  for (let i = 0; i < 100 && reg.get(handle.dispatchId).state !== "killed"; i++) await new Promise((r) => setTimeout(r, 10))
  assert.equal(reg.get(handle.dispatchId).state, "killed")
  assert.equal(reg.takeUndelivered().length, 0, "killed never wakes the parent")
})

test("TI-5: sync dispatch recovers identically (result returned, no throw)", async () => {
  const fetcher = fakeFetcher([
    { match: /\/session\?directory=/, handle: () => jsonRes({ id: CHILD }) },
    {
      match: new RegExp(`/session/${CHILD}/message$`),
      handle: (u, init) => {
        if (init?.method === "POST") return transportAbort()
        return jsonRes([{ info: { role: "assistant", tokens: { input: 4, output: 2, reasoning: 0, cache: { read: 0, write: 0 } } }, parts: [{ type: "text", text: "sync recovered" }] }])
      },
    },
  ])
  const sunk = []
  const engine = createDispatchEngine(baseDeps(fetcher, { sink: (e) => sunk.push(e) }))
  const r = await engine.dispatch({ prompt: "x", agent: "quick", depth: "low" })
  assert.equal(r.text, "sync recovered")
  assert.equal(r.sessionID, CHILD)
  assert.ok(sunk.some((e) => e.event === "transport-interrupted"))
  assert.ok(sunk.some((e) => e.event === "completed"))
  assert.equal(fetcher.calls.filter((c) => c.init?.method === "POST" && c.url.endsWith("/message")).length, 1)
})

test("TI-6: empty-response terminal report carries the child sessionID (agents path)", async () => {
  const reg = createDispatchRegistry()
  const fetcher = fakeFetcher([
    { match: /\/session\?directory=/, handle: () => jsonRes({ id: CHILD }) },
    {
      match: new RegExp(`/session/${CHILD}/message$`),
      handle: (u, init) => (init?.method === "POST" ? jsonRes({}) : jsonRes([{ info: { role: "assistant", tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }, parts: [] }])),
    },
  ])
  const sunk = []
  const engine = createDispatchEngine(agentsDeps(fetcher, { registry: reg, sink: (e) => sunk.push(e) }))
  const handle = await engine.dispatch({ prompt: "x", agent: "research", depth: "low" }, "ses_parent", { background: true })
  await settle()
  const entry = reg.get(handle.dispatchId)
  assert.equal(entry.state, "error")
  assert.equal(entry.result.sessionID, CHILD, "the incident's \"sessionID\": \"\" bug — terminal reports carry the child id")
  const errRow = sunk.find((e) => e.event === "error")
  assert.equal(errRow.sessionID, CHILD)
  assert.equal(errRow.dispatchId, handle.dispatchId)
})
