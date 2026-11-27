// Entry views for the TUI list/detail editors (change
// forge-tui-subagent-config, revised contract; spec "Scope-aware recipe
// browsing" + "Recipe field editing").
//
// REVISED (server-RPC contract): the authoritative parse + validation are
// the SERVER's (editOpen snapshot). This module builds DISPLAY views from
// the server's editOpen payload — it never reads a recipe file locally and
// never re-resolves ownership. The shared validators run here ONLY to
// project the server-parsed document into per-entry display rows with the
// SAME fail-soft findings the resolver would load (same shared core, same
// input bytes → the list shows exactly what the server plans against).
// An unrecognized document payload yields a findings-only view and editing
// stays refused — fail-closed, never a locally invented roster.

import { BUILTIN_OVERRIDE_IDS, validateAgentSet, validateOverrideNode, type ForgeAgentDef, type ForgeConfigFinding } from "../forge-config.ts"
import type { EditOpenOk } from "../../rpc.ts"
import type { SelectOption } from "./contracts.ts"
import { matchesQuery } from "./catalog.ts"

// The recipe-file view for one scope layer (display projection of the
// server snapshot).
export type RecipeFileView = {
  path: string
  existed: boolean
  readable: boolean
  parseOk: boolean
  parseError: string | null
  workers: EntryView[]
  overrides: EntryView[]
  overridesLegal: boolean // false on a workspace file (override node is global-only)
  findings: ForgeConfigFinding[]
}

export type EntryView = {
  id: string // normalized id (forge- prefix stripped, mirrors the resolver)
  kind: "worker" | "override"
  // auto | pinned | half-configured (invalid pair) | invalid
  mode: "auto" | "pinned" | "half-configured" | "invalid"
  def: ForgeAgentDef | null // null for invalid entries
  // Exactly as written in the file (unknown values preserved verbatim).
  rawModel: string | undefined
  rawLevel: string | undefined
  findings: ForgeConfigFinding[]
  promptPresent: boolean
  shape: "readonly" | "write" | undefined
  permissionKeys: string[]
  // UX round (design D10 point 3): presentation-only draft-overlay marker —
  // how this row relates to the pending drafts. Undefined = a plain base
  // row as saved. The marker NEVER changes the row's option value
  // (`kind:id`) and NEVER touches the held server snapshot or the base
  // file; the draft's own validation is disclosed separately in the entry
  // menu, never silently substituted for these base findings. The two
  // conflict kinds cover the post-rebase edges: an update draft whose
  // entry VANISHED from the fresh document (kept for re-editing — saving
  // it will be refused until the entry exists again) and a create draft
  // whose id ALREADY exists in the fresh document (saving would be
  // refused as a duplicate; base findings stay visible).
  pending?: "create" | "create-conflict" | "update" | "update-missing" | "delete"
}

// Findings name entries as `<labelPrefix>.<id>` (validateAgentSet labels) —
// attribute them per entry for the detail disclosure.
function findingsFor(findings: ForgeConfigFinding[], labelPrefix: string, id: string): ForgeConfigFinding[] {
  const needle = `${labelPrefix}.${id}`
  return findings.filter((f) => f.message.includes(needle))
}

function entryViewsOf(validated: Record<string, ForgeAgentDef>, rawEntries: Record<string, unknown>, kind: "worker" | "override", labelPrefix: string, findings: ForgeConfigFinding[]): EntryView[] {
  const views: EntryView[] = []
  for (const [id, def] of Object.entries(validated)) {
    const raw = rawEntries[id]
    const rawModel = raw !== null && typeof raw === "object" && !Array.isArray(raw) && typeof (raw as Record<string, unknown>).model === "string" ? ((raw as Record<string, unknown>).model as string) : undefined
    const rawLevel = raw !== null && typeof raw === "object" && !Array.isArray(raw) && typeof (raw as Record<string, unknown>).thoughtLevel === "string" ? ((raw as Record<string, unknown>).thoughtLevel as string) : undefined
    const own = findingsFor(findings, labelPrefix, id)
    const halfConfigured = own.some((f) => f.code === "agent-half-configured")
    const mode: EntryView["mode"] = halfConfigured ? "half-configured" : def.model !== undefined ? "pinned" : "auto"
    views.push({
      id,
      kind,
      mode,
      def,
      rawModel,
      rawLevel,
      findings: own,
      promptPresent: def.prompt !== undefined,
      shape: def.shape,
      permissionKeys: def.permission ? Object.keys(def.permission) : [],
    })
  }
  return views
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v)
}

// Build the display view from the SERVER's editOpen payload (the
// edit-start snapshot). Unreadable/unparseable files yield a view with the
// problem disclosed and NO entries (the flow blocks edits; it never
// pretends an empty file). An unrecognized `document` payload (not the
// JSON value the contract promises) yields a findings-only view — the
// editor refuses edits against it rather than inventing a roster.
export function documentViewOf(doc: EditOpenOk): RecipeFileView {
  const base: RecipeFileView = {
    path: doc.path,
    existed: doc.exists,
    readable: doc.readable,
    parseOk: false,
    parseError: null,
    workers: [],
    overrides: [],
    overridesLegal: doc.scope === "global",
    findings: [...doc.findings],
  }
  if (!doc.exists) return base
  if (!doc.readable) {
    return { ...base, parseError: "the file exists but cannot be read — its content is unknown" }
  }
  if (doc.parseError !== null) {
    const e = doc.parseError
    return { ...base, parseError: `${e.message}${e.line !== undefined ? ` (line ${e.line}, column ${e.column})` : ""}` }
  }
  const document = doc.document
  if (!isObject(document)) {
    return {
      ...base,
      parseError: "the server snapshot carried no recognizable document — editing is refused for this target (fail-closed; browse only)",
      findings: [...base.findings, { level: "error", code: "document-payload-unrecognized", message: `${doc.path}: the server document payload was not a recognizable recipe object — no entries are shown and edits are refused` }],
    }
  }
  const isGlobal = doc.scope === "global"
  const agents = validateAgentSet(document.agents)
  const agentViews = entryViewsOf(agents.agents, isObject(document.agents) ? document.agents : {}, "worker", "agents", agents.findings)
  let overrideViews: EntryView[] = []
  const overrideFindings: ForgeConfigFinding[] = []
  if (isGlobal) {
    const overrides = validateOverrideNode(document.override, doc.path)
    overrideViews = entryViewsOf(overrides.overrides, isObject(document.override) ? document.override : {}, "override", "override", overrides.findings)
    overrideFindings.push(...overrides.findings)
  } else if (document.override !== undefined) {
    overrideFindings.push({ level: "warn", code: "override-node-ignored-workspace", message: `${doc.path}: the top-level "override" field is GLOBAL-layer-only — field ignored` })
  }
  return {
    ...base,
    parseOk: true,
    workers: agentViews,
    overrides: overrideViews,
    findings: [...base.findings, ...agents.findings, ...overrideFindings],
  }
}

// List rows: one line per entry with mode/identity summary. Option values
// are `<kind>:<id>` — workers and overrides can share an id word
// (agents.general vs override.general), so the value must be unique across
// BOTH containers end to end. Search narrows by id/model/prompt — never
// hides that entries exist (a filtered list shows its total count in the
// title, rendered by the flow). The full identity lives in the option's
// official `footer` string (2.4.2 DialogSelectOption.footer — a plain
// string, never JSX; real rendering is unverified while CUA input is
// refused, so no visual claim is made) — the description stays a short
// state word and never has to carry or truncate a long identity.
export function entryListOptions(entries: EntryView[], query: string, extraOptions?: SelectOption[]): SelectOption[] {
  const filtered = entries.filter((e) => matchesQuery(query, [e.id, e.rawModel, e.def?.prompt]))
  const rows: SelectOption[] = filtered.map((e) => ({
    title: entryTitle(e),
    value: `${e.kind}:${e.id}`,
    description: entryDescription(e),
    footer: entryFooter(e),
    category: e.kind === "override" ? "Global built-in overrides" : undefined,
  }))
  return rows.concat(extraOptions ?? [])
}

// Parse a list-row value back into its container + id.
export function parseEntryValue(value: string): { kind: "worker" | "override"; id: string } | null {
  const i = value.indexOf(":")
  if (i === -1) return null
  const kind = value.slice(0, i)
  const id = value.slice(i + 1)
  return kind === "worker" || kind === "override" ? { kind, id } : null
}

// Row marker wording for draft-overlaid rows (design D10 point 3): SHORT
// markers only — the title line never grows into the full reason (the
// complete cause and consequence live in entryFooter). The marker is
// presentational; the hard contract is the pending VALUE visibility next
// to it and the option value staying `kind:id`.
const TITLE_MARKER: Record<NonNullable<EntryView["pending"]>, string> = {
  create: "unsaved",
  "create-conflict": "create conflict",
  update: "unsaved",
  "update-missing": "update missing",
  delete: "delete",
}

export function entryTitle(e: EntryView): string {
  // UX round (design D10 point 2, short titles): the title line is
  // id + mode word + SHORT marker — the full model identity and the full
  // conflict reasons NEVER sit here (footer / description carry them).
  const mode = e.mode === "pinned" ? "Pinned" : e.mode === "auto" ? "Auto" : e.mode === "half-configured" ? "INVALID" : "INVALID"
  const pending = e.pending !== undefined ? ` [${TITLE_MARKER[e.pending]}]` : ""
  return `${e.id} — ${mode}${pending}`
}

// SHORT description (UX round point 2, accessibility split): a one-phrase
// state line. The FULL per-row facts — complete model/level, shape, prompt,
// permissions, overlay semantics and risk findings — live in entryFooter
// (the official footer position), so neither the title nor this single
// description line ever has to carry or truncate a long identity.
function entryDescription(e: EntryView): string {
  if (e.pending === "delete") return "pending deletion"
  if (e.pending === "update") return "pending update"
  if (e.pending === "update-missing") return "pending update (entry gone)"
  if (e.pending === "create-conflict") return "pending create (id conflict)"
  if (e.pending === "create") return "pending create"
  return e.mode === "pinned" ? "pinned" : e.mode === "auto" ? "auto" : "invalid"
}

// The FULL per-row facts, in the official footer position (plain string).
// Overlay semantics and risk findings stay visible here — brevity in the
// title/description never hides risk (UX round point 5).
function entryFooter(e: EntryView): string {
  const parts: string[] = []
  // Full identity lives HERE, never in the title or short description.
  if (e.mode === "pinned") parts.push(`${e.rawModel ?? e.def?.model ?? "?"} @ ${e.rawLevel ?? e.def?.thoughtLevel ?? "?"}`)
  else if (e.mode === "auto") parts.push("auto — inherits the parent session's model")
  else if (e.mode === "half-configured") parts.push("INVALID — half-configured pair, skipped by the resolver")
  else parts.push("INVALID — skipped by the resolver")
  if (e.mode === "pinned" && e.def?.model !== undefined && e.rawModel !== undefined && e.rawModel !== e.def.model) parts.push(`raw "${e.rawModel}" (trimmed: "${e.def.model}")`)
  if (e.shape !== undefined) parts.push(`shape: ${e.shape}`)
  parts.push(e.promptPresent ? `custom prompt${e.def?.prompt !== undefined ? ` (${e.def.prompt.length} chars)` : ""}` : "no prompt")
  if (e.permissionKeys.length > 0) parts.push(`permissions: ${e.permissionKeys.join(", ")}`)
  // Pending overlay semantics (D10 point 3): the displayed values are the
  // pending draft's; the saved recipe is untouched until Save & Sync. The
  // two conflict kinds name the refusal the save will hit (never a silent
  // promise of success).
  if (e.pending === "update") parts.push("values shown are the PENDING draft — saved recipe unchanged until Save & Sync")
  if (e.pending === "update-missing") parts.push("the entry is GONE from the fresh saved recipe — keeping the draft re-edits it, but SAVING will be REFUSED until the entry exists again")
  if (e.pending === "delete") parts.push("pending deletion — saved recipe unchanged until Save & Sync")
  if (e.pending === "create") parts.push("pending creation — not yet in the saved recipe")
  if (e.pending === "create-conflict") parts.push("this id ALREADY exists in the saved recipe — the save will REFUSE this draft as a duplicate (siblings still apply)")
  // Base findings stay visible and attributed to the SAVED recipe — an
  // overlay never silently clears them. The DRAFT's own validation is a
  // separate disclosure in the entry menu, never merged into this line.
  if (e.findings.length > 0) parts.push(`findings from the saved recipe: ${e.findings.filter((f) => f.level === "error").length} error(s), ${e.findings.filter((f) => f.level !== "error").length} warn(s)`)
  return parts.join(" · ")
}

export const OVERRIDE_IDS: readonly string[] = BUILTIN_OVERRIDE_IDS
