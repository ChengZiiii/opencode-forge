import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServer } from "node:http"

// Stub-client coverage for the crew branch of the idle-continuation engine
// (change crew-autonomous-waves, spec: crew-harness — "Waves-armed crews
// auto-advance on session idle"). Same recipe as goal-mode.test.mjs: the
// debounce must be tiny BEFORE plugin.ts is imported (module-level const).
process.env.FORGE_GOAL_DEBOUNCE_MS = "10"
// Isolate from the host's real global forge layer and skip the models.dev
// fetch in the config hook (same recipe as forge-subagents-wiring).
process.env.FORGE_TEST_FORGE_HOME = mkdtempSync(join(tmpdir(), "crew-cont-home-"))
process.env.FORGE_TEST_NO_DISPATCH_FETCH = "1"
const { v2Setup, v2WiringSeam, resetServiceHttpDiscoveryForTests } = await import("../plugin.ts")
import { createV2MockContext } from "./lib/v2-mock-context.mjs"

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
const nextSid = () => `ses_crewcont-${++sidCounter}`

function toolCtx(sid, worktree, ask = allowAsk) {
  return { sessionID: sid, worktree, ask, metadata() {}, callID: "c", agent: "forge", messageID: "m" }
}

// Compliant workspace pool fixture (same recipe as goal-mode's crewWorktree):
// the crew_begin initialization + compliance gates pass, the roster resolves.
function crewWorktree(t) {
  const wt = mkdtempSync(join(tmpdir(), "crew-cont-"))
  t.after(() => {
    try {
      rmSync(wt, { recursive: true, force: true })
    } catch {}
  })
  mkdirSync(join(wt, ".opencode"), { recursive: true })
  writeFileSync(join(wt, ".opencode", "forge.json"), JSON.stringify({ pool: "crewcont", agents: { research: { model: "zai/glm", thoughtLevel: "low" } } }))
  return wt
}

async function crewHarness(t, opts = {}) {
  const wt = crewWorktree(t)
  const host = createServer((req, res) => {
    res.setHeader("content-type", "application/json")
    res.end(JSON.stringify(req.url.startsWith("/api/session/active") ? {} : []))
  })
  await new Promise((resolve) => host.listen(0, "127.0.0.1", resolve))
  const service = join(wt, "service.json")
  writeFileSync(service, JSON.stringify({ url: `http://127.0.0.1:${host.address().port}`, password: "test" }))
  process.env.FORGE_SERVICE_FILE = service
  resetServiceHttpDiscoveryForTests()
  t.after(async () => { host.closeAllConnections?.(); await new Promise((resolve) => host.close(resolve)); delete process.env.FORGE_SERVICE_FILE; resetServiceHttpDiscoveryForTests() })
  v2WiringSeam.resetHostAnchors()
  const { ctx, state } = createV2MockContext()
  if (opts.prompt) ctx.session.prompt = opts.prompt
  const cleanup = await v2Setup(ctx, { anchors: [wt], materialize: "runtime" })
  t.after(async () => { await cleanup?.(); v2WiringSeam.resetHostAnchors() })
  return { wt, state, prompts: state.prompts, cleanup }
}

// Register (PENDING) then arm to EXECUTING via the standalone arm call.
async function armCrew(state, wt, sid, objective = "ship the thing", titles = ["alpha", "beta"]) {
  await state.tools.get("crew_begin").execute({ objective, subtasks: titles.map((title) => ({ title })) }, toolCtx(sid, wt))
  return state.tools.get("crew_begin").execute({ execution: "waves" }, toolCtx(sid, wt))
}

const briefText = (p) => p.text
const idle = (state, sid) => state.sessionHooks.find((h) => h.name === "experimental.idle").cb({ sessionID: sid, background: [] })

// ---------------------------------------------------------------------------
// Scenario 1: idle + EXECUTING crew + no live goal → exactly ONE brief
// carrying the objective and EVERY declared subtask title.
// ---------------------------------------------------------------------------
test("crew-continue: idle between waves sends exactly one brief with objective + every declared subtask title", async (t) => {
  const { wt, state, prompts, cleanup } = await crewHarness(t)
  const sid = nextSid()
  const armed = await armCrew(state, wt, sid, "overnight refactor", ["map the module", "migrate the tests", "update the docs"])
  // review NIT-2: the auto-advance wording is pinned on the arming surface.
  assert.match(String(armed?.content ?? armed), /auto-advance on session idle until crew_close/, "the arming output carries the auto-advance clause")
  await idle(state, sid)
  await until(() => prompts.length >= 1, "first crew brief")
  await sleep(60) // retain the duplicate-delivery observation window
  assert.equal(prompts.length, 1, "exactly one brief per idle")
  assert.equal(prompts[0].sessionID, sid)
  const brief = briefText(prompts[0])
  assert.match(brief, /\[forge:crew-continue\]/)
  assert.ok(brief.includes("overnight refactor"), "objective carried")
  for (const title of ["map the module", "migrate the tests", "update the docs"]) {
    assert.ok(brief.includes(title), `subtask title carried: ${title}`)
  }
  assert.match(brief, /crew_close \{abandon: true, reason\} to re-shard/, "the abandon exit is in the brief")
  assert.match(brief, /native `subagent` calls made together/)
  assert.match(brief, /every work round of the previous wave is verified settled/)
  assert.match(brief, /end your turn and wait for the rest/)
  assert.match(brief, /terminal status alone is not PASS/)
  assert.match(brief, /full report and existing approvals/)
  assert.doesNotMatch(brief, /forge_shell|forge_jobs|subagent_type|run_in_background|parallel task calls/)
  await cleanup?.()
})

// ---------------------------------------------------------------------------
// Scenario 2: closed / abandoned crew → no brief; PENDING crew → no brief;
// goal-governed session → goal brief ONLY.
// ---------------------------------------------------------------------------
test("crew-continue: a goal-governed session is owned by the goal engine — goal brief only, no crew brief", async (t) => {
  const { wt, state, prompts, cleanup } = await crewHarness(t)
  const sid = nextSid()
  await state.tools.get("goal_write").execute(
    {
      goal: "govern the crew",
      criteria: ["npm test exits 0"],
      checks: [{ shell: "npm test" }],
      constraints: "stay in the sandbox",
      arm: true,
    },
    toolCtx(sid, wt),
  )
  // Born-armed one-call registration under the governing goal.
  await state.tools.get("crew_begin").execute({ objective: "crew under goal", subtasks: [{ title: "one" }], execution: "waves" }, toolCtx(sid, wt))
  assert.equal(v2WiringSeam.crews.get(sid).mode, "executing")
  await idle(state, sid)
  await sleep(60)
  assert.equal(prompts.length, 1, "exactly one brief — the goal's")
  assert.match(briefText(prompts[0]), /\[forge:goal-continue\]/)
  assert.doesNotMatch(briefText(prompts[0]), /\[forge:crew-continue\]/, "no crew brief alongside the goal brief")
  await cleanup?.()
})

// ---------------------------------------------------------------------------
// Scenario 5: non-forge speaker at schedule or send time → no brief.
// ---------------------------------------------------------------------------
test("crew-continue: a non-forge speaker at SCHEDULE time never arms a timer", async (t) => {
  const { wt, state, prompts, cleanup } = await crewHarness(t)
  const sid = nextSid()
  await armCrew(state, wt, sid, "switched away", ["one"]) // family forge during arming
  assert.equal(v2WiringSeam.crews.get(sid).mode, "executing")
  // The speaker switched to a non-forge agent BEFORE the idle fires.
  await state.sessionHooks.find((h) => h.name === "prompt").cb({ sessionID: sid, agent: "build" })
  await idle(state, sid)
  await sleep(60)
  assert.equal(prompts.length, 0, "non-forge speaker: no crew continuation")
  await cleanup?.()
})

test("crew-continue: a speaker switched to non-forge between schedule and SEND gets no brief", async (t) => {
  const { wt, state, prompts, cleanup } = await crewHarness(t)
  const sid = nextSid()
  await armCrew(state, wt, sid) // toolCtx agent "forge" → family forge at schedule time
  // Fire the idle, then switch the family INSIDE the debounce window: the
  // schedule-time gate passed, the send-time re-check must refuse.
  const ev = idle(state, sid)
  await state.sessionHooks.find((h) => h.name === "prompt").cb({ sessionID: sid, agent: "build" })
  await ev
  await sleep(60)
  assert.equal(prompts.length, 0, "family gate holds at send time for the crew branch")
  await cleanup?.()
})

// ---------------------------------------------------------------------------
// Scenario 6: stall — 3 consecutive activity-free crew turns stop the ENGINE
// (one bounded disclosure, crew untouched); task dispatch resets the streak;
// fresh crew_begin clears crewStalled.
// ---------------------------------------------------------------------------
test("crew-continue: 3 activity-free turns stall the engine (one disclosure, crew stays registered); fresh crew_begin clears the stall", async (t) => {
  const { wt, state, prompts, cleanup } = await crewHarness(t)
  const sid = nextSid()
  await armCrew(state, wt, sid, "stall me", ["one"])

  const originalWarn = console.warn
  let warns = 0
  console.warn = (...args) => {
    warns++
    originalWarn(...args)
  }
  try {
    await idle(state, sid) // brief #1
    await until(() => prompts.length >= 1, "stall test brief #1")
    assert.equal(prompts.length, 1)
    await idle(state, sid) // turn 1: activity-free → streak 1, brief #2
    await until(() => prompts.length >= 2, "stall test brief #2")
    assert.equal(prompts.length, 2)
    await idle(state, sid) // turn 2: activity-free → streak 2, brief #3
    await until(() => prompts.length >= 3, "stall test brief #3")
    assert.equal(prompts.length, 3)
    await idle(state, sid) // turn 3: streak hits the limit → stall, NO brief
    await sleep(80)
    assert.equal(prompts.length, 3, "the engine stops sending crew continuations at the streak limit")
    assert.equal(warns, 1, "exactly ONE bounded console disclosure")
    const crew = v2WiringSeam.crews.get(sid)
    assert.ok(crew && crew.mode === "executing", "the crew itself stays registered (no auto-abandon, no auto-close)")
    // A further idle still briefs nothing (the stall marker holds).
    await idle(state, sid)
    await sleep(60)
    assert.equal(prompts.length, 3)
    assert.equal(warns, 1, "no repeat disclosure")

    // Fresh crew_begin clears crewStalled: abandon, re-register, re-arm → the
    // engine briefs again for the NEW registration.
    await state.tools.get("crew_close").execute({ abandon: true, reason: "stalled" }, toolCtx(sid, wt))
    await armCrew(state, wt, sid, "round two", ["one"])
    await idle(state, sid)
    await sleep(60)
    assert.equal(prompts.length, 4, "fresh crew_begin clears the stall marker")
    assert.match(briefText(prompts[3]), /round two/)
    assert.equal(warns, 1, "still one disclosure total")
  } finally {
    console.warn = originalWarn
    await cleanup?.()
  }
})

test("crew-continue: native subagent dispatch resets an existing activity-free streak", async (t) => {
  const { wt, state, prompts, cleanup } = await crewHarness(t)
  const sid = nextSid()
  await armCrew(state, wt, sid, "wave work", ["one"])
  await idle(state, sid) // brief #1
  await sleep(60)
  assert.equal(prompts.length, 1)
  await idle(state, sid)
  await sleep(60)
  await idle(state, sid)
  await sleep(60)
  assert.equal(prompts.length, 3, "two activity-free turns establish the streak")
  // Native dispatch is real work and must clear the existing streak.
  const activity = v2WiringSeam.crewTurnActivity.get(sid)
  assert.ok(activity, "crew turn activity ledger is active")
  const before = activity.dispatches
  await state.toolHooks.find((h) => h.name === "execute.after").cb({ tool: "subagent", sessionID: sid, id: "c1", input: {} })
  assert.equal(activity.dispatches, before + 1, "accepted native subagent execution is recorded as crew activity")
  await idle(state, sid)
  await sleep(60)
  assert.equal(prompts.length, 4, "native dispatch resets rather than stalls the crew")
  await idle(state, sid)
  await sleep(60)
  await idle(state, sid)
  await sleep(60)
  assert.equal(prompts.length, 6, "two later activity-free turns still send")
  await idle(state, sid)
  await sleep(80)
  assert.equal(prompts.length, 6, "third later activity-free turn stalls the engine")
  await cleanup?.()
})

// ---------------------------------------------------------------------------
// Transport-failure cap (shared map + limit, disclosed stop for the crew).
// ---------------------------------------------------------------------------
test("crew-continue: repeated transport failures stop the crew engine with one disclosure; the crew stays registered", async (t) => {
  let fails = 0
  const { wt, state, cleanup } = await crewHarness(t, {
    prompt: async () => {
      fails++
      throw new Error("connection refused (test)")
    },
  })
  const sid = nextSid()
  await armCrew(state, wt, sid, "transport me", ["one"])

  const originalWarn = console.warn
  let warns = 0
  console.warn = () => {
    warns++
  }
  try {
    for (let i = 0; i < 3; i++) {
      await idle(state, sid)
      await sleep(60)
    }
    assert.equal(fails, 3)
    assert.equal(warns, 1, "one bounded disclosure at the transport cap")
    const crew = v2WiringSeam.crews.get(sid)
    assert.ok(crew && crew.mode === "executing", "the crew itself is untouched by transport failures")
    // The engine stopped: a fourth idle attempts no further delivery.
    await idle(state, sid)
    await sleep(60)
    assert.equal(fails, 3, "no further delivery attempts after the cap")
  } finally {
    console.warn = originalWarn
    await cleanup?.()
  }
})

// ---------------------------------------------------------------------------
// Scenario 7 (D4): session.deleted evicts the crew AND the engine's crew-side
// state.
// ---------------------------------------------------------------------------
test("crew-continue: session.deleted evicts the crew entry and the engine's crew-side state", async (t) => {
  const { wt, state, prompts, cleanup } = await crewHarness(t)
  const sid = nextSid()
  await armCrew(state, wt, sid, "delete me", ["one"])
  await idle(state, sid) // brief #1 — the engine holds open crew state for sid
  await sleep(60)
  assert.equal(prompts.length, 1)
  await state.emit("session.deleted", { sessionID: sid }); await sleep(20)
  assert.equal(v2WiringSeam.crews.get(sid), undefined, "session.deleted evicts the crews entry")
  await idle(state, sid)
  await sleep(60)
  assert.equal(prompts.length, 1, "no continuation for a deleted session")
  await cleanup?.()
})
