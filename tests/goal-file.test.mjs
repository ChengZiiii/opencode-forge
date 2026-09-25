import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  GoalError,
  appendCheckLog,
  appendLedger,
  atomicWrite,
  budgetState,
  bumpBudget,
  carryHistory,
  canTransitionGoal,
  completeCheckFailures,
  goalFileName,
  incTurns,
  isGoalLive,
  isGoalTerminal,
  parseGoal,
  parseGoalLoose,
  rankLiveGoals,
  rankQueuedGoals,
  renderGoal,
  slugifyGoal,
  transitionGoal,
} from "../src/goal-file.ts"

const NOW = "2026-09-25T12:00:00.000Z"

function sampleInput(overrides = {}) {
  return {
    goal: "make the test suite green",
    criteria: ["npm test exits 0", "no skipped tests"],
    checks: [
      { kind: "shell", cmd: "npm test", timeoutSec: 60 },
      { kind: "contains", file: "src/config.ts", text: "PORT from env" },
    ],
    constraints: "only touch src/ and tests/",
    nonGoals: ["do not refactor the build system"],
    ...overrides,
  }
}

function renderActive() {
  return renderGoal(sampleInput(), { now: NOW, status: "active", session: "ses_a" })
}

test("rendered goal file has the persistence layout", () => {
  const text = renderActive()
  assert.match(text, /^status: active$/m)
  assert.match(text, /^revision: 1$/m)
  assert.match(text, /^session: ses_a$/m)
  assert.match(text, /^max_turns: 25$/m)
  assert.match(text, /^turns_used: 0$/m)
  assert.match(text, /^max_minutes: 60$/m)
  assert.match(text, /^created: 2026-09-25T12:00:00\.000Z$/m)
  for (const header of ["## Goal", "## Success Criteria", "## Verification Checks", "## Constraints", "## Non-Goals", "## Check Log", "## Turn Ledger"]) {
    assert.ok(text.includes(header), `missing ${header}`)
  }
  assert.ok(text.includes("1. shell `npm test` (timeout 60s)"))
  assert.ok(text.includes("2. contains `src/config.ts` :: `PORT from env`"))
})

test("rendered queued goal has no session and no stop_reason", () => {
  const text = renderGoal(sampleInput(), { now: NOW, status: "queued" })
  assert.match(text, /^status: queued$/m)
  assert.ok(!/^session:/m.test(text))
  assert.ok(!/^stop_reason:/m.test(text))
})

test("filename layout: date-slug with same-day collision suffix", () => {
  assert.equal(goalFileName("2026-09-25", "make-suite-green"), "2026-09-25-make-suite-green.md")
  assert.equal(
    goalFileName("2026-09-25", "make-suite-green", ["2026-09-25-make-suite-green.md"]),
    "2026-09-25-make-suite-green-2.md",
  )
})

test("slugify keeps CJK segments and falls back", () => {
  assert.equal(slugifyGoal("Fix the Login Timeout!"), "fix-the-login-timeout")
  assert.ok(slugifyGoal("修复登录超时").length > 0)
  assert.equal(slugifyGoal("!!!"), "goal")
})

test("round-trip: parse inverts render", () => {
  const doc = parseGoal(renderActive())
  assert.equal(doc.status, "active")
  assert.equal(doc.revision, 1)
  assert.equal(doc.session, "ses_a")
  assert.equal(doc.maxTurns, 25)
  assert.equal(doc.goal, "make the test suite green")
  assert.deepEqual(doc.criteria, ["npm test exits 0", "no skipped tests"])
  assert.deepEqual(doc.checks, [
    { kind: "shell", cmd: "npm test", timeoutSec: 60 },
    { kind: "contains", file: "src/config.ts", text: "PORT from env" },
  ])
  assert.deepEqual(doc.nonGoals, ["do not refactor the build system"])
})

test("missing required content is rejected without writing", () => {
  assert.throws(() => renderGoal(sampleInput({ criteria: [] }), { now: NOW, status: "queued" }), GoalError)
  assert.throws(() => renderGoal(sampleInput({ checks: [] }), { now: NOW, status: "queued" }), GoalError)
  assert.throws(() => renderGoal(sampleInput({ constraints: " " }), { now: NOW, status: "queued" }), GoalError)
  assert.throws(() => renderGoal(sampleInput({ maxTurns: 9999 }), { now: NOW, status: "queued" }), /maxTurns/)
  assert.throws(() => renderGoal(sampleInput({ maxMinutes: 0 }), { now: NOW, status: "queued" }), /maxMinutes/)
})

test("parse rejects malformed documents", () => {
  assert.throws(() => parseGoal("no frontmatter"), GoalError)
  assert.throws(() => parseGoal("---\nstatus: weird\n---\n## Goal\n"), GoalError)
  const noChecks = renderActive().replace("## Verification Checks", "## Verification Checks Renamed")
  assert.throws(() => parseGoal(noChecks), /Verification Checks/)
  assert.equal(parseGoalLoose(noChecks), null)
})

test("state machine: legal paths and illegal transitions", () => {
  assert.equal(isGoalTerminal("completed"), true)
  assert.equal(isGoalTerminal("abandoned"), true)
  assert.equal(isGoalLive("active"), true)
  assert.equal(isGoalLive("paused"), true)
  assert.equal(isGoalLive("queued"), false)
  assert.ok(canTransitionGoal("queued", "active"))
  assert.ok(canTransitionGoal("active", "paused"))
  assert.ok(canTransitionGoal("paused", "active"))
  assert.ok(canTransitionGoal("active", "completed"))
  assert.ok(canTransitionGoal("queued", "abandoned"))
  assert.ok(!canTransitionGoal("queued", "paused"))
  assert.ok(!canTransitionGoal("completed", "active"))
  assert.ok(!canTransitionGoal("abandoned", "paused"))
})

test("transitionGoal: pause requires stop reason; resume rebinds owner and clears it", () => {
  const armed = renderActive()
  assert.throws(() => transitionGoal(armed, "paused", NOW), /stop reason/)
  const paused = transitionGoal(armed, "paused", NOW, { stopReason: "blocker" })
  assert.match(paused, /^stop_reason: blocker$/m)
  const resumed = transitionGoal(paused, "active", NOW, { session: "ses_b" })
  assert.match(resumed, /^session: ses_b$/m)
  assert.ok(!/^stop_reason:/m.test(resumed))
  assert.throws(() => transitionGoal(resumed, "active", NOW, { session: "ses_b" }), /already/)
  const queued = renderGoal(sampleInput(), { now: NOW, status: "queued" })
  assert.throws(() => transitionGoal(queued, "paused", NOW, { stopReason: "user" }), /Illegal/)
})

test("budget: turns and wall-clock tracks, first exhausted wins", () => {
  // budgetState compares against the real clock, so the base doc must carry a
  // fresh arm timestamp — the fixed NOW fixture would trip budget-time a day
  // after it was written (pre-existing time bomb, fixed 2026-09-26).
  const fresh = new Date().toISOString()
  const base = parseGoal(renderGoal(sampleInput(), { now: fresh, status: "active", session: "ses_a" }))
  assert.equal(budgetState(base), "ok")
  assert.equal(budgetState({ ...base, turnsUsed: 25 }), "budget-turns")
  const longAgo = new Date(Date.now() - 61 * 60_000).toISOString()
  assert.equal(budgetState({ ...base, created: longAgo }), "budget-time")
  assert.equal(budgetState({ ...base, turnsUsed: 25, created: longAgo }), "budget-turns")
})

test("incTurns and bumpBudget update the frontmatter with ceilings", () => {
  let text = renderActive()
  text = incTurns(text, NOW)
  text = incTurns(text, NOW)
  assert.match(text, /^turns_used: 2$/m)
  text = bumpBudget(text, 10, NOW)
  assert.match(text, /^max_turns: 35$/m)
  const nearCeiling = renderGoal(sampleInput({ maxTurns: 200 }), { now: NOW, status: "active", session: "s" })
  assert.match(bumpBudget(nearCeiling, 50, NOW), /^max_turns: 200$/m)
})

test("revision bump on revise keeps status/owner/budget and invalidates nothing silently", () => {
  let text = renderActive()
  text = incTurns(text, NOW)
  const revised = renderGoal(sampleInput({ goal: "make the suite green and fast" }), {
    now: NOW,
    status: "active",
    created: parseGoal(text).created,
    revision: 2,
    session: "ses_a",
    turnsUsed: 1,
  })
  const doc = parseGoal(revised)
  assert.equal(doc.revision, 2)
  assert.equal(doc.status, "active")
  assert.equal(doc.session, "ses_a")
  assert.equal(doc.turnsUsed, 1)
})

test("Check Log append: stamping, truncation, idempotency", () => {
  let text = renderActive()
  const outcomes = [
    { index: 1, ok: true, detail: "all good", durationMs: 213, label: "npm test" },
    { index: 2, ok: false, detail: "x".repeat(1000), durationMs: 5, label: "src/config.ts :: PORT from env" },
  ]
  text = appendCheckLog(text, "run-1", outcomes, NOW)
  assert.ok(text.includes(`- ${NOW} run=run-1 rev1 #1 OK (213ms) \`npm test\` :: all good`))
  const failLine = text.split("\n").find((l) => l.includes("#2 FAIL"))
  assert.ok(failLine.length < 600, "long detail must be truncated")
  assert.ok(failLine.endsWith("…"), "truncated detail marker")
  // Same run appended again: no duplicates.
  const again = appendCheckLog(text, "run-1", outcomes, NOW)
  assert.equal(again.match(/rev1 #1 OK/g)?.length, 1)
  // A later run in the same revision DOES append (audit trail).
  const later = appendCheckLog(text, "run-2", outcomes, NOW)
  assert.equal(later.match(/rev1 #1 OK/g)?.length, 2)
})

test("Turn Ledger append: keyed by turn number, replaces on re-append", () => {
  let text = renderActive()
  text = appendLedger(text, { turn: 1, revision: 1, at: NOW, activity: true, writes: 2, checks: 1 }, NOW)
  text = appendLedger(text, { turn: 2, revision: 1, at: NOW, activity: false, writes: 0, checks: 0 }, NOW)
  assert.ok(text.includes("- turn 1 rev1"))
  assert.ok(text.includes("activity=no"))
  text = appendLedger(text, { turn: 2, revision: 1, at: NOW, activity: true, writes: 4, checks: 0 }, NOW)
  assert.equal(text.match(/- turn 2 rev1/g)?.length, 1)
  const doc = parseGoal(text)
  assert.equal(doc.ledger.length, 2)
  assert.deepEqual(doc.ledger[1], { turn: 2, revision: 1, at: NOW, activity: true, writes: 4, checks: 0 })
})

test("discovery: live goals newest-first, queued oldest-first", () => {
  const a = renderGoal(sampleInput({ goal: "a" }), { now: "2026-09-25T10:00:00.000Z", status: "active", session: "s1" })
  const b = renderGoal(sampleInput({ goal: "b" }), { now: "2026-09-25T11:00:00.000Z", status: "paused", session: "s2" })
  const q1 = renderGoal(sampleInput({ goal: "q1" }), { now: "2026-09-25T09:00:00.000Z", status: "queued" })
  const q2 = renderGoal(sampleInput({ goal: "q2" }), { now: "2026-09-25T09:30:00.000Z", status: "queued" })
  const done = transitionGoal(a, "completed", NOW)
  const live = rankLiveGoals([
    { name: "b.md", text: b },
    { name: "a.md", text: a },
    { name: "done.md", text: done },
  ])
  assert.deepEqual(live.map((e) => e.name), ["b.md", "a.md"])
  const queued = rankQueuedGoals([
    { name: "q2.md", text: q2 },
    { name: "q1.md", text: q1 },
  ])
  assert.deepEqual(queued.map((e) => e.name), ["q1.md", "q2.md"])
})

test("completion self-attestation gate: coverage, pass, and stray entries", () => {
  const doc = parseGoal(renderActive())
  assert.deepEqual(completeCheckFailures(doc, [{ criterion: "npm test exits 0", pass: true, evidence: "exit 0" }, { criterion: "no skipped tests", pass: true, evidence: "grep" }]), [])
  assert.ok(completeCheckFailures(doc, [{ criterion: "npm test exits 0", pass: true, evidence: "x" }])[0].includes("no self-attestation"))
  assert.ok(completeCheckFailures(doc, [{ criterion: "npm test exits 0", pass: false, evidence: "" }, { criterion: "no skipped tests", pass: true, evidence: "x" }])[0].includes("unmet"))
  assert.ok(completeCheckFailures(doc, [{ criterion: "npm test exits 0", pass: true, evidence: "x" }, { criterion: "no skipped tests", pass: true, evidence: "y" }, { criterion: "stray", pass: true, evidence: "z" }]).some((f) => f.includes("do not match")))
})

test("atomic write: target always holds a complete document", () => {
  const dir = mkdtempSync(join(tmpdir(), "goal-atomic-"))
  try {
    const file = join(dir, "g.md")
    atomicWrite(file, renderActive())
    assert.ok(existsSync(file))
    // Crash between writeFileSync(tmp) and rename leaves the OLD content.
    writeFileSync(`${file}.tmp`, "partial garbage")
    assert.equal(parseGoalLoose(readFileSync(file, "utf8"))?.goal, "make the test suite green")
    assert.equal(readdirSync(dir).filter((f) => f.endsWith(".md")).length, 1)
    atomicWrite(file, transitionGoal(renderActive(), "paused", NOW, { stopReason: "user" }))
    assert.equal(parseGoal(readFileSync(file, "utf8")).status, "paused")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("budget wall-clock anchors on armed_at (since arming), not created", () => {
  const base = parseGoal(renderActive())
  const longAgo = new Date(Date.now() - 61 * 60_000).toISOString()
  const fresh = new Date(Date.now() - 60_000).toISOString()
  // armed_at wins over an old created: a queued-then-promoted goal keeps a
  // full window instead of inheriting time consumed while inert.
  assert.equal(budgetState({ ...base, created: longAgo, armedAt: fresh }), "ok")
  assert.equal(budgetState({ ...base, created: fresh, armedAt: longAgo }), "budget-time")
  // Legacy files without armed_at fall back to created.
  assert.equal(budgetState({ ...base, created: longAgo, armedAt: "" }), "budget-time")
})

test("transitionGoal: entering active stamps armed_at; pause keeps it; resume re-arms it", () => {
  const queued = renderGoal(sampleInput(), { now: NOW, status: "queued" })
  const armed = transitionGoal(queued, "active", "2026-09-25T13:00:00.000Z", { session: "ses_a" })
  assert.match(armed, /^armed_at: 2026-09-25T13:00:00\.000Z$/m)
  const paused = transitionGoal(armed, "paused", "2026-09-25T13:05:00.000Z", { stopReason: "user" })
  assert.match(paused, /^armed_at: 2026-09-25T13:00:00\.000Z$/m, "pausing keeps the original arming time")
  const resumed = transitionGoal(paused, "active", "2026-09-25T14:00:00.000Z", { session: "ses_b" })
  assert.match(resumed, /^armed_at: 2026-09-25T14:00:00\.000Z$/m, "resume re-arms the clock")
})

test("carryHistory: $-replacement patterns in audit lines survive literally", () => {
  const withLog = renderActive().replace(
    "(no checks recorded yet)",
    () => "- 2026-09-25T12:00:00.000Z run=r1 rev1 #1 OK (1ms) `echo $& $' $$` :: exit=0",
  )
  const oldDoc = parseGoal(withLog)
  const revised = carryHistory(renderGoal(sampleInput(), { now: NOW, status: "active", session: "ses_a", revision: 2 }), oldDoc)
  assert.ok(revised.includes("`echo $& $' $$`"), "replacement patterns must not expand")
  assert.equal(parseGoal(revised).log.length, 1)
})
