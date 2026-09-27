// Tier agent definition builder (spec: dispatch — "Tier materialization as
// the permission vehicle", design D3). Tier agents are the ONLY permission
// vehicle on 1.18.32 (POST /session rejects a permission field), so each
// materialized forge-<tier> carries a deny-style permission with task: deny
// (physical recursion ban) and NEVER a model field — the brain is bound per
// dispatch by the request body.

import type { ResolvedTier } from "./dispatch-roster.ts"

const MUTATING_TOOLS = ["write", "edit", "bash"] as const

// Per-tier discipline prompts (short; the per-dispatch discipline template in
// dispatch-prompt.ts carries the mandates — this prompt frames the agent).
const TIER_PROMPTS: Record<string, string> = {
  scout:
    "You are forge-scout, a readonly reconnaissance worker. Search, read, and run read-only commands; report findings with file:line evidence. You never modify anything — write tools are denied by design.",
  build:
    "You are forge-build, an implementation worker. Execute the dispatched task exactly: minimal, focused changes with tests where the task implies them. Do not expand scope.",
  review:
    "You are forge-review, a readonly review worker. Read the diff or files under review, run read-only checks/tests, and report findings as a prioritized list with file:line evidence and a single-line verdict. Write tools are denied by design.",
  quick:
    "You are forge-quick, a mechanical small-change worker. Make the smallest correct edit the task names (rename, constant, one-liner fix). No refactoring, no drive-by improvements.",
}

export function tierAgentPrompt(tierId: string): string {
  return TIER_PROMPTS[tierId] ?? `You are forge-${tierId}, a dispatched worker. Execute the dispatched task exactly as scoped.`
}

// ---------------------------------------------------------------------------
// forge.json agent materialization (add-dispatch-onboarding, spec delta —
// ADDED "Agent materialization as the permission vehicle" + MODIFIED "Worker
// prompt discipline"). Role prompt layering: an explicit def.prompt overrides
// everything; built-in roles (research, review) carry curated defaults; a
// custom agent without a prompt gets the generic worker prompt.
// ---------------------------------------------------------------------------

const ROLE_PROMPTS: Record<string, string> = {
  research:
    "You are a research worker: search, read, and run read-only checks to answer the dispatched question. Report findings as a compact brief with sources and file:line evidence; state plainly what could not be verified.",
  review:
    "You are a review worker: read the diff or files under review, run read-only checks/tests, and report findings as a prioritized list, each with file:line evidence and a concrete fix suggestion. End with a single-line verdict.",
}

export function rolePromptFor(agentId: string, def?: { prompt?: string }): string {
  if (def?.prompt && def.prompt.trim().length > 0) return def.prompt
  return ROLE_PROMPTS[agentId] ?? `You are forge-${agentId}, a dispatched worker. Execute the dispatched task exactly as scoped.`
}

export function tierAgentDef(tierId: string, tier: ResolvedTier): Record<string, unknown> {
  const permission: Record<string, string> = { task: "deny" }
  if (tier.shape === "readonly") {
    for (const t of MUTATING_TOOLS) permission[t] = "deny"
  }
  const shapeLine =
    tier.shape === "readonly"
      ? "Readonly tier: mutating tools are denied by design — report findings, never work around restrictions."
      : "Write tier: execute the scoped task with minimal, focused changes."
  const defaultLine = tier.defaultDepth ? ` Default reasoning depth: ${tier.defaultDepth}.` : ""
  return {
    description: `forge dispatch tier "${tierId}" (${tier.shape}) — spawned by forge_dispatch, not user-facing.${defaultLine}`,
    mode: "subagent",
    hidden: true,
    prompt: `${tierAgentPrompt(tierId)}\n\n${shapeLine}`,
    permission,
  }
}
