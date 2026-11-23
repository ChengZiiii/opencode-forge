// Native-child gate pure cores (change crew-continue-native-child-gate,
// tasks 2.1/2.2, design D2/D3/D7): host-native subagents dispatched through
// the task/subagent channel are invisible to the crew-waves engine's own
// registry — these cores give the engine native-child visibility.
//
// PURE: no @opencode-ai imports, no host state — the client is an injectable
// seam (any object with optional session.list / session.status), the clock
// lives in the plugin.ts wiring. FAIL-OPEN polarity (design D2): an
// unreadable list/status view is "no children in flight" — a false in-flight
// STRANDS the crew, a false idle costs one redundant brief (today's noise).

export type NativeChildOutcome = "succeeded" | "failed" | "interrupted"

/** Minimal client seam: both methods optional — absence fails OPEN. */
export type NativeChildClient = {
  session?: {
    list?: (args?: unknown) => Promise<unknown>
    status?: (opts?: unknown) => Promise<unknown>
  }
}

/**
 * Task 2.1 — the decision-time walk (authoritative gate). session.list with
 * the envelope tolerance proven by findChildByParentWalk /
 * detectOrphanDispatchChildren (array | {sessions} | {data}); keep entries
 * with parentID === sessionID; cross-read client.session.status() (unwrap
 * .data, keys = busy session ids). ANY child present in the map with a
 * non-idle type ⇒ in flight. Terminal = absent from the map or type "idle".
 * Any throw / unreadable shape ⇒ false (fail-OPEN: send the nudge).
 */
export async function nativeChildrenInFlight(client: NativeChildClient, sessionID: string): Promise<boolean> {
  if (!sessionID) return false
  try {
    const raw = await client?.session?.list?.({})
    const body = (raw as { data?: unknown } | undefined)?.data ?? raw
    const list = Array.isArray(body)
      ? (body as Array<Record<string, unknown>>)
      : Array.isArray((body as { sessions?: unknown[] } | undefined)?.sessions)
        ? ((body as { sessions: unknown[] }).sessions as Array<Record<string, unknown>>)
        : []
    const children: string[] = []
    for (const s of list) {
      if (!s || typeof s.id !== "string" || !s.id) continue
      if (s.parentID !== sessionID) continue
      children.push(s.id)
    }
    if (children.length === 0) return false
    // Status cross-read exactly like detectOrphanDispatchChildren: unwrap
    // .data, keys = busy session ids ("Sessions absent from the result are
    // inactive" — host contract).
    if (typeof client?.session?.status !== "function") return false // unreadable ⇒ fail-open
    const st = await client.session.status()
    const map = (st as { data?: Record<string, unknown> } | undefined)?.data
    if (!map || typeof map !== "object") return false // unreadable ⇒ fail-open
    for (const id of children) {
      const entry = map[id]
      if (entry === undefined) continue // terminal: absent from the active map
      if (entry !== null && typeof entry === "object" && (entry as { type?: unknown }).type === "idle") continue // terminal: idle
      return true // a busy native child ⇒ suppressed
    }
    return false
  } catch {
    return false // fail-OPEN, never fail-silent (design D2)
  }
}

/**
 * Task 2.2 — the ADVISORY warm set (event-fed tracker; the walk wins any
 * disagreement). Pure instance state: (childID, parentID) rows with their
 * terminal OUTCOME (succeeded/failed/interrupted — D7 defect-B: an
 * interrupted child must be nameable as dead the moment the plugin knows).
 */
export type TrackedNativeChild = {
  childID: string
  parentID: string
  terminal: boolean
  outcome?: NativeChildOutcome
}

export type NativeChildTerminalNote = {
  parentID: string
  /** True when NO non-terminal child remains for this parent (re-arm edge). */
  lastChildTerminal: boolean
}

export type NativeChildTracker = {
  /** session.created carrying a parentID marks (childID, parentID) running. */
  mark(childID: string, parentID: string): void
  /**
   * A terminal edge for a KNOWN child: records the outcome and reports the
   * parent + whether this was the parent's last non-terminal child. Unknown
   * child ⇒ null (flight-miss no-op — the tracker only tracks its own marks).
   */
  terminalize(childID: string, outcome: NativeChildOutcome): NativeChildTerminalNote | null
  /** session.deleted of a child drops its row (parent eviction is forgetParent). */
  drop(childID: string): void
  /** Gate-state eviction: drop every child row bound to this parent. */
  forgetParent(parentID: string): void
  /** Child ids still non-terminal for this parent (advisory). */
  runningChildren(parentID: string): string[]
  /** Test seam: live row map (readonly view). */
  rows(): ReadonlyMap<string, TrackedNativeChild>
}

export function createNativeChildTracker(): NativeChildTracker {
  const children = new Map<string, TrackedNativeChild>()
  return {
    mark(childID, parentID) {
      if (!childID || !parentID) return
      const existing = children.get(childID)
      if (existing && existing.terminal) return // a terminal verdict is sticky
      children.set(childID, { childID, parentID, terminal: false })
    },
    terminalize(childID, outcome) {
      const row = children.get(childID)
      if (!row) return null
      if (!row.terminal || row.outcome !== outcome) {
        row.terminal = true
        row.outcome = outcome
      }
      let lastChildTerminal = true
      for (const r of children.values()) {
        if (r.parentID === row.parentID && !r.terminal) {
          lastChildTerminal = false
          break
        }
      }
      return { parentID: row.parentID, lastChildTerminal }
    },
    drop(childID) {
      children.delete(childID)
    },
    forgetParent(parentID) {
      for (const [id, row] of [...children]) {
        if (row.parentID === parentID) children.delete(id)
      }
    },
    runningChildren(parentID) {
      const ids: string[] = []
      for (const row of children.values()) {
        if (row.parentID === parentID && !row.terminal) ids.push(row.childID)
      }
      return ids
    },
    rows() {
      return children
    },
  }
}

/**
 * Terminal-outcome classification for the durable execution events (the
 * observed idle edge on host 2.3.2 is session.execution.succeeded).
 * Non-execution types ⇒ null.
 */
export function nativeChildEventOutcome(type: string): NativeChildOutcome | null {
  if (type === "session.execution.succeeded") return "succeeded"
  if (type === "session.execution.failed") return "failed"
  if (type === "session.execution.interrupted") return "interrupted"
  return null
}

/**
 * D7 defect-B digest line: one line per terminal child (child id + outcome).
 * An interrupted child is disclosed as DEAD the moment the plugin knows.
 */
export function nativeChildDigestLine(childID: string, outcome: NativeChildOutcome): string {
  if (outcome === "interrupted") {
    return `native child ${childID} interrupted — DEAD (aborted mid-run; its dispatch sentence timed out or was killed): re-dispatch the subtask or record the loss in the close report`
  }
  return `native child ${childID} ${outcome}`
}
