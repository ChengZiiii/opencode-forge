// Host seam contracts for the TUI editor (change forge-tui-subagent-config,
// revised server-RPC contract — design D2/D4/D7/D8).
//
// Every host capability is an injectable interface here — the flow core in
// src/tui/flow.ts never imports the SDK. The root tui.ts wiring adapts the
// probe-proven runtime shapes (archive
// 2026-11-27-forge-tui-subagent-config-probes, host 2.4.2) into these seams.
//
// REVISED ARCHITECTURE (2026-11-27 revision, applied): the TUI drafts,
// dialogs and confirms — it never reads or writes a recipe path as a local
// file. The AUTHORITATIVE document, scope, exact owning path and
// server-issued target identity come from the server plugin through the
// official Plugin RPC (`ctx.client.rpc(forgeConfigRpcDefinition)`), whose
// wire types are imported from ../rpc.ts — the single shared definition.
// There is deliberately NO local fs seam, NO same-host gate, NO nonce
// channel and NO TUI-side second resolver left in these contracts.
//
// Probe-proven shapes behind each member:
//   ui.select     — ctx.ui.dialog.select({title, current?, options, actions?})
//                   → picked value | undefined (closed without pick)
//   ui.confirm    — ctx.ui.dialog.confirm({title, message, label?}) → boolean
//   ui.prompt     — ctx.ui.dialog.prompt({title, placeholder}) → string |
//                   undefined (falsy = cancelled or empty)
//   dialog sizing — each of select/confirm/prompt sizes its OWN just-opened
//                   dialog once via ctx.ui.dialog.set({size:"xlarge",
//                   centered:true}) — the ONLY 2.4.2 size control (SDK
//                   context.d.ts:278-342; no setSize, no size getter),
//                   applied synchronously after the dialog opens and before
//                   the promise is awaited (set targets the CURRENT active
//                   dialog; never a finally reset — that would resize other
//                   dialogs). A missing/throwing set degrades fail-soft to
//                   the usable default-size dialog with ONE short hint per
//                   editor session; the dialog promise's resolve/reject is
//                   never touched (a sizing failure never masks a dialog
//                   failure). The on-active visual effect is unverified
//                   (CUA input refused) — adapter-mock-tested only.
//   ui.toast      — ctx.ui.toast.show({title?, message, variant?, duration?})
//   ui.router     — ctx.ui.router.current() → {type:"home"|"session",
//                   sessionID?} (CLI binary-verified session-view shape)
//   client.plugin.list({location}) → { data: PluginRow[] }   (probe E6)
//   client.session.get({sessionID}) → SessionRow DIRECTLY (SDK-unwrapped;
//                   best-available record — may lag a session.moved)
//   client.command.list({location}) → { data: CommandRow[] } (opId
//                   command.list; the slash collision check)
//   client.rpc(definition) → per-method callables (probe REPORT §9.6/§9.7:
//                   nonce echo round-trip, unknown-method rejection, dispose
//                   → unavailable; SDK auto-wraps the HTTP {input} envelope)
//   data.location.provider|model .sync(location)/.list(location)
//                   → catalog rows (probe CATALOG)
//   data.on(eventType, handler) → unsubscribe (probe §9.1: real-TUI
//                   session.moved delivery; the command surface change
//                   notification rides "command.updated" — contract-documented
//                   event type in the 2.4.2 OpenAPI, real-world fire behavior
//                   is an E2E item)
//
// Fail-closed discipline: an absent client surface, an unbuildable RPC
// transport, or an unverifiable scope refuses everything (zero reads via
// RPC, zero writes, zero syncs) — never a substitute channel.

import type {
  CommitInput,
  CommitOutput,
  EchoInput,
  EchoOutput,
  EditOpenInput,
  EditOpenOutput,
  PrepareInput,
  PrepareOutput,
  ReceiptInput,
  ReceiptOutput,
  Scope,
  SyncInput,
  SyncOutput,
} from "../../rpc.ts"

export type { Scope }

export type SelectOption = {
  title: string
  value: string
  description?: string
  // Official 2.4.2 DialogSelectOption.footer (plain string, never JSX) —
  // the full per-row facts position (SDK context.d.ts:278-342, main-
  // controller Read); passed through to the host dialog verbatim. Visual
  // rendering is unverified while CUA input is refused — no visual claim.
  footer?: string
  category?: string
}

export type SelectAction = {
  bind: string
  title: string
  onTrigger: (value: string | undefined) => void | Promise<void>
}

export type HostUi = {
  select(input: {
    title: string
    current?: string
    options: SelectOption[]
    actions?: SelectAction[]
  }): Promise<string | undefined>
  confirm(input: { title: string; message: string; label?: { confirm?: string; cancel?: string } }): Promise<boolean | undefined>
  prompt(input: { title: string; placeholder?: string }): Promise<string | undefined>
  // ctx.ui.dialog.clear() (2.4.2 context.d.ts:337; binary probe: a footer
  // action does NOT close the dialog, clear() resolves the top dialog's
  // onClose synchronously). REQUIRED: the CtrlD delete action records its
  // target and clears the list, so the flow consumes the action right after
  // the select resolves — no nested confirm replacing the select, no extra
  // keypress. A host/wiring without it makes the action fall back to the
  // inline (nested) path — never a silently broken shortcut.
  clear(): void
  toast(input: { title?: string; message: string; variant?: "success" | "warning" | "error" | "info"; duration?: number }): void
  // Authoritative router view — the TUI's CURRENT view. `sessionID` is
  // present only for a session view; re-read at every decision point (the
  // user can move between home and sessions while the editor is open).
  router: { current(): RouterView | undefined }
}

export type RouterView = {
  type?: string
  sessionID?: string
}

export type HostLocation = { directory?: string; project?: { id?: string; directory?: string; canonical?: string } }

// /api/plugin row (probe P1/E6 shape; fields fail-soft optional).
export type PluginRow = {
  id?: string
  source?: { type?: string; path?: string }
  features?: { server?: boolean; tui?: boolean }
  state?: { status?: string; error?: unknown; ref?: unknown }
}

// /api/session/{sessionID} row subset (openapi Session.Info): the session
// record feeds the session-scope seam (record id validated against the
// router session; location.directory is the best-available anchor hint).
export type SessionRow = {
  id?: string
  projectID?: string
  location?: { directory?: string }
}

// /api/command row subset — the slash-name collision check.
export type CommandRow = {
  name?: string
  description?: string
}

export type HostClient = {
  plugin: { list(input: { location: HostLocation }): Promise<{ data?: PluginRow[] } | undefined> }
  // The session RECORD row directly (SDK-unwrapped envelope). Best-available
  // anchor source — may lag a session.moved (see SessionScope).
  session: { get(input: { sessionID: string }): Promise<SessionRow | undefined> }
  command: { list(input: { location: HostLocation }): Promise<{ data?: CommandRow[] } | undefined> }
  // Official Plugin RPC: `client.rpc(definition)` → per-method callables.
  // The wiring builds the typed transport from the SHARED definition object
  // (../rpc.ts); every member throws/absent → the transport refuses closed.
  rpc(definition: unknown): unknown
}

export type HostData = {
  location: {
    provider: {
      sync(location: HostLocation): Promise<unknown>
      list(location: HostLocation): unknown
    }
    model: {
      sync(location: HostLocation): Promise<unknown>
      list(location: HostLocation): unknown
    }
    default(): HostLocation
  }
  // Live-only event subscription (probe §9.1). Delivery is never
  // load-bearing for correctness — it only triggers a re-observation; the
  // next decisive read (registry / echo / editOpen) is the verdict.
  on(eventType: string, handler: (event: unknown) => void): () => void
}

// ---------------------------------------------------------------------------
// Re-readable scope. ONLY a router view typed "home" may use the observed
// host context location; a session view resolves through the session
// record; anything else (router missing, other view types, session view
// without an id) is unknown and refuses.
//
// The TUI supplies sessionID/anchor as DISCLOSURE + the RPC restatement
// value; the SERVER adjudicates authority (anchors, session.moved record).
// A session-kind anchor is therefore a best-available hint, never the
// decision-maker.
// ---------------------------------------------------------------------------

export type SessionScope = {
  // The router session verbatim; null unless the router reports a session
  // view with an id.
  sessionID: string | null
  // Best-available location hint (session record / observed home location).
  // Display + catalog location only — never an ownership decision.
  anchor: string | null
  kind: "session" | "home" | "unknown"
  // unknown-kind disclosure only.
  reason?: string
}

// ---------------------------------------------------------------------------
// The RPC transport the flow consumes (built in tui.ts from
// ctx.client.rpc(forgeConfigRpcDefinition)). Wire types are the shared
// ../rpc.ts protocol types — one definition, server and TUI alike.
// ---------------------------------------------------------------------------

// The frozen sync envelope carries the two-leg protocol natively
// (SyncInput.action prepare|apply; apply requires the token; commitId
// correlates the result to the original receipt).
export type ForgeConfigRpcTransport = {
  echo(input: EchoInput): Promise<EchoOutput>
  editOpen(input: EditOpenInput): Promise<EditOpenOutput>
  prepare(input: PrepareInput): Promise<PrepareOutput>
  commit(input: CommitInput): Promise<CommitOutput>
  receipt(input: ReceiptInput): Promise<ReceiptOutput>
  sync(input: SyncInput): Promise<SyncOutput>
}
