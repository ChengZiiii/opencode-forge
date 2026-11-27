// Family-scoped sync/retry handlers over the official Plugin RPC (change
// forge-tui-subagent-config, tasks 6.4/6.5, design D5/D6 — "Deterministic
// synchronization and application status"). This module OWNS the `sync`
// method of the forge-config RPC definition (rpc.ts freezes only the
// envelope; the shapes below are the finalized relay contract for the TUI).
//
// Contract spine (specs "Deterministic synchronization and application
// status" + server review hardening 2026-11-27):
//   - prepare (pure read): the scope is resolved by the SAME authoritative
//     resolver the edit path uses (moved-map-first session anchors — never
//     session.get inside resolution), the family identity is fixed by a FULL
//     resolution from the authoritative anchor registry, and the plan is
//     computed by the EXISTING roster compiler (planRosterSync) narrowed to
//     the selected family (family-sync selectFamilyPlans; the global scope
//     additionally carries the override plan with its deactivation GC pass —
//     runRosterSync parity). A short-lived SINGLE-USE token binds
//     epoch/generation, the exact binding (scope/sessionID/observedLocation/
//     anchor/family file), the family file's content hash AND the GC
//     candidate listing taken from the SAME snapshot the plan was compiled
//     from, plus the plan fingerprint. NOTHING is written at prepare.
//   - SAME-SNAPSHOT discipline (review item 6): plan and hash bind the exact
//     bytes the authoritative resolution read — the wired resolvePools
//     resolves with a FRESH createPoolResolver whose readFile records the
//     bytes per file, so an equal-size/same-mtime external edit can never
//     compile a stale prompt under a fresh hash (and never a second resolver
//     for the hash: readOf is the resolution's own read record).
//   - PRE-SAVE BASELINE discipline (review item 3): when the sync is
//     correlated to a save (commitId), the BEFORE side of the cross-family
//     winner diff is the commit protocol's retained pre-publish baseline —
//     never a post-save re-resolution, which would silently miss
//     save-caused flips. Missing/unknown/evicted baseline → the dependent
//     sync REFUSES with zero artifact writes (UNKNOWN is not "safe to
//     sync"). A baseline whose owner differs from the resolved target, or
//     whose diff shows any cross-family winner change, also refuses before
//     any write — host-wide sync stays the explicit recovery lever. A
//     standalone sync (no commitId) syncs CURRENT state: its before side is
//     the pre-write resolution.
//   - DIRECTORY-OVERLAP guard (review item 1): before any execution, no
//     UNSELECTED family may share the selected plans' artifact directories —
//     a family-scoped GC pass would otherwise garbage-collect another
//     family's projection. Refused with zero writes.
//   - apply (explicit confirm): under the shared per-actual-target commit
//     lock (forge-config-edit withCommitLock — the SAME lock the commit
//     protocol's publish uses), every binding is re-derived FRESH after
//     taking the lock, including an EXACT compare of the REQUEST's
//     scope/sessionID against the token binding (review item 5). Any drift
//     refuses stale — the independent retry is ALWAYS a fresh prepare
//     against current content; a saved patch is never replayed (requests
//     carry no paths and no write text).
//   - cross-family winner changes AFTER the write are disclosed only —
//     another family is never written; application is reported unconfirmed.
//   - applied status (review item 8): recipe projection maps
//     (resolvePools().agents) and session identity maps are EXPECTATION, not
//     host evidence. `applied: true` requires the injected listNativeAgents
//     observer — an INDEPENDENT host observation (e.g. the official
//     `agent.list` surface, openapi-2.4.2: GET /api/agent → Agent.Info rows:
//     {id, name, model?, request, system?, description?, mode, hidden,
//     permissions}) — to confirm the actually changed prompt/model/variant
//     fields or the exact removed ID. No provable seam (observer absent or
//     null) means every changed id stays UNCONFIRMED; it is never reported
//     applied from the recipe's own belief. The comparator is deliberately
//     strict (system body, model incl. variant, permissions map): a partial
//     write leaves the affected ids unconfirmed and the WHOLE order
//     unapplied.
//
// This module deliberately does NOT implement tokens for the edit path —
// snapshot handles, preview tokens, receipts and the commit lock protocol
// belong to src/config-rpc-protocol.ts. The sync token store here is the
// sync protocol's own bounded, in-memory, same-epoch state.

import { createHash, randomUUID } from "node:crypto"
import { normalize, resolve as resolvePath } from "node:path"
import { planOverrideSync, planRosterSync, executeRosterSync, type RosterFsDeps, type SyncPlan } from "./roster-compile.ts"
import { selectFamilyPlans, findFamily, crossFamilyWinnerConflictsFromBaseline, baselineSnapshotOf, type FamilyBaselineSnapshot } from "./family-sync.ts"
import type { PoolResolution } from "./forge-config.ts"
import { withCommitLock } from "./forge-config-edit.ts"
import type { ConfigRpcEpoch } from "./config-rpc-protocol.ts"
import type {
  Finding,
  Scope,
  SyncToken,
  SyncFileOp,
  SyncPreviewGc,
  SyncPreview,
  SyncPrepareOk,
  SyncApplyOk,
  SyncOutput,
  SyncRejectReason,
  SyncRosterRef,
  SyncErrorItem,
  SyncConflictItem,
} from "../rpc.ts"

// ---------------------------------------------------------------------------
// Finalized sync shapes (relay contract — the TUI/tests build against these;
// the rpc.ts `sync` input schema is tightened to exactly these fields)
// ---------------------------------------------------------------------------

export type SyncAction = "prepare" | "apply"

// Tightened input. The frozen envelope fields (scope/sessionID/confirm) keep
// their meaning; `confirm` is EXACTLY false on prepare (prepare is pure read
// — a "confirmed prepare" is refused) and EXACTLY true on apply. Requests
// carry NO paths and NO write text: the target is server-resolved and the
// plan is recomputed server-side from current recipe content.
export type SyncRpcInput = {
  scope: Scope
  sessionID: string | null
  confirm: boolean
  action: SyncAction
  // apply only: the opaque single-use token returned by prepare.
  token?: string
  // Optional correlation: the commit receipt's commitId from the save this
  // sync belongs to. Present → the sync is DEPENDENT: it runs against the
  // commit protocol's retained pre-save baseline and refuses (zero writes)
  // when that baseline is unknown, evicted, owner-drifted or shows a
//  cross-family winner change. Absent → a standalone sync of CURRENT state.
  commitId?: string
}

// The wire types (SyncPrepareOk, SyncApplyOk, SyncOutput, SyncRejectReason,
// SyncPreview, SyncPreviewGc, SyncFileOp, SyncFamily, SyncToken,
// SyncRosterRef, SyncErrorItem, SyncConflictItem, SyncAppliedStatus) are
// imported from ../rpc.ts — this module never re-declares a drifted copy.
export type {
  SyncPrepareOk,
  SyncApplyOk,
  SyncOutput,
  SyncRejectReason,
  SyncPreview,
  SyncPreviewGc,
  SyncFileOp,
  SyncFamily,
  SyncToken,
  SyncRosterRef,
  SyncErrorItem,
  SyncConflictItem,
  SyncAppliedStatus,
} from "../rpc.ts"

// The pre-save baseline the commit protocol retains (opaque to the store;
// THIS module defines the shape the plugin wiring produces). `coverage` is
// "unknown" whenever a full fresh resolution was not capturable — a
// dependent sync against an unknown baseline refuses with zero writes.
export type SyncBaseline = {
  v: 1
  at: number
  coverage: "full" | "unknown"
  reason?: string
  ownerFile: string
  anchor: string | null
  observedLocation: string | null
  familyNs: string | null
  materializedIds: string[]
  before: FamilyBaselineSnapshot
}

// The independent host observation seam. Rows use the OFFICIAL agent.list
// field names (openapi-2.4.2 Agent.Info: {id, system?, model?,
// permissions?}); a wrapper may adapt any proven host surface into them.
// Null/absent = no provable seam on this process: every changed id stays
// UNCONFIRMED.
export type NativeAgentRow = { id: string; system?: unknown; model?: unknown; permissions?: unknown }

// The resolution snapshot the sync binds: the authoritative resolution
// TOGETHER with the exact bytes its own reads produced (same-snapshot
// discipline — the plan and the hash can never disagree about content).
export type SyncResolutionSnapshot = { resolution: PoolResolution; readOf: (path: string) => string | null }

// ---------------------------------------------------------------------------
// Injectable deps (plugin wiring; tests inject memory state + a fake clock)
// ---------------------------------------------------------------------------

export type ConfigRpcSyncDeps = {
  // The SAME authoritative resolver the edit path uses (moved-map-first,
  // synchronous by the protocol store's contract).
  resolveScope: (req: { scope: Scope; sessionID: string | null }) =>
    | { ok: true; target: { path: string; observedLocation: string | null; anchor: string | null; creatable: boolean } }
    | { ok: false; reason: "scope-unresolved"; message: string }
  // ONE fresh authoritative resolution per call (review item 6): the wired
  // closure resolves with a fresh createPoolResolver over the host anchor
  // registry and returns the resolution plus the bytes its own reads
  // produced. Null = the registry cannot resolve at all (coverage unknown).
  resolvePools: () => SyncResolutionSnapshot | null
  // The commit protocol's retained pre-publish baseline (wired to
  // store.getCommitContext). The sync module treats the context as opaque
  // and validates the SyncBaseline shape on read.
  getCommitContext?: (commitId: string) => { found: true; context: Record<string, unknown> } | { found: false }
  globalPoolFile: () => string
  rosterDirs: () => { globalPoolFile: string; globalAgentDir: string }
  rosterFs: () => RosterFsDeps
  // Live epoch/registration generation (the server-provable epoch).
  epoch: () => ConfigRpcEpoch
  clock?: () => number
  randomId?: () => string
  hash?: (text: string) => string
  // Bounded sync-token lifetime (ms) and in-flight cap. Defaults: 5 min /
  // 64 — implementation parameters, not contract values; no auto-renewal.
  ttlMs?: number
  maxTokens?: number
  // Independent host registry observation. Absent → unconfirmed (the honest
  // default until a proven server-side seam exists).
  listNativeAgents?: () => Promise<NativeAgentRow[] | null>
  // Same-epoch receipt annotation (the store instance lives in the plugin
  // wiring; the handler carries no store reference). Absent/unknown id →
  // disclosed as unattached, never fatal.
  attachSyncOutcome?: (commitId: string, sync: Record<string, unknown>) => boolean
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

const DEFAULT_TTL_MS = 5 * 60 * 1000
const DEFAULT_MAX_TOKENS = 64

const foldPathOf = (p: string): string => (process.platform === "win32" ? p.replace(/\//g, "\\").toLowerCase() : p)

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex")

// Deterministic deep serialization (object key order never decides equality).
function canonicalJson(v: unknown): string {
  if (v === undefined) return "null"
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null"
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`
  const rec = v as Record<string, unknown>
  return `{${Object.keys(rec).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(rec[k])}`).join(",")}}`
}

type SyncTokenEntry = {
  token: string
  scope: Scope
  sessionID: string | null
  observedLocation: string | null
  anchor: string | null
  // The owning family file FIXED at prepare — apply refuses onto any other
  // owner (F6: a post-save re-resolution never hands the sync to a family
  // the human did not confirm).
  familyFile: string
  contentHash: string
  planFingerprint: string
  gcFingerprint: string
  // Dependent sync: the save this sync belongs to (its retained pre-save
  // baseline is fetched FRESH from the commit protocol at apply time —
  // eviction there is an honest refusal, not a stale local copy).
  commitId?: string
  epoch: ConfigRpcEpoch
  createdAt: number
  expiresAt: number
  spent: boolean
}

const SYNC_INPUT_KEYS = new Set(["scope", "sessionID", "confirm", "action", "token", "commitId"])

function validateInput(raw: unknown): { input: SyncRpcInput } | { refuse: { ok: false; action: "unknown"; reason: "invalid-input"; message: string } } {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { refuse: { ok: false, action: "unknown", reason: "invalid-input", message: "malformed sync request — expected an object" } }
  }
  const rec = raw as Record<string, unknown>
  for (const key of Object.keys(rec)) {
    if (!SYNC_INPUT_KEYS.has(key)) {
      return { refuse: { ok: false, action: "unknown", reason: "invalid-input", message: `unknown sync request field "${key}" — the sync surface accepts exactly scope/sessionID/confirm/action/token/commitId` } }
    }
  }
  const scope = rec.scope
  if (scope !== "workspace" && scope !== "global") {
    return { refuse: { ok: false, action: "unknown", reason: "invalid-input", message: 'sync scope must be "workspace" or "global"' } }
  }
  const sessionID = rec.sessionID
  if (sessionID !== null && typeof sessionID !== "string") {
    return { refuse: { ok: false, action: "unknown", reason: "invalid-input", message: "sync sessionID must be a string or exactly null" } }
  }
  const action = rec.action
  if (action !== "prepare" && action !== "apply") {
    return { refuse: { ok: false, action: "unknown", reason: "invalid-input", message: 'sync action must be "prepare" or "apply"' } }
  }
  if (typeof rec.confirm !== "boolean") {
    return { refuse: { ok: false, action: "unknown", reason: "invalid-input", message: "sync confirm must be a boolean" } }
  }
  // Prepare is pure read: confirm must be EXACTLY false (a confirmed
  // prepare would mislead — confirmation belongs to apply alone).
  if (action === "prepare" && rec.confirm !== false) {
    return { refuse: { ok: false, action: "unknown", reason: "invalid-input", message: 'sync prepare is pure read — confirm must be false; run action "apply" with confirm true to execute' } }
  }
  if (action === "apply") {
    if (rec.confirm !== true) {
      return { refuse: { ok: false, action: "unknown", reason: "invalid-input", message: "sync apply requires confirm === true — an unconfirmed plan is never executed" } }
    }
    if (typeof rec.token !== "string" || rec.token.length === 0) {
      return { refuse: { ok: false, action: "unknown", reason: "invalid-input", message: 'sync apply requires the token returned by action "prepare"' } }
    }
  }
  if (rec.token !== undefined && typeof rec.token !== "string") {
    return { refuse: { ok: false, action: "unknown", reason: "invalid-input", message: "sync token must be a string when present" } }
  }
  if (rec.commitId !== undefined && typeof rec.commitId !== "string") {
    return { refuse: { ok: false, action: "unknown", reason: "invalid-input", message: "sync commitId must be a string when present" } }
  }
  return {
    input: {
      scope,
      sessionID,
      confirm: rec.confirm,
      action,
      token: typeof rec.token === "string" ? rec.token : undefined,
      commitId: typeof rec.commitId === "string" ? rec.commitId : undefined,
    },
  }
}

// The parsed fingerprint surface: only the fields planRosterSync itself
// computes. Serializing the full plan (incl. compiled content) makes the
// fingerprint a complete plan binding — apply recomputes and compares, so a
// recipe drift between prepare and apply can never execute a stale plan.
function planFingerprintOf(plans: SyncPlan[], hash: (text: string) => string): string {
  const surface = plans.map((p) =>
    p.kind === "family"
      ? { kind: p.kind, family: { file: p.family.file, ns: p.family.ns, materializedIds: p.family.materializedIds }, dir: p.dir, files: p.files.map((f) => ({ matId: f.matId, fileName: f.fileName, content: f.content })) }
      : { kind: p.kind, dir: p.dir, files: p.files.map((f) => ({ fileName: f.fileName, content: f.content })) },
  )
  return hash(canonicalJson(surface))
}

// runRosterSync's usability rule, narrowed to the selected family: the file
// must exist and not be the subject of a parse-level error finding (a broken
// document is disclosed, never synced in place).
function recipeUsableFor(resolution: PoolResolution, file: string, stat: RosterFsDeps["stat"]): boolean {
  if ((stat ?? (() => null))(file) === null) return false
  return !resolution.findings.some((f) => (f.code === "config-parse-error" || f.code === "config-not-object") && f.message.startsWith(`${file}:`))
}

// The selected family's plans: the family plan narrowed from the compiler's
// whole-host plan, plus — GLOBAL SCOPE ONLY — the override plan with the
// same always-ride deactivation semantics as runRosterSync (an empty plan is
// still the GC pass; hand-written files are never touched by either).
function planFamilySync(resolution: PoolResolution, familyFile: string, dirs: { globalPoolFile: string; globalAgentDir: string }, opts?: { platform?: string }): SyncPlan[] {
  const plans: SyncPlan[] = selectFamilyPlans(planRosterSync(resolution, { globalPoolFile: dirs.globalPoolFile, globalAgentDir: dirs.globalAgentDir, platform: opts?.platform }), familyFile).plans
  if (foldPathOf(familyFile) === foldPathOf(dirs.globalPoolFile)) {
    const overridePlan = planOverrideSync(resolution.overrides ?? {}, { dir: dirs.globalAgentDir, recipeFile: dirs.globalPoolFile })
    plans.push(overridePlan ?? { kind: "override", dir: dirs.globalAgentDir, files: [] })
  }
  return plans
}

function joinPath(dir: string, name: string): string {
  const sep = dir.includes("\\") && !dir.includes("/") ? "\\" : "/"
  return dir.endsWith(sep) ? `${dir}${name}` : `${dir}${sep}${name}`
}

// Same comparison the executor uses: family plans compare CRLF-folded
// (sameProjection), override plans compare exact bytes. Preview and execute
// must agree, so both use this shape.
function previewOpOf(plan: SyncPlan, dest: string, content: string, fs: RosterFsDeps): { op: "create" | "update" | "unchanged" } {
  let existing: string | null = null
  try {
    if ((fs.stat ?? (() => null))(dest) !== null) existing = fs.readFile ? fs.readFile(dest) : null
  } catch {
    existing = null
  }
  if (existing === null) return { op: "create" }
  const same = plan.kind === "family"
    ? existing.replace(/\r\n/g, "\n") === content.replace(/\r\n/g, "\n")
    : existing === content
  return { op: same ? "unchanged" : "update" }
}

// The exact GC candidates of ONE plan (pure read) — executor-identical
// eligibility: family plans GC marker-carrying forge-*.md absent from the
// plan; override plans GC marker-carrying general.md/explore.md. A missing
// or unreadable directory yields no candidates (the executor behaves the
// same); a marker check failure skips the file exactly like the executor's
// per-file try/catch.
function gcCandidatesForPlan(plan: SyncPlan, fs: RosterFsDeps): SyncPreviewGc[] {
  const wanted = new Set(plan.files.map((f) => f.fileName))
  const gcEligible = (name: string): boolean => {
    if (!name.endsWith(".md")) return false
    if (plan.kind === "override") return name === "general.md" || name === "explore.md"
    return name.startsWith("forge-")
  }
  const out: SyncPreviewGc[] = []
  let listing: string[] | null = null
  try {
    listing = fs.readdir ? fs.readdir(plan.dir) : null
  } catch {
    listing = null
  }
  if (listing === null) return out
  for (const name of listing) {
    if (!gcEligible(name)) continue
    if (wanted.has(name)) continue
    const dest = joinPath(plan.dir, name)
    let marked = false
    try {
      marked = (fs.readFile ? fs.readFile(dest) : "").includes("<!-- GENERATED BY forge_sync")
    } catch {
      marked = false
    }
    if (!marked) continue
    out.push({ nativeId: nativeIdOfFileName(name), dest })
  }
  return out
}

function nativeIdOfFileName(name: string): string {
  return name.replace(/\.md$/, "")
}

function nativeIdOfPlanFile(plan: SyncPlan, file: { matId?: string; fileName: string }): string {
  if (plan.kind === "family" && typeof file.matId === "string") return `forge-${file.matId}`
  return file.fileName.replace(/\.md$/, "")
}

// Review item 1: no UNSELECTED family may share the selected plans'
// artifact directories. The executor's family-plan GC removes every marker-
// carrying forge-*.md not in the plan — with a shared directory that would
// garbage-collect ANOTHER family's projection. Detected → the whole sync
// refuses with zero writes (host-wide sync is the recovery). Fail-closed by
// design: a shared directory is a wiring defect, not something this sync
// works around. Directory equality is canonical (path.resolve/normalize +
// fold) so equivalent spellings ("C:/w/.opencode/." vs "C:/w/.opencode")
// cannot slip past the guard — standard normalization only; no symlink
// equivalence is claimed.
function canonicalPathOf(p: string): string {
  return foldPathOf(normalize(resolvePath(p)))
}

function directoryOverlapConflicts(resolution: PoolResolution, selectedPlans: SyncPlan[], familyFile: string, dirs: { globalPoolFile: string; globalAgentDir: string }): string[] {
  const selectedDirs = new Set(selectedPlans.map((p) => canonicalPathOf(p.dir)))
  const conflicts: string[] = []
  for (const p of planRosterSync(resolution, { globalPoolFile: dirs.globalPoolFile, globalAgentDir: dirs.globalAgentDir })) {
    if (p.kind !== "family") continue
    if (canonicalPathOf(p.family.file) === canonicalPathOf(familyFile)) continue
    if (selectedDirs.has(canonicalPathOf(p.dir))) {
      conflicts.push(`unselected family ${p.family.file} shares the artifact directory of the selected sync (${p.dir}) — a family-scoped sync would garbage-collect another family's projection; use the host-wide sync instead`)
    }
  }
  return conflicts
}

// ---------------------------------------------------------------------------
// Applied comparator (review item 8): strict field-level observation. Every
// leg must compare EQUAL on the official Agent.Info surfaces; anything not
// comparable stays unconfirmed — a partial write can never confirm the
// whole order.
// ---------------------------------------------------------------------------

// The compiled body (post-frontmatter text) — matched against a host row's
// `system`. CRLF-normalized; the seam wrapper must return rows under the
// same normalization, otherwise the comparison stays unconfirmed
// (fail-soft, never wrongly applied).
function compiledBodyOf(content: string): string | null {
  const m = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.exec(content)
  if (m === null) return null
  return content.slice(m[0].length).replace(/^\r?\n/, "").replace(/\r\n/g, "\n")
}

// The compiled model string a plan file carries (frontmatter `model:`) —
// the applied comparator's expected model. Undefined when the entry is an
// Auto worker (no model line: host inheritance). The search is confined to
// the frontmatter block, so a body line starting with "model:" can never be
// mistaken for the pin.
function modelStringFromContent(content: string): string | undefined {
  const fm = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.exec(content)
  if (fm === null) return undefined
  const m = /^model: ("((?:[^"\\]|\\.)*)"|(.+))$/m.exec(fm[0])
  if (m === null) return undefined
  if (m[2] !== undefined) return JSON.parse(`"${m[2]}"`) as string
  return m[3]?.trim()
}

// The compiled permission face a plan file carries — the STRICT observation
// target for the applied comparator. TWO shapes exist by design:
//   - workers compile a `permissions:` block (`  - action: "x"` /
//     `    resource: "*"` / `    effect: "y"` triples) → parsed verbatim
//     into an action→effect map;
//   - builtin overrides compile the legacy `tools:` map (boolean per tool)
//     → each false key is a DENY the host must surface in its Ruleset
//     (review round 6: an override compiled `shell:false` must NOT confirm
//     while the host row reports shell allow — an unobservable or contradicting
//     face is never success).
// Null = the entry carries NEITHER block (nothing compiled to observe).
function compiledPermissionFaceOf(content: string): Record<string, string> | null {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content)
  if (fm === null) return null
  const lines = fm[1].split(/\r?\n/)
  const start = lines.findIndex((l) => l === "permissions:")
  if (start >= 0) {
    const out: Record<string, string> = {}
    for (let i = start + 1; i < lines.length; i++) {
      const action = /^ {2}- action: ("(?:[^"\\]|\\.)*")$/.exec(lines[i])
      if (action === null) break
      const resource = /^ {4}resource: ("(?:[^"\\]|\\.)*")$/.exec(lines[i + 1] ?? "")
      const effect = /^ {4}effect: ("(?:[^"\\]|\\.)*")$/.exec(lines[i + 2] ?? "")
      if (resource === null || effect === null) return null
      if (JSON.parse(resource[1]) !== "*") return null
      out[JSON.parse(action[1]) as string] = JSON.parse(effect[1]) as string
      i += 2
    }
    return Object.keys(out).length > 0 ? out : null
  }
  const toolsStart = lines.findIndex((l) => l === "tools:")
  if (toolsStart >= 0) {
    const out: Record<string, string> = {}
    for (let i = toolsStart + 1; i < lines.length; i++) {
      const entry = /^ {2}([A-Za-z0-9_]+): (true|false)$/.exec(lines[i])
      if (entry === null) break
      // The legacy boolean face: false = deny, true = explicitly allowed.
      out[entry[1]] = entry[2] === "false" ? "deny" : "allow"
    }
    return Object.keys(out).length > 0 ? out : null
  }
  return null
}

// Model observation: the compiled string is `provider/model` or
// `provider/model#variant`. A host row carrying the plain string compares
// base AND variant; an object row ({providerID, modelID, variant?}) compares
// the provider/model identity plus the variant when EITHER side knows one —
// a variant the row does not expose cannot be confirmed (fail-soft).
function modelObserved(expected: string | undefined, rowModel: unknown): boolean {
  if (expected === undefined) return rowModel === undefined || rowModel === null || rowModel === ""
  const hash = expected.indexOf("#")
  const base = hash < 0 ? expected : expected.slice(0, hash)
  const variant = hash < 0 ? undefined : expected.slice(hash + 1)
  if (typeof rowModel === "string") {
    const at = rowModel.indexOf("#")
    const rowBase = at < 0 ? rowModel : rowModel.slice(0, at)
    const rowVariant = at < 0 ? undefined : rowModel.slice(at + 1)
    return rowBase === base && (variant === undefined ? rowVariant === undefined || rowVariant === "" : rowVariant === variant)
  }
  if (rowModel !== null && typeof rowModel === "object") {
    const rec = rowModel as { providerID?: unknown; id?: unknown; modelID?: unknown; variant?: unknown }
    // Official Agent.Info wire (2.4.2 probe): the model id field is `id`
    // ({providerID, id, variant}); a drifted `modelID` spelling is
    // tolerated for compatibility but never required.
    const modelId = typeof rec.id === "string" ? rec.id : typeof rec.modelID === "string" ? rec.modelID : undefined
    if (typeof rec.providerID === "string" && typeof modelId === "string") {
      if (`${rec.providerID}/${modelId}` !== base) return false
      const rowVariant = typeof rec.variant === "string" && rec.variant !== "" ? rec.variant : undefined
      return variant === rowVariant
    }
  }
  return false
}

// Normalize the host row's permission observation: the official ordered
// Permission.Ruleset array of {action, resource, effect} (kept IN ORDER —
// the effective permission of an action is decided by rule precedence), or
// a plain action→string object (entry order). Anything else is not
// comparable → null.
function normalizeRuleset(rowPermissions: unknown): Array<{ action: string; resource?: string; effect: string }> | null {
  if (Array.isArray(rowPermissions)) {
    const rules: Array<{ action: string; resource?: string; effect: string }> = []
    for (const entry of rowPermissions) {
      if (entry === null || typeof entry !== "object") return null
      const rec = entry as { action?: unknown; resource?: unknown; effect?: unknown }
      if (typeof rec.action !== "string" || typeof rec.effect !== "string") return null
      rules.push({ action: rec.action, resource: typeof rec.resource === "string" ? rec.resource : undefined, effect: rec.effect })
    }
    return rules
  }
  if (rowPermissions !== null && typeof rowPermissions === "object") {
    const rec = rowPermissions as Record<string, unknown>
    if (!Object.values(rec).every((v) => typeof v === "string")) return null
    return Object.entries(rec as Record<string, string>).map(([action, effect]) => ({ action, effect }))
  }
  return null
}

// Alias resolution for the legacy recipe keys the host renames on its
// surface: `task` compiles from tools.task:false but the host's dispatch
// deny is `subagent` (NATIVE_TOOL_VOCAB.taskKey mapping), `bash` is carried
// as `shell`.
function permissionAliasesOf(action: string): string[] {
  if (action === "task") return ["task", "subagent"]
  if (action === "bash") return ["bash", "shell"]
  return [action]
}

// Permissions observation — the approved contract is UNKNOWN ≠ SUCCESS:
//   - A row without a usable ruleset (missing/malformed field) observes
//     NOTHING → the face stays unconfirmed. This is the ONLY early refusal:
//     there is NO shape-default vacuous pass (a shape whose compiled
//     permission identity changed — e.g. a write→readonly edit's none→deny
//     family — must never be confirmed by a host that reports no rules).
//   - Rules are walked IN ORDER to the END (no early exit mid-walk): a rule
//     names a face entry's action via the alias sets (an action "*" rule
//     names everything). A GLOBAL rule (resource "*" or absent) is a proof:
//     the compiled face is a host-wide identity, so the entry's observation
//     is the LAST global rule's effect. A SPECIFIC-resource rule can never
//     prove a global entry — but after a global proof it can still OVERRIDE
//     the identity for its resource, so a later different-effect specific
//     rule marks the standing proof INVALID and the walk CONTINUES; a later
//     GLOBAL matching rule RE-ESTABLISHES the proof (the deviation is
//     superseded). The unified verdict at the end: the proof exists, is
//     still valid, and its effect equals the compiled expectation.
function permissionsObserved(face: Record<string, string> | null, rowPermissions: unknown): boolean {
  if (face === null) return true
  const rules = normalizeRuleset(rowPermissions)
  if (rules === null) return false
  for (const [action, effect] of Object.entries(face)) {
    const names = permissionAliasesOf(action)
    let globalEffective: string | undefined
    let globalSeen = false
    let proofValid = true
    for (const rule of rules) {
      if (rule.action !== "*" && !names.includes(rule.action)) continue
      if (rule.resource === undefined || rule.resource === "*") {
        globalSeen = true
        globalEffective = rule.effect
        proofValid = true
      } else if (globalSeen && rule.effect !== globalEffective) {
        // A later specific-resource rule with a DIFFERENT effect than the
        // standing global proof may override the compiled identity for its
        // resource — invalidate the proof but KEEP WALKING: a later global
        // matching rule re-establishes it.
        proofValid = false
      }
    }
    if (!globalSeen || !proofValid || globalEffective !== effect) return false
  }
  return true
}

// ---------------------------------------------------------------------------
// Handler factory
// ---------------------------------------------------------------------------

export function createConfigRpcSyncHandler(deps: ConfigRpcSyncDeps): (input: unknown) => Promise<SyncOutput> {
  const now = deps.clock ?? (() => Date.now())
  const randomId = deps.randomId ?? (() => randomUUID())
  const hash = deps.hash ?? sha256
  const ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS
  const maxTokens = deps.maxTokens ?? DEFAULT_MAX_TOKENS
  const tokens = new Map<string, SyncTokenEntry>()

  // Housekeeping ONLY — never runs before an apply's on-touch
  // classification (review S8/S9: an eager sweep would turn a precisely
  // diagnosable expired/stale token into an unhelpful "unknown").
  const sweep = (): void => {
    const t = now()
    const cur = deps.epoch()
    for (const [id, entry] of tokens) {
      if (t > entry.expiresAt || entry.epoch.epoch !== cur.epoch || entry.epoch.generation !== cur.generation) tokens.delete(id)
    }
  }

  const sameBinding = (a: string | null, b: string | null): boolean => (a === null || b === null ? a === b : foldPathOf(a) === foldPathOf(b))

  // The retained pre-save baseline for a dependent sync — fetched FRESH
  // from the commit protocol and shape-checked. Null = unknown (refuse).
  const baselineFor = (commitId: string): SyncBaseline | null => {
    if (typeof deps.getCommitContext !== "function") return null
    let ctx: { found: true; context: Record<string, unknown> } | { found: false }
    try {
      ctx = deps.getCommitContext(commitId)
    } catch {
      return null
    }
    if (!ctx.found) return null
    return readBaselineShape(ctx.context)
  }

  function readBaselineShape(raw: unknown): SyncBaseline | null {
    if (raw === null || typeof raw !== "object") return null
    const rec = raw as Record<string, unknown>
    if (rec.v !== 1 || (rec.coverage !== "full" && rec.coverage !== "unknown")) return null
    if (typeof rec.ownerFile !== "string" || rec.ownerFile === "") return null
    const before = rec.before as FamilyBaselineSnapshot | null
    if (before === null || typeof before !== "object" || typeof before.ownerByMatId !== "object" || typeof before.contentByMatId !== "object" || !Array.isArray(before.collisionFindings)) return null
    return {
      v: 1,
      at: typeof rec.at === "number" ? rec.at : 0,
      coverage: rec.coverage,
      reason: typeof rec.reason === "string" ? rec.reason : undefined,
      ownerFile: rec.ownerFile,
      anchor: rec.anchor === null || typeof rec.anchor === "string" ? (rec.anchor as string | null) : null,
      observedLocation: rec.observedLocation === null || typeof rec.observedLocation === "string" ? (rec.observedLocation as string | null) : null,
      familyNs: rec.familyNs === null || typeof rec.familyNs === "string" ? (rec.familyNs as string | null) : null,
      materializedIds: Array.isArray(rec.materializedIds) ? rec.materializedIds.filter((x): x is string => typeof x === "string") : [],
      before,
    }
  }

  // Pure-read preview shared by prepare. Refusals carry the reason the
  // contract names; nothing here writes.
  const buildPreview = (raw: { scope: Scope; sessionID: string | null; commitId?: string }): { ok: true; preview: SyncPreview; plans: SyncPlan[]; familyFile: string; contentHash: string; fingerprint: string; gcFingerprint: string; gc: SyncPreviewGc[]; snapshot: SyncResolutionSnapshot } | { ok: false; output: Extract<SyncOutput, { ok: false }> } => {
    const fs = deps.rosterFs()
    const snapshot = deps.resolvePools()
    if (snapshot === null) {
      return { ok: false, output: { ok: false, action: "prepare", reason: "no-coverage", message: "the host's authoritative anchor registry cannot resolve a full pool picture — sync is refused rather than answered from a partial set; initialize the workspace (or retry once the host has seen it)" } }
    }
    const resolution = snapshot.resolution
    const resolved = deps.resolveScope({ scope: raw.scope, sessionID: raw.sessionID })
    if (!resolved.ok) {
      return { ok: false, output: { ok: false, action: "prepare", reason: "scope-unresolved", message: resolved.message } }
    }
    const familyFile = resolved.target.path
    const dirs = deps.rosterDirs()
    const globalFile = dirs.globalPoolFile
    const isGlobalFamily = foldPathOf(familyFile) === foldPathOf(globalFile)
    if (!recipeUsableFor(resolution, familyFile, fs.stat)) {
      const exists = (fs.stat ?? (() => null))(familyFile) !== null
      return { ok: false, output: { ok: false, action: "prepare", reason: exists ? "recipe-unusable" : "stale-preview", message: exists
        ? `${familyFile} does not parse — broken documents are disclosed, never synced in place; fix the syntax first`
        : `${familyFile} is absent — nothing to project for this scope${resolved.target.creatable ? " (creating it is an edit-path save, not a sync)" : ""}` } }
    }
    const family = findFamily(resolution, familyFile)
    const plans = planFamilySync(resolution, familyFile, dirs)
    const overlaps = directoryOverlapConflicts(resolution, plans, familyFile, dirs)
    if (overlaps.length > 0) {
      return { ok: false, output: { ok: false, action: "prepare", reason: "directory-conflict", message: overlaps.join("; ") } }
    }
    const findings: Finding[] = resolution.findings
      .filter((f) => f.level === "warn" || f.level === "error")
      .map((f) => ({ level: f.level, code: f.code, message: f.message }))
    const familyBytes = snapshot.readOf(familyFile)
    if (familyBytes === null) {
      return { ok: false, output: { ok: false, action: "prepare", reason: "recipe-unusable", message: `${familyFile} was not part of the authoritative resolution's reads — refusing rather than hashing a second read of possibly different bytes` } }
    }
    const contentHash = hash(familyBytes)
    const files: SyncFileOp[] = []
    const summary: string[] = []
    for (const plan of plans) {
      for (const file of plan.files) {
        const dest = joinPath(plan.dir, file.fileName)
        const { op } = previewOpOf(plan, dest, file.content, fs)
        files.push({ nativeId: nativeIdOfPlanFile(plan, file), fileName: file.fileName, dest, op })
        if (op !== "unchanged") summary.push(`${op}: ${dest}`)
      }
    }
    const gc = plans.flatMap((p) => gcCandidatesForPlan(p, fs))
    for (const g of gc) summary.push(`gc: ${g.dest} (${g.nativeId})`)
    const preview: SyncPreview = {
      path: familyFile,
      scope: raw.scope,
      sessionID: raw.sessionID,
      observedLocation: resolved.target.observedLocation,
      anchor: resolved.target.anchor,
      family: family === null ? null : { file: family.file, ns: family.ns, materializedIds: [...family.materializedIds] },
      overridesIncluded: isGlobalFamily,
      files,
      gc,
      coverage: "full",
      summary,
      findings,
    }
    return { ok: true, preview, plans, familyFile, contentHash, fingerprint: planFingerprintOf(plans, hash), gcFingerprint: hash(canonicalJson(gc)), gc, snapshot }
  }

  // The saved-baseline discipline over ONE fresh snapshot (review item 3 /
  // round-5 addition): owner must still match, coverage must be full, and
  // the pre-save winners must not have moved — shared by prepare AND apply,
  // so a zero-artifact prepare cannot swallow a conflict behind a noop.
  const savedBaselineConflict = (commitId: string, familyFile: string, snap: SyncResolutionSnapshot): { ok: true } | { ok: false; reason: SyncRejectReason; message: string } => {
    const baseline = baselineFor(commitId)
    if (baseline === null) {
      return { ok: false, reason: "no-coverage", message: `the commit baseline for ${commitId} is unknown, evicted or malformed — whether that save wrote is UNKNOWN and a dependent sync is refused with zero writes; re-run the save flow, or sync current state standalone (without commitId)` }
    }
    if (baseline.coverage !== "full") {
      return { ok: false, reason: "no-coverage", message: `the save's pre-publish baseline is not a full resolution (${baseline.reason ?? "unknown coverage"}) — dependent sync refused with zero writes` }
    }
    if (foldPathOf(baseline.ownerFile) !== foldPathOf(familyFile)) {
      return { ok: false, reason: "scope-mismatch", message: `the owning family moved after the confirmed save (baseline owner ${baseline.ownerFile} vs resolved ${familyFile}) — a sync must never follow a new owner the human did not confirm; re-open the editor` }
    }
    const flips = crossFamilyWinnerConflictsFromBaseline(baseline.before, snap.resolution, familyFile)
    if (flips.length > 0) {
      return { ok: false, reason: "directory-conflict", message: `the save changed cross-family collision winners — family-scoped sync refused before any write (zero artifact writes): ${flips.join("; ")}; the explicit host-wide sync is the recovery lever` }
    }
    return { ok: true }
  }

  const prepare = (input: SyncRpcInput): SyncOutput => {
    sweep()
    // prepare-side evidence binding (review round 5): a commitId-carrying
    // prepare binds THIS sync to that save's retained pre-save baseline —
    // the context must exist NOW (a missing one can never be reconstructed;
    // the dependent sync would be dead on arrival). Full shape/coverage/
    // owner/winner checks still run at apply against live state.
    if (input.commitId !== undefined && typeof deps.getCommitContext === "function") {
      let found = false
      try {
        found = deps.getCommitContext(input.commitId).found === true
      } catch {
        found = false
      }
      if (!found) {
        return { ok: false, action: "prepare", reason: "no-coverage", message: `the commit ${input.commitId} this sync would correlate to has no retained pre-save context — the save's evidence is missing (never reconstructed); run the save flow again, or sync current state standalone (without commitId)` }
      }
    }
    const built = buildPreview(input)
    if (!built.ok) return built.output
    const cur = deps.epoch()
    const t = now()
    // Saved-baseline diff BEFORE the noop verdict (review round 6): a
    // zero-artifact projection must not swallow a winner flip behind a
    // "nothing to do" — a dependent prepare runs the same owner/coverage/
    // winners comparison as the apply and refuses on any conflict.
    if (input.commitId !== undefined) {
      const baseline = savedBaselineConflict(input.commitId, built.familyFile, built.snapshot)
      if (!baseline.ok) return { ok: false, action: "prepare", reason: baseline.reason, message: baseline.message }
    }
    if (built.preview.files.every((f) => f.op === "unchanged") && built.gc.length === 0) {
      // Zero-change sync (nothing to write AND nothing to garbage-collect —
      // a pure-delete sync is a real change, never a noop): no token is
      // issued — nothing can execute later, and the disclosure says so.
      return { ok: true, action: "prepare", outcome: "noop", preview: built.preview, findings: built.preview.findings }
    }
    const token = `synctok-${randomId()}`
    const entry: SyncTokenEntry = {
      token,
      scope: input.scope,
      sessionID: input.sessionID,
      observedLocation: built.preview.observedLocation,
      anchor: built.preview.anchor,
      familyFile: built.familyFile,
      contentHash: built.contentHash,
      planFingerprint: built.fingerprint,
      gcFingerprint: built.gcFingerprint,
      commitId: input.commitId,
      epoch: { ...cur },
      createdAt: t,
      expiresAt: t + ttlMs,
      spent: false,
    }
    if (tokens.size >= maxTokens && !tokens.has(token)) {
      const oldest = tokens.keys().next()
      if (!oldest.done) tokens.delete(oldest.value)
    }
    tokens.set(token, entry)
    return {
      ok: true,
      action: "prepare",
      outcome: "token",
      token: { token, expiresAt: entry.expiresAt, epoch: cur.epoch, generation: cur.generation },
      preview: built.preview,
      findings: built.preview.findings,
    }
  }

  const apply = async (input: SyncRpcInput): Promise<SyncOutput> => {
    const fail = (reason: SyncRejectReason, message: string): SyncOutput => ({ ok: false, action: "apply", reason, message })
    // On-touch classification FIRST (review S8/S9): a token that exists but
    // is stale/expired reports exactly that — the sweep never runs before
    // this lookup.
    const entry = typeof input.token === "string" ? tokens.get(input.token) : undefined
    if (entry === undefined) {
      sweep()
      return fail("token-unknown", "unknown sync token — nothing was executed; run a fresh prepare against current content")
    }
    const pre = deps.epoch()
    if (entry.epoch.epoch !== pre.epoch || entry.epoch.generation !== pre.generation) {
      tokens.clear()
      return fail("epoch-stale", "the server epoch or RPC registration generation changed — every sync token issued before it is refused; re-prepare")
    }
    const tPre = now()
    if (tPre > entry.expiresAt) {
      tokens.delete(entry.token)
      return fail("token-expired", "the sync token expired — nothing was executed; run a fresh prepare (no auto-renewal)")
    }
    if (entry.spent) return fail("token-spent", "the sync token was already used — at most one execution per token; run a fresh prepare to retry")
    // The REQUEST's scope/sessionID must match the token binding EXACTLY
    // (review item 5): a global/null token cannot be submitted under a
    // workspace/other identity, in or out of the lock.
    if (input.scope !== entry.scope || input.sessionID !== entry.sessionID) {
      return fail("scope-mismatch", "the request's scope/sessionID do not exactly match the sync token binding — nothing was executed")
    }
    // The correlation binding is EXACT (review round 5 bypass): the apply's
    // commitId must equal the prepare-bound value — both unset (standalone)
    // or the identical string. An apply cannot inject a receipt its prepare
    // never bound: without the prepare-side binding the pre-save baseline
    // checks would silently never run.
    if ((input.commitId ?? null) !== (entry.commitId ?? null)) {
      return fail("invalid-input", input.commitId === undefined
        ? `this sync token was prepared as a DEPENDENT sync of commit ${entry.commitId} — the apply must carry the same commitId (the correlation is part of the token binding)`
        : `the apply carries commitId ${input.commitId} but its prepare bound ${entry.commitId === undefined ? "no commitId" : entry.commitId} — a sync cannot correlate to a receipt its prepare never bound; re-prepare with the commitId to run the baseline-checked dependent sync`)
    }
    // Fresh binding re-derivation BEFORE the lock (fail fast); the SAME
    // checks run again inside the lock, where no await exists between them
    // and the write — a session.moved event cannot slip through.
    const resolved = deps.resolveScope({ scope: entry.scope, sessionID: entry.sessionID })
    if (!resolved.ok) return fail("scope-unresolved", resolved.message)
    if (foldPathOf(resolved.target.path) !== foldPathOf(entry.familyFile) || !sameBinding(resolved.target.observedLocation, entry.observedLocation) || !sameBinding(resolved.target.anchor, entry.anchor)) {
      return fail("scope-mismatch", "the target no longer resolves under the sync token binding (owner, path, session location or anchor changed) — re-prepare against current state")
    }
    const preSnap = deps.resolvePools()
    if (preSnap === null) return fail("no-coverage", "the host's authoritative anchor registry cannot resolve a full pool picture — sync is refused (no partial-set execution)")
    // Apply-time commitId = the sync's evidence check (S14): the correlated
    // save must STILL be known to this epoch. A commitId whose pre-save
    // context is gone (evicted, cross-epoch, unknown) means whether that
    // save wrote is UNKNOWN — the correlated sync refuses with zero writes
    // and nothing is annotated (fail-closed, never a silent annotation).
    // The PRE-SAVE baseline discipline (owner/coverage/winners) keys on the
    // prepare-bound commitId below; this check proves the correlation
    // target still exists.
    const commitEvidence = (commitId: string): { ok: true } | { ok: false; message: string } => {
      if (typeof deps.getCommitContext !== "function") {
        return { ok: false, message: `the sync correlates to commit ${commitId} but no commit-context seam is available — whether that save wrote is UNKNOWN; refused with zero writes` }
      }
      let found = false
      try {
        found = deps.getCommitContext(commitId).found === true
      } catch {
        found = false
      }
      if (!found) {
        return { ok: false, message: `the commit ${commitId} this sync correlates to has no retained pre-save context (evicted, cross-epoch or unknown) — whether that save wrote is UNKNOWN; the correlated sync is refused with zero writes (re-run the save flow to re-establish evidence)` }
      }
      return { ok: true }
    }
    if (typeof input.commitId === "string") {
      const evidence = commitEvidence(input.commitId)
      if (!evidence.ok) return fail("no-coverage", evidence.message)
    }
    const verifyState = (snap: SyncResolutionSnapshot): { ok: true; plans: SyncPlan[]; gc: SyncPreviewGc[] } | { ok: false; reason: SyncRejectReason; message: string } => {
      const fs = deps.rosterFs()
      const res = snap.resolution
      const family = findFamily(res, entry.familyFile)
      if (family === null) return { ok: false, reason: "stale-preview", message: `${entry.familyFile} no longer materializes as the owning family — re-prepare against current state` }
      const dirs = deps.rosterDirs()
      const plans = planFamilySync(res, entry.familyFile, dirs)
      const overlaps = directoryOverlapConflicts(res, plans, entry.familyFile, dirs)
      if (overlaps.length > 0) return { ok: false, reason: "directory-conflict", message: overlaps.join("; ") }
      if (planFingerprintOf(plans, hash) !== entry.planFingerprint) return { ok: false, reason: "stale-preview", message: "the planned projection changed since prepare — re-prepare against current content (a saved patch is never replayed)" }
      const gc = plans.flatMap((p) => gcCandidatesForPlan(p, fs))
      if (hash(canonicalJson(gc)) !== entry.gcFingerprint) return { ok: false, reason: "stale-preview", message: "the garbage-collection candidates changed since prepare — re-prepare against current state" }
      const familyBytes = snap.readOf(entry.familyFile)
      if (familyBytes === null) return { ok: false, reason: "recipe-unusable", message: `${entry.familyFile} was not part of the authoritative resolution's reads — refusing rather than hashing a second read of possibly different bytes` }
      if (hash(familyBytes) !== entry.contentHash) return { ok: false, reason: "stale-preview", message: `${entry.familyFile} changed since prepare — re-prepare against current content` }
      return { ok: true, plans, gc }
    }
    const preState = verifyState(preSnap)
    if (!preState.ok) return fail(preState.reason, preState.message)
    // Pre-write baseline comparison (review item 3) — a dependent sync runs
    // against the save's retained pre-publish baseline; any unknown, owner
    // drift or cross-family winner change refuses BEFORE any artifact write.
    const preBaseline = entry.commitId === undefined ? { ok: true as const } : savedBaselineConflict(entry.commitId, entry.familyFile, preSnap)
    if (!preBaseline.ok) return fail(preBaseline.reason, preBaseline.message)

    // ONE lock per actual target — the SAME withCommitLock surface the
    // commit protocol's atomic publish serializes on. Everything from the
    // in-lock re-verification through the spend and the projection write is
    // SYNCHRONOUS (the async body runs its pre-await segment atomically):
    // no await gap exists for an event to slip through. The observer await
    // (below) happens strictly after the write.
    const execResult = await withCommitLock(entry.familyFile, async (): Promise<SyncOutput | null> => {
      const cur = deps.epoch()
      if (entry.epoch.epoch !== cur.epoch || entry.epoch.generation !== cur.generation) {
        tokens.clear()
        return fail("epoch-stale", "the epoch or registration generation changed while the apply was pending — refused, nothing was executed")
      }
      const t2 = now()
      if (t2 > entry.expiresAt) {
        tokens.delete(entry.token)
        return fail("token-expired", "the sync token expired while the apply was pending — nothing was executed; re-prepare (no auto-renewal)")
      }
      if (entry.spent) return fail("token-spent", "the sync token was used by a competing apply — at most one execution per token")
      // Request-vs-binding exact compare again, inside the lock.
      if (input.scope !== entry.scope || input.sessionID !== entry.sessionID) {
        return fail("scope-mismatch", "the request's scope/sessionID stopped matching the sync token binding — nothing was executed")
      }
      const inLockScope = deps.resolveScope({ scope: entry.scope, sessionID: entry.sessionID })
      if (!inLockScope.ok || foldPathOf(inLockScope.target.path) !== foldPathOf(entry.familyFile) || !sameBinding(inLockScope.target.observedLocation, entry.observedLocation) || !sameBinding(inLockScope.target.anchor, entry.anchor)) {
        return fail("scope-mismatch", "the binding re-resolution changed while the apply was pending — refused, nothing was executed; re-prepare")
      }
      const snap = deps.resolvePools()
      if (snap === null) return fail("no-coverage", "coverage became unresolvable while the apply was pending — refused, nothing was executed")
      const inLock = verifyState(snap)
      if (!inLock.ok) return fail(inLock.reason, inLock.message)
      const inLockBaseline = entry.commitId === undefined ? { ok: true as const } : savedBaselineConflict(entry.commitId, entry.familyFile, snap)
      if (!inLockBaseline.ok) return fail(inLockBaseline.reason, inLockBaseline.message)
      if (typeof input.commitId === "string") {
        const inLockEvidence = commitEvidence(input.commitId)
        if (!inLockEvidence.ok) return fail("no-coverage", `${inLockEvidence.message} (re-checked inside the commit lock before any write)`)
      }
      // Spend immediately before the write: single-use holds even when the
      // execution itself fails — the retry is a fresh prepare, never revival.
      entry.spent = true
      const outcome = executeRosterSync(inLock.plans, deps.rosterFs())
      const after = deps.resolvePools()
      // Post-write winner diff (disclose-only): the before side is the
      // pre-write state just captured in-lock; a family-scoped plan should
      // never move another family — any flip here is disclosed as
      // unconfirmed, never silently reconciled.
      const conflicts = after === null
        ? ["post-sync coverage could not be re-resolved — application stays unconfirmed"]
        : crossFamilyWinnerConflictsFromBaseline(baselineSnapshotOf(snap.resolution), after.resolution, entry.familyFile)
      // Removed ids: exactly the generated files this pass garbage-collected,
      // keyed to their native registration ids.
      const removedIds = outcome.gced.map((dest) => nativeIdOfFileName(dest.split(/[\\/]/).pop() ?? dest))
      const changedNative: Array<{ plan: SyncPlan; fileName: string; matId?: string; content: string }> = []
      for (const p of inLock.plans) {
        if (p.kind === "family") {
          for (const f of p.files) {
            const dest = joinPath(p.dir, f.fileName)
            if (!outcome.created.includes(dest) && !outcome.updated.includes(dest)) continue
            changedNative.push({ plan: p, fileName: f.fileName, matId: f.matId, content: f.content })
          }
        } else {
          for (const f of p.files) {
            const dest = joinPath(p.dir, f.fileName)
            if (!outcome.created.includes(dest) && !outcome.updated.includes(dest)) continue
            changedNative.push({ plan: p, fileName: f.fileName, content: f.content })
          }
        }
      }
      const summary = [
        ...outcome.created.map((d) => `created: ${d}`),
        ...outcome.updated.map((d) => `updated: ${d}`),
        ...(outcome.unchanged.length ? [`unchanged: ${outcome.unchanged.length} file(s) already current`] : []),
        ...(outcome.gced.length ? [`gc'd: ${outcome.gced.join(", ")}`] : []),
        ...(outcome.errors.length ? [`errors: ${outcome.errors.join("; ")}`] : []),
        ...(conflicts.length ? [`conflicts (disclosed, not reconciled): ${conflicts.join("; ")}`] : []),
      ]
      const findings: Finding[] = after === null ? [] : after.resolution.findings.filter((f) => f.level === "warn" || f.level === "error").map((f) => ({ level: f.level, code: f.code, message: f.message }))
      // Wire mapping (the compiler's internal dest-string outcome is mapped
      // to the frozen rpc.ts shapes at this handler boundary — never
      // leaked as raw strings):
      const refOf = new Map<string, SyncRosterRef>()
      for (const p of inLock.plans) {
        for (const f of p.files) refOf.set(joinPath(p.dir, f.fileName), { nativeId: nativeIdOfPlanFile(p, f), fileName: f.fileName })
      }
      const refFor = (dest: string): SyncRosterRef => {
        const hit = refOf.get(dest)
        if (hit !== undefined) return hit
        const fileName = dest.split(/[\\/]/).pop() ?? dest
        return { nativeId: nativeIdOfFileName(fileName), fileName }
      }
      const createdRefs = outcome.created.map(refFor)
      const updatedRefs = outcome.updated.map(refFor)
      const errorItems: SyncErrorItem[] = outcome.errors.map((message) => {
        const hit = [...refOf.keys()].find((d) => message.startsWith(`${d}:`))
        return hit === undefined ? { message } : { message, ...refOf.get(hit)! }
      })
      const conflictItems: SyncConflictItem[] = conflicts.map((message) => ({ message }))
      const base = {
        ok: true as const,
        action: "apply" as const,
        path: entry.familyFile,
        scope: entry.scope,
        sessionID: entry.sessionID,
        created: createdRefs,
        updated: updatedRefs,
        unchanged: outcome.unchanged,
        gced: outcome.gced,
        errors: errorItems,
        removedIds,
        conflicts: conflictItems,
        summary,
        findings,
        epoch: cur.epoch,
        generation: cur.generation,
        at: t2,
      }
      const changedIds = changedNative.map((c) => nativeIdOfPlanFile(c.plan, { matId: c.matId, fileName: c.fileName }))
      // Review item 8 (P1g + round-6 reproduction): a planned file whose
      // write FAILED is disclosed in errors but never lands — its id is
      // unverified by definition. The executor's failure prefixes name
      // EITHER the destination (`${dest}: ...`) OR its temp file
      // (`${dest}.new: temporary file already exists ...`) — both attribute
      // to the same entry. Any residual error keeps the WHOLE order
      // unapplied (hard gate below), attributed or not.
      const erroredIds: string[] = []
      for (const p of inLock.plans) {
        for (const f of p.files) {
          const dest = joinPath(p.dir, f.fileName)
          if (outcome.created.includes(dest) || outcome.updated.includes(dest)) continue
          if (outcome.errors.some((e) => e.startsWith(`${dest}:`) || e.startsWith(`${dest}.new:`))) erroredIds.push(nativeIdOfPlanFile(p, f))
        }
      }
      if (conflicts.length > 0) {
        // Cross-family winner change after the write: disclose only. Another
        // family was never written here; application stays unconfirmed and
        // the explicit host-wide sync recovery is the separate lever.
        return { ...base, outcome: "conflict", applied: false, appliedStatus: { status: "unconfirmed", observedBy: null, confirmedIds: [], removedConfirmedIds: [], unconfirmedIds: [...changedIds, ...erroredIds, ...removedIds] } }
      }
      if (outcome.errors.length > 0 && outcome.created.length === 0 && outcome.updated.length === 0 && outcome.gced.length === 0) {
        return { ...base, outcome: "refused", applied: false, appliedStatus: { status: "unconfirmed", observedBy: null, confirmedIds: [], removedConfirmedIds: [], unconfirmedIds: [] } }
      }
      if (outcome.created.length === 0 && outcome.updated.length === 0 && outcome.gced.length === 0) {
        return { ...base, outcome: "noop", applied: false, appliedStatus: { status: "unconfirmed", observedBy: null, confirmedIds: [], removedConfirmedIds: [], unconfirmedIds: [] } }
      }
      // Independent host observation. Without a proven seam everything stays
      // UNCONFIRMED — the recipe's own projection never self-certifies.
      const observer = deps.listNativeAgents
      if (typeof observer !== "function") {
        return { ...base, outcome: "unconfirmed", applied: false, appliedStatus: { status: "unconfirmed", observedBy: null, confirmedIds: [], removedConfirmedIds: [], unconfirmedIds: [...changedIds, ...erroredIds, ...removedIds] } }
      }
      let rows: NativeAgentRow[] | null = null
      try {
        rows = await observer()
      } catch {
        rows = null
      }
      if (rows === null) {
        return { ...base, outcome: "unconfirmed", applied: false, appliedStatus: { status: "unconfirmed", observedBy: null, confirmedIds: [], removedConfirmedIds: [], unconfirmedIds: [...changedIds, ...erroredIds, ...removedIds] } }
      }
      const byId = new Map<string, NativeAgentRow>()
      for (const row of rows) {
        // ONE malformed row makes the WHOLE observation unusable (review
        // round 6): a row without a non-empty string id — e.g. a
        // {name}-shaped drift — must never be silently skipped, or a
        // pure-delete sync would misread an unobservable host as "id gone"
        // and report removedConfirmed. Fail the observation to unconfirmed.
        if (row === null || typeof row !== "object" || typeof row.id !== "string" || row.id.trim() === "") {
          return { ...base, outcome: "unconfirmed", applied: false, appliedStatus: { status: "unconfirmed", observedBy: null, confirmedIds: [], removedConfirmedIds: [], unconfirmedIds: [...changedIds, ...erroredIds, ...removedIds] } }
        }
        byId.set(row.id, row)
      }
      const confirmedIds: string[] = []
      const unconfirmedIds: string[] = []
      for (const c of changedNative) {
        const nativeId = nativeIdOfPlanFile(c.plan, { matId: c.matId, fileName: c.fileName })
        const row = byId.get(nativeId)
        // Unknown ≠ success: every compiled face entry must be observed by a
        // global rule with the matching effective (last) effect — no
        // shape-default vacuous pass, specific-resource rules prove nothing
        // about the global identity.
        const observed =
          row !== undefined &&
          modelObserved(modelStringFromContent(c.content), row.model) &&
          systemObserved(compiledBodyOf(c.content), row.system) &&
          permissionsObserved(compiledPermissionFaceOf(c.content), row.permissions)
        if (observed) confirmedIds.push(nativeId)
        else unconfirmedIds.push(nativeId)
      }
      const removedConfirmedIds = removedIds.filter((id) => !byId.has(id))
      const removedUnconfirmed = removedIds.filter((id) => byId.has(id))
      // Hard gate (round-6): ANY execution error forbids an applied verdict,
      // even an error that cannot be attributed to a specific plan file
      // (mkdir/readdir failures land in errors without a plan-file prefix).
      const allConfirmed = unconfirmedIds.length === 0 && removedUnconfirmed.length === 0 && erroredIds.length === 0 && outcome.errors.length === 0
      return {
        ...base,
        outcome: allConfirmed ? "applied" : "unconfirmed",
        applied: allConfirmed,
        appliedStatus: {
          status: allConfirmed ? "applied" : "unconfirmed",
          observedBy: "host-agent-list",
          confirmedIds,
          removedConfirmedIds,
          unconfirmedIds: [...unconfirmedIds, ...erroredIds, ...removedUnconfirmed],
        },
      }
    })
    if (execResult === null) {
      // Unreachable (every branch returns); kept as a fail-closed guard.
      return { ok: false, action: "apply", reason: "unavailable", message: "sync execution produced no verdict — nothing is claimed" }
    }
    // Same-epoch receipt annotation (deps.attachSyncOutcome → the store's
    // attachSyncOutcome): the outcome SUMMARY rides the saved receipt without
    // reviving anything. An unknown commitId is disclosed, never fatal.
    if (execResult.ok && execResult.action === "apply" && typeof input.commitId === "string" && typeof deps.attachSyncOutcome === "function") {
      const appliedResult = execResult
      let attached = false
      try {
        attached = deps.attachSyncOutcome(input.commitId, {
          action: "sync",
          outcome: appliedResult.outcome,
          applied: appliedResult.applied,
          path: appliedResult.path,
          created: appliedResult.created,
          updated: appliedResult.updated,
          gced: appliedResult.gced,
          conflicts: appliedResult.conflicts,
          appliedStatus: appliedResult.appliedStatus,
          at: appliedResult.at,
        })
      } catch {
        attached = false
      }
      if (!attached) {
        appliedResult.summary.push(`note: the sync outcome could not be attached to receipt ${input.commitId} (unknown or evicted — the sync result above remains authoritative)`)
      }
    }
    return execResult
  }

  return async (raw: unknown): Promise<SyncOutput> => {
    const checked = validateInput(raw)
    if ("refuse" in checked) return checked.refuse
    try {
      return checked.input.action === "prepare" ? prepare(checked.input) : await apply(checked.input)
    } catch (err) {
      return { ok: false, action: checked.input.action, reason: "unavailable", message: `sync ${checked.input.action} failed: ${err instanceof Error ? err.message : String(err)}` }
    }
  }
}

// The compiled body's observation: equality against the host row's `system`
// under the same normalization. A row without a string system cannot confirm
// (fail-soft).
function systemObserved(expected: string | null, rowSystem: unknown): boolean {
  if (expected === null) return false
  return typeof rowSystem === "string" && rowSystem === expected
}

// Capture helper for the plugin wiring (the commit protocol's beforeCommit
// seam): a full pre-publish baseline over the CURRENT fresh authoritative
// resolution. Unknown coverage is captured AS UNKNOWN — a dependent sync
// against it refuses with zero writes rather than diffing a partial picture.
export function captureSyncBaseline(req: { ownerFile: string; anchor: string | null; observedLocation: string | null }, resolvePools: () => SyncResolutionSnapshot | null, clock: () => number): SyncBaseline {
  const at = clock()
  const snap = resolvePools()
  if (snap === null) {
    return { v: 1, at, coverage: "unknown", reason: "no-coverage", ownerFile: req.ownerFile, anchor: req.anchor, observedLocation: req.observedLocation, familyNs: null, materializedIds: [], before: { ownerByMatId: {}, contentByMatId: {}, collisionFindings: [] } }
  }
  const family = findFamily(snap.resolution, req.ownerFile)
  return {
    v: 1,
    at,
    coverage: "full",
    ownerFile: req.ownerFile,
    anchor: req.anchor,
    observedLocation: req.observedLocation,
    familyNs: family?.ns ?? null,
    materializedIds: family ? [...family.materializedIds] : [],
    before: baselineSnapshotOf(snap.resolution),
  }
}
