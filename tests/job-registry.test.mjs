import test from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawn } from "node:child_process"

import { createJobManager } from "../src/job-manager.ts"
import { adoptSurvivor, pollJob, startJob } from "../src/job-runner.ts"
import { createJobRegistry, registryPathFor } from "../src/job-registry.ts"

function tmpDir() {
  return mkdtempSync(join(tmpdir(), "forge-registry-test-"))
}

const entry = (over = {}) => ({
  id: "j-test-1",
  pid: 1234,
  cmd: "node sleeper.js",
  logPath: "C:/nowhere/j-test-1.log",
  startedAt: Date.now(),
  ownerSession: "ses_old",
  hostPid: 999,
  ...over,
})

test("5.2 registry: add/list/remove round-trips on disk", () => {
  const dir = tmpDir()
  const reg = createJobRegistry(registryPathFor(dir))
  reg.add(entry())
  reg.add(entry({ id: "j-test-2", pid: 2233 }))
  assert.equal(reg.list().length, 2)
  const onDisk = JSON.parse(readFileSync(registryPathFor(dir), "utf8"))
  assert.equal(onDisk.version, 1)
  assert.equal(onDisk.entries.length, 2)
  reg.remove("j-test-1")
  assert.deepEqual(reg.list().map((e) => e.id), ["j-test-2"])
  rmSync(dir, { recursive: true, force: true })
})

test("5.2 registry: re-adding the same id replaces, never duplicates", () => {
  const dir = tmpDir()
  const reg = createJobRegistry(registryPathFor(dir))
  reg.add(entry({ pid: 1 }))
  reg.add(entry({ pid: 2 }))
  assert.equal(reg.list().length, 1)
  assert.equal(reg.list()[0].pid, 2)
  rmSync(dir, { recursive: true, force: true })
})

test("5.2 registry: bounded — oldest entries drop beyond the cap", () => {
  const dir = tmpDir()
  const reg = createJobRegistry(registryPathFor(dir))
  for (let i = 0; i < 105; i++) reg.add(entry({ id: `j-${i}`, pid: i, startedAt: i }))
  assert.equal(reg.list().length, 100)
  assert.ok(reg.list().some((e) => e.id === "j-104"), "newest kept")
  assert.ok(!reg.list().some((e) => e.id === "j-0"), "oldest dropped")
  rmSync(dir, { recursive: true, force: true })
})

test("5.2 registry: corrupt file self-heals to empty", () => {
  const dir = tmpDir()
  const path = registryPathFor(dir)
  mkdirSync(dir, { recursive: true })
  writeFileSync(path, "{ not json")
  const reg = createJobRegistry(path)
  assert.deepEqual(reg.list(), [])
  reg.add(entry())
  assert.equal(reg.list().length, 1)
  rmSync(dir, { recursive: true, force: true })
})

test("5.2 registry: rescan adopts the alive, ledgers-and-drops the dead, keeps only adopted on disk", () => {
  const dir = tmpDir()
  const reg = createJobRegistry(registryPathFor(dir))
  reg.add(entry({ id: "j-alive", pid: 111 }))
  reg.add(entry({ id: "j-dead", pid: 222 }))
  const { adopted, dead } = reg.rescan((pid) => pid === 111)
  assert.deepEqual(adopted.map((e) => e.id), ["j-alive"])
  assert.deepEqual(dead.map((e) => e.id), ["j-dead"])
  assert.deepEqual(reg.list().map((e) => e.id), ["j-alive"], "dead entries are removed from disk")
  rmSync(dir, { recursive: true, force: true })
})

// 5.2 two-host relay in-process: a survivor started by manager A is adopted
// by a fresh manager B (pid-addressed kill, shared log file, poll works).
test("5.2 relay: manager B adopts manager A's survivor — poll sees output, kill terminates, registry entry drops", async () => {
  const dir = tmpDir()
  const regA = createJobRegistry(registryPathFor(dir))
  const managerA = createJobManager()
  // A real detached sleeper that appends to stdout (= the log fd) regularly.
  const script = "setInterval(() => console.log('tick'), 200)\n"
  writeFileSync(join(dir, "sleeper.js"), script)
  const { job } = startJob(managerA, {
    cmd: `"${process.execPath}" "${join(dir, "sleeper.js")}"`,
    cwd: dir,
    ownerSession: "ses_A",
    worktree: dir,
    logDir: dir,
    runInBackground: true,
    survive: true,
    registry: regA,
  })
  assert.equal(regA.list().length, 1, "survivor recorded at start")
  assert.equal(regA.list()[0].pid, job.pid)
  // Host A "dies" — disposeAll skips the survivor, registry keeps the entry.
  managerA.disposeAll()
  assert.equal(managerA.get(job.id)?.state, "running", "survive job is not exit-killed")

  // Host B boots: fresh manager + registry rescan + adopt.
  const regB = createJobRegistry(registryPathFor(dir))
  const managerB = createJobManager()
  const { adopted } = regB.rescan((pid) => {
    try {
      process.kill(pid, 0)
      return true
    } catch (err) {
      return err.code === "EPERM"
    }
  })
  assert.equal(adopted.length, 1)
  const adoptedJob = adoptSurvivor(managerB, adopted[0], { registry: regB, logDir: dir })
  assert.equal(adoptedJob.previousRun, true)
  assert.equal(adoptedJob.survive, true)
  const p = await new Promise((resolve) => {
    const deadline = Date.now() + 8_000
    const poll = async () => {
      const r = await pollJob(managerB, adoptedJob.id, 300)
      if (r && r.newOutput.includes("tick")) resolve(r)
      else if (Date.now() > deadline) resolve(null)
      else setImmediate(poll)
    }
    poll()
  })
  assert.ok(p, "adopted job's output flows through the same log file")
  // Kill from manager B: pid-addressed tree kill (taskkill is async — poll
  // for the tree's death instead of assuming a fixed latency).
  managerB.kill(adoptedJob)
  const pid = adopted[0].pid
  const dead = async () => !(() => { try { process.kill(pid, 0); return true } catch ( err ) { return err.code === "EPERM" } })()
  let terminated = false
  for (let i = 0; i < 50 && !terminated; i++) {
    await new Promise((r) => setTimeout(r, 100))
    terminated = await dead()
  }
  assert.ok(terminated, "sleeper terminated (pid-addressed tree kill)")
  assert.equal(regB.list().length, 0, "registry entry dropped after kill")
  rmSync(dir, { recursive: true, force: true })
})
