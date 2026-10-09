// models.dev snapshot loader (inherited from the dispatch era; retained for
// reasoning-ladder verification in the forge-subagents depth injection).
//
// The plugin only needs a minimal slice of models.dev: per provider/model the
// native reasoning ladder (reasoning_options) and structured prices (cost).
// Fetch respects OPENCODE_MODELS_URL (same override opencode honors), caches
// the parsed slice under <tmp>/opencode-forge/models-dev/, and degrades to
// the last cache (then to an empty catalog) on failure — depth injection
// falls back to verbatim pass-through (the provider is the final judge).

import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

export const DEFAULT_MODELS_DEV_URL = "https://models.dev/api.json"

// Minimal slice of the models.dev snapshot (absorbed from the deleted
// dispatch-roster module). Prices are USD per million tokens (models.dev
// shape).
export type CatalogCost = { input?: number; output?: number }
export type ReasoningShape = "effort" | "toggle" | "budget_tokens"
export type CatalogModel = { reasoningShape?: ReasoningShape; reasoningOptions?: string[]; cost?: CatalogCost }
export type CatalogSnapshot = { providers: Record<string, { models: Record<string, CatalogModel> }> }

export type ModelsDevResult = {
  catalog: CatalogSnapshot
  degraded: boolean
  source: string
}

// "provider/model" — opencode's identity key. Bare model-name matching does
// not exist: the same model name on two providers is two entries.
export function parseIdentity(identity: string): { provider: string; model: string } | null {
  const slash = identity.indexOf("/")
  if (slash <= 0 || slash === identity.length - 1) return null
  return { provider: identity.slice(0, slash), model: identity.slice(slash + 1) }
}

// The identity's native ladder (effort values), or null when the catalog does
// not know it or the model's shape carries no named levels (toggle/budget).
export function nativeLadder(catalog: CatalogSnapshot | null | undefined, identity: string): string[] | null {
  if (!catalog) return null
  const parsed = parseIdentity(identity)
  if (!parsed) return null
  const entry = catalog.providers?.[parsed.provider]?.models?.[parsed.model]
  if (!entry) return null
  const options = entry.reasoningOptions
  return Array.isArray(options) ? [...options] : null
}

// catalog-driven-depth-shapes: the resolved wire shape for a model — effort
// (with its named ladder), toggle, or budget_tokens — or null when the
// catalog is silent on the model (callers fall back to the provider-prefix
// family, then to the default effort word channel).
export type ModelDepthShape = { shape: "effort"; ladder: string[] } | { shape: "toggle" } | { shape: "budget_tokens" }

export function modelDepthShape(catalog: CatalogSnapshot | null | undefined, identity: string): ModelDepthShape | null {
  if (!catalog) return null
  const parsed = parseIdentity(identity)
  if (!parsed) return null
  const entry = catalog.providers?.[parsed.provider]?.models?.[parsed.model]
  if (!entry) return null
  if (entry.reasoningShape === "toggle") return { shape: "toggle" }
  if (entry.reasoningShape === "budget_tokens") return { shape: "budget_tokens" }
  if (entry.reasoningShape === "effort") return { shape: "effort", ladder: entry.reasoningOptions ? [...entry.reasoningOptions] : [] }
  return null
}

export function modelsDevCacheDir(base?: string): string {
  return join(base ?? join(tmpdir(), "opencode-forge"), "models-dev")
}

type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; status?: number; text(): Promise<string> }>

// models.dev reasoning_options is a STRUCTURED array, e.g.
//   [{type:"effort", values:["low","high","max"]}]   — named effort ladder
//   [{type:"toggle"}]                                — on/off, no named levels
//   [{type:"budget_tokens", min|max}]                — budget range, no names
// The named ladder is the union of effort "values"; the SHAPE is the first
// row's type — kept in the slice since catalog-driven-depth-shapes (the wire
// channel comes from the data, not from provider-prefix guessing).
function namedLevels(rows: unknown[]): string[] {
  const out: string[] = []
  for (const r of rows) {
    if (r && typeof r === "object" && (r as { type?: unknown }).type === "effort") {
      const values = (r as { values?: unknown }).values
      if (Array.isArray(values)) for (const v of values) if (typeof v === "string") out.push(v)
    }
  }
  return out
}

function shapeOf(rows: unknown[]): ReasoningShape | undefined {
  for (const r of rows) {
    if (r && typeof r === "object") {
      const t = (r as { type?: unknown }).type
      if (t === "effort" || t === "toggle" || t === "budget_tokens") return t
    }
  }
  return undefined
}

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
      const rows = Array.isArray(m.reasoning_options) ? (m.reasoning_options as unknown[]) : undefined
      const shape = rows !== undefined ? shapeOf(rows) : undefined
      const options = rows !== undefined && shape === "effort" ? namedLevels(rows) : undefined
      const cost = m.cost && typeof m.cost === "object" ? m.cost : undefined
      out.models[modelID] = {
        ...(shape !== undefined ? { reasoningShape: shape } : {}),
        ...(options && options.length > 0 ? { reasoningOptions: options } : {}),
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
