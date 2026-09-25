import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

// ---------------------------------------------------------------------------
// hang-watchdog: timing table + graded intervention engine (pure logic).
// No @opencode-ai imports; clock, ledger sink, locator and killer are all
// injectable so tests drive it with fakes (same layering as job-manager).
// ---------------------------------------------------------------------------

export const WATCHDOG_ENV_MARK = "FORGE_WATCHDOG_MARK"

export type WatchdogMode = "off" | "dry-run" | "kill"

export type WatchdogEventType = "warn" | "kill" | "dry-run-candidate" | "unresolved" | "config-fallback"

export type LocatedProc = { pid: number; cmd: string; createdMs?: number }

export type LedgerEntry = {
  ts: string
  event: WatchdogEventType
  callID: string
  sessionID?: string
  tool?: string
  t0: number
  elapsedMs?: number
  mode: WatchdogMode
  pids?: LocatedProc[]
  /** Everything locate returned (pre-kill), for post-mortem diagnosis. */
  candidates?: LocatedProc[]
  reason?: string
}

export type TimingRecord = {
  callID: string
  sessionID?: string
  tool: string
  t0: number
  /** The shell.env hook fired for this callID — the marker actually rode along. */
  markerSeen: boolean
  warned: boolean
  acted: boolean
  /** Distinguishing token of the call's own command (Windows inference aid). */
  cmdNeedle?: string
  killedAt?: number
  /** 1 = subtree/needle kill done; 2 = workspace-scope wave done. */
  wave: 0 | 1 | 2
  unresolvedReported?: boolean
}

export type WatchdogOptions = {
  mode?: WatchdogMode
  stallMs?: number
  /** Scanner cadence (default 30s). */
  intervalMs?: number
  /** Post-kill window before an unresolved report (default 60s). */
  observeMs?: number
  /** Clamp floor for stallMs — protects against a zero misconfig (default 60s). */
  minStallMs?: number
  now?: () => number
  /** Ledger append; defaults to a no-op so the engine stays pure. */
  sink?: (entry: LedgerEntry) => void
  locate?: (callID: string, t0: number, cmdNeedle?: string, phase2?: boolean) => Promise<LocatedProc[]>
  killTree?: (pid: number) => void
  /** Liveness probe used to skip already-dead wave-2 candidates. */
  isAlive?: (pid: number) => boolean
  setIntervalFn?: typeof setInterval
  clearIntervalFn?: typeof clearInterval
}

const DEFAULT_STALL_MS = 600_000
const MIN_STALL_MS = 60_000
const DEFAULT_INTERVAL_MS = 30_000
const DEFAULT_OBSERVE_MS = 60_000
const WARN_RATIO = 0.8

export function clampStallMs(raw: unknown, min = MIN_STALL_MS): number {
  const n = typeof raw === "number" && Number.isFinite(raw) ? raw : DEFAULT_STALL_MS
  return Math.max(min, Math.floor(n))
}

export function parseMode(raw: unknown): WatchdogMode {
  return raw === "off" || raw === "dry-run" || raw === "kill" ? raw : "kill"
}

export type Watchdog = {
  readonly mode: WatchdogMode
  readonly stallMs: number
  track: (callID: string, sessionID: string | undefined, tool: string, t0?: number, cmdNeedle?: string) => void
  /** The shell.env hook fired for this callID — the marker rode along. */
  markSeen: (callID: string) => void
  untrack: (callID: string) => void
  has: (callID: string) => boolean
  size: () => number
  /** One scanner pass; also what the interval calls. */
  scan: () => Promise<void>
  setMode: (mode: WatchdogMode) => void
  dispose: () => void
}

export function createWatchdog(opts: WatchdogOptions = {}): Watchdog {
  const mode = parseMode(opts.mode)
  const stallMs = clampStallMs(opts.stallMs, opts.minStallMs ?? MIN_STALL_MS)
  const intervalMs = Math.max(1, opts.intervalMs ?? DEFAULT_INTERVAL_MS)
  const observeMs = opts.observeMs ?? DEFAULT_OBSERVE_MS
  const now = opts.now ?? Date.now
  const sink = opts.sink ?? (() => {})
  const locate = opts.locate ?? (async () => [])
  const killTree = opts.killTree ?? (() => {})
  const isAlive = opts.isAlive ?? ((pid: number) => { try { process.kill(pid, 0); return true } catch { return false } })
  const setIntervalFn = opts.setIntervalFn ?? setInterval
  const clearIntervalFn = opts.clearIntervalFn ?? clearInterval

  let currentMode: WatchdogMode = mode
  const table = new Map<string, TimingRecord>()
  // shell.env may fire before tool.execute.before; remember seen callIDs
  // independently of the table so the ordering can't fake a missing marker.
  const markerSeenIDs = new Set<string>()
  let timer: ReturnType<typeof setIntervalFn> | null = null

  const write = (event: WatchdogEventType, rec: TimingRecord, extra: Partial<LedgerEntry> = {}) => {
    sink({
      ts: new Date(now()).toISOString(),
      event,
      callID: rec.callID,
      ...(rec.sessionID !== undefined ? { sessionID: rec.sessionID } : {}),
      tool: rec.tool,
      t0: rec.t0,
      elapsedMs: now() - rec.t0,
      mode: currentMode,
      ...extra,
    })
  }

  const ensureTimer = () => {
    if (currentMode === "off" || timer) return
    // Low-frequency single scanner over the whole table (D2), never per call.
    timer = setIntervalFn(() => {
      void scan()
    }, intervalMs)
    ;(timer as unknown as { unref?: () => void }).unref?.()
  }

  const maybeStopTimer = () => {
    if (timer && table.size === 0) {
      clearIntervalFn(timer)
      timer = null
    }
  }

  const act = async (rec: TimingRecord): Promise<void> => {
    rec.acted = true
    try {
      // Degradation probe (4.1): the shell.env hook never fired for this
      // call — the marker did NOT ride along, so killing by inference alone
      // is unsafe. Degrade this act to dry-run and say so in the ledger.
    if (!rec.markerSeen) {
      const pids = await locate(rec.callID, rec.t0, rec.cmdNeedle)
      write("dry-run-candidate", rec, {
        pids,
        reason: "marker-missing (shell.env hook did not fire) — degraded to dry-run",
      })
      return
    }
    const pidsA = await locate(rec.callID, rec.t0, rec.cmdNeedle, false)
    // The #47350 shape: by act time the call's own bash/launcher chain has
    // EXITED — the only thing keeping the pipes open is a detached helper
    // that neither the subtree nor the needle can see. When phase A comes
    // back empty and we know the command, fall straight through to the
    // workspace-scope phase (the same list the post-kill wave would use).
    let pids = pidsA
    if (pidsA.length === 0 && rec.cmdNeedle !== undefined) {
      const pidsB = await locate(rec.callID, rec.t0, rec.cmdNeedle, true)
      if (pidsB.length > 0) {
        pids = pidsB
        rec.wave = 2
      }
    }
    if (pids.length === 0) {
      // Nothing to kill anywhere (e.g. a dropped provider stream) — honest
      // report only.
      write("unresolved", rec, { reason: "no matching process found" })
      return
    }
    if (currentMode === "dry-run") {
      write("dry-run-candidate", rec, { pids, candidates: pidsA })
      return
    }
    const killed: LocatedProc[] = []
    for (const p of pids) {
      try {
        killTree(p.pid)
        killed.push(p)
      } catch {
        // A pid that vanished between locate and kill is not a failure.
      }
    }
    rec.killedAt = now()
    if (rec.wave === 0) rec.wave = 1
    write("kill", rec, {
      pids: killed,
      candidates: pids,
      reason: pids === pidsA ? "wave 1 — host subtree / command match" : "workspace scope (call's own chain already exited)",
    })
    } catch (err) {
      // Locate itself exploded (WMI hiccup, /proc gone): never let the
      // scanner die on one call — record and move on.
      write("unresolved", rec, { reason: `intervention failed: ${String(err)}` })
    }
  }

  const scan = async (): Promise<void> => {
    if (currentMode === "off") return
    const nowMs = now()
    for (const rec of table.values()) {
      const elapsed = nowMs - rec.t0
      // Post-kill observation. Wave 1 killed the matched set but the call
      // still hasn't returned — on Windows the stdio pipe holders can be
      // detached grandchildren the subtree/needle match cannot see (their
      // parent died; their command is not the stalled command). Before
      // declaring unresolved, one workspace-scope wave: processes created
      // during this call whose command lives in the stalled command's own
      // directory. Blast radius still triple-guarded (time window + the
      // directory + only after a provably insufficient wave 1), and dry-run
      // audits the exact list.
      if (rec.acted && rec.killedAt !== undefined && !rec.unresolvedReported) {
        if (nowMs - rec.killedAt >= observeMs) {
          if (currentMode === "kill" && rec.wave === 1 && rec.cmdNeedle !== undefined) {
            const wave2 = await locate(rec.callID, rec.t0, rec.cmdNeedle, true)
            const stillAlive = wave2.filter((p) => isAlive(p.pid))
            if (stillAlive.length > 0) {
              const killed2: LocatedProc[] = []
              for (const p of stillAlive) {
                try {
                  killTree(p.pid)
                  killed2.push(p)
                } catch {
                  // Vanished between locate and kill.
                }
              }
              rec.killedAt = now()
              rec.wave = 2
              write("kill", rec, { pids: killed2, reason: "wave 2 — workspace scope (wave 1 did not unblock the call)" })
              return
            }
          }
          rec.unresolvedReported = true
          write("unresolved", rec, { reason: "no tool.execute.after within the observation window after kill" })
        }
        continue
      }
      if (rec.acted) continue
      if (elapsed >= stallMs) {
        await act(rec)
        continue
      }
      if (elapsed >= WARN_RATIO * stallMs && !rec.warned) {
        rec.warned = true
        write("warn", rec)
      }
    }
    maybeStopTimer()
  }

  return {
    get mode() {
      return currentMode
    },
    get stallMs() {
      return stallMs
    },
    track(callID, sessionID, tool, t0 = now(), cmdNeedle) {
      if (currentMode === "off") return
      table.set(callID, {
        callID,
        sessionID,
        tool,
        t0,
        markerSeen: markerSeenIDs.has(callID),
        warned: false,
        acted: false,
        wave: 0,
        ...(cmdNeedle !== undefined && cmdNeedle.length > 0 ? { cmdNeedle } : {}),
      })
      ensureTimer()
    },
    markSeen(callID) {
      markerSeenIDs.add(callID)
      const rec = table.get(callID)
      if (rec) rec.markerSeen = true
    },
    untrack(callID) {
      table.delete(callID)
      maybeStopTimer()
    },
    has: (callID) => table.has(callID),
    size: () => table.size,
    scan,
    setMode(next: WatchdogMode) {
      currentMode = next
      if (next === "off") {
        if (timer) {
          clearIntervalFn(timer)
          timer = null
        }
        table.clear()
      } else {
        ensureTimer()
      }
    },
    dispose() {
      if (timer) {
        clearIntervalFn(timer)
        timer = null
      }
      table.clear()
    },
  }
}

// ---------------------------------------------------------------------------
// Bounded JSONL ledger: append-only, trims the oldest entries past the cap by
// rewriting the file (same durability posture as the jobs ledger).
// ---------------------------------------------------------------------------

export function watchdogLogDir(base?: string): string {
  const tmp = base ?? (process.env.TMPDIR ?? process.env.TEMP ?? process.env.TMP ?? "/tmp")
  return `${tmp.replace(/[\\/]+$/, "")}/opencode-forge/watchdog`
}

export type FileLedger = {
  append: (entry: LedgerEntry) => void
  entries: () => LedgerEntry[]
  path: string
}

export function createFileLedger(logPath: string, maxEntries = 200, maxBytes = 1_000_000): FileLedger {
  const append = (entry: LedgerEntry): void => {
    try {
      mkdirSync(dirname(logPath), { recursive: true })
      let lines: string[] = []
      try {
        lines = readFileSync(logPath, "utf8").split("\n").filter((l) => l.trim().length > 0)
      } catch {
        // First write.
      }
      if (lines.length >= maxEntries) lines = lines.slice(lines.length - maxEntries + 1)
      lines.push(JSON.stringify(entry))
      let text = lines.join("\n") + "\n"
      if (text.length > maxBytes) {
        // Keep the newest half of the budget — reset style, bounded.
        const keep = Math.max(1, Math.floor(maxEntries / 2))
        text = lines.slice(-keep).join("\n") + "\n"
      }
      writeFileSync(logPath, text, "utf8")
    } catch {
      // A read-only or full disk must never break intervention.
    }
  }
  const entries = (): LedgerEntry[] => {
    try {
      return readFileSync(logPath, "utf8")
        .split("\n")
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l) as LedgerEntry)
    } catch {
      return []
    }
  }
  return { append, entries, path: logPath }
}
