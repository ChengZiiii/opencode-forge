// Minimal fence-only host: real createJobFence, real python job, then idle.
// The driver TerminateProcess'es this host (SIGTERM cross-process) so the
// ONLY thing that can kill the python tree is the fence kernel chain.
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { spawn } from "node:child_process"
import { createJobFence } from "../../../../src/job-fence.ts"
const dir = process.env.PROBE_DIR
const port = Number(process.env.PROBE_PORT)
const out = (s) => writeFileSync(join(dir, "host-events.log"), s + "\n", { flag: "a" })
const fence = createJobFence({ onDegrade: (r) => out(`fence degraded: ${r}`) })
out(`fence started=${!!fence}`)
const child = spawn(`python -m http.server ${port} --bind 127.0.0.1`, { shell: true, windowsHide: true, detached: false, env: process.env, stdio: ["ignore", "ignore", "ignore"] })
out(`job wrapper pid=${child.pid}`)
fence?.assign(child.pid)
setInterval(() => {}, 1 << 30)
