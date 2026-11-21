// dispatch-v2-hostsignals task 1.1 probe: do `agent` / `model` keys on the
// v2 promise-layer session.create LAND, what does the record read back, and
// does a bogus agent get refused?
//
// Usage: node scripts/agent-binding-probe.mjs
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { spawn, spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const REPO = resolve(process.cwd()).replaceAll("\\", "/")
const ROOT = join(tmpdir(), "opencode", `binding-probe-${process.pid}`)
const CFG = join(ROOT, "config")
const WS = join(ROOT, "ws")
const PKG = join(ROOT, "probe-pkg")
const PROBE_LOG = join(ROOT, "probe.log")
const PORT = 40000 + ((process.pid * 11) % 9000)
const BASE = `http://127.0.0.1:${PORT}`

rmSync(ROOT, { recursive: true, force: true })
mkdirSync(CFG, { recursive: true })
mkdirSync(WS, { recursive: true })
mkdirSync(PKG, { recursive: true })
writeFileSync(join(PKG, "package.json"), JSON.stringify({ name: "binding-probe", type: "module", main: "index.mjs" }))
copyFileSync(join(process.cwd(), "scripts", "agent-binding-probe-plugin.mjs"), join(PKG, "index.mjs"))
writeFileSync(
  join(CFG, "opencode.json"),
  JSON.stringify(
    {
      $schema: "https://opencode.ai/config.json",
      plugin: [`file://${PKG.replaceAll("\\", "/")}`],
      permission: {},
    },
    null,
    2,
  ),
)

const log = (...a) => console.log(`[probe ${new Date().toISOString()}]`, ...a)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const portSweepCmd = [
  "-NoProfile",
  "-Command",
  `Get-NetTCPConnection -LocalPort ${PORT} -State Listen -ErrorAction SilentlyContinue | ForEach-Object { taskkill /pid $_.OwningProcess /T /F }`,
]
const killServeTree = () => {
  try {
    spawnSync("powershell", portSweepCmd, { shell: true, stdio: "ignore", timeout: 15000 })
  } catch {}
}

const serve = spawn("opencode", ["serve", "--port", String(PORT), "--hostname", "127.0.0.1"], {
  cwd: WS,
  env: {
    ...process.env,
    OPENCODE_CONFIG_DIR: CFG,
    HYPHEN_PROBE_LOG: PROBE_LOG,
    XDG_CONFIG_HOME: join(ROOT, "xdg"),
    XDG_DATA_HOME: join(ROOT, "data"),
    XDG_CACHE_HOME: join(ROOT, "cache"),
    XDG_STATE_HOME: join(ROOT, "state"),
  },
  shell: true,
  stdio: ["ignore", "pipe", "pipe"],
})
let serveLog = ""
serve.stdout.on("data", (d) => (serveLog += d))
serve.stderr.on("data", (d) => (serveLog += d))

let exitCode = 0
try {
  killServeTree() // pre-sweep
  await sleep(2000)
  let up = false
  for (let i = 0; i < 120 && !up; i++) {
    await sleep(1000)
    try {
      const r = await fetch(`${BASE}/app`)
      if (r.ok) up = true
    } catch {}
  }
  if (!up) throw new Error(`serve never came up in 120s:\n${serveLog.slice(-1200)}`)
  const pw = serveLog.match(/server password (\S+)/)?.[1]
  const auth = pw ? { Authorization: `Basic ${Buffer.from(`opencode:${pw}`).toString("base64")}` } : {}
  log("serve up; auth:", pw ? "basic" : "none")
  // Activate the location (session create) so the plugin setup runs, then
  // invoke the probe command — session.create INSIDE setup deadlocks (see
  // the plugin header), so the probe work rides a command execute.
  let sid
  try {
    const c = await fetch(`${BASE}/api/session?directory=${encodeURIComponent(WS)}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...auth },
      body: JSON.stringify({}),
    })
    const j = await c.json().catch(() => undefined)
    sid = j?.data?.id ?? j?.id
    log("location touch (session create):", c.status, sid ?? "")
  } catch (e) {
    log("location touch failed:", String(e.message).slice(0, 120))
  }
  if (sid) {
    try {
      const inv = await fetch(`${BASE}/api/session/${sid}/command`, {
        method: "POST",
        headers: { "content-type": "application/json", ...auth },
        body: JSON.stringify({ name: "binding-probe", text: "" }),
      })
      log("binding-probe invoke:", inv.status)
    } catch (e) {
      log("invoke failed:", String(e.message).slice(0, 120))
    }
  }
  // Wait for the probe log lines.
  for (let i = 0; i < 40; i++) {
    await sleep(500)
    if (existsSync(PROBE_LOG)) {
      const lines = readFileSync(PROBE_LOG, "utf8").trim().split("\n").filter((l) => l.includes('"ev":'))
      if (lines.length >= 5) break
    }
  }
  const lines = existsSync(PROBE_LOG) ? readFileSync(PROBE_LOG, "utf8").trim().split("\n") : []
  for (const l of lines.slice(0, 10)) log("plugin:", l.slice(0, 420))
  if (!lines.some((l) => l.includes("create-bound-ok"))) {
    log("serveLog tail:", serveLog.slice(-900).replace(/\n/g, " | "))
    exitCode = 2
  }
} catch (e) {
  log("PROBE ERROR:", String(e.message ?? e).slice(0, 500))
  exitCode = 3
} finally {
  killServeTree()
}
process.exit(exitCode)
