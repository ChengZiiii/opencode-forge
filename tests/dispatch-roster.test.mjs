import test from "node:test"
import assert from "node:assert/strict"

// Spec: openspec/changes/add-dispatch-suite/specs/dispatch/spec.md
//   S1  full provider/model identity keys (same name, two providers = two entries)
//   S2  unlisted configured identity gets a generated default entry
//   S16 dead defaultDepth degrades the tier to depth-required
//   S17 expose typo on a catalog-known identity errors fast with the legal ladder

import {
  DEFAULT_TIERS,
  buildDispatchConfig,
} from "../src/dispatch-roster.ts"

const CATALOG = {
  providers: {
    "zai-coding-plan": {
      models: { "glm-5.3": { reasoningOptions: ["low", "high", "max"], cost: { input: 0.6, output: 2.2 } } },
    },
    "opencode-go": {
      models: { "glm-5.3": { reasoningOptions: ["low", "medium"] } },
    },
    anthropic: {
      models: { "claude-haiku-4-5": { reasoningOptions: ["off", "low", "medium", "high"] } },
    },
  },
}

test("default tiers ship with the documented shapes and depths", () => {
  assert.deepEqual(DEFAULT_TIERS.scout, { shape: "readonly", defaultDepth: "low" })
  assert.deepEqual(DEFAULT_TIERS.build, { shape: "write", defaultDepth: "high" })
  assert.deepEqual(DEFAULT_TIERS.review, { shape: "readonly", defaultDepth: "high" })
  assert.deepEqual(DEFAULT_TIERS.quick, { shape: "write", defaultDepth: "off" })
})

test("zero config: every configured identity gets a default entry with the full native ladder", () => {
  const built = buildDispatchConfig({
    configuredIdentities: ["zai-coding-plan/glm-5.3", "anthropic/claude-haiku-4-5"],
    catalog: CATALOG,
  })
  const byId = new Map(built.roster.map((e) => [e.model, e]))
  assert.equal(built.roster.length, 2)
  const glm = byId.get("zai-coding-plan/glm-5.3")
  assert.deepEqual(glm.expose, ["low", "high", "max"]) // full native ladder, verbatim
  assert.equal(glm.verified, true)
  assert.deepEqual(glm.profiles, ["scout", "quick"]) // generated default tiers
  // default tier map present untouched
  assert.equal(built.tiers.build.shape, "write")
})

test("S1: same model name on two providers stays two independent roster entries", () => {
  const built = buildDispatchConfig({
    configuredIdentities: ["zai-coding-plan/glm-5.3", "opencode-go/glm-5.3"],
    catalog: CATALOG,
    userRoster: [
      { model: "zai-coding-plan/glm-5.3", expose: ["low", "max"], profiles: ["build", "review"] },
      { model: "opencode-go/glm-5.3", expose: ["low", "medium"], profiles: ["build"] },
    ],
  })
  assert.equal(built.roster.length, 2)
  const a = built.roster.find((e) => e.model === "zai-coding-plan/glm-5.3")
  const b = built.roster.find((e) => e.model === "opencode-go/glm-5.3")
  assert.deepEqual(a.expose, ["low", "max"])
  assert.deepEqual(b.expose, ["low", "medium"]) // independently curated exposure
  assert.deepEqual(a.profiles, ["build", "review"])
  assert.deepEqual(b.profiles, ["build"])
  // declaration order preserved
  assert.equal(built.roster[0].model, "zai-coding-plan/glm-5.3")
  assert.equal(built.roster[1].model, "opencode-go/glm-5.3")
})

test("S2: an unlisted configured identity is appended as a generated default entry", () => {
  const built = buildDispatchConfig({
    configuredIdentities: ["zai-coding-plan/glm-5.3", "anthropic/claude-haiku-4-5"],
    catalog: CATALOG,
    userRoster: [{ model: "zai-coding-plan/glm-5.3", profiles: ["build"] }],
  })
  const generated = built.roster.find((e) => e.model === "anthropic/claude-haiku-4-5")
  assert.ok(generated, "unlisted identity must still get an entry")
  assert.deepEqual(generated.expose, ["off", "low", "medium", "high"]) // full ladder
  assert.deepEqual(generated.profiles, ["scout", "quick"])
  assert.equal(generated.verified, true)
  // listed entry keeps the user's curation and is not regenerated
  const listed = built.roster.find((e) => e.model === "zai-coding-plan/glm-5.3")
  assert.deepEqual(listed.profiles, ["build"])
})

test("S16: dead defaultDepth degrades the tier to depth-required with a warning", () => {
  const built = buildDispatchConfig({
    configuredIdentities: ["zai-coding-plan/glm-5.3"],
    catalog: CATALOG,
    userRoster: [{ model: "zai-coding-plan/glm-5.3", profiles: ["build", "scout", "review"] }],
  })
  // quick's default "off" has no quick candidate exposing it
  assert.equal(built.tiers.quick.defaultDepth, undefined) // default removed, never replaced
  const finding = built.findings.find((f) => f.code === "dead-default-depth")
  assert.ok(finding, "must warn naming the tier")
  assert.equal(finding.level, "warn")
  assert.match(finding.message, /quick/)
  // a healthy tier keeps its default
  assert.equal(built.tiers.build.defaultDepth, "high")
})

test("S16 positive: quick keeps its default when some quick candidate exposes off", () => {
  const built = buildDispatchConfig({
    configuredIdentities: ["anthropic/claude-haiku-4-5"], // ladder includes off
    catalog: CATALOG,
  })
  assert.equal(built.tiers.quick.defaultDepth, "off")
  // only tiers with no exposing candidate degrade (build/review will here);
  // quick itself must not be flagged
  assert.equal(
    built.findings.some((f) => f.code === "dead-default-depth" && f.message.includes('"quick"')),
    false,
  )
})

test("S17: expose typo on a catalog-known identity errors fast listing the legal ladder", () => {
  const built = buildDispatchConfig({
    configuredIdentities: ["zai-coding-plan/glm-5.3"],
    catalog: CATALOG,
    userRoster: [{ model: "zai-coding-plan/glm-5.3", expose: ["low", "hihg"], profiles: ["build"] }],
  })
  const finding = built.findings.find((f) => f.code === "expose-unknown-level")
  assert.ok(finding, "typo must be caught")
  assert.equal(finding.level, "error")
  assert.match(finding.message, /hihg/)
  assert.match(finding.message, /low, high, max/) // legal values listed
  // fail-closed: the illegal level is stripped from the effective expose so it
  // can never be dispatched; legal levels survive
  const entry = built.roster.find((e) => e.model === "zai-coding-plan/glm-5.3")
  assert.deepEqual(entry.expose, ["low"])
})

test("toggle/budget models have no cataloged named levels: user expose is accepted verbatim with a notice", () => {
  const catalog = {
    providers: { glm: { models: { "glm-4.7": { reasoningOptions: [] } } } }, // toggle-shaped after reduction
  }
  const built = buildDispatchConfig({
    configuredIdentities: ["glm/glm-4.7"],
    catalog,
    userRoster: [{ model: "glm/glm-4.7", expose: ["thinking"], profiles: ["build"] }],
  })
  const finding = built.findings.find((f) => f.code === "unnamed-levels-accepted")
  assert.ok(finding, "no cataloged named levels must be disclosed, not treated as a typo")
  assert.equal(finding.level, "notice")
  const entry = built.roster.find((e) => e.model === "glm/glm-4.7")
  assert.deepEqual(entry.expose, ["thinking"]) // verbatim — the user names toggle levels
  assert.equal(entry.verified, true)
})

test("dead roster key (identity not configured) warns by name", () => {
  const built = buildDispatchConfig({
    configuredIdentities: ["zai-coding-plan/glm-5.3"],
    catalog: CATALOG,
    userRoster: [{ model: "ghost/nope", profiles: ["build"] }],
  })
  const finding = built.findings.find((f) => f.code === "dead-key")
  assert.ok(finding)
  assert.equal(finding.level, "warn")
  assert.match(finding.message, /ghost\/nope/)
})

test("provider unknown to the catalog is accepted verbatim with an unverified notice", () => {
  const built = buildDispatchConfig({
    configuredIdentities: ["selfhost/mymodel"],
    catalog: CATALOG,
    userRoster: [{ model: "selfhost/mymodel", expose: ["deep", "deeper"], profiles: ["build"] }],
  })
  const finding = built.findings.find((f) => f.code === "unverified-identity")
  assert.ok(finding, "unknown provider must be flagged unverified, not rejected")
  assert.equal(finding.level, "notice")
  const entry = built.roster.find((e) => e.model === "selfhost/mymodel")
  assert.deepEqual(entry.expose, ["deep", "deeper"]) // verbatim
  assert.equal(entry.verified, false)
})

test("custom tier without a shape defaults to readonly with a warning", () => {
  const built = buildDispatchConfig({
    configuredIdentities: [],
    catalog: CATALOG,
    userTiers: { deep: { defaultDepth: "low" } },
  })
  assert.equal(built.tiers.deep.shape, "readonly")
  const finding = built.findings.find((f) => f.code === "shape-defaulted")
  assert.ok(finding)
  assert.equal(finding.level, "warn")
})

test("tier ids violating [a-z0-9-] warn", () => {
  const built = buildDispatchConfig({
    configuredIdentities: [],
    catalog: CATALOG,
    userTiers: { "Deep_Work": { shape: "write" } },
  })
  const finding = built.findings.find((f) => f.code === "tier-id-charset")
  assert.ok(finding)
  assert.equal(finding.level, "warn")
  assert.match(finding.message, /Deep_Work/)
})

test("profiles referencing a nonexistent tier warn", () => {
  const built = buildDispatchConfig({
    configuredIdentities: ["zai-coding-plan/glm-5.3"],
    catalog: CATALOG,
    userRoster: [{ model: "zai-coding-plan/glm-5.3", profiles: ["build", "nope"] }],
  })
  const finding = built.findings.find((f) => f.code === "unknown-tier-ref")
  assert.ok(finding)
  assert.equal(finding.level, "warn")
  assert.match(finding.message, /nope/)
})
