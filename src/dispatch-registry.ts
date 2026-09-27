// Background dispatch registry — a PURE state machine (design D10, task 3.1).
// No I/O and no timers: the engine drives the transitions, the wake engine
// consumes terminals exactly once. States:
//   queued → running → completed | timeout | killed | error
// (queued → terminal is legal: a submit-time failure can race the first poll.)
// `delivered` is the exactly-once wake guarantee: takeUndelivered() atomically
// hands out every terminal that has not been delivered to a parent brief yet.

export type DispatchState = "queued" | "running" | "completed" | "timeout" | "killed" | "error"

export type RegistryEntry = {
  dispatchId: string
  sessionID: string
  identity: string
  depth: string | null
  tier: string
  parentSessionID: string
  background: true
  queuedAt: string
  state: DispatchState
  delivered: boolean
  result?: Record<string, unknown>
  lateCompletion?: Record<string, unknown>
}

const TERMINAL_CAP = 50

export function createDispatchRegistry() {
  const entries = new Map<string, RegistryEntry>()
  let seq = 0

  const fail = (msg: string): never => {
    throw new Error(`[forge:dispatch-registry] ${msg}`)
  }

  const isTerminal = (st: DispatchState): boolean => st === "completed" || st === "timeout" || st === "killed" || st === "error"

  return {
    submit(entry: { sessionID: string; identity: string; depth: string | null; tier: string; parentSessionID: string; queuedAt?: string }): { dispatchId: string } {
      const dispatchId = `bg-${++seq}`
      entries.set(dispatchId, {
        ...entry,
        dispatchId,
        background: true,
        queuedAt: entry.queuedAt ?? new Date().toISOString(),
        state: "queued",
        delivered: false,
      })
      return { dispatchId }
    },

    get(dispatchId: string): RegistryEntry {
      const e = entries.get(dispatchId)
      if (!e) fail(`unknown dispatch id "${dispatchId}"`)
      return e
    },

    markRunning(dispatchId: string): RegistryEntry {
      const e = this.get(dispatchId)
      if (e.state !== "queued") fail(`illegal transition ${e.state} → running for ${dispatchId}`)
      e.state = "running"
      return e
    },

    markCompleted(dispatchId: string, result: Record<string, unknown>): RegistryEntry {
      return this.terminate(dispatchId, "completed", result)
    },
    markTimeout(dispatchId: string, report: Record<string, unknown>): RegistryEntry {
      return this.terminate(dispatchId, "timeout", report)
    },
    markError(dispatchId: string, report: Record<string, unknown>): RegistryEntry {
      return this.terminate(dispatchId, "error", report)
    },

    markKilled(dispatchId: string): RegistryEntry {
      return this.terminate(dispatchId, "killed")
    },

    // A result that arrived after a kill: noted on the entry, never delivered.
    noteLateCompletion(dispatchId: string, result: Record<string, unknown>): void {
      const e = this.get(dispatchId)
      if (e.state !== "killed") fail(`late completion only makes sense on a killed dispatch (${dispatchId} is ${e.state})`)
      e.lateCompletion = result
    },

    terminate(dispatchId: string, state: "completed" | "timeout" | "killed" | "error", result?: Record<string, unknown>): RegistryEntry {
      const e = this.get(dispatchId)
      if (isTerminal(e.state)) fail(`illegal transition ${e.state} → ${state} for ${dispatchId}`)
      e.state = state
      if (result !== undefined) e.result = result
      return e
    },

    // Atomic exactly-once delivery drain for the wake engine: every terminal
    // not yet delivered is returned and marked delivered in one step.
    takeUndelivered(): RegistryEntry[] {
      const out: RegistryEntry[] = []
      for (const e of entries.values()) {
        if (isTerminal(e.state) && !e.delivered && e.state !== "killed") {
          e.delivered = true
          out.push(e)
        }
      }
      return out
    },

    // In-flight (queued/running) + most recent terminal entries — the model's
    // recovery path after context compaction (forge_dispatch_list).
    list(): { inFlight: RegistryEntry[]; terminal: RegistryEntry[] } {
      const inFlight: RegistryEntry[] = []
      const terminal: RegistryEntry[] = []
      for (const e of entries.values()) {
        if (isTerminal(e.state)) terminal.push(e)
        else inFlight.push(e)
      }
      return { inFlight, terminal: terminal.slice(-TERMINAL_CAP) }
    },
  }
}

export type DispatchRegistry = ReturnType<typeof createDispatchRegistry>
