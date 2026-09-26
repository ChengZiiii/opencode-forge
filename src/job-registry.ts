// Persisted registry of surviving jobs (design D4): jobs started with
// survive=true record their pid/log/command here so a LATER host process can
// adopt them (poll/log/kill across `opencode run` invocations) and so dead
// survivors are detected and ledgered instead of silently rotting. On POSIX
// this scan is also the orphan-detection backstop the spec promises (there
// is no kernel fence there).
//
// File shape: JSON { "version": 1, "entries": [ { id, pid, cmd, logPath,
// startedAt, ownerSession, hostPid } ] } kept under the jobs log dir. All
// writes are read-modify-write under a lock file (exclusive create, bounded
// stale age) because several opencode processes may run concurrently.

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { execFileSync, spawn } from "node:child_process"
import { dirname, join } from "node:path"

export const REGISTRY_KEEP = 100

export type SurvivorEntry = {
  id: string
  pid: number
  cmd: string
  logPath: string
  startedAt: number
  ownerSession: string
  hostPid: number
}

export type JobRegistry = {
  add(entry: SurvivorEntry): void
  remove(id: string): void
  /** Current on-disk entries (re-read; multi-host safe). */
  list(): SurvivorEntry[]
  /**
   * Split the on-disk entries by liveness: `adopted` still have a live pid
   * (merge them into the job table), `dead` do not (ledger + drop). A dead
   * pid first goes through `relocate` — the recorded pid is the SHELL
   * wrapper (cmd.exe), which dies with the spawning host even when the job
   * itself survives; the structural fallback (live child of the dead pid)
   * re-targets the real process. Rewrites the file to keep the adopted set
   * (with relocated pids).
   */
  rescan(isAlive: (pid: number) => boolean, relocate?: (deadPid: number) => number | null): { adopted: SurvivorEntry[]; dead: SurvivorEntry[] }
}

/**
 * Structural relocation of a survivor whose recorded pid (the shell wrapper)
* died: find a LIVE process whose parent was that pid. Windows: CIM
* ParentProcessId lookup; POSIX: /proc/<pid>/stat ppid field. Returns null
* when nothing living descends from the dead wrapper — the job is truly gone.
 * Never matches by command line: parentage alone is precise and cannot hit
 * an unrelated user process.
 */
export function structuralRelocate(deadPid: number, platform: string = process.platform): number | null {
  if (deadPid <= 0) return null
  if (platform === "win32") {
    // CIM occasionally returns an empty table on a warm query (live finding:
    // a healthy survivor was misjudged dead at the next host's startup).
    // One bounded retry closes that hole.
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300)
      try {
        const raw = execFileSync(
          "powershell",
          ["-NoProfile", "-Command", `Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq ${deadPid} -and $_.Name -ne 'conhost.exe' } | Select-Object -First 1 -ExpandProperty ProcessId`],
          { encoding: "utf8", windowsHide: true, timeout: 10_000 },
        )
        const pid = Number(String(raw).trim())
        if (Number.isInteger(pid) && pid > 0) return pid
      } catch {
        // fall through to the retry / null
      }
    }
    return null
  }
  try {
    for (const ent of readdirSync("/proc")) {
      if (!/^\d+$/.test(ent)) continue
      try {
        // stat fields: pid (comm) state ppid ...
        const m = /^(\d+) \((.*)\) (\w) (\d+)/.exec(readFileSync(`/proc/${ent}/stat`, "utf8"))
        if (m && Number(m[4]) === deadPid) return Number(m[1])
      } catch {
        // Process vanished mid-scan — keep going.
      }
    }
  } catch {
    return null
  }
  return null
}

/**
 * Non-blocking variant for the job runner's fence reinforcement: the
 * synchronous CIM call stalls the host's event loop for ~0.5-1s, which is
 * unacceptable between spawn and the caller's first poll (live finding: a
 * readiness loop missed its window behind the blocking lookup). Never
 * rejects; resolves null when nothing living descends from the dead pid.
 */
export function structuralRelocateAsync(deadPid: number, platform: string = process.platform): Promise<number | null> {
  if (deadPid <= 0) return Promise.resolve(null)
  if (platform !== "win32") return Promise.resolve(structuralRelocate(deadPid, platform))
  return new Promise((resolve) => {
    let out = ""
    let settled = false
    const done = (pid: number | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const n = Number(String(out).trim())
      resolve(Number.isInteger(n) && n > 0 ? n : pid)
    }
    const child = spawn(
      "powershell",
      ["-NoProfile", "-Command", `Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq ${deadPid} -and $_.Name -ne 'conhost.exe' } | Select-Object -First 1 -ExpandProperty ProcessId`],
      { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] },
    )
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {}
      done(null)
    }, 10_000)
    child.stdout?.on("data", (d) => {
      out += d
    })
    child.on("error", () => done(null))
    child.on("exit", () => done(null))
  })
}

type Lock = { release: () => void }

function acquireLock(lockPath: string, timeoutMs = 2_000): Lock | null {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const fd = openSync(lockPath, "wx")
      return {
        release: () => {
          try {
            closeSync(fd)
            unlinkSync(lockPath)
          } catch {
            // Already removed — fine.
          }
        },
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err
      // Stale lock: holder crashed mid-write. Break it after 5s.
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > 5_000) {
          unlinkSync(lockPath)
          continue
        }
      } catch {
        // Lock vanished between open and stat — retry immediately.
      }
      if (Date.now() >= deadline) return null
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50)
    }
  }
}

function readRaw(path: string): SurvivorEntry[] {
  try {
    const raw = existsSync(path) ? readFileSync(path, "utf8") : ""
    if (!raw.trim()) return []
    const parsed = JSON.parse(raw) as { version?: number; entries?: SurvivorEntry[] }
    if (!Array.isArray(parsed.entries)) return []
    return parsed.entries.filter((e) => typeof e?.id === "string" && Number.isFinite(e?.pid) && e.pid > 0)
  } catch {
    // Corrupt registry behaves as empty (self-heals on next write).
    return []
  }
}

function writeRaw(path: string, entries: SurvivorEntry[]): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify({ version: 1, entries: entries.slice(0, REGISTRY_KEEP) }, null, 2)}\n`)
}

export function createJobRegistry(registryPath: string): JobRegistry {
  const lockPath = `${registryPath}.lock`
  // Read-modify-write under the lock; a lock that cannot be acquired inside
  // the bounded window is skipped (another host is mid-write — the next
  // mutation wins, entries are idempotent by id).
  const mutate = (fn: (entries: SurvivorEntry[]) => SurvivorEntry[]): boolean => {
    const lock = acquireLock(lockPath)
    if (!lock) return false
    try {
      writeRaw(registryPath, fn(readRaw(registryPath)))
      return true
    } finally {
      lock.release()
    }
  }
  return {
    add(entry) {
      mutate((entries) => [entry, ...entries.filter((e) => e.id !== entry.id)].slice(0, REGISTRY_KEEP))
    },
    remove(id) {
      mutate((entries) => entries.filter((e) => e.id !== id))
    },
    list() {
      return readRaw(registryPath)
    },
    rescan(isAlive, relocate) {
      const entries = readRaw(registryPath)
      const adopted: SurvivorEntry[] = []
      const dead: SurvivorEntry[] = []
      for (const e of entries) {
        if (isAlive(e.pid)) {
          adopted.push(e)
          continue
        }
        // The recorded pid is the shell wrapper; when the spawning host died
        // the wrapper may have died with it while the job lives on. Follow
        // parentage to the real process before declaring the job dead.
        const relocated = relocate?.(e.pid) ?? null
        if (relocated !== null && relocated !== e.pid && isAlive(relocated)) {
          adopted.push({ ...e, pid: relocated })
        } else {
          dead.push(e)
        }
      }
      const lock = acquireLock(lockPath)
      if (lock) {
        try {
          writeRaw(registryPath, adopted)
        } finally {
          lock.release()
        }
      }
      return { adopted, dead }
    },
  }
}

export function registryPathFor(jobsDir: string): string {
  return join(jobsDir, "registry.json")
}

// Helper for the uninstall note (README): where the registry lives.
export function registryExists(path: string): boolean {
  return existsSync(path) || existsSync(`${path}.lock`)
}
