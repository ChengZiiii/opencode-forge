import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  WATCHDOG_ENV_MARK,
  clampStallMs,
  createFileLedger,
  createWatchdog,
  parseMode,
} from "../src/watchdog.ts"
import { createPosixLocator, createWindowsLocator, markerValue, parseWindowsProcs } from "../src/proc-locate.ts"

function rig(over = {}) {
  const entries = []
  const killed = []
  let nowMs = 1_000_000
  const wd = createWatchdog({
    mode: "kill",
    stallMs: 1000,
    minStallMs: 1,
    intervalMs: 60_000,
    observeMs: 500,
    now: () => nowMs,
    sink: (e) => entries.push(e),
    locate: (callID, t0, needle, phase2) => (over.locate ? over.locate(callID, t0, needle, phase2) : [{ pid: 42, cmd: `node x ${callID}` }]),
    killTree: (pid) => killed.push(pid),
    isAlive: () => true,
    ...over.opts,
  })
  return { wd, entries, killed, tick: (ms) => (nowMs += ms), setNow: (ms) => (nowMs = ms), get now() { return nowMs } }
}

test("1.1 warn fires once at 80% of the budget", async () => {
  const r = rig()
  r.wd.track("c1", "ses_a", "shell", 0)
  r.wd.markSeen("c1")
  r.setNow(799)
  await r.wd.scan()
  assert.equal(r.entries.filter((e) => e.event === "warn").length, 0, "below 80%: silent")
  r.setNow(810)
  await r.wd.scan()
  assert.equal(r.entries.filter((e) => e.event === "warn").length, 1)
  r.setNow(900)
  await r.wd.scan()
  assert.equal(r.entries.filter((e) => e.event === "warn").length, 1, "warn is single-shot")
  const warn = r.entries.find((e) => e.event === "warn")
  assert.equal(warn.callID, "c1")
  assert.equal(warn.sessionID, "ses_a")
  assert.equal(warn.tool, "shell")
  assert.equal(typeof warn.t0, "number")
})

test("2.2 threshold in kill mode: locate → tree-kill → ledger with the hit list, once", async () => {
  const r = rig()
  r.wd.track("c2", undefined, "bash", 0)
  r.wd.markSeen("c2")
  r.setNow(1000)
  await r.wd.scan()
  const kills = r.entries.filter((e) => e.event === "kill")
  assert.equal(kills.length, 1)
  assert.deepEqual(r.killed, [42])
  assert.equal(kills[0].pids.length, 1)
  assert.equal(kills[0].pids[0].pid, 42)
  assert.equal(kills[0].mode, "kill")
  r.setNow(1500)
  await r.wd.scan()
  assert.equal(r.entries.filter((e) => e.event === "kill").length, 1, "acted at most once")
  assert.deepEqual(r.killed, [42], "no double kill")
})

test("2.3 dry-run records the would-be kill list and kills nothing", async () => {
  const r = rig({ opts: { mode: "dry-run" } })
  r.wd.track("c3", "ses_b", "shell", 0)
  r.wd.markSeen("c3")
  r.setNow(1000)
  await r.wd.scan()
  assert.deepEqual(r.killed, [], "dry-run never kills")
  const cand = r.entries.filter((e) => e.event === "dry-run-candidate")
  assert.equal(cand.length, 1)
  assert.equal(cand[0].pids.length, 1, "the would-be list is recorded")
  r.setNow(1500)
  await r.wd.scan()
  assert.equal(r.entries.filter((e) => e.event === "dry-run-candidate").length, 1, "single audit per call")
})

test("2.2 no matching process → diagnostics-only unresolved, nothing touched", async () => {
  const r = rig({ locate: async () => [] })
  r.wd.track("c4", "ses_c", "shell", 0)
  r.wd.markSeen("c4")
  r.setNow(1000)
  await r.wd.scan()
  assert.deepEqual(r.killed, [])
  const unres = r.entries.filter((e) => e.event === "unresolved")
  assert.equal(unres.length, 1)
  assert.match(unres[0].reason, /no matching process/)
})

test("2.2 post-kill observation: still no after → one unresolved report", async () => {
  const r = rig()
  r.wd.track("c5", "ses_d", "shell", 0)
  r.wd.markSeen("c5")
  r.setNow(1000)
  await r.wd.scan()
  assert.equal(r.entries.filter((e) => e.event === "kill").length, 1)
  r.setNow(1400)
  await r.wd.scan()
  assert.equal(r.entries.filter((e) => e.event === "unresolved").length, 0, "inside the observation window")
  r.setNow(1600)
  await r.wd.scan()
  const unres = r.entries.filter((e) => e.event === "unresolved")
  assert.equal(unres.length, 1)
  assert.match(unres[0].reason, /observation window/)
  r.setNow(3000)
  await r.wd.scan()
  assert.equal(r.entries.filter((e) => e.event === "unresolved").length, 1, "reported once")
})

test("2.2 a kill followed by the call ending normally leaves no unresolved", async () => {
  const r = rig()
  r.wd.track("c6", "ses_e", "shell", 0)
  r.wd.markSeen("c6")
  r.setNow(1000)
  await r.wd.scan()
  r.wd.untrack("c6")
  r.setNow(5000)
  await r.wd.scan()
  assert.equal(r.entries.filter((e) => e.event === "unresolved").length, 0)
})

test("4.1 marker missing (shell.env never fired) degrades the act to dry-run", async () => {
  const r = rig()
  r.wd.track("c7", "ses_f", "shell", 0) // no markSeen
  r.setNow(1000)
  await r.wd.scan()
  assert.deepEqual(r.killed, [], "no blind kill without the marker")
  const cand = r.entries.filter((e) => e.event === "dry-run-candidate")
  assert.equal(cand.length, 1)
  assert.match(cand[0].reason, /marker-missing/)
})

test("4.1 shell.env firing BEFORE tool.execute.before still counts as marker seen", async () => {
  const r = rig()
  r.wd.markSeen("c8")
  r.wd.track("c8", "ses_g", "shell", 0)
  r.setNow(1000)
  await r.wd.scan()
  assert.equal(r.entries.filter((e) => e.event === "kill").length, 1, "ordering cannot fake a missing marker")
})

test("2.3 off mode is fully inert", async () => {
  const r = rig({ opts: { mode: "off" } })
  r.wd.track("c9", "ses_h", "shell", 0)
  assert.equal(r.wd.size(), 0, "off mode does not even track")
  r.setNow(100_000)
  await r.wd.scan()
  assert.equal(r.entries.length, 0)
})

test("1.1 untrack clears the record; dispose empties the table", async () => {
  const r = rig()
  r.wd.track("c10", "ses_i", "shell", 0)
  assert.ok(r.wd.has("c10"))
  r.wd.untrack("c10")
  assert.ok(!r.wd.has("c10"))
  r.setNow(100_000)
  await r.wd.scan()
  assert.equal(r.entries.length, 0, "no intervention can target a completed call")
  r.wd.track("c11", "ses_i", "shell", 0)
  r.wd.dispose()
  assert.equal(r.wd.size(), 0)
})

test("3.2 config clamps and mode parsing", () => {
  assert.equal(clampStallMs(undefined), 600_000)
  assert.equal(clampStallMs("nope" ), 600_000)
  assert.equal(clampStallMs(5), 60_000, "below the floor clamps to the protection minimum")
  assert.equal(clampStallMs(90_000), 90_000)
  assert.equal(parseMode("off"), "off")
  assert.equal(parseMode("dry-run"), "dry-run")
  assert.equal(parseMode("kill"), "kill")
  assert.equal(parseMode("loud"), "kill", "invalid falls back to the default")
})

test("3.1 file ledger: bounded, rotated, entries carry the audit fields", () => {
  const dir = mkdtempSync(join(tmpdir(), "forge-wd-test-"))
  const path = join(dir, "log.jsonl")
  const ledger = createFileLedger(path, 5)
  for (let i = 0; i < 8; i++) {
    ledger.append({
      ts: new Date(2026, 0, 1, 0, 0, i).toISOString(),
      event: "warn",
      callID: `c${i}`,
      sessionID: "ses_x",
      tool: "shell",
      t0: i,
      mode: "kill",
    })
  }
  const entries = ledger.entries()
  assert.equal(entries.length, 5, "capped at the entry limit")
  assert.equal(entries[0].callID, "c3", "oldest rotated out")
  assert.equal(entries[4].callID, "c7")
  assert.ok(entries.every((e) => e.callID && e.event && typeof e.t0 === "number" && e.mode))
  rmSync(dir, { recursive: true, force: true })
})

test("2.1 POSIX locator: exact NUL-separated environ match only", async () => {
  const pids = [1, 2, 3]
  const locate = createPosixLocator({
    listPids: () => pids,
    readEnv: (pid) => {
      if (pid === 1) return Buffer.from(`HOME=/x\0X${WATCHDOG_ENV_MARK}=${markerValue("call-a")}\0`)
      if (pid === 2) return Buffer.from(`HOME=/y\0${WATCHDOG_ENV_MARK}=${markerValue("call-a")}\0`)
      return Buffer.from(`HOME=/z\0${WATCHDOG_ENV_MARK}=${markerValue("call-b")}\0`)
    },
    readCmd: (pid) => `proc-${pid}`,
  })
  const hits = await locate("call-a", 0)
  assert.deepEqual(hits.map((h) => h.pid), [2], "substring/suffix keys never match; other calls never match")
  assert.equal(hits[0].cmd, "proc-2")
})

test("2.1 Windows locator: host subtree × time window (with rounding slack), outsiders excluded", async () => {
  const t0 = 10_000
  const host = 10
  const procs = [
    { ProcessId: 10, ParentProcessId: 1, CommandLine: "opencode host", CreationDate: "/Date(500)/" },
    { ProcessId: 20, ParentProcessId: 10, CommandLine: "cmd launcher", CreationDate: "/Date(9000)/" },
    { ProcessId: 21, ParentProcessId: 20, CommandLine: "node holder", CreationDate: "/Date(9200)/" },
    // Created in the same second as t0 (rounds down below it) — inside the
    // rounding slack, still a target.
    { ProcessId: 22, ParentProcessId: 10, CommandLine: "same-second child", CreationDate: "/Date(9500)/" },
    // Well before the call — excluded.
    { ProcessId: 30, ParentProcessId: 10, CommandLine: "early child", CreationDate: "/Date(5000)/" },
    { ProcessId: 40, ParentProcessId: 99, CommandLine: "foreign tree", CreationDate: "/Date(13000)/" },
    // The locator's own probe — always self-excluded.
    { ProcessId: 50, ParentProcessId: 10, CommandLine: "powershell -Command Get-CimInstance Win32_Process ...", CreationDate: "/Date(15000)/" },
  ]
  const locate = createWindowsLocator({
    hostPid: host,
    execFn: () => JSON.stringify(procs),
  })
  const hits = await locate("call-x", t0)
  assert.deepEqual(
    hits.map((h) => h.pid).sort((a, b) => a - b),
    [20, 21, 22],
    "grandchildren + same-second children included; pre-window, outside-tree, and self excluded",
  )
  assert.equal(hits.find((h) => h.pid === 21).cmd, "node holder")
})

test("2.1 Windows JSON parsing tolerates single-object and ISO date shapes", () => {
  const one = parseWindowsProcs(JSON.stringify({ ProcessId: 7, ParentProcessId: 1, CommandLine: "solo", CreationDate: "2026-09-26T00:00:00.000Z" }))
  assert.equal(one.length, 1)
  assert.equal(one[0].pid, 7)
  assert.equal(one[0].createdMs, Date.parse("2026-09-26T00:00:00.000Z"))
  assert.deepEqual(parseWindowsProcs("not json"), [])
  const missingDate = parseWindowsProcs(JSON.stringify([{ ProcessId: 8, ParentProcessId: 1 }]))
  assert.deepEqual(missingDate, [], "procs without a readable CreationDate are skipped, not guessed")
})

test("2.1 Windows locator: command-needle branch catches CIM-ppid orphans inside the window", async () => {
  const t0 = 10_000
  const procs = [
    { ProcessId: 10, ParentProcessId: 1, CommandLine: "opencode host", CreationDate: "/Date(500)/" },
    { ProcessId: 20, ParentProcessId: 10, CommandLine: 'bash.exe -c "node C:/ws/launcher-long.js"', CreationDate: "/Date(9000)/" },
    // ppid lies (points outside the host tree) but the command text matches.
    { ProcessId: 21, ParentProcessId: 999, CommandLine: "node.exe C:/ws/launcher-long.js", CreationDate: "/Date(9100)/" },
    // Command matches but created BEFORE the window — excluded.
    { ProcessId: 22, ParentProcessId: 999, CommandLine: "node.exe C:/ws/launcher-long.js", CreationDate: "/Date(4000)/" },
    // In the tree/window but a console host — never a target.
    { ProcessId: 23, ParentProcessId: 10, CommandLine: "conhost.exe", CreationDate: "/Date(9200)/" },
  ]
  const locate = createWindowsLocator({ hostPid: 10, execFn: () => JSON.stringify(procs) })
  const hits = await locate("call-y", t0, "C:/ws/launcher-long.js")
  assert.deepEqual(hits.map((h) => h.pid).sort((a, b) => a - b), [20, 21], "subtree OR needle, both gated by the time window; conhost never")
  const noNeedle = await locate("call-y", t0)
  assert.deepEqual(noNeedle.map((h) => h.pid), [20], "without a needle only the subtree branch applies")
})

test("2.1 commandNeedle picks the distinguishing token", async () => {
  const { commandNeedle } = await import("../src/proc-locate.ts")
  assert.equal(commandNeedle("node C:/Users/x/forge-live/ws/launcher-long.js"), "C:/Users/x/forge-live/ws/launcher-long.js")
  assert.equal(commandNeedle("echo hi"), "echo hi", "degenerate short tokens fall back to the whole command")
  assert.equal(commandNeedle('  "npm test"  '), "npm test")
  assert.equal(commandNeedle(""), "")
})

test("2.2 wave 2: workspace-scope kill fires only after wave 1 fails to unblock", async () => {
  const calls = []
  const r = rig({
    locate: async (callID, _t0, _needle, phase2) => {
      calls.push(phase2 === true)
      return phase2 === true ? [{ pid: 77, cmd: "holder.js" }] : [{ pid: 42, cmd: "launcher.js" }]
    },
  })
  r.wd.track("c13", "ses_k", "shell", 0, "C:/ws/launcher.js")
  r.wd.markSeen("c13")
  r.setNow(1000)
  await r.wd.scan()
  assert.deepEqual(r.killed, [42], "wave 1 kills the matched set")
  r.setNow(1400)
  await r.wd.scan()
  assert.ok(!calls.includes(true), "inside the observation window: no wave 2 yet")
  r.setNow(1600)
  await r.wd.scan()
  assert.deepEqual(r.killed, [42, 77], "wave 2 kills the workspace-scope holder")
  const kills = r.entries.filter((e) => e.event === "kill")
  assert.equal(kills.length, 2)
  assert.match(kills[1].reason, /wave 2/)
  // After wave 2, another observation window and only then unresolved.
  r.setNow(1900)
  await r.wd.scan()
  assert.equal(r.entries.filter((e) => e.event === "unresolved").length, 0)
  r.setNow(3000)
  await r.wd.scan()
  const unres = r.entries.filter((e) => e.event === "unresolved")
  assert.equal(unres.length, 1, "no third wave — unresolved after wave 2's window")
  assert.deepEqual(r.killed, [42, 77], "no repeated kills")
})

test("2.2 wave 2 without a needle goes straight to unresolved", async () => {
  const r = rig()
  r.wd.track("c14", "ses_l", "shell", 0) // no needle
  r.wd.markSeen("c14")
  r.setNow(1000)
  await r.wd.scan()
  r.setNow(2000)
  await r.wd.scan()
  assert.deepEqual(r.killed, [42])
  assert.equal(r.entries.filter((e) => e.event === "unresolved").length, 1)
})

test("2.2 direct workspace scope when the call's own chain already exited (#47350 shape)", async () => {
  const r = rig({
    locate: async (_callID, _t0, _needle, phase2) => (phase2 === true ? [{ pid: 88, cmd: "holder-long.js" }] : []),
  })
  r.wd.track("c15", "ses_m", "shell", 0, "C:/forge-ws/launcher.js")
  r.wd.markSeen("c15")
  r.setNow(1000)
  await r.wd.scan()
  assert.deepEqual(r.killed, [88], "phase A empty + needle → workspace scope kills the pipe holder directly")
  const kills = r.entries.filter((e) => e.event === "kill")
  assert.equal(kills.length, 1)
  assert.match(kills[0].reason, /workspace scope/)
  // The workspace wave already ran (wave 2): the next expired observation
  // window reports unresolved instead of re-killing.
  r.setNow(2000)
  await r.wd.scan()
  assert.deepEqual(r.killed, [88])
  assert.equal(r.entries.filter((e) => e.event === "unresolved").length, 1)
})

test("2.2 no matching process anywhere → unresolved, nothing touched", async () => {
  const r = rig({ locate: async () => [] })
  r.wd.track("c16", "ses_n", "shell", 0, "C:/forge-ws/launcher.js")
  r.wd.markSeen("c16")
  r.setNow(1000)
  await r.wd.scan()
  assert.deepEqual(r.killed, [])
  const unres = r.entries.filter((e) => e.event === "unresolved")
  assert.equal(unres.length, 1)
  assert.match(unres[0].reason, /no matching process/)
})

test("2.1 Windows locator phase 2: directory scope matches backslash commands", async () => {
  const t0 = 10_000
  const procs = [
    { ProcessId: 10, ParentProcessId: 1, CommandLine: "opencode host", CreationDate: "/Date(500)/" },
    // Detached holder: parent dead (999), different command, same directory —
    // only the phase-2 dir branch catches it (separator-normalized).
    { ProcessId: 60, ParentProcessId: 999, CommandLine: "node.exe C:\\forge-ws\\holder-long.js", CreationDate: "/Date(9500)/" },
    // Same directory but created before the window — never a target.
    { ProcessId: 61, ParentProcessId: 999, CommandLine: "node.exe C:\\forge-ws\\older.js", CreationDate: "/Date(4000)/" },
  ]
  const locate = createWindowsLocator({ hostPid: 10, execFn: () => JSON.stringify(procs) })
  assert.deepEqual((await locate("c", t0, "C:/forge-ws/launcher.js", false)).map((h) => h.pid), [], "phase 1: no subtree/needle match")
  const wave2 = await locate("c", t0, "C:/forge-ws/launcher.js", true)
  assert.deepEqual(wave2.map((h) => h.pid), [60], "phase 2: same-directory holder inside the window")
})

test("2.1 Windows locator survives a failing PowerShell probe (empty list, no throw)", async () => {
  const locate = createWindowsLocator({
    hostPid: 10,
    execFn: () => {
      throw new Error("powershell 5.1 says no")
    },
  })
  assert.deepEqual(await locate("c", 0), [])
})

test("2.2 a locate that throws becomes an unresolved entry, not a dead scanner", async () => {
  const r = rig({ locate: async () => { throw new Error("wmi hiccup") } })
  r.wd.track("c12", "ses_j", "shell", 0)
  r.wd.markSeen("c12")
  r.setNow(1000)
  await r.wd.scan()
  assert.deepEqual(r.killed, [])
  const unres = r.entries.filter((e) => e.event === "unresolved")
  assert.equal(unres.length, 1)
  assert.match(unres[0].reason, /intervention failed/)
  r.setNow(2000)
  await r.wd.scan()
  assert.ok(true, "scanner stays alive after a failed act")
})
