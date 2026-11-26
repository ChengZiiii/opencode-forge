import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServer } from "node:http"
import { createV2MockContext } from "./lib/v2-mock-context.mjs"

// Stub-client coverage for the NATIVE-CHILD GATE wiring of the crew idle
// engine (change crew-continue-native-child-gate, tasks 3.1-3.7, design
// D2-D7). Same recipe as crew-continue.test.mjs, extended with the host-view
// stubs the gate reads: session.list (child sessions with parentID) and the
// dual-mode session.status (no-arg ⇒ {data:{…busy map…}} for the gate walk;
// {path:{id}} ⇒ the per-session idle re-check). Env knobs are module-level
// consts — they must be set BEFORE plugin.ts is imported.
process.env.FORGE_GOAL_DEBOUNCE_MS = "10"
process.env.FORGE_CREW_CHILD_RESUME_DEBOUNCE_MS = "10"
process.env.FORGE_TEST_FORGE_HOME = mkdtempSync(join(tmpdir(), "ncg-home-"))
process.env.FORGE_TEST_NO_DISPATCH_FETCH = "1"
const { v2Setup, resetServiceHttpDiscoveryForTests, setCrewNativeChildClockForTests, v2WiringSeam } = await import("../plugin.ts")

const allowAsk = async () => {}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(predicate, description, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail(`timeout waiting for ${description}`)
    await sleep(10)
  }
}

let sidCounter = 0
const nextSid = () => `ses_ncg-${++sidCounter}`
let childCounter = 0
const nextChild = () => `ses_ncg-child-${++childCounter}`

// The mutable host view the gate walks. list = session.list body; status =
// the no-arg status() body (busy map, keys = busy ids); listThrow /
// statusThrow flip the fail-open subcases; noList drops session.list.
function makeHostView(sid) {
  return {
    list: [{ id: nextChild(), parentID: sid }],
    status: { data: {} },
    listThrow: false,
    statusThrow: false,
    noList: false,
    garbageList: false,
    noStatus: false,
  }
}


function toolCtx(sid, worktree, ask = allowAsk) {
  return { sessionID: sid, worktree, ask, metadata() {}, callID: "c", agent: "forge", messageID: "m" }
}

let poolCounter = 0
function crewWorktree(t) {
  const wt = mkdtempSync(join(tmpdir(), "ncg-"))
  t.after(() => {
    try {
      rmSync(wt, { recursive: true, force: true })
    } catch {}
  })
  mkdirSync(join(wt, ".opencode"), { recursive: true })
  // Unique pool namespace per worktree: the fail-open subcases stack several
  // live harnesses in one test — a shared name trips the collision warning.
  writeFileSync(join(wt, ".opencode", "forge.json"), JSON.stringify({ pool: `ncg${++poolCounter}`, agents: { research: { model: "zai/glm", thoughtLevel: "low" } } }))
  return wt
}

async function crewHarness(t, sid, overrides = {}) {
  const view = Object.assign(makeHostView(sid), overrides)
  view.worktree = crewWorktree(t)
  view.prompts = []
  const host = createServer((req, res) => {
    const active = req.url.startsWith("/api/session/active")
    if ((active && view.statusThrow) || (!active && (view.listThrow || view.noList))) { res.writeHead(500); res.end(); return }
    res.setHeader("content-type", "application/json")
    res.end(JSON.stringify(active ? view.status : view.garbageList ? { unexpected: true } : view.list))
  })
  await new Promise((resolve) => host.listen(0, "127.0.0.1", resolve))
  const service = join(view.worktree, "service.json")
  writeFileSync(service, JSON.stringify({ url: `http://127.0.0.1:${host.address().port}`, password: "test" }))
  process.env.FORGE_SERVICE_FILE = service
  resetServiceHttpDiscoveryForTests()
  v2WiringSeam.resetHostAnchors()
  const { ctx, state } = createV2MockContext()
  ctx.session.prompt = async (input) => { view.prompts.push(input) }
  const cleanup = await v2Setup(ctx, { anchors: [view.worktree], materialize: "runtime" })
  t.after(async () => { await cleanup?.(); v2WiringSeam.resetHostAnchors(); host.closeAllConnections?.(); await new Promise((resolve) => host.close(resolve)); delete process.env.FORGE_SERVICE_FILE; resetServiceHttpDiscoveryForTests() })
  return { view, state, prompts: view.prompts, cleanup }
}

async function armCrew(state, wt, sid, objective = "ship the thing", titles = ["alpha", "beta"]) {
  await state.tools.get("crew_begin").execute({ objective, subtasks: titles.map((title) => ({ title })) }, toolCtx(sid, wt))
  return state.tools.get("crew_begin").execute({ execution: "waves" }, toolCtx(sid, wt))
}

const briefText = (p) => p.text
const idle = (state, sid) => state.sessionHooks.find((h) => h.name === "experimental.idle").cb({ sessionID: sid, background: [] })
const childBusy = (view, child) => {
  view.list = [{ id: child, parentID: view.list[0]?.parentID ?? "" }]
  view.status = { data: { [child]: { type: "running" } } }
}

// ---------------------------------------------------------------------------
// 3.1 — busy native child suppresses the brief: zero briefs across repeated
// idle edges; the suppression is NOT a turn (no no-progress streak, no
// transport-failure count, no ledger effect).
// ---------------------------------------------------------------------------
test("native-child gate: busy native child suppresses the crew brief — zero briefs, suppression is not a turn", async (t) => {
  const sid = nextSid()
  const { view, state, prompts, cleanup } = await crewHarness(t, sid)
  const child = view.list[0].id
  childBusy(view, child)
  await armCrew(state, view.worktree, sid, "suppress me", ["one"])

  for (let i = 0; i < 4; i++) {
    await idle(state, sid)
    await sleep(40)
  }
  assert.equal(prompts.length, 0, "zero briefs while the native child stays non-idle/non-terminal")
  assert.ok(v2WiringSeam.crewNativeCeiling.has(sid), "the suppression episode marker is seeded")

  // Suppression must NOT have accrued turns: with the streak limit at 3, four
  // counted turns would have stalled the engine. Open the gate (child goes
  // terminal in the walk view) — the very next idle briefs immediately.
  view.status = { data: {} }
  view.list = [{ id: child, parentID: sid, outcome: "succeeded" }]
  await idle(state, sid)
  await until(() => prompts.length >= 1, "verified settlement brief")
  await sleep(60) // detect duplicate delivery after the decision completes
  assert.equal(prompts.length, 1, "verified settlement permits the next idle brief without charging waiting turns")
  assert.match(briefText(prompts[0]), /\[forge:crew-continue\]/)
  await cleanup?.()
})

// ---------------------------------------------------------------------------
// 3.2 — last native child terminal re-arms EXACTLY one brief (not one per
// suppressed idle edge), carrying the one-line digest (child id + outcome).
// ---------------------------------------------------------------------------
test("native-child gate: last child terminal re-arms exactly ONE brief carrying the digest line", async (t) => {
  const sid = nextSid()
  const { view, state, prompts, cleanup } = await crewHarness(t, sid)
  const child = view.list[0].id
  childBusy(view, child)
  await armCrew(state, view.worktree, sid, "re-arm me", ["one"])

  for (let i = 0; i < 3; i++) {
    await idle(state, sid)
    await sleep(40)
  }
  assert.equal(prompts.length, 0, "suppressed first")

  // The advisory tracker learns the child (created), then its terminal edge.
  await state.emit("session.created", { info: { id: child, parentID: sid } }); await sleep(20)
  view.status = { data: {} } // the walk re-anchors: child absent from the busy map
  await state.emit("session.execution.succeeded", { sessionID: child }); await sleep(20)
  await sleep(120) // re-arm debounce 10ms + guards

  assert.equal(prompts.length, 1, "exactly one re-armed brief — NOT one per suppressed idle edge")
  const brief = briefText(prompts[0])
  assert.match(brief, /\[forge:crew-continue\]/)
  assert.ok(brief.includes(`native child ${child} succeeded`), "digest line: child id + outcome")
  assert.equal(v2WiringSeam.crewChildDigest.has(sid), false, "digest cleared on successful delivery")
  await cleanup?.()
})

// ---------------------------------------------------------------------------
// 3.3 — ceiling expiry: past FORGE_CREW_NATIVE_CHILD_CEILING_MS the engine
// sends once + ONE bounded disclosure, stops suppressing; fresh crew_begin
// re-arms normal gating.
// ---------------------------------------------------------------------------
// Retired D8 ceiling release: D11 allows only the diagnostic.
test("native-child gate: ceiling discloses once but never authorizes a wave; fresh crew_begin re-arms", async (t) => {
  const sid = nextSid()
  const { view, state, prompts, cleanup } = await crewHarness(t, sid)
  const child = view.list[0].id
  childBusy(view, child)
  await armCrew(state, view.worktree, sid, "ceiling me", ["one"])

  let now = 1_000_000
  setCrewNativeChildClockForTests(() => now)
  const originalWarn = console.warn
  let warns = 0
  console.warn = () => {
    warns++
  }
  try {
    await idle(state, sid) // suppressed: episode starts at t=1_000_000
    await sleep(40)
    assert.equal(prompts.length, 0)
    assert.ok(v2WiringSeam.crewNativeCeiling.get(sid)?.disclosed === false)

    now += 900_000 // default FORGE_CREW_NATIVE_CHILD_CEILING_MS
    await idle(state, sid)
    await sleep(60)
    assert.equal(prompts.length, 0, "D11: ceiling expiry never authorizes a normal brief")
    assert.equal(warns, 1, "exactly ONE bounded disclosure")

    await idle(state, sid) // suppression stopped for this registration
    await sleep(60)
    assert.equal(prompts.length, 0, "post-disclosure idle edges remain held")
    assert.equal(warns, 1, "no repeat disclosure")

    // Fresh crew_begin clears the marker: the gate suppresses again.
    await state.tools.get("crew_close").execute({ abandon: true, reason: "re-register" }, toolCtx(sid, view.worktree))
    await armCrew(state, view.worktree, sid, "round two", ["one"])
    assert.equal(v2WiringSeam.crewNativeCeiling.has(sid), false, "fresh crew_begin cleared the ceiling marker")
    await idle(state, sid)
    await sleep(40)
    assert.equal(prompts.length, 0, "child still busy + fresh registration remains suppressed")
    assert.equal(v2WiringSeam.crewNativeCeiling.get(sid)?.disclosed === false, true, "a fresh, fully-ceilinged episode")
    assert.equal(warns, 1, "still one disclosure total")
  } finally {
    console.warn = originalWarn
    setCrewNativeChildClockForTests(null)
    await cleanup?.()
  }
})

// ---------------------------------------------------------------------------
// 3.4 — fail-open: list throws / status throws / garbage envelopes each fall
// through to SEND.
// ---------------------------------------------------------------------------
// Retired fail-open assertion: unreadable is unknown and cannot authorize a wave.
test("native-child gate: unreadable host views remain held (D11)", async (t) => {
  const cases = [
    { name: "session.list throws", listThrow: true },
    { name: "session.status throws while the child is listed", statusThrow: true },
    { name: "garbage list envelope", garbageList: true },
    { name: "unreadable status body (no .data object)", status: "garbage-string" },
    { name: "session.list missing entirely", noList: true },
  ]
  for (const c of cases) {
    const sid = nextSid()
    const { view, state, cleanup } = await crewHarness(t, sid, c)
    await armCrew(state, view.worktree, sid, `unknown: ${c.name}`, ["one"])
    await idle(state, sid)
    await sleep(100)
    assert.equal(view.prompts.length, 0, `${c.name}: unknown cannot authorize a brief`)
    await cleanup?.()
  }
})

// ---------------------------------------------------------------------------
// 3.5 — session.deleted evicts the gate state (tracker rows + ceiling marker
// + digest); a later crew starts clean.
// ---------------------------------------------------------------------------
test("native-child gate: session.deleted evicts tracker rows, ceiling marker and digest; a later crew starts clean", async (t) => {
  const sid = nextSid()
  const { view, state, prompts, cleanup } = await crewHarness(t, sid)
  const child = view.list[0].id
  childBusy(view, child)
  await armCrew(state, view.worktree, sid, "evict me", ["one"])
  await idle(state, sid) // suppressed ⇒ ceiling marker seeded
  await sleep(40)
  assert.equal(prompts.length, 0)
  assert.ok(v2WiringSeam.crewNativeCeiling.has(sid))

  await state.emit("session.created", { info: { id: child, parentID: sid } }); await sleep(20)
  assert.equal(v2WiringSeam.crewNativeChildren.runningChildren(sid).length, 1, "tracker row live before eviction")
  v2WiringSeam.crewChildDigest.set(sid, ["pending digest line (test-seeded)"])

  await state.emit("session.deleted", { sessionID: sid }); await sleep(20)
  assert.equal(v2WiringSeam.crewNativeChildren.runningChildren(sid).length, 0, "tracker rows evicted")
  assert.equal(v2WiringSeam.crewNativeCeiling.has(sid), false, "ceiling marker evicted")
  assert.equal(v2WiringSeam.crewChildDigest.has(sid), false, "pending digest evicted")
  assert.equal(v2WiringSeam.crews.get(sid), undefined, "crew entry evicted (existing semantics)")

  // A later crew in a NEW session starts with a clean gate: the old busy
  // child belonged to the deleted parent, so the walk finds nothing.
  const sid2 = nextSid()
  await armCrew(state, view.worktree, sid2, "clean start", ["one"])
  await idle(state, sid2)
  await sleep(60)
  assert.equal(prompts.length, 1, "later crew briefs on the first idle — clean gate state")
  assert.match(briefText(prompts[0]), /clean start/)
  await cleanup?.()
})

// ---------------------------------------------------------------------------
// 3.6 — regression pin: a native child in flight does NOT affect goal
// continuations (the goal brief path is unchanged).
// ---------------------------------------------------------------------------
// Retired crew-only gate expectation: goal-governed crews share waiting (D11).
test("native-child gate: goal-governed crew waits for its busy child (D11)", async (t) => {
  const sid = nextSid()
  const { view, state, prompts, cleanup } = await crewHarness(t, sid)
  const child = view.list[0].id
  childBusy(view, child) // a busy native child of the goal-governed session
  await state.tools.get("goal_write").execute(
    {
      goal: "own the session",
      criteria: ["npm test exits 0"],
      checks: [{ shell: "npm test" }],
      constraints: "stay in the sandbox",
      arm: true,
    },
    toolCtx(sid, view.worktree),
  )
  await state.tools.get("crew_begin").execute({ objective: "crew under goal", subtasks: [{ title: "one" }], execution: "waves" }, toolCtx(sid, view.worktree))
  await idle(state, sid)
  await sleep(60)
  assert.equal(prompts.length, 0, "D11: goal owner also waits without a normal continuation")
  await cleanup?.()
})

// ---------------------------------------------------------------------------
// 3.7 / D7 defect-B — aborted-child disclosure: the child terminalizes with
// outcome interrupted while suppression was active ⇒ the re-arm fires
// promptly and the digest names the child + interrupted (DEAD).
// ---------------------------------------------------------------------------
test("native-child gate: an INTERRUPTED child wakes the crew — re-arm brief names the child dead", async (t) => {
  const sid = nextSid()
  const { view, state, prompts, cleanup } = await crewHarness(t, sid)
  const child = view.list[0].id
  childBusy(view, child)
  await armCrew(state, view.worktree, sid, "wake me on abort", ["one"])

  await idle(state, sid) // suppressed ⇒ episode live
  await sleep(40)
  assert.equal(prompts.length, 0)
  assert.ok(v2WiringSeam.crewNativeCeiling.has(sid))

  await state.emit("session.created", { info: { id: child, parentID: sid } }); await sleep(20)
  view.status = { data: {} }
  await state.emit("session.execution.interrupted", { sessionID: child }); await sleep(20)
  await sleep(120)

  assert.equal(prompts.length, 1, "the re-arm fires promptly after the abort — no further idle edge needed")
  const brief = briefText(prompts[0])
  assert.match(brief, /\[forge:crew-continue\]/)
  assert.ok(brief.includes(child), "the dead child's session id is named")
  assert.match(brief, /interrupted/, "the interrupted outcome is named")
  assert.match(brief, /DEAD/, "the child is disclosed DEAD — never silently stranded")
  await cleanup?.()
})

// ---------------------------------------------------------------------------
// D8 (sandbox E2E finding #2, Leg B — 2026-11-23): the tests above all seed
// the tracker AFTER the arm, the one order that hides the defect. On the
// live host the child's session.created arrived BEFORE the crew was armed;
// a fresh crew_begin wipes the parent's tracker rows, so the terminal edge
// found nothing to name and the first post-terminal brief carried NO outcome
// line. The walk is the authority now.
// ---------------------------------------------------------------------------
test("native-child gate: a child created BEFORE the crew is armed is still named with its outcome when it settles (the live Leg B order)", async (t) => {
  const sid = nextSid()
  const { view, state, prompts, cleanup } = await crewHarness(t, sid)
  const child = view.list[0].id
  childBusy(view, child)
  // The host announced the child FIRST, in the live 2.3.2 payload shape
  // (flat data {sessionID, parentID}; sandbox event capture 2026-11-23).
  await state.emit("session.created", { sessionID: child, parentID: sid, slug: "eager-cabin" }); await sleep(20)
  assert.equal(v2WiringSeam.crewNativeChildren.runningChildren(sid).length, 1, "tracker row live before the arm")
  await armCrew(state, view.worktree, sid, "pre-arm child", ["one"])

  await idle(state, sid) // suppressed ⇒ the walk takes over the watch
  await sleep(40)
  assert.equal(prompts.length, 0)
  assert.ok(v2WiringSeam.crewNativeWatch.get(sid)?.has(child), "the WALK is waiting on the pre-arm child")

  view.status = { data: {} }
  view.list = [{ id: child, parentID: sid, outcome: "succeeded" }]
  await state.emit("session.execution.succeeded", { sessionID: child }); await sleep(20) // live terminal payload
  await sleep(120) // re-arm debounce 10ms + guards
  assert.equal(prompts.length, 1, "the re-arm still fires — the terminal edge resolves the parent through the walk's watch set")
  assert.ok(briefText(prompts[0]).includes(`native child ${child} succeeded`), "digest line: child id + outcome")
  assert.equal(v2WiringSeam.crewNativeWatch.get(sid)?.size ?? 0, 0, "nothing waited on once the brief is delivered")
  await cleanup?.()
})

test("native-child gate: NO event reaches the plugin (stream loss) — the next idle edge's walk names the settled child from its ROW outcome", async (t) => {
  const sid = nextSid()
  const { view, state, prompts, cleanup } = await crewHarness(t, sid)
  const child = view.list[0].id
  childBusy(view, child)
  await armCrew(state, view.worktree, sid, "stream lost", ["one"])
  await idle(state, sid) // suppressed ⇒ watched
  await sleep(40)
  assert.equal(prompts.length, 0)

  view.status = { data: {} }
  view.list = [{ id: child, parentID: sid, outcome: "failed" }] // the row says failed
  await idle(state, sid) // no noteCrewNativeChildEvent at all
  await sleep(80)
  assert.equal(prompts.length, 1)
  assert.ok(briefText(prompts[0]).includes(`native child ${child} failed`), "the ROW's outcome names the child")
  await cleanup?.()
})

test("native-child gate: the terminal event AND the walk may both see a child settle — the digest names it exactly ONCE", async (t) => {
  const sid = nextSid()
  const { view, state, prompts, cleanup } = await crewHarness(t, sid)
  const child = view.list[0].id
  childBusy(view, child)
  await armCrew(state, view.worktree, sid, "dedupe me", ["one"])
  await idle(state, sid) // suppressed ⇒ watched
  await sleep(40)
  assert.equal(prompts.length, 0)

  view.status = { data: {} }
  view.list = [{ id: child, parentID: sid, outcome: "interrupted" }]
  await state.emit("session.created", { info: { id: child, parentID: sid } }); await sleep(20)
  await state.emit("session.execution.interrupted", { sessionID: child }); await sleep(20) // the event names it first
  await sleep(120)
  assert.equal(prompts.length, 1)
  const brief = briefText(prompts[0])
  assert.equal(brief.split(`native child ${child}`).length - 1, 1, "named exactly once")
  assert.match(brief, /interrupted[\s\S]*DEAD/, "with the event's outcome")
  // The host's own wake turn ends on a later idle edge: the walk sees the
  // settled row again — the line is never repeated.
  await idle(state, sid)
  await sleep(80)
  assert.equal(prompts.length, 2, "the ordinary idle-edge brief still fires")
  assert.doesNotMatch(briefText(prompts[1]), /native child/, "the digest rode ONE brief")
  await cleanup?.()
})

// Retired deleted-child release: unverified disappearance is not settlement.
test("native-child gate: deleted waited-on child remains held (D11)", async (t) => {
  const sid = nextSid()
  const { view, state, prompts, cleanup } = await crewHarness(t, sid)
  const child = view.list[0].id
  childBusy(view, child)
  await armCrew(state, view.worktree, sid, "deleted child", ["one"])
  await idle(state, sid) // suppressed ⇒ watched
  await sleep(40)
  assert.equal(prompts.length, 0)

  view.list = [] // the row is gone
  view.status = { data: {} }
  await state.emit("session.deleted", { sessionID: child }); await sleep(20) // live payload: flat {sessionID}
  await sleep(120)
  assert.equal(prompts.length, 0, "D11: deletion is unverified and cannot authorize continuation")
  await cleanup?.()
})
