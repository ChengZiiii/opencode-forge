import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Dispatch journal + restart recovery (dispatch-resilience fold E; spec
// "Dispatch resilience" scenarios: per-state transitions journaled, rotation
// keeps non-terminal records, corrupt lines tolerated, per-state init
// recovery (running alive/re-done/gone, queued both ways, retry-pending both
// ways), lazy per-workspace recovery scope). The journal core is pure
// (injectable fs); the wiring tests seed the REAL journal file on disk
// before server() boots — init recovery reads it through the production fs.

process.env.FORGE_TEST_NO_FENCE = "1"
process.env.FORGE_GOAL_DEBOUNCE_MS = "10"
process.env.FORGE_DISPATCH_POLL_INTERVAL_MS = "10"
process.env.FORGE_DISPATCH_POLL_SLICE_MS = "20"
process.env.FORGE_DISPATCH_RETRY_BACKOFF_MS = "20"
process.env.FORGE_TEST_FORGE_HOME = mkdtempSync(join(tmpdir(), "forge-journal-home-"))
process.env.FORGE_TEST_NO_DISPATCH_FETCH = "1"

import { server } from "../plugin.ts"
import { createDispatchJournal, parseJournalLines, compactJournalRecords, resolveJournalMax, DEFAULT_JOURNAL_MAX } from "../src/dispatch-journal.ts"

const worktreeRoot = mkdtempSync(join(tmpdir(), "forge-journal-"))
process.on("exit", () => {
  for (const d of [worktreeRoot, process.env.FORGE_TEST_FORGE_HOME]) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {}
  }
})

// ---------------------------------------------------------------------------
// Pure core: parse / dedupe / corrupt-line tolerance / rotation / knob

const rec = (over = {}) => ({
  id: "task_j1",
  agent: "forge-dp-research",
  ownerSession: "ses_owner1",
  workspace: "/w",
  state: "started",
  attempts: 1,
  createdAt: 1,
  updatedAt: 1,
  ...over,
})

test("journal parse: corrupt lines skipped, latest-per-id wins, invalid states dropped", () => {
  const text = [
    "not json at all {{{",
    JSON.stringify(rec({ id: "a", state: "dispatched", updatedAt: 1 })),
    JSON.stringify(rec({ id: "b", state: "weird-state" })), // invalid state → dropped
    JSON.stringify(rec({ id: "a", state: "started", childSessionId: "ses_x", updatedAt: 2 })), // latest wins
    "", // blank → skipped
  ].join("\n")
  const records = parseJournalLines(text)
  assert.equal(records.length, 1, "only the valid id survives")
  assert.equal(records[0].id, "a")
  assert.equal(records[0].state, "started", "latest-state-wins per id")
  assert.equal(records[0].childSessionId, "ses_x")
  assert.equal(parseJournalLines(null).length, 0, "null file → empty")
  assert.equal(parseJournalLines("").length, 0, "empty file → empty")
})

test("journal rotation: terminal records drop oldest-first; non-terminal records NEVER drop (overflow beats the bound)", () => {
  const records = [
    rec({ id: "t1", state: "terminal", updatedAt: 100 }),
    rec({ id: "t2", state: "terminal", updatedAt: 300 }),
    rec({ id: "live1", state: "started", updatedAt: 200 }),
    rec({ id: "live2", state: "queued", updatedAt: 400 }),
    rec({ id: "t3", state: "terminal", updatedAt: 500 }),
  ]
  const kept = compactJournalRecords(records, 3)
  assert.deepEqual(kept.map((r) => r.id).sort(), ["live1", "live2", "t3"], "oldest terminals dropped first, live state kept")
  // All-live overflow: compaction cannot reach the bound — nothing drops.
  const liveOnly = [rec({ id: "l1", state: "started" }), rec({ id: "l2", state: "queued" }), rec({ id: "l3", state: "retry-pending" })]
  assert.equal(compactJournalRecords(liveOnly, 1).length, 3, "non-terminal records are never removed (overflow)")
})

test("journal knob: FORGE_DISPATCH_JOURNAL_MAX (default 200; invalid → default)", () => {
  assert.equal(DEFAULT_JOURNAL_MAX, 200)
  assert.equal(resolveJournalMax({}), 200)
  assert.equal(resolveJournalMax({ FORGE_DISPATCH_JOURNAL_MAX: "" }), 200)
  assert.equal(resolveJournalMax({ FORGE_DISPATCH_JOURNAL_MAX: "nope" }), 200)
  assert.equal(resolveJournalMax({ FORGE_DISPATCH_JOURNAL_MAX: "0" }), 200)
  assert.equal(resolveJournalMax({ FORGE_DISPATCH_JOURNAL_MAX: "50" }), 50)
})

test("journal append: rotation fires through the injectable fs and keeps live state", () => {
  const lines = []
  const fs = {
    read: () => (lines.length === 0 ? null : lines.join("\n")),
    append: (line) => lines.push(line),
    rewrite: (kept) => {
      lines.length = 0
      lines.push(...kept)
    },
  }
  const j = createDispatchJournal("/w/.opencode/forge/dispatch-log.jsonl", { fs, maxRecords: 2 })
  j.append(rec({ id: "t1", state: "terminal", updatedAt: 100 }))
  j.append(rec({ id: "t2", state: "terminal", updatedAt: 300 }))
  j.append(rec({ id: "live", state: "started", updatedAt: 200 }))
  j.append(rec({ id: "t3", state: "terminal", updatedAt: 500 }))
  const ids = j.load().map((r) => r.id)
  assert.ok(!ids.includes("t1"), "the oldest terminal rotated out")
  assert.ok(ids.includes("live"), "the live record survives rotation")
  assert.equal(j.nonTerminal().length, 1, "nonTerminal view is live-only")
})

// ---------------------------------------------------------------------------
// Wiring: recovery through real server() boots. The journal is seeded on the
// REAL disk before boot; recovery runs through the production fs at init.

const readonlyPool = JSON.stringify({ pool: "dp", agents: { research: { model: "zai/glm", thoughtLevel: "low", shape: "readonly" }, builder: { model: "zai/glm", thoughtLevel: "low", shape: "write" } } })

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
  abort: undefined,
})

const emptyCfg = () => ({ agent: {}, command: {}, permission: {} })

function projectWithForgeJson(t, json) {
  const dir = mkdtempSync(join(tmpdir(), "forge-journal-proj-"))
  t.after(() => {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {}
  })
  mkdirSync(join(dir, ".opencode"), { recursive: true })
  writeFileSync(join(dir, ".opencode", "forge.json"), json)
  return dir
}

let lastHost = null
async function startServer(inputArg, opts) {
  if (lastHost) {
    lastHost.__forgeSubagentsTest.resetAnchors()
    // Simulate a fresh host process: the recovered-workspace Set and the
    // per-workspace journal instances are module state — clear them so each
    // boot recovers exactly its own anchor.
    lastHost.__forgeSubagentsTest.setDispatchJournalFs(null)
  }
  lastHost = await server(inputArg, opts)
  return lastHost
}

async function waitFor(predicate, label, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (predicate()) return
    if (Date.now() > deadline) throw new Error(`waitFor timeout: ${label}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

const journalPath = (dir) => join(dir, ".opencode", "forge", "dispatch-log.jsonl")

/** Seed the real journal file before boot. */
const seedJournal = (dir, records) => {
  mkdirSync(join(dir, ".opencode", "forge"), { recursive: true })
  writeFileSync(journalPath(dir), records.map((r) => JSON.stringify(r) + "\n").join(""))
}

/** Read the journal from the real disk and pick the latest record for an id. */
const latestRecord = (dir, id) => {
  let text = null
  try {
    text = readFileSync(journalPath(dir), "utf8")
  } catch {}
  return parseJournalLines(text).find((r) => r.id === id) ?? null
}

/** Recovery client: scriptable per-child state (pre-seeded ids included). */
function makeRecoveryClient(opts = {}) {
  const calls = { get: [], create: [], promptAsync: [], prompt: [], status: [], messages: [], abort: [] }
  const children = new Map()
  for (const [id, c] of Object.entries(opts.children ?? {})) children.set(id, { state: c.state ?? "busy", report: c.report ?? "recovered report" })
  let ownerGone = opts.ownerGone ?? false
  const ownerId = opts.ownerId ?? "ses_owner1"
  const client = {
    session: {
      get: async (a) => {
        calls.get.push(a)
        const id = a.path?.id
        if (id === ownerId) return ownerGone ? { data: null } : { directory: opts.dir, worktree: opts.dir }
        const c = children.get(id)
        if (!c || c.state === "gone") return { data: null }
        return { time: { updated: Date.now() } }
      },
      create: async (a) => {
        calls.create.push(a)
        const id = `ses_child_${calls.create.length}`
        children.set(id, { state: "busy", report: "respawned report" })
        return { data: { id } }
      },
      promptAsync: async (a) => {
        calls.promptAsync.push(a)
        return {}
      },
      prompt: async (a) => {
        calls.prompt.push(a)
        return {}
      },
      status: async () => {
        calls.status.push({})
        const map = {}
        for (const [id, c] of children) if (c.state !== "gone") map[id] = { type: c.state === "busy" ? "busy" : "idle" }
        return { data: map }
      },
      messages: async (a) => {
        calls.messages.push(a)
        const c = children.get(a.path?.id)
        if (!c || c.state === "gone" || c.state === "busy") return { data: [] }
        return { data: [{ info: { id: "m1", role: "assistant", finish: "stop", time: { created: 1 } }, parts: [{ type: "text", text: c.report }] }] }
      },
      abort: async (a) => {
        calls.abort.push(a)
        const c = children.get(a.path?.id)
        if (c) c.state = "done"
        return true
      },
    },
  }
  return { client, calls, children, setOwnerGone: (v) => (ownerGone = v) }
}

const textOf = (a) => String(a.body?.parts?.[0]?.text ?? "")

test("recovery: a RUNNING child re-arms on boot — the armed poller wakes when the child later finishes", async (t) => {
  const dir = projectWithForgeJson(t, readonlyPool)
  seedJournal(dir, [rec({ id: "task_r1", state: "started", childSessionId: "ses_rec_a", ownerSession: "ses_owner1", workspace: dir, prompt: "resume me", description: "recovery re-arm" })])
  const { client, calls, children } = makeRecoveryClient({ dir, ownerId: "ses_owner1", children: { ses_rec_a: { state: "busy" } } })
  const h = await startServer(input(dir, client), {})
  t.after(() => h.dispose?.())
  await h.config(emptyCfg())
  // The launch anchor recovered at init.
  assert.ok(h.__forgeSubagentsTest.dispatchRecoveredWorkspaces().includes(dir), "the anchor workspace is marked recovered")
  // The running record re-armed the tracker against the EXISTING child.
  await waitFor(() => h.__forgeSubagentsTest.dispatchTasks().some((x) => x.jobId === "task_r1"), "the started record re-armed")
  assert.equal(calls.create.length, 0, "no respawn — the child is alive; the EXISTING one is tracked")
  // The child finishes later: exactly one wake carries its final report.
  children.get("ses_rec_a").state = "done"
  await waitFor(() => h.__forgeSubagentsTest.dispatchTasks().filter((x) => x.jobId === "task_r1").length === 0, "the re-armed tracker settled on the late completion")
  await h.event({ event: { type: "session.idle", properties: { sessionID: "ses_owner1" } } })
  const toOwner = () => calls.promptAsync.filter((a) => a.path?.id === "ses_owner1")
  await waitFor(() => toOwner().some((a) => textOf(a).startsWith("[forge:dispatch-complete]")), "one wake delivered on idle")
  const wakes = toOwner().map(textOf).filter((s) => s.startsWith("[forge:dispatch-complete]"))
  assert.equal(wakes.length, 1, "exactly ONE wake for the re-armed record")
  assert.ok(wakes[0].includes("recovered report"), "the child's final report rides the wake")
  await h.event({ event: { type: "session.deleted", properties: { info: { id: "ses_owner1" } } } })
})

test("recovery: a child that finished WHILE THE HOST WAS DOWN delivers exactly one wake without re-dispatch", async (t) => {
  const dir = projectWithForgeJson(t, readonlyPool)
  seedJournal(dir, [rec({ id: "task_r2", state: "started", childSessionId: "ses_rec_b", ownerSession: "ses_owner2", workspace: dir, prompt: "done while down", description: "recovery done" })])
  const { client, calls } = makeRecoveryClient({ dir, ownerId: "ses_owner2", children: { ses_rec_b: { state: "done", report: "report from ses_rec_b" } } })
  const h = await startServer(input(dir, client), {})
  t.after(() => h.dispose?.())
  await h.config(emptyCfg())
  await waitFor(() => latestRecord(dir, "task_r2")?.state === "terminal", "the finished-while-down record finalized")
  const terminal = latestRecord(dir, "task_r2")
  assert.equal(terminal.outcome, "completed", "completed outcome")
  assert.ok(terminal.reason.includes("recovered after host restart"), "the reason names the restart recovery")
  assert.equal(calls.create.length, 0, "no respawn — the report was fetched, not re-run")
  await h.event({ event: { type: "session.idle", properties: { sessionID: "ses_owner2" } } })
  const toOwner = () => calls.promptAsync.filter((a) => a.path?.id === "ses_owner2")
  await waitFor(() => toOwner().some((a) => textOf(a).startsWith("[forge:dispatch-complete]")), "one wake delivered on idle")
  const wakes = toOwner().map(textOf).filter((s) => s.startsWith("[forge:dispatch-complete]"))
  assert.equal(wakes.length, 1, "exactly ONE recovered wake")
  assert.ok(wakes[0].includes("report from ses_rec_b"), "the fetched final report rides the wake")
  await h.event({ event: { type: "session.deleted", properties: { info: { id: "ses_owner2" } } } })
})

test("recovery: a GONE child terminalizes honestly — no wake fabrication, no respawn", async (t) => {
  const dir = projectWithForgeJson(t, readonlyPool)
  seedJournal(dir, [rec({ id: "task_r3", state: "started", childSessionId: "ses_rec_gone", ownerSession: "ses_owner3", workspace: dir, prompt: "gone case" })])
  const { client, calls } = makeRecoveryClient({ dir, ownerId: "ses_owner3", children: { ses_rec_gone: { state: "gone" } } })
  const h = await startServer(input(dir, client), {})
  t.after(() => h.dispose?.())
  await h.config(emptyCfg())
  await waitFor(() => latestRecord(dir, "task_r3")?.state === "terminal", "the gone record finalized")
  const terminal = latestRecord(dir, "task_r3")
  assert.equal(terminal.outcome, "error", "honest error outcome")
  assert.match(terminal.reason, /no longer exists at recovery/, "the honest gone finding")
  assert.equal(calls.create.length, 0, "no respawn for a gone child")
  assert.equal(h.__forgeSubagentsTest.dispatchTasks().filter((x) => x.jobId === "task_r3").length, 0, "nothing re-armed")
  await h.event({ event: { type: "session.deleted", properties: { info: { id: "ses_owner3" } } } })
})

test("recovery: a QUEUED wish re-enters the queue for a live owner and SPAWNS; a dead owner's wish terminalizes without spawning", async (t) => {
  const dir = projectWithForgeJson(t, readonlyPool)
  seedJournal(dir, [
    rec({ id: "task_q_live", state: "queued", ownerSession: "ses_owner4", workspace: dir, prompt: "queued work", description: "queued recovery" }),
    rec({ id: "task_q_dead", state: "queued", ownerSession: "ses_owner_dead", workspace: dir, prompt: "dead owner work" }),
  ])
  const { client, calls } = makeRecoveryClient({ dir, ownerId: "ses_owner4", children: {} })
  const h = await startServer(input(dir, client), {})
  t.after(() => h.dispose?.())
  await h.config(emptyCfg())
  // Live owner: the wish re-entered the queue and the pump spawned it (cap free).
  await waitFor(() => calls.create.length === 1, "the queued wish spawned at recovery")
  assert.equal(calls.create[0].body.parentID, "ses_owner4", "the recovered wish spawns for its owner")
  // sendPrompt lands right after createChildSession — wait for it, then assert.
  await waitFor(() => calls.promptAsync.length >= 1, "the spawn prompt sent")
  const spawnPrompt = calls.promptAsync.map((a) => a.body?.parts?.[0]?.text ?? "").find((s) => s.includes("queued work"))
  assert.ok(spawnPrompt, "the journal prompt (its only source) rode the spawn")
  assert.equal(latestRecord(dir, "task_q_live").state, "started", "started transition on spawn")
  // Dead owner: terminalized without spawning.
  await waitFor(() => latestRecord(dir, "task_q_dead")?.state === "terminal", "the dead owner's wish finalized")
  const dead = latestRecord(dir, "task_q_dead")
  assert.equal(dead.outcome, "aborted", "aborted outcome")
  assert.match(dead.reason, /no longer resolves at recovery/, "the honest dead-owner finding")
  assert.equal(calls.create.length, 1, "the dead owner's wish never spawned")
  await h.event({ event: { type: "session.deleted", properties: { info: { id: "ses_owner4" } } } })
})

test("recovery: RETRY-PENDING resumes the chain when attempts remain; terminalizes when exhausted", async (t) => {
  const dir = projectWithForgeJson(t, readonlyPool)
  seedJournal(dir, [
    rec({ id: "task_rp1", state: "retry-pending", attempts: 1, ownerSession: "ses_owner5", workspace: dir, prompt: "resume the flaky work", description: "retry recovery" }),
    rec({ id: "task_rp2", state: "retry-pending", attempts: 3, ownerSession: "ses_owner5", workspace: dir, prompt: "exhausted work" }),
  ])
  const { client, calls } = makeRecoveryClient({ dir, ownerId: "ses_owner5", children: {} })
  const h = await startServer(input(dir, client), {})
  t.after(() => h.dispose?.())
  await h.config(emptyCfg())
  // Attempts remain (1 < default max 2): the respawn happens with the
  // journal prompt plus the inspect-then-continue preamble.
  await waitFor(() => calls.create.length >= 1, "the retry respawned")
  const retryPrompt = calls.promptAsync.map((a) => a.body?.parts?.[0]?.text ?? "").find((s) => s.includes("resume the flaky work"))
  assert.ok(retryPrompt, "the journal prompt rode the respawn")
  assert.ok(retryPrompt.startsWith("Note: a previous attempt"), "the resume preamble is prepended")
  assert.equal(latestRecord(dir, "task_rp1").state, "started", "the respawn journaled started")
  // Exhausted (3 > default max 2 — a retry-pending record's `attempts` is
  // the attempt SCHEDULED but never confirmed started, so only a count
  // PAST the cap is truly exhausted): honest terminal, no respawn for it.
  await waitFor(() => latestRecord(dir, "task_rp2")?.state === "terminal", "the exhausted record finalized")
  const exhausted = latestRecord(dir, "task_rp2")
  assert.equal(exhausted.outcome, "error", "error outcome")
  assert.match(exhausted.reason, /attempts exhausted at recovery/, "the honest exhausted finding")
  assert.equal(calls.create.length, 1, "exactly one respawn (the exhausted wish never spawned)")
  await h.event({ event: { type: "session.deleted", properties: { info: { id: "ses_owner5" } } } })
})

test("recovery: live dispatch transitions journal; the terminal record REDACTS the prompt", async (t) => {
  const dir = projectWithForgeJson(t, readonlyPool)
  const { client, calls } = makeRecoveryClient({ dir, ownerId: "ses_live1", children: {} })
  const h = await startServer(input(dir, client), {})
  t.after(() => h.dispose?.())
  await h.config(emptyCfg())
  await h.tool.task.execute(
    { subagent_type: "forge-dp-research", prompt: "journal me", run_in_background: true, description: "journal flow" },
    allowCtx("ses_live1", dir),
  )
  // dispatched → started transitions landed (latest per id = started).
  const records = parseJournalLines(readFileSync(journalPath(dir), "utf8"))
  const started = records.find((r) => r.description === "journal flow")
  assert.ok(started, "the dispatch journaled")
  assert.equal(started.state, "started", "the started transition is the latest for the id")
  assert.ok(typeof started.childSessionId === "string" && started.childSessionId.startsWith("ses_child_"), "the child session id rides the started record")
  assert.equal(started.prompt, "journal me", "the prompt is RETAINED while non-terminal (recovery's only source)")
  // Owner death harvest → the record terminalizes with the prompt redacted
  // (the poller observes the registry kill at its next slice boundary).
  await h.event({ event: { type: "session.deleted", properties: { info: { id: "ses_live1" } } } })
  await waitFor(() => latestRecord(dir, started.id)?.state === "terminal", "the harvest terminalized the journal record")
  const terminal = latestRecord(dir, started.id)
  assert.ok(terminal, "a terminal record exists")
  assert.equal(terminal.state, "terminal", "terminal after harvest")
  assert.equal(terminal.prompt, undefined, "the prompt is REDACTED on the terminal record")
  void calls
})

test("recovery scope: the launch anchor recovers at init; ANOTHER workspace recovers lazily on its first session", async (t) => {
  const dir = projectWithForgeJson(t, readonlyPool)
  const { client } = makeRecoveryClient({ dir, ownerId: "ses_scope", children: {} })
  const h = await startServer(input(dir, client), {})
  t.after(() => h.dispose?.())
  await h.config(emptyCfg())
  // (recoveredDispatchWorkspaces is module state across tests — assert
  // membership, not the whole array.)
  assert.ok(h.__forgeSubagentsTest.dispatchRecoveredWorkspaces().includes(dir), "the anchor workspace recovered at init")
  const dir2 = mkdtempSync(join(tmpdir(), "forge-journal-ws2-"))
  t.after(() => {
    try {
      rmSync(dir2, { recursive: true, force: true })
    } catch {}
  })
  assert.ok(!h.__forgeSubagentsTest.dispatchRecoveredWorkspaces().includes(dir2), "the second workspace has NOT recovered yet (lazy scope)")
  // A session in ANOTHER workspace: its first session triggers its recovery
  // (the Set marks it even with an empty journal — recovery ran).
  await h.event({ event: { type: "session.created", properties: { info: { id: "ses_ws2", directory: dir2, worktree: dir2 } } } })
  await waitFor(() => h.__forgeSubagentsTest.dispatchRecoveredWorkspaces().includes(dir2), "the second workspace recovered lazily on its first session")
  assert.ok(h.__forgeSubagentsTest.dispatchRecoveredWorkspaces().includes(dir), "the anchor stays recovered")
  await h.event({ event: { type: "session.deleted", properties: { info: { id: "ses_ws2" } } } })
})
