// Shared process primitives for the forge plugin: shell spawn with a
// cross-platform process-tree kill, plus injectable seams so tests drive
// fakes. No @opencode-ai imports; nothing here knows about opencode.

import { spawn, type ChildProcess } from "node:child_process"

export type SpawnFn = typeof spawn

export type ShellSpawnOptions = {
  cwd?: string
  /** Merged over the parent environment — marker variables (FORGE_JOB_ID, ...) ride along here. */
  env?: Record<string, string | undefined>
  /** Own process group on POSIX so the whole tree is signalable. Defaults per-platform (true off Windows). */
  detached?: boolean
  windowsHide?: boolean
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
  })
}

// The platform plan for killing a shell child's whole tree. Windows: the
// direct child is cmd.exe with the real command as a grandchild, so
// `taskkill /F /T` is required. POSIX: the child was spawned detached (own
// process group), so the group can be signalled directly.
export function treeKillPlan(platform: string, pid: number): { kind: "taskkill"; args: string[] } | { kind: "group"; signal: string } {
  if (platform === "win32") return { kind: "taskkill", args: ["/pid", String(pid), "/F", "/T"] }
  return { kind: "group", signal: "SIGKILL" }
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
