// Native-child gate pure cores (change crew-continue-native-child-gate,
// tasks 2.1/2.2, design D2/D3/D7/D8): host-native subagents dispatched through
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

/** A child of the walked session that is NOT in flight, with its own row outcome. */
export type NativeChildSettled = {
  childID: string
  /** null ⇒ the host row carries no (or no known) outcome — never coerced into a verdict. */
  outcome: NativeChildOutcome | null
}

/**
 * One decision-time read of a session's native children (design D8 — the
 * walk is the single authority for BOTH the gate and the outcome digest).
 *
 * `readable: false` ⇒ nothing is known: the view failed to read and the
 * caller must treat it exactly like the fail-OPEN "no children in flight"
 * (send) — AND must not conclude anything about children it is waiting on.
 */
export type NativeChildWalkView = {
  readable: boolean
  /** Children of sessionID present in the active map with a non-idle type. */
  inFlight: string[]
  /** Children of sessionID NOT in flight (absent from the map, or idle). */
  settled: NativeChildSettled[]
}

const unreadable = (): NativeChildWalkView => ({ readable: false, inFlight: [], settled: [] })

/** Active-map entry ⇒ in flight? Absent or explicit idle = terminal (host contract). */
function entryInFlight(entry: unknown): boolean {
  if (entry === undefined) return false // terminal: absent from the active map
  if (entry !== null && typeof entry === "object" && (entry as { type?: unknown }).type === "idle") return false // terminal: idle
  return true
}

/**
 * A session row's `outcome` validated against the terminal union. Live 2.3.2
 * census (real host, 100 rows): succeeded / failed / interrupted / absent —
 * any other value reads as null ("unknown"), never as a coerced verdict.
 */
export function nativeChildOutcome(value: unknown): NativeChildOutcome | null {
  return value === "succeeded" || value === "failed" || value === "interrupted" ? value : null
}

/**
 * Task 2.1 / D8 — the decision-time walk. session.list with the parentID
 * HINT ({parentID: sessionID}) and the envelope tolerance proven by
 * findChildByParentWalk / detectOrphanDispatchChildren (array | {sessions} |
 * {data}); keep entries with parentID === sessionID; cross-read
 * client.session.status() (unwrap .data, keys = busy session ids). A child
 * present in the map with a non-idle type ⇒ in flight; every other child of
 * the session ⇒ settled, carrying its row outcome.
 *
 * Any throw / unreadable shape ⇒ `readable: false` with nothing in flight
 * (fail-OPEN, never fail-silent — design D2).
 *
 * The hint matters on the live host (2.3.2 OpenAPI, session.list): an
 * unscoped GET /api/session returns "the newest 50 sessions" GLOBALLY, and
 * the 50-row cap applies to the parentID-filtered page too (real host,
 * 2026-11-23: a parent with 85 children — 50 rows by default, 85 with
 * ?limit=500). Clients that ignore the hint keep working: the client-side
 * filter below is the semantic authority, the hint only narrows the page.
 */
export async function walkNativeChildren(client: NativeChildClient, sessionID: string): Promise<NativeChildWalkView> {
  if (!sessionID) return unreadable()
  try {
    const raw = await client?.session?.list?.({ parentID: sessionID })
    const body = (raw as { data?: unknown } | undefined)?.data ?? raw
    const list = Array.isArray(body)
      ? (body as Array<Record<string, unknown>>)
      : Array.isArray((body as { sessions?: unknown[] } | undefined)?.sessions)
        ? ((body as { sessions: unknown[] }).sessions as Array<Record<string, unknown>>)
        : null
    if (list === null) return unreadable() // no readable list at all
    const rows: NativeChildSettled[] = []
    for (const s of list) {
      if (!s || typeof s.id !== "string" || !s.id) continue
      if (s.parentID !== sessionID) continue
      rows.push({ childID: s.id, outcome: nativeChildOutcome(s.outcome) })
    }
    if (rows.length === 0) return { readable: true, inFlight: [], settled: [] }
    // Status cross-read exactly like detectOrphanDispatchChildren: unwrap
    // .data, keys = busy session ids ("Sessions absent from the result are
    // inactive" — host contract).
    if (typeof client?.session?.status !== "function") return unreadable()
    const st = await client.session.status()
    const map = (st as { data?: Record<string, unknown> } | undefined)?.data
    if (!map || typeof map !== "object") return unreadable()
    const inFlight: string[] = []
    const settled: NativeChildSettled[] = []
    for (const row of rows) {
      if (entryInFlight(map[row.childID])) inFlight.push(row.childID)
      else settled.push(row)
    }
    return { readable: true, inFlight, settled }
  } catch {
    return unreadable() // fail-OPEN, never fail-silent (design D2)
  }
}

/** Gate verdict of the walk: ANY non-idle/non-terminal native child ⇒ true. */
export async function nativeChildrenInFlight(client: NativeChildClient, sessionID: string): Promise<boolean> {
  return (await walkNativeChildren(client, sessionID)).inFlight.length > 0
}

/**
 * D8 — the orchestrator's OWN busy state on the same active map the walk
 * reads (the send-time idle re-check for adapters that carry no
 * session.status — the production v2 adapter). true ⇒ present and non-idle;
 * false ⇒ absent or idle; null ⇒ unreadable (callers keep whatever they did
 * before this read existed).
 */
export async function nativeSessionBusy(client: NativeChildClient, sessionID: string): Promise<boolean | null> {
  if (!sessionID) return null
  try {
    if (typeof client?.session?.status !== "function") return null
    const st = await client.session.status()
    const map = (st as { data?: Record<string, unknown> } | undefined)?.data
    if (!map || typeof map !== "object") return null
    return entryInFlight(map[sessionID])
  } catch {
    return null
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
 * An interrupted child is disclosed as DEAD the moment the plugin knows. A
 * null outcome (the row is gone or carries none) is disclosed as exactly
 * that — a child the plugin cannot vouch for is never reported as a success.
 */
export function nativeChildDigestLine(childID: string, outcome: NativeChildOutcome | null): string {
  if (outcome === "interrupted") {
    return `native child ${childID} interrupted — DEAD (aborted mid-run; its dispatch sentence timed out or was killed): re-dispatch the subtask or record the loss in the close report`
  }
  if (outcome === null) {
    return `native child ${childID} is no longer running but the host reports no outcome for it (deleted mid-run, or its row carries none) — treat the subtask as UNVERIFIED: re-dispatch it or record the loss in the close report`
  }
  return `native child ${childID} ${outcome}`
}
