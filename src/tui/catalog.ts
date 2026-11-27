// Catalog adapter for the TUI model/level pickers (design D3).
//
// Wraps the landed pure core (src/model-catalog.ts) with the list/option
// shapes the dialog flow needs. Hard probe findings stay baked in via the
// core: catalog "active" NEVER proves credentials (availability is always
// "unverified"), and a missing catalog is UNKNOWN — never an authoritative
// empty list. The UI discloses both wordings instead of guessing.

import { normalizeCatalog, catalogLookup, levelSupportFor, isVariantDepthWord, type CatalogModel } from "../model-catalog.ts"
import type { SelectOption } from "./contracts.ts"

export type CatalogView = {
  // null when the catalog could not be observed at all (unknown state).
  models: CatalogModel[]
  known: boolean
  findings: string[]
  lookup: (providerID: string, modelID: string) => CatalogModel | undefined
}

export function catalogFromRows(raw: unknown): CatalogView {
  const { models, findings } = normalizeCatalog(raw)
  return { models, known: true, findings, lookup: catalogLookup(models) }
}

export const catalogUnknown: CatalogView = {
  models: [],
  known: false,
  findings: ["the host model catalog is not available — availability unknown, not an empty authoritative list"],
  lookup: () => undefined,
}

// Provider options (grouped first picker — keeps per-dialog lists small on
// narrow terminals; native select filtering is not probe-proven so the
// editor never relies on it).
export function providerOptions(models: CatalogModel[], extra?: { manualEntryValue?: string; manualEntryLabel?: string }): SelectOption[] {
  const seen = new Map<string, number>()
  for (const m of models) seen.set(m.providerID, (seen.get(m.providerID) ?? 0) + 1)
  const options: SelectOption[] = [...seen.entries()].map(([providerID, count]) => ({
    title: providerID,
    value: `provider:${providerID}`,
    description: `${count} model(s) in the observed catalog — availability unverified`,
    category: "Observed providers",
  }))
  if (extra?.manualEntryValue) {
    options.push({
      title: extra.manualEntryLabel ?? "Enter a provider/model identity manually…",
      value: extra.manualEntryValue,
      description: "for an existing raw value absent from the catalog (preserved, disclosed as unverified)",
      category: "Other",
    })
  }
  return options
}

export function modelOptions(models: CatalogModel[], providerID: string): SelectOption[] {
  return models
    .filter((m) => m.providerID === providerID)
    .map((m) => ({
      title: `${m.providerID} / ${m.modelID}`,
      value: `model:${m.modelID}`,
      description: m.variants.length > 0 ? `observed variants: ${m.variants.join(" ")}` : "no variant metadata — levels unverified",
      category: m.label === `${m.providerID}/${m.modelID}` ? undefined : m.label,
    }))
}

// Level options for ONE target model: observed variants first (the catalog
// decides casing), then the canonical Forge depth words that the observed
// set does NOT already carry (labelled unverified), then a custom entry.
export function levelOptions(model: CatalogModel | undefined, customValue?: string): SelectOption[] {
  const options: SelectOption[] = []
  if (model !== undefined && model.variants.length > 0) {
    for (const v of model.variants) {
      const verdict = levelSupportFor(model, v)
      options.push({
        title: v,
        value: `level:${v}`,
        description: verdict.supported ? "observed variant — supported by catalog metadata" : verdict.note,
        category: "Observed variants",
      })
    }
  }
  for (const word of ["none", "low", "medium", "high", "max"]) {
    if (model !== undefined && model.variants.some((v) => v.toLowerCase() === word)) continue
    options.push({
      title: word,
      value: `level:${word}`,
      description:
        model === undefined
          ? "canonical depth word — target model unknown, level unverified"
          : model.variants.length === 0
            ? `canonical depth word — model exposes no variant metadata; ${isVariantDepthWord(word) ? "compiles into the model string" : "rides per-spawn chat.params"}`
            : `not among the observed variants — usable under Forge depth semantics, unverified by the catalog`,
      category: "Canonical depth words",
    })
  }
  if (customValue !== undefined) {
    options.push({
      title: "Enter a custom level…",
      value: customValue,
      description: "native level name under existing Forge depth semantics — labelled unverified unless observed",
      category: "Other",
    })
  }
  return options
}

// Pure search over entry-ish rows: case-insensitive substring across the
// searchable text. Used by the list flow ("Search…") — the editor never
// assumes the native select filters.
export function matchesQuery(query: string, texts: (string | undefined)[]): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return texts.some((t) => typeof t === "string" && t.toLowerCase().includes(q))
}
