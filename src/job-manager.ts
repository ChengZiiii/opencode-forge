// Job registry and lifecycle policy for the forge job supervisor.
//
// Pure logic, no @opencode-ai imports and no child_process usage: the job's
// killTree callback is injected by the runner, the clock and the ledger sink
// are injectable so tests drive everything determinately. The runner owns
// processes and output capture; this module owns policy — ownership,
// eviction caps, the completion-wake queue, and the diagnostics ledger.

export type JobState = "running" | "exited" | "killed" | "succeeded"

export type LedgerKind = "orphan-job" | "unread-completion" | "wake-timeout" | "evicted"

export type LedgerEntry = {
  at: string
  kind: LedgerKind
  jobId: string
  session: string
  detail: string
}

export type Job = {
  id: string
  cmd: string
  worktree: string
  ownerSession: string
  /** "session" jobs die with their owner; handoff promotes to "global". */
  scope: "session" | "global"
  state: JobState
  exitCode: number | null
  startedAt: number
  endedAt: number | null
  /** Milliseconds-precision wall clock of the last output chunk (monotonic enough for idle math). */
  lastOutputAt: number
  logPath: string
  /** Bounded in-memory output ring (tail window). */
  tail: string
  /** Total output length ever captured (monotonic poll cursor base). */
  outLen: number
  /** Chars of outLen already returned by the last poll. */
  pollCursor: number
  /** Set when the job produced output after going terminal (poll/log read the completion). */
  readAfterEnd: boolean
  /** Set when success_pattern matched; the process may still be running (keep-alive server). */
  succeededAt: number | null
  notify: boolean
  wakeState: "none" | "queued" | "delivered" | "abandoned"
  wakeQueuedAt: number | null
  killTree: () => void
  /** Spawned pid (0/undefined when unknown). Adopted registry survivors are addressed by pid. */
  pid?: number
  /** Opt-in: this job outlives the host process (persistent registry entry, no fence, never exit-killed). */
  survive?: boolean
  /** Adopted from a previous host run (registry scan). */
  previousRun?: boolean
}

export type JobManagerOptions = {
  /** Finished jobs retained in the registry before oldest-first eviction (default 50). */
  maxFinishedJobs?: number
  /** Per-job in-memory tail cap in chars (default 8192). */
  maxTailChars?: number
  /** Total in-memory output budget across the registry in chars (default 524288). */
  maxRegistryChars?: number
  /** Wake delivery window in ms before the completion is ledgered instead (default 600000). */
  wakeWindowMs?: number
  /** Diagnostics ledger bound in entries (default 200). */
  maxLedgerEntries?: number
  now?: () => number
  sink?: (entry: LedgerEntry) => void
}

export const DEFAULT_MAX_FINISHED_JOBS = 50
export const DEFAULT_MAX_TAIL_CHARS = 8192
export const DEFAULT_MAX_REGISTRY_CHARS = 524288
export const DEFAULT_WAKE_WINDOW_MS = 600000
export const DEFAULT_MAX_LEDGER_ENTRIES = 200

export type JobManager = ReturnType<typeof createJobManager>

function iso(now: () => number): string {
  return new Date(now()).toISOString()
}

export function createJobManager(opts: JobManagerOptions = {}) {
  const now = opts.now ?? Date.now
  const maxFinishedJobs = opts.maxFinishedJobs ?? DEFAULT_MAX_FINISHED_JOBS
  const maxTailChars = opts.maxTailChars ?? DEFAULT_MAX_TAIL_CHARS
  const maxRegistryChars = opts.maxRegistryChars ?? DEFAULT_MAX_REGISTRY_CHARS
  const wakeWindowMs = opts.wakeWindowMs ?? DEFAULT_WAKE_WINDOW_MS
  const maxLedgerEntries = opts.maxLedgerEntries ?? DEFAULT_MAX_LEDGER_ENTRIES

  const jobs = new Map<string, Job>()
  const ledger: LedgerEntry[] = []

  function emit(kind: LedgerKind, job: Job, detail: string): void {
    const entry: LedgerEntry = { at: iso(now), kind, jobId: job.id, session: job.ownerSession, detail }
    ledger.push(entry)
    if (ledger.length > maxLedgerEntries) ledger.splice(0, ledger.length - maxLedgerEntries)
    try {
      opts.sink?.(entry)
    } catch {
      // A broken sink must never take the supervisor down.
    }
  }

  function totalRegistryChars(): number {
    let n = 0
    for (const j of jobs.values()) n += j.tail.length
    return n
  }

  function isTerminal(job: Job): boolean {
    return job.state !== "running"
  }

  // Evict oldest finished jobs until the count and memory caps hold. Disk
  // logs are NOT deleted here — the runner owns file rotation.
  function enforceCaps(): void {
    const finished = [...jobs.values()].filter(isTerminal).sort((a, b) => (a.endedAt ?? a.startedAt) - (b.endedAt ?? b.startedAt))
    let over = jobs.size - (maxFinishedJobs + countRunning())
    let chars = totalRegistryChars()
    for (const j of finished) {
      if (over <= 0 && chars <= maxRegistryChars) break
      emit("evicted", j, `evicted from registry (state ${j.state})`)
      jobs.delete(j.id)
      over--
      chars -= j.tail.length
    }
  }

  function countRunning(): number {
    let n = 0
    for (const j of jobs.values()) if (!isTerminal(j)) n++
    return n
  }

  function create(input: {
    id: string
    cmd: string
    worktree: string
    ownerSession: string
    logPath: string
    notify: boolean
    killTree: () => void
    pid?: number
    survive?: boolean
    previousRun?: boolean
  }): Job {
    const t = now()
    const job: Job = {
      ...input,
      scope: "session",
      state: "running",
      exitCode: null,
      startedAt: t,
      endedAt: null,
      lastOutputAt: t,
      tail: "",
      outLen: 0,
      pollCursor: 0,
      readAfterEnd: false,
      succeededAt: null,
      wakeState: "none",
      wakeQueuedAt: null,
    }
    jobs.set(job.id, job)
    enforceCaps()
    return job
  }

  // The runner learns the pid only after spawn returns; adopted jobs get it
  // from the registry entry.
  function setPid(job: Job, pid: number): void {
    job.pid = pid
  }

  function get(id: string): Job | undefined {
    return jobs.get(id)
  }

  function list(): Job[] {
    return [...jobs.values()].sort((a, b) => b.startedAt - a.startedAt)
  }

  // Ring-append captured output: the tail window slides, the monotonic
  // outLen counter grows without bound so polls never miss.
  function appendOutput(job: Job, chunk: string): void {
    if (!chunk) return
    job.outLen += chunk.length
    job.lastOutputAt = now()
    const next = job.tail + chunk
    job.tail = next.length > maxTailChars ? next.slice(next.length - maxTailChars) : next
  }

  // First terminal transition wins (exit vs kill vs success race); a queued
  // wake is enqueued exactly once for notifying jobs.
  function markTerminal(job: Job, state: Exclude<JobState, "running">, exitCode: number | null): void {
    if (isTerminal(job)) return
    job.state = state
    job.exitCode = exitCode
    job.endedAt = now()
    if (job.notify && job.wakeState === "none") {
      job.wakeState = "queued"
      job.wakeQueuedAt = now()
    }
    enforceCaps()
  }

  function kill(job: Job): void {
    if (isTerminal(job)) return
    try {
      job.killTree()
    } catch {
      // killTree degrades internally; a throw here still means "kill issued".
    }
    markTerminal(job, "killed", null)
  }

  // Poll result: output produced since the caller's previous poll plus the
  // live exit status. Reading a terminal job marks its completion as read.
  function poll(job: Job): { state: JobState; exitCode: number | null; newOutput: string; cursor: number; succeeded: boolean; logPath: string } {
    if (isTerminal(job)) job.readAfterEnd = true
    const cursor = job.outLen
    const start = job.pollCursor
    const newOutput = sliceFromCursor(job, start)
    job.pollCursor = cursor
    return {
      state: job.state,
      exitCode: job.exitCode,
      newOutput,
      cursor,
      succeeded: job.succeededAt !== null,
      logPath: job.logPath,
    }
  }

  // The pollCursor counts against outLen while the tail is a capped window:
  // map the absolute cursor into the available window.
  function sliceFromCursor(job: Job, cursor: number): string {
    const startOffset = Math.max(0, cursor - (job.outLen - job.tail.length))
    return job.tail.slice(startOffset)
  }

  function clear(id: string): boolean {
    const job = jobs.get(id)
    if (!job || !isTerminal(job)) return false
    jobs.delete(id)
    return true
  }

  // Handoff promotes the job to plugin-global scope (survives the owner
  // session's end) and optionally rebinds ownership — the completion wake
  // then targets the rebound session (root ancestor, resolved by the wiring).
  function handoff(id: string, toSession?: string): Job | undefined {
    const job = jobs.get(id)
    if (!job) return undefined
    job.scope = "global"
    if (toSession) job.ownerSession = toSession
    return job
  }

  // Owner session ended: live session-scoped jobs are terminated (orphans
  // ledgered), unread terminal completions are ledgered, everything the
  // session owned leaves the registry. Surviving jobs opted out of death
  // entirely — they stay running and in the table.
  function onSessionEnd(sessionID: string): void {
    for (const job of [...jobs.values()]) {
      if (job.ownerSession !== sessionID) continue
      if (job.survive) continue
      if (!isTerminal(job)) {
        if (job.scope === "global") continue
        kill(job)
        emit("orphan-job", job, `owner session ended; tree killed (was: ${job.cmd.slice(0, 120)})`)
      } else if (!job.readAfterEnd) {
        emit("unread-completion", job, `owner session ended before the completion was read (state ${job.state}, exit ${job.exitCode})`)
      }
      jobs.delete(job.id)
    }
  }

  function disposeAll(): void {
    for (const job of [...jobs.values()]) {
      if (job.survive) continue
      if (!isTerminal(job)) {
        kill(job)
        emit("orphan-job", job, "plugin dispose; tree killed")
      }
      jobs.delete(job.id)
    }
  }

  // Wakes for a session that just went idle: delivered jobs flip state
  // exactly once; stale entries are abandoned to the ledger instead of
  // queueing forever.
  function deliverWakesFor(sessionID: string): Job[] {
    abandonStaleWakes()
    const ready: Job[] = []
    for (const job of jobs.values()) {
      if (job.wakeState === "queued" && job.ownerSession === sessionID) {
        job.wakeState = "delivered"
        ready.push(job)
      }
    }
    return ready
  }

  function abandonStaleWakes(): void {
    const t = now()
    for (const job of jobs.values()) {
      if (job.wakeState === "queued" && job.wakeQueuedAt !== null && t - job.wakeQueuedAt > wakeWindowMs) {
        job.wakeState = "abandoned"
        emit("wake-timeout", job, `session stayed busy past the ${wakeWindowMs}ms delivery window (state ${job.state}, exit ${job.exitCode})`)
      }
    }
  }

  function ledgerEntries(): LedgerEntry[] {
    return [...ledger]
  }

  return {
    create,
    setPid,
    get,
    list,
    appendOutput,
    markTerminal,
    kill,
    poll,
    clear,
    handoff,
    onSessionEnd,
    disposeAll,
    deliverWakesFor,
    abandonStaleWakes,
    ledgerEntries,
    size: () => jobs.size,
  }
}

export function newJobId(now: () => number = Date.now): string {
  const d = new Date(now())
  const p = (n: number, w = 2) => String(n).padStart(w, "0")
  const rand = Math.random().toString(36).slice(2, 8)
  return `j-${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}-${rand}`
}
