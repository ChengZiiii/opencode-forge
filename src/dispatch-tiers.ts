// forge subagent materialization source (spec: forge-subagents — "Static
// agent definitions in a dedicated forge.json" + "Materialization as native
// subagents with a pinned model"; changes simplify-dispatch-to-static-agents,
// auto-worker-inheritance).
//
// Each forge.json definition materializes as a subagent-mode agent
// `forge-<id>` that IS visible to the host's native task tool (no hidden
// flag — task-vocabulary discoverability is the point), carries the PINNED
// `model` when the definition is pinned (the brain is bound at
// materialization; there is no per-call model selection) or NO model key at
// all when the definition is an Auto worker (the host inherits the parent
// session's model at dispatch), a standing discipline prompt, and a
// deny-style permission with `task: deny` ALWAYS forced (recursive spawning
// stays physically impossible).

import type { ForgeAgentDef } from "./forge-config.ts"
import { materializeAgentPrompt } from "./dispatch-prompt.ts"

const MUTATING_TOOLS = ["write", "edit", "bash"] as const

// Built-in role defaults: an explicit def.prompt overrides everything;
// research/review carry curated defaults; a custom agent without a prompt
// gets the generic worker role.
const ROLE_PROMPTS: Record<string, string> = {
  research:
    "You are a research worker: search, read, and run read-only checks to answer the assigned question. Report findings as a compact brief with sources and file:line evidence; state plainly what could not be verified.",
  review:
    "You are a review worker: read the diff or files under review, run read-only checks/tests, and report findings as a prioritized list, each with file:line evidence and a concrete fix suggestion. End with a single-line verdict.",
}

export function rolePromptFor(agentId: string, def?: { prompt?: string }): string {
  if (def?.prompt && def.prompt.trim().length > 0) return def.prompt
  return ROLE_PROMPTS[agentId] ?? `You are a ${agentId} worker. Execute the assigned task exactly as scoped.`
}

// Short task-tool description: this is what the dispatching model sees in
// the task tool vocabulary, so it names the role and the brain — the pinned
// identity for pinned workers, the inheritance semantics for Auto workers.
export function agentDescriptionFor(agentId: string, def: ForgeAgentDef): string {
  const shape = def.shape === "write" ? "write" : "readonly"
  const brain = def.model !== undefined ? `pinned ${def.model}` : "auto — inherits the parent session's model at dispatch"
  return `forge subagent "${agentId}" (${shape}, ${brain}) — dispatch via the task tool with subagent_type "forge-${agentId}".`
}

// Materialize one forge.json agent as a config-agent entry. A pinned
// definition carries its `model` (the reversal of the old "agents never
// carry a model" rule: the brain is pinned by the definition, resolved by
// the host at spawn time); an Auto definition carries NO model key at all —
// the host's native spawn behavior binds the parent session's current model
// at dispatch (snapshot semantics). `tools` carries the exec-partition
// surface (tool-partition spec): every worker — regardless of shape — runs
// commands only through forge_shell, so the builtin shell/bash pair is
// hidden at materialization.
export function forgeAgentDef(agentId: string, def: ForgeAgentDef): Record<string, unknown> {
  const permission: Record<string, string> = { task: "deny" }
  const shape = def.shape ?? "readonly"
  if (shape === "readonly") {
    for (const t of MUTATING_TOOLS) permission[t] = "deny"
  }
  Object.assign(permission, def.permission ?? {})
  permission.task = "deny" // an override never lifts the recursion ban
  const entry: Record<string, unknown> = {
    description: agentDescriptionFor(agentId, def),
    mode: "subagent",
    prompt: materializeAgentPrompt({
      agent: agentId,
      shape,
      role: rolePromptFor(agentId, def),
    }),
    permission,
    tools: { shell: false, bash: false },
  }
  if (def.model !== undefined) entry.model = def.model
  return entry
}
