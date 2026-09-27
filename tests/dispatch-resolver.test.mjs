import test from "node:test"
import assert from "node:assert/strict"

// Spec: openspec/changes/add-dispatch-suite/specs/dispatch/spec.md
//   S3  requested depth nobody exposes => structured error with the full menu
//   S4  pinned model unavailable => error naming the pin, never a fallback
//   S5  one retry after mid-dispatch failure => exclude semantics
//   S1  same-name model on two providers resolves as independent candidates
//   B12 exact match, no clamping: {low,max} + "medium" is an error, not "high"

import { buildDispatchConfig } from "../src/dispatch-roster.ts"
import { resolveDispatch, exposedVocabulary, resolveAgent } from "../src/dispatch-resolver.ts"

// add-dispatch-onboarding: agents-path resolution (spec delta — MODIFIED
// "Exact-match resolution with no clamping": model pinned by the agent
// definition, depth ∈ depths verbatim, default = first entry, no retry).
import { SEED_AGENTS, PLACEHOLDER_IDENTITY } from "../src/forge-config.ts"

const CATALOG = {
  providers: {
    "zai-coding-plan": {
      models: { "glm-5.3": { reasoningOptions: ["low", "high", "max"], cost: { input: 0.6, output: 2.2 } } },
    },
    "opencode-go": {
      models: { "glm-5.3": { reasoningOptions: ["low", "medium"], cost: { input: 1.2, output: 4.4 } } },
    },
    anthropic: {
      models: { "claude-haiku-4-5": { reasoningOptions: ["off", "low", "medium", "high"] } },
    },
  },
}

const CFG = () =>
  buildDispatchConfig({
    configuredIdentities: ["zai-coding-plan/glm-5.3", "opencode-go/glm-5.3"],
    catalog: CATALOG,
    userRoster: [
      { model: "zai-coding-plan/glm-5.3", expose: ["low", "max"], profiles: ["build", "review"] },
      { model: "opencode-go/glm-5.3", expose: ["low", "medium"], profiles: ["build"] },
    ],
  })

const ok = (identity) => () => true
const only = (present) => (id) => present.includes(id)

test("exact hit picks the candidate whose expose contains the depth, ignoring declaration order", () => {
  const r = resolveDispatch(CFG(), { profile: "build", depth: "medium" }, ok)
  assert.equal(r.ok, true)
  if (r.ok) {
    assert.equal(r.identity, "opencode-go/glm-5.3") // zai (first) does not expose medium
    assert.equal(r.depth, "medium")
    assert.equal(r.pinned, false)
  }
})

test("declaration order wins among exact matches", () => {
  const r = resolveDispatch(CFG(), { profile: "build", depth: "low" }, ok)
  assert.equal(r.ok, true)
  if (r.ok) assert.equal(r.identity, "zai-coding-plan/glm-5.3") // declared first
})

test("S3: requested depth nobody exposes => structured error with the full menu", () => {
  const r = resolveDispatch(CFG(), { profile: "build", depth: "xhigh" }, ok)
  assert.equal(r.ok, false)
  if (!r.ok) {
    assert.equal(r.error.code, "no-candidate")
    assert.equal(r.error.menu.length, 2) // every build candidate listed
    const zai = r.error.menu.find((m) => m.identity === "zai-coding-plan/glm-5.3")
    assert.deepEqual(zai.expose, ["low", "max"])
    assert.match(zai.reason, /not exposed/)
    // vocabulary union across the roster for the menu footer
    for (const v of ["low", "max", "medium"]) assert.ok(r.error.vocabulary.includes(v))
  }
})

test("B12 regression: no clamping — {low,max} candidate never serves medium", () => {
  const cfg = buildDispatchConfig({
    configuredIdentities: ["zai-coding-plan/glm-5.3"],
    catalog: CATALOG,
    userRoster: [{ model: "zai-coding-plan/glm-5.3", expose: ["low", "max"], profiles: ["build"] }],
  })
  const r = resolveDispatch(cfg, { profile: "build", depth: "medium" }, ok)
  assert.equal(r.ok, false) // must NOT silently serve high or max
})

test("S4: pinned tier with unavailable model errors naming the pin, never falls back", () => {
  const cfg = buildDispatchConfig({
    configuredIdentities: ["zai-coding-plan/glm-5.3", "opencode-go/glm-5.3"],
    catalog: CATALOG,
    userTiers: { build: { shape: "write", model: "zai-coding-plan/glm-5.3", depth: "max" } },
    userRoster: [
      { model: "zai-coding-plan/glm-5.3", expose: ["low", "max"], profiles: ["build"] },
      { model: "opencode-go/glm-5.3", expose: ["low", "max"], profiles: ["build"] },
    ],
  })
  const r = resolveDispatch(cfg, { profile: "build" }, only(["opencode-go/glm-5.3"]))
  assert.equal(r.ok, false)
  if (!r.ok) {
    assert.equal(r.error.code, "pin-unavailable")
    assert.match(r.error.message, /zai-coding-plan\/glm-5\.3/)
    assert.match(r.error.message, /pin/i)
    // the menu names only the pinned identity — no other model offered
    assert.deepEqual(r.error.menu.map((m) => m.identity), ["zai-coding-plan/glm-5.3"])
  }
})

test("pin resolves directly when available, using the pin's depth", () => {
  const cfg = buildDispatchConfig({
    configuredIdentities: ["zai-coding-plan/glm-5.3"],
    catalog: CATALOG,
    userTiers: { build: { shape: "write", model: "zai-coding-plan/glm-5.3", depth: "max" } },
    userRoster: [{ model: "zai-coding-plan/glm-5.3", expose: ["low", "max"], profiles: ["build"] }],
  })
  const r = resolveDispatch(cfg, { profile: "build" }, ok)
  assert.equal(r.ok, true)
  if (r.ok) {
    assert.equal(r.identity, "zai-coding-plan/glm-5.3")
    assert.equal(r.depth, "max")
    assert.equal(r.pinned, true)
  }
})

test("pin + explicit unexposed depth is a mismatch error, not a silent serve", () => {
  const cfg = buildDispatchConfig({
    configuredIdentities: ["zai-coding-plan/glm-5.3"],
    catalog: CATALOG,
    userTiers: { build: { shape: "write", model: "zai-coding-plan/glm-5.3", depth: "max" } },
    userRoster: [{ model: "zai-coding-plan/glm-5.3", expose: ["low", "max"], profiles: ["build"] }],
  })
  const r = resolveDispatch(cfg, { profile: "build", depth: "medium" }, ok)
  assert.equal(r.ok, false)
  if (!r.ok) assert.equal(r.error.code, "pin-depth-mismatch")
})

test("S5: exclude drops a failed identity and resolution retries once against the rest", () => {
  const r = resolveDispatch(CFG(), { profile: "build", depth: "low", exclude: ["zai-coding-plan/glm-5.3"] }, ok)
  assert.equal(r.ok, true)
  if (r.ok) assert.equal(r.identity, "opencode-go/glm-5.3")
})

test("unavailable candidates are filtered and their menu line says why", () => {
  const r = resolveDispatch(CFG(), { profile: "build", depth: "low" }, only(["opencode-go/glm-5.3"]))
  assert.equal(r.ok, true)
  if (r.ok) assert.equal(r.identity, "opencode-go/glm-5.3")

  const none = resolveDispatch(CFG(), { profile: "build", depth: "medium" }, only(["zai-coding-plan/glm-5.3"]))
  assert.equal(none.ok, false)
  if (!none.ok) {
    const line = none.error.menu.find((m) => m.identity === "opencode-go/glm-5.3")
    assert.match(line.reason, /unavailable/)
  }
})

test("unknown tier errors", () => {
  const r = resolveDispatch(CFG(), { profile: "nope", depth: "low" }, ok)
  assert.equal(r.ok, false)
  if (!r.ok) assert.equal(r.error.code, "unknown-tier")
})

test("depth-required tier (degraded default) errors when no depth is passed", () => {
  const cfg = buildDispatchConfig({
    configuredIdentities: ["zai-coding-plan/glm-5.3"],
    catalog: CATALOG,
    userRoster: [
      // serves quick but exposes no "off" -> quick's default is dead, tier degrades
      { model: "zai-coding-plan/glm-5.3", expose: ["low"], profiles: ["quick", "build"] },
    ],
  })
  assert.equal(cfg.tiers.quick.defaultDepth, undefined) // degraded by roster validation
  const r = resolveDispatch(cfg, { profile: "quick" }, ok)
  assert.equal(r.ok, false)
  if (!r.ok) {
    assert.equal(r.error.code, "depth-required")
    assert.equal(r.error.menu.length, 1) // menu still shows the candidate's exposure
    assert.deepEqual(r.error.menu[0].expose, ["low"])
  }
})

test("tier default depth is used when the caller omits depth", () => {
  const cfg = buildDispatchConfig({
    configuredIdentities: ["anthropic/claude-haiku-4-5"],
    catalog: CATALOG,
    userRoster: [{ model: "anthropic/claude-haiku-4-5", profiles: ["scout"] }],
  })
  const r = resolveDispatch(cfg, { profile: "scout" }, ok)
  assert.equal(r.ok, true)
  if (r.ok) assert.equal(r.depth, "low") // scout's default
})

test("S1 through the resolver: same-name models stay independent candidates", () => {
  // zai exposes low,max; opencode-go exposes low,medium — a medium request can
  // only ever land on opencode-go (proven above); here: max only on zai.
  const r = resolveDispatch(CFG(), { profile: "build", depth: "max" }, ok)
  assert.equal(r.ok, true)
  if (r.ok) assert.equal(r.identity, "zai-coding-plan/glm-5.3")
})

test("exposedVocabulary is the union of every entry's expose", () => {
  const v = exposedVocabulary(CFG())
  assert.deepEqual([...v].sort(), ["low", "max", "medium"])
})

// ---------------------------------------------------------------------------
// add-dispatch-onboarding — resolveAgent (2.1)

const AGENTS = {
  research: { model: "zai-coding-plan/glm-5.3", depths: ["low", "high", "max"], shape: "readonly" },
  reviewer: { model: "anthropic/claude-haiku-4-5", depths: ["medium", "high"] },
}

test("2.1 default depth is the agent's first depths entry", () => {
  const r = resolveAgent(AGENTS, { agent: "research" }, ok)
  assert.equal(r.ok, true)
  if (r.ok) {
    assert.equal(r.model, "zai-coding-plan/glm-5.3")
    assert.equal(r.depth, "low")
  }
})

test("2.1 explicit depth in the set resolves verbatim", () => {
  const r = resolveAgent(AGENTS, { agent: "research", depth: "max" }, ok)
  assert.equal(r.ok, true)
  if (r.ok) assert.equal(r.depth, "max")
})

test("2.1 out-of-set depth errors listing the agent's allowed set", () => {
  const r = resolveAgent(AGENTS, { agent: "research", depth: "XHigh" }, ok)
  assert.equal(r.ok, false)
  if (!r.ok) {
    assert.equal(r.error.code, "depth-not-in-set")
    assert.match(r.error.message, /low.*high.*max/)
    assert.match(r.error.message, /research/)
  }
})

test("2.1 unknown agent errors listing defined agent names", () => {
  const r = resolveAgent(AGENTS, { agent: "ghost" }, ok)
  assert.equal(r.ok, false)
  if (!r.ok) {
    assert.equal(r.error.code, "unknown-agent")
    assert.match(r.error.message, /research/)
    assert.match(r.error.message, /reviewer/)
  }
})

test("2.1 unavailable pinned model errors naming it — never a fallback", () => {
  const r = resolveAgent(AGENTS, { agent: "research" }, () => false)
  assert.equal(r.ok, false)
  if (!r.ok) {
    assert.equal(r.error.code, "pin-unavailable")
    assert.match(r.error.message, /zai-coding-plan\/glm-5\.3/)
    assert.match(r.error.message, /no fallback/i)
  }
})

test("2.1 seed placeholder agent errors pin-unavailable on any host", () => {
  const r = resolveAgent(SEED_AGENTS, { agent: "research" }, (id) => id !== PLACEHOLDER_IDENTITY)
  assert.equal(r.ok, false)
  if (!r.ok) {
    assert.equal(r.error.code, "pin-unavailable")
    assert.match(r.error.message, /Local\/GPT Luna/)
  }
})

test("2.1 an agent with no depths errors with guidance to configure", () => {
  const r = resolveAgent({ broken: { model: "x/y", depths: [] } }, { agent: "broken" }, ok)
  assert.equal(r.ok, false)
  if (!r.ok) assert.equal(r.error.code, "depth-not-in-set")
})

test("2.1 an agent without a model string errors pin-unavailable", () => {
  const r = resolveAgent({ modelless: { model: "", depths: ["low"] } }, { agent: "modelless" }, ok)
  assert.equal(r.ok, false)
  if (!r.ok) assert.equal(r.error.code, "pin-unavailable")
})
