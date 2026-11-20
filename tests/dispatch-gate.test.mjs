import test from "node:test"
import assert from "node:assert/strict"

// harden-dispatch-resilience D3 — dispatch-gate core (pure logic, injectable
// clock): live-counter bounds (provider + provider/model dimensions), the
// breaker state machine (closed → open at N consecutive failed terminals →
// half-open after cooldownMs → closed on success / re-open on failure with
// the cooldown re-armed), half-open one-probe semantics, hot-apply config
// swaps that preserve live state, and the VERBATIM refusal strings (each
// names the mechanism, the counted dimension + current value, and the
// recovery condition; breaker refusals classify as the plugin's own
// throttle, never a provider error).

import { breakerHalfOpenRefusal, breakerRefusal, concurrencyRefusal, createDispatchGate } from "../src/dispatch-gate.ts"

function fakeClock(start = 0) {
  let t = start
  return { clock: { now: () => t }, advance: (ms) => (t += ms) }
}

const zai = { provider: "zai", model: "glm" }
const zai2 = { provider: "zai", model: "glm-2" }
const ant = { provider: "anthropic", model: "claude" }

const cfg = (over = {}) => ({
  providerConcurrency: {},
  modelConcurrency: {},
  circuitBreaker: { consecutiveFailures: 0, cooldownMs: 0 },
  ...over,
})

test("unconfigured gate admits without limits (absent node = today's behavior)", () => {
  const gate = createDispatchGate(null)
  for (let i = 0; i < 5; i++) assert.equal(gate.admit(zai).ok, true)
  assert.equal(gate.admit(ant).ok, true)
  assert.deepEqual(gate.liveCounts().provider, { zai: 5, anthropic: 1 }, "counters count, limits never bind")
})

test("provider concurrency: boundary refusal is VERBATIM; release re-admits", () => {
  const gate = createDispatchGate(cfg({ providerConcurrency: { zai: 2 } }))
  assert.equal(gate.admit(zai).ok, true)
  assert.equal(gate.admit(zai2).ok, true)
  const third = gate.admit(zai)
  assert.equal(third.ok, false)
  assert.equal(third.refusal, concurrencyRefusal("provider", "zai", 2, 2))
  assert.match(third.refusal, /a live child on that provider finishing frees a slot/)
  assert.match(third.refusal, /plugin's own throttle, not a provider error/)
  // Other providers unaffected.
  assert.equal(gate.admit(ant).ok, true)
  // A terminal releases the slot; the next dispatch is admitted.
  gate.recordTerminal(zai2, "completed")
  assert.deepEqual(gate.liveCounts().provider, { zai: 1, anthropic: 1 })
  assert.equal(gate.admit(zai).ok, true)
})

test("model concurrency: the provider/model dimension refuses verbatim", () => {
  const gate = createDispatchGate(cfg({ modelConcurrency: { "zai/glm": 1 } }))
  assert.equal(gate.admit(zai).ok, true)
  const second = gate.admit(zai)
  assert.equal(second.ok, false)
  assert.equal(second.refusal, concurrencyRefusal("provider/model", "zai/glm", 1, 1))
  // A different model on the same provider is a different dimension.
  assert.equal(gate.admit(zai2).ok, true)
})

test("breaker: closed → open at N consecutive failed terminals; refusal verbatim; cooldown gate", () => {
  const { clock, advance } = fakeClock()
  const gate = createDispatchGate(cfg({ circuitBreaker: { consecutiveFailures: 3, cooldownMs: 1000 } }), clock)
  for (let i = 1; i <= 3; i++) {
    assert.equal(gate.admit(zai).ok, true)
    gate.recordTerminal(zai, "failed")
    assert.deepEqual(gate.breakerState("zai"), { state: i < 3 ? "closed" : "open", failures: i })
  }
  const refused = gate.admit(zai)
  assert.equal(refused.ok, false)
  assert.equal(refused.refusal, breakerRefusal("zai", 3, 3, 1000, 1000))
  assert.match(refused.refusal, /half-opens when the 1000ms cooldown elapses/)
  assert.match(refused.refusal, /plugin's own throttle, not a provider error — it is never retried as one/)
  // Partially through the cooldown: still open, msLeft shrinks verbatim.
  advance(999)
  const refused2 = gate.admit(zai)
  assert.equal(refused2.ok, false)
  assert.equal(refused2.refusal, breakerRefusal("zai", 3, 3, 1000, 1))
  // Open provider does not block other providers.
  assert.equal(gate.admit(ant).ok, true)
})

test("breaker: half-open admits exactly ONE probe; failure re-opens with the cooldown re-armed; success closes", () => {
  const { clock, advance } = fakeClock()
  const gate = createDispatchGate(cfg({ circuitBreaker: { consecutiveFailures: 1, cooldownMs: 1000 } }), clock)
  gate.admit(zai)
  gate.recordTerminal(zai, "failed") // threshold 1 → open at t=0
  advance(1000) // cooldown elapsed → next admit half-opens
  assert.equal(gate.admit(zai).ok, true, "the probe dispatch is admitted")
  assert.deepEqual(gate.breakerState("zai"), { state: "half-open", failures: 1 })
  const second = gate.admit(zai)
  assert.equal(second.ok, false)
  assert.equal(second.refusal, breakerHalfOpenRefusal("zai"), "only one probe in flight — verbatim")
  // Probe FAILED: re-open, cooldown re-armed from NOW (t=1000).
  gate.recordTerminal(zai, "failed")
  assert.deepEqual(gate.breakerState("zai"), { state: "open", failures: 2 })
  advance(999)
  assert.equal(gate.admit(zai).ok, false, "re-armed cooldown still holds at 999ms")
  advance(1)
  assert.equal(gate.admit(zai).ok, true, "half-open again after the re-armed cooldown")
  // Probe SUCCEEDED: breaker closes, streak resets.
  gate.recordTerminal(zai, "completed")
  assert.deepEqual(gate.breakerState("zai"), { state: "closed", failures: 0 })
  assert.equal(gate.admit(zai).ok, true)
  assert.equal(gate.admit(zai).ok, true)
})

test("breaker: neutral outcomes (user aborts, stale kills) never feed the streak; success resets it", () => {
  const gate = createDispatchGate(cfg({ circuitBreaker: { consecutiveFailures: 3, cooldownMs: 1000 } }))
  gate.admit(zai)
  gate.recordTerminal(zai, "failed") // 1
  gate.admit(zai)
  gate.recordTerminal(zai, "neutral") // aborts don't count
  gate.admit(zai)
  gate.recordTerminal(zai, "failed") // 2
  assert.deepEqual(gate.breakerState("zai"), { state: "closed", failures: 2 })
  gate.admit(zai)
  gate.recordTerminal(zai, "completed") // reset
  assert.deepEqual(gate.breakerState("zai"), { state: "closed", failures: 0 })
})

test("breaker disabled unless consecutiveFailures is configured: failures accumulate, never opens", () => {
  const gate = createDispatchGate(cfg({ circuitBreaker: { consecutiveFailures: 0, cooldownMs: 5000 } }))
  for (let i = 0; i < 5; i++) {
    assert.equal(gate.admit(zai).ok, true)
    gate.recordTerminal(zai, "failed")
    assert.equal(gate.breakerState("zai").state, "closed")
  }
  assert.equal(gate.admit(zai).ok, true)
})

test("release clamps at zero (a terminal for a never-admitted dispatch cannot go negative)", () => {
  const gate = createDispatchGate(cfg({ providerConcurrency: { zai: 1 } }))
  gate.release(zai)
  gate.release(zai)
  assert.deepEqual(gate.liveCounts().provider, {})
  assert.equal(gate.admit(zai).ok, true)
})

test("hot-apply (updateConfig) swaps the limits while live counters and breaker state survive", () => {
  const gate = createDispatchGate(cfg({ providerConcurrency: { zai: 5 } }))
  assert.equal(gate.admit(zai).ok, true)
  assert.equal(gate.admit(zai2).ok, true)
  gate.updateConfig(cfg({ providerConcurrency: { zai: 1 } }))
  const third = gate.admit(zai)
  assert.equal(third.ok, false)
  assert.equal(third.refusal, concurrencyRefusal("provider", "zai", 2, 1), "live=2 survives the config swap")
})

test("modelKey + verbatim string contracts hold their exact shape", () => {
  assert.equal(
    concurrencyRefusal("provider", "zai", 2, 2),
    `[forge:dispatch-gate] Dispatch refused by the provider concurrency gate: 2/2 live dispatch children already run on provider "zai". Recovery: a live child on that provider finishing frees a slot — its [forge:dispatch-complete] wake announces it. This is the plugin's own throttle, not a provider error — do not retry the provider.`,
  )
  assert.equal(
    breakerRefusal("zai", 3, 3, 1000, 1),
    `[forge:dispatch-gate] Dispatch refused by the provider circuit breaker: provider "zai" is OPEN after 3 consecutive failed dispatch terminals (threshold 3). Recovery: the breaker half-opens when the 1000ms cooldown elapses (1ms left) and admits one probe dispatch; its success closes the breaker, its failure re-opens it. This is the plugin's own throttle, not a provider error — it is never retried as one.`,
  )
})
