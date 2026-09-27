import test from "node:test"
import assert from "node:assert/strict"

// Spec: openspec/changes/add-dispatch-onboarding — MODIFIED "Reasoning-depth
// injection via chat params" + design D4 metalanguage:
//   verbatim-first  a meta word that is natively valid passes as-is
//   no interpolation a meta word with no counterpart errors listing BOTH
//                   vocabularies — never a nearest guess
//   full disclosure the report shows canonical -> native
// Native level names (e.g. XHigh) are an escape hatch: passed through
// verbatim, the provider is the final judge.

import { translateDepth, applyDepthTranslation, META_DEPTHS, BUDGET_TIERS } from "../src/dispatch-depth.ts"

test("3.1 canonical metalanguage is the five-word set", () => {
  assert.deepEqual([...META_DEPTHS], ["none", "low", "medium", "high", "max"])
})

test("3.1 verbatim-first: a meta word the model natively offers passes as-is", () => {
  const t = translateDepth("low", "openai", ["low", "high", "max"])
  assert.equal(t.kind, "verbatim")
  assert.equal(t.word, "low")
  assert.equal(t.disclose, "verbatim")
  const options = {}
  applyDepthTranslation(options, t)
  assert.deepEqual(options, { reasoningEffort: "low" })
})

test("3.1 escape hatch: a native word (XHigh) passes through verbatim", () => {
  const t = translateDepth("XHigh", "openai", ["none", "low", "medium", "XHigh"])
  assert.equal(t.kind, "verbatim")
  assert.equal(t.word, "XHigh")
  const options = {}
  applyDepthTranslation(options, t)
  assert.deepEqual(options, { reasoningEffort: "XHigh" })
})

test("3.1 escape hatch on an unknown ladder still passes through (provider judges)", () => {
  const t = translateDepth("XHigh", "openai", null)
  assert.equal(t.kind, "verbatim")
  assert.match(t.disclose, /unverified/)
})

test("3.1 no interpolation: canonical high on a none/low/medium/XHigh model errors listing both vocabularies", () => {
  const t = translateDepth("high", "openai", ["none", "low", "medium", "XHigh"])
  assert.equal(t.kind, "no-mapping")
  assert.deepEqual(t.nativeVocabulary, ["none", "low", "medium", "XHigh"])
  assert.ok(t.metaAvailable.includes("low"), "meta words the model DOES take are listed")
  assert.ok(!t.metaAvailable.includes("high"), "high is not among them")
})

test("3.1 budget family: meta words get the published tier table, none turns thinking off", () => {
  const t = translateDepth("high", "anthropic", null)
  assert.equal(t.kind, "tiered")
  assert.equal(t.budgetTokens, BUDGET_TIERS.high)
  assert.match(t.disclose, /budget/)
  const options = {}
  applyDepthTranslation(options, t)
  assert.deepEqual(options, { thinking: { type: "enabled", budget_tokens: BUDGET_TIERS.high } })

  const off = translateDepth("none", "anthropic", null)
  assert.equal(off.kind, "off")
  const offOptions = {}
  applyDepthTranslation(offOptions, off)
  assert.deepEqual(offOptions, { thinking: { type: "disabled" } })
})

test("3.1 budget table is the published four-step ladder", () => {
  assert.deepEqual(BUDGET_TIERS, { low: 8192, medium: 16384, high: 24576, max: 32768 })
})

test("3.1 budget family has no native word slot: a non-meta word errors", () => {
  const t = translateDepth("XHigh", "anthropic", null)
  assert.equal(t.kind, "no-mapping")
  assert.ok(t.metaAvailable.length >= 4)
})

test("3.1 toggle family: none -> off, other meta words -> on", () => {
  const on = translateDepth("medium", "zai", null)
  assert.equal(on.kind, "toggle-on")
  const options = {}
  applyDepthTranslation(options, on)
  assert.deepEqual(options, { thinking: { type: "enabled" } })

  const off = translateDepth("none", "zai", null)
  assert.equal(off.kind, "off")
  const offOptions = {}
  applyDepthTranslation(offOptions, off)
  assert.deepEqual(offOptions, { thinking: { type: "disabled" } })
})

test("3.1 unknown provider shape injects nothing and says so (B21)", () => {
  const t = translateDepth("low", "unknown", ["low"])
  assert.equal(t.kind, "not-injected")
  assert.match(t.disclose, /not injected/)
  const options = {}
  applyDepthTranslation(options, t)
  assert.deepEqual(options, {})
})
