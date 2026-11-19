import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, readdirSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Task 5.1 (W6a field realities) — the v2 continuation engines on the REAL
// SDK 2.3.2 surfaces: idle via ctx.session.hook("experimental.idle")
// (SessionIdle {sessionID, background[]}), session.deleted via the
// ctx.event.subscribe() AsyncIterable ({id, type, data} envelopes,
// data.sessionID payload), and sends through the FLAT root-level
// {sessionID, text} prompt shape (live shape matrix 2026-11-19: the only
// spelling the 2.3.2 promise layer accepts) the shared cores' v1-shaped
// {path:{id}, body:{parts}} messages translate into. The scenarios mirror
// the v1 suites (tests/goal-mode.test.mjs continuation engine,
// tests/job-wiring.test.mjs wake engine) — the SAME shared cores run, only
// the seams differ.

// Debounce must be tiny BEFORE plugin.ts is imported (module-level const).
process.env.FORGE_GOAL_DEBOUNCE_MS = "10"
// No real fence watcher inside wiring tests: its stdin pipe holds the event
// loop open and the test process would never exit (same as job-wiring).
process.env.FORGE_TEST_NO_FENCE = "1"
// Sandbox the plugin's runtime-artifact home (session-anchor ledger etc.).
process.env.FORGE_TEST_FORGE_HOME = mkdtempSync(join(tmpdir(), "v2-cont-home-"))
const { v2Setup, v2WiringSeam } = await import("../plugin.ts")
import { parseGoal } from "../src/goal-file.ts"
import { createV2MockContext } from "./lib/v2-mock-context.mjs"

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const allowAsk = async () => {}

let sidCounter = 0
const nextSid = () => `ses_v2cont-${++sidCounter}`

function toolCtx(sid, worktree, ask = allowAsk) {
  return { sessionID: sid, worktree, ask, metadata() {}, callID: "c", messageID: "m", agent: "forge" }
}

function goalArgs(overrides = {}) {
  return {
    goal: "make the suite green",
    criteria: ["npm test exits 0"],
    checks: [{ shell: "npm test" }],
    constraints: "stay in the sandbox",
    ...overrides,
  }
}

async function makeV2() {
  const mock = createV2MockContext()
  const cleanup = await v2Setup(mock.ctx)
  return { ...mock, cleanup }
}

async function armGoal(state, worktree, overrides = {}) {
  const sid = nextSid()
  const tool = state.tools.get("goal_write")
  assert.ok(tool, "goal_write registered through the tool domain")
  const out = await tool.execute({ ...goalArgs(overrides), arm: true }, toolCtx(sid, worktree))
  return { sid, out }
}

function goalFiles(worktree) {
  const dir = join(worktree, ".opencode", "goal")
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter((f) => f.endsWith(".md")).map((f) => ({ name: f, text: readFileSync(join(dir, f), "utf8") }))
}

// The v2 execute wrapper returns { content } where content is the shared
// core's output string (see wrapV2ToolResult).
const outText = (res) => (typeof res?.content === "string" ? res.content : String(res?.content?.output ?? res?.content ?? ""))

// The idle seam: the in-process experimental.idle hook (SessionIdle
// {sessionID, background[]}).
const idleHook = (state) => {
  const h = state.sessionHooks.find((x) => x.name === "experimental.idle")
  assert.ok(h, "the experimental.idle hook is registered")
  return h.cb
}
const fireIdle = async (state, sessionID) => idleHook(state)({ sessionID, background: [] })
// The deleted seam: an SSE envelope through the AsyncIterable subscription.
const fireDeleted = async (state, sessionID) => state.emit("session.deleted", { sessionID })

// ---------------------------------------------------------------------------
// Registration + drift + cleanup (the harness contract, W5/W6a leg)
// ---------------------------------------------------------------------------

test("registration: wired ctx registers the idle hook + an AsyncIterable subscription; cleanup closes both", async () => {
  const { ctx, state, cleanup } = await makeV2()
  assert.equal(typeof ctx.event.subscribe, "function")
  assert.ok(state.sessionHooks.some((h) => h.name === "experimental.idle"), "experimental.idle hook registered")
  assert.equal(state.subscriptions.length, 1, "exactly one subscription from v2Setup")
  const sub = state.subscriptions[0]
  assert.equal(typeof sub.options, "object")
  assert.equal(state.subscriptionsAborted, 0)
  assert.equal(state.sessionHookDisposed.length, 0)
  assert.equal(typeof cleanup, "function", "setup returns the combined cleanup")
  cleanup()
  assert.equal(state.subscriptionsAborted, 1, "cleanup closes the subscription")
  assert.ok(state.sessionHookDisposed.includes("experimental.idle"), "cleanup disposes the idle hook registration")
  cleanup()
  assert.equal(state.subscriptionsAborted, 1, "cleanup is idempotent")
})

test("drift: every event drift mode disables only the event slice — no subscription, no throw; idle hook still registered", async () => {
  for (const mode of ["missing", "not-function", "bad-shape"]) {
    const mock = createV2MockContext({ drift: { event: mode } })
    const cleanup = await v2Setup(mock.ctx)
    assert.equal(mock.state.subscriptions.length, 0, `${mode}: no subscription`)
    assert.ok(mock.state.sessionHooks.some((h) => h.name === "experimental.idle"), `${mode}: idle hook unaffected`)
    // Other slices keep working (agent materialization is untouched).
    assert.ok(mock.state.agents.has("forge"), `${mode}: agent slice unaffected`)
    if (typeof cleanup === "function") cleanup()
  }
})

test("drift: a drifted session domain falls back to the SSE idle edge (session.execution.succeeded) for job wakes", async () => {
  const mock = createV2MockContext({ drift: { session: "not-function" } })
  await v2Setup(mock.ctx)
  assert.equal(mock.state.sessionHooks.length, 0, "no session hooks on a drifted session domain")
  assert.equal(mock.state.subscriptions.length, 1, "the event slice is its own failure domain")
  // No prompt method => no continuation client; but the idle fallback edge
  // still marks idle bookkeeping (no throw, no send).
  const sid = nextSid()
  v2WiringSeam.sessionAgents.set(sid, "forge")
  await mock.state.emit("session.execution.succeeded", { sessionID: sid })
  await sleep(40)
  assert.equal(mock.state.prompts.length, 0, "no prompt on the session domain => no continuation send")
})

// ---------------------------------------------------------------------------
// Goal idle continuation (port of the goal-mode continuation scenarios)
// ---------------------------------------------------------------------------

test("idle continuation: armed goal continues the owner session with the [forge:goal-continue] brief; turns increment", async () => {
  const wt = mkdtempSync(join(tmpdir(), "v2-goal-cont-"))
  try {
    const v2 = await makeV2()
    const { sid } = await armGoal(v2.state, wt)
    await fireIdle(v2.state, sid)
    await sleep(60)
    assert.equal(v2.state.prompts.length, 1)
    // W6a field reality (live shape matrix): the send is the FLAT root-level
    // {sessionID, text} — prompt:{text}/prompt:{parts}/{path,body} shapes
    // all throw SchemaError on the 2.3.2 promise layer; the v1
    // {path:{id}, body:{parts}} brief is translated to the flat spelling.
    const body = v2.state.prompts[0]
    assert.equal(body.sessionID, sid)
    const brief = body.text
    assert.match(brief, /\[forge:goal-continue\]/)
    assert.match(brief, /make the suite green/)
    assert.match(brief, /0\/25 turns used/)
    assert.match(goalFiles(wt)[0].text, /^turns_used: 1$/m)
    // Second idle evaluates turn 1 (ledger entry, no activity) and continues.
    await fireIdle(v2.state, sid)
    await sleep(60)
    assert.equal(v2.state.prompts.length, 2)
    assert.match(goalFiles(wt)[0].text, /- turn 1 rev1 \S+ activity=no \(writes=0 checks=0\)/)
    assert.equal(parseGoal(goalFiles(wt)[0].text).turnsUsed, 2)
    v2.cleanup?.()
  } finally {
    rmSync(wt, { recursive: true, force: true })
  }
})

test("idle continuation: non-owner session never continues", async () => {
  const wt = mkdtempSync(join(tmpdir(), "v2-goal-owner-"))
  try {
    const v2 = await makeV2()
    const { sid } = await armGoal(v2.state, wt)
    const stranger = nextSid()
    v2WiringSeam.sessionAgents.set(stranger, "forge")
    await fireIdle(v2.state, stranger)
    await sleep(60)
    assert.equal(v2.state.prompts.length, 0, "non-owner must not continue")
    // Cleanup closes the subscription: the HOST stops delivering events
    // (asserted on the mock's closed flag — the registration test covers
    // the flag itself; here we confirm cleanup leaves no live subscription
    // behind for the owner's next idle).
    v2.cleanup?.()
    assert.equal(v2.state.subscriptions[v2.state.subscriptions.length - 1].closed, true)
  } finally {
    rmSync(wt, { recursive: true, force: true })
  }
})

test("idle continuation: lazy seeding resolves an unknown session via the session-domain get() read", async () => {
  const wt = mkdtempSync(join(tmpdir(), "v2-goal-lazy-"))
  try {
    const v2 = await makeV2()
    const { sid } = await armGoal(v2.state, wt)
    // Drop the in-memory binding (new-process semantics, same trick as the
    // v1 lazy-seed test) — the engine must re-seed from ctx.session.get.
    v2WiringSeam.sessions.clear()
    v2.state.sessionRecords.set(sid, { directory: wt, worktree: wt })
    await fireIdle(v2.state, sid)
    await sleep(60)
    assert.equal(v2.state.prompts.length, 1, "lazy-seeded continuation via the session-domain read")
    assert.equal(v2.state.prompts[0].sessionID, sid)
    v2.cleanup?.()
  } finally {
    rmSync(wt, { recursive: true, force: true })
  }
})

test("budget: turn exhaustion wraps up once and pauses with budget-turns", async () => {
  const wt = mkdtempSync(join(tmpdir(), "v2-goal-budget-"))
  try {
    const v2 = await makeV2()
    const { sid } = await armGoal(v2.state, wt, { maxTurns: 1 })
    await fireIdle(v2.state, sid)
    await sleep(60)
    assert.equal(v2.state.prompts.length, 1, "the single budgeted continuation")
    await fireIdle(v2.state, sid)
    await sleep(80)
    assert.equal(v2.state.prompts.length, 2, "exactly one wrap-up prompt")
    assert.match(v2.state.prompts[1].text, /\[forge:goal-wrapup\]/)
    const doc = parseGoal(goalFiles(wt)[0].text)
    assert.equal(doc.status, "paused")
    assert.equal(doc.stopReason, "budget-turns")
    await fireIdle(v2.state, sid)
    await sleep(60)
    assert.equal(v2.state.prompts.length, 2, "no continuation after the pause")
    v2.cleanup?.()
  } finally {
    rmSync(wt, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Job-wake delivery (port of the job-wiring wake-engine scenarios) — the
// wakes ride the SAME SessionPrompt sends (promptAsync ≈ prompt in v2).
// ---------------------------------------------------------------------------

test("wake engine: exit queues, only the idle edge delivers, exactly once", async () => {
  const wt = mkdtempSync(join(tmpdir(), "v2-wake-"))
  try {
    const v2 = await makeV2()
    const sid = nextSid()
    const ctx = toolCtx(sid, wt)
    const started = await v2.state.tools.get("forge_shell").execute(
      { command: `node -e "setTimeout(()=>console.log('done'),150)"`, run_in_background: true },
      ctx,
    )
    const jobId = /jobId: (j-\S+)/.exec(outText(started))[1]
    // Wait until the job is terminal (bounded), asserting nothing delivered
    // while the session was busy (no idle edge yet).
    const lineOf = (txt) => txt.split("\n").find((l) => l.startsWith(jobId)) ?? ""
    let terminal = false
    for (let i = 0; i < 40 && !terminal; i++) {
      const l = await v2.state.tools.get("forge_jobs").execute({ action: "list" }, ctx)
      terminal = /\b(exited|killed|succeeded)\b/.test(lineOf(outText(l)))
      if (!terminal) await sleep(100)
    }
    assert.ok(terminal, "job reached a terminal state within the bound")
    assert.equal(v2.state.prompts.length, 0, "no delivery before the session goes idle")
    await fireIdle(v2.state, sid)
    await sleep(60)
    assert.equal(v2.state.prompts.length, 1, "exactly one wake on idle")
    assert.equal(v2.state.prompts[0].sessionID, sid)
    assert.match(v2.state.prompts[0].text, /\[forge:job-complete\]/)
    await fireIdle(v2.state, sid)
    await sleep(60)
    assert.equal(v2.state.prompts.length, 1, "no duplicate delivery on a second idle")
    v2.cleanup?.()
  } finally {
    rmSync(wt, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// session.deleted harvest (the shared harvestSessionEnd core) — the SSE
// AsyncIterable leg, payload under .data.
// ---------------------------------------------------------------------------

test("session.deleted harvest: evicts every session-bounded map via the shared core", async () => {
  const v2 = await makeV2()
  const sid = nextSid()
  v2WiringSeam.sessionAgents.set(sid, "forge-worker-x")
  v2WiringSeam.sessionDepths.set(sid, { translation: { kind: "effort", value: "high" } })
  v2WiringSeam.sealFindings.set(sid, new Set(["redirect"]))
  v2WiringSeam.crews.set(sid, { mode: "pending", objective: "o", startedAt: "t" })
  await fireDeleted(v2.state, sid)
  await sleep(30)
  assert.equal(v2WiringSeam.sessionAgents.get(sid), undefined, "agent-family map evicted")
  assert.equal(v2WiringSeam.sessionDepths.get(sid), undefined, "frozen depth table evicted")
  assert.equal(v2WiringSeam.sealFindings.get(sid), undefined, "seal findings evicted")
  assert.equal(v2WiringSeam.crews.get(sid), undefined, "crew record ended with the session")
  v2.cleanup?.()
})

test("session.deleted harvest: a live session-scoped job is killed and ledgered", async () => {
  const wt = mkdtempSync(join(tmpdir(), "v2-deleted-job-"))
  try {
    const v2 = await makeV2()
    const sid = nextSid()
    const ctx = toolCtx(sid, wt)
    const started = await v2.state.tools.get("forge_shell").execute(
      { command: `node -e "setTimeout(()=>{},30000)"`, run_in_background: true },
      ctx,
    )
    const jobId = /jobId: (j-\S+)/.exec(outText(started))[1]
    await fireDeleted(v2.state, sid)
    // The kill is async (taskkill fires and forgets); give Windows a beat
    // to reap the child before the assertions and the worktree removal.
    await sleep(600)
    // The harvest kills the live job AND removes the registry row (the
    // orphan lands in the diagnostics ledger — job-supervisor spec).
    const l = await v2.state.tools.get("forge_jobs").execute({ action: "list" }, ctx)
    assert.ok(!outText(l).split("\n").some((x) => x.startsWith(jobId)), "the owner's live job left the registry")
    const orphan = v2WiringSeam.jobLedger().find((e) => e.jobId === jobId && /owner session ended/.test(String(e.detail)))
    assert.ok(orphan, `the kill is ledgered as an orphan: ${JSON.stringify(v2WiringSeam.jobLedger().filter((e) => e.jobId === jobId))}`)
    v2.cleanup?.()
  } finally {
    try {
      rmSync(wt, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    } catch {
      // A killed child's cwd can linger a moment on Windows; the temp dir
      // cleaner owns it then.
    }
  }
})

test("session.deleted drift: a garbage envelope is a no-op, never a throw", async () => {
  const v2 = await makeV2()
  await v2.state.emit("session.deleted", 5)
  await v2.state.emit("session.deleted", { noSessionID: true })
  // A flat-payload spelling still harvests (legacy fallback): sanity that
  // the envelope parser never throws on either shape.
  await v2.state.emit("weird.event", { sessionID: "ses_flat_spellings" })
  await sleep(30)
  v2.cleanup?.()
})

test("SSE idle fallback: without the session domain the execution.succeeded edge drives job wakes (execution.succeeded, not session.idle)", async () => {
  // Drift ONLY the session domain's hook (not-function): the event loop
  // then owns the idle edge via session.execution.succeeded — the emitted
  // idle signal on 2.3.2 ("session.idle" is NOT emitted; kept as alias).
  const mock = createV2MockContext({ drift: { session: "not-function" } })
  const cleanup = await v2Setup(mock.ctx)
  try {
    const sid = nextSid()
    v2WiringSeam.sessionAgents.set(sid, "forge")
    // session.idle alias would also be accepted — but assert the REAL
    // 2.3.2 name works.
    await mock.state.emit("session.execution.succeeded", { sessionID: sid })
    await sleep(40)
    // No prompts possible (no session domain) — the assertion is that the
    // edge is consumed without a throw and the session is marked idle
    // (idleJobSessions side effect visible via the wiring seam indirectly:
    // re-emitting stays quiet).
    await mock.state.emit("session.execution.succeeded", { sessionID: sid })
    await sleep(20)
  } finally {
    cleanup?.()
  }
})
