// Provider-dimension dispatch gate + circuit breaker
// (harden-dispatch-resilience design D3).
//
// Pure logic, no @opencode-ai imports, clock injectable. The wiring
// (plugin.ts) owns:
//   • feeding — journalTerminalRecord feeds every terminal outcome
//     (release of the concurrency slot + the breaker streak);
//   • enforcement — the dispatch pump checks admission before child
//     creation, and queued dispatches re-check at dequeue time.
//
// Semantics (spec: forge-subagents — "Provider-dimension dispatch gate and
// circuit breaker"):
//   • live counters keyed by provider and by provider/model, with optional
//     per-key concurrency limits (absent key / absent config = unlimited);
//   • a breaker per provider: closed → open at N consecutive FAILED
//     terminals → half-open after cooldownMs (admits exactly ONE probe) →
//     closed on the probe's success / re-opened (cooldown re-armed) on its
//     failure;
//   • every refusal is an honest string naming the mechanism, the counted
//     dimension and its current value, and the recovery condition. Breaker
//     refusals are classified as the PLUGIN'S OWN THROTTLE — never a
//     provider error, never provider-retry-classified.

export type ModelIdentity = { provider: string; model: string }

export type DispatchGateConfig = {
  /** provider → max live children (absent key = unlimited). */
  providerConcurrency: Record<string, number>
  /** "provider/model" → max live children (absent key = unlimited). */
  modelConcurrency: Record<string, number>
  /** Breaker thresholds; consecutiveFailures <= 0 disables the breaker. */
  circuitBreaker: { consecutiveFailures: number; cooldownMs: number }
}

export type GateOutcomeClass = "completed" | "failed" | "neutral"

export type AdmissionResult = { ok: true } | { ok: false; refusal: string }

export type GateClock = { now: () => number }

export function modelKey(identity: ModelIdentity): string {
  return `${identity.provider}/${identity.model}`
}

// ---------------------------------------------------------------------------
// Refusal strings — honest by construction, contract-tested verbatim.
// ---------------------------------------------------------------------------

export function concurrencyRefusal(dimension: "provider" | "provider/model", key: string, live: number, limit: number): string {
  return (
    `[forge:dispatch-gate] Dispatch refused by the ${dimension} concurrency gate: ${live}/${limit} live dispatch children already run on ${dimension} "${key}". ` +
    `Recovery: a live child on that ${dimension} finishing frees a slot — its [forge:dispatch-complete] wake announces it. ` +
    `This is the plugin's own throttle, not a provider error — do not retry the provider.`
  )
}

export function breakerRefusal(provider: string, failures: number, threshold: number, cooldownMs: number, msLeft: number): string {
  return (
    `[forge:dispatch-gate] Dispatch refused by the provider circuit breaker: provider "${provider}" is OPEN after ${failures} consecutive failed dispatch terminals (threshold ${threshold}). ` +
    `Recovery: the breaker half-opens when the ${cooldownMs}ms cooldown elapses (${msLeft}ms left) and admits one probe dispatch; its success closes the breaker, its failure re-opens it. ` +
    `This is the plugin's own throttle, not a provider error — it is never retried as one.`
  )
}

export function breakerHalfOpenRefusal(provider: string): string {
  return (
    `[forge:dispatch-gate] Dispatch refused by the provider circuit breaker: provider "${provider}" is HALF-OPEN and its one probe dispatch is already in flight. ` +
    `Recovery: the probe's terminal outcome closes the breaker (success) or re-opens it (failure). ` +
    `This is the plugin's own throttle, not a provider error — it is never retried as one.`
  )
}

// ---------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------

type BreakerCell = {
  state: "closed" | "open" | "half-open"
  failures: number
  openedAt: number
  probeInFlight: boolean
}

export type DispatchGate = {
  /** Hot-apply the config (live counters + breaker state survive). */
  updateConfig(config: DispatchGateConfig | null | undefined): void
  /** Current effective config (test seam). */
  config(): DispatchGateConfig
  /**
   * Check admission (breaker first, then provider limit, then model limit)
   * and INCREMENT the live counters on success. A refusal changes nothing.
   */
  admit(identity: ModelIdentity): AdmissionResult
  /** Decrement the live counters (never below zero). */
  release(identity: ModelIdentity): void
  /**
   * Terminal feed: releases the concurrency slot and advances the breaker
   * ("completed" closes/resets, "failed" counts/re-opens, "neutral" — user
   * aborts, stale kills — only releases).
   */
  recordTerminal(identity: ModelIdentity, outcome: GateOutcomeClass): void
  /** Test seams. */
  liveCounts(): { provider: Record<string, number>; model: Record<string, number> }
  breakerState(provider: string): { state: "closed" | "open" | "half-open"; failures: number }
}

export function createDispatchGate(config: DispatchGateConfig | null | undefined = null, clock: GateClock = { now: () => Date.now() }): DispatchGate {
  let cfg: DispatchGateConfig = config ?? { providerConcurrency: {}, modelConcurrency: {}, circuitBreaker: { consecutiveFailures: 0, cooldownMs: 0 } }
  const liveProvider = new Map<string, number>()
  const liveModel = new Map<string, number>()
  const breakers = new Map<string, BreakerCell>()

  const breakerFor = (provider: string): BreakerCell => {
    let cell = breakers.get(provider)
    if (!cell) {
      cell = { state: "closed", failures: 0, openedAt: 0, probeInFlight: false }
      breakers.set(provider, cell)
    }
    return cell
  }

  const bump = (map: Map<string, number>, key: string, delta: number): void => {
    const next = Math.max(0, (map.get(key) ?? 0) + delta)
    if (next === 0) map.delete(key)
    else map.set(key, next)
  }

  return {
    updateConfig(next) {
      cfg = next ?? { providerConcurrency: {}, modelConcurrency: {}, circuitBreaker: { consecutiveFailures: 0, cooldownMs: 0 } }
    },
    config() {
      return cfg
    },

    admit(identity) {
      const cell = breakerFor(identity.provider)
      // Breaker first: an OPEN breaker refuses until the cooldown elapses,
      // then transitions HALF-OPEN (one probe). A HALF-OPEN breaker with a
      // probe already in flight refuses everything else on that provider.
      if (cell.state === "open") {
        const elapsed = clock.now() - cell.openedAt
        if (cfg.circuitBreaker.cooldownMs > 0 && cfg.circuitBreaker.consecutiveFailures > 0 && elapsed >= cfg.circuitBreaker.cooldownMs) {
          cell.state = "half-open"
          cell.probeInFlight = false
        } else {
          const msLeft = Math.max(0, cfg.circuitBreaker.cooldownMs - elapsed)
          return { ok: false, refusal: breakerRefusal(identity.provider, cell.failures, cfg.circuitBreaker.consecutiveFailures, cfg.circuitBreaker.cooldownMs, msLeft) }
        }
      }
      if (cell.state === "half-open" && cell.probeInFlight) {
        return { ok: false, refusal: breakerHalfOpenRefusal(identity.provider) }
      }
      // Concurrency gates: provider dimension, then provider/model.
      const pLimit = cfg.providerConcurrency[identity.provider]
      if (typeof pLimit === "number" && pLimit >= 1) {
        const live = liveProvider.get(identity.provider) ?? 0
        if (live >= pLimit) {
          return { ok: false, refusal: concurrencyRefusal("provider", identity.provider, live, pLimit) }
        }
      }
      const mk = modelKey(identity)
      const mLimit = cfg.modelConcurrency[mk]
      if (typeof mLimit === "number" && mLimit >= 1) {
        const live = liveModel.get(mk) ?? 0
        if (live >= mLimit) {
          return { ok: false, refusal: concurrencyRefusal("provider/model", mk, live, mLimit) }
        }
      }
      // Admitted: take the slot(s) and, when half-open, claim the probe.
      bump(liveProvider, identity.provider, 1)
      bump(liveModel, mk, 1)
      if (cell.state === "half-open") cell.probeInFlight = true
      return { ok: true }
    },

    release(identity) {
      bump(liveProvider, identity.provider, -1)
      bump(liveModel, modelKey(identity), -1)
    },

    recordTerminal(identity, outcome) {
      this.release(identity)
      const cell = breakerFor(identity.provider)
      if (cell.state === "half-open") {
        cell.probeInFlight = false
        if (outcome === "completed") {
          // Probe succeeded: breaker closes, streak resets.
          cell.state = "closed"
          cell.failures = 0
        } else if (outcome === "failed") {
          // Probe failed: re-open with the cooldown re-armed and the
          // streak carried (the probe failure is a failed terminal too).
          cell.failures++
          cell.state = "open"
          cell.openedAt = clock.now()
        }
        return
      }
      if (cell.state === "closed") {
        if (outcome === "completed") {
          cell.failures = 0
        } else if (outcome === "failed") {
          cell.failures++
          const threshold = cfg.circuitBreaker.consecutiveFailures
          if (threshold > 0 && cell.failures >= threshold) {
            cell.state = "open"
            cell.openedAt = clock.now()
          }
        }
      }
      // OPEN + terminal of a non-probe child (admitted before the breaker
      // opened): the streak is already at/over threshold; nothing to do.
    },

    liveCounts() {
      return { provider: Object.fromEntries(liveProvider), model: Object.fromEntries(liveModel) }
    },
    breakerState(provider) {
      const cell = breakerFor(provider)
      return { state: cell.state, failures: cell.failures }
    },
  }
}
