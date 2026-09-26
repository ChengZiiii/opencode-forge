import test from "node:test"
import assert from "node:assert/strict"
import { EventEmitter } from "node:events"

import { createJobFence } from "../src/job-fence.ts"

class FakeWatcher extends EventEmitter {
  constructor() {
    super()
    this.written = []
    this.ended = false
    this.stdin = {
      writable: true,
      write: (chunk) => {
        this.written.push(chunk)
        return true
      },
      end: () => {
        this.ended = true
      },
    }
  }
}

function fakeFenceSpawn() {
  const spawned = []
  const spawnFn = (cmd, args, opts) => {
    const child = new FakeWatcher()
    spawned.push({ cmd, args, opts, child })
    return child
  }
  spawnFn.spawned = spawned
  return spawnFn
}

test("4.1 fence: non-Windows platforms get no fence (POSIX has no kernel fence by design)", () => {
  const degrade = []
  const fence = createJobFence({ platform: "linux", onDegrade: (r) => degrade.push(r) })
  assert.equal(fence, null)
  assert.deepEqual(degrade, [], "absence on POSIX is by-design, not a degradation")
})

test("4.1 fence: watcher script sets KILL_ON_JOB_CLOSE and reads pids from stdin until EOF", () => {
  const fake = fakeFenceSpawn()
  const fence = createJobFence({ spawnFn: fake, platform: "win32" })
  assert.ok(fence, "fence created on win32")
  const { cmd, args, opts } = fake.spawned[0]
  assert.equal(cmd, "powershell")
  assert.match(args[0], /^-NoProfile$/)
  const script = args[args.length - 1]
  assert.match(script, /0x2000/, "JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE is set")
  assert.doesNotMatch(script, /BREAKAWAY/i, "no BREAKAWAY_OK — breakaway processes stay outside (known boundary)")
  assert.match(script, /AssignProcessToJobObject/)
  assert.match(script, /ReadLine\(\)\) != null/, "pids arrive as stdin lines until EOF")
  assert.match(script, /CreateToolhelp32Snapshot/, "periodic process-table sweep for race-free descendant adoption")
  assert.match(script, /new Timer\(Sweep, null, 0, 400\)/, "sweep cadence 400ms")
  assert.match(script, /MAX_DEPTH = 4/, "descendant walk is depth-bounded (no recycled-ancestor sweeps)")
  assert.equal(opts.stdio[0], "pipe", "stdin is the host-death signal")
  assert.equal(opts.stdio[1], "ignore")
  fence.dispose()
})

test("4.1 fence: assign writes pid lines; dispose ends stdin exactly once", () => {
  const fake = fakeFenceSpawn()
  const fence = createJobFence({ spawnFn: fake, platform: "win32" })
  fence.assign(4711)
  fence.assign(4712)
  assert.deepEqual(fake.spawned[0].child.written, ["4711\n", "4712\n"])
  fence.dispose()
  fence.dispose()
  assert.ok(fake.spawned[0].child.ended)
})

test("4.1 fence: a dead watcher degrades (ledgered once) and never throws", () => {
  const fake = fakeFenceSpawn()
  const degrade = []
  const fence = createJobFence({ spawnFn: fake, platform: "win32", onDegrade: (r) => degrade.push(r) })
  fake.spawned[0].child.emit("exit", 1)
  assert.equal(fence.healthy, false)
  fence.assign(5)
  fence.assign(6)
  assert.equal(degrade.length, 1, "degrade reported once, not per call")
})

test("4.1 fence: watcher spawn failure returns null with a degrade note", () => {
  const degrade = []
  const boom = () => {
    throw new Error("no powershell")
  }
  const fence = createJobFence({ spawnFn: boom, platform: "win32", onDegrade: (r) => degrade.push(r) })
  assert.equal(fence, null)
  assert.equal(degrade.length, 1)
})
