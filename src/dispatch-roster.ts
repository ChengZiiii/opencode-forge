// Pure roster core for the forge dispatch suite.
//
// No @opencode-ai imports and no fs — everything is data in, data out, so the
// tests exercise the exact code the plugin runs (same seam style as
// goal-file.ts). The host wiring layer (plugin.ts) owns fetching models.dev
// and enumerating configured identities; this module only ever sees plain
// objects.
//
// Concepts (spec: openspec/changes/add-dispatch-suite/specs/dispatch/spec.md,
// design D4/D6, wargame §2.1/§2.2):
//
//   identity      "provider/model" — opencode's dispatch key. Bare model-name
//                 matching does not exist here; the same model name on two
//                 providers is two independent entries.
//   expose        the reasoning levels an identity offers to dispatch, written
//                 as NATIVE level names passed through verbatim. Omitted =>
//                 the identity's full native ladder from the catalog.
//   tier          discipline + permission shape (scout/build/review/quick by
//                 default, open map). Tiers NEVER carry a model — the brain
//                 is bound per dispatch by the resolver. Optional pin:
//                 { model, depth } skips resolution (ZCode-style bundle).
//   ladder        an identity's native reasoning level names from the
//                 models.dev catalog (reasoning_options). Unknown => null.
//
// Exact match everywhere: a requested depth either appears verbatim in the
// entry's expose or resolution fails with the full menu. No clamping, no
// translation, no interpolation — misconfigured depth is an error, not a
// suggestion (user ruling 2026-09-27).

export type TierShape = "readonly" | "write"

export type TierDef = {
  shape?: TierShape
  defaultDepth?: string
  // Optional pin: when set, resolution skips the roster and always serves
  // this identity (erroring if unavailable — never falling back).
  model?: string
  depth?: string
}

export type RosterEntry = {
  model: string
  expose?: string[]
  profiles: string[]
}

export type ValidationLevel = "error" | "warn" | "notice"

export type ValidationFinding = {
  level: ValidationLevel
  code: string
  message: string
}

// Minimal slice of the models.dev snapshot this module needs. Prices are
// USD per million tokens (models.dev shape), used only for ranking.
export type CatalogCost = { input?: number; output?: number }
export type CatalogModel = { reasoningOptions?: string[]; cost?: CatalogCost }
export type CatalogSnapshot = { providers: Record<string, { models: Record<string, CatalogModel> }> }

export type ResolvedRosterEntry = {
  model: string
  expose: string[]
  profiles: string[]
  // false = the catalog does not know this identity (custom provider/model):
  // expose was accepted verbatim and could not be validated.
  verified: boolean
}

export type ResolvedTier = {
  shape: TierShape
  defaultDepth?: string
  model?: string
  depth?: string
  // true when the configured defaultDepth was removed by validation (dead
  // default): dispatching this tier without an explicit depth is an error.
  depthRequired?: boolean
}

export type BuiltRoster = {
  roster: ResolvedRosterEntry[]
  tiers: Record<string, ResolvedTier>
  findings: ValidationFinding[]
}

export const DEFAULT_TIERS: Record<string, TierDef> = {
  scout: { shape: "readonly", defaultDepth: "low" },
  build: { shape: "write", defaultDepth: "high" },
  review: { shape: "readonly", defaultDepth: "high" },
  quick: { shape: "write", defaultDepth: "off" },
}

const TIER_ID_RE = /^[a-z0-9-]+$/

// The identity's native ladder, or null when the catalog does not know it.
export function nativeLadder(catalog: CatalogSnapshot, identity: string): string[] | null {
  const parsed = parseIdentity(identity)
  if (!parsed) return null
  const entry = catalog.providers?.[parsed.provider]?.models?.[parsed.model]
  if (!entry) return null
  const options = entry.reasoningOptions
  return Array.isArray(options) ? [...options] : null
}

export function identityCost(catalog: CatalogSnapshot, identity: string): CatalogCost | undefined {
  const parsed = parseIdentity(identity)
  if (!parsed) return undefined
  return catalog.providers?.[parsed.provider]?.models?.[parsed.model]?.cost
}

export function parseIdentity(identity: string): { provider: string; model: string } | null {
  const slash = identity.indexOf("/")
  if (slash <= 0 || slash === identity.length - 1) return null
  return { provider: identity.slice(0, slash), model: identity.slice(slash + 1) }
}

function catalogKnowsIdentity(catalog: CatalogSnapshot, identity: string): boolean {
  const parsed = parseIdentity(identity)
  if (!parsed) return false
  return Boolean(catalog.providers?.[parsed.provider]?.models?.[parsed.model])
}

// Build the effective dispatch configuration from user overrides + catalog.
//
// `configuredIdentities` are the provider/model identities opencode actually
// has configured (availability discovery uses the full catalog + config, never
// the availability-gated provider list — keyless providers must stay visible).
//
// Order of operations:
//   1. tiers = defaults + user tiers (custom tier without shape => readonly)
//   2. roster = user entries (declaration order preserved) + generated
//      defaults for every configured identity the user did not list
//   3. the five validation checks run over the composed config
export function buildDispatchConfig(opts: {
  configuredIdentities: string[]
  catalog: CatalogSnapshot
  userTiers?: Record<string, TierDef>
  userRoster?: RosterEntry[]
}): BuiltRoster {
  const findings: ValidationFinding[] = []
  const catalog = opts.catalog ?? { providers: {} }

  // 1. Tiers.
  const tiers: Record<string, ResolvedTier> = {}
  for (const [id, def] of Object.entries(DEFAULT_TIERS)) {
    tiers[id] = { ...def, shape: def.shape ?? "readonly" }
  }
  for (const [id, def] of Object.entries(opts.userTiers ?? {})) {
    if (!TIER_ID_RE.test(id)) {
      findings.push({
        level: "warn",
        code: "tier-id-charset",
        message: `tier id "${id}" violates [a-z0-9-] (it materializes as forge-<tier> agent ids)`,
      })
    }
    const shape = def.shape ?? "readonly"
    if (def.shape === undefined) {
      findings.push({
        level: "warn",
        code: "shape-defaulted",
        message: `custom tier "${id}" has no shape; defaulting to readonly (write requires explicit "shape": "write")`,
      })
    }
    tiers[id] = { ...def, shape }
  }

  // 2. Roster: explicit user entries only (declaration order = priority).
  //    add-dispatch-onboarding removed the zero-config auto-generation of
  //    entries for unlisted configured identities (owner ruling: configured
  //    != usable); dispatch configuration lives in forge.json, and this
  //    inline roster is the documented legacy path.
  const roster: ResolvedRosterEntry[] = []
  for (const entry of opts.userRoster ?? []) {
    const ladder = nativeLadder(catalog, entry.model)
    const verified = ladder !== null
    if (verified && catalogKnowsIdentity(catalog, entry.model)) {
      const legal = ladder!
      if (legal.length === 0) {
        // Toggle/budget models: the catalog names no levels — the USER names
        // them (wargame §2.2). Accept verbatim, disclose the basis.
        findings.push({
          level: "notice",
          code: "unnamed-levels-accepted",
          message: `roster entry ${entry.model} has no cataloged named reasoning levels (toggle/budget model); expose accepted verbatim without validation`,
        })
        roster.push({ model: entry.model, expose: [...(entry.expose ?? [])], profiles: [...entry.profiles], verified: true })
      } else {
        // expose ⊆ native ladder — typos are config errors, fail fast.
        const expose = entry.expose ?? legal
        const illegal = expose.filter((d) => !legal.includes(d))
        if (illegal.length > 0) {
          findings.push({
            level: "error",
            code: "expose-unknown-level",
            message: `roster entry ${entry.model} exposes unknown level(s) ${illegal.map((d) => `"${d}"`).join(", ")}; legal ladder: ${legal.join(", ")}`,
          })
        }
        // Fail-closed: illegal levels are stripped from the effective expose so
        // a typo can never be dispatched; legal curation survives.
        roster.push({
          model: entry.model,
          expose: expose.filter((d) => legal.includes(d)),
          profiles: [...entry.profiles],
          verified: true,
        })
      }
    } else {
      // Unknown to the catalog: accept verbatim + unverified notice (never
      // block self-hosted/custom models, but say plainly we cannot check).
      findings.push({
        level: "notice",
        code: "unverified-identity",
        message: `roster entry ${entry.model} is not in the models.dev snapshot; expose accepted verbatim without validation`,
      })
      roster.push({ model: entry.model, expose: [...(entry.expose ?? [])], profiles: [...entry.profiles], verified: false })
    }
  }

  // 3. Validation over the composed config.
  const tierIds = new Set(Object.keys(tiers))
  for (const entry of roster) {
    if (!opts.configuredIdentities.includes(entry.model)) {
      findings.push({
        level: "warn",
        code: "dead-key",
        message: `roster entry ${entry.model} is not a configured provider/model identity (dead key)`,
      })
    }
    const unknownTiers = entry.profiles.filter((p) => !tierIds.has(p))
    if (unknownTiers.length > 0) {
      findings.push({
        level: "warn",
        code: "unknown-tier-ref",
        message: `roster entry ${entry.model} references nonexistent tier(s): ${unknownTiers.join(", ")}`,
      })
    }
  }

  // defaultDepth must be exposed by at least one candidate serving the tier;
  // otherwise degrade to depth-required (default removed, never replaced).
  for (const [id, tier] of Object.entries(tiers)) {
    if (tier.defaultDepth === undefined) continue
    const served = roster.some((e) => e.profiles.includes(id) && e.expose.includes(tier.defaultDepth!))
    if (!served) {
      findings.push({
        level: "warn",
        code: "dead-default-depth",
        message: `tier "${id}" defaultDepth "${tier.defaultDepth}" is exposed by no candidate; tier degrades to depth-required (dispatches must pass depth explicitly)`,
      })
      tiers[id] = { ...tier, defaultDepth: undefined, depthRequired: true }
    }
  }

  return { roster, tiers, findings }
}
