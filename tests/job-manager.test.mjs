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

test("ownership: dispose kills process-backed jobs only — dispatch rows SURVIVE (state unchanged, row present)", () => {
  // fix-dispatch-dispose-kill D1 renegotiation: the old pin ("dispose kills
  // every running job") rode the dispose crutch the dispatch pollers were
  // leaning on. Dispose kills PROCESS-backed jobs; dispatch rows (the only
  // identity marker is the dispatch meta) are skipped by isDispatchRow —
  // no kill, no delete, no state change: their children are server-side
  // sessions and continuity rides the dispatch journal + restart recovery.
  const { manager, sinkEntries } = makeManager()
  const a = makeJob(manager, "j-1")
  const b = makeJob(manager, "j-2", { ownerSession: "ses_b" })
  const d = makeJob(manager, "j-d", { ownerSession: "ses_d", dispatch: { agentID: "forge-dp-research", childSessionID: "ses_child_9", description: "dispatch row" } })
  manager.disposeAll((job) => job.dispatch != null)
  assert.deepEqual(a.killed, ["j-1"], "process job killed by dispose")
  assert.deepEqual(b.killed, ["j-2"], "second process job killed by dispose")
  assert.equal(manager.get("j-1"), undefined)
  assert.equal(manager.get("j-2"), undefined)
  // The dispose kill class is ledgered (this layer's disposeAll is the only
  // kill path; the plugin's wiring dispose runs the exit matrix first, so
  // THIS is where the orphan class is pinned).
  assert.ok(sinkEntries.some((e) => e.kind === "orphan-job" && e.jobId === "j-1" && /plugin dispose; tree killed/.test(e.detail)), "the dispose kill is ledgered with its class")
  assert.ok(!sinkEntries.some((e) => e.kind === "orphan-job" && e.jobId === "j-d"), "the spared dispatch row leaves NO ledger entry")
  assert.deepEqual(d.killed, [], "the dispatch row's killTree NEVER ran")
  assert.equal(manager.get("j-d"), d.job, "the dispatch row is still present")
  assert.equal(d.job.state, "running", "the dispatch row's state is unchanged")
  assert.equal(manager.size(), 1, "only the dispatch row remains")
})

test("ownership: owner end with keep (dispatch rows) — killed for the wake, row STAYS in the map until read", () => {
  // fix-dispatch-dispose-kill D2: owner death is still a LEGAL registry kill
  // for a dispatch row (killTree runs, state flips killed, wake queues), but
  // the row is NOT deleted synchronously — deliverWakesFor only traverses
  // the live Map, so the queued wake must stay reachable. The row leaves via
  // read-consumption (poll on the terminal row).
  const { manager, sinkEntries } = makeManager()
  const d = makeJob(manager, "j-keep", { dispatch: { agentID: "forge-dp-research", childSessionID: "ses_child_k", description: "kept row" } })
  const plain = makeJob(manager, "j-plain")
  manager.onSessionEnd("ses_a", (job) => job.dispatch != null)
  assert.deepEqual(d.killed, ["j-keep"], "the dispatch row was killed (owner death is a legal registry kill)")
  assert.equal(d.job.state, "killed", "killed state stamped")
  assert.equal(d.job.wakeState, "queued", "the completion wake is queued")
  assert.ok(manager.get("j-keep"), "the dispatch row STAYS in the map (wake must stay deliverable)")
  assert.equal(manager.get("j-plain"), undefined, "non-kept rows are deleted as before")
  assert.ok(sinkEntries.some((e) => e.kind === "orphan-job" && e.jobId === "j-keep" && /row kept for wake delivery/.test(e.detail)), "the kept-row kill is ledgered with the keep disclosure")
  // The queued wake IS deliverable for the dead owner's session.
  assert.equal(manager.deliverWakesFor("ses_a").length, 1, "the kept row's wake delivers")
  // Read-consumption self-clears the terminal row.
  manager.poll(d.job)
  assert.equal(manager.get("j-keep"), undefined, "polling the terminal row consumes it")
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

test("terminal evidence: markTerminal self-clears the entry and never queues a wake", () => {
  const { manager } = makeManager()
  const { job } = makeJob(manager, "j-te")
  job.terminalEvidence = true
  manager.markTerminal(job, "exited", 0)
  assert.equal(manager.get("j-te"), undefined, "self-cleared at completion — no manual clear")
  assert.equal(job.wakeState, "none", "the caller already holds the full output")
  assert.equal(manager.deliverWakesFor("ses_a").length, 0)
  // The entry cannot be cleared again (it is gone) and leaves no unread ledger noise.
  assert.equal(manager.clear("j-te"), false)
})

test("terminal evidence: consumed ids self-describe, FIFO-bounded like the finished cap", () => {
  const { manager } = makeManager({ maxFinishedJobs: 2 })
  for (const id of ["j-c1", "j-c2", "j-c3"]) {
    const { job } = makeJob(manager, id)
    job.terminalEvidence = true
    manager.markTerminal(job, "exited", 0)
  }
  assert.equal(manager.consumed("j-c1"), false, "oldest consumed id fell off the bounded memory")
  assert.equal(manager.consumed("j-c2"), true)
  assert.equal(manager.consumed("j-c3"), true)
  assert.equal(manager.consumed("j-never-existed"), false)
})

test("read consumption: a terminal poll consumes the entry and drops the queued wake", () => {
  const { manager } = makeManager()
  const { job } = makeJob(manager, "j-rc")
  manager.appendOutput(job, "out\n")
  manager.markTerminal(job, "exited", 0)
  assert.equal(job.wakeState, "queued")
  const p = manager.poll(job)
  assert.equal(p.state, "exited")
  assert.equal(p.exitCode, 0, "the poll itself delivered the completion")
  assert.equal(manager.get("j-rc"), undefined, "the terminal poll consumed the entry")
  assert.equal(manager.consumed("j-rc"), true, "stale verbs will self-describe")
  assert.equal(manager.deliverWakesFor("ses_a").length, 0, "the queued wake died with the entry — no double-notify")
})

test("read consumption: a wake already delivered, then polled — entry self-clears", () => {
  const { manager } = makeManager()
  const { job } = makeJob(manager, "j-rd")
  manager.markTerminal(job, "exited", 2)
  assert.equal(manager.deliverWakesFor("ses_a").length, 1)
  manager.poll(job)
  assert.equal(manager.get("j-rd"), undefined)
  assert.equal(manager.consumed("j-rd"), true)
})

test("read consumption: a non-terminal poll never consumes; list never consumes", () => {
  const { manager } = makeManager()
  const { job } = makeJob(manager, "j-rn")
  manager.appendOutput(job, "progress\n")
  manager.poll(job)
  assert.ok(manager.get("j-rn"), "a poll of a running job retains it")
  manager.markTerminal(job, "exited", 0)
  manager.list()
  assert.ok(manager.get("j-rn"), "list does not consume — only poll asserts state")
  manager.poll(job)
  assert.equal(manager.get("j-rn"), undefined, "the terminal poll consumes")
})

test("wake queueing fires the onWakeQueued hook exactly once per job", () => {
  const seen = []
  const { manager } = makeManager({ onWakeQueued: (j) => seen.push(j.id) })
  const { job } = makeJob(manager, "j-hook")
  manager.markTerminal(job, "exited", 0)
  assert.deepEqual(seen, ["j-hook"])
  manager.markTerminal(job, "killed", null) // late transition must not re-fire
  assert.deepEqual(seen, ["j-hook"])
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
