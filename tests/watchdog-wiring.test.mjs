import test from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { EventEmitter } from "node:events"

process.env.FORGE_WATCHDOG_PROBE = "1"
process.env.TMPDIR = process.env.TEMP // ledger dir follows TMPDIR/TEMP; keep it stable for reads

import { server } from "../plugin.ts"
import { WATCHDOG_ENV_MARK } from "../src/watchdog.ts"
import { JOB_ENV_MARKER } from "../src/job-runner.ts"
import { createJobManager } from "../src/job-manager.ts"
import { startJob } from "../src/job-runner.ts"
import { createFileLedger, watchdogLogDir } from "../src/watchdog.ts"

const probePath = join(tmpdir(), "forge-watchdog-probe.log")
rmSync(probePath, { force: true })

const fakeInput = () => ({
  client: { session: {} },
  project: { id: "p" },
  directory: "/w",
  worktree: "/w",
  serverUrl: new URL("http://127.0.0.1:1"),
})

test("1.2 shell.env injects the namespaced marker only when callID is present", async () => {
  const h = await server(fakeInput(), {})
  const out = { env: {} }
  await h["shell.env"]({ cwd: "/w", sessionID: "ses_a", callID: "cal_1" }, out)
  assert.equal(out.env[WATCHDOG_ENV_MARK], "opencode-forge:cal_1")
  const noId = { env: {} }
  await h["shell.env"]({ cwd: "/w", sessionID: "ses_a" }, noId)
  assert.equal(noId.env[WATCHDOG_ENV_MARK], undefined, "no callID → no marker, no timing")
})

test("1.2 before/after lifecycle tracks and clears shell/bash calls", async () => {
  const h = await server(fakeInput(), {})
  await h["tool.execute.before"]({ tool: "bash", sessionID: "ses_a", callID: "cal_2" })
  await h["tool.execute.after"]({ tool: "bash", sessionID: "ses_a", callID: "cal_2" })
  await h["tool.execute.before"]({ tool: "read", sessionID: "ses_a", callID: "cal_3" })
  await h.dispose()
  const probe = readFileSync(probePath, "utf8")
  assert.match(probe, /track cal_2/)
  assert.match(probe, /untrack cal_2/)
  assert.ok(!/cal_3/.test(probe), "non-shell tools are never timed")
})

test("3.2 invalid watchdog options fall back to defaults and ledger the fallback", async () => {
  const ledgerPath = join(watchdogLogDir(), "log.jsonl")
  const before = existsSync(ledgerPath) ? createFileLedger(ledgerPath).entries().filter((e) => e.event === "config-fallback").length : 0
  await server(fakeInput(), { watchdog: { mode: "loud", stallMs: "soon" } })
  const entries = createFileLedger(ledgerPath).entries().filter((e) => e.event === "config-fallback")
  assert.equal(entries.length - before, 2, "one fallback entry per invalid knob")
  assert.ok(entries.slice(-2).every((e) => /watchdog\.(mode|stallMs)/.test(e.reason)))
  rmSync(join(watchdogLogDir()), { recursive: true, force: true })
})

test("4.2 job-supervisor spawns carry the job marker but never the watchdog mark", async () => {
  const spawned = []
  const spawnFn = (cmd, opts) => {
    spawned.push({ cmd, opts })
    return new EventEmitter()
  }
  const manager = createJobManager()
  const dir = mkdtempSync(join(tmpdir(), "forge-wd-mutex-"))
  const { job } = startJob(manager, { cmd: "x", cwd: dir, ownerSession: "s", worktree: dir, logDir: dir, runInBackground: true, spawnFn })
  assert.equal(spawned[0].opts.env[JOB_ENV_MARKER], job.id, "job env marker present")
  assert.equal(spawned[0].opts.env[WATCHDOG_ENV_MARK], undefined, "watchdog never governs forge_shell jobs")
  manager.disposeAll()
  rmSync(dir, { recursive: true, force: true })
})
