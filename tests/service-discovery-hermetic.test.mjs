import test from "node:test"
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { v2SessionClientForTests, resetServiceHttpDiscoveryForTests } from "../plugin.ts"

// crew-continue-native-child-gate D8.7 — test hermeticity of the service.json
// channel (messages reader, native-child walker, interrupt fallback).
//
// Leak scan 2026-11-23: `v2-tools` issued 11 real GETs
// (`/api/session/ses_mockchild_1/message → 404`) against the user's running
// host, because discoverServiceHttp() fell back to the REAL default location
// (~/.local/state/opencode/service.json) whenever a test set neither
// FORGE_SERVICE_FILE nor XDG_STATE_HOME.
//
// Proof shape — a FAKE "real host" stands in for the user's service: a
// counting HTTP server on 127.0.0.1, registered under a temp HOME at the
// production default path.
//   leg 1 (this runner process) : ZERO requests reach the fake host
//   leg 2 (a plain `node` child) : exactly ONE request reaches it
// leg 2 is the control. It proves the fake default location is live and that
// the guard is confined to the test runner — so leg 1 cannot pass for an
// unrelated reason (HOME not picked up, server dead, guard over-reaching).

const PLUGIN = fileURLToPath(new URL("../plugin.ts", import.meta.url))

function svcCtx() {
  return {
    session: {
      prompt: async () => {},
      get: async () => ({}),
      create: async (flat) => ({ id: flat.id ?? "ses_adapter_child" }),
    },
  }
}

async function startFakeHost() {
  const hits = []
  const server = createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`)
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify([{ id: "msg_fake_1", type: "assistant", time: { created: 1, completed: 2 }, content: [{ type: "text", text: "report" }] }]))
  })
  await new Promise((r) => server.listen(0, "127.0.0.1", r))
  return {
    hits,
    port: server.address().port,
    close: () => new Promise((r) => server.close(r)),
  }
}

test("service discovery is hermetic: the runner never reads the default location, a plain node process does", async (t) => {
  const fake = await startFakeHost()
  const home = mkdtempSync(join(tmpdir(), "forge-hermetic-home-"))
  const stateDir = join(home, ".local", "state", "opencode")
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(join(stateDir, "service.json"), JSON.stringify({ url: `http://127.0.0.1:${fake.port}/`, password: "pw-fake" }))
  const saved = {}
  for (const k of ["FORGE_SERVICE_FILE", "XDG_STATE_HOME", "USERPROFILE", "HOME"]) saved[k] = process.env[k]
  const restore = () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    resetServiceHttpDiscoveryForTests()
  }
  t.after(async () => {
    restore()
    await fake.close()
    rmSync(home, { recursive: true, force: true })
  })
  delete process.env.FORGE_SERVICE_FILE
  delete process.env.XDG_STATE_HOME
  process.env.USERPROFILE = home // os.homedir() on win32
  process.env.HOME = home // os.homedir() on posix
  resetServiceHttpDiscoveryForTests()
  assert.equal(process.env.NODE_TEST_CONTEXT !== undefined || process.execArgv.some((a) => a === "--test" || a.startsWith("--test-")), true, "precondition: this process IS the Node test runner")

  await t.test("leg 1 — inside the runner: capability absence, zero requests, on all three channel users", async () => {
    const adapter = v2SessionClientForTests(svcCtx())
    assert.ok(adapter?.session.messages, "adapter built")
    assert.ok(adapter?.nativeChildWalker, "walker present")
    assert.deepEqual(await adapter.session.messages({ path: { id: "ses_leak_probe" } }), { capabilityPending: true }, "messages: pending = leg-not-applicable, never a view failure")
    await assert.rejects(adapter.nativeChildWalker.session.list({ parentID: "ses_parent" }), /service\.json discovery failed/, "walker list throws → pure core fails OPEN")
    await assert.rejects(adapter.nativeChildWalker.session.status(), /service\.json discovery failed/, "walker status throws → pure core fails OPEN")
    await assert.rejects(adapter.session.abort({ path: { id: "ses_leak_probe" } }), /abort unavailable/, "interrupt fallback refuses rather than dialing a default host")
    assert.deepEqual(fake.hits, [], "nothing reached the fake host")
  })

  await t.test("leg 1b — the refusal is NOT cached: an explicit fixture set afterwards is honored (real round trip)", async () => {
    const svcFile = join(home, "fixture-service.json")
    writeFileSync(svcFile, JSON.stringify({ url: `http://127.0.0.1:${fake.port}`, password: "pw-fake" }))
    process.env.FORGE_SERVICE_FILE = svcFile
    const adapter = v2SessionClientForTests(svcCtx())
    const res = await adapter.session.messages({ path: { id: "ses_fixture_child" } })
    assert.equal(res.error, undefined, "happy path through the fixture")
    assert.equal(res.data.length, 1)
    assert.deepEqual(fake.hits, ["GET /api/session/ses_fixture_child/message"])
    delete process.env.FORGE_SERVICE_FILE
    resetServiceHttpDiscoveryForTests()
  })

  await t.test("leg 2 — control: a plain `node` child (no runner) reads the same default location and DOES reach the fake host", async () => {
    const script = join(home, "plain-child.mjs")
    writeFileSync(
      script,
      [
        `const m = await import(${JSON.stringify(pathToFileURL(PLUGIN).href)})`,
        "const adapter = m.v2SessionClientForTests({ session: { prompt: async () => {}, get: async () => ({}), create: async () => ({ id: 'x' }) } })",
        "const res = await adapter.session.messages({ path: { id: 'ses_control_child' } })",
        "process.stdout.write(JSON.stringify({ ok: res.error === undefined, rows: res.data?.length }) + '\\n')",
        "",
      ].join("\n"),
    )
    const env = { ...process.env, USERPROFILE: home, HOME: home }
    delete env.FORGE_SERVICE_FILE
    delete env.XDG_STATE_HOME
    delete env.NODE_TEST_CONTEXT
    const before = fake.hits.length
    // ASYNC spawn on purpose: the fake host lives in THIS process, and a
    // synchronous spawn would freeze the event loop that has to answer.
    const child = spawn(process.execPath, [script], { env, stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (d) => (stdout += d))
    child.stderr.on("data", (d) => (stderr += d))
    const timer = setTimeout(() => child.kill(), 90_000)
    const exit = await new Promise((r) => child.on("close", (code, signal) => r({ code, signal })))
    clearTimeout(timer)
    assert.deepEqual(exit, { code: 0, signal: null }, `plain child exited cleanly\nstdout: ${stdout}\nstderr: ${stderr.slice(0, 600)}`)
    assert.deepEqual(JSON.parse(stdout.trim()), { ok: true, rows: 1 }, "the plain child read the default location and got the fake host's answer")
    assert.deepEqual(fake.hits.slice(before), ["GET /api/session/ses_control_child/message"], "control request observed")
  })
})
