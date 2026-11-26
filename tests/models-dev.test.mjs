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

test("malformed provider and model rows do not discard valid catalog siblings", () => {
  const catalog = reduceModelsDev({
    missing: null,
    array: [],
    good: { models: { missing: null, scalar: 42, array: [], valid: { reasoning_options: [{ type: "effort", values: ["low"] }] } } },
    ...SAMPLE,
  })
  assert.deepEqual(Object.keys(catalog.providers).sort(), ["good", "zai-coding-plan"])
  assert.deepEqual(catalog.providers.good.models, { valid: { reasoningShape: "effort", reasoningOptions: ["low"] } })
  assert.deepEqual(catalog.providers["zai-coding-plan"], reduceModelsDev(SAMPLE).providers["zai-coding-plan"])
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

test("pending snapshot loads are isolated by cache root and source", async (t) => {
  const { mkdtempSync, rmSync } = await import("node:fs")
  const { join } = await import("node:path")
  const root = mkdtempSync(join(process.cwd(), ".models-dev-test-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  let release
  const pending = new Promise(resolve => { release = resolve })
  const fetch = t.mock.method(globalThis, "fetch", async (url) => {
    await pending
    return { ok: true, text: async () => JSON.stringify(url.endsWith("/one") ? SAMPLE : {}) }
  })
  const a = { cacheDir: join(root, "a"), url: "https://fixture.example/one" }
  const b = { ...a, cacheDir: join(root, "b") }
  const c = { ...a, url: "https://fixture.example/two" }
  const loads = [a, a, b, c].map(opts => loadModelsDevSnapshot(opts))
  release()
  const results = await Promise.all(loads)
  assert.equal(fetch.mock.callCount(), 3)
  assert.deepEqual(results.map(r => r.source), [a.url, a.url, b.url, c.url])
  assert.deepEqual(results.map(r => r.catalog), [reduceModelsDev(SAMPLE), reduceModelsDev(SAMPLE), reduceModelsDev(SAMPLE), { providers: {} }])
  await loadModelsDevSnapshot(a)
  assert.equal(fetch.mock.callCount(), 4, "settled loads must not be memoized")
})

// Exercise the real setup loader, with only the transport and paths replaced.
test("v2 setup loads a snapshot into its isolated cache", async (t) => {
  const { mkdtempSync, readFileSync, rmSync } = await import("node:fs")
  const { join } = await import("node:path")
  const root = mkdtempSync(join(process.cwd(), ".models-dev-test-"))
  const keys = ["FORGE_TEST_RUNTIME_DIR", "FORGE_TEST_FORGE_HOME", "FORGE_TEST_NO_DISPATCH_FETCH"]
  const env = Object.fromEntries(keys.map(key => [key, process.env[key]]))
  t.after(() => {
    for (const key of keys) {
      if (env[key] === undefined) delete process.env[key]
      else process.env[key] = env[key]
    }
    rmSync(root, { recursive: true, force: true })
  })
  process.env.FORGE_TEST_RUNTIME_DIR = root
  process.env.FORGE_TEST_FORGE_HOME = root
  process.env.FORGE_TEST_NO_DISPATCH_FETCH = "0"
  let release
  const pending = new Promise(resolve => { release = resolve })
  const fetch = t.mock.method(globalThis, "fetch", async () => {
    await pending
    return { ok: true, text: async () => JSON.stringify(SAMPLE) }
  })
  const { v2Setup, __runtimeNamespaceTestSurface, v2WiringSeam } = await import("../plugin.ts")
  const deps = { anchors: [root], homeDir: root, stat: () => null, readFile: () => "{}", materialize: "runtime" }
  const first = v2Setup({}, deps)
  const second = v2Setup({}, { ...deps, anchors: [join(root, "second")] })
  release()
  await Promise.all([first, second])
  assert.equal(fetch.mock.callCount(), 1, "overlapping directory setups share one snapshot load")
  const file = join(root, "opencode-forge", "models-dev", "snapshot.json")
  assert.equal(__runtimeNamespaceTestSurface.modelsDevCacheDir(), join(root, "opencode-forge", "models-dev"))
  const expected = reduceModelsDev(SAMPLE)
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), expected)
  const channel = () => v2WiringSeam.resolveDepthChannel("zai-coding-plan", "glm-5.3")
  assert.deepEqual(v2WiringSeam.modelsDevCatalog(), expected)
  assert.deepEqual(channel(), { kind: "effort", ladder: ["low", "high", "max"] })

  // A stalled transport observes the actual fetch signal, not a separate
  // setup race. The short budget must abort it and retain the last good cache.
  let signal
  fetch.mock.mockImplementation(async (_url, init) => {
    signal = init.signal
    return new Promise((_, reject) => {
      // AbortSignal.timeout uses an unref'ed timer; keep this fixture alive.
      const watchdog = setTimeout(() => reject(new Error("fixture watchdog")), 4_000)
      signal.addEventListener("abort", () => {
        clearTimeout(watchdog)
        reject(signal.reason)
      }, { once: true })
    })
  })
  await Promise.all([v2Setup({}, deps), v2Setup({}, deps)])
  assert.equal(fetch.mock.callCount(), 2, "overlapping timeouts share the last-good load")
  assert.equal(signal.aborted, true, "v2 fetch must abort before the fixture watchdog")
  assert.equal(signal.reason.name, "TimeoutError")
  assert.deepEqual(v2WiringSeam.modelsDevCatalog(), expected)
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), expected)
  assert.deepEqual(channel(), { kind: "effort", ladder: ["low", "high", "max"] })

  // No cache: existing loader returns an empty catalog, so family fallback wins.
  fetch.mock.mockImplementation(async () => { throw new Error("offline fixture") })
  rmSync(file)
  await v2Setup({}, deps)
  assert.equal(fetch.mock.callCount(), 3)
  assert.deepEqual(v2WiringSeam.modelsDevCatalog(), { providers: {} })
  assert.deepEqual(channel(), { kind: "toggle" })
  // Preserve provider-family selection even when the setup loader has no
  // snapshot. The surviving depth consumer must not depend on v1 setup.
  assert.deepEqual(v2WiringSeam.resolveDepthChannel("openai", "fixture"), { kind: "effort", ladder: null })
  assert.deepEqual(v2WiringSeam.resolveDepthChannel("anthropic", "claude-opus-4-7"), { kind: "adaptive-effort" })
  assert.deepEqual(v2WiringSeam.resolveDepthChannel("anthropic", "claude-sonnet-4-6"), { kind: "budget" })
  assert.deepEqual(v2WiringSeam.resolveDepthChannel("fixture-provider", "fixture"), { kind: "effort", ladder: null })

  // Explicit test opt-out clears shared state to null without fetching.
  fetch.mock.mockImplementation(async () => ({ ok: true, text: async () => JSON.stringify(SAMPLE) }))
  await v2Setup({}, deps)
  assert.deepEqual(v2WiringSeam.modelsDevCatalog(), expected)
  process.env.FORGE_TEST_NO_DISPATCH_FETCH = "1"
  await v2Setup({}, deps)
  assert.equal(fetch.mock.callCount(), 4)
  assert.equal(v2WiringSeam.modelsDevCatalog(), null)
  assert.deepEqual(channel(), { kind: "toggle" })
  delete process.env.FORGE_TEST_NO_DISPATCH_FETCH
  await v2Setup({}, deps)
  assert.equal(fetch.mock.callCount(), 4, "ordinary node:test setups stay offline")
})
