// Probe driver: spawns the probe host, waits for ready + host exit, then
// asserts what the pre-fix build actually leaves behind: is the python
// process alive? does it still answer HTTP (healthy) or handshake-then-die
// (broken-pipe zombie)? Cleans up afterwards. Background-safe: 127.0.0.1
// only, headless processes, no window focus.
import { execFileSync, spawn } from "node:child_process"
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

const root = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")
const dir = join(tmpdir(), "forge-lifecycle-probe")
rmSync(dir, { recursive: true, force: true })
mkdirSync(dir, { recursive: true })
const port = 18470 + Math.floor(Math.random() * 100)

const findings = []
const note = (s) => {
  findings.push(s)
  console.log(s)
}

const host = spawn(process.execPath, [join(root, "host-probe.mjs")], {
  env: { ...process.env, PROBE_DIR: dir, PROBE_PORT: String(port) },
  stdio: ["ignore", "inherit", "inherit"],
  windowsHide: true,
})
const hostCode = await new Promise((res) => host.on("exit", res))
note(`host exit code: ${hostCode}`)

const ready = JSON.parse(readFileSync(join(dir, "ready.json"), "utf8"))
note(`job id: ${ready.jobId}`)

// Give any kill path a moment to act (a working cleanup would land here).
await new Promise((r) => setTimeout(r, 1500))

// 1. Is the job's python process still alive? Find PIDs whose command line
//    carries the probe port.
let alive = []
try {
  const raw = execFileSync("powershell", ["-NoProfile", "-Command", "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'http.server' } | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress"], { encoding: "utf8", windowsHide: true, timeout: 15000 })
  const rows = JSON.parse(raw)
  alive = (Array.isArray(rows) ? rows : rows ? [rows] : []).filter((p) => String(p.CommandLine).includes(String(port)))
} catch {}
note(`python http.server processes still alive after host exit: ${alive.map((p) => p.ProcessId).join(", ") || "(none)"}`)

// 2. Does it answer HTTP (healthy) or break (zombie)?
if (alive.length > 0) {
  const status = await fetch(`http://127.0.0.1:${port}/`).then((r) => r.status).catch((e) => `err:${String(e).slice(0, 80)}`)
  note(`post-exit HTTP status: ${status}`)
  note(`zombie verdict: ${status === 200 ? "SURVIVED-HEALTHY" : "SURVIVED-BROKEN (broken-pipe zombie: connection opens, handler dies writing stdout)"}`)
} else {
  note("zombie verdict: CLEAN (job tree died with the host)")
}

// Cleanup: kill leftovers whatever they are.
for (const p of alive) {
  try {
    execFileSync("taskkill", ["/PID", String(p.ProcessId), "/F", "/T"], { windowsHide: true })
  } catch {}
}

writeFileSync(
  join(root, "findings.txt"),
  findings.join("\n") + "\n\nhost-events.log:\n" + readFileSync(join(dir, "host-events.log"), "utf8") + "\njob log tail:\n" + readFileSync(join(dir, ready.jobId + ".log"), "utf8").slice(-500),
)
console.log("\nfindings written to probe/findings.txt")
