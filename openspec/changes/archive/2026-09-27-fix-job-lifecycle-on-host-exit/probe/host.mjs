// Fixed-build probe host: loads the REWORKED job-runner (stdio file-backed,
// exit matrix, fence, registry) exactly like the plugin would, starts one
// job per scenario, then exits through the scenario's designated exit path.
//   mode=survive-exit   survive:true job, then process.exit(0)      (2.2)
//   mode=normal-exit    fenced job,  then process.exit(0)          (3.2a)
//   mode=sigint         fenced job,  then process.kill(SIGINT)     (3.2b)
//   mode=wmclose        fenced job,  host killed by taskkill (no /F) (3.2c)
//   mode=hardkill       fenced job,  host killed by taskkill /F    (3.3 — fence only)
//   mode=relay-a        survive job, host exits                    (5.3 leg A)
//   mode=relay-b        adopts survivors from the registry, dumps poll/log/kill results (5.3 leg B)
import { writeFileSync, readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { createJobManager } from "../../../../src/job-manager.ts"
import { createJobRegistry, structuralRelocate, structuralRelocateAsync } from "../../../../src/job-registry.ts"
import { adoptSurvivor, jobsLogDir, pollJob, readJobLog, startJob } from "../../../../src/job-runner.ts"
import { createJobFence } from "../../../../src/job-fence.ts"
import { createExitCleanup } from "../../../../src/host-exit.ts"
import { pidAlive } from "../../../../src/proc.ts"

const dir = process.env.PROBE_DIR
const port = Number(process.env.PROBE_PORT)
const mode = process.env.PROBE_MODE
const out = (...lines) => writeFileSync(join(dir, "host-events.log"), lines.join("\n") + "\n", { flag: "a" })
out(`host pid=${process.pid} mode=${mode} start`)

const manager = createJobManager()
const registry = createJobRegistry(join(dir, "registry.json"))
const fence = createJobFence({ onDegrade: (r) => out(`host: fence degraded: ${r}`) })
out(`host: fence started=${!!fence}`)
const cleanup = createExitCleanup(manager, { graceMs: 1_500, after: () => fence?.dispose() })

if (mode === "relay-b") {
  const { adopted, dead } = registry.rescan(pidAlive, structuralRelocate)
  out(`host: relay-b scan adopted=${adopted.length} dead=${dead.length}`)
  for (const e of adopted) {
    const job = adoptSurvivor(manager, e, { registry, logDir: dir, relocate: structuralRelocate })
    const p = await pollJob(manager, job.id, 2_000)
    const page = readJobLog(job.logPath, { limit: 5 })
    out(`host: relay-b job=${job.id} poll state=${p?.state} newLen=${p?.newOutput?.length ?? 0} logLines=${page.total}`)
    manager.kill(job)
    out(`host: relay-b kill issued entry.pid=${e.pid} job.pid=${job.pid} aliveEntry=${pidAlive(e.pid)} aliveJob=${pidAlive(job.pid ?? 0)} registryLeft=${registry.list().length}`)
    // Give the async taskkill a real chance before this process exits.
    await new Promise((r) => setTimeout(r, 2_500))
    out(`host: relay-b post-wait aliveJob=${pidAlive(job.pid ?? 0)} aliveEntry=${pidAlive(e.pid)}`)
  }
  out("host: relay-b done")
  process.exit(0)
}

const survive = mode === "survive-exit" || mode === "relay-a"
const started = startJob(manager, {
  cmd: `python -m http.server ${port} --bind 127.0.0.1`,
  cwd: dir,
  ownerSession: "probe",
  worktree: dir,
  logDir: dir,
  runInBackground: true,
  ...(survive ? { survive: true, registry } : { fence, relocate: structuralRelocate, relocateAsync: structuralRelocateAsync }),
})
out(`host: job ${started.job.id} pid=${started.job.pid} survive=${!!survive}`)

// Readiness = HTTP 200 (python's banner is block-buffered under a pipe-file).
let ok = null
for (let i = 0; i < 150 && ok !== 200; i++) {
  ok = await fetch(`http://127.0.0.1:${port}/`).then((r) => r.status).catch(() => null)
  if (ok !== 200) await new Promise((r) => setTimeout(r, 100))
}
if (ok !== 200) {
  const alive = pidAlive(started.job.pid)
  const kid = await structuralRelocateAsync(started.job.pid)
  out(`host: readiness failed http=${ok} wrapperAlive=${alive} kidPid=${kid}`)
}
out(`host: readiness http=${ok}`)
if (ok !== 200) process.exit(3)
writeFileSync(join(dir, "ready.json"), JSON.stringify({ jobId: started.job.id, port, hostPid: process.pid, pid: started.job.pid }))

if (mode === "normal-exit") {
  out("host: exiting via process.exit(0)")
  process.exit(0)
} else if (mode === "sigint") {
  if (process.env.PROBE_SIGINT_DELAY_MS) {
    out(`host: waiting ${process.env.PROBE_SIGINT_DELAY_MS}ms before SIGINT (diagnostic window for fence reinforcement)`)
    await new Promise((r) => setTimeout(r, Number(process.env.PROBE_SIGINT_DELAY_MS)))
  }
  out(`host: pre-SIGINT job.pid=${started.job.pid} (reinforced if != spawn pid)`)
  out("host: raising SIGINT on self")
  process.kill(process.pid, "SIGINT")
  // The exit-matrix handler runs synchronously; give it a moment then die.
  setTimeout(() => process.exit(0), 4_000)
} else if (mode === "normal-run") {
  out("host: idling until terminated by the driver")
  setInterval(() => {}, 1 << 30)
} else if (mode === "survive-exit" || mode === "relay-a") {
  out("host: exiting via process.exit(0) — survivor must stay HEALTHY")
  process.exit(0)
} else {
  out(`host: unknown mode ${mode}`)
  process.exit(4)
}
