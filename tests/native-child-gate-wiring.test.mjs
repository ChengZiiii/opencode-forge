import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

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
const { server, noteCrewNativeChildEvent, setCrewNativeChildClockForTests, v2WiringSeam } = await import("../plugin.ts")

const allowAsk = async () => {}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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

function clientFromView(view) {
  const session = {
    prompt: async (body) => {
      view.prompts.push(body)
    },
    get: async () => undefined,
    status: async (o) => {
      if (o && o.path && o.path.id) return { [o.path.id]: { type: "idle" } } // send-time idle re-check
      if (view.statusThrow) throw new Error("status boom (test)")
      return view.status
    },
  }
  if (!view.noList) {
    session.list = async () => {
      if (view.listThrow) throw new Error("list boom (test)")
      if (view.garbageList) return { unexpected: true }
      return view.list
    }
  }
  return { session }
}

function makeHarness(view) {
  view.prompts = []
  const client = clientFromView(view)
  const serverPromise = server({
    client,
    project: { id: "p" },
    directory: view.worktree,
    worktree: view.worktree,
    serverUrl: new URL("http://127.0.0.1:1"),
    $: {},
    experimental_workspace: { register() {} },
  })
  return { client, view, serverPromise }
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

async function crewHarness(t, sid) {
  const view = makeHostView(sid)
  view.worktree = crewWorktree(t)
  const { client, serverPromise } = makeHarness(view)
  const hooks = await serverPromise
  await hooks.config({ agent: {} }) // re-anchor the pool loader to THIS worktree
  return { client, view, hooks, prompts: view.prompts }
}

async function armCrew(hooks, wt, sid, objective = "ship the thing", titles = ["alpha", "beta"]) {
  await hooks.tool.crew_begin.execute({ objective, subtasks: titles.map((title) => ({ title })) }, toolCtx(sid, wt))
  return hooks.tool.crew_begin.execute({ execution: "waves" }, toolCtx(sid, wt))
}

const briefText = (p) => p.body.parts[0].text
const idle = (hooks, sid) => hooks.event({ event: { type: "session.idle", properties: { sessionID: sid } } })
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
  const { view, hooks, prompts } = await crewHarness(t, sid)
  const child = view.list[0].id
  childBusy(view, child)
  await armCrew(hooks, view.worktree, sid, "suppress me", ["one"])

  for (let i = 0; i < 4; i++) {
    await idle(hooks, sid)
    await sleep(40)
  }
  assert.equal(prompts.length, 0, "zero briefs while the native child stays non-idle/non-terminal")
  assert.ok(v2WiringSeam.crewNativeCeiling.has(sid), "the suppression episode marker is seeded")

  // Suppression must NOT have accrued turns: with the streak limit at 3, four
  // counted turns would have stalled the engine. Open the gate (child goes
  // terminal in the walk view) — the very next idle briefs immediately.
  view.status = { data: {} }
  await idle(hooks, sid)
  await sleep(60)
  assert.equal(prompts.length, 1, "gate open ⇒ brief on the next idle (no stall, no transport cap accrued)")
  assert.match(briefText(prompts[0]), /\[forge:crew-continue\]/)
  await hooks.dispose?.()
})

// ---------------------------------------------------------------------------
// 3.2 — last native child terminal re-arms EXACTLY one brief (not one per
// suppressed idle edge), carrying the one-line digest (child id + outcome).
// ---------------------------------------------------------------------------
test("native-child gate: last child terminal re-arms exactly ONE brief carrying the digest line", async (t) => {
  const sid = nextSid()
  const { client, view, hooks, prompts } = await crewHarness(t, sid)
  const child = view.list[0].id
  childBusy(view, child)
  await armCrew(hooks, view.worktree, sid, "re-arm me", ["one"])

  for (let i = 0; i < 3; i++) {
    await idle(hooks, sid)
    await sleep(40)
  }
  assert.equal(prompts.length, 0, "suppressed first")

  // The advisory tracker learns the child (created), then its terminal edge.
  noteCrewNativeChildEvent("session.created", { info: { id: child, parentID: sid } }, client)
  view.status = { data: {} } // the walk re-anchors: child absent from the busy map
  noteCrewNativeChildEvent("session.execution.succeeded", { sessionID: child }, client)
  await sleep(120) // re-arm debounce 10ms + guards

  assert.equal(prompts.length, 1, "exactly one re-armed brief — NOT one per suppressed idle edge")
  const brief = briefText(prompts[0])
  assert.match(brief, /\[forge:crew-continue\]/)
  assert.ok(brief.includes(`native child ${child} succeeded`), "digest line: child id + outcome")
  assert.equal(v2WiringSeam.crewChildDigest.has(sid), false, "digest cleared on successful delivery")
  await hooks.dispose?.()
})

// ---------------------------------------------------------------------------
// 3.3 — ceiling expiry: past FORGE_CREW_NATIVE_CHILD_CEILING_MS the engine
// sends once + ONE bounded disclosure, stops suppressing; fresh crew_begin
// re-arms normal gating.
// ---------------------------------------------------------------------------
test("native-child gate: suppression past the ceiling sends once with ONE bounded disclosure; fresh crew_begin re-arms gating", async (t) => {
  const sid = nextSid()
  const { view, hooks, prompts } = await crewHarness(t, sid)
  const child = view.list[0].id
  childBusy(view, child)
  await armCrew(hooks, view.worktree, sid, "ceiling me", ["one"])

  let now = 1_000_000
  setCrewNativeChildClockForTests(() => now)
  const originalWarn = console.warn
  let warns = 0
  console.warn = () => {
    warns++
  }
  try {
    await idle(hooks, sid) // suppressed: episode starts at t=1_000_000
    await sleep(40)
    assert.equal(prompts.length, 0)
    assert.ok(v2WiringSeam.crewNativeCeiling.get(sid)?.disclosed === false)

    now += 900_000 // default FORGE_CREW_NATIVE_CHILD_CEILING_MS
    await idle(hooks, sid)
    await sleep(60)
    assert.equal(prompts.length, 1, "ceiling expiry ⇒ brief sent once despite the child still busy")
    assert.equal(warns, 1, "exactly ONE bounded disclosure")

    await idle(hooks, sid) // suppression stopped for this registration
    await sleep(60)
    assert.equal(prompts.length, 2, "post-disclosure idle edges send (no further suppression)")
    assert.equal(warns, 1, "no repeat disclosure")

    // Fresh crew_begin clears the marker: the gate suppresses again.
    await hooks.tool.crew_close.execute({ abandon: true, reason: "re-register" }, toolCtx(sid, view.worktree))
    await armCrew(hooks, view.worktree, sid, "round two", ["one"])
    assert.equal(v2WiringSeam.crewNativeCeiling.has(sid), false, "fresh crew_begin cleared the ceiling marker")
    await idle(hooks, sid)
    await sleep(40)
    assert.equal(prompts.length, 2, "child still busy + fresh registration ⇒ normal gating suppresses again")
    assert.equal(v2WiringSeam.crewNativeCeiling.get(sid)?.disclosed === false, true, "a fresh, fully-ceilinged episode")
    assert.equal(warns, 1, "still one disclosure total")
  } finally {
    console.warn = originalWarn
    setCrewNativeChildClockForTests(null)
    await hooks.dispose?.()
  }
})

// ---------------------------------------------------------------------------
// 3.4 — fail-open: list throws / status throws / garbage envelopes each fall
// through to SEND.
// ---------------------------------------------------------------------------
test("native-child gate: unreadable host view fails OPEN — the brief is sent", async (t) => {
  const cases = [
    { name: "session.list throws", listThrow: true },
    { name: "session.status throws while the child is listed", statusThrow: true },
    { name: "garbage list envelope", garbageList: true },
    { name: "unreadable status body (no .data object)", status: "garbage-string" },
    { name: "session.list missing entirely", noList: true },
  ]
  for (const c of cases) {
    const sid = nextSid()
    const view = makeHostView(sid)
    view.worktree = crewWorktree(t)
    Object.assign(view, c)
    if (typeof c.status === "string") view.status = c.status
    const { serverPromise } = makeHarness(view)
    const hooks = await serverPromise
    await hooks.config({ agent: {} })
    await armCrew(hooks, view.worktree, sid, `fail open: ${c.name}`, ["one"])
    await idle(hooks, sid)
    await sleep(60)
    assert.equal(view.prompts.length, 1, `${c.name} ⇒ treated as no children in flight ⇒ brief sent`)
    assert.match(briefText(view.prompts[0]), /\[forge:crew-continue\]/)
    await hooks.dispose?.()
  }
})

// ---------------------------------------------------------------------------
// 3.5 — session.deleted evicts the gate state (tracker rows + ceiling marker
// + digest); a later crew starts clean.
// ---------------------------------------------------------------------------
test("native-child gate: session.deleted evicts tracker rows, ceiling marker and digest; a later crew starts clean", async (t) => {
  const sid = nextSid()
  const { client, view, hooks, prompts } = await crewHarness(t, sid)
  const child = view.list[0].id
  childBusy(view, child)
  await armCrew(hooks, view.worktree, sid, "evict me", ["one"])
  await idle(hooks, sid) // suppressed ⇒ ceiling marker seeded
  await sleep(40)
  assert.equal(prompts.length, 0)
  assert.ok(v2WiringSeam.crewNativeCeiling.has(sid))

  noteCrewNativeChildEvent("session.created", { info: { id: child, parentID: sid } }, client)
  assert.equal(v2WiringSeam.crewNativeChildren.runningChildren(sid).length, 1, "tracker row live before eviction")
  v2WiringSeam.crewChildDigest.set(sid, ["pending digest line (test-seeded)"])

  await hooks.event({ event: { type: "session.deleted", properties: { info: { id: sid } } } })
  assert.equal(v2WiringSeam.crewNativeChildren.runningChildren(sid).length, 0, "tracker rows evicted")
  assert.equal(v2WiringSeam.crewNativeCeiling.has(sid), false, "ceiling marker evicted")
  assert.equal(v2WiringSeam.crewChildDigest.has(sid), false, "pending digest evicted")
  assert.equal(hooks.__forgeSubagentsTest.crews().get(sid), undefined, "crew entry evicted (existing semantics)")

  // A later crew in a NEW session starts with a clean gate: the old busy
  // child belonged to the deleted parent, so the walk finds nothing.
  const sid2 = nextSid()
  await armCrew(hooks, view.worktree, sid2, "clean start", ["one"])
  await idle(hooks, sid2)
  await sleep(60)
  assert.equal(prompts.length, 1, "later crew briefs on the first idle — clean gate state")
  assert.match(briefText(prompts[0]), /clean start/)
  await hooks.dispose?.()
})

// ---------------------------------------------------------------------------
// 3.6 — regression pin: a native child in flight does NOT affect goal
// continuations (the goal brief path is unchanged).
// ---------------------------------------------------------------------------
test("native-child gate: goal-branch brief path unchanged — native child in flight does not touch goal continuations", async (t) => {
  const sid = nextSid()
  const { view, hooks, prompts } = await crewHarness(t, sid)
  const child = view.list[0].id
  childBusy(view, child) // a busy native child of the goal-governed session
  await hooks.tool.goal_write.execute(
    {
      goal: "own the session",
      criteria: ["npm test exits 0"],
      checks: [{ shell: "npm test" }],
      constraints: "stay in the sandbox",
      arm: true,
    },
    toolCtx(sid, view.worktree),
  )
  await hooks.tool.crew_begin.execute({ objective: "crew under goal", subtasks: [{ title: "one" }], execution: "waves" }, toolCtx(sid, view.worktree))
  await idle(hooks, sid)
  await sleep(60)
  assert.equal(prompts.length, 1, "the goal brief fires despite the native child (gate is crew-branch only)")
  assert.match(briefText(prompts[0]), /\[forge:goal-continue\]/)
  assert.doesNotMatch(briefText(prompts[0]), /\[forge:crew-continue\]/)
  await hooks.dispose?.()
})

// ---------------------------------------------------------------------------
// 3.7 / D7 defect-B — aborted-child disclosure: the child terminalizes with
// outcome interrupted while suppression was active ⇒ the re-arm fires
// promptly and the digest names the child + interrupted (DEAD).
// ---------------------------------------------------------------------------
test("native-child gate: an INTERRUPTED child wakes the crew — re-arm brief names the child dead", async (t) => {
  const sid = nextSid()
  const { client, view, hooks, prompts } = await crewHarness(t, sid)
  const child = view.list[0].id
  childBusy(view, child)
  await armCrew(hooks, view.worktree, sid, "wake me on abort", ["one"])

  await idle(hooks, sid) // suppressed ⇒ episode live
  await sleep(40)
  assert.equal(prompts.length, 0)
  assert.ok(v2WiringSeam.crewNativeCeiling.has(sid))

  noteCrewNativeChildEvent("session.created", { info: { id: child, parentID: sid } }, client)
  view.status = { data: {} }
  noteCrewNativeChildEvent("session.execution.interrupted", { sessionID: child }, client)
  await sleep(120)

  assert.equal(prompts.length, 1, "the re-arm fires promptly after the abort — no further idle edge needed")
  const brief = briefText(prompts[0])
  assert.match(brief, /\[forge:crew-continue\]/)
  assert.ok(brief.includes(child), "the dead child's session id is named")
  assert.match(brief, /interrupted/, "the interrupted outcome is named")
  assert.match(brief, /DEAD/, "the child is disclosed DEAD — never silently stranded")
  await hooks.dispose?.()
})
