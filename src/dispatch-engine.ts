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

  async function dispatch(req: DispatchRequest, parentSessionID?: string): Promise<DispatchResult> {
    const t0 = deps.now()

    // Concurrency cap: one slot pool shared by sync and (later) background
    // dispatches — refusals carry the in-flight count and a retry hint.
    if (inFlight.size >= maxConcurrent) {
      deps.sink({ ts: new Date().toISOString(), event: "refused-cap", tier: req.profile, note: `${inFlight.size} in flight` })
      throw new DispatchError(
        `forge_dispatch refused: ${inFlight.size} dispatches already in flight (cap ${maxConcurrent}). Wait for a completion and retry.`,
        "cap-refused",
      )
    }

    // Spec: one retry per dispatch excluding a failed identity. The loop runs
    // at most twice; the per-dispatch deadline t0 spans both attempts (a retry
    // is a second chance to serve, not a second budget). Only attempt-level
    // failures where the identity did not get to serve are retried —
    // host-error and empty-response; a timeout consumed the child's real
    // serving time and is final.
    let exclude: string[] | undefined = undefined
    for (let attemptNo = 0; ; attemptNo++) {
      const slot = `d${++seq}`
      // Resolution: exact match only; menu errors name every candidate.
      const r = resolveDispatch(deps.cfg, { profile: req.profile, depth: req.depth, exclude }, deps.available, deps.catalog)
      if (!r.ok) {
        deps.sink({ ts: new Date().toISOString(), event: "resolve-error", tier: req.profile, outcome: r.error.code, note: r.error.message })
        throw new DispatchError(`${r.error.message}\nMenu:\n${r.error.menu.map((m) => `- ${m.identity} expose=[${m.expose.join(", ") || "none"}] ${m.reason}`).join("\n")}\nVocabulary: ${r.error.vocabulary.join(", ") || "(none)"}`, r.error.code)
      }
      const providerID = r.identity.slice(0, r.identity.indexOf("/"))
      inFlight.add(slot)
      let childID = ""
      try {
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
          })
          throw new DispatchError(
            `forge_dispatch timed out after ${elapsed}ms (deadline ${timeoutMs}ms). Partial state: child session ${childID} is left for the host to reclaim; its transcript remains queryable via the host API.`,
            "timeout",
          )
        }
        await turnPost

        // Poll for completion (stable-x2) under the per-dispatch deadline.
        let poll: PollState | null = null
        let messages: RawMessage[] = []
        for (;;) {
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
            })
            throw new DispatchError(
              `forge_dispatch timed out after ${elapsed}ms (deadline ${timeoutMs}ms). Partial state: child session ${childID} is left for the host to reclaim; its transcript remains queryable via the host API.`,
              "timeout",
            )
          }
          await deps.sleep(pollIntervalMs)
          messages = await fetchMessages(childID)
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
        })
        return result
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
