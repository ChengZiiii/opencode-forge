import test from "node:test"
import assert from "node:assert/strict"

// forge-tui-subagent-config — adapter contract tests for the ROOT WIRING
// (tui.ts) against the FROZEN plan: test seams default / readSessionScope /
// buildUi / buildClient / buildRpcTransport. The write architecture is
// server-mediated RPC — no same-host gate, no nonce plumbing, no
// connectedBaseUrl/hostAnchors seams (removed; their old tests are gone,
// not faked). client carries ONLY plugin.list + session.get +
// command.list; everything else refuses closed.

import adapter, { readSessionScope, buildUi, buildClient, buildRpcTransport } from "../tui.ts"

const tick = () => new Promise((r) => setTimeout(r, 20))

function fakeCtx(overrides = {}) {
  const toasts = []
  const layers = [] // layer factories passed to keymap.layer
  const handles = [] // what keymap.layer returned (unload handles)
  const firedHandles = [] // handles actually invoked (unloads)
  const subscriptions = [] // [event, handler] from data.on
  const ctx = {
    location: { directory: "C:/proj" },
    ui: {
      dialog: {
        select: async () => undefined,
        confirm: async () => false,
        prompt: async () => undefined,
      },
      toast: { show: (input) => toasts.push(input) },
      router: { current: () => undefined },
    },
    client: {},
    // Official storage.memory contract (SDK 2.4.2): [store, mutationSetter]
    // — the setter's callback mutates the store draft IN PLACE and the host
    // propagates the change to every factory that read the members.
    storage: {
      memory: (key, opts) => {
        const store = { ...(opts?.initial ?? {}) }
        const setter = (mutate) => {
          mutate(store)
        }
        return [store, setter]
      },
    },
    data: {
      location: {
        provider: { sync: async () => {}, list: () => [] },
        model: { sync: async () => {}, list: () => [] },
        default: () => ({ directory: "C:/proj" }),
      },
      on: (event, handler) => {
        subscriptions.push([event, handler])
        return () => {
          const i = subscriptions.findIndex(([e, h]) => e === event && h === handler)
          if (i >= 0) subscriptions.splice(i, 1)
        }
      },
    },
    keymap: {
      layer: (fn) => {
        layers.push(fn)
        const handle = () => {
          firedHandles.push(fn)
          const i = layers.indexOf(fn)
          if (i >= 0) layers.splice(i, 1)
        }
        handles.push(handle)
        return handle
      },
    },
  }
  Object.assign(ctx, overrides)
  return { ctx, toasts, layers, subscriptions, handles, firedHandles }
}

function paletteCmd(layers) {
  return registeredCommands(layers).find((c) => c.palette === true)
}

function slashMembers(layers) {
  return registeredCommands(layers).filter((c) => c.slash !== undefined)
}

function registeredCommands(layers) {
  const out = []
  for (const fn of layers) {
    const layer = fn()
    for (const cmd of layer?.commands ?? []) out.push(cmd)
  }
  return out
}

async function setupAndSettle(ctx) {
  await adapter.setup?.(ctx)
  for (let i = 0; i < 25; i++) await tick()
  await tick()
}

// ---------------------------------------------------------------------------
// Keymap registration discipline
// ---------------------------------------------------------------------------

test("no keymap.layer surface: setup discloses NOT registered — never a registered claim", async () => {
  const { ctx, toasts } = fakeCtx()
  delete ctx.keymap
  await setupAndSettle(ctx)
  const warn = toasts.find((t) => /was not registered/.test(t.message))
  assert.ok(warn, "the unavailability was disclosed")
  assert.equal(warn.variant, "warning")
})

test("keymap.layer returning undefined (a legitimate host answer) is NOT a registration failure", async () => {
  const { ctx, toasts, layers } = fakeCtx()
  ctx.keymap.layer = (fn) => {
    layers.push(fn)
    return undefined
  }
  await setupAndSettle(ctx)
  assert.equal(layers.length, 1, "the layer factory was invoked once")
  const cmd = paletteCmd(layers)
  assert.ok(cmd, "the palette command was registered")
  assert.equal(cmd.palette, true)
  assert.ok(!toasts.some((t) => /was not registered/.test(t.message)))
})

// ---------------------------------------------------------------------------
// Slash alias no-clobber + command.updated conflict observation
// ---------------------------------------------------------------------------

test("registry provably free of forge-config -> the slash alias registers", async () => {
  const { ctx, layers } = fakeCtx()
  ctx.client.command = { list: async () => ({ data: [] }) }
  await setupAndSettle(ctx)
  assert.deepEqual(slashMembers(layers)[0]?.slash, { name: "forge-config" }, "the slash carrier carries the alias when the registry is provably free")
  assert.equal(paletteCmd(layers)?.palette, true, "the palette entry stays registered")
})

test("the user's own /forge-config in the INITIAL registry -> slash withheld, palette kept", async () => {
  const { ctx, toasts, layers } = fakeCtx()
  ctx.client.command = { list: async () => ({ data: [{ name: "forge-config", description: "mine" }] }) }
  await setupAndSettle(ctx)
  assert.equal(slashMembers(layers).length, 0, "the user's command is never overwritten — no slash member anywhere")
  assert.equal(paletteCmd(layers)?.palette, true)
  assert.ok(toasts.some((t) => /did not overwrite|withheld/i.test(t.message)))
})

test("command registry unreadable (absent surface) -> slash withheld (fail closed), palette kept", async () => {
  const { ctx, layers } = fakeCtx()
  await setupAndSettle(ctx)
  assert.equal(slashMembers(layers).length, 0)
})

test("a user /forge-config arriving LATER via command.updated withdraws our slash alias through the gate — one layer factory, no dispose theater", async () => {
  const { ctx, toasts, layers, subscriptions } = fakeCtx()
  let userOwnsName = false
  ctx.client.command = { list: async () => ({ data: userOwnsName ? [{ name: "forge-config", description: "user's own" }] : [] }) }
  await setupAndSettle(ctx)
  assert.deepEqual(slashMembers(layers)[0]?.slash, { name: "forge-config" })
  assert.equal(layers.length, 1, "exactly ONE keymap.layer registration exists for the plugin's lifetime (void layer — no disposer by official contract)")
  assert.ok(subscriptions.some(([e]) => e === "command.updated"), "the adapter subscribes to command.updated for conflict observation")
  // The user defines /forge-config afterwards; the event fires, the
  // adapter re-observes the registry, closes the gate — and the SAME layer
  // factory, on its NEXT evaluation, no longer carries the slash alias.
  const [, handler] = subscriptions.find(([e]) => e === "command.updated")
  userOwnsName = true
  await handler({ commands: [{ name: "forge-config", description: "user's own" }] })
  await tick()
  await tick()
  const cmds = registeredCommands(layers)
  assert.equal(layers.length, 1, "no dispose/re-register/layer stacking happened — withdrawal is a gate flip, not a new layer")
  assert.equal(cmds.filter((c) => c.slash !== undefined).length, 0, "after the conflict the re-evaluated layer no longer carries the forge-config slash alias")
  assert.equal(cmds.filter((c) => c.palette === true).length, 1, "exactly one palette entry stays active")
  assert.ok(toasts.some((t) => /palette entry stays|NEXT invocation|forge-config|withheld|withdraw/i.test(t.message)), "the withdrawal is disclosed")
})

test("a no-arg slash invocation (run input undefined) re-checks the collision BEFORE any editor open — not treated as palette", async () => {
  const { ctx, toasts, layers } = fakeCtx()
  // The user OWNS /forge-config in the registry at invocation time.
  ctx.client.command = { list: async () => ({ data: [{ name: "forge-config", description: "user's own" }] }) }
  await setupAndSettle(ctx)
  const cmd = registeredCommands(layers)[0]
  assert.ok(cmd, "the command is registered")
  // The host may deliver a slash invocation WITHOUT args as undefined; the
  // flow must run the invocation-time collision leg and never open.
  await cmd.run(undefined)
  assert.ok(
    toasts.some((t) => /your own \/forge-config|was detected|withheld|withdraw/i.test(t.message ?? "")),
    `the collision (or fail-closed re-check) is disclosed for an undefined slash invocation — toasts: ${JSON.stringify(toasts).slice(0, 400)}`,
  )
  assert.ok(
    !toasts.some((t) => /RPC transport is unavailable/i.test(t.message ?? "")),
    "an undefined slash invocation must NOT fall through to the palette path (no transport toast)",
  )
})

test("A (user owns /forge-config) -> free location B: the re-check runs at the CURRENT location and arms the alias there", async () => {
  const { ctx, layers, subscriptions } = fakeCtx()
  let atB = false
  ctx.client.command = { list: async () => ({ data: atB ? [] : [{ name: "forge-config", description: "user's own" }] }) }
  await setupAndSettle(ctx)
  assert.equal(slashMembers(layers).length, 0, "at A the user owns the name — slash withheld")
  assert.ok(subscriptions.some(([e]) => e === "command.updated"), "the re-observation trigger is subscribed")
  // The host moves the session to free location B, then ANY registry
  // freshness signal fires — the re-check must observe the CURRENT (B)
  // location's registry and arm the alias there.
  atB = true
  const [, handler] = subscriptions.find(([e]) => e === "command.updated")
  await handler({ commands: [] })
  await tick()
  await tick()
  assert.deepEqual(slashMembers(layers)[0]?.slash, { name: "forge-config" }, `after moving to free B the alias is armed there — slash: ${JSON.stringify(registeredCommands(layers))}`)
})

// ---------------------------------------------------------------------------
// runEditor crash disclosure
// ---------------------------------------------------------------------------

async function runCommand(ctx, layers) {
  const cmd = registeredCommands(layers).find((c) => c.id === "forge.config")
  assert.ok(cmd, "the editor command is registered")
  await cmd.run()
  await tick()
  await tick()
}

test("editor.open throwing must NOT claim 'nothing was written' (the server may have committed)", async () => {
  const { ctx, toasts, layers } = fakeCtx()
  ctx.ui.router.current = () => ({ type: "home" })
  ctx.client.command = { list: async () => ({ data: [] }) } // provably free — the editor may open
  ctx.ui.dialog.select = async () => { throw new Error("boom") }
  await setupAndSettle(ctx)
  await runCommand(ctx, layers)
  const err = toasts.find((t) => t.variant === "error")
  assert.ok(err, "the crash was disclosed as an error")
  assert.ok(!/nothing was written/.test(err.message), `must not claim zero writes — message: ${err.message}`)
})

// ---------------------------------------------------------------------------
// readSessionScope (retained seam — strict router + direct session row)
// ---------------------------------------------------------------------------

function scopeCtx({ router, sessionGet, location = "C:/proj" } = {}) {
  const { ctx } = fakeCtx()
  ctx.location = { directory: location }
  ctx.data.location.default = () => ({ directory: location })
  if (router !== undefined) ctx.ui.router.current = () => router
  if (sessionGet !== undefined) ctx.client.session = { get: sessionGet }
  return ctx
}

test("readSessionScope: a session view resolves through the session ROW (SDK unwraps {data}); row.id must match", async () => {
  const ctx = scopeCtx({
    router: { type: "session", sessionID: "s1" },
    sessionGet: async ({ sessionID }) => ({ id: sessionID, location: { directory: "C:/sess" } }),
  })
  const scope = await readSessionScope(ctx)
  assert.deepEqual(scope, { sessionID: "s1", anchor: "C:/sess", kind: "session" })
})

test("readSessionScope: a raw-HTTP {data} envelope row is NOT trusted (row.id mismatch → unknown)", async () => {
  const ctx = scopeCtx({
    router: { type: "session", sessionID: "s1" },
    sessionGet: async () => ({ data: { id: "s1", location: { directory: "C:/sess" } } }),
  })
  const scope = await readSessionScope(ctx)
  assert.equal(scope.kind, "unknown")
  assert.equal(scope.anchor, null)
})

test("readSessionScope: an unknown router view never authorizes the home anchor", async () => {
  const ctx = scopeCtx({ router: undefined })
  const scope = await readSessionScope(ctx)
  assert.equal(scope.kind, "unknown")
  assert.equal(scope.anchor, null)
  assert.match(scope.reason, /router|view/i)
})

test("readSessionScope: a session view WITHOUT a sessionID refuses — never a home fallback", async () => {
  const ctx = scopeCtx({ router: { type: "session" } })
  const scope = await readSessionScope(ctx)
  assert.equal(scope.kind, "unknown")
  assert.match(scope.reason, /without a sessionID/)
})

test("readSessionScope: home view + observed location resolves as home", async () => {
  const ctx = scopeCtx({ router: { type: "home" } })
  const scope = await readSessionScope(ctx)
  assert.deepEqual(scope, { sessionID: null, anchor: "C:/proj", kind: "home" })
})

test("readSessionScope: session.get absent or throwing refuses closed with the reason disclosed", async () => {
  const missing = await readSessionScope(scopeCtx({ router: { type: "session", sessionID: "s1" } }))
  assert.equal(missing.kind, "unknown")
  assert.match(missing.reason, /session\.get is unavailable/)
  const failing = await readSessionScope(scopeCtx({ router: { type: "session", sessionID: "s1" }, sessionGet: async () => { throw new Error("boom") } }))
  assert.equal(failing.kind, "unknown")
  assert.match(failing.reason, /failed: boom/)
})

// ---------------------------------------------------------------------------
// buildUi / buildClient
// ---------------------------------------------------------------------------

test("buildUi proxies the host dialog/toast surfaces verbatim", async () => {
  const { ctx } = fakeCtx()
  const ui = buildUi(ctx)
  ctx.ui.dialog.select = async (input) => `picked:${input.title}`
  const picked = await ui.select({ title: "t", options: [] })
  assert.equal(picked, "picked:t")
  let toasted = null
  ctx.ui.toast.show = (input) => { toasted = input }
  ui.toast({ message: "m", variant: "info" })
  assert.equal(toasted?.message, "m")
})

test("buildClient exposes ONLY plugin.list / session.get / command.list and fails closed on absent surfaces", async () => {
  const { ctx } = fakeCtx()
  ctx.client.plugin = { list: async () => ({ data: [{ id: "forge" }] }) }
  const c = buildClient(ctx)
  const rows = await c.plugin.list({ location: { directory: "C:/proj" } })
  assert.deepEqual(rows.data, [{ id: "forge" }], "the wrapper proxies the real connection's rows")
  const bare = buildClient(fakeCtx().ctx) // no client surfaces at all
  let closed
  try {
    const res = await bare?.plugin?.list?.({ location: {} })
    closed = res === undefined || res === null
  } catch {
    closed = true
  }
  assert.ok(closed, "an absent client.surface refuses — it never answers with data")
})

// ---------------------------------------------------------------------------
// buildRpcTransport — the probe-proven RPC facts as regression anchors
// ---------------------------------------------------------------------------

function rpcCtx(rpcFactory) {
  const { ctx } = fakeCtx()
  if (rpcFactory !== null) ctx.client.rpc = rpcFactory
  return ctx
}

// The ACTUAL seam (tui.ts buildRpcTransport): ctx.client.rpc(SHARED
// definition) → per-method callables for ALL of echo/editOpen/prepare/
// commit/receipt/sync; ANY missing method (or an absent/throwing
// client.rpc) → null. There is deliberately NO client-side verify/probe
// member — echo provability + epoch adjudication live in the flow
// (guard.echoVerdictOf); the transport is a faithful typed pass-through.

function fullRegistry(seed = {}) {
  const ok = { ok: true }
  return {
    echo: async (input) => ({ nonce: input?.nonce, pluginID: "forge", appVersion: "2.4.2", epoch: "ep-1", generation: 7 }),
    editOpen: async () => ok,
    prepare: async () => ok,
    commit: async () => ok,
    receipt: async () => ({ found: false, epoch: "ep-1", generation: 7 }),
    sync: async () => ok,
    ...seed,
  }
}

test("buildRpcTransport: binds ALL six shared-definition methods and passes the input through verbatim", async () => {
  const seen = []
  const ctx = rpcCtx((definition) => {
    assert.ok(definition && typeof definition === "object", "the SHARED definition object is handed to client.rpc")
    return fullRegistry({
      echo: async (input) => {
        seen.push(input)
        return { nonce: input?.nonce, pluginID: "forge", appVersion: "2.4.2", epoch: "ep-1", generation: 7 }
      },
    })
  })
  const t = buildRpcTransport(ctx, "C:/proj")
  assert.ok(t !== null, "a full method registry builds the transport")
  const out = await t.echo({ nonce: "n-123" })
  assert.deepEqual(seen, [{ nonce: "n-123" }], "the input reaches the RPC surface verbatim")
  assert.equal(out.nonce, "n-123", "the nonce round-trips to the caller (adjudication is the flow's job)")
})

test("buildRpcTransport: one missing method is an unprovable transport (null) — never a half-usable surface", async () => {
  const reg = fullRegistry()
  delete reg.sync // the sync surface is mandatory, not optional
  const ctx = rpcCtx(() => reg)
  assert.equal(buildRpcTransport(ctx, "C:/proj"), null, "a registry without sync refuses the whole transport")
})

test("buildRpcTransport: absent client.rpc (or a throwing factory) refuses with null", () => {
  assert.equal(buildRpcTransport(rpcCtx(null), "C:/proj"), null, "no client.rpc at all → null")
  assert.equal(
    buildRpcTransport(rpcCtx(() => { throw new Error("transport gone") }), "C:/proj"),
    null,
    "a throwing client.rpc → null",
  )
  assert.equal(buildRpcTransport(rpcCtx(() => 42), "C:/proj"), null, "a non-object registry → null")
})

test("buildRpcTransport: the location argument is REQUIRED — missing or empty refuses (no default-location fallback)", () => {
  assert.equal(buildRpcTransport(rpcCtx(() => fullRegistry())), null, "a missing location argument → null")
  assert.equal(buildRpcTransport(rpcCtx(() => fullRegistry()), ""), null, "an empty location string → null")
})

test("buildRpcTransport: ALL six methods send (input, {location:{directory}}) verbatim — the fixed location on every call, the input never mutated", async () => {
  const calls = []
  const reg = {}
  for (const method of ["echo", "editOpen", "prepare", "commit", "receipt", "sync"]) {
    reg[method] = async (input, opts) => {
      calls.push({ method, input: JSON.parse(JSON.stringify(input ?? null)), opts })
      return method === "echo"
        ? { nonce: input?.nonce, pluginID: "forge", appVersion: "2.4.2", epoch: "ep-1", generation: 7 }
        : method === "receipt"
          ? { found: false, epoch: "ep-1", generation: 7 }
          : { ok: true }
    }
  }
  const t = buildRpcTransport(rpcCtx(() => reg), "C:/proj")
  assert.ok(t !== null, "the transport builds with a location")
  const inputs = {
    echo: { nonce: "n-1" },
    editOpen: { scope: "workspace", sessionID: "s-1" },
    prepare: { snapshotId: "snap-1", ops: [] },
    commit: { token: "tok-1", confirm: true },
    receipt: { token: "tok-1" },
    sync: { action: "prepare", scope: "workspace" },
  }
  const frozenSnapshot = JSON.stringify(inputs)
  await t.echo(inputs.echo)
  await t.editOpen(inputs.editOpen)
  await t.prepare(inputs.prepare)
  await t.commit(inputs.commit)
  await t.receipt(inputs.receipt)
  await t.sync(inputs.sync)
  assert.equal(calls.length, 6, `all six methods went through the transport — ${calls.length}`)
  for (const c of calls) {
    assert.deepEqual(
      c.opts,
      { location: { directory: "C:/proj" } },
      `${c.method}: the official opts bag carries ONLY the fixed bound location — ${JSON.stringify(c.opts)}`,
    )
    assert.deepEqual(c.input, inputs[c.method], `${c.method}: the input passes through verbatim`)
  }
  assert.equal(JSON.stringify(inputs), frozenSnapshot, "the input objects are never mutated by the transport")
})

test("buildRpcTransport: a method surface that dies after dispose surfaces the failure as a rejection — the flow treats it as unprovable", async () => {
  let disposed = false
  const ctx = rpcCtx(() => fullRegistry({
    echo: async (input) => {
      if (disposed) throw new Error("RPC is unavailable: echo")
      return { nonce: input?.nonce, pluginID: "forge", appVersion: "2.4.2", epoch: "ep-1", generation: 7 }
    },
  }))
  const t = buildRpcTransport(ctx, "C:/proj")
  assert.ok(t !== null)
  ctx.client.rpc().dispose?.()
  disposed = true
  await assert.rejects(() => t.echo({ nonce: "n" }), /unavailable|echo/, "the dead surface rejects — never a silent fake answer")
})

// ---------------------------------------------------------------------------
// Dialog sizing (UX round point 1, 2026-11-28): the ONLY 2.4.2 size control
// is dialog.set({size, centered?}) — official contract (SDK context.d.ts:
// 278-342, main-controller Read): no setSize, no size getter. Probe
// 2026-11-28: dialog own keys alert/clear/confirm/prompt/select/set/show; a
// no-active set({size:"xlarge",centered:true}) returned undefined without
// throwing. The on-ACTIVE-dialog visual effect is UNVERIFIED (CUA physical
// input refused) — these are MOCK-contract tests of the adapter discipline,
// never host visual proof.
// ---------------------------------------------------------------------------

const XLARGE = JSON.stringify({ size: "xlarge", centered: true })

function sizedDialogCtx({ setBehavior } = {}) {
  const { ctx, toasts } = fakeCtx()
  const events = [] // ordered interaction record: <member>:open / set:{...}
  const setCalls = [] // { thisArg, payload } — every dialog.set invocation
  const dialog = {
    select: async (input) => {
      events.push("select:open")
      return input.options[0]?.value
    },
    confirm: async () => {
      events.push("confirm:open")
      return true
    },
    prompt: async () => {
      events.push("prompt:open")
      return "typed"
    },
  }
  if (setBehavior !== "missing") {
    dialog.set = function (payload) {
      events.push(`set:${JSON.stringify(payload)}`)
      setCalls.push({ thisArg: this, payload })
      if (setBehavior === "throw") throw new Error("set exploded")
    }
  }
  ctx.ui.dialog = dialog
  return { ctx, toasts, events, setCalls, dialog }
}

test("dialog sizing: select opens, then ONE synchronous set({size:'xlarge',centered:true}) — before await, this-bound, nothing after resolve", async () => {
  const { ctx, events, setCalls, dialog } = sizedDialogCtx()
  const ui = buildUi(ctx)
  const p = ui.select({ title: "t", current: "worker:coder", options: [{ title: "Coder", value: "worker:coder", footer: "glm/glm-5.3 @ high" }] })
  // Synchronous discipline: before ANY await, open AND the size write have
  // both already happened (the just-opened dialog is the active one at that
  // instant — an awaited or finally-placed set could resize another dialog).
  assert.deepEqual(events.slice(0, 2), ["select:open", `set:${XLARGE}`], `open then set with no await between — got ${JSON.stringify(events)}`)
  const picked = await p
  assert.equal(picked, "worker:coder", "the original promise value is returned untouched")
  assert.deepEqual(events, ["select:open", `set:${XLARGE}`], "exactly ONE size write — nothing after the resolution (no post-close sizing)")
  assert.equal(setCalls.length, 1)
  assert.equal(setCalls[0].thisArg, dialog, "set is invoked as a method OF the dialog object (host this-binding)")
  assert.deepEqual(setCalls[0].payload, { size: "xlarge", centered: true }, "the official payload members only")
})

test("dialog sizing: confirm and prompt get the same single synchronous xlarge write — never a reset-to-medium (it would resize OTHER dialogs)", async () => {
  const { ctx, events, setCalls, dialog } = sizedDialogCtx()
  const ui = buildUi(ctx)
  const c = ui.confirm({ title: "Save & Sync?", message: "m" })
  assert.deepEqual(events.slice(0, 2), ["confirm:open", `set:${XLARGE}`])
  await c
  const t = ui.prompt({ title: "Role prompt", placeholder: "p" })
  assert.deepEqual(events.slice(2, 4), ["prompt:open", `set:${XLARGE}`])
  await t
  assert.equal(setCalls.length, 2, "one write per opened dialog")
  for (const call of setCalls) {
    assert.deepEqual(call.payload, { size: "xlarge", centered: true })
    assert.equal(call.thisArg, dialog, "set this-bound to the dialog on every member")
  }
  assert.ok(!events.some((e) => /"size":"medium"/.test(e)), "NEVER a reset-to-medium write anywhere")
})

test("dialog sizing: a THROWING set never masks the dialog — resolve value still arrives, the original rejection passes through, ONE hint", async () => {
  const { ctx, toasts } = sizedDialogCtx({ setBehavior: "throw" })
  const ui = buildUi(ctx)
  const picked = await ui.select({ title: "t", options: [{ title: "a", value: "a" }] })
  assert.equal(picked, "a", "the opened promise survives the sizing failure (a set failure never loses it)")
  ctx.ui.dialog.confirm = async () => { throw new Error("dialog boom") }
  await assert.rejects(() => ui.confirm({ title: "t", message: "m" }), /dialog boom/, "the dialog's own rejection is never swallowed or replaced by sizing")
  assert.equal(toasts.filter((t) => /dialog\.set is unavailable|default size/i.test(t.message)).length, 1, "exactly ONE degradation hint for the session")
})

test("dialog sizing: a MISSING dialog.set degrades fail-soft — fully usable default-size dialogs + exactly ONE info hint (no per-dialog spam)", async () => {
  const { ctx, toasts } = sizedDialogCtx({ setBehavior: "missing" })
  const ui = buildUi(ctx)
  assert.equal(await ui.select({ title: "1", options: [{ title: "a", value: "a" }] }), "a", "the default-size dialog stays fully usable")
  assert.equal(await ui.confirm({ title: "2", message: "m" }), true)
  assert.equal(await ui.prompt({ title: "3" }), "typed")
  const hints = toasts.filter((t) => /dialog\.set is unavailable|default size/i.test(t.message))
  assert.equal(hints.length, 1, `ONE short hint for the whole session, never one per dialog — got ${hints.length}`)
  assert.equal(hints[0]?.variant, "info", "the hint is a brief info, not an error")
})

test("select pass-through: footer and current reach the host dialog VERBATIM (options by reference); set working stays silent — no hint", async () => {
  const { ctx, toasts } = sizedDialogCtx()
  let seen = null
  ctx.ui.dialog.select = async (input) => {
    seen = input
    return input.options[0]?.value
  }
  const ui = buildUi(ctx)
  const options = [{ title: "Coder", value: "worker:coder", description: "pinned", footer: "glm/glm-5.3 @ high · shape: subagent" }]
  const picked = await ui.select({ title: "Entries", current: "worker:coder", options })
  assert.equal(picked, "worker:coder")
  assert.equal(seen?.current, "worker:coder", "the current selection passes through")
  assert.equal(seen?.options?.[0]?.footer, "glm/glm-5.3 @ high · shape: subagent", "the official footer string passes through")
  assert.equal(seen?.options, options, "the adapter passes the option array by REFERENCE — never a rebuild")
  assert.equal(toasts.length, 0, "a working set is SILENT — no hint, no noise")
})
