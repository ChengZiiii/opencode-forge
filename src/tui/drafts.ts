// Draft state for the TUI editor (design D3/D4 — draft isolation,
// Auto/Pinned atomicity, model-change level revalidation).
//
// A draft is one entry's pending change (create/update/delete). Drafts
// stay in memory until the user explicitly confirms Save & Sync; nothing
// here writes. Pure functions over a plain state object.

import { levelSupportFor } from "../model-catalog.ts"
import type { CatalogView } from "./catalog.ts"
import { validateOverrideDraft, validateWorkerDraft, type DraftValidation, type EntryDraft } from "../forge-config-edit.ts"
import type { ForgeConfigFinding } from "../forge-config.ts"

export type DraftOp = "create" | "update" | "delete"

export type PendingDraft = {
  kind: "worker" | "override"
  op: DraftOp
  id: string // raw id at creation; immutable for updates
  draft: EntryDraft
  // The entry's state as loaded (for diff display + no-op detection).
  original: EntryDraft | null
  // The user's touched rebase groups (see RebaseGroup) — accumulated at
  // EDIT time against the then-current base and carried across rebases,
  // so an adopted external value is NEVER misread as a user edit. The
  // Auto/Pinned trio accumulates as the single "pin" group.
  touchedGroups?: RebaseGroup[]
}

// Copy a loaded entry into draft shape (mode derives from the atomic pair).
export function draftOfLoaded(def: { model?: string; thoughtLevel?: string; prompt?: string; shape?: "readonly" | "write"; permission?: Record<string, string> } | null): EntryDraft {
  if (def === null) return { mode: "auto" }
  if (def.model !== undefined && def.thoughtLevel !== undefined) {
    return { mode: "pinned", model: def.model, thoughtLevel: def.thoughtLevel, prompt: def.prompt, shape: def.shape, permission: def.permission ? { ...def.permission } : undefined }
  }
  return { mode: "auto", prompt: def.prompt, shape: def.shape, permission: def.permission ? { ...def.permission } : undefined }
}

// The ONE permission normalization both equality and rebase diffs share:
// an empty permission object IS the absent member (write defaults apply).
function normalizedPermission(d: EntryDraft): Record<string, string> | undefined {
  return d.permission !== undefined && Object.keys(d.permission).length > 0 ? d.permission : undefined
}

export function draftsEqual(a: EntryDraft, b: EntryDraft): boolean {
  const norm = (d: EntryDraft) => ({
    mode: d.mode,
    model: d.mode === "pinned" ? d.model : undefined,
    thoughtLevel: d.mode === "pinned" ? d.thoughtLevel : undefined,
    prompt: d.prompt,
    shape: d.shape,
    permission: normalizedPermission(d),
  })
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b))
}

// Field names whose normalized value differs between the two drafts (the
// same normalization draftsEqual uses — pinned-only model/level).
export function changedFieldNames(a: EntryDraft, b: EntryDraft): string[] {
  const normModel = (d: EntryDraft) => (d.mode === "pinned" ? d.model : undefined)
  const normLevel = (d: EntryDraft) => (d.mode === "pinned" ? d.thoughtLevel : undefined)
  const names: string[] = []
  if (a.mode !== b.mode) names.push("mode")
  if (normModel(a) !== normModel(b)) names.push("model")
  if (normLevel(a) !== normLevel(b)) names.push("thoughtLevel")
  if (a.prompt !== b.prompt) names.push("prompt")
  if (a.shape !== b.shape) names.push("shape")
  if (JSON.stringify(normalizedPermission(a)) !== JSON.stringify(normalizedPermission(b))) names.push("permission")
  return names
}

// The Auto/Pinned trio (mode/model/thoughtLevel) is ONE rebase atom — the
// D3/D4 contract never mixes halves across sources (a field-wise merge
// could otherwise produce "my model + their level" without the user ever
// choosing that combination). Every other field is its own group.
export type RebaseGroup = "pin" | "prompt" | "shape" | "permission"

const GROUP_FIELDS: Record<RebaseGroup, readonly string[]> = {
  pin: ["mode", "model", "thoughtLevel"],
  prompt: ["prompt"],
  shape: ["shape"],
  permission: ["permission"],
}

const ALL_GROUPS = Object.keys(GROUP_FIELDS) as RebaseGroup[]

// Collapse raw changed-field names into rebase groups.
export function rebaseGroupsOf(names: string[]): RebaseGroup[] {
  const s = new Set(names)
  return ALL_GROUPS.filter((g) => GROUP_FIELDS[g].some((f) => s.has(f)))
}

// Canonical value of one group under the draftsEqual normalization — the
// same-value exemption compares THESE (an external change that lands on
// the exact value the user already chose has fulfilled the user's intent;
// it is never a conflict ask). Positional JSON, never string concatenation:
// a `@`-joined render would collide distinct pins ("prov/m@rev"+"high" vs
// "prov/m"+"rev@high").
function groupValue(d: EntryDraft, g: RebaseGroup): string {
  switch (g) {
    case "pin":
      return JSON.stringify([d.mode, d.mode === "pinned" ? d.model : undefined, d.mode === "pinned" ? d.thoughtLevel : undefined])
    case "prompt":
      return JSON.stringify(d.prompt ?? null)
    case "shape":
      return JSON.stringify(d.shape ?? null)
    case "permission":
      return JSON.stringify(normalizedPermission(d) ?? null)
  }
}

export type RebaseResult = {
  // The draft with every USER-UNTOUCHED GROUP adopted whole from the fresh
  // definition (an external change is never overwritten by a stale loaded
  // value; the Auto/Pinned trio adopts as ONE unit) and every user-touched
  // group kept verbatim.
  rebased: EntryDraft
  // User-touched groups that ALSO changed externally AND genuinely diverge
  // (fresh's group value differs from the draft's) — the explicit
  // keep-mine/drop decision belongs to the human, never a default. A
  // concurrent external edit landing on the user's own value is intent
  // fulfilled, not a conflict.
  conflicts: RebaseGroup[]
  // The user's touched groups (stored accumulation ∪ current diff) — the
  // caller keeps these on the pending so the NEXT rebase starts from the
  // advanced base without losing user intent.
  touched: RebaseGroup[]
}

// Rebase an update draft onto a FRESH entry definition. The base is the
// draft's `original` (as of the last completed rebase / editor open):
// touched = stored groups ∪ diff(draft, base); external =
// diff(fresh, base); untouched groups adopt fresh whole; touched groups
// that also changed externally AND diverge in value are conflicts. The
// caller advances `original` to the fresh state after the rebase resolves,
// which is what keeps consecutive rebases idempotent (an adopted external
// value can never re-enter the touched set as a user edit).
export function rebaseUpdateDraft(
  pending: PendingDraft,
  freshDef: { model?: string; thoughtLevel?: string; prompt?: string; shape?: "readonly" | "write"; permission?: Record<string, string> } | null,
): RebaseResult {
  const base = pending.original
  if (base === null) return { rebased: pending.draft, conflicts: [], touched: [] } // create — nothing to rebase
  const fresh = draftOfLoaded(freshDef)
  const touched = [...new Set([...(pending.touchedGroups ?? []), ...rebaseGroupsOf(changedFieldNames(pending.draft, base))])]
  const external = rebaseGroupsOf(changedFieldNames(fresh, base))
  const conflicts = external.filter((g) => touched.includes(g) && groupValue(fresh, g) !== groupValue(pending.draft, g))
  const rebased: EntryDraft = { ...pending.draft }
  for (const g of ALL_GROUPS) {
    if (touched.includes(g)) continue // the user's value wins verbatim
    for (const f of GROUP_FIELDS[g]) {
      const value = (fresh as Record<string, unknown>)[f]
      if (value === undefined) delete (rebased as Record<string, unknown>)[f]
      else (rebased as Record<string, unknown>)[f] = value
    }
  }
  // Atomic-pair consistency (unchanged contract): an adopted auto mode
  // strips the pins; a pinned mode missing one half cannot arise from
  // whole-group adoption — surface it as a pin conflict rather than
  // inventing a half.
  if (rebased.mode === "auto") {
    delete rebased.model
    delete rebased.thoughtLevel
  }
  if (rebased.mode === "pinned" && (rebased.model === undefined || rebased.thoughtLevel === undefined) && !conflicts.includes("pin")) {
    conflicts.push("pin")
  }
  return { rebased, conflicts, touched }
}

// Design D3: changing the model invalidates an unsupported level selection
// until reconfirmed. Returns the OLD level's verdict on the NEW model.
export function levelVerdictAfterModelChange(draft: EntryDraft, catalog: CatalogView): { needsReconfirmation: boolean; note: string } | null {
  if (draft.mode !== "pinned" || !draft.model || !draft.thoughtLevel || !draft.model.includes("/")) return null
  const [providerID, modelID] = splitModelId(draft.model)
  const verdict = levelSupportFor(catalog.lookup(providerID, modelID), draft.thoughtLevel)
  return verdict.supported ? { needsReconfirmation: false, note: `"${draft.thoughtLevel}" is an observed variant of ${draft.model}` } : { needsReconfirmation: true, note: verdict.note }
}

export function splitModelId(model: string): [providerID: string, modelID: string] {
  const i = model.indexOf("/")
  return i === -1 ? [model, ""] : [model.slice(0, i), model.slice(i + 1)]
}

// Validate a pending draft against the live contract (shared core). The
// existing-ids collision check applies to creations only.
export function validateDraft(pending: PendingDraft, existingIds: string[]): DraftValidation {
  if (pending.op === "delete") return { ok: true, findings: [], normalizedId: pending.id }
  if (pending.kind === "override") return validateOverrideDraft(pending.id, pending.draft)
  const ids = pending.op === "create" ? existingIds : []
  return validateWorkerDraft(pending.id, pending.draft, ids)
}

// True when the pending draft would change nothing (spec: no-op saves
// make zero writes — the flow skips planning such drafts entirely).
export function isNoOp(pending: PendingDraft): boolean {
  if (pending.op === "delete") return false // a delete of an absent entry is refused by the plan, not a no-op
  if (pending.original === null) return false
  return draftsEqual(pending.draft, pending.original)
}

export function findingsOf(v: DraftValidation): ForgeConfigFinding[] {
  return v.findings
}
