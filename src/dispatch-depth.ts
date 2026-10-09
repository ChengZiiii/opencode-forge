// Reasoning-depth metalanguage translation (catalog-driven-depth-shapes).
//
// Canonical metalanguage: the seven-word DICTIONARY
//   none / minimal / low / medium / high / xhigh / max
// A translation dictionary, never a whitelist (the change's axiom): words the
// dictionary does not know pass through VERBATIM on word-shaped channels —
// the provider is the final judge, and a provider-side rejection surfaces as
// the request's own error (the plugin never breaks the session itself).
//
// Wire shape comes from the resolved DepthChannel (see the chat.params chain
// in plugin.ts): catalog reasoning_options first, provider-prefix fallback,
// and effort-word pass-through as the default for unknown endpoints. This
// module stays pure: data in, data out, findings as data — never a throw.
//
// Channel semantics (spec: forge-subagents "Pinned thoughtLevel injection"):
//   effort          word channel (openai chat/responses, catalog effort
//                   models): ladder match is case-insensitive and emits the
//                   LADDER's native casing; unmatched words pass through
//                   unverified.
//   adaptive-effort word channel for adaptive-era Anthropic models: the
//                   effort word rides the adaptive channel as-is.
//   budget          legacy Anthropic numeric channel: dictionary words map
//                   to the documented tier table (README publishes it
//                   verbatim); words without a tier are a dead end.
//   toggle          on/off channel: `none` maps to off; ANY other word is a
//                   dead end — the shape cannot express levels, and silently
//                   collapsing `xhigh` to "on" would decide for the user.
//
// The dead ends (budget without a tier, toggle with a level word) are the
// ONLY no-counterpart cases: inject nothing, record a bounded finding naming
// both vocabularies. No interpolation anywhere: a word passes as-is or is
// refused with a finding — it is never remapped to a different level.
//
// Pure data in, data out; no fs, no host imports.

export const META_DEPTHS: readonly string[] = ["none", "minimal", "low", "medium", "high", "xhigh", "max"]

// Published budget tier table (README documents it verbatim; it is this
// plugin's selection — there is no community-standard table, the only
// cross-project consensus number is the 1024 Anthropic API minimum).
export const BUDGET_TIERS: Readonly<Record<string, number>> = {
  minimal: 1024,
  low: 8192,
  medium: 16384,
  high: 24576,
  xhigh: 28672,
  max: 32768,
}

// The wire shape a model offers, resolved by the caller's fallback chain.
export type DepthChannel =
  | { kind: "effort"; ladder: string[] | null } // null ladder = unknown endpoint: pass-through territory
  | { kind: "adaptive-effort" }
  | { kind: "budget" }
  | { kind: "toggle" }

export type DepthTranslation =
  | { kind: "verbatim"; channel: "effort" | "adaptive-effort"; word: string; confirmed: boolean; disclose: string }
  | { kind: "tiered"; channel: "budget"; budgetTokens: number; disclose: string }
  | { kind: "off"; channel: "budget" | "toggle"; disclose: string }
  | {
      kind: "no-mapping"
      channel: DepthChannel["kind"]
      message: string
      shapeVocabulary: string[]
      dictionary: string[]
    }

function noMapping(depth: string, channel: DepthChannel["kind"], shapeVocabulary: string[]): DepthTranslation {
  return {
    kind: "no-mapping",
    channel,
    message: `depth "${depth}" has no channel on this shape (${channel} — the endpoint cannot express it). Shape vocabulary: ${shapeVocabulary.join(", ") || "(none)"}. Dictionary words: ${META_DEPTHS.join(", ")}. The plugin never interpolates; fix the pinned thoughtLevel or the model's wire shape.`,
    shapeVocabulary,
    dictionary: [...META_DEPTHS],
  }
}

// Case-insensitive ladder match emitting the LADDER's native casing: the user
// writes lowercase (config-boundary normalization), the catalog vouches for
// the wire casing ("xhigh" in, "XHigh" out when the ladder says so).
function ladderWord(ladder: string[] | null, depth: string): string | null {
  if (ladder === null) return null
  for (const w of ladder) if (w.toLowerCase() === depth) return w
  return null
}

export function translateDepth(depth: string, channel: DepthChannel): DepthTranslation {
  const d = depth.trim().toLowerCase()
  if (channel.kind === "effort" || channel.kind === "adaptive-effort") {
    const native = channel.kind === "effort" ? ladderWord(channel.ladder, d) : null
    if (native !== null) {
      return {
        kind: "verbatim",
        channel: channel.kind,
        word: native,
        confirmed: true,
        disclose: `canonical ${d} → native "${native}" (catalog-confirmed)`,
      }
    }
    // Unmatched word on a word channel: pass through VERBATIM, disclosed as
    // unverified — the provider is the final judge (dictionary-not-whitelist).
    const why = channel.kind === "effort" && channel.ladder !== null ? `catalog ladder does not list "${d}"` : "no catalog ladder for this endpoint"
    return {
      kind: "verbatim",
      channel: channel.kind,
      word: d,
      confirmed: false,
      disclose: `verbatim (unverified — ${why}; the provider judges)`,
    }
  }
  if (channel.kind === "toggle") {
    if (d === "none") return { kind: "off", channel: "toggle", disclose: "canonical none → native thinking:off" }
    // Any level word on a toggle-only endpoint is a dead end: collapsing it
    // to "on" would silently approximate — the finding names both sides.
    return noMapping(d, "toggle", ["none (thinking on/off only)"])
  }
  // budget: legacy numeric channel.
  if (d === "none") return { kind: "off", channel: "budget", disclose: "canonical none → native thinking:off" }
  const budget = BUDGET_TIERS[d]
  if (budget !== undefined) {
    return { kind: "tiered", channel: "budget", budgetTokens: budget, disclose: `canonical ${d} → native thinking budget:${budget}` }
  }
  return noMapping(d, "budget", ["none", ...Object.keys(BUDGET_TIERS)])
}

// Stamp the translation onto the host LLM request options (the chat.params
// hook re-applies the SAME value on every request of the worker session).
// Option keys are channel-specific and EMPIRICALLY verified against the real
// host (verify/adaptive-key.md, sandbox wire capture 2026-10-09):
//   - effort channel: options.reasoningEffort — the host transports it for
//     OpenAI-compatible transports (established behavior, unchanged).
//   - adaptive-effort channel: options.effort — the patched host maps this
//     top-level key to the adaptive-era native wire shape
//     `output_config:{effort:<word>}`; `reasoningEffort` and the
//     namespaced `anthropic.output_config` form are BOTH silently dropped
//     by the anthropic transport (two-run differential capture, markers
//     low/medium/xhigh disambiguated; the host's own title-generation call
//     confirmed output_config.effort as the native adaptive vocabulary).
export function applyDepthTranslation(options: Record<string, unknown>, t: DepthTranslation): void {
  if (t.kind === "verbatim") {
    if (t.channel === "adaptive-effort") {
      options.effort = t.word
    } else {
      options.reasoningEffort = t.word
    }
  } else if (t.kind === "tiered") {
    options.thinking = { type: "enabled", budget_tokens: t.budgetTokens }
  } else if (t.kind === "off") {
    options.thinking = { type: "disabled" }
  }
  // no-mapping: intentionally write nothing.
}

// Resolve a materialized agent's pinned thoughtLevel (spec: forge-subagents —
// "Pinned thoughtLevel injection keyed by agent name"). Thin wrapper over
// translateDepth with forge-subagents semantics: the input word is normalized
// defensively (the config boundary already normalized it — double safety),
// and an untranslatable word NEVER fails a session — it injects nothing and
// yields a bounded finding message naming both vocabularies.
export function resolvePinnedDepth(
  thoughtLevel: string,
  channel: DepthChannel,
): { translation: DepthTranslation | null; findingMessage?: string } {
  const t = translateDepth(thoughtLevel, channel)
  if (t.kind === "no-mapping") return { translation: null, findingMessage: t.message }
  return { translation: t }
}
