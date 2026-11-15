import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Task-shadow wiring (change task-shadow, tasks group 3/4): the `task` tool
// (the 0.22.0 SDK dispatch engine shadowing the native name) against a fake
// structural SDK client — registration + disable knob + partition posture +
// forge_dispatch retirement, the gate matrix (cross-pool / crew pending /
// crew compliance / primary-only / per-session cap / plan-draft shape parity
// in both modes / write-target async accepted), the sync path (native-parity
// create body WITHOUT question-deny + final message + metadata keys), the
// non-forge target parity path (no pool gate, question policy mode-keyed,
// honest Agent-not-found), sync abort parity, the async handle + single
// idle wake carrying the child's final report, and owner-death harvest
// (SDK abort + diagnostics ledger).

process.env.FORGE_TEST_NO_FENCE = "1"
process.env.FORGE_GOAL_DEBOUNCE_MS = "10"
// Fast polls: the sync path and the async poller slices run in milliseconds.
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
        // Every child is listed (busy stays busy; done/error surface as
        // idle) — the poller's soundness rule treats MISSING entries as
        // active, so a map that omits finished children would never settle.
        for (const [id, st] of childState) map[id] = { type: st === "busy" ? "busy" : "idle" }
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
  return { client, calls, setChildState: (id, st) => childState.set(id, st) }
}

const input = (dir, client) => ({
  client: client ?? { session: {} },
  project: { id: "p" },
  directory: dir,
  worktree: dir,
  serverUrl: new URL("http://127.0.0.1:1"),
  $: () => {},
})

// Tool context seam: metadata calls are recorded so the native/OMO metadata
// contract (agent/sessionId/taskId/run_in_background/description/prompt)
// can be asserted. abort is an AbortController signal when the test wants
// abort parity.
const allowCtx = (sessionID, dir, opts = {}) => {
  const metadataCalls = []
  return {
    sessionID,
    worktree: dir,
    directory: dir,
    ask: async () => ({ status: "allow" }),
    metadata: (m) => metadataCalls.push(m),
    message: async () => {},
    abort: opts.abortController ? opts.abortController.signal : undefined,
    _metadataCalls: metadataCalls,
  }
}

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
// Registration + retirement + tool-face posture + disable knob

test("registration: task is OUR dispatch surface with decision guidance and anti-polling discipline; forge_dispatch is retired", async (t) => {
  const dir = projectWithForgeJson(t, readonlyPool)
  const h = await startServer(input(dir), {})
  t.after(() => h.dispose?.())
  const cfg = emptyCfg()
  await h.config(cfg)
  const tool = h.tool.task
  assert.ok(tool, "task is registered (the shadow)")
  assert.match(tool.description, /run_in_background: true \(async\)/, "run_in_background semantics: async")
  assert.match(tool.description, /omit it \(sync\)/, "run_in_background semantics: sync default")
  assert.match(tool.description, /\[forge:dispatch-complete\]/, "the wake channel is named")
  assert.match(tool.description, /BLOCKING anti-pattern/, "the no-pre-wake-polling rule")
  assert.match(tool.description, /the child MAY ask the user questions/, "sync question parity disclosed")
  assert.match(tool.description, /question tool denied session-wide/, "async question-deny disclosed")
  assert.match(tool.description, /forge-\*`? subagent/, "forge roster guidance")
  // Retirement (spec scenario "forge_dispatch is retired").
  assert.equal(h.tool.forge_dispatch, undefined, "no forge_dispatch tool exists")
  // Partition posture: `task` is NOT a hidden forge-family tool — non-forge
  // agents keep the (shadowed) task surface for their own parity dispatches;
  // workers are banned via their materialized permission task deny.
  assert.equal(cfg.agent.build.tools.task, undefined, "non-forge agents see task (shadow parity)")
  assert.equal(cfg.agent["forge-dp-research"].tools.task, undefined, "workers keep task visible in the tools map (the ban is the permission deny)")
  assert.equal(cfg.agent["forge-dp-research"].tools.forge_dispatch, undefined, "forge_dispatch is gone from the partition vocabulary")
  assert.equal(cfg.agent["forge-dp-research"].permission.task, "deny", "worker recursion ban intact (task: deny)")
  assert.equal(cfg.agent.forge.tools?.task, undefined, "the primary keeps task")
})

test("disable knob: forge.disable removes the shadow with the whole family (native task returns)", async (t) => {
  const dir = projectWithForgeJson(t, readonlyPool)
  const h = await startServer(input(dir), {})
  t.after(() => h.dispose?.())
  const cfg = emptyCfg()
  cfg.agent.forge = { disable: true }
  await h.config(cfg)
  assert.equal(h.tool.task, undefined, "getter removes the task shadow under the disable knob")
  assert.equal(h.tool.plan_write, undefined, "the whole family is gone")
})

// ---------------------------------------------------------------------------
// Sync mode: SDK child session + final message + native-parity create body + metadata

test("sync dispatch: parentID + NO question-deny create body, agent identity + child session id + final message + metadata keys", async (t) => {
  const dir = projectWithForgeJson(t, readonlyPool)
  const { client, calls } = makeClient({ record: { directory: dir, worktree: dir } })
  const h = await startServer(input(dir, client), {})
  t.after(() => h.dispose?.())
  await h.config(emptyCfg())
  const ctx = allowCtx("ses_wait1", dir)
  const r = await h.tool.task.execute(
    { subagent_type: "forge-dp-research", prompt: "audit the repo", description: "repo audit" },
    ctx,
  )
  assert.match(r.output, /forge-dp-research finished/, "agent identity in the result")
  assert.match(r.output, /ses_child_1/, "child session id in the result")
  assert.match(r.output, /report from ses_child_1/, "the child's final assistant message rides the result")
  const create = calls.create[0]
  assert.equal(create.body.parentID, "ses_wait1", "parentID links the child to the dispatching session")
  assert.equal(create.body.permission, undefined, "sync create body carries NO question-deny (native parity — the child may ask)")
  assert.equal(create.body.title, "repo audit (@forge-dp-research subagent)", "native child title format")
  assert.deepEqual(create.query, { directory: dir }, "the child is anchored to the parent's directory")
  const send = calls.promptAsync[0]
  assert.equal(send.path.id, "ses_child_1")
  assert.equal(send.body.agent, "forge-dp-research", "the materialized agent id rides the prompt body")
  // Metadata mirrors the native/OMO task contract (design D3).
  const meta = ctx._metadataCalls.at(-1)?.metadata ?? {}
  assert.equal(meta.agent, "forge-dp-research")
  assert.equal(meta.sessionId, "ses_child_1")
  assert.ok(typeof meta.taskId === "string" && meta.taskId.length > 0, "taskId present")
  assert.equal(meta.run_in_background, false)
  assert.equal(meta.description, "repo audit")
  assert.equal(meta.prompt, "audit the repo")
  assert.deepEqual(Object.keys(meta).sort(), ["agent", "description", "prompt", "run_in_background", "sessionId", "taskId"], "exactly the native/OMO keys")
})

// ---------------------------------------------------------------------------
// Gate matrix (spec: Task shadow surface — the forge gate chain)

test("gate: cross-pool target refused with the task belt copy", async (t) => {
  const dirA = projectWithForgeJson(t, JSON.stringify({ pool: "pa", agents: { research: { model: "zai/glm", thoughtLevel: "low" } } }))
  const dirB = projectWithForgeJson(t, JSON.stringify({ pool: "pb", agents: { research: { model: "zai/glm", thoughtLevel: "low" } } }))
  const { client } = makeClient({ record: { directory: dirA, worktree: dirA } })
  const h = await startServer(input(dirA, client), {})
  t.after(() => h.dispose?.())
  await server(input(dirB, client), {}) // register the second workspace anchor
  await h.config(emptyCfg())
  await assert.rejects(
    () => h.tool.task.execute({ subagent_type: "forge-pb-research", prompt: "x" }, allowCtx("ses_pool", dirA)),
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
    () => h.tool.task.execute({ subagent_type: "forge-dp-research", prompt: "x", run_in_background: true }, allowCtx("ses_cp", dir)),
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
    () => h.tool.task.execute({ subagent_type: `forge-${liveId}`, prompt: "x" }, allowCtx("ses_cc", dir)),
    (err) => {
      const m = String(err)
      assert.match(m, /Pool compliance refused/)
      assert.match(m, /"pool"/, "the minimal fix names the field")
      assert.match(m, /NATIVE task channel/, "the native exit rides the mid-crew refusal")
      return true
    },
  )
})

test("gate: primary-only — workers and non-forge-agents-to-forge-targets are refused", async (t) => {
  const dir = projectWithForgeJson(t, readonlyPool)
  const { client } = makeClient({ record: { directory: dir, worktree: dir } })
  const h = await startServer(input(dir, client), {})
  t.after(() => h.dispose?.())
  await h.config(emptyCfg())
  await h["chat.message"]({ sessionID: "ses_worker", agent: "forge-dp-research" })
  await assert.rejects(
    () => h.tool.task.execute({ subagent_type: "forge-dp-research", prompt: "x" }, allowCtx("ses_worker", dir)),
    /reserved for the primary forge agent/,
  )
  await h["chat.message"]({ sessionID: "ses_out", agent: "build" })
  await assert.rejects(
    () => h.tool.task.execute({ subagent_type: "forge-dp-research", prompt: "x" }, allowCtx("ses_out", dir)),
    (err) => {
      assert.match(String(err), /outside the forge family/)
      assert.match(String(err), /forge-family worker/)
      return true
    },
  )
})

test("gate: unknown forge target refused with roster guidance", async (t) => {
  const dir = projectWithForgeJson(t, readonlyPool)
  const { client } = makeClient({ record: { directory: dir, worktree: dir } })
  const h = await startServer(input(dir, client), {})
  t.after(() => h.dispose?.())
  await h.config(emptyCfg())
  await assert.rejects(
    () => h.tool.task.execute({ subagent_type: "forge-dp-ghost", prompt: "x" }, allowCtx("ses_unk", dir)),
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
  // Readonly target: reconnaissance dispatch passes sync AND async.
  const sync = await h.tool.task.execute({ subagent_type: "forge-dp-research", prompt: "recon" }, allowCtx("ses_draft2", dir))
  assert.match(sync.output, /report from /)
  const asyncR = await h.tool.task.execute({ subagent_type: "forge-dp-research", prompt: "recon 2", run_in_background: true }, allowCtx("ses_draft2", dir))
  assert.match(asyncR.output, /task id: /)
  // Write target: refused in BOTH modes with the draft gate copy.
  for (const bg of [false, true]) {
    await assert.rejects(
      () => h.tool.task.execute({ subagent_type: "forge-dp-builder", prompt: "build", run_in_background: bg }, allowCtx("ses_draft2", dir)),
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
  const r = await h.tool.task.execute(
    { subagent_type: "forge-dp-builder", prompt: "implement it", run_in_background: true, description: "build wave" },
    allowCtx("ses_write", dir),
  )
  assert.match(r.output, /in async mode/, "write shape is dispatchable in async mode")
  assert.match(r.output, /task id: /)
  assert.match(r.output, /child session: ses_child_\d+/)
  assert.deepEqual(calls.create[0].body.permission, [{ permission: "question", action: "deny", pattern: "*" }], "question-deny seal on the async child")
  // Clean up: end the owner session (harvests the child).
  await h.event({ event: { type: "session.deleted", properties: { info: { id: "ses_write" } } } })
})

// ---------------------------------------------------------------------------
// Non-forge targets: native dispatch parity (spec scenario)

test("parity: non-forge host target — sync dispatch, same engine, no forge gates, NO question-deny", async (t) => {
  const dir = projectWithForgeJson(t, readonlyPool)
  const { client, calls } = makeClient({ record: { directory: dir, worktree: dir } })
  const h = await startServer(input(dir, client), {})
  t.after(() => h.dispose?.())
  await h.config(emptyCfg())
  const r = await h.tool.task.execute({ subagent_type: "build", prompt: "run the build", description: "native build" }, allowCtx("ses_nf1", dir))
  assert.match(r.output, /build finished/, "the child runs the target host agent and the result returns")
  assert.match(r.output, /report from ses_child_1/)
  const create = calls.create[0]
  assert.equal(create.body.parentID, "ses_nf1")
  assert.equal(create.body.title, "native build (@build subagent)", "native title format for the host agent target")
  assert.equal(create.body.permission, undefined, "sync parity: no question-deny on non-forge targets either")
  assert.equal(calls.promptAsync[0].body.agent, "build", "the host agent id rides the prompt body")
})

test("parity: non-forge host target — async dispatch carries the question-deny seal", async (t) => {
  const dir = projectWithForgeJson(t, readonlyPool)
  const { client, calls } = makeClient({ record: { directory: dir, worktree: dir }, mode: "busy" })
  const h = await startServer(input(dir, client), {})
  t.after(() => h.dispose?.())
  await h.config(emptyCfg())
  const r = await h.tool.task.execute({ subagent_type: "general", prompt: "bg job", run_in_background: true }, allowCtx("ses_nf2", dir))
  assert.match(r.output, /task id: /)
  assert.deepEqual(calls.create[0].body.permission, [{ permission: "question", action: "deny", pattern: "*" }], "async question policy is mode-keyed for non-forge targets too")
  await h.event({ event: { type: "session.deleted", properties: { info: { id: "ses_nf2" } } } })
})

test("parity: a NON-FORGE speaker dispatching a non-forge target succeeds (native caller parity)", async (t) => {
  const dir = projectWithForgeJson(t, readonlyPool)
  const { client } = makeClient({ record: { directory: dir, worktree: dir } })
  const h = await startServer(input(dir, client), {})
  t.after(() => h.dispose?.())
  await h.config(emptyCfg())
  await h["chat.message"]({ sessionID: "ses_native_speaker", agent: "build" })
  const r = await h.tool.task.execute({ subagent_type: "general", prompt: "help me" }, allowCtx("ses_native_speaker", dir))
  assert.match(r.output, /general finished/, "non-forge speaker → non-forge target flows through the same engine")
})

test("parity: unknown non-forge target is an honest Agent-not-found refusal", async (t) => {
  const dir = projectWithForgeJson(t, readonlyPool)
  const { client } = makeClient({ record: { directory: dir, worktree: dir } })
  const h = await startServer(input(dir, client), {})
  t.after(() => h.dispose?.())
  await h.config(emptyCfg())
  await assert.rejects(
    () => h.tool.task.execute({ subagent_type: "ghost-agent", prompt: "x" }, allowCtx("ses_ghost", dir)),
    (err) => {
      assert.match(String(err), /Agent not found: "ghost-agent"/)
      assert.match(String(err), /neither a materialized forge-\* subagent nor a configured host agent/)
      return true
    },
  )
})

// ---------------------------------------------------------------------------
// Sync abort parity (spec scenario "Sync abort parity")

test("abort parity: a sync dispatch aborted mid-flight aborts the child via the SDK and resolves with the disclosure", async (t) => {
  const dir = projectWithForgeJson(t, readonlyPool)
  const { client, calls } = makeClient({ record: { directory: dir, worktree: dir }, mode: "busy" })
  const h = await startServer(input(dir, client), {})
  t.after(() => h.dispose?.())
  await h.config(emptyCfg())
  const abortController = new AbortController()
  const exec = h.tool.task.execute({ subagent_type: "forge-dp-research", prompt: "long audit", description: "abort me" }, allowCtx("ses_abort", dir, { abortController }))
  // Let the poll loop take at least one slice, then abort the turn.
  setTimeout(() => abortController.abort(), 50)
  const r = await exec
  assert.match(r.output, /dispatching turn was aborted/, "the abort is disclosed in the resolution")
  assert.match(r.output, /child session ses_child_1 was aborted via the SDK/, "the child session id is named")
  assert.ok(calls.abort.some((a) => a.path.id === "ses_child_1"), "session.abort was called on the child")
})

// ---------------------------------------------------------------------------
// Async lifecycle (spec: Dispatch lifecycle)

test("cap: per-session concurrent async cap 3 — 4th refused with in-flight ids + guidance", async (t) => {
  const dir = projectWithForgeJson(t, readonlyPool)
  const { client, calls } = makeClient({ record: { directory: dir, worktree: dir }, mode: "busy" })
  const h = await startServer(input(dir, client), {})
  t.after(() => h.dispose?.())
  await h.config(emptyCfg())
  const dispatch = async (i) =>
    h.tool.task.execute({ subagent_type: "forge-dp-research", prompt: `p${i}`, run_in_background: true }, allowCtx("ses_cap", dir))
  const handles = []
  for (let i = 0; i < 3; i++) handles.push(await dispatch(i))
  const ids = handles.map((x) => x.output.match(/task id: (\S+)/)[1])
  await assert.rejects(
    () => dispatch(3),
    (err) => {
      const m = String(err)
      assert.match(m, /cap 3/, "the cap value is named")
      for (const id of ids) assert.ok(m.includes(id), `in-flight task id ${id} listed`)
      assert.match(m, /without run_in_background/, "guidance to wait or go sync")
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
  const ctx = allowCtx("ses_wake", dir)
  const r = await h.tool.task.execute(
    { subagent_type: "forge-dp-research", prompt: "go", run_in_background: true, description: "wake test" },
    ctx,
  )
  assert.match(r.output, /END YOUR TURN/, "the handle mandates ending the turn")
  const childID = r.output.match(/child session: (ses_child_\d+)/)[1]
  // Async metadata contract mirrors the native keys too.
  const meta = ctx._metadataCalls.at(-1)?.metadata ?? {}
  assert.equal(meta.agent, "forge-dp-research")
  assert.equal(meta.sessionId, childID)
  assert.equal(meta.run_in_background, true)
  assert.ok(typeof meta.taskId === "string" && meta.taskId.length > 0)
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

// ---------------------------------------------------------------------------
// Sync timeout arms completion tracking (change sync-timeout-notify; spec
// scenario "Sync timeout is honest"): a sync dispatch whose child outlives
// the poll window throws the honest finding — and the already-running child
// is registered for the standard completion wake BEFORE the throw, so
// exactly one [forge:dispatch-complete] wake carries the final report when
// it later completes. Arming bypasses the async cap (design D3). The window
// rides the FORGE_DISPATCH_POLL_TIMEOUT_MS env knob (read at call time).

test("sync timeout: honest throw disclosing the ARMED wake, then exactly one [forge:dispatch-complete] with the final report", async (t) => {
  const dir = projectWithForgeJson(t, readonlyPool)
  const { client, calls, setChildState } = makeClient({ record: { directory: dir, worktree: dir }, mode: "busy" })
  const h = await startServer(input(dir, client), {})
  t.after(() => h.dispose?.())
  await h.config(emptyCfg())
  process.env.FORGE_DISPATCH_POLL_TIMEOUT_MS = "250"
  t.after(() => {
    delete process.env.FORGE_DISPATCH_POLL_TIMEOUT_MS
  })
  const ctx = allowCtx("ses_to", dir)
  await assert.rejects(
    () => h.tool.task.execute({ subagent_type: "forge-dp-research", prompt: "long audit", description: "timeout test" }, ctx),
    (err) => {
      const m = String(err)
      assert.match(m, /Poll timeout after 250ms/, "the resolved env-knob window is named (the knob flows through)")
      assert.match(m, /child session ses_child_1 never reached a terminal state/, "the child session id is named")
      assert.match(m, /It remains a real session: inspect or abort it natively in the host TUI/, "the native-inspectability disclosure stays")
      assert.match(m, /Completion tracking is ARMED/, "the armed wake is disclosed")
      assert.match(m, /exactly one \[forge:dispatch-complete\] wake carrying the final report/, "the wake contract is disclosed")
      assert.match(m, /do not poll or re-dispatch in the meantime/, "the no-polling discipline is disclosed")
      assert.ok(!m.includes("No auto-convert"), "the retired No-auto-convert line is gone")
      return true
    },
  )
  // Arming happened: the registry holds the entry and the metadata publish
  // mirrors the async path (taskId = the armed job id).
  const armed = h.__forgeSubagentsTest.dispatchTasks().filter((x) => x.ownerSession === "ses_to")
  assert.equal(armed.length, 1, "the timed-out child is registered for completion tracking")
  assert.equal(armed[0].childSessionID, "ses_child_1")
  const meta = ctx._metadataCalls.at(-1)?.metadata ?? {}
  assert.equal(ctx._metadataCalls.at(-1)?.title, "forge-dp-research: dispatch async", "metadata published like the async path")
  assert.equal(meta.taskId, armed[0].jobId, "the metadata taskId is the ARMED job id")
  assert.equal(meta.sessionId, "ses_child_1")
  assert.equal(meta.run_in_background, false, "the call itself stayed a sync dispatch")
  // The child completes later — the armed poller fetches the report and the
  // wake queue delivers it on idle (exactly once).
  const wakesTo = (sid) => calls.promptAsync.filter((a) => a.path?.id === sid && String(JSON.stringify(a.body)).includes("dispatch-complete"))
  assert.equal(wakesTo("ses_to").length, 0, "no wake before the session idles")
  setChildState("ses_child_1", "done")
  await waitFor(() => h.__forgeSubagentsTest.dispatchTasks().filter((x) => x.ownerSession === "ses_to").length === 0, "armed poller settles")
  await h.event({ event: { type: "session.idle", properties: { sessionID: "ses_to" } } })
  await waitFor(() => wakesTo("ses_to").length === 1, "one wake delivered on idle")
  assert.ok(String(JSON.stringify(wakesTo("ses_to")[0].body)).includes("report from ses_child_1"), "the child's final report rides the wake")
  await h.event({ event: { type: "session.idle", properties: { sessionID: "ses_to" } } })
  await new Promise((res) => setTimeout(res, 100))
  assert.equal(wakesTo("ses_to").length, 1, "at-most-once: no duplicate wake")
})

test("sync timeout arming BYPASSES the async cap (design D3: the cap governs new dispatch decisions, not an already-running child)", async (t) => {
  const dir = projectWithForgeJson(t, readonlyPool)
  const { client, calls, setChildState } = makeClient({ record: { directory: dir, worktree: dir }, mode: "busy" })
  const h = await startServer(input(dir, client), {})
  t.after(() => h.dispose?.())
  await h.config(emptyCfg())
  process.env.FORGE_DISPATCH_POLL_TIMEOUT_MS = "250"
  t.after(() => {
    delete process.env.FORGE_DISPATCH_POLL_TIMEOUT_MS
  })
  // Fill the per-session cap: 3 async dispatches in flight.
  const dispatch = async (i) =>
    h.tool.task.execute({ subagent_type: "forge-dp-research", prompt: `p${i}`, run_in_background: true }, allowCtx("ses_caparm", dir))
  for (let i = 0; i < 3; i++) await dispatch(i)
  // A SYNC dispatch in the same at-cap session times out — arming must still
  // happen (the child is already running regardless of the cap).
  await assert.rejects(
    () => h.tool.task.execute({ subagent_type: "forge-dp-research", prompt: "over the window", description: "cap bypass" }, allowCtx("ses_caparm", dir)),
    (err) => {
      assert.match(String(err), /Completion tracking is ARMED/)
      return true
    },
  )
  const armed = h.__forgeSubagentsTest.dispatchTasks().filter((x) => x.ownerSession === "ses_caparm" && x.childSessionID === "ses_child_4")
  assert.equal(armed.length, 1, "the timed-out sync child is armed despite the session being at the async cap")
  setChildState("ses_child_4", "done")
  const wakesTo = (sid) => calls.promptAsync.filter((a) => a.path?.id === sid && String(JSON.stringify(a.body)).includes("dispatch-complete"))
  await h.event({ event: { type: "session.idle", properties: { sessionID: "ses_caparm" } } })
  await waitFor(() => wakesTo("ses_caparm").some((a) => String(JSON.stringify(a.body)).includes("report from ses_child_4")), "the armed wake arrives with the final report")
  const syncWakes = wakesTo("ses_caparm").filter((a) => String(JSON.stringify(a.body)).includes("report from ses_child_4"))
  assert.equal(syncWakes.length, 1, "exactly one wake carries the timed-out child's report")
})

// Terminal-inference soundness at the wiring layer (sync-timeout-notify):
// the sync dispatch reuses pollChild, so a receipt-style finished message
// observed while the child blinks out of the status map (the host's idle
// signal — map lists only active sessions) or flapping back to busy must
// NOT resolve the call early with the receipt — completion lands only
// after the stability depth, on the real report.

test("soundness (wiring): sync dispatch does not return a receipt on a missing/flapping status — completed only after stability depth, on the real report", async (t) => {
  const dir = projectWithForgeJson(t, readonlyPool)
  const calls = { get: [], create: [], promptAsync: [], prompt: [], status: [], messages: [], abort: [] }
  let n = 0
  const client = {
    session: {
      get: async (a) => { calls.get.push(a); return { directory: dir, worktree: dir } },
      create: async (a) => { calls.create.push(a); return { data: { id: "ses_child_1" } } },
      promptAsync: async (a) => { calls.promptAsync.push(a); return {} },
      prompt: async (a) => { calls.prompt.push(a); return {} },
      // Flap script: tick1 the child is MISSING from the fetched map
      // (unreadable), tick2 it is busy again, tick3+ it is truly idle.
      status: async () => {
        calls.status.push({})
        n++
        if (n === 1) return { data: {} }
        if (n === 2) return { data: { ses_child_1: { type: "busy" } } }
        return { data: { ses_child_1: { type: "idle" } } }
      },
      messages: async (a) => {
        calls.messages.push(a)
        // During the flap window the child emits a finished RECEIPT message
        // (truthy finish + text) — under the old single-observation logic
        // this falsely completed the dispatch at tick 1.
        if (n <= 2) {
          return { data: [{ info: { id: "r", role: "assistant", finish: "stop", time: { created: 1 } }, parts: [{ type: "text", text: "receipt: acknowledged" }] }] }
        }
        return { data: [{ info: { id: "f", role: "assistant", finish: "stop", time: { created: 2 } }, parts: [{ type: "text", text: "REAL final report" }] }] }
      },
      abort: async (a) => { calls.abort.push(a); return true },
    },
  }
  const h = await startServer(input(dir, client), {})
  t.after(() => h.dispose?.())
  await h.config(emptyCfg())
  const r = await h.tool.task.execute(
    { subagent_type: "forge-dp-research", prompt: "flap audit", description: "flap test" },
    allowCtx("ses_flap", dir),
  )
  assert.ok(!/receipt: acknowledged/.test(r.output), "the receipt never resolves the sync dispatch")
  assert.match(r.output, /REAL final report/, "the completed verdict carries the real final report (latest assistant message)")
  assert.equal(calls.status.length, 5, "exactly 5 status readings: missing → busy → 3 stable idle ticks (depth 3 after the reset)")
})

test("soundness (wiring): the async wake path inherits pollChild soundness (completion only after stability)", async (t) => {
  // The async poller slices pollChild with a SHARED stability state — a
  // slice boundary must not reset the run. mode "done" (idle + finished
  // textful message from the first tick) completes only after 3 stable
  // observations, then delivers exactly one wake.
  const dir = projectWithForgeJson(t, readonlyPool)
  const { client, calls } = makeClient({ record: { directory: dir, worktree: dir } })
  const h = await startServer(input(dir, client), {})
  t.after(() => h.dispose?.())
  await h.config(emptyCfg())
  const r = await h.tool.task.execute(
    { subagent_type: "forge-dp-research", prompt: "inherit check", run_in_background: true },
    allowCtx("ses_inherit", dir),
  )
  const childID = r.output.match(/child session: (ses_child_\d+)/)[1]
  const statusReads = () => calls.status.length
  const readsAtDispatch = statusReads()
  await waitFor(() => h.__forgeSubagentsTest.dispatchTasks().filter((x) => x.ownerSession === "ses_inherit").length === 0, "poller settles (stability reached across slices)")
  assert.ok(statusReads() - readsAtDispatch >= 3, "completion required at least the 3-tick stability depth (not the first observation)")
  const wakesTo = (sid) => calls.promptAsync.filter((a) => a.path?.id === sid && String(JSON.stringify(a.body)).includes("dispatch-complete"))
  await h.event({ event: { type: "session.idle", properties: { sessionID: "ses_inherit" } } })
  await waitFor(() => wakesTo("ses_inherit").length === 1, "one wake delivered on idle")
  assert.ok(String(JSON.stringify(wakesTo("ses_inherit")[0].body)).includes(`report from ${childID}`), "the final report rides the wake")
})
