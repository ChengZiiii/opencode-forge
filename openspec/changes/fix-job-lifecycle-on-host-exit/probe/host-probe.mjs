// Probe host: loads the CURRENT (pre-fix) job-runner, starts a background
// python http.server job, waits until it serves, drops a ready-file, then
// exits NORMALLY without calling dispose — the suspected `opencode run`
// exit path. Process-level handlers log which cleanup exits actually fire.
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { createJobManager } from "../../../../src/job-manager.ts"
import { startJob, pollJob } from "../../../../src/job-runner.ts"

const dir = process.env.PROBE_DIR
const port = Number(process.env.PROBE_PORT)
const out = (...lines) => writeFileSync(join(dir, "host-events.log"), lines.join("\n") + "\n", { flag: "a" })

out(`host pid=${process.pid} start`)
process.on("exit", () => out("host event: process exit fired"))
process.on("SIGINT", () => out("host event: SIGINT (probe host ignores; not part of scenario)"))

const manager = createJobManager()
const started = startJob(manager, {
  cmd: `python -m http.server ${port} --bind 127.0.0.1`,
  cwd: dir,
  ownerSession: "probe-session",
  worktree: dir,
  logDir: dir,
  runInBackground: true,
})
out(`host: job ${started.job.id} logPath=${started.job.logPath}`)

// Wait until the server actually answers HTTP (banner goes to stdout and is
// block-buffered under a pipe — readiness must be probed, not read).
let ok = "no-answer"
for (let i = 0; i < 100; i++) {
  ok = await fetch(`http://127.0.0.1:${port}/`).then((r) => r.status).catch(() => null)
  if (ok === 200) break
  await new Promise((r) => setTimeout(r, 100))
}
if (ok !== 200) {
  out(`host: server never answered (last=${String(ok)})`)
  process.exit(3)
}
out("host: sanity request status=200 (alive AND healthy while host lives)")
writeFileSync(join(dir, "ready.json"), JSON.stringify({ jobId: started.job.id, port, hostPid: process.pid }))
out("host: ready-file written; exiting NORMALLY (no dispose, no session.deleted simulation)")
process.exit(0)
