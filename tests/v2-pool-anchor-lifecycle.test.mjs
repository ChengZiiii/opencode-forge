import test from "node:test"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync, readFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { createV2MockContext } from "./lib/v2-mock-context.mjs"
import { createPoolResolver } from "../src/forge-config.ts"

const root = mkdtempSync(join(tmpdir(), "forge-pool-anchor-"))
process.env.FORGE_TEST_FORGE_HOME = join(root, "home")
process.env.FORGE_TEST_RUNTIME_DIR = join(root, "runtime")
process.env.OPENCODE_CONFIG_DIR = join(root, "config")
process.env.FORGE_TEST_NO_DISPATCH_FETCH = "1"
process.env.FORGE_TEST_NO_FENCE = "1"
const { v2Setup, v2WiringSeam, __sessionAnchorTestSurface: surface } = await import("../plugin.ts")
test.after(() => rmSync(root, { recursive: true, force: true }))

const home = process.env.FORGE_TEST_FORGE_HOME
const globalFile = join(home, ".config", "opencode", "forge.json")
const fold = (p) => p?.replaceAll("\\", "/").toLowerCase()
const ids = (r) => Object.keys(r.agents).sort()
const pathOf = (ws) => join(ws, ".opencode", "forge.json")
const recipe = (pool, shared) => JSON.stringify({ pool, shared, agents: { coder: {} } })
let stamp = 1700000000
function put(file, text) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text)
  utimesSync(file, ++stamp, stamp)
}
function workspace() { return mkdtempSync(join(root, "workspace-")) }
async function setup(t, ws, mock = createV2MockContext()) {
  const cleanup = await v2Setup(mock.ctx, { anchors: [ws], homeDir: home, materialize: "runtime" })
  t.after(() => cleanup?.())
  return mock
}
function own(resolution, anchor) {
  const file = surface.workspacePoolOf(anchor) ?? globalFile
  return resolution.families.find((f) => fold(f.file) === fold(file))?.materializedIds ?? []
}

test("v2 pool lifecycle: live resolution empties a malformed owner, then deletes, recreates and refreshes it", async (t) => {
  v2WiringSeam.resetHostAnchors()
  const a = workspace(), b = workspace(), bare = workspace()
  const file = pathOf(a)
  put(globalFile, recipe("ignored", "global role"))
  put(file, recipe("alpha", "first role"))
  put(pathOf(b), recipe("beta", "sibling role"))
  const { state } = await setup(t, a)
  await setup(t, b)
  assert.ok(state.agents.has("forge-alpha-coder"))
  assert.ok(state.agents.has("forge-global-coder"))
  // v2 also materializes the launch cwd's pool; keep assertions scoped to
  // the independent fixture families, not whatever recipe the checkout has.
  const resolve = () => {
    const r = surface.resolvePools()
    return { ...r, agents: Object.fromEntries(Object.entries(r.agents).filter(([, a]) => fold(a.file).startsWith(fold(root) + "/"))) }
  }
  let r = resolve()
  assert.deepEqual(ids(r), ["alpha-coder", "beta-coder", "global-coder"])
  assert.deepEqual(own(r, a), ["alpha-coder"])
  assert.deepEqual(own(r, b), ["beta-coder"])
  assert.deepEqual(own(r, bare), ["global-coder"])
  assert.equal(r.agents["alpha-coder"].shared, "first role")
  put(file, recipe("alpha", "other role"))
  r = resolve()
  assert.equal(r.agents["alpha-coder"].shared, "other role")
  const refreshed = await setup(t, a)
  assert.ok(refreshed.state.agents.get("forge-alpha-coder").system.includes("other role"))
  assert.doesNotMatch(refreshed.state.agents.get("forge-alpha-coder").system, /first role/)
  assert.ok(refreshed.state.agents.get("forge-beta-coder").system.includes("sibling role"))
  put(file, "{ invalid")
  r = resolve()
  assert.equal(fold(surface.workspacePoolOf(a)), fold(file), "broken file still owns its workspace")
  assert.deepEqual(own(r, a), [], "no global fallback for a malformed owner")
  assert.deepEqual(ids(r), ["beta-coder", "global-coder"])
  assert.ok(r.findings.some(f => f.code === "config-parse-error" && /line 1/.test(f.message) && fold(f.message).includes(fold(file))))
  rmSync(file)
  const afterDeletion = await setup(t, a)
  assert.equal(afterDeletion.state.agents.has("forge-alpha-coder"), false, "next registration does not recreate the deleted family")
  assert.ok(afterDeletion.state.agents.has("forge-beta-coder"), "independent sibling remains registered")
  assert.ok(afterDeletion.state.agents.has("forge-global-coder"), "global fallback remains registered")
  r = resolve()
  assert.equal(surface.workspacePoolOf(a), null)
  assert.deepEqual(own(r, a), ["global-coder"])
  assert.equal(r.families.some(f => fold(f.file) === fold(file)), false)
  put(file, recipe("alpha", "reborn role"))
  r = resolve()
  assert.deepEqual(own(r, a), ["alpha-coder"])
  assert.equal(r.agents["alpha-coder"].shared, "reborn role")
  const fresh = await setup(t, a)
  assert.ok(fresh.state.agents.get("forge-alpha-coder").system.includes("reborn role"))
  assert.deepEqual(ids(r), ["alpha-coder", "beta-coder", "global-coder"])
})

test("v2 host anchors deduplicate path variants and reset between host lifetimes", async (t) => {
  v2WiringSeam.resetHostAnchors()
  const a = workspace(), b = workspace()
  put(pathOf(a), recipe("anchor-a", "a"))
  put(pathOf(b), recipe("anchor-b", "b"))
  const families = () => surface.resolvePools().families.filter(f => [pathOf(a), pathOf(b)].some(p => fold(p) === fold(f.file)))
  await setup(t, a)
  assert.deepEqual(families().map(f => fold(f.file)), [fold(pathOf(a))])
  await setup(t, a.toUpperCase().replaceAll("\\", "/"))
  assert.deepEqual(families().map(f => fold(f.file)), [fold(pathOf(a))], "case and slash variants do not add a family")
  v2WiringSeam.resetHostAnchors()
  await setup(t, b)
  assert.deepEqual(families().map(f => fold(f.file)), [fold(pathOf(b))], "a fresh host no longer resolves the previous family")
})

test("v2 pool gate: shared-host workspace and global ownership matrix", async (t) => {
  v2WiringSeam.resetHostAnchors()
  surface.resetInitializedDirectories()
  const a = workspace(), b = workspace(), bare = workspace()
  put(globalFile, JSON.stringify({ agents: { universal: { model: "zai/glm", thoughtLevel: "low" } } }))
  t.after(() => rmSync(globalFile, { force: true }))
  put(pathOf(a), recipe("gate-a", "a"))
  put(pathOf(b), recipe("gate-b", "b"))
  const mock = await setup(t, a)
  await setup(t, b, mock)
  assert.ok(mock.state.agents.has("forge-gate-a-coder"))
  assert.ok(mock.state.agents.has("forge-gate-b-coder"))
  assert.ok(mock.state.agents.has("forge-global-universal"))
  assert.equal(mock.state.agents.has("forge-coder"), false)
  const before = mock.state.toolHooks.find(h => h.name === "execute.before").cb
  const dispatch = (sid, target) => before({ tool: "subagent", sessionID: sid, agent: "forge", input: { agent: target } })
  const sa = randomUUID(), sb = randomUUID(), sg = randomUUID()
  for (const [sid, dir] of [[sa, a], [sb, b], [sg, bare]]) mock.state.sessionRecords.set(sid, { location: { directory: dir } })
  await dispatch(sa, "forge-gate-a-coder")
  await dispatch(sb, "forge-gate-b-coder")
  await dispatch(sg, "forge-global-universal")
  for (const [sid, target, origin] of [[sa, "forge-gate-b-coder", pathOf(b)], [sb, "forge-gate-a-coder", pathOf(a)], [sa, "forge-global-universal", globalFile], [sg, "forge-gate-a-coder", pathOf(a)]]) {
    await assert.rejects(dispatch(sid, target), err => {
      assert.match(err.message, /not dispatchable from this session/)
      assert.ok(fold(err.message).includes(fold(origin)))
      assert.match(err.message, /open a session in that pool's workspace/)
      assert.match(err.message, /configure the role into this workspace's pool/)
      assert.match(err.message, /global layer/)
      return true
    })
  }
})

test("v2 crew command delivers the session-scoped roster and ownership rules", async (t) => {
  v2WiringSeam.resetHostAnchors()
  surface.resetInitializedDirectories()
  const a = workspace(), b = workspace()
  put(pathOf(a), recipe("cmd-a", "a"))
  put(pathOf(b), recipe("cmd-b", "b"))
  const mock = await setup(t, a)
  await setup(t, b, mock)
  const sid = randomUUID()
  mock.state.sessionRecords.set(sid, { agent: "forge", location: { directory: a } })
  await mock.state.commands.get("crew").execute({ sessionID: sid })
  const text = mock.state.prompts.at(-1).text
  assert.match(text, /ROSTER OWNERSHIP/)
  assert.match(text, /nearest \.opencode\/forge\.json walking up from this session's worktree/)
  assert.match(text, /global fallback/i)
  assert.match(text, /NOT dispatchable from this session/)
  assert.match(text, /pool cmd-b \(forge-cmd-b-\*\)/)
  assert.doesNotMatch(text, /primary pool/)
  assert.ok(fold(text).includes(fold(pathOf(b))))
  assert.match(text, /forge-cmd-a-coder/)
  assert.match(text, /forge-cmd-b-coder/)
  assert.match(text, /nested deeper in the workspace subtree are ignored/)
})

test("v2 pool compliance: executing crew degrades and repairs without restart", async (t) => {
  v2WiringSeam.resetHostAnchors()
  surface.resetInitializedDirectories()
  const a = workspace(), b = workspace()
  put(pathOf(a), recipe("crew-a", "a"))
  put(pathOf(b), recipe("crew-b", "b"))
  const mock = await setup(t, a)
  await setup(t, b, mock)
  const sid = randomUUID()
  mock.state.sessionRecords.set(sid, { location: { directory: a } })
  const call = (args) => mock.state.tools.get("crew_begin").execute(args, { sessionID: sid, agent: "forge", worktree: a })
  await call({ objective: "compliance matrix", subtasks: [{ title: "one" }] })
  await call({ execution: "waves" })
  assert.equal(v2WiringSeam.crews.get(sid).mode, "executing")
  const before = mock.state.toolHooks.find(h => h.name === "execute.before").cb
  const dispatch = agent => before({ tool: "subagent", sessionID: sid, agent: "forge", input: { agent } })
  await assert.rejects(dispatch("forge-crew-b-coder"), err => {
    assert.match(err.message, /not dispatchable from this session/)
    assert.ok(fold(err.message).includes(fold(pathOf(b))))
    assert.doesNotMatch(err.message, /Pool compliance refused/)
    return true
  })
  put(pathOf(a), JSON.stringify({ agents: { coder: {} } }))
  await assert.rejects(dispatch("forge-crew-b-coder"), err => {
    assert.match(err.message, /not dispatchable from this session/)
    assert.ok(fold(err.message).includes(fold(pathOf(b))))
    assert.doesNotMatch(err.message, /Pool compliance refused/)
    return true
  })
  await assert.rejects(dispatch("forge-crew-a-coder"), err => {
    assert.match(err.message, /Pool compliance refused/)
    assert.match(err.message, /missing top-level pool field/)
    assert.match(err.message, /no host restart/)
    assert.match(err.message, /Repair the pool before retrying the refused operation; respect existing approvals and permissions/)
    assert.doesNotMatch(err.message, /NATIVE task channel/)
    return true
  })
  await dispatch("general")
  put(pathOf(a), recipe("crew-a", "a"))
  await assert.rejects(dispatch("forge-crew-a-ghost"), /not dispatchable from this session/)
  await dispatch("forge-crew-a-coder")
})

test("v2 pool compliance: global fallback and per-agent fail-soft remain dispatchable", async (t) => {
  v2WiringSeam.resetHostAnchors()
  surface.resetInitializedDirectories()
  const bare = workspace(), ws = workspace()
  put(globalFile, JSON.stringify({ agents: { universal: { model: "zai/glm", thoughtLevel: "low" } } }))
  t.after(() => rmSync(globalFile, { force: true }))
  put(pathOf(ws), JSON.stringify({ pool: "softfail", agents: { research: { model: "zai/glm", thoughtLevel: "low" }, broken: { thoughtLevel: "low" } } }))
  const mock = await setup(t, bare)
  await setup(t, ws, mock)
  assert.ok(mock.state.agents.has("forge-softfail-research"))
  assert.equal(mock.state.agents.has("forge-softfail-broken"), false)
  const before = mock.state.toolHooks.find(h => h.name === "execute.before").cb
  for (const [dir, target] of [[bare, "forge-global-universal"], [ws, "forge-softfail-research"]]) {
    const sid = randomUUID()
    mock.state.sessionRecords.set(sid, { location: { directory: dir } })
    const call = args => mock.state.tools.get("crew_begin").execute(args, { sessionID: sid, agent: "forge", worktree: dir })
    assert.match((await call({ objective: "compliance", subtasks: [{ title: "one" }] })).content, /registered PENDING/)
    await call({ execution: "waves" })
    await before({ tool: "subagent", sessionID: sid, agent: "forge", input: { agent: target } })
  }
})

test("v2 pool anchors: authoritative records, map fallback and degenerate replay", async (t) => {
  v2WiringSeam.resetHostAnchors()
  surface.resetInitializedDirectories()
  const a = workspace(), b = workspace(), bare = workspace()
  put(pathOf(a), recipe("auth-a", "a"))
  put(pathOf(b), recipe("auth-b", "b"))
  const mock = await setup(t, a)
  await setup(t, b, mock)
  const before = mock.state.toolHooks.find(h => h.name === "execute.before").cb
  const dispatch = (sid, agent) => before({ tool: "subagent", sessionID: sid, agent: "forge", input: { agent } })
  const sid = randomUUID()
  await mock.state.emit("session.created", { info: { id: sid, directory: bare } })
  mock.state.sessionRecords.set(sid, { location: { directory: a } })
  await dispatch(sid, "forge-auth-a-coder")
  await assert.rejects(dispatch(sid, "forge-auth-b-coder"), /its workspace pool/)
  const fresh = randomUUID()
  mock.state.sessionRecords.set(fresh, { location: { directory: a } })
  await dispatch(fresh, "forge-auth-a-coder")
  const mapped = randomUUID()
  await mock.state.emit("session.created", { info: { id: mapped, directory: b } })
  const originalGet = mock.ctx.session.get
  mock.ctx.session.get = async () => { throw new Error("record unavailable") }
  await dispatch(mapped, "forge-auth-b-coder")
  await assert.rejects(dispatch(mapped, "forge-auth-a-coder"), /not dispatchable from this session/)
  await mock.state.emit("session.created", { info: { id: mapped, worktree: "/" } })
  await dispatch(mapped, "forge-auth-b-coder")
  assert.equal(surface.worktreeOf(mapped), b)
  mock.ctx.session.get = originalGet
})

test("v2 ledger rebind disclosures are bounded and live pooled bindings outrank stale evidence", async (t) => {
  v2WiringSeam.resetHostAnchors()
  surface.resetInitializedDirectories()
  const a = workspace(), b = workspace(), bare = workspace()
  put(pathOf(a), recipe("ledger-a", "a"))
  put(pathOf(b), recipe("ledger-b", "b"))
  const mock = await setup(t, a)
  await setup(t, b, mock)
  const before = mock.state.toolHooks.find(h => h.name === "execute.before").cb
  const dispatch = (sid, agent) => before({ tool: "subagent", sessionID: sid, agent: "forge", input: { agent } })
  const warn = t.mock.method(console, "warn", () => {})
  const sid = randomUUID()
  await mock.state.emit("session.created", { info: { id: sid, directory: b } })
  assert.match(surface.sessionAnchorLedgerText(), new RegExp(sid))
  surface.resetSessionBindings()
  mock.state.sessionRecords.set(sid, { location: { directory: bare } })
  await dispatch(sid, "forge-ledger-b-coder")
  await dispatch(sid, "forge-ledger-b-coder")
  await assert.rejects(dispatch(sid, "forge-ledger-a-coder"), /its workspace pool/)
  const rebound = warn.mock.calls.map(c => c.arguments.join(" ")).filter(s => s.includes("re-bound from the persisted session-anchor ledger"))
  assert.equal(rebound.length, 1)
  assert.match(rebound[0], /restart-resume rebind shape/)
  const live = randomUUID()
  await mock.state.emit("session.created", { info: { id: live, directory: b } })
  mock.state.sessionRecords.set(live, { location: { directory: bare } })
  await dispatch(live, "forge-ledger-b-coder")
  await dispatch(live, "forge-ledger-b-coder")
  await assert.rejects(dispatch(live, "forge-ledger-a-coder"), /its workspace pool/)
  const pref = warn.mock.calls.map(c => c.arguments.join(" ")).filter(s => s.includes(live) && s.includes("pooled binding wins"))
  assert.equal(pref.length, 1)
  assert.match(pref[0], /POOL-LESS/)
})

test("v2 live pooled binding and authoritative record outrank a stale ledger", async (t) => {
  v2WiringSeam.resetHostAnchors()
  surface.resetInitializedDirectories()
  const a = workspace(), b = workspace(), bare = workspace()
  put(pathOf(a), recipe("priority-a", "a"))
  put(pathOf(b), recipe("priority-b", "b"))
  let ledger = ""
  surface.setSessionAnchorLedgerFs(() => ({ read: () => ledger, write: s => { ledger = s }, append: s => { ledger += s } }))
  t.after(() => surface.setSessionAnchorLedgerFs(null))
  const mock = await setup(t, a)
  await setup(t, b, mock)
  const before = mock.state.toolHooks.find(h => h.name === "execute.before").cb
  const dispatch = (sid, agent) => before({ tool: "subagent", sessionID: sid, agent: "forge", input: { agent } })
  const warn = t.mock.method(console, "warn", () => {})
  const live = randomUUID(), record = randomUUID()
  await mock.state.emit("session.created", { info: { id: live, directory: b } })
  ledger = [JSON.stringify({ sessionID: live, worktree: a, ts: "2020-01-01T00:00:00.000Z" }), JSON.stringify({ sessionID: record, worktree: b, ts: "2020-01-01T00:00:00.000Z" })].join("\n") + "\n"
  mock.state.sessionRecords.set(live, { location: { directory: bare } })
  await dispatch(live, "forge-priority-b-coder")
  await assert.rejects(dispatch(live, "forge-priority-a-coder"), /its workspace pool/)
  mock.state.sessionRecords.set(record, { location: { directory: a } })
  await dispatch(record, "forge-priority-a-coder")
  await assert.rejects(dispatch(record, "forge-priority-b-coder"), /not dispatchable from this session/)
  const messages = warn.mock.calls.map(c => c.arguments.join(" "))
  assert.ok(messages.some(s => s.includes(live) && s.includes("pooled binding wins")))
  assert.ok(!messages.some(s => (s.includes(live) || s.includes(record)) && s.includes("re-bound from the persisted session-anchor ledger")))
})

test("v2 ledger: deleted pool falls back to global without stale rebind disclosure", async (t) => {
  v2WiringSeam.resetHostAnchors()
  surface.resetInitializedDirectories()
  const a = workspace(), bare = workspace()
  put(pathOf(a), recipe("deleted", "a"))
  put(globalFile, JSON.stringify({ agents: { universal: { model: "zai/glm", thoughtLevel: "low" } } }))
  t.after(() => rmSync(globalFile, { force: true }))
  const mock = await setup(t, a)
  const sid = randomUUID()
  await mock.state.emit("session.created", { info: { id: sid, directory: a } })
  assert.match(surface.sessionAnchorLedgerText(), new RegExp(sid))
  rmSync(pathOf(a))
  surface.resetSessionBindings()
  mock.state.sessionRecords.set(sid, { location: { directory: bare } })
  const warn = t.mock.method(console, "warn", () => {})
  const before = mock.state.toolHooks.find(h => h.name === "execute.before").cb
  await before({ tool: "subagent", sessionID: sid, agent: "forge", input: { agent: "forge-global-universal" } })
  assert.equal(await surface.resolveSessionAnchorForPools(mock.ctx, sid), bare)
  assert.ok(!warn.mock.calls.some(c => c.arguments.join(" ").includes("re-bound from the persisted session-anchor ledger")))
})

test("v2 pool gate: unknown anchor fails open with one bounded disclosure", async (t) => {
  v2WiringSeam.resetHostAnchors()
  surface.resetInitializedDirectories()
  const a = workspace()
  put(pathOf(a), recipe("unknown", "a"))
  const mock = await setup(t, a)
  await setup(t, workspace(), mock)
  mock.ctx.session.get = async () => { throw new Error("record unavailable") }
  const sid = randomUUID()
  const warn = t.mock.method(console, "warn", () => {})
  const before = mock.state.toolHooks.find(h => h.name === "execute.before").cb
  const dispatch = () => before({ tool: "subagent", sessionID: sid, agent: "forge", input: { agent: "forge-unknown-coder" } })
  await dispatch()
  await dispatch()
  const messages = warn.mock.calls.map(c => c.arguments.join(" ")).filter(s => s.includes(sid) && s.includes("could not be established"))
  assert.equal(messages.length, 1)
  assert.match(messages[0], /fail-open belt posture/)
})

test("v2 crew compliance resolves the authoritative noncompliant pool before dispatch", async (t) => {
  v2WiringSeam.resetHostAnchors()
  surface.resetInitializedDirectories()
  const good = workspace(), bad = workspace()
  put(pathOf(good), recipe("good", "good"))
  put(pathOf(bad), JSON.stringify({ agents: { coder: {} } }))
  const mock = await setup(t, good)
  await setup(t, bad, mock)
  const sid = randomUUID()
  mock.state.sessionRecords.set(sid, { location: { directory: good } })
  const call = args => mock.state.tools.get("crew_begin").execute(args, { sessionID: sid, agent: "forge", worktree: good })
  await call({ objective: "anchor compliance", subtasks: [{ title: "one" }] })
  await call({ execution: "waves" })
  mock.state.sessionRecords.set(sid, { location: { directory: bad } })
  const family = surface.resolvePools().families.find(f => fold(f.file) === fold(pathOf(bad)))
  assert.equal(family.materializedIds.length, 1)
  const before = mock.state.toolHooks.find(h => h.name === "execute.before").cb
  await assert.rejects(before({ tool: "subagent", sessionID: sid, agent: "forge", input: { agent: `forge-${family.materializedIds[0]}` } }), err => {
    assert.match(err.message, /Pool compliance refused/)
    assert.ok(fold(err.message).includes(fold(pathOf(bad))))
    assert.match(err.message, /missing top-level pool field/)
    return true
  })
})

test("resolver cache: deletion and recreation at identical stat must not retain old content", () => {
  const file = "C:/fixture/.opencode/forge.json"
  let text = recipe("cache", "first")
  const res = createPoolResolver({ stat: p => p === file && text !== null ? { mtimeMs: 1, size: text.length } : null, readFile: () => text })
  assert.equal(res.resolve(["C:/fixture"]).agents["cache-coder"].shared, "first")
  text = null
  assert.deepEqual(ids(res.resolve(["C:/fixture"])), [])
  text = recipe("cache", "other")
  assert.equal(res.resolve(["C:/fixture"]).agents["cache-coder"].shared, "other")
})

test("v2 pool anchors: per-location records, persisted rebind and move precedence", async (t) => {
  v2WiringSeam.resetHostAnchors()
  surface.resetInitializedDirectories()
  const a = workspace(), b = workspace(), bare = workspace()
  put(pathOf(a), recipe("move-a", "a"))
  put(pathOf(b), recipe("move-b", "b"))
  const A = await setup(t, a), B = await setup(t, b)
  const sidA = randomUUID(), sidB = randomUUID()
  A.state.sessionRecords.set(sidA, { location: { directory: a } })
  B.state.sessionRecords.set(sidB, { location: { directory: b } })
  const resolve = (mock, sid) => surface.resolveSessionAnchorForPools(mock.ctx, sid)
  assert.equal((await surface.stateForCheck(sidA, A.ctx)).worktree, a)
  assert.equal((await surface.stateForCheck(sidB, B.ctx)).worktree, b)
  assert.equal(await resolve(A, sidA), a)
  assert.equal(await resolve(B, sidB), b)
  // A resumed record points to a pool-less launch; ledger rebind is exact.
  v2WiringSeam.sessions.delete(sidB)
  B.state.sessionRecords.set(sidB, { location: { directory: bare } })
  assert.equal(await resolve(B, sidB), b)
  assert.equal(surface.worktreeOf(sidB), b)
  // A real move overrides stale record and historical ledger in both directions.
  await A.state.emit("session.moved", { sessionID: sidA, location: { directory: bare } })
  await new Promise(setImmediate)
  assert.equal(await resolve(A, sidA), bare)
  assert.equal(surface.worktreeOf(sidA), bare)
  await A.state.emit("session.moved", { sessionID: sidA, location: { directory: b } })
  await new Promise(setImmediate)
  assert.equal(await resolve(A, sidA), b)
  assert.equal(surface.worktreeOf(sidA), b)
  assert.equal(await resolve(B, sidB), b)
  v2WiringSeam.sessions.delete(sidB)
  rmSync(pathOf(b))
  assert.equal(await resolve(B, sidB), bare, "deleted ledger target cannot revive a pool")
})

test("v2 pool materialization preserves an entire pre-existing user record and stable same-id siblings", async (t) => {
  v2WiringSeam.resetHostAnchors()
  const a = workspace(), b = workspace()
  put(pathOf(a), recipe("user-a", "generated a"))
  put(pathOf(b), recipe("user-b", "generated b"))
  const mock = createV2MockContext()
  const custom = { mode: "subagent", system: "handwritten body", description: "handwritten description", custom: { value: 42 } }
  mock.state.agents.set("forge-user-a-coder", structuredClone(custom))
  await setup(t, a, mock)
  await setup(t, b, mock)
  assert.deepEqual(mock.state.agents.get("forge-user-a-coder"), custom)
  assert.ok(mock.state.agents.get("forge-user-b-coder").system.includes("generated b"))
  const before = structuredClone(mock.state.agents.get("forge-user-b-coder"))
  await setup(t, b, mock)
  assert.deepEqual(mock.state.agents.get("forge-user-a-coder"), custom)
  assert.deepEqual(mock.state.agents.get("forge-user-b-coder"), before)
})

// Retained persistence semantics, driven through the v2 session resolver.
test("v2 ledger: last pooled binding wins and FIFO compaction preserves newest distinct sessions", async (t) => {
  v2WiringSeam.resetHostAnchors()
  surface.resetInitializedDirectories()
  const a = workspace(), b = workspace(), bare = workspace()
  put(pathOf(a), recipe("fifo-a", "a"))
  put(pathOf(b), recipe("fifo-b", "b"))
  const A = await setup(t, a), B = await setup(t, b)
  const bind = async (mock, sid, directory) => {
    mock.state.sessionRecords.set(sid, { location: { directory } })
    v2WiringSeam.sessions.delete(sid)
    assert.equal((await surface.stateForCheck(sid, mock.ctx)).worktree, directory)
  }
  const entries = () => readFileSync(surface.sessionAnchorLedgerPath(), "utf8").trim().split("\n").map(JSON.parse)
  const mover = randomUUID()
  await bind(A, mover, a)
  await bind(B, mover, b)
  await bind(B, mover, b)
  assert.deepEqual(entries().filter(e => e.sessionID === mover).map(e => e.worktree), [a, b])
  v2WiringSeam.sessions.delete(mover)
  B.state.sessionRecords.set(mover, { location: { directory: bare } })
  assert.equal(await surface.resolveSessionAnchorForPools(B.ctx, mover), b)
  const prefix = randomUUID()
  for (let i = 0; i < 220; i++) await bind(A, `${prefix}-${i}`, a)
  const compacted = entries()
  assert.ok(compacted.length <= 200)
  assert.equal(new Set(compacted.map(e => e.sessionID)).size, compacted.length)
  assert.ok(compacted.some(e => e.sessionID === `${prefix}-219`))
  assert.ok(!compacted.some(e => e.sessionID === `${prefix}-0`))
})

test("v2 ledger: session.created events bind sessions and drive FIFO compaction", async (t) => {
  v2WiringSeam.resetHostAnchors()
  surface.resetInitializedDirectories()
  const a = workspace()
  put(pathOf(a), recipe("event-fifo", "event role"))
  const A = await setup(t, a)
  const prefix = randomUUID()
  for (let i = 0; i < 401; i++) {
    await A.state.emit("session.created", { info: { id: `${prefix}-${i}`, directory: a } })
    await new Promise(setImmediate)
  }
  const entries = readFileSync(surface.sessionAnchorLedgerPath(), "utf8").trim().split("\n").map(JSON.parse)
  assert.equal(surface.worktreeOf(`${prefix}-400`), a)
  assert.ok(entries.some(e => e.sessionID === `${prefix}-400` && e.worktree === a))
  assert.ok(!entries.some(e => e.sessionID === `${prefix}-0`))
})

test("v2 ledger: unreadable/unwritable ledger does not break live resolution or binding", async (t) => {
  v2WiringSeam.resetHostAnchors()
  surface.resetInitializedDirectories()
  const a = workspace(), bare = workspace()
  put(pathOf(a), recipe("io-a", "a"))
  surface.resetSessionBindings()
  const A = await setup(t, a), B = await setup(t, bare)
  const failure = () => { throw new Error("ledger disk gone") }
  surface.setSessionAnchorLedgerFs(() => ({ read: failure, write: failure, append: failure }))
  t.after(() => surface.setSessionAnchorLedgerFs(null))
  const warn = t.mock.method(console, "warn", () => {})
  assert.equal(surface.sessionAnchorLedgerText(), null)
  const sid = randomUUID()
  B.state.sessionRecords.set(sid, { location: { directory: bare } })
  assert.equal(await surface.resolveSessionAnchorForPools(B.ctx, sid), bare)
  assert.equal(await surface.resolveSessionAnchorForPools(B.ctx, sid), bare)
  const before = B.state.toolHooks.find(h => h.name === "execute.before").cb
  await assert.rejects(() => before({ tool: "task", sessionID: sid, agent: "forge", messageID: "m", id: randomUUID(), input: { subagent_type: "forge-io-a-coder" } }), /not dispatchable from this session/)
  A.state.sessionRecords.set(sid, { location: { directory: a } })
  assert.equal((await surface.stateForCheck(sid, A.ctx)).worktree, a)
  assert.equal(await surface.resolveSessionAnchorForPools(A.ctx, sid), a)
  const warnings = warn.mock.calls.map(c => c.arguments.join(" ")).filter(s => s.includes("session-anchor ledger"))
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /fail-soft/)
  assert.equal(warnings[0], "[forge:pool] session-anchor ledger read failed (fail-soft; resolution degrades to the live chain): ledger disk gone")
})

test("wiring crew_begin: the registration output session-scopes the dispatchable roster", async (t) => {
  v2WiringSeam.resetHostAnchors()
  surface.resetInitializedDirectories()
  rmSync(globalFile, { force: true })
  const dirA = workspace(), dirB = workspace()
  put(pathOf(dirA), JSON.stringify({ pool: "teama", agents: { research: { model: "zai/glm", thoughtLevel: "low" } } }))
  put(pathOf(dirB), JSON.stringify({ pool: "teamb", agents: { shader: { model: "zai/glm", thoughtLevel: "low" } } }))
  const mock = await setup(t, dirA)
  await setup(t, dirB, mock)
  const sid = randomUUID()
  mock.state.sessionRecords.set(sid, { location: { directory: dirA } })
  const { content } = await mock.state.tools.get("crew_begin").execute(
    { objective: "o", subtasks: [{ title: "x" }] },
    { sessionID: sid, agent: "forge", messageID: "m", callID: randomUUID() },
  )
  assert.match(content, /registered PENDING/)
  assert.match(content, /Session roster origins — sole ownership/, "the session-scoped roster header")
  assert.match(content, /DISPATCHABLE from this session — workspace pool: [^\n]*forge\.json/, "the session's own pool leads, with origin path")
  assert.ok(fold(content).includes(fold(pathOf(dirA))))
  assert.match(content, /forge-teama-research/, "own agents render with namespaced ids")
  assert.match(content, /NOT dispatchable from this session — pool teamb/, "other pools marked with the verbatim anchor + namespaced label")
  assert.ok(!content.includes("primary pool"), "no primary-pool label remains")
  assert.ok(fold(content).includes(fold(pathOf(dirB))), "the other pool's origin path rides the mark")
})

test("v2 crew registration follows move events and recipe deletion", async (t) => {
  v2WiringSeam.resetHostAnchors()
  surface.resetInitializedDirectories()
  rmSync(globalFile, { force: true })
  const pooled = workspace(), bare = workspace()
  put(pathOf(pooled), recipe("crew-move", "crew role"))
  const { state } = await setup(t, pooled)
  const call = (sid, directory) => state.tools.get("crew_begin").execute(
    { objective: "move regression", subtasks: [{ title: "one" }] },
    { sessionID: sid, agent: "forge", worktree: directory, directory, messageID: "m", callID: randomUUID() },
  )
  const movedIn = randomUUID()
  state.sessionRecords.set(movedIn, { location: { directory: bare } })
  await state.emit("session.moved", { sessionID: movedIn, location: { directory: pooled } })
  await new Promise(setImmediate)
  const result = await call(movedIn, bare)
  assert.match(result.content, /forge-crew-move-coder/)
  const recordPath = v2WiringSeam.crews.get(movedIn).recordPath
  assert.equal(dirname(recordPath), join(pooled, ".opencode", "crew"))
  assert.match(readFileSync(recordPath, "utf8"), /^# Crew Record: move regression\n/)
  assert.match(result.content, /inspectable history; NOT a resume mechanism/)
  await state.tools.get("crew_close").execute({ abandon: true, reason: "move regression" }, { sessionID: movedIn, agent: "forge", worktree: bare, directory: bare })
  const movedOut = randomUUID()
  state.sessionRecords.set(movedOut, { location: { directory: pooled } })
  await state.emit("session.created", { info: { id: movedOut, directory: pooled, worktree: pooled } })
  await new Promise(setImmediate)
  assert.equal(v2WiringSeam.sessions.get(movedOut)?.worktree, pooled)
  await state.emit("session.moved", { sessionID: movedOut, location: { directory: bare } })
  await new Promise(setImmediate)
  await assert.rejects(() => call(movedOut, pooled), err => {
    assert.match(String(err), /CREW IS NOT INITIALIZED/)
    assert.ok(!fold(String(err)).includes(fold(pathOf(pooled))))
    return true
  })
  assert.equal(v2WiringSeam.crews.has(movedOut), false)
  rmSync(pathOf(pooled))
  const afterDeletion = randomUUID()
  state.sessionRecords.set(afterDeletion, { location: { directory: pooled } })
  await assert.rejects(() => call(afterDeletion), /CREW IS NOT INITIALIZED/)
  assert.equal(v2WiringSeam.crews.has(afterDeletion), false)
})

test("v2 crew registration refuses missing and invalid pool declarations without writing records", async (t) => {
  v2WiringSeam.resetHostAnchors()
  surface.resetInitializedDirectories()
  rmSync(globalFile, { force: true })
  for (const pool of [undefined, "Aa Team!"]) {
    const ws = workspace()
    const file = pathOf(ws)
    put(file, JSON.stringify({ pool, agents: { research: { model: "zai/glm", thoughtLevel: "low" } } }))
    const { state } = await setup(t, ws)
    assert.ok([...state.agents.keys()].some(id => id.startsWith("forge-") && id.endsWith("-research")))
    const sid = randomUUID()
    state.sessionRecords.set(sid, { location: { directory: ws } })
    await assert.rejects(() => state.tools.get("crew_begin").execute(
      { objective: "registration validation", subtasks: [{ title: "one" }] },
      { sessionID: sid, agent: "forge", worktree: ws },
    ), err => {
      const message = String(err)
      assert.match(message, /Pool compliance refused/)
      assert.ok(fold(message).includes(fold(file)))
      assert.match(message, pool === undefined ? /missing top-level pool field/ : /invalid top-level pool field "Aa Team!"/)
      assert.match(message, /Minimal fix: add or repair the top-level "pool": "[a-z0-9-]+"/)
      assert.match(message, /REQUIRED for crew-governed dispatch/)
      assert.match(message, /no host restart/)
      assert.doesNotMatch(message, /Native exit/)
      return true
    })
    assert.equal(v2WiringSeam.crews.has(sid), false)
    assert.equal(existsSync(join(ws, ".opencode", "crew")), false)
    if (pool === undefined) {
      put(file, JSON.stringify({ pool: "repaired", agents: { research: { model: "zai/glm", thoughtLevel: "low" } } }))
      const { content } = await state.tools.get("crew_begin").execute(
        { objective: "registration validation", subtasks: [{ title: "one" }] },
        { sessionID: sid, agent: "forge", worktree: ws },
      )
      assert.match(content, /registered PENDING/)
      assert.equal(v2WiringSeam.crews.get(sid).mode, "pending")
    }
  }
})

test("v2 crew registration uses the authoritative workspace instead of a stale tool directory", async (t) => {
  v2WiringSeam.resetHostAnchors()
  surface.resetInitializedDirectories()
  rmSync(globalFile, { force: true })
  const pooled = workspace(), bare = workspace()
  put(pathOf(pooled), JSON.stringify({ pool: "record-owner", agents: { coder: { shape: "readonly", model: "zai/glm", thoughtLevel: "low" } } }))
  const { state } = await setup(t, pooled)
  const sid = randomUUID()
  state.sessionRecords.set(sid, { location: { directory: pooled } })
  const { content } = await state.tools.get("crew_begin").execute(
    { objective: "record anchor", subtasks: [{ title: "one", agent: "forge-record-owner-coder" }] },
    { sessionID: sid, agent: "forge", worktree: bare, directory: bare },
  )
  assert.match(content, /forge-record-owner-coder/)
  assert.match(content, /DISPATCHABLE from this session — workspace pool/)
  assert.doesNotMatch(content, /CREW IS NOT INITIALIZED/)
  const crew = v2WiringSeam.crews.get(sid)
  assert.equal(crew.mode, "pending")
  assert.equal(dirname(crew.recordPath), join(pooled, ".opencode", "crew"))
  assert.equal(existsSync(join(bare, ".opencode", "crew")), false)
  assert.equal(existsSync(globalFile), false)
  await state.tools.get("crew_close").execute({ abandon: true, reason: "anchor regression" }, { sessionID: sid, agent: "forge", worktree: bare, directory: bare })
  assert.match(readFileSync(crew.recordPath, "utf8"), /ABANDONED/i)
})

test("v2 crew registration uses the tool directory when session lookup is unavailable", async (t) => {
  v2WiringSeam.resetHostAnchors()
  surface.resetInitializedDirectories()
  rmSync(globalFile, { force: true })
  const pooled = workspace(), bare = workspace()
  put(pathOf(pooled), recipe("context-owner", "registration role"))
  const mock = createV2MockContext()
  delete mock.ctx.session.get
  const { state } = await setup(t, pooled, mock)
  const call = (sid, dir) => state.tools.get("crew_begin").execute(
    { objective: "context fallback", subtasks: [{ title: "one" }] },
    { sessionID: sid, agent: "forge", worktree: dir, directory: dir },
  )
  const rejected = randomUUID()
  await assert.rejects(() => call(rejected, bare), /CREW IS NOT INITIALIZED/)
  assert.equal(v2WiringSeam.crews.has(rejected), false)
  assert.equal(existsSync(join(bare, ".opencode", "crew")), false)
  const accepted = randomUUID()
  const { content } = await call(accepted, pooled)
  assert.match(content, /forge-context-owner-coder/)
  await state.tools.get("crew_close").execute({ abandon: true, reason: "context regression" }, { sessionID: accepted, agent: "forge", worktree: pooled })
})

test("v2 plan record uses the session directory when the worktree is degenerate", async (t) => {
  v2WiringSeam.resetHostAnchors()
  surface.resetInitializedDirectories()
  const host = workspace(), ws = workspace()
  const { state } = await setup(t, host)
  const sid = randomUUID()
  await state.tools.get("plan_write").execute(
    { goal: "anchor check", context: "c", approach: "a", tasks: ["t1"], risks: "r", acceptance: ["ac"] },
    { sessionID: sid, agent: "forge", worktree: "/", directory: ws },
  )
  assert.ok(existsSync(join(ws, ".opencode", "plan")), "the plan landed under the session directory")
  assert.ok(!existsSync(join(host, ".opencode", "plan")), "nothing leaked to the launch directory")
})

test("v2 crew initialization: empty and unmaterialized workspace diagnostics, then global origin", async (t) => {
  v2WiringSeam.resetHostAnchors()
  surface.resetInitializedDirectories()
  rmSync(globalFile, { force: true })
  const host = workspace(), ws = workspace(), other = workspace()
  const { ctx, state } = await setup(t, host)
  const call = async (directory, sid) => {
    state.sessionRecords.set(sid, { location: { directory } })
    return state.tools.get("crew_begin").execute({ objective: "diagnose", subtasks: [{ title: "one" }] }, { sessionID: sid, agent: "forge", messageID: "m", callID: randomUUID() })
  }
  const empty = randomUUID()
  await assert.rejects(() => call(host, empty), err => {
    for (const pattern of [/CREW IS NOT INITIALIZED/, /forge\.json/, /restart/, /SOLE OWNERSHIP/, /fallback, NOT a merge/, /nested deeper.*ignored/, /DELETED pool file un-materializes/, /"prompt"/, /"shape": "readonly"/, /absent shape defaults to WRITE/, /EXPLICIT shape/, /SHORT prompt/, /WITHOUT the `forge-` prefix/, /REQUIRED for crew-governed dispatch/, /\/forge init \(draft/, /\/forge init global/, /no host restart needed/]) assert.match(String(err), pattern)
    assert.doesNotMatch(String(err), /host has NOT materialized it/)
    assert.doesNotMatch(String(err), /non-primary/)
    return true
  })
  assert.equal(v2WiringSeam.crews.has(empty), false)
  assert.equal(existsSync(join(host, ".opencode", "crew")), false)
  put(pathOf(ws), recipe("unseen", "unseen role"))
  for (const withSibling of [false, true]) {
    if (withSibling) { put(pathOf(other), recipe("sibling", "sibling role")); await setup(t, other, { ctx, state }) }
    const sid = randomUUID()
    await assert.rejects(() => call(ws, sid), err => {
      assert.match(String(err), /CREW IS NOT INITIALIZED/)
      assert.ok(fold(String(err)).includes(fold(pathOf(ws))))
      assert.match(String(err), /workspace DOES have a forge.json/)
      assert.match(String(err), /host has NOT materialized it/)
      assert.match(String(err), /Re-initialize the host in that workspace, or move the agents into the global layer/)
      return true
    })
    assert.equal(v2WiringSeam.crews.has(sid), false)
    assert.equal(existsSync(join(ws, ".opencode", "crew")), false)
  }
  put(globalFile, recipe("ignored", "global role"))
  await setup(t, host, { ctx, state })
  const { content } = await call(host, randomUUID())
  assert.match(content, /Session roster origins — sole ownership/)
  assert.ok(fold(content).includes(fold(`DISPATCHABLE from this session — global fallback: ${globalFile}`)))
  assert.doesNotMatch(content, /workspace has its own forge.json/)
})
