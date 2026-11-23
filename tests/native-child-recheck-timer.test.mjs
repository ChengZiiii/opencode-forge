import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// D8 suppression RE-CHECK TIMER (change crew-continue-native-child-gate,
// sandbox E2E finding #2, 2026-11-23) — the REAL timer, not the seam.
//
// The gate's resume used to depend on a host idle edge or on a volatile
// event reaching the plugin. A child deleted mid-run may leave the parent
// with no idle edge at all, and a subscription gap can swallow the one that
// comes — the crew then sat suppressed forever (the one outcome design D2
// calls unacceptable). While the gate holds a crew, a bounded timer re-walks
// the host view and schedules the shared continuation once it is clear.
//
// Same stub-client recipe as native-child-gate-wiring.test.mjs; the re-check
// interval is a module-level const — a short REAL interval must be set
// BEFORE plugin.ts is imported.
process.env.FORGE_GOAL_DEBOUNCE_MS = "10"
process.env.FORGE_CREW_CHILD_RESUME_DEBOUNCE_MS = "10"
process.env.FORGE_CREW_NATIVE_CHILD_RECHECK_MS = "30"
process.env.FORGE_TEST_FORGE_HOME = mkdtempSync(join(tmpdir(), "ncr-home-"))
process.env.FORGE_TEST_NO_DISPATCH_FETCH = "1"
const { server, noteCrewNativeChildEvent, setCrewNativeChildClockForTests, v2WiringSeam } = await import("../plugin.ts")

const allowAsk = async () => {}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const until = async (fn, what, timeoutMs = 5_000) => {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    if (fn()) return
    await sleep(10)
  }
  assert.fail(`timeout waiting for: ${what}`)
}

let sidCounter = 0
const nextSid = () => `ses_ncr-${++sidCounter}`
let poolCounter = 0

function makeHostView(sid) {
  return { list: [{ id: `ses_ncr-child-${sid}`, parentID: sid }], status: { data: {} }, prompts: [] }
}
function clientFromView(view) {
  return {
    session: {
      prompt: async (body) => {
        view.prompts.push(body)
      },
      get: async () => undefined,
      // Dual-mode like the wiring suite: {path:{id}} ⇒ the send-time idle
      // re-check; no-arg ⇒ the busy map the gate walks.
      status: async (o) => (o && o.path && o.path.id ? { [o.path.id]: { type: "idle" } } : view.status),
      list: async () => view.list,
    },
  }
}
const toolCtx = (sid, wt) => ({ sessionID: sid, worktree: wt, ask: allowAsk, metadata() {}, callID: "c", agent: "forge", messageID: "m" })
async function crewHarness(t, sid) {
  const view = makeHostView(sid)
  const wt = mkdtempSync(join(tmpdir(), "ncr-"))
  t.after(() => {
    try {
      rmSync(wt, { recursive: true, force: true })
    } catch {}
  })
  mkdirSync(join(wt, ".opencode"), { recursive: true })
  writeFileSync(join(wt, ".opencode", "forge.json"), JSON.stringify({ pool: `ncr${++poolCounter}`, agents: { research: { model: "zai/glm", thoughtLevel: "low" } } }))
  view.worktree = wt
  const client = clientFromView(view)
  const hooks = await server({ client, project: { id: "p" }, directory: wt, worktree: wt, serverUrl: new URL("http://127.0.0.1:1"), $: {}, experimental_workspace: { register() {} } })
  await hooks.config({ agent: {} })
  const ctx = toolCtx(sid, wt)
  await hooks.tool.crew_begin.execute({ objective: "recheck", subtasks: [{ title: "one" }] }, ctx)
  await hooks.tool.crew_begin.execute({ execution: "waves" }, ctx)
  return { client, view, hooks, prompts: view.prompts, ctx }
}
const idle = (hooks, sid) => hooks.event({ event: { type: "session.idle", properties: { sessionID: sid } } })
const briefText = (p) => p.body.parts[0].text
const busy = (view, child) => {
  view.status = { data: { [child]: { type: "running" } } }
}

// ---------------------------------------------------------------------------
// The timer really fires: held crew, NO idle edge and NO event afterwards,
// the child leaves the active map ⇒ the re-check alone resumes the crew.
// ---------------------------------------------------------------------------
test("re-check timer: held crew resumes with NO idle edge and NO event once the child settles — the brief names it", async (t) => {
  const sid = nextSid()
  const { view, hooks, prompts } = await crewHarness(t, sid)
  const child = view.list[0].id
  busy(view, child)
  await idle(hooks, sid) // the ONLY idle edge this crew ever gets
  await until(() => v2WiringSeam.crewNativeRecheckArmed(sid), "the re-check armed by the suppressed decision")
  await sleep(150) // several re-check periods while the child runs
  assert.equal(prompts.length, 0, "still held while the child is in flight")

  view.status = { data: {} }
  view.list = [{ id: child, parentID: sid, outcome: "succeeded" }]
  await until(() => prompts.length >= 1, "the timer-resumed brief")
  await sleep(200) // a second brief would land here
  assert.equal(prompts.length, 1, "exactly one resumed brief")
  assert.ok(briefText(prompts[0]).includes(`native child ${child} succeeded`), "named with its row outcome")
  assert.equal(v2WiringSeam.crewNativeRecheckArmed(sid), false, "disarmed: the episode ended with a delivered brief")
  await hooks.dispose?.()
})

// ---------------------------------------------------------------------------
// The stranding case: the child's row is deleted mid-run — no terminal edge,
// no host wake, the parent never runs another turn.
// ---------------------------------------------------------------------------
test("re-check timer: a child DELETED mid-run (no terminal edge, no idle edge) no longer strands the crew", async (t) => {
  const sid = nextSid()
  const { view, hooks, prompts } = await crewHarness(t, sid)
  const child = view.list[0].id
  busy(view, child)
  await idle(hooks, sid)
  await until(() => v2WiringSeam.crewNativeRecheckArmed(sid), "armed")

  view.list = [] // DELETE /api/session/{child}
  view.status = { data: {} }
  await until(() => prompts.length >= 1, "the timer-resumed brief")
  assert.ok(briefText(prompts[0]).includes(`native child ${child} is no longer running`), "the vanished child is named")
  assert.match(briefText(prompts[0]), /UNVERIFIED/, "no verdict invented")
  await hooks.dispose?.()
})

// ---------------------------------------------------------------------------
// The ceiling no longer needs an idle edge to be evaluated.
// ---------------------------------------------------------------------------
test("re-check timer: the ceiling is evaluated by the re-check — one brief + ONE disclosure with no idle edge", async (t) => {
  const sid = nextSid()
  const { view, hooks, prompts } = await crewHarness(t, sid)
  const child = view.list[0].id
  busy(view, child)
  let now = 1_000_000
  setCrewNativeChildClockForTests(() => now)
  const originalWarn = console.warn
  let warns = 0
  console.warn = () => {
    warns++
  }
  try {
    await idle(hooks, sid)
    await until(() => v2WiringSeam.crewNativeRecheckArmed(sid), "armed")
    await sleep(150)
    assert.equal(prompts.length, 0, "held before the ceiling")

    now += 900_000 // default FORGE_CREW_NATIVE_CHILD_CEILING_MS
    await until(() => prompts.length >= 1, "the ceiling brief")
    await sleep(150)
    assert.equal(prompts.length, 1, "the ceiling resumes the crew once")
    assert.equal(warns, 1, "exactly ONE bounded disclosure")
    assert.equal(v2WiringSeam.crewNativeCeiling.get(sid)?.disclosed, true)
  } finally {
    console.warn = originalWarn
    setCrewNativeChildClockForTests(null)
    await hooks.dispose?.()
  }
})

// ---------------------------------------------------------------------------
// Lifecycle: the timer dies with the registration and with the session —
// a re-check for a closed/evicted crew never schedules anything.
// ---------------------------------------------------------------------------
test("re-check timer: dies with a fresh registration and with session.deleted; a late tick for a crew that no longer exists schedules nothing", async (t) => {
  const sid = nextSid()
  const { view, hooks, prompts, ctx } = await crewHarness(t, sid)
  const child = view.list[0].id
  busy(view, child)
  await idle(hooks, sid)
  await until(() => v2WiringSeam.crewNativeRecheckArmed(sid), "armed")
  assert.ok(v2WiringSeam.crewNativeWatch.get(sid)?.has(child))

  // A fresh registration (close + crew_begin) evicts the watch set and the timer.
  await hooks.tool.crew_close.execute({ abandon: true, reason: "re-register" }, ctx)
  await hooks.tool.crew_begin.execute({ objective: "recheck", subtasks: [{ title: "one" }] }, ctx)
  assert.equal(v2WiringSeam.crewNativeRecheckArmed(sid), false, "timer evicted by the fresh registration")
  assert.equal(v2WiringSeam.crewNativeWatch.has(sid), false, "watch set evicted")

  // Held again under the new registration (armed like a real crew), then the
  // parent session is deleted.
  await hooks.tool.crew_begin.execute({ execution: "waves" }, ctx)
  await idle(hooks, sid)
  await until(() => v2WiringSeam.crewNativeRecheckArmed(sid), "re-armed")
  await hooks.event({ event: { type: "session.deleted", properties: { info: { id: sid } } } })
  assert.equal(v2WiringSeam.crewNativeRecheckArmed(sid), false, "timer evicted with the session")
  assert.equal(v2WiringSeam.crewNativeWatch.has(sid), false, "watch set evicted with the session")
  const promptsBefore = prompts.length
  await v2WiringSeam.crewNativeRecheckNow(sid, null) // a late tick: nothing to continue
  await sleep(120)
  assert.equal(prompts.length, promptsBefore, "no brief for a crew that no longer exists")
  await hooks.dispose?.()
})
