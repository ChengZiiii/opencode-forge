// Host-facing dispatch engine (spec: dispatch — forge_dispatch tool contract;
// design D1/D3/D12). Pure orchestration over injected I/O: the fetcher, clock,
// sleep, sink, and availability are all injected, so unit tests drive the
// exact code paths (create -> message -> poll -> aggregate -> report) without
// a server. plugin.ts creates the engine with the real fetch + ledger sink.
//
// Completion detection: completionVerdict (stable-x2). Deadline: per-dispatch
// (dispatch.timeoutMs, default/max 600000). Terminal states are always
// ledgered; sync failures throw DispatchError with an honest message.

import { completionVerdict, computeCost, sumTokens, type PollState, type TokenCount } from "./dispatch-client.ts"
import type { DispatchRegistry } from "./dispatch-registry.ts"
import type { ResolveOk } from "./dispatch-resolver.ts"
import { composeWorkerPrompt } from "./dispatch-prompt.ts"
import { resolveDispatch } from "./dispatch-resolver.ts"
import type { BuiltRoster, CatalogSnapshot } from "./dispatch-roster.ts"

export const DEFAULT_DISPATCH_TIMEOUT_MS = 600_000
export const MAX_DISPATCH_TIMEOUT_MS = 600_000
export const DEFAULT_MAX_CONCURRENT = 4
export const DEFAULT_POLL_INTERVAL_MS = 2_000

export type DispatchRequest = { prompt: string; profile: string; depth?: string }

export type DispatchResult = {
  tier: string
  requested: { profile: string; depth?: string }
  actual: { model: string; depth: string }
  sessionID: string
  durationMs: number
  tokens: TokenCount
  costUsd: number | null
  costNote?: string
  priceSnapshot?: string
  text: string
  depthInjected: string
}

export type DispatchLedgerEvent = {
  ts: string
  event: string
  tier?: string
  identity?: string
  depth?: string
  sessionID?: string
  outcome?: string
  tokens?: TokenCount
  costUsd?: number | null
  durationMs?: number
  note?: string
}

export class DispatchError extends Error {
  code: string
  constructor(message: string, code: string) {
    super(message)
    this.name = "DispatchError"
    this.code = code
  }
}

export type DispatchEngineDeps = {
  serverUrl: string
  workspace: string
  fetcher: typeof fetch
  now: () => number
  sleep: (ms: number) => Promise<void>
  cfg: BuiltRoster
  catalog: CatalogSnapshot
  available: (identity: string) => boolean
  sink: (entry: DispatchLedgerEvent) => void
  // Registers the resolved depth for the child session (feeds the chat.params
  // injection table); providerFamily resolves the option shape for disclosure.
  onDepth: (sessionID: string, level: string, providerID: string) => void
  registry?: DispatchRegistry
  // Wake-engine hook: fired after a background dispatch reaches any
  // deliverable terminal state (killed never fires — its wake is suppressed).
  onTerminal?: (parentSessionID: string) => void
  providerFamily: (providerID: string) => string | null
  maxConcurrent?: number
  timeoutMs?: number
  pollIntervalMs?: number
}

type RawMessage = {
  role?: string
  info?: { role?: string; tokens?: Record<string, unknown>; cost?: unknown }
  parts?: Array<{ type?: string; text?: string }>
}

function textOf(messages: RawMessage[]): string {
  const assistant = [...messages].reverse().find((m) => (m.info?.role ?? m.role) === "assistant")
  if (!assistant) return ""
  return (assistant.parts ?? [])
    .filter((p) => p.type === "text" || typeof p.text === "string")
    .map((p) => p.text ?? "")
    .join("\n")
    .trim()
}

function tokensOf(messages: RawMessage[]): Array<Record<string, unknown>> {
  return messages.filter((m) => (m.info?.role ?? m.role) === "assistant" && m.info?.tokens).map((m) => m.info!.tokens!)
}

export function createDispatchEngine(deps: DispatchEngineDeps) {
  const maxConcurrent = deps.maxConcurrent ?? DEFAULT_MAX_CONCURRENT
  const timeoutMs = Math.min(deps.timeoutMs ?? DEFAULT_DISPATCH_TIMEOUT_MS, MAX_DISPATCH_TIMEOUT_MS)
  const pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  const inFlight = new Set<string>()
  let seq = 0

  const api = async (path: string, init?: RequestInit): Promise<unknown> => {
    const res = await deps.fetcher(`${deps.serverUrl}${path}`, {
      ...init,
      headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    })
    const text = await res.text()
    if (!res.ok) throw new DispatchError(`${init?.method ?? "GET"} ${path} -> ${res.status}: ${text.slice(0, 300)}`, "host-error")
    return text ? JSON.parse(text) : undefined
  }

  const fetchMessages = async (sessionID: string): Promise<RawMessage[]> => {
    const list = (await api(`/session/${sessionID}/message`)) as unknown
    return Array.isArray(list) ? (list as RawMessage[]) : []
  }

  // Per-pipeline abort control: kill() flips `fired` and resolves `promise`;
  // the poll loop races its message fetch against the promise so a kill lands
  // even mid-fetch (a bare flag check would never run while an await hangs).
  type KillControl = { fired: boolean; promise: Promise<void>; fire: () => void }
  const killControls = new Map<string, KillControl>()

  const resolveOrThrow = (profile: string, depth: string | undefined, exclude: string[] | undefined): ResolveOk => {
    const r = resolveDispatch(deps.cfg, { profile, depth, exclude }, deps.available, deps.catalog)
    if (!r.ok) {
      deps.sink({ ts: new Date().toISOString(), event: "resolve-error", tier: profile, outcome: r.error.code, note: r.error.message })
      throw new DispatchError(`${r.error.message}\nMenu:\n${r.error.menu.map((m) => `- ${m.identity} expose=[${m.expose.join(", ") || "none"}] ${m.reason}`).join("\n")}\nVocabulary: ${r.error.vocabulary.join(", ") || "(none)"}`, r.error.code)
    }
    return r
  }

  // One pipeline attempt: child session + depth hook + turn + completion poll.
  // Throws DispatchError (timeout / empty-response / host-error / menu codes);
  // the CALLER owns slot accounting, retries, and (for background) registry
  // terminal mapping. The per-dispatch deadline t0 is shared across attempts.
  async function runAttempt(
    r: ResolveOk,
    req: DispatchRequest,
    parentSessionID: string | undefined,
    t0: number,
    ctl: KillControl | undefined,
    onChild: ((sessionID: string) => void) | undefined,
    dispatchId?: string,
  ): Promise<DispatchResult> {
    const providerID = r.identity.slice(0, r.identity.indexOf("/"))
    let childID = ""
    // Child session: parentID is best-effort (dev-branch semantics; 1.18.32
    // rejects some unknown CreateInput fields with 400) — retry plain.
    const dir = encodeURIComponent(deps.workspace)
    let created: unknown
    try {
      created = await api(`/session?directory=${dir}`, { method: "POST", body: JSON.stringify(parentSessionID ? { parentID: parentSessionID } : {}) })
    } catch {
      created = await api(`/session?directory=${dir}`, { method: "POST", body: JSON.stringify({}) })
    }
    childID = (created as { id?: string })?.id ?? ""
    if (!childID) throw new DispatchError("host returned no session id for the child session", "host-error")
    onChild?.(childID)

    deps.onDepth(childID, r.depth, providerID)
    const family = deps.providerFamily(providerID)
    const depthInjected = family === null ? "not injected (unknown provider shape)" : `${family} <- ${r.depth}`

    // The host's message POST is turn-synchronous (verified 1.18.32): it
    // does not return until the child's whole first turn settles, so the
    // per-dispatch deadline must govern this await too — race it, never
    // await it bare. The elapsed re-check keeps fake-clock tests (instant
    // sleep) honest: a raced deadline only declares timeout when the clock
    // actually passed the deadline.
    let deadlineHit = false
    const deadlinePromise = deps
      .sleep(Math.max(timeoutMs - (deps.now() - t0), 0))
      .then(() => {
        deadlineHit = true
      })
    const turnPost = api(`/session/${childID}/message`, {
      method: "POST",
      body: JSON.stringify({
        model: { providerID, modelID: r.identity.slice(r.identity.indexOf("/") + 1) },
        agent: `forge-${req.profile}`,
        parts: [{ type: "text", text: composeWorkerPrompt({ prompt: req.prompt, tier: req.profile, shape: deps.cfg.tiers[req.profile]?.shape ?? "readonly" }) }],
      }),
    })
    await Promise.race([turnPost, deadlinePromise])
    if (deadlineHit && deps.now() - t0 >= timeoutMs) {
      const elapsed = deps.now() - t0
      deps.sink({
        ts: new Date().toISOString(),
        event: "timeout",
        tier: req.profile,
        identity: r.identity,
        depth: r.depth,
        sessionID: childID,
        durationMs: elapsed,
        ...(dispatchId !== undefined ? { dispatchId, parentSessionID: parentSessionID ?? "" } : {}),
      })
      throw new DispatchError(
        `forge_dispatch timed out after ${elapsed}ms (deadline ${timeoutMs}ms). Partial state: child session ${childID} is left for the host to reclaim; its transcript remains queryable via the host API.`,
        "timeout",
      )
    }
    await turnPost

    // Poll for completion (stable-x2) under the per-dispatch deadline. With a
    // kill control, the message fetch races the abort promise so a kill lands
    // even while a fetch is hanging.
    let poll: PollState | null = null
    let messages: RawMessage[] = []
    for (;;) {
      if (ctl?.fired) throw new KillRequested()
      const elapsed = deps.now() - t0
      if (elapsed >= timeoutMs) {
        deps.sink({
          ts: new Date().toISOString(),
          event: "timeout",
          tier: req.profile,
          identity: r.identity,
          depth: r.depth,
          sessionID: childID,
          durationMs: elapsed,
          ...(dispatchId !== undefined ? { dispatchId, parentSessionID: parentSessionID ?? "" } : {}),
        })
        throw new DispatchError(
          `forge_dispatch timed out after ${elapsed}ms (deadline ${timeoutMs}ms). Partial state: child session ${childID} is left for the host to reclaim; its transcript remains queryable via the host API.`,
          "timeout",
        )
      }
      await deps.sleep(pollIntervalMs)
      messages = await (ctl ? Promise.race([fetchMessages(childID), ctl.promise.then(() => [])]) : fetchMessages(childID))
      if (ctl?.fired) throw new KillRequested()
      poll = completionVerdict(poll, { count: messages.length, text: textOf(messages) })
      if (poll.verdict === "complete" || poll.verdict === "empty") break
    }

    const durationMs = deps.now() - t0
    if (poll.verdict === "empty") {
      deps.sink({
        ts: new Date().toISOString(),
        event: "empty-response",
        tier: req.profile,
        identity: r.identity,
        depth: r.depth,
        sessionID: childID,
        durationMs,
        ...(dispatchId !== undefined ? { dispatchId, parentSessionID: parentSessionID ?? "" } : {}),
      })
      throw new DispatchError(
        `child session ${childID} returned an empty response (0-token assistant message). This is a known quirk of keyless endpoints combined with restricted tiers — see the README dispatch notes. The dispatch is NOT counted as success.`,
        "empty-response",
      )
    }

    const tokens = sumTokens(tokensOf(messages))
    const price = priceFor(deps.catalog, r.identity)
    const cost = computeCost(tokens, price?.spec ?? null)
    const result: DispatchResult = {
      tier: req.profile,
      requested: { profile: req.profile, depth: req.depth },
      actual: { model: r.identity, depth: r.depth },
      sessionID: childID,
      durationMs,
      tokens,
      costUsd: cost.costUsd,
      ...(cost.note ? { costNote: cost.note } : {}),
      ...(price?.label ? { priceSnapshot: price.label } : {}),
      text: textOf(messages),
      depthInjected,
    }
    deps.sink({
      ts: new Date().toISOString(),
      event: "completed",
      tier: req.profile,
      identity: r.identity,
      depth: r.depth,
      sessionID: childID,
      outcome: "completed",
      tokens,
      costUsd: cost.costUsd,
      durationMs,
      ...(dispatchId !== undefined ? { dispatchId, parentSessionID: parentSessionID ?? "" } : {}),
    })
    return result
  }

  // Map a background pipeline failure to the registry terminal state + ledger.
  // Never throws: a background dispatch reports through the registry and the
  // completion brief, never by rejecting a long-gone tool call.
  function bgTerminal(
    reg: NonNullable<typeof deps.registry>,
    dispatchId: string,
    identity: string,
    req: DispatchRequest,
    t0: number,
    e: unknown,
  ): void {
    const report = {
      tier: req.profile,
      requested: { profile: req.profile, depth: req.depth },
      actual: { model: identity, depth: null as string | null },
      sessionID: "",
      outcome: "error",
      durationMs: deps.now() - t0,
      error: e instanceof Error ? e.message : String(e),
    }
    if (e instanceof DispatchError && e.code === "timeout") {
      report.outcome = "timeout"
      reg.markTimeout(dispatchId, report)
      deps.onTerminal?.(reg.get(dispatchId).parentSessionID)
      return
    }
    deps.sink({ ts: new Date().toISOString(), event: "error", tier: req.profile, identity, outcome: "error", note: report.error })
    reg.markError(dispatchId, report)
    deps.onTerminal?.(reg.get(dispatchId).parentSessionID)
  }

  async function dispatch(req: DispatchRequest, parentSessionID?: string, opts?: { background?: boolean }): Promise<DispatchResult | DispatchHandle> {
    const t0 = deps.now()

    // Concurrency cap: ONE slot pool shared by sync and background dispatches
    // (spec: over-cap submits are refused identically).
    if (inFlight.size >= maxConcurrent) {
      deps.sink({ ts: new Date().toISOString(), event: "refused-cap", tier: req.profile, note: `${inFlight.size} in flight` })
      throw new DispatchError(
        `forge_dispatch refused: ${inFlight.size} dispatches already in flight (cap ${maxConcurrent}). Wait for a completion and retry.`,
        "cap-refused",
      )
    }

    const bg = opts?.background === true
    if (bg && !deps.registry) throw new DispatchError("background dispatch requires the dispatch registry (internal error)", "host-error")

    // Eager resolution for BOTH paths: menu/pin errors surface synchronously
    // before anything is spawned.
    const first: ResolveOk = resolveOrThrow(req.profile, req.depth, undefined)

    if (bg) {
      const reg = deps.registry!
      const { dispatchId } = reg.submit({ sessionID: "", identity: first.identity, depth: first.depth, tier: req.profile, parentSessionID: parentSessionID ?? "" })
      let fire = () => {}
      const promise = new Promise<void>((res) => {
        fire = res
      })
      const ctl: KillControl = { fired: false, promise, fire: () => { ctl.fired = true; fire() } }
      killControls.set(dispatchId, ctl)
      const slot = `d${++seq}`
      inFlight.add(slot) // the cap pool stays occupied while the pipeline runs
      void (async () => {
        try {
          if (reg.get(dispatchId).state === "killed") return // killed before the pipeline could start
          reg.markRunning(dispatchId)
          let identity = first
          let exclude: string[] | undefined = undefined
          for (let attemptNo = 0; ; attemptNo++) {
            try {
              const result = await runAttempt(identity, req, parentSessionID, t0, ctl, (sid) => {
                try {
                  reg.get(dispatchId).sessionID = sid
                } catch {}
              }, dispatchId)
              if (reg.get(dispatchId).state === "killed") {
                // The kill landed while the result was already in: discard and
                // note it (spec: a result arriving after a kill is noted).
                reg.noteLateCompletion(dispatchId, result)
                deps.sink({ ts: new Date().toISOString(), event: "kill-late-completion", tier: req.profile, identity: identity.identity, sessionID: result.sessionID, outcome: "kill-late-completion" })
              } else {
                reg.markCompleted(dispatchId, result)
                deps.onTerminal?.(reg.get(dispatchId).parentSessionID)
              }
              return
            } catch (e) {
              if (e instanceof KillRequested) return // kill() already ledgered and mapped it
              if (reg.get(dispatchId).state === "killed") return
              const retryable = e instanceof DispatchError && (e.code === "host-error" || e.code === "empty-response")
              const alternative = retryable
                ? resolveDispatch(deps.cfg, { profile: req.profile, depth: req.depth, exclude: [identity.identity] }, deps.available, deps.catalog)
                : { ok: false as const }
              if (!retryable || attemptNo > 0 || !alternative.ok) {
                bgTerminal(reg, dispatchId, identity.identity, req, t0, e)
                return
              }
              deps.sink({ ts: new Date().toISOString(), event: "retry-excluded", tier: req.profile, identity: identity.identity, note: `${identity.identity}: ${(e as DispatchError).code}` })
              exclude = [identity.identity]
              identity = alternative
              reg.get(dispatchId).identity = identity.identity
            }
          }
        } finally {
          inFlight.delete(slot)
          killControls.delete(dispatchId)
        }
      })()
      return {
        dispatchId,
        tier: req.profile,
        requested: { profile: req.profile, depth: req.depth },
        resolved: first.identity,
        depth: first.depth,
        queuedAt: reg.get(dispatchId).queuedAt,
      }
    }

    // Sync path: bounded one-retry loop (spec B11); deadline t0 spans attempts.
    let exclude: string[] | undefined = undefined
    for (let attemptNo = 0; ; attemptNo++) {
      const r: ResolveOk = attemptNo === 0 ? first : resolveOrThrow(req.profile, req.depth, exclude)
      const slot = `d${++seq}`
      inFlight.add(slot)
      try {
        return await runAttempt(r, req, parentSessionID, t0, undefined, undefined)
      } catch (e) {
        const identity = r.identity
        const retryable = e instanceof DispatchError && (e.code === "host-error" || e.code === "empty-response")
        if (!retryable || attemptNo > 0) throw e
        // Retry only when an alternative identity would actually serve; with
        // none, the ORIGINAL honest error stands (its guidance — e.g. the
        // keyless empty-response note — must not be swallowed by a menu).
        const alternative = resolveDispatch(deps.cfg, { profile: req.profile, depth: req.depth, exclude: [identity] }, deps.available, deps.catalog)
        if (!alternative.ok) throw e
        deps.sink({ ts: new Date().toISOString(), event: "retry-excluded", tier: req.profile, identity, note: `${identity}: ${(e as DispatchError).code}` })
        exclude = [identity]
      } finally {
        inFlight.delete(slot)
      }
    }
  }

  return {
    dispatch,
    // Best-effort kill (design D12): mark killed FIRST (so the pipeline's
    // catch sees it), then fire the abort so a hung fetch unwinds. There is
    // no host session-abort API on 1.18.32 — the child may finish naturally
    // and its result is discarded and noted, never delivered.
    kill: (dispatchId: string): void => {
      const reg = deps.registry
      if (!reg) throw new DispatchError("forge_dispatch_kill unavailable: no dispatch registry (internal error)", "kill-failed")
      const e = reg.get(dispatchId)
      if (e.state === "completed" || e.state === "timeout" || e.state === "error") {
        throw new DispatchError(`forge_dispatch_kill refused: dispatch ${dispatchId} already ${e.state}; use forge_dispatch_list for its result.`, "kill-failed")
      }
      if (e.state === "killed") throw new DispatchError(`dispatch ${dispatchId} is already killed.`, "kill-failed")
      reg.markKilled(dispatchId)
      deps.sink({ ts: new Date().toISOString(), event: "killed", tier: e.tier, identity: e.identity, depth: e.depth ?? undefined, sessionID: e.sessionID, outcome: "killed" })
      killControls.get(dispatchId)?.fire()
    },
    inFlightCount: () => inFlight.size,
    inFlightIDs: () => [...inFlight],
    // Host exit honesty: sessions are host memory objects — record whatever is
    // still in flight as lost-on-exit (no orphan processes possible).
    dispose: () => {
      for (const slot of inFlight) {
        deps.sink({ ts: new Date().toISOString(), event: "lost-on-exit", note: `dispatch ${slot} in flight at host exit` })
      }
      inFlight.clear()
    },
  }
}

// Internal abort sentinel: kill() fires the pipeline's abort promise; the
// poll loop unwinds with this instead of an error the caller would see.
class KillRequested extends Error {
  constructor() {
    super("kill requested")
  }
}

// Immediate return value of a background submit (spec: eager resolution,
// nothing awaited — the pipeline continues detached).
export type DispatchHandle = {
  dispatchId: string
  tier: string
  requested: { profile: string; depth?: string | null }
  resolved: string
  depth: string | null
  queuedAt: string
}

export type DispatchEngine = ReturnType<typeof createDispatchEngine>

// Price lookup: USD-per-million spec + a snapshot label for disclosure.
export function priceFor(catalog: CatalogSnapshot, identity: string): { spec: Parameters<typeof computeCost>[1]; label: string } | null {
  const slash = identity.indexOf("/")
  if (slash <= 0) return null
  const model = catalog.providers?.[identity.slice(0, slash)]?.models?.[identity.slice(slash + 1)]
  const cost = model?.cost as Record<string, unknown> | undefined
  if (!cost) return null
  return {
    spec: {
      input: cost.input as number | undefined,
      output: cost.output as number | undefined,
      cacheRead: cost.cache_read as number | undefined,
      cacheWrite: cost.cache_write as number | undefined,
    },
    label: "models.dev snapshot",
  }
}
