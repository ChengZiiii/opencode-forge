import test from "node:test"
import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createJobManager } from "../src/job-manager.ts"
import { JOB_ENV_MARKER, pollJob, readJobLog, rotateLogs, startJob } from "../src/job-runner.ts"

class FakeChild extends EventEmitter {
  constructor(pid = 4711) {
    super()
    this.pid = pid
    this.stdout = new EventEmitter()
    this.stderr = new EventEmitter()
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

test("3.1 exit-bound completion: grandchild holding the pipes cannot suspend the call", async () => {
  const manager = createJobManager({ now: () => 0 })
  const dir = tmpLogDir()
  const fake = makeFakeSpawn()
  const { job, settle } = startJob(manager, { ...BASE, logDir: dir, idleMs: 10_000, maxWaitMs: 60_000, spawnFn: fake, exitGraceMs: 30 })
  const done = settle.then((r) => r)
  // The direct child EXITS while its (fake) streams never emit close/EOF —
  // the #47350 shape. Completion rides the exit event; the grace cap closes
  // the job out despite the held pipes.
  fake.spawned[0].child.emit("exit", 0)
  const r = await done
  assert.equal(r.status, "exited")
  assert.equal(r.exitCode, 0)
  assert.equal(job.state, "exited")
  rmSync(dir, { recursive: true, force: true })
})

test("3.1b real #47350 repro: launcher exits, detached holder keeps the pipes open", async () => {
  const manager = createJobManager()
  const dir = tmpLogDir()
  // The holder outlives the completion (5s) but self-exits, so the test
  // process is not held alive by the open pipe handle it keeps.
  writeFileSync(
    join(dir, "holder.js"),
    "console.log('holder-alive')\nsetTimeout(() => process.exit(0), 5_000)\n",
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
  // The detached holder survives as debris — kill the (already exited) job's
  // recorded child tree cleans nothing here, so kill the holder directly.
  job.killTree()
  // The holder's cwd IS this temp dir, so Windows refuses to delete it until
  // the process self-exits (5s); retry the cleanup until then.
  for (let i = 0; i < 30; i++) {
    try {
      rmSync(dir, { recursive: true, force: true })
      break
    } catch {
      await new Promise((r) => setTimeout(r, 250))
    }
  }
})

test("3.2 idle early return: still-running, process alive, hint payload present", async () => {
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
  const { job, settle } = startJob(manager, { ...BASE, logDir: dir, idleMs: 60_000, maxWaitMs: 40, spawnFn: fake })
  const child = fake.spawned[0].child
  const drip = setInterval(() => child.stdout.emit("data", "tick\n"), 5)
  const r = await settle
  clearInterval(drip)
  assert.equal(r.status, "still-running")
  assert.equal(job.state, "running")
  assert.deepEqual(child.killSignals, [])
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
  fake.spawned[0].child.stdout.emit("data", "vite dev server\nlistening on :3000\n")
  const r = await settle
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
  const child = fake.spawned[0].child
  child.stdout.emit("data", "building...\nDone in 1.2s\n")
  const r = await settle
  assert.equal(r.keptAlive, false)
  assert.equal(job.state, "succeeded")
  child.emit("exit", null)
  assert.equal(job.state, "succeeded", "late exit must not override the terminal state")
  rmSync(dir, { recursive: true, force: true })
})

test("3.4 output is tee'd to the namespaced log file", async () => {
  const manager = createJobManager()
  const dir = tmpLogDir()
  const fake = makeFakeSpawn()
  const { job, settle } = startJob(manager, { ...BASE, logDir: dir, idleMs: 30, spawnFn: fake })
  fake.spawned[0].child.stdout.emit("data", "line-one\n")
  fake.spawned[0].child.stderr.emit("data", "line-two-stderr\n")
  await settle
  assert.ok(existsSync(job.logPath))
  const text = readFileSync(job.logPath, "utf8")
  assert.ok(text.includes("line-one"))
  assert.ok(text.includes("line-two-stderr"))
  const page = readJobLog(job.logPath)
  assert.equal(page.total, 2)
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
  const { job, settle } = startJob(manager, { ...BASE, logDir: dir, runInBackground: true, spawnFn: fake })
  assert.equal(job.state, "running")
  assert.ok(job.logPath.endsWith(".log"))
  assert.match(job.id, /^j-/)
  const opts = fake.spawned[0].opts
  assert.equal(opts.env[JOB_ENV_MARKER], job.id, "job marker env rides along")
  fake.spawned[0].child.stdout.emit("data", "booting\n")
  fake.spawned[0].child.emit("exit", 3)
  fake.spawned[0].child.stdout.emit("close")
  fake.spawned[0].child.stderr.emit("close")
  await Promise.resolve()
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(job.state, "exited")
  assert.equal(job.exitCode, 3)
  const settled = await settle
  assert.equal(settled.status, "exited")
  rmSync(dir, { recursive: true, force: true })
})

test("pollJob waits for new output within the bounded window and drains once", async () => {
  const manager = createJobManager()
  const dir = tmpLogDir()
  const fake = makeFakeSpawn()
  const { job } = startJob(manager, { ...BASE, logDir: dir, runInBackground: true, spawnFn: fake })
  const child = fake.spawned[0].child
  setTimeout(() => child.stdout.emit("data", "fresh\n"), 20)
  const p = await pollJob(manager, job.id, 2_000)
  assert.equal(p.newOutput, "fresh\n")
  const p2 = await pollJob(manager, job.id, 0)
  assert.equal(p2.newOutput, "")
  child.emit("exit", 0)
  child.stdout.emit("close")
  child.stderr.emit("close")
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
