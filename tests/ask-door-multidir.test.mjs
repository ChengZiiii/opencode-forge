import test, { after } from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// fix-ask-door-multi-directory-host (design D2/D7) — on a host that has
// initialized the plugin in MORE THAN ONE directory (one process, one module,
// N initializations — the 2.4.0 service reality), a user-confirmation door
// must ask through the interface of the initialization that registered the
// tool it runs in — the one bound to the session's own directory — never
// through "whatever initialization ran last".
//
// Levels under test (the tools v2Setup registers + the v2ToolContext ask
// adapter): the ask is routed per initialization, it survives the
// last-initialized interface going dead, the single-directory ask keeps its
// exact shape, a host-provided ask is kept, and an initialization that
// captured no interface refuses by name.

// Must precede the plugin import (evaluated first).
import "./lib/test-env-home.mjs"
import { createV2MockContext } from "./lib/v2-mock-context.mjs"

process.env.FORGE_TEST_NO_FENCE = "1"
process.env.FORGE_GOAL_DEBOUNCE_MS = "10"
process.env.FORGE_DISPATCH_POLL_INTERVAL_MS = "5"
process.env.FORGE_DISPATCH_POLL_SLICE_MS = "10"
process.env.FORGE_DISPATCH_RECONCILE_FLOOR_MS = "0"

import { __sessionAnchorTestSurface, v2Setup } from "../plugin.ts"

const surface = __sessionAnchorTestSurface
const dirs = []
const mk = (prefix) => {
  const d = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(d)
  return d
}
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

// One plugin initialization for one directory = one directory activation on
// a multi-directory host. The module-level state is shared between them,
// exactly as on the real host (the plugin module is evaluated once).
async function init(dir, opts) {
  const { ctx, state } = createV2MockContext(opts)
  await v2Setup(ctx, { anchors: [dir] })
  return { ctx, state, dir }
}
// The REAL v2 tool-context shape (W6a): it carries NO directory and NO ask.
const realCtx = (sessionID) => ({ sessionID, agent: "forge", messageID: "msg_1", id: "call_1" })
const DOOR_ARGS = (slug) => ({ goal: `door ${slug}`, criteria: ["one criterion"], checks: [{ shell: "node -v" }], constraints: "none" })
const goalFiles = (dir) => {
  const d = join(dir, ".opencode", "goal")
  return existsSync(d) ? readdirSync(d) : []
}
const bind = (initd, sessionID) => initd.state.sessionRecords.set(sessionID, { sessionID, location: { directory: initd.dir } })
const actions = (initd) => initd.state.asserts.map((x) => x.action)
// An interface whose directory the host has evicted: every assert fails on
// entry, as the host's closed permission service does (DeclinedError defect).
const DEAD = () => {
  throw new Error("declined (instance closed)")
}
const REFUSED_CLOSED = /REFUSED \(fail-closed; state is unchanged, nothing was approved\)/

test("B1: a door opened in directory A asks through A's interface — a later initialization of B never receives it", async () => {
  const dirA = mk("forge-door-b1-a-")
  const dirB = mk("forge-door-b1-b-")
  const a = await init(dirA)
  const b = await init(dirB) // initialized LAST: before this change every ask in the process went here
  a.state.assertBehavior = "deny"
  b.state.assertBehavior = "deny"
  const sid = "ses-b1"
  bind(a, sid)

  await assert.rejects(a.state.tools.get("goal_write").execute(DOOR_ARGS("b1"), realCtx(sid)), /permission denied: goal_write/)
  await assert.rejects(a.state.tools.get("forge_shell").execute({ command: "cd" }, realCtx(sid)), /permission denied: forge_shell/)

  assert.deepEqual(actions(a), ["goal_write", "forge_shell"], "A's own interface carried both asks")
  assert.equal(b.state.asserts.length, 0, "the interface of the later initialization B saw nothing")
  assert.deepEqual(goalFiles(dirA), [], "declined → nothing armed")
  assert.deepEqual(goalFiles(dirB), [])

  // A session the host has no record for still runs on A's instance (the host
  // routed the call there), so its ask belongs to A's interface as well.
  await assert.rejects(a.state.tools.get("goal_write").execute(DOOR_ARGS("b1-norec"), realCtx("ses-b1-norec")), /permission denied: goal_write/)
  assert.equal(actions(a).at(-1), "goal_write")
  assert.equal(b.state.asserts.length, 0)
})

test("B2: the last-initialized interface going dead (its directory evicted) leaves directory A's doors and forge_shell untouched", async () => {
  const dirA = mk("forge-door-b2-a-")
  const dirB = mk("forge-door-b2-b-")
  const a = await init(dirA)
  const b = await init(dirB)
  a.state.assertBehavior = "deny"
  b.state.assertBehavior = DEAD
  const sid = "ses-b2"
  bind(a, sid)

  // The user's decline comes back as the user's decline — the host's own
  // ToolError, never the dead interface's failure, and never an approval.
  await assert.rejects(a.state.tools.get("goal_write").execute(DOOR_ARGS("b2"), realCtx(sid)), /^ToolError: \[mock\] permission denied: goal_write$/)
  await assert.rejects(a.state.tools.get("forge_shell").execute({ command: "cd" }, realCtx(sid)), /^ToolError: \[mock\] permission denied: forge_shell$/)
  assert.deepEqual(actions(a), ["goal_write", "forge_shell"])
  assert.equal(b.state.asserts.length, 0)

  // B's own tools hold B's dead interface: they fail closed, by that failure.
  const sidB = "ses-b2-b"
  bind(b, sidB)
  await assert.rejects(b.state.tools.get("goal_write").execute(DOOR_ARGS("b2-b"), realCtx(sidB)), /instance closed/)
  assert.deepEqual(actions(b), ["goal_write"])
  assert.deepEqual(goalFiles(dirA), [])
  assert.deepEqual(goalFiles(dirB), [])
})

test("B3: single directory — the ask a door sends to the host is exactly what it was", async () => {
  const only = await init(mk("forge-door-b3-only-"))
  only.state.assertBehavior = "deny"
  const sid = "ses-b3"
  bind(only, sid)

  await assert.rejects(only.state.tools.get("goal_write").execute(DOOR_ARGS("b3"), realCtx(sid)), /permission denied: goal_write/)
  assert.deepEqual(only.state.asserts, [
    {
      sessionID: sid,
      agent: "forge",
      action: "goal_write",
      resources: ["*"],
      metadata: { title: "Arm goal: door b3" },
    },
  ])
  // No agent on the context → no agent key at all (never a fabricated one).
  await assert.rejects(
    only.state.tools.get("goal_write").execute(DOOR_ARGS("b3-noagent"), { sessionID: "ses-b3-noagent", messageID: "msg_1", id: "call_1" }),
    /permission denied: goal_write/,
  )
  assert.deepEqual(only.state.asserts[1], {
    sessionID: "ses-b3-noagent",
    action: "goal_write",
    resources: ["*"],
    metadata: { title: "Arm goal: door b3-noagent" },
  })
  assert.deepEqual(goalFiles(only.dir), [])
})

test("B4: the context resolver takes the interface it is given; given none it synthesizes no ask", async () => {
  const a = await init(mk("forge-door-b4-a-"))
  const b = await init(mk("forge-door-b4-b-"))
  const sid = "ses-b4"
  const calls = []
  const mine = async (input) => {
    calls.push(input)
  }

  const withMine = await surface.resolveToolContext(realCtx(sid), { session: a.ctx.session }, mine)
  assert.equal(typeof withMine.context.ask, "function")
  await withMine.context.ask({ permission: "goal_discard", patterns: ["docs/**"], always: [], metadata: { title: "Discard goal: b4" } })
  assert.deepEqual(calls, [{ sessionID: sid, agent: "forge", action: "goal_discard", resources: ["docs/**"], metadata: { title: "Discard goal: b4" } }])

  // There is no "latest initialization" left to borrow an interface from.
  const bare = await surface.resolveToolContext(realCtx(sid), { session: a.ctx.session })
  assert.equal(bare.context.ask, undefined)

  // No session in the context → no ask either (the host would have no
  // session to register the request for).
  const noSession = await surface.resolveToolContext({ id: "call_1", messageID: "msg_1" }, undefined, mine)
  assert.equal(noSession.context.ask, undefined)
  assert.equal(calls.length, 1, "the given interface was not called")

  assert.equal(a.state.asserts.length, 0)
  assert.equal(b.state.asserts.length, 0)
})

test("B5: an initialization that captured no permission interface refuses every door by name — nothing runs, nothing is approved", async () => {
  const dir = mk("forge-door-b5-")
  const { ctx, state } = createV2MockContext({ drift: { permission: "not-function" } })
  await v2Setup(ctx, { anchors: [dir] })
  const sid = "ses-b5"
  state.sessionRecords.set(sid, { sessionID: sid, location: { directory: dir } })

  await assert.rejects(state.tools.get("goal_write").execute(DOOR_ARGS("b5"), realCtx(sid)), REFUSED_CLOSED)
  await assert.rejects(state.tools.get("forge_shell").execute({ command: "cd" }, realCtx(sid)), REFUSED_CLOSED)
  assert.deepEqual(goalFiles(dir), [])
})

test("B6: a directory initialized again (evicted, then booted afresh) registers its tools on its NEW interface; an old closure never borrows another directory's", async () => {
  const dirA = mk("forge-door-b6-a-")
  const dirB = mk("forge-door-b6-b-")
  const aOld = await init(dirA)
  const b = await init(dirB)
  const aNew = await init(dirA)
  aOld.state.assertBehavior = DEAD
  aNew.state.assertBehavior = "deny"
  b.state.assertBehavior = "deny"
  const sid = "ses-b6"
  bind(aNew, sid)

  await assert.rejects(aNew.state.tools.get("goal_write").execute(DOOR_ARGS("b6"), realCtx(sid)), /permission denied: goal_write/)
  assert.deepEqual(actions(aNew), ["goal_write"])

  // The host no longer reaches A's old closures (its old registry is gone);
  // should anything still hold one, it talks to A's OLD interface — and to
  // nothing else.
  bind(aOld, "ses-b6-old")
  await assert.rejects(aOld.state.tools.get("goal_write").execute(DOOR_ARGS("b6-old"), realCtx("ses-b6-old")), /instance closed/)
  assert.deepEqual(actions(aOld), ["goal_write"])
  assert.equal(b.state.asserts.length, 0)
  assert.deepEqual(goalFiles(dirA), [])
  assert.deepEqual(goalFiles(dirB), [])
})

test("B7: a host that provides its own ask keeps it — the plugin's adapter is synthesized only when the host gave none", async () => {
  const a = await init(mk("forge-door-b7-"))
  const hostAsks = []
  const hostAsk = async (input) => {
    hostAsks.push(input)
  }
  const sid = "ses-b7"
  const mine = async () => {
    throw new Error("the plugin adapter must not be used here")
  }

  const kept = await surface.resolveToolContext({ ...realCtx(sid), ask: hostAsk }, { session: a.ctx.session }, mine)
  assert.equal(kept.context.ask, hostAsk, "the host's ask, the very same function")
  await kept.context.ask({ permission: "goal_write", patterns: ["*"], always: [], metadata: { title: "t" } })
  assert.equal(hostAsks.length, 1)
  assert.equal(a.state.asserts.length, 0)
})
