import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
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

import { server, TASK_SEAM_DEGRADED_ERROR } from "../plugin.ts"

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
  let abortMode = opts.abortMode ?? "ok"
  const childState = new Map()
  const client = {
    session: {
      get: async (args) => {
        calls.get.push(args)
        // Child-id probes feed the fold B stale machinery (sessionGet);
        // owner-id probes feed the pool-gate anchor resolution (opts.record).
        if (typeof args.path?.id === "string" && args.path.id.startsWith("ses_child_")) {
          if (typeof opts.childGet === "function") return opts.childGet(args.path.id)
          // Default: a PRODUCING child (fresh time.updated every read).
          return { time: { updated: Date.now() } }
        }
        return opts.record
      },
      create: async (args) => {
        calls.create.push(args)
        const id = `ses_child_${++seq}`
        const mode = typeof opts.mode === "function" ? opts.mode(seq) : (opts.mode ?? "done")
        childState.set(id, mode)
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
        // Textless-idle floor shape (fold #2): not-active + a finished
        // assistant message whose only text part is EMPTY — not a
        // reportable final message.
        if (st === "textless") {
          return { data: [{ info: { id: "m1", role: "assistant", finish: "stop", time: { created: 1 } }, parts: [{ type: "text", text: "" }] }] }
        }
        const info = { id: "m1", role: "assistant", finish: "stop", time: { created: 1 } }
        if (st === "error") info.error = { name: "ProviderError", data: { message: opts.errorText ?? "kaput" } }
        return { data: [{ info, parts: [{ type: "text", text: `report from ${id}` }] }] }
      },
      abort: async (args) => {
        calls.abort.push(args)
        if (abortMode === "throw") throw new Error("abort endpoint refused")
        childState.set(args.path.id, "done")
        return true
      },
    },
  }
  return { client, calls, setChildState: (id, st) => childState.set(id, st), setAbortMode: (m) => (abortMode = m) }
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
  assert.ok(meta.prompt.startsWith("audit the repo"), "the original prompt leads the metadata verbatim")
  assert.match(meta.prompt, new RegExp(`Report delivery contract[^\\n]*reports/${meta.taskId}-report\\.md`), "the metadata prompt carries the standing report-file contract (stream-loss honesty)")
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

test("cap (fold D): 4th+ wish QUEUES — only beyond the queue bound is the call refused with in-flight AND queued ids", async (t) => {
  process.env.FORGE_DISPATCH_QUEUE_MAX = "1"
  t.after(() => {
    delete process.env.FORGE_DISPATCH_QUEUE_MAX
  })
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
  // Cap number unchanged: 3 RUNNING; the 4th wish QUEUES instead of refusing.
  const queued = await dispatch(3)
  assert.match(queued.output, /QUEUED \(queue position 1\)/, "the 4th wish queues with a position note")
  const queuedId = queued.output.match(/task id: (\S+)/)[1]
  assert.equal(h.__forgeSubagentsTest.dispatchQueues().filter((x) => x.ownerSession === "ses_cap").length, 1, "the wish sits in the per-session queue")
  assert.equal(calls.create.length, 3, "no child spawned for the queued wish yet")
  // Beyond the queue bound (FORGE_DISPATCH_QUEUE_MAX=1): refused listing the
  // in-flight AND queued task ids.
  await assert.rejects(
    () => dispatch(4),
    (err) => {
      const m = String(err)
      assert.match(m, /cap 3/, "the cap value is named")
      for (const id of ids) assert.ok(m.includes(id), `in-flight task id ${id} listed`)
      assert.ok(m.includes(queuedId), "queued task id listed")
      assert.match(m, /queue is full \(bound 1\)/, "the queue bound is named")
      assert.match(m, /without run_in_background/, "guidance to wait or go sync")
      return true
    },
  )
  // Owner death harvest (spec scenario): each running child aborted via the
  // SDK + orphan ledgered; the handle map drains; the queued wish flushes
  // WITHOUT spawning.
  await h.event({ event: { type: "session.deleted", properties: { info: { id: "ses_cap" } } } })
  await waitFor(() => calls.abort.length >= 3, "3 child aborts")
  // (dispatchTasks is module state across tests — scope to this session.)
  assert.equal(h.__forgeSubagentsTest.dispatchTasks().filter((x) => x.ownerSession === "ses_cap").length, 0, "handle map drained for the dead session")
  const orphans = h.__forgeSubagentsTest.jobLedger().filter((e) => e.kind === "orphan-job" && ids.includes(e.jobId))
  assert.equal(orphans.length, 3, "every orphan is recorded in the diagnostics ledger")
  assert.equal(h.__forgeSubagentsTest.dispatchQueues().filter((x) => x.ownerSession === "ses_cap").length, 0, "the queued wish flushed without spawning")
  assert.equal(calls.create.length, 3, "the flushed wish never spawned a child")
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
// scenario "Sync timeout is honest"; presentation reclassified by
// dispatch-sync-handoff-notice): a sync dispatch whose child outlives the
// poll window returns an INFORMATIONAL handoff notice (never the error
// channel) — and the already-running child is registered for the standard
// completion wake BEFORE the return, so exactly one
// [forge:dispatch-complete] wake carries the final report when it later
// completes. Arming bypasses the async cap (design D3). The window rides
// the FORGE_DISPATCH_POLL_TIMEOUT_MS env knob (read at call time).

test("sync timeout: informational handoff notice (not an error) disclosing the armed wake, then exactly one [forge:dispatch-complete] with the final report", async (t) => {
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
  const r = await h.tool.task.execute({ subagent_type: "forge-dp-research", prompt: "long audit", description: "timeout test" }, ctx)
  const m = r.output
  assert.match(r.title, /dispatch continues in background/, "the handoff is a normal result (informational title, no error channel)")
  assert.match(m, /Sync wait budget ended \(250ms\)/, "the resolved env-knob window is named (the knob flows through)")
  assert.match(m, /the dispatch continues in the background; collect with forge_jobs/, "the outcome + collection path are named (spec wording)")
  assert.match(m, /child session: ses_child_1/, "the child session id is named")
  assert.match(m, /inspect or abort it natively in the host TUI/, "the native-inspectability disclosure stays")
  assert.match(m, /Report path \(ground truth\): reports\/\S+-report\.md/, "the report-path retrieval pointer is present")
  assert.match(m, /exactly one \[forge:dispatch-complete\] wake carrying the final report/, "the wake contract is disclosed")
  assert.match(m, /do not poll or re-dispatch in the meantime/, "the no-polling discipline is disclosed")
  assert.ok(!m.includes("No auto-convert"), "the retired No-auto-convert line is gone")
  // Arming happened: the registry holds the entry and the metadata publish
  // mirrors the async path (taskId = the armed job id).
  const armed = h.__forgeSubagentsTest.dispatchTasks().filter((x) => x.ownerSession === "ses_to")
  assert.equal(armed.length, 1, "the timed-out child is registered for completion tracking")
  assert.equal(armed[0].childSessionID, "ses_child_1")
  const meta = ctx._metadataCalls.at(-1)?.metadata ?? {}
  assert.equal(ctx._metadataCalls.at(-1)?.title, "forge-dp-research: dispatch async", "tracker metadata published like the async path")
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

test("sync handoff presentation matrix: genuine failures keep the error channel (dispatch-sync-handoff-notice)", async (t) => {
  const dir = projectWithForgeJson(t, readonlyPool)
  const { client } = makeClient({ record: { directory: dir, worktree: dir }, mode: "error", errorText: "no provider available for the pinned model" })
  const h = await startServer(input(dir, client), {})
  t.after(() => h.dispose?.())
  await h.config(emptyCfg())
  process.env.FORGE_DISPATCH_POLL_TIMEOUT_MS = "120000"
  t.after(() => {
    delete process.env.FORGE_DISPATCH_POLL_TIMEOUT_MS
  })
  // Evidence-backed worker failure: the SYNC call REJECTS (error channel) —
  // the informational reclassification never covers real failures.
  await assert.rejects(
    () => h.tool.task.execute({ subagent_type: "forge-dp-research", prompt: "broken config", description: "error channel" }, allowCtx("ses_matrix", dir)),
    (err) => {
      const m = String(err)
      assert.match(m, /child session ses_child_1 ended in error/, "the worker error names the child + the recorded evidence")
      assert.match(m, /no provider available/, "the evidence rides the error")
      assert.ok(!m.includes("collect with forge_jobs"), "no informational handoff styling on a genuine failure")
      return true
    },
  )
  // Gate refusal: same error channel as before — pin ONE refusal class (the
  // primary-only belt; the full gate matrix lives in its own tests).
  await h["chat.message"]({ sessionID: "ses_matrix_worker", agent: "forge-dp-research" })
  await assert.rejects(
    () => h.tool.task.execute({ subagent_type: "forge-dp-research", prompt: "worker dispatch" }, allowCtx("ses_matrix_worker", dir)),
    /reserved for the primary forge agent/,
    "gate refusal stays a rejection",
  )
  await h.event({ event: { type: "session.deleted", properties: { info: { id: "ses_matrix" } } } })
  await h.event({ event: { type: "session.deleted", properties: { info: { id: "ses_matrix_worker" } } } })
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
  const rCap = await h.tool.task.execute(
    { subagent_type: "forge-dp-research", prompt: "over the window", description: "cap bypass" },
    allowCtx("ses_caparm", dir),
  )
  assert.match(rCap.output, /collect with forge_jobs/, "the informational handoff still surfaces at the cap")
  const armed = h.__forgeSubagentsTest.dispatchTasks().filter((x) => x.ownerSession === "ses_caparm" && x.childSessionID === "ses_child_4")
  assert.equal(armed.length, 1, "the timed-out sync child is armed despite the session being at the async cap")
  setChildState("ses_child_4", "done")
  const wakesTo = (sid) => calls.promptAsync.filter((a) => a.path?.id === sid && String(JSON.stringify(a.body)).includes("dispatch-complete"))
  await h.event({ event: { type: "session.idle", properties: { sessionID: "ses_caparm" } } })
  await waitFor(() => wakesTo("ses_caparm").some((a) => String(JSON.stringify(a.body)).includes("report from ses_child_4")), "the armed wake arrives with the final report")
  const syncWakes = wakesTo("ses_caparm").filter((a) => String(JSON.stringify(a.body)).includes("report from ses_child_4"))
  assert.equal(syncWakes.length, 1, "exactly one wake carries the timed-out child's report")
  // Explicit teardown (fix-dispatch-dispose-kill 2.4): dispose spares dispatch
  // rows by contract, and the three cap-filling children stay busy forever —
  // end the owner session (the legal registry kill) so their trackers drain
  // and no test relies on process-exit cleanup.
  await h.event({ event: { type: "session.deleted", properties: { info: { id: "ses_caparm" } } } })
  await waitFor(() => h.__forgeSubagentsTest.dispatchTasks().filter((x) => x.ownerSession === "ses_caparm").length === 0, "cap-filling trackers drained by the owner-death harvest")
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

// ---------------------------------------------------------------------------
// Never-die tracking + progress notices + textless-idle floor
// (sync-timeout-notify fold #2, design D6; spec scenarios "Long child keeps
// tracking past the notification interval" and "Textless idle child
// terminates honestly"). The async poller has NO wall-clock deadline: the
// loop ends only at completion / error / registry kill / the floor, and
// past each notification interval it parks a non-terminal
// [forge:dispatch-progress] notice that flushes on the owner idle edge
// BEFORE the terminal wake.

test("never-die (K3 shape): child busy past a notify boundary → progress notices, then exactly ONE report wake with the REAL final report", async (t) => {
  process.env.FORGE_DISPATCH_NOTIFY_INTERVAL_MS = "80"
  t.after(() => {
    delete process.env.FORGE_DISPATCH_NOTIFY_INTERVAL_MS
  })
  const dir = projectWithForgeJson(t, readonlyPool)
  const { client, calls, setChildState } = makeClient({ record: { directory: dir, worktree: dir }, mode: "busy" })
  const h = await startServer(input(dir, client), {})
  t.after(() => h.dispose?.())
  await h.config(emptyCfg())
  const r = await h.tool.task.execute(
    { subagent_type: "forge-dp-research", prompt: "long run", run_in_background: true, description: "k3 long" },
    allowCtx("ses_k3", dir),
  )
  const childID = r.output.match(/child session: (ses_child_\d+)/)[1]
  const jobId = r.output.match(/task id: (\S+)/)[1]
  // The child stays busy across ≥1 notify-interval boundary: notices park.
  await waitFor(() => h.__forgeSubagentsTest.dispatchProgress("ses_k3").length >= 1, "progress notices enqueue past the interval")
  assert.equal(h.__forgeSubagentsTest.dispatchTasks().filter((x) => x.ownerSession === "ses_k3").length, 1, "tracking continues past the notify boundary (never dies)")
  // Nothing delivered while the owner is not idle (idle-only injection).
  const toOwner = () => calls.promptAsync.filter((a) => a.path?.id === "ses_k3")
  assert.equal(toOwner().length, 0, "no sends before the owner idles")
  // The child completes LATE — the tracker is still alive to see it.
  setChildState(childID, "done")
  await waitFor(() => h.__forgeSubagentsTest.dispatchTasks().filter((x) => x.ownerSession === "ses_k3").length === 0, "poller settles on real completion")
  await h.event({ event: { type: "session.idle", properties: { sessionID: "ses_k3" } } })
  // Classify sends by their TEXT PREFIX, not substring: the progress notice
  // names [forge:dispatch-complete] in its body, and the terminal wake's
  // tail slice embeds the parked notice text.
  const textOf = (a) => String(a.body?.parts?.[0]?.text ?? "")
  await waitFor(() => toOwner().some((a) => textOf(a).startsWith("[forge:dispatch-complete]")), "the terminal wake is delivered")
  const sends = toOwner().map(textOf)
  const progress = sends.filter((s) => s.startsWith("[forge:dispatch-progress]"))
  assert.ok(progress.length >= 1, "at least one progress notice was delivered")
  assert.match(progress[0], new RegExp(`\\[forge:dispatch-progress\\] task dispatch to forge-dp-research \\(task ${jobId}, child session ${childID}\\) is still running after \\d+ min`), "the exact notice shape (agent, task id, child session, minutes)")
  for (const p of progress) assert.ok(!p.includes("report from"), "progress notices carry no report content")
  const wakes = sends.filter((s) => s.startsWith("[forge:dispatch-complete]"))
  assert.equal(wakes.length, 1, "exactly ONE terminal wake")
  assert.ok(wakes[0].includes(`report from ${childID}`), "the terminal wake carries the REAL final report (not a timeout string)")
  assert.ok(sends.findIndex((s) => s.startsWith("[forge:dispatch-progress]")) < sends.findIndex((s) => s.startsWith("[forge:dispatch-complete]")), "progress flushes BEFORE the terminal wake")
  await h.event({ event: { type: "session.deleted", properties: { info: { id: "ses_k3" } } } })
})

test("never-die (K1b shape + knob isolation): completion inside a notify boundary still wakes; FORGE_DISPATCH_POLL_TIMEOUT_MS never kills the tracker", async (t) => {
  // A tiny SYNC-WAIT knob (150ms) plus a notify interval of 600ms: the
  // child finishes at ~250ms — past the sync knob, inside the notify
  // boundary. Under the old deadline break this is exactly the K1b race
  // (completion near the boundary loses); now there is no deadline to lose
  // against, and the sync knob scopes only the sync wait.
  process.env.FORGE_DISPATCH_POLL_TIMEOUT_MS = "150"
  process.env.FORGE_DISPATCH_NOTIFY_INTERVAL_MS = "600"
  t.after(() => {
    delete process.env.FORGE_DISPATCH_POLL_TIMEOUT_MS
    delete process.env.FORGE_DISPATCH_NOTIFY_INTERVAL_MS
  })
  const dir = projectWithForgeJson(t, readonlyPool)
  const { client, calls, setChildState } = makeClient({ record: { directory: dir, worktree: dir }, mode: "busy" })
  const h = await startServer(input(dir, client), {})
  t.after(() => h.dispose?.())
  await h.config(emptyCfg())
  const r = await h.tool.task.execute(
    { subagent_type: "forge-dp-research", prompt: "near boundary", run_in_background: true },
    allowCtx("ses_k1b", dir),
  )
  const childID = r.output.match(/child session: (ses_child_\d+)/)[1]
  await new Promise((res) => setTimeout(res, 250))
  assert.equal(h.__forgeSubagentsTest.dispatchTasks().filter((x) => x.ownerSession === "ses_k1b").length, 1, "the tracker is alive past FORGE_DISPATCH_POLL_TIMEOUT_MS (the knob scopes the SYNC WAIT only)")
  assert.equal(h.__forgeSubagentsTest.dispatchProgress("ses_k1b").length, 0, "no progress notice yet (completion falls inside the notify interval)")
  setChildState(childID, "done")
  await waitFor(() => h.__forgeSubagentsTest.dispatchTasks().filter((x) => x.ownerSession === "ses_k1b").length === 0, "poller settles")
  await h.event({ event: { type: "session.idle", properties: { sessionID: "ses_k1b" } } })
  const toOwner = () => calls.promptAsync.filter((a) => a.path?.id === "ses_k1b")
  const textOf = (a) => String(a.body?.parts?.[0]?.text ?? "")
  await waitFor(() => toOwner().some((a) => textOf(a).startsWith("[forge:dispatch-complete]")), "the report wake arrives (no deadline break to lose the race against)")
  const sends = toOwner().map(textOf)
  assert.equal(sends.filter((s) => s.startsWith("[forge:dispatch-complete]")).length, 1, "exactly one terminal wake")
  assert.ok(sends.filter((s) => s.startsWith("[forge:dispatch-complete]"))[0].includes(`report from ${childID}`), "the real final report rides the wake")
  assert.equal(sends.filter((s) => s.startsWith("[forge:dispatch-progress]")).length, 0, "no progress notices — completed before the first boundary")
  await h.event({ event: { type: "session.deleted", properties: { info: { id: "ses_k1b" } } } })
})

test("textless-idle floor: idle child with a finished-but-textless message ends honestly after one notify interval (finding names the child)", async (t) => {
  process.env.FORGE_DISPATCH_NOTIFY_INTERVAL_MS = "120"
  t.after(() => {
    delete process.env.FORGE_DISPATCH_NOTIFY_INTERVAL_MS
  })
  const dir = projectWithForgeJson(t, readonlyPool)
  const { client, calls } = makeClient({ record: { directory: dir, worktree: dir }, mode: "textless" })
  const h = await startServer(input(dir, client), {})
  t.after(() => h.dispose?.())
  await h.config(emptyCfg())
  const r = await h.tool.task.execute(
    { subagent_type: "forge-dp-research", prompt: "go silent", run_in_background: true },
    allowCtx("ses_floor", dir),
  )
  const childID = r.output.match(/child session: (ses_child_\d+)/)[1]
  const jobId = r.output.match(/task id: (\S+)/)[1]
  // Report-file delivery contract: the child's dispatch prompt names the
  // concrete agreed path (reports/<task>-report.md).
  const childSend = calls.promptAsync.find((a) => a.path?.id === childID)
  assert.ok(childSend, "the child prompt send is recorded")
  assert.match(String(childSend.body?.parts?.[0]?.text ?? ""), new RegExp(`Report delivery contract[^\\n]*reports/${jobId}-report\\.md`), "the dispatch prompt carries the standing report-file contract with the concrete agreed path")
  await waitFor(() => h.__forgeSubagentsTest.dispatchTasks().filter((x) => x.ownerSession === "ses_floor").length === 0, "the floor terminates the tracker honestly")
  await h.event({ event: { type: "session.idle", properties: { sessionID: "ses_floor" } } })
  const toOwner = () => calls.promptAsync.filter((a) => a.path?.id === "ses_floor")
  const textOf = (a) => String(a.body?.parts?.[0]?.text ?? "")
  await waitFor(() => toOwner().some((a) => textOf(a).startsWith("[forge:dispatch-complete]")), "the finding arrives as the terminal wake")
  const sends = toOwner().map(textOf)
  const wakes = sends.filter((s) => s.startsWith("[forge:dispatch-complete]"))
  assert.equal(wakes.length, 1, "exactly one terminal wake")
  // dispatch-stream-loss-honesty: the floor exit is the stream-lost/unknown
  // class — result stream lost, child state UNKNOWN, never an obituary.
  assert.match(wakes[0], /RESULT STREAM LOST/, "the wake states the result stream was lost")
  assert.match(wakes[0], new RegExp(`child session ${childID} state UNKNOWN \\(possibly still running\\)`), "the wake names the child session id with the honest UNKNOWN state")
  assert.match(wakes[0], new RegExp(`reports/${jobId}-report\\.md`), "the wake names the agreed report file as the ground-truth recovery channel")
  assert.ok(!/ended without a reportable final message/.test(wakes[0]), "no death-certificate obituary wording")
  // Ledger completeness: the journal records the stream-lost/unknown
  // terminal with the last-observed activity timestamp.
  const journalText = readFileSync(join(dir, ".opencode", "forge", "dispatch-log.jsonl"), "utf8")
  const records = journalText.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l))
  const lostRecord = records.find((rec) => rec.outcome === "stream-lost/unknown")
  assert.ok(lostRecord, "the journal records a stream-lost/unknown entry (never a bare error)")
  assert.equal(lostRecord.state, "terminal", "the stream-lost outcome is the dispatch's terminal record")
  assert.equal(lostRecord.id, jobId, "the lost record names the dispatch task id")
  assert.match(lostRecord.reason, /last observed activity \d{4}-\d{2}-\d{2}T/, "the lost record carries the last-observed activity timestamp")
  assert.equal(sends.filter((s) => s.startsWith("[forge:dispatch-progress]")).length, 0, "no progress notices — a textless-idle child is not 'running'")
  await h.event({ event: { type: "session.deleted", properties: { info: { id: "ses_floor" } } } })
})

test("textless-idle floor: a busy re-appearance resets the streak — no finding while the child runs", async (t) => {
  process.env.FORGE_DISPATCH_NOTIFY_INTERVAL_MS = "150"
  t.after(() => {
    delete process.env.FORGE_DISPATCH_NOTIFY_INTERVAL_MS
  })
  const dir = projectWithForgeJson(t, readonlyPool)
  const { client, calls, setChildState } = makeClient({ record: { directory: dir, worktree: dir }, mode: "textless" })
  const h = await startServer(input(dir, client), {})
  t.after(() => h.dispose?.())
  await h.config(emptyCfg())
  const r = await h.tool.task.execute(
    { subagent_type: "forge-dp-research", prompt: "flap then finish", run_in_background: true },
    allowCtx("ses_reset", dir),
  )
  const childID = r.output.match(/child session: (ses_child_\d+)/)[1]
  // Textless-idle for a while (inside the interval), then BUSY again — the
  // streak must reset, so the tracker cannot floor a running child.
  await new Promise((res) => setTimeout(res, 60))
  setChildState(childID, "busy")
  await new Promise((res) => setTimeout(res, 250))
  assert.equal(h.__forgeSubagentsTest.dispatchTasks().filter((x) => x.ownerSession === "ses_reset").length, 1, "no floor finding while the child runs — the streak reset on the busy reading")
  // It then completes textful: the normal report wake lands.
  setChildState(childID, "done")
  await waitFor(() => h.__forgeSubagentsTest.dispatchTasks().filter((x) => x.ownerSession === "ses_reset").length === 0, "poller settles on completion")
  await h.event({ event: { type: "session.idle", properties: { sessionID: "ses_reset" } } })
  const toOwner = () => calls.promptAsync.filter((a) => a.path?.id === "ses_reset")
  const textOf = (a) => String(a.body?.parts?.[0]?.text ?? "")
  await waitFor(() => toOwner().some((a) => textOf(a).startsWith("[forge:dispatch-complete]")), "the report wake arrives")
  const wake = toOwner().map(textOf).find((s) => s.startsWith("[forge:dispatch-complete]"))
  assert.ok(wake.includes(`report from ${childID}`), "the real final report rides the wake (the floor never fired)")
  await h.event({ event: { type: "session.deleted", properties: { info: { id: "ses_reset" } } } })
})

test("copy: async discipline, handle text, and the ARMED finding disclose progress notices + the guaranteed final wake however long it takes", async (t) => {
  const dir = projectWithForgeJson(t, readonlyPool)
  const { client, calls } = makeClient({ record: { directory: dir, worktree: dir }, mode: "busy" })
  const h = await startServer(input(dir, client), {})
  t.after(() => h.dispose?.())
  await h.config(emptyCfg())
  assert.match(h.tool.task.description, /\[forge:dispatch-progress\]/, "the tool description discloses interim progress notices")
  assert.match(h.tool.task.description, /however long it takes/, "the guaranteed-final-wake wording")
  assert.match(h.tool.task.description, /BLOCKING anti-pattern/, "the no-pre-wake-polling rule stays")
  const r = await h.tool.task.execute(
    { subagent_type: "forge-dp-research", prompt: "copy check", run_in_background: true },
    allowCtx("ses_copy", dir),
  )
  assert.match(r.output, /END YOUR TURN/, "the stop mandate stays")
  assert.match(r.output, /\[forge:dispatch-progress\] notices may arrive while the child runs/, "the handle mentions interim notices")
  assert.match(r.output, /however long it takes/, "the handle guarantees the final wake regardless of duration")
  // The ARMED sync handoff carries the same disclosure (informational, not
  // an error).
  process.env.FORGE_DISPATCH_POLL_TIMEOUT_MS = "150"
  t.after(() => {
    delete process.env.FORGE_DISPATCH_POLL_TIMEOUT_MS
  })
  const rArmed = await h.tool.task.execute(
    { subagent_type: "forge-dp-research", prompt: "over the window", description: "copy armed" },
    allowCtx("ses_copy2", dir),
  )
  const mArmed = rArmed.output
  assert.match(mArmed, /collect with forge_jobs/)
  assert.match(mArmed, /exactly one \[forge:dispatch-complete\] wake carrying the final report/, "at-most-one terminal wake stays TRUE")
  assert.match(mArmed, /however long it takes/)
  assert.match(mArmed, /\[forge:dispatch-progress\] notices may arrive meanwhile/)
  // Harvest both sessions (aborts the still-busy children, drains state).
  await h.event({ event: { type: "session.deleted", properties: { info: { id: "ses_copy" } } } })
  await h.event({ event: { type: "session.deleted", properties: { info: { id: "ses_copy2" } } } })
})

// ---------------------------------------------------------------------------
// Activity-stale reap (dispatch-resilience fold B; spec scenarios "Stale
// reap after prolonged inactivity", "Active children are never reaped",
// "Stale observe mode only notifies", "Runtime floor blocks early reap",
// "Failed abort skips the sweep", "Existence probe decides"). The runtime
// floor is shrunk via the internal FORGE_DISPATCH_STALE_FLOOR_MS seam; the
// stale threshold keeps its production default (45 min) with the fake's
// time.updated anchored 46 min in the past — the clamp on
// FORGE_DISPATCH_STALE_MS itself is unit-tested in dispatch-async.test.mjs.

const MIN = 60_000

test("stale reap (kill): silent busy child aborted via the SDK with the ONE honest stale wake; NEVER retried", async (t) => {
  process.env.FORGE_DISPATCH_STALE_FLOOR_MS = "50"
  t.after(() => {
    delete process.env.FORGE_DISPATCH_STALE_FLOOR_MS
  })
  const dir = projectWithForgeJson(t, readonlyPool)
  const past = Date.now() - 46 * MIN
  const { client, calls } = makeClient({ record: { directory: dir, worktree: dir }, mode: "busy", childGet: () => ({ time: { updated: past } }) })
  const h = await startServer(input(dir, client), {})
  t.after(() => h.dispose?.())
  await h.config(emptyCfg())
  const r = await h.tool.task.execute(
    { subagent_type: "forge-dp-research", prompt: "hang forever", run_in_background: true },
    allowCtx("ses_stale1", dir),
  )
  const childID = r.output.match(/child session: (ses_child_\d+)/)[1]
  const jobId = r.output.match(/task id: (\S+)/)[1]
  // The reaper aborts the child via the SDK...
  await waitFor(() => calls.abort.some((a) => a.path.id === childID), "SDK abort on the stale child")
  // ...and the tracker terminalizes with the honest stale finding.
  await waitFor(() => h.__forgeSubagentsTest.dispatchTasks().filter((x) => x.ownerSession === "ses_stale1").length === 0, "tracker settles on the reap")
  await h.event({ event: { type: "session.idle", properties: { sessionID: "ses_stale1" } } })
  const toOwner = () => calls.promptAsync.filter((a) => a.path?.id === "ses_stale1")
  const textOf = (a) => String(a.body?.parts?.[0]?.text ?? "")
  await waitFor(() => toOwner().some((a) => textOf(a).startsWith("[forge:dispatch-complete]")), "stale wake delivered")
  const wakes = toOwner().map(textOf).filter((s) => s.startsWith("[forge:dispatch-complete]"))
  assert.equal(wakes.length, 1, "exactly ONE terminal wake")
  assert.match(wakes[0], /stale: aborted after \d+ min without activity/, "the honest stale finding (verbatim shape)")
  assert.ok(wakes[0].includes(childID), "the finding names the child session id")
  assert.ok(wakes[0].includes(jobId), "the wake names the task id")
  // A stale kill is EXCLUDED from fold C retry: no respawn happened.
  assert.equal(calls.create.length, 1, "no retry — the stale kill is final")
  await h.event({ event: { type: "session.deleted", properties: { info: { id: "ses_stale1" } } } })
})

test("stale reap: a continuously-producing child is NEVER reaped (refresh rail resets the timer)", async (t) => {
  process.env.FORGE_DISPATCH_STALE_FLOOR_MS = "50"
  t.after(() => {
    delete process.env.FORGE_DISPATCH_STALE_FLOOR_MS
  })
  const dir = projectWithForgeJson(t, readonlyPool)
  const { client, calls } = makeClient({ record: { directory: dir, worktree: dir }, mode: "busy" })
  const h = await startServer(input(dir, client), {})
  t.after(() => h.dispose?.())
  await h.config(emptyCfg())
  await h.tool.task.execute(
    { subagent_type: "forge-dp-research", prompt: "keep producing", run_in_background: true },
    allowCtx("ses_stale2", dir),
  )
  // Default childGet returns a FRESH time.updated every probe — across many
  // slice boundaries the anchor keeps resetting, so no abort ever fires.
  await new Promise((res) => setTimeout(res, 700))
  assert.equal(calls.abort.length, 0, "a producing child is never aborted")
  assert.equal(h.__forgeSubagentsTest.dispatchTasks().filter((x) => x.ownerSession === "ses_stale2").length, 1, "tracking continues (never reaped)")
  await h.event({ event: { type: "session.deleted", properties: { info: { id: "ses_stale2" } } } })
})

test("stale observe mode: ONE progress notice per threshold crossing, NO kill", async (t) => {
  process.env.FORGE_DISPATCH_STALE_FLOOR_MS = "50"
  process.env.FORGE_DISPATCH_STALE_MODE = "observe"
  t.after(() => {
    delete process.env.FORGE_DISPATCH_STALE_FLOOR_MS
    delete process.env.FORGE_DISPATCH_STALE_MODE
  })
  const dir = projectWithForgeJson(t, readonlyPool)
  const past = Date.now() - 46 * MIN
  const { client, calls } = makeClient({ record: { directory: dir, worktree: dir }, mode: "busy", childGet: () => ({ time: { updated: past } }) })
  const h = await startServer(input(dir, client), {})
  t.after(() => h.dispose?.())
  await h.config(emptyCfg())
  const r = await h.tool.task.execute(
    { subagent_type: "forge-dp-research", prompt: "silent but observed", run_in_background: true },
    allowCtx("ses_stale3", dir),
  )
  const childID = r.output.match(/child session: (ses_child_\d+)/)[1]
  await waitFor(() => h.__forgeSubagentsTest.dispatchProgress("ses_stale3").length >= 1, "the observe notice parks")
  // More slices pass (the crossing would repeat every tick without the
  // staleNotified latch) — the notice must NOT repeat.
  await new Promise((res) => setTimeout(res, 400))
  const notices = h.__forgeSubagentsTest.dispatchProgress("ses_stale3").filter((s) => s.includes("no activity"))
  assert.equal(notices.length, 1, "exactly ONE notice per crossing (not per tick)")
  assert.match(notices[0], new RegExp(`child session ${childID}`), "the notice names the child")
  assert.match(notices[0], /not killing/, "the observe posture is disclosed")
  assert.equal(calls.abort.length, 0, "observe mode NEVER aborts")
  assert.equal(h.__forgeSubagentsTest.dispatchTasks().filter((x) => x.ownerSession === "ses_stale3").length, 1, "tracking continues")
  await h.event({ event: { type: "session.deleted", properties: { info: { id: "ses_stale3" } } } })
})

test("stale reap: FAILED abort + session still exists → skip the sweep and re-arm; finalize only when the abort later succeeds", async (t) => {
  process.env.FORGE_DISPATCH_STALE_FLOOR_MS = "50"
  t.after(() => {
    delete process.env.FORGE_DISPATCH_STALE_FLOOR_MS
  })
  const dir = projectWithForgeJson(t, readonlyPool)
  const past = Date.now() - 46 * MIN
  const { client, calls, setAbortMode } = makeClient({ record: { directory: dir, worktree: dir }, mode: "busy", childGet: () => ({ time: { updated: past } }), abortMode: "throw" })
  const h = await startServer(input(dir, client), {})
  t.after(() => h.dispose?.())
  await h.config(emptyCfg())
  const r = await h.tool.task.execute(
    { subagent_type: "forge-dp-research", prompt: "unabortable", run_in_background: true },
    allowCtx("ses_stale4", dir),
  )
  const childID = r.output.match(/child session: (ses_child_\d+)/)[1]
  // The abort fails but existence (sessionGet) proves the session alive —
  // the sweep skips and re-arms; NO terminal wake fires.
  await waitFor(() => calls.abort.length >= 1, "the reaper attempted the abort")
  await new Promise((res) => setTimeout(res, 300))
  assert.equal(h.__forgeSubagentsTest.dispatchTasks().filter((x) => x.ownerSession === "ses_stale4").length, 1, "skipped sweep re-armed — the row is still tracked")
  assert.ok(calls.abort.length >= 2, "the sweep retried on later slices (re-armed)")
  // The abort endpoint recovers — the next sweep kills and finalizes.
  setAbortMode("ok")
  await waitFor(() => h.__forgeSubagentsTest.dispatchTasks().filter((x) => x.ownerSession === "ses_stale4").length === 0, "the recovered abort finalizes the reap")
  await h.event({ event: { type: "session.idle", properties: { sessionID: "ses_stale4" } } })
  const textOf = (a) => String(a.body?.parts?.[0]?.text ?? "")
  await waitFor(
    () => calls.promptAsync.filter((a) => a.path?.id === "ses_stale4").some((a) => textOf(a).startsWith("[forge:dispatch-complete]")),
    "the stale wake arrives once the abort landed",
  )
  const wake = calls.promptAsync.filter((a) => a.path?.id === "ses_stale4").map(textOf).find((s) => s.startsWith("[forge:dispatch-complete]"))
  assert.match(wake, /stale: aborted after \d+ min without activity/)
  assert.ok(wake.includes(childID))
  await h.event({ event: { type: "session.deleted", properties: { info: { id: "ses_stale4" } } } })
})

test("stale reap: session MISSING at the sweep → finalize honestly without an abort", async (t) => {
  process.env.FORGE_DISPATCH_STALE_FLOOR_MS = "50"
  t.after(() => {
    delete process.env.FORGE_DISPATCH_STALE_FLOOR_MS
  })
  const dir = projectWithForgeJson(t, readonlyPool)
  // Deterministic gone-path: the anchor adopts a past time.updated, every
  // kill sweep's ABORT fails (endpoint throws) while existence still proves
  // the session alive (skip + re-arm), and THEN the probe flips to
  // data:null — the next sweep finalizes the record as gone.
  let goneNow = false
  const past = Date.now() - 46 * MIN
  const mk = makeClient({
    record: { directory: dir, worktree: dir },
    mode: "busy",
    abortMode: "throw",
    childGet: () => (goneNow ? { data: null } : { time: { updated: past } }),
  })
  const h = await startServer(input(dir, mk.client), {})
  t.after(() => h.dispose?.())
  await h.config(emptyCfg())
  const r = await h.tool.task.execute(
    { subagent_type: "forge-dp-research", prompt: "vanishing child", run_in_background: true },
    allowCtx("ses_stale5", dir),
  )
  const childID = r.output.match(/child session: (ses_child_\d+)/)[1]
  // Kill sweeps fire but the abort fails with the session still existing —
  // skip + re-arm, NO terminal wake while existence holds.
  await waitFor(() => mk.calls.abort.length >= 1, "the reaper attempted (and failed) the abort")
  assert.equal(h.__forgeSubagentsTest.dispatchTasks().filter((x) => x.ownerSession === "ses_stale5").length, 1, "failed abort + live session → sweep skipped, re-armed")
  // The session vanishes: the next probe finalizes the record as gone.
  goneNow = true
  await waitFor(() => h.__forgeSubagentsTest.dispatchTasks().filter((x) => x.ownerSession === "ses_stale5").length === 0, "the missing session finalizes the record")
  await h.event({ event: { type: "session.idle", properties: { sessionID: "ses_stale5" } } })
  const textOf = (a) => String(a.body?.parts?.[0]?.text ?? "")
  await waitFor(
    () => mk.calls.promptAsync.filter((a) => a.path?.id === "ses_stale5").some((a) => textOf(a).startsWith("[forge:dispatch-complete]")),
    "the gone finding arrives",
  )
  const wake = mk.calls.promptAsync.filter((a) => a.path?.id === "ses_stale5").map(textOf).find((s) => s.startsWith("[forge:dispatch-complete]"))
  assert.match(wake, /no longer exists/, "the honest gone finding")
  assert.ok(wake.includes(childID), "names the child session id")
  await h.event({ event: { type: "session.deleted", properties: { info: { id: "ses_stale5" } } } })
})

test("stale reap: the 60 s runtime floor blocks early reap (however silent)", async (t) => {
  process.env.FORGE_DISPATCH_STALE_FLOOR_MS = "600000" // 10 min floor — no reap inside this test
  t.after(() => {
    delete process.env.FORGE_DISPATCH_STALE_FLOOR_MS
  })
  const dir = projectWithForgeJson(t, readonlyPool)
  const past = Date.now() - 46 * MIN
  const { client, calls } = makeClient({ record: { directory: dir, worktree: dir }, mode: "busy", childGet: () => ({ time: { updated: past } }) })
  const h = await startServer(input(dir, client), {})
  t.after(() => h.dispose?.())
  await h.config(emptyCfg())
  await h.tool.task.execute(
    { subagent_type: "forge-dp-research", prompt: "young and silent", run_in_background: true },
    allowCtx("ses_stale6", dir),
  )
  await new Promise((res) => setTimeout(res, 500))
  assert.equal(calls.abort.length, 0, "a child younger than the runtime floor is never reaped, however silent")
  assert.equal(h.__forgeSubagentsTest.dispatchTasks().filter((x) => x.ownerSession === "ses_stale6").length, 1, "tracking continues")
  await h.event({ event: { type: "session.deleted", properties: { info: { id: "ses_stale6" } } } })
})

// ---------------------------------------------------------------------------
// Retry with resume preamble (dispatch-resilience fold C; spec scenarios
// "Retryable error respawns with a resume preamble", "Deterministic terminal
// classes are never retried", "Stale kills, aborts, and floor findings are
// never retried"). The 10 s backoff is shrunk via the
// FORGE_DISPATCH_RETRY_BACKOFF_MS test seam.

test("retry: transient error respawns with the preamble — slot inherited, notice per attempt, final wake discloses attempts", async (t) => {
  process.env.FORGE_DISPATCH_RETRY_BACKOFF_MS = "30"
  t.after(() => {
    delete process.env.FORGE_DISPATCH_RETRY_BACKOFF_MS
  })
  const dir = projectWithForgeJson(t, readonlyPool)
  // Child 1 dies in a TRANSIENT error; the retry child (create #2) completes.
  const { client, calls } = makeClient({ record: { directory: dir, worktree: dir }, mode: (seq) => (seq === 1 ? "error" : "done"), errorText: "fetch failed: ECONNRESET mid-stream" })
  const h = await startServer(input(dir, client), {})
  t.after(() => h.dispose?.())
  await h.config(emptyCfg())
  const r = await h.tool.task.execute(
    { subagent_type: "forge-dp-research", prompt: "recover me", run_in_background: true, description: "retry test" },
    allowCtx("ses_rt1", dir),
  )
  const jobId = r.output.match(/task id: (\S+)/)[1]
  const child1 = r.output.match(/child session: (ses_child_\d+)/)[1]
  // The retry child spawned...
  await waitFor(() => calls.create.length === 2, "the fresh child spawned")
  const create2 = calls.create[1]
  assert.equal(create2.body.parentID, "ses_rt1", "respawn keeps the owner as parent")
  assert.deepEqual(create2.body.permission, [{ permission: "question", action: "deny", pattern: "*" }], "the mode-keyed question deny is re-applied on the retry child")
  const child2 = "ses_child_2"
  // The retry prompt carries the ORIGINAL prompt + the inspect-then-continue preamble.
  const retryPrompt = calls.promptAsync.map((a) => a.body?.parts?.[0]?.text ?? "").find((txt) => txt.includes("recover me") && txt.includes("inspect the current workspace state"))
  assert.ok(retryPrompt, "the retry prompt contains the original prompt AND the inspect-then-continue preamble")
  assert.ok(retryPrompt.startsWith("Note: a previous attempt"), "the preamble is PREPENDED")
  assert.ok(retryPrompt.includes("CONTINUE the work"), "the continue-not-redo instruction")
  // A progress notice disclosed the attempt.
  await waitFor(() => h.__forgeSubagentsTest.dispatchProgress("ses_rt1").some((s) => s.includes(`attempt 2/2 starting after`)), "the attempt notice parks")
  // Registry slot inherited: ONE row for the session the whole time, ending on child2.
  await waitFor(() => h.__forgeSubagentsTest.dispatchTasks().filter((x) => x.ownerSession === "ses_rt1").length === 0, "the retry settles")
  await h.event({ event: { type: "session.idle", properties: { sessionID: "ses_rt1" } } })
  const toOwner = () => calls.promptAsync.filter((a) => a.path?.id === "ses_rt1")
  const textOf = (a) => String(a.body?.parts?.[0]?.text ?? "")
  await waitFor(() => toOwner().some((a) => textOf(a).startsWith("[forge:dispatch-complete]")), "the final wake arrives")
  const wakes = toOwner().map(textOf).filter((s) => s.startsWith("[forge:dispatch-complete]"))
  assert.equal(wakes.length, 1, "exactly ONE terminal wake after the retry")
  assert.ok(wakes[0].includes(child2), "the wake names the NEW child session id")
  assert.ok(wakes[0].includes(`report from ${child2}`), "the retry child's report rides the wake")
  assert.ok(wakes[0].includes("(after 2 attempt(s))"), "the final wake discloses the attempt count")
  assert.ok(wakes[0].includes(jobId), "same registry slot — the original task id")
  assert.ok(!wakes[0].includes(`report from ${child1}`), "the dead attempt's session is not the reported one")
  await h.event({ event: { type: "session.deleted", properties: { info: { id: "ses_rt1" } } } })
})

test("retry: provider-config-class error does NOT retry (omo terminal set)", async (t) => {
  const dir = projectWithForgeJson(t, readonlyPool)
  const { client, calls } = makeClient({ record: { directory: dir, worktree: dir }, mode: "error", errorText: "no provider available for the pinned model" })
  const h = await startServer(input(dir, client), {})
  t.after(() => h.dispose?.())
  await h.config(emptyCfg())
  const r = await h.tool.task.execute(
    { subagent_type: "forge-dp-research", prompt: "broken config", run_in_background: true },
    allowCtx("ses_rt2", dir),
  )
  await waitFor(() => h.__forgeSubagentsTest.dispatchTasks().filter((x) => x.ownerSession === "ses_rt2").length === 0, "terminal on the first error")
  assert.equal(calls.create.length, 1, "no respawn for a provider-configuration error")
  assert.equal(h.__forgeSubagentsTest.dispatchProgress("ses_rt2").filter((s) => s.includes("attempt")).length, 0, "no attempt notice")
  await h.event({ event: { type: "session.idle", properties: { sessionID: "ses_rt2" } } })
  const textOf = (a) => String(a.body?.parts?.[0]?.text ?? "")
  await waitFor(
    () => calls.promptAsync.filter((a) => a.path?.id === "ses_rt2").some((a) => textOf(a).startsWith("[forge:dispatch-complete]")),
    "the honest error wake arrives as-is",
  )
  const wake = calls.promptAsync.filter((a) => a.path?.id === "ses_rt2").map(textOf).find((s) => s.startsWith("[forge:dispatch-complete]"))
  assert.ok(wake.includes("no provider available"), "the error is delivered as-is")
  assert.ok(!wake.includes("attempt(s)"), "no attempt disclosure — nothing was retried")
  await h.event({ event: { type: "session.deleted", properties: { info: { id: "ses_rt2" } } } })
})

test("retry: UNKNOWN error class does NOT retry (fail-closed)", async (t) => {
  const dir = projectWithForgeJson(t, readonlyPool)
  const { client, calls } = makeClient({ record: { directory: dir, worktree: dir }, mode: "error", errorText: "kaput" })
  const h = await startServer(input(dir, client), {})
  t.after(() => h.dispose?.())
  await h.config(emptyCfg())
  await h.tool.task.execute(
    { subagent_type: "forge-dp-research", prompt: "mystery death", run_in_background: true },
    allowCtx("ses_rt3", dir),
  )
  await waitFor(() => h.__forgeSubagentsTest.dispatchTasks().filter((x) => x.ownerSession === "ses_rt3").length === 0, "terminal on the first error")
  assert.equal(calls.create.length, 1, "unrecognized classes are never retried")
  await h.event({ event: { type: "session.deleted", properties: { info: { id: "ses_rt3" } } } })
})

test("retry: attempt cap honored — 2 transient deaths end in the honest terminal after BOTH attempts", async (t) => {
  process.env.FORGE_DISPATCH_RETRY_BACKOFF_MS = "30"
  t.after(() => {
    delete process.env.FORGE_DISPATCH_RETRY_BACKOFF_MS
  })
  const dir = projectWithForgeJson(t, readonlyPool)
  const { client, calls } = makeClient({ record: { directory: dir, worktree: dir }, mode: "error", errorText: "503 Service Unavailable" })
  const h = await startServer(input(dir, client), {})
  t.after(() => h.dispose?.())
  await h.config(emptyCfg())
  await h.tool.task.execute(
    { subagent_type: "forge-dp-research", prompt: "always down", run_in_background: true },
    allowCtx("ses_rt4", dir),
  )
  await waitFor(() => h.__forgeSubagentsTest.dispatchTasks().filter((x) => x.ownerSession === "ses_rt4").length === 0, "the cap ends the tracking honestly")
  assert.equal(calls.create.length, 2, "exactly 2 attempts (FORGE_DISPATCH_MAX_ATTEMPTS default 2)")
  assert.ok(h.__forgeSubagentsTest.dispatchProgress("ses_rt4").some((s) => s.includes("attempt 2/2 starting after")), "the retry attempt was noticed")
  await h.event({ event: { type: "session.idle", properties: { sessionID: "ses_rt4" } } })
  const textOf = (a) => String(a.body?.parts?.[0]?.text ?? "")
  await waitFor(
    () => calls.promptAsync.filter((a) => a.path?.id === "ses_rt4").some((a) => textOf(a).startsWith("[forge:dispatch-complete]")),
    "the honest terminal wake",
  )
  const wake = calls.promptAsync.filter((a) => a.path?.id === "ses_rt4").map(textOf).find((s) => s.startsWith("[forge:dispatch-complete]"))
  assert.ok(wake.includes("child session ended in error"), "the terminal discloses the error")
  assert.ok(wake.includes("(after 2 attempt(s))"), "the attempt count is disclosed")
  assert.ok(wake.includes("ses_child_2"), "the wake names the LAST attempt's child session")
  await h.event({ event: { type: "session.deleted", properties: { info: { id: "ses_rt4" } } } })
})

test("retry: USER ABORT (registry kill at owner death) never retries", async (t) => {
  const dir = projectWithForgeJson(t, readonlyPool)
  const { client, calls } = makeClient({ record: { directory: dir, worktree: dir }, mode: "busy" })
  const h = await startServer(input(dir, client), {})
  t.after(() => h.dispose?.())
  await h.config(emptyCfg())
  await h.tool.task.execute(
    { subagent_type: "forge-dp-research", prompt: "die with the owner", run_in_background: true },
    allowCtx("ses_rt5", dir),
  )
  await new Promise((res) => setTimeout(res, 150))
  await h.event({ event: { type: "session.deleted", properties: { info: { id: "ses_rt5" } } } })
  await waitFor(() => calls.abort.length >= 1, "the harvest aborted the child")
  await new Promise((res) => setTimeout(res, 250))
  assert.equal(calls.create.length, 1, "a user abort is never retried")
  await new Promise((res) => setTimeout(res, 100))
})

test("retry: textless-idle floor finding never retries", async (t) => {
  process.env.FORGE_DISPATCH_NOTIFY_INTERVAL_MS = "80"
  t.after(() => {
    delete process.env.FORGE_DISPATCH_NOTIFY_INTERVAL_MS
  })
  const dir = projectWithForgeJson(t, readonlyPool)
  const { client, calls } = makeClient({ record: { directory: dir, worktree: dir }, mode: "textless" })
  const h = await startServer(input(dir, client), {})
  t.after(() => h.dispose?.())
  await h.config(emptyCfg())
  await h.tool.task.execute(
    { subagent_type: "forge-dp-research", prompt: "go textless", run_in_background: true },
    allowCtx("ses_rt6", dir),
  )
  await waitFor(() => h.__forgeSubagentsTest.dispatchTasks().filter((x) => x.ownerSession === "ses_rt6").length === 0, "the floor terminates")
  assert.equal(calls.create.length, 1, "a floor finding is never retried")
  await h.event({ event: { type: "session.deleted", properties: { info: { id: "ses_rt6" } } } })
})

test("retry (armed-sync): a timed-out sync dispatch's armed poller retries too — the wake names the NEW child session id", async (t) => {
  process.env.FORGE_DISPATCH_POLL_TIMEOUT_MS = "150"
  process.env.FORGE_DISPATCH_RETRY_BACKOFF_MS = "30"
  t.after(() => {
    delete process.env.FORGE_DISPATCH_POLL_TIMEOUT_MS
    delete process.env.FORGE_DISPATCH_RETRY_BACKOFF_MS
  })
  const dir = projectWithForgeJson(t, readonlyPool)
  const { client, calls, setChildState } = makeClient({ record: { directory: dir, worktree: dir }, mode: (seq) => (seq === 1 ? "busy" : "done"), errorText: "socket hang up" })
  const h = await startServer(input(dir, client), {})
  t.after(() => h.dispose?.())
  await h.config(emptyCfg())
  const rArmed = await h.tool.task.execute(
    { subagent_type: "forge-dp-research", prompt: "long then flaky", description: "armed retry" },
    allowCtx("ses_rt7", dir),
  )
  assert.match(rArmed.output, /collect with forge_jobs/, "the armed handoff is informational")
  // The armed child dies in a transient error AFTER the timeout handoff —
  // the armed poller retries through the same machinery.
  setChildState("ses_child_1", "error")
  await waitFor(() => calls.create.length === 2, "the armed poller respawned")
  await waitFor(() => h.__forgeSubagentsTest.dispatchTasks().filter((x) => x.ownerSession === "ses_rt7").length === 0, "the retry settles")
  await h.event({ event: { type: "session.idle", properties: { sessionID: "ses_rt7" } } })
  const toOwner = () => calls.promptAsync.filter((a) => a.path?.id === "ses_rt7")
  const textOf = (a) => String(a.body?.parts?.[0]?.text ?? "")
  await waitFor(() => toOwner().some((a) => textOf(a).startsWith("[forge:dispatch-complete]")), "the armed wake arrives")
  const wake = toOwner().map(textOf).find((s) => s.startsWith("[forge:dispatch-complete]"))
  assert.match(wake, /finished \(task \S+, child session ses_child_2\)/, "the wake header names the NEW child session id")
  assert.ok(wake.includes("report from ses_child_2"), "the retry child's report rides the wake")
  assert.ok(wake.includes("(after 2 attempt(s))"), "the attempt count is disclosed")
  assert.ok(!wake.includes("report from ses_child_1"), "the dead child's report is not the delivered one")
  await h.event({ event: { type: "session.deleted", properties: { info: { id: "ses_rt7" } } } })
})

// ---------------------------------------------------------------------------
// fix-v2-crew-surface-drift task 3.2 (design D2): the task tool's guarded
// client-shape probe — absent creation seam degrades with the exact
// contract string (never a raw TypeError), and the child's parent directory
// resolves from the AUTHORITATIVE anchor (task 2.3).

test("task client guard: absent session.create seam -> the EXACT honest degradation contract string, never a raw TypeError", async (t) => {
  const dir = projectWithForgeJson(t, readonlyPool)
  const { client } = makeClient({ record: { directory: dir, worktree: dir } })
  delete client.session.create // the 2.3.2 live-failure shape: no creation seam on the client
  const h = await startServer(input(dir, client), {})
  t.after(() => h.dispose?.())
  await h.config(emptyCfg())
  await assert.rejects(
    () => h.tool.task.execute({ subagent_type: "forge-dp-research", prompt: "x" }, allowCtx("ses_noseam", dir)),
    (err) => {
      assert.equal(String(err?.message ?? err), TASK_SEAM_DEGRADED_ERROR, "the degradation contract string verbatim (names the native task tool)")
      assert.match(String(err?.message ?? err), /NATIVE task tool/, "the native task tool is named as the dispatch surface")
      return true
    },
  )
})

test("task client guard: child creation parent directory resolves from the AUTHORITATIVE anchor (re-anchored parents -> anchored children)", async (t) => {
  const dir = projectWithForgeJson(t, readonlyPool)
  const elsewhere = mkdtempSync(join(tmpdir(), "forge-disp-moved-"))
  t.after(() => {
    try {
      rmSync(elsewhere, { recursive: true, force: true })
    } catch {}
  })
  const { client, calls } = makeClient({ record: { directory: dir, worktree: dir } })
  const h = await startServer(input(elsewhere, client), {}) // host launched in the POOL-LESS dir
  t.after(() => h.dispose?.())
  await server(input(dir, client), {}) // shared host: the pooled workspace joins the registry (same fake client - one seam)
  await h.config(emptyCfg())
  // The tool context (worktree/directory) still reports the pool-less dir -
  // the session RECORD (authoritative) says the pooled workspace. The child
  // must anchor to the RECORD's directory, not the tool context's.
  const r = await h.tool.task.execute(
    { subagent_type: "forge-dp-research", prompt: "audit", description: "moved parent" },
    allowCtx("ses_moved", elsewhere),
  )
  assert.equal(r.metadata.agent, "forge-dp-research")
  assert.equal(calls.create[0].query.directory, dir, "query.directory comes from the authoritative session record, not the tool context")
  assert.equal(calls.create[0].body.parentID, "ses_moved", "parentID is the calling session")
})

// ---------------------------------------------------------------------------
// fix-dispatch-dispose-kill 2.4 (design D1 + D4): dispose exempts dispatch
// rows — a v2 multi-context host fires dispose on every context recycle while
// the host keeps living, so an in-flight dispatch must survive it. Process
// jobs keep the old dispose contract (killed). And D2: a kill path whose
// abort FAILS never silently drops the result — the journal terminal reason
// and the wake both disclose "abort unconfirmed".

test("dispose exemption: A's dispatch row SURVIVES dispose (intact + still polling, wake still arrives); B's process job is killed", async (t) => {
  const dir = projectWithForgeJson(t, readonlyPool)
  const { client, calls, setChildState } = makeClient({ record: { directory: dir, worktree: dir }, mode: "busy" })
  const h = await startServer(input(dir, client), {})
  await h.config(emptyCfg())
  // Session A: an in-flight async dispatch (busy child).
  const r = await h.tool.task.execute(
    { subagent_type: "forge-dp-research", prompt: "survive the recycle", run_in_background: true, description: "dispose exempt" },
    allowCtx("ses_survive", dir),
  )
  const childID = r.output.match(/child session: (ses_child_\d+)/)[1]
  const jobId = r.output.match(/task id: (\S+)/)[1]
  // Session B: a real background PROCESS job.
  const bCtx = { sessionID: "ses_proc", worktree: dir, directory: dir, ask: async () => ({ status: "allow" }), metadata: () => {} }
  const started = await h.tool.forge_shell.execute({ command: `node -e "setTimeout(()=>console.log('late'),60000)"`, run_in_background: true }, bCtx)
  const procJobId = /jobId: (j-\S+)/.exec(started.output)?.[1]
  assert.ok(procJobId, "the process job started")
  const listBefore = await h.tool.forge_jobs.execute({ action: "list" }, bCtx)
  assert.ok(listBefore.output.split("\n").some((l) => l.startsWith(procJobId)), "the process job is registered before dispose")
  // The context recycle: dispose.
  await h.dispose()
  // A's dispatch row: intact, state unchanged, still tracked.
  const rows = h.__forgeSubagentsTest.dispatchTasks().filter((x) => x.ownerSession === "ses_survive")
  assert.equal(rows.length, 1, "the dispatch row survived dispose")
  assert.equal(rows[0].childSessionID, childID, "the row still points at the live child")
  // B's process job: the plugin dispose path runs the exit matrix FIRST
  // (killOne: terminateTreeSync + killTree + markTerminal — no ledger emit),
  // so the wiring-level observable is the forge_jobs registry: the row is
  // GONE. (The "plugin dispose; tree killed" orphan ledger class is pinned
  // at the job-manager unit layer, where disposeAll is the only kill path.)
  await assert.rejects(
    () => h.tool.forge_jobs.execute({ action: "poll", jobId: procJobId }, bCtx),
    (err) => {
      assert.match(String(err?.message ?? err), new RegExp(`(No job ${procJobId} in the registry|Job ${procJobId} was already consumed)`), "the dispose-killed process job is out of the registry")
      return true
    },
  )
  // The journal has NO aborted terminal for the spared dispatch.
  const journalText = readFileSync(join(dir, ".opencode", "forge", "dispatch-log.jsonl"), "utf8")
  const spared = journalText.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l)).find((rec) => rec.id === jobId && rec.state === "terminal")
  assert.equal(spared, undefined, "no aborted journal terminal for the spared dispatch row")
  // The poller kept watching: the child completes LATE and the wake still
  // arrives with the real final report.
  setChildState(childID, "done")
  await waitFor(() => h.__forgeSubagentsTest.dispatchTasks().filter((x) => x.ownerSession === "ses_survive").length === 0, "the spared poller settles on the late completion")
  await h.event({ event: { type: "session.idle", properties: { sessionID: "ses_survive" } } })
  const toOwner = () => calls.promptAsync.filter((a) => a.path?.id === "ses_survive")
  const textOf = (a) => String(a.body?.parts?.[0]?.text ?? "")
  await waitFor(() => toOwner().some((a) => textOf(a).startsWith("[forge:dispatch-complete]")), "the completion wake arrives after the dispose")
  const wake = toOwner().map(textOf).find((s) => s.startsWith("[forge:dispatch-complete]"))
  assert.match(wake, /finished \(task /, "the spared dispatch completes NORMALLY (finished, real report)")
  assert.ok(wake.includes(`report from ${childID}`), "the real final report rides the wake")
  await h.event({ event: { type: "session.deleted", properties: { info: { id: "ses_survive" } } } })
  await h.event({ event: { type: "session.deleted", properties: { info: { id: "ses_proc" } } } })
})

test("kill-path abort-unconfirmed: a FAILED abort on the owner-death kill is disclosed in the journal terminal AND the wake (never void-dropped)", async (t) => {
  const dir = projectWithForgeJson(t, readonlyPool)
  const { client, calls } = makeClient({ record: { directory: dir, worktree: dir }, mode: "busy", abortMode: "throw" })
  const h = await startServer(input(dir, client), {})
  t.after(() => h.dispose?.())
  await h.config(emptyCfg())
  const r = await h.tool.task.execute(
    { subagent_type: "forge-dp-research", prompt: "unabortable child", run_in_background: true, description: "unconfirmed kill" },
    allowCtx("ses_unconf", dir),
  )
  const childID = r.output.match(/child session: (ses_child_\d+)/)[1]
  const jobId = r.output.match(/task id: (\S+)/)[1]
  // Ordering contract: do NOT pre-idle the owner. The kill wake pushes
  // immediately on queue only for an already-idle owner — but the abort
  // verdict lands in abortUnconfirmedNotes ASYNC (after the abortChild
  // promise rejects), and the wake text renders at DELIVERY time. Keeping
  // the owner non-idle holds the wake queued until the journal proves the
  // unconfirmed note is in, then the idle event delivers a wake that MUST
  // carry the disclosure.
  await h.event({ event: { type: "session.deleted", properties: { info: { id: "ses_unconf" } } } })
  // The journal terminal reason carries the unconfirmed disclosure.
  const journalText = () => readFileSync(join(dir, ".opencode", "forge", "dispatch-log.jsonl"), "utf8")
  let terminal = undefined
  await waitFor(() => {
    terminal = journalText().split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l)).find((rec) => rec.id === jobId && rec.state === "terminal")
    return terminal !== undefined && /abort unconfirmed/.test(terminal.reason)
  }, "the kill terminalized the journal with the unconfirmed disclosure")
  assert.equal(terminal.outcome, "aborted", "aborted outcome")
  assert.match(terminal.reason, /registry kill/, "the kill reason leads")
  assert.match(terminal.reason, /abort unconfirmed — child may still be running/, "the unconfirmed disclosure rides the journal terminal reason")
  assert.match(terminal.reason, /session\.abort threw/, "the underlying abort failure is named")
  // NOW deliver the held wake: the idle event renders it with the disclosure.
  await h.event({ event: { type: "session.idle", properties: { sessionID: "ses_unconf" } } })
  // The wake discloses the same fact — ABORTED, never a fake finished report.
  const toOwner = () => calls.promptAsync.filter((a) => a.path?.id === "ses_unconf")
  const textOf = (a) => String(a.body?.parts?.[0]?.text ?? "")
  await waitFor(() => toOwner().some((a) => textOf(a).startsWith("[forge:dispatch-complete]")), "the killed wake is delivered")
  const wake = toOwner().map(textOf).find((s) => s.startsWith("[forge:dispatch-complete]"))
  assert.match(wake, /— ABORTED \(task /, "the wake presents the kill as an abort")
  assert.match(wake, /abort unconfirmed — child may still be running \(session\.abort threw/, "the wake discloses the failed abort verbatim")
  assert.match(wake, /inspect or abort it natively in the host TUI/, "the recovery pointer rides the disclosure")
  assert.ok(!wake.includes("Final report:"), "no fake-report styling on a killed dispatch")
  assert.ok(!wake.includes("(no output)"), "no empty-tail fake report")
  void childID
})
