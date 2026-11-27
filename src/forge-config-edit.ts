// Pure recipe editing core (change forge-tui-subagent-config, design D4).
//
// Snapshot → draft validation → field-level edit plan → owner-confirmed
// commit. Data in, data out: every fs dependency is injectable and tests
// drive the exact code the TUI wiring runs (no SDK imports here).
//
// Contract highlights:
//   - An UPDATE patches only the DIFFERING fields inside the existing
//     entry member (design correction 2026-11-27): unknown keys and
//     comments inside the entry survive; Auto conversion removes ONLY the
//     model/thoughtLevel members — prompt/shape/permission NOT carried by
//     the draft are preserved as-is, never cleared (partial-draft rule).
//   - A PINNED draft without BOTH halves refuses (never degrades to Auto);
//     an AUTO draft carrying stray pin fields refuses (never half-pins).
//   - DELETE removes the entry member (a JSON patch) — never the recipe
//     file. An existing id is immutable (renameTo refuses the plan).
//   - Duplicate keys at an edit target refuse the plan as ambiguous.
//   - The commit compares the CURRENT file BYTES against the snapshot
//     bytes (a same-length rewrite or a restored timestamp defeats
//     stat-only checks) plus the stat identity, refuses stale snapshots,
//     reports no-ops with zero writes and verifies the write landed as
//     planned. Write discipline: an INJECTED writeFile is this fs's
//     atomic write primitive (the injector owns durability — tests use a
//     memory fs); with NO injected write surface the REAL node:fs path
//     runs exclusive-create temp + rename with a freshness re-check
//     between the temp write and the rename, refusing unsafe targets
//     (symlink / hard-linked destinations). There is no direct-write
//     bypass of the real path.
//   - Snapshot AND commit re-read through a STRICT UTF-8 decode (real
//     Buffer: fatal decode; string: lone surrogates rejected) —
//     undecodable content snapshots as unreadable and refuses every edit;
//     lossy-decoded bytes are never rewritten.
//   - The REAL write path creates the parent tree only through verified
//     real directories (every existing ancestor is lstat/realpath-checked;
//     a symlink/junction ancestor refuses), writes its exclusive-create
//     temp with mode 0600, cleans only the temp it actually OWNS in the
//     finally (a name that came back EEXIST belongs to a foreign file and
//     is never touched), re-verifies REPLACE freshness / CREATION absence
//     before the publish, and publishes a CREATION with an exclusive link
//     (EEXIST refuses; hardlink-less filesystems fail closed — no rename
//     fallback). The INJECTED surface follows the same protocol: writeFile
//     is a temp writer only, rename is the required publisher, CREATION
//     re-verifies absence twice (the second check immediately before the
//     seam is handed out) and prefers an exclusive `link` seam whose
//     EEXIST reports conflict with the competing bytes intact — a bare
//     destination write is never performed.

import { lstatSync, linkSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { parseForgeJsonc, validateAgentSet, validatePoolField, BUILTIN_OVERRIDE_IDS, type ForgeConfigFinding } from "./forge-config.ts"
import { insertEntry, insertField, locateEntry, objectFields, removeEntry, removeField, replaceFieldValue, scanTopLevelKeys, type JsoncEditErrReason, type JsoncRange } from "./jsonc-edit.ts"
import { defaultIdentityStat, identityMatches, isUnsafeIdentityError, normalizeFileIdentity, type FileIdentity, type FileIdentityInput } from "./file-identity.ts"

// Strict UTF-8 decoder (fatal: invalid bytes throw instead of U+FFFD-mangling
// the document; ignoreBOM keeps a leading BOM character so bytes round-trip).
const UTF8_STRICT = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })

// Default read: raw Buffer → strict UTF-8. Invalid encoding throws (the
// snapshot then reports readable=false) — never a lossy decode.
function defaultReadFile(path: string): string {
  return UTF8_STRICT.decode(readFileSync(path))
}

// Strict decode everywhere a file's bytes enter this module: a Buffer (or
// any binary view) decodes fatally; a string carrying lone surrogates (the
// telltale of an upstream lossy decode) is rejected too. Undecodable
// content refuses the edit/write — it is never a silent rewrite source.
function strictDecode(bytes: unknown): string {
  if (typeof bytes === "string") {
    for (const ch of bytes) {
      const cp = ch.codePointAt(0) as number
      if (cp >= 0xd800 && cp <= 0xdfff) throw new Error("invalid UTF-8 content: lone surrogate (lossy decode) detected")
    }
    return bytes
  }
  if (bytes instanceof Uint8Array) return UTF8_STRICT.decode(bytes)
  return UTF8_STRICT.decode(Buffer.from(bytes as string))
}

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

// Canonical identity shape lives in ./file-identity.ts: dev/ino are
// canonical decimal STRINGS (real inodes exceed the safe-integer range —
// Number() would round them) and every sample comes from one bigint stat.
// Re-exported for the existing kernel consumers; seam inputs may still
// hand over safe-number dev/ino via FileIdentityInput and are normalized
// at the entry — an unsafe identity throws (never degrades to null and
// never String()-repaired).
export type { FileIdentity, FileIdentityInput } from "./file-identity.ts"

export type RecipeSnapshot = {
  path: string
  // stat said the path exists (absent and unreadable are distinguished).
  exists: boolean
  // The bytes could be read (an unreadable file still snapshots its stat
  // identity and refuses edits rather than being treated as absent).
  readable: boolean
  // Exact raw bytes (utf8 string), null when unreadable or absent.
  raw: string | null
  stat: FileIdentity | null
  parse: { ok: true; value: unknown } | { ok: false; message: string } | null
}

export type SnapshotDeps = {
  path: string
  // May return the canonical identity or a seam input carrying safe-number
  // dev/ino; normalized at this entry — an unsafe identity THROWS here
  // (never disguised as null = absent).
  stat?: (path: string) => FileIdentityInput | null
  readFile?: (path: string) => string
}

export function snapshotRecipe(deps: SnapshotDeps): RecipeSnapshot {
  const stat = deps.stat ?? defaultIdentityStat
  const readFile = deps.readFile ?? defaultReadFile
  const rawStat = stat(deps.path)
  const st = rawStat === null ? null : normalizeFileIdentity(rawStat)
  if (st === null) {
    return { path: deps.path, exists: false, readable: false, raw: null, stat: null, parse: null }
  }
  let raw: string | null = null
  try {
    // STRICT decode on every snapshot: a Buffer decodes fatally; an
    // injected string is checked for lone surrogates (the fingerprint of a
    // lossy upstream decode). Undecodable content snapshots as unreadable
    // and refuses every edit — it is never planned over or rewritten.
    raw = strictDecode(readFile(deps.path))
  } catch {
    return { path: deps.path, exists: true, readable: false, raw: null, stat: st, parse: null }
  }
  const parsed = parseForgeJsonc(raw)
  const parse: RecipeSnapshot["parse"] = parsed.ok ? { ok: true, value: parsed.config } : { ok: false, message: `${parsed.error.message}${parsed.error.line !== undefined ? ` (line ${parsed.error.line}, column ${parsed.error.column})` : ""}` }
  return { path: deps.path, exists: true, readable: true, raw, stat: st, parse }
}

// ---------------------------------------------------------------------------
// Drafts
// ---------------------------------------------------------------------------

export type EntryDraft = {
  mode: "auto" | "pinned"
  model?: string
  thoughtLevel?: string
  prompt?: string
  shape?: "readonly" | "write"
  permission?: Record<string, string>
}

// The editable worker fields (spec: "exactly model, thoughtLevel, shape,
// prompt, permission, plus the ID at creation").
export const EDITABLE_FIELDS: readonly string[] = ["model", "thoughtLevel", "prompt", "shape", "permission"]

const AGENT_ID_RE = /^[a-z0-9-]+$/

// Reserved-prefix self-heal mirror (same semantics as validateAgentSet):
// the materializer adds `forge-` itself, so a prefixed id is stripped with a
// warn finding; empty-after-strip is invalid.
export function normalizeWorkerId(rawId: string): { id: string; findings: ForgeConfigFinding[] } {
  const findings: ForgeConfigFinding[] = []
  let id = rawId
  if (rawId.startsWith("forge-")) {
    id = rawId.replace(/^(forge-)+/, "")
    findings.push({ level: "warn", code: "agent-id-forge-prefix", message: `id "${rawId}": the forge- prefix is added automatically at materialization — using "${id}"` })
  }
  return { id, findings }
}

// Draft field sanity (draft-SPECIFIED fields only — untouched fields are
// preserved raw and validated by the live contract at resolve time, with
// their existing findings disclosed):
//   - pinned requires BOTH model and thoughtLevel (never degrades to Auto);
//   - auto carries neither pin field;
//   - prompt must be a non-empty string, shape a valid word, permission a
//     string→string map — an invalid specified value refuses the plan
//     (writing it would silently drop the user's input).
function validateDraftShape(draft: EntryDraft): ForgeConfigFinding[] {
  const findings: ForgeConfigFinding[] = []
  if (draft.mode === "pinned") {
    if (typeof draft.model !== "string" || draft.model.trim().length === 0 || typeof draft.thoughtLevel !== "string" || draft.thoughtLevel.trim().length === 0) {
      findings.push({ level: "error", code: "agent-half-configured", message: "pinned mode requires BOTH model and thoughtLevel — a pin with a missing half is refused (it would silently degrade to an Auto worker)" })
    }
  } else if (draft.model !== undefined || draft.thoughtLevel !== undefined) {
    findings.push({ level: "error", code: "auto-with-pin-fields", message: "auto mode cannot carry model or thoughtLevel — switch to pinned mode to set the pair" })
  }
  if (draft.prompt !== undefined && !(typeof draft.prompt === "string" && draft.prompt.trim().length > 0)) {
    findings.push({ level: "error", code: "prompt-invalid", message: "prompt must be a non-empty string" })
  }
  if (draft.shape !== undefined && draft.shape !== "readonly" && draft.shape !== "write") {
    findings.push({ level: "error", code: "shape-invalid", message: 'shape must be "readonly" or "write"' })
  }
  if (draft.permission !== undefined && !(typeof draft.permission === "object" && draft.permission !== null && !Array.isArray(draft.permission) && Object.values(draft.permission).every((v) => typeof v === "string"))) {
    findings.push({ level: "error", code: "permission-invalid", message: "permission must map tool names to string values" })
  }
  return findings
}

// Draft → normalized definition via the LIVE recipe contract (trimmed
// model, lowercased thoughtLevel, atomic pair). `ok` is false when any
// ERROR-level finding exists.
function validatedDefOf(id: string, draft: EntryDraft): { ok: boolean; def: Record<string, unknown>; findings: ForgeConfigFinding[] } {
  const entry: Record<string, unknown> = {}
  if (draft.mode === "pinned") {
    entry.model = draft.model
    entry.thoughtLevel = draft.thoughtLevel
  }
  if (draft.prompt !== undefined) entry.prompt = draft.prompt
  if (draft.shape !== undefined) entry.shape = draft.shape
  if (draft.permission !== undefined) entry.permission = draft.permission
  const { id: normalizedId } = normalizeWorkerId(id)
  const validated = validateAgentSet({ [normalizedId]: entry }, "agents")
  const def = (validated.agents[normalizedId] ?? {}) as Record<string, unknown>
  return { ok: !validated.findings.some((f) => f.level === "error"), def, findings: validated.findings }
}

export type DraftValidation = { ok: boolean; findings: ForgeConfigFinding[]; normalizedId: string }

// Validate a worker draft + id against the live contract. `existingIds` are
// the RAW container keys — the normalized-id collision check mirrors the
// resolver's first-definition-wins rule.
export function validateWorkerDraft(id: string, draft: EntryDraft, existingIds: string[]): DraftValidation {
  const { id: normalizedId, findings } = normalizeWorkerId(id)
  if (!normalizedId || !AGENT_ID_RE.test(normalizedId)) {
    return { ok: false, findings: [...findings, { level: "error", code: "agent-id-invalid", message: `agent id must match [a-z0-9-] after forge- prefix stripping — "${id}" is invalid` }], normalizedId }
  }
  const normalizedExisting = new Set(existingIds.map((k) => normalizeWorkerId(k).id))
  if (normalizedExisting.has(normalizedId)) {
    return { ok: false, findings: [...findings, { level: "error", code: "agent-id-collision", message: `"${normalizedId}" already exists in this recipe (ids that normalize to the same word collide; first definition wins)` }], normalizedId }
  }
  const shapeFindings = validateDraftShape(draft)
  if (shapeFindings.some((f) => f.level === "error")) {
    return { ok: false, findings: [...findings, ...shapeFindings], normalizedId }
  }
  const check = validatedDefOf(normalizedId, draft)
  return { ok: check.ok, findings: [...findings, ...shapeFindings, ...check.findings], normalizedId }
}

// Override drafts: the id must be an exact built-in (lowercase
// general/explore — the probe-established identity key; a `forge-`-prefixed
// id is NOT an override id and never normalizes into one); the definition
// reuses the live agent validation.
export function validateOverrideDraft(id: string, draft: EntryDraft): DraftValidation {
  if (!(BUILTIN_OVERRIDE_IDS as readonly string[]).includes(id)) {
    return { ok: false, findings: [{ level: "error", code: "override-id-unknown", message: `override ids are exactly ${BUILTIN_OVERRIDE_IDS.map((i) => `"${i}"`).join(", ")} (lowercase, case-sensitive) — "${id}" is not a built-in subagent id (a forge- prefix never normalizes into an override id)` }], normalizedId: id }
  }
  const shapeFindings = validateDraftShape(draft)
  if (shapeFindings.some((f) => f.level === "error")) {
    return { ok: false, findings: shapeFindings, normalizedId: id }
  }
  const check = validatedDefOf(id, draft)
  return { ok: check.ok, findings: check.findings, normalizedId: id }
}

// ---------------------------------------------------------------------------
// Edit plans
// ---------------------------------------------------------------------------

export type PlanContainer = "agents" | "override"

export type PlanKind = "patch" | "remove" | "no-op" | "create-file"

export type PlanErrReason =
  | "unparseable"
  | "ambiguous"
  | "invalid-id"
  | "invalid-draft"
  | "invalid-pool"
  | "invalid-scope"
  | "not-found"
  | "duplicate"
  | "unreadable"

export type EditPlan = {
  kind: PlanKind
  action: "create" | "update" | "delete"
  path: string
  container: PlanContainer
  id: string
  // The full new file content (create-file: the initial document; no-op:
  // byte-equal to the snapshot).
  newText: string
  summary: string[]
}

export type PlanResult =
  | { ok: true; plan: EditPlan; findings: ForgeConfigFinding[] }
  | { ok: false; reason: PlanErrReason; message: string; detail: string; findings: ForgeConfigFinding[] }

export type PlanOp = {
  action: "create" | "update" | "delete"
  id: string
  draft?: EntryDraft
  // Presence refuses the plan: an existing id is immutable in the form.
  renameTo?: string
}

export type PlanOpts = {
  // Workspace pool creation REQUIRES a valid declared pool name (global
  // creation needs none — the global namespace is fixed).
  pool?: string
  scope?: "workspace" | "global"
}

const planErr = (reason: PlanErrReason, message: string, findings: ForgeConfigFinding[] = []): PlanResult => ({ ok: false, reason, message, detail: message, findings })

// jsonc-edit reasons fold into plan reasons: a missing container means the
// entry cannot exist ("not-found"); a non-object container is a broken
// document shape ("unparseable"). The rest map 1:1.
function foldJsoncReason(reason: JsoncEditErrReason): "unparseable" | "ambiguous" | "not-found" {
  if (reason === "container-missing") return "not-found"
  if (reason === "container-not-object") return "unparseable"
  return reason
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const ka = Object.keys(a as object)
  const kb = Object.keys(b as object)
  if (ka.length !== kb.length) return false
  return ka.every((k) => k in (b as object) && deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
}

// Field-level patch of ONE existing entry. `setFields` are the fields the
// draft explicitly sets (replaced/inserted only when they actually
// differ); `removeFields` must be absent afterwards (the Auto pin-pair
// removal). EVERY other member of the entry — unknown keys, comments,
// untouched editable fields — survives byte-for-byte. A targeted field
// that appears more than once in the entry is an ambiguous edit target
// and refuses (a partial removal would leave a half-configured entry).
function patchEntryFields(
  raw: string,
  container: PlanContainer,
  id: string,
  setFields: Record<string, unknown>,
  removeFields: readonly string[],
): { ok: true; text: string; summary: string[] } | { ok: false; message: string } {
  let working = raw
  const summary: string[] = []
  for (const key of EDITABLE_FIELDS) {
    const want = setFields[key]
    const shouldRemove = removeFields.includes(key)
    if (want === undefined && !shouldRemove) continue // untouched → preserve
    // Permission maps are patched SUB-KEY by SUB-KEY (never rewritten):
    // sibling entries and their comments survive a single-key change. A
    // NON-map current permission value falls through to the generic
    // whole-value replace below instead of being silently skipped.
    if (key === "permission" && want !== undefined && typeof want === "object" && want !== null && !Array.isArray(want)) {
      const patched = patchPermissionSubKeys(working, container, id, want as Record<string, unknown>)
      if (!patched.ok) return patched
      if (patched.subPatched) {
        working = patched.text
        summary.push(...patched.notes)
        continue
      }
    }
    // Re-locate after every patch — byte offsets shift as members change.
    const loc = locateEntry(working, container, id)
    if (!loc.ok) return { ok: false, message: `entry became unlocatable mid-plan: ${loc.detail}` }
    const fields = objectFields(working, loc.entry)
    if (!fields.ok) return { ok: false, message: `the "${container}.${id}" entry is not an object — refusing a field-level edit` }
    const matches = fields.fields.filter((f) => f.key === key)
    if (matches.length > 1) {
      return { ok: false, message: `"${container}.${id}.${key}" is defined ${matches.length} times — ambiguous edit target, refusing` }
    }
    const have = matches[0]
    if (want !== undefined) {
      const wantJson = JSON.stringify(want)
      if (have !== undefined) {
        // Compare parsed values (JSONC-tolerant: a current permission value
        // with comments must not block an unrelated prompt edit).
        const currentText = working.slice(have.value.start, have.value.end)
        const current = parseForgeJsonc(currentText)
        if (current.ok && deepEqual(current.config, want)) continue
        // Live trim semantics: the validated definition trims model and
        // trims+lowercases thoughtLevel, but raw values are preserved
        // verbatim — a pin whose raw bytes carry surrounding spaces and/or
        // non-lowercase casing (`" p/m "`, `" CuStOm "`) is the SAME pin
        // the draft normalizes to, so it is skipped and its bytes survive
        // an unrelated prompt-only edit.
        if ((key === "model" || key === "thoughtLevel") && current.ok && typeof current.config === "string" && typeof want === "string") {
          const haveNorm = key === "model" ? current.config.trim() : current.config.trim().toLowerCase()
          const wantNorm = key === "model" ? want.trim() : want.trim().toLowerCase()
          if (haveNorm === wantNorm) continue
        }
        const replaced = replaceFieldValue(working, have.value, wantJson)
        working = replaced.text
        summary.push(`set ${id}.${key} = ${wantJson}`)
      } else {
        const inserted = insertField(working, loc.entry, key, wantJson)
        if (!inserted.ok) return { ok: false, message: `could not add ${id}.${key}: ${inserted.detail}` }
        working = inserted.text
        summary.push(`add ${id}.${key} = ${wantJson}`)
      }
    } else if (shouldRemove && have !== undefined) {
      const removed = removeField(working, have.member)
      working = removed.text
      summary.push(`remove ${id}.${key}`)
    }
  }
  return { ok: true, text: working, summary }
}

// One sub-key operation (set/insert, or remove when `value` is null) inside
// the entry's existing permission map. Everything else in the map — sibling
// entries, their comments, unknown keys — survives byte-for-byte; the map
// value itself is NEVER serialized wholesale. Each call re-locates (byte
// offsets shift with every prior op); duplicate sub-keys refuse ambiguous.
function patchPermissionSubKeys(
  raw: string,
  container: PlanContainer,
  id: string,
  want: Record<string, unknown>,
): { ok: true; text: string; notes: string[]; subPatched: boolean } | { ok: false; message: string } {
  let working = raw
  const notes: string[] = []
  const currentMapOf = (text: string): { ok: true; map: Record<string, unknown> } | { ok: false; message: string } => {
    const loc = locateEntry(text, container, id)
    if (!loc.ok) return { ok: false, message: `entry became unlocatable mid-plan: ${loc.detail}` }
    const fields = objectFields(text, loc.entry)
    if (!fields.ok) return { ok: false, message: `the "${container}.${id}" entry is not an object — refusing a field-level edit` }
    const perms = fields.fields.filter((f) => f.key === "permission")
    if (perms.length === 0) return { ok: true, map: {} }
    if (perms.length > 1) return { ok: false, message: `"${container}.${id}.permission" is defined ${perms.length} times — ambiguous edit target, refusing` }
    const parsed = parseForgeJsonc(text.slice(perms[0].value.start, perms[0].value.end))
    if (!parsed.ok || typeof parsed.config !== "object" || parsed.config === null || Array.isArray(parsed.config)) {
      // A non-map permission value cannot be sub-key patched — it is
      // replaced wholesale by the generic field path instead.
      return { ok: false, message: "not-a-map" }
    }
    return { ok: true, map: parsed.config as Record<string, unknown> }
  }
  const first = currentMapOf(working)
  if (!first.ok && first.message !== "not-a-map") return first
  if (!first.ok) return { ok: true, text: raw, notes: [], subPatched: false } // caller's generic path handles it
  // Removals: current sub-keys the draft no longer lists.
  for (const subKey of Object.keys(first.map)) {
    if (subKey in want) continue
    const r = permissionSubKeyOp(working, container, id, subKey, null)
    if (!r.ok) return r
    working = r.text
    if (r.changed) notes.push(`remove ${id}.permission.${subKey}`)
  }
  // Sets/inserts for the draft's sub-keys (only actual differences).
  for (const [subKey, value] of Object.entries(want)) {
    const r = permissionSubKeyOp(working, container, id, subKey, value)
    if (!r.ok) return r
    working = r.text
    if (r.changed) notes.push(`set ${id}.permission.${subKey} = ${JSON.stringify(value)}`)
  }
  return { ok: true, text: working, notes, subPatched: true }
}

function permissionSubKeyOp(
  raw: string,
  container: PlanContainer,
  id: string,
  subKey: string,
  value: unknown | null,
): { ok: true; text: string; changed: boolean } | { ok: false; message: string } {
  const loc = locateEntry(raw, container, id)
  if (!loc.ok) return { ok: false, message: `entry became unlocatable mid-plan: ${loc.detail}` }
  const fields = objectFields(raw, loc.entry)
  if (!fields.ok) return { ok: false, message: `the "${container}.${id}" entry is not an object — refusing a field-level edit` }
  const perms = fields.fields.filter((f) => f.key === "permission")
  if (perms.length === 0) {
    if (value === null) return { ok: true, text: raw, changed: false }
    const mapJson = `{${JSON.stringify(subKey)}: ${JSON.stringify(value)}}`
    const inserted = insertField(raw, loc.entry, "permission", mapJson)
    if (!inserted.ok) return { ok: false, message: `could not add ${id}.permission: ${inserted.detail}` }
    return { ok: true, text: inserted.text, changed: true }
  }
  if (perms.length > 1) return { ok: false, message: `"${container}.${id}.permission" is defined ${perms.length} times — ambiguous edit target, refusing` }
  const mapRange = perms[0].value
  const parsed = parseForgeJsonc(raw.slice(mapRange.start, mapRange.end))
  if (!parsed.ok || typeof parsed.config !== "object" || parsed.config === null || Array.isArray(parsed.config)) {
    return { ok: false, message: `"${container}.${id}.permission" is not a map — refusing a sub-key edit` }
  }
  const sub = objectFields(raw, mapRange)
  if (!sub.ok) return { ok: false, message: sub.detail }
  const hits = sub.fields.filter((f) => f.key === subKey)
  if (hits.length > 1) return { ok: false, message: `"${container}.${id}.permission.${subKey}" is defined ${hits.length} times — ambiguous edit target, refusing` }
  const have = hits[0]
  if (value === null) {
    if (have === undefined) return { ok: true, text: raw, changed: false }
    const removed = removeField(raw, have.member)
    return { ok: true, text: removed.text, changed: true }
  }
  const wantJson = JSON.stringify(value)
  if (have !== undefined) {
    const current = parseForgeJsonc(raw.slice(have.value.start, have.value.end))
    if (current.ok && deepEqual(current.config, value)) return { ok: true, text: raw, changed: false }
    const replaced = replaceFieldValue(raw, have.value, wantJson)
    return { ok: true, text: replaced.text, changed: true }
  }
  const inserted = insertField(raw, mapRange, subKey, wantJson)
  if (!inserted.ok) return { ok: false, message: `could not add ${id}.permission.${subKey}: ${inserted.detail}` }
  return { ok: true, text: inserted.text, changed: true }
}

// Initial document for a missing recipe file (explicit creation only).
function buildInitialFile(opts: { pool?: string; container: PlanContainer; id: string; entryJson: string }): string {
  const lines: string[] = ["{"]
  if (opts.pool !== undefined) {
    lines.push(`  "pool": ${JSON.stringify(opts.pool)},`)
  }
  lines.push(`  "${opts.container}": {`)
  lines.push(`    ${JSON.stringify(opts.id)}: ${opts.entryJson}`)
  lines.push("  }")
  lines.push("}")
  return `${lines.join("\n")}\n`
}

// Entry JSON in canonical field order (model, thoughtLevel, prompt, shape,
// permission) from a validated definition.
function entryJsonOf(def: Record<string, unknown>): string {
  const ordered: Record<string, unknown> = {}
  for (const key of EDITABLE_FIELDS) {
    if (def[key] !== undefined) ordered[key] = def[key]
  }
  return JSON.stringify(ordered)
}

// The raw container keys (for normalized-id collision checks).
function existingEntryIds(raw: string, container: PlanContainer): { ok: true; ids: string[] } | { ok: false; message: string } {
  const top = scanTopLevelKeys(raw)
  if (!top.ok) return { ok: false, message: top.detail }
  const found = top.top.find((m) => m.key === container)
  if (!found) return { ok: true, ids: [] }
  const fields = objectFields(raw, found.value)
  if (!fields.ok) return { ok: false, message: fields.detail }
  return { ok: true, ids: fields.fields.map((f) => f.key) }
}

// The update patch inputs from a draft: the pin pair is set (pinned) or
// removed (Auto); other fields ride ONLY when the draft specifies them.
function patchInputsOf(draft: EntryDraft, def: Record<string, unknown>): { setFields: Record<string, unknown>; removeFields: string[] } {
  const setFields: Record<string, unknown> = {}
  const removeFields: string[] = []
  if (draft.mode === "pinned") {
    setFields.model = def.model
    setFields.thoughtLevel = def.thoughtLevel
  } else {
    removeFields.push("model", "thoughtLevel")
  }
  if (draft.prompt !== undefined) setFields.prompt = def.prompt
  if (draft.shape !== undefined) setFields.shape = def.shape
  if (draft.permission !== undefined) setFields.permission = def.permission
  return { setFields, removeFields }
}

function planEntryEdit(
  snapshot: RecipeSnapshot,
  op: PlanOp,
  opts: PlanOpts,
  container: PlanContainer,
  kind: "worker" | "override",
): PlanResult {
  const findings: ForgeConfigFinding[] = []
  if (op.renameTo !== undefined && op.renameTo !== op.id) {
    return planErr("invalid-id", "renaming an existing entry id is not supported — create the new id explicitly and delete the old one", findings)
  }
  if (kind === "override") {
    // The built-in whitelist governs EVERY override action (create, update
    // AND delete): only exact lowercase general/explore are override ids.
    if (!(BUILTIN_OVERRIDE_IDS as readonly string[]).includes(op.id)) {
      if (opts.scope === "workspace") return planErr("invalid-scope", "override entries live only on the GLOBAL recipe (~/.config/opencode/forge.json) — a workspace pool file may not carry them", findings)
      return planErr("invalid-id", `override ids are exactly ${BUILTIN_OVERRIDE_IDS.map((i) => `"${i}"`).join(", ")} (lowercase, case-sensitive) — "${op.id}" is not a built-in subagent id (a forge- prefix never normalizes into an override id)`, findings)
    }
    if (opts.scope === "workspace") {
      return planErr("invalid-scope", "override entries live only on the GLOBAL recipe (~/.config/opencode/forge.json) — a workspace pool file may not carry them", findings)
    }
  }
  // Absent file: only explicit creation proceeds. A file that exists but
  // cannot be read refuses EVERY action (creation over unknown bytes is
  // destructive). Worker creation requires a valid declared pool name on
  // the WORKSPACE scope only (the global namespace is fixed).
  if (!snapshot.exists) {
    if (op.action !== "create") {
      return planErr("not-found", `no recipe file at ${snapshot.path} — nothing to ${op.action}`, findings)
    }
    const wantsPool = kind === "worker" && opts.scope !== "global"
    if (wantsPool && opts.pool === undefined) {
      return planErr("invalid-pool", "creating a workspace pool file requires a valid declared pool name ([a-z0-9-], 1-24 chars) — pass opts.pool", findings)
    }
    if (wantsPool && !validatePoolField(opts.pool).ok) {
      return planErr("invalid-pool", `"${String(opts.pool)}" is not a valid pool namespace ([a-z0-9-], 1-24 chars after trim)`, findings)
    }
    const validate = kind === "worker" ? validateWorkerDraft(op.id, op.draft ?? { mode: "auto" }, []) : validateOverrideDraft(op.id, op.draft ?? { mode: "auto" })
    findings.push(...validate.findings)
    if (!validate.ok) {
      const isId = validate.findings.some((f) => f.level === "error" && (f.code === "agent-id-invalid" || f.code === "agent-id-collision" || f.code === "override-id-unknown"))
      return planErr(isId ? "invalid-id" : "invalid-draft", validate.findings.filter((f) => f.level === "error").map((f) => f.message).join("; "), findings)
    }
    const check = validatedDefOf(validate.normalizedId, op.draft ?? { mode: "auto" })
    const content = buildInitialFile({ pool: wantsPool ? opts.pool : undefined, container, id: validate.normalizedId, entryJson: entryJsonOf(check.def) })
    if (!parseForgeJsonc(content).ok) {
      return planErr("unparseable", "the initial document this plan produces does not parse — refusing", findings)
    }
    if (kind === "worker" && wantsPool) {
      // Spec: creation of a missing workspace recipe warns that it replaces
      // the global fallback — the create-file path carries the consequence.
      findings.push({ level: "warn", code: "tui-fallback-replaced", message: `creating "${validate.normalizedId}" in this workspace pool replaces the global fallback for this roster` })
    }
    return {
      ok: true,
      plan: {
        kind: "create-file",
        action: "create",
        path: snapshot.path,
        container,
        id: validate.normalizedId,
        newText: content,
        summary: [`create ${container}.${validate.normalizedId} in ${snapshot.path}${wantsPool ? ` (pool "${opts.pool}")` : " (global)"}`],
      },
      findings,
    }
  }
  if (snapshot.raw === null) {
    return planErr("unreadable", `the recipe at ${snapshot.path} exists but cannot be read (unreadable bytes or invalid UTF-8) — refusing every edit, including creation`, findings)
  }
  const raw = snapshot.raw
  const parse = snapshot.parse
  if (parse === null || !parse.ok) {
    const detail = parse && !parse.ok ? parse.message : "unparseable document"
    return planErr("unparseable", `${snapshot.path}: ${detail} — broken documents are never edited in place; fix the syntax first`, findings)
  }
  if (parse.value === null || typeof parse.value !== "object" || Array.isArray(parse.value)) {
    return planErr("unparseable", `${snapshot.path}: top level must be an object — refusing to edit`, findings)
  }

  if (kind === "worker") {
    if (op.action === "create") {
      const existing = existingEntryIds(raw, container)
      if (!existing.ok) return planErr("unparseable", existing.message, findings)
      const validate = validateWorkerDraft(op.id, op.draft ?? { mode: "auto" }, existing.ids)
      findings.push(...validate.findings)
      if (!validate.ok) {
        const isDup = validate.findings.some((f) => f.code === "agent-id-collision")
        const isId = validate.findings.some((f) => f.code === "agent-id-invalid")
        return planErr(isDup ? "duplicate" : isId ? "invalid-id" : "invalid-draft", validate.findings.filter((f) => f.level === "error").map((f) => f.message).join("; "), findings)
      }
      const check = validatedDefOf(validate.normalizedId, op.draft ?? { mode: "auto" })
      const inserted = insertEntry(raw, container, validate.normalizedId, entryJsonOf(check.def), { createContainer: true })
      if (!inserted.ok) return planErr(inserted.reason === "ambiguous" ? "duplicate" : foldJsoncReason(inserted.reason), inserted.detail, findings)
      if (!parseForgeJsonc(inserted.text).ok) return planErr("unparseable", "the patched document does not parse — refusing", findings)
      // The fallback warning is workspace-only: creating a worker on the
      // GLOBAL file replaces nothing (there is no fallback above it).
      if (opts.scope !== "global") {
        findings.push({ level: "warn", code: "tui-fallback-replaced", message: `creating "${validate.normalizedId}" in this workspace pool replaces the global fallback for this roster` })
      }
      return {
        ok: true,
        plan: {
          kind: "patch",
          action: "create",
          path: snapshot.path,
          container,
          id: validate.normalizedId,
          newText: inserted.text,
          summary: [`create ${container}.${validate.normalizedId} in ${snapshot.path}`],
        },
        findings,
      }
    }
    // update / delete: the entry must exist (its id is immutable).
    const loc = locateEntry(raw, container, op.id)
    if (!loc.ok) return planErr(foldJsoncReason(loc.reason), `${container}.${op.id}: ${loc.detail}`, findings)
    if (op.action === "delete") {
      const removed = removeEntry(raw, container, op.id)
      if (!removed.ok) return planErr(foldJsoncReason(removed.reason), removed.detail, findings)
      if (!parseForgeJsonc(removed.text).ok) return planErr("unparseable", "the patched document does not parse — refusing", findings)
      return {
        ok: true,
        plan: {
          kind: "remove",
          action: "delete",
          path: snapshot.path,
          container,
          id: op.id,
          newText: removed.text,
          summary: [`delete ${container}.${op.id} from ${snapshot.path}`],
        },
        findings,
      }
    }
    const validate = validateWorkerDraft(op.id, op.draft ?? { mode: "auto" }, [])
    findings.push(...validate.findings)
    if (!validate.ok) {
      return planErr("invalid-draft", validate.findings.filter((f) => f.level === "error").map((f) => f.message).join("; "), findings)
    }
    const check = validatedDefOf(op.id, op.draft ?? { mode: "auto" })
    const { setFields, removeFields } = patchInputsOf(op.draft ?? { mode: "auto" }, check.def)
    const patched = patchEntryFields(raw, container, op.id, setFields, removeFields)
    if (!patched.ok) return planErr("ambiguous", patched.message, findings)
    if (!parseForgeJsonc(patched.text).ok) return planErr("unparseable", "the patched document does not parse — refusing", findings)
    if (patched.text === raw) {
      return {
        ok: true,
        plan: { kind: "no-op", action: "update", path: snapshot.path, container, id: op.id, newText: raw, summary: ["no field changes"] },
        findings,
      }
    }
    return {
      ok: true,
      plan: {
        kind: "patch",
        action: "update",
        path: snapshot.path,
        container,
        id: op.id,
        newText: patched.text,
        summary: patched.summary,
      },
      findings,
    }
  }

  // ---- override branch (global layer, general/explore only; the
  // whitelist check at the top already gated every action) ----
  // Full draft validation on EVERY override write too (the whitelist only
  // fixes the ID): a pinned draft without BOTH halves refuses here — a
  // half pin must never land as a `{}` or `{model}` stub.
  const validateOverride = validateOverrideDraft(op.id, op.draft ?? { mode: "auto" })
  findings.push(...validateOverride.findings)
  if (!validateOverride.ok) {
    return planErr("invalid-draft", validateOverride.findings.filter((f) => f.level === "error").map((f) => f.message).join("; "), findings)
  }
  if (op.action === "create") {
    const existing = existingEntryIds(raw, container)
    if (!existing.ok) return planErr("unparseable", existing.message, findings)
    // Normalized-identity collision (mirrors the live validator's
    // forge- prefix self-heal): a raw key `forge-general` holds the slot
    // that `general` would take — first definition wins downstream, so
    // the create refuses instead of silently landing a skipped entry.
    const normalizedExisting = new Set(existing.ids.map((k) => normalizeWorkerId(k).id))
    if (normalizedExisting.has(op.id)) {
      return planErr("duplicate", `override.${op.id} already exists — a key that normalizes onto it (forge-${op.id}) holds the slot (first definition wins); update it instead`, findings)
    }
    const check = validatedDefOf(op.id, op.draft ?? { mode: "auto" })
    const inserted = insertEntry(raw, container, op.id, entryJsonOf(check.def), { createContainer: true })
    if (!inserted.ok) return planErr(inserted.reason === "ambiguous" ? "duplicate" : foldJsoncReason(inserted.reason), inserted.detail, findings)
    if (!parseForgeJsonc(inserted.text).ok) return planErr("unparseable", "the patched document does not parse — refusing", findings)
    return {
      ok: true,
      plan: {
        kind: "patch",
        action: "create",
        path: snapshot.path,
        container: "override",
        id: op.id,
        newText: inserted.text,
        summary: [`activate override.${op.id} in ${snapshot.path} (machine-wide)`],
      },
      findings,
    }
  }
  const loc = locateEntry(raw, "override", op.id)
  if (!loc.ok) return planErr(foldJsoncReason(loc.reason), `override.${op.id}: ${loc.detail}`, findings)
  if (op.action === "delete") {
    const removed = removeEntry(raw, "override", op.id)
    if (!removed.ok) return planErr(foldJsoncReason(removed.reason), removed.detail, findings)
    if (!parseForgeJsonc(removed.text).ok) return planErr("unparseable", "the patched document does not parse — refusing", findings)
    return {
      ok: true,
      plan: {
        kind: "remove",
        action: "delete",
        path: snapshot.path,
        container: "override",
        id: op.id,
        newText: removed.text,
        summary: [`remove override.${op.id} from ${snapshot.path} (built-in behavior returns)`],
      },
      findings,
    }
  }
  const check = validatedDefOf(op.id, op.draft ?? { mode: "auto" })
  const { setFields, removeFields } = patchInputsOf(op.draft ?? { mode: "auto" }, check.def)
  const patched = patchEntryFields(raw, "override", op.id, setFields, removeFields)
  if (!patched.ok) return planErr("ambiguous", patched.message, findings)
  if (!parseForgeJsonc(patched.text).ok) return planErr("unparseable", "the patched document does not parse — refusing", findings)
  if (patched.text === raw) {
    return {
      ok: true,
      plan: { kind: "no-op", action: "update", path: snapshot.path, container: "override", id: op.id, newText: raw, summary: ["no field changes"] },
      findings,
    }
  }
  return {
    ok: true,
    plan: {
      kind: "patch",
      action: "update",
      path: snapshot.path,
      container: "override",
      id: op.id,
      newText: patched.text,
      summary: patched.summary,
    },
    findings,
  }
}

export function planWorkerEdit(snapshot: RecipeSnapshot, op: PlanOp, opts?: PlanOpts): PlanResult {
  return planEntryEdit(snapshot, op, opts ?? {}, "agents", "worker")
}

export function planOverrideEdit(snapshot: RecipeSnapshot, op: PlanOp, opts?: PlanOpts): PlanResult {
  return planEntryEdit(snapshot, op, opts ?? {}, "override", "override")
}

// ---------------------------------------------------------------------------
// Commit boundary
// ---------------------------------------------------------------------------

export type CommitErrReason = "conflict" | "missing" | "unreadable" | "unparseable" | "ownership-lost" | "write-failed"

export type CommitDeps = {
  // Seam input (safe-number dev/ino allowed); normalized at every call
  // site inside this module — an unsafe identity refuses the commit.
  stat?: (path: string) => FileIdentityInput | null
  readFile?: (path: string) => string
  // INJECTED ATOMIC PROTOCOL (API change 2026-11-27, review-mandated):
  // writeFile is a TEMP WRITER ONLY — the destination path is NEVER
  // handed to it (a bare destination write could corrupt the recipe on a
  // partial write). rename is the REQUIRED publisher (replace; and the
  // interim creation seam). CREATION prefers `link` — an EXCLUSIVE
  // publish surface whose contract is: MUST throw (EEXIST) when the
  // destination already exists and NEVER overwrite it. On the rename seam
  // a creation re-verifies absence a second time immediately before the
  // publish and honors a thrown EEXIST as a lost race (conflict, the
  // competing bytes stay); any other seam error fails the save.
  // With NO injected write surface the REAL node:fs path runs
  // exclusive-create temp + rename (replace) / exclusive hardlink publish
  // (creation). There is no direct-write bypass in either path.
  writeFile?: (path: string, data: string) => void
  rename?: (from: string, to: string) => void
  link?: (from: string, to: string) => void
  unlink?: (path: string) => void
  mkdir?: (path: string) => void
  // Injected ownership recheck (scope/anchor revalidation before replace).
  recheckOwnership?: () => boolean
}

export type CommitResult =
  | { ok: true; outcome: "written" | "no-op"; bytes: number }
  | { ok: false; reason: CommitErrReason; message: string }

let tempCounter = 0

// Normalize a seam stat result at every kernel entry that consumes one:
// an unsafe identity throws here (never confused with null = absent, no
// silent precision repair), canonical identities pass through.
function normalizedStat(st: FileIdentityInput | null): FileIdentity | null {
  return st === null ? null : normalizeFileIdentity(st)
}

export function commitRecipeEdit(snapshot: RecipeSnapshot, plan: { kind: PlanKind; path?: string; newText: string }, deps: CommitDeps = {}): CommitResult {
  const path = plan.path ?? snapshot.path
  if (deps.recheckOwnership !== undefined && deps.recheckOwnership() === false) {
    return { ok: false, reason: "ownership-lost", message: "the owning scope re-check failed — the target's owning pool or anchor changed since the snapshot" }
  }
  const stat = deps.stat ?? defaultIdentityStat
  const readFile = deps.readFile ?? defaultReadFile
  // Commit-boundary identity sampling: an unsafe identity becomes an
  // explicit zero-write CommitResult refusal (no temp, no publish) with
  // the same write-failed reason the write phase produces — never a raw
  // throw escaping the kernel. Only UnsafeIdentityError is converted;
  // every other error keeps propagating.
  const sampledIdentity = (p: string): { identity: FileIdentity | null; refusal: CommitResult | null } => {
    try {
      return { identity: normalizedStat(stat(p)), refusal: null }
    } catch (err) {
      if (!isUnsafeIdentityError(err)) throw err
      return { identity: null, refusal: { ok: false, reason: "write-failed", message: `unsafe file identity for ${p}: ${err.message} — refusing before any write (no temp, no publish)` } }
    }
  }
  // A no-op plan is zero-write, but NEVER blind: the current bytes and
  // identity are re-verified first — a competing edit that landed after
  // the snapshot (even at identical stat) refuses the no-op too.
  if (plan.kind === "no-op") {
    const sampledNoop = sampledIdentity(path)
    if (sampledNoop.refusal !== null) return sampledNoop.refusal
    const noopIdentity = sampledNoop.identity
    if (noopIdentity === null) return { ok: false, reason: "missing", message: `${path} no longer exists` }
    let noopRaw: string
    try {
      noopRaw = strictDecode(readFile(path))
    } catch (err) {
      return { ok: false, reason: "unreadable", message: `cannot read ${path}: ${err instanceof Error ? err.message : String(err)}` }
    }
    if (snapshot.raw !== null && noopRaw !== snapshot.raw) {
      return { ok: false, reason: "conflict", message: `${path} changed since the snapshot — the no-op verdict is stale; reload` }
    }
    if (snapshot.stat !== null && !identityMatches(noopIdentity, snapshot.stat)) {
      return { ok: false, reason: "conflict", message: `${path}'s identity changed since the snapshot — the no-op verdict is stale; reload` }
    }
    return { ok: true, outcome: "no-op", bytes: 0 }
  }
  const sampledPre = sampledIdentity(path)
  if (sampledPre.refusal !== null) return sampledPre.refusal
  const identity = sampledPre.identity
  if (plan.kind === "create-file") {
    // Creation: the file must still be absent (no-clobber).
    if (identity !== null) return { ok: false, reason: "conflict", message: `${path} appeared since the snapshot — reload before creating` }
  } else {
    if (identity === null) return { ok: false, reason: "missing", message: `${path} no longer exists` }
    let currentRaw: string
    try {
      currentRaw = strictDecode(readFile(path))
    } catch (err) {
      // Undecodable current bytes refuse the write and stay untouched —
      // never a lossy rewrite source.
      return { ok: false, reason: "unreadable", message: `cannot read ${path} before replace: ${err instanceof Error ? err.message : String(err)}` }
    }
    // Content compare FIRST (a same-length rewrite or a restored mtime
    // defeats stat-only checks), then the stat identity.
    if (snapshot.raw !== null && currentRaw !== snapshot.raw) {
      return { ok: false, reason: "conflict", message: `${path} changed since the snapshot — refusing to overwrite newer contents; reload` }
    }
    if (snapshot.stat !== null && !identityMatches(identity, snapshot.stat)) {
      return { ok: false, reason: "conflict", message: `${path}'s identity changed since the snapshot — refusing; reload` }
    }
    // No-op detection: textual equality, else semantic equality — an
    // unchanged draft never touches the disk (spec: zero writes).
    if (currentRaw === plan.newText) return { ok: true, outcome: "no-op", bytes: 0 }
    const curParsed = parseForgeJsonc(currentRaw)
    const newParsed = parseForgeJsonc(plan.newText)
    if (curParsed.ok && newParsed.ok && deepEqual(curParsed.config, newParsed.config)) {
      return { ok: true, outcome: "no-op", bytes: 0 }
    }
  }
  if (parseForgeJsonc(plan.newText).ok === false) {
    return { ok: false, reason: "unparseable", message: "the planned document does not parse — refusing to write" }
  }
  let refusal: { reason: CommitErrReason; message: string } | null = null
  try {
    if (deps.writeFile !== undefined) {
      // INJECTED ATOMIC PROTOCOL — same shape as the real fs: writeFile is
      // a TEMP WRITER ONLY (it is never handed the destination), rename is
      // the required exclusive publisher, and the freshness/absence
      // re-check runs between the temp write and the publish. A bare
      // destination-write surface is deliberately NOT accepted: a partial
      // write there corrupts the recipe. With writeFile but no rename the
      // commit fails closed.
      if (deps.rename === undefined) {
        return { ok: false, reason: "write-failed", message: "the injected fs provides writeFile without rename — no atomic publish surface; refusing (fail closed)" }
      }
      // CREATION capability check BEFORE ANY WRITE (zero-write fail
      // closed, not even the temp): creation publishes ONLY through the
      // exclusive seam — a rename publish could cover a competing
      // creation, so without `link` there is no safe publish.
      const publishLink = deps.link
      if (plan.kind === "create-file" && publishLink === undefined) {
        return { ok: false, reason: "write-failed", message: "creation on an injected fs requires an exclusive publish surface (link) — a rename publish could cover a competing creation; refusing before any write" }
      }
      const renamePublish = deps.rename
      const temp = `${path}.forge-tui-${process.pid}-${++tempCounter}.tmp`
      let tempOwned = false
      try {
        if (plan.kind === "create-file" && deps.mkdir !== undefined) {
          try {
            deps.mkdir(dirname(path))
          } catch {}
        }
        deps.writeFile(temp, plan.newText)
        tempOwned = true
        // Re-checks between the temp write and the publish (same protocol
        // as the real fs): a racing injected fs is a conflict, never a
        // cover. CREATION re-verifies absence a SECOND time immediately
        // before the publish is handed out — the rename seam is a black
        // box that could itself plant the destination, so exclusivity is
        // re-verified as late as possible and a lost race is reported by
        // the seam's EEXIST, never renamed over.
        if (deps.recheckOwnership !== undefined && deps.recheckOwnership() === false) {
          refusal = { reason: "ownership-lost", message: "ownership re-check failed after the temp write — the save was aborted before the publish" }
        } else {
          const stale = plan.kind === "create-file" ? verifyCreateAbsent(path, { stat }) : verifyFreshness(snapshot, path, { stat, readFile })
          if (stale !== null) {
            refusal = { reason: "conflict", message: stale }
          } else if (plan.kind === "create-file") {
            const finalStale = verifyCreateAbsent(path, { stat })
            refusal = finalStale !== null ? { reason: "conflict", message: finalStale } : exclusiveInjectedPublish({ link: publishLink, rename: renamePublish }, temp, path, plan.newText, readFile)
          } else {
            renamePublish(temp, path)
            // Verify the publish landed as planned.
            const landed = strictDecode(readFile(path))
            if (landed !== plan.newText) {
              refusal = { reason: "conflict", message: `${path} changed while the save was in flight — application refused; reload` }
            }
          }
        }
      } finally {
        if (tempOwned && deps.unlink !== undefined) {
          try {
            deps.unlink(temp)
          } catch {}
        }
      }
    } else {
      refusal = atomicRealWrite(path, snapshot, plan, { stat, readFile, recheckOwnership: deps.recheckOwnership })
    }
  } catch (err) {
    return { ok: false, reason: "write-failed", message: `write failed: ${err instanceof Error ? err.message : String(err)}` }
  }
  if (refusal !== null) return { ok: false, reason: refusal.reason, message: refusal.message }
  return { ok: true, outcome: "written", bytes: plan.newText.length }
}

// One freshness verification of the target against the snapshot bytes.
// Returns an error message, or null when the target still matches.
function verifyFreshness(
  snapshot: RecipeSnapshot,
  path: string,
  deps: { stat: (path: string) => FileIdentityInput | null; readFile: (path: string) => string },
): string | null {
  const st = normalizedStat(deps.stat(path))
  if (st === null) return `${path} no longer exists`
  if (snapshot.raw !== null) {
    let currentRaw: string
    try {
      currentRaw = strictDecode(deps.readFile(path))
    } catch (err) {
      return `cannot read ${path} before replace: ${err instanceof Error ? err.message : String(err)}`
    }
    if (currentRaw !== snapshot.raw) return `${path} changed since the snapshot — refusing to overwrite newer contents; reload`
  }
  if (snapshot.stat !== null && !identityMatches(st, snapshot.stat)) {
    return `${path}'s identity changed since the snapshot — refusing; reload`
  }
  return null
}

// Ancestor safety for CREATION: every EXISTING directory from the root
// down to the target's parent must be a real directory — a symlink or
// junction ancestor (including a dangling one) could carry the write
// outside the intended tree and refuses. Only plain ENOENT levels are
// acceptable (they are about to be created).
function assertRealDirAncestors(dir: string): void {
  let cur = resolve(dir)
  const chain: string[] = []
  while (true) {
    chain.unshift(cur)
    const parent = dirname(cur)
    if (parent === cur) break
    cur = parent
  }
  for (const dirPath of chain) {
    let st: import("node:fs").Stats
    try {
      st = lstatSync(dirPath)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue
      throw new Error(`unsafe creation root: cannot inspect ${dirPath}: ${err instanceof Error ? err.message : String(err)}`)
    }
    if (st.isSymbolicLink()) throw new Error(`unsafe creation root: ${dirPath} is a symlink/junction — the creation could land outside the intended tree`)
    if (!st.isDirectory()) throw new Error(`unsafe creation root: ${dirPath} is not a directory`)
  }
}

// The REAL atomic write (no injected write surface): exclusive-create
// same-directory temp written with mode 0600, freshness + ownership
// RE-CHECK between the temp write and the publish, then — for a REPLACE —
// rename; for a CREATION an exclusive hardlink publish that refuses
// EEXIST (a plain rename could silently cover a competing creation). If
// the filesystem cannot hardlink, creation FAILS CLOSED — there is no
// rename fallback, because even a re-verified absence leaves a race where
// the rename covers a competing creation. Our own temp is ALWAYS cleaned
// up in the finally (a failed publish leaves the destination untouched);
// a foreign temp file is never truncated or unlinked.
function atomicRealWrite(
  path: string,
  snapshot: RecipeSnapshot,
  plan: { kind: PlanKind; newText: string },
  deps: { stat: (path: string) => FileIdentityInput | null; readFile: (path: string) => string; recheckOwnership?: () => boolean },
): { reason: CommitErrReason; message: string } | null {
  const isCreate = plan.kind === "create-file"
  if (!isCreate) {
    const lst = lstatSync(path)
    if (lst.isSymbolicLink()) throw new Error(`unsafe target: ${path} is a symlink — replace the link target's real file instead`)
    if (lst.nlink > 1) throw new Error(`unsafe target: ${path} is hard-linked (${lst.nlink} names) — the write would leak across identities`)
    const real = realpathOf(path)
    if (real !== null && foldPath(real) !== foldPath(path)) throw new Error(`unsafe target: ${path} resolves to ${real}`)
  } else {
    // Parent-chain verification BEFORE any mkdir (mkdir recursive would
    // happily traverse a planted junction).
    assertRealDirAncestors(dirname(path))
    try {
      mkdirSync(dirname(path), { recursive: true })
    } catch {}
    const real = realpathOf(dirname(path))
    if (real !== null && foldPath(real) !== foldPath(resolve(dirname(path)))) {
      throw new Error(`unsafe creation root: ${dirname(path)} resolves to ${real} — refusing to create through a redirected parent`)
    }
  }
  // `ownedTemp` is set ONLY after wx succeeded — a candidate name that
  // came back EEXIST belongs to someone else and is never cleaned up.
  let ownedTemp = ""
  try {
    for (let attempt = 0; attempt < 5; attempt++) {
      const candidate = `${path}.forge-tui-${process.pid}-${++tempCounter}.tmp`
      try {
        writeFileSync(candidate, plan.newText, { flag: "wx", mode: 0o600 })
        ownedTemp = candidate
        break
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (code === "EEXIST") {
          if (attempt < 4) continue
          break // all candidate names occupied → dedicated refusal below
        }
        throw err
      }
    }
    if (ownedTemp === "") {
      // All five candidate names were occupied by foreign files: fail
      // closed without touching any of them.
      return { reason: "write-failed", message: `could not acquire an exclusive temp name next to ${path} (5 attempts, all occupied) — refusing rather than touching foreign files` }
    }
    const temp = ownedTemp
    // RE-VERIFY bytes/identity/ownership between the temp write and the
    // publish (a competing save may have landed in the gap). Creation
    // re-verifies the target is STILL ABSENT — verifyFreshness would
    // demand it exist and turn every first creation into a conflict.
    if (deps.recheckOwnership !== undefined && deps.recheckOwnership() === false) {
      return { reason: "ownership-lost", message: "ownership re-check failed after the temp write — the save was aborted before the publish" }
    }
    const stale = isCreate ? verifyCreateAbsent(path, deps) : verifyFreshness(snapshot, path, deps)
    if (stale !== null) return { reason: "conflict", message: stale }
    if (isCreate) {
      // Exclusive publish ONLY: the hardlink refuses a competing creation
      // (EEXIST). No rename fallback on hardlink-less filesystems — fail
      // closed instead (a rename could still cover a competing creation).
      try {
        linkSync(temp, path)
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EEXIST") {
          return { reason: "conflict", message: `${path} appeared while the save was in flight — creation refused (no-clobber); reload` }
        }
        throw new Error(`exclusive publish unavailable on this filesystem (${err instanceof Error ? err.message : String(err)}) — creation refused (fail closed)`)
      }
      return null
    }
    renameSync(temp, path)
    return null
  } finally {
    if (ownedTemp !== "") {
      try {
        unlinkSync(ownedTemp)
      } catch {}
    }
  }
}

// Creation freshness: the target must STILL be absent right before the
// exclusive publish (no-clobber).
function verifyCreateAbsent(
  path: string,
  deps: { stat: (path: string) => FileIdentityInput | null },
): string | null {
  if (normalizedStat(deps.stat(path)) !== null) return `${path} appeared since the snapshot — creation refused (no-clobber); reload`
  return null
}

// Creation publish on the injected surface: prefer an EXCLUSIVE seam
// (`link` — contract: throw EEXIST when the destination exists, never
// overwrite it); otherwise the rename seam, whose EEXIST is honored as a
// lost race (the competing bytes stay) while any other error fails the
// save. A successful publish is verified to have landed as planned.
function exclusiveInjectedPublish(
  deps: { link?: (from: string, to: string) => void; rename: (from: string, to: string) => void },
  temp: string,
  path: string,
  newText: string,
  readFile: (path: string) => string,
): { reason: CommitErrReason; message: string } | null {
  const publish = deps.link ?? deps.rename
  try {
    publish(temp, path)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      return { reason: "conflict", message: `${path} appeared while the save was in flight — creation refused (no-clobber); reload` }
    }
    throw err
  }
  const landed = strictDecode(readFile(path))
  if (landed !== newText) {
    return { reason: "conflict", message: `${path} changed while the save was in flight — application refused; reload` }
  }
  return null
}

function realpathOf(path: string): string | null {
  try {
    return realpathSync(path)
  } catch {
    return null
  }
}

function foldPath(p: string): string {
  return process.platform === "win32" ? p.replace(/\//g, "\\").toLowerCase() : p
}

// Cooperating-save serialization: commits for the same normalized path run
// one at a time within this process (the TUI is single-process; this guards
// overlapping async flows like a retry racing a pending save). The stored
// tail is a settled promise (never rejects, never leaks an unhandled
// rejection) and is removed once it is the latest tail.
const commitLocks = new Map<string, Promise<void>>()

export function withCommitLock<T>(path: string, fn: () => Promise<T> | T): Promise<T> {
  const key = foldPath(path)
  const prev = commitLocks.get(key) ?? Promise.resolve()
  const run = prev.then(fn, fn)
  const tail = run.then(
    () => undefined,
    () => undefined,
  )
  commitLocks.set(key, tail)
  void tail.then(() => {
    if (commitLocks.get(key) === tail) commitLocks.delete(key)
  })
  return run as Promise<T>
}
