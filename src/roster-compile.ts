// Native roster compiler (change native-first-roster, design D2/D3/D6).
//
// Pure core: a resolved pool recipe (src/forge-config.ts createPoolResolver
// output — the SEMANTIC AUTHORITY, untouched) compiles into namespaced
// native agent files `.opencode/agent/forge-<ns>-<id>.md`. Data in, data
// out; every fs dependency is injectable; NO @opencode-ai imports.
//
// Output contract per entry (probe evidence:
// reports/probe-native-agent-surface.md, host 2.3.2, 2026-11-21):
//   - frontmatter uses probe-confirmed description, mode, model and either
//     native permissions (workers) or the legacy tools map (builtin overrides).
//   - `mode: subagent` is ALWAYS stamped: the default is primary, and a
//     primary worker makes task dispatch silently fall back to general
//     (probe §6 — the single nastiest hand-writer trap).
//   - `model: provider/model[#variant]` for pinned workers; the variant
//     channel is the robust depth surface (probe §2/§3 — runtime-proven
//     end to end). Depth words OUTSIDE the variant set ride the existing
//     per-spawn chat.params injection (design D3) and emit nothing here.
//     Auto workers (no model) emit no model key — the host inherits the
//     parent session's model.
//   - namespaced worker permissions deny recursive dispatch and primary-only
//     harness actions; readonly adds write-family and execute denies. Shell
//     policy remains host-owned unless a recipe states an explicit effect.
//   - prompt body: the dispatch mandates + shape frame + role prompt are
//     BAKED at compile time (native workers have no runtime injection).
//   - a GENERATED header directs edits to the recipe, never the file.
//
// Sync semantics (design D4): atomic writes (temp+rename), garbage
// collection of orphaned forge-* files for entries that left the recipe
// (only OUR generated files — hand-written files are never touched), and
// a staleness predicate (expected compiled content, or recipe mtime vs
// newest matching artifact mtime without a content oracle; missing artifacts
// while the recipe is non-empty are always stale).

import type { ForgeAgentDef, PoolFamilyOrigin, PoolResolution } from "./forge-config.ts"
import { BUILTIN_OVERRIDE_IDS } from "./forge-config.ts"
import { MUTATING_TOOLS, PRIMARY_ONLY_WORKER_TOOLS, workerPermissionFor, agentDescriptionFor, rolePromptFor, type PoolProvenance } from "./dispatch-tiers.ts"
import { materializeAgentPrompt } from "./dispatch-prompt.ts"

// ---------------------------------------------------------------------------
// NATIVE_TOOL_VOCAB (design D6): the SINGLE constant collecting every host
// tool name the compiler may emit. Vocabulary drift is a first-class risk —
// native dispatch is `subagent`, shell is `shell`, and Code Mode is a
// separate `execute` entry (retire-plugin-runtime design, v2.4.0 source).
// The drift-mirror tests lock these recorded spellings; a live registry
// check is separate. forge_sync re-emits from here
// after a host rename; the README documents the current names.
// ---------------------------------------------------------------------------
export const NATIVE_TOOL_VOCAB = {
  // Probe §1/§5: the host's dispatch tool is named `subagent` (the
  // frontmatter key `task:false` is MAPPED to it by the host).
  dispatchTool: "subagent",
  shell: "shell",
  question: "question",
  grep: "grep",
  glob: "glob",
  // Probe §5: `tools.task:false` maps to the dispatch-tool deny action.
  taskKey: "task",
  // Probe §5: the Code Mode runtime `execute` is separate from native
  // `shell`; legacy `bash:false → shell deny` does NOT cover it.
  // The v2.4.0 source records shell access through full Code Mode.
  shellChannel: "execute",
  // Recipe shell aliases; the independent legacy override still emits both.
  legacyShellKeys: ["shell", "bash"],
  // The full mutating family (postrelease-hardening D3 — mirrors
  // dispatch-tiers MUTATING_TOOLS; the drift test locks the equality).
  mutatingFamily: [...MUTATING_TOOLS],
  primaryOnly: [...PRIMARY_ONLY_WORKER_TOOLS],
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

// Git checkout line endings do not change the Markdown projection. Do not
// normalize other content (including the provenance of a moved checkout).
function sameProjection(existing: string, expected: string): boolean {
  return existing.replace(/\r\n/g, "\n") === expected.replace(/\r\n/g, "\n")
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

// Independent legacy builtin override face: preserve its bytes and ordering.
function overrideToolsFaceFor(shape: AgentShapeOrWrite): Record<string, boolean> {
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

// Namespaced workers use the probe-confirmed native permissions array so
// explicit ask rules survive compilation; overrides retain their old tools map.
export function toolsFaceFor(shape: AgentShapeOrWrite, permission?: ForgeAgentDef["permission"]): Record<string, string> {
  const { task: _legacy, ...native } = workerPermissionFor({ shape, permission })
  return native
}

// Frontmatter block (probe-proven keys ONLY — description, mode, model,
// tools or permissions; YAML double-quoted strings via JSON.stringify).
function frontmatterFor(input: { description: string; model?: string; tools?: Record<string, boolean>; permissions?: Record<string, string> }): string {
  const lines = ["---", `description: ${JSON.stringify(input.description)}`, "mode: subagent"]
  if (input.model !== undefined) lines.push(`model: ${JSON.stringify(input.model)}`)
  if (input.tools) {
    lines.push("tools:")
    for (const [k, v] of Object.entries(input.tools)) lines.push(`  ${k}: ${v}`)
  }
  if (input.permissions) {
    lines.push("permissions:")
    for (const [action, effect] of Object.entries(input.permissions)) {
      lines.push(`  - action: ${JSON.stringify(action)}`, '    resource: "*"', `    effect: ${JSON.stringify(effect)}`)
    }
  }
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
  const permissions = toolsFaceFor(shape, input.def.permission)
  const recipeFile = "global" in input.provenance ? "the global fallback layer" : input.provenance.file
  const body = materializeAgentPrompt({
    agent: input.matId,
    shape,
    role: rolePromptFor(input.matId, input.def, input.shared),
  })
  return {
    fileName: `forge-${input.matId}.md`,
    content: `${frontmatterFor({ description, model, permissions })}\n\n${generatedHeader(recipeFile)}\n\n${body}\n`,
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
// the legacy tools face remain independent of workers; the GC predicate for
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
  const tools = overrideToolsFaceFor(shape)
  const body = input.def.prompt !== undefined && input.def.prompt.trim().length > 0 ? input.def.prompt : OVERRIDE_DEFAULT_PROMPTS[input.id]
  return {
    fileName: `${input.id}.md`,
    content: `${frontmatterFor({ description, model, tools })}\n\n${generatedHeader(input.recipeFile)}\n\n${body}\n`,
  }
}

// The agent directory holding a pool file's compiled artifacts: the
// sibling `agent` directory of the `.opencode` (or config) directory the
// recipe lives in — workspace pools compile into
// `<ws>/.opencode/agent/`. The global recipe sibling is only the default
// global agent directory; use the host-resolved directory for global workers.
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
// `<home>/.config/opencode/agent`. Global workers and override artifacts
// (general.md / explore.md) land HERE, which may differ from agentDirFor(globalPoolFile)
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

// Inspect only the two independently owned builtin destinations. No writes.
export function overrideSyncFindings(plan: OverrideSyncPlan, deps: RosterFsDeps): string[] {
  const findings: string[] = []
  for (const id of BUILTIN_OVERRIDE_IDS) {
    const name = `${id}.md`
    const dest = joinPath(plan.dir, name)
    const expected = plan.files.find((file) => file.fileName === name)
    try {
      if (deps.stat?.(dest) == null) {
        if (expected) findings.push(`missing override artifact: ${dest}`)
        continue
      }
      const existing = deps.readFile!(dest)
      if (!existing.includes(GENERATED_MARKER)) {
        if (expected) findings.push(`override collision: hand-written file ${dest}`)
      } else if (!expected || existing !== expected.content) {
        findings.push(`stale generated override: ${dest}`)
      }
    } catch {
      findings.push(`unreadable override artifact: ${dest}`)
    }
  }
  return findings
}

// Provenance for one family (same rule as the v1 config hook: the global
// fallback file's ns is FIXED to "global" and its provenance names the
// global layer, not a file).
function provenanceFor(origin: { file: string; ns: string }, globalPoolFile: string, platform: string): PoolProvenance {
  const fold = (p: string) => platform === "win32" ? p.replace(/\//g, "\\").toLowerCase() : p
  return fold(origin.file) === fold(globalPoolFile) ? { global: true } : { ns: origin.ns, file: origin.file }
}

// Resolve the same family directory for materialization and freshness/GC.
export function rosterAgentDirFor(poolFile: string, opts: { globalPoolFile: string; globalAgentDir?: string; platform?: string }): string {
  return "global" in provenanceFor({ file: poolFile, ns: "" }, opts.globalPoolFile, opts.platform ?? process.platform)
    ? opts.globalAgentDir ?? agentDirFor(poolFile)
    : agentDirFor(poolFile)
}

// Share the exact compiler input between sync and the staleness oracle.
export function compileResolvedRosterEntry(resolution: PoolResolution, matId: string, opts: { globalPoolFile: string; platform?: string }) {
  const agent = resolution.agents[matId]
  const provenance = provenanceFor(agent, opts.globalPoolFile, opts.platform ?? process.platform)
  return compileRosterEntry({ matId, def: agent.def, provenance, shared: agent.shared ?? undefined })
}

// Plan the WHOLE sync (all families of a resolution). Pure: no fs. The
// executor (below) writes the plan.
export function planRosterSync(resolution: PoolResolution, opts: { globalPoolFile: string; globalAgentDir?: string; platform?: string }): FamilySyncPlan[] {
  const plans: FamilySyncPlan[] = []
  for (const family of resolution.families) {
    const files = family.materializedIds.map((matId) => ({ matId, ...compileResolvedRosterEntry(resolution, matId, opts) }))
    plans.push({ kind: "family", family, dir: rosterAgentDirFor(family.file, opts), files })
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

// Execute a sync plan: atomic writes (temp + rename; a failed rename
// never triggers deletion of the existing destination), plus GC of
// orphaned generated forge-*.md files.
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
        if (existing !== null && !existing.includes(GENERATED_MARKER)) {
          out.errors.push(`${dest}: collision refused — a hand-written file of this exact name already exists; sync never overwrites it. Fold your changes into the recipe, or rename/remove the hand-written file.`)
          continue
        }
        if (existing !== null && (plan.kind === "family" ? sameProjection(existing, file.content) : existing === file.content)) {
          out.unchanged.push(dest)
          continue
        }
        const tempPath = `${dest}.new`
        if (stat(tempPath) !== null) {
          out.errors.push(`${tempPath}: temporary file already exists; sync leaves it untouched`)
          continue
        }
        tmp = tempPath
        writeFile(tmp, file.content)
        rename(tmp, dest)
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

// Staleness for ONE pool: stale if artifacts are missing while the recipe
// contributes agents. When `expectedContentOf` is supplied, compare content
// regardless of mtime (an old projection can have the same timestamp and
// byte-identical output is current even after a touch or checkout skew).
// With the content oracle, orphaned generated files also count as stale,
// including when the recipe disappears. Without the oracle retain the
// legacy recipe-vs-newest-artifact mtime check and empty-pool exemption.
export function staleCheckForPool(
  poolFile: string | null,
  expectedMatIds: string[],
  deps: RosterFsDeps = {},
  expectedContentOf?: (matId: string) => string,
  artifactDir?: string,
): StaleVerdict {
  if (poolFile === null) return { stale: false, reason: "no workspace pool — global-fallback roster, no per-workspace artifacts gate" }
  const stat = deps.stat ?? (() => null)
  const readFile = deps.readFile ?? (() => {
    throw new Error("readFile unavailable")
  })
  const recipe = stat(poolFile)
  const dir = artifactDir ?? agentDirFor(poolFile)
  if (expectedContentOf) {
    const wanted = new Set(expectedMatIds.map((id) => `forge-${id}.md`))
    for (const name of deps.readdir?.(dir) ?? []) {
      if (!name.startsWith("forge-") || !name.endsWith(".md") || wanted.has(name)) continue
      try {
        if (readFile(joinPath(dir, name)).includes(GENERATED_MARKER)) {
          return { stale: true, reason: `orphaned generated artifact: ${joinPath(dir, name)} — ${recipe === null ? "recipe missing" : "entry removed from recipe"}` }
        }
      } catch {
        return { stale: true, reason: `artifact ${joinPath(dir, name)} unreadable` }
      }
    }
    if (recipe === null && expectedMatIds.length > 0) return { stale: true, reason: `recipe missing: ${poolFile}` }
  }
  if (recipe === null) return { stale: false, reason: "recipe file not statable" }
  if (expectedMatIds.length === 0) return { stale: false, reason: "recipe contributes no agents" }
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
  if (expectedContentOf) {
    for (const matId of expectedMatIds) {
      try {
        const existing = readFile(joinPath(dir, `forge-${matId}.md`))
        if (!existing.includes(GENERATED_MARKER)) {
          return { stale: true, reason: `hand-written collision: ${joinPath(dir, `forge-${matId}.md`)} differs from what it compiles to` }
        }
        if (!sameProjection(existing, expectedContentOf(matId))) {
          return { stale: true, reason: `recipe ${poolFile} — the compiled forge-${matId}.md differs from what it compiles to` }
        }
      } catch {
        return { stale: true, reason: `artifact for forge-${matId} unreadable` }
      }
    }
    return { stale: false, reason: "compiled content is current" }
  }
  if (recipe.mtimeMs > newest) {
    return { stale: true, reason: `recipe ${poolFile} is newer (mtime ${recipe.mtimeMs}) than the newest compiled artifact (mtime ${newest})` }
  }
  return { stale: false, reason: "artifacts are at least as new as the recipe" }
}
