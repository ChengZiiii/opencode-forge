import test from "node:test"
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { createV2MockContext } from "./lib/v2-mock-context.mjs"
import { parseGoal } from "../src/goal-file.ts"

process.env.FORGE_GOAL_DEBOUNCE_MS = "10"
process.env.FORGE_CREW_NATIVE_CHILD_RECHECK_MS = "30"
process.env.FORGE_TEST_NO_DISPATCH_FETCH = "1"
const root = mkdtempSync(join(tmpdir(), "forge-goal-native-"))
process.env.FORGE_TEST_FORGE_HOME = join(root, "home")
const { v2Setup, resetServiceHttpDiscoveryForTests, v2WiringSeam } = await import("../plugin.ts")
test.after(() => rmSync(root, { recursive: true, force: true }))
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(fn) {
  for (let n = 0; n < 250; n++) { if (fn()) return; await sleep(10) }
  assert.fail("condition did not settle")
}
let seq = 0
async function fixture(t) {
  const wt = mkdtempSync(join(root, "workspace-")), sid = "ses-goal-native-" + ++seq
  const child = sid + "-child"
  const view = { list: [], active: {}, reads: 0, transcript: [] }
  const server = createServer((req, res) => {
    view.reads++
    res.setHeader("content-type", "application/json")
    const send = () => res.end(JSON.stringify(req.url.startsWith("/api/session/active") ? view.active : view.list))
    if (view.blockRead) view.blockRead(send, req.url); else send()
  })
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
  const service = join(wt, "service.json")
  writeFileSync(service, JSON.stringify({ url: "http://127.0.0.1:" + server.address().port, password: "test" }))
  process.env.FORGE_SERVICE_FILE = service
  resetServiceHttpDiscoveryForTests()
  v2WiringSeam.resetHostAnchors()
  const { ctx, state } = createV2MockContext()
  ctx.session.context = async () => view.transcript
  const assertPermission = ctx.permission.assert
  ctx.permission.assert = async input => {
    if (view.blockAsk) await view.blockAsk(input)
    return assertPermission(input)
  }
  const cleanup = await v2Setup(ctx, { anchors: [wt] })
  t.after(async () => {
    await cleanup?.()
    server.closeAllConnections?.()
    await new Promise(resolve => server.close(resolve))
    delete process.env.FORGE_SERVICE_FILE
    resetServiceHttpDiscoveryForTests()
  })
  const call = (name, args) => state.tools.get(name).execute(args, { sessionID: sid, worktree: wt, agent: "forge", messageID: "m", callID: "c", metadata() {} })
  const idle = () => state.sessionHooks.find(h => h.name === "experimental.idle").cb({ sessionID: sid, background: [] })
  const before = (tool, input = {}) => state.toolHooks.find(h => h.name === "execute.before").cb({ tool, sessionID: sid, agent: "forge", input })
  const path = () => { const dir = join(wt, ".opencode", "goal"); return join(dir, readdirSync(dir)[0]) }
  const doc = () => parseGoal(readFileSync(path(), "utf8"))
  await call("goal_write", { goal: "native waiting", criteria: ["done"], constraints: "sandbox only", checks: [{ shell: "echo done" }], arm: true, maxTurns: 10, maxMinutes: 1 })
  return { view, state, child, sid, idle, before, call, doc, path, cleanup, origin: "http://127.0.0.1:" + server.address().port }
}

test("ordinary goal waits for native busy, unknown and missing outcomes; then resumes exactly once", async t => {
  const f = await fixture(t)
  await f.idle()
  await until(() => f.doc().turnsUsed === 1)
  f.view.list = [{ id: f.child, parentID: f.sid }]
  f.view.active = { [f.child]: { type: "running" } }
  await f.idle()
  await sleep(150)
  assert.equal(f.state.prompts.length, 1)
  f.view.active = {}
  await sleep(100)
  f.view.list = [] // disappearance is not settlement
  await sleep(100)
  assert.equal(f.doc().turnsUsed, 1)
  f.view.list = { data: [{ id: f.child, parentID: f.sid, outcome: "succeeded" }], cursor: { next: "more" } }
  await sleep(100)
  assert.equal(f.state.prompts.length, 1)
  f.view.list = [{ id: f.child, parentID: f.sid, outcome: "succeeded" }]
  await until(() => f.doc().turnsUsed === 2)
  await sleep(150)
  assert.equal(f.state.prompts.length, 2)
  assert.equal(f.doc().status, "active")
})

test("paused goal refuses new native work, including reused sessions, but permits reads and explicit resume", async t => {
  const f = await fixture(t)
  await f.before("shell", { command: "echo accepted" })
  await f.call("goal_pause", { blocker: "waiting for user" })
  await assert.rejects(f.before("shell"), /Autonomous work refused/)
  await assert.rejects(f.before("subagent", { agent: "general", sessionID: f.child }), /Autonomous work refused/)
  await f.before("read")
  await f.before("goal_resume")
  await f.call("goal_resume", {})
  await f.before("shell")
  await f.before("subagent", { agent: "general" })
})

test("pause wins the native admission await race", async t => {
  const f = await fixture(t)
  const pending = f.before("subagent", { agent: "general", sessionID: f.child })
  await f.call("goal_pause", { blocker: "stop before acceptance" })
  await assert.rejects(pending, /Autonomous work refused/)
  assert.equal(f.doc().status, "paused")
})

test("minute budget expires while native view remains unknown, without a normal or wrapup prompt", async t => {
  const f = await fixture(t)
  f.view.list = { data: [], cursor: { next: "more" } }
  const text = readFileSync(f.path(), "utf8")
  writeFileSync(f.path(), text.replace(/^armed_at: .*$/m, "armed_at: " + new Date(Date.now() - 59_800).toISOString()))
  await f.idle()
  await until(() => f.doc().status === "paused")
  assert.equal(f.doc().stopReason, "budget-time")
  assert.equal(f.doc().turnsUsed, 0)
  assert.equal(f.state.prompts.length, 0)
})

test("reused native child must settle its new round; pause and cleanup revoke retry timers", async t => {
  const f = await fixture(t)
  f.view.list = [{ id: f.child, parentID: f.sid, outcome: "succeeded" }]
  await f.idle()
  await until(() => f.doc().turnsUsed === 1)
  f.view.active = { [f.child]: { type: "running" } }
  f.view.list = [{ id: f.child, parentID: f.sid }]
  await f.idle()
  await sleep(100)
  await f.state.emit("session.execution.succeeded", { sessionID: f.child }) // late old round
  f.view.active = {}
  await sleep(100)
  assert.equal(f.state.prompts.length, 1)
  // Observe issuance, not server arrival or response-body completion.
  const originalFetch = globalThis.fetch
  const issued = []
  globalThis.fetch = (input, ...args) => {
    const url = String(input)
    if (url.startsWith(f.origin + "/")) issued.push(new URL(url).pathname)
    return originalFetch(input, ...args)
  }
  try {
    async function revokeWhileWalkBlocked(revoke) {
      const blocked = new Set()
      const releaseAll = () => {
        for (const send of blocked) {
          blocked.delete(send)
          try { send() } catch { /* do not mask the test failure during cleanup */ }
        }
      }
      f.view.blockRead = (send, url) => {
        if (url.startsWith("/api/session/active")) send()
        else blocked.add(send)
      }
      try {
        await until(() => blocked.size > 0)
        const atRevoke = issued.length
        await revoke()
        f.view.blockRead = undefined
        releaseAll()
        await until(() => issued.slice(atRevoke).includes("/api/session/active"))
        await sleep(120)
        assert.deepEqual(issued.slice(atRevoke), ["/api/session/active"],
          "only the blocked walk's active request may be issued after revocation")
        assert.equal(f.state.prompts.length, 1)
      } finally {
        f.view.blockRead = undefined
        releaseAll()
      }
    }
    await revokeWhileWalkBlocked(() => f.call("goal_pause", {}))
    await f.call("goal_resume", {})
    f.view.list = [{ id: f.child, parentID: f.sid }]
    await f.idle()
    await revokeWhileWalkBlocked(() => f.cleanup?.())
  } finally {
    f.view.blockRead = undefined
    globalThis.fetch = originalFetch
  }
})

test("a pause then new arm cannot authorize the older admission decision", async t => {
  const f = await fixture(t)
  const pending = f.before("subagent", { agent: "general", sessionID: f.child })
  // Attach the rejection handler immediately, then exercise the user gate.
  const refusal = assert.rejects(pending, /Autonomous work refused/)
  await f.call("goal_pause", {})
  await f.call("goal_resume", {})
  await refusal
  await f.before("subagent", { agent: "general" })
})

test("accepted native dispatch rounds count once by call ID; unknown after does not count", async t => {
  const f = await fixture(t)
  await f.idle()
  await until(() => f.doc().turnsUsed === 1)
  const after = f.state.toolHooks.find(h => h.name === "execute.after").cb
  const event = { tool: "subagent", sessionID: f.sid, id: "accepted", status: "completed", result: { output: { sessionID: f.child, status: "running", output: "accepted" }, content: [], metadata: { status: "running", sessionID: f.child } } }
  await after(event)
  await after(event)
  await after({ ...event, id: "reused", result: {} })
  await after({ ...event, id: "reused" })
  const activity = v2WiringSeam.turnActivity.get(f.sid)
  assert.equal(activity.dispatches, 2)
  assert.equal(activity.writes, 2)
  await f.idle()
  await sleep(100)
  assert.equal(f.doc().turnsUsed, 1, "accepted child missing from list remains held")
  f.view.list = [{ id: f.child, parentID: f.sid, outcome: "succeeded" }]
  const receipt = (id, created) => ({ type: "assistant", time: { created }, content: [{ type: "tool", name: "subagent", id, state: { status: "completed", metadata: { sessionID: f.child } } }] })
  const result = (id, created) => ({ type: "synthetic", id, time: { created }, metadata: { source: "subagent", childID: f.child, state: "completed" }, text: '<background-result kind="subagent" sessionID="' + f.child + '" state="completed" description="work">done</background-result>' })
  f.view.transcript = [receipt("accepted", 1), result("result-1", 2), receipt("reused", 3)]
  await sleep(100)
  assert.equal(f.doc().turnsUsed, 1, "old terminal row cannot settle reused round")
  f.view.transcript.push(result("result-2", 4))
  await until(() => f.doc().turnsUsed === 2)
  assert.equal(f.doc().ledger[0].writes, 2)
  assert.equal(f.doc().ledger[0].activity, true)
  await after({ ...event, id: "error", status: "error" })
  await after(event) // late duplicate from earlier turn
  assert.equal(v2WiringSeam.turnActivity.get(f.sid).dispatches, undefined)
  await f.idle()
  await until(() => f.doc().turnsUsed === 3)
  assert.equal(f.doc().ledger[1].writes, 0)
  assert.equal(f.doc().ledger[1].activity, false)
  assert.equal(f.doc().status, "active")
})


test("owning-session running or unreadable active map defers settlement across duplicate idle edges", async t => {
  const f = await fixture(t)
  await f.idle()
  await until(() => f.doc().turnsUsed === 1)
  f.view.active = { [f.sid]: { type: "running" } }
  await f.idle()
  await sleep(100)
  await f.idle()
  await sleep(100)
  assert.equal(f.doc().ledger.length, 0)
  assert.equal(f.state.prompts.length, 1)
  f.view.active = []
  await sleep(100)
  assert.equal(f.doc().ledger.length, 0)
  assert.equal(f.doc().turnsUsed, 1)
  f.view.active = {}
  await until(() => f.doc().turnsUsed === 2)
  await sleep(100)
  assert.equal(f.doc().ledger.length, 1)
  assert.equal(f.state.prompts.length, 2)
  assert.equal(f.doc().status, "active")
})


test("a sole background-shell idle still enforces the minute deadline", async t => {
  const f = await fixture(t)
  const text = readFileSync(f.path(), "utf8")
  writeFileSync(f.path(), text.replace(/^armed_at: .*$/m, "armed_at: " + new Date(Date.now() - 59_800).toISOString()))
  await f.state.sessionHooks.find(h => h.name === "experimental.idle").cb({ sessionID: f.sid, background: [{ kind: "shell", sessionID: f.sid, shellID: "shell-1", command: "echo pending" }] })
  await until(() => f.doc().status === "paused")
  assert.equal(f.doc().stopReason, "budget-time")
  assert.equal(f.state.prompts.length, 0)
})

test("unknown child row cannot settle by disappearing", async t => {
  const f = await fixture(t)
  f.view.list = [{ id: f.child, parentID: f.sid }]
  await f.idle()
  await sleep(100)
  f.view.list = []
  await sleep(100)
  assert.equal(f.doc().turnsUsed, 0)
  f.view.list = [{ id: f.child, parentID: f.sid, outcome: "succeeded" }]
  await until(() => f.doc().turnsUsed === 1)
})


test("paused before decision cannot borrow a later resume authorization", async t => {
  const f = await fixture(t)
  await f.call("goal_pause", {})
  const pending = assert.rejects(f.before("subagent", { agent: "general", sessionID: f.child }), /Autonomous work refused/)
  await f.call("goal_resume", {})
  await pending
  await f.before("subagent", { agent: "general" })
})

test("revising an active held goal preserves its original minute deadline", async t => {
  const f = await fixture(t)
  f.view.list = null
  const text = readFileSync(f.path(), "utf8")
  writeFileSync(f.path(), text.replace(/^armed_at: .*$/m, "armed_at: " + new Date(Date.now() - 59_650).toISOString()))
  await f.idle()
  await sleep(100)
  await f.call("goal_write", { goal: "revised native waiting", criteria: ["done"], constraints: "sandbox only", checks: [{ shell: "echo done" }], revise: true })
  await until(() => f.doc().status === "paused")
  assert.equal(f.doc().revision, 2)
  assert.equal(f.doc().stopReason, "budget-time")
  assert.equal(f.state.prompts.length, 0)
})


test("blocked native HTTP observation cannot postpone revised goal deadline", async t => {
  const f = await fixture(t)
  let release
  f.view.blockRead = send => { release = send }
  const text = readFileSync(f.path(), "utf8")
  writeFileSync(f.path(), text.replace(/^armed_at: .*$/m, "armed_at: " + new Date(Date.now() - 59_600).toISOString()))
  await f.idle()
  await until(() => typeof release === "function")
  await f.call("goal_write", { goal: "revised blocked observation", criteria: ["done"], constraints: "sandbox only", checks: [{ shell: "echo done" }], revise: true })
  await until(() => f.doc().status === "paused")
  assert.equal(f.doc().stopReason, "budget-time")
  assert.equal(f.state.prompts.length, 0)
  f.view.blockRead = undefined
  release()
  await sleep(100)
  assert.equal(f.state.prompts.length, 0)
})

test("incomplete idle background cannot clear an observed shell wait", async t => {
  const f = await fixture(t)
  await f.idle()
  await until(() => f.doc().turnsUsed === 1)
  const hook = f.state.sessionHooks.find(h => h.name === "experimental.idle").cb
  await hook({ sessionID: f.sid, background: [{ kind: "shell", sessionID: f.sid, shellID: "shell-1", command: "echo pending" }] })
  await sleep(80)
  await hook({ sessionID: f.sid })
  await sleep(100)
  assert.equal(f.doc().turnsUsed, 1)
  assert.equal(f.doc().ledger.length, 0)
  await f.idle()
  await until(() => f.doc().turnsUsed === 2)
})


test("resume confirmation for paused revision cannot arm a revised contract", async t => {
  const f = await fixture(t)
  await f.call("goal_pause", {})
  let release
  f.view.blockAsk = input => input.action === "goal_resume" ? new Promise(resolve => { release = resolve }) : undefined
  const refused = assert.rejects(f.call("goal_resume", {}), /authorization changed while awaiting confirmation/)
  await until(() => typeof release === "function")
  await f.call("goal_write", { goal: "new paused contract", criteria: ["done"], constraints: "sandbox only", checks: [{ shell: "echo done" }], revise: true })
  assert.equal(f.doc().revision, 2)
  assert.equal(f.doc().status, "paused")
  f.view.blockAsk = undefined
  release()
  await refused
  assert.equal(f.doc().status, "paused")
  await f.call("goal_resume", {})
  assert.equal(f.doc().status, "active")
  assert.equal(f.doc().revision, 2)
})


test("late pre-pause native result cannot settle an overlapping post-resume call", async t => {
  const f = await fixture(t)
  const after = f.state.toolHooks.find(h => h.name === "execute.after").cb
  const accepted = id => ({ tool: "subagent", sessionID: f.sid, id, status: "completed", input: { agent: "general" }, result: { output: { sessionID: f.child, status: "running" }, metadata: { sessionID: f.child, status: "running" } } })
  const receipt = (id, created) => ({ type: "assistant", time: { created }, content: [{ type: "tool", name: "subagent", id, state: { status: "completed", metadata: { sessionID: f.child } } }] })
  await f.idle()
  await until(() => f.doc().turnsUsed === 1)
  await after(accepted("old-round"))
  f.view.transcript = [receipt("old-round", 1)]
  await f.call("goal_pause", {})
  await f.call("goal_resume", {})
  await after(accepted("new-round"))
  f.view.list = [{ id: f.child, parentID: f.sid, outcome: "succeeded" }]
  f.view.transcript.push(receipt("new-round", 2))
  await f.idle()
  await sleep(100)
  const before = f.doc()
  f.view.transcript.push({ type: "synthetic", id: "late-old-result", time: { created: 3 }, metadata: { source: "subagent", childID: f.child, state: "completed" }, text: '<background-result kind="subagent" sessionID="' + f.child + '" state="completed" description="work">old result</background-result>' })
  await sleep(150)
  assert.equal(f.state.prompts.length, 1)
  assert.equal(f.doc().turnsUsed, before.turnsUsed)
  assert.equal(f.doc().ledger.length, before.ledger.length)
})

test("new shell wait arriving during native observation wins over stale empty read", async t => {
  const f = await fixture(t)
  await f.idle()
  await until(() => f.doc().turnsUsed === 1)
  let release
  f.view.blockRead = send => { release = send }
  await f.idle()
  await until(() => typeof release === "function")
  const hook = f.state.sessionHooks.find(h => h.name === "experimental.idle").cb
  await hook({ sessionID: f.sid, background: [{ kind: "shell", sessionID: f.sid, shellID: "shell-1", command: "echo waiting" }] })
  await hook({ sessionID: f.sid })
  await sleep(80)
  f.view.blockRead = undefined
  release()
  await sleep(120)
  assert.equal(f.state.prompts.length, 1)
  assert.equal(f.doc().ledger.length, 0)
  await f.idle()
  await until(() => f.doc().turnsUsed === 2)
})


test("historical unobserved native receipt prevents attributing its delayed result to new round", async t => {
  const f = await fixture(t)
  const receipt = (id, created) => ({ type: "assistant", time: { created }, content: [{ type: "tool", name: "subagent", id, state: { status: "completed", metadata: { sessionID: f.child } } }] })
  await f.idle()
  await until(() => f.doc().turnsUsed === 1)
  const after = f.state.toolHooks.find(h => h.name === "execute.after").cb
  await after({ tool: "subagent", sessionID: f.sid, id: "new-round", status: "completed", input: { agent: "general" }, result: { output: { sessionID: f.child, status: "running" }, metadata: { sessionID: f.child, status: "running" } } })
  f.view.list = [{ id: f.child, parentID: f.sid, outcome: "succeeded" }]
  f.view.transcript = [receipt("unobserved-old-round", 1), receipt("new-round", 2), { type: "synthetic", id: "late-old-result", time: { created: 3 }, metadata: { source: "subagent", childID: f.child, state: "completed" }, text: '<background-result kind="subagent" sessionID="' + f.child + '" state="completed" description="work">old result</background-result>' }]
  await f.idle()
  await sleep(150)
  assert.equal(f.state.prompts.length, 1)
  assert.equal(f.doc().ledger.length, 0)
})
