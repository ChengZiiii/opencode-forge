// Historical (2026-11-26, retire-plugin-runtime): historical command-domain probe; not current command acceptance.
// v2-command-surface task 1.1 gate probe: does a 2.3.x host accept a
// hyphenated command name on the v2 command domain, and what does the
// invocation actually deliver to execute?
//
// Field realities baked in (2.3.2, 2026-11-22):
//   - config `plugin` file:// entries must point at a DIRECTORY package
//     (single .mjs files are dropped with "configured plugin path must be a
//     directory" — core/src/config/plugin/source.ts L154) → probe ships as a
//     probe-pkg dir with package.json main index.mjs (npm-postpublish-e2e
//     precedent).
//   - standalone `opencode serve` prints a random `server password <pw>` on
//     stdout; /app is public, API routes may 401 → capture the password and
//     send Basic auth when present.
//
// Usage: node scripts/hyphen-command-probe.mjs
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { spawn, spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const REPO = resolve(process.cwd()).replaceAll("\\", "/")
// Per-run unique root: a leftover serve from a previous run holds its cwd
// handle, and Windows rmSync on a live dir EPERMs (2026-11-22 field reality).
const ROOT = join(tmpdir(), "opencode", `hyphen-probe-${process.pid}`)
const CFG = join(ROOT, "config")
const WS = join(ROOT, "ws")
const PKG = join(ROOT, "probe-pkg")
const PROBE_LOG = join(ROOT, "probe.log")
const PORT = 40000 + ((process.pid * 7) % 9000) // per-run port: reused ports carry TIME_WAIT heels on win32 (bind fails for minutes after a kill)
const BASE = `http://127.0.0.1:${PORT}`

rmSync(ROOT, { recursive: true, force: true })
try {
  mkdirSync(CFG, { recursive: true })
} catch {
  // parent exists / racing handle — the subdirs below still get created
}
mkdirSync(WS, { recursive: true })
mkdirSync(PKG, { recursive: true })
writeFileSync(join(PKG, "package.json"), JSON.stringify({ name: "hyphen-probe", type: "module", main: "index.mjs" }))
copyFileSync(join(process.cwd(), "scripts", "hyphen-command-probe-plugin.mjs"), join(PKG, "index.mjs"))
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
const portSweepCmd = [
  "-NoProfile",
  "-Command",
  `Get-NetTCPConnection -LocalPort ${PORT} -State Listen -ErrorAction SilentlyContinue | ForEach-Object { taskkill /pid $_.OwningProcess /T /F }`,
]
const killServeTree = () => {
  // spawnSync: a pending async spawn during process exit trips a libuv
  // assertion on win32 (UV_HANDLE_CLOSING) — keep the kill synchronous.
  try {
    spawnSync("powershell", portSweepCmd, { shell: true, stdio: "ignore", timeout: 15000 })
  } catch {}
}
let exitCode = 0
try {
  // Pre-sweep + port-free verification: a leftover serve from an earlier run
  // (job tree-kill does not reach the shim's node grandchild) would hold the
  // port, and our spawn would die with "port in use" while /app silently
  // answers from the ZOMBIE (unknown password → 401s below). Sweep by port
  // OWNER and do not spawn until the port stops answering.
  for (let i = 0; i < 15; i++) {
    let occupied = false
    try {
      const r = await fetch(`${BASE}/app`, { signal: AbortSignal.timeout(1500) })
      occupied = true
    } catch {}
    if (!occupied) break
    try {
      spawnSync("powershell", portSweepCmd, { shell: true, stdio: "ignore", timeout: 15000 })
    } catch {}
    await sleep(2000)
  }

  // Readiness: /app is the public probe (npm-postpublish-e2e precedent).
  let up = false
  for (let i = 0; i < 120 && !up; i++) {
    await sleep(1000)
    try {
      const r = await fetch(`${BASE}/app`)
      if (r.ok) up = true
    } catch {}
  }
  if (!up) throw new Error(`serve never came up in 120s:\n${serveLog.slice(-1500)}`)
  log("serve up")
  // The stdout pipe is block-buffered (no TTY) — the password line may never
  // flush. Fall back to the on-disk credentials: the persisted service config
  // (XDG_CONFIG_HOME/opencode/service.json) and the live registration
  // (XDG_STATE_HOME/opencode/service[-local|-<channel>].json) both carry it.
  let pw = serveLog.match(/server password (\S+)/)?.[1]
  const credCandidates = [
    join(ROOT, "xdg", "opencode", "service.json"),
    join(ROOT, "state", "opencode", "service.json"),
    join(ROOT, "state", "opencode", "service-local.json"),
  ]
  const readCred = () => {
    for (const f of credCandidates) {
      if (!existsSync(f)) continue
      try {
        const v = JSON.parse(readFileSync(f, "utf8"))?.password
        if (typeof v === "string" && v) return v
      } catch {}
    }
    return undefined
  }
  for (let i = 0; i < 20 && !pw; i++) {
    await sleep(500)
    pw = serveLog.match(/server password (\S+)/)?.[1] ?? readCred()
  }
  if (!pw) {
    for (const f of credCandidates) log("cred file", f, existsSync(f) ? "exists" : "absent")
    log("serveLog tail:", serveLog.slice(-400).replace(/\n/g, " | "))
  }
  log("password captured:", pw ? "yes" : "NO")
  const auth = pw ? { Authorization: `Basic ${Buffer.from(`opencode:${pw}`).toString("base64")}` } : {}
  // Auth posture documentation: bare vs authed /api/info.
  try {
    const bare = await fetch(`${BASE}/api/info`)
    log("auth posture: /api/info bare ->", bare.status)
  } catch (e) {
    log("auth posture: /api/info bare errored:", String(e.message).slice(0, 80))
  }

  const api = async (path, init) => {
    const res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: { "content-type": "application/json", ...auth, ...(init?.headers ?? {}) },
    })
    const text = await res.text()
    let json
    try {
      json = JSON.parse(text)
    } catch {}
    return { status: res.status, text, json }
  }

  // Gate 1: hyphenated command listed. The list is location-scoped and the
  // plugin-editor commands may land in a DIFFERENT location than the query —
  // try the three variants and print each.
  for (const [label, qs] of [
    ["ws", `location[directory]=${encodeURIComponent(WS)}`],
    ["bare", ""],
    ["home", `location[directory]=${encodeURIComponent(join(ROOT, "xdg"))}`],
  ]) {
    const list = await api(`/api/command${qs ? `?${qs}` : ""}`)
    const raw = Array.isArray(list.json) ? list.json : Array.isArray(list.json?.data) ? list.json.data : undefined
    const names = raw ? raw.map((c) => c?.name ?? c?.id) : undefined
    log(`command.list[${label}] status:`, list.status, "names:", JSON.stringify(names))
    if (label === "ws" && list.json && !raw) log("list body sample:", JSON.stringify(list.json).slice(0, 400))
  }
  const list = await api(`/api/command?location[directory]=${encodeURIComponent(WS)}`)
  const raw = Array.isArray(list.json) ? list.json : Array.isArray(list.json?.data) ? list.json.data : undefined
  const names = raw ? raw.map((c) => c?.name ?? c?.id) : undefined
  const listed = Array.isArray(names) && names.includes("forge-sync")
  log(listed ? "PASS gate1: forge-sync listed" : "FAIL gate1: forge-sync NOT in location[directory]=ws list")

  // Gate 2: invocation delivers typed args to execute.
  const c1 = await api(`/api/session?directory=${encodeURIComponent(WS)}`, { method: "POST", body: JSON.stringify({}) })
  const sid = c1.status < 300 ? (c1.json?.data?.id ?? c1.json?.id) : undefined
  if (!sid) log("session create failed:", c1.status, (c1.text || "").slice(0, 200))
  if (sid) {
    const inv = await api(`/api/session/${sid}/command`, {
      method: "POST",
      body: JSON.stringify({ name: "forge-sync", text: "sync", delivery: "steer" }),
    })
    log("command invoke status:", inv.status, (inv.text || "").slice(0, 200))
    let execLine
    for (let i = 0; i < 40; i++) {
      await sleep(500)
      if (existsSync(PROBE_LOG)) {
        const lines = readFileSync(PROBE_LOG, "utf8").trim().split("\n")
        execLine = lines.find((l) => l.includes('"ev":"execute-input"'))
        if (execLine) break
      }
    }
    log("execute-input:", execLine ?? "(never arrived in 20s)")
    const rest = existsSync(PROBE_LOG)
      ? readFileSync(PROBE_LOG, "utf8").trim().split("\n").filter((l) => /prompt|skip|transform|editor|setup/.test(l))
      : []
    for (const l of rest.slice(0, 6)) log("plugin:", l.slice(0, 280))
  }
  if (!listed) exitCode = 2
} catch (e) {
  log("PROBE ERROR:", String(e.message ?? e).slice(0, 600))
  exitCode = 3
} finally {
  killServeTree()
}
process.exit(exitCode)
