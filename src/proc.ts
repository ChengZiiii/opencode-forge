// Shared process primitives for the forge plugin: shell spawn with a
// cross-platform process-tree kill, plus injectable seams so tests drive
// fakes. No @opencode-ai imports; nothing here knows about opencode.

import { spawn, spawnSync, type ChildProcess } from "node:child_process"

export type SpawnFn = typeof spawn
export type SpawnSyncFn = typeof spawnSync

/** Structural type of the job-fence watcher handle (src/job-fence.ts). */
export type JobFenceLike = { assign(pid: number): void; dispose(): void }

export type ShellSpawnOptions = {
  cwd?: string
  /** Merged over the parent environment — marker variables (FORGE_JOB_ID, ...) ride along here. */
  env?: Record<string, string | undefined>
  /** Own process group on POSIX so the whole tree is signalable. Defaults per-platform (true off Windows). */
  detached?: boolean
  windowsHide?: boolean
  /** Full stdio override — job-runner passes ["ignore", logFd, logFd] so output lands in the log file directly. */
  stdio?: ChildProcess["stdio"]
}

// Spawn `cmd` through the platform shell. Defaults mirror the original
// run-check behavior: hidden window on Windows, own process group on POSIX.
export function shellSpawn(spawnFn: SpawnFn, cmd: string, opts: ShellSpawnOptions = {}): ChildProcess {
  return spawnFn(cmd, {
    shell: true,
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    env: opts.env ? { ...process.env, ...opts.env } : process.env,
    windowsHide: opts.windowsHide ?? true,
    detached: opts.detached ?? process.platform !== "win32",
    ...(opts.stdio !== undefined ? { stdio: opts.stdio } : {}),
  })
}

// The platform plan for killing a shell child's whole tree. Windows: the
// direct child is cmd.exe with the real command as a grandchild, so
// `taskkill /F /T` is required. POSIX: the child was spawned detached (own
// process group), so the group can be signalled directly.
export function treeKillPlan(platform: string, pid: number, force = true): { kind: "taskkill"; args: string[] } | { kind: "group"; signal: string } {
  if (platform === "win32") return { kind: "taskkill", args: force ? ["/pid", String(pid), "/F", "/T"] : ["/pid", String(pid), "/T"] }
  return { kind: "group", signal: force ? "SIGKILL" : "SIGTERM" }
}

// Kill a spawned shell child and its whole tree. Falls back to a direct kill
// when the platform call throws (pid reuse / process already gone).
export function killTree(
  child: Pick<ChildProcess, "pid" | "kill">,
  opts: { spawnFn?: SpawnFn; platform?: string } = {},
): void {
  const platform = opts.platform ?? process.platform
  if (!child.pid) {
    child.kill()
    return
  }
  const plan = treeKillPlan(platform, child.pid)
  if (plan.kind === "taskkill") {
    try {
      ;(opts.spawnFn ?? spawn)("taskkill", plan.args, { windowsHide: true, stdio: "ignore" })
    } catch {
      child.kill()
    }
  } else {
    try {
      process.kill(-child.pid, plan.signal as NodeJS.Signals)
    } catch {
      child.kill(plan.signal as NodeJS.Signals)
    }
  }
}

// Liveness of an arbitrary pid (adopted registry survivors have no child
// handle). Windows: process.kill(pid, 0) throws for foreign-process pids
// with EPERM — that still proves the process exists.
export function pidAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM"
  }
}

// Synchronous tree termination with graceful-then-force semantics, used on
// the process exit paths (the 'exit' event allows no async work; the signal
// handlers share it so one code path covers the matrix). Graceful pass:
// taskkill without /F (WM_CLOSE / CTRL_CLOSE) on Windows, SIGTERM to the
// process group on POSIX; bounded wait; force pass always runs at the end —
// a job that died early costs only one failed taskkill.
export function terminateTreeSync(
  pid: number,
  opts: { graceMs?: number; spawnSyncFn?: SpawnSyncFn; platform?: string; wait?: boolean } = {},
): { graceful: boolean; forced: boolean } {
  const graceMs = Math.max(0, opts.graceMs ?? 0)
  const platform = opts.platform ?? process.platform
  const sync = opts.spawnSyncFn ?? spawnSync
  // The wait between passes REALLY sleeps (Atomics.wait on the main thread —
  // allowed here: this runs on exit paths where nothing else may proceed).
  // Tests and callers that must not block pass wait: false.
  const wait = opts.wait ?? true
  const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  const run = (force: boolean) => {
    const plan = treeKillPlan(platform, pid, force)
    if (plan.kind === "taskkill") {
      try {
        sync("taskkill", plan.args, { windowsHide: true, stdio: "ignore", timeout: 10_000 })
      } catch {
        // Already gone or taskkill missing — the force pass reports it.
      }
    } else {
      try {
        process.kill(-pid, plan.signal as NodeJS.Signals)
      } catch {
        try {
          process.kill(pid, plan.signal as NodeJS.Signals)
        } catch {
          // Already gone.
        }
      }
    }
  }
  // A zero grace window means the caller has no time for the graceful pass
  // (process 'exit' path): go straight to force.
  if (graceMs > 0) {
    run(false)
    if (wait) {
      const deadline = Date.now() + graceMs
      while (Date.now() < deadline && pidAlive(pid)) sleep(Math.min(100, deadline - Date.now()))
    }
  }
  run(true)
  return { graceful: graceMs > 0, forced: true }
}
