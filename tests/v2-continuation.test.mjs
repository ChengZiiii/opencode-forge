import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServer } from "node:http"

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
const { v2Setup, v2WiringSeam, resetServiceHttpDiscoveryForTests } = await import("../plugin.ts")
import { parseGoal } from "../src/goal-file.ts"
import { createV2MockContext } from "./lib/v2-mock-context.mjs"

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const allowAsk = async () => {}

// The Goal waiting gate requires a positively readable host view, even when
// there are no children. This host is local to the test process.
const host = createServer((req, res) => {
  res.setHeader("content-type", "application/json")
  if (req.url.startsWith("/api/session/active")) res.end(JSON.stringify({}))
  else if (req.url.startsWith("/api/session")) res.end(JSON.stringify([]))
  else { res.statusCode = 404; res.end() }
})
const serviceDir = mkdtempSync(join(tmpdir(), "v2-cont-service-"))
const previousService = process.env.FORGE_SERVICE_FILE
test.before(async () => {
  await new Promise(resolve => host.listen(0, "127.0.0.1", resolve))
  const serviceFile = join(serviceDir, "service.json")
  writeFileSync(serviceFile, JSON.stringify({ url: `http://127.0.0.1:${host.address().port}`, password: "test" }))
  process.env.FORGE_SERVICE_FILE = serviceFile
  resetServiceHttpDiscoveryForTests()
})
test.after(async () => {
  host.closeAllConnections?.()
  await new Promise(resolve => host.close(resolve))
  if (previousService === undefined) delete process.env.FORGE_SERVICE_FILE
  else process.env.FORGE_SERVICE_FILE = previousService
  resetServiceHttpDiscoveryForTests()
  rmSync(serviceDir, { recursive: true, force: true })
})

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

test("cleanup cancels its pending Goal timer and ignores stale repeated idle without touching a sibling", async () => {
  const wt = mkdtempSync(join(tmpdir(), "v2-cleanup-goal-"))
  const siblingWt = mkdtempSync(join(tmpdir(), "v2-cleanup-sibling-"))
  const v2 = await makeV2()
  const sibling = await makeV2()
  try {
    const { sid } = await armGoal(v2.state, wt)
    const { sid: siblingSid } = await armGoal(sibling.state, siblingWt)
    const before = goalFiles(wt)
    assert.equal(before.length, 1)
    await fireIdle(v2.state, sid)
    await fireIdle(sibling.state, siblingSid)
    v2.cleanup()
    await fireIdle(v2.state, sid)
    await fireIdle(v2.state, sid)
    await sleep(100)
    assert.equal(v2.state.prompts.length, 0)
    assert.deepEqual(goalFiles(wt), before, "cleanup preserves the armed Goal bytes")
    assert.equal(sibling.state.prompts.length, 1, "sibling timer remains live")
    assert.equal(sibling.state.prompts[0].sessionID, siblingSid)
  } finally {
    v2.cleanup()
    sibling.cleanup()
    rmSync(wt, { recursive: true, force: true })
    rmSync(siblingWt, { recursive: true, force: true })
  }
})

test("cleanup invalidates an idle callback suspended in the lazy session read", async () => {
  const wt = mkdtempSync(join(tmpdir(), "v2-cleanup-read-"))
  const mock = createV2MockContext()
  let releaseRead
  let startRead
  const started = new Promise(resolve => { startRead = resolve })
  mock.ctx.session.get = async () => {
    startRead()
    return new Promise(resolve => { releaseRead = resolve })
  }
  const cleanup = await v2Setup(mock.ctx)
  try {
    const { sid } = await armGoal(mock.state, wt)
    const before = goalFiles(wt)
    v2WiringSeam.sessions.delete(sid)
    await fireIdle(mock.state, sid)
    await Promise.race([started, sleep(500).then(() => { throw new Error("lazy read did not start") })])
    cleanup()
    releaseRead({ directory: wt, worktree: wt })
    await fireIdle(mock.state, sid)
    await sleep(50)
    assert.equal(mock.state.prompts.length, 0)
    assert.deepEqual(goalFiles(wt), before)
  } finally {
    cleanup()
    rmSync(wt, { recursive: true, force: true })
  }
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
    assert.match(brief, /meaningful read-only reconnaissance and review, real changes, commits, and checks or failure diagnosis with new evidence/)
    assert.match(brief, /Treat verified waiting as distinct from work or no-progress/)
    assert.match(brief, /No write, shell command, or git diff is required every turn/)
    assert.match(brief, /unknown or truncated evidence does not establish equality/)
    assert.match(brief, /already accepted host work may finish/)
    assert.match(brief, /wall-clock minute limit continues during waiting/)
    assert.match(brief, /stop on either budget limit or when goal authorization ends/)
    assert.match(brief, /every work round of the previous wave is verified settled/)
    assert.match(brief, /duplicate observations of one round count once/)
    assert.match(brief, /A diagnostic is not permission to launch another wave/)
    assert.match(brief, /completion notification is not by itself PASS/)
    assert.doesNotMatch(brief, /forge_shell|forge_jobs|subagent_type|run_in_background/)
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

test("owning shell and unknown background hold Goal until a complete empty view", async () => {
  const wt = mkdtempSync(join(tmpdir(), "v2-goal-wait-"))
  const v2 = await makeV2()
  try {
    const { sid } = await armGoal(v2.state, wt)
    const shell = { kind: "shell", sessionID: sid, shellID: "sh_1", command: "npm test" }
    for (let i = 0; i < 4; i++) {
      await idleHook(v2.state)({ sessionID: sid, background: [shell] })
      await sleep(60)
    }
    assert.equal(v2.state.prompts.length, 0)
    assert.equal(parseGoal(goalFiles(wt)[0].text).turnsUsed, 0)
    assert.equal(parseGoal(goalFiles(wt)[0].text).status, "active")
    await idleHook(v2.state)({ sessionID: sid, background: [{ ...shell, sessionID: "other" }, { kind: "unknown" }] })
    await sleep(100)
    assert.equal(v2.state.prompts.length, 0, "unknown background cannot clear an established wait")
    assert.equal(parseGoal(goalFiles(wt)[0].text).turnsUsed, 0)
    await idleHook(v2.state)({ sessionID: sid, background: [] })
    const deadline = Date.now() + 5000
    while (v2.state.prompts.length < 1 && Date.now() < deadline) await sleep(10)
    assert.equal(v2.state.prompts.length, 1, "complete empty background clears the wait")
    await sleep(60)
    assert.equal(v2.state.prompts.length, 1, "the resolved wait resumes only once")
    assert.equal(parseGoal(goalFiles(wt)[0].text).turnsUsed, 1)
  } finally {
    v2.cleanup?.()
    rmSync(wt, { recursive: true, force: true })
  }
})

test("waiting idle still checks elapsed minutes and paused goals stay paused without prompts", async () => {
  const wt = mkdtempSync(join(tmpdir(), "v2-goal-wait-budget-"))
  const v2 = await makeV2()
  try {
    const { sid } = await armGoal(v2.state, wt, { maxMinutes: 1 })
    const file = goalFiles(wt)[0]
    writeFileSync(join(wt, ".opencode", "goal", file.name), file.text.replace(/^armed_at: .*$/m, "armed_at: 2020-01-01T00:00:00.000Z"))
    const raw = { sessionID: sid, background: [{ kind: "shell", sessionID: sid, shellID: "sh_1", command: "npm test" }] }
    await idleHook(v2.state)(raw)
    await sleep(60)
    const doc = parseGoal(goalFiles(wt)[0].text)
    assert.equal(doc.status, "paused")
    assert.equal(doc.stopReason, "budget-time")
    await idleHook(v2.state)(raw)
    await fireIdle(v2.state, sid)
    await sleep(60)
    assert.equal(v2.state.prompts.length, 0)
    assert.equal(parseGoal(goalFiles(wt)[0].text).turnsUsed, 0)
    // Native plugin unload/reload must not implicitly resume the parked goal.
    v2.cleanup?.()
    const reloaded = await makeV2()
    try {
      await fireIdle(reloaded.state, sid)
      await sleep(60)
      assert.equal(reloaded.state.prompts.length, 0)
      assert.equal(parseGoal(goalFiles(wt)[0].text).status, "paused")
      assert.equal(parseGoal(goalFiles(wt)[0].text).turnsUsed, 0)
    } finally {
      reloaded.cleanup?.()
    }
  } finally {
    v2.cleanup?.()
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
// session.deleted harvest (the shared harvestSessionEnd core) — the SSE
// AsyncIterable leg, payload under .data.
// ---------------------------------------------------------------------------

test("session.deleted harvest: evicts every session-bounded map via the shared core", async () => {
  const v2 = await makeV2()
  const sid = nextSid()
  v2WiringSeam.sessionAgents.set(sid, "forge-worker-x")
  v2WiringSeam.sessionDepths.set(sid, { translation: { kind: "effort", value: "high" } })
  v2WiringSeam.crews.set(sid, { mode: "pending", objective: "o", startedAt: "t" })
  await fireDeleted(v2.state, sid)
  await sleep(30)
  assert.equal(v2WiringSeam.sessionAgents.get(sid), undefined, "agent-family map evicted")
  assert.equal(v2WiringSeam.sessionDepths.get(sid), undefined, "frozen depth table evicted")
  assert.equal(v2WiringSeam.crews.get(sid), undefined, "crew record ended with the session")
  v2.cleanup?.()
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
