import test from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { createServer } from "node:http"
import { createV2MockContext } from "./lib/v2-mock-context.mjs"
import { appendTerminalSection, parsePlan, rankActivePlans, transitionStatus } from "../src/plan-file.ts"
import { appendLedger, parseGoal } from "../src/goal-file.ts"
import { runChecks, setShellRunnerForTests } from "../src/run-check.ts"
import { resolveShell } from "../src/shell-select.ts"

process.env.FORGE_TEST_NO_FENCE = "1"
process.env.FORGE_TEST_NO_DISPATCH_FETCH = "1"
process.env.FORGE_GOAL_DEBOUNCE_MS = "10"
const root = mkdtempSync(join(tmpdir(), "forge-v2-goal-lifecycle-"))
process.env.FORGE_TEST_FORGE_HOME = join(root, "home")
process.env.OPENCODE_CONFIG_DIR = join(root, "host-config")
const { v2Setup, v2WiringSeam, resetServiceHttpDiscoveryForTests } = await import("../plugin.ts")
// Goal continuation needs an authoritative complete empty child view.
const host = createServer((req, res) => {
  res.setHeader("content-type", "application/json")
  res.end(JSON.stringify(req.url.startsWith("/api/session/active") ? {} : { data: [], cursor: {} }))
})
await new Promise(resolve => host.listen(0, "127.0.0.1", resolve))
const oldService = process.env.FORGE_SERVICE_FILE
process.env.FORGE_SERVICE_FILE = join(root, "service.json")
writeFileSync(process.env.FORGE_SERVICE_FILE, JSON.stringify({ url: `http://127.0.0.1:${host.address().port}`, password: "test" }))
resetServiceHttpDiscoveryForTests()
test.after(async () => {
  host.closeAllConnections?.()
  await new Promise(resolve => host.close(resolve))
  if (oldService === undefined) delete process.env.FORGE_SERVICE_FILE; else process.env.FORGE_SERVICE_FILE = oldService
  resetServiceHttpDiscoveryForTests()
  rmSync(root, { recursive: true, force: true })
})

const planArgs = () => ({
  goal: "supersedeable work",
  context: "recon found the entry point",
  approach: "direct edit; rejected the framework swap as too big",
  tasks: ["step one", "step two"],
  risks: "none",
  acceptance: ["it works", "it is fast"],
})
function planFile(wt) {
  const dir = join(wt, ".opencode", "plan")
  const names = readdirSync(dir).filter((f) => f.endsWith(".md"))
  assert.equal(names.length, 1)
  return { name: names[0], text: readFileSync(join(dir, names[0]), "utf8") }
}

// goal-mode.test.mjs:887-918
test("v2 plan_discard supersedes with one atomic narrative", async () => {
  const wt = mkdtempSync(join(root, "workspace-"))
  const { ctx, state } = createV2MockContext()
  const cleanup = await v2Setup(ctx, { anchors: [wt] })
  try {
    const toolCtx = { sessionID: "ses-v2-lifecycle-supersede", worktree: wt, agent: "forge", messageID: "m", callID: "c", metadata() {} }
    await state.tools.get("plan_write").execute(planArgs(), toolCtx)
    const before = planFile(wt)
    const out = await state.tools.get("plan_discard").execute(
      { reason: "work moved to crew orchestration", supersede: ".opencode/crew/2026-10-01-campaign.md" }, toolCtx,
    )
    const f = planFile(wt)
    assert.equal(parsePlan(f.text).status, "superseded", "supersede present -> superseded, never abandoned")
    const updated = f.text.match(/^updated: (.*)$/m)[1]
    assert.equal(f.text, appendTerminalSection(transitionStatus(before.text, "superseded", updated), "superseded", { reason: "work moved to crew orchestration", successor: ".opencode/crew/2026-10-01-campaign.md" }, updated))
    assert.ok(f.text.includes("reason: work moved to crew orchestration"))
    assert.ok(f.text.includes("successor: .opencode/crew/2026-10-01-campaign.md"))
    assert.match(out.content, /superseded/)
    assert.match(out.content, /— superseded/, "output names the appended section")
    assert.match(out.content, /successor/)
  } finally {
    await cleanup?.()
  }
})

const goalArgs = (overrides = {}) => ({
  goal: "make the suite green",
  criteria: ["npm test exits 0"],
  checks: [{ shell: "npm test" }, { containsFile: "done.txt", containsText: "done" }],
  constraints: "stay in the sandbox",
  ...overrides,
})
function goalFiles(wt) {
  const dir = join(wt, ".opencode", "goal")
  return readdirSync(dir).filter((f) => f.endsWith(".md")).map((name) => ({ name, text: readFileSync(join(dir, name), "utf8") }))
}
function liveDoc(wt) {
  const files = goalFiles(wt)
  assert.ok(files.length > 0, "expected a goal file")
  return { name: files[0].name, doc: parseGoal(files[0].text) }
}
let fixtureId = 0
async function fixture(fn, configure = () => {}) {
  const id = ++fixtureId
  const wt = mkdtempSync(join(root, "workspace-"))
  const { ctx, state } = createV2MockContext()
  configure(ctx, state)
  const cleanup = await v2Setup(ctx, { anchors: [wt] })
  const sid = `ses-v2-goal-${id}`
  const call = (name, args, sessionID = sid) => state.tools.get(name).execute(args, { sessionID, worktree: wt, agent: "forge", messageID: "m", callID: "c", metadata() {} })
  try { await fn({ wt, state, call, sid }) } finally { await cleanup?.() }
}

// goal-mode.test.mjs:156-166 (idle assertion separately noted in report)
test("v2 goal_write queues an inert goal", () => fixture(async ({ wt, state, call }) => {
  state.assertBehavior = "deny"
  const out = await call("goal_write", { ...goalArgs(), arm: false })
  const { doc } = liveDoc(wt)
  assert.equal(doc.status, "queued")
  assert.equal(doc.session, "")
  assert.match(out.content, /queued \(inert\)/)
  assert.deepEqual(state.asserts, [])
}))

// goal-mode.test.mjs:195-223: draft blocks arming but permits an inert queue.
test("v2 draft plan blocks goal arming while allowing an inert queue", () => fixture(async ({ wt, call }) => {
  await call("plan_write", planArgs())
  const plan = planFile(wt)
  await assert.rejects(call("goal_write", { ...goalArgs(), arm: true }), {
    message: `This session has a plan in draft (.opencode/plan/${plan.name}); autonomous execution cannot arm against the planning-phase write ban. Approve the plan (plan_approve) or discard it (/plan discard) first.`,
  })
  assert.equal(existsSync(join(wt, ".opencode", "goal")), false, "draft refusal must not create the goal directory")
  await call("goal_write", { ...goalArgs(), arm: false })
  const files = goalFiles(wt)
  assert.equal(files.length, 1)
  assert.equal(parseGoal(files[0].text).status, "queued")
  assert.equal(parsePlan(planFile(wt).text).status, "draft")
}))

// goal-mode.test.mjs:178-188
test("v2 goal_write refuses a second live goal", () => fixture(async ({ wt, call }) => {
  await call("goal_write", { ...goalArgs(), arm: true })
  await assert.rejects(call("goal_write", { ...goalArgs({ goal: "another" }), arm: true }), /already has a goal|edit|queue|discard/i)
  assert.equal(goalFiles(wt).length, 1)
}))

// goal-mode.test.mjs:226-242
test("v2 goal_write revises and preserves owner and budget", () => fixture(async ({ wt, state, call, sid }) => {
  const armed = await call("goal_write", { ...goalArgs({ maxTurns: 5 }), arm: true })
  assert.match(armed.content, /armed/)
  assert.equal(liveDoc(wt).doc.revision, 1)
  assert.equal(state.asserts.length, 1)
  assert.equal(state.asserts[0].action, "goal_write")
  assert.match(state.asserts[0].metadata.title, /^Arm goal:/)
  state.assertBehavior = "deny"
  const out = await call("goal_write", { ...goalArgs({ goal: "make the suite green and fast", criteria: ["npm test exits 0", "lint passes"] }), revise: true })
  assert.match(out.title, /rev 2/)
  const { doc } = liveDoc(wt)
  assert.equal(doc.revision, 2)
  assert.equal(doc.status, "active")
  assert.equal(doc.session, sid)
  assert.equal(doc.maxTurns, 5)
  assert.equal(doc.criteria.length, 2)
  assert.equal(state.asserts.length, 1, "revision does not ask again")
}))

// goal-mode.test.mjs:276-288
test("v2 goal_write revision preserves paused stop reason", () => fixture(async ({ wt, state, call }) => {
  await call("goal_write", { ...goalArgs(), arm: true })
  await call("goal_pause", { blocker: "waiting on an external API key" })
  assert.equal(liveDoc(wt).doc.status, "paused")
  state.assertBehavior = "deny"
  await call("goal_write", { ...goalArgs({ goal: "make the suite green once unblocked" }), revise: true })
  assert.deepEqual(state.asserts.map(a => a.action), ["goal_write"])
  const { doc, name } = liveDoc(wt)
  assert.equal(doc.status, "paused", "status stays paused across the revision")
  assert.equal(doc.stopReason, "blocker", "stop_reason survives the revision")
  assert.equal(doc.blocker, "waiting on an external API key")
  assert.match(readFileSync(join(wt, ".opencode", "goal", name), "utf8"), /^stop_reason: blocker$/m)
}))

// goal-mode.test.mjs:492-503 (persistence assertions)
test("v2 goal_pause records both stop reason variants", () => fixture(async ({ wt, state, call }) => {
  await call("goal_write", { ...goalArgs(), arm: true })
  state.assertBehavior = "deny"
  const out = await call("goal_pause", {})
  assert.match(out.content, /stop_reason: user/)
  state.assertBehavior = null
  await call("goal_resume", {})
  state.assertBehavior = "deny"
  const out2 = await call("goal_pause", { blocker: "auth service is down" })
  assert.deepEqual(state.asserts.map(a => a.action), ["goal_write", "goal_resume"])
  assert.match(out2.content, /stop_reason: blocker/)
  assert.match(goalFiles(wt)[0].text, /^stop_reason: blocker$/m)
  assert.equal(liveDoc(wt).doc.blocker, "auth service is down")
}))

// goal-mode.test.mjs:515-516,519-528 (allowed resume, not denial)
test("v2 goal_resume rebinds owner and caps budget", () => fixture(async ({ wt, state, call }) => {
  await call("goal_write", { ...goalArgs({ maxTurns: 10 }), arm: true })
  await call("goal_pause", {})
  const before = goalFiles(wt)[0].text
  state.assertBehavior = "deny"
  await assert.rejects(call("goal_resume", {}), /permission denied: goal_resume/)
  assert.equal(goalFiles(wt)[0].text, before)
  state.assertBehavior = null
  await call("goal_resume", { addTurns: 5 }, "ses-v2-resumer")
  const { doc } = liveDoc(wt)
  assert.equal(doc.status, "active")
  assert.equal(doc.session, "ses-v2-resumer", "ownership rebinds to the resuming session")
  assert.equal(doc.maxTurns, 15)
  state.assertBehavior = "deny"
  await call("goal_pause", {}, "ses-v2-resumer")
  state.assertBehavior = null
  await call("goal_resume", { addTurns: 99999 }, "ses-v2-resumer")
  assert.equal(liveDoc(wt).doc.maxTurns, 200)
  assert.deepEqual(state.asserts.map(a => a.action), ["goal_write", "goal_resume", "goal_resume", "goal_resume"])
}))

// goal-mode.test.mjs:563,566-570 (successful terminal transition)
test("v2 goal_discard preserves abandoned history", () => fixture(async ({ wt, state, call }) => {
  await call("goal_write", { ...goalArgs(), arm: true })
  const before = goalFiles(wt)[0].text
  state.assertBehavior = "deny"
  await assert.rejects(call("goal_discard", { reason: "wrong objective" }), /permission denied: goal_discard/)
  assert.equal(goalFiles(wt)[0].text, before)
  state.assertBehavior = null
  const out = await call("goal_discard", { reason: "wrong objective" })
  assert.match(out.content, /abandoned/)
  assert.match(goalFiles(wt)[0].text, /^status: abandoned$/m)
  await call("goal_write", { ...goalArgs({ goal: "fresh start" }), arm: false })
  assert.deepEqual(state.asserts.map(a => a.action), ["goal_write", "goal_discard", "goal_discard"])
}))

// goal-mode.test.mjs:925-953
test("v2 plan_discard records reason and missing reason", () => fixture(async ({ wt, call }) => {
  await call("plan_write", planArgs())
  const before = planFile(wt)
  const out = await call("plan_discard", { reason: "user cancelled the task" })
  const f = planFile(wt)
  assert.equal(parsePlan(f.text).status, "abandoned")
  assert.ok(f.text.includes("reason: user cancelled the task"), "reason verbatim in the artifact")
  assert.ok(!f.text.includes("successor:"), "no successor line on a plain discard")
  const updated = f.text.match(/^updated: (.*)$/m)[1]
  assert.equal(f.text, appendTerminalSection(transitionStatus(before.text, "abandoned", updated), "abandoned", { reason: "user cancelled the task" }, updated))
  assert.match(out.content, /— abandoned/)
  await call("plan_write", { ...planArgs(), goal: "second attempt" }, "ses-plan-second")
  await call("plan_discard", {}, "ses-plan-third")
  const others = readdirSync(join(wt, ".opencode", "plan")).filter((n) => n !== f.name)
  assert.equal(others.length, 1)
  const text2 = readFileSync(join(wt, ".opencode", "plan", others[0]), "utf8")
  assert.equal(parsePlan(text2).status, "abandoned")
  assert.ok(text2.includes("reason: (none given)"))
}))

// goal-mode.test.mjs:960-1009 (no checks are executed for this legacy plan)
test("v2 plan_close writes evidence summary with done status", () => fixture(async ({ wt, state, call }) => {
  await call("plan_write", planArgs())
  await call("plan_approve", {})
  await call("plan_tick", { n: 1 })
  await call("plan_tick", { n: 2 })
  const before = planFile(wt)
  const beforeAsserts = state.asserts.length
  const checks = [{ criterion: "it works", pass: true, evidence: "node --test: 2 pass" }, { criterion: "it is fast", pass: true, evidence: "bench p95 12ms" }]
  const out = await call("plan_close", { checks })
  assert.equal(state.asserts.length, beforeAsserts, "close must fire ZERO ask events")
  const f = planFile(wt)
  assert.equal(parsePlan(f.text).status, "done")
  const updated = f.text.match(/^updated: (.*)$/m)[1]
  assert.equal(f.text, appendTerminalSection(transitionStatus(before.text, "done", updated), "closed", { reason: "completion gate passed (plugin-verified)", checks }, updated))
  assert.ok(f.text.includes("reason: completion gate passed (plugin-verified)"))
  assert.ok(f.text.includes("- PASS — it works"))
  assert.ok(f.text.includes("  evidence: node --test: 2 pass"))
  assert.ok(f.text.includes("- PASS — it is fast"))
  assert.match(out.content, /— closed/, "output names the appended section")
  assert.match(out.content, /plugin-verified/, "output announces the plugin-verified gate")
}))

// goal-mode.test.mjs:1027-1038
test("v2 plan_discard whitespace supersede abandons", () => fixture(async ({ wt, call }) => {
  await call("plan_write", { ...planArgs(), goal: "blank supersede case" })
  const out = await call("plan_discard", { reason: "moved on", supersede: "   " })
  const f = planFile(wt)
  assert.equal(parsePlan(f.text).status, "abandoned", "a whitespace-only supersede is treated as absent (S2 trade-off)")
  assert.ok(!f.text.includes("successor:"), "no successor line without a real successor value")
  assert.match(out.content, /— abandoned/, "the output announces the abandoned exit, never superseded")
}))

function planEntries(wt) {
  const dir = join(wt, ".opencode", "plan")
  return readdirSync(dir).filter((name) => name.endsWith(".md")).map((name) => ({ name, text: readFileSync(join(dir, name), "utf8") }))
}
const passRunner = async () => ({ code: 0, output: "ok", timedOut: false })

// goal-mode.test.mjs:249-268; fake runner prevents external commands.
test("v2 goal revision preserves check log and turn ledger", () => fixture(async ({ wt, state, call }) => {
  setShellRunnerForTests(passRunner)
  try {
    await call("goal_write", { ...goalArgs(), arm: true })
    await call("goal_check", {})
    const file = goalFiles(wt)[0]
    writeFileSync(join(wt, ".opencode", "goal", file.name), appendLedger(file.text, { turn: 1, revision: 1, at: "2026-09-25T10:00:00+08:00", activity: true, writes: 2, checks: 1 }, "2026-09-25T10:00:00+08:00"))
    state.assertBehavior = "deny"
    await call("goal_write", { ...goalArgs({ goal: "make the suite greener" }), revise: true })
    assert.deepEqual(state.asserts.map(a => a.action), ["goal_write"])
    const after = goalFiles(wt)[0]
    const doc = parseGoal(after.text)
    assert.equal(doc.revision, 2, "revision bumped")
    assert.equal(doc.log.length, 2, "both rev1 Check Log lines survive the revision")
    assert.match(doc.log[0], /rev1 #1 OK .*`npm test`/)
    assert.equal(doc.ledger.length, 1, "the rev1 Turn Ledger entry survives the revision")
    assert.match(after.text, /- turn 1 rev1 .*activity=yes \(writes=2 checks=1\)/)
  } finally { setShellRunnerForTests(null) }
}))

// goal-mode.test.mjs:299-315; fake runner prevents external commands.
test("v2 goal_check records numbered revision checks", () => fixture(async ({ wt, call }) => {
  writeFileSync(join(wt, "done.txt"), "done\n")
  setShellRunnerForTests(passRunner)
  try {
    await call("goal_write", { ...goalArgs(), arm: true })
    const out = await call("goal_check", {})
    assert.match(out.content, /2\/2|#1 \[PASS\]/)
    const text = goalFiles(wt)[0].text
    assert.match(text, /run=\S+ rev1 #1 OK .*`npm test`/)
    assert.match(text, /rev1 #2 OK .*`done.txt :: done`/)
    const out2 = await call("goal_check", { items: [2] })
    assert.match(out2.content, /#2 \[PASS\]/)
    await assert.rejects(call("goal_check", { items: [9] }), /None of the given item numbers/)
  } finally { setShellRunnerForTests(null) }
}))

// goal-mode.test.mjs:398-416; fake failing runner, no external execution.
test("v2 goal_complete fails closed when checks fail", () => fixture(async ({ wt, state, call }) => {
  setShellRunnerForTests(async () => ({ code: 1, output: "boom", timedOut: false }))
  try {
    await call("goal_write", { ...goalArgs(), arm: true })
    const assertions = state.asserts.length
    await assert.rejects(call("goal_complete", { attestations: [{ criterion: "npm test exits 0", pass: true, evidence: "x" }] }), /fail-closed|FAIL/)
    assert.equal(state.asserts.length, assertions, "user gate must not be reached on failing checks")
    assert.deepEqual(state.asserts.map(a => a.action), ["goal_write"])
    assert.equal(liveDoc(wt).doc.status, "active")
  } finally { setShellRunnerForTests(null) }
}))

// goal-mode.test.mjs:323-329
test("v2 goal_check requires a live goal", () => fixture(async ({ call }) => {
  await assert.rejects(call("goal_check", {}), /No live goal/)
}))

// goal-mode.test.mjs:424-440; the checks are faked, not run externally.
test("v2 goal_complete rejects incomplete or failing attestations", () => fixture(async ({ wt, call }) => {
  writeFileSync(join(wt, "done.txt"), "done\n")
  setShellRunnerForTests(passRunner)
  try {
    await call("goal_write", { ...goalArgs(), arm: true })
    await assert.rejects(call("goal_complete", { attestations: [] }), /no self-attestation/)
    await assert.rejects(call("goal_complete", { attestations: [{ criterion: "npm test exits 0", pass: false, evidence: "still red" }] }), /unmet/)
    assert.equal(liveDoc(wt).doc.status, "active")
  } finally { setShellRunnerForTests(null) }
}))

// goal-mode.test.mjs:448-463; fake runner prevents external commands.
test("v2 goal_complete records successful final checks", () => fixture(async ({ wt, state, call }) => {
  writeFileSync(join(wt, "done.txt"), "done\n")
  setShellRunnerForTests(passRunner)
  try {
    await call("goal_write", { ...goalArgs(), arm: true })
    const out = await call("goal_complete", { attestations: [{ criterion: "npm test exits 0", pass: true, evidence: "exit 0, 42 tests" }] })
    assert.match(out.content, /completed/)
    const text = goalFiles(wt)[0].text
    assert.match(text, /^status: completed$/m)
    assert.match(text, /rev1 #1 OK/, "final gate re-run recorded")
    assert.deepEqual(state.asserts.map(a => a.action), ["goal_write", "goal_complete"])
  } finally { setShellRunnerForTests(null) }
}))

// goal-mode.test.mjs:471-480
test("v2 goal_complete requires active goal", () => fixture(async ({ call }) => {
  await call("goal_write", { ...goalArgs(), arm: true })
  await call("goal_pause", {})
  await assert.rejects(call("goal_complete", { attestations: [{ criterion: "npm test exits 0", pass: true, evidence: "x" }] }), /No active goal/)
}))

// goal-mode.test.mjs:535-551
test("v2 goal_resume promotes oldest queued goal", () => fixture(async ({ wt, call, sid }) => {
  await call("goal_write", { ...goalArgs({ goal: "first queued" }), arm: false }, `${sid}-first`)
  await new Promise((resolve) => setTimeout(resolve, 5))
  await call("goal_write", { ...goalArgs({ goal: "second queued" }), arm: false }, `${sid}-second`)
  const promoter = `${sid}-promoter`
  await call("goal_resume", {}, promoter)
  const active = goalFiles(wt).find((f) => parseGoal(f.text).status === "active")
  assert.ok(active, "one goal must be active")
  assert.match(active.name, /first-queued/, "the OLDEST queued goal is promoted")
  assert.equal(parseGoal(active.text).session, promoter)
}))

// goal-mode.test.mjs:1093-1123; commands are persisted, not executed.
test("v2 plan_write renders and parses verification checks", () => fixture(async ({ wt, call }) => {
  const out = await call("plan_write", { ...planArgs(), goal: "structured checks plan", checks: [{ shell: "npm test" }, { shell: "echo hi", timeoutSec: 5 }, { containsFile: "done.txt", containsText: "done" }] })
  const f = planFile(wt)
  assert.ok(f.text.includes("## Verification Checks"), "checks section rendered")
  assert.ok(f.text.includes("1. shell `npm test` (timeout 120s)"))
  assert.ok(f.text.includes("2. shell `echo hi` (timeout 5s)"))
  assert.ok(f.text.includes("3. contains `done.txt` :: `done`"))
  assert.ok(f.text.includes("## Check Log"), "check log section present from creation")
  assert.ok(f.text.includes("(no checks recorded yet)"))
  assert.deepEqual(parsePlan(f.text).checks, [{ kind: "shell", cmd: "npm test", timeoutSec: 120 }, { kind: "shell", cmd: "echo hi", timeoutSec: 5 }, { kind: "contains", file: "done.txt", text: "done" }])
  assert.match(out.content, /Verification Checks: 3 items/)
}))

// goal-mode.test.mjs:1214-1252
test("v2 plan_reopen rebinds and allows a second close", () => fixture(async ({ wt, call, sid }) => {
  await call("plan_write", { ...planArgs(), goal: "reopenable work" })
  await call("plan_approve", {})
  await call("plan_tick", { n: 1 })
  await call("plan_tick", { n: 2 })
  await call("plan_close", { checks: [{ criterion: "it works", pass: true, evidence: "e" }, { criterion: "it is fast", pass: true, evidence: "e" }] })
  const sid2 = `${sid}-reopen`
  const out = await call("plan_reopen", { reason: "user read the evidence and asked for more" }, sid2)
  const f = planFile(wt)
  assert.equal(parsePlan(f.text).status, "approved", "reopen flips done -> approved")
  assert.ok(f.text.includes("— reopened"), "dated reopened section appended")
  assert.ok(f.text.includes("reason: user read the evidence and asked for more"), "reopen reason verbatim")
  assert.match(out.content, /done -> approved/)
  assert.match(out.content, /2\/2 tasks still ticked/)
  await call("plan_close", { checks: [{ criterion: "it works", pass: true, evidence: "e2" }, { criterion: "it is fast", pass: true, evidence: "e2" }] }, sid2)
  const reclosed = planFile(wt)
  assert.equal(parsePlan(reclosed.text).status, "done", "frontmatter status is the single current truth")
  const closeHeadings = reclosed.text.match(/^## .+ — closed$/gm)
  assert.equal(closeHeadings.length, 2, "a second close appends a SECOND dated close section")
  await assert.rejects(() => call("plan_close", {}, `${sid}-third`), /No plan to close\./)
}))

// goal-mode.test.mjs:1260-1290
test("v2 superseded plan is terminal and fresh draft is discovered", () => fixture(async ({ wt, call, sid }) => {
  await call("plan_write", { ...planArgs(), goal: "the superseded ancestor" })
  await call("plan_discard", { reason: "work moved to the crew", supersede: ".opencode/crew/2026-10-01-campaign.md" })
  const ancestor = planFile(wt)
  assert.equal(parsePlan(ancestor.text).status, "superseded")
  assert.deepEqual(rankActivePlans(planEntries(wt)), [])
  await assert.rejects(() => call("plan_approve", {}), /No plan awaiting approval\. Create one with plan_write first\./)
  const sid2 = `${sid}-successor`
  await call("plan_write", { ...planArgs(), goal: "the fresh successor plan" }, sid2)
  const ranked = rankActivePlans(planEntries(wt))
  assert.equal(ranked.length, 1)
  assert.equal(ranked[0].doc.status, "draft")
  assert.equal(ranked[0].doc.goal, "the fresh successor plan")
  await call("plan_approve", {}, sid2)
  const successor = planEntries(wt).find((e) => e.text.includes("goal: the fresh successor plan"))
  assert.equal(parsePlan(successor.text).status, "approved")
  assert.equal(parsePlan(ancestor.text).status, "superseded", "the terminal ancestor stays frozen")
}))

// goal-mode.test.mjs:1045-1081
test("v2 terminal outputs relay exact dated sections", () => fixture(async ({ wt, state, call, sid }) => {
  const sidA = `${sid}-discard`
  await call("plan_write", { ...planArgs(), goal: "relay the discard section" }, sidA)
  const outA = await call("plan_discard", { reason: "user cancelled" }, sidA)
  const fA = planEntries(wt).find((e) => e.text.includes("goal: relay the discard section"))
  const headingA = fA.text.match(/^## (.+ — abandoned)$/m)[1]
  assert.ok(outA.content.includes(`## ${headingA}`), "the discard output carries the exact dated section heading from disk")
  const sidB = `${sid}-close`
  await call("plan_write", { ...planArgs(), goal: "relay the close section" }, sidB)
  await call("plan_approve", {}, sidB)
  await call("plan_tick", { n: 1 }, sidB)
  await call("plan_tick", { n: 2 }, sidB)
  state.assertBehavior = "deny"
  const outB = await call("plan_close", { checks: [{ criterion: "it works", pass: true, evidence: "node --test: 2 pass" }, { criterion: "it is fast", pass: true, evidence: "bench p95 12ms" }] }, sidB)
  const fB = planEntries(wt).find((e) => e.text.includes("goal: relay the close section"))
  const headingB = fB.text.match(/^## (.+ — closed)$/m)[1]
  assert.ok(outB.content.includes(`## ${headingB}`), "the close output carries the exact dated section heading from disk")
  assert.match(outB.content, /plugin-verified/)
  assert.ok(fB.text.includes("- PASS — it works"), "evidence summary verdicts live on disk")
  assert.ok(fB.text.includes("  evidence: node --test: 2 pass"))
}))

const idle = async (state, sid, background = []) => {
  const hook = state.sessionHooks.find((h) => h.name === "experimental.idle")
  assert.ok(hook, "the experimental.idle hook is registered")
  await hook.cb({ sessionID: sid, background })
  await new Promise((resolve) => setTimeout(resolve, 80))
}

test("v2 paused goal suppresses repeated idle and pending debounce", () => fixture(async ({ wt, state, call, sid }) => {
  await call("goal_write", { ...goalArgs(), arm: true })
  v2WiringSeam.crews.set(sid, { objective: "review benign notes", subtasks: [{ title: "read notes" }], mode: "executing", startedAt: new Date().toISOString(), recordPath: null })
  const hook = state.sessionHooks.find((h) => h.name === "experimental.idle")
  await hook.cb({ sessionID: sid, background: [] })
  await call("goal_pause", { blocker: "waiting for user input" })
  const paused = goalFiles(wt)[0].text
  await idle(state, sid)
  await idle(state, sid)
  assert.equal(state.prompts.length, 0)
  assert.equal(goalFiles(wt)[0].text, paused)
  v2WiringSeam.crews.delete(sid) // crew registration is process-local
  v2WiringSeam.sessions.delete(sid)
  state.sessionRecords.set(sid, { location: { directory: wt } })
  await idle(state, sid)
  await idle(state, sid)
  assert.equal(state.prompts.length, 0, "lazy rebind from disk stays paused")
  assert.equal(goalFiles(wt)[0].text, paused)
  state.assertBehavior = "deny"
  await assert.rejects(() => call("goal_resume", {}), /denied/i)
  assert.equal(goalFiles(wt)[0].text, paused)
  state.assertBehavior = null
  const before = state.asserts.length
  await call("goal_resume", {})
  assert.equal(state.asserts.length, before + 1)
  assert.equal(liveDoc(wt).doc.status, "active")
  assert.equal(liveDoc(wt).doc.blocker, undefined)
  assert.doesNotMatch(goalFiles(wt)[0].text, /^blocker:/m)
}))

test("v2 paused goal accounts the accepted blocking prompt without reactivation", () => {
  let release, started
  const waiting = new Promise(resolve => { started = resolve })
  return fixture(async ({ wt, state, call, sid }) => {
    await call("goal_write", { ...goalArgs(), arm: true })
    const hook = state.sessionHooks.find(h => h.name === "experimental.idle")
    await hook.cb({ sessionID: sid, background: [] })
    await waiting
    await afterTool(state, sid, "write")
    await call("goal_pause", { blocker: "waiting for user input" })
    release()
    await idle(state, sid)
    await idle(state, sid)
    assert.equal(state.prompts.length, 1, "only the already-admitted prompt")
    const doc = liveDoc(wt).doc
    assert.equal(doc.status, "paused")
    assert.equal(doc.stopReason, "blocker")
    assert.equal(doc.blocker, "waiting for user input")
    assert.equal(doc.turnsUsed, 1)
    assert.equal(doc.ledger.length, 1)
    assert.equal(doc.ledger[0].writes, 1)
    const settled = goalFiles(wt)[0].text
    await idle(state, sid)
    assert.equal(goalFiles(wt)[0].text, settled)
  }, (ctx, state) => {
    ctx.session.prompt = async input => {
      state.prompts.push(input)
      await new Promise(resolve => { release = resolve; started() })
    }
  })
})

test("v2 completed goal accounts the accepted blocking prompt exactly once", () => {
  let release, started
  const waiting = new Promise(resolve => { started = resolve })
  return fixture(async ({ wt, state, call, sid }) => {
    writeFileSync(join(wt, "done.txt"), "done\n")
    setShellRunnerForTests(passRunner)
    try {
      await call("goal_write", { ...goalArgs(), arm: true })
      v2WiringSeam.crews.set(sid, { objective: "review notes", subtasks: [{ title: "one" }], mode: "executing", startedAt: new Date().toISOString(), recordPath: null, goalGoverned: true })
      await state.sessionHooks.find(h => h.name === "experimental.idle").cb({ sessionID: sid, background: [] })
      await waiting
      await afterTool(state, sid, "goal_check")
      await call("goal_complete", { attestations: [{ criterion: "npm test exits 0", pass: true, evidence: "synthetic fixture" }] })
      release()
      await idle(state, sid)
      await idle(state, sid)
      const doc = liveDoc(wt).doc
      assert.equal(doc.status, "completed")
      assert.equal(doc.turnsUsed, 1)
      assert.equal(doc.ledger.length, 1)
      assert.equal(doc.ledger[0].checks, 1)
      assert.equal(state.prompts.length, 1)
    } finally { setShellRunnerForTests(null) }
  }, (ctx, state) => {
    ctx.session.prompt = async input => {
      state.prompts.push(input)
      await new Promise(resolve => { release = resolve; started() })
    }
  })
})

// goal-mode.test.mjs:167-171
test("v2 queued goal does not continue on idle", () => fixture(async ({ state, call, sid }) => {
  await call("goal_write", { ...goalArgs(), arm: false })
  await idle(state, sid)
  assert.equal(state.prompts.length, 0)
}))

// goal-mode.test.mjs:700-720
test("v2 goal turn budget pauses after one wrapup", () => fixture(async ({ wt, state, call, sid }) => {
  await call("goal_write", { ...goalArgs({ maxTurns: 1 }), arm: true })
  await idle(state, sid)
  assert.equal(state.prompts.length, 1, "the single budgeted continuation")
  assert.match(goalFiles(wt)[0].text, /^turns_used: 1$/m)
  await idle(state, sid)
  assert.equal(state.prompts.length, 2, "exactly one wrap-up prompt")
  assert.match(state.prompts[1].text, /\[forge:goal-wrapup\]/)
  const { doc } = liveDoc(wt)
  assert.equal(doc.status, "paused")
  assert.equal(doc.stopReason, "budget-turns")
  await idle(state, sid)
  assert.equal(state.prompts.length, 2)
}))

// goal-mode.test.mjs:1373-1392
test("v2 promotion refreshes old queued goal wall-clock budget", () => fixture(async ({ wt, state, call, sid }) => {
  await call("goal_write", { ...goalArgs({ maxMinutes: 5 }), arm: false })
  const file = goalFiles(wt)[0]
  const goalPath = join(wt, ".opencode", "goal", file.name)
  const old = new Date(Date.now() - 30 * 60_000).toISOString()
  writeFileSync(goalPath, readFileSync(goalPath, "utf8").replace(/^created:.*$/m, `created: ${old}`))
  const sidB = `${sid}-promoter`
  await call("goal_resume", {}, sidB)
  await idle(state, sidB)
  assert.equal(state.prompts.length, 1, "fresh armed_at must let the promoted goal continue instead of budget-pausing on stale created")
  assert.match(goalFiles(wt)[0].text, /^turns_used: 1$/m)
}))

const afterTool = (state, sid, tool) => state.toolHooks.find((h) => h.name === "execute.after").cb({ tool, sessionID: sid, id: "c", input: {} })

// goal-mode.test.mjs:132-149,581-606,658-667,1493
test("v2 active goal continues only its owner and persists the ledger", () => fixture(async ({ wt, state, call, sid }) => {
  const out = await call("goal_write", { ...goalArgs(), arm: true })
  const { doc } = liveDoc(wt)
  assert.equal(doc.status, "active")
  assert.equal(doc.session, sid)
  assert.equal(doc.revision, 1)
  assert.match(out.content, /armed/)
  await idle(state, `${sid}-other`)
  assert.equal(state.prompts.length, 0)
  await idle(state, sid)
  assert.equal(state.prompts.length, 1)
  const prompt = state.prompts[0]
  assert.equal(prompt.sessionID, sid)
  assert.equal(prompt.agent, undefined)
  assert.match(prompt.text, /\[forge:goal-continue\]/)
  assert.match(prompt.text, /make the suite green/)
  assert.match(prompt.text, /shell `npm test`/)
  assert.match(prompt.text, /0\/25 turns used/)
  assert.equal(liveDoc(wt).doc.turnsUsed, 1)
  await idle(state, sid)
  assert.equal(state.prompts.length, 2)
  assert.match(goalFiles(wt)[0].text, /- turn 1 rev1 \S+ activity=no \(writes=0 checks=0\)/)
  assert.equal(liveDoc(wt).doc.turnsUsed, 2)
}))

test("v2 continuation brief distinguishes structured crew contracts from plain goals", async () => {
  for (const [criteria, prefer] of [
    [["forge-plugindev-coder lands the wiring tests", "suite stays green"], true],
    [["npm test exits 0"], false],
  ]) {
    await fixture(async ({ state, call, sid }) => {
      await call("goal_write", { ...goalArgs({ criteria }), arm: true })
      await idle(state, sid)
      assert.equal(state.prompts.length, 1)
      const brief = state.prompts[0].text
      assert.match(brief, /Crew layer: you own it under this goal/)
      if (prefer) assert.match(brief, /PREFER re-registering it as a born-armed crew/)
      else assert.doesNotMatch(brief, /PREFER/)
    })
  }
})

// goal-mode.test.mjs:727-793; native shell activity is simulated, never executed.
for (const [tool, writes, checks] of [["write", 1, 0], ["shell", 1, 1]]) {
  test(`v2 no-progress streak resets on ${tool}, then pauses after two empty turns`, () => fixture(async ({ wt, state, call, sid }) => {
    await call("goal_write", { ...goalArgs({ maxTurns: 10 }), arm: true })
    await idle(state, sid)
    assert.match(state.prompts[0].text, /Per-turn discipline/)
    assert.match(state.prompts[0].text, /meaningful read-only reconnaissance and review/)
    await idle(state, sid)
    assert.equal(liveDoc(wt).doc.status, "active")
    await afterTool(state, sid, tool)
    await idle(state, sid)
    assert.equal(state.prompts.length, 3)
    const doc = liveDoc(wt).doc
    assert.equal(doc.status, "active")
    assert.equal(doc.ledger.at(-1).activity, true)
    assert.equal(doc.ledger.at(-1).writes, writes)
    assert.equal(doc.ledger.at(-1).checks, checks)
    await idle(state, sid)
    assert.equal(liveDoc(wt).doc.status, "active")
    await idle(state, sid)
    assert.equal(liveDoc(wt).doc.status, "paused")
    assert.equal(liveDoc(wt).doc.stopReason, "no-progress")
    assert.match(state.prompts.at(-1).text, /\[forge:goal-wrapup\]/)
    const count = state.prompts.length
    await idle(state, sid)
    assert.equal(state.prompts.length, count)
    await call("goal_resume", {})
    await idle(state, sid)
    await idle(state, sid)
    assert.equal(liveDoc(wt).doc.status, "active", "resume resets the old no-progress streak")
    assert.equal(state.prompts.length, count + 2)
  }))
}

for (const waitingEdges of [1, 3]) {
  test(`v2 ${waitingEdges} waiting idle edges do not prematurely settle accepted turn evidence`, () => fixture(async ({ wt, state, call, sid }) => {
    await call("goal_write", { ...goalArgs({ maxTurns: 10 }), arm: true })
    await idle(state, sid)
    await idle(state, sid) // one confirmed empty turn
    const background = [{ kind: "shell", sessionID: sid, shellID: "sh_1", command: "npm test" }]
    for (let i = 0; i < waitingEdges; i++) {
      await idle(state, sid, background)
      const doc = liveDoc(wt).doc
      assert.equal(doc.status, "active")
      assert.equal(doc.turnsUsed, 2)
      assert.equal(doc.ledger.length, 1, "outstanding turn must not be settled yet")
      assert.equal(state.prompts.length, 2)
    }
    await afterTool(state, sid, "write") // late evidence on the accepted turn
    await idle(state, sid)
    const doc = liveDoc(wt).doc
    assert.equal(doc.ledger.length, 2)
    assert.equal(doc.ledger.at(-1).activity, true)
    assert.equal(doc.ledger.at(-1).writes, 1)
    assert.equal(doc.status, "active")
    await call("goal_pause", { blocker: "waiting for user input" })
    const paused = goalFiles(wt)[0].text
    await idle(state, sid, background)
    await idle(state, sid)
    assert.equal(goalFiles(wt)[0].text, paused)
    assert.equal(state.prompts.length, 3)
  }))
}

test("v2 waiting with no observed activity does not add to the existing stagnation streak", () => fixture(async ({ wt, state, call, sid }) => {
  await call("goal_write", { ...goalArgs({ maxTurns: 10 }), arm: true })
  await idle(state, sid)
  await idle(state, sid)
  const background = [{ kind: "shell", sessionID: sid, shellID: "sh_1", command: "npm test" }]
  await idle(state, sid, background)
  await idle(state, sid, background)
  await idle(state, sid)
  assert.equal(liveDoc(wt).doc.status, "active")
  assert.equal(liveDoc(wt).doc.ledger.length, 2)
  assert.equal(state.prompts.length, 3)
  await idle(state, sid)
  assert.equal(liveDoc(wt).doc.stopReason, "no-progress")
}))

test("v2 explicit pause during outstanding waiting preserves accepted turn and suppresses late idles", () => fixture(async ({ wt, state, call, sid }) => {
  await call("goal_write", { ...goalArgs(), arm: true })
  await idle(state, sid)
  const background = [{ kind: "shell", sessionID: sid, shellID: "sh_1", command: "npm test" }]
  await idle(state, sid, background)
  await afterTool(state, sid, "write")
  await call("goal_pause", { blocker: "waiting for user input" })
  const doc = liveDoc(wt).doc
  assert.equal(doc.status, "paused")
  assert.equal(doc.turnsUsed, 1)
  assert.equal(doc.ledger.length, 1)
  assert.equal(doc.ledger[0].writes, 1)
  const paused = goalFiles(wt)[0].text
  await idle(state, sid, background)
  await idle(state, sid)
  assert.equal(goalFiles(wt)[0].text, paused)
  assert.equal(state.prompts.length, 1)
}))

test("v2 minute limit pauses during outstanding waiting without a wrap-up prompt", () => fixture(async ({ wt, state, call, sid }) => {
  await call("goal_write", { ...goalArgs({ maxMinutes: 1 }), arm: true })
  await idle(state, sid)
  const background = [{ kind: "shell", sessionID: sid, shellID: "sh_1", command: "npm test" }]
  await idle(state, sid, background)
  const realNow = Date.now
  try {
    Date.now = () => realNow() + 61_000
    await idle(state, sid, background)
  } finally {
    Date.now = realNow
  }
  const doc = liveDoc(wt).doc
  assert.equal(doc.stopReason, "budget-time")
  assert.equal(doc.status, "paused")
  assert.equal(doc.turnsUsed, 1)
  assert.equal(doc.ledger.length, 1)
  await idle(state, sid, background)
  await idle(state, sid)
  assert.equal(state.prompts.length, 1)
}))

// goal-mode.test.mjs:758-795: native read and shell evidence accounting.
test("v2 read and shell evidence distinguish changed, identical and truncated checks", () => fixture(async ({ wt, state, call, sid }) => {
  await call("goal_write", { ...goalArgs({ maxTurns: 15 }), arm: true })
  await idle(state, sid)
  await idle(state, sid)
  let id = 0
  const observe = async (tool, input, output) => {
    await state.toolHooks.find((h) => h.name === "execute.after").cb({ tool, sessionID: sid, id: `evidence-${++id}`, input, output })
    await idle(state, sid)
    return liveDoc(wt).doc.ledger.at(-1)
  }
  assert.equal((await observe("read", { filePath: "notes.txt" }, { output: "evidence" })).activity, true)
  const check = (text, exitCode, truncated = false) => observe("shell", { command: "npm test" }, { output: text, metadata: { exitCode, truncated } })
  assert.equal((await check("fail", 1)).activity, true)
  assert.equal((await check("pass", 0)).activity, true)
  assert.equal((await check("pass", 0)).activity, false)
  await check("pass", 0, true)
  assert.equal(liveDoc(wt).doc.status, "active", "truncated evidence cannot establish repetition")
  assert.equal((await observe("shell", { command: "git commit -m done" }, { output: "committed", metadata: { exitCode: 0, truncated: false } })).activity, true)
  await check("pass", 0)
  await check("pass", 0)
  const last = await check("pass", 0)
  assert.equal(last.activity, false)
  assert.equal(last.checks, 1)
  assert.equal(liveDoc(wt).doc.stopReason, "no-progress")
  assert.match(state.prompts.at(-1).text, /Repeated identical check/)
}))

test("v2 default goal_check credits changed and incomplete results, not identical complete checks", () => fixture(async ({ wt, state, call, sid }) => {
  let result = { code: 0, output: "first", timedOut: false }
  setShellRunnerForTests(async () => result)
  try {
    writeFileSync(join(wt, "done.txt"), "done")
    await call("goal_write", { ...goalArgs({ maxTurns: 15 }), arm: true })
    await idle(state, sid)
    let id = 0
    const check = async (args = {}) => {
      const output = await call("goal_check", args)
      await state.toolHooks.find((h) => h.name === "execute.after").cb({ tool: "goal_check", sessionID: sid, id: `check-${++id}`, input: args, output })
      await idle(state, sid)
      return liveDoc(wt).doc.ledger.at(-1)
    }
    assert.equal((await check()).activity, true)
    assert.equal((await check()).activity, false)
    result = { ...result, output: "changed" }
    assert.equal((await check()).activity, true)
    assert.equal((await check()).activity, false)
    result = { ...result, output: "x".repeat(3000) }
    // D11: incomplete output is unknown, not proof of new activity or repetition.
    // The ledger has only a boolean; verify that uncertainty does not pause the goal.
    await check()
    await check()
    assert.equal(liveDoc(wt).doc.status, "active", "incomplete checks cannot prove repetition")
    result = { ...result, output: "changed" }
    assert.equal((await check()).activity, true)
    assert.equal((await check({ items: [1] })).activity, true, "different selected checks")
    assert.equal((await check({ items: [1] })).activity, false)
    const last = await check({ items: [1] })
    assert.equal(last.activity, false)
    assert.equal(last.checks, 1)
    assert.equal(liveDoc(wt).doc.stopReason, "no-progress")
  } finally { setShellRunnerForTests(null) }
}))

// Reduced from candidate2-goal-check-repeat-observed.log: inner after precedes
// the CodeMode wrapper, with different call IDs but the same message/session.
test("v2 CodeMode goal_check text parts repeat without losing the check ledger", () => fixture(async ({ wt, state, call, sid }) => {
  setShellRunnerForTests(async () => ({ code: 0, output: "GOAL_CHECK_OK", timedOut: false }))
  try {
    await call("goal_write", { ...goalArgs({ maxTurns: 15 }), arm: true })
    await idle(state, sid)
    const after = state.toolHooks.find(h => h.name === "execute.after").cb
    for (let i = 1; i <= 3; i++) {
      const input = { items: [1] }, messageID = `message-${i}`
      const result = await call("goal_check", input)
      const text = result.content
      const calls = [{ tool: "goal_check", status: "completed", input }]
      await after({ tool: "goal_check", codemode: true, sessionID: sid, messageID, id: `inner-${i}`, input, status: "completed", result: { content: [{ type: "text", text }] } })
      await after({ tool: "execute", codemode: false, sessionID: sid, messageID, id: `outer-${i}`, input: { code: "return await tools.goal_check({items:[1]})" }, status: "completed", result: { output: { output: text, toolCalls: calls, files: [] }, content: [{ type: "text", text }], metadata: { toolCalls: calls } } })
      await idle(state, sid)
      const doc = liveDoc(wt).doc
      assert.equal(doc.ledger.at(-1).activity, i === 1, `turn ${i}`)
      assert.equal(doc.ledger.at(-1).checks, 1)
    }
    assert.equal(liveDoc(wt).doc.stopReason, "no-progress")
    const text = goalFiles(wt)[0].text
    const checkLog = text.split("## Check Log")[1].split("## Turn Ledger")[0]
    assert.equal((checkLog.match(/rev1 #1 OK/g) ?? []).length, 3)
    assert.match(state.prompts.at(-1).text, /Repeated identical check/)
  } finally { setShellRunnerForTests(null) }
}))

test("v2 CodeMode missing raw inner input does not correlate to run-all", () => fixture(async ({ wt, state, call, sid }) => {
  setShellRunnerForTests(async () => ({ code: 0, output: "same", timedOut: false }))
  try {
    writeFileSync(join(wt, "done.txt"), "done")
    await call("goal_write", { ...goalArgs({ maxTurns: 15 }), arm: true })
    await idle(state, sid)
    const after = state.toolHooks.find(h => h.name === "execute.after").cb
    for (let i = 1; i <= 4; i++) {
      const { content: text } = await call("goal_check", {})
      const calls = [{ tool: "goal_check", status: "completed", input: {} }]
      const messageID = `missing-input-${i}`
      await after({ tool: "goal_check", codemode: true, sessionID: sid, messageID, id: `inner-${i}`, status: "completed", result: { content: [{ type: "text", text }] } })
      await after({ tool: "execute", codemode: false, sessionID: sid, messageID, id: `outer-${i}`, input: { code: "return await tools.goal_check({})" }, status: "completed", result: { output: { output: text, toolCalls: calls, files: [] }, content: [{ type: "text", text }], metadata: { toolCalls: calls } } })
      await idle(state, sid)
    }
    const doc = liveDoc(wt).doc
    assert.equal(doc.status, "active", "missing raw input cannot prove repeated run-all")
    assert.notEqual(doc.stopReason, "no-progress")
  } finally { setShellRunnerForTests(null) }
}))

// goal-mode.test.mjs:800-820
test("v2 three consecutive transport failures pause; resume starts a fresh streak", () => {
  let fails = 0
  let failing = true
  return fixture(async ({ wt, state, call, sid }) => {
    await call("goal_write", { ...goalArgs({ maxTurns: 10 }), arm: true })
    for (let i = 1; i <= 3; i++) {
      await idle(state, sid)
      assert.equal(fails, i)
      assert.equal(liveDoc(wt).doc.status, i < 3 ? "active" : "paused")
    }
    assert.equal(liveDoc(wt).doc.stopReason, "transport-failures")
    await idle(state, sid)
    assert.equal(fails, 3)
    await call("goal_resume", {})
    await idle(state, sid)
    assert.equal(fails, 4)
    assert.equal(liveDoc(wt).doc.status, "active")
    failing = false
    await idle(state, sid)
    assert.equal(state.prompts.length, 1)
  }, (ctx) => {
    const prompt = ctx.session.prompt
    ctx.session.prompt = async (input) => {
      if (failing) { fails++; throw new Error("connection refused (mock)") }
      return prompt(input)
    }
  })
})

// goal-mode.test.mjs:827-854 (draft-conflict persistence only)
test("v2 draft conflict pauses without injecting a continuation", () => fixture(async ({ wt, state, call, sid }) => {
  await call("goal_write", { ...goalArgs(), arm: true })
  await call("plan_write", planArgs())
  await assert.rejects(state.toolHooks.find(h => h.name === "execute.before").cb({ tool: "write", sessionID: sid, agent: "forge", input: {} }), /\[forge\] A plan is in draft/)
  await idle(state, sid)
  assert.equal(state.prompts.length, 0)
  assert.equal(liveDoc(wt).doc.status, "paused")
  assert.equal(liveDoc(wt).doc.stopReason, "draft-conflict")
}))

// goal-mode.test.mjs:1421-1444
test("v2 completion turn is ledgered after terminal transition", () => fixture(async ({ wt, state, call, sid }) => {
  writeFileSync(join(wt, "done.txt"), "done\n")
  setShellRunnerForTests(passRunner)
  try {
    await call("goal_write", { ...goalArgs(), arm: true })
    await idle(state, sid)
    assert.equal(state.prompts.length, 1)
    // A complete legacy string result is real check evidence; an empty hook
    // notification would be unknown and cannot assert activity=yes under D11.
    const output = await call("goal_check", {})
    await state.toolHooks.find(h => h.name === "execute.after").cb({ tool: "goal_check", sessionID: sid, id: "complete-check", input: {}, output })
    await call("goal_complete", { attestations: [{ criterion: "npm test exits 0", pass: true, evidence: "fake runner" }] })
    assert.equal(liveDoc(wt).doc.status, "completed")
    await idle(state, sid)
    assert.match(goalFiles(wt)[0].text, /- turn 1 rev1 \S+ activity=yes \(writes=0 checks=1\)/)
    assert.equal(state.prompts.length, 1)
  } finally { setShellRunnerForTests(null) }
}))

// goal-mode.test.mjs:1300-1347 (v2 context and compaction hooks)
test("v2 compaction brief and active/paused goal notices coexist with plan notice", () => fixture(async ({ state, call, sid }) => {
  await call("goal_write", { ...goalArgs(), arm: true })
  const compaction = state.sessionHooks.find((h) => h.name === "compaction").cb
  const ev = { sessionID: sid, context: [] }
  await compaction(ev)
  assert.equal(ev.context.length, 1)
  assert.match(ev.context[0], /\[forge:goal-brief\]/)
  assert.match(ev.context[0], /make the suite green/)
  const other = { sessionID: `${sid}-other`, context: [] }
  await compaction(other)
  assert.deepEqual(other.context, [])
  await call("plan_write", planArgs())
  const context = state.sessionHooks.find((h) => h.name === "context").cb
  const active = { sessionID: sid, agent: "forge", system: [] }
  await context(active)
  assert.ok(active.system.find((s) => s.includes("[forge:plan-notice]")))
  assert.match(active.system.find((s) => s.includes("[forge:goal-notice]")), /status: active/)
  await call("goal_pause", {})
  const paused = { sessionID: sid, agent: "forge", system: [] }
  await context(paused)
  const notice = paused.system.find((s) => s.includes("[forge:goal-notice]"))
  assert.match(notice, /stopped: user/)
  assert.match(notice, /goal_resume/)
}))

// goal-mode.test.mjs:1130-1173; approved checks, fake runner only.
test("v2 approved plan close re-runs frozen checks and records evidence", () => fixture(async ({ wt, state, call }) => {
  await call("plan_write", { ...planArgs(), checks: [{ shell: "echo alpha" }] })
  await call("plan_approve", {})
  await call("plan_tick", { n: 1 })
  await call("plan_tick", { n: 2 })
  const approved = planFile(wt)
  writeFileSync(join(wt, ".opencode", "plan", approved.name), approved.text.replace("1. shell `echo alpha` (timeout 120s)", "1. shell `echo alpha` (timeout 120s)\n2. shell `echo beta` (timeout 120s)"))
  const cmds = []
  setShellRunnerForTests(async (cmd) => { cmds.push(cmd); return { code: 0, output: `ran ${cmd}`, timedOut: false } })
  try {
    const before = state.asserts.length
    const out = await call("plan_close", { checks: [{ criterion: "it works", pass: true, evidence: "extra human-readable evidence" }] })
    assert.equal(state.asserts.length, before)
    assert.deepEqual(cmds, ["echo alpha", "echo beta"])
    const closed = planFile(wt)
    assert.equal(parsePlan(closed.text).status, "done")
    assert.match(closed.text, /reason: completion gate passed \(plugin-verified\)/)
    assert.match(closed.text, /- #1 OK \(\d+ms\) `echo alpha`/)
    assert.match(closed.text, /- #2 OK \(\d+ms\) `echo beta`/)
    assert.match(closed.text, /output: exit=0 ran echo alpha/)
    assert.match(closed.text, /- PASS — it works/)
    assert.match(out.content, /2 frozen verification items re-run passing/)
  } finally { setShellRunnerForTests(null) }
}))

// goal-mode.test.mjs:1181-1206; no actual shell invocation.
test("v2 frozen check failure keeps approved plan and retry closes", () => fixture(async ({ wt, call }) => {
  await call("plan_write", { ...planArgs(), checks: [{ shell: "npm test" }] })
  await call("plan_approve", {})
  await call("plan_tick", { n: 1 })
  await call("plan_tick", { n: 2 })
  setShellRunnerForTests(async () => ({ code: 1, output: "boom", timedOut: false }))
  try {
    await assert.rejects(call("plan_close", {}), /fail-closed[\s\S]*Fix the work and retry/)
    const refused = planFile(wt)
    assert.equal(parsePlan(refused.text).status, "approved")
    assert.match(refused.text, /- \S+ run=\S+ #1 FAIL \(\d+ms\) `npm test` :: exit=1 boom/)
    assert.ok(!refused.text.includes("(no checks recorded yet)"))
    setShellRunnerForTests(passRunner)
    const out = await call("plan_close", {})
    assert.equal(parsePlan(planFile(wt).text).status, "done")
    assert.match(out.content, /— closed/)
  } finally { setShellRunnerForTests(null) }
}))

// Migrate the actual runner smoke tests from goal-mode.test.mjs:336-395,1504-1514.
// Each command invokes only the current Node interpreter and our own fixture.
function nodeCommand(script) {
  const { family } = resolveShell()
  const bin = process.execPath
  if (family === "ps") return `& '${bin.replaceAll("'", "''")}' ${script}`
  if (family === "cmd") return `"${bin}" ${script}`
  return `'${bin.replaceAll("'", "'\\''")}' ${script}`
}
function runnerFixture(wt) {
  writeFileSync(join(wt, "done.txt"), "all done\n")
  writeFileSync(join(wt, "check.mjs"), `import { readFileSync } from "node:fs"; console.log(readFileSync("done.txt", "utf8").trim(), "cwd-marker");`)
  writeFileSync(join(wt, "fail.mjs"), `console.error("nonzero-marker"); process.exit(3);`)
  writeFileSync(join(wt, "slow.mjs"), `setTimeout(() => {}, 8000);`)
  return { pass: nodeCommand("check.mjs"), fail: nodeCommand("fail.mjs"), slow: nodeCommand("slow.mjs") }
}

test("v2 real goal runner: cwd, native exit status, file hit/miss/missing and boundary", () => fixture(async ({ wt, state, call }) => {
  const cmd = runnerFixture(wt)
  await call("goal_write", goalArgs({ arm: true, checks: [
    { shell: cmd.pass }, { shell: cmd.fail },
    { containsFile: "done.txt", containsText: "all done" },
    { containsFile: "done.txt", containsText: "not there" },
    { containsFile: "missing.txt", containsText: "x" },
    { containsFile: "../escape.txt", containsText: "x" },
  ] }))
  const before = state.asserts.length
  const out = await call("goal_check", {})
  assert.match(out.content, /#1 \[PASS\][\s\S]*all done cwd-marker/)
  assert.match(out.content, /#2 \[FAIL\][\s\S]*exit=3 nonzero-marker/)
  assert.match(out.content, /#3 \[PASS\]/)
  assert.match(out.content, /#4 \[FAIL\][\s\S]*not found/)
  assert.match(out.content, /#5 \[FAIL\][\s\S]*cannot read file/)
  assert.match(out.content, /#6 \[FAIL\][\s\S]*escapes the workspace/)
  await assert.rejects(call("goal_complete", { attestations: [{ criterion: "npm test exits 0", pass: true, evidence: "not a substitute" }] }), /fail-closed/)
  assert.equal(state.asserts.length, before)
  assert.equal(liveDoc(wt).doc.status, "active")
  assert.equal(liveDoc(wt).doc.log.length, 12, "completion actually re-runs all six checks")
}))

test("v2 real goal runner: timeout fails completion before ask", () => fixture(async ({ wt, state, call }) => {
  const cmd = runnerFixture(wt)
  await call("goal_write", goalArgs({ arm: true, checks: [{ shell: cmd.slow, timeoutSec: 2 }] }))
  const before = state.asserts.length
  const started = Date.now()
  const out = await call("goal_check", {})
  assert.match(out.content, /#1 \[FAIL\][\s\S]*timed out after 2s/)
  assert.ok(Date.now() - started < 7000, "must not wait for the 8s fixture")
  await assert.rejects(call("goal_complete", { attestations: [{ criterion: "npm test exits 0", pass: true, evidence: "x" }] }), /timed out after 2s/)
  assert.equal(state.asserts.length, before)
  assert.equal(liveDoc(wt).doc.status, "active")
}))

test("v2 real plan runner: frozen mixed checks fail closed, then retry without ask", () => fixture(async ({ wt, state, call }) => {
  const cmd = runnerFixture(wt)
  await call("plan_write", { ...planArgs(), checks: [
    { shell: cmd.pass }, { shell: cmd.fail }, { shell: cmd.slow, timeoutSec: 2 },
    { containsFile: "required.txt", containsText: "ready" },
  ] })
  await call("plan_approve", {})
  await call("plan_tick", { n: 1 })
  await call("plan_tick", { n: 2 })
  const frozen = parsePlan(planFile(wt).text).checks
  const before = state.asserts.length
  await assert.rejects(call("plan_close", { checks: [{ criterion: "it works", pass: true, evidence: "cannot replace frozen checks" }] }), /fail-closed/)
  const failed = planFile(wt).text
  assert.equal(parsePlan(failed).status, "approved")
  assert.deepEqual(parsePlan(failed).checks, frozen)
  assert.match(failed, /#1 OK .*cwd-marker/)
  assert.match(failed, /#2 FAIL .*exit=3 nonzero-marker/)
  assert.match(failed, /#3 FAIL .*timed out after 2s/)
  assert.match(failed, /#4 FAIL .*cannot read file/)
  assert.equal(state.asserts.length, before)
  writeFileSync(join(wt, "fail.mjs"), `console.log("repaired");`)
  writeFileSync(join(wt, "slow.mjs"), `console.log("fast now");`)
  writeFileSync(join(wt, "required.txt"), "ready")
  await call("plan_close", {})
  const closed = planFile(wt).text
  assert.equal(parsePlan(closed).status, "done")
  assert.deepEqual(parsePlan(closed).checks, frozen)
  assert.match(closed, /#4 OK .*required.txt/)
  assert.equal(state.asserts.length, before)
}))

test("v2 goal final gate re-reads fixture and asks only after all checks pass", () => fixture(async ({ wt, state, call }) => {
  const cmd = runnerFixture(wt)
  await call("goal_write", goalArgs({ arm: true, checks: [{ shell: cmd.pass }, { containsFile: "done.txt", containsText: "all done" }] }))
  const attestations = [{ criterion: "npm test exits 0", pass: true, evidence: "fixture checked" }]
  const before = state.asserts.length
  assert.match((await call("goal_check", {})).content, /#2 \[PASS\]/)
  writeFileSync(join(wt, "done.txt"), "changed")
  await assert.rejects(call("goal_complete", { attestations }), /required text not found/)
  assert.equal(state.asserts.length, before)
  writeFileSync(join(wt, "done.txt"), "all done")
  await call("goal_complete", { attestations })
  assert.equal(state.asserts.length, before + 1)
  assert.equal(state.asserts.at(-1).action, "goal_complete")
  assert.equal(liveDoc(wt).doc.status, "completed")
  assert.equal(liveDoc(wt).doc.log.length, 6)
}))

test("shared real runner propagates native exit status through host interpreter", () => fixture(async ({ wt }) => {
  const cmd = runnerFixture(wt)
  const [out] = await runChecks([{ kind: "shell", cmd: cmd.fail, timeoutSec: 60 }], wt)
  assert.equal(out.ok, false)
  assert.match(out.detail, /exit=3 nonzero-marker/)
}))
