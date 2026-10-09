import test from "node:test"
import assert from "node:assert/strict"

// Spec: catalog-driven-depth-shapes — the models.dev slice keeps the
// reasoning SHAPE (effort/toggle/budget_tokens), not just the effort values:
//   fetch success -> reduced snapshot, not degraded
//   fetch failure -> degraded empty catalog (dispatch keeps working)
//   OPENCODE_MODELS_URL is respected as the source

import { loadModelsDevSnapshot, reduceModelsDev, modelDepthShape, nativeLadder } from "../src/models-dev.ts"

const SAMPLE = {
  "zai-coding-plan": {
    models: {
      // real models.dev shape: reasoning_options is a STRUCTURED array
      "glm-5.3": { reasoning_options: [{ type: "effort", values: ["low", "high", "max"] }], cost: { input: 0.6, output: 2.2, cache_read: 0.11 } },
      "glm-4.7": { reasoning_options: [{ type: "toggle" }] },
      "claude-x": { reasoning_options: [{ type: "budget_tokens", min: 1024 }] },
      weird: { cost: "not-an-object" },
    },
  },
}

test("reduceModelsDev keeps the shape + effort values + cost, skips malformed entries", () => {
  const c = reduceModelsDev(SAMPLE)
  const glm = c.providers["zai-coding-plan"].models["glm-5.3"]
  assert.equal(glm.reasoningShape, "effort")
  assert.deepEqual(glm.reasoningOptions, ["low", "high", "max"], "effort values are the named ladder")

  const toggle = c.providers["zai-coding-plan"].models["glm-4.7"]
  assert.equal(toggle.reasoningShape, "toggle")
  assert.equal(toggle.reasoningOptions, undefined, "toggle models carry the shape, not a fake empty ladder")

  const budget = c.providers["zai-coding-plan"].models["claude-x"]
  assert.equal(budget.reasoningShape, "budget_tokens")
  assert.equal(budget.reasoningOptions, undefined, "budget-only models have no named levels")

  assert.equal(glm.cost.input, 0.6)
  assert.ok(c.providers["zai-coding-plan"].models.weird, "model kept even with a malformed cost")
  assert.equal(reduceModelsDev(null).providers && Object.keys(reduceModelsDev(null).providers).length, 0)
})

test("modelDepthShape: the catalog decides the channel; silence yields null", () => {
  const c = reduceModelsDev(SAMPLE)
  assert.deepEqual(modelDepthShape(c, "zai-coding-plan/glm-5.3"), { shape: "effort", ladder: ["low", "high", "max"] })
  assert.deepEqual(modelDepthShape(c, "zai-coding-plan/glm-4.7"), { shape: "toggle" })
  assert.deepEqual(modelDepthShape(c, "zai-coding-plan/claude-x"), { shape: "budget_tokens" })
  assert.equal(modelDepthShape(c, "zai-coding-plan/weird"), null, "no reasoning_options row -> catalog-silent")
  assert.equal(modelDepthShape(c, "unknown-provider/whatever"), null)
  assert.equal(modelDepthShape(null, "zai-coding-plan/glm-5.3"), null, "degraded snapshot fails soft")
})

test("nativeLadder: toggle/budget models now yield null (no fake empty ladder)", () => {
  const c = reduceModelsDev(SAMPLE)
  assert.deepEqual(nativeLadder(c, "zai-coding-plan/glm-5.3"), ["low", "high", "max"])
  assert.equal(nativeLadder(c, "zai-coding-plan/glm-4.7"), null)
})

test("fetch success -> snapshot, not degraded; failure -> degraded empty", async () => {
  const ok = await loadModelsDevSnapshot({
    fetcher: async () => ({ ok: true, status: 200, text: async () => JSON.stringify(SAMPLE) }),
  })
  assert.equal(ok.degraded, false)
  assert.equal(ok.catalog.providers["zai-coding-plan"].models["glm-5.3"].reasoningOptions.length, 3)

  const fail = await loadModelsDevSnapshot({
    fetcher: async () => ({ ok: false, status: 500, text: async () => "boom" }),
  })
  assert.equal(fail.degraded, true)
  assert.deepEqual(fail.catalog.providers, {})
})

test("OPENCODE_MODELS_URL override is honored", async () => {
  let seen
  await loadModelsDevSnapshot({
    url: "https://mirror.example/api.json",
    fetcher: async (u) => {
      seen = u
      return { ok: true, status: 200, text: async () => "{}" }
    },
  })
  assert.equal(seen, "https://mirror.example/api.json")
})
