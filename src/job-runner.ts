// Process side of the forge job supervisor: spawns shell commands, races the
// four completion conditions, and keeps capturing output after an early
// return. Completion binds to the child's EXIT event, never to stdio stream
// EOF — and since the lifecycle rework the child has NO host-held pipes at
// all: stdout/stderr are the log file itself (inherited file descriptor,
// stdio ["ignore", logFd, logFd]). That kills the whole broken-pipe class:
// a job that outlives the host (survive mode) stays healthy because it never
// wrote into a dead pipe, and no grandchild can suspend the host on a
// `close` event because there are no pipes to hold.
//
// Capture is a file tail: a small unref'd poller feeds the manager's ring
// (and the success-pattern matcher) with new bytes from the log file; polls
// flush on demand so callers see output instantly.

import { spawn, type ChildProcess } from "node:child_process"
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readSync, readFileSync, statSync, unlinkSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { killTree, pidAlive, shellSpawn, type JobFenceLike, type SpawnFn } from "./proc.ts"
import { newJobId, type Job, type JobManager } from "./job-manager.ts"
import type { JobRegistry, SurvivorEntry } from "./job-registry.ts"

export const DEFAULT_IDLE_MS = 60_000
export const DEFAULT_MAX_WAIT_MS = 120_000
export const HARD_MAX_WAIT_MS = 600_000
export const POLL_WAIT_MAX_MS = 30_000
export const DEFAULT_LOG_KEEP = 50
export const JOB_ENV_MARKER = "FORGE_JOB_ID"
const TAIL_POLL_MS = 200
const ADOPT_LIVENESS_MS = 1_000

export function jobsLogDir(base?: string): string {
  return join(base ?? join(tmpdir(), "opencode-forge"), "jobs")
}

export type StartOptions = {
  cmd: string
  cwd: string
  ownerSession: string
  worktree: string
  logDir: string
  runInBackground?: boolean
  idleMs?: number
  maxWaitMs?: number
  /** Opt-in success fast-path: matching newly captured output completes the call. */
  successPattern?: RegExp | null
  /** After a success match: keep the process alive (server semantics) unless explicitly false. */
  keepAlive?: boolean
  notify?: boolean
  env?: Record<string, string>
  spawnFn?: SpawnFn
  /** Cap on waiting for the final log flush after exit (default 500ms). */
  exitGraceMs?: number
  /** Opt-in: the job outlives this host process (recorded in the persistent registry). */
  survive?: boolean
  registry?: JobRegistry
  /** OS-level fence (Windows job object watcher); never applied to survive jobs. */
  fence?: JobFenceLike | null
  /** Structural child-of-pid lookup (survivor relocation, sync — registry scan). */
  relocate?: (pid: number) => number | null
  /** Async variant used for fence reinforcement (must not block the loop). */
  relocateAsync?: (pid: number) => Promise<number | null>
}

export type ForegroundResult =
  | { status: "exited"; exitCode: number | null; outputTail: string; spawnError?: string }
  | { status: "succeeded"; matched: string; outputTail: string; keptAlive: boolean }
  | { status: "still-running"; idleForMs: number; outputTail: string }

export type StartedJob = {
  job: Job
  /** Resolves on the first of: exit / success match / idle / max-wait. Never rejects. */
  settle: Promise<ForegroundResult>
}

// File-backed output source: tracks a byte position in the log file, reads
// the newly appended slice on every flush. Tolerates truncation by resetting
// to the current size (rotation never touches a RUNNING job's file; this is
// belt for manual interference).
//
// HARD BOUND on the per-flush allocation: a burst (huge build log, `cat` of
// a big file) must never translate into one giant buffer in the host — reads
// are chunked at TAIL_CHUNK_BYTES and the position advances per chunk, so
// memory stays flat no matter how fast the file grows.
const TAIL_CHUNK_BYTES = 4 * 1024 * 1024

export type FileTail = { flush(): void; stop(): void }

export function createFileTail(logPath: string, onText: (chunk: string) => void, pollMs = TAIL_POLL_MS): FileTail {
  let pos = existsSync(logPath) ? statSync(logPath).size : 0
  let stopped = false
  const flush = () => {
    if (stopped) return
    try {
      let size = existsSync(logPath) ? statSync(logPath).size : 0
      if (size < pos) pos = size // truncated externally — restart from the new end
      const fd = openSync(logPath, "r")
      try {
        const buf = Buffer.allocUnsafe(TAIL_CHUNK_BYTES)
        while (pos < size) {
          const want = Math.min(TAIL_CHUNK_BYTES, size - pos)
          let read = 0
          while (read < want) {
            const n = readSync(fd, buf, read, want - read, pos + read)
            if (n <= 0) break
            read += n
          }
          if (read <= 0) break
          pos += read
          onText(buf.toString("utf8", 0, read))
          size = existsSync(logPath) ? statSync(logPath).size : size // grew mid-flush: keep draining
          if (stopped) break
        }
      } finally {
        closeSync(fd)
      }
    } catch {
      // A vanished/read-locked file must never break capture.
    }
  }
  const timer = setInterval(flush, pollMs)
  timer.unref?.()
  return {
    flush,
    stop() {
      stopped = true
      clearInterval(timer)
    },
  }
}

// Live tails by job id (spawned and adopted alike) so pollJob can flush on
// demand. Cleaned up when a job goes terminal.
const liveTails = new Map<string, FileTail>()

export function flushJobOutput(job: Job): void {
  liveTails.get(job.id)?.flush()
}

export function startJob(manager: JobManager, opts: StartOptions): StartedJob {
  const idleMs = Math.max(0, opts.idleMs ?? DEFAULT_IDLE_MS)
  const maxWaitMs = Math.min(Math.max(0, opts.maxWaitMs ?? DEFAULT_MAX_WAIT_MS), HARD_MAX_WAIT_MS)
  mkdirSync(opts.logDir, { recursive: true })
  const id = newJobId()
  const logPath = join(opts.logDir, `${id}.log`)
  let child: ReturnType<SpawnFn>
  let settled = false
  let exiting = false
  let idleTimer: ReturnType<typeof setTimeout> | null = null
  const maxWaitTimer = setTimeout(() => {
    resolveStillRunning()
  }, maxWaitMs)
  maxWaitTimer.unref?.()

  let resolveSettle: (r: ForegroundResult) => void = () => {}
  const settle = new Promise<ForegroundResult>((res) => {
    resolveSettle = res
  })

  const armIdle = () => {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => resolveStillRunning(), idleMs)
    idleTimer.unref?.()
  }

  const stopTimers = () => {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = null
    clearTimeout(maxWaitTimer)
  }

  // Reinforcement hooks fire once, on the first captured output (the real
  // grandchild has started writing) — see the fence assignment block below.
  const firstOutputHooks: Array<() => void> = []

  function resolveStillRunning(): void {
    if (settled) return
    settled = true
    stopTimers()
    // The process keeps running under the job handle; capture continues.
    resolveSettle({ status: "still-running", idleForMs: Date.now() - job.lastOutputAt, outputTail: job.tail })
  }

  const job = manager.create({
    id,
    cmd: opts.cmd,
    worktree: opts.worktree,
    ownerSession: opts.ownerSession,
    logPath,
    notify: opts.notify ?? true,
    killTree: () => {
      killTree(child)
      if (opts.survive) opts.registry?.remove(id)
    },
    ...(opts.survive ? { survive: true } : {}),
  })

  // The write handle exists only to hand the child an inherited descriptor;
  // close ours right after spawn — the child keeps its own copy, and the
  // host holds no job pipes at all.
  let wfd: number | undefined
  try {
    wfd = openSync(logPath, "a")
    child = shellSpawn(opts.spawnFn ?? spawn, opts.cmd, {
      cwd: opts.cwd,
      env: { ...(opts.env ?? {}), [JOB_ENV_MARKER]: id },
      stdio: ["ignore", wfd, wfd] as unknown as ChildProcess["stdio"],
    })
  } catch (err) {
    if (wfd !== undefined) {
      try {
        closeSync(wfd)
      } catch {}
    }
    manager.markTerminal(job, "killed", null)
    maxWaitTimer && clearTimeout(maxWaitTimer)
    resolveSettle({ status: "exited", exitCode: null, outputTail: "", spawnError: String(err) })
    return { job, settle }
  }
  if (wfd !== undefined) {
    try {
      closeSync(wfd)
    } catch {}
  }
  manager.setPid(job, child.pid ?? 0)
  if (opts.survive) {
    opts.registry?.add({ id, pid: child.pid ?? 0, cmd: opts.cmd, logPath, startedAt: job.startedAt, ownerSession: opts.ownerSession, hostPid: process.pid })
  } else if (opts.fence) {
    // Fence layer 1: the shell wrapper itself. The REAL command usually
    // lives in a grandchild that is born before the fence watcher finishes
    // its Add-Type compile — too late for job-object inheritance — so layer
    // 2 reinforces once the grandchild exists, assigning it into the fence
    // AND re-targeting job.pid so every later kill addresses the real tree
    // even after the wrapper dies with the host (live finding: wrapper death
    // orphans an unfenced grandchild). Reinforce ASAP — the grandchild is
    // born within ~100ms of the wrapper while the CIM lookup takes ~0.5s,
    // so any realistically-timed signal arrives after the retarget — with
    // first output and a timer as backstops.
    opts.fence.assign(child.pid ?? 0)
    // Latch only on SUCCESS: an early probe that runs before the grandchild
    // exists must not burn the retries (live finding — the first attempt
    // raced the grandchild's birth and the retarget never happened).
    let reinforced = false
    const reinforce = () => {
      if (reinforced) return
      void (async () => {
        const kid = (await opts.relocateAsync?.(child.pid ?? 0)) ?? opts.relocate?.(child.pid ?? 0) ?? null
        if (kid !== null && kid > 0) {
          reinforced = true
          opts.fence?.assign(kid)
          manager.setPid(job, kid)
        }
      })()
    }
    // Try at a few points: the grandchild is born within ~100ms of the
    // wrapper while the lookup takes ~0.5s, so any realistically-timed
    // signal arrives after the retarget; first output and a timer backstop.
    for (const delay of [50, 400, 1_500]) {
      const t = setTimeout(reinforce, delay)
      t.unref?.()
    }
    firstOutputHooks.push(reinforce)
  }

  const onChunk = (text: string) => {
    if (firstOutputHooks.length > 0) {
      for (const hook of firstOutputHooks.splice(0)) hook()
    }
    manager.appendOutput(job, text)
    if (opts.successPattern && !settled && job.succeededAt === null) {
      const m = opts.successPattern.exec(text) ?? opts.successPattern.exec(job.tail)
      if (m) {
        settled = true
        stopTimers()
        job.succeededAt = Date.now()
        const keptAlive = opts.keepAlive !== false
        if (!keptAlive) {
          killTree(child)
          if (opts.survive) opts.registry?.remove(id)
          manager.markTerminal(job, "succeeded", null)
        }
        resolveSettle({ status: "succeeded", matched: m[0], outputTail: job.tail, keptAlive })
      }
    }
  }

  const tail = createFileTail(logPath, onChunk)
  liveTails.set(id, tail)

  // THE completion binding: `exit`, not `close` — there are no pipes at all
  // now, so a detached grandchild cannot delay anything (#47350 shape); the
  // short grace (capped) just lets a final write to the inherited log fd land
  // before the job is declared terminal.
  child.on("exit", (code) => {
    if (exiting) return
    exiting = true
    stopTimers()
    let finished = false
    const finish = () => {
      if (finished) return
      finished = true
      tail.flush()
      tail.stop()
      liveTails.delete(id)
      manager.markTerminal(job, "exited", code)
      if (opts.survive) opts.registry?.remove(id)
      rotateLogs(opts.logDir)
      if (!settled) {
        settled = true
        resolveSettle({ status: "exited", exitCode: code, outputTail: job.tail })
      }
    }
    const graceTimer = setTimeout(finish, opts.exitGraceMs ?? 500)
    graceTimer.unref?.()
  })
  child.on("error", (err) => {
    tail.stop()
    liveTails.delete(id)
    if (opts.survive) opts.registry?.remove(id)
    if (!settled) {
      settled = true
      stopTimers()
      manager.markTerminal(job, "killed", null)
      resolveSettle({ status: "exited", exitCode: null, outputTail: job.tail, spawnError: err.message })
    }
  })

  if (opts.runInBackground) {
    // Immediate handle return; the settle promise resolves unnoticed when
    // the process eventually ends (markTerminal + wake queueing still run).
    stopTimers()
  } else {
    armIdle()
  }
  return { job, settle }
}

// Bounded poll: waits up to `waitMs` (clamped) for NEW output or a terminal
// state, then drains via the manager exactly once. Flushing the file tail
// here keeps poll latency at caller pace, not the poller cadence.
export async function pollJob(
  manager: JobManager,
  jobId: string,
  waitMs = 0,
): Promise<ReturnType<JobManager["poll"]> | undefined> {
  const job = manager.get(jobId)
  if (!job) return undefined
  const deadline = Date.now() + Math.min(Math.max(0, waitMs), POLL_WAIT_MAX_MS)
  // Peek without consuming the cursor.
  while (job.outLen === job.pollCursor && job.state === "running" && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25))
    flushJobOutput(job)
  }
  flushJobOutput(job)
  return manager.poll(job)
}

// Adopt a survivor recorded by a PREVIOUS host process (design D4): rebuild
// the job table entry from the registry (pid-addressed kill, same log file,
// liveness polling instead of a child handle). List output marks it as a
// previous-run job via `previousRun`.
export function adoptSurvivor(
  manager: JobManager,
  entry: SurvivorEntry,
  opts: { registry: JobRegistry; logDir: string; relocate?: (pid: number) => number | null },
): Job {
  const kill = () => {
    // The recorded pid is the shell wrapper; when the spawning host died the
    // wrapper usually died with it while the job lives on (and the registry
    // scan may even have captured a pre-death pid). Re-target to the deepest
    // LIVE generation before issuing the tree kill — a taskkill aimed at a
    // dead wrapper misses the real process entirely (live finding).
    let pid = entry.pid
    for (let hop = 0; hop < 3 && !pidAlive(pid); hop++) {
      const kid = opts.relocate?.(pid) ?? null
      if (kid === null || kid <= 0) break
      pid = kid
    }
    killTree({ pid, kill: (sig) => process.kill(pid, sig as NodeJS.Signals) })
    opts.registry.remove(entry.id)
  }
  const job = manager.create({
    id: entry.id,
    cmd: entry.cmd,
    worktree: opts.logDir,
    ownerSession: entry.ownerSession,
    logPath: entry.logPath,
    notify: false,
    killTree: kill,
    survive: true,
    previousRun: true,
  })
  manager.setPid(job, entry.pid)
  const tail = createFileTail(entry.logPath, (t) => manager.appendOutput(job, t))
  liveTails.set(job.id, tail)
  const watcher = setInterval(() => {
    if (!pidAlive(entry.pid)) {
      clearInterval(watcher)
      tail.flush()
      tail.stop()
      liveTails.delete(job.id)
      opts.registry.remove(entry.id)
      manager.markTerminal(job, "exited", null)
      rotateLogs(opts.logDir)
    }
  }, ADOPT_LIVENESS_MS)
  watcher.unref?.()
  return job
}

// Line-based paging over the on-disk log: `offset` = first line index,
// omitted = tail window of `limit` lines (default 200). Files larger than
// LOG_READ_MAX_BYTES are windowed to their tail (the result says so) —
// reading a multi-GB log into the host would be its own incident.
const LOG_READ_MAX_BYTES = 8 * 1024 * 1024

export function readJobLog(
  logPath: string,
  opts: { offset?: number; limit?: number } = {},
): { lines: string[]; total: number; offset: number; windowed?: boolean } {
  const limit = Math.max(1, opts.limit ?? 200)
  let raw = ""
  let windowed = false
  try {
    if (existsSync(logPath)) {
      const size = statSync(logPath).size
      if (size > LOG_READ_MAX_BYTES) {
        const fd = openSync(logPath, "r")
        try {
          const buf = Buffer.allocUnsafe(LOG_READ_MAX_BYTES)
          let read = 0
          while (read < LOG_READ_MAX_BYTES) {
            const n = readSync(fd, buf, read, LOG_READ_MAX_BYTES - read, size - LOG_READ_MAX_BYTES + read)
            if (n <= 0) break
            read += n
          }
          const text = buf.toString("utf8", 0, read)
          raw = text.slice(text.indexOf("\n") + 1) // drop the partial first line
          windowed = true
        } finally {
          closeSync(fd)
        }
      } else {
        raw = readFileSync(logPath, "utf8")
      }
    }
  } catch {
    raw = ""
  }
  const lines = raw.length === 0 ? [] : raw.split(/\r?\n/)
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop()
  const total = lines.length
  const offset = opts.offset !== undefined ? Math.max(0, Math.min(opts.offset, total)) : Math.max(0, total - limit)
  return { lines: lines.slice(offset, offset + limit), total, offset, ...(windowed ? { windowed: true } : {}) }
}

// Keep at most `keep` job logs; oldest-modified files go first. Disk logs
// outlive registry eviction (bounded here instead).
export function rotateLogs(logDir: string, keep = DEFAULT_LOG_KEEP): void {
  let entries: Array<{ name: string; mtime: number }> = []
  try {
    entries = readdirSync(logDir)
      .filter((f) => f.endsWith(".log"))
      .map((name) => {
        try {
          return { name, mtime: statSync(join(logDir, name)).mtimeMs }
        } catch {
          return { name, mtime: 0 }
        }
      })
  } catch {
    return
  }
  const excess = entries.length - keep
  if (excess <= 0) return
  entries.sort((a, b) => a.mtime - b.mtime)
  for (const e of entries.slice(0, excess)) {
    try {
      unlinkSync(join(logDir, e.name))
    } catch {
      // Already gone — fine.
    }
  }
}
