import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Async-dispatch wiring (change async-dispatch, tasks 6.2/6.3): the
// forge_dispatch tool against a fake structural SDK client — registration +
// disable knob + partition injection, the gate matrix (cross-pool / crew
// pending / crew compliance / primary-only / per-session cap / plan-draft
// shape parity in both modes / write-target async accepted), the wait path
// (question-deny create body + final message), the async handle + single
// idle wake carrying the child's final report, and owner-death harvest
// (SDK abort + diagnostics ledger).

process.env.FORGE_TEST_NO_FENCE = "1"
process.env.FORGE_GOAL_DEBOUNCE_MS = "10"
// Fast polls: the wait path and the async poller slices run in milliseconds.
process.env.FORGE_DISPATCH_POLL_INTERVAL_MS = "10"
process.env.FORGE_DISPATCH_POLL_SLICE_MS = "20"
process.env.FORGE_TEST_FORGE_HOME = mkdtempSync(join(tmpdir(), "forge-disp-home-"))
process.env.FORGE_TEST_NO_DISPATCH_FETCH = "1"

import { server } from "../plugin.ts"

const worktreeRoot = mkdtempSync(join(tmpdir(), "forge-disp-"))
process.on("exit", () => {
  for (const d of [worktreeRoot, process.env.FORGE_TEST_FORGE_HOME]) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {}
  }
})

// ---------------------------------------------------------------------------
// Fake structural SDK client: every endpoint recorded; child sessions are
// scripted per test through opts (mode "done" completes on the first poll,
// "busy" stays active forever, "error" terminally errors).

function makeClient(opts = {}) {
  const calls = { get: [], create: [], promptAsync: [], prompt: [], status: [], messages: [], abort: [] }
  let seq = 0
  const childState = new Map()
  const client = {
    session: {
      get: async (args) => {
        calls.get.push(args)
        return opts.record
      },
      create: async (args) => {
        calls.create.push(args)
        const id = `ses_child_${++seq}`
        childState.set(id, opts.mode ?? "done")
        return { data: { id } }
      },
      promptAsync: async (args) => {
        calls.promptAsync.push(args)
        return {}
      },
      prompt: async (args) => {
        calls.prompt.push(args)
        return {}
      },
      status: async () => {
        calls.status.push({})
        const map = {}
        for (const [id, st] of childState) if (st === "busy") map[id] = { type: "busy" }
        return { data: map }
      },
      messages: async (args) => {
        calls.messages.push(args)
        const id = args.path.id
        const st = childState.get(id)
        if (st === "busy") return { data: [] }
        const info = { id: "m1", role: "assistant", finish: "stop", time: { created: 1 } }
        if (st === "error") info.error = { name: "ProviderError", data: { message: "kaput" } }
        return { data: [{ info, parts: [{ type: "text", text: `report from ${id}` }] }] }
      },
      abort: async (args) => {
        calls.abort.push(args)
        childState.set(args.path.id, "done")
        return true
      },
    },
  }
  return { client, calls }
}

const input = (dir, client) => ({
  client: client ?? { session: {} },
  project: { id: "p" },
  directory: dir,
  worktree: dir,
  serverUrl: new URL("http://127.0.0.1:1"),
  $: () => {},
})

const allowCtx = (sessionID, dir) => ({
  sessionID,
  worktree: dir,
  directory: dir,
  ask: async () => ({ status: "allow" }),
  metadata: () => {},
  message: async () => {},
})

const emptyCfg = () => ({ agent: {}, command: {}, permission: {} })

let lastHost = null
async function startServer(inputArg, opts) {
  if (lastHost) lastHost.__forgeSubagentsTest.resetAnchors()
  lastHost = await server(inputArg, opts)
  return lastHost
}

function projectWithForgeJson(t, json) {
  const dir = mkdtempSync(join(tmpdir(), "forge-disp-proj-"))
  t.after(() => {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {}
  })
  mkdirSync(join(dir, ".opencode"), { recursive: true })
  writeFileSync(join(dir, ".opencode", "forge.json"), json)
  return dir
}

async function waitFor(predicate, label, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (predicate()) return
    if (Date.now() > deadline) throw new Error(`waitFor timeout: ${label}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

const readonlyPool = JSON.stringify({ pool: "dp", agents: { research: { model: "zai/glm", thoughtLevel: "low", shape: "readonly" }, builder: { model: "zai/glm", thoughtLevel: "low", shape: "write" } } })

// ---------------------------------------------------------------------------
// Registration + tool-face partition + disable knob

test("registration: forge_dispatch registers with decision guidance and anti-polling discipline", async (t) => {
  const dir = projectWithForgeJson(t, readonlyPool)
  const h = await startServer(input(dir), {})
  t.after(() => h.dispose?.())
  const cfg = emptyCfg()
  await h.config(cfg)
  const tool = h.tool.forge_dispatch
  assert.ok(tool, "forge_dispatch is registered")
  assert.match(tool.description, /"async" when the result does NOT block your next steps/, "dispatch-time decision guidance: async")
  assert.match(tool.description, /next step depends on the result/, "dispatch-time decision guidance: wait")
  assert.match(tool.description, /\[forge:dispatch-complete\]/, "the wake channel is named")
  assert.match(tool.description, /BLOCKING anti-pattern/, "the no-pre-wake-polling rule")
  assert.match(tool.description, /question tool is denied session-wide/, "unattended-safety disclosure")
  // Partition: primary-only (STATE-class) + hidden from non-forge agents.
  assert.equal(cfg.agent["forge-dp-research"].tools.forge_dispatch, false, "workers do not see forge_dispatch (primary-only)")
  assert.equal(cfg.agent.build.tools.forge_dispatch, false, "non-forge agents do not see forge_dispatch")
  assert.equal(cfg.agent.forge.tools?.forge_dispatch, undefined, "the primary keeps it")
})

test("disable knob: forge.dispatch removes forge_dispatch with the whole family", async (t) => {
  const dir = projectWithForgeJson(t, readonlyPool)
  const h = await startServer(input(dir), {})
  t.after(() => h.dispose?.())
  const cfg = emptyCfg()
  cfg.agent.forge = { disable: true }
  await h.config(cfg)
  assert.equal(h.tool.forge_dispatch, undefined, "getter removes forge_dispatch under the disable knob")
  assert.equal(h.tool.plan_write, undefined, "the whole family is gone")
})

// ---------------------------------------------------------------------------
// wait mode: SDK child session + final message

test("wait dispatch: parentID + question-deny create body, agent identity + child session id + final message", async (t) => {
  const dir = projectWithForgeJson(t, readonlyPool)
  const { client, calls } = makeClient({ record: { directory: dir, worktree: dir } })
  const h = await startServer(input(dir, client), {})
  t.after(() => h.dispose?.())
  await h.config(emptyCfg())
  const r = await h.tool.forge_dispatch.execute(
    { subagent_type: "forge-dp-research", prompt: "audit the repo", mode: "wait", description: "repo audit" },
    allowCtx("ses_wait1", dir),
  )
  assert.match(r.output, /forge-dp-research finished/, "agent identity in the result")
  assert.match(r.output, /ses_child_1/, "child session id in the result")
  assert.match(r.output, /report from ses_child_1/, "the child's final assistant message rides the result")
  const create = calls.create[0]
  assert.equal(create.body.parentID, "ses_wait1", "parentID links the child to the dispatching session")
  assert.deepEqual(create.body.permission, [{ permission: "question", action: "deny", pattern: "*" }], "question-deny seal session-wide")
  assert.equal(create.body.title, "repo audit (@forge-dp-research subagent)", "native child title format")
  assert.deepEqual(create.query, { directory: dir }, "the child is anchored to the parent's directory")
  const send = calls.promptAsync[0]
  assert.equal(send.path.id, "ses_child_1")
  assert.equal(send.body.agent, "forge-dp-research", "the materialized agent id rides the prompt body")
})

// ---------------------------------------------------------------------------
// Gate matrix (spec: forge_dispatch surface — gate parity with native task)

test("gate: cross-pool target refused with the native-task copy", async (t) => {
  const dirA = projectWithForgeJson(t, JSON.stringify({ pool: "pa", agents: { research: { model: "zai/glm", thoughtLevel: "low" } } }))
  const dirB = projectWithForgeJson(t, JSON.stringify({ pool: "pb", agents: { research: { model: "zai/glm", thoughtLevel: "low" } } }))
  const { client } = makeClient({ record: { directory: dirA, worktree: dirA } })
  const h = await startServer(input(dirA, client), {})
  t.after(() => h.dispose?.())
  await server(input(dirB, client), {}) // register the second workspace anchor
  await h.config(emptyCfg())
  await assert.rejects(
    () => h.tool.forge_dispatch.execute({ subagent_type: "forge-pb-research", prompt: "x", mode: "wait" }, allowCtx("ses_pool", dirA)),
    (err) => {
      const m = String(err)
      assert.match(m, /not dispatchable from this session/, "the spec-mandated finding")
      assert.ok(m.toLowerCase().includes(join(dirB, ".opencode", "forge.json").toLowerCase()), "the target's origin pool path is named")
      assert.match(m, /Exits: /, "the three exits")
      return true
    },
  )
})

test("gate: crew pending belt refuses dispatch until armed", async (t) => {
  const dir = projectWithForgeJson(t, readonlyPool)
  const { client } = makeClient({ record: { directory: dir, worktree: dir } })
  const h = await startServer(input(dir, client), {})
  t.after(() => h.dispose?.())
  await h.config(emptyCfg())
  await h.tool.crew_begin.execute({ objective: "o", subtasks: [{ title: "x" }] }, allowCtx("ses_cp", dir))
  await assert.rejects(
    () => h.tool.forge_dispatch.execute({ subagent_type: "forge-dp-research", prompt: "x", mode: "async" }, allowCtx("ses_cp", dir)),
    /PENDING/,
  )
})

test("gate: crew pool-compliance belt refuses mid-crew dispatch on a degraded pool file", async (t) => {
  // Register + arm while the pool file is compliant, then DEGRADE it
  // (drop the top-level pool field) mid-crew — the dispatch belt re-checks
  // file truth on every call (hot-apply) and refuses until repaired.
  const dir = projectWithForgeJson(t, JSON.stringify({ pool: "dp2", agents: { research: { model: "zai/glm", thoughtLevel: "low", shape: "readonly" } } }))
  const { client } = makeClient({ record: { directory: dir, worktree: dir } })
  const h = await startServer(input(dir, client), {})
  t.after(() => h.dispose?.())
  await h.config(emptyCfg())
  await h.tool.crew_begin.execute({ objective: "o", subtasks: [{ title: "x" }] }, allowCtx("ses_cc", dir))
  await h.tool.crew_begin.execute({ execution: "waves" }, allowCtx("ses_cc", dir))
  writeFileSync(join(dir, ".opencode", "forge.json"), JSON.stringify({ agents: { research: { model: "zai/glm", thoughtLevel: "low", shape: "readonly" } } }))
  // Degrading the file re-materializes the family under the directory-name
  // namespace — resolve the LIVE id (hot-apply truth) and target it.
  const liveId = Object.keys(h.__forgeSubagentsTest.resolveNow().agents).find((id) => id.endsWith("research"))
  assert.ok(liveId, "the degraded pool still materializes its agent (renamed)")
  await assert.rejects(
    () => h.tool.forge_dispatch.execute({ subagent_type: `forge-${liveId}`, prompt: "x", mode: "wait" }, allowCtx("ses_cc", dir)),
    (err) => {
      const m = String(err)
      assert.match(m, /Pool compliance refused/)
      assert.match(m, /"pool"/, "the minimal fix names the field")
      assert.match(m, /NATIVE task channel/, "the native exit rides the mid-crew refusal")
      return true
    },
  )
})

test("gate: primary-only — workers and non-forge agents cannot dispatch", async (t) => {
  const dir = projectWithForgeJson(t, readonlyPool)
  const { client } = makeClient({ record: { directory: dir, worktree: dir } })
  const h = await startServer(input(dir, client), {})
  t.after(() => h.dispose?.())
  await h.config(emptyCfg())
  await h["chat.message"]({ sessionID: "ses_worker", agent: "forge-dp-research" })
  await assert.rejects(
    () => h.tool.forge_dispatch.execute({ subagent_type: "forge-dp-research", prompt: "x", mode: "wait" }, allowCtx("ses_worker", dir)),
    /reserved for the primary forge agent/,
  )
  await h["chat.message"]({ sessionID: "ses_out", agent: "build" })
  await assert.rejects(
    () => h.tool.forge_dispatch.execute({ subagent_type: "forge-dp-research", prompt: "x", mode: "wait" }, allowCtx("ses_out", dir)),
    /outside it/,
  )
})

test("gate: unknown target refused with roster guidance", async (t) => {
  const dir = projectWithForgeJson(t, readonlyPool)
  const { client } = makeClient({ record: { directory: dir, worktree: dir } })
  const h = await startServer(input(dir, client), {})
  t.after(() => h.dispose?.())
  await h.config(emptyCfg())
  await assert.rejects(
    () => h.tool.forge_dispatch.execute({ subagent_type: "forge-dp-ghost", prompt: "x", mode: "wait" }, allowCtx("ses_unk", dir)),
    /not a materialized forge subagent/,
  )
})

test("gate: plan-draft shape parity — readonly passes BOTH modes, write refused in BOTH modes", async (t) => {
  const dir = projectWithForgeJson(t, readonlyPool)
  const { client } = makeClient({ record: { directory: dir, worktree: dir } })
  const h = await startServer(input(dir, client), {})
  t.after(() => h.dispose?.())
  await h.config(emptyCfg())
  await h.tool.plan_write.execute(
    { goal: "drafting", context: "c", approach: "a", tasks: ["t1"], risks: "r", acceptance: ["a1"] },
    allowCtx("ses_draft2", dir),
  )
  // Readonly target: reconnaissance dispatch passes in wait AND async.
  const wait = await h.tool.forge_dispatch.execute({ subagent_type: "forge-dp-research", prompt: "recon", mode: "wait" }, allowCtx("ses_draft2", dir))
  assert.match(wait.output, /report from /)
  const asyncR = await h.tool.forge_dispatch.execute({ subagent_type: "forge-dp-research", prompt: "recon 2", mode: "async" }, allowCtx("ses_draft2", dir))
  assert.match(asyncR.output, /task id: /)
  // Write target: refused in BOTH modes with the native-task draft copy.
  for (const mode of ["wait", "async"]) {
    await assert.rejects(
      () => h.tool.forge_dispatch.execute({ subagent_type: "forge-dp-builder", prompt: "build", mode }, allowCtx("ses_draft2", dir)),
      (err) => {
        const m = String(err)
        assert.match(m, /plan is in draft/)
        assert.match(m, /Readonly recon scouts ARE dispatchable during draft: forge-dp-research/, "roster guidance names the readonly scouts")
        return true
      },
    )
  }
})

test("gate: write-target async accepted outside a draft (all-shapes async)", async (t) => {
  const dir = projectWithForgeJson(t, readonlyPool)
  const { client, calls } = makeClient({ record: { directory: dir, worktree: dir } })
  const h = await startServer(input(dir, client), {})
  t.after(() => h.dispose?.())
  await h.config(emptyCfg())
  const r = await h.tool.forge_dispatch.execute(
    { subagent_type: "forge-dp-builder", prompt: "implement it", mode: "async", description: "build wave" },
    allowCtx("ses_write", dir),
  )
  assert.match(r.output, /in async mode/, "write shape is dispatchable in async mode")
  assert.match(r.output, /task id: /)
  assert.match(r.output, /child session: ses_child_\d+/)
  assert.deepEqual(calls.create[0].body.permission, [{ permission: "question", action: "deny", pattern: "*" }], "question-deny seal on the write child too")
  // Clean up: end the owner session (harvests the child).
  await h.event({ event: { type: "session.deleted", properties: { info: { id: "ses_write" } } } })
})

// ---------------------------------------------------------------------------
// Async lifecycle (spec: Async dispatch lifecycle)

test("cap: per-session concurrent async cap 3 — 4th refused with in-flight ids + guidance", async (t) => {
  const dir = projectWithForgeJson(t, readonlyPool)
  const { client, calls } = makeClient({ record: { directory: dir, worktree: dir }, mode: "busy" })
  const h = await startServer(input(dir, client), {})
  t.after(() => h.dispose?.())
  await h.config(emptyCfg())
  const dispatch = async (i) =>
    h.tool.forge_dispatch.execute({ subagent_type: "forge-dp-research", prompt: `p${i}`, mode: "async" }, allowCtx("ses_cap", dir))
  const handles = []
  for (let i = 0; i < 3; i++) handles.push(await dispatch(i))
  const ids = handles.map((x) => x.output.match(/task id: (\S+)/)[1])
  await assert.rejects(
    () => dispatch(3),
    (err) => {
      const m = String(err)
      assert.match(m, /cap 3/, "the cap value is named")
      for (const id of ids) assert.ok(m.includes(id), `in-flight task id ${id} listed`)
      assert.match(m, /mode: "wait"/, "guidance to wait or use wait mode")
      return true
    },
  )
  // Owner death harvest (spec scenario): each child aborted via the SDK +
  // orphan ledgered; the handle map drains.
  await h.event({ event: { type: "session.deleted", properties: { info: { id: "ses_cap" } } } })
  await waitFor(() => calls.abort.length >= 3, "3 child aborts")
  // (dispatchTasks is module state across tests — scope to this session.)
  assert.equal(h.__forgeSubagentsTest.dispatchTasks().filter((x) => x.ownerSession === "ses_cap").length, 0, "handle map drained for the dead session")
  const orphans = h.__forgeSubagentsTest.jobLedger().filter((e) => e.kind === "orphan-job" && ids.includes(e.jobId))
  assert.equal(orphans.length, 3, "every orphan is recorded in the diagnostics ledger")
})

test("wake: async completion delivers ONE idle wake carrying the child's final message", async (t) => {
  const dir = projectWithForgeJson(t, readonlyPool)
  const { client, calls } = makeClient({ record: { directory: dir, worktree: dir } })
  const h = await startServer(input(dir, client), {})
  t.after(() => h.dispose?.())
  await h.config(emptyCfg())
  const r = await h.tool.forge_dispatch.execute(
    { subagent_type: "forge-dp-research", prompt: "go", mode: "async", description: "wake test" },
    allowCtx("ses_wake", dir),
  )
  assert.match(r.output, /END YOUR TURN/, "the handle mandates ending the turn")
  const childID = r.output.match(/child session: (ses_child_\d+)/)[1]
  // The poller settles in the background; the wake waits for idle.
  await waitFor(() => h.__forgeSubagentsTest.dispatchTasks().length === 0, "poller settles")
  const wakesTo = (sid) => calls.promptAsync.filter((a) => a.path?.id === sid && String(JSON.stringify(a.body)).includes("dispatch-complete"))
  assert.equal(wakesTo("ses_wake").length, 0, "no wake before the session idles")
  await h.event({ event: { type: "session.idle", properties: { sessionID: "ses_wake" } } })
  await waitFor(() => wakesTo("ses_wake").length === 1, "one wake delivered on idle")
  const wake = wakesTo("ses_wake")[0]
  const text = JSON.stringify(wake.body)
  assert.ok(text.includes(`report from ${childID}`), "the child's final message rides the wake inline")
  assert.ok(text.includes("forge-dp-research"), "the wake names the agent identity")
  // At-most-once: another idle edge delivers nothing new.
  await h.event({ event: { type: "session.idle", properties: { sessionID: "ses_wake" } } })
  await new Promise((res) => setTimeout(res, 100))
  assert.equal(wakesTo("ses_wake").length, 1, "no duplicate wake after delivery")
})
