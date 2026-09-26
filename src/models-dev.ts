// models.dev snapshot loader (spec: dispatch — cost reporting; design D5/D6).
//
// The plugin only needs a minimal slice of models.dev: per provider/model the
// native reasoning ladder (reasoning_options) and structured prices (cost).
// Fetch respects OPENCODE_MODELS_URL (same override opencode honors), caches
// the parsed slice under <tmp>/opencode-forge/models-dev/, and degrades to
// the last cache (then to an empty catalog) on failure — dispatch keeps
// working, costs report null.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type { CatalogSnapshot } from "./dispatch-roster.ts"

export const DEFAULT_MODELS_DEV_URL = "https://models.dev/api.json"

export type ModelsDevResult = {
  catalog: CatalogSnapshot
  degraded: boolean
  source: string
}

export function modelsDevCacheDir(base?: string): string {
  return join(base ?? join(tmpdir(), "opencode-forge"), "models-dev")
}

type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; status?: number; text(): Promise<string> }>

// Shape reducer: models.dev api.json -> the minimal catalog slice. Never
// throws on unexpected model shapes — a malformed entry is skipped.
export function reduceModelsDev(raw: unknown): CatalogSnapshot {
  const catalog: CatalogSnapshot = { providers: {} }
  const providers = (raw as Record<string, Record<string, unknown>> | null)?.constructor === Object ? (raw as Record<string, Record<string, unknown>>) : null
  if (!providers) return catalog
  for (const [providerID, provider] of Object.entries(providers)) {
    const models = (provider as { models?: Record<string, unknown> }).models
    if (!models || typeof models !== "object") continue
    const out: CatalogSnapshot["providers"][string] = { models: {} }
    for (const [modelID, model] of Object.entries(models as Record<string, unknown>)) {
      const m = model as { reasoning_options?: unknown; cost?: Record<string, unknown> }
      const options = Array.isArray(m.reasoning_options) ? m.reasoning_options.filter((o): o is string => typeof o === "string") : undefined
      const cost = m.cost && typeof m.cost === "object" ? m.cost : undefined
      out.models[modelID] = {
        ...(options ? { reasoningOptions: options } : {}),
        ...(cost ? { cost: cost as { input?: number; output?: number } } : {}),
      }
    }
    catalog.providers[providerID] = out
  }
  return catalog
}

export async function loadModelsDevSnapshot(
  opts: { timeoutMs?: number; cacheDir?: string; fetcher?: FetchLike; url?: string } = {},
): Promise<ModelsDevResult> {
  const url = opts.url ?? process.env.OPENCODE_MODELS_URL ?? DEFAULT_MODELS_DEV_URL
  const cacheDir = modelsDevCacheDir(opts.cacheDir)
  const cacheFile = join(cacheDir, "snapshot.json")
  const fetcher = opts.fetcher
  if (fetcher) {
    // Injected fetcher (tests): no cache writes — pure behavior check.
    try {
      const res = await fetcher(url, { signal: AbortSignal.timeout(opts.timeoutMs ?? 8_000) })
      if (res.ok) return { catalog: reduceModelsDev(JSON.parse(await res.text())), degraded: false, source: url }
    } catch {}
    return { catalog: { providers: {} }, degraded: true, source: "fetch-failed" }
  }
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(opts.timeoutMs ?? 8_000) })
    if (res.ok) {
      const catalog = reduceModelsDev(JSON.parse(await res.text()))
      try {
        mkdirSync(cacheDir, { recursive: true })
        writeFileSync(cacheFile, JSON.stringify(catalog))
      } catch {}
      return { catalog, degraded: false, source: url }
    }
  } catch {}
  // Degrade: last good cache, then empty.
  try {
    const cached = JSON.parse(readFileSync(cacheFile, "utf8")) as CatalogSnapshot
    if (cached && typeof cached === "object" && cached.providers) return { catalog: cached, degraded: true, source: "cache" }
  } catch {}
  return { catalog: { providers: {} }, degraded: true, source: "unavailable" }
}
