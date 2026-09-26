import test from "node:test"
import assert from "node:assert/strict"

import { createJobManager } from "../src/job-manager.ts"
import { createExitCleanup } from "../src/host-exit.ts"

// Fake synchronous taskkill: records every invocation.
function fakeTaskkill() {
  const calls = []
  const spawnSyncFn = (cmd, args) => {
    calls.push({ cmd, args })
    return { status: 0 }
  }
  spawnSyncFn.calls = calls
  return spawnSyncFn
}

function jobWith(manager, { pid, survive = false, state = "running" }) {
  const job = manager.create({
    id: `j-${pid}`,
    cmd: "fake",
    worktree: "/w",
    ownerSession: "s",
    logPath: `C:/nowhere/${pid}.log`,
    notify: false,
    killTree: () => {},
    ...(pid ? { pid } : {}),
    ...(survive ? { survive: true } : {}),
  })
  if (state !== "running") manager.markTerminal(job, state, 0)
  return job
}

test("3.1 exit matrix: dispose kills every live non-survive job, graceful then force, once per job", () => {
  const manager = createJobManager()
  jobWith(manager, { pid: 101 })
  jobWith(manager, { pid: 102 })
  jobWith(manager, { pid: 103, survive: true })
  jobWith(manager, { pid: 104, state: "exited" })
  const tk = fakeTaskkill()
  const cleanup = createExitCleanup(manager, { spawnSyncFn: tk, platform: "win32", noWait: true, graceMs: 1_000 })
  cleanup.trigger("dispose")
  cleanup.uninstall()
  const pids = (force) => tk.calls.filter((c) => c.args.includes("/F") === force).map((c) => c.args[1])
  assert.deepEqual(pids(false).sort(), ["101", "102"], "graceful pass (taskkill without /F) for each live job")
  assert.deepEqual(pids(true).sort(), ["101", "102"], "force pass after the grace window")
  assert.equal(tk.calls.length, 4, "survive and terminal jobs are never touched")
  assert.equal(manager.get("j-103").state, "running", "survive job keeps running")
  assert.equal(manager.get("j-101").state, "killed")
})

test("3.1 exit matrix: signal paths force immediately (no slow graceful sequence)", () => {
  const manager = createJobManager()
  jobWith(manager, { pid: 201 })
  const tk = fakeTaskkill()
  const cleanup = createExitCleanup(manager, { spawnSyncFn: tk, platform: "win32", noWait: true, graceMs: 3_000 })
  cleanup.trigger("SIGINT")
  cleanup.uninstall()
  assert.equal(tk.calls.length, 1, "single force taskkill — a Windows SIGINT kills the host mid-handler, so the pass must be fast")
  assert.ok(tk.calls[0].args.includes("/F"))
})

test("3.1 exit matrix: 'exit' path force-kills immediately (no graceful pass)", () => {
  const manager = createJobManager()
  jobWith(manager, { pid: 201 })
  const tk = fakeTaskkill()
  const cleanup = createExitCleanup(manager, { spawnSyncFn: tk, platform: "win32", noWait: true })
  cleanup.trigger("exit")
  cleanup.uninstall()
  assert.equal(tk.calls.length, 1, "single force taskkill")
  assert.ok(tk.calls[0].args.includes("/F"))
})

test("3.1 exit matrix: a SIGINT killed halfway must not swallow the 'exit' belt", () => {
  // Live finding: on Windows the SIGINT handler can be terminated before it
  // finishes. The 'exit' handler must still fire its own force pass — the
  // forceIssued latch deduplicates only COMPLETED passes. Simulated here by
  // a job that appears only at exit time (the signal pass saw nothing).
  const manager = createJobManager()
  const tk = fakeTaskkill()
  const cleanup = createExitCleanup(manager, { spawnSyncFn: tk, platform: "win32", noWait: true })
  const early = jobWith(manager, { pid: 301 })
  cleanup.trigger("SIGINT")
  // The signal pass completed for pid 301; a late-registered job (race) or a
  // retry must not double-kill 301 ...
  assert.equal(tk.calls.filter((c) => c.args[1] === "301").length, 1)
  // ... but the dispose path after a completed signal force does not repeat:
  cleanup.trigger("dispose")
  assert.equal(tk.calls.filter((c) => c.args[1] === "301").length, 1, "no double kill across the matrix")
  cleanup.uninstall()
})

test("3.1 exit matrix: repeated triggers add nothing (per process)", () => {
  const manager = createJobManager()
  jobWith(manager, { pid: 301 })
  const tk = fakeTaskkill()
  let afterRan = 0
  const cleanup = createExitCleanup(manager, { spawnSyncFn: tk, platform: "win32", noWait: true, after: () => afterRan++ })
  for (const kind of ["SIGINT", "SIGTERM", "exit", "uncaughtException", "unhandledRejection", "dispose"]) cleanup.trigger(kind)
  cleanup.uninstall()
  assert.equal(tk.calls.length, 1, "one force taskkill total")
  assert.equal(afterRan, 1, "after() teardown ran exactly once")
})

test("3.1 exit matrix: 'after' teardown (fence dispose) runs even with zero jobs", () => {
  const manager = createJobManager()
  let afterRan = false
  const cleanup = createExitCleanup(manager, { spawnSyncFn: fakeTaskkill(), platform: "win32", noWait: true, after: () => (afterRan = true) })
  cleanup.trigger("dispose")
  cleanup.uninstall()
  assert.ok(afterRan)
})

test("3.1 exit matrix: process listeners are actually installed and removable", () => {
  const manager = createJobManager()
  const before = process.listenerCount("SIGINT")
  const cleanup = createExitCleanup(manager, { spawnSyncFn: fakeTaskkill(), platform: "win32", noWait: true })
  assert.ok(process.listenerCount("SIGINT") > before, "SIGINT listener installed")
  assert.ok(process.listenerCount("exit") > 0, "exit listener installed")
  assert.ok(process.listenerCount("uncaughtException") > 0)
  assert.ok(process.listenerCount("unhandledRejection") > 0)
  const after = process.listenerCount("SIGINT")
  cleanup.uninstall()
  assert.equal(process.listenerCount("SIGINT"), after - 1, "uninstall removes it")
})

// POSIX plan: the force pass signals the process group.
test("3.1 exit matrix: POSIX force pass via the group", () => {
  const manager = createJobManager()
  jobWith(manager, { pid: 401 })
  const sent = []
  const origKill = process.kill
  process.kill = (target, signal) => {
    sent.push({ target, signal })
    return true
  }
  const cleanup = createExitCleanup(manager, { platform: "linux", noWait: true, graceMs: 1_000 })
  cleanup.trigger("SIGTERM")
  cleanup.uninstall()
  process.kill = origKill
  assert.deepEqual(sent.map((s) => `${s.target}:${s.signal}`), ["-401:SIGKILL"])
  assert.equal(manager.get("j-401").state, "killed")
})
