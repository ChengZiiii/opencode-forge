// Forge subagent configuration editor — dialog flow core (change
// forge-tui-subagent-config, REVISED server-RPC contract; tasks 6.6/3.2/3.3).
//
// REVISED ARCHITECTURE (2026-11-27 revision, applied): the TUI owns drafts,
// forms, dialogs and explicit confirmation ONLY. Every authoritative
// question is answered by the server plugin over the official Plugin RPC:
// the document (editOpen snapshot, read exactly once at editor open), the
// canonical patch + preview (prepare), the single-use commit (commit), the
// same-epoch receipt lookup (receipt) and the family sync (sync). This
// module NEVER reads or writes a recipe path as a local file, never
// resolves ownership itself, and never replays a saved patch.
//
// Client-instance protocol discipline (design D7):
//   - the edit-start snapshot handle comes from editOpen and every prepare
//     references it — an external edit between open and Save is refused
//     server-side (conflict-reload) and offered a reload, never swallowed;
//   - before a commit the flow re-echoes and compares epoch/generation with
//     the token binding; any mismatch drops the token and requires a fresh
//     editor session (fresh prepare + fresh human confirmation);
//   - a lost commit response is resolved by the same-epoch receipt lookup;
//     found:false is UNKNOWN — drafts are kept, the token is dropped, and
//     the next Save re-prepares against current content. Bytes are never
//     used to adjudicate an old commit and commits are never replayed;
//   - a failed sync after a successful save offers an independent retry
//     that re-reads the CURRENT recipe server-side (never the old patch)
//     and is explicitly re-confirmed by the human.
//
// Fail-soft/fail-closed discipline: a refused draft never blocks its
// siblings (the server lists rejected entries; they stay pending here);
// an unresolvable scope, an unprovable transport or a server refusal
// refuses save+sync and keeps drafts; cancelled dialogs never mutate state.

import { randomUUID } from "node:crypto"
import {
  normalizeWorkerId,
  validateOverrideDraft,
  validateWorkerDraft,
  type DraftValidation,
  type EntryDraft,
} from "../forge-config-edit.ts"
import { validatePoolField } from "../forge-config.ts"
import { MUTATING_TOOLS, PRIMARY_ONLY_WORKER_TOOLS } from "../dispatch-tiers.ts"
import type { CatalogView } from "./catalog.ts"
import { catalogFromRows, catalogUnknown, levelOptions, modelOptions, providerOptions } from "./catalog.ts"
import { documentViewOf, entryListOptions, entryTitle, parseEntryValue, type EntryView, type RecipeFileView } from "./entries.ts"
import { changedFieldNames, draftOfLoaded, isNoOp, levelVerdictAfterModelChange, rebaseGroupsOf, rebaseUpdateDraft, splitModelId, type PendingDraft, type RebaseGroup } from "./drafts.ts"
import { anchorableStartupScope, echoVerdictOf, enablementOf, safeErrorText as errorText } from "./guard.ts"
import type { ForgeConfigRpcTransport, HostClient, HostData, HostUi, Scope, SelectOption, SessionScope } from "./contracts.ts"
import type { CommitEntryOutcome, CommitReceipt, EditOpenOk, Finding, Op, PreviewRejected, SyncApplyOk, SyncOutput } from "../../rpc.ts"

export type EditorDeps = {
  ui: HostUi
  client: HostClient
  data: HostData
  // The typed RPC transport (built in tui.ts from the SHARED definition).
  // The wiring refuses to construct the editor without one — an absent
  // transport means zero reads, zero writes, zero syncs.
  rpc: ForgeConfigRpcTransport
  // Re-readable authoritative scope (router sessionID → client.session.get
  // record). Re-read at every decisive step; the CURRENT sessionID is
  // restated to prepare/commit/sync and the SERVER adjudicates it against
  // the token/snapshot binding (a session→home migration or any change
  // refuses — the server cannot observe the router, so the client restates).
  sessionScope: () => Promise<SessionScope>
  // The BOUND startup scope (runEditor: readSessionScope → refused unless a
  // directory anchor exists → transport built AT that anchor). The editor's
  // whole RPC transport is fixed to this location; every currentSession()
  // re-read must equal it strictly (kind+sessionID+anchor — home null is
  // not interchangeable with an absent one) or the invocation voids.
  initialScope: SessionScope
  pluginId?: string
  // Injectable time seams for the bounded registry readiness (tests inject
  // a fake clock/sleep — zero real waiting); the wiring provides real
  // defaults.
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  // Cancellable deadline-timer seam for the readiness window: fire the
  // callback ONCE after ms; the returned cancel is idempotent (post-fire or
  // post-cancel calls are no-ops, and a cancelled timer never fires). Tests
  // inject a manual-fire or never-firing schedule beside the fake clock;
  // the wiring's real default is a plain setTimeout.
  schedule?: (ms: number, callback: () => void) => () => void
}

type DocState = {
  snapshotId: string
  path: string
  // Server-issued target identity of the resolved binding — disclosed in
  // every preview and receipt (remote-disclosure requirement).
  targetIdentity: string
  scope: Scope
  sessionID: string | null
  observedLocation: string | null
  anchor: string | null
  epoch: string
  generation: number
  expiresAt: number
  exists: boolean
  readable: boolean
  creatable: boolean
  identityLabel: string
  view: RecipeFileView
}

type PreparedToken = {
  token: string
  expiresAt: number
  epoch: string
  generation: number
  preview: {
    path: string
    targetIdentity: string
    scope: Scope
    sessionID: string | null
    oldText: string | null
    newText: string
    createFile: boolean
    entries: { opId: string; id: string; kind: string; action: string; summary: string[] }[]
    rejected: PreviewRejected[]
  }
}

type EditorState = {
  sessionID: string | null
  anchorHint: string | null
  view: Scope
  doc: DocState | null
  // Whether a workspace pool exists (learned from the workspace editOpen) —
  // lets the global view be labelled fallback-only for this session.
  workspaceHasPool: boolean
  pending: PendingDraft[]
  pendingPool: string | null
  catalog: CatalogView
  lastSaveFailed: boolean
  // Review P2(4): the saved-receipt sync state is SEPARATE from the drafts
  // — a pending/delete draft lifecycle must never hide (or fake) the retry
  // entry for a receipt whose sync has not completed.
  pendingSyncOutstanding: boolean
  // The last WRITTEN receipt (save succeeded) — enables the independent
  // sync retry even when the sync slot was absent/failed.
  savedReceipt: CommitReceipt | null
  // The last receipt of ANY outcome — its per-entry outcomes stay browsable
  // from the list (review P2(5): the summary toast is never the only
  // detail surface for a large receipt).
  lastReceipt: CommitReceipt | null
  // The LAST sync result of ANY outcome — full detail lines, never a blind
  // slice (UX round point 5; coordinator ruling: the receipt's embedded
  // sync report can be null, and the follow-up sync legs' complete outcome
  // must stay traceable on demand — failures/unconfirmed never vanish into
  // a short toast).
  lastSyncResult: { title: string; ok: boolean; lines: string[] } | null
  // The LAST prepare-level save outcome OR rebase outcome — full detail
  // lines viewable on demand, the same discipline as lastSyncResult
  // (reviewer P2: the no-op/rebase toast is never the only place its
  // summary/refusals/findings/drops live).
  lastSaveDetail: { title: string; lines: string[] } | null
  // Search query + current selection of the list view (UX round point 4):
  // preserved across save/refresh within the same scope, CLEARED on a scope
  // switch (spec ruling: never carried into the other scope). Single values
  // — deliberately no per-scope cache map.
  listQuery: string
  listCurrent: string | null
  token: PreparedToken | null
}

const SEARCH_OPTION_VALUE = "__search__"
const NEW_WORKER_VALUE = "__new-worker__"
const NEW_OVERRIDE_VALUE = "__new-override__"
const CREATE_POOL_VALUE = "__create-pool__"
const SAVE_VALUE = "__save__"
const DISCARD_VALUE = "__discard__"
const SWITCH_VALUE = "__switch__"
const RELOAD_VALUE = "__reload__"
const RETRY_SYNC_VALUE = "__retry-sync__"
const RECEIPT_DETAIL_VALUE = "__receipt-detail__"
const SYNC_DETAIL_VALUE = "__sync-detail__"
const SOURCE_DETAIL_VALUE = "__source-detail__"
const SAVE_DETAIL_VALUE = "__save-detail__"
const DELETE_OPTION_VALUE = "__delete-entry__"
const PREVIEW_NEXT_VALUE = "__preview-next__"
const PREVIEW_PREV_VALUE = "__preview-prev__"
const PREVIEW_CONFIRM_VALUE = "__preview-confirm__"
const PREVIEW_CANCEL_VALUE = "__preview-cancel__"
const CUSTOM_LEVEL_VALUE = "__custom-level__"
const MANUAL_MODEL_VALUE = "__manual-model__"

// Permission keys the compiler lets through; the forced-deny set is NOT
// offered (never lift mandatory worker restrictions — spec).
const PERMISSION_KEY_CHOICES = ["shell", "execute", "question", "grep", "glob", ...MUTATING_TOOLS] as const
const PERMISSION_EFFECTS = ["allow", "ask", "deny"] as const

function forcedDenyKeys(): string[] {
  return ["task", "subagent", ...PRIMARY_ONLY_WORKER_TOOLS]
}

export function createForgeConfigEditor(deps: EditorDeps): { open(): Promise<void> } {
  const state: EditorState = {
    sessionID: null,
    anchorHint: null,
    view: "workspace",
    doc: null,
    workspaceHasPool: false,
    pending: [],
    pendingPool: null,
    catalog: catalogUnknown,
    lastSaveFailed: false,
    pendingSyncOutstanding: false,
    savedReceipt: null,
    lastReceipt: null,
    lastSyncResult: null,
    lastSaveDetail: null,
    listQuery: "",
    listCurrent: null,
    token: null,
  }
  const ui = deps.ui
  const rpc = deps.rpc
  // Review P1(1): the editor connection revision — incremented
  // SYNCHRONOUSLY on every server.connected event. prepare captures it;
  // post-confirm commit/apply verify it unchanged. A changed revision
  // voids the held preview AND the sync token — the recovery is always a
  // fresh open/prepare/confirm, never "keep the old token".
  let connectionRevision = 0

  // ------------------------------------------------------------------
  // Small helpers
  // ------------------------------------------------------------------

  const inform = (message: string, variant: "success" | "warning" | "error" | "info" = "info", title = "Forge: Configure subagents") => {
    try {
      ui.toast({ title, message, variant, duration: 6000 })
    } catch {
      /* toast is best-effort disclosure */
    }
  }

  function findingsLines(view: RecipeFileView): string[] {
    const lines: string[] = []
    if (view.parseError !== null) lines.push(`UNPARSEABLE/UNREADABLE — ${view.parseError}`)
    for (const f of view.findings) lines.push(`${f.level}: ${f.message}`)
    return lines
  }

  function catalogFindingLines(): string[] {
    return state.catalog.findings.slice(0, 4).map((f) => `catalog: ${f}`)
  }

  // Fresh authoritative scope read (contracts SessionScope). kind unknown
  // or a null session binding refuses — never a guessed directory.
  async function currentSession(): Promise<SessionScope> {
    try {
      return await deps.sessionScope()
    } catch (err) {
      return { sessionID: null, anchor: null, kind: "unknown", reason: `session scope read failed: ${errorText(err)}` }
    }
  }

  // The scope re-verification before every decisive step (prepare, commit,
  // sync pre-check AND apply, editOpen — see the guard inside
  // openDocument): the CURRENT scope must equal the BOUND startup scope
  // EXACTLY. Strict kind+sessionID+anchor triple — the sessionID-only
  // check of earlier revisions let a homeA→homeB migration through (both
  // carry a null sessionID) and would have committed/synced against the
  // old binding. The saved receipt is never re-bound: a refusal keeps the
  // retry armed against the ORIGINAL receipt's target.
  async function reverifySession(): Promise<{ ok: true } | { ok: false; message: string }> {
    const sc = await currentSession()
    if (sc.kind === "unknown") {
      return { ok: false, message: `the authoritative session scope is unavailable (${sc.reason ?? "unknown kind"}) — refusing against a possibly-stale scope` }
    }
    const S0 = deps.initialScope
    if (!anchorableStartupScope(S0)) {
      return { ok: false, message: "the bound startup scope is missing or invalid (wiring defect) — refusing against a possibly-stale scope" }
    }
    const same = sc.kind === S0.kind && sc.sessionID === S0.sessionID && sc.anchor === S0.anchor
    if (!same) {
      return { ok: false, message: `the scope changed since the editor opened (bound ${S0.kind}/${S0.sessionID ?? "home"} @ ${S0.anchor ?? "no anchor"} → now ${sc.kind}/${sc.sessionID ?? "home"} @ ${sc.anchor ?? "no anchor"}) — reopen /forge-config to re-resolve the scope (the saved receipt is never re-bound)` }
    }
    return { ok: true }
  }

  // ------------------------------------------------------------------
  // Server document (editOpen — the edit-start snapshot handle, F1)
  // ------------------------------------------------------------------

  function docLabel(doc: DocState): string {
    const created = doc.exists ? "" : doc.creatable ? " (absent — explicit creation required)" : " (absent — the server did not resolve a creation target)"
    return `${doc.path}${created}`
  }

  // The LAST open-failure line (verbatim cause). Set on every openDocument
  // failure — including the QUIET mode used by the post-save refresh, where
  // the caller (receiptFlow) folds the cause into its ONE verdict toast
  // instead of stacking a second one (reviewer P2: 底层+外层双 toast).
  let lastOpenFailureLine: string | null = null

  async function openDocument(scope: Scope, opts?: { quietFailure?: boolean }): Promise<boolean> {
    // Unified scope gate covering EVERY entry into editOpen — the initial
    // open, Reload-from-server, and every reconnect fresh-open: the
    // CURRENT scope must still equal the bound startup scope BEFORE any
    // editOpen is issued (zero reads on a changed scope; the old binding
    // is never re-pointed).
    const fail = (line: string): void => {
      lastOpenFailureLine = line
      if (opts?.quietFailure !== true) inform(line, "error")
    }
    const bound = await reverifySession()
    if (!bound.ok) {
      state.doc = null
      state.token = null // a held token binds the OLD target/snapshot — voided with the doc (the saved receipt is untouched)
      fail(`Edit open refused — ${bound.message}.`)
      return false
    }
    let out
    try {
      out = await rpc.editOpen({ scope, sessionID: state.sessionID })
    } catch (err) {
      state.doc = null
      state.token = null // a held token binds the OLD target/snapshot — voided with the failed open (the saved receipt is untouched)
      // The read request was already SENT — "zero reads" would be false. What
      // this failure honestly guarantees: no document was bound and no save
      // or sync is initiated.
      fail(`The server document is unavailable (RPC editOpen failed: ${errorText(err)}) — no document was bound and no save or sync is initiated. The transport or server Forge may be down; retry /forge-config later.`)
      return false
    }
    if (!out.ok) {
      state.doc = null
      state.token = null // a held token binds the OLD target/snapshot — voided with the refused open (the saved receipt is untouched)
      // The refusal text is server-supplied and untrusted: it goes through the
      // established safeErrorText bound/mask (code+message shape, throwing
      // getters and non-scalars fail closed to the fixed sentence) — never a
      // raw interpolation of wire values.
      fail(`The server cannot resolve this target — ${errorText({ code: out.reason, message: out.message })} — no document, no writes, no syncs.`)
      return false
    }
    // Post-response re-verification: the editOpen RESPONSE can arrive after
    // a scope change — the SAME strict triple is re-checked BEFORE any
    // state assignment. On a change the stale response is DISCARDED (no
    // state.doc binding, no rebase, no list refresh follow from this) and
    // the open fails; the old binding is never re-pointed. The read was
    // already SENT, so nothing here claims zero reads.
    const settled = await reverifySession()
    if (!settled.ok) {
      state.doc = null
      state.token = null // a held token binds the OLD target/snapshot — voided with the discarded response (the saved receipt is untouched)
      fail(`Open discarded — ${settled.message} The editOpen response arrived after the scope changed and was thrown away unbound; reopen /forge-config to re-resolve the scope.`)
      return false
    }
    // Post-answer binding verification: the local scope re-verification above
    // proves nothing about WHERE this answer resolved — a success answer can
    // still name a foreign directory/session and would otherwise be bound and
    // rendered here (e.g. a false "no pool" for a directory this editor never
    // opened). The answer must name THIS request (scope + sessionID echo) and
    // carry a target identity consistent with the startup binding. On a
    // mismatch the answer is DISCARDED unbound: no state.doc, the held token
    // is voided, the saved receipt is untouched, no rebase, no UI entry.
    const binding = editOpenBindingVerdictOf({ scope, sessionID: state.sessionID }, deps.initialScope, out)
    if (!binding.ok) {
      state.doc = null
      state.token = null // a held token binds the OLD target/snapshot — voided with the discarded answer (the saved receipt is untouched)
      fail(`Open discarded — the editOpen answer does not belong to this request/binding: ${binding.message} Nothing was bound; reopen /forge-config to re-resolve.`)
      return false
    }
    // Old-server compatibility for the workspace conflict the server now
    // refuses itself (config-rpc-protocol editOpen guard): an owning pool
    // that reads back ABSENT while the server could NOT anchor its creation
    // is a conflicted resolution — never rendered as an effective global
    // fallback, and no creation entry is offered (this open refuses instead).
    if (scope === "workspace" && !out.exists && !out.creatable) {
      state.doc = null
      state.token = null // same void discipline — the saved receipt is untouched
      fail(`Open refused — the server resolved the workspace pool at ${disclosedDir(out.path)} but reports it absent and NOT creatable (conflicting resolution; possibly an older server). Reload from the list once the file settles; nothing was bound.`)
      return false
    }
    state.doc = {
      snapshotId: out.snapshotId,
      path: out.path,
      targetIdentity: out.targetIdentity,
      scope: out.scope,
      sessionID: out.sessionID,
      observedLocation: out.observedLocation,
      anchor: out.anchor,
      epoch: out.epoch,
      generation: out.generation,
      expiresAt: out.expiresAt,
      exists: out.exists,
      readable: out.readable,
      creatable: out.creatable,
      identityLabel: formatIdentity(out.identity),
      view: documentViewOf(out),
    }
    state.token = null // a prepared token binds the OLD target/snapshot
    if (scope === "workspace") state.workspaceHasPool = out.exists
    return true
  }

  function formatIdentity(identity: EditOpenOk["identity"]): string {
    if (identity === null) return "no file identity (absent)"
    const parts = [`mtime ${identity.mtimeMs}`, `size ${identity.size}`]
    if (identity.dev !== undefined) parts.push(`dev ${identity.dev}`)
    if (identity.ino !== undefined) parts.push(`ino ${identity.ino}`)
    return parts.join(", ")
  }

  async function loadCatalog(): Promise<void> {
    const loc = state.anchorHint ? { directory: state.anchorHint } : deps.data.location.default()
    try {
      await Promise.all([deps.data.location.provider.sync(loc), deps.data.location.model.sync(loc)])
      state.catalog = catalogFromRows(deps.data.location.model.list(loc))
    } catch {
      state.catalog = catalogUnknown
    }
  }

  // ------------------------------------------------------------------
  // List / scope views
  // ------------------------------------------------------------------

  async function scopeList(): Promise<void> {
    for (;;) {
      const outcome = await runListLoop()
      if (outcome === "quit") return
      // "switch": the view flipped and the new document is open.
    }
  }

  // The display row for a PENDING draft (create, or an update overlay):
  // values come from the DRAFT, never the snapshot. The draft's own
  // validation is disclosed separately in the entry menu — never merged
  // into the row (base findings stay attributed to the saved recipe).
  function entryViewOfDraft(p: PendingDraft): EntryView {
    return {
      id: p.id,
      kind: p.kind,
      mode: p.draft.mode,
      def: p.draft.mode === "pinned" ? { model: p.draft.model, thoughtLevel: p.draft.thoughtLevel, prompt: p.draft.prompt, shape: p.draft.shape, permission: p.draft.permission } : { prompt: p.draft.prompt, shape: p.draft.shape, permission: p.draft.permission },
      rawModel: p.draft.model,
      rawLevel: p.draft.thoughtLevel,
      findings: [],
      promptPresent: p.draft.prompt !== undefined,
      shape: p.draft.shape,
      permissionKeys: p.draft.permission ? Object.keys(p.draft.permission) : [],
    }
  }

  function entriesForView(view: RecipeFileView): EntryView[] {
    // Review P2(6): always a COPY — the synthetic pending rows below must
    // never mutate the held server snapshot (a discarded draft would
    // otherwise leave a ghost row inside the snapshot view).
    const base = state.view === "global" ? [...view.workers, ...view.overrides] : [...view.workers]
    // UX round (design D10 point 3): ALL pending drafts overlay the base
    // rows of the same scope — an UPDATE replaces the displayed values
    // (pending marker), a DELETE keeps the row with a removal marker, a
    // CREATE appends a synthetic row. Presentation only: the held snapshot
    // is never mutated, the base file is untouched until a confirmed save,
    // and search runs over this same merged view (draft values match;
    // stale snapshot values do not stand in for them). The option value
    // stays `kind:id` — CtrlD delete and entry opening are unaffected.
    const rows: EntryView[] = []
    const overlaid = new Set<string>()
    for (const e of base) {
      const p = state.pending.find((q) => q.kind === e.kind && q.id === e.id)
      if (p === undefined) {
        rows.push(e)
        continue
      }
      overlaid.add(`${p.kind}:${p.id}`)
      if (p.op === "delete") rows.push({ ...e, pending: "delete" })
      else if (p.op === "update") rows.push({ ...entryViewOfDraft(p), pending: "update", findings: e.findings })
      // A create draft over an EXISTING id (kept through a rebase): the
      // save will refuse it as a duplicate — the row shows the conflict
      // and KEEPS the base findings (review P2: never a fake "not yet in
      // the saved recipe").
      else rows.push({ ...entryViewOfDraft(p), pending: "create-conflict", findings: e.findings })
    }
    // Drafts without a base row stay synthetic rows (workspace overrides
    // remain hidden — the override node is global-only). An UPDATE draft
    // whose entry vanished from the fresh document (kept through the
    // rebase) must stay visible and searchable as itself — never faked
    // into a create (review P2).
    for (const p of state.pending) {
      if (state.view === "workspace" && p.kind === "override") continue
      if (overlaid.has(`${p.kind}:${p.id}`)) continue
      if (p.op === "delete") continue // deletes always reference a base row
      rows.push({ ...entryViewOfDraft(p), pending: p.op === "create" ? "create" : "update-missing" })
    }
    return rows
  }

  // F4 (dedup separation): a worker creation collides with WORKER ids only,
  // an override activation with OVERRIDE ids only — override.general must
  // not be blocked by agents.general (and vice versa).
  function existingIdsOf(kind: "worker" | "override"): string[] {
    const view = state.doc?.view
    const ids = kind === "worker" ? (view?.workers.map((e) => e.id) ?? []) : (view?.overrides.map((e) => e.id) ?? [])
    for (const p of state.pending) if (p.op === "create" && p.kind === kind) ids.push(p.id)
    return ids
  }

  function draftFindingsText(pending: PendingDraft): string {
    const v = validateDraft(pending, existingIdsOf(pending.kind).filter((id) => !(pending.op === "create" && id === pending.id)))
    if (!v.ok) return v.findings.filter((f) => f.level === "error").map((f) => f.message).join("; ")
    const warns = v.findings.filter((f) => f.level === "warn")
    return warns.length > 0 ? warns.map((f) => f.message).join("; ") : ""
  }

  function validateDraft(pending: PendingDraft, existingIds: string[]): DraftValidation {
    if (pending.op === "delete") return { ok: true, findings: [], normalizedId: pending.id }
    if (pending.kind === "override") return validateOverrideDraft(pending.id, pending.draft)
    const ids = pending.op === "create" ? existingIds : []
    return validateWorkerDraft(pending.id, pending.draft, ids)
  }

  // SHORT effective-source label for the list title (UX round point 2 —
  // titles stay short): the full path, binding and fallback consequences
  // live in "Source / file details" (sourceDetailLines) and the explicit
  // creation warning; the label keeps the effective/fallback STATE visible.
  function shortSourceLabel(doc: DocState): string {
    if (doc.scope === "workspace") return doc.exists ? "effective source" : "no pool — global fallback effective"
    return state.workspaceHasPool ? "fallback-only (not effective)" : "effective source (machine-wide)"
  }

  // The list view is RECOMPUTED from the held server document + pending
  // drafts every iteration — mutations from delete/create/save flows are
  // visible on the next render, never stale. The DOCUMENT is refreshed only
  // on explicit reload/view-switch/save (the edit-start snapshot is held
  // from editor open — F1), never per render.
  async function runListLoop(): Promise<"quit" | "switch"> {
    for (;;) {
      const doc = state.doc
      const view = doc?.view ?? null
      const entries = view !== null ? entriesForView(view) : []
      const problem = view !== null ? findingsLines(view) : ["no server document is open — reload or switch scope"]
      // missingPool = the workspace has no pool file YET. needsPool (the
      // create-blocking state) additionally requires NO pending pool
      // declaration: once the declaration is pending, worker creation is
      // allowed again — the declared pool rides the save batch (review
      // item 5: a worker can be created after the pool declaration).
      const missingPool = doc !== null && doc.scope === "workspace" && !doc.exists
      const needsPool = missingPool && state.pendingPool === null
      const poolPending = missingPool && state.pendingPool !== null
      const title = [
        state.view === "workspace" ? "Workspace workers" : "Global workers & overrides",
        doc !== null ? `(${shortSourceLabel(doc)})` : "",
        poolPending ? "(pool declaration pending save)" : "",
        state.pending.length > 0 ? `— ${state.pending.length} pending change(s)` : "",
      ].join(" ")
      const query = state.listQuery
      const filtered = query ? entries.filter((e) => matchesEntry(query, e)) : entries
      const options = entryListOptions(filtered, "", [
        { title: "Reload from server", value: RELOAD_VALUE, description: "fresh editOpen snapshot for this scope (drafts kept)", category: "List" },
        ...(doc !== null ? [{ title: "Source / file details…", value: SOURCE_DETAIL_VALUE, description: "exact path, scope, anchor, server-issued target identity, snapshot binding", category: "List" }] : []),
        ...(doc !== null && needsPool && doc.creatable ? [{ title: "Create a workspace pool file…", value: CREATE_POOL_VALUE, description: "stops the global fallback for this workspace (explicit, warned, pool name required)", category: "Create" }] : []),
        ...(state.view === "global" ? [{ title: "New global override…", value: NEW_OVERRIDE_VALUE, description: "activate a general/explore override in the global recipe", category: "Create" }] : []),
        { title: "New worker…", value: NEW_WORKER_VALUE, description: state.view === "global" ? "worker in the GLOBAL fallback recipe" : poolPending ? "worker in the declared (pending) workspace pool" : needsPool ? "requires creating the workspace pool first" : "worker in the workspace pool", category: "Create" },
        ...(entries.length > 0 ? [{ title: "Delete an entry…", value: DELETE_OPTION_VALUE, description: "pick the entry to delete (same deletion as the CtrlD shortcut)", category: "Delete" }] : []),
        { title: query ? `Search: "${query}" — change query…` : "Search entries…", value: SEARCH_OPTION_VALUE, description: `${filtered.length} of ${entries.length} shown`, category: "List" },
        { title: "Switch scope / source", value: SWITCH_VALUE, description: state.view === "workspace" ? "switch to the global view (the search and selection start fresh there)" : "switch to the workspace view (the search and selection start fresh there)", category: "List" },
        ...(state.pending.length > 0
          ? [
              { title: `${state.lastSaveFailed ? "Retry Save & Sync" : "Save & Sync"}`, value: SAVE_VALUE, description: "server prepare → preview → your explicit confirm → single-use commit; the confirmation enumerates every included entry", category: "Save" },
              { title: "Discard pending changes", value: DISCARD_VALUE, description: "drop all drafts without writing", category: "Save" },
            ]
          : []),
        ...(state.savedReceipt !== null && state.pendingSyncOutstanding ? [{ title: "Retry sync (saved recipe)", value: RETRY_SYNC_VALUE, description: "server re-reads the CURRENT recipe — the saved patch is never replayed", category: "Save" }] : []),
        // UX round point 5: the full receipt of ANY size is viewable on
        // demand (the threshold is gone — a two-entry receipt is equally
        // reachable), paginated by the shared browser.
        ...(state.lastReceipt !== null ? [{ title: `Last save receipt detail (${state.lastReceipt.entries.length} entries)…`, value: RECEIPT_DETAIL_VALUE, description: "browse EVERY entry — id · action · honest outcome · summary (the toast is never the only detail)", category: "Receipt" }] : []),
        ...(state.lastSyncResult !== null ? [{ title: `${state.lastSyncResult.ok ? "Last sync result" : "Last sync result (FAILED/UNCONFIRMED)"}…`, value: SYNC_DETAIL_VALUE, description: "the COMPLETE sync outcome — every error, conflict and note, never a truncated slice", category: "Receipt" }] : []),
        ...(state.lastSaveDetail !== null ? [{ title: `${state.lastSaveDetail.title}…`, value: SAVE_DETAIL_VALUE, description: "the COMPLETE save/rebase outcome — every note, refusal (with its findings), drop and warning, never a truncated slice", category: "Receipt" }] : []),
      ])
      // F2 (review item 4, real 2.4.2 semantics): the CtrlD action records
      // its target and CLOSES the list through the official
      // ctx.ui.dialog.clear() (probe: the host action dispatcher never
      // resolves the select itself, but clear() resolves the top dialog's
      // onClose synchronously — the footer action does not, clear does).
      // After the awaited select returns, the recorded target is consumed
      // FIRST and only then is the close judged as Esc — no nested confirm
      // replacing the select (which left onClose undefined and misjudged
      // Esc), no extra keypress. When the clear seam is unavailable
      // (try/catch), the delete runs inline so the shortcut still works —
      // the real 2.4.2 host always provides clear.
      // Object holder (not bare lets): the onTrigger closure assigns these,
      // and a bare `let` narrowed by control-flow analysis collapses to
      // never after the await.
      const action: { target: { kind: "worker" | "override"; id: string } | null; consumed: boolean } = { target: null, consumed: false }
      const picked = await ui.select({
        // Reviewer P2: the title carries only a COUNT flag — a full finding
        // message never folds into the title line; the complete findings
        // (every line, whole) live in "Source / file details".
        title: problem.length > 0 ? `${title} — FINDINGS: ${problem.length} item(s) (see Source / file details)` : title,
        // UX round point 4: the selection survives save/refresh within the
        // same scope (the host dialog re-highlights this row); a scope
        // switch clears it (never carried across scopes).
        ...(state.listCurrent !== null ? { current: state.listCurrent } : {}),
        options,
        actions: [
          {
            bind: "ctrl+d",
            title: "Delete",
            onTrigger: async (value) => {
              const parsed = typeof value === "string" ? parseEntryValue(value) : null
              if (parsed === null) return
              action.target = parsed
              action.consumed = false
              // Yield one microtask first: if the host closes the dialog
              // itself (its own clear), the flow must not double-clear —
              // clear() on an already-closed stack is probe-safe but the
              // close already happened. Otherwise THIS clear() closes the
              // list (the official mechanism; the action's return never
              // auto-closes anything).
              await Promise.resolve()
              if (action.target !== parsed || action.consumed) return
              try {
                ui.clear() // closes the list; the target is consumed below
              } catch {
                // clear unavailable / already closed by the host: consume
                // inline so the shortcut still deletes (the confirm names
                // the identity and can be cancelled). The post-select doc
                // guard applies here too — a swap during the select voids
                // the stale row; the delete can repeat on the fresh render.
                action.consumed = true
                if (state.doc !== doc) return
                await deleteFlow(parsed.kind, parsed.id)
              }
            },
          },
        ],
      })
      // P1 (review round 3): the select above is an AWAIT — a reconnect
      // fresh open can swap state.doc (S0 → S1) while it is on screen, and
      // the OLD select then resolves against the NEW document. Every row
      // below (`entries`, `entry`, `filtered`) was built from S0; acting on
      // them would hand entryMenu an OLD whole draft while it captures the
      // NEW doc (the stale-over-fresh shape overwrite), and the delete
      // paths would re-use stale rows — CtrlD included. Re-render from the
      // fresh document instead (the pressed action is dropped with the
      // stale page and can be repeated on the fresh render).
      if (state.doc !== doc) continue
      if (action.target !== null && !action.consumed) {
        // Action target BEFORE Esc judgment: clear() closed the list, so a
        // resolved undefined here is the action's close, never an Esc.
        const target = action.target
        action.target = null
        await deleteFlow(target.kind, target.id)
        continue
      }
      if (picked === undefined) {
        // F3: a pendingPool-only state is ALSO unsaved work — Esc must ask.
        if (state.pending.length > 0 || state.pendingPool !== null) {
          const stay = await ui.confirm({
            title: "Discard pending changes?",
            message: `${state.pending.length} pending change(s)${state.pendingPool !== null ? " and the pending pool declaration" : ""} are not saved. Closing now discards them.`,
            label: { confirm: "Discard", cancel: "Stay" },
          })
          if (stay !== true) continue
          state.pending = []
          state.pendingPool = null
        }
        return "quit"
      }
      if (picked === SEARCH_OPTION_VALUE) {
        const q = await ui.prompt({ title: "Search entries (id / model / prompt text)", placeholder: state.listQuery })
        if (q !== undefined) state.listQuery = q.trim()
        continue
      }
      if (picked === RELOAD_VALUE) {
        // Independent re-review P1: rebase on EVERY successful fresh open
        // with pending drafts — the per-pending baselines survive even a
        // failed recovery open, so a null captured doc never gates this.
        await freshOpenAndRebase()
        continue
      }
      if (picked === CREATE_POOL_VALUE) {
        await createPoolFlow()
        continue
      }
      if (picked === NEW_WORKER_VALUE) {
        if (doc !== null && needsPool) inform("Create the workspace pool file first — a worker entry needs its owning file.", "warning")
        else await newWorkerFlow()
        continue
      }
      if (picked === NEW_OVERRIDE_VALUE) {
        await newOverrideFlow()
        continue
      }
      if (picked === SWITCH_VALUE) {
        if (!(await guardPendingOnSwitch())) continue
        const next: Scope = state.view === "workspace" ? "global" : "workspace"
        const opened = await openDocument(next)
        if (opened) {
          state.view = next
          // Spec ruling: a scope switch CLEARS the query and selection —
          // the previous scope's context is never carried into the new one
          // (single values, no per-scope cache).
          state.listQuery = ""
          state.listCurrent = null
        }
        continue
      }
      if (picked === SAVE_VALUE) {
        await saveFlow()
        continue
      }
      if (picked === DISCARD_VALUE) {
        const sure = await ui.confirm({ title: "Discard pending changes?", message: `${state.pending.length} pending change(s)${state.pendingPool !== null ? " and the pending pool declaration" : ""} will be dropped without writing.`, label: { confirm: "Discard", cancel: "Keep" } })
        if (sure === true) {
          state.pending = []
          state.pendingPool = null
          // lastSaveFailed is NOT reset: it tracks the SAVED receipt's
          // outstanding sync, which is independent of the local drafts
          // (a view/discard action must never lose the retry entry —
          // reviewer red: "switching view clears lastSaveFailed and loses retry").
        }
        continue
      }
      if (picked === RETRY_SYNC_VALUE) {
        await syncRetryFlow()
        continue
      }
      if (picked === RECEIPT_DETAIL_VALUE) {
        // On-demand receipt browsing (review P2(5) + UX round point 5): the
        // summary toast is never the only detail surface — every entry of
        // the last receipt is a real option here, paginated at ANY size.
        // The per-entry detail is WHOLE: summary lines PLUS the refusal
        // reason and per-entry findings (a rejected entry often carries an
        // empty summary — its reason/findings are exactly what must not be
        // lost), and the receipt-level message opens the listing.
        const receipt = state.lastReceipt
        if (receipt !== null) {
          await pagedEntryBrowser(
            receipt.entries.map((e) => ({
              badge: entryOutcomeLabel(e),
              action: e.action,
              kind: e.kind,
              id: e.id,
              summary: [
                ...e.summary,
                ...(e.reason !== undefined && e.reason !== "" ? [`reason: ${e.reason}`] : []),
                ...e.findings.map((f) => `${f.level}: ${f.message}`),
              ],
            })),
            `Save receipt — per-entry outcomes (${receipt.outcome})${receipt.message ? ` — ${receipt.message}` : ""}`,
            null,
          )
        }
        continue
      }
      if (picked === SYNC_DETAIL_VALUE) {
        // The COMPLETE sync outcome of the last sync attempt — every error,
        // conflict, note and finding, never a truncated slice (coordinator
        // ruling: a receipt's embedded sync report can be null; the
        // follow-up legs' full result must stay traceable on demand).
        const sync = state.lastSyncResult
        if (sync !== null) await pagedDetailBrowser(sync.title, sync.lines)
        continue
      }
      if (picked === SAVE_DETAIL_VALUE) {
        // The COMPLETE prepare-level save outcome on demand — the no-op
        // toast's counts are never the only evidence (reviewer P2: the
        // rejected entries' own findings are part of the disclosure).
        const detail = state.lastSaveDetail
        if (detail !== null) await pagedDetailBrowser(detail.title, detail.lines)
        continue
      }
      if (picked === SOURCE_DETAIL_VALUE) {
        // Full source/file facts on demand (UX round: source detail is
        // reachable from the list — the short title line carries only the
        // effective-source summary).
        if (doc !== null) await pagedDetailBrowser("Source / file details", sourceDetailLines(doc))
        continue
      }
      if (picked === DELETE_OPTION_VALUE) {
        // Menu path to the same deletion (narrow terminals / no shortcut):
        // a second select names the entry, then the same explicit confirm.
        if (entries.length === 0) continue
        const victim = await ui.select({ title: "Delete which entry?", options: entryListOptions(entries, "", []) })
        const parsed = typeof victim === "string" ? parseEntryValue(victim) : null
        if (parsed !== null) await deleteFlow(parsed.kind, parsed.id)
        continue
      }
      const parsed = parseEntryValue(picked)
      if (parsed === null) continue
      // Selection memory (UX round point 4): survives save/refresh within
      // the same scope — the list re-highlight picks this row back up.
      state.listCurrent = picked
      const entry = entries.find((e) => e.kind === parsed.kind && e.id === parsed.id)
      if (entry === undefined) continue
      if (doc !== null && needsPool && parsed.kind === "worker" && state.pendingPool === null) {
        const go = await ui.confirm({
          title: "This entry lives in the global recipe",
          message: `${entry.id} is a global fallback worker — the workspace has no pool file. Edit it in the Global view (its owning file)?`,
          label: { confirm: "Open Global view", cancel: "Back" },
        })
        if (go === true) {
          if (await guardPendingOnSwitch()) {
            const opened = await openDocument("global")
            if (opened) {
              state.view = "global"
              state.listQuery = "" // scope switch clears query + selection (spec ruling)
              state.listCurrent = null
            }
          }
        }
        continue
      }
      await entryMenu(parsed.kind, parsed.id, entry)
    }
  }

  function matchesEntry(query: string, e: EntryView): boolean {
    const q = query.trim().toLowerCase()
    if (!q) return true
    return [e.id, e.rawModel, e.def?.prompt].some((t) => typeof t === "string" && t.toLowerCase().includes(q))
  }

  async function guardPendingOnSwitch(): Promise<boolean> {
    if (state.pending.length === 0 && state.pendingPool === null) return true
    const discard = await ui.confirm({ title: "Discard pending changes?", message: `${state.pending.length} pending change(s)${state.pendingPool !== null ? " and the pending pool declaration" : ""} target the current source. Switching scope discards them.`, label: { confirm: "Discard", cancel: "Stay" } })
    if (discard !== true) return false
    state.pending = []
    state.pendingPool = null
    // lastSaveFailed intentionally untouched — the saved receipt's sync
    // debt survives a scope switch (the retry entry must not be lost; see
    // the DISCARD branch note).
    return true
  }

  // ------------------------------------------------------------------
  // Model / level chain (design D3 — catalog-driven, Auto/Pinned atomic)
  // ------------------------------------------------------------------

  async function pickLevel(model: string | undefined, currentLevel: string | undefined): Promise<string | undefined> {
    const catalogModel = model && model.includes("/") ? state.catalog.lookup(...splitModelId(model)) : undefined
    if (state.catalog.known === false) inform("The host model catalog is unavailable — level support cannot be verified; choices are labelled unverified.", "warning")
    for (;;) {
      const options = levelOptions(catalogModel, CUSTOM_LEVEL_VALUE)
      const current: SelectOption | undefined = currentLevel !== undefined ? { title: `Keep current: ${currentLevel}`, value: `keep:${currentLevel}`, description: "preserve the existing raw value", category: "Current" } : undefined
      const picked = await ui.select({ title: `Reasoning level${model ? ` for ${model}` : ""}${catalogModel ? "" : " (target model absent from catalog — unverified)"}`, options: current ? [current, ...options] : options })
      if (picked === undefined) return undefined // cancelled — draft unchanged
      if (picked === CUSTOM_LEVEL_VALUE) {
        const custom = await ui.prompt({ title: "Custom reasoning level (canonical: none|low|medium|high|max, or a native level name)", placeholder: currentLevel ?? "e.g. ultrathought" })
        if (custom === undefined || custom.trim() === "") continue
        return custom.trim().toLowerCase()
      }
      if (picked.startsWith("keep:")) return currentLevel
      if (picked.startsWith("level:")) {
        // No extra confirm here: the option's own description already
        // labels unverified choices, and the model-CHANGE revalidation
        // (D3) is handled once in the entry menu when a level is carried
        // across a model switch. Asking twice would nag every fresh pin.
        return picked.slice("level:".length)
      }
    }
  }

  // UX round (design D10 point 2): the model chain NO LONGER asks the
  // Auto/Pinned mode question — the mode lives on the entry menu's `mode`
  // row (choosing Auto/Pinned there is the ONLY mode interaction); this
  // chain picks the pin pair itself (provider → model → level, or a manual
  // identity when the catalog is unavailable). A Pinned caller keeps its
  // mode (only the level is revalidated); an Auto caller becomes Pinned by
  // completing the pair.
  async function pickModelAndLevel(draft: EntryDraft): Promise<EntryDraft | null> {
    let model: string | undefined
    if (state.catalog.known && state.catalog.models.length > 0) {
      for (;;) {
        const providerId = await ui.select({ title: "Provider (observed catalog)", options: providerOptions(state.catalog.models, { manualEntryValue: MANUAL_MODEL_VALUE }) })
        if (providerId === undefined) return null
        if (providerId === MANUAL_MODEL_VALUE) break
        const pid = providerId.slice("provider:".length)
        const picked = await ui.select({ title: `Model by ${pid}`, options: modelOptions(state.catalog.models, pid) })
        if (picked === undefined) continue
        model = `${pid}/${picked.slice("model:".length)}`
        break
      }
    }
    if (model === undefined) {
      for (;;) {
        const manual = await ui.prompt({ title: 'Exact provider/model identity (e.g. "glm/glm-5.3")', placeholder: "provider/model" })
        if (manual === undefined) return null
        const trimmed = manual.trim()
        if (trimmed.includes("/") && !trimmed.startsWith("/") && !trimmed.endsWith("/")) {
          model = trimmed
          if (state.catalog.lookup(...splitModelId(model)) === undefined) {
            inform(`${model} is absent from the observed catalog — preserved as an unverified identity.`, "warning")
          }
          break
        }
        inform('Identity must look like "provider/model".', "warning")
      }
    }
    const previous = draft.mode === "pinned" ? draft.thoughtLevel : undefined
    const level = await pickLevel(model, previous)
    if (level === undefined) return null
    return { ...draft, mode: "pinned", model, thoughtLevel: level }
  }

  // Creation-time INITIAL mode choice: a NEW entry declares Auto or Pinned
  // exactly once (later changes go through the entry menu's mode row —
  // never a forced re-selection). This is the entry-time decision, not a
  // redundant step on every model edit.
  async function pickInitialMode(draft: EntryDraft): Promise<EntryDraft | null> {
    const modePicked = await ui.select({
      title: "Model mode (Auto/Pinned is an atomic pair)",
      options: [
        { title: "Auto — inherit the parent session's model", value: "auto", description: "removes BOTH model and thoughtLevel" },
        { title: "Pinned — exact provider/model + reasoning level", value: "pinned", description: state.catalog.known ? `${state.catalog.models.length} model(s) observed — availability unverified` : "catalog unavailable — manual identity only, unverified" },
      ],
    })
    if (modePicked === undefined) return null
    if (modePicked === "auto") return { ...draft, mode: "auto", model: undefined, thoughtLevel: undefined }
    return pickModelAndLevel(draft)
  }

  // ------------------------------------------------------------------
  // Field editors
  // ------------------------------------------------------------------

  async function editPromptFlow(pending: PendingDraft): Promise<void> {
    const current = pending.draft.prompt
    const picked = await ui.select({
      title: `Prompt ${current ? `(current: ${current.length} chars)` : "(not set)"}`,
      options: [
        { title: current !== undefined ? "Replace prompt" : "Set prompt", value: "replace", description: "opens a text prompt (empty input cancels)" },
        ...(current !== undefined ? [{ title: "Remove prompt", value: "remove", description: "deletes the prompt member on save" }] : []),
      ],
    })
    if (picked === undefined) return
    if (picked === "remove") {
      pending.draft = { ...pending.draft, prompt: undefined }
      return
    }
    const text = await ui.prompt({ title: `Role prompt for "${pending.id}" (multi-line supported; empty cancels)`, placeholder: current ? "new prompt text" : "role prompt text" })
    if (text === undefined || text.trim() === "") return
    pending.draft = { ...pending.draft, prompt: text }
  }

  async function editShapeFlow(pending: PendingDraft): Promise<void> {
    const picked = await ui.select({
      title: `Shape for "${pending.id}"`,
      options: [
        { title: "write (default)", value: "write", description: pending.draft.shape === undefined ? "no explicit shape member" : "sets shape: write" },
        { title: "readonly", value: "readonly", description: "write-family + execute denies at compile time" },
        ...(pending.draft.shape !== undefined ? [{ title: "Clear explicit shape", value: "clear", description: "removes the member (default write applies)" }] : []),
      ],
    })
    if (picked === undefined) return
    pending.draft = { ...pending.draft, shape: picked === "clear" ? undefined : (picked as "readonly" | "write") }
  }

  async function editPermissionFlow(pending: PendingDraft): Promise<void> {
    for (;;) {
      const perm = pending.draft.permission ?? {}
      const keyOptions: SelectOption[] = Object.entries(perm).map(([k, v]) => ({
        title: `${k}: ${v}`,
        value: `key:${k}`,
        description: forcedDenyKeys().includes(k) ? "forced deny by the compiler — editing here cannot lift it" : "select to change or remove",
        category: "Current overrides",
      }))
      const picked = await ui.select({
        title: `Permissions for "${pending.id}" (tool → effect)`,
        options: [
          ...keyOptions,
          { title: "Add permission key…", value: "add", description: `curated: ${PERMISSION_KEY_CHOICES.join(", ")} — or any custom tool name`, category: "Actions" },
          ...(Object.keys(perm).length > 0 ? [{ title: "Clear all explicit permissions", value: "clear", description: "removes the member; mandatory worker restrictions still apply at compile time", category: "Actions" }] : []),
        ],
      })
      if (picked === undefined) return
      if (picked === "clear") {
        pending.draft = { ...pending.draft, permission: undefined }
        continue
      }
      if (picked === "add") {
        const keyPicked = await ui.select({
          title: "Tool name",
          options: [
            ...PERMISSION_KEY_CHOICES.map((k) => ({ title: k, value: `k:${k}`, category: "Curated vocabulary" })),
            { title: "Custom tool name…", value: "k:__custom__", description: "any tool name the host exposes", category: "Other" },
          ],
        })
        if (keyPicked === undefined) continue
        let key: string | undefined = keyPicked.slice(2)
        if (key === "__custom__") {
          const custom = await ui.prompt({ title: "Custom tool name", placeholder: "tool name" })
          if (custom === undefined || custom.trim() === "") continue
          key = custom.trim()
        }
        const effectPicked = await ui.select({ title: `Effect for "${key}"`, options: PERMISSION_EFFECTS.map((e) => ({ title: e, value: e })) })
        if (effectPicked === undefined) continue
        pending.draft = { ...pending.draft, permission: { ...perm, [key]: effectPicked } }
        continue
      }
      const key = picked.slice("key:".length)
      const action = await ui.select({
        title: `Permission "${key}"`,
        options: [
          ...PERMISSION_EFFECTS.map((e) => ({ title: `Set ${e}`, value: `set:${e}`, description: perm[key] === e ? "current value" : undefined })),
          { title: "Remove this key", value: "remove", description: "deletes the member on save" },
        ],
      })
      if (action === undefined) continue
      if (action === "remove") {
        const next = { ...perm }
        delete next[key]
        pending.draft = { ...pending.draft, permission: Object.keys(next).length > 0 ? next : undefined }
      } else {
        pending.draft = { ...pending.draft, permission: { ...perm, [key]: action.slice(4) } }
      }
    }
  }

  async function entryMenu(kind: "worker" | "override", id: string, entry: EntryView): Promise<void> {
    const existing = pendingFor(kind, id)
    if (existing !== undefined && existing.op === "delete") {
      inform(`"${id}" already has a pending deletion (save to apply).`, "info")
      return
    }
    // P1 (reviewer round 2): ALL edits land on a DETACHED copy. The
    // sub-editors (prompt/shape/perm) mutate `pending.draft` AFTER their
    // internal awaits — against the SHARED object a same-epoch reconnect
    // (revision bumps, but no rebase/doc swap follows) would leak the
    // mutation into state.pending BEFORE the outer guard could run, and
    // the exit message "NOT applied" would be false. The working object
    // is private to this menu session — NOTHING in state.pending ever
    // references it — so any mid-await mutation is discardable.
    const pending: PendingDraft = detachPending(existing ?? {
      kind,
      op: "update",
      id,
      draft: draftOfLoaded(entry.def),
      original: draftOfLoaded(entry.def),
    })
    // Publication is a CLONE: state.pending receives a copy of the working
    // draft, so the working object stays exclusively ours across the whole
    // loop (a later in-place edit can never reach into state.pending).
    const publishWorking = (): void => {
      upsertPending(detachPending(pending))
    }
    // P1 (reviewer round 2, guard #1): a connection change while any
    // editor is open voids this menu session.
    const revisionAtOpen = connectionRevision
    // Guard #2: ANY background replacement of the pending LIST (rebase
    // publish, receipt consumption) swaps the array reference — our own
    // publishes go through upsertPending (splice/assign/push, in place),
    // so a changed reference is always a background replacement even at
    // the same revision.
    const pendingListAtOpen = state.pending
    // Guard #3: a background fresh open (reconnect recovery) swaps the
    // DOCUMENT — this can land BETWEEN the revision bump and the rebase,
    // or with NO pending at all (no array swap, revision already
    // re-captured). An old whole draft published onto the NEW snapshot
    // would be exactly the stale-over-fresh prepare this editor refuses
    // to risk. Any document swap (new DocState object) voids the session.
    const docAtOpen = state.doc
    const staleAfterAwait = (): boolean =>
      connectionRevision !== revisionAtOpen || state.pending !== pendingListAtOpen || state.doc !== docAtOpen
    const staleExit = (): void => {
      inform("The server document or pending list changed while this entry editor was open — every edit was held on a detached copy and NOTHING was published. Re-open the entry from the list to edit the current values.", "warning")
    }
    for (;;) {
      const d = pending.draft
      const findingsText = draftFindingsText(pending)
      // Reviewer P2 (round 3): an UNEDITED half-configured entry must not
      // read as "Auto / already repaired" — the repair draft is only a
      // menu-internal baseline until a real edit is published. The title
      // shows the BASE mode while no actual pending draft exists, and the
      // DRAFT's mode only once one does (a pin↔Auto change made here is
      // visible immediately). The pending marker rule is unchanged: only
      // with an actual draft in state.pending, never a fake "[unsaved]".
      const pendingNow = pendingFor(kind, id)
      const liveMode: EntryView["mode"] = pendingNow !== undefined ? (d.mode === "pinned" ? "pinned" : "auto") : entry.mode
      const liveTitle = entryTitle({ ...entry, mode: liveMode, pending: pendingNow !== undefined ? entry.pending ?? "update" : undefined })
      // UX round (design D10 point 2, flat edit page): the field controls
      // with their CURRENT values are visible on ONE page — every option's
      // description carries the current value, and each field editor is
      // reached directly with no unrelated navigation. The base findings
      // stay attributed to the saved recipe (on the list row); the DRAFT's
      // own validation is disclosed via the title flag and per-edit
      // findings, never merged into the base line.
      const picked = await ui.select({
        title: `${liveTitle}${findingsText ? " — DRAFT findings present (disclosed at save)" : ""}`,
        // UX round (accessibility split): the description stays a short
        // action phrase; the COMPLETE current value sits in the official
        // footer string (2.4.2 DialogSelectOption.footer — plain string,
        // never JSX; real rendering unverified while CUA input is refused,
        // so no visual claim is made). A single description line never has
        // to carry or truncate a long identity.
        options: [
          ...(d.mode === "pinned"
            ? [
                { title: "Model…", value: "model", description: "direct change — the mode STAYS Pinned, only the level is revalidated", footer: `current: ${d.model ?? "?"} @ ${d.thoughtLevel ?? "?"}` },
                { title: "Level…", value: "level", description: "change it ALONE — the model identity is unchanged", footer: `current level: ${d.thoughtLevel ?? "?"}` },
                { title: "Mode: Auto/Pinned…", value: "mode", description: "choosing Auto removes BOTH model and thoughtLevel", footer: "current: Pinned" },
              ]
            : [
                { title: "Mode: Auto/Pinned…", value: "mode", description: `choosing Pinned opens the provider/model/level pin chain${entry.mode === "half-configured" ? " — saving a valid draft repairs the half-configured pair" : ""}`, footer: `current: ${pendingNow !== undefined ? (entry.mode === "half-configured" ? "Auto (repairs the half-configured pair)" : "Auto") : entry.mode === "half-configured" ? "INVALID (half-configured pair)" : entry.mode === "invalid" ? "INVALID" : "Auto"}` },
              ]),
          { title: "Prompt…", value: "prompt", description: d.prompt ? "replace or remove the role prompt" : "set a role prompt", footer: d.prompt ? `current: ${d.prompt.length} chars` : "current: not set" },
          { title: "Shape…", value: "shape", description: "write (default) / readonly", footer: `current: ${d.shape ?? "write (default)"}` },
          { title: "Permissions…", value: "perm", description: "explicit tool → effect overrides", footer: d.permission && Object.keys(d.permission).length > 0 ? `current: ${Object.entries(d.permission).map(([k, v]) => `${k}:${v}`).join(", ")}` : "current: none explicit" },
          { title: "Save & Sync…", value: "save", description: state.pending.length > 0 ? "prepare the CURRENT pending batch — every included entry is enumerated on the confirmation page before anything is written" : "no pending changes yet — a save now would be a no-op" },
          { title: "Back (draft kept)", value: "back", description: "changes stay pending until Save & Sync" },
        ],
      })
      if (picked === undefined || picked === "back") return
      if (picked === "model" && d.mode === "pinned") {
        const next = await pickModelAndLevel(pending.draft)
        if (staleAfterAwait()) return staleExit()
        if (next !== null) {
          // D3 revalidation, asked ONLY when a level is carried UNCHANGED
          // across a model change — a freshly picked (model, level) pair
          // was already labelled at pick time. The old level's support on
          // the new model is what needs explicit reconfirmation.
          const carriedUnchanged = pending.draft.mode === "pinned" && next.mode === "pinned" && next.thoughtLevel === pending.draft.thoughtLevel && next.model !== pending.draft.model
          if (carriedUnchanged) {
            const verdict = levelVerdictAfterModelChange(next, state.catalog)
            if (verdict !== null && verdict.needsReconfirmation) {
              const keep = await ui.confirm({ title: "Level needs revalidation", message: `${verdict.note}\n\nKeep this level (labelled unverified) or pick again?`, label: { confirm: "Keep unverified level", cancel: "Pick again" } })
              if (staleAfterAwait()) return staleExit()
              if (keep !== true) continue
            }
          }
          pending.draft = next
          publishWorking()
        }
        continue
      }
      if (picked === "level" && d.mode === "pinned") {
        // Level edited ALONE: the model identity is untouched and the draft
        // remains a valid pinned pair (specs "Level edited alone").
        const level = await pickLevel(d.model, d.thoughtLevel)
        if (staleAfterAwait()) return staleExit()
        if (level !== undefined && level !== d.thoughtLevel) {
          pending.draft = { ...pending.draft, thoughtLevel: level }
          publishWorking()
        }
        continue
      }
      if (picked === "mode") {
        const choice = await ui.select({
          title: "Mode (Auto/Pinned is an atomic pair)",
          options: [
            { title: `Auto${d.mode === "auto" ? " (current)" : ""}`, value: "auto", description: "removes BOTH model and thoughtLevel" },
            { title: `Pinned${d.mode === "pinned" ? " (current)" : ""}`, value: "pinned", description: state.catalog.known ? "exact provider/model + reasoning level" : "catalog unavailable — manual identity only, unverified" },
          ],
        })
        if (staleAfterAwait()) return staleExit()
        if (choice === undefined || choice === d.mode) continue
        if (choice === "auto") {
          pending.draft = { ...pending.draft, mode: "auto", model: undefined, thoughtLevel: undefined }
          publishWorking()
          continue
        }
        // auto → pinned: the pin chain completes the pair (the only path
        // into a pin — there is no separate model entry on an Auto entry).
        const next = await pickModelAndLevel(pending.draft)
        if (staleAfterAwait()) return staleExit()
        if (next !== null) {
          pending.draft = next
          publishWorking()
        }
        continue
      }
      if (picked === "prompt") {
        await editPromptFlow(pending)
        if (staleAfterAwait()) return staleExit()
        publishWorking()
        continue
      }
      if (picked === "shape") {
        await editShapeFlow(pending)
        if (staleAfterAwait()) return staleExit()
        publishWorking()
        continue
      }
      if (picked === "perm") {
        await editPermissionFlow(pending)
        if (staleAfterAwait()) return staleExit()
        publishWorking()
        continue
      }
      if (picked === "save") {
        // In-page Save & Sync (D10 point 2): saves the CURRENT pending
        // batch; the confirmation page enumerates every included entry
        // (paged above 10) before anything is written — nothing outside
        // the previewed batch is written. After the save the editor
        // RETURNS TO THE LIST: this loop closure still holds the PRE-save
        // `pending` object — continuing here would edit a draft the save
        // already consumed (a consumed create resurrects as a duplicate;
        // a consumed update carries a stale `original` baseline and its
        // next edit would be misjudged as a no-op against old bytes —
        // reviewer P1). The list re-entry opens the entry fresh from the
        // refreshed document.
        await saveFlow()
        return
      }
    }
  }

  function pendingFor(kind: "worker" | "override", id: string): PendingDraft | undefined {
    return state.pending.find((p) => p.kind === kind && p.id === id)
  }

  // A fully DETACHED copy of a pending draft (reviewer P1 round 2): the
  // entry menu edits a private object so a mid-await background event can
  // never leak a half-applied change into state.pending, and publication
  // clones again so the working object is never shared. EntryDraft is a
  // flat record — the permission map is the only nested member and is
  // cloned with it.
  function detachPending(p: PendingDraft): PendingDraft {
    return {
      ...p,
      draft: {
        ...p.draft,
        ...(p.draft.permission !== undefined ? { permission: { ...p.draft.permission } } : {}),
      },
      original: p.original === null ? null : { ...p.original },
      touchedGroups: p.touchedGroups !== undefined ? [...p.touchedGroups] : undefined,
    }
  }

  function upsertPending(pending: PendingDraft): void {
    // Independent touched-group accumulation (UNKNOWN-rebase correctness):
    // recorded against the CURRENT base at edit time and carried across
    // rebases. Rebase adoption never enters this set — the base only
    // advances to the adopted fresh state after a completed rebase, so a
    // consecutive rebase re-derives touched from a base that already
    // contains the adopted values.
    if (pending.op === "update" && pending.original !== null) {
      pending.touchedGroups = [
        ...new Set([...(pending.touchedGroups ?? []), ...rebaseGroupsOf(changedFieldNames(pending.draft, pending.original))]),
      ]
    }
    const i = state.pending.findIndex((p) => p.kind === pending.kind && p.id === pending.id)
    if (isNoOp(pending)) {
      if (i >= 0) state.pending.splice(i, 1)
      return
    }
    if (i >= 0) state.pending[i] = pending
    else state.pending.push(pending)
  }

  // ------------------------------------------------------------------
  // Creation flows (F4: per-container dedup)
  // ------------------------------------------------------------------

  async function newWorkerFlow(): Promise<void> {
    let id: string | undefined
    for (;;) {
      const raw = await ui.prompt({ title: "Worker id ([a-z0-9-]; the forge- prefix is stripped automatically)", placeholder: "e.g. coder" })
      if (raw === undefined) return
      const normalized = normalizeWorkerId(raw.trim())
      id = normalized.id
      // Duplicate ids are NOT blocked here: the refusal happens at PREPARE
      // time (fail-soft — a refused draft never blocks its siblings), so
      // the user can draft first and see the exact refusal in the preview.
      if (existingIdsOf("worker").includes(id)) {
        inform(`"${id}" collides with an existing worker (ids that normalize to the same word collide) — the save plan will REFUSE this draft; siblings still apply.`, "warning")
      }
      if (normalized.findings.length > 0) inform(normalized.findings.map((f) => f.message).join(" · "), "warning")
      break
    }
    if (id === undefined) return
    const pending: PendingDraft = { kind: "worker", op: "create", id, draft: { mode: "auto" }, original: null }
    const next = await pickInitialMode(pending.draft)
    if (next === null) return
    pending.draft = next
    upsertPending(pending)
    inform(`"${id}" is a pending draft — Save & Sync writes it (a workspace creation replaces the global fallback for this roster).`, "info")
  }

  async function newOverrideFlow(): Promise<void> {
    const picked = await ui.select({
      title: "Override which built-in? (global recipe, machine-wide)",
      options: [
        { title: "general", value: "general", description: "General-purpose built-in subagent" },
        { title: "explore", value: "explore", description: "Explore built-in subagent" },
      ],
    })
    if (picked === undefined) return
    // F4: overrides dedup against OVERRIDE ids only — agents.general in the
    // same file must not block activating override.general.
    if (existingIdsOf("override").includes(picked)) {
      inform(`override.${picked} already exists — edit it from the list instead.`, "warning")
      return
    }
    const pending: PendingDraft = { kind: "override", op: "create", id: picked, draft: { mode: "auto" }, original: null }
    const next = await pickInitialMode(pending.draft)
    if (next === null) return
    pending.draft = next
    upsertPending(pending)
    inform(`override.${picked} activation is pending — Save & Sync activates ONLY this built-in; others keep their behavior.`, "info")
  }

  async function createPoolFlow(): Promise<void> {
    const doc = state.doc
    if (doc === null || doc.scope !== "workspace" || doc.exists || !doc.creatable) return
    const confirmed = await ui.confirm({
      title: "Create a workspace pool file?",
      message: [
        `New file (on the connected server): ${doc.path}`,
        `Server-issued target identity: ${doc.targetIdentity}`,
        "Effect: this workspace stops using the global fallback — its roster becomes exactly this file (global workers no longer apply here).",
        "The file requires a valid declared pool name ([a-z0-9-], 1-24 chars).",
        "Nothing is written until you confirm Save & Sync with the server preview.",
      ].join("\n"),
      label: { confirm: "Continue", cancel: "Cancel" },
    })
    if (confirmed !== true) return
    for (;;) {
      const suggested = sanitizeSuggestion(state.anchorHint ?? doc.path)
      const raw = await ui.prompt({ title: "Declared pool name ([a-z0-9-], 1-24 chars)", placeholder: suggested })
      if (raw === undefined) return
      const check = validatePoolField(raw.trim())
      if (check.ok) {
        state.pendingPool = check.ns
        inform(`Pool "${check.ns}" will be declared when the file is created on Save & Sync.`, "info")
        return
      }
      inform(`"${raw.trim()}" is not a valid pool name ([a-z0-9-], 1-24 chars after trim).`, "warning")
    }
  }

  // ------------------------------------------------------------------
  // Delete flow (F2: reached immediately from the CtrlD action trigger)
  // ------------------------------------------------------------------

  async function deleteFlow(kind: "worker" | "override", id: string): Promise<void> {
    const view = state.doc?.view
    const entry = view !== undefined ? [...view.workers, ...view.overrides].find((e) => e.kind === kind && e.id === id) : undefined
    if (entry === undefined) {
      // Not a document entry — it can only be a PENDING CREATION row: drop
      // that draft (no write involved) instead of claiming it is absent.
      const pendingCreate = state.pending.find((p) => p.kind === kind && p.id === id && p.op === "create")
      if (pendingCreate === undefined) {
        inform(`"${id}" is not in the current source.`, "warning")
        return
      }
      const drop = await ui.confirm({ title: `Discard the pending creation of "${id}"?`, message: "Nothing has been written yet — this drops the unsaved draft.", label: { confirm: "Discard draft", cancel: "Keep" } })
      if (drop !== true) return
      state.pending = state.pending.filter((p) => p !== pendingCreate)
      state.lastSaveFailed = false
      inform(`Pending creation of "${id}" discarded.`, "info")
      return
    }
    const existingIndex = state.pending.findIndex((p) => p.kind === kind && p.id === id)
    const confirmed = await ui.confirm({
      title: kind === "override" ? `Remove override.${id}?` : `Delete worker "${id}"?`,
      message:
        kind === "override"
          ? `Removes override.${id} from ${state.doc?.path ?? "the recipe"} — the built-in ${id} behavior returns machine-wide.\nConfirming removes only this recipe entry on explicit Save & Sync.`
          : `Deletes ${id} from ${state.doc?.path ?? "the recipe"}.\nConfirming removes only this recipe entry on explicit Save & Sync (its generated projection is garbage-collected by the server family sync).`,
      label: { confirm: kind === "override" ? "Remove override" : "Delete", cancel: "Cancel" },
    })
    if (confirmed !== true) return
    if (existingIndex >= 0) state.pending.splice(existingIndex, 1)
    // original carries the LOADED state (kept for display parity — the
    // server's receipt decides applied/unconfirmed from its own observation).
    state.pending.push({ kind, op: "delete", id, draft: { mode: "auto" }, original: draftOfLoaded(entry.def) })
    state.lastSaveFailed = false
    inform(`Deletion of "${id}" is pending — Save & Sync applies it.`, "info")
  }

  // ------------------------------------------------------------------
  // Save & Sync — server prepare → preview → explicit confirm → commit
  // ------------------------------------------------------------------

  // Wire op for one pending draft (rpc Op). Ops NEVER carry paths or raw
  // text; `renameTo` is never sent (ids are immutable). The pending pool
  // rides workspace worker ops when declared (the server requires one
  // consistent pool per create-file batch and ignores it otherwise).
  function opOf(pending: PendingDraft): Op {
    const op: Op = {
      opId: `${pending.kind}:${pending.op}:${pending.id}`,
      action: pending.op,
      kind: pending.kind,
      id: pending.id,
    }
    if (pending.op !== "delete") op.draft = pending.draft
    if (state.view === "workspace" && state.pendingPool !== null && pending.kind === "worker") op.pool = state.pendingPool
    return op
  }

  async function saveFlow(): Promise<void> {
    if (state.pending.length === 0) {
      inform("No pending changes — nothing to save (zero writes).", "info")
      return
    }
    if (state.doc === null) {
      inform("No server document is open — reload from the list first.", "error")
      return
    }
    // Authoritative scope re-verification BEFORE anything else; the CURRENT
    // sessionID is what prepare restates and the server compares against
    // the snapshot binding (a mismatch refuses without a token).
    const sessionCheck = await reverifySession()
    if (!sessionCheck.ok) {
      inform(`Save refused — ${sessionCheck.message}`, "error")
      return
    }
    const ops = state.pending.map(opOf)
    // Review P1(1): the revision this prepare was built against — a
    // connection event between here and the commit voids the token.
    const revisionAtPrepare = connectionRevision
    let out
    try {
      out = await rpc.prepare({ snapshotId: state.doc.snapshotId, scope: state.doc.scope, sessionID: state.sessionID, ops })
    } catch (err) {
      state.lastSaveFailed = true
      inform(`Prepare failed (RPC transport: ${errorText(err)}) — zero writes. Drafts kept; if the connection broke, the next Save & Sync prepares fresh.`, "error")
      return
    }
    if (!out.ok) {
      state.lastSaveFailed = true
      if (out.reason === "conflict-reload") {
        const reload = await ui.confirm({
          title: "The file changed since the editor opened",
          message: `${out.message}\n\nThe server refused so your edit is not silently swallowed. Reload the document now? (Drafts are kept and re-checked against the fresh snapshot.)`,
          label: { confirm: "Reload", cancel: "Keep editing" },
        })
        if (reload === true) {
          await freshOpenAndRebase()
        }
        return
      }
      const findings = (out.findings ?? []).map((f) => `${f.level}: ${f.message}`).join("\n")
      inform(`Prepare refused (${out.reason}): ${out.message}${findings ? `\n${findings}` : ""}\nDrafts kept${["snapshot-unknown", "snapshot-expired", "epoch-stale"].includes(out.reason) ? " — use Reload from server for a fresh snapshot" : ""}.`, "error")
      return
    }
    if (out.outcome === "no-op") {
      // Review item 8: a prepare no-op NEVER silently clears the drafts —
      // the pending drafts (including refused ones) stay with the server's
      // summary/rejections/findings disclosed as the evidence; dropping
      // them is an explicit Discard, never a side effect. The disclosure
      // is WHOLE — no slice anywhere (reviewer P2: findings/detail are the
      // only evidence a no-op leaves behind), and it is independently
      // re-viewable under "Last save attempt detail" — the toast carries
      // only counts + risk flags.
      state.token = null // no token exists for a no-op — nothing can write
      // Reviewer P2: a no-op means every op resolved to no change — but a
      // REFUSED op never "matched" anything. The wording counts the two
      // kinds separately; an all-refused batch never claims "matches".
      const matchedCount = ops.length - out.rejected.length
      const matchedWording = matchedCount > 0
        ? `${matchedCount} draft(s) already match the saved recipe`
        : "no draft matches — every one was refused by validation"
      const lines = [
        // Reviewer P2 (wording distinction): this is the RECIPE leg — zero
        // writes happened and the sync/projection leg never ran. A SYNC
        // no-op is the other case (recipe saved, projection already
        // matched) and is worded separately there.
        `Recipe prepare resolved to NO effective changes — ZERO WRITES: ${matchedWording}. The recipe file was not written; the sync/projection leg never ran.`,
        ...out.summary.map((l) => `note: ${l}`),
        ...out.rejected.flatMap((r) => [
          `REFUSED (kept pending): ${r.id} — ${r.message}`,
          ...(r.reason !== "" ? [`    reason: ${r.reason}`] : []),
          ...r.findings.map((f) => `    ${f.level}: ${f.message}`),
        ]),
        ...out.findings.map((f) => `${f.level}: ${f.message}`),
        "The pending drafts are KEPT — drop them explicitly via 'Discard pending changes'.",
      ]
      state.lastSaveDetail = { title: "Last save attempt — prepare no-op (zero writes)", lines }
      inform(
        [
          `No effective changes — zero writes: ${matchedCount} draft(s) match the saved recipe, ${out.rejected.length} refused (nothing was written; the sync leg never ran).`,
          `${out.summary.length} note(s) — full detail under "Last save attempt detail". The pending drafts are KEPT.`,
          ...(out.rejected.length > 0 ? [`RISK: ${out.rejected.length} entr(ies) REFUSED (kept pending) — their findings are in the detail view`] : []),
        ].join("\n"),
        out.rejected.length > 0 ? "warning" : "info",
      )
      return
    }
    state.token = {
      token: out.token.token,
      expiresAt: out.token.expiresAt,
      epoch: out.token.epoch,
      generation: out.token.generation,
      preview: {
        path: out.preview.path,
        targetIdentity: out.preview.targetIdentity,
        scope: out.preview.scope,
        sessionID: out.preview.sessionID,
        oldText: out.preview.oldText,
        newText: out.preview.newText,
        createFile: out.preview.createFile,
        entries: out.preview.entries.map((e) => ({ opId: e.opId, id: e.id, kind: e.kind, action: e.action, summary: e.summary })),
        rejected: out.preview.rejected,
      },
    }
    const proceed = await confirmPreview(state.token)
    if (proceed !== true) {
      state.token = null // cancel never writes; the unspent token is dropped
      inform("Cancelled — nothing was written (the prepared preview was dropped).", "info")
      return
    }
    // Review P1(1): a connection event while the preview was on screen
    // voids the prepared token — the recovery is a fresh open/prepare/
    // confirm, NEVER committing the old token.
    if (connectionRevision !== revisionAtPrepare) {
      state.token = null
      state.lastSaveFailed = true
      inform(`The server connection changed while the preview was open (revision ${connectionRevision}) — the prepared preview and token are VOID; nothing was committed. A fresh document/preview/confirmation is required; drafts are kept and rebased onto the fresh open.`, "error")
      // Same recovery discipline as every other void boundary: the fresh
      // open rebases the pending drafts (a stale draft must never prepare
      // over fresh bytes on the NEXT save).
      await freshOpenAndRebase()
      return
    }
    await commitFlow()
  }

  // Shared paged review listing (review P2(5) + receipt accessibility):
  // EVERY entry is a real select option carrying its id, action and summary
  // in the option itself; selecting one discloses its FULL summary lines as
  // a read-only detail toast — a bare Next/Confirm count is never the only
  // disclosure. The confirm choice appears ONLY after every page has been
  // rendered (the "all reviewed" claim stays honest); navigation is clamped
  // at the edges and Esc exits without crossing a page boundary. With
  // confirmTitle === null it is a browse-only listing (receipts).
  async function pagedEntryBrowser(
    rows: { badge?: string; action: string; kind: string; id: string; summary: string[] }[],
    listTitle: string,
    confirmTitle: string | null,
  ): Promise<"cancel" | "confirm"> {
    const perPage = 10
    const pageCount = Math.max(1, Math.ceil(rows.length / perPage))
    const visited = new Set<number>()
    let page = 0
    for (;;) {
      visited.add(page)
      const start = page * perPage
      const slice = rows.slice(start, start + perPage)
      const pick = await ui.select({
        title: `${listTitle} — page ${page + 1} of ${pageCount} (entries ${start + 1}-${start + slice.length} of ${rows.length})`,
        options: [
          ...slice.map((r, i) => ({
            title: `${r.badge !== undefined ? `${r.badge}: ` : ""}${r.action} ${r.kind} "${r.id}"`,
            description: r.summary.length > 0 ? r.summary.join(" · ") : "(no per-entry detail lines)",
            value: `entry:${start + i}`,
            category: "Entry",
          })),
          ...(page + 1 < pageCount ? [{ title: "Next page", value: PREVIEW_NEXT_VALUE, description: `entries ${start + perPage + 1}-${Math.min(start + perPage * 2, rows.length)}`, category: "Review" }] : []),
          ...(page > 0 ? [{ title: "Previous page", value: PREVIEW_PREV_VALUE, category: "Review" }] : []),
          ...(confirmTitle !== null && visited.size >= pageCount ? [{ title: confirmTitle, value: PREVIEW_CONFIRM_VALUE, category: "Review" }] : []),
          { title: confirmTitle === null ? "Close" : "Cancel — nothing is written", value: PREVIEW_CANCEL_VALUE, category: "Review" },
        ],
      })
      if (pick === PREVIEW_CANCEL_VALUE || pick === undefined) return "cancel" // Esc never crosses a page boundary
      if (pick === PREVIEW_CONFIRM_VALUE) return "confirm"
      if (pick === PREVIEW_NEXT_VALUE) {
        page = Math.min(page + 1, pageCount - 1)
        continue
      }
      if (pick === PREVIEW_PREV_VALUE) {
        page = Math.max(page - 1, 0)
        continue
      }
      const row = rows[Number(String(pick).slice("entry:".length))]
      if (row !== undefined) {
        inform([`${row.action} ${row.kind} "${row.id}"${row.badge !== undefined ? ` — ${row.badge}` : ""}`, ...row.summary.map((l) => `    ${l}`)].join("\n"), "info")
      }
    }
  }

  // Paged read-only text listing (10 lines/page) — the on-demand FULL
  // detail surface for source/file facts and sync results (UX round point
  // 5: brevity in toasts never hides detail; anything over one page
  // paginates without loss). A long line folds in the title for width
  // ONLY — its complete text lives in the official `footer` (plain
  // string, never truncated) and SELECTING the row re-discloses it whole
  // (reviewer P2: no detail ever depends on a single-line description
  // with no expansion).
  async function pagedDetailBrowser(title: string, lines: string[]): Promise<void> {
    const perPage = 10
    const pageCount = Math.max(1, Math.ceil(lines.length / perPage))
    let page = 0
    for (;;) {
      const start = page * perPage
      const slice = lines.slice(start, start + perPage)
      const pick = await ui.select({
        title: `${title} — page ${page + 1} of ${pageCount}`,
        options: [
          ...slice.map((l, i) => ({
            title: l.length > 80 ? `${l.slice(0, 77)}…` : l,
            value: `line:${start + i}`,
            footer: l,
            ...(l.length > 80 ? { description: `${l.length} chars — select to view the full line` } : {}),
            category: "Detail",
          })),
          ...(page + 1 < pageCount ? [{ title: "Next page", value: PREVIEW_NEXT_VALUE, description: `lines ${start + perPage + 1}-${Math.min(start + perPage * 2, lines.length)}`, category: "Review" }] : []),
          ...(page > 0 ? [{ title: "Previous page", value: PREVIEW_PREV_VALUE, category: "Review" }] : []),
          { title: "Close", value: PREVIEW_CANCEL_VALUE, category: "Review" },
        ],
      })
      if (pick === PREVIEW_CANCEL_VALUE || pick === undefined) return
      if (pick === PREVIEW_NEXT_VALUE) {
        page = Math.min(page + 1, pageCount - 1)
        continue
      }
      if (pick === PREVIEW_PREV_VALUE) {
        page = Math.max(page - 1, 0)
        continue
      }
      // 点开全文: selecting a row re-discloses its COMPLETE line (never
      // the folded title alone).
      const index = Number(String(pick).slice("line:".length))
      const line = lines[index]
      if (line !== undefined) inform(line, "info", `${title} — line ${index + 1} (full)`)
    }
  }

  // Full source/file facts for the on-demand detail view — everything the
  // server issued for this binding, disclosed in full (remote-disclosure
  // requirement; the list title only carries the short effective-source
  // summary).
  function sourceDetailLines(doc: DocState): string[] {
    // Reviewer P2 (title carries the count only): the COMPLETE findings
    // (parse problem + every finding, whole text) are reachable HERE —
    // the list title's count flag points at this view.
    const findings = findingsLines(doc.view)
    return [
      `path: ${doc.path}`,
      `scope: ${doc.scope === "global" ? "global (machine-wide)" : "workspace"} · sessionID: ${doc.sessionID ?? "null (home)"}`,
      `observed location: ${doc.observedLocation ?? "(none)"}`,
      `anchor: ${doc.anchor ?? "(none)"}`,
      `server-issued target identity: ${doc.targetIdentity}`,
      `snapshot binding: epoch ${doc.epoch} · generation ${doc.generation} · expiresAt ${new Date(doc.expiresAt).toISOString()}`,
      `file: ${doc.exists ? "exists" : "absent"} · readable: ${doc.readable ? "yes" : "no"} · creatable: ${doc.creatable ? "yes" : "no"}`,
      `identity: ${doc.identityLabel}`,
      `pending changes: ${state.pending.length}${state.pendingPool !== null ? ` · pending pool declaration: ${state.pendingPool}` : ""}`,
      ...(findings.length > 0 ? [`findings: ${findings.length} item(s) — full text below`, ...findings] : []),
    ]
  }

  // Explicit human confirmation over the server preview. The remote-write
  // disclosure is mandatory and unconditional: the write lands on the
  // CONNECTED SERVER's filesystem — scope, exact path and server-issued
  // identity are shown before confirmation is possible (specs
  // remote-disclosure requirement; there is no same-machine proof).
  async function confirmPreview(prepared: PreparedToken): Promise<boolean> {
    const p = prepared.preview
    // Review P2(5): EVERY entry is reviewable BEFORE confirmation — more
    // than 10 are paged in full (never a slice-12 ellipsis), every entry
    // option names its id/action/summary, and the confirm choice exists
    // only after every page was rendered; the dialog then carries the
    // verified totals honestly.
    let pagedThrough = false
    if (p.entries.length > 10) {
      const verdict = await pagedEntryBrowser(
        p.entries.map((e) => ({ action: e.action, kind: e.kind, id: e.id, summary: e.summary })),
        "Review preview",
        `All ${p.entries.length} entries reviewed — go to confirmation`,
      )
      if (verdict !== "confirm") return false
      pagedThrough = true
    }
    const entryLines = pagedThrough
      ? [`All ${p.entries.length} change(s) were reviewed page-by-page above.`]
      : p.entries.flatMap((e) => [`• ${e.action} ${e.kind} "${e.id}":`, ...e.summary.slice(0, 6).map((l) => `    ${l}`)])
    const summaryLines = [
      `File: ${p.path}`,
      `Scope: ${p.scope === "global" ? "global (machine-wide)" : `workspace (sessionID ${p.sessionID === null ? "null — home scope of the server-observed location" : p.sessionID})`}`,
      `Server-issued target identity: ${p.targetIdentity}`,
      "TARGET: the CONNECTED SERVER's filesystem — this editor never writes local files.",
      ...(p.createFile ? ["NEW FILE will be created."] : []),
      ...entryLines,
      diffSummary(p.oldText, p.newText),
      ...p.rejected.map((r) => `REFUSED — NOT included (${r.id}): ${r.message}`),
      ...state.doc?.view.findings.slice(0, 4).map((f) => `${f.level}: ${f.message}`) ?? [],
      ...catalogFindingLines(),
    ]
    return (await ui.confirm({
      title: `Save & Sync ${p.entries.length} change(s)${p.rejected.length > 0 ? `, ${p.rejected.length} refused` : ""} to the connected server?`,
      message: summaryLines.join("\n") || "no effective changes",
      label: { confirm: "Save & Sync", cancel: "Cancel" },
    })) === true
  }

  async function commitFlow(): Promise<void> {
    const prepared = state.token
    if (prepared === null) return
    const doc = state.doc
    if (doc === null) {
      state.token = null
      return
    }
    // Independent re-review P1: the revision this commit verification began
    // against — a connection event during ANY of the awaited steps below
    // (echo, session re-verify) is caught by the synchronous gate right
    // before the write.
    const revisionAtCommit = connectionRevision
    // Epoch/registration check (D7 client-instance discipline): a fresh
    // echo must match the token binding, else the token is dropped and a
    // fresh editor session (prepare + preview + confirm) is required.
    const nonce = randomUUID()
    let verdict
    try {
      verdict = echoVerdictOf(nonce, await rpc.echo({ nonce }), { epoch: prepared.epoch, generation: prepared.generation })
    } catch (err) {
      verdict = { provable: false, reason: `echo failed (RPC transport: ${errorText(err)})` }
    }
    if (!verdict.provable) {
      state.token = null
      state.lastSaveFailed = true
      inform(`Commit refused — ${verdict.reason}\nDrafts kept. The next Save & Sync prepares a fresh preview for explicit confirmation.`, "error")
      return
    }
    // Restate the CURRENT scope/sessionID (the server cannot observe the
    // TUI router's session→home migration — commit compares exactly).
    const sessionCheck = await reverifySession()
    if (!sessionCheck.ok) {
      state.token = null
      state.lastSaveFailed = true
      inform(`Commit refused — ${sessionCheck.message}`, "error")
      return
    }
    // Synchronous gate AFTER the last await and BEFORE the write RPC: a
    // server.connected event during the echo/session awaits increments the
    // revision and may already have nulled state.token — the captured
    // local `prepared` alone must never still commit. Void = ZERO commit,
    // fresh open, drafts rebased; the next save is a NEW prepare + preview
    // + explicit confirmation.
    if (connectionRevision !== revisionAtCommit || state.token !== prepared) {
      state.token = null
      state.lastSaveFailed = true
      inform(`The server connection changed while the commit was being verified (revision ${connectionRevision}) — the prepared token is VOID; NOTHING was committed. A fresh document/preview/confirmation is required; drafts are kept.`, "error")
      await freshOpenAndRebase()
      return
    }
    let out
    try {
      out = await rpc.commit({ token: prepared.token, confirm: true, scope: doc.scope, sessionID: state.sessionID })
    } catch {
      // R-CONN1: a connection event while the commit itself was in flight
      // makes its outcome UNADJUDICABLE — no same-epoch receipt lookup, no
      // receiptFlow, zero consumption. Drafts stay pending; the write may
      // or may not have landed server-side and is never replayed.
      if (connectionRevision !== revisionAtCommit || state.token !== prepared) {
        state.token = null
        state.lastSaveFailed = true
        inform(`The server connection changed while the commit was in flight (revision ${connectionRevision}) — the commit outcome is UNADJUDICATED: no receipt lookup, no receipt consumption. Drafts stay pending; a fresh document is open; the next Save & Sync prepares fresh.`, "warning")
        await freshOpenAndRebase()
        return
      }
      // Response lost / transport failure — NEVER replay. The same-epoch
      // receipt lookup decides when it exists; otherwise the outcome is
      // UNKNOWN (bytes are never used to adjudicate an old commit).
      let receipt: CommitReceipt | null = null
      try {
        const r = await rpc.receipt({ token: prepared.token })
        // The receipt lookup is ITSELF an awaited boundary: a connection
        // event during it makes a found answer untrustworthy — the outcome
        // stays UNKNOWN, the old receipt is never consumed, no sync starts.
        if (connectionRevision !== revisionAtCommit || state.token !== prepared) {
          state.token = null
          state.lastSaveFailed = true
          inform(`The server connection changed while the commit receipt was being looked up (revision ${connectionRevision}) — the commit outcome stays UNKNOWN: the old receipt is not consumed, no sync starts. Drafts stay pending; a fresh document is open.`, "warning")
          await freshOpenAndRebase()
          return
        }
        if (r.found) receipt = r.receipt
      } catch {
        // Thrown-lookup twin: an event during the failed lookup is the same
        // UNKNOWN boundary — never silently treated as "no receipt" on a
        // crossed connection.
        if (connectionRevision !== revisionAtCommit || state.token !== prepared) {
          state.token = null
          state.lastSaveFailed = true
          inform(`The server connection changed while the commit receipt lookup failed (revision ${connectionRevision}) — the commit outcome stays UNKNOWN: the old receipt is not consumed, no sync starts. Drafts stay pending; a fresh document is open.`, "warning")
          await freshOpenAndRebase()
          return
        }
        receipt = null
      }
      state.token = null
      if (receipt !== null) {
        await receiptFlow(receipt)
        return
      }
      state.lastSaveFailed = true
      // Review item 6: UNKNOWN is never replayed and bytes never adjudicate
      // an old commit — the only honest recovery is a FRESH editOpen (new
      // snapshotId/epoch) while the drafts are kept AND REBASED onto the
      // fresh content (review P1(2): a stale draft must not overwrite
      // externally changed pins/shapes — untouched fields adopt fresh,
      // collided fields ask explicitly); any further save is a NEW prepare
      // + preview + explicit confirmation.
      // Independent re-review P1: the per-pending baselines survive a failed
      // recovery open (state.doc === null) — the NEXT successful fresh open
      // must still rebase, or a stale draft prepares over fresh bytes.
      const reopened = await freshOpenAndRebase()
      inform(
        [
          "Commit outcome UNKNOWN (response lost, no receipt found) — nothing is replayed.",
          reopened === "ok"
            ? "A fresh server document is open (new snapshot/epoch); the drafts were rebased onto it and kept — Save & Sync prepares a NEW preview for explicit confirmation."
            : reopened === "rebase-cancelled"
              ? "The fresh document opened, but the draft rebase was CANCELLED (Esc) — no decision was recorded, the snapshot binding was released, the drafts are unchanged. Use 'Reload from server' to re-answer the rebase prompts; Save & Sync is refused until a document is open."
              : "The fresh document open failed too — use 'Reload from server' once the connection recovers; the drafts are kept.",
        ].join("\n"),
        "error",
      )
      return
    }
    // R-CONN1 resolved-path twin: a connection event while the commit await
    // was pending voids adjudication even when the RPC RESOLVED — the old
    // receipt is never consumed (no receiptFlow, no sync start), drafts
    // stay pending, nothing is replayed; the fresh open shows what actually
    // landed server-side.
    if (connectionRevision !== revisionAtCommit || state.token !== prepared) {
      state.token = null
      state.lastSaveFailed = true
      inform(`The server connection changed while the commit was in flight (revision ${connectionRevision}) — the commit outcome is UNADJUDICATED: the returned receipt is not consumed. Drafts stay pending; a fresh document is open; the next Save & Sync prepares fresh.`, "warning")
      await freshOpenAndRebase()
      return
    }
    state.token = null // the token is spent either way (success or refusal)
    if (!out.ok) {
      state.lastSaveFailed = true
      inform(`Commit refused (${out.reason}): ${out.message}\nDrafts kept — the next Save & Sync prepares fresh.`, "error")
      return
    }
    await receiptFlow(out.receipt)
  }

  // The SHORT toast form (UX round point 5): counts + risk flags only —
  // never a full receipt listing, never stacked long lines. The complete
  // receipt stays one list item away ("Last save receipt detail", ANY
  // size, paginated). The refusal line goes through refusedAccountLine —
  // the "still pending" part is reconciled, never a stale claim.
  function shortReceiptSummary(receipt: CommitReceipt, pendingLeft: number, refusedStillPendingCount?: number): string[] {
    const written = receipt.entries.filter((e) => e.outcome === "written").length
    const unchanged = receipt.entries.filter((e) => e.outcome === "no-op").length
    const refused = receipt.entries.filter((e) => e.outcome === "rejected").length
    const lines = [
      receipt.outcome === "no-op"
        ? `no-op: zero writes — the file already matches (${unchanged} unchanged, ${refused} refused)`
        : `saved: ${written} change(s) → ${receipt.path} (${receipt.bytes} bytes, commit ${receipt.commitId.slice(0, 8)})`,
    ]
    if (refused > 0) {
      const line = refusedAccountLine(refused, refusedStillPendingCount ?? refused)
      if (line !== null) lines.push(line)
    }
    if (unchanged > 0 && receipt.outcome !== "no-op") lines.push(`${unchanged} entr(ies) unchanged`)
    if (receipt.entries.length > 0 && receipt.entries.some((e) => e.outcome !== "written" && e.outcome !== "no-op" && e.outcome !== "rejected")) lines.push("RISK: some entries have no explicit server verdict (kept pending)")
    if (receipt.entries.length === 0) lines.push("the receipt carried no per-entry outcomes — every draft stays pending")
    if (pendingLeft > 0) lines.push(`${pendingLeft} draft(s) remain pending`)
    return lines
  }

  // Reviewer P2 (round 3, item 4): a refusal count is historical — the
  // still-pending part is RECONCILED against the current pending list by
  // identity (the post-save rebase can Drop refused drafts). null when
  // there were no refusals (no note at all).
  function refusedAccountLine(total: number, stillPending: number): string | null {
    if (total <= 0) return null
    if (stillPending >= total) return `RISK: this save REFUSED ${total} entr(ies) — all still pending (findings under "Last save receipt detail")`
    if (stillPending > 0) return `RISK: this save REFUSED ${total} entr(ies) — ${stillPending} still pending, ${total - stillPending} since dropped (findings under "Last save receipt detail")`
    return `this save REFUSED ${total} entr(ies) — all since dropped from the pending list (details under "Last save receipt detail")`
  }

  async function receiptFlow(receipt: CommitReceipt): Promise<void> {
    // The receipt stays browsable from the list regardless of its outcome —
    // "Last save receipt detail" (ANY size) re-opens the full per-entry
    // listing on demand (never a modal intercept between the save and its
    // follow-up sync confirm).
    state.lastReceipt = receipt
    if (receipt.outcome === "no-op") {
      // Review item 8: a no-op receipt consumes ONLY entries the server
      // explicitly mapped — rejected or unmapped drafts stay pending with
      // the evidence disclosed (never a silent clear-all); the short toast
      // carries the counts, the full per-entry evidence is the detail view.
      state.pending = consumeReceiptEntries(receipt)
      // Review P2(4): pendingSyncOutstanding is deliberately UNTOUCHED — a
      // no-op SAVE receipt says nothing about the SAVED receipt's
      // outstanding sync, and a consumed draft must not hide the retry.
      state.lastSaveFailed = state.pending.length > 0
      inform([...shortReceiptSummary(receipt, state.pending.length), "use 'Discard pending changes' to drop drafts explicitly — a no-op never clears them"].join("\n"), state.lastSaveFailed ? "warning" : "info", "Forge: Save & Sync receipt")
      return
    }
    if (receipt.outcome !== "written") {
      // conflict / ownership-lost / write-failed / missing / unreadable /
      // unparseable: NOTHING was written — every draft stays pending. This
      // is a protocol refusal: the cause stays visible verbatim (never
      // flattened into a bare count).
      const conflictish = receipt.outcome === "conflict" || receipt.outcome === "ownership-lost"
      const lines = [conflictish ? `CONFLICT (nothing overwritten): ${receipt.message}` : `WRITE ERROR (prior bytes intact): ${receipt.message}`]
      if (["conflict", "ownership-lost", "unparseable"].includes(receipt.outcome)) lines.push("Use 'Reload from server' for a fresh snapshot (drafts are kept).")
      state.lastSaveFailed = true
      inform([...lines, `${state.pending.length} draft(s) remain pending — Save & Sync again to prepare against the current file.`].join("\n"), "error", "Forge: Save & Sync receipt")
      return
    }
    // Written. ONLY an explicit per-entry verdict consumes a draft:
    // written/no-op entries are satisfied, rejected and unmapped entries
    // stay pending (fail-soft).
    state.pending = consumeReceiptEntries(receipt)
    state.pendingPool = null
    state.savedReceipt = receipt
    const rejected = receipt.entries.filter((e) => e.outcome === "rejected")
    // Reviewer P2 (round 3, item 4): "N refused" is a HISTORICAL fact about
    // THIS save; whether those entries are STILL pending must be reconciled
    // by identity (kind+id) at disclosure time — the post-save rebase can
    // legitimately Drop some of them, and a stale "still pending" claim
    // would be false.
    const refusedIds: { kind: "worker" | "override"; id: string }[] = rejected.map((e) => ({ kind: e.kind, id: e.id }))
    const refusedStillPending = (): number =>
      state.pending.filter((p) => refusedIds.some((r) => r.kind === p.kind && r.id === p.id)).length
    const syncReport = summarizeSync(receipt.sync)
    // Review P2(4): the saved-receipt sync state is its own flag — a later
    // draft lifecycle can no longer hide (or fake) the retry entry.
    state.pendingSyncOutstanding = syncReport === null || !syncReport.ok
    if (syncReport !== null) {
      state.lastSaveFailed = rejected.length > 0 || !syncReport.ok
      // The receipt's embedded sync outcome is fully traceable on demand —
      // recorded whole (never a slice), short flags in the toast.
      recordSyncResult(`Sync report (from save receipt) — ${syncReport.ok ? "ok" : "failed/unconfirmed"}`, syncReport.ok, syncReport.lines)
    } else {
      // Review item 3: the server reported NO sync outcome for the write —
      // the FIRST sync runs immediately: prepare (pure read) → the CURRENT
      // scope/path/changes preview → the user's explicit SECOND
      // confirmation → apply. Cancel/refusal keeps the retry entry; the
      // saved patch is never replayed.
      state.lastSaveFailed = true
    }
    // Refresh the document (fresh snapshot for further edits) — through the
    // SHARED recovery discipline: drafts that REMAIN pending (rejected or
    // unmapped entries) are REBASED onto the fresh snapshot (per-pending
    // baselines/touchedGroups), so the next prepare can never replay a
    // stale whole draft over externally-changed untouched fields (reviewer
    // P1). BOTH disclosures are quiet here: the open-failure cause and the
    // rebase-cancel verdict are folded into the SINGLE post-save toast
    // below (reviewer P2 round 3, item 3 — the embedded-sync save toast is
    // DEFERRED and shown together with the refresh verdict; two toasts for
    // one ending never happen).
    const refreshed = await freshOpenAndRebase({ quietOpenFailure: true, quietRebaseCancel: true })
    const refusedStill = refusedStillPending()
    const saveToastLines = (syncLine: string | null): string[] => [
      ...shortReceiptSummary(receipt, state.pending.length, refusedStill),
      ...(syncLine !== null ? [syncLine] : []),
    ]
    if (refreshed === "ok") {
      if (syncReport !== null) {
        // The deferred save verdict — ONE toast, issued only now that the
        // refresh has landed (counts + risk flags; full receipt one list
        // item away).
        inform(
          saveToastLines(syncReport.ok ? "sync: executed (details under 'Last sync result')" : "sync: failed/unconfirmed — retry available").join("\n"),
          state.lastSaveFailed ? "warning" : "success",
          "Forge: Save & Sync receipt",
        )
      } else {
        // First-sync path: the sync confirmation carries the already-saved
        // context (incl. the reconciled refusal line) — no stacked save
        // toast.
        await runSyncLegs(receipt.scope, receipt.commitId, refusedIds)
      }
      return
    }
    // The refused line rides saveToastLines already — the standalone copy
    // is appended only on the sync-null path, never both. The Retry mention
    // appears only while the retry entry is actually armed, and the
    // embedded sync state is named in every ending.
    const syncLineText = syncReport !== null ? (syncReport.ok ? "sync: executed (details under 'Last sync result')" : "sync: failed/unconfirmed — retry available") : null
    const refusedLine = refusedAccountLine(rejected.length, refusedStill)
    const retryMention = state.pendingSyncOutstanding ? "; for the pending sync, 'Retry sync (saved recipe)'" : ""
    if (refreshed === "rebase-cancelled") {
      // An Esc-cancelled rebase is a USER cancellation, never "refresh
      // failed" — and the only toast for the whole ending carries the save
      // verdict (when the sync was embedded), the cancellation verdict and
      // the reconciled refusal line (sync-null path only — embedded already
      // carries it) together.
      inform(
        [
          ...(syncLineText !== null ? saveToastLines(syncLineText) : []),
          `saved — the post-save draft rebase was CANCELLED (Esc): no decision was recorded, the drafts and baselines are unchanged, and the fresh snapshot binding was released. Nothing is replayed. Recovery: 'Reload from server' re-answers the rebase prompts${retryMention}.`,
          ...(syncReport === null && refusedLine !== null ? [refusedLine] : []),
        ].join("\n"),
        "warning",
        "Forge: Save & Sync receipt",
      )
      return
    }
    // open-failed: a failed refresh ENDS the flow — no sync confirmation is
    // stacked on a document-less editor (runSyncLegs would only refuse on
    // it again). The saved receipt stays fully retained; the sync retry
    // entry stays armed via pendingSyncOutstanding. The open failure's
    // verbatim cause leads this single toast (its own toast was suppressed
    // above), which also names the embedded sync state — a successful sync
    // never points at the (unarmed) retry.
    inform(
      [
        ...(lastOpenFailureLine !== null ? [lastOpenFailureLine] : ["The fresh open after the save failed — no document is bound."]),
        ...(syncLineText !== null ? saveToastLines(syncLineText) : []),
        `saved — the receipt stays valid and accessible ("Last save receipt detail"); nothing is replayed. Recovery: 'Reload from server'${state.pendingSyncOutstanding ? " or, for the pending sync, 'Retry sync (saved recipe)'" : ""}.`,
        ...(syncReport === null && refusedLine !== null ? [refusedLine] : []),
      ].join("\n"),
      "warning",
      "Forge: Save & Sync receipt",
    )
  }

  // Honest per-entry wording: an unchanged entry is never worded as applied.
  function entryOutcomeLabel(e: CommitEntryOutcome): string {
    return e.outcome === "written" ? "written" : e.outcome === "no-op" ? "no-op (unchanged)" : "REFUSED"
  }

  // Shared per-entry consumption for both receipt paths (review item 8):
  // ONLY an explicit server verdict consumes a draft — rejected entries and
  // unmapped drafts always stay pending.
  function consumeReceiptEntries(receipt: CommitReceipt): PendingDraft[] {
    const stillPending: PendingDraft[] = []
    for (const p of state.pending) {
      const key = `${p.kind}:${p.op}:${p.id}`
      const outcome = receipt.entries.find((e) => e.opId === key)
      if (outcome === undefined || outcome.outcome === "rejected") stillPending.push(p)
    }
    return stillPending
  }

  // Presentation label for a rebase group (the Auto/Pinned trio names
  // itself as the atomic pair it is — never three loose fields).
  function groupLabel(g: RebaseGroup): string {
    return g === "pin" ? "model/level pin (Auto/Pinned pair)" : g === "prompt" ? "prompt" : g === "shape" ? "shape" : "permissions"
  }

  // Review P1(2): after a FRESH document open the pending drafts are
  // REBASED, never blindly replayed over the fresh bytes — untouched groups
  // adopt the fresh values whole (an external pin/shape/permission change
  // is never overwritten by a stale loaded value), user-touched groups that
  // ALSO changed externally get an explicit keep-mine/drop decision, and
  // vanished entries / appeared duplicates are surfaced. Per-draft fail-
  // soft: one refused draft never blocks its siblings.
  // Independent re-review P1: NO captured-document parameter — every
  // pending carries its own `original` baseline, which survives even a
  // FAILED recovery open (state.doc === null). EVERY successful fresh open
  // with pending drafts rebases here; whether a stale doc happened to be
  // reachable must never gate the rebase.
  async function rebaseDraftsOnFreshDocument(opts?: { silentCancel?: boolean }): Promise<void> {
    const freshDoc = state.doc
    if (freshDoc === null || state.pending.length === 0) return
    const freshEntryOf = (kind: "worker" | "override", id: string) =>
      (kind === "worker" ? freshDoc.view.workers : freshDoc.view.overrides).find((e) => e.id === id)
    // TRANSACTIONAL rebase (reviewer ruling): the decisions are collected
    // on COPIES — an earlier draft's base advance can never leak into a
    // later cancel — and the result is published to state.pending only
    // when EVERY draft reached an EXPLICIT resolution. An Esc (undefined)
    // at ANY prompt cancels the WHOLE rebase: the original pending list,
    // baselines and touchedGroups stay untouched, the fresh snapshot
    // binding is RELEASED (state.doc = null, held token with it — the
    // saved receipt is untouched), so the un-rebased drafts can never pair
    // with the fresh snapshot in a prepare. The recovery is 'Reload from
    // server' (the fresh open re-asks every prompt); a save without a
    // document is refused — never bypassed.
    const working: PendingDraft[] = state.pending.map((p) => ({ ...p }))
    const kept: PendingDraft[] = []
    // Drop announcements are DEFERRED until the batch is actually
    // published: a prompt answered "Drop" and then cancelled by a later Esc
    // must never have claimed a drop (the transactional publish discards
    // the whole working set — nothing was dropped).
    const droppedNotes: string[] = []
    let dropped = 0
    let adopted = 0
    const cancelRebase = (): void => {
      state.doc = null // the fresh snapshot binding is released with the cancelled rebase
      state.token = null // a held token binds the old target/snapshot — released with the doc
      // silentCancel: the CALLER words the cancellation (its toast carries
      // the full save context — reviewer P2 round 3: two toasts for the
      // same cancellation, inner + outer, announce it twice).
      if (opts?.silentCancel === true) return
      inform(
        "Rebase CANCELLED (Esc) — no decision was recorded: the drafts, baselines and pending list are UNCHANGED and the fresh snapshot binding was released, so nothing pairs the old draft values with the fresh bytes. Use 'Reload from server' to re-open the document and answer the rebase prompts; Save & Sync is refused until a document is open.",
        "warning",
      )
    }
    for (const p of working) {
      if (p.op === "create") {
        const duplicate =
          freshEntryOf(p.kind, p.id) !== undefined ||
          working.some((q) => q !== p && q.op === "create" && q.kind === p.kind && q.id === p.id)
        if (!duplicate) {
          kept.push(p)
          continue
        }
        const keep = await ui.confirm({
          title: `Your new "${p.id}" already exists in the fresh document`,
          message: `The fresh server document contains ${p.kind} "${p.id}" — saving your create draft would be refused as a duplicate. Keep the draft (it stays refused until resolved) or drop it?`,
          label: { confirm: "Keep draft", cancel: "Drop draft" },
        })
        if (keep === undefined) return cancelRebase() // no answer — the whole rebase cancels
        if (keep === true) kept.push(p)
        else {
          dropped++
          droppedNotes.push(`Dropped create draft "${p.id}" — it duplicates the fresh document.`)
        }
        continue
      }
      if (p.op === "delete") {
        const freshEntry = freshEntryOf(p.kind, p.id)
        if (freshEntry === undefined) {
          dropped++
          droppedNotes.push(`Dropped delete draft "${p.id}" — the entry is already gone from the fresh document (nothing left to delete).`)
          continue
        }
        // The per-pending `original` IS the entry's loaded baseline (it
        // survives even when state.doc is null mid-recovery); the external-
        // change judgment compares the FRESH entry against THAT baseline
        // under the shared draftsEqual normalization.
        const changedExternally =
          p.original !== null && changedFieldNames(draftOfLoaded(freshEntry.def), p.original).length > 0
        if (!changedExternally) {
          kept.push(p)
          continue
        }
        const proceed = await ui.confirm({
          title: `"${p.id}" changed on the server`,
          message: `The entry you are deleting changed on the server since the editor opened. Deleting now discards those external changes too. Delete anyway, or drop this delete draft (it stays pending for re-review)?`,
          label: { confirm: "Delete anyway", cancel: "Drop draft" },
        })
        if (proceed === undefined) return cancelRebase() // no answer — the whole rebase cancels
        if (proceed === true) kept.push(p)
        else {
          dropped++
          droppedNotes.push(`Dropped the delete draft for "${p.id}" — re-review it against the fresh values.`)
        }
        continue
      }
      // update — rebase field-wise against the fresh definition.
      const freshEntry = freshEntryOf(p.kind, p.id)
      if (freshEntry === undefined) {
        const keep = await ui.confirm({
          title: `"${p.id}" is gone from the fresh document`,
          message: `The entry you edited no longer exists in the fresh server document — saving the edit would be refused. Keep the draft or drop it?`,
          label: { confirm: "Keep draft", cancel: "Drop draft" },
        })
        if (keep === undefined) return cancelRebase() // no answer — the whole rebase cancels
        if (keep === true) kept.push(p)
        else {
          dropped++
          droppedNotes.push(`Dropped the edit draft for "${p.id}" — the entry vanished server-side.`)
        }
        continue
      }
      const rebase = rebaseUpdateDraft(p, freshEntry.def)
      if (rebase.conflicts.length === 0) {
        // Silent rebase — but count drafts whose untouched fields actually
        // adopted an external change, for the honest summary.
        if (changedFieldNames(rebase.rebased, p.draft).length > 0) adopted++
        p.draft = rebase.rebased
        // Base advance: the next diff starts from what the server holds
        // NOW — an adopted external value can never re-enter the touched
        // set as a user edit (consecutive UNKNOWNs stay conflict-free).
        p.original = draftOfLoaded(freshEntry.def)
        kept.push(p)
        continue
      }
      const keep = await ui.confirm({
        title: `"${p.id}": the server changed fields you also edited`,
        message: `Externally changed on the server: ${rebase.conflicts.map(groupLabel).join(", ")}. Your edits touch the same part(s). Keep YOUR values for them (every part you did not touch adopts the fresh value; the Auto/Pinned pair moves as one unit) or drop this draft?`,
        label: { confirm: "Keep my edits", cancel: "Drop draft" },
      })
      if (keep === undefined) return cancelRebase() // no answer — the whole rebase cancels
      if (keep === true) {
        p.draft = rebase.rebased
        p.original = draftOfLoaded(freshEntry.def) // base advance (see above)
        kept.push(p)
      } else {
        dropped++
        droppedNotes.push(`Dropped the edit draft for "${p.id}" — re-edit it against the fresh values.`)
      }
    }
    // EVERY draft resolved explicitly — publish the whole batch at once
    // (no partial mutation ever escaped the copies above).
    state.pending = kept
    // ONLY NOW are drops announced — the publish made them real. A cancelled
    // rebase never reached this point, so no stale "Dropped…" claim survives
    // an Esc. ONE summary toast (reviewer P2: N per-drop toasts stacked over
    // the total announce the same thing N+1 times); the per-item detail is
    // PERSISTED under "Last save attempt detail" for on-demand review.
    if (dropped > 0 || adopted > 0) {
      state.lastSaveDetail = {
        title: `Last rebase — ${kept.length} kept, ${dropped} dropped`,
        lines: [...droppedNotes, `kept: ${kept.length} (${adopted} adopted external changes into untouched fields)`],
      }
      inform(`Drafts rebased onto the fresh document: ${kept.length} kept (${adopted} adopted external changes into untouched fields), ${dropped} dropped — per-item detail under "Last save attempt detail".`, "info")
    }
  }

  // ONE recovery discipline for EVERY connection-crossed await boundary:
  // after a voided in-flight operation, the recovery tail is always the
  // same — a FRESH open and, when pending drafts exist, a rebase onto it.
  // Every void path ends here so no site forgets the rebase half; the
  // per-pending baselines survive even a FAILED open (state.doc === null),
  // and the NEXT successful open still rebases. The return DISCRIMINATES
  // (reviewer P2): an Esc-cancelled rebase is a USER cancellation — never
  // worded as "refresh failed"; a failed open is the only failure. With
  // quietOpenFailure the open's own error toast is suppressed and the
  // verbatim cause stays in lastOpenFailureLine for the caller to fold
  // into its single verdict toast.
  async function freshOpenAndRebase(opts?: { quietOpenFailure?: boolean; quietRebaseCancel?: boolean }): Promise<"ok" | "open-failed" | "rebase-cancelled"> {
    lastOpenFailureLine = null
    const opened = await openDocument(state.view, { quietFailure: opts?.quietOpenFailure === true })
    if (!opened) return "open-failed"
    if (state.pending.length > 0) {
      await rebaseDraftsOnFreshDocument({ silentCancel: opts?.quietRebaseCancel === true })
      // The rebase can CANCEL ITSELF on Esc — which releases state.doc.
      // That is not an open failure: the fresh document WAS bound; the
      // user just declined to resolve the rebase. Callers word the two
      // differently (a "refresh failed" claim here would be false).
      if (state.doc === null) return "rebase-cancelled"
    }
    return "ok"
  }

  // ------------------------------------------------------------------
  // Bounded registry readiness (GET-only; probe evidence
  // getplugin-activation-0360-run1.log — the forge row activates
  // asynchronously, so an early echo answers 400 rpc.unavailable).
  // Polls plugin.list at the EXACT bound location until active-observed:
  // absent rows wait within the budget, failed rows refuse immediately
  // (never pass), timeout/throw fail closed. The OVERALL deadline covers
  // each request too — the list call is raced against the REMAINING
  // budget, so a hung request cannot stretch the bound, and a late
  // resolution of a timed-out request is the race loser: it is never
  // consumed and never opens or writes anything. Echo is never retried
  // here; no session is created; no default directory is guessed.
  // ------------------------------------------------------------------
  const READINESS_DEADLINE_MS = 10000
  const READINESS_POLL_MS = 500
  const defaultSleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      const timer: ReturnType<typeof setTimeout> = setTimeout(() => resolve(), ms)
      if (typeof timer === "object" && timer !== null && typeof (timer as { unref?: unknown }).unref === "function") (timer as { unref(): void }).unref()
    })
  // Real default for the EditorDeps.schedule seam: one-shot setTimeout with
  // an idempotent cancel (registryReadiness's finally ALWAYS invokes it, so
  // the total-deadline timer can never outlive the readiness window).
  const defaultSchedule = (ms: number, callback: () => void): (() => void) => {
    let settled = false
    const timer: ReturnType<typeof setTimeout> = setTimeout(() => {
      settled = true
      callback()
    }, ms)
    if (typeof timer === "object" && timer !== null && typeof (timer as { unref?: unknown }).unref === "function") (timer as { unref(): void }).unref()
    return () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
    }
  }
  async function registryReadiness(anchor: string): Promise<boolean> {
    // Monotonic real default (performance.now) — Date.now() can jump under
    // NTP adjustment and corrupt the budget math; an injected now stays fake.
    const nowMs = deps.now ?? (() => performance.now())
    const sleep = deps.sleep ?? defaultSleep
    const schedule = deps.schedule ?? defaultSchedule
    const deadlineAt = nowMs() + READINESS_DEADLINE_MS
    // ONE cancellable total-deadline timer for the whole readiness window —
    // ALWAYS cleared in the finally below (never a settle-null pretense).
    const gate: { cancel: (() => void) | null } = { cancel: null }
    let timedOut = false
    const deadlineGate = new Promise<never>((_, reject) => {
      gate.cancel = schedule(READINESS_DEADLINE_MS, () => {
        timedOut = true
        reject(new Error(`registry readiness exceeded its ${READINESS_DEADLINE_MS}ms budget`))
      })
    })
    deadlineGate.catch(() => {}) // the race below consumes the rejection; the bare gate must never surface unhandled
    try {
      for (;;) {
        // Budget BEFORE any verdict — even an active row cannot pass an
        // expired budget.
        if (timedOut || nowMs() >= deadlineAt) {
          inform(`The forge plugin row did not become active at the bound location within ${READINESS_DEADLINE_MS}ms — the editor stays closed: zero reads, zero writes, zero syncs. Reopen /forge-config once the server Forge is active.`, "error")
          return false
        }
        let enablement
        try {
          const res = await Promise.race([deps.client.plugin.list({ location: { directory: anchor } }), deadlineGate])
          enablement = enablementOf(res?.data, deps.pluginId ?? "forge")
        } catch (err) {
          inform(`The registry readiness probe failed — the editor stays closed: zero reads, zero writes, zero syncs (${errorText(err)}). Reopen /forge-config once the server Forge is active.`, "error")
          return false
        }
        if (enablement.state === "active-observed") {
          if (timedOut || nowMs() >= deadlineAt) {
            inform(`The forge plugin row did not become active at the bound location within ${READINESS_DEADLINE_MS}ms — the editor stays closed: zero reads, zero writes, zero syncs. Reopen /forge-config once the server Forge is active.`, "error")
            return false
          }
          return true
        }
        if (enablement.state === "failed") {
          inform(`The server Forge row reports FAILED — the editor stays closed: zero reads, zero writes, zero syncs (${JSON.stringify(enablement)}). Reopen /forge-config once the server Forge is active.`, "error")
          return false
        }
        // absent / unverifiable: keep waiting, the poll sleep is CLAMPED to
        // the remaining budget and RACED against the total deadline (a
        // timeout mid-sleep wakes immediately instead of after the lap).
        // ANY race rejection — the deadline firing or the sleeper itself
        // rejecting — is DISCLOSED via safeErrorText and refuses
        // (fail-closed; never swallowed into another polling lap).
        const wait = Math.max(0, Math.min(READINESS_POLL_MS, deadlineAt - nowMs()))
        try {
          await Promise.race([sleep(wait), deadlineGate])
        } catch (err) {
          inform(`The registry readiness window ended mid-poll — the editor stays closed: zero reads, zero writes, zero syncs (${errorText(err)}). Reopen /forge-config once the server Forge is active.`, "error")
          return false
        }
      }
    } finally {
      gate.cancel?.()
    }
  }

  // ------------------------------------------------------------------
  // Independent sync legs — the frozen one-method/two-action sync protocol
  //
  // prepare (confirm:false, no token) is PURE READ against the CURRENT
  // recipe bytes and returns the projection preview (scope, path, family,
  // files, coverage:"full"); apply (confirm exactly true + token) executes
  // it ONLY after an explicit human confirmation of THAT preview AND a
  // FRESH session re-verification between the confirm and the apply (review
  // item 1: a session→home migration while the preview is on screen must
  // never apply under the stale sessionID — the prepared token is dropped,
  // nothing is written). The saved patch is never replayed, recipe
  // prepare/commit is never invoked here, and commitId attaches the result
  // to the original save receipt. The sync preview carries NO
  // targetIdentity field of its own — the SAVED receipt's server-issued
  // identity is disclosed verbatim when one exists (never a locally
  // fabricated id; the server re-verifies the binding at apply).
  // appliedStatus is reported VERBATIM: without a proven native-registry
  // observation it stays "unconfirmed" — real applied confirmation requires
  // E2E evidence.
  // ------------------------------------------------------------------

  // UX round point 5 + coordinator ruling: the sync result is rendered in
  // TWO forms — `short` (counts + risk flags for the toast) and `lines`
  // (the COMPLETE outcome: every error, conflict, note and finding, NO
  // slice anywhere) recorded whole in state.lastSyncResult for the
  // on-demand detail view. Unconfirmed/unknown outcomes stay traceable.
  function renderSyncApply(app: SyncApplyOk): { okStatus: boolean; short: string[]; lines: string[] } {
    const lines: string[] = []
    lines.push(`sync: ${app.outcome}`)
    lines.push(`file: ${app.path}`)
    const roster = (label: string, refs: SyncApplyOk["created"]): string =>
      `${label}: ${refs.length > 0 ? refs.map((r) => r.nativeId).join(", ") : "(none)"}`
    lines.push(roster("created", app.created))
    lines.push(roster("updated", app.updated))
    lines.push(`unchanged: ${app.unchanged.length > 0 ? app.unchanged.join(", ") : "(none)"}`)
    lines.push(`gced: ${app.gced.length > 0 ? app.gced.join(", ") : "(none)"}`)
    lines.push(`removedIds: ${app.removedIds.length > 0 ? app.removedIds.join(", ") : "(none)"}`)
    for (const e of app.errors) lines.push(`error: ${e.message}${e.nativeId !== undefined ? ` (${e.nativeId})` : ""}`)
    for (const c of app.conflicts) lines.push(`conflict: ${c.message}${c.winnerFile !== undefined ? ` (winner: ${c.winnerFile})` : ""}`)
    lines.push(...app.summary.map((t) => `note: ${t}`))
    lines.push(...app.findings.map((f) => `${f.level}: ${f.message}`))
    // appliedStatus is the ONLY applied verdict surface — reported verbatim;
    // unconfirmed (no proven registry observation) is never upgraded.
    const st = app.appliedStatus
    const observedBy = st.observedBy !== null && st.observedBy !== "" ? st.observedBy : "no proven native-registry observation"
    lines.push(`application: ${st.status} (observed by: ${observedBy})`)
    if (st.confirmedIds.length > 0) lines.push(`confirmed ids: ${st.confirmedIds.join(", ")}`)
    if (st.unconfirmedIds.length > 0) lines.push(`unconfirmed ids: ${st.unconfirmedIds.join(", ")}`)
    if (st.removedConfirmedIds.length > 0) lines.push(`removals confirmed: ${st.removedConfirmedIds.join(", ")}`)
    if (app.outcome === "unconfirmed" || app.outcome === "conflict") {
      lines.push("The saved recipe is kept; the explicit host-wide /forge sync remains the separate reconciliation path when disclosed.")
    }
    // Short form: outcome + counts + risk flags (never the full listing).
    const okStatus = app.outcome === "applied" && app.applied === true
    const short: string[] = [
      `sync: ${app.outcome} — created ${app.created.length}, updated ${app.updated.length}, unchanged ${app.unchanged.length}, removed ${app.removedIds.length}${app.gced.length > 0 ? `, gc ${app.gced.length}` : ""}`,
      `application: ${st.status}${st.confirmedIds.length > 0 ? ` (${st.confirmedIds.length} confirmed)` : ""}`,
    ]
    if (app.errors.length > 0) short.push(`RISK: ${app.errors.length} error(s)`)
    if (app.conflicts.length > 0) short.push(`RISK: ${app.conflicts.length} conflict(s)`)
    if (st.unconfirmedIds.length > 0) short.push(`RISK: ${st.unconfirmedIds.length} unconfirmed id(s)`)
    if (!okStatus && app.outcome !== "noop") short.push("retry available under 'Retry sync (saved recipe)'")
    return { okStatus, short, lines }
  }

  // The full sync outcome of ANY terminal state is recorded whole for the
  // on-demand "Last sync result" view (failures/unconfirmed/unknown never
  // vanish into a short toast — UX round point 5).
  function recordSyncResult(title: string, ok: boolean, lines: string[]): void {
    state.lastSyncResult = { title, ok, lines }
  }

  // Shared failure/cancel tail for the sync legs: flags + full-trace
  // record + disclosure (the cause stays visible verbatim — never
  // flattened into a bare count).
  function syncFail(lines: string[], variant: "error" | "warning" | "info" = "error"): void {
    state.lastSaveFailed = true
    state.pendingSyncOutstanding = true
    recordSyncResult(`Sync ${variant === "info" ? "cancelled" : variant === "warning" ? "outcome unknown/unconfirmed" : "failed/refused"}`, false, lines)
    inform(lines.join("\n"), variant, "Forge: Sync receipt")
  }

  // The two sync legs against an EXPLICIT target scope (the saved receipt's
  // scope — never "whatever view is open"). Interactive throughout: the
  // preview confirmation is a real dialog, every refusal keeps the retry
  // entry (lastSaveFailed stays true). BOTH legs carry the SAVED receipt's
  // commitId — prepare so the server binds the pre-save baseline, apply
  // keeping the SAME value (a prepare/apply mismatch is refused
  // server-side); the retry still reads the CURRENT recipe bytes (the old
  // patch is never replayed, zero recipe writes). A missing original
  // context refuses — a context-free sync is never fabricated here (that is
  // the separate host-wide /forge path).
  async function runSyncLegs(scope: Scope, commitId: string, refusedFromSave: { kind: "worker" | "override"; id: string }[] = []): Promise<void> {
    // Reviewer P2: the saved batch's REFUSED entries stay visible in EVERY
    // terminal state of the sync legs — on the first-sync path their save
    // toast was deliberately skipped, so a noop/failure/cancel ending is
    // where the count must still surface. ONE wrapper appends the note.
    // Reviewer P2 (round 3, item 4): the note is RECONCILED by identity —
    // "remain pending" is only claimed for refused drafts still in
    // state.pending (the rebase may have dropped some); dropped ones are
    // said so, never implied pending.
    const refusedTotal = refusedFromSave.length
    // Reconciled at DISCLOSURE time, never snapped at entry: the legs'
    // awaits cross rebase-capable boundaries, and a mid-flight rebase can
    // drop refused drafts (a pre-awaited count would call them pending).
    const refusedNoteNow = (): string =>
      refusedAccountLine(
        refusedTotal,
        state.pending.filter((p) => refusedFromSave.some((r) => r.kind === p.kind && r.id === p.id)).length,
      ) ?? ""
    const failSync = (lines: string[], variant: "error" | "warning" | "info" = "error"): void => {
      syncFail(refusedTotal > 0 ? [...lines, refusedNoteNow()] : lines, variant)
    }
    if (commitId === "") {
      failSync(["Sync refused — no saved receipt commit to bind (the TUI sync always binds the original save receipt's commitId)."])
      return
    }
    // Prepare restates the CURRENT scope/sessionID — verify before the read
    // so even the pure-read leg never runs on a stale session.
    const preCheck = await reverifySession()
    if (!preCheck.ok) {
      failSync([`Sync refused — ${preCheck.message}`])
      return
    }
    // Leg 1 — prepare: pure read against the CURRENT recipe bytes
    // (confirm:false, no token) with the saved receipt binding. The
    // revision this prepare was built against is captured — a connection
    // event between the confirm and the apply voids the sync token.
    const revisionAtPrepare = connectionRevision
    let prep: SyncOutput
    try {
      prep = await rpc.sync({ scope, sessionID: state.sessionID, confirm: false, action: "prepare", commitId })
    } catch (err) {
      failSync([`Sync prepare failed (RPC transport: ${errorText(err)}) — the saved recipe is untouched; retry later.`])
      return
    }
    if (prep.ok !== true) {
      failSync([`Sync prepare refused (${prep.reason}): ${prep.message}`, "The saved recipe is kept; nothing was written."])
      return
    }
    if (prep.action !== "prepare") {
      // A prepare request must never draw an apply-shaped answer — honest
      // guard, not a compatibility shim.
      failSync(["Sync prepare received an apply-shaped answer — projection state UNKNOWN.", "Retry sync to prepare against current content."], "warning")
      return
    }
    if (prep.outcome === "noop") {
      state.lastSaveFailed = false
      state.pendingSyncOutstanding = false // nothing left to sync
      // Reviewer P2: the noop record is WHOLE — every unchanged projection
      // file, server note and finding stays traceable under "Last sync
      // result"; the toast is the short calm form. The wording names the
      // distinction a bare "zero writes" hides: the recipe WAS saved; only
      // the projection leg found nothing to do. Findings from the envelope
      // and the preview are DEDUPED (the same finding on both levels is
      // counted once), and the saved batch's REFUSED entries stay named
      // here — their save toast was skipped on the first-sync path.
      const noopFindings = dedupeFindings([...prep.findings, ...prep.preview.findings])
      const lines = [
        "The recipe itself WAS saved (commit bound) — the native projection already matches it, so this sync leg made ZERO WRITES.",
        ...prep.preview.files.map((f) => `file: ${f.op} ${f.nativeId} → ${f.dest}`),
        ...prep.preview.summary.map((t) => `note: ${t}`),
        ...noopFindings.map((f) => `${f.level}: ${f.message}`),
        ...(refusedTotal > 0 ? [refusedNoteNow()] : []),
      ]
      recordSyncResult("Sync prepare: the projection already matches (noop)", true, lines)
      inform(
        [
          "The native projection already matches the saved recipe — nothing to sync (zero writes). The recipe itself was saved.",
          `${prep.preview.files.length} projection file(s) unchanged${noopFindings.length > 0 ? `, RISK: ${noopFindings.length} finding(s)` : ""} — full detail under "Last sync result".`,
          ...(refusedTotal > 0 ? [refusedNoteNow()] : []),
        ].join("\n"),
        "info",
      )
      return
    }
    const preview = prep.preview
    const tokenValue = prep.token.token
    // Explicit human confirmation over the projection preview (the SECOND
    // confirm of the first-sync path; the ONLY confirm of the retry path).
    // UX round point 5: CHANGED projection files lead, unchanged files are
    // a count, and GC rows share the SAME paged review — a pure-GC preview
    // (no changed files, many stale generated files) is paged too, never a
    // bare count. More than 10 rows are reviewed IN FULL before the confirm
    // choice exists — nothing hidden, nothing truncated.
    const changed = preview.files.filter((f) => f.op !== "unchanged")
    const unchangedCount = preview.files.length - changed.length
    // Reviewer P2: the server's summary notes ride the SAME paged review as
    // the file/gc rows — once paged through they are NOT re-poured into the
    // confirm (a per-file note would then appear twice). In the small
    // (unpaged) case they stay in the confirm message, still exactly once.
    const reviewRows = [
      ...changed.map((f) => ({ action: f.op, kind: "projection file", id: f.nativeId, summary: [`→ ${f.dest}`] })),
      ...preview.gc.map((g) => ({ action: "gc", kind: "generated file", id: g.nativeId, summary: [`remove ${g.dest}`] })),
      ...preview.summary.map((t) => ({ action: "note", kind: "server summary", id: "", summary: [t] })),
    ]
    let pagedThrough = false
    if (reviewRows.length > 10) {
      const verdict = await pagedEntryBrowser(
        reviewRows,
        "Sync projection preview — changed files & garbage collection",
        `All ${reviewRows.length} preview row(s) reviewed — go to confirmation`,
      )
      if (verdict !== "confirm") {
        failSync(["Cancelled — the prepared sync was dropped; nothing was written. 'Retry sync (saved recipe)' prepares fresh against the current recipe."], "info")
        return
      }
      pagedThrough = true
    }
    const savedIdentity = state.savedReceipt?.targetIdentity
    const go = await ui.confirm({
      title: "Apply the native projection for this family?",
      message: [
        `File: ${preview.path}`,
        `Scope: ${preview.scope === "global" ? "global (machine-wide)" : `workspace (sessionID ${preview.sessionID ?? "null"})`}`,
        `Observed location: ${preview.observedLocation ?? "(none)"} · anchor: ${preview.anchor ?? "(none)"}`,
        // The save itself ALREADY HAPPENED before this dialog (first-sync
        // path): the saved context — including any REFUSED entries, whose
        // save toast was deliberately skipped so it would not stack over
        // this dialog — is disclosed here, so the confirmation carries the
        // full picture without a preceding stacked toast.
        ...(state.savedReceipt !== null ? [`already SAVED: ${state.savedReceipt.path} (commit ${state.savedReceipt.commitId.slice(0, 8)})${refusedTotal > 0 ? ` — ${refusedNoteNow()}` : ""} — this confirmation covers ONLY the generated native projection`] : []),
        ...(savedIdentity !== undefined ? [`Saved target identity (server-issued at save; re-verified by the server at apply): ${savedIdentity}`] : []),
        ...(preview.family !== null ? [`Family: ${preview.family.ns} (${preview.family.file}) · ${preview.family.materializedIds.length} materialized id(s) — full roster in the sync result`] : []),
        `Overrides included: ${preview.overridesIncluded ? "yes (global family)" : "no"} · coverage: ${preview.coverage}`,
        ...(pagedThrough
          ? [`All ${reviewRows.length} preview row(s) (${changed.length} changed, ${preview.gc.length} gc, ${preview.summary.length} server note(s)) were reviewed page-by-page above.`]
          : [...changed.slice(0, 10).map((f) => `• ${f.op} ${f.nativeId} → ${f.dest}`), ...preview.summary.map((t) => `note: ${t}`)]),
        ...(unchangedCount > 0 ? [`unchanged: ${unchangedCount} projection file(s) — listed in full in the sync result`] : []),
        ...(preview.gc.length > 0 ? [`gc: ${preview.gc.length} stale generated file(s) will be garbage-collected`] : []),
        ...preview.findings.map((f) => `${f.level}: ${f.message}`),
        "This writes GENERATED projection files on the CONNECTED SERVER's filesystem. The previously saved patch is never replayed.",
      ].join("\n"),
      label: { confirm: "Apply sync", cancel: "Cancel" },
    })
    if (go !== true) {
      // Cancel keeps the retry entry (the saved recipe's sync debt is
      // real); the full trace is recorded for the on-demand view.
      failSync(["Cancelled — the prepared sync was dropped; nothing was written. 'Retry sync (saved recipe)' prepares fresh against the current recipe."], "info")
      return
    }
    // FRESH session re-verification AFTER the confirm and BEFORE the apply
    // (review item 1): the session may have moved while the preview was on
    // screen — a session→home migration refuses here (the prepared token is
    // dropped, nothing is applied under the stale sessionID).
    const applyCheck = await reverifySession()
    if (!applyCheck.ok) {
      failSync([`Sync apply refused — ${applyCheck.message}`, "The prepared sync was dropped; nothing was written."])
      return
    }
    // Review P1(1): a connection event while the sync preview was open
    // voids the prepared sync token — retry prepares fresh, nothing applies.
    if (connectionRevision !== revisionAtPrepare) {
      failSync([`The server connection changed while the sync preview was open (revision ${connectionRevision}) — the prepared sync token is VOID; nothing was applied. Retry sync prepares fresh.`], "error")
      return
    }
    // Leg 2 — apply: the confirmed token; commitId attaches the result to
    // the original save receipt when one exists.
    let app: SyncOutput
    try {
      app = await rpc.sync({ scope, sessionID: state.sessionID, confirm: true, action: "apply", token: tokenValue, commitId })
    } catch (err) {
      // The apply await is itself a boundary: an event during it leaves the
      // outcome UNKNOWN/unconfirmed — never worded as a plain transport
      // failure (the token's spent-state is not guessed); the SAVED
      // receipt's target retry stays armed and the retry prepares FRESH.
      if (connectionRevision !== revisionAtPrepare) {
        failSync([`The server connection changed while the sync apply was in flight (revision ${connectionRevision}) — the apply outcome is UNKNOWN/unconfirmed: the old result is not consumed and the token's spent-state is not guessed.`, "'Retry sync (saved recipe)' prepares FRESH (new prepare → preview → your explicit confirmation) against the saved receipt's target."], "warning")
        return
      }
      failSync([`Sync apply failed (RPC transport: ${errorText(err)}) — the saved recipe is untouched; the prepared sync was consumed, retry prepares fresh.`])
      return
    }
    // Resolved-path twin: a connection-crossed apply is never trusted as
    // "applied" (that would silently hide the retry) — the returned outcome
    // is not consumed; UNKNOWN/unconfirmed is disclosed and the saved
    // target's retry stays armed for a FRESH prepare/confirm cycle.
    if (connectionRevision !== revisionAtPrepare) {
      failSync([`The server connection changed while the sync apply was in flight (revision ${connectionRevision}) — the returned apply outcome is treated as UNKNOWN/unconfirmed: not consumed, not worded as applied.`, "'Retry sync (saved recipe)' prepares FRESH (new prepare → preview → your explicit confirmation) against the saved receipt's target."], "warning")
      return
    }
    if (app.ok !== true) {
      failSync([`Sync apply refused (${app.reason}): ${app.message}`, "The saved recipe is kept."])
      return
    }
    if (app.action !== "apply") {
      failSync(["Sync apply received a prepare-shaped answer — projection state UNKNOWN.", "Retry sync to re-prepare against current content."], "warning")
      return
    }
    const verdict = renderSyncApply(app)
    // A direct-apply noop is a CLEAN terminal state: nothing needed doing,
    // so neither the retry hint nor the retry entry is armed for it, and
    // the recorded outcome is a NORMAL end — independent of `applied`
    // (reviewer P2: ok=false would mislabel the list entry
    // "FAILED/UNCONFIRMED" for a sync that simply had nothing to do; the
    // wording still never claims "applied").
    const noop = app.outcome === "noop"
    state.lastSaveFailed = !verdict.okStatus && !noop
    state.pendingSyncOutstanding = !verdict.okStatus && !noop
    const finalLines = refusedTotal > 0 ? [...verdict.lines, refusedNoteNow()] : verdict.lines
    const finalShort = refusedTotal > 0 ? [...verdict.short, refusedNoteNow()] : verdict.short
    recordSyncResult(`Sync result — ${app.outcome}${noop ? " (nothing to do — clean end)" : ""}`, verdict.okStatus || noop, finalLines)
    inform(finalShort.join("\n"), verdict.okStatus || noop ? "success" : "warning", "Forge: Sync receipt")
  }

  // Retry is BOUND to the saved target (review item 2): it runs only
  // against the saved receipt's scope + server-issued identity. A different
  // current view is never silently substituted — the flow offers an
  // explicit switch back to the saved target and performs ZERO sync RPCs
  // until the user is on it.
  async function syncRetryFlow(): Promise<void> {
    const saved = state.savedReceipt
    if (saved === null) {
      inform("No saved recipe receipt — run Save & Sync first (sync retry never invents a target).", "error")
      return
    }
    const doc = state.doc
    const bound = state.view === saved.scope && doc !== null && doc.scope === saved.scope && doc.targetIdentity === saved.targetIdentity
    if (!bound) {
      const go = await ui.confirm({
        title: "Sync retry is bound to the saved target",
        message: `The open view is not the saved receipt's target. The saved target is the ${saved.scope === "global" ? "Global view" : "Workspace view"} (${saved.path}, identity ${saved.targetIdentity}). Nothing will be synced from this view — switch to the saved target now?`,
        label: { confirm: "Switch to saved target", cancel: "Stay" },
      })
      if (go === true) {
        // A DIFFERENT view is a real scope switch: discard guard + the
        // query/selection clear (spec ruling; drafts are dropped by the
        // guard, so a plain open needs no rebase). A SAME-scope recovery
        // (the view is already the saved target but its document is
        // null/stale) goes through the SHARED fresh-open discipline: any
        // surviving pending drafts are REBASED onto the fresh snapshot —
        // never a new snapshot paired with old drafts (the same P1 as the
        // receipt refresh); the user's query and selection survive.
        if (state.view === saved.scope) {
          await freshOpenAndRebase()
          state.view = saved.scope
        } else if (await guardPendingOnSwitch()) {
          const opened = await openDocument(saved.scope)
          if (opened) {
            state.view = saved.scope
            state.listQuery = "" // real scope switch clears query + selection (spec ruling)
            state.listCurrent = null
          }
        }
      }
      return // zero sync RPCs off the saved target — never a substituted view
    }
    await runSyncLegs(saved.scope, saved.commitId)
  }

  // Defensive reader for the reserved sync slot — against the REAL server
  // annotation shape (config-rpc-sync attachSyncOutcome: action/outcome/
  // applied/path/created/updated/gced/conflicts/appliedStatus/at). The
  // TRUE outcome/applied/appliedStatus are reported verbatim — never a
  // guessed "ok/status" the report does not carry; an unrecognized shape
  // is disclosed verbatim instead of being invented into a verdict.
  function summarizeSync(report: Record<string, unknown> | null | undefined): { ok: boolean; lines: string[] } | null {
    if (report === null || report === undefined) return null
    if (typeof report !== "object") return null
    const rec = report as Record<string, unknown>
    if (typeof rec.outcome !== "string") {
      // Unrecognized payload — disclose honestly, fail the flag (never
      // invent an ok verdict from a shape the server did not send).
      return { ok: false, lines: [`sync report (unrecognized shape): ${JSON.stringify(report).slice(0, 300)}`] }
    }
    const lines: string[] = []
    lines.push(`sync: ${rec.outcome}`)
    if (typeof rec.path === "string") lines.push(`file: ${rec.path}`)
    const idList = (v: unknown): string =>
      Array.isArray(v)
        ? v
            .map((r) => (r !== null && typeof r === "object" && typeof (r as Record<string, unknown>).nativeId === "string" ? ((r as Record<string, unknown>).nativeId as string) : "?"))
            .join(", ")
        : ""
    // created/updated are {nativeId,...} refs; gced is a REAL string[] —
    // each renders in its own shape (never "?" from a shared reader).
    for (const [label, v] of [["created", rec.created], ["updated", rec.updated]] as const) {
      if (Array.isArray(v)) lines.push(`${label}: ${v.length > 0 ? idList(v) : "(none)"}`)
    }
    if (Array.isArray(rec.gced)) lines.push(`gced: ${(rec.gced as string[]).length > 0 ? (rec.gced as string[]).join(", ") : "(none)"}`)
    if (Array.isArray(rec.conflicts)) {
      for (const c of rec.conflicts) {
        if (c !== null && typeof c === "object") {
          const m = (c as Record<string, unknown>).message
          const w = (c as Record<string, unknown>).winnerFile
          lines.push(`conflict: ${typeof m === "string" ? m : "(unrecognized conflict entry)"}${typeof w === "string" ? ` (winner: ${w})` : ""}`)
        }
      }
    }
    // appliedStatus — the ONLY applied verdict surface, verbatim.
    const st = rec.appliedStatus
    if (st !== null && typeof st === "object") {
      const s = st as Record<string, unknown>
      if (typeof s.status === "string") lines.push(`application: ${s.status}`)
      const observedBy = typeof s.observedBy === "string" && s.observedBy !== "" ? s.observedBy : "no proven native-registry observation"
      lines.push(`observed by: ${observedBy}`)
      if (Array.isArray(s.confirmedIds) && s.confirmedIds.length > 0) lines.push(`confirmed ids: ${(s.confirmedIds as unknown[]).filter((i): i is string => typeof i === "string").join(", ")}`)
      if (Array.isArray(s.unconfirmedIds) && s.unconfirmedIds.length > 0) lines.push(`unconfirmed ids: ${s.unconfirmedIds.join(", ")}`)
      if (Array.isArray(s.removedConfirmedIds) && s.removedConfirmedIds.length > 0) lines.push(`removals confirmed: ${s.removedConfirmedIds.join(", ")}`)
    } else if (rec.applied === true) {
      lines.push("application: applied")
    } else if (rec.applied === false) {
      lines.push("application: unconfirmed")
    }
    // Extension string arrays (defensive; the base envelope is frozen,
    // extension fields are not) — recorded WHOLE, no slice.
    const textLabels: Record<string, string> = { summary: "note", errors: "error", warnings: "warning", notes: "note" }
    for (const [key, label] of Object.entries(textLabels)) {
      const v = rec[key]
      if (Array.isArray(v)) {
        const texts = v.filter((t): t is string => typeof t === "string")
        if (texts.length > 0) lines.push(...texts.map((t) => `${label}: ${t}`))
      }
    }
    // The honest flag: applied only on outcome "applied" AND applied true;
    // noop is a clean "nothing to do"; everything else keeps the retry.
    const ok = rec.outcome === "applied" ? rec.applied === true : rec.outcome === "noop"
    return { ok, lines }
  }

  // ------------------------------------------------------------------
  // Entry point
  // ------------------------------------------------------------------

  return {
    async open(): Promise<void> {
      // Startup order (registry-activation fix; GET-only probe evidence
      // getplugin-activation-0360-run1.log: an echo fired BEFORE the forge
      // row activates answers 400 rpc.unavailable and fail-closes a healthy
      // transport). The transport is BOUND to deps.initialScope's anchor by
      // the wiring (runEditor refused anything without one); this sequence
      // is: bounded registry readiness (GET plugin.list only) → ONE echo
      // (never retried, never skipped) → scope re-checks at every await
      // boundary → editOpen. No session is created and no default directory
      // is ever guessed.
      const S0 = deps.initialScope
      // (The `|| S0.anchor === null` arm only NARROWS for the compiler — the
      // predicate already guarantees a non-blank anchor at runtime.)
      if (!anchorableStartupScope(S0) || S0.anchor === null) {
        inform("Wiring defect: no bound startup scope/location — the editor cannot open: zero reads, zero writes, zero syncs.", "error")
        return
      }
      state.sessionID = S0.sessionID
      state.anchorHint = S0.anchor
      const scopeUnchanged = async (): Promise<boolean> => {
        const sc = await currentSession()
        const same = sc.kind === S0.kind && sc.sessionID === S0.sessionID && sc.anchor === S0.anchor
        if (!same) {
          inform(`The scope changed while the editor was opening (bound ${S0.kind}/${S0.sessionID ?? "home"} @ ${S0.anchor ?? "no anchor"} → now ${sc.kind}/${sc.sessionID ?? "home"} @ ${sc.anchor ?? "no anchor"}) — this invocation is VOID; reopen /forge-config. Nothing was read or written.`, "warning")
        }
        return same
      }
      // Bounded registry readiness at the EXACT bound location.
      if (!(await registryReadiness(S0.anchor))) return // fail-closed, already disclosed
      if (!(await scopeUnchanged())) return
      // Transport provability (ONE echo — never retried, never skipped):
      // nonce round-trip against the shared definition.
      const nonce = randomUUID()
      let echo
      try {
        echo = echoVerdictOf(nonce, await rpc.echo({ nonce }))
      } catch (err) {
        inform(`The forge-config RPC transport is unprovable (echo failed: ${errorText(err)}) — the editor stays closed: zero reads, zero writes, zero syncs.`, "error")
        return
      }
      if (!echo.provable) {
        inform(`The forge-config RPC transport is unprovable (${echo.reason}) — the editor stays closed: zero reads, zero writes, zero syncs.`, "error")
        return
      }
      if (!(await scopeUnchanged())) return // editOpen stays closed on a scope change
      // (The former unbounded enablement plugin.list here is GONE — review
      // item 3: registryReadiness already holds the row and refuses unless
      // active-observed, so a second unbounded list duplicated it. The
      // loadCatalog→editOpen await boundary is covered by the openDocument
      // entry guard below, which re-verifies the strict bound scope before
      // editOpen.)
      await loadCatalog()
      if (!state.catalog.known) inform(state.catalog.findings.join(" · "), "warning")
      const opened = await openDocument("workspace") // entry guard: strict reverifySession before editOpen
      if (!opened) return
      // Review P1(1) (connection discipline): the revision increments
      // SYNCHRONOUSLY on the event and every prepare captured it — the
      // post-confirm commit/apply checks therefore void any preview/token
      // held across a connection event, INCLUDING a same-epoch one and the
      // sync token. There is deliberately NO "keep the old token" option:
      // the recovery is always a fresh open/prepare/confirm. Additionally
      // the re-echo compares epoch/generation against the open document —
      // a changed binding reopens it (drafts kept, then rebased).
      let unsubscribeConnected: (() => void) | null = null
      try {
        unsubscribeConnected = deps.data.on("server.connected", () => {
          connectionRevision++ // synchronous — voids in-flight previews/tokens
          state.token = null
          void (async () => {
            const nonce = randomUUID()
            let verdict
            try {
              verdict = echoVerdictOf(nonce, await rpc.echo({ nonce }))
            } catch {
              inform(`The server reconnected but the transport echo failed — the held preview/token is already void (revision ${connectionRevision}); use 'Reload from server' when the connection recovers. Drafts are kept.`, "warning")
              return
            }
            if (!verdict.provable) {
              inform(`The reconnected server is unprovable (${verdict.reason}) — the held preview/token is already void (revision ${connectionRevision}). Drafts are kept; nothing proceeds on an unprovable transport.`, "warning")
              return
            }
            const docEpoch = state.doc?.epoch
            const docGeneration = state.doc?.generation
            if (docEpoch !== undefined && (verdict.epoch !== docEpoch || (docGeneration !== undefined && verdict.generation !== docGeneration))) {
              await freshOpenAndRebase()
            }
            inform(`Server connection event (revision ${connectionRevision}): any held preview/token is VOID — the next Save & Sync prepares fresh and asks for a NEW confirmation.`, "warning")
          })()
        })
      } catch {
        // No live event surface: registration- and step-time checks remain.
      }
      try {
        await scopeList()
      } finally {
        if (unsubscribeConnected !== null) {
          try {
            unsubscribeConnected()
          } catch {
            /* already gone */
          }
        }
      }
},
  }
}

// The same finding can arrive at BOTH the sync envelope and the embedded
// preview — dedupe by full identity (level|code|message) so the risk count
// and the detail listing never inflate a duplicate (reviewer P2).
function dedupeFindings(findings: Finding[]): Finding[] {
  const seen = new Set<string>()
  return findings.filter((f) => {
    const key = `${f.level}|${f.code}|${f.message}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function sanitizeSuggestion(seed: string): string {
  const base = seed.split(/[\\/]/).filter(Boolean).pop() ?? "pool"
  return (
    base
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 24) || "pool"
  )
}

// One-line diff stat for the preview dialog (display-only — the server's
// previewHash binds the canonical content; this never adjudicates anything).
function diffSummary(before: string | null, after: string): string {
  const b = before ?? "(new file)"
  const bLines = b === "(new file)" ? [] : b.split("\n")
  const aLines = after.split("\n")
  const added = aLines.filter((l) => !bLines.includes(l)).length
  const removed = bLines.filter((l) => !aLines.includes(l)).length
  return `diff: ${added} line(s) added, ${removed} line(s) removed${b === "(new file)" ? " (file created)" : ""}`
}

// ---------------------------------------------------------------------------
// editOpen answer binding verdict (review matrix): a SUCCESS answer is only
// bindable when it names THIS request (scope + sessionID echo) and carries a
// target identity consistent with the BOUND startup scope. out.path is never
// compared here — an ancestor-owned pool file is a legal owner. Echo
// epoch/generation discipline is NOT touched (the existing rules stay).
// ---------------------------------------------------------------------------

// Directory identity folding by SHAPE, not process.platform: these
// directories come from a REMOTE server that may be Windows while this TUI
// runs on POSIX. A drive-letter (X:\ / X:/) or UNC (\\host\share,
// //host/share) prefix marks Windows identity — case and separators fold
// (the established foldPath habit: plugin.ts/config-rpc-* all share the same
// one-liner); everything else is POSIX identity and compares verbatim
// (case-sensitive). Mixed shapes never compare equal (fail-closed). Pure
// strings — no fs/path import, no realpath/symlink equivalence (never
// promised).
function foldDirIdentity(p: string): string {
  const windows = /^[a-zA-Z]:[\\/]/.test(p) || /^\\\\[^\\]/.test(p) || /^\/\/[^/]/.test(p)
  return windows ? p.replace(/\//g, "\\").toLowerCase() : p
}

function sameOptionalDir(a: string | null, b: string | null): boolean {
  // Only real strings ever reach foldDirIdentity — a malformed wire value
  // (undefined/number/garbage typed as string|null) compares unequal through
  // the same exactness path as null: fail closed, never throw.
  if (a === null || b === null || typeof a !== "string" || typeof b !== "string") return a === b
  return foldDirIdentity(a) === foldDirIdentity(b)
}

// Bounded disclosure for a directory value inside a refusal message: the
// established safeErrorText bound/mask, with an explicit "(absent)" for a
// missing/blank field (fail-closed rendering — never a raw "undefined").
function disclosedDir(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") return "(absent)"
  return errorText(value)
}

function editOpenBindingVerdictOf(
  request: { scope: Scope; sessionID: string | null },
  startup: { kind: string; anchor: string | null },
  out: EditOpenOk,
): { ok: true } | { ok: false; message: string } {
  if (out.scope !== request.scope) {
    // The wire scope value is untrusted: only a recognized literal is echoed
    // back in the message, anything else gets the fixed category (never a raw
    // interpolation of an arbitrary value).
    const named = out.scope === "workspace" || out.scope === "global" ? `scope ${out.scope}` : "an unrecognized scope"
    return { ok: false, message: `the answer names ${named}, not the requested ${request.scope}` }
  }
  if (out.sessionID !== request.sessionID) {
    return { ok: false, message: `the answer session binding (${out.sessionID === null ? "home" : "another session"}) does not match the requested one (${request.sessionID === null ? "home" : "this session"})` }
  }
  if (typeof out.observedLocation !== "string" || out.observedLocation.trim() === "") {
    // Missing/blank/non-string fails closed here — `.trim()` on a non-string
    // would throw out of the verdict instead of refusing.
    return { ok: false, message: "the answer carries no usable observed location (missing/blank/not a string) — the server cannot have observed this target" }
  }
  // Home-kind startup: the binding is exactly the home scope of the BOUND
  // startup location — a different observedLocation is a foreign binding even
  // when a global target path would look identical (the location is part of
  // the binding, never a wildcard).
  if (startup.kind === "home" && !sameOptionalDir(out.observedLocation, startup.anchor)) {
    return { ok: false, message: `the answer's observed location ${disclosedDir(out.observedLocation)} is not the bound startup location ${disclosedDir(startup.anchor)}` }
  }
  // session-kind startup: the SERVER's live anchor is authoritative over the
  // TUI's possibly-stale startup row (spec: the live session.moved record
  // wins), so the answer's observedLocation is only required to be a
  // non-blank live location (checked above) — equality with the startup
  // anchor is deliberately NOT demanded. A live-moved location never SILENTLY
  // re-binds the editor either: the strict local startup-triple re-verification
  // still gates every later decisive step (prepare/commit/sync).
  if (out.scope === "workspace") {
    if (!sameOptionalDir(out.anchor, out.observedLocation)) {
      return { ok: false, message: `the workspace answer's anchor ${disclosedDir(out.anchor)} does not match its observed location ${disclosedDir(out.observedLocation)}` }
    }
  } else if (out.anchor !== null) {
    return { ok: false, message: `the global answer carries an anchor ${disclosedDir(out.anchor)} — the global layer has no workspace anchor (expected null)` }
  }
  return { ok: true }
}
