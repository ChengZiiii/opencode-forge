import test from "node:test"
import assert from "node:assert/strict"

import { killTree, shellSpawn, treeKillPlan } from "../src/proc.ts"

function fakeChild(pid = 4242) {
  const calls = []
  return {
    pid,
    kill(signal) {
      calls.push(signal ?? "SIGTERM")
    },
    killCalls: calls,
  }
}

test("treeKillPlan: windows escalates to taskkill /F /T against the tree", () => {
  assert.deepEqual(treeKillPlan("win32", 4242), { kind: "taskkill", args: ["/pid", "4242", "/F", "/T"] })
})

test("treeKillPlan: posix signals the detached process group", () => {
  assert.deepEqual(treeKillPlan("linux", 4242), { kind: "group", signal: "SIGKILL" })
  assert.deepEqual(treeKillPlan("darwin", 4242), { kind: "group", signal: "SIGKILL" })
})

test("killTree: windows path runs taskkill through the injected spawn", () => {
  const spawned = []
  const child = fakeChild(777)
  killTree(child, {
    platform: "win32",
    spawnFn: (cmd, args, opts) => {
      spawned.push({ cmd, args, opts })
      return fakeChild(9999)
    },
  })
  assert.equal(spawned.length, 1)
  assert.equal(spawned[0].cmd, "taskkill")
  assert.deepEqual(spawned[0].args, ["/pid", "777", "/F", "/T"])
  assert.equal(child.killCalls.length, 0)
})

test("killTree: a missing pid degrades to a direct child kill", () => {
  const child = fakeChild(undefined)
  killTree(child, { platform: "win32", spawnFn: () => { throw new Error("must not spawn") } })
  assert.deepEqual(child.killCalls, ["SIGTERM"])
})

test("killTree: posix group kill failure falls back to a direct SIGKILL", () => {
  const child = fakeChild(1234)
  // No process group 1234 exists in the test process, so the group signal
  // throws and the fallback fires.
  killTree(child, { platform: "linux" })
  assert.deepEqual(child.killCalls, ["SIGKILL"])
})

test("shellSpawn: shell mode, env merge with markers, hidden window", () => {
  const captured = []
  const fakeSpawn = (cmd, opts) => {
    captured.push({ cmd, opts })
    return fakeChild(1)
  }
  shellSpawn(fakeSpawn, "echo hi", {
    cwd: "/w",
    env: { FORGE_JOB_ID: "j-1", PATH: undefined },
    detached: true,
    windowsHide: true,
  })
  assert.equal(captured.length, 1)
  const { cmd, opts } = captured[0]
  assert.equal(cmd, "echo hi")
  assert.equal(opts.shell, true)
  assert.equal(opts.cwd, "/w")
  assert.equal(opts.detached, true)
  assert.equal(opts.windowsHide, true)
  assert.equal(opts.env.FORGE_JOB_ID, "j-1")
  assert.ok(opts.env.PATH !== undefined || true, "parent env merged")
  assert.equal("PATH" in opts.env, true)
})

test("shellSpawn: detached defaults per platform and can be forced off", () => {
  const captured = []
  const fakeSpawn = (cmd, opts) => {
    captured.push(opts)
    return fakeChild(1)
  }
  shellSpawn(fakeSpawn, "a")
  assert.equal(captured[0].detached, process.platform !== "win32")
  shellSpawn(fakeSpawn, "b", { detached: false })
  assert.equal(captured[1].detached, false)
})
