import test from "node:test"
import assert from "node:assert/strict"

// forge-tui-subagent-config — TUI editor flow tests against the REAL
// seams (src/tui/flow.ts, EditorDeps={ui,client,data,rpc,sessionScope,
// pluginId?}) and the frozen wire types in ../rpc.ts (echo/editOpen/
// prepare/commit/receipt/sync; sync = ONE method, action prepare|apply).
// The scripted rpc is a per-test canned transport + call recorder; the
// server-side protocol itself is covered in tests/config-rpc-*.test.mjs.
// Script exhaustion throws (bounded) — unknown dialogs fail loudly, never
// loop.

import { createForgeConfigEditor } from "../src/tui/flow.ts"

const PATH = "C:/proj/.opencode/forge.json"
const IDENTITY = "mtime 100, size 41"

// ---------------------------------------------------------------------------
// Scripted UI + canned typed-v2 RPC
// ---------------------------------------------------------------------------

function history(calls) {
  return calls.map((c) => `${c.kind}:"${String(c.args?.title).slice(0, 50)}"=>${JSON.stringify(c.answer)}`).join(" | ")
}

// Sentinel: a select stays PENDING until the public ui.clear() closes it —
// the official CtrlD semantics (onTrigger records the target + ui.clear();
// clear synchronously resolves the open select; the action NEVER auto-closes
// the dialog and a nested confirm never replaces clear).
const PENDING_CLEAR = Symbol("pending-clear")
// AUTO_TAIL: from this point on, every remaining dialog is answered BY ITS
// TYPE (select → undefined/close, confirm → true, prompt → ""), bounded to
// 20 dialogs — for tails whose exact re-render count is flow-internal.
const AUTO_TAIL = Symbol("auto-tail")

function scriptedUi(steps) {
  const calls = []
  const toasts = []
  const pendingSelects = []
  let autoTail = false
  let autoCount = 0
  const take = async (kind, args) => {
    const call = { kind, args, answer: undefined }
    calls.push(call)
    if (autoTail) {
      if (++autoCount > 20) throw new Error(`auto tail exceeded 20 dialogs at ${kind} — history: ${history(calls)}`)
      call.stepTaken = "AUTO_TAIL"
      call.answer = kind === "confirm" ? true : kind === "prompt" ? "" : undefined
      return call.answer
    }
    if (steps.length === 0) throw new Error(`script exhausted at ${kind}: ${JSON.stringify(args?.title ?? args)} — history: ${history(calls)}`)
    const step = steps.shift()
    if (step === AUTO_TAIL) {
      autoTail = true
      call.stepTaken = "AUTO_TAIL(marker)"
      return take(kind, args)
    }
    call.stepTaken = step
    if (typeof step === "function") {
      // For selects the dialog is LIVE from the moment the offer is built —
      // register the close resolver BEFORE the step runs so ui.clear() inside
      // the action trigger resolves THIS dialog (official CtrlD semantics).
      if (kind === "select") {
        let resolveSelect
        const live = new Promise((resolve) => { resolveSelect = resolve })
        pendingSelects.push(resolveSelect)
        const out = await step({ args, calls, ui: uiPublic })
        if (out === PENDING_CLEAR) {
          call.answer = "pending-clear"
          return live // stays pending until ui.clear() resolves it
        }
        const i = pendingSelects.indexOf(resolveSelect)
        if (i >= 0) pendingSelects.splice(i, 1)
        resolveSelect(out)
        call.answer = out
        return out
      }
      const out = await step({ args, calls, ui: uiPublic })
      call.answer = out
      return out
    }
    if (kind === "select") {
      if (step !== undefined && typeof step !== "string") {
        throw new Error(`bounded mismatch: the select "${args?.title}" received a non-string scripted step ${JSON.stringify(step)} — the scripted dialog offer diverges from the flow; history: ${history(calls)}`)
      }
      if (typeof step === "string" && !(args?.options ?? []).some((o) => o.value === step)) {
        throw new Error(`bounded mismatch: the select "${args?.title}" was scripted to pick ${JSON.stringify(step)} but offers ${JSON.stringify((args?.options ?? []).map((o) => o.value))}; history: ${history(calls)}`)
      }
    }
    if (kind === "confirm" && step !== undefined && typeof step !== "boolean") {
      throw new Error(`bounded mismatch: the confirm "${args?.title}" received a non-boolean scripted step ${JSON.stringify(step)}; history: ${history(calls)}`)
    }
    if (kind === "prompt" && step !== undefined && typeof step !== "string") {
      throw new Error(`bounded mismatch: the prompt "${args?.title}" received a non-string scripted step ${JSON.stringify(step)}; history: ${history(calls)}`)
    }
    call.answer = step
    return step
  }
  const uiPublic = {
    // PUBLIC clear: synchronously resolves the CURRENT open select as closed
    // (undefined) — the official mechanism behind CtrlD; the fake never
    // auto-closes a select from inside an action trigger.
    clear: () => {
      const resolve = pendingSelects.shift()
      if (resolve === undefined) throw new Error("bounded mismatch: ui.clear() called with no open select — the flow must clear only a live dialog")
      resolve(undefined)
    },
  }
  return {
    calls,
    toasts,
    ui: {
      select: (input) => take("select", input),
      confirm: (input) => take("confirm", input),
      prompt: (input) => take("prompt", input),
      toast: (input) => { toasts.push(input) },
      clear: uiPublic.clear,
    },
  }
}

// Dynamic pick helpers for dialogs whose option values are flow-internal.
const firstOption = ({ args }) => args.options[0]?.value

function editOpenOk(seed = {}) {
  return {
    ok: true,
    snapshotId: seed.snapshotId ?? "snap-1",
    path: seed.path ?? PATH,
    targetIdentity: seed.targetIdentity ?? "tgt-1",
    scope: seed.scope ?? "workspace",
    sessionID: seed.sessionID ?? null,
    // null is a CONTRACT value (global anchor:null) — only undefined falls
    // back to the fixture default; never let ?? overwrite an explicit null.
    observedLocation: seed.observedLocation === undefined ? "C:/proj" : seed.observedLocation,
    anchor: seed.anchor === undefined ? "C:/proj" : seed.anchor,
    epoch: "ep-1",
    generation: 7,
    expiresAt: 9_000_000,
    exists: seed.exists ?? true,
    readable: seed.readable ?? true,
    creatable: seed.creatable ?? true,
    identity: seed.exists === false ? null : { mtimeMs: 100, size: 41, dev: 1, ino: 1 },
    raw: seed.exists === false ? null : (seed.raw ?? '{ "pool": "proj", "agents": { "scout": {} } }'),
    document: seed.exists === false ? null : (seed.doc ?? { pool: "proj", agents: { scout: {} } }),
    parseError: null,
    findings: [],
  }
}

function previewOf(req, seed = {}) {
  return {
    path: seed.path ?? PATH,
    targetIdentity: "tgt-1",
    scope: req.scope,
    sessionID: req.sessionID ?? null,
    oldText: seed.oldText ?? '{ "pool": "proj", "agents": { "scout": {} } }',
    newText: seed.newText ?? "{ changed }",
    previewHash: "h",
    createFile: seed.createFile ?? false,
    identity: { mtimeMs: 100, size: 41 },
    entries: (req.ops ?? []).map((op) => ({
      opId: op.opId,
      id: op.id,
      kind: op.kind,
      action: op.action,
      entryKind: op.action === "create" ? "create-file" : "patch",
      summary: [`plan ${op.action} ${op.kind} ${op.id}`],
      findings: [],
    })),
    rejected: seed.rejected ?? [],
  }
}

function receiptOf(req, seed = {}) {
  return {
    commitId: seed.commitId ?? "c-1",
    token: req.token,
    outcome: seed.outcome ?? "written",
    message: seed.message ?? "",
    path: seed.path ?? PATH,
    targetIdentity: "tgt-1",
    scope: req.scope,
    sessionID: req.sessionID ?? null,
    savedIdentity: seed.outcome === "written" ? { mtimeMs: 101, size: 40 } : null,
    bytes: seed.outcome === "written" ? 40 : 0,
    entries: seed.entries ?? [],
    epoch: "ep-1",
    generation: 7,
    at: 9_000_001,
    sync: seed.sync,
  }
}

function syncPrepareOk(seed = {}) {
  return {
    ok: true,
    action: "prepare",
    outcome: "token",
    token: { token: seed.syncToken ?? "synctok-1", expiresAt: 9_000_000, epoch: "ep-1", generation: 7 },
    preview: {
      path: seed.path ?? PATH,
      scope: seed.scope ?? "workspace",
      sessionID: seed.sessionID ?? null,
      observedLocation: "C:/proj",
      anchor: "C:/proj",
      family: { file: PATH, ns: "proj", materializedIds: ["forge-proj-scout"] },
      overridesIncluded: false,
      files: [{ nativeId: "forge-proj-scout", fileName: "forge-proj-scout.md", dest: "C:/proj/.opencode/agent/forge-proj-scout.md", op: "update" }],
      gc: [],
      coverage: "full",
      summary: ["1 projection file"],
      findings: [],
    },
    findings: [],
  }
}

function syncApplyOk(seed = {}) {
  return {
    ok: true,
    action: "apply",
    outcome: seed.outcome ?? "applied",
    applied: seed.applied ?? true,
    path: seed.path ?? PATH,
    scope: seed.scope ?? "workspace",
    sessionID: seed.sessionID ?? null,
    created: [],
    updated: [{ nativeId: "forge-proj-scout", fileName: "forge-proj-scout.md" }],
    unchanged: [],
    gced: [],
    errors: [],
    removedIds: [],
    appliedStatus: {
      status: seed.status ?? "unconfirmed",
      observedBy: seed.observedBy ?? null,
      confirmedIds: [],
      removedConfirmedIds: [],
      unconfirmedIds: ["forge-proj-scout"],
    },
    conflicts: [],
    summary: [],
    findings: [],
    epoch: "ep-1",
    generation: 7,
    at: 9_000_002,
  }
}

function fakeRpc(seed = {}) {
  const calls = []
  let commitCount = 0
  let editOpenSeq = 0
  let tokSeq = 0
  // Each call records [name, req, opts] — opts is the official RPC options
  // bag (opts.location) the transport must always attach; existing
  // assertions index [0]/[1] and are untouched.
  const rpc = {
    calls,
    echo: async (req, opts) => {
      calls.push(["echo", req, opts])
      if (seed.echoFail) throw new Error("RPC is unavailable: echo")
      return { nonce: req?.nonce, pluginID: "forge", appVersion: seed.version ?? "2.4.2", epoch: "ep-1", generation: 7 }
    },
    editOpen: async (req, opts) => {
      calls.push(["editOpen", req, opts])
      if (seed.editOpenFail) throw new Error("editOpen failed")
      return editOpenOk({ ...seed, snapshotId: seed.snapshotId ?? `snap-${++editOpenSeq}` })
    },
    prepare: async (req, opts) => {
      calls.push(["prepare", req, opts])
      if (seed.prepareFail) return { ok: false, reason: seed.prepareFailReason ?? "invalid-draft", message: seed.prepareFailMsg ?? "refused" }
      return {
        ok: true,
        outcome: "token",
        token: { token: seed.token ?? `tok-${++tokSeq}`, expiresAt: 9_000_000, epoch: "ep-1", generation: 7 },
        preview: previewOf(req, seed),
        findings: [],
      }
    },
    commit: async (req, opts) => {
      calls.push(["commit", req, opts])
      commitCount++
      if (seed.commitThrows && (seed.commitThrowMax === undefined || commitCount <= seed.commitThrowMax)) throw new Error("connection lost")
      if (seed.commitScopeMismatch && req.sessionID !== (seed.commitSessionID ?? "sess-1")) {
        return { ok: false, reason: "scope-mismatch", message: "confirmed scope no longer matches" }
      }
      if (seed.commitFail) return { ok: false, reason: seed.commitFailReason ?? "epoch-stale", message: "stale" }
      return { ok: true, receipt: receiptOf(req, seed) }
    },
    receipt: async (req, opts) => {
      calls.push(["receipt", req, opts])
      return seed.receiptFound
        ? { found: true, receipt: receiptOf({ token: req?.token }, seed), epoch: "ep-1", generation: 7 }
        : { found: false, epoch: "ep-1", generation: 7 }
    },
    sync: async (req, opts) => {
      calls.push(["sync", req, opts])
      if (seed.syncFail) return { ok: false, action: req.action ?? "unknown", reason: "unavailable", message: seed.syncFailMsg ?? "sync failed" }
      if (req.action === "prepare") return seed.syncNoop ? { ok: true, action: "prepare", outcome: "noop", summary: [], findings: [], preview: { ...syncPrepareOk(seed).preview, files: [] } } : (seed.syncPrepare ?? syncPrepareOk(seed))
      return seed.syncApply ?? syncApplyOk(seed)
    },
  }
  rpc.commitCalls = () => calls.filter((c) => c[0] === "commit")
  return rpc
}

// Controllable fake clock for the readiness budget (the deadline must be
// reachable WITHOUT real time; sleepers wake only when the test advances).
// schedule(ms, cb) mirrors the product's cancellable-timer seam: callbacks
// fire on advance unless cancelled; cancel is idempotent and counted.
// sleep(ms) remains the POLL seam; its requested durations are recorded so
// the clamp (min(500, remaining)) is assertable.
function fakeClock() {
  let nowMs = 0
  const sleepers = []
  const timers = []
  let cancels = 0
  const sleepCalls = []
  return {
    now: () => nowMs,
    sleep: (ms) => {
      sleepCalls.push(ms)
      return new Promise((resolve) => {
        sleepers.push({ wakeAt: nowMs + ms, resolve })
      })
    },
    schedule: (ms, cb) => {
      const timer = { wakeAt: nowMs + ms, cb, cancelled: false }
      timers.push(timer)
      return () => {
        if (timer.cancelled) return // idempotent cancel
        timer.cancelled = true
        cancels++
      }
    },
    stats: () => ({ scheduled: timers.length, cancels, sleepCalls }),
    advance: async (ms) => {
      nowMs += ms
      const due = sleepers.filter((s) => s.wakeAt <= nowMs)
      for (const s of due) {
        const i = sleepers.indexOf(s)
        if (i >= 0) sleepers.splice(i, 1)
        s.resolve()
      }
      const timersDue = timers.filter((t) => !t.cancelled && t.wakeAt <= nowMs)
      for (const t of timersDue) t.cb()
      await new Promise((r) => setTimeout(r, 0)) // let the woken continuations run
    },
  }
}

function makeDeps(ui, rpc, opts = {}) {
  const deps = {
    ui,
    // S0 — REQUIRED by the readiness design: runEditor binds the transport
    // location to THIS anchor by value (never observedDirectory, never a
    // default fallback).
    initialScope: opts.initialScope ?? { kind: "home", anchor: "C:/proj", sessionID: null },
    client: {
      plugin: {
        // Readiness poll: script a queue of answers via opts.pluginList
        // (values, throwables or `never` for an eternally pending promise).
        // EVERY poll call is recorded WITH its requested location — the
        // flow-level S0.anchor pin lives HERE (the six-method opts bag is
        // attached by buildRpcTransport and pinned at the adapter layer).
        list:
          opts.pluginList === undefined
            ? async (req) => {
                if (opts.pluginListCalls) opts.pluginListCalls.push(req?.location?.directory ?? null)
                return { data: [{ id: "forge", features: { server: true, tui: true }, state: { status: "active" } }] }
              }
            : async (req) => {
                if (opts.pluginListCalls) opts.pluginListCalls.push(req?.location?.directory ?? null)
                const next = Array.isArray(opts.pluginList) ? opts.pluginList.shift() : opts.pluginList
                if (next === "never") return new Promise(() => {})
                if (next instanceof Error) throw next
                return typeof next === "function" ? next(req) : next
              },
      },
      session: { get: async ({ sessionID }) => ({ id: sessionID, location: { directory: "C:/sess" } }) },
      command: { list: async () => ({ data: [] }) },
    },
    data: {
      location: {
        provider: { sync: async () => {}, list: () => [] },
        model: { sync: async () => {}, list: () => [] },
        default: () => ({ directory: "C:/proj" }),
      },
      // opts.events (if given) captures the live handlers so a test can fire
      // real connection events at the flow.
      on: (event, fn) => {
        if (opts.events) opts.events[event] = fn
        return () => {}
      },
    },
    rpc,
    // Re-verification seam: opts.scope may be a VALUE or a FUNCTION (for
    // scripted sequences — e.g. an anchor that moves during readiness).
    sessionScope: async () =>
      (typeof opts.scope === "function" ? opts.scope() : opts.scope) ?? {
        sessionID: null,
        anchor: "C:/proj",
        kind: "home",
      },
    pluginId: "forge",
    // Clock injection: real setTimeout + Date.now are the fallbacks; the
    // readiness tests inject a controllable fake clock (or a raw sleep
    // override, e.g. a rejecting sleep for the fail-closed counterexample).
    sleep: opts.sleep ?? (opts.clock ? opts.clock.sleep : async () => {}),
    now: opts.clock ? opts.clock.now : undefined,
    schedule: opts.clock ? opts.clock.schedule : undefined,
  }
  return deps
}

const EDIT_SCOUT = ["worker:scout", "prompt", "replace", "__TEXT__", "back"]

// Fill a script's prompt text in place of __TEXT__.
function editScript(text, tail = []) {
  return EDIT_SCOUT.map((s) => (s === "__TEXT__" ? text : s)).concat(tail)
}

// ---------------------------------------------------------------------------
// Zero-write on unprovable transport
// ---------------------------------------------------------------------------

test("unprovable RPC transport (echo fails): zero prepare/commit/sync, refusal disclosed", async () => {
  const rpc = fakeRpc({ echoFail: true })
  const { ui, toasts, calls } = scriptedUi([undefined])
  await createForgeConfigEditor(makeDeps(ui, rpc)).open("C:/proj")
  const kinds = rpc.calls.map((c) => c[0])
  assert.ok(!kinds.includes("prepare") && !kinds.includes("commit") && !kinds.includes("sync"), `no write/sync may happen — saw: ${kinds}`)
  assert.ok(toasts.some((t) => t.variant === "error" && /unprovable|echo failed/i.test(t.message)), "the broken transport is disclosed")
})

// Screenshot defect: an echo rejection that is a NON-Error (a plain SDK
// error object) must still be disclosed READABLY (its code/message, never
// "[object Object]") — and the transport stays fail-closed: zero reads
// beyond the echo itself, zero writes/syncs.
test("echo rejects with a plain {code,message} object: the toast is readable (code + message, never '[object Object]') and the transport stays fail-closed (zero editOpen/prepare/commit/sync)", async () => {
  const rpc = fakeRpc({})
  const origEcho = rpc.echo
  rpc.echo = () => Promise.reject({ code: "E_UPSTREAM", message: "upstream forge unreachable" })
  const { ui, toasts, calls } = scriptedUi([undefined])
  await createForgeConfigEditor(makeDeps(ui, rpc)).open("C:/proj")
  const disclosed = toasts.map((t) => `${t.title ?? ""} ${t.message ?? ""}`).join("\n")
  assert.ok(!disclosed.includes("[object Object]"), `the rejection is never "[object Object]" — toasts: ${JSON.stringify(toasts).slice(0, 500)}`)
  assert.ok(
    disclosed.includes("E_UPSTREAM") && disclosed.includes("upstream forge unreachable"),
    `the code and message are readable in the disclosure — toasts: ${JSON.stringify(toasts).slice(0, 500)}`,
  )
  const kinds = rpc.calls.map((c) => c[0])
  assert.ok(!kinds.includes("editOpen"), `zero editOpen on the unprovable transport — saw: ${kinds}`)
  assert.ok(!kinds.includes("prepare") && !kinds.includes("commit") && !kinds.includes("sync"), `zero writes/syncs — saw: ${kinds}`)
  assert.ok(toasts.some((t) => t.variant === "error"), "the failure is disclosed as an error")
})

// ---------------------------------------------------------------------------
// Save happy path + reviewer item 3: written receipt with sync:null must
// auto-enter the FIRST sync prepare with its explicit preview confirmation
// (not merely point at a retry option).
// ---------------------------------------------------------------------------

test("save: prepare references the editOpen snapshot handle, commit only after explicit confirm; written sync:null auto-enters the first sync prepare+confirm", async () => {
  const rpc = fakeRpc()
  const { ui, toasts, calls } = scriptedUi([
    ...editScript("new prompt text"),
    "__save__",
    true, // confirm Save & Sync preview
    true, // confirm the AUTO first-sync projection preview (second confirm)
    undefined, // close
    true, // the draft honestly stays pending (no per-entry verdict) — discard to quit
  ])
  await createForgeConfigEditor(makeDeps(ui, rpc)).open("C:/proj")
  const prepareCall = rpc.calls.find((c) => c[0] === "prepare")
  const editOpenCall = rpc.calls.find((c) => c[0] === "editOpen")
  assert.ok(editOpenCall, "the flow opens a server snapshot first")
  assert.ok(prepareCall, "save goes through prepare")
  // The canned editOpen output carries snapshotId "snap-1" (editOpenOk) —
  // prepare must reference THAT handle, proving no fresh local read happened.
  assert.equal(prepareCall[1].snapshotId, "snap-1", "prepare references the edit-open handle — never a fresh local read")
  const commits = rpc.calls.filter((c) => c[0] === "commit")
  assert.equal(commits.length, 1)
  assert.equal(commits[0][1].confirm, true, "the commit carries the explicit human confirmation")
  const syncs = rpc.calls.filter((c) => c[0] === "sync")
  assert.ok(syncs.length >= 2, `a written receipt with sync:null must auto-run the first sync prepare+apply — saw: ${JSON.stringify(syncs.map((s) => s[1]))}`)
  assert.equal(syncs[0][1].action, "prepare")
  assert.equal(syncs[0][1].confirm, false, "the sync prepare leg is a pure read (confirm:false, no token)")
  assert.equal(syncs[0][1].token, undefined)
  assert.equal(syncs[1][1].action, "apply")
  assert.equal(syncs[1][1].confirm, true, "the sync apply leg carries the explicit confirmation")
  assert.equal(syncs[1][1].token, "synctok-1", "the sync apply uses the sync-dedicated token")
  const saveConfirm = calls.find((c) => c.kind === "confirm" && /already SAVED/i.test(c.args?.message ?? ""))
  assert.ok(saveConfirm !== undefined, `the sync preview confirm carries the saved receipt's verdict (no stacked pre-toast) — confirms: ${JSON.stringify(calls.filter((c) => c.kind === "confirm").map((c) => c.args?.title))}`)
  assert.ok(toasts.some((t) => /Forge: Sync receipt/i.test(`${t.title ?? ""}`) && /sync: (applied|failed|unconfirmed)/i.test(`${t.message ?? ""}`)), `the final short sync receipt toast is surfaced — toasts: ${JSON.stringify(toasts).slice(0, 800)}`)
})

// ---------------------------------------------------------------------------
// Reviewer item 1: the authoritative session moves session→home between
// prepare and confirm — no commit restating the stale sessionID, disclosed.
// ---------------------------------------------------------------------------

test("scope moved session→home between prepare and confirm: no commit with the stale scope, disclosed", async () => {
  const rpc = fakeRpc()
  let flips = 0
  const { ui, toasts, calls } = scriptedUi([
    ...editScript("moved text"),
    "__save__",
    true, // confirm the preview (the refusal happens at the commit re-check)
    undefined, // Esc after the refusal
    true, // discard the kept pending draft to quit
  ])
  const deps = makeDeps(ui, rpc)
  deps.sessionScope = async () => {
    flips++
    return flips <= 2 // open(1) + save re-verify(2) still session; commit re-check(3) sees home
      ? { sessionID: "sess-1", anchor: "C:/sess", kind: "session" }
      : { sessionID: null, anchor: "C:/proj", kind: "home" }
  }
  await createForgeConfigEditor(deps).open("C:/proj")
  const commits = rpc.commitCalls()
  assert.ok(commits.every((c) => c[1].sessionID !== "sess-1"), "no commit may carry the stale sessionID")
  assert.ok(toasts.some((t) => /refus|session changed|scope/i.test(JSON.stringify(t))), "the stale-scope refusal is disclosed")
  assert.ok(!rpc.calls.some((c) => c[0] === "sync"), "a refused save never triggers sync")
})

// ---------------------------------------------------------------------------
// Reviewer item 4 (independent retry, sync typed v2): after a WRITTEN save
// whose sync was not reported, the retry is sync prepare (pure read, no
// token) → explicit preview confirm → apply with the SYNC token + commitId.
// The recipe commit is never re-run and the saved patch is never replayed.
// ---------------------------------------------------------------------------

test("retry sync after a written receipt: independent sync prepare/preview/confirm with a sync token — recipe committed exactly once, old patch never replayed", async () => {
  const rpc = fakeRpc({ syncPrepare: syncPrepareOk({ syncToken: "synctok-r1" }) })
  const { ui, toasts, calls } = scriptedUi([
    ...editScript("retry text"),
    "__save__",
    true, // confirm save (receipt written, sync:null → auto first sync)
    false, // CANCEL the auto first sync at its projection-preview confirm
    "__retry-sync__", // the independent retry entry on the refreshed list
    true, // confirm the FRESH sync preview
    undefined, // close
    true, // the draft honestly stays pending — discard to quit
  ])
  await createForgeConfigEditor(makeDeps(ui, rpc)).open("C:/proj")
  assert.ok(toasts.some((t) => /sync|cancel/i.test(JSON.stringify(t))), "the sync outcome (and the cancelled auto leg) is surfaced")
  const commits = rpc.commitCalls()
  assert.equal(commits.length, 1, "the retry NEVER re-runs the recipe commit (no patch replay)")
  const syncs = rpc.calls.filter((c) => c[0] === "sync")
  assert.ok(syncs.length === 3, `cancelled auto + retry = prepare, prepare, apply — saw ${syncs.length}: ${JSON.stringify(syncs.map((x) => x[1].action))}`)
  assert.equal(syncs[0][1].action, "prepare", "the cancelled auto leg got as far as its pure-read prepare")
  assert.equal(syncs[1][1].action, "prepare")
  assert.equal(syncs[2][1].action, "apply")
  assert.equal(syncs[1][1].confirm, false, "the retry prepare is a pure read")
  assert.equal(syncs[1][1].token, undefined, "the sync prepare carries no commit token")
  assert.equal(syncs[2][1].confirm, true)
  assert.equal(syncs[2][1].token, "synctok-r1", "the apply confirms the SYNC-dedicated token (never the commit token)")
  // ACTUAL commitId/target consistency across the retry's two legs (and the
  // cancelled auto leg — it also binds the saved receipt).
  assert.equal(syncs[0][1].commitId, "c-1", "even the cancelled auto prepare binds the saved receipt's commitId")
  assert.equal(syncs[1][1].commitId, "c-1", "the retry prepare binds the saved receipt's commitId")
  assert.equal(syncs[2][1].commitId, "c-1", "the apply correlates to the saved receipt via commitId")
  assert.equal(syncs[1][1].commitId, syncs[2][1].commitId, "prepare and apply carry the SAME commitId")
  assert.equal(syncs[1][1].scope, "workspace", "the prepare leg restates the saved target scope")
  assert.equal(syncs[2][1].scope, syncs[1][1].scope, "prepare and apply target the SAME scope")
  assert.notEqual(syncs[2][1].token, commits[0][1].token, "sync token ≠ commit token")
})

// ---------------------------------------------------------------------------
// Reviewer item 2: a saved WORKSPACE receipt then a view switch to global —
// the sync retry must still restate the SAVED workspace target, never the
// currently-viewed scope.
// ---------------------------------------------------------------------------

test("workspace save then switch to global view: the sync retry still targets the saved workspace scope", async () => {
  const rpc = fakeRpc()
  const { ui } = scriptedUi([
    ...editScript("ws text"),
    "__save__",
    true, // save confirm (receipt written, sync:null → retry offered)
    false, // CANCEL the auto first sync at its projection-preview confirm
    "__switch__", // user browses the global view afterwards
    true, // the draft honestly stays pending — discard it to switch
    undefined, // close in the global view
  ])
  await createForgeConfigEditor(makeDeps(ui, rpc)).open("C:/proj")
  const syncs = rpc.calls.filter((c) => c[0] === "sync")
  assert.ok(syncs.length >= 1, `the saved workspace save must enter the sync path (auto or retried) even after switching views — saw ${syncs.length} sync call(s)`)
  const retryAfterSwitch = syncs.filter((s) => s[1].scope !== "workspace")
  assert.equal(retryAfterSwitch.length, 0, `a workspace save's sync (auto or retried after switching) must restate the saved workspace scope — saw: ${JSON.stringify(syncs.map((s) => s[1].scope))}`)
})

// ---------------------------------------------------------------------------
// ctrl+d delete discipline (F2): the action trigger asks an explicit
// confirmation naming the identity; cancel never prepares/commits; a
// confirmed delete is disclosed as pending, never written directly.
// ---------------------------------------------------------------------------

// Official CtrlD fake semantics: onTrigger records the delete target and
// the flow closes the select via the PUBLIC ui.clear() — the action trigger
// itself never auto-closes the dialog, and clear() resolves the open select
// (undefined). The fake's clear() is the only closer.
test("list binds ctrl+d delete: confirmation names the identity, cancel never prepares/commits", async () => {
  const rpc = fakeRpc()
  const { ui, calls, toasts } = scriptedUi([
    async ({ args }) => {
      const del = args.actions?.find((a) => a.bind === "ctrl+d")
      assert.ok(del, "the list exposes a ctrl+d delete action")
      void del.onTrigger("worker:scout") // the PRODUCT's own ui.clear() closes the list
      return PENDING_CLEAR
    },
    false, // CANCEL the delete confirm
    undefined, // quit (nothing pending — no guard)
  ])
  await createForgeConfigEditor(makeDeps(ui, rpc)).open("C:/proj")
  const confirmCalls = calls.filter((c) => c.kind === "confirm")
  assert.ok(confirmCalls.length >= 1, "deletion asks for explicit confirmation")
  assert.match(JSON.stringify(confirmCalls[0].args), /scout/, "the confirmation names the entry identity")
  assert.equal(rpc.calls.filter((c) => c[0] === "commit").length, 0, "a cancelled delete never reaches commit")
  assert.equal(rpc.calls.filter((c) => c[0] === "prepare").length, 0, "a cancelled delete never prepares")
  assert.ok(toasts.length === 0 || !/pending/i.test(JSON.stringify(toasts)), "a cancelled delete leaves no pending state")
})

test("saved sync CANCELLED then an unsaved ctrl+d delete: the retry entry survives (never loses the saved-retry state)", async () => {
  const rpc = fakeRpc()
  const { ui } = scriptedUi([
    ...editScript("retry-survival text"),
    "__save__",
    true, // save confirm (receipt written, auto first sync)
    false, // CANCEL the auto first sync — retry entry stays (lastSaveFailed)
    async ({ args }) => {
      const del = args.actions?.find((a) => a.bind === "ctrl+d")
      assert.ok(del, "the list exposes a ctrl+d delete action")
      void del.onTrigger("worker:scout") // product's own clear closes the list
      return PENDING_CLEAR
    },
    true, // confirm the UNSAVED delete (stays a pending draft)
    async ({ args }) => {
      const values = (args.options ?? []).map((o) => o.value)
      assert.ok(values.includes("__retry-sync__"), `the retry entry SURVIVES the unsaved delete — options: ${JSON.stringify(values)}`)
      return undefined // quit
    },
    true, // discard pending to quit
  ])
  await createForgeConfigEditor(makeDeps(ui, rpc)).open("C:/proj")
})

test("confirmed ctrl+d delete stays a PENDING draft: disclosed in the list, written only via Save & Sync", async () => {
  const rpc = fakeRpc()
  const { ui, calls } = scriptedUi([
    async ({ args }) => {
      const del = args.actions.find((a) => a.bind === "ctrl+d")
      void del.onTrigger("worker:scout") // the PRODUCT's own ui.clear() closes the list
      return PENDING_CLEAR
    },
    true, // confirm the delete (the list re-renders with the pending row)
    undefined, // Esc — the discard guard asks
    true, // discard to quit
  ])
  await createForgeConfigEditor(makeDeps(ui, rpc)).open("C:/proj")
  const listTitles = calls.filter((c) => c.kind === "select").map((c) => c.args.title)
  assert.ok(listTitles.some((t) => /1 pending change/.test(t)), `the pending deletion is disclosed in the list title — titles: ${JSON.stringify(listTitles)}`)
  assert.equal(rpc.calls.filter((c) => c[0] === "commit").length, 0, "the delete confirmation itself never writes")
  const discardGuard = calls.find((c) => c.kind === "confirm" && /Discard pending/.test(c.args.title))
  assert.ok(discardGuard, "Esc with a pending deletion asks before discarding")
})

// ---------------------------------------------------------------------------
// Reviewer item 5: an absent-but-creatable workspace — declaring the pool
// keeps the first worker save alive with the pool attached to the batch.
// ---------------------------------------------------------------------------

test("missing workspace: pending pool + a new worker save prepare a create-file batch carrying the declared pool", async () => {
  const rpc = fakeRpc({ exists: false, createFile: true, oldText: null })
  const { ui, toasts, calls } = scriptedUi([
    "__create-pool__",
    true, // create-file warning confirm
    "proj", // pool name prompt
    "__new-worker__",
    "scout", // worker id prompt
    "auto", // model mode (Auto)
    "__save__",
    true, // confirm the creation preview
    true, // confirm the AUTO first-sync projection preview (second confirm)
    undefined, // close
    true, // the draft honestly stays pending — discard to quit
  ])
  await createForgeConfigEditor(makeDeps(ui, rpc)).open("C:/proj")
  const prepareCall = rpc.calls.find((c) => c[0] === "prepare")
  assert.ok(prepareCall, "the first save prepares against the absent file")
  assert.ok(prepareCall[1].ops.some((op) => op.action === "create" && op.pool === "proj"), `the declared pool rides the worker op — ops: ${JSON.stringify(prepareCall[1].ops)}`)
  assert.equal(rpc.commitCalls().length, 1, "the confirmed creation commits once")
  const saveConfirm = calls.find((c) => c.kind === "confirm" && /already SAVED/i.test(c.args?.message ?? ""))
  assert.ok(saveConfirm !== undefined, `the sync preview confirm carries the saved creation's verdict (no stacked pre-toast) — confirms: ${JSON.stringify(calls.filter((c) => c.kind === "confirm").map((c) => c.args?.title))}`)
  assert.ok(toasts.some((t) => /Forge: Sync receipt/i.test(`${t.title ?? ""}`)), `the final short sync receipt toast is surfaced — toasts: ${JSON.stringify(toasts).slice(0, 600)}`)
})

// ---------------------------------------------------------------------------
// Pending pool draft discard
// ---------------------------------------------------------------------------

test("a new-worker ghost row disappears after an explicit discard (never lingers in the list)", async () => {
  const rpc = fakeRpc()
  const { ui } = scriptedUi([
    async ({ args }) => {
      const values = (args.options ?? []).map((o) => o.value)
      assert.ok(!values.includes("worker:ghost1"), "no ghost before it exists")
      return "__new-worker__"
    },
    "ghost1", // worker id prompt
    "auto", // model mode
    async ({ args }) => {
      const values = (args.options ?? []).map((o) => o.value)
      assert.ok(values.includes("worker:ghost1"), `the pending ghost row is visible — options: ${JSON.stringify(values)}`)
      return "__discard__"
    },
    true, // confirm the discard
    async ({ args }) => {
      const values = (args.options ?? []).map((o) => o.value)
      assert.ok(!values.includes("worker:ghost1"), `the ghost row is GONE after the discard — options: ${JSON.stringify(values)}`)
      return undefined // quit (nothing pending — no guard)
    },
  ])
  await createForgeConfigEditor(makeDeps(ui, rpc)).open("C:/proj")
})

test("a pending new-pool draft is discarded on explicit discard: the later scope switch carries no pending state into a commit", async () => {
  const rpc = fakeRpc({ exists: false })
  const { ui, calls } = scriptedUi([
    "__create-pool__",
    true,
    "proj",
    "__switch__", // attempt scope switch with a pending pool declaration
    true, // discard
    undefined, // close in the other scope — nothing pending, no guard
  ])
  await createForgeConfigEditor(makeDeps(ui, rpc)).open("C:/proj")
  assert.ok(calls.some((c) => c.kind === "confirm" && /Discard pending/.test(c.args.title)), "the switch-time discard ask fired")
  assert.equal(rpc.calls.filter((c) => c[0] === "prepare").length, 0, "a discarded pool draft is never prepared")
  assert.equal(rpc.commitCalls().length, 0, "a discarded pool draft never commits")
})

// ---------------------------------------------------------------------------
// Override and same-name worker are independent containers (F4)
// ---------------------------------------------------------------------------

test("creating override general while a worker named general exists prepares BOTH entries (no false collision)", async () => {
  const rpc = answerPerContractAt(fakeRpc({
    raw: '{ "pool": "proj", "agents": { "general": {} } }',
    doc: { pool: "proj", agents: { general: {} } },
  }), "C:/proj")
  const { ui } = scriptedUi([
    "__switch__", // the global view (overrides live there)
    "__new-override__",
    "general",
    "auto", // model mode
    "__save__",
    true,
    true, // confirm the AUTO first-sync projection preview (second confirm)
    undefined,
    true, // the draft honestly stays pending — discard to quit
  ])
  await createForgeConfigEditor(makeDeps(ui, rpc)).open("C:/proj")
  const prepareCall = rpc.calls.find((c) => c[0] === "prepare")
  assert.ok(prepareCall, "the override activation reaches prepare")
  const ops = prepareCall[1].ops
  assert.ok(ops.some((op) => op.kind === "override" && op.id === "general"), `override.general is prepared — ops: ${JSON.stringify(ops)}`)
  assert.ok(!ops.some((op) => op.kind === "worker"), "the existing worker general is not touched (per-container dedup)")
})

// ---------------------------------------------------------------------------
// Reviewer item 8: no-op receipt + a rejected entry — the rejected draft
// stays pending and its refusal is disclosed (never silently dropped).
// ---------------------------------------------------------------------------

test("no-op outcome with a rejected entry: the rejected draft stays pending and the refusal is disclosed", async () => {
  const rpc = fakeRpc({ prepareFail: true, prepareFailReason: "no-valid-entries", prepareFailMsg: "worker scout rejected: duplicate" })
  const { ui, calls, toasts } = scriptedUi([
    "__new-worker__",
    "scout",
    "auto",
    "__save__",
    undefined, // Esc after the refusal disclosure
    true, // discard pending to quit
  ])
  await createForgeConfigEditor(makeDeps(ui, rpc)).open("C:/proj")
  assert.ok(toasts.some((t) => /REFUS|reject|duplicate/i.test(JSON.stringify(t))), `the refusal is disclosed — toasts: ${JSON.stringify(toasts)}`)
  assert.equal(rpc.commitCalls().length, 0, "a fully-refused batch never commits")
  const discardGuard = calls.find((c) => c.kind === "confirm" && /Discard pending/.test(c.args.title))
  assert.ok(discardGuard, "the rejected draft stays pending (the quit guard still sees it)")
})

// ---------------------------------------------------------------------------
// Precise observability: the receipt names per-entry outcomes; an unchanged
// entry is never reported applied.
// ---------------------------------------------------------------------------

test("receipt surfacing: per-entry outcomes are reachable in the receipt detail and an unchanged entry is never reported applied", async () => {
  const rpc = fakeRpc({
    entries: [
      { opId: "worker:update:scout", id: "scout", kind: "worker", action: "update", entryKind: "patch", outcome: "written", summary: ["prompt updated"], findings: [] },
      { opId: "worker:update:scribe", id: "scribe", kind: "worker", action: "update", entryKind: "no-op", outcome: "no-op", summary: ["already matches"], findings: [] },
    ],
  })
  const { ui, toasts } = scriptedUi([
    ...editScript("observability text"),
    "__save__",
    true,
    true, // confirm the AUTO first-sync projection preview (second confirm)
    "__receipt-detail__", // per-entry outcomes live behind the on-demand detail browse
    ({ args }) => {
      const page = JSON.stringify(args)
      assert.match(page, /scout/, `the changed entry is named in the receipt detail — page: ${page.slice(0, 500)}`)
      assert.ok(/no-op|unchanged/i.test(page), `the unchanged entry's honest outcome is surfaced — page: ${page.slice(0, 500)}`)
      const at = page.indexOf("scribe")
      const around = at === -1 ? "" : page.slice(Math.max(0, at - 40), at + 160)
      const readsApplied = /applied/i.test(around) && !/unconfirmed|no-op|unchanged/i.test(around)
      assert.ok(!readsApplied, `the unchanged entry must not read as applied — context: ${around || page}`)
      return undefined // close the browse
    },
    undefined, // quit
  ])
  await createForgeConfigEditor(makeDeps(ui, rpc)).open("C:/proj")
  assert.ok(toasts.some((t) => /Forge: Sync receipt/i.test(`${t.title ?? ""}`)), `the short sync receipt toast is surfaced — toasts: ${JSON.stringify(toasts).slice(0, 500)}`)
})

// ---------------------------------------------------------------------------
// Commit outcome UNKNOWN (response lost, no receipt): disclosed honestly,
// drafts kept, and the NEXT Save & Sync must re-prepare against a FRESH
// snapshot — the lost token/patch is never replayed.
// ---------------------------------------------------------------------------

test("UNKNOWN x2 (original Auto/readonly, external prov/new@high/write, user prompt-only): every post-external prepare carries the COMPLETE fresh-based pin/shape/thought — never a revert, never a false conflict", async () => {
  const rpc = fakeRpc({ commitThrows: true, receiptFound: false })
  // ORIGINAL base: Auto (no pin) + readonly. From the reopen onward the
  // server document carries the EXTERNAL pin prov/new@high + write —
  // the fresh snapshot is the base of truth for every later draft.
  const origEditOpen = rpc.editOpen
  let opens = 0
  rpc.editOpen = async (req) => {
    opens++
    const r = await origEditOpen(req)
    if (opens >= 2) {
      const ext = { pool: "proj", agents: { scout: { model: "prov/new", thoughtLevel: "high", shape: "write" } } }
      return { ...r, raw: JSON.stringify(ext), document: ext }
    }
    return r
  }
  const { ui, toasts, calls } = scriptedUi([
    ...editScript("lost text"),
    "__save__",
    true, // UNKNOWN #1 (commit response lost, no receipt)
    "__save__",
    true, // confirm the FRESH preview
    undefined, // Esc after the second reopen
    true, // drafts honestly pending — discard to quit
  ])
  await createForgeConfigEditor(makeDeps(ui, rpc)).open("C:/proj")
  const unknownToasts = toasts.filter((t) => /UNKNOWN/i.test(t.message ?? JSON.stringify(t)))
  assert.ok(unknownToasts.length >= 2, `BOTH UNKNOWN outcomes are disclosed — toasts: ${JSON.stringify(toasts).slice(0, 400)}`)
  assert.ok(toasts.every((t) => !/conflict/i.test(t.message ?? JSON.stringify(t))), `an UNKNOWN is never worded as a conflict — toasts: ${JSON.stringify(toasts).slice(0, 400)}`)
  const prepares = rpc.calls.filter((c) => c[0] === "prepare")
  assert.ok(prepares.length >= 2, `initial + post-UNKNOWN prepares — saw ${prepares.length}`)
  for (const idx of prepares.slice(1).map((_, i) => i + 1)) {
    const scoutOps = prepares[idx][1].ops.filter((op) => op.id === "scout")
    assert.equal(scoutOps.length, 1, `prepare #${idx + 1}: exactly one scout op — ${JSON.stringify(prepares[idx][1].ops)}`)
    const d = scoutOps[0].draft ?? {}
    // EntryDraft.mode is REQUIRED — a complete draft is legal; what is
    // illegal is any field that does not MATCH the fresh external base.
    assert.equal(d.mode, "pinned", `prepare #${idx + 1}: the draft mode must carry the FRESH external pin, not the stale Auto — ${JSON.stringify(d)}`)
    assert.equal(d.model, "prov/new", `prepare #${idx + 1}: the draft model must be the fresh external pin — ${JSON.stringify(d)}`)
    assert.equal(d.thoughtLevel, "high", `prepare #${idx + 1}: the thought rides the atomic pin group at the fresh value — ${JSON.stringify(d)}`)
    assert.equal(d.shape, "write", `prepare #${idx + 1}: the draft shape must be the fresh external shape — ${JSON.stringify(d)}`)
    assert.equal(d.prompt, "lost text", `prepare #${idx + 1}: the prompt-only diff is the user's — ${JSON.stringify(d)}`)
    assert.ok(!JSON.stringify(scoutOps).includes("prov/m"), `no stale pin anywhere in prepare #${idx + 1} — ${JSON.stringify(scoutOps)}`)
  }
})

// The user REALLY changes the pin (prov/u@high); the server document
// changes externally while the first commit is UNKNOWN — to the SAME pin
// value (no conflict, the save completes) and to a DIFFERENT value (the
// collision must be CONFIRMED, never silently written over).
test("user pins prov/u@high; external changes to the SAME pin while UNKNOWN: the retry saves with zero conflict", async () => {
  const rpc = fakeRpc({ commitThrows: true, commitThrowMax: 1, receiptFound: false })
  const origEditOpen = rpc.editOpen
  let opens = 0
  rpc.editOpen = async (req) => {
    opens++
    const r = await origEditOpen(req)
    if (opens >= 2) {
      const ext = { pool: "proj", agents: { scout: { model: "prov/u", thoughtLevel: "high", shape: "write" } } }
      return { ...r, raw: JSON.stringify(ext), document: ext }
    }
    return r
  }
  const { ui, toasts, calls } = scriptedUi([
    "worker:scout", "mode", "pinned", "prov/u", "level:high", "back",
    "__save__",
    true, // Save & Sync confirm
    "__save__", // retry against the fresh EXTERNAL doc (pin prov/u — same value)
    true, // confirm the FRESH preview (same-value rebase is silent the 2nd time)
    true, // auto first-sync projection confirm
    AUTO_TAIL, // quit — the post-receipt re-render count is flow-internal
  ])
  await createForgeConfigEditor(makeDeps(ui, rpc)).open("C:/proj")
  const prepares = rpc.calls.filter((c) => c[0] === "prepare")
  assert.ok(prepares.length >= 2, `the retry re-prepares — ${prepares.length}`)
  const lastOps = prepares[prepares.length - 1][1].ops.filter((op) => op.id === "scout")
  const d = lastOps[0]?.draft ?? {}
  assert.equal(d.mode, "pinned", `the user's real pin survives the fresh base — ${JSON.stringify(d)}`)
  assert.equal(d.model, "prov/u", `same-value external pin: no conflict, the draft keeps prov/u — ${JSON.stringify(d)}`)
  assert.equal(d.thoughtLevel, "high", `the atomic thought rides the pin — ${JSON.stringify(d)}`)
  assert.ok(toasts.every((t) => !/conflict/i.test(t.message ?? JSON.stringify(t))), `a same-value external change is NOT a conflict — toasts: ${JSON.stringify(toasts).slice(0, 400)}`)
  const commits = rpc.commitCalls()
  assert.equal(commits.length, 2, `the retry SAVED (exactly one thrown + one real commit) — ${commits.length}`)
})

test("user pins prov/u@high; external changes to a DIFFERENT pin while UNKNOWN: the collision is confirmed, never written over", async () => {
  const rpc = fakeRpc({ commitThrows: true, commitThrowMax: 1, receiptFound: false })
  const origEditOpen = rpc.editOpen
  let opens = 0
  rpc.editOpen = async (req) => {
    opens++
    const r = await origEditOpen(req)
    if (opens >= 2) {
      const ext = { pool: "proj", agents: { scout: { model: "prov/other", thoughtLevel: "low", shape: "write" } } }
      return { ...r, raw: JSON.stringify(ext), document: ext }
    }
    return r
  }
  const { ui, calls, toasts } = scriptedUi([
    "worker:scout", "mode", "pinned", "prov/u", "level:high", "back",
    "__save__",
    true, // Save & Sync confirm
    true, // the rebase ask — user confirms
    "__save__", // retry — the fresh external pin prov/other COLLIDES with the user's prov/u
    true, // confirm the FRESH preview
    true, // the collision ask — the user confirms (or cancels) EXPLICITLY
    undefined,
    true, // discard pending to quit
  ])
  await createForgeConfigEditor(makeDeps(ui, rpc)).open("C:/proj")
  const confirmCalls = calls.filter((c) => c.kind === "confirm")
  const collisionConfirm = confirmCalls.find((c) => /prov\/u|prov\/other|pin/i.test(JSON.stringify(c.args)))
  const conflictDisclosed = toasts.some((t) => /conflict|prov\/u|prov\/other/i.test(t.message ?? JSON.stringify(t)))
  assert.ok(
    collisionConfirm !== undefined || conflictDisclosed,
    `a differing external pin must be CONFIRMED (a dialog naming the collision) or refused with a disclosed conflict — confirms: ${JSON.stringify(confirmCalls.map((c) => c.args.title))}, toasts: ${JSON.stringify(toasts).slice(0, 500)}`,
  )
  // The differing external pin is never silently overwritten: at most ONE
  // commit ever carried the user's pin (the first, whose response was lost)
  // and no LATER commit ran without the collision being confirmed.
  const commits = rpc.commitCalls()
  assert.ok(commits.length <= 2, `no silent extra commits past the collision — ${commits.length}`)
})

// Reviewer regression R-UNK1: when the UNKNOWN auto-reopen ALSO fails, the
// pre-UNKNOWN document must still be preserved for the later manual reload's
// rebase — a `staleDoc === null` skip would leave the drafts on the ORIGINAL
// base and the next prepare would revert the fresh external pin/shape.
test("UNKNOWN with a FAILING auto-reopen: the manual Reload still rebases on the pre-UNKNOWN document — the retry prepare carries the fresh pin/shape, never a revert", async () => {
  const rpc = fakeRpc({ commitThrows: true, commitThrowMax: 1, receiptFound: false })
  const origEditOpen = rpc.editOpen
  let opens = 0
  rpc.editOpen = async (req) => {
    opens++
    if (opens === 2) throw new Error("editOpen failed (still down)") // the UNKNOWN auto-reopen
    const r = await origEditOpen(req)
    if (opens >= 3) {
      const ext = { pool: "proj", agents: { scout: { model: "prov/new", thoughtLevel: "high", shape: "write" } } }
      return { ...r, raw: JSON.stringify(ext), document: ext }
    }
    return r
  }
  const { ui, calls, toasts } = scriptedUi([
    ...editScript("lost text"),
    "__save__",
    true, // UNKNOWN #1 — and the auto-reopen fails too
    "__reload__", // the manual recovery once the connection recovers
    "__save__", // the retry after the fresh document is open
    true, // confirm the FRESH preview
    AUTO_TAIL, // the post-receipt tail re-render count is flow-internal
  ])
  await createForgeConfigEditor(makeDeps(ui, rpc)).open("C:/proj")
  assert.ok(
    toasts.some((t) => /fresh document open failed/i.test(t.message ?? "")),
    `the failed auto-reopen is disclosed — toasts: ${JSON.stringify(toasts).slice(0, 400)}`,
  )
  const prepares = rpc.calls.filter((c) => c[0] === "prepare")
  const lastPrepare = prepares[prepares.length - 1]
  assert.ok(lastPrepare !== undefined, "the retry prepared")
  const scoutOps = lastPrepare[1].ops.filter((op) => op.id === "scout")
  assert.equal(scoutOps.length, 1, `exactly one scout op — ${JSON.stringify(lastPrepare[1].ops)}`)
  const d = scoutOps[0].draft ?? {}
  // The manual reload's rebase must run against the PRESERVED pre-UNKNOWN
  // document: untouched fields adopt the fresh external pin/shape/thought.
  assert.equal(d.mode, "pinned", `the draft mode carries the FRESH external pin, not the stale Auto — ${JSON.stringify(d)}`)
  assert.equal(d.model, "prov/new", `the draft model is the fresh external pin (a staleDoc-null rebase skip would revert it) — ${JSON.stringify(d)}`)
  assert.equal(d.thoughtLevel, "high", `the thought rides the atomic pin group at the fresh value — ${JSON.stringify(d)}`)
  assert.equal(d.shape, "write", `the draft shape is the fresh external shape — ${JSON.stringify(d)}`)
  assert.equal(d.prompt, "lost text", `the prompt-only diff is still the user's — ${JSON.stringify(d)}`)
  assert.ok(!JSON.stringify(scoutOps).includes("prov/m"), `no stale pin anywhere in the retry prepare — ${JSON.stringify(scoutOps)}`)
  assert.ok(calls.some((c) => c.kind === "select" && (c.args?.options ?? []).some((o) => o.value === "__reload__")), "the manual Reload recovery is offered in the list")
})

// Reviewer regression R-CONN1: a same-epoch server.connected while the
// commit itself is in flight voids adjudication — the in-flight commit WAS
// already sent, so the product must never claim "this save wrote nothing";
// when the echo resolves, the returned receipt is NEVER consumed, ZERO new
// commits run, the drafts stay pending, and a fresh document is open.
test("same-epoch server.connected while the commit is in flight: the resolved old commit is never adjudicated — zero post-event commits, no false zero-writes claim, drafts stay pending", async () => {
  const rpc = fakeRpc({})
  const events = {}
  let eventFired = false
  const origCommit = rpc.commit
  let heldSeq = 0
  let releaseHeld = null
  let commitAfterEvent = false
  rpc.commit = async (req) => {
    if (eventFired) commitAfterEvent = true
    if (++heldSeq === 1) {
      rpc.calls.push(["commit", req]) // bookkeeping mirrors fakeRpc.commit
      return new Promise((resolve) => {
        releaseHeld = () => resolve({ ok: true, receipt: receiptOf(req, {}) })
      })
    }
    return origCommit(req)
  }
  const { ui, calls, toasts } = scriptedUi([
    ...editScript("held text"),
    "__save__",
    // Answer the Save & Sync confirm, then — while the commit hangs —
    // fire a SAME-EPOCH server.connected (the subscription is live; a
    // missing handler fails loudly, never ignored) and release the echo.
    () => {
      setTimeout(() => {
        assert.ok(typeof events["server.connected"] === "function", "the flow subscribed to server.connected")
        events["server.connected"]()
        eventFired = true
        Promise.resolve().then(() => Promise.resolve()).then(() => releaseHeld?.())
      }, 0)
      return true
    },
    AUTO_TAIL, // Esc / discard-quit — the tail is flow-internal
  ])
  await createForgeConfigEditor(makeDeps(ui, rpc, { events })).open("C:/proj")
  // Direct commit counter: exactly the ONE in-flight commit (sent BEFORE
  // the event) ever ran — zero commits are issued after the connection event.
  assert.equal(rpc.commitCalls().length, 1, `exactly the pre-event in-flight commit ran — ${rpc.commitCalls().length}`)
  assert.equal(commitAfterEvent, false, "ZERO commits were issued after the connection event")
  // The outcome is disclosed as UNADJUDICATED — never as a false "this save
  // wrote nothing": the in-flight write may or may not have landed.
  assert.ok(
    toasts.some((t) => /UNADJUDICATED/i.test(t.message ?? "")),
    `the unadjudicated outcome is disclosed — toasts: ${JSON.stringify(toasts).slice(0, 500)}`,
  )
  assert.ok(
    toasts.every((t) => !/nothing was written|zero writes/i.test(t.message ?? "")),
    `the in-flight save is never mis-called a zero-write — toasts: ${JSON.stringify(toasts).slice(0, 500)}`,
  )
  // The old receipt is never consumed (no receiptFlow, no sync start).
  assert.ok(
    toasts.every((t) => !/Save & Sync receipt/i.test(`${t.title ?? ""} ${t.message ?? ""}`)),
    `the old commit's receipt is never adjudicated after the connection event — toasts: ${JSON.stringify(toasts).slice(0, 500)}`,
  )
  // The drafts are still pending at quit (the discard guard fires).
  assert.ok(
    calls.some((c) => c.kind === "confirm" && /Discard pending changes\?/i.test(c.args?.title ?? "")),
    `the drafts are still pending after the released echo (the quit guard asks) — calls: ${JSON.stringify(calls.map((c) => `${c.kind}:${String(c.args?.title).slice(0, 60)}`))}`,
  )
})

// R-CONN1 companion (kept SEPARATE from the in-flight case below — the two
// windows have different guarantees): a same-epoch server.connected that
// lands during the commit's echo/session verification fires BEFORE the
// commit RPC is ever sent — the synchronous gate must void the token with
// ZERO commits (direct rpc.commit counter), drafts kept, fresh open.
test("server.connected during the commit's echo/session verification (pre-send): the gate voids the token with ZERO commits — direct counter, drafts kept", async () => {
  const rpc = fakeRpc({})
  const events = {}
  // The handler is armed ONLY for the commit window, and fires ONCE: the
  // product's connected handler itself awaits rpc.echo (flow.ts:1919), so
  // re-emitting on every echo would recurse connected→echo→connected until
  // the stack overflows (the PromiseRejectCallback RangeError). A real host
  // emits the event once; this fixture must too.
  let armed = false
  let fired = false
  const origEcho = rpc.echo
  rpc.echo = async (req) => {
    if (armed && !fired) {
      fired = true
      assert.ok(typeof events["server.connected"] === "function", "the flow subscribed to server.connected before the commit window")
      // Fires while commitFlow is awaiting the echo — strictly BEFORE any
      // commit send is possible.
      events["server.connected"]()
    }
    return origEcho(req)
  }
  const { ui, calls, toasts } = scriptedUi([
    ...editScript("gate text"),
    "__save__",
    // Arm AFTER the subscription exists (the list loop is live) and answer
    // the confirm — the commit's echo/session verification follows.
    () => {
      armed = true
      return true
    },
    AUTO_TAIL,
  ])
  await createForgeConfigEditor(makeDeps(ui, rpc, { events })).open("C:/proj")
  assert.equal(rpc.commitCalls().length, 0, `ZERO commits were sent — ${rpc.commitCalls().length}`)
  assert.ok(
    toasts.some((t) => /NOTHING was committed|VOID/i.test(t.message ?? "")),
    `the pre-send void is disclosed — toasts: ${JSON.stringify(toasts).slice(0, 500)}`,
  )
  assert.ok(
    calls.some((c) => c.kind === "confirm" && /Discard pending changes\?/i.test(c.args?.title ?? "")),
    `the drafts are still pending (the quit guard asks) — calls: ${JSON.stringify(calls.map((c) => `${c.kind}:${String(c.args?.title).slice(0, 60)}`))}`,
  )
})

// Leak leg L1 (resolve): commit throws → the same-epoch receipt lookup is
// pending → server.connected lands → the lookup resolves found:true with
// the OLD receipt. The old receipt must NEVER be consumed (no receiptFlow,
// the auto sync must never start) — direct counters, not toasts.
test("commit throw, receipt lookup pending, connected lands, lookup resolves found:true: the old receipt is never consumed and the auto sync never starts", async () => {
  const rpc = fakeRpc({ commitThrows: true, commitThrowMax: 1 })
  const events = {}
  let eventFired = false
  const origReceipt = rpc.receipt
  let receiptHeld = 0
  let releaseReceipt = null
  rpc.receipt = async (req) => {
    rpc.calls.push(["receipt", req])
    if (++receiptHeld === 1) {
      return new Promise((resolve) => {
        releaseReceipt = () => resolve({ found: true, receipt: receiptOf({ token: req.token }, {}), epoch: "ep-1", generation: 7 })
      })
    }
    return origReceipt(req)
  }
  const { ui, calls, toasts } = scriptedUi([
    ...editScript("leg1 text"),
    "__save__",
    // The commit threw; the receipt lookup now hangs. Fire a SAME-EPOCH
    // connected (the subscription is live by now — a missing handler fails
    // loudly, it is never ignored), then release the OLD receipt as
    // found:true.
    () => {
      setTimeout(() => {
        assert.ok(typeof events["server.connected"] === "function", "the flow subscribed to server.connected")
        events["server.connected"]()
        eventFired = true
        Promise.resolve().then(() => Promise.resolve()).then(() => releaseReceipt?.())
      }, 0)
      return true
    },
    AUTO_TAIL,
  ])
  await createForgeConfigEditor(makeDeps(ui, rpc, { events })).open("C:/proj")
  assert.equal(rpc.calls.filter((c) => c[0] === "receipt").length, 1, `the receipt lookup ran exactly once — ${rpc.calls.filter((c) => c[0] === "receipt").length}`)
  assert.equal(rpc.calls.filter((c) => c[0] === "sync").length, 0, `the auto sync NEVER started from the old receipt — sync calls: ${rpc.calls.filter((c) => c[0] === "sync").length}`)
  assert.ok(
    toasts.every((t) => !/Save & Sync receipt/i.test(`${t.title ?? ""} ${t.message ?? ""}`)),
    `the old found:true receipt is never consumed — toasts: ${JSON.stringify(toasts).slice(0, 500)}`,
  )
  assert.ok(
    calls.some((c) => c.kind === "confirm" && /Discard pending changes\?/i.test(c.args?.title ?? "")),
    `the drafts are still pending (the quit guard asks) — calls: ${JSON.stringify(calls.map((c) => `${c.kind}:${String(c.args?.title).slice(0, 60)}`))}`,
  )
})

// Leak leg L2 (resolve): the sync APPLY is in flight → server.connected
// lands → the apply resolves ok/applied. The old apply result must not be
// adjudicated: the retry entry stays visible and the retry prepare is a
// FRESH prepare bound to the saved receipt's commitId — direct rpc counts.
test("connected while the sync apply is in flight, the apply then resolves ok: the old applied result is not adjudicated — the retry entry survives and the retry prepare is fresh", async () => {
  const rpc = fakeRpc({})
  const events = {}
  let eventFired = false
  const origSync = rpc.sync
  let applyHeld = 0
  let releaseApply = null
  const syncAfterEvent = []
  rpc.sync = async (req) => {
    if (eventFired) syncAfterEvent.push(req)
    if (req.action === "apply" && ++applyHeld === 1) {
      rpc.calls.push(["sync", req])
      return new Promise((resolve) => {
        releaseApply = () => resolve(syncApplyOk({}))
      })
    }
    return origSync(req)
  }
  const { ui, calls, toasts } = scriptedUi([
    ...editScript("leg2 text"),
    "__save__",
    true, // Save & Sync confirm
    // The auto first-sync projection confirm — the apply hangs after it.
    () => {
      setTimeout(() => {
        assert.ok(typeof events["server.connected"] === "function", "the flow subscribed to server.connected")
        events["server.connected"]()
        eventFired = true
        Promise.resolve().then(() => Promise.resolve()).then(() => releaseApply?.())
      }, 0)
      return true
    },
    "__retry-sync__", // the retry entry must SURVIVE the crossed apply
    true, // the retry sync confirm (the only confirm of the retry path)
    AUTO_TAIL,
  ])
  await createForgeConfigEditor(makeDeps(ui, rpc, { events })).open("C:/proj")
  assert.ok(
    calls.some((c) => c.kind === "select" && (c.args?.options ?? []).some((o) => o.value === "__retry-sync__")),
    `the retry entry survives the crossed apply — list offers: ${JSON.stringify(calls.filter((c) => c.kind === "select").flatMap((c) => (c.args?.options ?? []).map((o) => o.value))).slice(0, 400)}`,
  )
  const retryPrepare = syncAfterEvent.find((r) => r.action === "prepare")
  assert.ok(retryPrepare !== undefined, "the retry prepared FRESH after the event")
  assert.equal(retryPrepare.commitId, "c-1", `the retry prepare binds the saved receipt's commitId — ${JSON.stringify(retryPrepare)}`)
  assert.equal(rpc.calls.filter((c) => c[0] === "sync" && c[1]?.action === "apply").length, 2, `the held apply plus the retry apply — ${rpc.calls.filter((c) => c[0] === "sync").length}`)
})

// Leak leg L2 (throw): the sync APPLY is in flight → server.connected
// lands → the apply THROWS. The outcome is unadjudicable — the product must
// never mislabel it "Sync apply failed … the prepared sync was consumed"
// (the write may have landed); the retry entry survives.
test("connected while the sync apply is in flight, the apply then throws: no false failed/consumed label — the retry entry survives and the retry prepare is fresh", async () => {
  const rpc = fakeRpc({})
  const events = {}
  let eventFired = false
  const origSync = rpc.sync
  let applyHeld = 0
  let rejectApply = null
  const syncAfterEvent = []
  rpc.sync = async (req) => {
    if (eventFired) syncAfterEvent.push(req)
    if (req.action === "apply" && ++applyHeld === 1) {
      rpc.calls.push(["sync", req])
      return new Promise((_resolve, reject) => {
        rejectApply = reject
      })
    }
    return origSync(req)
  }
  const { ui, calls, toasts } = scriptedUi([
    ...editScript("leg2t text"),
    "__save__",
    true, // Save & Sync confirm
    () => {
      setTimeout(() => {
        assert.ok(typeof events["server.connected"] === "function", "the flow subscribed to server.connected")
        events["server.connected"]()
        eventFired = true
        Promise.resolve().then(() => Promise.resolve()).then(() => rejectApply?.(new Error("connection lost")))
      }, 0)
      return true
    },
    "__retry-sync__", // the retry entry must SURVIVE the crossed apply
    true, // the retry sync confirm
    AUTO_TAIL,
  ])
  await createForgeConfigEditor(makeDeps(ui, rpc, { events })).open("C:/proj")
  assert.ok(
    toasts.every((t) => !/the prepared sync was consumed/i.test(t.message ?? "")),
    `the crossed apply is never mislabeled a plain failure/consumption — toasts: ${JSON.stringify(toasts).slice(0, 500)}`,
  )
  assert.ok(
    toasts.some((t) => /UNADJUDICAT|connection changed|revision/i.test(t.message ?? "")),
    `the crossed-apply outcome is disclosed as connection-crossed — toasts: ${JSON.stringify(toasts).slice(0, 500)}`,
  )
  assert.ok(
    calls.some((c) => c.kind === "select" && (c.args?.options ?? []).some((o) => o.value === "__retry-sync__")),
    "the retry entry survives the crossed apply",
  )
  const retryPrepare = syncAfterEvent.find((r) => r.action === "prepare")
  assert.ok(retryPrepare !== undefined, "the retry prepared FRESH after the event")
  assert.equal(retryPrepare.commitId, "c-1", `the retry prepare binds the saved receipt's commitId — ${JSON.stringify(retryPrepare)}`)
})

// Leak leg L3: the preview-confirm gate fires (connected crossed BEFORE the
// gate check) → the void path opens a FRESH document — and MUST rebase the
// drafts onto it. A rebase skip leaves the stale draft and the next prepare
// would carry the OLD auto/readonly base over fresh external bytes.
test("connected crosses the preview confirm: the void path's fresh open rebases the drafts — the next prepare carries the COMPLETE fresh-based draft, never the stale auto/readonly", async () => {
  const rpc = fakeRpc({})
  const events = {}
  const origEditOpen = rpc.editOpen
  let opens = 0
  rpc.editOpen = async (req) => {
    opens++
    const r = await origEditOpen(req)
    if (opens >= 2) {
      const ext = { pool: "proj", agents: { scout: { model: "prov/new", thoughtLevel: "high", shape: "write" } } }
      return { ...r, raw: JSON.stringify(ext), document: ext }
    }
    return r
  }
  const { ui, calls, toasts } = scriptedUi([
    ...editScript("kept text"),
    "__save__",
    // The connected event lands inside the confirm window — before the
    // gate check reads the revision.
    () => {
      events["server.connected"]()
      return true
    },
    "__save__", // the retry after the void's fresh open
    true, // confirm the FRESH preview
    AUTO_TAIL,
  ])
  await createForgeConfigEditor(makeDeps(ui, rpc, { events })).open("C:/proj")
  const prepares = rpc.calls.filter((c) => c[0] === "prepare")
  const lastPrepare = prepares[prepares.length - 1]
  assert.ok(lastPrepare !== undefined, "the retry prepared")
  const scoutOps = lastPrepare[1].ops.filter((op) => op.id === "scout")
  assert.equal(scoutOps.length, 1, `exactly one scout op — ${JSON.stringify(lastPrepare[1].ops)}`)
  const d = scoutOps[0].draft ?? {}
  assert.equal(d.mode, "pinned", `the draft mode carries the FRESH external pin, not the stale Auto — ${JSON.stringify(d)}`)
  assert.equal(d.model, "prov/new", `the draft model is the fresh external pin (a skipped rebase would leave the stale base) — ${JSON.stringify(d)}`)
  assert.equal(d.thoughtLevel, "high", `the thought rides the atomic pin group at the fresh value — ${JSON.stringify(d)}`)
  assert.equal(d.shape, "write", `the draft shape is the fresh external shape — ${JSON.stringify(d)}`)
  assert.equal(d.prompt, "kept text", `the prompt-only diff is still the user's — ${JSON.stringify(d)}`)
  assert.ok(!JSON.stringify(scoutOps).includes("prov/m"), `no stale pin anywhere in the retry prepare — ${JSON.stringify(scoutOps)}`)
})

// Reviewer regression R-PINKEY: two LEGAL spellings that do not denote the
// same pin key — variant-in-model (`prov/m@rev` + `high`) vs variant-in-level
// (`prov/m` + `rev@high`) — must COLLIDE on rebase (explicit confirm), never
// be silently equated or silently overwritten. Both spellings are accepted by
// the real UI validators (model prompt: contains "/", no edge slashes;
// custom level prompt: any native name, lowercased).
test("legal pin spellings prov/m@rev+high vs prov/m+rev@high do NOT denote the same pin: the rebase collision is confirmed, never silently equated", async () => {
  const rpc = fakeRpc({ commitThrows: true, commitThrowMax: 1, receiptFound: false })
  const origEditOpen = rpc.editOpen
  let opens = 0
  rpc.editOpen = async (req) => {
    opens++
    const r = await origEditOpen(req)
    if (opens >= 2) {
      const ext = { pool: "proj", agents: { scout: { model: "prov/m", thoughtLevel: "rev@high", shape: "write" } } }
      return { ...r, raw: JSON.stringify(ext), document: ext }
    }
    return r
  }
  const { ui, calls, toasts } = scriptedUi([
    "worker:scout", "mode", "pinned", "prov/m@rev", "level:high", "back",
    "__save__",
    true, // UNKNOWN #1 (commit response lost)
    true, // the rebase collision ask — the user confirms explicitly
    "__save__", // the retry
    true, // confirm the FRESH preview
    AUTO_TAIL, // the tail is flow-internal
  ])
  await createForgeConfigEditor(makeDeps(ui, rpc)).open("C:/proj")
  const collisionConfirm = calls.find((c) => c.kind === "confirm" && /changed fields you also edited/i.test(c.args?.title ?? JSON.stringify(c.args)))
  const conflictDisclosed = toasts.some((t) => /conflict|prov\/m/i.test(t.message ?? JSON.stringify(t)))
  assert.ok(
    collisionConfirm !== undefined || conflictDisclosed,
    `the differing pin spellings must be CONFIRMED (the collision dialog) or disclosed — confirms: ${JSON.stringify(calls.filter((c) => c.kind === "confirm").map((c) => c.args?.title))}, toasts: ${JSON.stringify(toasts).slice(0, 500)}`,
  )
  const commits = rpc.commitCalls()
  assert.ok(commits.length <= 2, `no silent overwrite past the collision — ${commits.length}`)
})

// ---------------------------------------------------------------------------
// Readiness gate (corrected design): initialScope (S0) binds the transport
// location by value → read-only registry poll (active passes; absent
// continues bounded; failed/disabled/unverifiable/throw/deadline refuse;
// budget 10000, interval 500 — BOTH injectable via deps.sleep/deps.now) →
// strict currentSession(kind+sessionID+anchor) re-verify → ONE echo at the
// bound location → scope re-check → editOpen. No default-location fallback,
// never a skip of readiness via another location's echo, never
// observedDirectory overriding the row anchor.
// ---------------------------------------------------------------------------

const ACTIVE_ROW = { id: "forge", features: { server: true, tui: true }, state: { status: "active" } }
const activeList = () => ({ data: [ACTIVE_ROW] })
const rowWith = (status) => ({ data: [{ id: "forge", features: { server: true, tui: true }, state: { status } }] })

function wsScope(anchor, sessionID = null, kind = "home") {
  return { kind, sessionID, anchor }
}

test("readiness: initialScope binds the transport location — the happy path polls AT THE BOUND ANCHOR, strictly re-verifies, echoes ONCE, then editOpen (in that order)", async () => {
  const rpc = fakeRpc()
  const listCalls = []
  const { ui } = scriptedUi([undefined])
  await createForgeConfigEditor(
    makeDeps(ui, rpc, { pluginList: activeList, pluginListCalls: listCalls, initialScope: wsScope("C:/proj") }),
  ).open("C:/proj")
  const kinds = rpc.calls.map((c) => c[0])
  const echoCount = kinds.filter((k) => k === "echo").length
  assert.equal(echoCount, 1, `exactly ONE readiness echo — ${JSON.stringify(kinds)}`)
  const idxEcho = kinds.indexOf("echo")
  const idxEditOpen = kinds.indexOf("editOpen")
  assert.ok(idxEcho !== -1 && idxEditOpen !== -1, `echo and editOpen both ran — ${JSON.stringify(kinds)}`)
  assert.ok(idxEcho < idxEditOpen, `editOpen comes AFTER the readiness echo (readiness → re-verify → echo → re-check → editOpen) — ${JSON.stringify(kinds)}`)
  // Flow-level location pin: the readiness poll reads the registry AT the
  // bound anchor (S0), never an observed/default directory. (The six-method
  // opts bag is transport-level and pinned in tui-adapter.test.mjs.)
  assert.ok(listCalls.length >= 1, `the registry was polled — ${listCalls.length}`)
  for (const loc of listCalls) {
    assert.equal(loc, "C:/proj", `every plugin.list poll carries the bound anchor as its location — got ${JSON.stringify(loc)}`)
  }
})

test("readiness: an ABSENT forge row continues the bounded poll AT THE BOUND ANCHOR and passes once active (fake clock, no real waiting)", async () => {
  const rpc = fakeRpc()
  const clock = fakeClock()
  const listCalls = []
  let polls = 0
  const answers = [{ data: [] }, activeList()] // absent → active
  const { ui } = scriptedUi([undefined])
  const deps = makeDeps(ui, rpc, {
    clock,
    initialScope: wsScope("C:/proj"),
    pluginListCalls: listCalls,
    pluginList: () => {
      polls++
      return answers.shift() ?? activeList()
    },
  })
  const p = createForgeConfigEditor(deps).open("C:/proj")
  await new Promise((r) => setTimeout(r, 0))
  await clock.advance(500) // one poll interval — the absent row re-polls
  await p
  const kinds = rpc.calls.map((c) => c[0])
  assert.ok(polls >= 2, `the absent row was RE-POLLED, not treated as fatal — polls: ${polls}`)
  assert.equal(rpc.calls.filter((c) => c[0] === "editOpen").length, 1, `the editor opened after the row went active — ${JSON.stringify(kinds)}`)
  assert.equal(rpc.calls.filter((c) => c[0] === "echo").length, 1, `a single echo, only after active — ${JSON.stringify(kinds)}`)
  for (const loc of listCalls) {
    assert.equal(loc, "C:/proj", `every re-poll stays at the bound anchor — got ${JSON.stringify(loc)}`)
  }
})

test("readiness: a FAILED forge row refuses — zero echo/editOpen/prepare/commit/sync", async () => {
  const rpc = fakeRpc()
  const clock = fakeClock()
  const { ui, toasts, calls } = scriptedUi([undefined])
  await createForgeConfigEditor(makeDeps(ui, rpc, { clock, pluginList: rowWith("failed"), initialScope: wsScope("C:/proj") })).open("C:/proj")
  const kinds = rpc.calls.map((c) => c[0])
  assert.ok(!kinds.includes("echo") && !kinds.includes("editOpen"), `no echo/editOpen past a failed row — ${JSON.stringify(kinds)}`)
  assert.ok(!kinds.includes("prepare") && !kinds.includes("commit") && !kinds.includes("sync"), `zero writes/sync — ${JSON.stringify(kinds)}`)
  assert.ok(toasts.some((t) => t.variant === "error" || t.variant === "warning"), "the refusal is disclosed")
})

test("readiness: a DISABLED forge row never passes (refusal at the injected deadline; zero echo/editOpen/writes)", async () => {
  const rpc = fakeRpc()
  const clock = fakeClock()
  const { ui } = scriptedUi([undefined])
  const deps = makeDeps(ui, rpc, { clock, pluginList: rowWith("disabled"), initialScope: wsScope("C:/proj") })
  const p = createForgeConfigEditor(deps).open("C:/proj")
  await new Promise((r) => setTimeout(r, 0))
  await clock.advance(10_000) // the disabled row never passes — the deadline closes the wait
  await p
  const kinds = rpc.calls.map((c) => c[0])
  assert.ok(!kinds.includes("echo") && !kinds.includes("editOpen"), `disabled never passes — ${JSON.stringify(kinds)}`)
  assert.ok(!kinds.includes("prepare") && !kinds.includes("commit") && !kinds.includes("sync"), `zero writes — ${JSON.stringify(kinds)}`)
})

test("readiness timer: the TOTAL deadline is scheduled exactly ONCE for the full budget and its cancel runs on the success path (finally clear)", async () => {
  const rpc = fakeRpc()
  const clock = fakeClock()
  const { ui } = scriptedUi([undefined])
  await createForgeConfigEditor(makeDeps(ui, rpc, { clock, pluginList: activeList, initialScope: wsScope("C:/proj") })).open("C:/proj")
  const stats = clock.stats()
  assert.equal(stats.scheduled, 1, `the total deadline is ONE timer, not one per poll — ${JSON.stringify(stats)}`)
  assert.ok(stats.cancels >= 1, `the deadline timer's cancel runs even after success (finally clear) — ${JSON.stringify(stats)}`)
  assert.equal(rpc.calls.filter((c) => c[0] === "echo").length, 1, "the happy path itself stays intact")
})

test("readiness poll: sleeps are clamped to the remaining budget (min(500, remaining)) and the deadline refusal wins at the boundary", async () => {
  const rpc = fakeRpc()
  const clock = fakeClock()
  const { ui } = scriptedUi([undefined])
  const deps = makeDeps(ui, rpc, { clock, pluginList: { data: [] }, initialScope: wsScope("C:/proj") }) // eternally absent
  const p = createForgeConfigEditor(deps).open("C:/proj")
  await new Promise((r) => setTimeout(r, 0))
  await clock.advance(9_600) // budget nearly spent — remaining 400 < poll 500
  await clock.advance(500) // crosses the deadline
  await p
  const stats = clock.stats()
  assert.ok(stats.sleepCalls.some((ms) => ms === 400), `a poll sleep was clamped to the remaining budget — sleeps: ${JSON.stringify(stats.sleepCalls)}`)
  assert.ok(!stats.sleepCalls.some((ms) => ms > 500), `no poll sleep exceeds the interval — sleeps: ${JSON.stringify(stats.sleepCalls)}`)
  assert.ok(!rpc.calls.some((c) => c[0] === "echo" || c[0] === "editOpen"), "an eternally absent row never passes")
})

test("readiness poll: the FIRST rejecting sleep fails closed IMMEDIATELY (sleep races the deadlineGate; the swallow-and-continue deviation is pinned red) — a pending later sleep only bounds the test against regression hangs", async () => {
  const rpc = fakeRpc()
  const clock = fakeClock()
  let sleepCalls = 0
  const { ui, toasts, calls } = scriptedUi([undefined])
  const deps = makeDeps(ui, rpc, {
    clock,
    initialScope: wsScope("C:/proj"),
    pluginList: { data: [] }, // eternally absent — the wait path is exercised
    // First sleep REJECTS: the REQUIRED contract is fail-closed right here
    // (sleep raced against the deadlineGate; catch discloses via
    // safeErrorText and returns false). A swallow-and-continue regression
    // would poll again — this fixture PARKS that second sleep forever so a
    // regression cannot hot-loop the suite: it is then bounded by the
    // scheduled deadline below and pinned red by sleepCalls.
    sleep: (ms) => {
      sleepCalls++
      return sleepCalls === 1 ? Promise.reject(new Error("timer wheel blew up")) : new Promise(() => {})
    },
  })
  const p = createForgeConfigEditor(deps).open("C:/proj")
  await new Promise((r) => setTimeout(r, 0))
  await clock.advance(10_000) // bounds a regression (deadline is the last authority)
  await p.catch(() => {}) // a refusal throw is acceptable — an escape is not
  const kinds = rpc.calls.map((c) => c[0])
  assert.equal(sleepCalls, 1, `the FIRST rejection must fail closed (no continued polling) — sleep calls: ${sleepCalls}`)
  assert.ok(!kinds.includes("echo") && !kinds.includes("editOpen"), `a broken timer wheel refuses CLOSED (zero echo/editOpen) — ${JSON.stringify(kinds)}`)
  assert.ok(!kinds.includes("prepare") && !kinds.includes("commit") && !kinds.includes("sync"), `zero writes — ${JSON.stringify(kinds)}`)
  assert.ok(toasts.some((t) => t.variant === "error" || t.variant === "warning"), "the refusal is disclosed")
})

test("readiness: an UNVERIFIABLE row shape refuses at the deadline (fake clock advances the 10000 budget)", async () => {
  const rpc = fakeRpc()
  const clock = fakeClock()
  const { ui } = scriptedUi([undefined])
  const deps = makeDeps(ui, rpc, { clock, pluginList: rowWith("weird-unknown-status"), initialScope: wsScope("C:/proj") })
  const p = createForgeConfigEditor(deps).open("C:/proj")
  await new Promise((r) => setTimeout(r, 0))
  await clock.advance(10_000)
  await p
  const kinds = rpc.calls.map((c) => c[0])
  assert.ok(!kinds.includes("echo") && !kinds.includes("editOpen"), `unverifiable never passes (deadline refusal) — ${JSON.stringify(kinds)}`)
  assert.ok(!kinds.includes("prepare") && !kinds.includes("commit") && !kinds.includes("sync"), `zero writes — ${JSON.stringify(kinds)}`)
})

test("readiness: a registry that THROWS refuses — zero echo/editOpen/writes", async () => {
  const rpc = fakeRpc()
  const clock = fakeClock()
  const { ui } = scriptedUi([undefined])
  await createForgeConfigEditor(makeDeps(ui, rpc, { clock, pluginList: new Error("registry exploded"), initialScope: wsScope("C:/proj") })).open("C:/proj")
  const kinds = rpc.calls.map((c) => c[0])
  assert.ok(!kinds.includes("echo") && !kinds.includes("editOpen") && !kinds.includes("prepare") && !kinds.includes("commit") && !kinds.includes("sync"), `a throwing registry refuses — ${JSON.stringify(kinds)}`)
})

test("readiness: an eternally PENDING registry hits the injected deadline (≤10s fake budget) and refuses; a LATE resolve is never consumed — no late echo/editOpen", async () => {
  const rpc = fakeRpc()
  const clock = fakeClock()
  let lateResolve = null
  const { ui, toasts, calls } = scriptedUi([undefined])
  const deps = makeDeps(
    ui,
    rpc,
    {
      clock,
      pluginList: () => new Promise((resolve) => { lateResolve = () => resolve(activeList()) }),
      initialScope: wsScope("C:/proj"),
    },
  )
  const p = createForgeConfigEditor(deps).open("C:/proj")
  await new Promise((r) => setTimeout(r, 0))
  await clock.advance(10_000) // the budget expires while the promise still pends
  await p
  const before = rpc.calls.length
  assert.ok(rpc.calls.every((c) => c[0] !== "echo" && c[0] !== "editOpen"), `the deadline refusal never echoed/opened — ${JSON.stringify(rpc.calls.map((c) => c[0]))}`)
  assert.ok(toasts.some((t) => t.variant === "error" || t.variant === "warning"), "the deadline refusal is disclosed")
  lateResolve() // the registry resolves ACTIVE far too late
  await new Promise((r) => setTimeout(r, 0))
  await new Promise((r) => setTimeout(r, 0))
  assert.equal(rpc.calls.length, before, `the late resolve is never consumed (no late echo/editOpen) — ${JSON.stringify(rpc.calls.map((c) => c[0]))}`)
})

test("readiness: an anchor that MOVES during readiness refuses at the strict currentSession re-verify — zero echo/editOpen", async () => {
  const rpc = fakeRpc()
  const clock = fakeClock()
  let scopeCalls = 0
  const { ui, toasts, calls } = scriptedUi([undefined])
  const deps = makeDeps(ui, rpc, {
    clock,
    pluginList: activeList,
    initialScope: wsScope("C:/proj", "s-1", "session"),
    scope: () => {
      scopeCalls++
      return scopeCalls <= 2 ? wsScope("C:/proj", "s-1", "session") : wsScope("C:/moved", "s-1", "session")
    },
  })
  await createForgeConfigEditor(deps).open("C:/proj")
  const kinds = rpc.calls.map((c) => c[0])
  assert.ok(!kinds.includes("editOpen"), `the moved anchor never opens the document — ${JSON.stringify(kinds)}`)
  assert.ok(toasts.some((t) => /scope|session|anchor|changed|refused|move/i.test(`${t.title ?? ""}${t.message ?? ""}`)), `the move is disclosed — toasts: ${JSON.stringify(toasts).slice(0, 400)}`)
})

test("readiness: ws2 active at its OWN location — the same-location success path stays bounded, single echo, polls at ws2", async () => {
  const rpc = fakeRpc()
  const listCalls = []
  const { ui } = scriptedUi([undefined])
  await createForgeConfigEditor(
    makeDeps(ui, rpc, {
      pluginList: activeList,
      pluginListCalls: listCalls,
      initialScope: wsScope("C:/ws2", "s-ws2", "session"),
      scope: wsScope("C:/ws2", "s-ws2", "session"),
    }),
  ).open("C:/proj")
  const kinds = rpc.calls.map((c) => c[0])
  assert.equal(kinds.filter((k) => k === "echo").length, 1, `ws2's own readiness echo runs exactly once — ${JSON.stringify(kinds)}`)
  assert.ok(kinds.includes("editOpen"), "ws2 opened its own document")
  for (const loc of listCalls) {
    assert.equal(loc, "C:/ws2", `every poll is at ws2's own location — got ${JSON.stringify(loc)}`)
  }
})

test("readiness: ws1 active but ws2 has NO forge row — ws2's missing row is never covered by ws1's activation: bounded refusal, zero echo/editOpen, every poll still at ws2", async () => {
  const rpc = fakeRpc()
  const clock = fakeClock()
  const listCalls = []
  const { ui } = scriptedUi([undefined])
  // The registry DOES report an active forge row (installed at ws1) — but
  // the registry answers its LOCATION-SCOPED query: the ws2 poll comes back
  // empty. ws1's activation must never loan ws2 its readiness: poll at ws2
  // until the deadline, then refuse closed.
  const deps = makeDeps(ui, rpc, {
    clock,
    pluginListCalls: listCalls,
    pluginList: (req) => (req?.location?.directory === "C:/ws2" ? { data: [] } : activeList()),
    initialScope: wsScope("C:/ws2", "s-ws2", "session"),
    scope: wsScope("C:/ws2", "s-ws2", "session"),
  })
  const p = createForgeConfigEditor(deps).open("C:/proj")
  await new Promise((r) => setTimeout(r, 0))
  await clock.advance(10_000) // ws2's own readiness never arrives
  await p
  const kinds = rpc.calls.map((c) => c[0])
  assert.ok(!kinds.includes("echo"), `ws1's activation never lends ws2 an echo — ${JSON.stringify(kinds)}`)
  assert.ok(!kinds.includes("editOpen"), `ws2 never opens on borrowed readiness — ${JSON.stringify(kinds)}`)
  assert.ok(!kinds.includes("prepare") && !kinds.includes("commit") && !kinds.includes("sync"), `zero writes — ${JSON.stringify(kinds)}`)
  assert.ok(listCalls.length >= 1, `ws2's own readiness was polled — ${listCalls.length}`)
  for (const loc of listCalls) {
    assert.equal(loc, "C:/ws2", `every poll is at the bound ws2 anchor, never the ws1 default — got ${JSON.stringify(loc)}`)
  }
})

// Home→home anchor drift (same null sessionID, DIFFERENT directory): the
// triple re-verify must refuse every decisive step — the sessionID-only
// check of round 1 let home-A→home-B commits/syncs/refreshes through.
const HOME_A = { kind: "home", sessionID: null, anchor: "C:/homeA" }
const HOME_B = { kind: "home", sessionID: null, anchor: "C:/homeB" }

test("home-home drift: the anchor moves A→B BEFORE the save is requested — saveFlow's pre-prepare re-verify refuses: zero prepare, zero commit", async () => {
  const rpc = answerPerContractAt(fakeRpc(), HOME_A.anchor)
  let flipped = false
  const { ui, toasts, calls } = scriptedUi([
    ...editScript("drift text"),
    // The drift lands while the workspace list select is being answered —
    // BEFORE "__save__" reaches saveFlow's re-verify (flow.ts:1060).
    () => {
      flipped = true
      return "__save__"
    },
    AUTO_TAIL, // the save is refused before any dialog — absorb the tail
  ])
  await createForgeConfigEditor(
    makeDeps(ui, rpc, { initialScope: HOME_A, scope: () => (flipped ? HOME_B : HOME_A) }),
  ).open("C:/proj")
  assert.equal(rpc.calls.filter((c) => c[0] === "prepare").length, 0, `the pre-prepare re-verify refuses the drifted anchor: zero prepare — ${JSON.stringify(rpc.calls.map((c) => c[0]))}`)
  assert.equal(rpc.calls.filter((c) => c[0] === "commit").length, 0, `zero commits past a home-A→home-B drift — ${JSON.stringify(rpc.calls.map((c) => c[0]))}`)
  assert.ok(
    toasts.some((t) => /scope|anchor|changed|refused/i.test(`${t.title ?? ""}${t.message ?? ""}`)),
    `the drift refusal is disclosed — toasts: ${JSON.stringify(toasts).slice(0, 400)}`,
  )
})

test("home-home drift: the anchor moves at the SAVE PREVIEW CONFIRM — the already-sent prepare is adjudicated honestly (zero commit; the commit's own re-verify refuses)", async () => {
  const rpc = answerPerContractAt(fakeRpc(), HOME_A.anchor)
  let flipped = false
  const { ui, toasts, calls } = scriptedUi([
    ...editScript("drift text"),
    "__save__",
    // The preview confirm is answered, THEN the anchor drifts — prepare
    // was already legitimately sent BEFORE this confirm; the commit's own
    // re-verify (flow.ts:1278) must refuse: ZERO commits.
    () => {
      flipped = true
      return true
    },
    AUTO_TAIL,
  ])
  await createForgeConfigEditor(
    makeDeps(ui, rpc, { initialScope: HOME_A, scope: () => (flipped ? HOME_B : HOME_A) }),
  ).open("C:/proj")
  assert.equal(rpc.calls.filter((c) => c[0] === "commit").length, 0, `the commit's re-verify refuses the drifted anchor: ZERO commits — ${JSON.stringify(rpc.calls.map((c) => c[0]))}`)
  assert.ok(
    toasts.some((t) => /scope|anchor|changed|refused/i.test(`${t.title ?? ""}${t.message ?? ""}`)),
    `the drift refusal is disclosed — toasts: ${JSON.stringify(toasts).slice(0, 400)}`,
  )
})

test("home-home drift: the anchor moves before the AUTO-SYNC apply — zero apply ever runs and the retry entry survives a second refusal", async () => {
  const rpc = answerPerContractAt(fakeRpc(), HOME_A.anchor)
  let flipped = false
  const { ui, calls } = scriptedUi([
    ...editScript("drift sync"),
    "__save__",
    true, // Save & Sync confirm (scope still A — the save completes at A)
    // Answer the projection confirm, THEN drift to homeB — the apply's
    // re-verify must refuse, leaving the saved receipt's sync outstanding.
    () => {
      flipped = true
      return true
    },
    "__retry-sync__", // the retry entry must survive the first refusal
    AUTO_TAIL, // the retry refuses BEFORE its confirm (pre-check at flow.ts:1793) — absorb the tail
  ])
  await createForgeConfigEditor(
    makeDeps(ui, rpc, { initialScope: HOME_A, scope: () => (flipped ? HOME_B : HOME_A) }),
  ).open("C:/proj")
  assert.equal(rpc.calls.filter((c) => c[0] === "sync" && c[1]?.action === "apply").length, 0, `zero sync applies past the drift — ${JSON.stringify(rpc.calls.map((c) => `${c[0]}:${c[1]?.action ?? ""}`))}`)
  assert.ok(
    calls.some((c) => c.kind === "select" && (c.args?.options ?? []).some((o) => o.value === "__retry-sync__")),
    "the retry entry survives the drift refusal",
  )
})

test("home-home drift: the anchor moves before a RELOAD — the refresh refuses a fresh openDocument (editOpen count never grows)", async () => {
  const rpc = answerPerContractAt(fakeRpc(), HOME_A.anchor)
  let flipped = false
  const { ui, toasts, calls } = scriptedUi([
    () => {
      // The very first list select: drift first, then pick Reload from
      // server — the refresh must refuse against the moved anchor.
      flipped = true
      return "__reload__"
    },
    undefined,
    true, // tolerate a pending-draft guard if the flow keeps the editor open
    AUTO_TAIL,
  ])
  await createForgeConfigEditor(
    makeDeps(ui, rpc, { initialScope: HOME_A, scope: () => (flipped ? HOME_B : HOME_A) }),
  ).open("C:/proj")
  const editOpens = rpc.calls.filter((c) => c[0] === "editOpen").length
  assert.ok(editOpens <= 1, `the drifted refresh never re-opens the document (initial open only) — editOpen count: ${editOpens}`)
  assert.ok(
    toasts.some((t) => /scope|anchor|changed|refused/i.test(`${t.title ?? ""}${t.message ?? ""}`)),
    `the drift refusal on refresh is disclosed — toasts: ${JSON.stringify(toasts).slice(0, 400)}`,
  )
})

test("home-home drift: the editOpen request leaves at anchor A, the response lands AFTER a drift to homeB — the deferred response is DISCARDED (post-response triple re-check): zero UI list, zero prepare/commit/sync, the old document is never displayed or rebased", async () => {
  const rpc = answerPerContractAt(fakeRpc(), HOME_A.anchor)
  let flipped = false
  let releaseEditOpen = null
  let editOpensSent = 0
  const origEditOpen = rpc.editOpen
  rpc.editOpen = async (req) => {
    editOpensSent++
    if (editOpensSent === 1) {
      // The request leaves while the scope is homeA; the response is held
      // until the test drifts the anchor to homeB.
      return new Promise((resolve) => {
        releaseEditOpen = () => resolve(origEditOpen(req))
      })
    }
    return origEditOpen(req)
  }
  const { ui, calls, toasts } = scriptedUi([
    // NO scripted list steps: a correct guard discards the deferred
    // response and closes without ever showing a list.
  ])
  const deps = makeDeps(ui, rpc, { initialScope: HOME_A, scope: () => (flipped ? HOME_B : HOME_A) })
  const p = createForgeConfigEditor(deps).open("C:/proj")
  await new Promise((r) => setTimeout(r, 0))
  assert.ok(releaseEditOpen !== null, "the editOpen request is in flight while the scope is still homeA")
  flipped = true // homeB lands while the response is on the wire
  releaseEditOpen() // the response arrives too late — it must be discarded
  await p.catch(() => {})
  assert.equal(editOpensSent, 1, `the deferred response is discarded — no second editOpen is ever issued — sent: ${editOpensSent}`)
  const kinds = rpc.calls.map((c) => c[0])
  assert.ok(!kinds.includes("prepare") && !kinds.includes("commit") && !kinds.includes("sync"), `zero writes/sync on a drifted response — ${JSON.stringify(kinds)}`)
  assert.equal(calls.length, 0, `zero UI: the list is never shown on a discarded deferred response — dialogs: ${JSON.stringify(calls.map((c) => `${c.kind}:${String(c.args?.title).slice(0, 50)}`))}`)
  assert.ok(
    toasts.some((t) => /scope|anchor|changed|refused/i.test(`${t.title ?? ""}${t.message ?? ""}`)),
    `the deferred-response refusal is disclosed — toasts: ${JSON.stringify(toasts).slice(0, 400)}`,
  )
})

test("readiness: runEditor with an UNKNOWN kind / null session / null anchor refuses WITHOUT building the transport (zero RPC)", async () => {
  for (const bad of [wsScope("C:/proj", "s-1", "unknown"), wsScope("C:/proj", null, "session"), wsScope(null, "s-1", "session")]) {
    const rpc = fakeRpc()
    const { ui } = scriptedUi([undefined])
    let crashed = false
    try {
      await createForgeConfigEditor(makeDeps(ui, rpc, { initialScope: bad })).open("C:/proj")
    } catch {
      crashed = true // a refusal throw is acceptable — a crash is not
    }
    assert.equal(rpc.calls.length, 0, `scope ${JSON.stringify(bad)}: zero RPC without a transport — saw ${JSON.stringify(rpc.calls.map((c) => c[0]))}`)
    assert.ok(crashed || rpc.calls.length === 0, "wiring never crashes the process")
  }
})

test("readiness: deps WITHOUT initialScope refuse cleanly (no crash, zero RPC) — the S0 binding is mandatory", async () => {
  const rpc = fakeRpc()
  const { ui } = scriptedUi([undefined])
  const deps = makeDeps(ui, rpc)
  delete deps.initialScope
  let crashed = false
  try {
    await createForgeConfigEditor(deps).open("C:/proj")
  } catch {
    crashed = true
  }
  assert.equal(rpc.calls.length, 0, `zero RPC without the S0 scope — saw ${JSON.stringify(rpc.calls.map((c) => c[0]))}`)
  assert.ok(crashed || rpc.calls.length === 0, "wiring never crashes the process")
})

test("13 pending changes: the preview pages and the receipt-detail browse name EVERY entry (a 12-cap with '… and N more' hides identities)", async () => {
  const ids = ["scout", ...Array.from({ length: 12 }, (_, i) => `w${i + 1}`)]
  const entries = ids.map((id, i) => ({
    opId: `worker:${i === 0 ? "update" : "create"}:${id}`,
    id, kind: "worker", action: i === 0 ? "update" : "create",
    entryKind: i === 0 ? "patch" : "create-file",
    outcome: "written", summary: [`${id} done`], findings: [],
  }))
  const rpc = fakeRpc({ entries })
  // The save's post-receipt refresh must return the REAL saved document —
  // all 13 entries exist server-side after the written receipt (a stale
  // pre-save answer would resurrect ghost drafts in the rebase).
  const origEditOpen = rpc.editOpen
  let opens = 0
  rpc.editOpen = async (req) => {
    opens++
    const r = await origEditOpen(req)
    if (opens >= 2) {
      const saved = { pool: "proj", agents: {} }
      for (const id of ids) saved.agents[id] = id === "scout" ? { model: "prov/old", thoughtLevel: "low" } : {}
      return { ...r, raw: JSON.stringify(saved), document: saved }
    }
    return r
  }
  const steps = ["worker:scout", "prompt", "replace", "alpha new prompt", "back"]
  for (let i = 1; i <= 12; i++) steps.push("__new-worker__", `w${i}`, "auto")
  const pages = []
  const receiptPages = []
  steps.push(
    "__save__",
    async ({ args }) => { pages.push(JSON.stringify(args)); return "__preview-next__" },
    async ({ args }) => { pages.push(JSON.stringify(args)); return "__preview-confirm__" },
    true, // Save & Sync confirm
    true, // auto first-sync projection confirm
    "__receipt-detail__", // the receipt names EVERY entry behind this browse
    ({ args }) => { receiptPages.push(JSON.stringify(args)); return "__preview-next__" }, // page 1 of 2
    ({ args }) => { receiptPages.push(JSON.stringify(args)); return undefined }, // page 2, then close
    undefined, // quit
  )
  const { ui, calls, toasts } = scriptedUi(steps)
  await createForgeConfigEditor(makeDeps(ui, rpc)).open("C:/proj")
  const previewText = pages.join("|")
  assert.equal(pages.length, 2, `the review paginates (13 entries) — pages seen: ${pages.length}`)
  const receiptText = receiptPages.join("|")
  for (const id of ids) {
    assert.ok(previewText.includes(id), `the preview names entry "${id}" — preview: ${previewText.slice(0, 600)}`)
    assert.ok(receiptText.includes(id), `the receipt detail names entry "${id}" — receipt: ${receiptText.slice(0, 600)}`)
    assert.ok(previewText.includes(`${id} done`) || receiptText.includes(`${id} done`), `entry "${id}"'s SUMMARY is retrievable from the review or the receipt — receipt: ${receiptText.slice(0, 400)}`)
  }
})

test("13 entries: paged-preview Esc commits NOTHING; afterwards the on-demand 'Last save receipt detail' browse reaches EVERY entry id + full summary", async () => {
  const ids = ["scout", ...Array.from({ length: 12 }, (_, i) => `w${i + 1}`)]
  const entries = ids.map((id, i) => ({
    opId: `worker:${i === 0 ? "update" : "create"}:${id}`,
    id, kind: "worker", action: i === 0 ? "update" : "create",
    entryKind: i === 0 ? "patch" : "create-file",
    outcome: "written", summary: [`${id} done`], findings: [],
  }))
  const rpc = fakeRpc({ entries })
  const steps = ["worker:scout", "prompt", "replace", "alpha new prompt", "back"]
  for (let i = 1; i <= 12; i++) steps.push("__new-worker__", `w${i}`, "auto")
  const previewPages = []
  const receiptPages = []
  steps.push(
    "__save__",
    async ({ args }) => { previewPages.push(JSON.stringify(args)); return undefined }, // Esc on page 1 — nothing written
    "__save__", // the retry
    async ({ args }) => { previewPages.push(JSON.stringify(args)); return "__preview-next__" },
    async ({ args }) => { previewPages.push(JSON.stringify(args)); return "__preview-confirm__" },
    true, // Save & Sync confirm
    true, // auto first-sync projection confirm
    "__receipt-detail__", // the on-demand entry in the main list
    async ({ args }) => { receiptPages.push(JSON.stringify(args)); return "entry:0" }, // page 1: open scout's FULL detail
    async ({ args }) => { receiptPages.push(JSON.stringify(args)); return "__preview-next__" },
    async ({ args }) => { receiptPages.push(JSON.stringify(args)); return "entry:12" }, // page 2: open w12's FULL detail
    async ({ args }) => { receiptPages.push(JSON.stringify(args)); return undefined }, // Esc closes the browse
    undefined, // quit
  )
  const { ui, calls, toasts } = scriptedUi(steps)
  await createForgeConfigEditor(makeDeps(ui, rpc)).open("C:/proj")
  // The Esc on the paged preview is a full cancel: ZERO commits ever ran for it.
  assert.ok(
    toasts.some((t) => /nothing was written/i.test(t.message ?? "")),
    `the preview Esc is disclosed as a cancel — toasts: ${JSON.stringify(toasts).slice(0, 400)}`,
  )
  // The on-demand receipt entry is offered and every one of the 13 entries is
  // reachable through its pages (each page option names id · action · summary).
  assert.ok(
    calls.some((c) => c.kind === "select" && (c.args?.options ?? []).some((o) => o.value === "__receipt-detail__")),
    "the main list offers the on-demand 'Last save receipt detail' entry",
  )
  const receiptText = receiptPages.join("|")
  for (const id of ids) {
    assert.ok(receiptText.includes(`worker \\"${id}\\"`), `the receipt-detail browse names entry "${id}" — pages: ${receiptText.slice(0, 800)}`)
  }
  // Opening an entry discloses its FULL summary lines (not just the id).
  const disclosed = toasts.map((t) => JSON.stringify(t)).join("\n")
  assert.ok(disclosed.includes(`worker \\"scout\\"`) && disclosed.includes("scout done"), `scout's full detail is disclosed on pick — toasts: ${disclosed.slice(0, 500)}`)
  assert.ok(disclosed.includes(`worker \\"w12\\"`) && disclosed.includes("w12 done"), `w12's full detail is disclosed on pick — toasts: ${disclosed.slice(0, 500)}`)
  // Exactly ONE commit total: the cancelled preview wrote nothing, the retry wrote once.
  assert.equal(rpc.commitCalls().length, 1, `the Esc'd preview commits nothing; the retry commits once — ${rpc.commitCalls().length}`)
})

test("commit response lost with no receipt = UNKNOWN: disclosed, drafts kept, next save prepares a FRESH snapshot with a new token", async () => {
  const rpc = fakeRpc({ commitThrows: true, receiptFound: false })
  const { ui, toasts, calls } = scriptedUi([
    ...editScript("lost text"),
    "__save__",
    true, // confirm save — the commit response is LOST, no receipt found
    "__save__", // save again against current content
    true, // confirm the FRESH preview
    undefined, // Esc — drafts kept after the second UNKNOWN
    true, // discard pending to quit
    undefined,
  ])
  await createForgeConfigEditor(makeDeps(ui, rpc)).open("C:/proj")
  assert.ok(
    toasts.some((t) => /UNKNOWN/i.test(t.message ?? JSON.stringify(t))),
    `the UNKNOWN outcome is disclosed verbatim (never "nothing was written") — toasts: ${JSON.stringify(toasts).slice(0, 400)}`,
  )
  assert.ok(!toasts.some((t) => /nothing was written/i.test(t.message ?? "")), "an UNKNOWN commit never claims zero writes")
  const editOpens = rpc.calls.filter((c) => c[0] === "editOpen")
  const prepares = rpc.calls.filter((c) => c[0] === "prepare")
  assert.ok(prepares.length >= 2, "the retry re-prepares")
  const snapshotIds = new Set(prepares.map((c) => c[1].snapshotId))
  assert.equal(editOpens.length >= prepares.length, true, `every prepare rides a fresh editOpen snapshot — editOpens: ${editOpens.length}, prepares: ${prepares.length}`)
  assert.equal(snapshotIds.size, prepares.length, `no prepare may reuse a stale snapshot after UNKNOWN — ids: ${JSON.stringify([...snapshotIds])}`)
  assert.equal(prepares[prepares.length - 1][1].snapshotId, "snap-2", "the post-UNKNOWN save prepares against the REOPENED snapshot (snap-2), never the lost one")
  const tokens = rpc.calls.filter((c) => c[0] === "commit").map((c) => c[1].token)
  assert.equal(new Set(tokens).size, tokens.length, "the lost token is never replayed")
})





// ---------------------------------------------------------------------------
// editOpen response-binding discipline (change forge-tui-subagent-config,
// review round: the flow must adjudicate the SERVER'S ANSWER against the
// REQUEST and the bound startup scope S0 — never bind a foreign binding).
// Contract matrix (review-corrected):
//   scope and sessionID must equal the REQUEST;
//   home kind: observedLocation directory-equivalent (win32 case/separator
//     folding) to S0.anchor;
//   workspace: anchor directory-equivalent to observedLocation; out.path on
//     the S0 anchor's ANCESTOR chain is legal (walk-up pool ownership);
//   global: anchor exactly null (observedLocation stays the S0 evidence);
//   a session answer's observedLocation is the server's live session.moved
//     authority and may legitimately differ from a stale S0 row — never a
//     refusal reason by itself;
//   workspace exists:false + creatable:false is a CONTRADICTION state —
//     refuse (no doc, no writes); it must never be labeled the global
//     fallback ("no workspace pool" line).
// Mock harness (fakeRpc + scriptedUi) — flow-level seam tests, NOT E2E.
// ---------------------------------------------------------------------------

// Wrap rpc.editOpen with an ordered answer script; every call is still
// recorded in rpc.calls (the wrapper pushes before answering).
function editOpenScripted(rpc, answers) {
  const orig = rpc.editOpen
  let n = 0
  rpc.editOpen = async (req, opts) => {
    rpc.calls.push(["editOpen", req, opts])
    const answer = answers[Math.min(n, answers.length - 1)]
    n++
    return typeof answer === "function" ? answer(req, n) : answer
  }
  return rpc
}


// Contract-true per-request answers stitched at a fixed startup anchor: a
// workspace request gets anchor≡observedLocation=startupAnchor; a global
// request gets anchor:null + observedLocation=startupAnchor. Used to repair
// PRE-BINDING-CONTRACT fixtures whose canned answers predate the response-
// binding matrix (expectations untouched — only the wire shape is修齐).
function answerPerContractAt(rpc, startupAnchor, docSeed = {}) {
  const orig = rpc.editOpen
  rpc.editOpen = async (req, opts) => {
    rpc.calls.push(["editOpen", req, opts])
    if (req?.scope === "global") {
      return editOpenOk({ ...docSeed, scope: "global", sessionID: req?.sessionID ?? null, anchor: null, observedLocation: startupAnchor, targetIdentity: "tgt-global" })
    }
    return editOpenOk({
      ...docSeed,
      scope: req?.scope ?? "workspace",
      sessionID: req?.sessionID ?? null,
      observedLocation: startupAnchor,
      anchor: startupAnchor,
      path: `${startupAnchor}/.opencode/forge.json`,
    })
  }
  return rpc
}

function assertNoWrites(rpc, label) {
  const kinds = rpc.calls.map((c) => c[0])
  assert.ok(!kinds.includes("prepare") && !kinds.includes("commit") && !kinds.includes("sync"), `${label}: zero writes/syncs on a refused document — saw: ${kinds}`)
}

const FOREIGN = "C:/other"

test("RED evidence: home S0=A but editOpen succeeds answering B (foreign observedLocation/anchor): refused, never bound, zero writes, no rebase", async () => {
  const rpc = editOpenScripted(fakeRpc({}), [
    editOpenOk({
      path: `${FOREIGN}/.opencode/forge.json`,
      observedLocation: FOREIGN,
      anchor: FOREIGN,
      // foreign doc content marker: its worker "scout" must never surface
    }),
  ])
  const { ui, toasts, calls } = scriptedUi([undefined]) // the (refusal) list, then close
  await createForgeConfigEditor(makeDeps(ui, rpc)).open("C:/proj")
  assertNoWrites(rpc, "home A→B")
  assert.ok(toasts.some((t) => t.variant === "error"), `the foreign-binding answer must be refused with an error disclosure — toasts: ${JSON.stringify(toasts).slice(0, 600)}`)
  const offered = JSON.stringify(calls ?? [])
  assert.ok(!offered.includes("worker:scout"), `the foreign doc's entries must never be offered — dialogs: ${offered.slice(0, 600)}`)
  assert.ok(!offered.includes(FOREIGN), `the foreign path must never be presented as the bound source — dialogs: ${offered.slice(0, 600)}`)
})

test("RED evidence: workspace exists:false + creatable:false (contradiction state): refused — never labeled the global fallback", async () => {
  const rpc = editOpenScripted(fakeRpc({}), [
    editOpenOk({ exists: false, creatable: false, path: "C:/proj/.opencode/forge.json" }),
  ])
  const { ui, toasts, calls } = scriptedUi([undefined])
  await createForgeConfigEditor(makeDeps(ui, rpc)).open("C:/proj")
  assertNoWrites(rpc, "false/false")
  assert.ok(toasts.some((t) => t.variant === "error"), `exists:false + creatable:false must refuse (conflict/unresolvable), not bind — toasts: ${JSON.stringify(toasts).slice(0, 600)}`)
  const offered = JSON.stringify(calls ?? [])
  assert.ok(!offered.includes("no workspace pool"), `the contradiction state must never be labeled the global fallback ("no workspace pool") — dialogs: ${offered.slice(0, 600)}`)
})

test("legal: home answer with win32 case AND separator-equivalent observedLocation is accepted (folding equivalence)", async () => {
  for (const equivalent of ["c:/PROJ", "C:\\PROJ", "C:\\proj"]) {
    const rpc = editOpenScripted(fakeRpc({}), [
      editOpenOk({ observedLocation: equivalent, anchor: equivalent }),
    ])
    const { ui, toasts, calls } = scriptedUi([undefined])
    await createForgeConfigEditor(makeDeps(ui, rpc)).open("C:/proj")
    assert.ok(!toasts.some((t) => t.variant === "error"), `the win-equivalent spelling ${equivalent} is legal (case + / vs \\ folding) — toasts: ${JSON.stringify(toasts).slice(0, 400)}`)
    assert.ok(JSON.stringify(calls ?? []).includes("worker:scout"), `the document binds for ${equivalent} and offers its entries`)
  }
})

test("legal: workspace answer whose out.path is the S0 anchor's REAL ANCESTOR pool (walk-up ownership) is accepted", async () => {
  // S0 home anchor = C:/proj/packages/app; the owning pool lives at the
  // ancestor C:/proj/.opencode/forge.json. The mock server (and the flow's
  // binding) must treat this as the legal walk-up shape — the TEST binds the
  // real fixture paths, no subtree validation is demanded from the product.
  const S0 = "C:/proj/packages/app"
  const ancestorPool = "C:/proj/.opencode/forge.json"
  const rpc = editOpenScripted(fakeRpc({}), [
    editOpenOk({
      path: ancestorPool,
      observedLocation: S0,
      anchor: S0,
    }),
  ])
  const { ui, toasts, calls } = scriptedUi([
    "__source-detail__", // the exact path lives in "Source / file details" (short title UX)
    ({ args }) => {
      const surface = JSON.stringify(args)
      assert.ok(surface.includes(ancestorPool), `the ancestor pool path is disclosed in the source details — details: ${surface.slice(0, 600)}`)
      return undefined // close the details browse
    },
    undefined, // quit
  ])
  await createForgeConfigEditor(makeDeps(ui, rpc, { initialScope: { kind: "home", anchor: S0, sessionID: null }, scope: { sessionID: null, anchor: S0, kind: "home" } })).open(S0)
  assert.ok(!toasts.some((t) => t.variant === "error"), `an ancestor owning pool is a legal workspace target — toasts: ${JSON.stringify(toasts).slice(0, 400)}`)
  assert.ok(JSON.stringify(calls ?? []).includes("__source-detail__"), "the source details entry is offered in the list")
})

test("legal: switch to global — answer scope=global, anchor=null, observedLocation=S0.anchor binds the global view", async () => {
  const rpc = editOpenScripted(fakeRpc({}), [
    editOpenOk({}),
    editOpenOk({ scope: "global", sessionID: null, anchor: null, observedLocation: "C:/proj", targetIdentity: "tgt-global" }),
  ])
  const { ui, toasts, calls } = scriptedUi([
    "__switch__", // workspace view → global view (second editOpen)
    undefined, // close in the global view
  ])
  await createForgeConfigEditor(makeDeps(ui, rpc)).open("C:/proj")
  const opens = rpc.calls.filter((c) => c[0] === "editOpen")
  assert.equal(opens.length, 2, `the switch issues exactly one fresh editOpen — saw: ${opens.length}`)
  assert.equal(opens[1][1].scope, "global", "the second open requests the global scope")
  assert.ok(!toasts.some((t) => t.variant === "error"), `a legal global answer (anchor null) must bind, not refuse — toasts: ${JSON.stringify(toasts).slice(0, 500)}`)
  assert.ok(JSON.stringify(calls ?? []).includes("Global workers"), "the global view renders")
})

// ---------------------------------------------------------------------------
// Response-binding matrix round 2 (same discipline as the block above):
// scope/sessionID must equal the REQUEST; missing contract fields refuse;
// POSIX directory identity is CASE-SENSITIVE (the equivalence helper must
// never key off the TUI's process.platform — a remote Windows server behind
// a POSIX TUI must still fold by the path's own rules; no realpath, no
// guessing); a saved receipt survives a refused reload.
// ---------------------------------------------------------------------------

test("RED evidence: answer scope=global to a workspace request: refused, never bound, zero writes", async () => {
  const rpc = editOpenScripted(fakeRpc({}), [
    editOpenOk({ scope: "global", sessionID: null, anchor: null, observedLocation: "C:/proj", targetIdentity: "tgt-x" }),
  ])
  const { ui, toasts, calls } = scriptedUi([undefined])
  await createForgeConfigEditor(makeDeps(ui, rpc)).open("C:/proj")
  assertNoWrites(rpc, "scope mismatch")
  assert.ok(toasts.some((t) => t.variant === "error"), `a scope≠request answer must refuse — toasts: ${JSON.stringify(toasts).slice(0, 400)}`)
  assert.ok(!JSON.stringify(calls ?? []).includes("Global workers"), "the mismatched global answer never renders the global view")
})

test("RED evidence: answer sessionID sess-other to a sess-1 session scope: refused, never bound", async () => {
  const S0 = { kind: "session", sessionID: "sess-1", anchor: "C:/proj" }
  const rpc = editOpenScripted(fakeRpc({}), [
    editOpenOk({ sessionID: "sess-other" }),
  ])
  const { ui, toasts, calls } = scriptedUi([undefined])
  await createForgeConfigEditor(makeDeps(ui, rpc, { initialScope: S0, scope: S0 })).open("C:/proj")
  assertNoWrites(rpc, "sessionID mismatch")
  assert.ok(toasts.some((t) => t.variant === "error"), `a sessionID≠request answer must refuse — toasts: ${JSON.stringify(toasts).slice(0, 400)}`)
  assert.ok(!JSON.stringify(calls ?? []).includes("worker:scout"), "the mismatched answer never binds its document")
})

test("RED evidence: answer missing the observedLocation contract field: CONTROLLED refusal (Open discarded + missing-field explanation) — never a throw", async () => {
  const partial = editOpenOk({})
  delete partial.observedLocation // contract requires it (rpc.ts editOpenOkSchema)
  const rpc = editOpenScripted(fakeRpc({}), [partial])
  const { ui, toasts, calls } = scriptedUi([undefined])
  // The verdict must fail CLOSED on the incomplete shape (undefined is not
  // null; trim on it must never run) — a controlled disclosure, never an
  // exception escaping open().
  await assert.doesNotReject(
    () => createForgeConfigEditor(makeDeps(ui, rpc)).open("C:/proj"),
    "a malformed wire answer is refused, never thrown",
  )
  assertNoWrites(rpc, "missing field")
  const disclosed = toasts.map((t) => `${t.title ?? ""} ${t.message ?? ""}`).join("")
  assert.ok(toasts.some((t) => t.variant === "error"), `an incomplete contract answer must refuse with an error disclosure — toasts: ${JSON.stringify(toasts).slice(0, 500)}`)
  assert.ok(/open discarded/i.test(disclosed), `the refusal is the controlled open-discard disclosure — got: ${disclosed.slice(0, 400)}`)
  assert.ok(/observed location|observedLocation/i.test(disclosed), `the disclosure explains the missing observed location — got: ${disclosed.slice(0, 400)}`)
  assert.ok(!/TypeError|\.trim|Cannot read/i.test(disclosed), `the raw failure mechanics never leak into the disclosure — got: ${disclosed.slice(0, 400)}`)
  assert.ok(!JSON.stringify(calls ?? []).includes("worker:scout"), "the incomplete answer never binds its document")
})

test("RED evidence: an ok:false refusal message carrying a fake token is MASKED in the disclosure (safeErrorText whitelist; the raw secret never surfaces)", async () => {
  // Fake credential shapes ONLY (no real secret): a Bearer assignment and a
  // JWT-looking string — the masking counterexample for the ok:false branch
  // (flow openDocument refusal disclosure).
  const fakeBearer = "Bearer faketoken1234567890abcdef"
  const fakeJwt = "eyJfake.header.payload.signature00"
  const rpc = editOpenScripted(fakeRpc({}), [])
  rpc.editOpen = async (req, opts) => {
    rpc.calls.push(["editOpen", req, opts])
    return { ok: false, reason: "unavailable", message: `upstream refused (Authorization: ${fakeBearer}; token ${fakeJwt})` }
  }
  const { ui, toasts, calls } = scriptedUi([undefined])
  await assert.doesNotReject(() => createForgeConfigEditor(makeDeps(ui, rpc)).open("C:/proj"))
  assertNoWrites(rpc, "ok:false masking")
  const disclosed = toasts.map((t) => `${t.title ?? ""} ${t.message ?? ""}`).join("")
  assert.ok(disclosed.length > 0, "the ok:false refusal is disclosed")
  assert.ok(!disclosed.includes(fakeBearer), `the raw fake Bearer credential must never surface — disclosure: ${disclosed.slice(0, 500)}`)
  assert.ok(!disclosed.includes(fakeJwt), `the raw fake JWT must never surface — disclosure: ${disclosed.slice(0, 500)}`)
  assert.ok(/masked/i.test(disclosed), `the masking is visible in the disclosure — disclosure: ${disclosed.slice(0, 500)}`)
})

test("POSIX identity: /Work vs S0 /work is a DIFFERENT directory — refused (case-sensitive fold, never platform-keyed)", async () => {
  const rpc = editOpenScripted(fakeRpc({}), [
    editOpenOk({ path: "/Work/.opencode/forge.json", observedLocation: "/Work", anchor: "/Work" }),
  ])
  const { ui, toasts, calls } = scriptedUi([undefined])
  await createForgeConfigEditor(makeDeps(ui, rpc, { initialScope: { kind: "home", anchor: "/work", sessionID: null }, scope: { sessionID: null, anchor: "/work", kind: "home" } })).open("/work")
  assertNoWrites(rpc, "posix case")
  assert.ok(toasts.some((t) => t.variant === "error"), `"/Work" is not "/work" on a POSIX server — toasts: ${JSON.stringify(toasts).slice(0, 400)}`)
  assert.ok(!JSON.stringify(calls ?? []).includes("/Work"), "the foreign POSIX spelling never binds")
})

test("POSIX identity: exact /work answer binds (same directory, legal)", async () => {
  const rpc = editOpenScripted(fakeRpc({}), [
    editOpenOk({ path: "/work/.opencode/forge.json", observedLocation: "/work", anchor: "/work" }),
  ])
  const { ui, toasts, calls } = scriptedUi([undefined])
  await createForgeConfigEditor(makeDeps(ui, rpc, { initialScope: { kind: "home", anchor: "/work", sessionID: null }, scope: { sessionID: null, anchor: "/work", kind: "home" } })).open("/work")
  assert.ok(!toasts.some((t) => t.variant === "error"), `the exact POSIX directory is legal — toasts: ${JSON.stringify(toasts).slice(0, 400)}`)
  assert.ok(JSON.stringify(calls ?? []).includes("worker:scout"), "the document binds")
})

test("a saved receipt SURVIVES a refused reload: sync retry stays armed, the recipe is never re-committed", async () => {
  const rpc = fakeRpc({ syncPrepare: syncPrepareOk({ syncToken: "synctok-r2" }) })
  const { ui, toasts, calls } = scriptedUi([
    ...editScript("receipt text"),
    "__save__",
    true, // confirm save (receipt written, sync:null → auto first sync)
    false, // CANCEL the auto first sync at its projection-preview confirm
    "__reload__", // reload — this editOpen now answers a FOREIGN binding
    undefined, // close after the refusal
    true, // the draft honestly stays pending — discard it to quit
  ])
  // First editOpen (the editor open + the save's snapshot) legal; the
  // RELOAD's answer is foreign (home S0 A, answer B).
  const legal = editOpenOk({})
  const foreign = editOpenOk({
    path: `${FOREIGN}/.opencode/forge.json`,
    observedLocation: FOREIGN,
    anchor: FOREIGN,
  })
  let openSeq = 0
  const origEditOpen = rpc.editOpen
  rpc.editOpen = async (req, opts) => {
    rpc.calls.push(["editOpen", req, opts])
    openSeq++
    // opens 1..N during the save flow are legal; the reload gets the foreign answer
    return openSeq <= 2 ? legal : foreign
  }
  await createForgeConfigEditor(makeDeps(ui, rpc)).open("C:/proj")
  const reloadToast = toasts.some((t) => t.variant === "error" && /refus|bind|observed|anchor|foreign|scope/i.test(`${t.title ?? ""} ${t.message ?? ""}`))
  assert.ok(reloadToast, `the foreign reload answer must be refused with an error disclosure — toasts: ${JSON.stringify(toasts).slice(0, 600)}`)
  const lastSelect = [...calls].reverse().find((c) => c.kind === "select")
  assert.ok(lastSelect, "a list dialog is still offered after the refusal")
  assert.ok(
    (lastSelect.args?.options ?? []).some((o) => o.value === "__retry-sync__"),
    `the saved receipt keeps the sync retry armed — options: ${JSON.stringify((lastSelect.args?.options ?? []).map((o) => o.value))}`,
  )
  assert.equal(rpc.commitCalls().length, 1, "the refused reload never re-runs the recipe commit")
})

// ---------------------------------------------------------------------------
// forge-tui-subagent-config RED batch r1 (2026-11-28): an existing entry's
// UPDATE draft never overlays its list row — entriesForView only merges
// pending op === "create" (src/tui/flow.ts). The rows below use the OLD
// model-chain menu path (worker → model → pinned → manual identity → level
// → back) deliberately, so the red is the ROW defect, not unbuilt new UX.
// The seed snapshot carries scout pinned prov/old @ low.
// ---------------------------------------------------------------------------

const PINNED_SEED = {
  raw: '{ "pool": "proj", "agents": { "scout": { "model": "prov/old", "thoughtLevel": "low" } } }',
  doc: { pool: "proj", agents: { scout: { model: "prov/old", thoughtLevel: "low" } } },
}

// Row-level unsaved marker wording is negotiable pending the new UX — the
// hard red is the draft VALUE visibility on the row.
const ROW_MARKER = /pending|unsaved|draft|modified|\*/

function scoutRow(options) {
  return (options ?? []).find((o) => o.value === "worker:scout")
}

test("RED r1 overlay: existing pinned scout edited to prov/new@high — the list row shows the DRAFT values with a row-level unsaved marker", async () => {
  const rpc = fakeRpc(PINNED_SEED)
  const { ui } = scriptedUi([
    "worker:scout",
    "model",

    "prov/new", // manual identity prompt (catalog unavailable)
    "level:high",
    "back", // draft kept — the list re-renders
    async ({ args }) => {
      const row = scoutRow(args.options)
      assert.ok(row, `the scout row is listed — options: ${JSON.stringify((args.options ?? []).map((o) => o.value))} — title: ${args.title}`)
      const surface = `${row.title} ${row.description ?? ""} ${row.footer ?? ""}`
      assert.ok(
        surface.includes("prov/new") && surface.includes("high"),
        `the row must show the DRAFT pin prov/new@high (the pre-edit red: it still shows the snapshot prov/old@low) — row: ${JSON.stringify(row)}`,
      )
      assert.ok(
        !surface.includes("prov/old"),
        `the snapshot value prov/old must not read as the live state once a draft exists — row: ${JSON.stringify(row)}`,
      )
      assert.ok(
        ROW_MARKER.test(surface),
        `the row itself must carry an unsaved marker (wording negotiable: ${ROW_MARKER}) — row: ${JSON.stringify(row)}`,
      )
      return undefined // quit
    },
    true, // the update draft is honestly pending — discard to quit
  ])
  await createForgeConfigEditor(makeDeps(ui, rpc)).open("C:/proj")
})

test("RED r2 Auto: existing pinned scout converted to Auto — the list row shows Auto (not the stale snapshot pin)", async () => {
  const rpc = fakeRpc(PINNED_SEED)
  const { ui } = scriptedUi([
    "worker:scout",
    "mode", // the mode select (Auto/Pinned), then pick Auto
    "auto",
    "back",
    async ({ args }) => {
      const row = scoutRow(args.options)
      assert.ok(row, `the scout row is listed — options: ${JSON.stringify((args.options ?? []).map((o) => o.value))}`)
      const surface = `${row.title} ${row.description ?? ""} ${row.footer ?? ""}`
      assert.ok(
        /\bAuto\b/i.test(surface),
        `the row must show the DRAFT Auto mode (the pre-edit red: it still shows the snapshot prov/old@low pin) — row: ${JSON.stringify(row)}`,
      )
      assert.ok(
        !surface.includes("prov/old"),
        `the snapshot pin must not read as the live state in Auto draft mode — row: ${JSON.stringify(row)}`,
      )
      assert.ok(ROW_MARKER.test(surface), `the row itself must carry an unsaved marker — row: ${JSON.stringify(row)}`)
      return undefined
    },
    true, // discard the pending Auto draft to quit
  ])
  await createForgeConfigEditor(makeDeps(ui, rpc)).open("C:/proj")
})

test("RED r3 search draft: searching matches the DRAFT model (prov/new) and no longer the snapshot value (prov/old)", async () => {
  const rpc = fakeRpc(PINNED_SEED)
  const { ui } = scriptedUi([
    "worker:scout",
    "model",

    "prov/new",
    "level:high",
    "back",
    "__search__",
    "prov/new", // the DRAFT model text
    async ({ args }) => {
      const row = scoutRow(args.options)
      assert.ok(
        row,
        `the draft model text prov/new must MATCH the pending scout row (search runs over the overlay) — options: ${JSON.stringify((args.options ?? []).map((o) => o.value))}`,
      )
      return "__search__"
    },
    "prov/old", // the SNAPSHOT model text
    async ({ args }) => {
      const row = scoutRow(args.options)
      assert.ok(
        row === undefined,
        `the snapshot value prov/old must no longer match once a draft overlays the row — options: ${JSON.stringify((args.options ?? []).map((o) => o.value))}`,
      )
      return undefined
    },
    true, // discard the pending draft to quit
  ])
  await createForgeConfigEditor(makeDeps(ui, rpc)).open("C:/proj")
})

test("GUARD r4 discard: discarding the update draft restores the snapshot row and never refreshes the held snapshot", async () => {
  const rpc = fakeRpc(PINNED_SEED)
  const { ui } = scriptedUi([
    "worker:scout",
    "model",

    "prov/new",
    "level:high",
    "back",
    "__discard__",
    true, // confirm the discard
    async ({ args }) => {
      const row = scoutRow(args.options)
      assert.ok(row, `the scout row is still listed after the discard — options: ${JSON.stringify((args.options ?? []).map((o) => o.value))}`)
      const surface = `${row.title} ${row.description ?? ""} ${row.footer ?? ""}`
      assert.ok(
        surface.includes("prov/old") && surface.includes("low"),
        `the discarded draft is gone: the row shows the SNAPSHOT prov/old@low again — row: ${JSON.stringify(row)}`,
      )
      assert.ok(
        !surface.includes("prov/new"),
        `no draft residue after the discard — row: ${JSON.stringify(row)}`,
      )
      assert.ok(
        !/pending change/i.test(args.title ?? ""),
        `the list title no longer counts pending changes after the discard — title: ${args.title}`,
      )
      return undefined // quit — nothing pending, no guard
    },
  ])
  await createForgeConfigEditor(makeDeps(ui, rpc)).open("C:/proj")
  const opens = rpc.calls.filter((c) => c[0] === "editOpen").length
  assert.equal(opens, 1, `the discard never re-opens the document (the held snapshot is unpolluted) — editOpen calls: ${opens}`)
})

// Batch r2 (2026-11-28): delete row marker (red), receipt detail at any
// count (red, currently gated to >10 entries), the negotiated level-only
// in-page menu (new UX — honest red until implemented), the save batch
// disclosure (red), and the refresh-failed receipt guard.

test("RED r5 delete marker: a pending ctrl+d deletion is disclosed ON THE ROW (not only the global pending count)", async () => {
  const rpc = fakeRpc(PINNED_SEED)
  const { ui, calls } = scriptedUi([
    async ({ args }) => {
      const del = args.actions?.find((a) => a.bind === "ctrl+d")
      assert.ok(del, "the list exposes a ctrl+d delete action")
      void del.onTrigger("worker:scout") // the product's own ui.clear() closes the list
      return PENDING_CLEAR
    },
    true, // confirm the deletion (stays a pending draft)
    async ({ args }) => {
      const row = scoutRow(args.options)
      assert.ok(row, `the pending-delete scout row stays listed — options: ${JSON.stringify((args.options ?? []).map((o) => o.value))}`)
      const surface = `${row.title} ${row.description ?? ""} ${row.footer ?? ""}`
      assert.ok(
        /pending delet|delete|remov/i.test(surface),
        `the row itself must carry a deletion marker (the pre-edit red: it still reads as a normal pinned worker) — row: ${JSON.stringify(row)}`,
      )
      return undefined // quit
    },
    true, // the pending deletion is honestly unsaved — discard to quit
  ])
  await createForgeConfigEditor(makeDeps(ui, rpc)).open("C:/proj")
})

test("UX r6 receipt detail at ANY count: the receipt-detail entry is offered for a 2-entry receipt (the >10 gate is gone) and the summary toast stays short", async () => {
  const rpc = fakeRpc({
    entries: [
      { opId: "worker:update:scout", id: "scout", kind: "worker", action: "update", entryKind: "patch", outcome: "written", summary: ["prompt updated"], findings: [] },
      { opId: "worker:update:scribe", id: "scribe", kind: "worker", action: "update", entryKind: "patch", outcome: "written", summary: ["prompt updated"], findings: [] },
    ],
  })
  const { ui, toasts } = scriptedUi([
    ...editScript("detail text"),
    "__save__",
    true, // confirm save (receipt written, auto first sync)
    false, // CANCEL the auto first sync
    async ({ args }) => {
      assert.ok(
        (args.options ?? []).some((o) => o.value === "__receipt-detail__"),
        `the receipt-detail entry must be offered at ANY receipt count (the pre-edit red: gated to entries.length > 10) — options: ${JSON.stringify((args.options ?? []).map((o) => o.value))}`,
      )
      const bloated = toasts.find((t) => `${t.title ?? ""} ${t.message ?? ""}`.length > 600)
      assert.ok(bloated === undefined, `the summary toast stays short — the detail lives behind the receipt-detail entry — longest toast: ${bloated === undefined ? "(none)" : JSON.stringify(bloated).slice(0, 700)}`)
      return undefined
    },
    true, // quit
  ])
  await createForgeConfigEditor(makeDeps(ui, rpc)).open("C:/proj")
  assert.ok(toasts.some((t) => /saved/i.test(JSON.stringify(t))), "the save receipt is surfaced")
})

test("UX r7 level-only: the entry menu offers an independent level step — NO provider/model prompt on the way (negotiated menu contract)", async () => {
  const rpc = fakeRpc(PINNED_SEED)
  const { ui } = scriptedUi([
    "worker:scout",
    async ({ args }) => {
      const lvl = (args.options ?? []).find((o) => o.value === "level")
      assert.ok(
        lvl,
        `the entry menu must offer an independent level step (the pre-edit red: level is only reachable through the model chain) — options: ${JSON.stringify((args.options ?? []).map((o) => o.value))}`,
      )
      return "level"
    },
    "level:high", // straight to the level select — no model/provider dialog in between
    "back",
    async ({ args }) => {
      const row = scoutRow(args.options)
      assert.ok(row, `the scout row is listed — options: ${JSON.stringify((args.options ?? []).map((o) => o.value))}`)
      const surface = `${row.title} ${row.description ?? ""} ${row.footer ?? ""}`
      assert.ok(
        surface.includes("prov/old") && surface.includes("high"),
        `a level-only change keeps the pin's model and moves ONLY the level — row: ${JSON.stringify(row)}`,
      )
      assert.ok(ROW_MARKER.test(surface), `the row itself must carry an unsaved marker — row: ${JSON.stringify(row)}`)
      return undefined
    },
    true, // discard the pending draft to quit
  ])
  await createForgeConfigEditor(makeDeps(ui, rpc)).open("C:/proj")
})

test("UX r8 save batch disclosure: the save entry is plain, and BEFORE the confirm the batch is enumerated (per-entry confirm content + prepare ops carry every batch item)", async () => {
  const rpc = fakeRpc(PINNED_SEED)
  const { ui, calls } = scriptedUi([
    "worker:scout",
    "model",

    "prov/new",
    "level:high",
    "back",
    "__save__", // the entry itself stays a short launcher — no entry list in its title
    ({ args }) => {
      // The PREVIEW CONFIRM is where the batch is disclosed: per-entry.
      const surface = `${args.title ?? ""} ${args.message ?? ""}`
      assert.ok(
        /scout/.test(surface),
        `the confirm must enumerate the batch entries before the user confirms — confirm: ${JSON.stringify({ title: args.title, message: args.message }).slice(0, 600)}`,
      )
      return true // confirm the save
    },
    true, // confirm the AUTO first-sync projection preview
    undefined, // close
    true, // quit
  ])
  await createForgeConfigEditor(makeDeps(ui, rpc)).open("C:/proj")
  const prepare = rpc.calls.find((c) => c[0] === "prepare")
  assert.ok(prepare, "save goes through prepare")
  assert.ok(
    prepare[1].ops.some((op) => op.id === "scout" && op.kind === "worker"),
    `the prepare ops carry every item of the current batch — ops: ${JSON.stringify(prepare[1].ops)}`,
  )
  const confirms = calls.filter((c) => c.kind === "confirm")
  assert.ok(confirms.length >= 1, "an explicit confirm precedes the commit")
})

test("GUARD r9 the save's OWN post-receipt refresh FAILS: saved + refresh-failed are BOTH disclosed and the receipt stays queryable (sync retry armed, zero re-commit)", async () => {
  const rpc = fakeRpc({})
  const origEditOpen = rpc.editOpen
  let opens = 0
  rpc.editOpen = async (req, opts) => {
    opens++
    if (opens === 2) throw new Error("editOpen failed (connection lost)") // the receipt flow's INTERNAL fresh-open, right after the written receipt
    return origEditOpen(req, opts)
  }
  const { ui, toasts } = scriptedUi([
    ...editScript("refresh-guard text"),
    "__save__",
    true, // confirm save → receipt written → the internal refresh editOpen THROWS → the list returns with NO document open
    ({ args }) => {
      const options = (args.options ?? []).map((o) => o.value)
      assert.ok(
        options.includes("__retry-sync__"),
        `the saved receipt keeps the sync retry armed across the FAILED internal refresh — options: ${JSON.stringify(options)}`,
      )
      return undefined // quit
    },
    true, // the failed refresh left the drafts honestly pending — discard to quit
  ])
  await createForgeConfigEditor(makeDeps(ui, rpc)).open("C:/proj")
  const disclosed = toasts.map((t) => `${t.title ?? ""} ${t.message ?? ""}`).join("\n")
  assert.ok(/saved/i.test(disclosed), `the written receipt is disclosed — toasts: ${JSON.stringify(toasts).slice(0, 600)}`)
  assert.ok(
    toasts.some((t) => /unavailable|failed/i.test(`${t.title ?? ""} ${t.message ?? ""}`) && /saved/i.test(`${t.message ?? ""}`)),
    `the failed refresh is disclosed WITH the saved-receipt reassurance — toasts: ${JSON.stringify(toasts).slice(0, 600)}`,
  )
  assert.equal(rpc.commitCalls().length, 1, "the failed refresh never re-runs the recipe commit")
  assert.equal(opens, 2, `exactly the editor open + the failed internal refresh (the thrown call never binds a document) — editOpen attempts: ${opens}`)
})

// Batch b (2026-11-28, review P2 boundary round): rebase edge cases around
// externally-changed targets — an update draft whose entry vanished
// server-side, and a create draft colliding with an external same-id entry
// that carries base findings.

test("RED b1 update target vanished externally: reload + Keep draft — the pending update stays visible AND searchable, is marked target-missing, and never converts to a create", async () => {
  const rpc = fakeRpc(PINNED_SEED)
  const origEditOpen = rpc.editOpen
  let opens = 0
  rpc.editOpen = async (req) => {
    opens++
    const r = await origEditOpen(req)
    if (opens >= 2) {
      // EXTERNAL deletion: the fresh document no longer contains scout.
      const ext = { pool: "proj", agents: {} }
      return { ...r, raw: JSON.stringify(ext), document: ext }
    }
    return r
  }
  const { ui, toasts, calls } = scriptedUi([
    "worker:scout",
    "prompt",
    "replace",
    "external vanish text",
    "back",
    "__reload__", // fresh open → the gone-entry rebase ask
    true, // Keep draft
    "__search__",
    "scout", // the draft's id must still MATCH
    async ({ args }) => {
      const row = scoutRow(args.options)
      assert.ok(
        row,
        `the kept pending UPDATE must stay visible and searchable after its base vanished — options: ${JSON.stringify((args.options ?? []).map((o) => o.value))}`,
      )
      const surface = `${row.title} ${row.description ?? ""} ${row.footer ?? ""}`
      assert.ok(
        /gone|missing|no longer|not in the|vanished/i.test(surface),
        `the row must mark that its TARGET no longer exists in the document — row: ${JSON.stringify(row)}`,
      )
      return "__save__"
    },
    ({ args }) => {
      const surface = `${args.title ?? ""} ${args.message ?? ""}`
      assert.ok(/scout/.test(surface), `the confirm enumerates the kept batch — confirm: ${JSON.stringify({ title: args.title, message: args.message }).slice(0, 500)}`)
      return true // confirm the save
    },
    ({ args }) => {
      // The save's own fresh open rebases the kept draft — the gone-target
      // ask may re-fire here. Keep the draft explicitly (never a bare tail).
      if (/gone from the fresh document/i.test(args.title ?? "")) return true
      return true
    },
    ({ args }) => {
      // Any later confirm: cancel the sync preview, accept the discard guard.
      if (args.options !== undefined) return undefined // a list dialog: Esc
      if (/Discard pending/i.test(args.title ?? "")) return true
      return undefined // e.g. the sync projection confirm — cancel, retry stays armed
    },
    ({ args }) => {
      if (args.options !== undefined) return undefined // the list: Esc
      return true // the discard guard (the kept draft is honestly pending)
    },
    ({ args }) => {
      if (args.options !== undefined) return undefined // the list: Esc
      return true // the discard guard (the kept draft is honestly pending)
    },
  ])
  await createForgeConfigEditor(makeDeps(ui, rpc)).open("C:/proj")
  const prepare = rpc.calls.find((c) => c[0] === "prepare")
  if (prepare !== undefined) {
    const scoutOps = prepare[1].ops.filter((op) => op.id === "scout")
    assert.equal(scoutOps.length, 1, `exactly one scout op — ${JSON.stringify(prepare[1].ops)}`)
    assert.equal(
      scoutOps[0].action,
      "update",
      `a kept update draft NEVER converts to create when its base vanished — op: ${JSON.stringify(scoutOps[0])}`,
    )
  } else {
    assert.ok(
      toasts.some((t) => /scout/i.test(JSON.stringify(t))),
      `a refused save must still disclose the kept scout draft's fate — toasts: ${JSON.stringify(toasts.slice(-4)).slice(0, 600)}`,
    )
  }
})

test("RED b2 pending create collides with an external same-id entry carrying findings: reload keeps the draft — the conflict is disclosed, the fresh base findings stay visible, nothing claims 'not in the saved recipe', and a save still prepares a REFUSED create", async () => {
  const rpc = fakeRpc({
    ...PINNED_SEED,
    prepareFail: true,
    prepareFailReason: "duplicate-id",
    prepareFailMsg: 'worker "scribe" already exists in the fresh document',
  })
  const origEditOpen = rpc.editOpen
  let opens = 0
  rpc.editOpen = async (req) => {
    opens++
    const r = await origEditOpen(req)
    if (opens >= 2) {
      // EXTERNAL creation of the same id — half-configured (model without a
      // thought level) so the fresh entry carries base findings.
      const ext = { pool: "proj", agents: { scribe: { model: "prov/only" } } }
      return { ...r, raw: JSON.stringify(ext), document: ext }
    }
    return r
  }
  const { ui, calls, toasts } = scriptedUi((() => {
    let asked = false
    let saved = false
    // The collision may surface as an explicit ask (Keep/Drop) or as a
    // silent keep + disclosed conflict — the test accepts EITHER shape and
    // asserts the CONTRACT, never an unknown dialog count.
    const listAsserts = (args) => {
      const row = (args.options ?? []).find((o) => o.value === "worker:scribe")
      assert.ok(
        row,
        `the kept create draft (and/or its external twin) is listed — options: ${JSON.stringify((args.options ?? []).map((o) => o.value))}`,
      )
      const listTitle = `${args.title ?? ""}`
      assert.ok(
        /INVALID|half-configured|FINDINGS/i.test(listTitle),
        `the fresh entry's BASE findings stay visible after the rebase — title: ${listTitle}`,
      )
      assert.ok(
        /already exists|duplicate|conflict|FINDINGS/i.test(`${listTitle} ${row.title} ${row.description ?? ""}`),
        `the create collision is disclosed (marker on the row or the list) — title: ${listTitle} row: ${JSON.stringify(row)}`,
      )
      assert.ok(
        !/not in (the )?saved recipe/i.test(`${listTitle} ${row.title} ${row.description ?? ""} ${toasts.map((t) => `${t.title ?? ""} ${t.message ?? ""}`).join(" ")}`),
        `a kept (unsaved) draft is never worded as "not in the saved recipe" — that phrasing is a receipt verdict and the draft has none`,
      )
      saved = true
      return "__save__" // the kept create must still prepare — and be refused
    }
    const fn2 = ({ args }) => {
      if (args.options !== undefined) {
        if (asked && !saved) return listAsserts(args) // the ask path: the list comes second
        return undefined // any other list (incl. the post-refusal re-render): Esc
      }
      return true // a confirm (the discard guard): the create draft stays pending — discard to quit
    }
    return [
      "__new-worker__",
      "scribe", // pending CREATE of scribe
      "auto",
      "__reload__", // fresh doc HAS scribe
      ({ args }) =>
        /already exists in the fresh document/i.test(args.title ?? "")
          ? ((asked = true), true) // Keep draft (the create stays, refused until resolved)
          : listAsserts(args), // no ask — the list re-rendered with the kept draft
      fn2,
      fn2,
      true, // residual guard answer (either path)
    ]
  })())
  await createForgeConfigEditor(makeDeps(ui, rpc)).open("C:/proj")
  const prepare = rpc.calls.find((c) => c[0] === "prepare")
  assert.ok(prepare, "the kept create draft still goes through prepare")
  const scribeOps = prepare[1].ops.filter((op) => op.id === "scribe")
  assert.equal(scribeOps.length, 1, `exactly one scribe op — ${JSON.stringify(prepare[1].ops)}`)
  assert.equal(scribeOps[0].action, "create", `the kept draft prepares as a CREATE (the server refuses it as a duplicate — never silently rewritten) — op: ${JSON.stringify(scribeOps[0])}`)
  assert.ok(
    toasts.some((t) => /refus|duplicate|already exists/i.test(JSON.stringify(t))),
    `the duplicate refusal is disclosed — toasts: ${JSON.stringify(toasts.slice(-4)).slice(0, 600)}`,
  )
})


// ---------------------------------------------------------------------------
// P1/WIRE/CTX boundary batch (2026-11-28, review close-out): background
// rebase vs an in-flight field menu, the Esc transaction on a rebase ask,
// partial-receipt rebase keeping external fields, in-menu save exiting the
// menu, the REAL embedded sync shape (gced dests + confirmed application),
// refused entries keeping reason/findings with an EMPTY summary, and
// query/scope context surviving a failed same-scope refresh. Every script
// answers by explicit step — no generic catch-alls, no AUTO_TAIL.
// ---------------------------------------------------------------------------

test("P1 background rebase vs an in-flight menu: a server.connected mid-editor rebases the pending — the stale menu's answer is DISCARDED (staleExit), never upserted over the fresh values", async () => {
  const rpc = fakeRpc(PINNED_SEED)
  const origEcho = rpc.echo
  let reconnected = false
  rpc.echo = async (req) => {
    const r = await origEcho(req)
    return reconnected ? { ...r, epoch: "ep-2" } : r // the reconnected server carries a NEW epoch → freshOpenAndRebase
  }
  const origEditOpen = rpc.editOpen
  let opens = 0
  rpc.editOpen = async (req) => {
    opens++
    const r = await origEditOpen(req)
    if (opens >= 2) {
      const ext = { pool: "proj", agents: { scout: { model: "prov/ext", thoughtLevel: "high" } } }
      return { ...r, epoch: "ep-2", raw: JSON.stringify(ext), document: ext }
    }
    return r
  }
  const events = {}
  const { ui, toasts } = scriptedUi([
    "worker:scout",
    () => {
      assert.ok(typeof events["server.connected"] === "function", "the flow subscribed to server.connected before the menu was opened")
      reconnected = true
      events["server.connected"]() // synchronous revision bump; the fresh open+rebase runs while the editor is in flight
      return "prompt" // the user's in-flight menu answer, racing the rebase
    },
    "replace",
    "user text", // arrives AFTER the background rebase — must be discarded, never upserted
    ({ args }) => {
      // The stale exit lands on the list; a search round-trip yields the
      // background fresh-open chain its event-loop turns before we assert.
      const probe = scoutRow(args.options)
      if (probe === undefined || !/prov\/ext/.test(`${probe.title} ${probe.footer ?? ""}`)) return "__search__"
      return undefined
    },
    ({ args }) => {
      if ((args.options ?? []).some((o) => o.value === "__search__")) return "prov/ext"
      return undefined
    },
    ({ args }) => {
      const row = scoutRow(args.options)
      assert.ok(row, `the scout row is listed — options: ${JSON.stringify((args.options ?? []).map((o) => o.value))}`)
      const surface = `${row.title} ${row.description ?? ""} ${row.footer ?? ""}`
      assert.ok(
        surface.includes("prov/ext") && surface.includes("high"),
        `the REBASED pending is authoritative after the background rebase — row: ${JSON.stringify(row)}`,
      )
      assert.ok(
        !surface.includes("user text") && !surface.includes("prov/old"),
        `the stale menu's answer and the pre-rebase base never resurface — row: ${JSON.stringify(row)}`,
      )
      assert.ok(
        toasts.some((t) => /changed while this entry editor|connection changed|rebased/i.test(`${t.title ?? ""} ${t.message ?? ""}`)),
        `the stale exit is disclosed — toasts: ${JSON.stringify(toasts.slice(-3)).slice(0, 600)}`,
      )
      return undefined // quit
    },
    true, // the rebased draft is honestly pending — discard to quit
  ])
  await createForgeConfigEditor(makeDeps(ui, rpc, { events })).open("C:/proj")
})

test("P1 Esc transaction on the gone-target rebase ask: pressing Esc (undefined) KEEPS the draft (a cancel is never a drop) — proven by a RE-OBSERVING reload that restores the entry (row + pending count), never by a doc=null absence", async () => {
  const rpc = fakeRpc(PINNED_SEED)
  const origEditOpen = rpc.editOpen
  let opens = 0
  rpc.editOpen = async (req) => {
    opens++
    const r = await origEditOpen(req)
    if (opens === 2) {
      const ext = { pool: "proj", agents: {} } // external deletion of scout (the reload's fresh doc)
      return { ...r, raw: JSON.stringify(ext), document: ext }
    }
    if (opens >= 3) return r // the RE-OBSERVING reload: the entry exists again server-side
    return r
  }
  const { ui, calls, toasts } = scriptedUi([
    "worker:scout",
    "prompt",
    "replace",
    "esc keep text",
    "back",
    "__reload__", // fresh doc has no scout → the gone-target ask
    ({ args }) => (/gone from the fresh document/i.test(args.title ?? "") ? undefined : true), // ESC = cancel the transaction
    ({ args }) => {
      // Doc is null here (the base is gone) — row absence proves NOTHING.
      // Re-observe through a reload that restores the entry.
      return "__reload__"
    },
    ({ args }) => {
      const row = scoutRow(args.options)
      assert.ok(row, `the restored entry is listed — options: ${JSON.stringify((args.options ?? []).map((o) => o.value))}`)
      assert.ok(
        /1 pending change/i.test(args.title ?? ""),
        `RAW EVIDENCE the draft was DROPPED by the cancelled ask: after the re-observing reload the pending count is 0 (expected 1) — title: ${args.title}`,
      )
      assert.ok(
        !toasts.some((t) => /Dropped the edit draft/i.test(`${t.title ?? ""} ${t.message ?? ""}`)),
        `no "Dropped" claim may appear for a CANCELLED ask — toasts: ${JSON.stringify(toasts.slice(-3)).slice(0, 500)}`,
      )
      const surface = `${row.title} ${row.description ?? ""} ${row.footer ?? ""}`
      assert.ok(
        /custom prompt/i.test(surface),
        `the kept draft's content survives the cancelled transaction — row: ${JSON.stringify(row)}`,
      )
      return undefined // quit
    },
    true, // the kept draft is honestly pending — discard to quit
  ])
  await createForgeConfigEditor(makeDeps(ui, rpc)).open("C:/proj")
})

test("P1 partial receipt rebase: a rejected entry stays pending and its untouched fields adopt the EXTERNAL fresh values on the next prepare (never overwrites the fresh base)", async () => {
  const rpc = fakeRpc({
    entries: [
      { opId: "worker:update:scout", id: "scout", kind: "worker", action: "update", entryKind: "patch", outcome: "rejected", summary: [], findings: [], reason: "external lock" },
      { opId: "worker:create:scribe", id: "scribe", kind: "worker", action: "create", entryKind: "create-file", outcome: "written", summary: ["scribe done"], findings: [] },
    ],
  })
  const origEditOpen = rpc.editOpen
  let opens = 0
  rpc.editOpen = async (req) => {
    opens++
    const r = await origEditOpen(req)
    if (opens >= 2) {
      // The REAL saved doc: scribe landed; scout changed EXTERNALLY (fresh
      // pin prov/ext@high + shape readonly) while our scout draft was refused.
      const ext = { pool: "proj", agents: { scout: { model: "prov/ext", thoughtLevel: "high", shape: "readonly" }, scribe: {} } }
      return { ...r, raw: JSON.stringify(ext), document: ext }
    }
    return r
  }
  const { ui, toasts } = scriptedUi([
    "worker:scout",
    "prompt",
    "replace",
    "mine",
    "back",
    "__new-worker__",
    "scribe",
    "auto",
    "__save__",
    true, // save confirm (scout refused + kept, scribe written; sync:null → auto first sync)
    true, // auto first-sync projection confirm
    "__save__", // back on the list — the SECOND save: the kept scout draft against the fresh doc
    true, // confirm the fresh preview
    true, // auto first-sync projection confirm
    undefined,
    ({ args }) => {
      if (args.options !== undefined) return undefined // the list: Esc
      return true // the kept scout draft honestly stays pending — discard to quit
    },
    ({ args }) => {
      if (args.options !== undefined) return undefined // the list: Esc
      return true // the kept scout draft honestly stays pending — discard to quit
    },
  ])
  await createForgeConfigEditor(makeDeps(ui, rpc)).open("C:/proj")
  assert.ok(toasts.some((t) => /RISK|REFUSED|external lock/i.test(JSON.stringify(t))), `the partial refusal is disclosed — toasts: ${JSON.stringify(toasts.slice(0, 6)).slice(0, 600)}`)
  const prepares = rpc.calls.filter((c) => c[0] === "prepare")
  assert.ok(prepares.length >= 2, `the kept draft re-prepares — ${prepares.length}`)
  const scoutOps = prepares[prepares.length - 1][1].ops.filter((op) => op.id === "scout")
  assert.equal(scoutOps.length, 1, `exactly one scout op — ${JSON.stringify(prepares[prepares.length - 1][1].ops)}`)
  const d = scoutOps[0].draft ?? {}
  assert.equal(d.prompt, "mine", `the USER's only edit survives the partial receipt — ${JSON.stringify(d)}`)
  assert.equal(d.model, "prov/ext", `the untouched model adopts the EXTERNAL fresh value (never the stale prov/old) — ${JSON.stringify(d)}`)
  assert.equal(d.thoughtLevel, "high", `the untouched level adopts the external value — ${JSON.stringify(d)}`)
  assert.equal(d.shape, "readonly", `the untouched shape adopts the external value (never reverts to the old draft's write) — ${JSON.stringify(d)}`)
})

test("P1 in-menu 'Save & Sync…' EXITS the entry editor: after the save the flow is back on the LIST (never a stale menu over the consumed pending)", async () => {
  const rpc = fakeRpc(PINNED_SEED)
  const { ui, calls } = scriptedUi([
    "worker:scout",
    "prompt",
    "replace",
    "menu save text",
    "save", // the in-menu save entry
    ({ args }) => {
      const surface = `${args.title ?? ""} ${args.message ?? ""}`
      assert.ok(/scout/.test(surface), `the confirm enumerates the batch — confirm: ${JSON.stringify({ title: args.title, message: args.message }).slice(0, 500)}`)
      return true // confirm the save
    },
    ({ args }) => {
      if (args.options !== undefined) return undefined // the list: Esc
      if (/Discard pending/i.test(args.title ?? "")) return true
      return undefined // the sync projection confirm — cancel, retry stays armed
    },
    ({ args }) => {
      const values = (args.options ?? []).map((o) => o.value)
      assert.ok(values.includes("__search__"), `the flow is back on the MAIN LIST after an in-menu save — options: ${JSON.stringify(values)}`)
      assert.ok(
        !values.some((v) => ["model", "level", "mode", "prompt", "shape", "perm", "save", "back"].includes(v)),
        `the STALE entry menu never re-renders after its save consumed the pending — options: ${JSON.stringify(values)}`,
      )
      return undefined // quit
    },
    ({ args }) => {
      if (args.options !== undefined) return undefined // the list: Esc
      return true // any residual guard
    },
  ])
  await createForgeConfigEditor(makeDeps(ui, rpc)).open("C:/proj")
  const confirmIdx = calls.findIndex((c) => c.kind === "confirm" && /Save & Sync 1 change/i.test(c.args?.title ?? ""))
  const menusAfter = calls.filter((c, i) => i > confirmIdx && c.kind === "select" && /Model…|Level…|Mode: Auto\/Pinned…/.test(JSON.stringify(c.args?.options ?? [])))
  assert.equal(menusAfter.length, 0, `zero entry menus render after the in-menu save — ${JSON.stringify(menusAfter.map((c) => c.args?.title))}`)
})

test("WIRE embedded sync shape: the REAL SyncApplyOk is surfaced verbatim — gced DEST paths, observedBy-confirmed application, never a fake unconfirmed RISK", async () => {
  const rpc = fakeRpc({
    syncApply: {
      ...syncApplyOk({}),
      gced: ["C:/proj/.opencode/agent/forge-proj-old.md"],
      appliedStatus: { status: "confirmed", observedBy: "native-walk-1", confirmedIds: ["forge-proj-scout"], removedConfirmedIds: [], unconfirmedIds: [] },
    },
  })
  const { ui, toasts } = scriptedUi([
    ...editScript("wire sync text"),
    "__save__",
    true, // confirm save (receipt written, sync:null → auto first sync)
    true, // confirm the AUTO first-sync projection preview
    "__sync-detail__", // the list → the COMPLETE sync outcome
    ({ args }) => {
      const page = JSON.stringify(args)
      assert.ok(
        page.includes("C:/proj/.opencode/agent/forge-proj-old.md"),
        `the gc'd DEST path is reported verbatim (a string[] of paths, never nativeIds) — detail: ${page.slice(0, 700)}`,
      )
      assert.ok(
        page.includes("native-walk-1"),
        `the confirmed application names its OBSERVER — detail: ${page.slice(0, 700)}`,
      )
      return undefined // close the detail
    },
    undefined, // the list: Esc
    true, // the draft honestly stays pending — discard to quit
    ({ args }) => {
      const page = JSON.stringify(args)
      assert.ok(
        page.includes("C:/proj/.opencode/agent/forge-proj-old.md"),
        `the gc'd DEST path is reported verbatim (a string[] of paths, never nativeIds) — detail: ${page.slice(0, 700)}`,
      )
      assert.ok(
        page.includes("native-walk-1"),
        `the confirmed application names its OBSERVER — detail: ${page.slice(0, 700)}`,
      )
      return undefined // close the detail
    },
    ({ args }) => {
      if (args.options !== undefined) return undefined // the list: Esc
      return true // any residual guard
    },
  ])
  await createForgeConfigEditor(makeDeps(ui, rpc)).open("C:/proj")
  const syncToast = toasts.find((t) => /Forge: Sync receipt/i.test(t.title ?? ""))
  assert.ok(syncToast !== undefined, `the short sync receipt toast is surfaced — toasts: ${JSON.stringify(toasts).slice(0, 700)}`)
  const surface = `${syncToast.title} ${syncToast.message}`
  assert.ok(/gc 1/i.test(surface), `the gc'd count is surfaced on the short toast — toast: ${JSON.stringify(syncToast)}`)
  assert.ok(/confirmed/i.test(surface), `the confirmed application is worded confirmed — toast: ${JSON.stringify(syncToast)}`)
  assert.ok(!/unconfirmed/i.test(surface), `a CONFIRMED application is never worded unconfirmed — toast: ${JSON.stringify(syncToast)}`)
})

test("WIRE refused entry with an EMPTY summary keeps its reason and findings reachable (never a blank detail row)", async () => {
  const rpc = fakeRpc({
    entries: [
      { opId: "worker:update:scout", id: "scout", kind: "worker", action: "update", entryKind: "patch", outcome: "rejected", summary: [], findings: [{ level: "error", code: "duplicate", message: "duplicate worker id" }], reason: "duplicate worker id" },
    ],
  })
  const { ui, toasts } = scriptedUi([
    ...editScript("reject text"),
    "__save__",
    true, // save confirm — the entry is REFUSED and kept pending
    ({ args }) => {
      const surface = `${args.title ?? ""} ${args.message ?? ""}`
      assert.ok(
        /REFUSED/i.test(surface),
        `the refusal is disclosed even with an empty summary — confirm: ${JSON.stringify({ title: args.title, message: args.message }).slice(0, 600)}`,
      )
      return true // the auto first-sync projection confirm
    },
    "__receipt-detail__",
    ({ args }) => {
      const page = JSON.stringify(args)
      assert.ok(
        /duplicate worker id/i.test(page),
        `the receipt detail carries the refusal reason/findings for the empty-summary entry — page: ${page.slice(0, 600)}`,
      )
      return undefined // close the browse
    },
    undefined, // quit
    true, // the refused draft stays pending — discard to quit
  ])
  await createForgeConfigEditor(makeDeps(ui, rpc)).open("C:/proj")
  assert.ok(
    toasts.some((t) => /Forge: Sync receipt/i.test(t.title ?? "")),
    `the save/sync outcome toast is still surfaced for the refused batch — toasts: ${JSON.stringify(toasts.slice(0, 5)).slice(0, 600)}`,
  )
})

test("CTX a FAILED same-scope refresh keeps the search query and the current scope (no context reset to an unfiltered default view)", async () => {
  const rpc = fakeRpc(PINNED_SEED)
  const origEditOpen = rpc.editOpen
  let opens = 0
  rpc.editOpen = async (req) => {
    opens++
    if (opens >= 2) throw new Error("editOpen failed (connection lost)") // the manual reload fails
    return origEditOpen(req)
  }
  const { ui, toasts } = scriptedUi([
    "__search__",
    "prov/old",
    ({ args }) => {
      assert.ok(
        /worker:scout/.test(JSON.stringify(args.options)),
        `the query filters the list — options: ${JSON.stringify((args.options ?? []).map((o) => o.value))}`,
      )
      return "__reload__" // same scope, the refresh FAILS
    },
    ({ args }) => {
      const searchOption = (args.options ?? []).find((o) => o.value === "__search__")
      assert.ok(
        searchOption !== undefined && /Search: "prov\/old"/i.test(searchOption.title ?? ""),
        `the query SURVIVES the failed refresh (the search entry still carries it) — options: ${JSON.stringify((args.options ?? []).map((o) => o.title))}`,
      )
      assert.ok(
        /Workspace workers/i.test(args.title ?? ""),
        `the scope is unchanged (still the workspace view) — title: ${args.title}`,
      )
      return undefined // quit
    },
    true, // quit — nothing pending, no guard
  ])
  await createForgeConfigEditor(makeDeps(ui, rpc)).open("C:/proj")
  assert.ok(
    toasts.some((t) => t.variant === "error" && /reload|open|fail|unavailable|fresh/i.test(`${t.title ?? ""} ${t.message ?? ""}`)),
    `the failed refresh is disclosed — toasts: ${JSON.stringify(toasts.slice(-3)).slice(0, 600)}`,
  )
})

// ---------------------------------------------------------------------------
// P1-precise (reviewer counterexamples A/B + title contracts): same-epoch
// reconnection during a sub-editor, revision-bump with a DELAYED fresh open
// from an empty-pending list, and the live menu title contracts.
// ---------------------------------------------------------------------------

test("P1-A same-epoch reconnection inside the Shape editor: revision-only change (pending array untouched) — the cancelled editor's 'readonly' answer NEVER lands on the shared draft (prepare must show prompt=P1, shape=write)", async () => {
  const rpc = fakeRpc(PINNED_SEED)
  const events = {}
  const { ui, toasts } = scriptedUi([
    "worker:scout",
    "prompt",
    "replace",
    "P1",
    "back", // pending exists: prompt=P1
    "worker:scout", // reopen the menu — it captures the CURRENT pending
    ({ args }) => {
      assert.ok(typeof events["server.connected"] === "function", "the flow subscribed to server.connected")
      events["server.connected"]() // SAME epoch/generation: revision++ only, NO freshOpen, pending array NOT swapped
      return "shape"
    },
    "readonly", // the in-flight answer racing the reconnection
    ({ args }) => {
      const values = (args.options ?? []).map((o) => o.value)
      assert.ok(
        !values.includes("shape"),
        `the stale menu must not re-render after the reconnection — options: ${JSON.stringify(values)}`,
      )
      const row = scoutRow(args.options)
      assert.ok(row, `the list is shown — options: ${JSON.stringify(values)}`)
      const surface = `${row.title} ${row.description ?? ""} ${row.footer ?? ""}`
      assert.ok(
        !/readonly/i.test(surface),
        `the cancelled editor's answer never lands on the draft — row: ${JSON.stringify(row)}`,
      )
      assert.ok(
        toasts.some((t) => /changed while this entry editor|connection changed|rebased/i.test(`${t.title ?? ""} ${t.message ?? ""}`)),
        `the invalidation is disclosed — toasts: ${JSON.stringify(toasts.slice(-3)).slice(0, 500)}`,
      )
      return "__save__"
    },
    ({ args }) => {
      const surface = `${args.title ?? ""} ${args.message ?? ""}`
      assert.ok(/scout/.test(surface), `the confirm enumerates the batch — confirm: ${JSON.stringify({ title: args.title, message: args.message }).slice(0, 500)}`)
      return true // confirm the save
    },
    ({ args }) => {
      if (args.options !== undefined) return undefined // the list: Esc
      if (/Discard pending/i.test(args.title ?? "")) return true
      return undefined // the sync projection confirm — cancel
    },
    ({ args }) => {
      if (args.options !== undefined) return undefined // the list: Esc
      return true // the kept draft honestly asks — discard to quit
    },
    ({ args }) => {
      if (args.options !== undefined) return undefined // the list: Esc
      return true // the kept draft honestly asks — discard to quit
    },
  ])
  await createForgeConfigEditor(makeDeps(ui, rpc, { events })).open("C:/proj")
  const prepare = rpc.calls.find((c) => c[0] === "prepare")
  assert.ok(prepare, "the kept batch prepares")
  const scoutOps = prepare[1].ops.filter((op) => op.id === "scout")
  assert.equal(scoutOps.length, 1, `exactly one scout op — ${JSON.stringify(prepare[1].ops)}`)
  const d = scoutOps[0].draft ?? {}
  assert.equal(d.prompt, "P1", `the earlier prompt edit survives — ${JSON.stringify(d)}`)
  assert.ok(
    d.shape === undefined || d.shape === "write",
    `the cancelled readonly answer must NOT reach the prepare (expected write/undefined) — ${JSON.stringify(d)}`,
  )
})

test("P1-B revision bumped while the fresh open is DELAYED (held echo): the old-document menu's prompt=P1 edit must never prepare over the fresh S1 doc — rebind keeps shape=readonly, invalidation exits clean", async () => {
  const rpc = fakeRpc(PINNED_SEED)
  const events = {}
  const origEcho = rpc.echo
  let armed = false
  let releaseEcho = null
  rpc.echo = async (req) => {
    if (armed && releaseEcho === null) {
      const r = await origEcho(req)
      return new Promise((resolve) => {
        releaseEcho = () => resolve({ ...r, epoch: "ep-2" }) // the reconnected server's NEW epoch, held until released
      })
    }
    const r = await origEcho(req)
    // Once the reconnection happened, EVERY later echo answers the NEW epoch —
    // an ep-1 answer after the doc advanced to ep-2 would self-contradict.
    return armed ? { ...r, epoch: "ep-2" } : r
  }
  const origEditOpen = rpc.editOpen
  let opens = 0
  const openLog = []
  rpc.editOpen = async (req) => {
    opens++
    const r = await origEditOpen(req)
    if (opens >= 2) {
      const s1 = { pool: "proj", agents: { scout: { model: "prov/ext", thoughtLevel: "high", shape: "readonly" } } }
      const out = { ...r, epoch: "ep-2", raw: JSON.stringify(s1), document: s1 }
      openLog.push({ open: opens, snapshotId: out.snapshotId, epoch: out.epoch, exists: out.exists, path: out.path })
      return out
    }
    openLog.push({ open: opens, snapshotId: r.snapshotId, epoch: r.epoch, exists: r.exists, path: r.path })
    return r
  }
  // COMPLETION BARRIER: the connected handler's tail fires the FIXED toast
  // "Server connection event (revision N)…" strictly AFTER
  // `await freshOpenAndRebase()` has fully finished (open + scope recheck +
  // rebase). Resolving a deferred from that toast is a deterministic
  // completion signal — no sleeps, no microtask counting, no src hooks.
  let openRebaseDone = null
  const openRebasePromise = new Promise((resolve) => {
    openRebaseDone = resolve
  })
  const { ui, toasts, calls } = scriptedUi([
    ({ args }) => {
      assert.ok(typeof events["server.connected"] === "function", "the flow subscribed to server.connected")
      armed = true
      events["server.connected"]() // revision++ NOW; the fresh open is stuck at the held echo
      return "worker:scout" // the user opens the menu against the OLD document
    },
    "prompt",
    "replace",
    ({ args }) => {
      releaseEcho?.() // let the held fresh open finish while the menu keeps running
      return "P1" // the prompt text, answered against the OLD document context
    },
    "back",
    async ({ args }) => {
      releaseEcho?.() // idempotent: start the held fresh open now
      await openRebasePromise // the open+rebase chain FULLY completed (its tail toast fired)
      // The doc-guard voids a pick made against the pre-fresh render — Esc
      // this list and re-observe; the guard "Stay" keeps the pending draft.
      const values = (args.options ?? []).map((o) => o.value)
      assert.ok(
        values.includes("__search__"),
        `the flow must be back on the LIST (a stale old-doc menu must not survive the fresh open) — options: ${JSON.stringify(values)}`,
      )
      return undefined
    },
    ({ args }) => {
      // Stay through the discard guard / re-observe until the fresh row shows.
      if (args.options === undefined) return false // a confirm: "Stay" — never discard the pending draft
      const row = scoutRow(args.options)
      if (row !== undefined && `${row.title} ${row.footer ?? ""}`.includes("prov/ext")) return "__save__"
      return false // keep looping (Stay) until the fresh document renders
    },
    ({ args }) => {
      if (args.options === undefined) return false // "Stay"
      const row = scoutRow(args.options)
      assert.ok(row, `the scout row is listed — options: ${JSON.stringify((args.options ?? []).map((o) => o.value))} — title: ${args.title}`)
      const surface = `${row.title} ${row.description ?? ""} ${row.footer ?? ""}`
      assert.ok(
        surface.includes("prov/ext"),
        `the fresh S1 document is authoritative — row: ${JSON.stringify(row)}`,
      )
      return "__save__"
    },
    ({ args }) => {
      // The prepared preview asks on its own surface; the prepare has ALREADY
      // run by now — assert the snapshot/draft contract from the recorded RPC.
      if (args.options !== undefined) {
        const values = (args.options ?? []).map((o) => o.value)
        if (values.includes("__preview-confirm__")) {
          const prepare = rpc.calls.find((c) => c[0] === "prepare")
          assert.ok(prepare !== undefined, "the save prepared before the preview ask")
          assert.equal(prepare[1].snapshotId, "snap-2", `the retry prepare binds the FRESH S1 snapshot — ${JSON.stringify(prepare[1])}`)
          const d = prepare[1].ops.find((op) => op.id === "scout")?.draft ?? {}
          assert.equal(d.shape, "readonly", `the rebind adopts the fresh readonly shape — ${JSON.stringify(d)}`)
          assert.equal(d.prompt, "P1", `the user's prompt=P1 survives the rebind — ${JSON.stringify(d)}`)
          assert.equal(d.model, "prov/ext", `the rebind adopts the fresh model — ${JSON.stringify(d)}`)
          return "__preview-confirm__"
        }
        return undefined // the list: Esc
      }
      if (/Discard pending/i.test(args.title ?? "")) return true
      return undefined // the sync projection confirm — cancel
    },
    ({ args }) => {
      if (args.options !== undefined) return undefined // the list: Esc
      return true // any kept draft honestly asks — discard to quit
    },
    ({ args }) => {
      if (args.options !== undefined) return undefined // the list: Esc
      return true // any kept draft honestly asks — discard to quit
    },
  ])
    // Toast instrument: the connected handler's tail toast IS the completion barrier.
  ui.toast = (input) => {
    toasts.push(input)
    if (/Server connection event/i.test(input?.message ?? "")) openRebaseDone?.()
  }
try {
  await createForgeConfigEditor(makeDeps(ui, rpc, { events })).open("C:/proj")
} catch (err) {
  console.error("B-DUMP", JSON.stringify({
    err: String(err).slice(0, 200),
    openLog,
    toasts: toasts.map((t) => `${t.title ?? ""} :: ${String(t.message ?? "").slice(0, 160)} [${t.variant}]`),
    rpc: rpc.calls.map((c) => `${c[0]}:${c[1]?.action ?? ""}:${c[1]?.snapshotId ?? ""}`),
  }))
  throw err
}
  const prepare = rpc.calls.find((c) => c[0] === "prepare")
  if (prepare !== undefined) {
    // A prepare against the FRESH S1 snapshot is legal ONLY with the
    // rebased shape — the old menu's draft must never prepare shape=write
    // over S1's readonly.
    const scoutOps = prepare[1].ops.filter((op) => op.id === "scout")
    assert.equal(scoutOps.length, 1, `exactly one scout op — ${JSON.stringify(prepare[1].ops)}`)
    const d = scoutOps[0].draft ?? {}
    assert.equal(d.shape, "readonly", `a prepare over the fresh S1 doc must carry the REBASED readonly shape, never the old draft's write — ${JSON.stringify(d)}`)
    assert.equal(d.prompt, "P1", `if the rebind keeps the edit, the user's prompt=P1 survives — ${JSON.stringify(d)}`)
  }
  // No prepare at all is equally legal: the invalidation exit dropped the
  // stale menu edit (asserted on the list step above).
})

test("P1-C menu title contracts: the title tracks the LIVE draft (a half-configured external base edits back to valid → Pinned → Auto, never stuck INVALID), and a fresh list row carries NO unsaved marker", async () => {
  const rpc = fakeRpc(PINNED_SEED)
  const origEditOpen = rpc.editOpen
  let opens = 0
  rpc.editOpen = async (req) => {
    opens++
    const r = await origEditOpen(req)
    if (opens >= 2) {
      // The external doc turned scout HALF-CONFIGURED (model without level).
      const ext = { pool: "proj", agents: { scout: { model: "prov/only" } } }
      return { ...r, raw: JSON.stringify(ext), document: ext }
    }
    return r
  }
  const { ui, calls } = scriptedUi([
    ({ args }) => {
      const row = scoutRow(args.options)
      assert.ok(row, `the scout row is listed — options: ${JSON.stringify((args.options ?? []).map((o) => o.value))}`)
      const surface = `${row.title} ${row.description ?? ""} ${row.footer ?? ""}`
      assert.ok(
        !/unsaved|pending update/i.test(surface),
        `a freshly opened document shows NO unsaved marker — row: ${JSON.stringify(row)}`,
      )
      assert.ok(
        !/pending change/i.test(args.title ?? ""),
        `a freshly opened list counts NO pending changes — title: ${args.title}`,
      )
      return "worker:scout"
    },
    "prompt",
    "replace",
    "repair text",
    "back", // pending update exists (prompt only)
    "__reload__", // the fresh external doc is half-configured → the rebase adopts it
    ({ args }) => {
      if (args.options === undefined) return true // a rebase ask: keep the draft
      if (scoutRow(args.options) !== undefined) return "worker:scout" // the list: reopen the (now half-configured) entry
      return undefined // the entry vanished from the list — fail the visibility contract below
    },
    ({ args }) => {
      const row = scoutRow(args.options)
      assert.ok(
        row,
        `the rebased half-configured draft must stay a VISIBLE row (editable) — options: ${JSON.stringify((args.options ?? []).map((o) => o.value))} title: ${args.title}`,
      )
      assert.ok(
        /half-configured|INVALID|update missing|GONE/i.test(`${row.title} ${row.description ?? ""} ${row.footer ?? ""}`),
        `the rebased state against a half-configured (skipped) base is honestly disclosed — row: ${JSON.stringify(row)}`,
      )
      return "worker:scout"
    },
    ({ args }) => {
      assert.ok(
        /INVALID|half-configured|update missing|GONE/i.test(args.title ?? ""),
        `the rebased draft against a half-configured (view-skipped) base is honestly titled — title: ${args.title}`,
      )
      return "mode"
    },
    "pinned", // repair through the pin chain: the menu re-renders, then model+level
    "model",
    "prov/fix",
    "level:high",
    ({ args }) => {
      assert.ok(
        !/INVALID|half-configured/i.test(args.title ?? ""),
        `after a valid pin the title tracks the LIVE draft (no stale INVALID) — title: ${args.title}`,
      )
      return "mode"
    },
    "auto",
    ({ args }) => {
      assert.ok(
        !/INVALID|half-configured/i.test(args.title ?? ""),
        `the Auto conversion keeps the title live (no stale INVALID) — title: ${args.title}`,
      )
      return "back"
    },
    ({ args }) => {
      const row = scoutRow(args.options)
      assert.ok(row, `the scout row is listed — options: ${JSON.stringify((args.options ?? []).map((o) => o.value))}`)
      const surface = `${row.title} ${row.description ?? ""} ${row.footer ?? ""}`
      assert.ok(
        !/INVALID|half-configured/i.test(surface),
        `after repairing to Auto the draft is no longer INVALID — row: ${JSON.stringify(row)}`,
      )
      assert.ok(
        /unsaved|pending update/i.test(surface) && /repair text|custom prompt/i.test(surface),
        `the repaired draft (with the user's prompt) stays pending and visible — row: ${JSON.stringify(row)}`,
      )
      return undefined // quit
    },
    true, // the pending Auto draft is honest — discard to quit
  ])
  await createForgeConfigEditor(makeDeps(ui, rpc)).open("C:/proj")
})

test("P2-a stale CtrlD under a clear() throw after the doc changed: the inline delete fallback must NOT raise a delete confirm for a target the fresh document no longer contains", { timeout: 6000 }, async () => {
  const rpc = fakeRpc(PINNED_SEED)
  const events = {}
  const origEcho = rpc.echo
  let armed = false
  rpc.echo = async (req) => {
    const r = await origEcho(req)
    return armed ? { ...r, epoch: "ep-2" } : r
  }
  const origEditOpen = rpc.editOpen
  let opens = 0
  rpc.editOpen = async (req) => {
    opens++
    const r = await origEditOpen(req)
    if (opens >= 2) {
      const ext = { pool: "proj", agents: {} } // scout is GONE in the fresh document
      return { ...r, epoch: "ep-2", raw: JSON.stringify(ext), document: ext }
    }
    return r
  }
  // Deterministic completion barrier: the connected tail toast fires only
  // AFTER freshOpenAndRebase has fully adopted the swapped document.
  let barrierDone = null
  const barrier = new Promise((resolve) => {
    barrierDone = resolve
  })
  const stale = { args: null, clearCalls: 0, confirmCalls: 0, deleteConfirms: 0 }
  const { ui, toasts } = scriptedUi([
    async ({ args }) => {
      // The FIRST list render: capture its args (rows + actions) as the
      // STALE surface, arm the epoch, make the host clear() THROW, swap the
      // document via the reconnection, WAIT for the rebase barrier, then —
      // and only then — fire the OLD args' ctrl+d and AWAIT it. The whole
      // stale-trigger transaction is completed inside this step.
      stale.args = args
      const del = (args.actions ?? []).find((a) => a.bind === "ctrl+d")
      assert.ok(del, "the stale list exposes a ctrl+d action")
      assert.ok(scoutRow(args.options), "the stale list shows scout")
      const prevToast = ui.toast
      ui.toast = (input) => {
        if (/Server connection event/i.test(input?.message ?? "")) barrierDone?.()
        return prevToast(input)
      }
      const prevConfirm = ui.confirm
      ui.confirm = async (input) => {
        stale.confirmCalls++
        if (/delete/i.test(input?.title ?? "") && /scout/i.test(JSON.stringify(input))) {
          stale.deleteConfirms++
          assert.fail(`unexpected DELETE confirm for the stale target — dialog: ${JSON.stringify(input).slice(0, 400)}`)
        }
        return prevConfirm(input)
      }
      ui.clear = () => {
        stale.clearCalls++
        throw new Error("host clear failed")
      }
      armed = true
      events["server.connected"]()
      await barrier // the document swap is COMPLETE
      await del.onTrigger("worker:scout") // the stale trigger, fully awaited
      return undefined // Esc — stay on the (re-rendered) list
    },
    undefined,
    true,
  ])
  await createForgeConfigEditor(makeDeps(ui, rpc, { events })).open("C:/proj")
  assert.equal(opens, 2, `the trigger really ran against the swapped document (editor open + the reconnected fresh open) — editOpen calls: ${opens}`)
  assert.equal(stale.clearCalls, 1, `the ctrl+d really reached the THROWING clear seam exactly once — clear calls: ${stale.clearCalls}`)
  assert.equal(stale.deleteConfirms, 0, `no delete confirm was ever raised for the stale target — delete confirms: ${stale.deleteConfirms}`)
  assert.equal(rpc.commitCalls().length, 0, "no delete write ever ran")
  assert.equal(rpc.calls.filter((c) => c[0] === "prepare").length, 0, "no delete prepare ever ran")
  assert.ok(
    !toasts.some((t) => /deleted/i.test(`${t.title ?? ""} ${t.message ?? ""}`) && /scout/i.test(JSON.stringify(t))),
    `no "deleted scout" disclosure may appear — toasts: ${JSON.stringify(toasts.slice(-4)).slice(0, 500)}`,
  )
})

test("P2-b a real embedded sync followed by a refresh failure discloses EXACTLY ONE combined receipt (saved + sync executed + refresh failed) and offers NO retry entry", async () => {
  const rpc = fakeRpc({
    // The receipt EMBEDS a real successful sync (the exact attachSyncOutcome
    // annotation shape: outcome/applied/path/created/updated/gced/conflicts/
    // appliedStatus/at — no invented ok/action). The entry is written → the
    // draft is consumed.
    sync: {
      action: "sync",
      outcome: "applied",
      applied: true,
      path: PATH,
      created: [],
      updated: [{ nativeId: "forge-proj-scout", fileName: "forge-proj-scout.md" }],
      gced: ["C:/proj/.opencode/agent/forge-proj-old.md"],
      conflicts: [],
      appliedStatus: { status: "confirmed", observedBy: "native-walk-1", confirmedIds: ["forge-proj-scout"], removedConfirmedIds: [], unconfirmedIds: [] },
      at: 9_000_002,
    },
    entries: [{ opId: "worker:update:scout", id: "scout", kind: "worker", action: "update", entryKind: "patch", outcome: "written", summary: ["scout done"], findings: [] }],
  })
  const origEditOpen = rpc.editOpen
  let opens = 0
  rpc.editOpen = async (req) => {
    opens++
    if (opens >= 2) throw new Error("editOpen failed (connection lost)") // the post-receipt internal refresh (opens: 1 initial + 2 refresh)
    return origEditOpen(req)
  }
  const { ui, toasts } = scriptedUi([
    ...editScript("p2b text"),
    "__save__",
    true, // save confirm → the receipt embeds the executed sync; then the post-receipt refresh editOpen THROWS
    ({ args }) => {
      const values = (args.options ?? []).map((o) => o.value)
      assert.ok(
        !values.includes("__retry-sync__"),
        `an executed sync must NOT arm the retry entry — options: ${JSON.stringify(values)}`,
      )
      assert.ok(
        !values.includes("__save__"),
        `the written entry consumed the draft (nothing pending) — options: ${JSON.stringify(values)}`,
      )
      return undefined // quit the document-less list
    },
  ])
  await createForgeConfigEditor(makeDeps(ui, rpc)).open("C:/proj")
  const failures = toasts.filter((t) => /unavailable|failed|refresh/i.test(`${t.title ?? ""} ${t.message ?? ""}`))
  assert.equal(
    failures.length,
    1,
    `exactly ONE combined refresh-failure disclosure — got ${failures.length}: ${JSON.stringify(failures).slice(0, 700)}`,
  )
  const combined = `${failures[0].title ?? ""} ${failures[0].message ?? ""}`
  assert.ok(/saved/i.test(combined), `the combined disclosure carries the saved verdict — ${combined}`)
  assert.ok(/sync: executed/i.test(combined), `the combined disclosure carries the EXECUTED sync outcome — ${combined}`)
  assert.ok(!/retry sync|Retry sync/i.test(combined), `an executed sync is never pointed at the retry entry — ${combined}`)
})

test("P2-c refused drafts explicitly DROPPED during a held sync-prepare await keep the HISTORICAL refusal count (2 REFUSED reachable) and the terminal state never says 'still pending'", { timeout: 6000 }, async () => {
  const twoWorkers = { pool: "proj", agents: { scout: { model: "prov/old", thoughtLevel: "low" }, scribe: { model: "prov/old", thoughtLevel: "low" } } }
  const rpc = fakeRpc({
    raw: JSON.stringify(twoWorkers),
    doc: twoWorkers,
    entries: [
      { opId: "worker:update:scout", id: "scout", kind: "worker", action: "update", entryKind: "patch", outcome: "rejected", summary: [], findings: [], reason: "external lock" },
      { opId: "worker:update:scribe", id: "scribe", kind: "worker", action: "update", entryKind: "patch", outcome: "rejected", summary: [], findings: [], reason: "external lock" },
    ],
    syncNoop: true,
  })
  const events = {}
  const origEcho = rpc.echo
  let armed = false
  rpc.echo = async (req) => {
    const r = await origEcho(req)
    return armed ? { ...r, epoch: "ep-2" } : r
  }
  const origEditOpen = rpc.editOpen
  let opens = 0
  rpc.editOpen = async (req) => {
    opens++
    const r = await origEditOpen(req)
    if (opens >= 3) {
      const ext = { pool: "proj", agents: {} } // the RECONNECTED document: BOTH refused entries are gone
      return { ...r, epoch: "ep-2", raw: JSON.stringify(ext), document: ext }
    }
    return r // refresh #2 still sees both workers — no gone asks there
  }
  // The FIRST sync prepare (the auto first sync — refusedIds already = 2)
  // is HELD, and the reconnection fires FROM INSIDE the wrapper: the rebase
  // (and the explicit drops) land strictly during the prepare await.
  const origSync = rpc.sync
  let holdSync = null
  rpc.sync = async (req) => {
    if (req.action === "prepare" && holdSync === null) {
      const r = await origSync(req)
      return new Promise((resolve) => {
        holdSync = () => resolve(r)
        armed = true
        events["server.connected"]()
      })
    }
    return origSync(req)
  }
  const { ui, toasts } = scriptedUi([
    "worker:scout",
    "prompt",
    "replace",
    "refused text",
    "back",
    "worker:scribe",
    "prompt",
    "replace",
    "refused scribe text",
    "back",
    "__save__",
    true, // save confirm: both entries REFUSED → kept pending; the auto first sync's prepare is HELD and the reconnection fires
    ({ args }) => {
      // The reconnected rebase asks for the refused drafts — EXPLICIT Drop.
      if (/gone from the fresh document/i.test(args.title ?? "")) return false // Drop (scout)
      if (/Discard pending/i.test(args.title ?? "")) return false // stay
      return undefined // the re-rendered list
    },
    ({ args }) => {
      if (/gone from the fresh document/i.test(args.title ?? "")) return false // Drop (scribe)
      if (/Discard pending/i.test(args.title ?? "")) return false
      return undefined
    },
    ({ args }) => {
      if (/Discard pending/i.test(args.title ?? "")) return false
      if (args.options !== undefined) {
        const values = (args.options ?? []).map((o) => o.value)
        assert.ok(
          !values.includes("__save__"),
          `no pending drafts remain after the explicit drops (no Save entry) — options: ${JSON.stringify(values)}`,
        )
        return "__receipt-detail__"
      }
      return true
    },
    ({ args }) => {
      const page = JSON.stringify(args)
      assert.ok(
        (page.match(/REFUSED/g) ?? []).length >= 2,
        `the HISTORICAL refusal count (2) stays reachable in the receipt detail — page: ${page.slice(0, 700)}`,
      )
      return undefined // close the browse
    },
    undefined, // quit — nothing pending after the explicit drops
  ])
  // The connected chain's tail toast fires only AFTER freshOpenAndRebase
  // fully completed (both explicit drops answered) — it RESOLVES the held
  // sync prepare (never a bare optional-chaining release mid-ask).
  const prevToast = ui.toast
  ui.toast = (input) => {
    if (/Server connection event/i.test(input?.message ?? "")) holdSync?.()
    return prevToast(input)
  }
  // Count the EXPLICIT drops: each rebase gone ask answered with Drop.
  const counters = { goneConfirms: 0 }
  const prevConfirm = ui.confirm
  ui.confirm = async (input) => {
    if (/gone from the fresh document/i.test(input?.title ?? "")) counters.goneConfirms++
    return prevConfirm(input)
  }
  await createForgeConfigEditor(makeDeps(ui, rpc, { events })).open("C:/proj")
  assert.equal(
    counters.goneConfirms,
    2,
    `BOTH refused drafts faced an explicit Drop confirm — gone-ask confirms: ${counters.goneConfirms}`,
  )
  assert.equal(
    opens,
    3,
    `the rebase ran against the RECONNECTED document (editor open + save refresh + connected fresh open) — editOpen calls: ${opens}`,
  )
  assert.ok(
    toasts.some((t) => /RISK|REFUSED|external lock/i.test(`${t.title ?? ""} ${t.message ?? ""}`)),
    `the original refusal was disclosed at save time — toasts: ${JSON.stringify(toasts.slice(0, 6)).slice(0, 600)}`,
  )
  // The TERMINAL sync receipt (the noop leg after the held prepare resolved)
  // carries the RECONCILED historical refusal: "REFUSED 2 — all since
  // dropped" (refusedAccountLine's stillPending===0 branch) and never the
  // stale "all still pending" claim. Only the terminal toast is checked —
  // the save-time "RISK: … all still pending" disclosure was CORRECT then.
  const terminal = toasts.filter((t) => /REFUSED/.test(`${t.title ?? ""} ${t.message ?? ""}`))
  assert.ok(
    terminal.some((t) => /this save REFUSED 2 entr\(ies\) — all since dropped/i.test(`${t.title ?? ""} ${t.message ?? ""}`)),
    `the terminal state reconciles the refusal to 'all since dropped' — REFUSED toasts: ${JSON.stringify(terminal).slice(0, 900)}`,
  )
  assert.ok(
    terminal.every((t) => !/all still pending/i.test(`${t.title ?? ""} ${t.message ?? ""}`)),
    `no TERMINAL toast may keep the stale 'all still pending' claim — REFUSED toasts: ${JSON.stringify(terminal).slice(0, 900)}`,
  )
})
