import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { createServer } from "node:http"
import { createV2MockContext } from "./lib/v2-mock-context.mjs"

process.env.FORGE_GOAL_DEBOUNCE_MS = "10"
process.env.FORGE_TEST_NO_FENCE = "1"
const root = mkdtempSync(join(tmpdir(), "v2-crew-lifecycle-"))
process.env.FORGE_TEST_FORGE_HOME = join(root, "home")
const { v2Setup, v2WiringSeam, resetServiceHttpDiscoveryForTests } = await import("../plugin.ts")
test.after(() => rmSync(root, { recursive: true, force: true }))
const sleep = (ms = 70) => new Promise(r => setTimeout(r, ms))
async function until(predicate, label) {
  const deadline = Date.now() + 5000
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail(`timed out waiting for ${label}`)
    await sleep(10)
  }
}
let sequence = 0
async function fixture(fn, failPrompt = false) {
  v2WiringSeam.resetHostAnchors()
  const wt = mkdtempSync(join(root, "workspace-"))
  mkdirSync(join(wt, ".opencode"), { recursive: true })
  writeFileSync(join(wt, ".opencode", "forge.json"), JSON.stringify({ pool: "crewcont", agents: { research: { model: "zai/glm", thoughtLevel: "low" } } }))
  // A complete empty native-child view is distinct from unavailable enumeration.
  const host = createServer((req, res) => {
    res.setHeader("content-type", "application/json")
    res.end(JSON.stringify(req.url.startsWith("/api/session/active") ? {} : { data: [], cursor: {} }))
  })
  await new Promise(resolve => host.listen(0, "127.0.0.1", resolve))
  const service = join(wt, "service.json"), oldService = process.env.FORGE_SERVICE_FILE
  writeFileSync(service, JSON.stringify({ url: `http://127.0.0.1:${host.address().port}`, password: "test" }))
  process.env.FORGE_SERVICE_FILE = service
  resetServiceHttpDiscoveryForTests()
  const { ctx, state } = createV2MockContext()
  let attempts = 0
  if (failPrompt) ctx.session.prompt = async () => { attempts++; throw new Error("connection refused (test)") }
  const cleanup = await v2Setup(ctx, { anchors: [wt], materialize: "runtime" })
  const sid = `ses_v2crew_${++sequence}`
  const call = (name, args, sessionID = sid) => state.tools.get(name).execute(args, { sessionID, worktree: wt, agent: "forge", messageID: "m", callID: "c", metadata() {}, ask: async () => {} })
  const idle = async () => { await state.sessionHooks.find(h => h.name === "experimental.idle").cb({ sessionID: sid, background: [] }); await sleep() }
  const arm = async (objective = "ship the thing", titles = ["alpha", "beta"]) => { await call("crew_begin", { objective, subtasks: titles.map(title => ({ title })) }); return call("crew_begin", { execution: "waves" }) }
  try { await fn({ state, sid, call, idle, arm, attempts: () => attempts }) } finally {
    await cleanup?.()
    host.closeAllConnections?.()
    await new Promise(resolve => host.close(resolve))
    if (oldService === undefined) delete process.env.FORGE_SERVICE_FILE; else process.env.FORGE_SERVICE_FILE = oldService
    resetServiceHttpDiscoveryForTests()
    v2WiringSeam.resetHostAnchors()
    rmSync(wt, { recursive: true, force: true })
  }
}

// crew-continue.test.mjs:88-105
test("v2 crew continuation carries the complete declared plan", () => fixture(async ({ state, sid, idle, arm }) => {
  const out = await arm("overnight refactor", ["map the module", "migrate the tests", "update the docs"])
  assert.match(out.content, /auto-advance on session idle until crew_close/i)
  await idle()
  await until(() => state.prompts.length >= 1, "crew continuation prompt")
  assert.equal(state.prompts.length, 1)
  assert.equal(state.prompts[0].sessionID, sid)
  const brief = state.prompts[0].text
  assert.match(brief, /\[forge:crew-continue\]/)
  for (const text of ["overnight refactor", "map the module", "migrate the tests", "update the docs"]) assert.ok(brief.includes(text), text)
  assert.match(brief, /crew_close \{abandon: true, reason\} to re-shard/)
}))

// crew-continue.test.mjs:112-144
for (const mode of ["closed", "abandoned", "pending"]) test(`v2 ${mode} crew does not continue`, () => fixture(async ({ state, sid, call, arm, idle }) => {
  if (mode === "pending") {
    await call("crew_begin", { objective: "pend me", subtasks: [{ title: "one" }] })
    assert.equal(v2WiringSeam.crews.get(sid).mode, "pending")
  } else {
    await arm(`${mode} me`, ["one"])
    const recordPath = v2WiringSeam.crews.get(sid).recordPath
    if (mode === "closed") {
      const result = await call("crew_close", { report: [{ title: "one", verdict: "PASS", evidence: "ok" }] })
      assert.match(result.content, /one/)
      assert.match(result.content, /PASS/)
      assert.match(result.content, /ok/)
    }
    else await call("crew_close", { abandon: true, reason: "wrong decomposition" })
    assert.equal(v2WiringSeam.crews.get(sid), undefined)
    const record = readFileSync(recordPath, "utf8")
    assert.ok(record.includes(mode === "closed" ? "PASS" : "wrong decomposition"))
  }
  await idle()
  assert.equal(state.prompts.length, 0)
}))

// crew-continue.test.mjs:147-168
test("v2 goal governs a born-armed crew", () => fixture(async ({ state, sid, call, idle }) => {
  await call("goal_write", { goal: "govern the crew", criteria: ["tests pass"], checks: [{ shell: "npm test" }], constraints: "stay in the sandbox", arm: true })
  await call("crew_begin", { objective: "crew under goal", subtasks: [{ title: "one" }], execution: "waves" })
  assert.equal(v2WiringSeam.crews.get(sid).mode, "executing")
  await idle()
  assert.equal(state.prompts.length, 1)
  assert.match(state.prompts[0].text, /\[forge:goal-continue\]/)
  assert.doesNotMatch(state.prompts[0].text, /\[forge:crew-continue\]/)
}))

for (const ending of ["discard", "ownership change"]) {
  test(`v2 goal-governed crew does not become standalone after ${ending}`, () => fixture(async ({ state, sid, call, idle }) => {
    await call("goal_write", { goal: "review notes", criteria: ["notes reviewed"], checks: [{ containsFile: "notes.txt", containsText: "reviewed" }], constraints: "read only", arm: true })
    await call("crew_begin", { objective: "review notes", subtasks: [{ title: "one" }], execution: "waves" })
    if (ending === "discard") await call("goal_discard", {})
    else {
      await call("goal_pause", {})
      await call("goal_resume", {}, `${sid}-new-owner`)
    }
    await idle()
    await idle()
    assert.equal(state.prompts.length, 0)
    assert.equal(v2WiringSeam.crews.get(sid).mode, "executing")
  }))
}

// crew-continue.test.mjs:206-252
test("v2 crew stalls once and a fresh registration resets it", () => fixture(async ({ state, sid, call, idle, arm }) => {
  await arm("stall me", ["one"])
  const original = console.warn
  let warns = 0
  console.warn = () => { warns++ }
  try {
    for (let i = 1; i <= 3; i++) { await idle(); assert.equal(state.prompts.length, i) }
    await idle()
    assert.equal(state.prompts.length, 3)
    assert.equal(warns, 1)
    assert.equal(v2WiringSeam.crews.get(sid).mode, "executing")
    await idle()
    assert.equal(state.prompts.length, 3)
    assert.equal(warns, 1)
    await call("crew_close", { abandon: true, reason: "stalled" })
    await arm("round two", ["one"])
    await idle()
    assert.equal(state.prompts.length, 4)
    assert.match(state.prompts[3].text, /round two/)
    assert.equal(warns, 1)
  } finally { console.warn = original }
}))

// crew-continue.test.mjs:281-313
test("v2 crew transport failure cap discloses once", () => fixture(async ({ sid, idle, arm, attempts }) => {
  await arm("transport me", ["one"])
  const original = console.warn
  let warns = 0
  console.warn = () => { warns++ }
  try {
    for (let i = 1; i <= 3; i++) {
      await idle()
      await until(() => attempts() >= i && (i < 3 || warns >= 1), `transport attempt ${i}`)
      assert.equal(attempts(), i)
    }
    assert.equal(attempts(), 3)
    assert.equal(warns, 1)
    assert.equal(v2WiringSeam.crews.get(sid).mode, "executing")
    await idle()
    assert.equal(attempts(), 3)
  } finally { console.warn = original }
}, true))

// crew-continue.test.mjs:320-332
test("v2 session deletion evicts the crew", () => fixture(async ({ state, sid, idle, arm }) => {
  await arm("delete me", ["one"])
  assert.equal(v2WiringSeam.crews.get(sid).mode, "executing")
  assert.equal(state.prompts.length, 0)
  await state.emit("session.deleted", { sessionID: sid })
  await sleep()
  assert.equal(v2WiringSeam.crews.get(sid), undefined)
  await idle()
  assert.equal(state.prompts.length, 0)
}))
