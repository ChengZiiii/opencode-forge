import test from "node:test"
import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createJobManager } from "../src/job-manager.ts"
import { JOB_ENV_MARKER, pollJob, readJobLog, rotateLogs, startJob } from "../src/job-runner.ts"

class FakeChild extends EventEmitter {
  constructor(pid = 4711) {
    super()
    this.pid = pid
    this.killSignals = []
  }
  kill(signal) {
    this.killSignals.push(signal ?? "SIGTERM")
  }
}

function makeFakeSpawn() {
  const spawned = []
  const spawnFn = (cmd, opts) => {
    const child = new FakeChild()
    spawned.push({ cmd, opts, child })
    return child
  }
  spawnFn.spawned = spawned
  return spawnFn
}

function tmpLogDir() {
  return mkdtempSync(join(tmpdir(), "forge-jobs-test-"))
}

const BASE = { cmd: "echo hi", cwd: "/w", ownerSession: "ses_a", worktree: "/w" }

// Output now lands in the log FILE (the child writes into an inherited fd);
// tests simulate that by appending to the log and letting the tail flush.
const emit = (job, text) => appendFileSync(job.logPath, text)

test("3.1 exit-bound completion: no pipes exist, exit completes the call", async () => {
  const manager = createJobManager({ now: () => 0 })
  const dir = tmpLogDir()
  const fake = makeFakeSpawn()
  const { job, settle } = startJob(manager, { ...BASE, logDir: dir, idleMs: 10_000, maxWaitMs: 60_000, spawnFn: fake, exitGraceMs: 30 })
  const done = settle.then((r) => r)
  emit(job, "final-write\n")
  fake.spawned[0].child.emit("exit", 0)
  const r = await done
  assert.equal(r.status, "exited")
  assert.equal(r.exitCode, 0)
  assert.equal(job.state, "exited")
  rmSync(dir, { recursive: true, force: true })
})

test("3.1 spawn stdio is file-backed: the child gets no host pipes", async () => {
  const dir = tmpLogDir()
  const fake = makeFakeSpawn()
  const { job } = startJob(manager0(), { ...BASE, logDir: dir, runInBackground: true, spawnFn: fake })
  const opts = fake.spawned[0].opts
  assert.equal(opts.stdio[0], "ignore", "stdin ignored")
  assert.ok(Number.isInteger(opts.stdio[1]) && opts.stdio[1] > 2, "stdout is a log-file fd, not a pipe")
  assert.ok(Number.isInteger(opts.stdio[2]) && opts.stdio[2] === opts.stdio[1], "stderr shares the same fd")
  fake.spawned[0].child.emit("exit", 0)
  rmSync(dir, { recursive: true, force: true })
})

function manager0() {
  return createJobManager()
}

test("3.1b real #47350 repro: detached holder keeps the LOG fd, completion still rides exit", async () => {
  const manager = createJobManager()
  const dir = tmpLogDir()
  // The holder inherits fd 1 (= the job's log fd) and writes to it AFTER the
  // launcher exits — the #47350 shape transposed to file-backed stdio: a
  // grandchild holding output capacity can no longer suspend anything, and
  // its late write stays durable in the log.
  writeFileSync(
    join(dir, "holder.js"),
    "setTimeout(() => { require('node:fs').writeSync(1, 'holder-late-write\\n'); process.exit(0) }, 300)\n",
  )
  writeFileSync(
    join(dir, "launcher.js"),
    "const { spawn } = require('node:child_process')\n" +
      "const p = spawn(process.execPath, [require('node:path').join(__dirname, 'holder.js')], " +
      "{ detached: true, stdio: ['ignore', 'inherit', 'inherit'] })\n" +
      "p.unref()\n" +
      "console.log('launcher-done')\n",
  )
  const t0 = Date.now()
  const { job, settle } = startJob(manager, {
    cmd: `"${process.execPath}" "${join(dir, "launcher.js")}"`,
    cwd: dir,
    ownerSession: "ses_repro",
    worktree: dir,
    logDir: dir,
    idleMs: 30_000,
    maxWaitMs: 30_000,
    exitGraceMs: 500,
  })
  const r = await settle
  const elapsed = Date.now() - t0
  assert.equal(r.status, "exited", "the launcher's exit completes the call")
  assert.equal(r.exitCode, 0)
  assert.ok(elapsed < 5_000, `exit + grace resolves fast (took ${elapsed}ms)`)
  assert.match(r.outputTail, /launcher-done/, "final flush captured inside the grace window")
  // The holder writes 300ms after exit; the write lands in the log file even
  // though the job is terminal (nothing was suspended).
  await new Promise((res) => setTimeout(res, 800))
  assert.match(readFileSync(job.logPath, "utf8"), /holder-late-write/, "late grandchild write is durable in the log")
  rmSync(dir, { recursive: true, force: true })
})

test("3.2 idle early return: still-running, process alive, no kill issued", async () => {
  const manager = createJobManager()
  const dir = tmpLogDir()
  const fake = makeFakeSpawn()
  const { job, settle } = startJob(manager, { ...BASE, logDir: dir, idleMs: 30, maxWaitMs: 5_000, spawnFn: fake })
  const r = await settle
  assert.equal(r.status, "still-running")
  assert.ok(r.idleForMs >= 20)
  assert.equal(job.state, "running")
  assert.deepEqual(fake.spawned[0].child.killSignals, [])
  rmSync(dir, { recursive: true, force: true })
})

test("3.2 max-wait cap fires even with continuous output, without killing", async () => {
  const manager = createJobManager()
  const dir = tmpLogDir()
  const fake = makeFakeSpawn()
  const { job, settle } = startJob(manager, { ...BASE, logDir: dir, idleMs: 60_000, maxWaitMs: 250, spawnFn: fake })
  const drip = setInterval(() => emit(job, "tick\n"), 25)
  const r = await settle
  clearInterval(drip)
  assert.equal(r.status, "still-running")
  assert.equal(job.state, "running")
  assert.deepEqual(fake.spawned[0].child.killSignals, [])
  assert.ok(job.outLen > 0, "capture kept running under the drip")
  rmSync(dir, { recursive: true, force: true })
})

test("3.3 success pattern: match short-circuits; default keeps the server alive", async () => {
  const manager = createJobManager()
  const dir = tmpLogDir()
  const fake = makeFakeSpawn()
  const { job, settle } = startJob(manager, {
    ...BASE,
    logDir: dir,
    idleMs: 60_000,
    maxWaitMs: 60_000,
    successPattern: /listening on :3000/,
    spawnFn: fake,
  })
  emit(job, "vite dev server\nlistening on :3000\n")
  const r = await Promise.race([settle, new Promise((res) => setTimeout(() => res("timeout"), 3_000))])
  assert.notEqual(r, "timeout", "tail flush picks the write up within the poll cadence")
  assert.equal(r.status, "succeeded")
  assert.equal(r.matched, "listening on :3000")
  assert.equal(r.keptAlive, true)
  assert.equal(job.state, "running")
  assert.ok(job.succeededAt > 0)
  assert.deepEqual(fake.spawned[0].child.killSignals, [])
  rmSync(dir, { recursive: true, force: true })
})

test("3.3 success pattern with keep_alive=false kills the tree and closes the job", async () => {
  const manager = createJobManager()
  const dir = tmpLogDir()
  const fake = makeFakeSpawn()
  const { job, settle } = startJob(manager, {
    ...BASE,
    logDir: dir,
    idleMs: 60_000,
    maxWaitMs: 60_000,
    successPattern: /Done in/,
    keepAlive: false,
    spawnFn: fake,
  })
  emit(job, "building...\nDone in 1.2s\n")
  const r = await Promise.race([settle, new Promise((res) => setTimeout(() => res("timeout"), 3_000))])
  assert.notEqual(r, "timeout")
  assert.equal(r.keptAlive, false)
  assert.equal(job.state, "succeeded")
  fake.spawned[0].child.emit("exit", null)
  assert.equal(job.state, "succeeded", "late exit must not override the terminal state")
  rmSync(dir, { recursive: true, force: true })
})

test("3.4 output capture flows through the log file into the tail ring", async () => {
  const manager = createJobManager()
  const dir = tmpLogDir()
  const fake = makeFakeSpawn()
  const { job } = startJob(manager, { ...BASE, logDir: dir, runInBackground: true, spawnFn: fake })
  emit(job, "line-one\n")
  emit(job, "line-two-stderr\n")
  const p = await pollJob(manager, job.id, 2_000)
  assert.ok(p.newOutput.includes("line-one"))
  assert.ok(p.newOutput.includes("line-two-stderr"))
  assert.ok(existsSync(job.logPath))
  const text = readFileSync(job.logPath, "utf8")
  assert.ok(text.includes("line-one"))
  assert.ok(text.includes("line-two-stderr"))
  const page = readJobLog(job.logPath)
  assert.equal(page.total, 2)
  fake.spawned[0].child.emit("exit", 0)
  rmSync(dir, { recursive: true, force: true })
})

test("3.4 readJobLog pages by offset/limit and defaults to the tail window", () => {
  const dir = tmpLogDir()
  const p = join(dir, "x.log")
  writeFileSync(p, Array.from({ length: 10 }, (_, i) => `L${i}`).join("\n") + "\n")
  const tail = readJobLog(p, { limit: 3 })
  assert.deepEqual(tail.lines, ["L7", "L8", "L9"])
  assert.equal(tail.offset, 7)
  const mid = readJobLog(p, { offset: 2, limit: 2 })
  assert.deepEqual(mid.lines, ["L2", "L3"])
  const beyond = readJobLog(p, { offset: 99 })
  assert.deepEqual(beyond.lines, [])
  rmSync(dir, { recursive: true, force: true })
})

test("3.4 rotateLogs deletes the oldest beyond the keep cap", async () => {
  const dir = tmpLogDir()
  const names = ["a", "b", "c"]
  for (const n of names) writeFileSync(join(dir, `${n}.log`), "x")
  await new Promise((r) => setTimeout(r, 20))
  writeFileSync(join(dir, "b.log"), "newer")
  rotateLogs(dir, 3)
  assert.equal(readdirSync(dir).length, 3)
  rotateLogs(dir, 2)
  const left = readdirSync(dir)
  assert.equal(left.length, 2)
  assert.ok(!left.includes("a.log"), "oldest mtime goes first")
  rmSync(dir, { recursive: true, force: true })
})

test("3.5 run_in_background returns an immediate handle; exit settles later", async () => {
  const manager = createJobManager()
  const dir = tmpLogDir()
  const fake = makeFakeSpawn()
  const { job, settle } = startJob(manager, { ...BASE, logDir: dir, runInBackground: true, spawnFn: fake, exitGraceMs: 20 })
  assert.equal(job.state, "running")
  assert.ok(job.logPath.endsWith(".log"))
  assert.match(job.id, /^j-/)
  const opts = fake.spawned[0].opts
  assert.equal(opts.env[JOB_ENV_MARKER], job.id, "job marker env rides along")
  emit(job, "booting\n")
  fake.spawned[0].child.emit("exit", 3)
  await new Promise((r) => setTimeout(r, 60))
  assert.equal(job.state, "exited")
  assert.equal(job.exitCode, 3)
  const settled = await settle
  assert.equal(settled.status, "exited")
  assert.ok(settled.outputTail.includes("booting"), "grace flush captured the final write")
  rmSync(dir, { recursive: true, force: true })
})

test("pollJob waits for new output within the bounded window and drains once", async () => {
  const manager = createJobManager()
  const dir = tmpLogDir()
  const fake = makeFakeSpawn()
  const { job } = startJob(manager, { ...BASE, logDir: dir, runInBackground: true, spawnFn: fake })
  setTimeout(() => emit(job, "fresh\n"), 20)
  const p = await pollJob(manager, job.id, 2_000)
  assert.equal(p.newOutput, "fresh\n")
  const p2 = await pollJob(manager, job.id, 0)
  assert.equal(p2.newOutput, "")
  fake.spawned[0].child.emit("exit", 0)
  rmSync(dir, { recursive: true, force: true })
})

test("spawn failure resolves as exited with spawnError, never hangs", async () => {
  const manager = createJobManager()
  const dir = tmpLogDir()
  const boom = () => {
    throw new Error("ENOENT")
  }
  const { job, settle } = startJob(manager, { ...BASE, logDir: dir, spawnFn: boom })
  const r = await settle
  assert.equal(r.status, "exited")
  assert.match(r.spawnError, /ENOENT/)
  assert.equal(job.state, "killed")
  rmSync(dir, { recursive: true, force: true })
})

// 2.3 poll/log semantics under the file tail: incremental cursor, same
// logPath, and the tail ring keeps its bounded window.
test("2.3 file tail: poll cursor advances incrementally and the ring stays bounded", async () => {
  const manager = createJobManager({ maxTailChars: 100 })
  const dir = tmpLogDir()
  const fake = makeFakeSpawn()
  const { job } = startJob(manager, { ...BASE, logDir: dir, runInBackground: true, spawnFn: fake })
  emit(job, "x".repeat(60) + "\n")
  const p1 = await pollJob(manager, job.id, 2_000)
  assert.equal(p1.cursor, 61)
  emit(job, "y".repeat(60) + "\n")
  const p2 = await pollJob(manager, job.id, 2_000)
  assert.equal(p2.cursor, 122)
  assert.equal(p2.newOutput, "y".repeat(60) + "\n", "only the delta is returned")
  assert.ok(job.tail.length <= 100, "ring is capped")
  fake.spawned[0].child.emit("exit", 0)
  rmSync(dir, { recursive: true, force: true })
})
