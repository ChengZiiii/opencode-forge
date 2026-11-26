import test from "node:test"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, relative } from "node:path"
import { createV2MockContext } from "./lib/v2-mock-context.mjs"
import { crewNativeView } from "./lib/crew-native-view.mjs"

// All persistence and config inputs belong to this synthetic fixture.
const root = mkdtempSync(join(tmpdir(), "forge-crew-record-"))
process.env.FORGE_TEST_FORGE_HOME = join(root, "home")
process.env.FORGE_TEST_RUNTIME_DIR = join(root, "runtime")
process.env.OPENCODE_CONFIG_DIR = join(root, "config")
process.env.FORGE_TEST_NO_FENCE = "1"
const { v2Setup, v2WiringSeam, resetServiceHttpDiscoveryForTests } = await import("../plugin.ts")
const native = await crewNativeView(root, resetServiceHttpDiscoveryForTests)
test.after(async () => { await native.close(); rmSync(root, { recursive: true, force: true }) })

async function fixture(fn, blocked = false) {
  v2WiringSeam.resetHostAnchors()
  const wt = mkdtempSync(join(root, "workspace-"))
  mkdirSync(join(wt, ".opencode"))
  writeFileSync(join(wt, ".opencode", "forge.json"), JSON.stringify({ pool: "record", agents: { research: { model: "zai/glm", thoughtLevel: "low" } } }))
  if (blocked) writeFileSync(join(wt, ".opencode", "crew"), "not a directory")
  const { ctx, state } = createV2MockContext()
  const sid = `ses_crew_record_${randomUUID()}`
  state.sessionRecords.set(sid, { id: sid, worktree: wt, directory: wt })
  const cleanup = await v2Setup(ctx, { anchors: [wt], materialize: "runtime" })
  const call = (name, args) => state.tools.get(name).execute(args, { sessionID: sid, agent: "forge", messageID: "m", callID: randomUUID(), metadata() {} })
  const crew = () => v2WiringSeam.crews.get(sid)
  try { await fn({ wt, state, ctx, sid, call, crew }) } finally { native.view.rows = []; native.view.active = {}; await cleanup?.(); v2WiringSeam.resetHostAnchors(); rmSync(wt, { recursive: true, force: true }) }
}

test("v2 crew close associates a deduplicated native dispatch and its actual result", () => fixture(async ({ state, ctx, sid, call, crew }) => {
  await call("crew_begin", { objective: "verify fallback", subtasks: [{ title: "alpha" }] })
  await call("crew_begin", { execution: "waves" })
  const report = [{ title: "alpha", verdict: "PASS", evidence: "native fallback verified tests" }]
  const after = state.toolHooks.find(h => h.name === "execute.after").cb
  const metadata = { sessionID: "ses_child", status: "running" }
  const dispatch = { tool: "subagent", sessionID: sid, id: "call_alpha", status: "completed", input: { agent: "general", description: "alpha", prompt: "tests" }, result: { output: { ...metadata, output: "The subagent is working in the background" }, content: [{ type: "text", text: "The subagent is working in the background" }], metadata } }
  await after(dispatch)
  await after(dispatch)
  assert.equal(crew().rounds.length, 1)
  native.view.rows = [{ id: "ses_child", parentID: sid, outcome: "succeeded" }]
  const messages = [{ type: "assistant", time: { created: 1 }, content: [{ type: "tool", name: "subagent", id: "call_alpha", state: { status: "completed", metadata } }] }]
  ctx.session.context = async () => messages
  await assert.rejects(() => call("crew_close", { report }), /verified successful round evidence/)
  messages.unshift({ type: "synthetic", time: { created: 2 }, metadata: { source: "subagent", childID: "ses_child", state: "completed" }, text: '<background-result kind="subagent" sessionID="ses_child" state="completed" description="alpha">\nTests green.\n</background-result>' })
  const path = crew().recordPath
  assert.match((await call("crew_close", { report })).content, /PASS/)
  assert.match(readFileSync(path, "utf8"), /alpha: call_alpha → ses_child \(general, native fallback\)/)
}))

// forge-subagents-wiring: declared plan, record header, output order, relay.
test("v2 crew registration persists the declared plan and explicit lineage", () => fixture(async ({ wt, call, crew }) => {
  const subtasks = [{ title: "alpha", agent: "forge-record-research" }, { title: "beta" }]
  const lineage = ".opencode/plan/synthetic.md"
  for (const invalid of [[], [{ title: "same" }, { title: "same" }], [{ title: "same" }, { title: " Same " }]]) {
    await assert.rejects(() => call("crew_begin", { objective: "invalid", subtasks: invalid }), /subtasks|unique/)
    assert.equal(crew(), undefined)
  }
  const { content } = await call("crew_begin", { objective: "keep records", subtasks, lineage })
  assert.match(content, /convert to a goal contract/)
  assert.match(content, /standby/)
  assert.match(content, /END YOUR TURN/)
  assert.doesNotMatch(content, /Proceed with the discipline/)
  assert.deepEqual(crew().subtasks, subtasks)
  assert.equal(crew().mode, "pending")
  const path = crew().recordPath
  assert.equal(dirname(path), join(wt, ".opencode", "crew"))
  assert.match(path, /\.md$/)
  assert.equal(readdirSync(dirname(path)).length, 1)
  const record = readFileSync(path, "utf8")
  assert.match(record, /^# Crew Record: keep records\n/)
  assert.ok(record.includes(`- anchor: ${wt}\n- lineage: ${lineage}\n`))
  assert.match(record, /- registered: \S+\n- anchor:/)
  assert.match(record, /## Declared plan \(2\)\n1\. alpha → forge-record-research\n2\. beta/)
  assert.match(record, /^## \S+ — registered \(pending\)$/m)
  const sections = ["Crew record (inspectable history", "Lineage: " + lineage, "RELAY RULE:", "Objective: keep records", "Declared plan (2)", "RELAY FIRST", "1. supervised waves NOW"]
  let previous = -1
  for (const section of sections) {
    const at = content.indexOf(section)
    assert.ok(at > previous, section)
    previous = at
  }
  assert.ok(content.includes(`RELAY RULE: this crew descends from ${lineage} — every dispatch prompt must explicitly carry the artifact path (or its exact slice), and every close-report evidence statement must name the contract it worked against.`))
  assert.ok(content.includes(relative(wt, path).replaceAll("\\", "/")))
  assert.match(content, /RELAY FIRST: tell the user the crew record path/)
  await assert.rejects(() => call("crew_begin", { objective: "another", subtasks }), /already has an active crew/)
  assert.equal(readFileSync(path, "utf8"), record)
}))

test("v2 draft plan blocks crew registration until approval", () => fixture(async ({ state, call, crew }) => {
  await call("plan_write", { goal: "gate exits", context: "c", approach: "a", tasks: ["t1"], risks: "r", acceptance: ["a1"] })
  const args = { objective: "register after approval", subtasks: [{ title: "x" }] }
  await assert.rejects(() => call("crew_begin", args), (err) => {
    const message = String(err)
    assert.match(message, /plan is in draft/)
    assert.match(message, /plan_approve/)
    assert.match(message, /an APPROVED plan does not block \/crew/)
    assert.match(message, /\/plan discard abandons the plan outright/)
    assert.match(message, /\/plan discard \{supersede:/)
    return true
  })
  assert.equal(crew(), undefined)
  assert.equal(state.asserts.length, 0)
  await call("plan_approve", {})
  const { content } = await call("crew_begin", args)
  assert.match(content, /registered PENDING/)
  assert.equal(crew().mode, "pending")
}))

test("v2 invalid crew registration cannot create a record", () => fixture(async ({ wt, call, crew }) => {
  const registration = { objective: "invalid registration", subtasks: [{ title: "one" }] }
  await assert.rejects(() => call("crew_begin", { ...registration, execution: "waves" }), /cannot self-arm outside a governing goal/)
  await assert.rejects(() => call("crew_begin", { ...registration, execution: "goal" }), /converts an already-registered/)
  await assert.rejects(() => call("crew_begin", { execution: "waves" }), /No active crew to arm/)
  await assert.rejects(() => call("crew_begin", { execution: "fast" }), /execution must be/)
  assert.equal(crew(), undefined)
  assert.ok(!readdirSync(join(wt, ".opencode")).includes("crew"))
}))

// Ordinary report validation only: no native round settlement is simulated here.
test("v2 crew close validates reports and appends verdict and evidence history", () => fixture(async ({ state, call, crew }) => {
  await call("crew_begin", { objective: "close the record", subtasks: [{ title: "alpha" }, { title: "beta" }] })
  const path = crew().recordPath
  const registered = readFileSync(path, "utf8")
  const result = await call("crew_begin", { execution: "waves" })
  assert.match(result.content, /ARMED for supervised waves/)
  assert.match(result.content, /existing user approval rules/)
  assert.match(result.content, /Native fallback: when the pool offers no forge worker fitting a subtask/)
  assert.match(result.content, /RECORD the fallback/)
  assert.match(result.content, /native `subagent` calls made together/)
  assert.match(result.content, /every work round of the previous wave is verified settled/)
  await assert.rejects(() => call("crew_begin", { execution: "waves" }), /already armed/)
  const armed = readFileSync(path, "utf8")
  assert.ok(armed.startsWith(registered))
  assert.match(armed.slice(registered.length), /^## \S+ — armed \(waves\)$/m)
  const alpha = { title: "alpha", verdict: "PASS", evidence: "synthetic tests green" }
  const beta = { title: "beta", verdict: "fail", evidence: "both attempts failed", attempts: ["attempt one", "retry one"] }
  for (const [report, error] of [
    [[alpha], /silently dropped/],
    [[alpha, beta, { ...alpha, title: "gamma" }], /renegade/],
    [[alpha, { ...beta, evidence: " " }], /missing evidence/],
    [[alpha, { ...beta, verdict: "maybe" }], /verdict must be PASS or FAIL/],
    [[alpha, { ...beta, attempts: ["attempt one"] }], /both failure reports/],
    [[alpha, alpha, beta], /duplicate report entry/],
  ]) {
    await assert.rejects(() => call("crew_close", { report }), error)
    assert.equal(crew().mode, "executing")
    assert.equal(readFileSync(path, "utf8"), armed)
  }
  state.assertBehavior = "deny"
  await assert.rejects(() => call("crew_close", { report: [alpha, beta] }), /denied/i)
  assert.equal(crew().mode, "executing")
  assert.equal(readFileSync(path, "utf8"), armed)
  state.assertBehavior = null
  const { content } = await call("crew_close", { report: [alpha, beta] })
  assert.equal(crew(), undefined)
  const closed = readFileSync(path, "utf8")
  assert.ok(closed.startsWith(armed))
  assert.match(closed.slice(armed.length), /^## \S+ — closed$/m)
  for (const text of ["subtasks: 2 (PASS 1, FAIL 1)", "- alpha: PASS — synthetic tests green", "- beta: FAIL — both attempts failed"]) {
    assert.ok(closed.includes(text), text)
    assert.ok(content.includes(text), text)
  }
  assert.ok(content.includes(path))
  await assert.rejects(() => call("crew_close", { report: [alpha, beta] }), /No active crew/)
  assert.equal(readFileSync(path, "utf8"), closed)
}))

test("v2 pending crew close retains report validation and history", () => fixture(async ({ call, crew }) => {
  await call("crew_begin", { objective: "close pending record", subtasks: [{ title: "alpha" }, { title: "beta" }] })
  const path = crew().recordPath
  const before = readFileSync(path, "utf8")
  const alpha = { title: "alpha", verdict: "PASS", evidence: "tests green" }
  const beta = { title: "beta", verdict: "fail", evidence: "both attempts failed", attempts: ["attempt one", "retry one"] }
  await assert.rejects(() => call("crew_close", { report: [alpha] }), /declared plan|silently dropped/)
  await assert.rejects(() => call("crew_close", { report: [alpha, beta, { ...alpha, title: "gamma" }] }), /renegade|declared plan/)
  assert.equal(readFileSync(path, "utf8"), before)
  const { content } = await call("crew_close", { report: [alpha, beta] })
  assert.match(content, /PASS 1, FAIL 1/)
  assert.equal(crew(), undefined)
  const closed = readFileSync(path, "utf8")
  assert.ok(closed.startsWith(before))
  assert.match(closed, /^## \S+ — closed$/m)
  assert.match(closed, /subtasks: 2 \(PASS 1, FAIL 1\)/)
  assert.match(closed, /- alpha: PASS — tests green/)
  assert.match(closed, /- beta: FAIL — both attempts failed/)
}))

test("v2 crew abandon appends history from pending and executing and permits fresh registration", () => fixture(async ({ state, call, crew }) => {
  let earlierPath, earlierHistory
  for (const mode of ["pending", "executing"]) {
    const { content } = await call("crew_begin", { objective: "reshard", subtasks: [{ title: "one" }] })
    assert.doesNotMatch(content, /Lineage:|RELAY RULE/)
    const path = crew().recordPath
    assert.notEqual(path, earlierPath)
    if (earlierPath) assert.equal(readFileSync(earlierPath, "utf8"), earlierHistory)
    if (mode === "executing") await call("crew_begin", { execution: "waves" })
    const before = readFileSync(path, "utf8")
    assert.doesNotMatch(before, /^- lineage:/m)
    state.assertBehavior = "deny"
    await assert.rejects(() => call("crew_close", { abandon: true, reason: "wrong decomposition" }), /denied/i)
    assert.equal(crew().mode, mode)
    assert.equal(readFileSync(path, "utf8"), before)
    state.assertBehavior = "allow"
    const result = await call("crew_close", { abandon: true, reason: "wrong decomposition" })
    assert.match(result.content, /ABANDONED/)
    assert.ok(result.content.includes(`mode at abandon: ${mode}`))
    assert.equal(crew(), undefined)
    const after = readFileSync(path, "utf8")
    assert.ok(after.startsWith(before))
    assert.match(after.slice(before.length), /^## \S+ — abandoned$/m)
    assert.ok(after.includes(`mode at abandon: ${mode}\nreason: wrong decomposition`))
    earlierPath = path
    earlierHistory = after
  }
}))

test("v2 crew conversion appends a terminal record without verdicts", () => fixture(async ({ call, crew }) => {
  await call("crew_begin", { objective: "convert the plan", subtasks: [{ title: "one", agent: "forge-record-research" }] })
  const path = crew().recordPath
  const before = readFileSync(path, "utf8")
  const { content } = await call("crew_begin", { execution: "goal" })
  assert.match(content, /CONVERSION record/)
  assert.match(content, /goal_write with arm=true/)
  assert.match(content, /one → forge-record-research/)
  assert.match(content, /BORN-ARMED crew in ONE call/)
  assert.match(content, /Preserve the subtask STRUCTURE/)
  assert.match(content, /Born-armed registration sketch/)
  assert.equal(crew(), undefined)
  const after = readFileSync(path, "utf8")
  assert.ok(after.startsWith(before))
  assert.match(after.slice(before.length), /^## \S+ — converted to goal$/m)
  assert.match(after.slice(before.length), /1\. one → forge-record-research/)
}))

test("v2 crew registration is fail-soft when the record directory is blocked", () => fixture(async ({ call, crew }) => {
  const { content } = await call("crew_begin", { objective: "no record", subtasks: [{ title: "one" }] })
  assert.match(content, /could not be written \(fail-soft/)
  assert.equal(crew().recordPath, null)
  assert.equal(crew().mode, "pending")
  await call("crew_begin", { execution: "waves" })
  const closed = await call("crew_close", { report: [{ title: "one", verdict: "PASS", evidence: "synthetic result" }] })
  assert.match(closed.content, /nothing persists/)
  assert.equal(crew(), undefined)
}, true))

test("v2 crew records follow the session workspace rather than the setup directory", () => fixture(async ({ wt, call, crew }) => {
  const other = mkdtempSync(join(root, "other-"))
  mkdirSync(join(other, ".opencode"))
  writeFileSync(join(other, ".opencode", "forge.json"), JSON.stringify({ pool: "other", agents: { research: { model: "zai/glm", thoughtLevel: "low" } } }))
  const second = createV2MockContext()
  const cleanup = await v2Setup(second.ctx, { anchors: [other], materialize: "runtime" })
  try {
    await call("crew_begin", { objective: "keep records", subtasks: [{ title: "one" }] })
    const path = crew().recordPath
    assert.equal(dirname(path), join(wt, ".opencode", "crew"))
    assert.match(readFileSync(path, "utf8"), /# Crew Record: keep records/)
    await call("crew_begin", { execution: "waves" })
    assert.match(readFileSync(path, "utf8"), /armed \(waves\)/)
    await call("crew_close", { report: [{ title: "one", verdict: "PASS", evidence: "ok" }] })
    assert.match(readFileSync(path, "utf8"), /one: PASS/)
    assert.ok(!readdirSync(join(other, ".opencode")).includes("crew"))
  } finally {
    await cleanup?.()
    rmSync(other, { recursive: true, force: true })
  }
}))
