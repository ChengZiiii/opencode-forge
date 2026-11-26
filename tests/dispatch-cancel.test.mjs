import test from "node:test"
import assert from "node:assert/strict"
import { setTimeout as sleep } from "node:timers/promises"

import { gate, resolveGateAskWatchdogMs } from "../plugin.ts"

// ① Gated-ask watchdog

test("watchdog resolver: default 300s; env-tunable; 0 disables; invalid falls back; 1h clamp", () => {
  assert.equal(resolveGateAskWatchdogMs({}), 300_000)
  assert.equal(resolveGateAskWatchdogMs({ FORGE_GATE_ASK_WATCHDOG_MS: "250" }), 250)
  assert.equal(resolveGateAskWatchdogMs({ FORGE_GATE_ASK_WATCHDOG_MS: "0" }), 0)
  assert.equal(resolveGateAskWatchdogMs({ FORGE_GATE_ASK_WATCHDOG_MS: "nope" }), 300_000)
  assert.equal(resolveGateAskWatchdogMs({ FORGE_GATE_ASK_WATCHDOG_MS: "-5" }), 300_000)
  assert.equal(resolveGateAskWatchdogMs({ FORGE_GATE_ASK_WATCHDOG_MS: "99999999" }), 3_600_000)
})

test("watchdog: a never-answered gate resolves as a disclosed fail-closed rejection", async () => {
  process.env.FORGE_GATE_ASK_WATCHDOG_MS = "120"
  const start = Date.now()
  await assert.rejects(
    gate(
      () => new Promise(() => {}), // no adjudication, ever (the TUI wedge)
      "goal_write",
      "Arm goal: wedge-leg",
    ),
    (e) => {
      const msg = String(e?.message ?? e)
      assert.match(msg, /gate-watchdog/, "the finding names the watchdog")
      assert.match(msg, /goal_write/, "the finding names the gate")
      assert.match(msg, /REFUSED|fail-closed/, "the finding states the fail-closed refusal")
      assert.match(msg, /state is unchanged|nothing was approved/, "the finding promises state safety")
      assert.match(msg, /re-run/, "the finding carries the retry contract")
      return true
    },
  )
  const waited = Date.now() - start
  assert.ok(waited >= 100, `the rejection waited for the window (waited ${waited}ms)`)
  assert.ok(waited < 5000, "the watchdog fired inside the configured window (not the 300s default)")
})

test("watchdog: a decision inside the window wins and no rejection fires", async () => {
  process.env.FORGE_GATE_ASK_WATCHDOG_MS = "5000"
  await gate(
    () => sleep(10).then(() => "approved"),
    "plan_approve",
    "Approve plan: fast-leg",
  )
})

test("watchdog: 0 disables — the gate waits indefinitely for adjudication", async () => {
  process.env.FORGE_GATE_ASK_WATCHDOG_MS = "0"
  let resolveAsk
  const deferred = new Promise((resolve) => {
    resolveAsk = resolve
  })
  const pending = gate(() => deferred, "crew_close", "Close crew: disabled-leg")
  let settled = false
  pending.then(
    () => {
      settled = true
    },
    () => {
      settled = true
    },
  )
  await sleep(220)
  assert.equal(settled, false, "with the watchdog disabled the gate is still waiting past any plausible window")
  resolveAsk("user said yes")
  await pending // resolves with the user's decision, no rejection
})

test("watchdog: a late client reply after a rejection is harmless", async () => {
  process.env.FORGE_GATE_ASK_WATCHDOG_MS = "80"
  let resolveAsk
  const deferred = new Promise((resolve) => {
    resolveAsk = resolve
  })
  const refused = gate(() => deferred, "goal_complete", "Complete goal: late-leg")
  await assert.rejects(refused, /gate-watchdog/)
  // The stale dialog's late reply lands after the refusal — it must not
  // throw unhandled or mutate anything (the refused call stays refused).
  resolveAsk("too late")
  await sleep(50)
})
