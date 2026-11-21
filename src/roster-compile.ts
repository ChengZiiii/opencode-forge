// Native roster compiler (change native-first-roster, design D2/D3/D6).
//
// Pure core: a resolved pool recipe (src/forge-config.ts createPoolResolver
// output — the SEMANTIC AUTHORITY, untouched) compiles into namespaced
// native agent files `.opencode/agent/forge-<ns>-<id>.md`. Data in, data
// out; every fs dependency is injectable; NO @opencode-ai imports.
//
// Output contract per entry (probe evidence:
// reports/probe-native-agent-surface.md, host 2.3.2, 2026-11-21):
//   - frontmatter carries ONLY probe-proven keys: description, mode,
//     model, tools. Unknown keys are dropped by the host once
//     `permissions` is present (probe §3) — and `permissions` itself is
//     deliberately NOT emitted (the tools face expresses the seals).
//   - `mode: subagent` is ALWAYS stamped: the default is primary, and a
//     primary worker makes task dispatch silently fall back to general
//     (probe §6 — the single nastiest hand-writer trap).
//   - `model: provider/model[#variant]` for pinned workers; the variant
//     channel is the robust depth surface (probe §2/§3 — runtime-proven
//     end to end). Depth words OUTSIDE the variant set ride the existing
//     per-spawn chat.params injection (design D3) and emit nothing here.
//     Auto workers (no model) emit no model key — the host inherits the
//     parent session's model.
//   - tools face per shape in the CURRENT host vocabulary (probe §5):
//     readonly seals the mutating family + the `execute` Code-Mode shell
//     channel + `task` (which the host maps to its real dispatch tool
//     `subagent`); write workers seal `task` and the legacy shell keys —
//     execution belongs to the forge_shell partition, which stays
//     name-keyed on the `forge-` prefix.
//   - prompt body: the dispatch mandates + shape frame + role prompt are
//     BAKED at compile time (native workers have no runtime injection).
//   - a GENERATED header directs edits to the recipe, never the file.
//
// Sync semantics (design D4): atomic writes (temp+rename), garbage
// collection of orphaned forge-* files for entries that left the recipe
// (only OUR generated files — hand-written files are never touched), and
// a staleness predicate (recipe mtime vs newest matching artifact mtime,
// or artifacts missing while the recipe is non-empty).

import type { ForgeAgentDef, PoolFamilyOrigin, PoolResolution } from "./forge-config.ts"
import { BUILTIN_OVERRIDE_IDS } from "./forge-config.ts"
import { MUTATING_TOOLS, agentDescriptionFor, rolePromptFor, type PoolProvenance } from "./dispatch-tiers.ts"
import { materializeAgentPrompt } from "./dispatch-prompt.ts"

// ---------------------------------------------------------------------------
// NATIVE_TOOL_VOCAB (design D6): the SINGLE constant collecting every host
// tool name the compiler may emit. Vocabulary drift is a first-class risk —
// the host renamed bash→execute and task→subagent within one minor era —
// so a drift-mirror test (tests/roster-compile.test.mjs) locks this
// constant to the probe evidence verbatim. forge_sync re-emits from here
// after a host rename; the README documents the current names.
// ---------------------------------------------------------------------------
export const NATIVE_TOOL_VOCAB = {
  // Probe §1/§5: the host's dispatch tool is named `subagent` (the
  // frontmatter key `task:false` is MAPPED to it by the host).
  dispatchTool: "subagent",
  // Probe §5: `tools.task:false` maps to the dispatch-tool deny action.
  taskKey: "task",
  // Probe §5: the host's current shell channel is the Code Mode runtime
  // `execute`; the legacy `bash:false → shell deny` mapping does NOT
  // cover it, so readonly workers must deny `execute` explicitly.
  shellChannel: "execute",
  // Legacy shell keys hidden on EVERY worker (execution belongs to the
  // forge_shell partition; the `forge-` id prefix still triggers the
  // plugin's tool-partition injections on v1 hosts).
  legacyShellKeys: ["shell", "bash"],
  // The full mutating family (postrelease-hardening D3 — mirrors
  // dispatch-tiers MUTATING_TOOLS; the drift test locks the equality).
  mutatingFamily: [...MUTATING_TOOLS],
} as const

// Design D3: recipe depth words that map to model VARIANT values compile
// into the model string (`provider/model#low`). Everything else in the
// 7-word dictionary (none/minimal/xhigh/max) keeps riding the per-spawn
// chat.params injection with its existing disclosure.
export const VARIANT_DEPTH_WORDS: readonly string[] = ["low", "medium", "high"]

// Injectable fs surface (tests drive the exact code the plugin runs).
export type RosterFsDeps = {
  stat?: (path: string) => { mtimeMs: number; size: number } | null
  readFile?: (path: string) => string
  writeFile?: (path: string, data: string) => void
  rename?: (from: string, to: string) => void
  unlink?: (path: string) => void
  readdir?: (path: string) => string[] | null
  mkdir?: (path: string) => void
}

// The GENERATED marker: present in every file this compiler owns. GC only
// ever deletes forge-*.md files carrying it — a hand-written file (even a
// hand-EDITED generated one with the marker stripped) is never touched.
export const GENERATED_MARKER = "<!-- GENERATED BY forge_sync"

export function generatedHeader(recipeFile: string): string {
  return `${GENERATED_MARKER} — edit the recipe (${recipeFile}), not this file. -->`
}

// Model string for one definition: `provider/model[#variant]` for pinned
// workers whose depth word maps to a variant; plain `provider/model` for
// pinned workers on non-variant words; undefined for Auto workers (no
// model key — host inheritance).
export function modelStringFor(def: ForgeAgentDef): string | undefined {
  if (def.model === undefined) return undefined
  if (def.thoughtLevel !== undefined && VARIANT_DEPTH_WORDS.includes(def.thoughtLevel)) {
    return `${def.model}#${def.thoughtLevel}`
  }
  return def.model
}

// Tools face per shape, in NATIVE_TOOL_VOCAB spellings:
//   readonly — mutating family + `execute` + `task` all false (a readonly
//     child then genuinely has no write tool at all — probe §5);
//   write (the default — shape-default-open) — `task` false (recursion
//     ban) + the legacy shell keys false (forge_shell owns execution;
//     the `forge-` prefix still keys the plugin-side tool partition).
export function toolsFaceFor(shape: AgentShapeOrWrite): Record<string, boolean> {
  const face: Record<string, boolean> = {}
  face[NATIVE_TOOL_VOCAB.taskKey] = false
  for (const k of NATIVE_TOOL_VOCAB.legacyShellKeys) face[k] = false
  if (shape === "readonly") {
    for (const t of NATIVE_TOOL_VOCAB.mutatingFamily) face[t] = false
    face[NATIVE_TOOL_VOCAB.shellChannel] = false
  }
  return face
}
type AgentShapeOrWrite = "readonly" | "write"

// Frontmatter block (probe-proven keys ONLY — description, mode, model,
// tools; YAML double-quoted strings via JSON.stringify, nested tools map).
function frontmatterFor(input: { description: string; model?: string; tools: Record<string, boolean> }): string {
  const lines = ["---", `description: ${JSON.stringify(input.description)}`, "mode: subagent"]
  if (input.model !== undefined) lines.push(`model: ${JSON.stringify(input.model)}`)
  lines.push("tools:")
  for (const [k, v] of Object.entries(input.tools)) lines.push(`  ${k}: ${v}`)
  lines.push("---")
  return lines.join("\n")
}

// Compile ONE materialized pool agent into its file name + full content.
export function compileRosterEntry(input: {
  matId: string
  def: ForgeAgentDef
  provenance: PoolProvenance
  shared?: string
}): { fileName: string; content: string } {
  const shape: AgentShapeOrWrite = input.def.shape === "readonly" ? "readonly" : "write"
  const description = agentDescriptionFor(input.matId, input.def, input.provenance)
  const model = modelStringFor(input.def)
  const tools = toolsFaceFor(shape)
  const recipeFile = "global" in input.provenance ? "the global fallback layer" : input.provenance.file
  const body = materializeAgentPrompt({
    agent: input.matId,
    shape,
    role: rolePromptFor(input.matId, input.def, input.shared),
  })
  return {
    fileName: `forge-${input.matId}.md`,
    content: `${frontmatterFor({ description, model, tools })}\n\n${generatedHeader(recipeFile)}\n\n${body}\n`,
  }
}

// ---------------------------------------------------------------------------
// Built-in override emission (change builtin-override, design D2): the
// GLOBAL recipe's `override` entries compile to SAME-NAME, NON-NAMESPACED
// files in the host's global agent dir, case-locked to the built-in's exact
// LOWERCASE id stem — the probe-established identity key
// (reports/probe-builtin-override.md): only `general.md` / `explore.md`
// truly override the built-ins; a capitalized variant creates an ambiguous
// duplicate entry (the negative form) and is NEVER emitted (compileOverride
// returns null for any id outside BUILTIN_OVERRIDE_IDS). model+variant and
// the tools face follow the SAME rules as workers; the GC predicate for
// override files keys on the in-content GENERATED marker (they carry no
// `forge-` prefix).
// ---------------------------------------------------------------------------

// The minimal default body when an activated override entry carries no
// prompt of its own (D3: activating an override replaces the built-in's
// prompt wholesale — we never copy vendor text; this is only a floor, the
// handbook tells the user to write their own).
const OVERRIDE_DEFAULT_PROMPTS: Record<string, string> = {
  general: "You are the user-overridden built-in General subagent. Do the dispatched work directly and report a compact result with evidence.",
  explore: "You are the user-overridden built-in Explore subagent. Search and read the codebase for the dispatched question; report a compact brief with file:line evidence.",
}

export function compileOverrideEntry(input: { id: string; def: ForgeAgentDef; recipeFile: string }): { fileName: string; content: string } | null {
  // Case-lock: the exact builtin lowercase id only — a capitalized id
  // never compiles (never emitted, by construction).
  if (!(BUILTIN_OVERRIDE_IDS as readonly string[]).includes(input.id)) return null
  const shape: AgentShapeOrWrite = input.def.shape === "readonly" ? "readonly" : "write"
  const description = `Built-in ${input.id} override — pinned by the global forge.json "override" node (${input.def.model !== undefined ? "pinned model" : "Auto worker"}).`
  const model = modelStringFor(input.def)
  const tools = toolsFaceFor(shape)
  const body = input.def.prompt !== undefined && input.def.prompt.trim().length > 0 ? input.def.prompt : OVERRIDE_DEFAULT_PROMPTS[input.id]
  return {
    fileName: `${input.id}.md`,
    content: `${frontmatterFor({ description, model, tools })}\n\n${generatedHeader(input.recipeFile)}\n\n${body}\n`,
  }
}

// The agent directory holding a pool file's compiled artifacts: the
// sibling `agent` directory of the `.opencode` (or config) directory the
// recipe lives in — workspace pools compile into
// `<ws>/.opencode/agent/`, the global fallback layer into
// `<home>/.config/opencode/agent/` (the host's global agent layer,
// probe §7).
export function agentDirFor(poolFile: string): string {
  const sep = poolFile.includes("\\") && !poolFile.includes("/") ? "\\" : "/"
  const parts = poolFile.split(/[\\/]/)
  parts.pop() // forge.json
  const dirName = parts.pop() // ".opencode" or "opencode"
  const base = parts.join(sep)
  return `${base}${sep}${dirName}${sep}agent`
}

// builtin-override D5 (probe correction, reports/probe-builtin-override.md
// §修正1): the host's GLOBAL agent dir mirrors the host's own resolution —
// `OPENCODE_CONFIG_DIR` set → `$CONFIG_DIR/agent` (the fake home's
// `.config` path is NOT read in that mode); unset →
// `<home>/.config/opencode/agent`. Override artifacts (general.md /
// explore.md) land HERE, which may differ from agentDirFor(globalPoolFile)
// on hosts that point OPENCODE_CONFIG_DIR elsewhere.
export function globalAgentDirFor(opts: { homeDir: string; configDir?: string | null }): string {
  const cfg = (opts.configDir ?? "").trim()
  if (cfg) {
    const sep = cfg.includes("\\") && !cfg.includes("/") ? "\\" : "/"
    return cfg.endsWith(sep) ? `${cfg}agent` : `${cfg}${sep}agent`
  }
  const sep = opts.homeDir.includes("\\") && !opts.homeDir.includes("/") ? "\\" : "/"
  const base = opts.homeDir.endsWith(sep) ? opts.homeDir : `${opts.homeDir}${sep}`
  return `${base}.config${sep}opencode${sep}agent`
}

export type FamilySyncPlan = {
  kind: "family"
  family: PoolFamilyOrigin
  dir: string
  files: { matId: string; fileName: string; content: string }[]
}

// builtin-override D2/D4: the override sync plan targets the host's GLOBAL
// agent dir (globalAgentDirFor) with non-namespaced lowercase files. Two
// semantic deltas vs a family plan, both keyed on kind:"override":
//   - collision redline — an existing destination WITHOUT the GENERATED
//     marker is a HAND-WRITTEN file: sync refuses + discloses, never
//     overwrites (byte-identical preserved);
//   - GC keys on the in-content GENERATED marker over the builtin id stems
//     only (`general.md`/`explore.md`) — no `forge-` prefix exists on these
//     files, and every other file in the dir (incl. the forge-global-*
//     artifacts the fallback family owns) is invisible to this plan.
export type OverrideSyncPlan = {
  kind: "override"
  dir: string
  files: { fileName: string; content: string }[]
}

export type SyncPlan = FamilySyncPlan | OverrideSyncPlan

// Plan the override sync from a resolution's `overrides` map. Pure: no fs.
// Returns null when the recipe activates no override entry (zero emission).
export function planOverrideSync(overrides: Record<string, ForgeAgentDef>, opts: { dir: string; recipeFile: string }): OverrideSyncPlan | null {
  const files: OverrideSyncPlan["files"] = []
  for (const id of BUILTIN_OVERRIDE_IDS) {
    const def = overrides[id]
    if (def === undefined) continue
    const compiled = compileOverrideEntry({ id, def, recipeFile: opts.recipeFile })
    if (compiled !== null) files.push(compiled)
  }
  return files.length > 0 ? { kind: "override", dir: opts.dir, files } : null
}

// Provenance for one family (same rule as the v1 config hook: the global
// fallback file's ns is FIXED to "global" and its provenance names the
// global layer, not a file).
function provenanceFor(family: PoolFamilyOrigin, globalPoolFile: string): PoolProvenance {
  return family.file === globalPoolFile ? { global: true } : { ns: family.ns, file: family.file }
}

// Plan the WHOLE sync (all families of a resolution). Pure: no fs. The
// executor (below) writes the plan.
export function planRosterSync(resolution: PoolResolution, opts: { globalPoolFile: string }): FamilySyncPlan[] {
  const plans: FamilySyncPlan[] = []
  for (const family of resolution.families) {
    const provenance = provenanceFor(family, opts.globalPoolFile)
    const files = family.materializedIds.map((matId) => {
      const agent = resolution.agents[matId]
      const compiled = compileRosterEntry({ matId, def: agent.def, provenance, shared: agent.shared ?? undefined })
      return { matId, ...compiled }
    })
    plans.push({ kind: "family", family, dir: agentDirFor(family.file), files })
  }
  return plans
}

export type SyncOutcome = {
  created: string[]
  updated: string[]
  unchanged: string[]
  gced: string[]
  errors: string[]
}

function joinPath(dir: string, name: string): string {
  const sep = dir.includes("\\") && !dir.includes("/") ? "\\" : "/"
  return dir.endsWith(sep) ? `${dir}${name}` : `${dir}${sep}${name}`
}

// Execute a sync plan: atomic writes (temp + rename; the rename falls
// back to unlink+rename on platforms where rename refuses an existing
// destination — the temp file means a FAILED write never leaves a
// half-written artifact), plus GC of orphaned generated forge-*.md files.
// Fail-soft per file: one bad file records an error, its siblings still
// apply. Override plans (kind:"override") add the collision redline (a
// hand-written same-name file is refused + disclosed, never overwritten)
// and marker-keyed GC over the builtin id stems.
export function executeRosterSync(plans: SyncPlan[], deps: RosterFsDeps = {}): SyncOutcome {
  const stat = deps.stat ?? (() => null)
  const readFile = deps.readFile ?? (() => {
    throw new Error("readFile unavailable")
  })
  const writeFile = deps.writeFile ?? (() => {
    throw new Error("writeFile unavailable")
  })
  const rename = deps.rename ?? (() => {
    throw new Error("rename unavailable")
  })
  const unlink = deps.unlink ?? (() => {
    throw new Error("unlink unavailable")
  })
  const readdir = deps.readdir ?? (() => null)
  const mkdir = deps.mkdir ?? (() => {})
  const out: SyncOutcome = { created: [], updated: [], unchanged: [], gced: [], errors: [] }
  for (const plan of plans) {
    try {
      mkdir(plan.dir)
    } catch {
      // Exists or unavailable — the writes below surface real failures.
    }
    const wanted = new Set(plan.files.map((f) => f.fileName))
    for (const file of plan.files) {
      const dest = joinPath(plan.dir, file.fileName)
      let tmp: string | null = null
      try {
        const existing = stat(dest) !== null ? readFile(dest) : null
        // Collision redline (builtin-override D4): an existing destination
        // WITHOUT the GENERATED marker is hand-written — refuse + disclose,
        // never overwrite (byte-identical preserved), siblings still apply.
        if (plan.kind === "override" && existing !== null && !existing.includes(GENERATED_MARKER)) {
          out.errors.push(`${dest}: collision refused — a hand-written file of this exact name already exists; sync never overwrites it. Fold your changes into the global recipe's "override" entry, or rename/remove the hand-written file.`)
          continue
        }
        if (existing === file.content) {
          out.unchanged.push(dest)
          continue
        }
        tmp = `${dest}.new`
        writeFile(tmp, file.content)
        try {
          rename(tmp, dest)
        } catch {
          // Destination exists and the platform refuses the overwrite
          // (win32 EEXIST/EPERM): clear it, then land the temp file.
          try {
            unlink(dest)
          } catch {}
          rename(tmp, dest)
        }
        tmp = null // landed — nothing to clean up
        if (existing === null) out.created.push(dest)
        else out.updated.push(dest)
      } catch (err) {
        // Best-effort temp cleanup: a failed write may leave a partial
        // `<name>.md.new` behind; the destination itself is never
        // half-written (atomic rename semantics).
        if (tmp !== null) {
          try {
            unlink(tmp)
          } catch {}
        }
        out.errors.push(`${dest}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    // GC: generated forge-*.md files no longer in the recipe go away
    // ("删池文件即失池" mirror). Only files carrying the GENERATED marker —
    // hand-written files (marker absent) are never touched. Override plans
    // (kind:"override") key the SAME marker predicate on the builtin id
    // stems only (no forge- prefix exists on those files); everything else
    // in the directory — including the forge-global-* artifacts the global
    // fallback family plan owns — is invisible to this plan.
    const gcEligible = (name: string): boolean => {
      if (!name.endsWith(".md")) return false
      if (plan.kind === "override") return (BUILTIN_OVERRIDE_IDS as readonly string[]).some((id) => name === `${id}.md`)
      return name.startsWith("forge-")
    }
    try {
      const listing = readdir(plan.dir)
      if (listing !== null) {
        for (const name of listing) {
          if (!gcEligible(name)) continue
          if (wanted.has(name)) continue
          const dest = joinPath(plan.dir, name)
          try {
            if (!readFile(dest).includes(GENERATED_MARKER)) continue
            unlink(dest)
            out.gced.push(dest)
          } catch (err) {
            out.errors.push(`${dest}: ${err instanceof Error ? err.message : String(err)}`)
          }
        }
      }
    } catch {
      // An unreadable directory never blocks the rest of the sync.
    }
  }
  return out
}

export type StaleVerdict = {
  stale: boolean
  reason: string
}

// Staleness for ONE pool (design D4): stale iff artifacts are missing
// while the recipe contributes agents, or the recipe is newer than the
// newest artifact AND the compiled content actually differs (mtime is the
// cheap trigger; when `expectedContentOf` is supplied the final verdict
// is CONTENT-based — an mtime-newer recipe whose compiled output is
// byte-identical, e.g. a touched file or a checkout with skewed mtimes,
// is NOT stale, so a sync round-trip can always clear the gate). A pool
// with no agents is never stale (nothing to compile). A missing/unstatable
// recipe file is never stale (the resolver owns that failure mode).
export function staleCheckForPool(
  poolFile: string | null,
  expectedMatIds: string[],
  deps: RosterFsDeps = {},
  expectedContentOf?: (matId: string) => string,
): StaleVerdict {
  if (poolFile === null) return { stale: false, reason: "no workspace pool — global-fallback roster, no per-workspace artifacts gate" }
  const stat = deps.stat ?? (() => null)
  const readFile = deps.readFile ?? (() => {
    throw new Error("readFile unavailable")
  })
  const recipe = stat(poolFile)
  if (recipe === null) return { stale: false, reason: "recipe file not statable" }
  if (expectedMatIds.length === 0) return { stale: false, reason: "recipe contributes no agents" }
  const dir = agentDirFor(poolFile)
  let newest = -Infinity
  let missing: string[] = []
  for (const matId of expectedMatIds) {
    const st = stat(joinPath(dir, `forge-${matId}.md`))
    if (st === null) missing.push(`forge-${matId}.md`)
    else if (st.mtimeMs > newest) newest = st.mtimeMs
  }
  if (missing.length > 0) {
    return { stale: true, reason: `missing artifact(s): ${missing.join(", ")} — the recipe has agents but no compiled file for them` }
  }
  if (recipe.mtimeMs > newest) {
    if (expectedContentOf) {
      for (const matId of expectedMatIds) {
        try {
          if (readFile(joinPath(dir, `forge-${matId}.md`)) !== expectedContentOf(matId)) {
            return { stale: true, reason: `recipe ${poolFile} changed — the compiled forge-${matId}.md differs from what it compiles to` }
          }
        } catch {
          return { stale: true, reason: `artifact for forge-${matId} unreadable` }
        }
      }
      return { stale: false, reason: "recipe mtime is newer but the compiled content is current (touch/skew, not a change)" }
    }
    return { stale: true, reason: `recipe ${poolFile} is newer (mtime ${recipe.mtimeMs}) than the newest compiled artifact (mtime ${newest})` }
  }
  return { stale: false, reason: "artifacts are at least as new as the recipe" }
}
