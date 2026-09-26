import test from "node:test"
import assert from "node:assert/strict"

// Spec: openspec/changes/add-dispatch-suite/specs/dispatch/spec.md
//   S7  timeout reports partial state (completion detection feeds the deadline path)
//   S14 tokens come from host message info, cost self-computed from the snapshot
//   S15 unpriced identity => costUsd null with a note, never 0
//   B27 known keyless-Zen quirk: an empty response must be detected as "empty",
//       never reported as a successful completion

import {
  completionVerdict,
  sumTokens,
  computeCost,
} from "../src/dispatch-client.ts"

test("completion: stable message count + text for two consecutive polls completes", () => {
  let s = completionVerdict(null, { count: 1, text: "working…" })
  assert.equal(s.verdict, "waiting")
  s = completionVerdict(s, { count: 1, text: "working…" })
  assert.equal(s.verdict, "waiting")
  s = completionVerdict(s, { count: 1, text: "working…" })
  assert.equal(s.verdict, "complete")
})

test("completion: a growing session resets stability", () => {
  let s = completionVerdict(null, { count: 1, text: "a" })
  s = completionVerdict(s, { count: 1, text: "a" })
  s = completionVerdict(s, { count: 2, text: "ab" }) // new message -> reset
  assert.equal(s.verdict, "waiting")
  assert.equal(s.stablePolls, 0)
})

test("completion: no messages yet is never complete", () => {
  let s = completionVerdict(null, { count: 0, text: "" })
  s = completionVerdict(s, { count: 0, text: "" })
  s = completionVerdict(s, { count: 0, text: "" })
  assert.equal(s.verdict, "waiting")
})

test("B27: count grows but text stays empty => verdict empty (never a silent success)", () => {
  let s = completionVerdict(null, { count: 1, text: "" })
  s = completionVerdict(s, { count: 1, text: "" })
  s = completionVerdict(s, { count: 1, text: "" })
  assert.equal(s.verdict, "empty")
  // and a textful session at the same shape completes normally
  let t = completionVerdict(null, { count: 1, text: "done" })
  t = completionVerdict(t, { count: 1, text: "done" })
  t = completionVerdict(t, { count: 1, text: "done" })
  assert.equal(t.verdict, "complete")
})

test("sumTokens totals every assistant message info", () => {
  const total = sumTokens([
    { input: 10, output: 5, reasoning: 3, cache: { read: 2, write: 1 } },
    { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
  ])
  assert.deepEqual(total, { input: 11, output: 6, reasoning: 3, cache: { read: 2, write: 1 } })
})

test("computeCost: snapshot pricing, reasoning billed as output", () => {
  const { costUsd, note } = computeCost(
    { input: 1_000_000, output: 500_000, reasoning: 500_000, cache: { read: 1_000_000, write: 0 } },
    { input: 1, output: 3, cacheRead: 0.1, cacheWrite: 0.2 },
  )
  // input 1e6 * $1/M = 1 ; (output+reasoning) 1e6 * $3/M = 3 ; cacheRead 1e6 * $0.1/M = 0.1
  assert.equal(costUsd, 4.1)
  assert.equal(note, undefined)
})

test("S15: unpriced identity => costUsd null with a price-unavailable note, never 0", () => {
  const r = computeCost({ input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } }, null)
  assert.equal(r.costUsd, null)
  assert.match(r.note, /price unavailable/i)
})

test("computeCost: essential input/output price missing => null", () => {
  const r = computeCost({ input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } }, { output: 3 })
  assert.equal(r.costUsd, null)
  assert.match(r.note, /price unavailable/i)
})

test("computeCost: cache tokens present but cache price missing => null (honest, not approximate)", () => {
  const r = computeCost(
    { input: 1_000_000, output: 1_000_000, reasoning: 0, cache: { read: 500_000, write: 0 } },
    { input: 1, output: 2 },
  )
  assert.equal(r.costUsd, null)
  assert.match(r.note, /cache/i)
})

test("computeCost: zero cache tokens need no cache price", () => {
  const r = computeCost(
    { input: 1_000_000, output: 1_000_000, reasoning: 0, cache: { read: 0, write: 0 } },
    { input: 1, output: 2 },
  )
  assert.equal(r.costUsd, 3)
})
