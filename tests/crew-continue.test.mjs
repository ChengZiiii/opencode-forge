import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Stub-client coverage for the crew branch of the idle-continuation engine
// (change crew-autonomous-waves, spec: crew-harness — "Waves-armed crews
// auto-advance on session idle"). Same recipe as goal-mode.test.mjs: the
// debounce must be tiny BEFORE plugin.ts is imported (module-level const).
process.env.FORGE_GOAL_DEBOUNCE_MS = "10"
// Isolate from the host's real global forge layer and skip the models.dev
// fetch in the config hook (same recipe as forge-subagents-wiring).
process.env.FORGE_TEST_FORGE_HOME = mkdtempSync(join(tmpdir(), "crew-cont-home-"))
process.env.FORGE_TEST_NO_DISPATCH_FETCH = "1"
const { server } = await import("../plugin.ts")

const allowAsk = async () => {}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let sidCounter = 0
const nextSid = () => `ses_crewcont-${++sidCounter}`

function makeHarness(opts = {}) {
  const prompts = []
  const client = {
    session: {
      prompt:
        opts.prompt ??
        (async (body) => {
          prompts.push(body)
        }),
      get: async () => undefined,
      status: opts.status ?? (async (o) => ({ [o.path.id]: { type: "idle" } })),
    },
  }
  const serverPromise = server({
    client,
    project: { id: "p" },
    directory: opts.worktree,
    worktree: opts.worktree,
    serverUrl: new URL("http://127.0.0.1:1"),
    $: {},
    experimental_workspace: { register() {} },
  })
  return { client, prompts, serverPromise }
}

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
  const { serverPromise, prompts } = makeHarness({ worktree: wt, ...opts })
  const hooks = await serverPromise
  await hooks.config({ agent: {} }) // re-anchor the pool loader to THIS worktree
  return { wt, hooks, prompts }
}

// Register (PENDING) then arm to EXECUTING via the standalone arm call.
async function armCrew(hooks, wt, sid, objective = "ship the thing", titles = ["alpha", "beta"]) {
  await hooks.tool.crew_begin.execute({ objective, subtasks: titles.map((title) => ({ title })) }, toolCtx(sid, wt))
  return hooks.tool.crew_begin.execute({ execution: "waves" }, toolCtx(sid, wt))
}

const briefText = (p) => p.body.parts[0].text
const idle = (hooks, sid) => hooks.event({ event: { type: "session.idle", properties: { sessionID: sid } } })

// ---------------------------------------------------------------------------
// Scenario 1: idle + EXECUTING crew + no live goal → exactly ONE brief
// carrying the objective and EVERY declared subtask title.
// ---------------------------------------------------------------------------
test("crew-continue: idle between waves sends exactly one brief with objective + every declared subtask title", async (t) => {
  const { wt, hooks, prompts } = await crewHarness(t)
  const sid = nextSid()
  await armCrew(hooks, wt, sid, "overnight refactor", ["map the module", "migrate the tests", "update the docs"])
  await idle(hooks, sid)
  await sleep(60)
  assert.equal(prompts.length, 1, "exactly one brief per idle")
  assert.equal(prompts[0].path.id, sid)
  const brief = briefText(prompts[0])
  assert.match(brief, /\[forge:crew-continue\]/)
  assert.ok(brief.includes("overnight refactor"), "objective carried")
  for (const title of ["map the module", "migrate the tests", "update the docs"]) {
    assert.ok(brief.includes(title), `subtask title carried: ${title}`)
  }
  assert.match(brief, /crew_close \{abandon: true, reason\} to re-shard/, "the abandon exit is in the brief")
  await hooks.dispose?.()
})

// ---------------------------------------------------------------------------
// Scenario 2: closed / abandoned crew → no brief; PENDING crew → no brief;
// goal-governed session → goal brief ONLY.
// ---------------------------------------------------------------------------
test("crew-continue: a CLOSED crew never continues (crews entry evicted)", async (t) => {
  const { wt, hooks, prompts } = await crewHarness(t)
  const sid = nextSid()
  await armCrew(hooks, wt, sid, "close me", ["one"])
  await hooks.tool.crew_close.execute({ report: [{ title: "one", verdict: "PASS", evidence: "ok" }] }, toolCtx(sid, wt))
  assert.equal(hooks.__forgeSubagentsTest.crews().get(sid), undefined, "close evicts the crews entry")
  await idle(hooks, sid)
  await sleep(60)
  assert.equal(prompts.length, 0)
  await hooks.dispose?.()
})

test("crew-continue: an ABANDONED crew never continues (crews entry evicted)", async (t) => {
  const { wt, hooks, prompts } = await crewHarness(t)
  const sid = nextSid()
  await armCrew(hooks, wt, sid, "abandon me", ["one"])
  await hooks.tool.crew_close.execute({ abandon: true, reason: "wrong decomposition" }, toolCtx(sid, wt))
  assert.equal(hooks.__forgeSubagentsTest.crews().get(sid), undefined, "abandon evicts the crews entry")
  await idle(hooks, sid)
  await sleep(60)
  assert.equal(prompts.length, 0)
  await hooks.dispose?.()
})

test("crew-continue: a PENDING crew is never auto-continued (the user's decision seam)", async (t) => {
  const { wt, hooks, prompts } = await crewHarness(t)
  const sid = nextSid()
  await hooks.tool.crew_begin.execute({ objective: "pend me", subtasks: [{ title: "one" }] }, toolCtx(sid, wt))
  assert.equal(hooks.__forgeSubagentsTest.crews().get(sid).mode, "pending")
  await idle(hooks, sid)
  await sleep(60)
  assert.equal(prompts.length, 0)
  await hooks.dispose?.()
})

test("crew-continue: a goal-governed session is owned by the goal engine — goal brief only, no crew brief", async (t) => {
  const { wt, hooks, prompts } = await crewHarness(t)
  const sid = nextSid()
  await hooks.tool.goal_write.execute(
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
  await hooks.tool.crew_begin.execute({ objective: "crew under goal", subtasks: [{ title: "one" }], execution: "waves" }, toolCtx(sid, wt))
  assert.equal(hooks.__forgeSubagentsTest.crews().get(sid).mode, "executing")
  await idle(hooks, sid)
  await sleep(60)
  assert.equal(prompts.length, 1, "exactly one brief — the goal's")
  assert.match(briefText(prompts[0]), /\[forge:goal-continue\]/)
  assert.doesNotMatch(briefText(prompts[0]), /\[forge:crew-continue\]/, "no crew brief alongside the goal brief")
  await hooks.dispose?.()
})

// ---------------------------------------------------------------------------
// Scenario 5: non-forge speaker at schedule or send time → no brief.
// ---------------------------------------------------------------------------
test("crew-continue: a non-forge speaker at SCHEDULE time never arms a timer", async (t) => {
  const { wt, hooks, prompts } = await crewHarness(t)
  const sid = nextSid()
  await armCrew(hooks, wt, sid, "switched away", ["one"]) // family forge during arming
  assert.equal(hooks.__forgeSubagentsTest.crews().get(sid).mode, "executing")
  // The speaker switched to a non-forge agent BEFORE the idle fires.
  await hooks["chat.message"]({ sessionID: sid, agent: "build" }, { message: {}, parts: [] })
  await idle(hooks, sid)
  await sleep(60)
  assert.equal(prompts.length, 0, "non-forge speaker: no crew continuation")
  await hooks.dispose?.()
})

test("crew-continue: a speaker switched to non-forge between schedule and SEND gets no brief", async (t) => {
  const { wt, hooks, prompts } = await crewHarness(t)
  const sid = nextSid()
  await armCrew(hooks, wt, sid) // toolCtx agent "forge" → family forge at schedule time
  // Fire the idle, then switch the family INSIDE the debounce window: the
  // schedule-time gate passed, the send-time re-check must refuse.
  const ev = idle(hooks, sid)
  await hooks["chat.message"]({ sessionID: sid, agent: "build" }, { message: {}, parts: [] })
  await ev
  await sleep(60)
  assert.equal(prompts.length, 0, "family gate holds at send time for the crew branch")
  await hooks.dispose?.()
})

// ---------------------------------------------------------------------------
// Scenario 6: stall — 3 consecutive activity-free crew turns stop the ENGINE
// (one bounded disclosure, crew untouched); task dispatch resets the streak;
// fresh crew_begin clears crewStalled.
// ---------------------------------------------------------------------------
test("crew-continue: 3 activity-free turns stall the engine (one disclosure, crew stays registered); fresh crew_begin clears the stall", async (t) => {
  const { wt, hooks, prompts } = await crewHarness(t)
  const sid = nextSid()
  await armCrew(hooks, wt, sid, "stall me", ["one"])

  const originalWarn = console.warn
  let warns = 0
  console.warn = (...args) => {
    warns++
    originalWarn(...args)
  }
  try {
    await idle(hooks, sid) // brief #1
    await sleep(60)
    assert.equal(prompts.length, 1)
    await idle(hooks, sid) // turn 1: activity-free → streak 1, brief #2
    await sleep(60)
    assert.equal(prompts.length, 2)
    await idle(hooks, sid) // turn 2: activity-free → streak 2, brief #3
    await sleep(60)
    assert.equal(prompts.length, 3)
    await idle(hooks, sid) // turn 3: streak hits the limit → stall, NO brief
    await sleep(80)
    assert.equal(prompts.length, 3, "the engine stops sending crew continuations at the streak limit")
    assert.equal(warns, 1, "exactly ONE bounded console disclosure")
    const crew = hooks.__forgeSubagentsTest.crews().get(sid)
    assert.ok(crew && crew.mode === "executing", "the crew itself stays registered (no auto-abandon, no auto-close)")
    // A further idle still briefs nothing (the stall marker holds).
    await idle(hooks, sid)
    await sleep(60)
    assert.equal(prompts.length, 3)
    assert.equal(warns, 1, "no repeat disclosure")

    // Fresh crew_begin clears crewStalled: abandon, re-register, re-arm → the
    // engine briefs again for the NEW registration.
    await hooks.tool.crew_close.execute({ abandon: true, reason: "stalled" }, toolCtx(sid, wt))
    await armCrew(hooks, wt, sid, "round two", ["one"])
    await idle(hooks, sid)
    await sleep(60)
    assert.equal(prompts.length, 4, "fresh crew_begin clears the stall marker")
    assert.match(briefText(prompts[3]), /round two/)
    assert.equal(warns, 1, "still one disclosure total")
  } finally {
    console.warn = originalWarn
    await hooks.dispose?.()
  }
})

test("crew-continue: a task dispatch during a crew turn counts as activity and resets the streak", async (t) => {
  const { wt, hooks, prompts } = await crewHarness(t)
  const sid = nextSid()
  await armCrew(hooks, wt, sid, "wave work", ["one"])
  await idle(hooks, sid) // brief #1
  await sleep(60)
  assert.equal(prompts.length, 1)
  // The turn dispatched a task wave (no writes, no checks) — activity.
  await hooks["tool.execute.after"]({ tool: "task", sessionID: sid, callID: "c1", args: {} }, { title: "", output: "", metadata: {} })
  await idle(hooks, sid) // activity → streak reset, brief #2
  await sleep(60)
  assert.equal(prompts.length, 2, "a dispatching turn continues — the wave discipline advances")
  // Three activity-free turns AFTER the reset are needed to stall.
  await idle(hooks, sid)
  await sleep(60)
  await idle(hooks, sid)
  await sleep(60)
  assert.equal(prompts.length, 4, "streak 1 and 2 still send")
  await idle(hooks, sid)
  await sleep(80)
  assert.equal(prompts.length, 4, "third activity-free turn stalls the engine")
  await hooks.dispose?.()
})

// ---------------------------------------------------------------------------
// Transport-failure cap (shared map + limit, disclosed stop for the crew).
// ---------------------------------------------------------------------------
test("crew-continue: repeated transport failures stop the crew engine with one disclosure; the crew stays registered", async (t) => {
  let fails = 0
  const { wt, hooks } = await crewHarness(t, {
    prompt: async () => {
      fails++
      throw new Error("connection refused (test)")
    },
  })
  const sid = nextSid()
  await armCrew(hooks, wt, sid, "transport me", ["one"])

  const originalWarn = console.warn
  let warns = 0
  console.warn = () => {
    warns++
  }
  try {
    for (let i = 0; i < 3; i++) {
      await idle(hooks, sid)
      await sleep(60)
    }
    assert.equal(fails, 3)
    assert.equal(warns, 1, "one bounded disclosure at the transport cap")
    const crew = hooks.__forgeSubagentsTest.crews().get(sid)
    assert.ok(crew && crew.mode === "executing", "the crew itself is untouched by transport failures")
    // The engine stopped: a fourth idle attempts no further delivery.
    await idle(hooks, sid)
    await sleep(60)
    assert.equal(fails, 3, "no further delivery attempts after the cap")
  } finally {
    console.warn = originalWarn
    await hooks.dispose?.()
  }
})

// ---------------------------------------------------------------------------
// Scenario 7 (D4): session.deleted evicts the crew AND the engine's crew-side
// state.
// ---------------------------------------------------------------------------
test("crew-continue: session.deleted evicts the crew entry and the engine's crew-side state", async (t) => {
  const { wt, hooks, prompts } = await crewHarness(t)
  const sid = nextSid()
  await armCrew(hooks, wt, sid, "delete me", ["one"])
  await idle(hooks, sid) // brief #1 — the engine holds open crew state for sid
  await sleep(60)
  assert.equal(prompts.length, 1)
  await hooks.event({ event: { type: "session.deleted", properties: { info: { id: sid } } } })
  assert.equal(hooks.__forgeSubagentsTest.crews().get(sid), undefined, "session.deleted evicts the crews entry")
  await idle(hooks, sid)
  await sleep(60)
  assert.equal(prompts.length, 1, "no continuation for a deleted session")
  await hooks.dispose?.()
})
