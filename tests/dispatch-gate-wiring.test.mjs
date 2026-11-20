import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// harden-dispatch-resilience wiring (blocks A + C, tasks 5.1/5.2):
//  A — the stuck-active+text child completes via the message-stream override
//      with the disclosure riding the terminal wake (sync output + async
//      journal); a stuck-active child with NO text stays honest; a healthy
//      child is unaffected.
//  C — the terminal-recording seam feeds the counters (a finished child
//      frees the provider slot); the dispatch call refuses before child
//      creation with the verbatim gate string; queued wishes RE-CHECK at
//      dequeue; the breaker opens on consecutive failed terminals and its
//      refusal never spawns (never provider-retry-classified); a malformed
//      dispatch node refuses nothing (fail-soft).

process.env.FORGE_TEST_NO_FENCE = "1"
process.env.FORGE_GOAL_DEBOUNCE_MS = "10"
process.env.FORGE_DISPATCH_POLL_INTERVAL_MS = "10"
process.env.FORGE_DISPATCH_POLL_SLICE_MS = "20"
process.env.FORGE_TEST_FORGE_HOME = mkdtempSync(join(tmpdir(), "forge-dgw-home-"))
process.env.FORGE_TEST_NO_DISPATCH_FETCH = "1"
process.env.FORGE_DISPATCH_MAX_ATTEMPTS = "1"

import { server } from "../plugin.ts"
import { ACTIVE_TEXTFUL_OVERRIDE_NOTE } from "../src/dispatch-async.ts"
import { concurrencyRefusal } from "../src/dispatch-gate.ts"

const worktreeRoot = mkdtempSync(join(tmpdir(), "forge-dgw-"))
process.on("exit", () => {
  for (const d of [worktreeRoot, process.env.FORGE_TEST_FORGE_HOME]) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {}
  }
})

// ---------------------------------------------------------------------------
// Fake structural SDK client (dispatch-queue style) with the extra
// stuck-active modes block A needs.
// ---------------------------------------------------------------------------

function makeClient(opts = {}) {
  const calls = { get: [], create: [], promptAsync: [], status: [], messages: [], abort: [] }
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
        for (const [id, st] of childState) map[id] = { type: st === "done" || st === "error" ? "idle" : "busy" }
        return { data: map }
      },
      messages: async (args) => {
        calls.messages.push(args)
        const id = args.path.id
        const st = childState.get(id)
        if (st === "busy") return { data: [] }
        if (st === "silent") return { data: [] }
        if (st === "stuck") {
          // Block A's stuck-active shape: status says busy FOREVER, but the
          // final assistant text is out and finished.
          const info = { id: "m1", role: "assistant", finish: "stop", time: { created: 1 } }
          return { data: [{ info, parts: [{ type: "text", text: `report from ${id}` }] }] }
        }
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

const allowCtx = (sessionID, dir) => {
  const metadataCalls = []
  return {
    sessionID,
    worktree: dir,
    directory: dir,
    ask: async () => ({ status: "allow" }),
    metadata: (m) => metadataCalls.push(m),
    message: async () => {},
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
  const dir = mkdtempSync(join(tmpdir(), "forge-dgw-proj-"))
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

const poolJson = (dispatch) =>
  JSON.stringify({
    pool: "dgw",
    agents: { research: { model: "zai/glm", thoughtLevel: "low", shape: "readonly" } },
    ...(dispatch ? { dispatch } : {}),
  })

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

// ---------------------------------------------------------------------------
// Block A wiring
// ---------------------------------------------------------------------------

test("A (wiring, sync): stuck-active child with the final text out → completes with the override disclosure in the tool output", async (t) => {
  const dir = projectWithForgeJson(t, poolJson(null))
  const mk = makeClient({ record: { directory: dir, worktree: dir }, mode: "stuck" })
  const h = await startServer(input(dir, mk.client), {})
  t.after(() => h.dispose?.())
  h.__forgeSubagentsTest.resetDispatchGate()
  await h.config(emptyCfg())
  const r = await h.tool.task.execute({ subagent_type: "forge-dgw-research", prompt: "go" }, allowCtx("ses_a1", dir))
  assert.match(r.output, /finished \(child session ses_child_1\)/)
  assert.ok(r.output.includes(ACTIVE_TEXTFUL_OVERRIDE_NOTE), "the wake names the message-stream establishment path")
  assert.match(r.output, /Final report:\nreport from ses_child_1/)
})

test("A (wiring, async): stuck-active+text → the terminal journal record carries the override disclosure", async (t) => {
  const dir = projectWithForgeJson(t, poolJson(null))
  const journal = makeJournalFs()
  const mk = makeClient({ record: { directory: dir, worktree: dir }, mode: "stuck" })
  const h = await startServer(input(dir, mk.client), {})
  t.after(() => h.dispose?.())
  h.__forgeSubagentsTest.resetDispatchGate()
  h.__forgeSubagentsTest.setDispatchJournalFs(journal.factory)
  await h.config(emptyCfg())
  await h.tool.task.execute({ subagent_type: "forge-dgw-research", prompt: "go", run_in_background: true }, allowCtx("ses_a2", dir))
  await waitFor(() => h.__forgeSubagentsTest.dispatchTasks().length === 0, "poller settles via the override")
  const rec = [...latestRecords(h.__forgeSubagentsTest.dispatchJournalText(dir)).values()].find((x) => x.state === "terminal")
  assert.equal(rec.outcome, "completed")
  assert.ok(rec.reason.includes(ACTIVE_TEXTFUL_OVERRIDE_NOTE), "the journal reason names the establishment path")
})

test("A (wiring): stuck-active with NO text stays honest — no completion invented (sync wait budget governs)", async (t) => {
  const dir = projectWithForgeJson(t, poolJson(null))
  const mk = makeClient({ record: { directory: dir, worktree: dir }, mode: "silent" })
  const h = await startServer(input(dir, mk.client), {})
  t.after(() => h.dispose?.())
  h.__forgeSubagentsTest.resetDispatchGate()
  process.env.FORGE_DISPATCH_POLL_TIMEOUT_MS = "150"
  t.after(() => {
    delete process.env.FORGE_DISPATCH_POLL_TIMEOUT_MS
  })
  await h.config(emptyCfg())
  const r = await h.tool.task.execute({ subagent_type: "forge-dgw-research", prompt: "go" }, allowCtx("ses_a3", dir))
  assert.match(r.output, /Sync wait budget ended/, "the honest wait-budget handoff — NOT a fabricated completion")
  assert.match(r.output, /continues in the background/)
  assert.ok(!r.output.includes(ACTIVE_TEXTFUL_OVERRIDE_NOTE))
})

test("A (wiring): a healthy child is unaffected (ordinary completion, no override disclosure)", async (t) => {
  const dir = projectWithForgeJson(t, poolJson(null))
  const mk = makeClient({ record: { directory: dir, worktree: dir }, mode: "done" })
  const h = await startServer(input(dir, mk.client), {})
  t.after(() => h.dispose?.())
  h.__forgeSubagentsTest.resetDispatchGate()
  await h.config(emptyCfg())
  const r = await h.tool.task.execute({ subagent_type: "forge-dgw-research", prompt: "go" }, allowCtx("ses_a4", dir))
  assert.match(r.output, /finished \(child session ses_child_1\)/)
  assert.ok(!r.output.includes(ACTIVE_TEXTFUL_OVERRIDE_NOTE), "no override claim on an ordinary completion")
})

// ---------------------------------------------------------------------------
// Block C wiring
// ---------------------------------------------------------------------------

test("C (wiring): the terminal seam feeds the counters — a live child holds the provider slot; a refusal is VERBATIM; the next terminal re-admits", async (t) => {
  const dir = projectWithForgeJson(t, poolJson({ providerConcurrency: { zai: 1 } }))
  const journal = makeJournalFs()
  const mk = makeClient({ record: { directory: dir, worktree: dir }, mode: "busy" })
  const h = await startServer(input(dir, mk.client), {})
  t.after(() => h.dispose?.())
  h.__forgeSubagentsTest.resetDispatchGate()
  h.__forgeSubagentsTest.setDispatchJournalFs(journal.factory)
  await h.config(emptyCfg())
  const ctx = allowCtx("ses_c1", dir)
  const r1 = await h.tool.task.execute({ subagent_type: "forge-dgw-research", prompt: "p1", run_in_background: true }, ctx)
  assert.match(r1.output, /async mode/)
  // The pinned zai/glm child holds the only zai slot: the second dispatch
  // is refused BEFORE any child creation, with the verbatim gate string.
  const createsBefore = mk.calls.create.length
  await assert.rejects(
    h.tool.task.execute({ subagent_type: "forge-dgw-research", prompt: "p2", run_in_background: true }, allowCtx("ses_c1", dir)),
    (err) => err instanceof Error && err.message === concurrencyRefusal("provider", "zai", 1, 1),
    "the refusal string is the module's verbatim contract",
  )
  assert.equal(mk.calls.create.length, createsBefore, "no child was created for the refused dispatch")
  // Terminal feed: finish the child → the completed terminal releases the
  // slot (journalTerminalRecord feeds the gate) → the next dispatch admits.
  const child = h.__forgeSubagentsTest.dispatchTasks()[0]
  mk.setChildState(child.childSessionID, "done")
  await waitFor(() => h.__forgeSubagentsTest.dispatchTasks().length === 0, "first child settles")
  const rec = [...latestRecords(h.__forgeSubagentsTest.dispatchJournalText(dir)).values()].find((x) => x.state === "terminal")
  assert.equal(rec.outcome, "completed")
  const r3 = await h.tool.task.execute({ subagent_type: "forge-dgw-research", prompt: "p3", run_in_background: true }, allowCtx("ses_c1", dir))
  assert.match(r3.output, /async mode/, "the freed slot re-admits")
})

test("C (wiring): queued wishes RE-CHECK the gate at dequeue — a hot-applied tightening fails the wish as an honest error wake", async (t) => {
  const dir = projectWithForgeJson(t, poolJson(null))
  const journal = makeJournalFs()
  const mk = makeClient({ record: { directory: dir, worktree: dir }, mode: "busy" })
  const h = await startServer(input(dir, mk.client), {})
  t.after(() => h.dispose?.())
  h.__forgeSubagentsTest.resetDispatchGate()
  h.__forgeSubagentsTest.setDispatchJournalFs(journal.factory)
  await h.config(emptyCfg())
  const ctx = allowCtx("ses_c2", dir)
  for (let i = 0; i < 3; i++) {
    await h.tool.task.execute({ subagent_type: "forge-dgw-research", prompt: `p${i}`, run_in_background: true }, ctx)
  }
  const r4 = await h.tool.task.execute({ subagent_type: "forge-dgw-research", prompt: "p3", run_in_background: true }, ctx)
  assert.match(r4.output, /QUEUED/)
  const wishId = /task id: (\S+)/.exec(r4.output)?.[1]
  assert.ok(wishId)
  // Hot-apply a tightening (bigger file size ⇒ the mtime cache re-reads).
  writeFileSync(join(dir, ".opencode", "forge.json"), poolJson({ providerConcurrency: { zai: 1 }, note: "hot-apply forces a re-read with a longer document" }))
  // Free a session slot: the pump dequeues the wish and the gate refuses it
  // (2 live zai children remain against the tightened limit of 1).
  const child = h.__forgeSubagentsTest.dispatchTasks()[0]
  mk.setChildState(child.childSessionID, "done")
  await waitFor(() => {
    const rec = latestRecords(h.__forgeSubagentsTest.dispatchJournalText(dir)).get(wishId)
    return rec?.state === "terminal"
  }, "queued wish terminalizes via the dequeue gate check")
  const rec = latestRecords(h.__forgeSubagentsTest.dispatchJournalText(dir)).get(wishId)
  assert.equal(rec.outcome, "error")
  assert.match(rec.reason, /spawn refused at queue pump/)
  assert.match(rec.reason, /provider concurrency gate/)
  assert.match(rec.reason, /2\/1 live dispatch children already run on provider "zai"/, "the counted dimension and its current value are in the wake")
})

test("C (wiring): the breaker opens on consecutive failed terminals and refuses BEFORE child creation (never provider-retry)", async (t) => {
  const dir = projectWithForgeJson(t, poolJson({ circuitBreaker: { consecutiveFailures: 2, cooldownMs: 600000 } }))
  const journal = makeJournalFs()
  const mk = makeClient({ record: { directory: dir, worktree: dir }, mode: "error" })
  const h = await startServer(input(dir, mk.client), {})
  t.after(() => h.dispose?.())
  h.__forgeSubagentsTest.resetDispatchGate()
  h.__forgeSubagentsTest.setDispatchJournalFs(journal.factory)
  await h.config(emptyCfg())
  // Two failed terminals open the breaker.
  for (const sid of ["ses_c3a", "ses_c3b"]) {
    const r = await h.tool.task.execute({ subagent_type: "forge-dgw-research", prompt: "p", run_in_background: true }, allowCtx(sid, dir))
    assert.match(r.output, /async mode/)
    await waitFor(() => h.__forgeSubagentsTest.dispatchTasks().length === 0, `error terminal for ${sid}`)
  }
  const state = h.__forgeSubagentsTest.dispatchGateState()
  assert.equal(state.breakers.zai.state, "open", "the breaker opened at 2 consecutive failed terminals")
  // The third dispatch is refused before child creation; the refusal is the
  // plugin's own throttle (a plain tool error — the provider-retry
  // classifier is never consulted because nothing spawned).
  const createsBefore = mk.calls.create.length
  await assert.rejects(
    h.tool.task.execute({ subagent_type: "forge-dgw-research", prompt: "p", run_in_background: true }, allowCtx("ses_c3a", dir)),
    (err) =>
      err instanceof Error &&
      err.message.includes("provider circuit breaker") &&
      err.message.includes("OPEN after 2 consecutive failed dispatch terminals (threshold 2)") &&
      err.message.includes("plugin's own throttle, not a provider error — it is never retried as one"),
  )
  assert.equal(mk.calls.create.length, createsBefore, "no child was created for the breaker refusal")
})

test("C (wiring): a malformed dispatch node refuses NOTHING (fail-soft — never a parse-failure refusal)", async (t) => {
  const dir = projectWithForgeJson(t, poolJson({ providerConcurrency: { zai: "oops" }, circuitBreaker: { consecutiveFailures: "x" } }))
  const mk = makeClient({ record: { directory: dir, worktree: dir }, mode: "done" })
  const h = await startServer(input(dir, mk.client), {})
  t.after(() => h.dispose?.())
  h.__forgeSubagentsTest.resetDispatchGate()
  await h.config(emptyCfg())
  // The bad fields dropped ⇒ unlimited: two sequential dispatches both go
  // through (the done-child settles fast, so even a surviving limit of 1
  // would pass — run both CONCURRENTLY to prove the limit is really gone).
  const r1 = await h.tool.task.execute({ subagent_type: "forge-dgw-research", prompt: "p1", run_in_background: true }, allowCtx("ses_c4", dir))
  const r2 = await h.tool.task.execute({ subagent_type: "forge-dgw-research", prompt: "p2", run_in_background: true }, allowCtx("ses_c4", dir))
  assert.match(r1.output, /async mode/)
  assert.match(r2.output, /async mode/, "a malformed node never refuses a dispatch")
  await waitFor(() => h.__forgeSubagentsTest.dispatchTasks().length === 0, "children settle")
})
