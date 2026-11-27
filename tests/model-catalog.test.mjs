import test from "node:test"
import assert from "node:assert/strict"

// forge-tui-subagent-config — contract tests for the host model catalog
// adapter (design D3; landed src/model-catalog.ts). Spec: catalog-driven
// selection with unknown/unverified disclosure, never silent remapping.

import { normalizeCatalog, catalogLookup, levelSupportFor, isVariantDepthWord } from "../src/model-catalog.ts"

// /api/model shape: rows with providerID/modelID and variants as an array
// of {id, ...} objects.
const API_ROWS = [
  { providerID: "anthropic", modelID: "claude-opus-4-6", name: "Opus 4.6", status: "active", variants: [{ id: "low" }, { id: "high" }] },
  { providerID: "openai", modelID: "gpt-5.2", name: "GPT-5.2", status: "active", variants: ["low", "medium", "high"] },
]

test("normalizeCatalog: array rows with object variants fold to searchable identities", () => {
  const { models, findings } = normalizeCatalog(API_ROWS)
  assert.equal(models.length, 2)
  // `enabled` is a preserved wire field: present verbatim when the row
  // carries it, explicit null when absent (the disabled-row test below
  // pins enabled:false survival).
  assert.deepEqual(models[0], { providerID: "anthropic", modelID: "claude-opus-4-6", label: "Opus 4.6", variants: ["low", "high"], status: "active", enabled: null, availability: "unverified" })
  assert.deepEqual(models[1].variants, ["low", "medium", "high"], "string variant entries fold too")
  assert.equal(findings.length, 0)
})

test("normalizeCatalog: TUI-side object-keyed variants map accepted (wire casing preserved)", () => {
  const { models } = normalizeCatalog([{ providerID: "p", modelID: "m", variants: { Max: {}, Low: {} } }])
  assert.deepEqual(models[0].variants, ["Max", "Low"])
})

test("normalizeCatalog: every identity carries availability unverified (catalog presence never proves credentials)", () => {
  const { models } = normalizeCatalog(API_ROWS)
  assert.ok(models.every((m) => m.availability === "unverified"))
})

test("normalizeCatalog: non-array catalog is UNKNOWN, never an authoritative empty list", () => {
  for (const bad of [null, undefined, {}, "x", 42]) {
    const { models, findings } = normalizeCatalog(bad)
    assert.deepEqual(models, [])
    assert.ok(findings.length > 0, `${JSON.stringify(bad)} must produce a disclosure finding`)
    assert.match(findings[0], /catalog unavailable/)
  }
})

test("normalizeCatalog: malformed rows are skipped with findings, usable siblings survive", () => {
  const { models, findings } = normalizeCatalog([null, 7, { providerID: "p" }, { modelID: "m" }, { provider: "q", id: "n" }, { providerID: "p2", modelID: "m2" }])
  assert.deepEqual(models.map((m) => `${m.providerID}/${m.modelID}`), ["q/n", "p2/m2"], "provider/id fallback keys normalize; identity-less rows skip")
  assert.ok(findings.length >= 3)
})

test("normalizeCatalog: duplicate identities dedupe (first wins)", () => {
  const { models } = normalizeCatalog([{ providerID: "p", modelID: "m", name: "first" }, { providerID: "p", modelID: "m", name: "second" }])
  assert.equal(models.length, 1)
  assert.equal(models[0].label, "first")
})

test("normalizeCatalog: zero usable rows discloses unknown rather than pretending empty", () => {
  const { models, findings } = normalizeCatalog([1, 2])
  assert.deepEqual(models, [])
  assert.ok(findings.some((f) => /no usable model rows/.test(f)))
})

test("catalogLookup: exact case-sensitive identity match", () => {
  const lookup = catalogLookup(normalizeCatalog(API_ROWS).models)
  assert.equal(lookup("anthropic", "claude-opus-4-6")?.label, "Opus 4.6")
  assert.equal(lookup("Anthropic", "claude-opus-4-6"), undefined, "lookup is case-sensitive")
  assert.equal(lookup("anthropic", "nope"), undefined)
})

test("levelSupportFor: a supported word returns the catalog's wire casing variant", () => {
  const lookup = catalogLookup(normalizeCatalog(API_ROWS).models)
  const verdict = levelSupportFor(lookup("anthropic", "claude-opus-4-6"), "high")
  assert.deepEqual(verdict, { supported: true, variant: "high" })
})

test("levelSupportFor: case-insensitive word match still returns the catalog casing", () => {
  const { models } = normalizeCatalog([{ providerID: "p", modelID: "m", variants: { High: {} } }])
  const verdict = levelSupportFor(models[0], "HIGH")
  assert.ok(verdict.supported)
  assert.equal(verdict.variant, "High", "the catalog decides wire casing")
})

test("levelSupportFor: unknown model is disclosed unverified, never remapped or rejected as forbidden", () => {
  const verdict = levelSupportFor(undefined, "medium")
  assert.equal(verdict.supported, false)
  assert.equal(verdict.unverified, true)
  assert.match(verdict.note, /absent from the observed catalog/)
})

test("levelSupportFor: absent variant metadata is unknown, not an empty authoritative list", () => {
  const { models } = normalizeCatalog([{ providerID: "p", modelID: "m" }])
  const verdict = levelSupportFor(models[0], "low")
  assert.equal(verdict.supported, false)
  assert.equal(verdict.unverified, true)
  assert.match(verdict.note, /no variant metadata/)
})

test("levelSupportFor: word outside the observed set is unverified but usable (Forge depth semantics)", () => {
  const verdict = levelSupportFor(normalizeCatalog(API_ROWS).models[0], "ultra")
  assert.equal(verdict.supported, false)
  assert.equal(verdict.unverified, true)
  assert.match(verdict.note, /not among the observed variants/)
})

test("isVariantDepthWord: exactly the compiler depth words", () => {
  assert.deepEqual(["low", "medium", "high"].filter(isVariantDepthWord), ["low", "medium", "high"])
  assert.equal(isVariantDepthWord("max"), false)
  assert.equal(isVariantDepthWord("ultra"), false)
})

test("normalizeCatalog: a disabled row (enabled:false) is PRESERVED, not dropped", () => {
  const { models } = normalizeCatalog([{ providerID: "p", modelID: "m", enabled: false, status: "inactive" }])
  assert.equal(models.length, 1, "a disabled catalog row is still a known identity — it must survive normalization with its status")
  assert.equal(models[0].status, "inactive")
  assert.equal(models[0].availability, "unverified")
})
