// Host model catalog adapter (change forge-tui-subagent-config, design D3).
//
// Normalizes OBSERVED catalog rows (server `GET /api/model` or the TUI-side
// `data.location.model.list`) into searchable identities with level
// evidence. Hard probe findings baked in (probes REPORT §2, host 2.4.2):
//   - `variants` arrives as an ARRAY of {id, settings} on /api/model and as
//     an object-keyed map on the TUI catalog — both shapes are accepted.
//   - catalog `status: "active"` does NOT prove credentials are usable
//     (ghost models of dead providers still report active) — every identity
//     carries availability "unverified"; the UI discloses that wording.
//   - A missing/absent catalog is UNKNOWN, never an authoritative empty
//     list: normalizeCatalog returns findings instead of pretending.

import { VARIANT_DEPTH_WORDS } from "./roster-compile.ts"

export type CatalogModel = {
  providerID: string
  modelID: string
  label: string
  // Observed target-model variant ids (wire casing preserved — the catalog
  // decides casing, the config surface stays lowercase).
  variants: string[]
  // Raw catalog status ("active" observed; null when absent).
  status: string | null
  // Raw catalog enabled flag (null when the catalog does not say). Rows are
  // NEVER dropped for enabled:false — the flag is carried so the UI can
  // disclose a disabled identity instead of silently skipping it.
  enabled: boolean | null
  // Always "unverified": catalog presence never proves credentials work.
  availability: "unverified"
}

export function normalizeCatalog(raw: unknown): { models: CatalogModel[]; findings: string[] } {
  const findings: string[] = []
  if (!Array.isArray(raw)) {
    return { models: [], findings: [`catalog unavailable: expected an array of model rows, got ${raw === null ? "null" : typeof raw}`] }
  }
  const models: CatalogModel[] = []
  const seen = new Set<string>()
  for (const row of raw) {
    if (row === null || typeof row !== "object" || Array.isArray(row)) {
      findings.push("catalog: skipped a non-object model row")
      continue
    }
    const rec = row as Record<string, unknown>
    const providerID = typeof rec.providerID === "string" && rec.providerID ? rec.providerID : typeof rec.provider === "string" && rec.provider ? (rec.provider as string) : null
    const modelID = typeof rec.modelID === "string" && rec.modelID ? rec.modelID : typeof rec.id === "string" && rec.id ? (rec.id as string) : null
    if (!providerID || !modelID) {
      findings.push(`catalog: skipped a model row missing provider/model identity (${JSON.stringify(Object.keys(rec))})`)
      continue
    }
    const key = `${providerID}/${modelID}`
    if (seen.has(key)) continue
    seen.add(key)
    models.push({
      providerID,
      modelID,
      label: typeof rec.name === "string" && rec.name ? rec.name : key,
      variants: normalizeVariants(rec.variants),
      status: typeof rec.status === "string" ? rec.status : null,
      enabled: typeof rec.enabled === "boolean" ? rec.enabled : null,
      availability: "unverified",
    })
  }
  if (models.length === 0) findings.push("catalog: no usable model rows — treat as unknown, not as an empty authoritative list")
  return { models, findings }
}

// /api/model rows carry `variants` as an array of ids or {id,...} objects;
// the TUI-side catalog carries an object keyed by variant id. Both fold to
// the id list (original casing).
function normalizeVariants(v: unknown): string[] {
  if (Array.isArray(v)) {
    return v
      .map((entry) => (typeof entry === "string" ? entry : entry !== null && typeof entry === "object" && typeof (entry as Record<string, unknown>).id === "string" ? ((entry as Record<string, unknown>).id as string) : null))
      .filter((id): id is string => id !== null)
  }
  if (v !== null && typeof v === "object" && !Array.isArray(v)) {
    return Object.keys(v as Record<string, unknown>)
  }
  return []
}

export type ModelLookup = (providerID: string, modelID: string) => CatalogModel | undefined

// Find one identity (exact ids, case-sensitive — a pinned identity is an
// exact provider/model string).
export const catalogLookup = (models: CatalogModel[]): ModelLookup => (providerID, modelID) =>
  models.find((m) => m.providerID === providerID && m.modelID === modelID)

export type LevelVerdict =
  | { supported: true; variant: string }
  | { supported: false; word: string; unverified: true; note: string }

// Level evidence for ONE target model: the word is supported only when the
// model's OBSERVED variants contain it (case-insensitive comparison; the
// catalog's original casing is the wire value). Anything else — unknown
// model, absent metadata, word outside the observed set — is disclosed as
// unverified, never silently remapped or rejected as forbidden.
export function levelSupportFor(model: CatalogModel | undefined, thoughtLevel: string): LevelVerdict {
  const word = thoughtLevel.trim()
  if (model === undefined) {
    return { supported: false, word, unverified: true, note: "this provider/model identity is absent from the observed catalog — availability unknown" }
  }
  const hit = model.variants.find((v) => v.toLowerCase() === word.toLowerCase())
  if (hit !== undefined) return { supported: true, variant: hit }
  if (model.variants.length === 0) {
    return { supported: false, word, unverified: true, note: "the catalog exposes no variant metadata for this model — the level is unverified" }
  }
  return { supported: false, word, unverified: true, note: `"${word}" is not among the observed variants [${model.variants.join(", ")}] — usable under existing Forge depth semantics, but unverified by the catalog` }
}

// Depth words that compile INTO the model string (`provider/model#low`);
// all other words ride the existing per-spawn chat.params injection.
export function isVariantDepthWord(word: string): boolean {
  return (VARIANT_DEPTH_WORDS as readonly string[]).includes(word)
}
