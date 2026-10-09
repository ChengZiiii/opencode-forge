import test from "node:test"
import assert from "node:assert/strict"

// Spec: openspec/changes/catalog-driven-depth-shapes — MODIFIED "Pinned
// thoughtLevel injection keyed by agent name". Axiom: the dictionary is a
// translation dictionary, never a whitelist.
//   word channels   ladder match is case-insensitive and emits the LADDER's
//                   native casing; unmatched words pass through VERBATIM
//                   (unverified — the provider is the final judge)
//   budget          dictionary words map to the published tier table; words
//                   without a tier are a dead end (finding)
//   toggle          none -> off; any level word is a dead end (finding) —
//                   collapsing xhigh to "on" would decide for the user
// No interpolation anywhere: pass as-is or refuse with a finding.

import { translateDepth, applyDepthTranslation, resolvePinnedDepth, META_DEPTHS, BUDGET_TIERS } from "../src/dispatch-depth.ts"

test("dictionary is the seven-word community set (none..max)", () => {
  assert.deepEqual([...META_DEPTHS], ["none", "minimal", "low", "medium", "high", "xhigh", "max"])
})

test("effort channel: ladder match is case-insensitive and emits the ladder's native casing", () => {
  const t = translateDepth("low", { kind: "effort", ladder: ["low", "high", "max"] })
  assert.equal(t.kind, "verbatim")
  assert.equal(t.confirmed, true)
  assert.equal(t.word, "low")

  const mixed = translateDepth("xhigh", { kind: "effort", ladder: ["none", "low", "medium", "XHigh"] })
  assert.equal(mixed.kind, "verbatim")
  assert.equal(mixed.confirmed, true)
  assert.equal(mixed.word, "XHigh", "the catalog vouches for wire casing; the user writes lowercase")
  assert.match(mixed.disclose, /catalog-confirmed/)

  const options = {}
  applyDepthTranslation(options, mixed)
  assert.deepEqual(options, { reasoningEffort: "XHigh" })
})

test("effort channel: unmatched words (dictionary or not) pass through unverified — provider judges", () => {
  const dictionaryWord = translateDepth("high", { kind: "effort", ladder: ["none", "low", "medium", "XHigh"] })
  assert.equal(dictionaryWord.kind, "verbatim")
  assert.equal(dictionaryWord.confirmed, false)
  assert.equal(dictionaryWord.word, "high")
  assert.match(dictionaryWord.disclose, /unverified/)
  assert.match(dictionaryWord.disclose, /provider judges/)

  const novel = translateDepth("ultra", { kind: "effort", ladder: null })
  assert.equal(novel.kind, "verbatim")
  assert.equal(novel.confirmed, false)
  assert.equal(novel.word, "ultra")
  assert.match(novel.disclose, /no catalog ladder/)

  const input = translateDepth("  High ", { kind: "effort", ladder: ["high"] })
  assert.equal(input.word, "high", "input is defensively normalized (config boundary already did)")
})

test("adaptive-effort channel: the word rides the EMPIRICALLY VERIFIED effort key", () => {
  const t = translateDepth("xhigh", { kind: "adaptive-effort" })
  assert.equal(t.kind, "verbatim")
  assert.equal(t.channel, "adaptive-effort")
  assert.equal(t.confirmed, false)
  assert.equal(t.word, "xhigh")
  const options = {}
  applyDepthTranslation(options, t)
  // options.effort is the key the patched host maps to the adaptive-era
  // native wire shape output_config:{effort}; reasoningEffort is silently
  // dropped by the anthropic transport (verify/adaptive-key.md).
  assert.deepEqual(options, { effort: "xhigh" })
})

test("effort channel keeps the reasoningEffort key (host-verified for OpenAI-compatible transports)", () => {
  const t = translateDepth("ultra", { kind: "effort", ladder: null })
  const options = {}
  applyDepthTranslation(options, t)
  assert.deepEqual(options, { reasoningEffort: "ultra" })
})

test("budget channel: dictionary words get the published tiers incl. the new slots; none turns thinking off", () => {
  const t = translateDepth("high", { kind: "budget" })
  assert.equal(t.kind, "tiered")
  assert.equal(t.budgetTokens, BUDGET_TIERS.high)
  const options = {}
  applyDepthTranslation(options, t)
  assert.deepEqual(options, { thinking: { type: "enabled", budget_tokens: BUDGET_TIERS.high } })

  const off = translateDepth("none", { kind: "budget" })
  assert.equal(off.kind, "off")
  const offOptions = {}
  applyDepthTranslation(offOptions, off)
  assert.deepEqual(offOptions, { thinking: { type: "disabled" } })
})

test("budget table carries the minimal floor and the xhigh half-step", () => {
  assert.deepEqual(BUDGET_TIERS, { minimal: 1024, low: 8192, medium: 16384, high: 24576, xhigh: 28672, max: 32768 })
  assert.equal(translateDepth("minimal", { kind: "budget" }).budgetTokens, 1024, "the 1024 Anthropic API minimum")
  assert.equal(translateDepth("xhigh", { kind: "budget" }).budgetTokens, 28672)
})

test("budget channel dead end: a non-dictionary word is refused with a finding naming both sides", () => {
  const t = translateDepth("ultra", { kind: "budget" })
  assert.equal(t.kind, "no-mapping")
  assert.ok(t.dictionary.includes("xhigh"))
  assert.match(t.message, /budget/)
})

test("toggle channel: none -> off; level words are dead ends (never collapsed to on)", () => {
  const off = translateDepth("none", { kind: "toggle" })
  assert.equal(off.kind, "off")
  const offOptions = {}
  applyDepthTranslation(offOptions, off)
  assert.deepEqual(offOptions, { thinking: { type: "disabled" } })

  for (const word of ["high", "xhigh", "ultra"]) {
    const t = translateDepth(word, { kind: "toggle" })
    assert.equal(t.kind, "no-mapping", `${word} on a toggle-only endpoint is a dead end`)
    assert.match(t.message, new RegExp(word))
  }
  assert.equal(translateDepth("high", { kind: "toggle" }).channel, "toggle")
})

test("no-mapping writes nothing to options", () => {
  const options = {}
  applyDepthTranslation(options, translateDepth("ultra", { kind: "budget" }))
  applyDepthTranslation(options, translateDepth("high", { kind: "toggle" }))
  assert.deepEqual(options, {})
})

test("resolvePinnedDepth: dead ends yield a finding naming both vocabularies; word channels never do", () => {
  const dead = resolvePinnedDepth("medium", { kind: "toggle" })
  assert.equal(dead.translation, null)
  assert.match(dead.findingMessage ?? "", /medium/)
  assert.match(dead.findingMessage ?? "", /toggle/)

  const confirmed = resolvePinnedDepth("high", { kind: "effort", ladder: ["low", "high", "max"] })
  assert.equal(confirmed.translation?.kind, "verbatim")
  assert.equal(confirmed.findingMessage, undefined)

  const unverified = resolvePinnedDepth("custom-word", { kind: "effort", ladder: null })
  assert.equal(unverified.translation?.kind, "verbatim", "unknown endpoints are pass-through territory (provider judges)")
  assert.equal(unverified.findingMessage, undefined)
})
