// Process side of the forge job supervisor: spawns shell commands, races the
// four completion conditions, and keeps capturing output after an early
// return. Completion binds to the child's EXIT event, never to stdio stream
// EOF — a detached grandchild holding the inherited pipes cannot suspend the
// calling agent (the #47350 class of hangs is structurally impossible here).
//
// Output capture is deliberately NOT joined into completion: after an
// idle/max-wait early return (or a kept-alive success) the capture continues
// in the background, feeding the job's tail ring and log file until the
// process actually exits.

import { spawn } from "node:child_process"
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { killTree, shellSpawn, type SpawnFn } from "./proc.ts"
import { newJobId, type Job, type JobManager } from "./job-manager.ts"

export const DEFAULT_IDLE_MS = 60_000
export const DEFAULT_MAX_WAIT_MS = 120_000
export const HARD_MAX_WAIT_MS = 600_000
export const POLL_WAIT_MAX_MS = 30_000
export const DEFAULT_LOG_KEEP = 50
export const JOB_ENV_MARKER = "FORGE_JOB_ID"

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
  /** Cap on waiting for the final pipe flush after exit (default 500ms). */
  exitGraceMs?: number
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
    killTree: () => killTree(child),
  })

  try {
    child = shellSpawn(opts.spawnFn ?? spawn, opts.cmd, {
      cwd: opts.cwd,
      env: { ...(opts.env ?? {}), [JOB_ENV_MARKER]: id },
    })
  } catch (err) {
    manager.markTerminal(job, "killed", null)
    maxWaitTimer && clearTimeout(maxWaitTimer)
    resolveSettle({ status: "exited", exitCode: null, outputTail: "", spawnError: String(err) })
    return { job, settle }
  }

  const onChunk = (d: Buffer | string) => {
    const text = String(d)
    manager.appendOutput(job, text)
    try {
      appendFileSync(logPath, text)
    } catch {
      // A read-only or full disk must never break capture.
    }
    if (opts.successPattern && !settled && job.succeededAt === null) {
      const m = opts.successPattern.exec(text) ?? opts.successPattern.exec(job.tail)
      if (m) {
        settled = true
        stopTimers()
        job.succeededAt = Date.now()
        const keptAlive = opts.keepAlive !== false
        if (!keptAlive) {
          killTree(child)
          manager.markTerminal(job, "succeeded", null)
        }
        resolveSettle({ status: "succeeded", matched: m[0], outputTail: job.tail, keptAlive })
      }
    }
  }
  child.stdout?.on("data", onChunk)
  child.stderr?.on("data", onChunk)

  // THE completion binding: `exit`, not `close` — a detached grandchild can
  // hold the pipe write ends open forever (#47350 shape) and `close` would
  // wait on it. A short grace (capped, stream-close if it happens) lets the
  // final pipe flush land in the tail; then the job is terminal regardless
  // of whether the streams ever close.
  child.on("exit", (code) => {
    if (exiting) return
    exiting = true
    stopTimers()
    let finished = false
    const finish = () => {
      if (finished) return
      finished = true
      manager.markTerminal(job, "exited", code)
      rotateLogs(opts.logDir)
      if (!settled) {
        settled = true
        resolveSettle({ status: "exited", exitCode: code, outputTail: job.tail })
      }
    }
    const graceTimer = setTimeout(finish, opts.exitGraceMs ?? 500)
    graceTimer.unref?.()
    const streams: Array<Pick<NodeJS.ReadableStream, "once">> = []
    if (child.stdout) streams.push(child.stdout)
    if (child.stderr) streams.push(child.stderr)
    let left = streams.length
    if (left === 0) finish()
    else for (const s of streams) s.once("close", () => { if (--left === 0) finish() })
  })
  child.on("error", (err) => {
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
// state, then drains via the manager exactly once.
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
  }
  return manager.poll(job)
}

// Line-based paging over the on-disk log: `offset` = first line index,
// omitted = tail window of `limit` lines (default 200).
export function readJobLog(
  logPath: string,
  opts: { offset?: number; limit?: number } = {},
): { lines: string[]; total: number; offset: number } {
  const limit = Math.max(1, opts.limit ?? 200)
  let raw = ""
  try {
    raw = existsSync(logPath) ? readFileSync(logPath, "utf8") : ""
  } catch {
    raw = ""
  }
  const lines = raw.length === 0 ? [] : raw.split(/\r?\n/)
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop()
  const total = lines.length
  const offset = opts.offset !== undefined ? Math.max(0, Math.min(opts.offset, total)) : Math.max(0, total - limit)
  return { lines: lines.slice(offset, offset + limit), total, offset }
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
