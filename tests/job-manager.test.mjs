import test from "node:test"
import assert from "node:assert/strict"

import { createJobManager, newJobId } from "../src/job-manager.ts"

// Deterministic clock the tests can advance.
function makeClock(start = 1_000_000) {
  let t = start
  return {
    now: () => t,
    advance: (ms) => (t += ms),
  }
}

function makeManager(overrides = {}) {
  const clock = makeClock()
  const sinkEntries = []
  const manager = createJobManager({
    now: clock.now,
    sink: (e) => sinkEntries.push(e),
    ...overrides,
  })
  return { manager, clock, sinkEntries }
}

function makeJob(manager, id, overrides = {}) {
  const killed = []
  return {
    job: manager.create({
      id,
      cmd: `echo ${id}`,
      worktree: "/w",
      ownerSession: "ses_a",
      logPath: `/tmp/x/${id}.log`,
      notify: true,
      killTree: () => killed.push(id),
      ...overrides,
    }),
    killed,
  }
}

test("lifecycle: create -> terminal -> clear, terminal transition is first-wins", () => {
  const { manager } = makeManager()
  const { job } = makeJob(manager, "j-1")
  assert.equal(job.state, "running")
  manager.markTerminal(job, "exited", 0)
  manager.markTerminal(job, "killed", null) // late close event after a kill must not override
  assert.equal(job.state, "exited")
  assert.equal(job.exitCode, 0)
  assert.ok(manager.clear("j-1"))
  assert.equal(manager.get("j-1"), undefined)
  assert.equal(manager.clear("j-1"), false)
})

test("eviction: finished jobs beyond the cap are evicted oldest-first, running survive", () => {
  const { manager, sinkEntries } = makeManager({ maxFinishedJobs: 2 })
  for (let i = 0; i < 5; i++) {
    const { job } = makeJob(manager, `j-${i}`)
    manager.markTerminal(job, "exited", 0)
  }
  const { job: live } = makeJob(manager, "j-live")
  assert.equal(live.state, "running")
  assert.equal(manager.get("j-0"), undefined)
  assert.equal(manager.get("j-1"), undefined)
  assert.equal(manager.get("j-2"), undefined)
  assert.ok(manager.get("j-3"))
  assert.ok(manager.get("j-live"), "running jobs are never evicted")
  assert.ok(sinkEntries.some((e) => e.kind === "evicted" && e.jobId === "j-0"))
})

test("appendOutput: tail window slides, outLen grows monotonically, poll drains increments", () => {
  const { manager } = makeManager({ maxTailChars: 10 })
  const { job } = makeJob(manager, "j-t")
  manager.appendOutput(job, "0123456789")
  manager.appendOutput(job, "abcdef")
  assert.equal(job.tail.length, 10)
  assert.equal(job.outLen, 16)
  const p1 = manager.poll(job)
  assert.equal(p1.state, "running")
  assert.equal(p1.newOutput, job.tail, "first poll returns the whole window")
  const p2 = manager.poll(job)
  assert.equal(p2.newOutput, "", "second poll drains nothing new")
  manager.appendOutput(job, "XY")
  const p3 = manager.poll(job)
  assert.equal(p3.newOutput, "XY")
})

test("ownership: owner session end kills its live jobs and ledgers orphans", () => {
  const { manager, sinkEntries } = makeManager()
  const a = makeJob(manager, "j-a")
  makeJob(manager, "j-b", { ownerSession: "ses_b" })
  manager.onSessionEnd("ses_a")
  assert.deepEqual(a.killed, ["j-a"])
  assert.equal(manager.get("j-a"), undefined)
  assert.ok(manager.get("j-b"))
  const orphan = sinkEntries.find((e) => e.kind === "orphan-job" && e.jobId === "j-a")
  assert.ok(orphan)
  assert.match(orphan.detail, /owner session ended/)
})

test("ownership: handoff survives owner end, wake follows the rebound owner", () => {
  const { manager } = makeManager()
  const a = makeJob(manager, "j-h")
  manager.handoff("j-h", "ses_root")
  manager.onSessionEnd("ses_a")
  assert.deepEqual(a.killed, [])
  assert.ok(manager.get("j-h"))
  manager.markTerminal(a.job, "exited", 3)
  const deliveredRoot = manager.deliverWakesFor("ses_root")
  assert.equal(deliveredRoot.length, 1)
  const deliveredOld = manager.deliverWakesFor("ses_a")
  assert.equal(deliveredOld.length, 0)
})

test("ownership: dispose kills every running job", () => {
  const { manager } = makeManager()
  const a = makeJob(manager, "j-1")
  const b = makeJob(manager, "j-2", { ownerSession: "ses_b" })
  manager.disposeAll()
  assert.deepEqual(a.killed, ["j-1"])
  assert.deepEqual(b.killed, ["j-2"])
  assert.equal(manager.size(), 0)
})

test("wake: at most one delivery per job, only for the idle owner session", () => {
  const { manager } = makeManager()
  const { job } = makeJob(manager, "j-w")
  manager.markTerminal(job, "exited", 0)
  assert.equal(job.wakeState, "queued")
  assert.equal(manager.deliverWakesFor("ses_b").length, 0)
  assert.equal(manager.deliverWakesFor("ses_a").length, 1)
  assert.equal(manager.deliverWakesFor("ses_a").length, 0, "second idle delivers nothing more")
  assert.equal(job.wakeState, "delivered")
})

test("wake: notify=false never queues", () => {
  const { manager } = makeManager()
  const { job } = makeJob(manager, "j-q", { notify: false })
  manager.markTerminal(job, "exited", 0)
  assert.equal(job.wakeState, "none")
  assert.equal(manager.deliverWakesFor("ses_a").length, 0)
})

test("wake: stale entries are abandoned to the ledger, not queued forever", () => {
  const { manager, clock, sinkEntries } = makeManager({ wakeWindowMs: 1000 })
  const { job } = makeJob(manager, "j-stale")
  manager.markTerminal(job, "exited", 1)
  clock.advance(2000)
  assert.equal(manager.deliverWakesFor("ses_a").length, 0)
  assert.equal(job.wakeState, "abandoned")
  const entry = sinkEntries.find((e) => e.kind === "wake-timeout" && e.jobId === "j-stale")
  assert.ok(entry)
  assert.match(entry.detail, /delivery window/)
})

test("ledger: unread completions are reported when the owner ends without reading", () => {
  const { manager, sinkEntries } = makeManager()
  const { job } = makeJob(manager, "j-u")
  manager.markTerminal(job, "exited", 0)
  manager.onSessionEnd("ses_a")
  assert.ok(sinkEntries.some((e) => e.kind === "unread-completion" && e.jobId === "j-u"))
})

test("ledger: bounded — oldest entries fall off beyond the cap", () => {
  const { manager, sinkEntries } = makeManager({ maxLedgerEntries: 3 })
  for (let i = 0; i < 6; i++) {
    const { job } = makeJob(manager, `j-l${i}`)
    manager.markTerminal(job, "exited", 0)
    manager.onSessionEnd(job.ownerSession)
  }
  assert.equal(sinkEntries.length, 6, "sink sees everything")
  assert.ok(manager.ledgerEntries().every((e) => e.at && e.kind && e.jobId))
  assert.ok(manager.ledgerEntries().length <= 3)
})

test("newJobId: unique, prefixed, filesystem-safe", () => {
  const a = newJobId()
  const b = newJobId()
  assert.notEqual(a, b)
  assert.match(a, /^j-\d{8}-\d{6}-[a-z0-9]+$/)
})
