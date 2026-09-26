import test from "node:test"
import assert from "node:assert/strict"

// Spec: dispatch — cost reporting with self-computed prices; design D5/D6.
//   fetch success -> reduced snapshot, not degraded
//   fetch failure -> degraded empty catalog (dispatch keeps working)
//   OPENCODE_MODELS_URL is respected as the source

import { loadModelsDevSnapshot, reduceModelsDev } from "../src/models-dev.ts"

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

test("reduceModelsDev keeps reasoning_options + cost, skips malformed entries", () => {
  const c = reduceModelsDev(SAMPLE)
  const glm = c.providers["zai-coding-plan"].models["glm-5.3"]
  assert.deepEqual(glm.reasoningOptions, ["low", "high", "max"], "effort values are the named ladder")
  assert.deepEqual(c.providers["zai-coding-plan"].models["glm-4.7"].reasoningOptions, [], "toggle models have no named levels")
  assert.deepEqual(c.providers["zai-coding-plan"].models["claude-x"].reasoningOptions, [], "budget-only models have no named levels")
  assert.equal(glm.cost.input, 0.6)
  assert.ok(c.providers["zai-coding-plan"].models.weird, "model kept even with a malformed cost")
  assert.equal(reduceModelsDev(null).providers && Object.keys(reduceModelsDev(null).providers).length, 0)
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
