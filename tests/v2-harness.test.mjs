import test from "node:test"
import assert from "node:assert/strict"

// Task 1.1 — the V2 mock-context harness itself (tests/lib/v2-mock-context.mjs).
// Wired legs: every domain records registrations into inspectable state.
// Drifted legs: every drift mode keeps the domain inert without throwing.
// The harness mirrors the goal-mode stub-client pattern and is the shared
// fixture for W1–W5 (agent/tool now; permission/session/command/event next).

import { createV2MockContext, V2_DOMAINS, V2_DRIFT_MODES } from "./lib/v2-mock-context.mjs"
import { v2Setup } from "../plugin.ts"

// ---------------------------------------------------------------------------
// Wired shapes

test("harness: wired agent domain records create-only draft updates", async () => {
  const { ctx, state } = createV2MockContext()
  await ctx.agent.transform(async (draft) => {
    draft.update("x", (a) => {
      a.system = "S"
    })
  })
  assert.equal(state.agents.get("x").system, "S")
  assert.equal(state.calls.agentTransform, 1)
  const listed = await new Promise((resolve) => ctx.agent.transform(async (d) => resolve(d.list())))
  assert.deepEqual(listed, [{ id: "x" }])
})

test("harness: wired tool domain records add/hook; permission/session/command/event/skill all record", async () => {
  const { ctx, state } = createV2MockContext()
  await ctx.tool.transform(async (editor) => {
    editor.add({ name: "t1", description: "d", input: { type: "object" }, execute: async () => ({}) })
  })
  ctx.tool.hook("execute.before", () => {})
  ctx.permission.hook("evaluate", () => {})
  await ctx.permission.assert({ sessionID: "s", action: "read", resources: ["*"] })
  ctx.session.hook("context", () => {})
  await ctx.command.transform(async (draft) => {
    draft.add({ name: "plan", template: ["..."] })
  })
  // W6a: subscribe(options?) returns an AsyncIterable of {id, type, data}.
  const iter = ctx.event.subscribe({ types: ["session.deleted"] })[Symbol.asyncIterator]()
  await iter.return?.()
  await ctx.skill.transform(async (draft) => {
    draft.source({ type: "directory", path: "/x" })
  })
  assert.equal(state.tools.get("t1").name, "t1")
  assert.equal(state.tools.get("t1").id, "t1", "ToolEditor entries carry an id (the effective-name key)")
  assert.deepEqual(state.toolHooks.map((h) => h.name), ["execute.before"])
  assert.deepEqual(state.permissionHooks.map((h) => h.name), ["evaluate"])
  assert.deepEqual(state.asserts, [{ sessionID: "s", action: "read", resources: ["*"] }])
  assert.deepEqual(state.sessionHooks.map((h) => h.name), ["context"])
  assert.deepEqual([...state.commands.keys()], ["plan"])
  assert.equal(state.subscriptions.length, 1)
  assert.equal(state.subscriptionsAborted, 1, "closing the iterator flips the subscription closed exactly once")
  assert.deepEqual(state.skillSources, [{ type: "directory", path: "/x" }])
})

test("harness: event subscribe is repeatable and per-subscription; emit feeds every live iterator", async () => {
  const { ctx, state } = createV2MockContext()
  const a = ctx.event.subscribe({})
  const b = ctx.event.subscribe({})
  const ai = a[Symbol.asyncIterator]()
  const bi = b[Symbol.asyncIterator]()
  await state.emit("session.deleted", { sessionID: "ses_1" })
  assert.deepEqual(await ai.next(), { done: false, value: { id: "evt_1", type: "session.deleted", data: { sessionID: "ses_1" } } })
  assert.deepEqual((await bi.next()).value.type, "session.deleted")
  await ai.return?.()
  assert.equal(state.subscriptionsAborted, 1)
  await ai.return?.() // idempotent
  assert.equal(state.subscriptionsAborted, 1)
  await bi.return?.()
  assert.equal(state.subscriptionsAborted, 2)
  // A closed subscription receives nothing.
  await state.emit("session.deleted", { sessionID: "ses_2" })
  assert.equal((await bi.next()).done, true)
})

// ---------------------------------------------------------------------------
// Drifted shapes — one mode per domain, iterated

test("harness: every drift mode leaves its domain inert and never throws v2Setup", async () => {
  for (const domain of V2_DOMAINS) {
    for (const mode of V2_DRIFT_MODES) {
      const { ctx } = createV2MockContext({ drift: { [domain]: mode } })
      if (mode === "missing") assert.equal(domain in ctx, false, `${domain} key omitted`)
      else assert.ok(ctx[domain] !== undefined, `${domain} keeps a (broken) shape`)
      await assert.doesNotReject(v2Setup(ctx), `${domain}/${mode} must not throw`)
    }
  }
})

test("harness: 'missing' omits the key entirely; others keep a broken shape", () => {
  const { ctx: missing } = createV2MockContext({ drift: { tool: "missing" } })
  assert.equal("tool" in missing, false)
  const { ctx: notFn } = createV2MockContext({ drift: { tool: "not-function" } })
  assert.notEqual(typeof notFn.tool.transform, "function")
  const { ctx: badShape } = createV2MockContext({ drift: { agent: "bad-shape" } })
  assert.notEqual(badShape.agent, undefined)
})

test("harness: drifted agent draft ('bad-shape') disables only its own slice — v2Setup still completes", async () => {
  const { ctx, state } = createV2MockContext({ drift: { agent: "bad-shape" } })
  await assert.doesNotReject(v2Setup(ctx))
  assert.equal(state.agents.size, 0, "garbage draft => no registrations, no throw")
})

// ---------------------------------------------------------------------------
// The harness against the real v2Setup — wired legs for what W1–W2 wires
// (agent + tool); the other domains are recorded by the harness but not yet
// consumed by the plugin (W3–W5).

test("harness: full drift matrix over ALL domains at once still no-ops", async () => {
  const drift = {}
  for (const d of V2_DOMAINS) drift[d] = "bad-shape"
  const { ctx } = createV2MockContext({ drift })
  await assert.doesNotReject(v2Setup(ctx))
})

test("harness: only-agent ctx (all other domains absent) registers the forge agent", async () => {
  const { ctx, state } = createV2MockContext({ drift: { tool: "missing", permission: "missing", session: "missing", command: "missing", event: "missing", skill: "missing" } })
  await v2Setup(ctx)
  assert.ok(state.agents.has("forge"))
  assert.equal(state.tools.size, 0, "no tool domain => no tool registrations")
})
