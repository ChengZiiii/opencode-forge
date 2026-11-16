import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// dispatch-resilience fold D wiring (tasks 4.1-4.4): the per-session FIFO
// queue behind the async cap. 4th+ wish QUEUES and spawns on slot release;
// bound refusal lists in-flight AND queued ids; spawn-time re-checks
// (roster / draft gate / crew belt) fail queued wishes as honest error
// wakes; owner death flushes without spawning; the queued-start notice
// fires; the cap number stays 3; retry keeps its slot with queued wishes
// waiting behind the retry chain.

process.env.FORGE_TEST_NO_FENCE = "1"
process.env.FORGE_GOAL_DEBOUNCE_MS = "10"
process.env.FORGE_DISPATCH_POLL_INTERVAL_MS = "10"
process.env.FORGE_DISPATCH_POLL_SLICE_MS = "20"
process.env.FORGE_TEST_FORGE_HOME = mkdtempSync(join(tmpdir(), "forge-dq-home-"))
process.env.FORGE_TEST_NO_DISPATCH_FETCH = "1"

import { server, ASYNC_DISPATCH_CAP, resolveDispatchQueueMax } from "../plugin.ts"

const worktreeRoot = mkdtempSync(join(tmpdir(), "forge-dq-"))
process.on("exit", () => {
  for (const d of [worktreeRoot, process.env.FORGE_TEST_FORGE_HOME]) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {}
  }
})

// ---------------------------------------------------------------------------
// Fake structural SDK client (dispatch-wiring style) + in-memory journal fs.

function makeClient(opts = {}) {
  const calls = { get: [], create: [], promptAsync: [], prompt: [], status: [], messages: [], abort: [] }
  let seq = 0
  const childState = new Map()
  const client = {
    session: {
      get: async (args) => {
        calls.get.push(args)
        if (typeof args.path?.id === "string" && args.path.id.startsWith("ses_child_")) {
          if (typeof opts.childGet === "function") return opts.childGet(args.path.id)
          return { time: { updated: Date.now() } }
        }
        if (typeof args.path?.id === "string" && args.path.id.startsWith("ses_owner_gone")) return { data: null }
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
        for (const [id, st] of childState) map[id] = { type: st === "busy" ? "busy" : "idle" }
        return { data: map }
      },
      messages: async (args) => {
        calls.messages.push(args)
        const id = args.path.id
        const st = childState.get(id)
        if (st === "busy") return { data: [] }
        const info = { id: "m1", role: "assistant", finish: "stop", time: { created: 1 } }
        if (st === "error") info.error = { name: "ProviderError", data: { message: opts.errorText ?? "kaput" } }
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

/** In-memory journal fs factory: one fake file per path. */
function makeJournalFs() {
  const files = new Map()
  return {
    files,
    factory: (path) => ({
      read: () => files.get(path) ?? null,
      append: (line) => files.set(path, (files.get(path) ?? "") + line + "\n"),
      rewrite: (lines) => files.set(path, lines.length === 0 ? "" : lines.map((l) => l + "\n").join("")),
    }),
  }
}

const input = (dir, client) => ({
  client: client ?? { session: {} },
  project: { id: "p" },
  directory: dir,
  worktree: dir,
  serverUrl: new URL("http://127.0.0.1:1"),
  $: () => {},
})

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
  const dir = mkdtempSync(join(tmpdir(), "forge-dq-proj-"))
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

const readonlyPool = JSON.stringify({ pool: "dq", agents: { research: { model: "zai/glm", thoughtLevel: "low", shape: "readonly" }, builder: { model: "zai/glm", thoughtLevel: "low", shape: "write" } } })

/** Latest journal record per id from the fake journal text. */
function latestRecords(text) {
  const byId = new Map()
  for (const line of (text ?? "").split("\n")) {
    if (!line.trim()) continue
    try {
      const rec = JSON.parse(line)
      byId.set(rec.id, rec)
    } catch {}
  }
  return byId
}

const textOf = (a) => String(a.body?.parts?.[0]?.text ?? "")

// ---------------------------------------------------------------------------

test("knobs: ASYNC_DISPATCH_CAP stays 3; FORGE_DISPATCH_QUEUE_MAX default 10 with invalid fallback", () => {
  assert.equal(ASYNC_DISPATCH_CAP, 3, "the cap number itself is unchanged (3 running)")
  assert.equal(resolveDispatchQueueMax({}), 10, "default queue bound 10")
  assert.equal(resolveDispatchQueueMax({ FORGE_DISPATCH_QUEUE_MAX: "2" }), 2, "valid override")
  assert.equal(resolveDispatchQueueMax({ FORGE_DISPATCH_QUEUE_MAX: "nope" }), 10, "invalid â†?default")
  assert.equal(resolveDispatchQueueMax({ FORGE_DISPATCH_QUEUE_MAX: "-3" }), 10, "non-positive â†?default")
})

test("queue: the 4th wish returns a QUEUED handle immediately (metadata queued:true, position note, no child yet)", async (t) => {
  const dir = projectWithForgeJson(t, readonlyPool)
  const journal = makeJournalFs()
  const mk = makeClient({ record: { directory: dir, worktree: dir }, mode: "busy" })
  const h = await startServer(input(dir, mk.client), {})
  t.after(() => h.dispose?.())
  h.__forgeSubagentsTest.setDispatchJournalFs(journal.factory)
  await h.config(emptyCfg())
  const ctx = allowCtx("ses_q1", dir)
  for (let i = 0; i < 3; i++) {
    await h.tool.task.execute({ subagent_type: "forge-dq-research", prompt: `p${i}`, run_in_background: true }, ctx)
  }
  const r4 = await h.tool.task.execute({ subagent_type: "forge-dq-research", prompt: "p3", run_in_background: true, description: "wish3" }, ctx)
  assert.match(r4.output, /QUEUED \(queue position 1\)/, "queue position note in the handle text")
  assert.match(r4.output, /spawns automatically when a slot frees/, "spawn-on-release semantics disclosed")
  const meta = ctx._metadataCalls.at(-1)?.metadata ?? {}
  assert.equal(meta.queued, true, "queued: true panel metadata until spawn")
  const wishId = r4.output.match(/task id: (\S+)/)[1]
  assert.equal(meta.taskId, wishId, "the queued handle carries the task id")
  assert.equal(mk.calls.create.length, 3, "no child spawned for the queued wish yet")
  // Journal: the queued transition is journaled with the prompt RETAINED
  // (the journal is the only prompt source after a restart).
  const recs = latestRecords(journal.files.get(join(dir, ".opencode", "forge", "dispatch-log.jsonl")))
  assert.equal(recs.get(wishId)?.state, "queued", "queued transition journaled")
  assert.equal(recs.get(wishId)?.prompt, "p3", "prompt retained while queued")
  await h.event({ event: { type: "session.deleted", properties: { info: { id: "ses_q1" } } } })
})

test("queue: 4th wish spawns on slot release (setChildState seam) â€?spawned-from-queue notice + journal started", async (t) => {
  const dir = projectWithForgeJson(t, readonlyPool)
  const journal = makeJournalFs()
  const mk = makeClient({ record: { directory: dir, worktree: dir }, mode: "busy" })
  const h = await startServer(input(dir, mk.client), {})
  t.after(() => h.dispose?.())
  h.__forgeSubagentsTest.setDispatchJournalFs(journal.factory)
  await h.config(emptyCfg())
  const dispatch = (i) =>
    h.tool.task.execute({ subagent_type: "forge-dq-research", prompt: `p${i}`, run_in_background: true, description: `wish${i}` }, allowCtx("ses_q2", dir))
  for (let i = 0; i < 3; i++) await dispatch(i)
  const r4 = await dispatch(3)
  const wishId = r4.output.match(/task id: (\S+)/)[1]
  assert.equal(mk.calls.create.length, 3)
  // Slot release: child 1 completes.
  mk.setChildState("ses_child_1", "done")
  await waitFor(() => mk.calls.create.length === 4, "the pump spawned the queued wish")
  const spawn = mk.calls.create[3]
  assert.equal(spawn.body.parentID, "ses_q2", "the wish spawns with the owner as parent")
  assert.match(spawn.body.title, /wish3/, "the wish's own description rides the spawn")
  assert.deepEqual(spawn.body.permission, [{ permission: "question", action: "deny", pattern: "*" }], "the async question deny is applied on the pump spawn")
  // The queued-start progress notice announces the spawn.
  await waitFor(() => h.__forgeSubagentsTest.dispatchProgress("ses_q2").some((s) => s.includes(`wish ${wishId} spawned from the queue`)), "the queued-start notice parks")
  // Journal: queued â†?started transitions for the wish id.
  const recs = latestRecords(journal.files.get(join(dir, ".opencode", "forge", "dispatch-log.jsonl")))
  assert.equal(recs.get(wishId)?.state, "started", "the wish's journal record advanced queued â†?started")
  assert.ok(recs.get(wishId)?.childSessionId, "the started record carries the child session id")
  // The wish is now a normal tracked dispatch (in the registry, counted by the cap).
  assert.equal(h.__forgeSubagentsTest.dispatchTasks().filter((x) => x.jobId === wishId).length, 1, "the spawned wish is tracked")
  await h.event({ event: { type: "session.deleted", properties: { info: { id: "ses_q2" } } } })
})

test("queue: spawn-time roster vanish â†?honest error wake, the wish never spawns", async (t) => {
  const dir = projectWithForgeJson(t, readonlyPool)
  const journal = makeJournalFs()
  const mk = makeClient({ record: { directory: dir, worktree: dir }, mode: "busy" })
  const h = await startServer(input(dir, mk.client), {})
  t.after(() => h.dispose?.())
  h.__forgeSubagentsTest.setDispatchJournalFs(journal.factory)
  await h.config(emptyCfg())
  const dispatch = (i) =>
    h.tool.task.execute({ subagent_type: "forge-dq-research", prompt: `p${i}`, run_in_background: true, description: `wish${i}` }, allowCtx("ses_q3", dir))
  for (let i = 0; i < 3; i++) await dispatch(i)
  const r4 = await dispatch(3)
  const wishId = r4.output.match(/task id: (\S+)/)[1]
  // The roster vanishes while the wish is queued (delete the pool file).
  writeFileSync(join(dir, ".opencode", "forge.json"), JSON.stringify({ pool: "dq", agents: {} }))
  mk.setChildState("ses_child_1", "done") // slot release â†?pump â†?re-check fails
  await waitFor(() => h.__forgeSubagentsTest.dispatchQueues().filter((x) => x.ownerSession === "ses_q3").length === 0, "the wish left the queue")
  assert.equal(mk.calls.create.length, 3, "the vanished-roster wish NEVER spawns")
  // Honest error wake on idle.
  await h.event({ event: { type: "session.idle", properties: { sessionID: "ses_q3" } } })
  const wakes = () => mk.calls.promptAsync.filter((a) => a.path?.id === "ses_q3").map(textOf).filter((s) => s.startsWith("[forge:dispatch-complete]"))
  await waitFor(() => wakes().some((s) => s.includes(wishId)), "the error wake names the wish task id")
  const wake = wakes().find((s) => s.includes(wishId))
  assert.match(wake, /no longer a materialized forge subagent/, "the honest roster-vanish reason")
  assert.match(wake, /never spawned/, "the wish never spawned disclosure")
  // Journal terminalized with the error outcome.
  const recs = latestRecords(journal.files.get(join(dir, ".opencode", "forge", "dispatch-log.jsonl")))
  assert.equal(recs.get(wishId)?.state, "terminal")
  assert.equal(recs.get(wishId)?.outcome, "error")
  await h.event({ event: { type: "session.deleted", properties: { info: { id: "ses_q3" } } } })
})

test("queue: draft tightened while queued â†?spawn-time refusal with the draft gate copy (honest wake)", async (t) => {
  const dir = projectWithForgeJson(t, readonlyPool)
  const journal = makeJournalFs()
  const mk = makeClient({ record: { directory: dir, worktree: dir }, mode: "busy" })
  const h = await startServer(input(dir, mk.client), {})
  t.after(() => h.dispose?.())
  h.__forgeSubagentsTest.setDispatchJournalFs(journal.factory)
  await h.config(emptyCfg())
  // Queue a WRITE-target wish (no draft at call time â€?passes).
  for (let i = 0; i < 3; i++) {
    await h.tool.task.execute({ subagent_type: "forge-dq-research", prompt: `p${i}`, run_in_background: true }, allowCtx("ses_q4", dir))
  }
  const r4 = await h.tool.task.execute({ subagent_type: "forge-dq-builder", prompt: "build it", run_in_background: true, description: "late build" }, allowCtx("ses_q4", dir))
  const wishId = r4.output.match(/task id: (\S+)/)[1]
  // A draft lands while the wish is queued â†?the write target tightens.
  await h.tool.plan_write.execute(
    { goal: "drafting late", context: "c", approach: "a", tasks: ["t1"], risks: "r", acceptance: ["a1"] },
    allowCtx("ses_q4", dir),
  )
  mk.setChildState("ses_child_1", "done") // slot release â†?pump â†?draft re-check refuses
  await waitFor(() => h.__forgeSubagentsTest.dispatchQueues().filter((x) => x.ownerSession === "ses_q4").length === 0, "the wish left the queue")
  assert.equal(mk.calls.create.length, 3, "the tightened wish NEVER spawns")
  await h.event({ event: { type: "session.idle", properties: { sessionID: "ses_q4" } } })
  const wakes = () => mk.calls.promptAsync.filter((a) => a.path?.id === "ses_q4").map(textOf).filter((s) => s.startsWith("[forge:dispatch-complete]"))
  await waitFor(() => wakes().some((s) => s.includes(wishId) && s.includes("plan is in draft")), "the honest draft-tighten wake")
  await h.event({ event: { type: "session.deleted", properties: { info: { id: "ses_q4" } } } })
})

test("queue: crew pending belt registered while queued â†?spawn-time refusal with the PENDING copy (honest wake)", async (t) => {
  const dir = projectWithForgeJson(t, readonlyPool)
  const journal = makeJournalFs()
  const mk = makeClient({ record: { directory: dir, worktree: dir }, mode: "busy" })
  const h = await startServer(input(dir, mk.client), {})
  t.after(() => h.dispose?.())
  h.__forgeSubagentsTest.setDispatchJournalFs(journal.factory)
  await h.config(emptyCfg())
  for (let i = 0; i < 3; i++) {
    await h.tool.task.execute({ subagent_type: "forge-dq-research", prompt: `p${i}`, run_in_background: true }, allowCtx("ses_q5", dir))
  }
  const r4 = await h.tool.task.execute({ subagent_type: "forge-dq-research", prompt: "queued then crewed", run_in_background: true }, allowCtx("ses_q5", dir))
  const wishId = r4.output.match(/task id: (\S+)/)[1]
  // A pending crew registers while the wish is queued â€?the belt tightens.
  await h.tool.crew_begin.execute({ objective: "o", subtasks: [{ title: "x" }] }, allowCtx("ses_q5", dir))
  mk.setChildState("ses_child_1", "done") // slot release â†?pump â†?crew belt refuses
  await waitFor(() => h.__forgeSubagentsTest.dispatchQueues().filter((x) => x.ownerSession === "ses_q5").length === 0, "the wish left the queue")
  assert.equal(mk.calls.create.length, 3, "the belted wish NEVER spawns")
  await h.event({ event: { type: "session.idle", properties: { sessionID: "ses_q5" } } })
  const wakes = () => mk.calls.promptAsync.filter((a) => a.path?.id === "ses_q5").map(textOf).filter((s) => s.startsWith("[forge:dispatch-complete]"))
  await waitFor(() => wakes().some((s) => s.includes(wishId) && s.includes("PENDING")), "the honest crew-belt wake")
  await h.event({ event: { type: "session.deleted", properties: { info: { id: "ses_q5" } } } })
})

test("queue: owner death flushes queued wishes WITHOUT spawning and terminalizes their journal records", async (t) => {
  const dir = projectWithForgeJson(t, readonlyPool)
  const journal = makeJournalFs()
  const mk = makeClient({ record: { directory: dir, worktree: dir }, mode: "busy" })
  const h = await startServer(input(dir, mk.client), {})
  t.after(() => h.dispose?.())
  h.__forgeSubagentsTest.setDispatchJournalFs(journal.factory)
  await h.config(emptyCfg())
  for (let i = 0; i < 3; i++) {
    await h.tool.task.execute({ subagent_type: "forge-dq-research", prompt: `p${i}`, run_in_background: true }, allowCtx("ses_q6", dir))
  }
  const r4 = await h.tool.task.execute({ subagent_type: "forge-dq-research", prompt: "flush me", run_in_background: true }, allowCtx("ses_q6", dir))
  const wishId = r4.output.match(/task id: (\S+)/)[1]
  await h.event({ event: { type: "session.deleted", properties: { info: { id: "ses_q6" } } } })
  await waitFor(() => h.__forgeSubagentsTest.dispatchQueues().filter((x) => x.ownerSession === "ses_q6").length === 0, "the queue drained")
  assert.equal(mk.calls.create.length, 3, "the flushed wish NEVER spawns")
  const recs = latestRecords(journal.files.get(join(dir, ".opencode", "forge", "dispatch-log.jsonl")))
  const rec = recs.get(wishId)
  assert.equal(rec?.state, "terminal", "the queued wish's journal record terminalized")
  assert.equal(rec?.outcome, "aborted", "terminal outcome aborted (owner death flush)")
  assert.match(rec?.reason ?? "", /ended before the queued wish spawned/, "the honest flush reason")
  assert.equal(rec.prompt, undefined, "prompt redacted on the terminal record")
})

test("queueÃ—retry: the retry keeps its slot â€?queued wishes stay behind until the retry chain settles", async (t) => {
  process.env.FORGE_DISPATCH_RETRY_BACKOFF_MS = "30"
  t.after(() => {
    delete process.env.FORGE_DISPATCH_RETRY_BACKOFF_MS
  })
  const dir = projectWithForgeJson(t, readonlyPool)
  const journal = makeJournalFs()
  // seq1 (wish A's child) dies transiently twice; the others stay busy.
  const mk = makeClient({ record: { directory: dir, worktree: dir }, mode: "busy", errorText: "fetch failed: ECONNRESET mid-stream" })
  const h = await startServer(input(dir, mk.client), {})
  t.after(() => h.dispose?.())
  h.__forgeSubagentsTest.setDispatchJournalFs(journal.factory)
  await h.config(emptyCfg())
  for (let i = 0; i < 3; i++) {
    await h.tool.task.execute({ subagent_type: "forge-dq-research", prompt: `p${i}`, run_in_background: true, description: `run${i}` }, allowCtx("ses_q7", dir))
  }
  const r4 = await h.tool.task.execute({ subagent_type: "forge-dq-research", prompt: "behind the retry", run_in_background: true, description: "wishD" }, allowCtx("ses_q7", dir))
  const wishId = r4.output.match(/task id: (\S+)/)[1]
  assert.equal(mk.calls.create.length, 3)
  // Wish A's child dies in a TRANSIENT error â†?the retry chain holds the
  // slot (the registry row stays running); the queued wish must NOT jump.
  mk.setChildState("ses_child_1", "error")
  await waitFor(() => mk.calls.create.length === 4, "the retry respawned (create #4)")
  assert.equal(h.__forgeSubagentsTest.dispatchQueues().filter((x) => x.ownerSession === "ses_q7").length, 1, "the queued wish stays behind the retry")
  assert.ok(!mk.calls.create.some((c) => String(c.body.title).includes("wishD")), "the queued wish has not spawned while the retry holds the slot")
  // The retry child dies transiently again â€?attempt cap (2) reached â†?the
  // chain settles â†?the slot truly releases â†?the wish spawns NOW.
  mk.setChildState("ses_child_4", "error")
  await waitFor(() => mk.calls.create.some((c) => String(c.body.title).includes("wishD")), "the wish spawns after the retry chain settles")
  const wishSpawnIdx = mk.calls.create.findIndex((c) => String(c.body.title).includes("wishD"))
  assert.ok(wishSpawnIdx > 3, "the wish spawned after the retry respawn (never jumped it)")
  assert.equal(h.__forgeSubagentsTest.dispatchQueues().filter((x) => x.ownerSession === "ses_q7").length, 0, "the queue drained")
  await h.event({ event: { type: "session.deleted", properties: { info: { id: "ses_q7" } } } })
})
