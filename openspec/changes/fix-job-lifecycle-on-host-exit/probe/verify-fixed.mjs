// Fixed-build verification driver (tasks 2.2 / 3.2 / 3.3 / 5.3, scripted
// live checks). Every scenario runs a headless node "host" on 127.0.0.1
// with a random port — nothing touches the user's foreground.
import { execFileSync, spawn } from "node:child_process"
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

const root = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")
const results = []
const note = (s) => {
  results.push(s)
  console.log(s)
}

const httpOk = async (port) => fetch(`http://127.0.0.1:${port}/`).then((r) => r.status).catch((e) => `err:${String(e).slice(0, 50)}`)
const httpDown = async (port) => {
  const s = await httpOk(port)
  return s !== 200
}

// Python http.server processes still alive for a given port.
const serversFor = (port) => {
  try {
    const raw = execFileSync("powershell", ["-NoProfile", "-Command", `Get-CimInstance Win32_Process -Filter \"Name='python.exe'\" | Where-Object { $_.CommandLine -match '${port}' } | Select-Object ProcessId | ConvertTo-Json -Compress`], { encoding: "utf8", windowsHide: true, timeout: 15_000 })
    const rows = JSON.parse(raw)
    return (Array.isArray(rows) ? rows : rows ? [rows] : []).map((r) => r.ProcessId)
  } catch {
    return []
  }
}
const killPids = (pids) => {
  for (const p of pids) {
    try {
      execFileSync("taskkill", ["/PID", String(p), "/F", "/T"], { windowsHide: true })
    } catch {}
  }
}

const runHost = async (mode, dir, port) => runHostWithEnv(mode, dir, port, {})
const runHostWithEnv = async (mode, dir, port, extra = {}) => {
  const child = spawn(process.execPath, [join(root, "host.mjs")], {
    env: { ...process.env, PROBE_DIR: dir, PROBE_PORT: String(port), PROBE_MODE: mode, ...extra },
    stdio: ["ignore", "inherit", "inherit"],
    windowsHide: true,
  })
  return new Promise((res) => child.on("exit", (code) => res({ code, pid: child.pid })))
}

const freshDir = (name) => {
  const dir = join(tmpdir(), `forge-lv-${name}`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  return dir
}
const waitMs = (ms) => new Promise((r) => setTimeout(r, ms))
// The kill chains differ in latency (direct taskkill: <300ms; fence kernel
// chain after host death: up to ~2.5s measured) — poll, don't fixed-wait.
const waitUntilGone = async (port, maxMs = 10_000) => {
  // Death = the port stops answering. fetch is the truth; CIM process
  // queries lag seconds behind reality and must never gate the verdict
  // (they caused false negatives on both the kill and relay scenarios).
  const t0 = Date.now()
  while (Date.now() - t0 < maxMs) {
    if (await httpDown(port)) return Date.now() - t0
    await waitMs(250)
  }
  return -1
}

// --- 2.2 + survive semantics: host exits normally, survivor stays HEALTHY ---
{
  const port = 19110 + Math.floor(Math.random() * 200)
  const dir = freshDir("survive")
  const { code } = await runHost("survive-exit", dir, port)
  await waitMs(1_500)
  const alive = serversFor(port)
  const status = alive.length > 0 ? await httpOk(port) : "process-dead"
  note(`2.2 survive: hostExit=${code} survivorAlive=${alive.length > 0} http=${status} -> ${alive.length > 0 && status === 200 ? "PASS (no broken-pipe zombie)" : "FAIL"}`)
  killPids(alive)
  await waitMs(300)
}

// --- 3.2a normal exit: fenced job dies with the host ---
{
  const port = 19310 + Math.floor(Math.random() * 200)
  const dir = freshDir("normalex")
  const { code } = await runHost("normal-exit", dir, port)
  const goneMs = await waitUntilGone(port)
  note(`3.2a normal-exit: hostExit=${code} goneInMs=${goneMs} -> ${goneMs >= 0 ? "PASS (exit-event force kill)" : "FAIL"}`)
  killPids(serversFor(port))
}

// --- 3.2b signal-terminate path (SIGTERM to the host: single-point kill,
// no /T tree walk, no JS exit handler on Windows) — this isolates the FENCE
// chain: host dies -> watcher stdin EOF -> job-object handle closes -> kernel
// kills the fenced tree. A true Ctrl-C cannot be simulated cross-process on
// Windows (CTRL_C_EVENT is console-wide); in a real Ctrl-C the same-console
// child ALSO receives the event itself, so that path has one more layer than
// tested here.
{
  const port = 19510 + Math.floor(Math.random() * 200)
  const dir = freshDir("sigterm")
  let hostPid = 0
  const child = spawn(process.execPath, [join(root, "host.mjs")], {
    env: { ...process.env, PROBE_DIR: dir, PROBE_PORT: String(port), PROBE_MODE: "normal-run" },
    stdio: ["ignore", "inherit", "inherit"], windowsHide: true,
  })
  hostPid = child.pid
  let ready = false
  for (let i = 0; i < 150 && !ready; i++) {
    ready = existsSync(join(dir, "ready.json"))
    if (!ready) await waitMs(100)
  }
  await waitMs(3_000) // let the fence sweep adopt the grandchild
  let termOk = true
  try {
    process.kill(hostPid, "SIGTERM")
  } catch {
    termOk = false
  }
  await new Promise((r) => child.on("exit", r))
  const goneMs = await waitUntilGone(port, 10_000)
  note(`3.2b sigterm-terminate: signaled=${termOk} goneInMs=${goneMs} -> ${goneMs >= 0 ? `PASS (fence chain, ${goneMs}ms)` : "FAIL"}`)
  killPids(serversFor(port))
}

// --- 3.2c WM_CLOSE host kill (taskkill without /F) ---
{
  const port = 19710 + Math.floor(Math.random() * 200)
  const dir = freshDir("wmclose")
  const child = spawn(process.execPath, [join(root, "host.mjs")], {
    env: { ...process.env, PROBE_DIR: dir, PROBE_PORT: String(port), PROBE_MODE: "wmclose" },
    stdio: ["ignore", "inherit", "inherit"],
    windowsHide: true,
  })
  // wait for readiness
  let ready = false
  for (let i = 0; i < 150 && !ready; i++) {
    ready = existsSync(join(dir, "ready.json"))
    if (!ready) await waitMs(100)
  }
  try {
    execFileSync("taskkill", ["/PID", String(child.pid), "/T"], { windowsHide: true })
  } catch {}
  await new Promise((r) => child.on("exit", r))
  const goneMs = await waitUntilGone(port)
  note(`3.2c wmclose-kill: goneInMs=${goneMs} -> ${goneMs >= 0 ? "PASS" : "FAIL"}`)
  killPids(serversFor(port))
}

// --- 3.3 hard kill (taskkill /F): ONLY the fence can clean this up ---
{
  const port = 19910 + Math.floor(Math.random() * 200)
  const dir = freshDir("hardkill")
  const child = spawn(process.execPath, [join(root, "host.mjs")], {
    env: { ...process.env, PROBE_DIR: dir, PROBE_PORT: String(port), PROBE_MODE: "hardkill" },
    stdio: ["ignore", "inherit", "inherit"],
    windowsHide: true,
  })
  let ready = false
  for (let i = 0; i < 150 && !ready; i++) {
    ready = existsSync(join(dir, "ready.json"))
    if (!ready) await waitMs(100)
  }
  if (!ready) note(`3.3 hardkill: HOST NEVER READY (scenario aborted)`)
  const t0 = Date.now()
  try {
    execFileSync("taskkill", ["/PID", String(child.pid), "/F", "/T"], { windowsHide: true })
  } catch {}
  // Poll for job death at 250ms granularity — the fence's stdin-EOF -> watcher
  // exit -> kernel kill chain lands in the hundreds-of-ms range.
  let dead = false
  let deadAt = 0
  for (let i = 0; i < 40 && !dead; i++) {
    await waitMs(250)
    if (serversFor(port).length === 0) {
      dead = true
      deadAt = Date.now() - t0
    }
  }
  const down = await httpDown(port)
  note(`3.3 hardkill(/F): jobDead=${dead} inMs=${deadAt} portDown=${down} -> ${dead && down ? (deadAt <= 2_000 ? `PASS (kernel fence, ${deadAt}ms)` : `PASS-SLOW (${deadAt}ms)`) : "FAIL"}`)
  killPids(serversFor(port))
}

// --- 5.3 cross-host relay: host A leaves a survivor, host B adopts/poll/kills ---
{
  const port = 20110 + Math.floor(Math.random() * 200)
  const dir = freshDir("relay")
  const a = await runHost("relay-a", dir, port)
  await waitMs(1_000)
  const stillAlive = serversFor(port)
  const b = await runHost("relay-b", dir, port)
  const goneRelay = await waitUntilGone(port, 12_000)
  const regLeft = JSON.parse(readFileSync(join(dir, "registry.json"), "utf8")).entries.length
  const afterB = serversFor(port)
  const events = readFileSync(join(dir, "host-events.log"), "utf8")
  const adopted = /relay-b scan adopted=1/.test(events)
  const polled = /relay-b job=.*poll state=running newLen=\d+/.test(events)
  const killed = goneRelay >= 0 && regLeft === 0
  note(`5.3 relay: hostA=${a.code} survivorAliveAfterA=${stillAlive.length > 0} hostB=${b.code} adopted=${adopted} polled=${polled} killed=${killed} inMs=${goneRelay} registryLeft=${regLeft} cimLinger=${afterB.length} -> ${stillAlive.length > 0 && adopted && polled && killed ? "PASS" : "FAIL"}`)
  killPids(serversFor(port))
}

writeFileSync(join(root, "findings-fixed.txt"), results.join("\n") + "\n")
console.log("\nwritten to probe/findings-fixed.txt")
