// Pure exact-match resolver for the forge dispatch suite (spec: dispatch —
// "Exact-match resolution with no clamping", design D4).
//
// resolve(tier, depth, exclude) picks roster candidates that serve the tier,
// are available, are not excluded, and whose expose contains the requested
// depth VERBATIM. Ranking is declaration order, then cost. No candidate =>
// structured error carrying the full menu (each candidate's exposure and the
// reason it was not chosen) plus the whole exposed vocabulary. There is no
// clamping, interpolation, or substitution anywhere — a mis-set depth is an
// error the calling agent must act on, not something the plugin fixes.

import { type BuiltRoster, type CatalogSnapshot, identityCost } from "./dispatch-roster.ts"
import type { ForgeAgentDef } from "./forge-config.ts"

export type MenuLine = {
  identity: string
  expose: string[]
  verified: boolean
  reason: string
}

export type ResolveOk = {
  ok: true
  identity: string
  depth: string
  pinned: boolean
}

export type ResolveErr = {
  ok: false
  error: {
    // no-candidate | pin-unavailable | pin-depth-mismatch | unknown-tier | depth-required
    code: string
    message: string
    menu: MenuLine[]
    vocabulary: string[]
  }
}

export type ResolveRequest = {
  profile: string
  depth?: string
  // Identities to skip (the one-retry semantics: the caller re-resolves with
  // the failed identity excluded — at most one retry per dispatch, enforced
  // by the tool layer, not here).
  exclude?: string[]
}

// Union of every exposed level name — rendered into the forge_dispatch tool
// description so the main agent always sees the menu before it picks.
export function exposedVocabulary(cfg: BuiltRoster): string[] {
  const set = new Set<string>()
  for (const entry of cfg.roster) for (const d of entry.expose) set.add(d)
  return [...set]
}

function menuFor(cfg: BuiltRoster, tierId: string, depth: string | undefined, exclude: string[], available: (identity: string) => boolean): MenuLine[] {
  const lines: MenuLine[] = []
  for (const entry of cfg.roster) {
    if (!entry.profiles.includes(tierId)) continue
    let reason: string
    if (exclude.includes(entry.model)) reason = "excluded after a failed attempt"
    else if (!available(entry.model)) reason = "identity currently unavailable"
    else if (depth !== undefined && !entry.expose.includes(depth)) reason = `depth "${depth}" not exposed`
    else reason = "eligible"
    lines.push({ identity: entry.model, expose: [...entry.expose], verified: entry.verified, reason })
  }
  return lines
}

function costRank(catalog: CatalogSnapshot, identity: string): number {
  // Declaration order is the primary key; cost only breaks (nonexistent)
  // ties in a stable, explicit way. Missing prices sort last.
  const cost = identityCost(catalog, identity)
  if (!cost || typeof cost.input !== "number" || typeof cost.output !== "number") return Number.POSITIVE_INFINITY
  return cost.input + cost.output
}

export function resolveDispatch(
  cfg: BuiltRoster,
  req: ResolveRequest,
  available: (identity: string) => boolean,
  // Catalog slice for cost ranking; defaults to empty so tests without
  // prices stay pure (missing prices sort last).
  catalog: CatalogSnapshot = { providers: {} },
): ResolveOk | ResolveErr {
  const tier = cfg.tiers[req.profile]
  if (!tier) {
    return {
      ok: false,
      error: {
        code: "unknown-tier",
        message: `unknown tier "${req.profile}"; known tiers: ${Object.keys(cfg.tiers).join(", ")}`,
        menu: [],
        vocabulary: exposedVocabulary(cfg),
      },
    }
  }
  const exclude = req.exclude ?? []

  // Pin path: skip roster resolution entirely; unavailable pin is an error
  // naming the pin — never a fallback to another model.
  if (tier.model) {
    const pinnedIdentity = tier.model
    const entry = cfg.roster.find((e) => e.model === pinnedIdentity)
    const expose = entry?.expose ?? []
    const menu: MenuLine[] = [
      { identity: pinnedIdentity, expose, verified: entry?.verified ?? false, reason: "pinned tier target" },
    ]
    if (!available(pinnedIdentity)) {
      return {
        ok: false,
        error: {
          code: "pin-unavailable",
          message: `tier "${req.profile}" is pinned to ${pinnedIdentity}, which is currently unavailable; fix or unpin the tier — no fallback model will be used`,
          menu,
          vocabulary: exposedVocabulary(cfg),
        },
      }
    }
    const depth = req.depth ?? tier.depth
    if (depth === undefined) {
      return {
        ok: false,
        error: {
          code: "depth-required",
          message: `tier "${req.profile}" is pinned without a depth and none was requested; pass depth explicitly`,
          menu,
          vocabulary: exposedVocabulary(cfg),
        },
      }
    }
    if (!expose.includes(depth)) {
      return {
        ok: false,
        error: {
          code: "pin-depth-mismatch",
          message: `pinned model ${pinnedIdentity} does not expose depth "${depth}" (expose: ${expose.join(", ") || "none"}); exact match only — no clamping`,
          menu,
          vocabulary: exposedVocabulary(cfg),
        },
      }
    }
    return { ok: true, identity: pinnedIdentity, depth, pinned: true }
  }

  // Dynamic path.
  const depth = req.depth ?? tier.defaultDepth
  if (depth === undefined) {
    return {
      ok: false,
      error: {
        code: "depth-required",
        message: `tier "${req.profile}" has no usable default depth (its default was removed at validation); pass depth explicitly`,
        menu: menuFor(cfg, req.profile, undefined, exclude, available),
        vocabulary: exposedVocabulary(cfg),
      },
    }
  }

  const candidates = cfg.roster
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => entry.profiles.includes(req.profile))
    .filter(({ entry }) => !exclude.includes(entry.model))
    .filter(({ entry }) => available(entry.model))
    .filter(({ entry }) => entry.expose.includes(depth))
    .sort((a, b) => a.index - b.index || costRank(catalog, a.entry.model) - costRank(catalog, b.entry.model))

  if (candidates.length === 0) {
    return {
      ok: false,
      error: {
        code: "no-candidate",
        message: `no candidate serves tier "${req.profile}" at depth "${depth}"; pick a depth from the menu's exposures (exact match — the plugin never clamps)`,
        menu: menuFor(cfg, req.profile, depth, exclude, available),
        vocabulary: exposedVocabulary(cfg),
      },
    }
  }
  return { ok: true, identity: candidates[0].entry.model, depth, pinned: false }
}

// ---------------------------------------------------------------------------
// Agents path (add-dispatch-onboarding, spec delta — MODIFIED "Exact-match
// resolution with no clamping"). The model is pinned by the agent definition;
// the ONLY config-side validation is dispatch-time set membership: depth must
// appear in the agent's depths verbatim (default = first entry). No
// alternative-candidate retry exists on this path — a pinned model that fails
// reports the honest error.
// ---------------------------------------------------------------------------

export type AgentResolveOk = {
  ok: true
  model: string
  depth: string
  def: ForgeAgentDef
}

export type AgentResolveErr = {
  ok: false
  error: {
    // unknown-agent | depth-not-in-set | pin-unavailable
    code: string
    message: string
  }
}

export function resolveAgent(
  agents: Record<string, ForgeAgentDef>,
  req: { agent: string; depth?: string },
  available: (identity: string) => boolean,
): AgentResolveOk | AgentResolveErr {
  const def = agents[req.agent]
  if (!def || typeof def !== "object") {
    return {
      ok: false,
      error: {
        code: "unknown-agent",
        message: `unknown dispatch agent "${req.agent}"; defined agents: ${Object.keys(agents).join(", ") || "(none)"}`,
      },
    }
  }
  if (!def.model || typeof def.model !== "string") {
    return {
      ok: false,
      error: {
        code: "pin-unavailable",
        message: `agent "${req.agent}" has no usable model (model: ${JSON.stringify(def.model)}); fix its "model" in forge.json — no fallback model will be used`,
      },
    }
  }
  if (!available(def.model)) {
    return {
      ok: false,
      error: {
        code: "pin-unavailable",
        message: `agent "${req.agent}" is pinned to ${def.model}, which is not configured on this host; fix the agent's "model" in forge.json — no fallback model will be used`,
      },
    }
  }
  const depths = Array.isArray(def.depths) ? def.depths : []
  if (depths.length === 0) {
    return {
      ok: false,
      error: {
        code: "depth-not-in-set",
        message: `agent "${req.agent}" defines no depths; give it at least one depth in forge.json (canonical words: none, low, medium, high, max — or the model's native level names)`,
      },
    }
  }
  const depth = req.depth ?? depths[0]
  if (!depths.includes(depth)) {
    return {
      ok: false,
      error: {
        code: "depth-not-in-set",
        message: `agent "${req.agent}" does not allow depth "${depth}" (allowed: ${depths.join(", ")}) — exact match only, the plugin never clamps`,
      },
    }
  }
  return { ok: true, model: def.model, depth, def }
}
