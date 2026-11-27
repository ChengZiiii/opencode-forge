// TUI entry (change forge-tui-subagent-config, REVISED server-RPC contract
// — design D1/D2/D4/D7/D8).
//
// Separate host server and TUI entry points in the SAME package: this file
// bundles to dist/tui.js (export "./tui") and is loaded ONLY by the TUI
// plugin loader; plugin.ts (export ".") stays untouched server-side
// behavior. The only import that leaves the bundle is the host runtime SDK
// alias `@opencode/plugin/tui`, imported through a COMPUTED specifier —
// the probe-proven load path (archive
// 2026-11-27-forge-tui-subagent-config-probes: TUI_IMPORT_OK, keys
// [Plugin, PluginContextProvider, usePlugin], host 2.4.2); bun must leave
// it as a runtime import (verified in the bundle step).
//
// REVISED ARCHITECTURE (2026-11-27 revision, applied): the TUI drafts,
// dialogs and confirms — it NEVER reads or writes a recipe path as a local
// file. Every authoritative answer (document snapshot, canonical patch,
// single-use commit token, family sync) comes from the server plugin over
// the official Plugin RPC: `ctx.client.rpc(forgeConfigRpcDefinition)` with
// the ONE shared statically-bundled definition from ./rpc (probe §9.6/§9.7:
// nonce echo round-trip RPC_ECHO_OK, unknown-method rejection, dispose →
// unavailable; the SDK auto-wraps the HTTP {input} envelope). There is NO
// service.json fallback, NO self-made HTTP endpoint, NO model-callable
// write tool, NO second recipe resolver, NO same-host gate and NO nonce
// channel (the probe-proven-unsatisfiable 2.4.2 same-host gate is
// deprecated as a write premise — superseded by server adjudication).
//
// Probe-proven host surface used here (host 2.4.2):
//   ctx.keymap.layer(() => ({mode, priority, commands:[{id, title, group,
//     palette, slash:{name, aliases, arguments}, enabled, suggested, run}],
//     bindings}))            — palette + slash registration (probe KEYMAP_
//                              LAYER_REGISTERED; palette search + Enter run
//                              observed in the real TUI)
//   ctx.ui.dialog.select / .confirm / .prompt({title, placeholder})
//   ctx.ui.dialog.set({size, centered?}) — sizes the CURRENT active dialog
//                              (SDK context.d.ts:278-342, official contract;
//                              no setSize / size getter; probe 2026-11-28:
//                              accepted on a no-active call — the on-active
//                              visual effect is UNVERIFIED, CUA refused);
//                              openSizedDialog applies it once per Forge
//                              dialog, synchronously after open
//   ctx.ui.toast.show({title, message, variant, duration})
//   ctx.ui.router.current() — {type: "home" | "session", sessionID?}
//                              (binary-verified session-view shape); ONLY
//                              a view typed "home" may use the observed
//                              location — missing router, other view
//                              types, or a session view without an id
//                              refuse as unknown
//   ctx.location.directory  — the OBSERVED host workspace (home kind only)
//   ctx.client.plugin.list({location})         — probe PLUGIN_LIST/E6
//   ctx.client.session.get({sessionID})        — session RECORD row (SDK
//                                                unwraps {data}; row.id
//                                                validated against the
//                                                router session; the record
//                                                is best-AVAILABLE — after
//                                                a session.moved it can
//                                                keep the pre-move location,
//                                                plugin.ts:297-305 probe
//                                                fact; the SERVER's
//                                                sessionMovedAnchors stay
//                                                the live authority)
//   ctx.client.command.list({location})        — command registry (opId
//                                                command.list) — the slash
//                                                collision check
//   ctx.client.rpc(definition)                 — official Plugin RPC call
//                                                surface (probe §9.6)
//   ctx.data.location.provider|model .sync(location)/.list(location) —
//                                                probe CATALOG
//   ctx.data.on(eventType, handler) → unsubscribe — probe §9.1 (real-TUI
//                                                session.moved delivery);
//                                                "command.updated" is a
//                                                contract-documented 2.4.2
//                                                event type (OpenAPI
//                                                components/schemas/
//                                                command.updated) used as a
//                                                RE-OBSERVATION TRIGGER only
//                                                — delivery is live-only and
//                                                never load-bearing.
// NEVER: conversation model access (ui.model / variant.set), prompt
// sending, or main-config writes. Opening/browsing/cancelling writes
// nothing; every write is the server's, behind a confirmed preview token.
//
// REQUIRED CAPABILITY DISCIPLINE: an unbuildable RPC transport, an echo
// that does not round-trip, or an unresolved scope closes the editor with
// disclosure — zero reads, zero writes, zero syncs (fail-closed).
//
// Slash no-shadow discipline (review 2026-11-27, hardened; storage-gate
// design per the coordinator's verified host path): the /forge-config alias
// registers ONLY while the OFFICIAL reactive gate —
// ctx.storage.memory("config-slash-gate", {initial:{allowed:false,
// location:null}}) → [store, mutationSetter] synchronized with the host's
// createStore (SDK 2.4.2 context.d.ts:14-21/395-402) — says
// allowed && gate.location === current directory. There is ONE keymap.layer
// registration for the plugin's lifetime; its factory reads gate.allowed +
// gate.location + the CURRENT host location at evaluation time (never an
// early destructured bool), so a gate flip withdraws the alias on the
// factory's next evaluation WITHOUT any dispose/re-register/layer stacking
// (keymap.layer returns void/bool on 2.4.2 — no probe-proven disposer, and
// stacking layers never removes an old one). Setup resets the gate to
// {allowed:false, location:null} first (hot-reload stale-value defense),
// then one bounded registry observation arms it only when the CURRENT
// location's command registry provably lacks the name (client.command.list;
// unreadable registry = withheld, fail closed). command.updated and
// server-side observations re-run the SAME bounded check; every verdict
// carries a generation + location guard so a late answer for location A can
// never open location B's alias. When ctx.storage.memory is unavailable the
// gate cannot exist → the slash stays withheld entirely (fail-closed),
// palette only. Source separation (review P1(3): run(input) typing is NOT a
// contract — 2.4.2 passes NO string without slash arguments): TWO official
// command entries with distinct run closures — the SLASH entry runs the
// invocation-time conflict leg (collision or unprovable → refuse to open +
// withdraw + disclose — the NEXT invocation reaches the user's command; we
// never fake-dispatch it) and re-arms the gate for the current location; the
// PALETTE entry never collides with a slash name and goes straight to the
// RPC transport gate, refreshing the gate observation (a NEW location
// re-arms there on first invocation).
//
// Named exports (test seams — the test worker binds these): default
// (the definition), readSessionScope, buildUi, buildClient, buildData,
// buildRpcTransport. They are wiring internals, not additional product API.

import { createForgeConfigEditor, type EditorDeps } from "./src/tui/flow.ts"
import { anchorableStartupScope, safeErrorText as errorText } from "./src/tui/guard.ts"
import { forgeConfigRpcDefinition, type ConfigRpcMethod } from "./rpc.ts"
import type {
  CommandRow,
  ForgeConfigRpcTransport,
  HostClient,
  HostData,
  HostUi,
  PluginRow,
  RouterView,
  SessionRow,
  SessionScope,
} from "./src/tui/contracts.ts"

// Computed specifier: stays a RUNTIME import through bun's bundler (the
// host provides the module; it is never installed with this package).
const TUI_SDK_SPEC = ["@opencode", "plugin", "tui"].join("/")

// Typed host-context surfaces (P1: no `any` — runtime shapes are read
// through `unknown` members + narrow guards, and each SDK touchpoint makes
// exactly one named assertion to its contract type).
type HostUiSurface = {
  dialog?: {
    select?: unknown
    confirm?: unknown
    prompt?: unknown
    clear?: unknown
    // dialog.set({size, centered?}) — the ONLY 2.4.2 size control (SDK
    // context.d.ts:278-342; no setSize, no size getter). See
    // openSizedDialog for the sizing discipline.
    set?: unknown
  }
  toast?: { show?: unknown }
  router?: { current?: unknown }
}

type HostClientSurface = {
  // NO endpoint member exists on 2.4.2 (E2E-proven) — and none is needed:
  // connection identity is never adjudicated client-side under the revised
  // contract; the server resolves and discloses every target itself.
  plugin?: { list?: unknown }
  session?: { get?: unknown }
  command?: { list?: unknown }
  rpc?: unknown
}

type HostDataSurface = {
  location?: {
    provider?: { sync?: unknown; list?: unknown }
    model?: { sync?: unknown; list?: unknown }
    default?: unknown
  }
  // Live-only event subscription (probe §9.1). Used ONLY as a
  // re-observation trigger, never as a correctness source.
  on?: unknown
}

type HostCtx = {
  app?: { version?: string }
  location?: { directory?: string }
  ui?: HostUiSurface
  client?: HostClientSurface
  data?: HostDataSurface
  keymap?: { layer(fn: () => unknown): unknown }
  // The OFFICIAL reactive state seam (SDK 2.4.2 context.d.ts:14-21):
  // memory(key, {initial}) → [store, mutationSetter] synchronized with the
  // host's createStore — the slash gate lives here (never a plain module
  // bool, never a solid-js import).
  storage?: { memory?: unknown }
}

type HostLocation = { directory?: string }

async function loadTuiApi(): Promise<{ Plugin?: { define(definition: unknown): unknown } } | null> {
  try {
    const mod = (await import(TUI_SDK_SPEC)) as { Plugin?: { define(definition: unknown): unknown } }
    return mod ?? null
  } catch {
    return null // disclosed in setup — server-side Forge stays usable
  }
}

// ---------------------------------------------------------------------
// Narrow readers (no `any`): a callable guard plus one named assertion
// per SDK touchpoint.
// ---------------------------------------------------------------------

function asCallable(value: unknown): ((...args: unknown[]) => unknown) | null {
  return typeof value === "function" ? (value as (...args: unknown[]) => unknown) : null
}

// Real default for the readiness sleep seam — never holds the host process
// open (same unref discipline as checkDeadline).
function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer: ReturnType<typeof setTimeout> = setTimeout(() => resolve(), ms)
    if (typeof timer === "object" && timer !== null && typeof (timer as { unref?: unknown }).unref === "function") {
      ;(timer as { unref(): void }).unref()
    }
  })
}

// Real default for the readiness deadline-timer seam: fire the callback ONCE
// after ms; the returned cancel is idempotent (post-fire/post-cancel calls
// are no-ops). The flow's registryReadiness invokes the cancel in its
// finally, so the total-deadline timer never outlives the readiness window.
function defaultSchedule(ms: number, callback: () => void): () => void {
  let settled = false
  const timer: ReturnType<typeof setTimeout> = setTimeout(() => {
    settled = true
    callback()
  }, ms)
  if (typeof timer === "object" && timer !== null && typeof (timer as { unref?: unknown }).unref === "function") {
    ;(timer as { unref(): void }).unref()
  }
  return () => {
    if (settled) return
    settled = true
    clearTimeout(timer)
  }
}

// ---------------------------------------------------------------------
// Seams: adapt the probe-proven runtime shapes to the flow's contracts.
// ---------------------------------------------------------------------

// Dialog sizing (UX round point 1, 2026-11-28, probe-fenced): calls open()
// — the host dialog fn(input), which opens the dialog and returns its
// promise — then sizes the JUST-OPENED active dialog through dialog.set,
// the ONLY 2.4.2 size control (SDK context.d.ts:278-342; probe: dialog own
// keys alert/clear/confirm/prompt/select/set/show — no setSize, no size
// getter; a no-active set({size:"xlarge",centered:true}) returned undefined
// without throwing — the on-active visual effect stays UNVERIFIED while
// CUA physical input is refused, so no visual claim is made). Forge opens
// its editor dialogs at xlarge + centered so the option footers (the full
// per-row facts) stay readable.
//
// Discipline: EXACTLY ONE set per opened dialog, synchronously AFTER
// fn(input) opened it and BEFORE the promise is awaited (the opened dialog
// is the active one at that instant; no await may open another). Never a
// finally "reset to medium" — dialog.set targets the CURRENT active dialog
// and a reset would resize OTHER dialogs; never a read of a size state
// (there is no size getter). set is invoked AS A METHOD OF the dialog
// object (host this-binding — asCallable strips this). A missing or
// throwing set degrades FAIL-SOFT: the dialog stays fully usable at the
// host default size and onDegraded() fires once (the caller throttles it
// to ONE hint per editor session — never a toast per dialog). The opened
// promise is returned AS-IS: resolve/reject untouched, a sizing failure
// never masks or replaces a dialog failure, and the save protocol never
// sees this seam.
function openSizedDialog<T>(
  dialogObj: { set?: unknown },
  open: () => Promise<T>,
  onDegraded: () => void,
): Promise<T> {
  const opened = open()
  try {
    const set = asCallable(dialogObj.set)
    if (set === null) throw new Error("ctx.ui.dialog.set is unavailable")
    set.call(dialogObj, { size: "xlarge", centered: true })
  } catch {
    onDegraded() // fail-soft: default-size dialog stays usable
  }
  return opened
}

export function buildUi(ctx: HostCtx): HostUi {
  const ui: HostUiSurface = ctx.ui ?? {}
  const dialog = ui.dialog ?? {}
  // ONE short degradation hint per editor session (buildUi runs once per
  // runEditor): a hint per dialog would spam the host. Best-effort — no
  // toast surface means the hint is silently skipped, never thrown.
  let sizeHintShown = false
  const discloseSizeDegradation = (): void => {
    if (sizeHintShown) return
    sizeHintShown = true
    try {
      const show = asCallable(ui.toast?.show)
      if (show !== null) {
        show({
          title: "Forge",
          message: "Could not widen this dialog; using host default size.",
          variant: "info",
          duration: 4000,
        })
      }
    } catch {
      /* the hint is best-effort disclosure */
    }
  }
  const sized = <T>(open: () => Promise<T>): Promise<T> => openSizedDialog<T>(dialog, open, discloseSizeDegradation)
  return {
    select: (input) => {
      const fn = asCallable(dialog.select)
      if (fn === null) throw new Error("ctx.ui.dialog.select is unavailable")
      // The ONE named assertion sits at the PROVEN host boundary — fn(input)
      // IS the host dialog call (contract: it returns the dialog promise).
      // sized passes the SAME promise object through (generic T — no
      // async/ Promise.resolve re-wrap, the identity is never changed).
      return sized(() => fn(input) as Promise<string | undefined>)
    },
    confirm: (input) => {
      const fn = asCallable(dialog.confirm)
      if (fn === null) throw new Error("ctx.ui.dialog.confirm is unavailable")
      return sized(() => fn(input) as Promise<boolean | undefined>)
    },
    prompt: (input) => {
      const fn = asCallable(dialog.prompt)
      if (fn === null) throw new Error("ctx.ui.dialog.prompt is unavailable")
      return sized(() => fn(input) as Promise<string | undefined>)
    },
    // ctx.ui.dialog.clear() — closes the TOP dialog (probe: a footer action
    // does not, clear does). The flow calls it from the CtrlD action; a
    // host without the member throws here and the flow falls back to the
    // inline delete path (disclosed by the flow's try/catch, never silent).
    clear: () => {
      const fn = asCallable(dialog.clear)
      if (fn === null) throw new Error("ctx.ui.dialog.clear is unavailable — the CtrlD delete shortcut cannot close the list safely")
      return fn(undefined) as void
    },
    toast: (input) => {
      try {
        const show = asCallable(ui.toast?.show)
        if (show !== null) show(input)
      } catch {
        /* disclosure is best-effort */
      }
    },
    router: {
      current: () => {
        const current = asCallable(ui.router?.current)
        if (current === null) return undefined
        return current() as RouterView | undefined
      },
    },
  }
}

export function buildClient(ctx: HostCtx): HostClient {
  const client: HostClientSurface = ctx.client ?? {}
  // Every member binds to THE connected client; an absent surface throws —
  // consumers treat that as "leg unverifiable → refuse closed".
  const callOne = (method: unknown, label: string, input: unknown): Promise<unknown> => {
    const fn = asCallable(method)
    if (fn === null) throw new Error(`${label} is unavailable on the connected client`)
    return Promise.resolve(fn(input))
  }
  return {
    plugin: {
      list: async (input) => (await callOne(client.plugin?.list, "client.plugin.list", input)) as { data?: PluginRow[] } | undefined,
    },
    session: {
      get: async (input) => (await callOne(client.session?.get, "client.session.get", input)) as SessionRow | undefined,
    },
    command: {
      list: async (input) => (await callOne(client.command?.list, "client.command.list", input)) as { data?: CommandRow[] } | undefined,
    },
    // The RPC factory is asserted in buildRpcTransport (one named place).
    rpc: (definition: unknown) => {
      const fn = asCallable(client.rpc)
      if (fn === null) throw new Error("client.rpc is unavailable on the connected client")
      return fn(definition)
    },
  }
}

export function buildData(ctx: HostCtx): HostData {
  const location: HostDataSurface["location"] = ctx.data?.location ?? {}
  const provider = location?.provider ?? {}
  const model = location?.model ?? {}
  return {
    location: {
      provider: {
        sync: (l) => {
          const fn = asCallable(provider.sync)
          if (fn === null) throw new Error("data.location.provider.sync is unavailable")
          return fn(l) as Promise<unknown>
        },
        list: (l) => {
          const fn = asCallable(provider.list)
          if (fn === null) throw new Error("data.location.provider.list is unavailable")
          return fn(l) as unknown
        },
      },
      model: {
        sync: (l) => {
          const fn = asCallable(model.sync)
          if (fn === null) throw new Error("data.location.model.sync is unavailable")
          return fn(l) as Promise<unknown>
        },
        list: (l) => {
          const fn = asCallable(model.list)
          if (fn === null) throw new Error("data.location.model.list is unavailable")
          return fn(l) as unknown
        },
      },
      default: () => {
        const fn = asCallable(location?.default)
        if (fn === null) throw new Error("data.location.default is unavailable")
        return fn() as HostLocation
      },
    },
    on: (eventType: string, handler: (event: unknown) => void) => {
      const fn = asCallable(ctx.data?.on)
      if (fn === null) throw new Error("data.on is unavailable — live event subscription is not provided")
      return fn(eventType, handler) as () => void
    },
  }
}

// Observed host context location (ctx.location.directory, then the host
// data default). AUTHORITATIVE for the home kind ONLY; elsewhere a display
// hint (the server adjudicates every target itself).
function observedDirectory(ctx: HostCtx): string | null {
  const dir = ctx.location?.directory
  if (typeof dir === "string" && dir !== "") return dir
  try {
    const fn = asCallable(ctx.data?.location?.default)
    if (fn === null) return null
    const def = fn() as HostLocation | undefined
    const d = def?.directory
    return typeof d === "string" && d !== "" ? d : null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------
// Re-readable scope: ONLY a router view typed "home" may use the observed
// context location. A missing router, an unidentifiable view type, or a
// session view without an id is UNKNOWN — never silently authorized as
// home. A session view resolves through the session RECORD (row.id
// validated against the router session). The record is the BEST-AVAILABLE
// anchor source (it can lag a session.moved — plugin.ts:297-305 probe
// fact); under the revised contract it feeds DISCLOSURE and the sessionID
// restatement only: the server's authoritative anchors (including its live
// session.moved record) decide every target.
// ---------------------------------------------------------------------

export async function readSessionScope(ctx: HostCtx): Promise<SessionScope> {
  let routerView: RouterView | undefined
  try {
    const current = asCallable(ctx.ui?.router?.current)
    routerView = current !== null ? (current() as RouterView | undefined) : undefined
  } catch {
    routerView = undefined
  }
  const routerType = typeof routerView?.type === "string" ? routerView.type : null
  const routerSessionID = typeof routerView?.sessionID === "string" && routerView.sessionID !== "" ? routerView.sessionID : null
  if (routerType !== "home" && routerType !== "session") {
    return {
      sessionID: null,
      anchor: null,
      kind: "unknown",
      reason:
        routerView === undefined
          ? "ui.router.current() is unavailable — the view cannot be identified; only a proven home view could use the observed location"
          : `ui.router.current() reports view ${JSON.stringify(routerType)} — neither home nor session; scope cannot be established`,
    }
  }
  if (routerType === "home") {
    const observed = observedDirectory(ctx)
    if (observed !== null) return { sessionID: null, anchor: observed, kind: "home" }
    return { sessionID: null, anchor: null, kind: "unknown", reason: "the router reports the home view but no observed host location is available" }
  }
  // Session view.
  const sessionID = routerSessionID
  if (sessionID === null) {
    return { sessionID: null, anchor: null, kind: "unknown", reason: "the router reports a session view without a sessionID" }
  }
  let row: SessionRow | undefined
  try {
    row = await buildClient(ctx).session.get({ sessionID })
  } catch (err) {
    return { sessionID, anchor: null, kind: "unknown", reason: `client.session.get failed: ${errorText(err)}` }
  }
  if (row === null || typeof row !== "object") {
    return { sessionID, anchor: null, kind: "unknown", reason: "client.session.get returned no session record" }
  }
  if (row.id !== sessionID) {
    return {
      sessionID,
      anchor: null,
      kind: "unknown",
      reason: `the session record's id ${JSON.stringify(row.id ?? null)} does not match the router session ${JSON.stringify(sessionID)} — the record is not trusted`,
    }
  }
  const dir = row.location?.directory
  if (typeof dir === "string" && dir !== "") return { sessionID, anchor: dir, kind: "session" }
  return { sessionID, anchor: null, kind: "unknown", reason: "the session record carries no location.directory" }
}

// ---------------------------------------------------------------------
// RPC transport (official Plugin RPC, probe §9.6): ctx.client.rpc(SHARED
// definition) → per-method callables. Every method must be a callable or
// the WHOLE transport refuses (null) — a half-usable transport is an
// unprovable transport. Returns null when client.rpc itself is absent —
// the caller discloses and refuses (zero reads/writes/syncs).
// ---------------------------------------------------------------------

const RPC_METHODS: readonly ConfigRpcMethod[] = ["echo", "editOpen", "prepare", "commit", "receipt", "sync"]

export function buildRpcTransport(ctx: HostCtx, location: string): ForgeConfigRpcTransport | null {
  // Runtime refusal for a missing/empty location (the TS type forbids it,
  // but a wired caller must still be refused — there is no default-location
  // fallback, ever).
  if (typeof location !== "string" || location === "") return null
  const client = buildClient(ctx)
  // The WHOLE transport is bound to the startup scope's directory anchor:
  // every RPC method carries the official second argument opts.location
  // (the business input is never polluted). The binding is fixed for the
  // editor session — a scope/location change can only be served by closing
  // this editor and a fresh runEditor (the old transport never re-points).
  const opts = { location: { directory: location } }
  try {
    const raw = client.rpc(forgeConfigRpcDefinition)
    if (raw === null || typeof raw !== "object") return null
    const methods = raw as Record<string, unknown>
    const bound: Record<string, unknown> = {}
    for (const name of RPC_METHODS) {
      const fn = asCallable(methods[name])
      if (fn === null) return null // one missing method = unprovable transport
      bound[name] = async (input: unknown) => (await fn(input, opts)) as unknown
    }
    return bound as unknown as ForgeConfigRpcTransport
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------
// Editor command
// ---------------------------------------------------------------------

async function runEditor(ctx: HostCtx, source: "slash" | "palette"): Promise<void> {
  const ui = buildUi(ctx)
  // Source discrimination is the RUN CLOSURE IDENTITY (two official command
  // entries), not run(input) typing — 2.4.2 passes NO string input without
  // slash arguments, so input typing is not a contract (review P1(3)).
  // The SLASH path re-checks the registry BEFORE anything opens: collision
  // or unprovable → refuse + withdraw + disclose (the NEXT invocation
  // reaches the user's command; we never fake-dispatch it); provably free
  // → re-arm the gate for the CURRENT location (a location change is
  // re-checked here too — an alias armed at A never opens at B).
  const gate = buildSlashGate(ctx)
  if (source === "slash") {
    const verdict = await Promise.race([slashNameTaken(ctx), checkDeadline(3000)])
    const now = observedDirectory(ctx)
    if (gate !== null) gate.set(false, now) // withdrawn BEFORE any open decision
    if (verdict !== false) {
      if (verdict === true) {
        disclose(ctx, "Your own /forge-config command was detected — this invocation reached Forge's alias, which is now withdrawn; your command's NEXT invocation reaches it.", "warning")
      } else {
        disclose(ctx, "The command registry could not be re-checked before opening (fail-closed) — /forge-config stays closed. The palette entry remains registered.", "warning")
      }
      return
    }
    if (gate !== null) gate.set(true, now)
  } else {
    // Palette: refresh the bounded observation (arms/re-arms for the
    // CURRENT location; a conflict flips the gate without refusing — the
    // palette entry cannot shadow a slash command).
    void observeAndSetGate(ctx, gate)
  }
  // The startup scope is bound ONCE, here: the SHARED anchorability
  // predicate (src/tui/guard.ts — the same rule the flow's re-verification
  // applies) refuses anything but home+null-sessionID or session+non-blank
  // sessionID with a non-blank directory anchor. The transport is built AT
  // that anchor and the editor's every later scope re-read compares against
  // this bound value (a change voids the invocation — the editor is closed
  // and a fresh runEditor re-observes).
  const initialScope = await readSessionScope(ctx)
  // (The `|| initialScope.anchor === null` arm only NARROWS for the compiler
  // — the predicate already guarantees a non-blank anchor at runtime.)
  if (!anchorableStartupScope(initialScope) || initialScope.anchor === null) {
    ui.toast({
      title: "Forge: Configure subagents",
      message: `Scope/location cannot be anchored (${initialScope.reason ?? "no legal startup scope"}) — the editor cannot open: zero reads, zero writes, zero syncs.`,
      variant: "error",
      duration: 8000,
    })
    return
  }
  const rpc = buildRpcTransport(ctx, initialScope.anchor)
  if (rpc === null) {
    ui.toast({
      title: "Forge: Configure subagents",
      message: "The forge-config RPC transport is unavailable (client.rpc or a method is missing) — the editor cannot open: zero reads, zero writes, zero syncs. Server-side /forge is unaffected.",
      variant: "error",
      duration: 8000,
    })
    return
  }
  const deps: EditorDeps = {
    ui,
    client: buildClient(ctx),
    data: buildData(ctx),
    rpc,
    sessionScope: () => readSessionScope(ctx),
    initialScope,
    pluginId: "forge",
    sleep: defaultSleep,
    schedule: defaultSchedule,
    // Monotonic real default (performance.now) — Date.now() can jump under
    // NTP adjustment and would corrupt the readiness budget math. Tests
    // inject a fake clock and keep full control.
    now: () => performance.now(),
  }
  const editor = createForgeConfigEditor(deps)
  try {
    await editor.open()
  } catch (err) {
    // The flow may have already landed a confirmed commit before throwing —
    // the write state is resolved by the server's receipt, never assumed.
    ui.toast({ title: "Forge: Configure subagents", message: `The editor closed on an error — if a Save & Sync was confirmed, resolve its outcome via Retry sync / the server receipt (error: ${errorText(err)})`, variant: "error", duration: 8000 })
  }
}

// ---------------------------------------------------------------------
// Editor registration (palette + conditional slash; see the header note)
// ---------------------------------------------------------------------

// ---------------------------------------------------------------------
// Slash gate — the OFFICIAL reactive host state. There is exactly ONE
// keymap.layer registration for the plugin's lifetime and NO dispose /
// re-register / layer-stacking anywhere: keymap.layer returns void/bool on
// 2.4.2 (no probe-proven disposer) and stacking layers never removes an old
// one, so withdrawal is a GATE FLIP that the factory reads on its next
// evaluation.
// ---------------------------------------------------------------------

type SlashGate = { allowed: boolean; location: string | null }

type SlashGateState = {
  // Property reads stay inside the layer factory (tracked by the host's
  // createStore); this reader only normalizes shapes.
  read(): SlashGate
  set(allowed: boolean, location: string | null): void
}

function buildSlashGate(ctx: HostCtx): SlashGateState | null {
  const memory = asCallable(ctx.storage?.memory)
  if (memory === null) return null
  let pair: unknown
  try {
    pair = memory("config-slash-gate", { initial: { allowed: false, location: null } })
  } catch {
    return null
  }
  if (!Array.isArray(pair) || pair.length < 2) return null
  const store = pair[0] as SlashGate
  const setter = asCallable(pair[1])
  if (setter === null) return null
  return {
    read: () => ({
      allowed: store.allowed === true,
      location: typeof store.location === "string" ? store.location : null,
    }),
    set: (allowed, location) => {
      try {
        // mutationSetter contract (SDK 2.4.2): the callback mutates the
        // store draft in place; the host propagates the change to every
        // factory that read the members.
        setter((draft: SlashGate) => {
          draft.allowed = allowed
          draft.location = location
        })
      } catch {
        /* the factory's next read shows the truth; never crash registration */
      }
    },
  }
}

// The command list the layer factory returns. TWO entries with DISTINCT
// run closures — palette and slash are source-discriminated by which run
// executed, never by a host-provided run(input) value (review P1(3): 2.4.2
// passes NO string input without slash arguments, so input typing is not a
// contract; independent command entries are the official capability). The
// slash member of the slash entry is decided AT EVALUATION TIME from the
// gate + the CURRENT host location — never from a captured bool.
function layerCommands(ctx: HostCtx, gate: SlashGateState | null): unknown {
  let slashAllowed = false
  if (gate !== null) {
    const g = gate.read()
    const dir = observedDirectory(ctx)
    slashAllowed = g.allowed && (g.location === null || g.location === dir)
  }
  return {
    mode: "global",
    priority: 50,
    commands: [
      {
        // The SLASH entry: palette-invisible; its run closure carries the
        // invocation-time conflict leg.
        id: "forge.config-slash",
        title: "Forge: Configure subagents (/forge-config)",
        group: "Forge",
        palette: false,
        ...(slashAllowed ? { slash: { name: "forge-config" } } : {}),
        enabled: () => true,
        suggested: false,
        run: () => runEditor(ctx, "slash"),
      },
      {
        // The PALETTE entry: never collides with a slash name — no
        // refusal leg; its run refreshes the gate observation so an
        // invocation at a NEW location re-arms there.
        id: "forge.config",
        title: "Forge: Configure subagents",
        group: "Forge",
        palette: true,
        enabled: () => true,
        suggested: false,
        run: () => runEditor(ctx, "palette"),
      },
    ],
    bindings: [],
  }
}

function disclose(ctx: HostCtx, message: string, variant: "success" | "warning" | "error" | "info"): void {
  try {
    const show = asCallable(ctx.ui?.toast?.show)
    if (show !== null) show({ title: "Forge", message, variant, duration: 6000 })
  } catch {
    /* nothing else to disclose through */
  }
}

// Slash-name collision check through the connected client (GET /api/command
// — opId command.list), queried for the CURRENT location. false = the
// registry provably has no such name → the slash may arm. true = the user
// owns /forge-config → the gate stays/becomes closed (palette kept). null =
// the check could not run (surface absent, non-array shape, failure,
// deadline) — FAIL CLOSED: the gate closes too (an unprovable no-collision
// is never a license to overwrite a user command).
async function slashNameTaken(ctx: HostCtx): Promise<boolean | null> {
  const list = asCallable(ctx.client?.command?.list)
  if (list === null) return null
  try {
    const directory = ctx.location?.directory
    const res = (await list({ location: typeof directory === "string" && directory !== "" ? { directory } : {} })) as { data?: CommandRow[] } | undefined
    const rows = res?.data
    if (!Array.isArray(rows)) return null
    return rows.some((row) => row?.name === "forge-config")
  } catch {
    return null
  }
}

// Bounded wait: a stalled server must not hold an observation open — the
// check degrades to null (fail-closed gate close + disclosure) after the
// deadline.
function checkDeadline(ms: number): Promise<null> {
  return new Promise((resolve) => {
    const timer: ReturnType<typeof setTimeout> = setTimeout(() => resolve(null), ms)
    if (typeof timer === "object" && timer !== null && typeof (timer as { unref?: unknown }).unref === "function") {
      ;(timer as { unref(): void }).unref() // never hold the host process open
    }
  })
}

let unsubscribe: (() => void) | null = null
// Late-answer guard: only the LATEST observation may apply its verdict, and
// only while the observed location is still current (a late answer for
// location A must never open location B's alias).
let observationGeneration = 0

// One bounded registry observation. The verdict arms/closes the gate ONLY
// when this is still the latest check AND the observed location is still
// current (a late answer for location A must never open location B's
// alias). With a null gate (storage.memory unavailable) the observation
// still runs for the collision/no-registry DISCLOSURES — the slash simply
// stays withheld (fail closed).
async function observeAndSetGate(ctx: HostCtx, gate: SlashGateState | null): Promise<void> {
  const generation = ++observationGeneration
  const atLocation = observedDirectory(ctx)
  const verdict = await Promise.race([slashNameTaken(ctx), checkDeadline(3000)])
  if (generation !== observationGeneration) return // superseded by a newer observation
  if (observedDirectory(ctx) !== atLocation) return // the user moved on — stale verdict
  if (gate !== null) gate.set(verdict === false, atLocation)
  if (verdict === true) {
    disclose(ctx, 'Your own "/forge-config" command was detected — Forge registered its palette entry only and did not overwrite your command.', "info")
  } else if (verdict === null) {
    disclose(ctx, "The command registry is not readable from this TUI — a user-defined /forge-config collision cannot be ruled out, so the /forge-config slash shortcut is withheld (fail-closed; the palette entry is active).", "warning")
  }
}

async function setupTui(ctx: HostCtx): Promise<undefined> {
  const gate = buildSlashGate(ctx)
  // Hot-reload defense FIRST: reset the gate so a stale allowed value from
  // a previous plugin load can never keep an unverified alias live.
  gate?.set(false, null)
  const layer = asCallable(ctx.keymap?.layer)
  if (layer === null) {
    disclose(ctx, "The TUI command surface is unavailable — the Forge palette entry was not registered. Server-side /forge is unaffected.", "warning")
    return
  }
  try {
    // THE single registration. The factory reads the gate + current
    // location at every evaluation; withdrawal is a gate flip, never a
    // dispose or a re-registration.
    layer(() => layerCommands(ctx, gate))
  } catch {
    disclose(ctx, "The TUI command surface is unavailable — the Forge palette entry was not registered. Server-side /forge is unaffected.", "warning")
    return
  }
  if (gate === null) {
    // No official reactive state → the alias cannot be withdrawn reliably →
    // fail closed: the slash stays withheld entirely (palette only). The
    // registry observation below still runs for honest disclosures.
    disclose(ctx, "The reactive command gate (ctx.storage.memory) is unavailable in this host — the /forge-config slash shortcut is withheld entirely (fail-closed; the palette entry is active).", "warning")
  }
  await observeAndSetGate(ctx, gate)
  // Live re-observation trigger (probe §9.1 data.on; "command.updated" is a
  // contract-documented 2.4.2 event type). Delivery is live-only and NEVER
  // load-bearing: every notification just re-runs the same bounded registry
  // observation; the verdict comes from command.list, not from the event.
  // The event's data payload shape is unspecified in the contract, so it is
  // not interpreted at all.
  try {
    unsubscribe = buildData(ctx).on("command.updated", () => {
      void observeAndSetGate(ctx, gate)
    })
  } catch {
    // No event subscription surface: the setup-time + invocation-time
    // checks remain; disclosed as an honest limitation, never a silent gap.
    disclose(ctx, "Live command-registry change events are unavailable in this host — /forge-config collision detection relies on setup- and invocation-time checks.", "info")
  }
  return undefined
}

const api = await loadTuiApi()
const definition = {
  id: "forge",
  setup: setupTui,
  // Best-effort lifecycle hook (NOT probe-proven — disclosed): releases the
  // event subscription when the host unloads the TUI plugin. There is no
  // keymap-layer release here — the single layer was never disposed by this
  // code on 2.4.2 (no probe-proven disposer), and the gate opens {false}
  // again on the next setup (hot-reload defense).
  dispose: () => {
    const un = unsubscribe
    unsubscribe = null
    if (un !== null) {
      try {
        un()
      } catch {
        /* already released */
      }
    }
  },
}
export default api?.Plugin?.define ? api.Plugin.define(definition) : definition
