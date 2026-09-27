// Reasoning-depth metalanguage translation (add-dispatch-onboarding, design
// D4; spec delta — MODIFIED "Reasoning-depth injection via chat params").
//
// Canonical metalanguage: none / low / medium / high / max. Native level names
// (e.g. Qwen's XHigh) are an escape hatch written verbatim in an agent's
// depths and passed through untouched. Three hard rules govern translation:
//
//   verbatim-first    a meta word the model natively offers passes as-is
//   no interpolation  a meta word with no counterpart on the model errors
//                     listing BOTH vocabularies — never a nearest guess
//   full disclosure   every translation is disclosed as canonical -> native
//
// Family shapes (the option the provider actually accepts):
//   openai (effort)     options.reasoningEffort = <word>
//   anthropic (budget)  options.thinking = enabled with a published budget
//                       tier, or disabled for "none"
//   zai (toggle)        options.thinking = enabled | disabled
//   unknown             nothing injected — disclosed, never guessed (B21)
//
// Pure data in, data out; no fs, no host imports.

export const META_DEPTHS: readonly string[] = ["none", "low", "medium", "high", "max"]

// Published budget tier table (README documents it verbatim). Evenly spaced,
// every value within every known Claude ceiling; "max" IS the table's
// published model cap — a provider that rejects it is the final judge.
export const BUDGET_TIERS: Readonly<Record<string, number>> = {
  low: 8192,
  medium: 16384,
  high: 24576,
  max: 32768,
}

export type DepthFamilyID = "openai" | "anthropic" | "zai" | "unknown"

export type DepthTranslation =
  | { kind: "verbatim"; family: "openai"; word: string; disclose: string }
  | { kind: "tiered"; family: "anthropic"; budgetTokens: number; disclose: string }
  | { kind: "off"; family: "anthropic" | "zai"; disclose: string }
  | { kind: "toggle-on"; family: "zai"; disclose: string }
  | { kind: "not-injected"; family: "unknown"; disclose: string }
  | {
      kind: "no-mapping"
      family: DepthFamilyID
      message: string
      nativeVocabulary: string[]
      metaAvailable: string[]
    }

function noMapping(depth: string, family: DepthFamilyID, nativeVocabulary: string[], metaAvailable: string[]): DepthTranslation {
  return {
    kind: "no-mapping",
    family,
    message: `depth "${depth}" has no native counterpart on this model — the plugin never interpolates. Native levels: ${nativeVocabulary.join(", ") || "(none named)"}. Meta words this model accepts: ${metaAvailable.join(", ") || "(none)"}.`,
    nativeVocabulary,
    metaAvailable,
  }
}

export function translateDepth(depth: string, family: DepthFamilyID, ladder: string[] | null): DepthTranslation {
  if (family === "unknown") {
    return { kind: "not-injected", family, disclose: "not injected (unknown provider shape)" }
  }
  if (family === "anthropic") {
    if (depth === "none") return { kind: "off", family, disclose: "canonical none → native thinking:off" }
    const budget = BUDGET_TIERS[depth]
    if (budget !== undefined) {
      return { kind: "tiered", family, budgetTokens: budget, disclose: `canonical ${depth} → native thinking budget:${budget}` }
    }
    return noMapping(depth, family, [], [...META_DEPTHS])
  }
  if (family === "zai") {
    if (depth === "none") return { kind: "off", family, disclose: "canonical none → native thinking:off" }
    if ((META_DEPTHS as readonly string[]).includes(depth)) {
      return { kind: "toggle-on", family, disclose: `canonical ${depth} → native thinking:on (this provider shape takes a toggle, not a level)` }
    }
    return noMapping(depth, family, ["thinking on/off"], [...META_DEPTHS])
  }
  // Effort family: verbatim-first against the model's native ladder.
  const native = ladder ?? null
  if (native !== null && native.includes(depth)) {
    return { kind: "verbatim", family: "openai", word: depth, disclose: (META_DEPTHS as readonly string[]).includes(depth) ? "verbatim" : `verbatim (native word "${depth}")` }
  }
  if (native !== null && native.length > 0 && (META_DEPTHS as readonly string[]).includes(depth)) {
    // A meta word the model does not natively offer: error, never a guess.
    // (An EMPTY ladder is a toggle-shaped model the catalog cannot vouch for —
    // that case passes through below; the provider is the final judge.)
    return noMapping(depth, family, native, (META_DEPTHS as readonly string[]).filter((w) => native.includes(w)))
  }
  // Unknown ladder (custom provider) or a native escape-hatch word the
  // catalog does not confirm: pass through and let the provider judge.
  return { kind: "verbatim", family: "openai", word: depth, disclose: `verbatim (unverified — ${native === null ? "catalog does not know this model" : `catalog ladder does not list "${depth}"`}; the provider judges)` }
}

// Stamp the translation onto the host LLM request options (the chat.params
// hook re-applies the SAME value on every request of the worker session).
export function applyDepthTranslation(options: Record<string, unknown>, t: DepthTranslation): void {
  if (t.kind === "verbatim") {
    options.reasoningEffort = t.word
  } else if (t.kind === "tiered") {
    options.thinking = { type: "enabled", budget_tokens: t.budgetTokens }
  } else if (t.kind === "off") {
    options.thinking = { type: "disabled" }
  } else if (t.kind === "toggle-on") {
    options.thinking = { type: "enabled" }
  }
  // not-injected / no-mapping: intentionally write nothing.
}
