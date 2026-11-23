import test from "node:test"
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"

// REAL-PATH coverage for the crew-continue-native-child-gate capability
// seam (change task 4.2, sandbox E2E finding 2026-11-23).
//
// The gate's unit layer (native-child-gate-wiring.test.mjs) drove a STUB
// client that happened to provide session.list/session.status — and the
// production v2 adapter provides NEITHER (the promise-layer ctx.session
// domain has no list/status), so the gate was a structural no-op on live
// hosts while every stub test stayed green. These tests close that class:
// the PRODUCTION adapter (v2SessionClientForTests) builds the PRODUCTION
// walker (v2NativeChildWalker) and the only fake is the host's HTTP surface
// — serving the shapes RECORDED from a live 2.3.2 host (bare session rows,
// bare active map; sandbox E2E evidence in reports/e2e-convergence-2026-11-23.md).
//
// Env knobs are module-level consts — set BEFORE plugin.ts is imported.
process.env.FORGE_GOAL_DEBOUNCE_MS = "10"
process.env.FORGE_CREW_CHILD_RESUME_DEBOUNCE_MS = "10"
process.env.FORGE_TEST_FORGE_HOME = mkdtempSync(join(tmpdir(), "ncw-home-"))
process.env.FORGE_TEST_NO_DISPATCH_FETCH = "1"
const { server, noteCrewNativeChildEvent, resetServiceHttpDiscoveryForTests, setCrewNativeChildClockForTests, v2SessionClientForTests, v2WiringSeam } = await import("../plugin.ts")
const { nativeChildrenInFlight, walkNativeChildren } = await import("../src/native-child-gate.ts")

/** Fake host HTTP surface with the live-2.3.2 shapes; `state` is mutable per test. */
async function fakeHost(t) {
  const state = {
    sessions: [],
    active: {},
    listStatus: 200,
    activeStatus: 200,
    rawList: null,
    rawActive: null,
    auth: [],
    queries: [],
  }
  const json = (res, body) => {
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify(body))
  }
  const srv = createServer((req, res) => {
    state.auth.push(req.headers.authorization)
    state.queries.push(req.url)
    const path = req.url.split("?")[0]
    if (path === "/api/session") {
      return state.listStatus === 200 ? json(res, state.rawList ?? state.sessions) : (res.writeHead(state.listStatus), res.end("nope"))
    }
    if (path === "/api/session/active") {
      return state.activeStatus === 200 ? json(res, state.rawActive ?? state.active) : (res.writeHead(state.activeStatus), res.end("nope"))
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise((r) => srv.listen(0, "127.0.0.1", r))
  const port = srv.address().port
  const dir = mkdtempSync(join(tmpdir(), "ncw-svc-"))
  const svcFile = join(dir, "service.json")
  writeFileSync(svcFile, JSON.stringify({ url: `http://127.0.0.1:${port}`, password: "pw-e2e" }))
  process.env.FORGE_SERVICE_FILE = svcFile
  resetServiceHttpDiscoveryForTests()
  t.after(async () => {
    srv.closeAllConnections?.()
    await new Promise((r) => srv.close(r))
    delete process.env.FORGE_SERVICE_FILE
    resetServiceHttpDiscoveryForTests()
    rmSync(dir, { recursive: true, force: true })
  })
  return state
}

/** The PRODUCTION v2 adapter over a mock promise-layer session domain. */
function adapterFor(prompts) {
  return v2SessionClientForTests({
    session: {
      prompt: async (input) => {
        prompts.push(input)
      },
      get: async () => undefined,
    },
  })
}

// ---------------------------------------------------------------------------
// Capability seam: the adapter carries the walker; the shared session domain
// is UNTOUCHED (blast-radius guard — six other call sites probe list/status
// with v1-shaped expectations).
// ---------------------------------------------------------------------------
test("v2 adapter carries a dedicated native-child walker — session.list/status stay ABSENT on the shared domain", async (t) => {
  await fakeHost(t)
  const adapter = adapterFor([])
  assert.ok(adapter, "adapter built")
  assert.equal(typeof adapter.session.list, "undefined", "session.list is NOT added to the shared adapter domain")
  assert.equal(typeof adapter.session.status, "undefined", "session.status is NOT added to the shared adapter domain")
  assert.equal(typeof adapter.nativeChildWalker?.session?.list, "function", "dedicated walker exposes list")
  assert.equal(typeof adapter.nativeChildWalker?.session?.status, "function", "dedicated walker exposes status")
})

// ---------------------------------------------------------------------------
// Live shapes (recorded from a running 2.3.2 host): GET /api/session returns
// BARE rows; GET /api/session/active returns the BARE map {id:{type}}.
// ---------------------------------------------------------------------------
test("walker reads the live 2.3.2 shapes — bare session rows + bare active map ⇒ native child in flight", async (t) => {
  const state = await fakeHost(t)
  const walker = adapterFor([]).nativeChildWalker
  state.sessions = [
    { id: "c1", parentID: "p1", agent: "build" },
    { id: "x1", parentID: "someone-else" },
    { id: "p1", agent: "forge" },
  ]
  state.active = { c1: { type: "running" } }
  assert.equal(await nativeChildrenInFlight(walker, "p1"), true, "a running child of p1 ⇒ in flight")
  assert.deepEqual(
    [...state.auth].slice(0, 2),
    [0, 1].map(() => "Basic " + Buffer.from("opencode:pw-e2e").toString("base64")),
    "host Basic auth from service.json on every walker call",
  )
  assert.deepEqual(
    [...state.queries].slice(0, 2),
    ["/api/session?parentID=p1&limit=500", "/api/session/active"],
    "the two sanctioned surfaces — the list page scoped to THIS session's children and widened past the newest-50 cap (real host 2026-11-23: a parent with 85 children answers 50 rows without the limit, all 85 with it)",
  )
})

test("terminal = absent from the active map OR type idle ⇒ not in flight (gate opens)", async (t) => {
  const state = await fakeHost(t)
  const walker = adapterFor([]).nativeChildWalker
  state.sessions = [{ id: "c1", parentID: "p1" }]
  state.active = {}
  assert.equal(await nativeChildrenInFlight(walker, "p1"), false, "absent from the active map = inactive (host contract)")
  state.active = { c1: { type: "idle" } }
  assert.equal(await nativeChildrenInFlight(walker, "p1"), false, "explicit idle type = terminal")
})

test("envelope tolerance: {data:[…]} / {sessions:[…]} list bodies and a {data:{…}} active body all parse", async (t) => {
  const state = await fakeHost(t)
  const walker = adapterFor([]).nativeChildWalker
  state.active = { c1: { type: "running" } }
  for (const raw of [{ data: [{ id: "c1", parentID: "p1" }] }, { sessions: [{ id: "c1", parentID: "p1" }] }]) {
    state.rawList = raw
    assert.equal(await nativeChildrenInFlight(walker, "p1"), true, `list body ${Object.keys(raw)[0]}`)
  }
  state.rawList = [{ id: "c1", parentID: "p1" }]
  state.rawActive = { data: { c1: { type: "running" } } }
  assert.equal(await nativeChildrenInFlight(walker, "p1"), true, "already-enveloped active body passes its inner map through")
})

test("fail-OPEN on every live-view failure: HTTP 5xx on either surface, garbage bodies, missing service.json", async (t) => {
  const state = await fakeHost(t)
  const walker = adapterFor([]).nativeChildWalker
  state.sessions = [{ id: "c1", parentID: "p1" }]
  state.active = { c1: { type: "running" } }
  state.listStatus = 500
  assert.equal(await nativeChildrenInFlight(walker, "p1"), false, "list HTTP 500 ⇒ send (fail-open)")
  state.listStatus = 200
  state.activeStatus = 503
  assert.equal(await nativeChildrenInFlight(walker, "p1"), false, "active HTTP 503 ⇒ send (fail-open)")
  state.activeStatus = 200
  state.rawActive = "not-a-map"
  assert.equal(await nativeChildrenInFlight(walker, "p1"), false, "garbage active body ⇒ send (fail-open)")
  state.rawActive = null
  // Missing service.json: discovery fails ⇒ the walker throws ⇒ fail-open.
  const gone = join(tmpdir(), "ncw-no-service-" + Date.now(), "service.json")
  process.env.FORGE_SERVICE_FILE = gone
  resetServiceHttpDiscoveryForTests()
  assert.equal(await nativeChildrenInFlight(walker, "p1"), false, "no service.json ⇒ send (fail-open)")
  // Restore this test's fake service for the after() hook.
  const live = state.queries.length // (keep state referenced)
  assert.ok(live >= 0)
})

test("server-side parentID filter rides when the caller hints it; the bare call lists everything", async (t) => {
  const state = await fakeHost(t)
  const walker = adapterFor([]).nativeChildWalker
  state.sessions = [{ id: "c1", parentID: "p1" }]
  await walker.session.list({ parentID: "p1" })
  assert.equal(state.queries.at(-1), "/api/session?parentID=p1&limit=500", "the scoped call asks for the widened page")
  await walker.session.list({})
  assert.equal(state.queries.at(-1), "/api/session", "the bare call is unchanged")
})

// ---------------------------------------------------------------------------
// REAL PATH through the engine: idle edge → continueCrewIfEligible → the
// PRODUCTION adapter's walker → fake host HTTP. This is the test that was
// missing: the stub suite could not see that the live adapter had no
// capability path.
// ---------------------------------------------------------------------------
const allowAsk = async () => {}
const toolCtx = (sid, worktree) => ({ sessionID: sid, worktree, ask: allowAsk, metadata() {}, callID: "c", agent: "forge", messageID: "m" })
let poolCounter = 0
function crewWorktree(t) {
  const wt = mkdtempSync(join(tmpdir(), "ncw-"))
  t.after(() => {
    try {
      rmSync(wt, { recursive: true, force: true })
    } catch {}
  })
  mkdirSync(join(wt, ".opencode"), { recursive: true })
  writeFileSync(join(wt, ".opencode", "forge.json"), JSON.stringify({ pool: `ncw${++poolCounter}`, agents: { research: { model: "zai/glm", thoughtLevel: "low" } } }))
  return wt
}

test("REAL PATH — production v2 adapter + HTTP walker: busy native child suppresses the crew brief; terminal re-arms ONE brief carrying the digest", async (t) => {
  const state = await fakeHost(t)
  const sid = "ses_ncw-p1"
  const child = "ses_ncw-child-1"
  state.sessions = [{ id: child, parentID: sid }]
  state.active = { [child]: { type: "running" } }

  const prompts = []
  const adapter = adapterFor(prompts)
  const wt = crewWorktree(t)
  const hooks = await server({
    client: adapter,
    project: { id: "p" },
    directory: wt,
    worktree: wt,
    serverUrl: new URL("http://127.0.0.1:1"),
    $: {},
    experimental_workspace: { register() {} },
  })
  await hooks.config({ agent: {} }) // re-anchor the pool loader to THIS worktree
  await hooks.tool.crew_begin.execute({ objective: "real path", subtasks: [{ title: "one" }] }, toolCtx(sid, wt))
  await hooks.tool.crew_begin.execute({ execution: "waves" }, toolCtx(sid, wt))

  // (a) busy native child: three idle edges, each walked to COMPLETION against
  // the host view, ZERO briefs. Timing-safe by construction: a local HTTP
  // round trip on a loaded machine costs hundreds of ms, so every idle edge
  // is awaited until its walk actually read the active view — never a sleep
  // that could pass vacuously before the walk returned.
  const activeCalls = () => state.queries.filter((q) => q.startsWith("/api/session/active")).length
  const until = async (fn, what, timeoutMs = 15_000) => {
    const t0 = Date.now()
    while (Date.now() - t0 < timeoutMs) {
      if (fn()) return
      await sleep(25)
    }
    assert.fail(`timeout waiting for: ${what}`)
  }
  for (let i = 0; i < 3; i++) {
    const before = activeCalls()
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: sid } } })
    await until(() => activeCalls() > before, `idle edge ${i + 1} walked the active view`)
  }
  await sleep(150) // let any (wrongly sent) brief land before the assertion
  assert.equal(prompts.length, 0, "zero briefs across three fully-walked idle edges while the native child runs (live adapter path)")
  assert.ok(v2WiringSeam.crewNativeCeiling.has(sid), "suppression episode seeded through the live adapter path")

  // (b) the child goes terminal: the advisory tracker learns it, the walk
  // re-anchors (absent from the active map) ⇒ exactly ONE re-armed brief
  // carrying the digest line.
  noteCrewNativeChildEvent("session.created", { info: { id: child, parentID: sid } }, adapter)
  state.active = {}
  noteCrewNativeChildEvent("session.execution.succeeded", { sessionID: child }, adapter)
  await until(() => prompts.length >= 1, "the re-armed brief")
  await sleep(250) // a second (duplicate) brief would land here
  assert.equal(prompts.length, 1, "exactly one re-armed brief")
  const brief = JSON.stringify(prompts[0])
  assert.ok(brief.includes("[forge:crew-continue]"), "the brief is the crew continuation")
  assert.ok(brief.includes(`native child ${child} succeeded`), "digest line rides the brief: child id + outcome")
  assert.equal(v2WiringSeam.crewChildDigest.has(sid), false, "digest cleared on successful delivery")
  await hooks.dispose?.()
})

test("REAL PATH — walker view failure fails OPEN through the engine: the brief is sent, nothing is suppressed", async (t) => {
  const state = await fakeHost(t)
  const sid = "ses_ncw-p2"
  state.sessions = [{ id: "ses_ncw-child-2", parentID: sid }]
  state.activeStatus = 500 // the host's active view is unreadable
  const prompts = []
  const adapter = adapterFor(prompts)
  const wt = crewWorktree(t)
  const hooks = await server({
    client: adapter,
    project: { id: "p" },
    directory: wt,
    worktree: wt,
    serverUrl: new URL("http://127.0.0.1:1"),
    $: {},
    experimental_workspace: { register() {} },
  })
  await hooks.config({ agent: {} })
  await hooks.tool.crew_begin.execute({ objective: "fail open", subtasks: [{ title: "one" }] }, toolCtx(sid, wt))
  await hooks.tool.crew_begin.execute({ execution: "waves" }, toolCtx(sid, wt))
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: sid } } })
  const t0 = Date.now()
  while (prompts.length === 0 && Date.now() - t0 < 15_000) await sleep(25)
  assert.equal(prompts.length, 1, "unreadable host view ⇒ the brief is sent (a false in-flight would strand the crew)")
  assert.equal(v2WiringSeam.crewNativeCeiling.has(sid), false, "no suppression episode was opened")
  await hooks.dispose?.()
})

// ---------------------------------------------------------------------------
// D8 REAL PATH (sandbox E2E findings #2/#3, 2026-11-23). The test above
// seeded the tracker AFTER the arm — the one order that hides the defect.
// On the live host the child's session.created arrived BEFORE the crew was
// armed; a fresh crew_begin wipes the parent's tracker rows, so the terminal
// edge found nothing to name and the first post-terminal brief carried NO
// outcome line. The WALK is the authority now; events only accelerate.
// ---------------------------------------------------------------------------
const until = async (fn, what, timeoutMs = 15_000) => {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    if (fn()) return
    await sleep(25)
  }
  assert.fail(`timeout waiting for: ${what}`)
}
const activeCalls = (state) => state.queries.filter((q) => q.startsWith("/api/session/active")).length
const idleEdge = (hooks, sid) => hooks.event({ event: { type: "session.idle", properties: { sessionID: sid } } })
async function realPath(t, adapter, sid, objective) {
  const wt = crewWorktree(t)
  const hooks = await server({
    client: adapter,
    project: { id: "p" },
    directory: wt,
    worktree: wt,
    serverUrl: new URL("http://127.0.0.1:1"),
    $: {},
    experimental_workspace: { register() {} },
  })
  await hooks.config({ agent: {} }) // re-anchor the pool loader to THIS worktree
  await hooks.tool.crew_begin.execute({ objective, subtasks: [{ title: "one" }] }, toolCtx(sid, wt))
  await hooks.tool.crew_begin.execute({ execution: "waves" }, toolCtx(sid, wt))
  return hooks
}
/** One idle edge, awaited until its walk actually read the active view. */
async function walkedIdleEdge(hooks, state, sid) {
  const before = activeCalls(state)
  await idleEdge(hooks, sid)
  await until(() => activeCalls(state) > before, "the idle edge walked the active view")
}

test("REAL PATH — a child created BEFORE the crew is armed is named with its outcome (live Leg B order, live payload shapes)", async (t) => {
  const state = await fakeHost(t)
  const sid = "ses_ncw-p3"
  const child = "ses_ncw-child-3"
  state.sessions = [{ id: child, parentID: sid }] // a running child's row carries no outcome (live)
  state.active = { [child]: { type: "running" } }
  const prompts = []
  const adapter = adapterFor(prompts)
  // session.created exactly as captured from the live host (flat data).
  noteCrewNativeChildEvent("session.created", { sessionID: child, slug: "eager-cabin", version: "2.3.2", parentID: sid }, adapter)
  const hooks = await realPath(t, adapter, sid, "pre-arm child")
  assert.equal(v2WiringSeam.crewNativeChildren.rows().has(child), false, "the fresh registration wiped the tracker row (existing semantics — and exactly why the walk must be the authority)")

  await walkedIdleEdge(hooks, state, sid)
  await sleep(200)
  assert.equal(prompts.length, 0, "suppressed")
  assert.ok(v2WiringSeam.crewNativeWatch.get(sid)?.has(child), "the WALK is waiting on the pre-arm child")
  assert.equal(v2WiringSeam.crewNativeRecheckArmed(sid), true, "a suppressed decision arms the suppression re-check")

  // Settles: the row carries its outcome (live shape), it leaves the active
  // map, and the terminal event arrives in the live shape {sessionID}.
  state.sessions = [{ id: child, parentID: sid, outcome: "succeeded", time: { created: 1, updated: 2, busy: 1, idle: 2 } }]
  state.active = {}
  noteCrewNativeChildEvent("session.execution.succeeded", { sessionID: child }, adapter)
  await until(() => prompts.length >= 1, "the resumed brief")
  await sleep(300) // a duplicate would land here
  assert.equal(prompts.length, 1, "exactly one resumed brief")
  const brief = JSON.stringify(prompts[0])
  assert.ok(brief.includes("[forge:crew-continue]"), "the brief is the crew continuation")
  assert.ok(brief.includes(`native child ${child} succeeded`), "the pre-arm child is named with its outcome — the line the live run was missing")
  assert.equal(v2WiringSeam.crewNativeRecheckArmed(sid), false, "the re-check is disarmed once the episode ended")
  await hooks.dispose?.()
})

test("REAL PATH — the event stream is lost entirely: the next idle edge's walk names the settled child from its ROW (interrupted ⇒ DEAD)", async (t) => {
  const state = await fakeHost(t)
  const sid = "ses_ncw-p4"
  const child = "ses_ncw-child-4"
  state.sessions = [{ id: child, parentID: sid }]
  state.active = { [child]: { type: "running" } }
  const prompts = []
  const adapter = adapterFor(prompts)
  const hooks = await realPath(t, adapter, sid, "stream lost")
  await walkedIdleEdge(hooks, state, sid)
  assert.equal(prompts.length, 0, "suppressed")

  // No event reaches the plugin. The host view alone changes.
  state.sessions = [{ id: child, parentID: sid, outcome: "interrupted" }]
  state.active = {}
  await walkedIdleEdge(hooks, state, sid)
  await until(() => prompts.length >= 1, "the brief after the settled child")
  const brief = JSON.stringify(prompts[0])
  assert.ok(brief.includes(`native child ${child} interrupted`), "the row's outcome names the child")
  assert.match(brief, /DEAD/, "an interrupted child is disclosed dead")
  assert.equal(v2WiringSeam.crewNativeWatch.get(sid)?.size ?? 0, 0, "nothing waited on after the delivered brief")
  await hooks.dispose?.()
})

test("REAL PATH — a waited-on child DELETED mid-run: the suppression re-check alone resumes the crew (no idle edge, no event) and names it UNVERIFIED", async (t) => {
  const state = await fakeHost(t)
  const sid = "ses_ncw-p5"
  const child = "ses_ncw-child-5"
  state.sessions = [{ id: child, parentID: sid }]
  state.active = { [child]: { type: "running" } }
  const prompts = []
  const adapter = adapterFor(prompts)
  const hooks = await realPath(t, adapter, sid, "deleted child")
  await walkedIdleEdge(hooks, state, sid)
  assert.equal(v2WiringSeam.crewNativeRecheckArmed(sid), true)

  // The child's row disappears (DELETE /api/session/{id} on the live host);
  // no terminal edge, and the parent never runs another turn ⇒ no idle edge.
  state.sessions = []
  state.active = {}
  await sleep(150)
  assert.equal(prompts.length, 0, "nothing resumes on its own before the re-check")
  await v2WiringSeam.crewNativeRecheckNow(sid, adapter) // what the timer calls
  await until(() => prompts.length >= 1, "the re-check's resumed brief")
  await sleep(300)
  assert.equal(prompts.length, 1, "exactly one brief")
  const brief = JSON.stringify(prompts[0])
  assert.ok(brief.includes(`native child ${child} is no longer running`), "the vanished child is named")
  assert.match(brief, /UNVERIFIED/, "no verdict is invented for a row that no longer exists")
  await hooks.dispose?.()
})

test("REAL PATH — the re-check keeps the crew HELD while the child is in flight, and evaluates the ceiling without any idle edge", async (t) => {
  const state = await fakeHost(t)
  const sid = "ses_ncw-p6"
  const child = "ses_ncw-child-6"
  state.sessions = [{ id: child, parentID: sid }]
  state.active = { [child]: { type: "running" } }
  const prompts = []
  const adapter = adapterFor(prompts)
  const hooks = await realPath(t, adapter, sid, "held")
  let now = 5_000_000
  setCrewNativeChildClockForTests(() => now)
  const originalWarn = console.warn
  let warns = 0
  console.warn = () => {
    warns++
  }
  try {
    await walkedIdleEdge(hooks, state, sid)
    for (let i = 0; i < 3; i++) {
      await v2WiringSeam.crewNativeRecheckNow(sid, adapter)
      await sleep(60)
    }
    assert.equal(prompts.length, 0, "three re-checks while the child runs ⇒ zero briefs")
    assert.equal(v2WiringSeam.crewNativeRecheckArmed(sid), true, "still held ⇒ the re-check stays armed")

    now += 900_000 // default FORGE_CREW_NATIVE_CHILD_CEILING_MS
    await v2WiringSeam.crewNativeRecheckNow(sid, adapter)
    await until(() => prompts.length >= 1, "the ceiling brief")
    await sleep(200)
    assert.equal(prompts.length, 1, "past the ceiling the re-check resumes the crew once")
    assert.equal(warns, 1, "exactly ONE bounded disclosure")
    assert.equal(v2WiringSeam.crewNativeCeiling.get(sid)?.disclosed, true)
    assert.doesNotMatch(JSON.stringify(prompts[0]), /native child/, "a child still in flight is not named as settled")
  } finally {
    console.warn = originalWarn
    setCrewNativeChildClockForTests(null)
    await hooks.dispose?.()
  }
})

test("REAL PATH — v2 send-time busy re-check: a parent mid-turn gets NO brief; the brief lands on its next idle edge", async (t) => {
  const state = await fakeHost(t)
  const sid = "ses_ncw-p7"
  state.sessions = [] // no native children at all
  state.active = { [sid]: { type: "running" } } // the PARENT is mid-turn (the user resumed, or the host's own wake)
  const prompts = []
  const adapter = adapterFor(prompts)
  const hooks = await realPath(t, adapter, sid, "busy parent")
  await walkedIdleEdge(hooks, state, sid) // walks the list, then reads the active map for the parent
  await sleep(250)
  assert.equal(prompts.length, 0, "no brief into a session that is busy — the re-check that never ran on live v2 hosts before")

  state.active = {} // its turn ended
  await walkedIdleEdge(hooks, state, sid)
  await until(() => prompts.length >= 1, "the brief on the next idle edge")
  assert.equal(prompts.length, 1)
  assert.ok(JSON.stringify(prompts[0]).includes("[forge:crew-continue]"))
  await hooks.dispose?.()
})

test("REAL PATH — walker view: the scoped HTTP page with live row shapes yields in-flight + settled with validated outcomes", async (t) => {
  const state = await fakeHost(t)
  const walker = adapterFor([]).nativeChildWalker
  state.sessions = [
    { id: "c-run", parentID: "p1", time: { created: 1, updated: 2, busy: 1 } },
    { id: "c-ok", parentID: "p1", outcome: "succeeded", time: { created: 1, updated: 9, busy: 1, idle: 9 } },
    { id: "c-cut", parentID: "p1", outcome: "interrupted", time: { created: 1, updated: 5, busy: 1, idle: 5 } },
    { id: "c-never", parentID: "p1" }, // created, never prompted
    { id: "c-other", parentID: "p2", outcome: "failed" },
  ]
  state.active = { "c-run": { type: "running" }, "c-other": { type: "running" } }
  assert.deepEqual(await walkNativeChildren(walker, "p1"), {
    readable: true,
    inFlight: ["c-run"],
    settled: [
      { childID: "c-ok", outcome: "succeeded" },
      { childID: "c-cut", outcome: "interrupted" },
      { childID: "c-never", outcome: null },
    ],
  })
  // A host list that cannot be parsed reports nothing known (fail-open AND no digest).
  state.rawList = { unexpected: true }
  assert.deepEqual(await walkNativeChildren(walker, "p1"), { readable: false, inFlight: [], settled: [] })
})
