// Async dispatch core: SDK child-session lifecycle for the task-shadow
// dispatch surface (the `task` tool; formerly forge_dispatch).
//
// Pure logic, no @opencode-ai imports — the client is a structural
// (duck-typed) seam shaped after the pinned @opencode-ai/sdk 1.18.33
// surface (see openspec/changes/async-dispatch/design.md Open Questions
// for the exact verified call shapes):
//   session.create   POST /session                       body {parentID,title,permission,...} query {directory}
//   session.promptAsync POST /session/{id}/prompt_async  body {agent,parts:[{type:"text",text}]} → 204 void
//   session.status   GET  /session/status                → { [sessionID]: {type:"idle"|"busy"|"retry"} }
//   session.messages GET  /session/{id}/message          → [{info:{role,finish,error,time},parts:[{type,text}]}]
//   session.get      GET  /session/{id}                  → session record ({time:{updated}}) — fold B probe
//   session.abort    POST /session/{id}/abort            → boolean
//
// The clock and sleeper are injectable so tests drive polls
// deterministically. Wiring (plugin.ts) owns gates, handles, wakes.

/** Session-wide question deny seal (OMO parity): a child can never block on human input. */
export const QUESTION_DENY_PERMISSION: ReadonlyArray<{
  permission: "question"
  action: "deny"
  pattern: "*"
}> = [{ permission: "question", action: "deny", pattern: "*" }]

/** Active (non-terminal) session status types — mirrors the SDK SessionStatus union. */
const ACTIVE_STATUS_TYPES = new Set(["busy", "retry", "running"])

export type SessionLike = { id?: string }

export type MessageInfoLike = {
  id?: string
  role?: string
  finish?: string
  error?: unknown
  time?: { created?: number; completed?: number }
}

export type PartLike = { type?: string; text?: string }

export type SessionMessageLike = { info?: MessageInfoLike; parts?: PartLike[] }

export type StatusMapLike = { [sessionID: string]: { type?: string } }

/**
 * Structural client seam — the host SDK client satisfies this without any
 * adapter. Responses are the SDK's {data?, error?} envelope; `error !==
 * undefined` is the failure branch (OMO convention).
 */
export type DispatchClient = {
  session: {
    create: (args: {
      body: Record<string, unknown>
      query?: { directory?: string }
    }) => Promise<{ data?: SessionLike; error?: unknown }>
    /** Fire-and-forget prompt (POST /session/{id}/prompt_async, 204 void). Preferred endpoint. */
    promptAsync?: (args: {
      path: { id: string }
      body: Record<string, unknown>
      query?: { directory?: string }
    }) => Promise<unknown>
    /** Synchronous fallback (POST /session/{id}/message) when promptAsync is absent. */
    prompt?: (args: {
      path: { id: string }
      body: Record<string, unknown>
      query?: { directory?: string }
    }) => Promise<unknown>
    status: (args?: Record<string, never>) => Promise<{ data?: StatusMapLike; error?: unknown }>
    /**
     * Session record fetch (GET /session/{id}) — the fold B activity/
     * existence probe. Optional: hosts/clients without the endpoint report
     * `exists: null` (unresolved) and the stale reap skips its sweeps.
     * Tolerates BOTH response shapes seen in the wild: the SDK's
     * {data?, error?} envelope AND a bare session record.
     */
    get?: (args: { path: { id: string }; query?: { directory?: string } }) => Promise<unknown>
    messages: (args: {
      path: { id: string }
      query?: { limit?: number }
    }) => Promise<{ data?: SessionMessageLike[]; error?: unknown }>
    abort: (args: { path: { id: string }; query?: { directory?: string } }) => Promise<unknown>
  }
}

export type TimeSeams = {
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

const defaultNow = () => Date.now()
const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Child session title in the host-native format (design D-spike: live TUI
 * children render as `"<desc> (@<agent> subagent)"` — we match verbatim).
 */
export function childSessionTitle(description: string, agentID: string): string {
  return `${description} (@${agentID} subagent)`
}

export type CreateChildInput = {
  parentSessionID: string
  /** Directory of the parent session (query.directory anchors the child to the same worktree). */
  parentDirectory: string
  agentID: string
  description: string
  /**
   * Question policy (task-shadow, mode-keyed): async dispatches seal the
   * child with the session-wide question deny (unattended safety, 0.22.0
   * semantics); sync dispatches omit the seal entirely — native parity, the
   * user is present at the panel and the child may ask.
   */
  questionDeny?: boolean
}

export type CreateChildResult =
  | { ok: true; sessionID: string }
  | { ok: false; error: string }

export async function createChildSession(
  client: DispatchClient,
  input: CreateChildInput,
): Promise<CreateChildResult> {
  let result: { data?: SessionLike; error?: unknown }
  try {
    result = await client.session.create({
      body: {
        parentID: input.parentSessionID,
        title: childSessionTitle(input.description, input.agentID),
        ...(input.questionDeny === true ? { permission: QUESTION_DENY_PERMISSION } : {}),
      },
      query: { directory: input.parentDirectory },
    })
  } catch (e) {
    return { ok: false, error: `session.create threw: ${String(e)}` }
  }
  if (result.error !== undefined) {
    return { ok: false, error: `session.create failed: ${String(result.error)}` }
  }
  const id = result.data?.id
  if (typeof id !== "string" || id === "") {
    return { ok: false, error: "session.create returned no session id" }
  }
  return { ok: true, sessionID: id }
}

export type SendPromptInput = {
  sessionID: string
  agentID: string
  prompt: string
  directory?: string
}

export type SendPromptResult = { ok: true } | { ok: false; error: string }

export function buildPromptArgs(input: SendPromptInput): {
  path: { id: string }
  body: Record<string, unknown>
  query?: { directory?: string }
} {
  return {
    path: { id: input.sessionID },
    body: {
      agent: input.agentID,
      parts: [{ type: "text", text: input.prompt }],
    },
    ...(input.directory !== undefined ? { query: { directory: input.directory } } : {}),
  }
}

export async function sendPrompt(
  client: DispatchClient,
  input: SendPromptInput,
): Promise<SendPromptResult> {
  const args = buildPromptArgs(input)
  try {
    if (typeof client.session.promptAsync === "function") {
      await client.session.promptAsync(args)
    } else if (typeof client.session.prompt === "function") {
      await client.session.prompt(args)
    } else {
      return { ok: false, error: "client has no session.promptAsync or session.prompt endpoint" }
    }
  } catch (e) {
    return { ok: false, error: `prompt send threw: ${String(e)}` }
  }
  return { ok: true }
}

export type PollInput = {
  sessionID: string
  /** Poll interval in ms (default 1000). */
  intervalMs?: number
  /** Wait-mode timeout in ms — the honest ceiling before giving up (default 600000). */
  timeoutMs?: number
  /**
   * Caller-owned terminal-stability counter (sync-timeout-notify soundness).
   * pollChild resets/increments it per tick observation; the ASYNC wiring
   * (runAsyncDispatchPoller) shares ONE state object across its poll slices
   * so the stability depth survives slice boundaries. Omit for a
   * self-contained counter (the sync path).
   */
  stability?: TerminalStabilityState
  /**
   * Sync abort parity (task-shadow design D4): the dispatching turn's abort
   * signal. When it fires mid-poll the loop returns `aborted` — the CALLER
   * then aborts the child via the SDK and discloses. Checked every poll
   * iteration (belt, not a listener: poll slices are short).
   */
  signal?: AbortSignal
}

export type PollResult =
  | { status: "completed"; polls: number }
  | { status: "error"; error: string; polls: number }
  | { status: "timeout"; sessionID: string; timeoutMs: number; polls: number }
  | { status: "aborted"; sessionID: string; polls: number }

export const DEFAULT_POLL_INTERVAL_MS = 1000
export const DEFAULT_POLL_TIMEOUT_MS = 600000

/** Upper clamp for FORGE_DISPATCH_POLL_TIMEOUT_MS — one hour is plenty for a poll window. */
export const MAX_POLL_TIMEOUT_MS = 3_600_000

/**
 * Resolve the sync-dispatch poll timeout from the environment knob
 * `FORGE_DISPATCH_POLL_TIMEOUT_MS` (default 600000, unchanged). Read with the
 * same tolerance posture as the interval knob's `Number(env.X ?? DEFAULT)`
 * call-site reads, plus honest fallback and a ceiling: unset/empty, a
 * non-numeric string, or a non-positive value falls back to the default; a
 * valid value is clamped to MAX_POLL_TIMEOUT_MS. The env is a parameter so
 * tests drive it deterministically without touching process.env.
 */
export function resolvePollTimeoutMs(env: { [key: string]: string | undefined } = process.env): number {
  const raw = env.FORGE_DISPATCH_POLL_TIMEOUT_MS
  if (raw === undefined || raw === "") return DEFAULT_POLL_TIMEOUT_MS
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_POLL_TIMEOUT_MS
  return Math.min(Math.round(parsed), MAX_POLL_TIMEOUT_MS)
}

/**
 * Resolve the [forge:dispatch-progress] notification interval from the
 * environment knob `FORGE_DISPATCH_NOTIFY_INTERVAL_MS` (sync-timeout-notify
 * fold #2, design D6). Default 600000 — the same wall clock the sync wait
 * uses BY DEFAULT, but tuned independently: FORGE_DISPATCH_POLL_TIMEOUT_MS
 * scopes the SYNC WAIT only and must never feed the never-die tracker.
 * Same tolerance posture and ceiling clamp as resolvePollTimeoutMs; the
 * env is a parameter so tests drive it deterministically.
 */
export function resolveNotifyIntervalMs(env: { [key: string]: string | undefined } = process.env): number {
  const raw = env.FORGE_DISPATCH_NOTIFY_INTERVAL_MS
  if (raw === undefined || raw === "") return DEFAULT_POLL_TIMEOUT_MS
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_POLL_TIMEOUT_MS
  return Math.min(Math.round(parsed), MAX_POLL_TIMEOUT_MS)
}

// ---------------------------------------------------------------------------
// Activity-stale reap (dispatch-resilience fold B). The activity anchor is
// the child's `session.get` `time.updated` timestamp (part-level updates —
// a child streaming one long generation still refreshes it; a message-list
// re-read one tick later adds no independent signal). When no activity
// timestamp has ever been observed, the anchor is the dispatch start time.
// Distinct from the textless-idle floor: floor = child GONE from the status
// map with no reportable message; stale = child STILL BUSY (active) with no
// activity advancement.

/** Default stale threshold: 45 min without activity past the runtime floor. */
export const DEFAULT_STALE_MS = 2_700_000

/** Minimum runtime before ANY reap is considered (spec: 60-second floor). */
export const MIN_STALE_RUNTIME_MS = 60_000

export type StaleMode = "kill" | "observe"

/**
 * Resolve the stale threshold from `FORGE_DISPATCH_STALE_MS` (default
 * 2700000). Same tolerance posture as the other dispatch knobs: unset/
 * empty, non-numeric, or non-positive values fall back to the default; a
 * valid value below the 60 s runtime floor clamps UP to the floor (design
 * migration note, review F21).
 */
export function resolveStaleMs(env: { [key: string]: string | undefined } = process.env): number {
  const raw = env.FORGE_DISPATCH_STALE_MS
  if (raw === undefined || raw === "") return DEFAULT_STALE_MS
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_STALE_MS
  return Math.max(Math.round(parsed), MIN_STALE_RUNTIME_MS)
}

/**
 * Resolve `FORGE_DISPATCH_STALE_MODE`: `kill` (default — abort the stale
 * child, honest terminal wake) or `observe` (one progress notice per
 * threshold crossing, never kill). Anything unrecognized falls back to
 * `kill`.
 */
export function resolveStaleMode(env: { [key: string]: string | undefined } = process.env): StaleMode {
  const raw = (env.FORGE_DISPATCH_STALE_MODE ?? "").trim().toLowerCase()
  return raw === "observe" ? "observe" : "kill"
}

/**
 * Internal test seam for the 60 s minimum-runtime floor
 * (`FORGE_DISPATCH_STALE_FLOOR_MS`): production semantics are the fixed
 * MIN_STALE_RUNTIME_MS; wiring tests shrink it to drive reaps in
 * milliseconds. Invalid values fall back to the fixed floor.
 */
export function resolveStaleFloorMs(env: { [key: string]: string | undefined } = process.env): number {
  const raw = env.FORGE_DISPATCH_STALE_FLOOR_MS
  if (raw === undefined || raw === "") return MIN_STALE_RUNTIME_MS
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed < 0) return MIN_STALE_RUNTIME_MS
  return Math.round(parsed)
}

/** Result of the session.get activity/existence probe (see sessionGet). */
export type SessionGetResult = {
  /** true = session record resolved; false = session proven missing; null = UNRESOLVED (fetch error — never a verdict). */
  exists: boolean | null
  /** `time.updated` (or `time_updated`) when present and finite; else null. */
  timeUpdated: number | null
}

// Ported not-found signals (omo session-existence.ts): a 404 status or a
// not-found/missing message on the fetch proves the session GONE; any other
// fetch failure is UNRESOLVED (skip the sweep — never a terminal verdict on
// a signal that could not be read).
function sessionNotFoundSignal(error: unknown): boolean {
  let text = ""
  let status: number | undefined
  if (typeof error === "string") {
    text = error
  } else if (error && typeof error === "object") {
    const rec = error as { message?: unknown; name?: unknown; status?: unknown; statusCode?: unknown; code?: unknown }
    for (const key of ["statusCode", "status", "code"] as const) {
      const val = rec[key]
      if (typeof val === "number" && val >= 100 && val < 600) status = val
      if (typeof val === "string" && /^\d{3}$/.test(val)) status = Number(val)
    }
    text = [String(rec.name ?? ""), String(rec.message ?? "")].join(" ")
  }
  if (status === 404) return true
  return /not found|missing/i.test(text)
}

function readTimeUpdated(record: unknown): number | null {
  if (!record || typeof record !== "object") return null
  const rec = record as { time?: unknown; time_updated?: unknown }
  const time = rec.time && typeof rec.time === "object" ? (rec.time as { updated?: unknown }) : undefined
  // omo parity (session-activity.ts:18-22): time.updated ?? time_updated
  for (const candidate of [time?.updated, rec.time_updated]) {
    if (typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0) return candidate
  }
  return null
}

/**
 * The fold B activity/existence probe: ONE `session.get` call serving both
 * the refresh rail (a refreshed `time.updated` proves the child producing —
 * it can never be reaped) and the existence probe (session missing →
 * finalize; fetch error → unresolved → skip the sweep). Handles the SDK
 * envelope ({data?, error?}) and bare-record response shapes; an absent
 * endpoint reports unresolved.
 */
export async function sessionGet(client: DispatchClient, sessionID: string): Promise<SessionGetResult> {
  // Invoke as a BOUND method - destructuring (`const get = client.session.get`)
  // loses `this` and the SDK instance method throws (`this._client` undefined).
  if (typeof client.session.get !== "function") return { exists: null, timeUpdated: null }
  let result: unknown
  try {
    result = await client.session.get({ path: { id: sessionID } })
  } catch (e) {
    if (process.env.FORGE_DISPATCH_DEBUG === "1") console.error(`[forge-dbg] sessionGet threw: ${String(e).slice(0, 300)}`)
    return sessionNotFoundSignal(e) ? { exists: false, timeUpdated: null } : { exists: null, timeUpdated: null }
  }
  if (
    result !== null &&
    typeof result === "object" &&
    ("error" in (result as Record<string, unknown>) || "data" in (result as Record<string, unknown>))
  ) {
    const env = result as { data?: unknown; error?: unknown }
    if (env.error !== undefined && env.error !== null) {
      if (process.env.FORGE_DISPATCH_DEBUG === "1") console.error(`[forge-dbg] sessionGet error envelope: ${JSON.stringify(env.error).slice(0, 300)}`)
      return sessionNotFoundSignal(env.error) ? { exists: false, timeUpdated: null } : { exists: null, timeUpdated: null }
    }
    if (env.data == null) return { exists: false, timeUpdated: null }
    return { exists: true, timeUpdated: readTimeUpdated(env.data) }
  }
  if (result == null) return { exists: false, timeUpdated: null }
  return { exists: true, timeUpdated: readTimeUpdated(result) }
}

/**
 * Per-tracked-child stale state: `lastActivity` is the last OBSERVED
 * `time.updated` (adopted on first observation — the anchor IS the host's
 * timestamp, even if clock skew puts it slightly before dispatch start);
 * null while nothing has ever been observed (anchor = dispatch start).
 */
export type StaleSweepState = { lastActivity: number | null; staleNotified: boolean }

/** The effective activity anchor: last observed time.updated, else dispatch start. */
export function staleAnchor(state: StaleSweepState, startedAt: number): number {
  return state.lastActivity ?? startedAt
}

/** Pure gate: runtime floor met AND the anchor has been silent for the threshold. */
export function staleThresholdCrossed(
  state: StaleSweepState,
  now: number,
  startedAt: number,
  staleMs: number,
  floorMs: number,
): boolean {
  return now - startedAt >= floorMs && now - staleAnchor(state, startedAt) >= staleMs
}

export type StaleSweepDecision =
  | { action: "skip" } // probe unresolved — skip this sweep entirely
  | { action: "gone" } // session missing — finalize honestly
  | { action: "notify" } // observe mode: first crossing — emit the ONE notice
  | { action: "quiet" } // observe mode: already notified this crossing
  | { action: "kill" } // kill mode: proceed to the SDK abort

/**
 * Fold the fresh session.get probe into the stale state (run EVERY sweep
 * cadence — this IS the refresh rail): a `time.updated` newer than the last
 * observation resets the timer (a producing child can never be reaped) and
 * the FIRST observation ADOPTS the host's timestamp as the anchor even if
 * clock skew puts it before dispatch start (the anchor IS the host's
 * timestamp; the dispatch start time is only the null fallback). The
 * `staleNotified` flag resets with the anchor so a later crossing can
 * notify again (observe mode: one notice per crossing).
 */
export function applyStaleProbe(state: StaleSweepState, probe: SessionGetResult): void {
  if (probe.exists !== true) return
  const t = probe.timeUpdated
  if (t === null) return
  if (state.lastActivity === null || t > state.lastActivity) {
    state.lastActivity = t
    state.staleNotified = false
  }
}

/**
 * Pure decision for one stale sweep WHEN THE THRESHOLD IS CROSSED (call
 * applyStaleProbe with this same probe FIRST — a refreshed timestamp then
 * reset the anchor and the crossing evaporates). The caller performs the
 * abort (and the abort-failure existence re-probe) — this function never
 * touches the client.
 */
export function decideStaleSweep(
  probe: SessionGetResult,
  state: StaleSweepState,
  mode: StaleMode,
): StaleSweepDecision {
  if (probe.exists === null) return { action: "skip" }
  if (probe.exists === false) return { action: "gone" }
  if (mode === "observe") return state.staleNotified ? { action: "quiet" } : { action: "notify" }
  return { action: "kill" }
}

/** Honest minutes-silent figure for the stale finding ("aborted after N min"). */
export function staleSilentMinutes(state: StaleSweepState, now: number, startedAt: number): number {
  return Math.max(1, Math.round((now - staleAnchor(state, startedAt)) / 60000))
}

function isActiveStatus(status: { type?: string } | undefined): boolean {
  return status !== undefined && status.type !== undefined && ACTIVE_STATUS_TYPES.has(status.type)
}

/**
 * Terminal-inference soundness (sync-timeout-notify): how many CONSECUTIVE
 * poll ticks the completed candidate (not-active + truthy finish + non-empty
 * text parts on the latest assistant message) must hold before pollChild
 * may return `completed`. A single observation is not a verdict — a session
 * that flaps back to busy resets the run.
 */
export const TERMINAL_STABILITY_TICKS = 3

/**
 * Caller-shareable stability counter (see PollInput.stability). The optional
 * `textlessIdleSince` is the textless-idle floor streak (sync-timeout-notify
 * fold #2): pollChild stamps it when a NOT-ACTIVE child's latest assistant
 * message is not a reportable final message and clears it on any active
 * reading or textful candidate; the ASYNC wiring reads it to terminate
 * honestly once the streak spans a full notification interval. Sync callers
 * ignore it (their own wait window applies), so pollChild's return contract
 * is unchanged.
 */
export type TerminalStabilityState = { stableTicks: number; textlessIdleSince?: number }

function latestAssistant(messages: SessionMessageLike[]): SessionMessageLike | undefined {
  let best: SessionMessageLike | undefined
  let bestCreated = -Infinity
  for (const m of messages) {
    if (m.info?.role !== "assistant") continue
    const created = m.info.time?.created ?? 0
    if (created >= bestCreated) {
      best = m
      bestCreated = created
    }
  }
  return best
}

function describeError(error: unknown): string {
  if (error && typeof error === "object" && "name" in error) {
    const named = error as { name?: string; data?: { message?: unknown } }
    const detail = named.data?.message ?? ""
    return `${String(named.name)}${detail ? `: ${String(detail)}` : ""}`
  }
  return String(error)
}

/**
 * Poll the child session to a terminal state. Terminal semantics
 * (sync-timeout-notify soundness): the latest assistant message carrying an
 * `error` object is a terminal error (immediate — explicit, not inferred);
 * `completed` requires the not-active + truthy-finish + non-empty-text
 * candidate to hold stable across TERMINAL_STABILITY_TICKS consecutive
 * ticks (any active reading resets the run), and an unreadable status
 * (fetch failure / session missing from the map) counts as ACTIVE. Reaching
 * the timeout returns an honest timeout naming the child session id (the
 * child stays alive and natively abortable — we never kill on timeout here).
 */
export async function pollChild(
  client: DispatchClient,
  input: PollInput,
  seams: TimeSeams = {},
): Promise<PollResult> {
  const now = seams.now ?? defaultNow
  const sleep = seams.sleep ?? defaultSleep
  const intervalMs = input.intervalMs ?? DEFAULT_POLL_INTERVAL_MS
  const timeoutMs = input.timeoutMs ?? DEFAULT_POLL_TIMEOUT_MS
  const deadline = now() + timeoutMs
  const stability = input.stability ?? { stableTicks: 0 }
  let polls = 0

  for (;;) {
    await sleep(intervalMs)
    polls++

    // Sync abort parity: the dispatching turn was aborted — hand the abort
    // back to the caller (which aborts the child via the SDK and discloses).
    if (input.signal?.aborted) {
      return { status: "aborted", sessionID: input.sessionID, polls }
    }

    // Soundness (sync-timeout-notify), empirically corrected on host 1.19.5:
    // GET /session/status returns ONLY currently-active (busy/retry) sessions
    // — a COMPLETED session is REMOVED from the map. So:
    //   • an UNREADABLE status (fetch failed/threw) is treated as ACTIVE —
    //     keep polling, never a verdict on a signal we could not read;
    //   • a session MISSING from a successfully fetched map is the host's
    //     IDLE signal — not-active (the stability window below is what
    //     guards against transient flakes where a running child blinks out
    //     of the map for a tick or two; it re-appears and resets the run).
    let statusMap: StatusMapLike | undefined
    try {
      const statusResult = await client.session.status()
      if (statusResult.error === undefined && statusResult.data && typeof statusResult.data === "object") {
        statusMap = statusResult.data
      }
    } catch {
      statusMap = undefined
    }
    let active: boolean
    if (statusMap === undefined) {
      active = true
    } else {
      const entry = statusMap[input.sessionID]
      active = entry === undefined ? false : isActiveStatus(entry)
    }

    let messages: SessionMessageLike[] = []
    try {
      const msgResult = await client.session.messages({
        path: { id: input.sessionID },
        query: { limit: 100 },
      })
      if (msgResult.error === undefined && Array.isArray(msgResult.data)) {
        messages = msgResult.data
      }
    } catch {
      messages = []
    }

    const last = latestAssistant(messages)
    if (last?.info?.error != null) {
      // Error is an EXPLICIT host-written terminal fact — immediate, no
      // stability window (the window guards INFERENCE, not declarations).
      return { status: "error", error: describeError(last.info.error), polls }
    }
    // Completed candidate: not-active AND a truthy finish AND non-empty text
    // parts on the latest assistant message. A finished-but-textless (or
    // unfinished) message is NOT a final report — keep polling; such a child
    // ends as the honest timeout (the armed wake covers it upstream).
    const finished = Boolean(last?.info?.finish)
    const textful =
      last !== undefined &&
      (last.parts ?? []).some((p) => p.type === "text" && typeof p.text === "string" && p.text !== "")
    if (!active && finished && textful) {
      stability.stableTicks++
      if (stability.stableTicks >= TERMINAL_STABILITY_TICKS) {
        return { status: "completed", polls }
      }
    } else {
      // Any busy/active reading or a failed candidate observation breaks the
      // consecutive run (spec: "resetting when the session turns busy again").
      stability.stableTicks = 0
    }
    // Textless-idle floor streak: a NOT-ACTIVE child whose latest assistant
    // message is not a reportable final message (no message, falsy finish,
    // or no non-empty text) starts/holds the streak; any ACTIVE reading
    // (a status fetch failure counts as active) or a textful candidate
    // clears it — so a RUNNING child can never accumulate floor time.
    if (active || (finished && textful)) {
      stability.textlessIdleSince = undefined
    } else if (stability.textlessIdleSince === undefined) {
      stability.textlessIdleSince = now()
    }

    if (now() >= deadline) {
      return { status: "timeout", sessionID: input.sessionID, timeoutMs, polls }
    }
  }
}

export type FinalMessageResult = { ok: true; text: string } | { ok: false; error: string }

/** Newest-first assistant text: text parts of the latest assistant message, joined. */
export async function fetchFinalMessage(
  client: DispatchClient,
  sessionID: string,
): Promise<FinalMessageResult> {
  let messages: SessionMessageLike[]
  try {
    const result = await client.session.messages({ path: { id: sessionID } })
    if (result.error !== undefined) {
      return { ok: false, error: `session.messages failed: ${String(result.error)}` }
    }
    messages = Array.isArray(result.data) ? result.data : []
  } catch (e) {
    return { ok: false, error: `session.messages threw: ${String(e)}` }
  }
  const last = latestAssistant(messages)
  if (last === undefined) {
    return { ok: false, error: `no assistant response found in child session ${sessionID}` }
  }
  const text = (last.parts ?? [])
    .filter((p) => p.type === "text")
    .map((p) => p.text ?? "")
    .filter(Boolean)
    .join("\n")
  if (text === "") {
    return { ok: false, error: `no assistant text output found in child session ${sessionID}` }
  }
  return { ok: true, text }
}

export type AbortResult = { ok: true } | { ok: false; error: string }

export async function abortChild(client: DispatchClient, sessionID: string): Promise<AbortResult> {
  try {
    await client.session.abort({ path: { id: sessionID } })
  } catch (e) {
    return { ok: false, error: `session.abort threw: ${String(e)}` }
  }
  return { ok: true }
}
