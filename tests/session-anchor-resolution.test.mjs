import test, { after } from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// fix-multi-location-session-anchor (design D3) — where a v2 session is
// anchored when the plugin has been initialized for MORE THAN ONE directory
// (one host process, one module, N initializations — the 2.4.0 service
// reality). The plugin-level default is the LAST-initialized directory; a
// session must never land on it while the host's own session record names
// its directory.
// Plus fix-session-anchor-ledger-use-time-path (design D3) — the ledger
// path follows a redirection set in the test body.
//
// Levels under test (v2ToolContext):
//   explicit context directory → in-memory binding → HOST SESSION RECORD
//   (own directory, then each parentID) → plugin default (named in result).

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
async function init(dir) {
  const { ctx, state } = createV2MockContext()
  await v2Setup(ctx, { anchors: [dir] })
  return { ctx, state, dir }
}
// A session-record reader over a plain table: id → record.
const readerOf = (records) => ({ session: { get: async ({ path }) => records.get(path?.id) } })
// The REAL v2 tool-context shape (W6a): it carries NO directory.
const realCtx = (sessionID) => ({ sessionID, agent: "forge", messageID: "msg_1", id: "call_1" })
// A registered core that binds the calling session first, then refuses for an
// unrelated reason (no goal exists) — the binding is what is under test.
const bindVia = (state, sessionID) => assert.rejects(state.tools.get("goal_check").execute({}, realCtx(sessionID)), /No live goal/)

test("A1: no in-memory binding + the host record names a directory → THAT directory, never the plugin default", async () => {
  const dirA = mk("forge-anchor-a1-own-")
  const dirB = mk("forge-anchor-a1-latest-")
  await init(dirA)
  const latest = await init(dirB) // the plugin default is dirB from here on
  const sid = "ses-a1"
  latest.state.sessionRecords.set(sid, { sessionID: sid, location: { directory: dirA } })

  await bindVia(latest.state, sid)
  assert.equal(surface.worktreeOf(sid), dirA, "bound to the record's directory")

  // A later initialization changes the plugin default, not where a session
  // resolves: a brand-new session still takes its own record's directory.
  const third = await init(mk("forge-anchor-a1-third-"))
  const sid2 = "ses-a1-after-third"
  third.state.sessionRecords.set(sid2, { sessionID: sid2, location: { directory: dirA } })
  const direct = await surface.resolveToolContext(realCtx(sid2), { session: third.ctx.session })
  assert.equal(direct.context.worktree, dirA)
  assert.equal(direct.defaultDirectory, null, "the default was not used")
  const still = await surface.resolveToolContext(realCtx(sid), { session: third.ctx.session })
  assert.equal(still.context.worktree, dirA)
  assert.equal(still.defaultDirectory, null)
})

test("A2: the record carries only a parentID → the chain is walked up to a directory (bounded, cycle-safe)", async () => {
  const dirA = mk("forge-anchor-a2-parent-")
  const dirB = mk("forge-anchor-a2-latest-")
  await init(dirA)
  const latest = await init(dirB)
  latest.state.sessionRecords.set("ses-a2-parent", { sessionID: "ses-a2-parent", location: { directory: dirA } })
  latest.state.sessionRecords.set("ses-a2-child", { sessionID: "ses-a2-child", parentID: "ses-a2-parent" })

  await bindVia(latest.state, "ses-a2-child")
  assert.equal(surface.worktreeOf("ses-a2-child"), dirA, "the child takes the parent's directory")

  // The resolver itself.
  const walk = new Map([
    ["c", { parentID: "p" }],
    ["p", { parentID: "g" }],
    ["g", { directory: dirA }],
  ])
  assert.equal(await surface.hostSessionDirectory(readerOf(walk), "c"), dirA, "grandparent reached")
  const v2Shape = new Map([["v", { parentID: "w" }], ["w", { location: { directory: dirB } }]])
  assert.equal(await surface.hostSessionDirectory(readerOf(v2Shape), "v"), dirB, "the v2 `location.directory` spelling")
  const cycle = new Map([
    ["x", { parentID: "y" }],
    ["y", { parentID: "x" }],
  ])
  assert.equal(await surface.hostSessionDirectory(readerOf(cycle), "x"), "", "a parent cycle terminates empty")
  const deep = new Map()
  for (let i = 0; i < 40; i++) deep.set(`n${i}`, { parentID: `n${i + 1}` })
  deep.set("n40", { directory: dirA })
  assert.equal(await surface.hostSessionDirectory(readerOf(deep), "n0"), "", "the walk is bounded")
  assert.equal(await surface.hostSessionDirectory(readerOf(new Map()), "missing"), "", "no record → empty")
  assert.equal(await surface.hostSessionDirectory(null, "c"), "", "no reader → empty")
  assert.equal(await surface.hostSessionDirectory({ session: {} }, "c"), "", "no session.get → empty")
  assert.equal(
    await surface.hostSessionDirectory(
      { session: { get: async () => { throw new Error("location evicted") } } },
      "c",
    ),
    "",
    "a failing read → empty (never a throw into the tool path)",
  )
  assert.equal(await surface.hostSessionDirectory(readerOf(new Map([["r", { directory: "C:\\" }]])), "r"), "", "a filesystem root is not an anchor")
  assert.equal(await surface.hostSessionDirectory(readerOf(new Map([["w", { worktree: dirB, location: { directory: dirA } }]])), "w"), dirB, "worktree keeps precedence over directory")
})

test("A3: the host gives nothing → the plugin default, and the tool result NAMES it", async () => {
  const dirA = mk("forge-anchor-a3-other-")
  const dirB = mk("forge-anchor-a3-latest-")
  await init(dirA)
  const latest = await init(dirB)

  // A text result from a session with no record at all.
  const res = await latest.state.tools.get("forge_jobs").execute({ action: "list" }, realCtx("ses-a3-note"))
  const note = `[forge] The host gave no workspace for this session (no directory in the session record), so this call ran in the plugin's default directory: ${dirB}`
  assert.ok(String(res.content).endsWith("\n\n" + note), `the result ends with the one naming sentence; got: ${res.content}`)
  assert.equal(String(res.content).split("[forge] The host gave no workspace").length, 2, "named exactly once")
  assert.match(String(res.title), /^jobs \(\d+\)$/, "the result itself is unchanged")

  await bindVia(latest.state, "ses-a3-bind")
  assert.equal(surface.worktreeOf("ses-a3-bind"), dirB, "the default is still the last resort")
  const direct = await surface.resolveToolContext(realCtx("ses-a3-direct"), latest.ctx.session ? { session: latest.ctx.session } : undefined)
  assert.equal(direct.context.worktree, dirB)
  assert.equal(direct.defaultDirectory, dirB, "and it is reported")

  // A host that passes the directory in the context never reports a default.
  const explicit = await surface.resolveToolContext({ sessionID: "ses-a3-explicit", directory: dirA }, latest.ctx.session ? { session: latest.ctx.session } : undefined)
  assert.equal(explicit.context.worktree, dirA)
  assert.equal(explicit.defaultDirectory, null)

  // A host with no session reader at all: same fallback, same naming.
  const blind = await surface.resolveToolContext(realCtx("ses-a3-blind"), undefined)
  assert.equal(blind.context.worktree, dirB)
  assert.equal(blind.defaultDirectory, dirB)
})

test("A4: a dispatch child is bound to the owner's resolved directory the moment it exists", async (t) => {
  const dirA = mk("forge-anchor-a4-owner-")
  const dirB = mk("forge-anchor-a4-latest-")
  await init(dirA)
  const latest = await init(dirB)
  const sid = "ses-a4-owner"
  latest.state.sessionRecords.set(sid, { sessionID: sid, location: { directory: dirA } })
  t.after(async () => {
    try {
      await latest.state.tools.get("forge_jobs").execute({ action: "stop" }, { sessionID: sid, worktree: dirA, directory: dirA, metadata: () => {}, message: async () => {} })
    } catch {}
  })

  const res = await latest.state.tools.get("task").execute({ subagent_type: "general", prompt: "anchor probe", description: "anchor probe", run_in_background: true }, realCtx(sid))

  assert.ok(/task id|dispatched/i.test(String(res.content ?? res)), "an async handle returns")
  assert.equal(latest.state.creates.length, 1, "one child was created")
  const flat = latest.state.creates[0]
  assert.equal(flat.parentID, sid)
  assert.equal(flat.directory, dirA, "the child is created in the owner's resolved directory (not the default dirB)")
  // The mock's create seam answers with the bare record `ses_mockchild_<n>`.
  const childId = "ses_mockchild_1"
  assert.equal(surface.worktreeOf(childId), dirA, "bound to it at creation — no window before the child's first tool call")
  // The owner itself was resolved from its record.
  assert.equal(surface.worktreeOf(sid), dirA)
})

test("A5: single-directory initialization — resolution and results as before", async () => {
  const dirA = mk("forge-anchor-a5-only-")
  const only = await init(dirA)
  const sid = "ses-a5"
  only.state.sessionRecords.set(sid, { sessionID: sid, location: { directory: dirA } })

  const r = await surface.resolveToolContext(realCtx(sid), { session: only.ctx.session })
  assert.equal(r.context.worktree, dirA, "the record's directory is the one and only directory")
  assert.equal(r.defaultDirectory, null, "no default was used, nothing is named")
  assert.equal(typeof r.context.ask, "function", "the ask adapter is wired exactly as before")
  assert.equal(typeof r.context.metadata, "function")

  const res = await only.state.tools.get("forge_jobs").execute({ action: "list" }, realCtx(sid))
  assert.doesNotMatch(String(res.content), /default directory/, "a byte-identical result: no naming sentence")
  assert.match(String(res.title), /^jobs \(\d+\)$/)

  // Level 2 keeps precedence over the record: a session already bound in
  // memory is not re-resolved (the pre-existing contract, untouched).
  const dirOther = mk("forge-anchor-a5-memory-")
  surface.bindChildToDirectory("ses-a5-memory", dirOther)
  only.state.sessionRecords.set("ses-a5-memory", { location: { directory: dirA } })
  const mem = await surface.resolveToolContext(realCtx("ses-a5-memory"), { session: only.ctx.session })
  assert.equal(mem.context.worktree, dirOther)
  assert.equal(mem.defaultDirectory, null)
})

// Set (undefined = remove) the two redirect variables for a synchronous body,
// then restore exactly what was there.
const withRedirect = (vars, body) => {
  const prev = {}
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = process.env[k]
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  try {
    return body()
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

test("ledger path: a FORGE_TEST_FORGE_HOME set in the test body (after the import) is honored", () => {
  const home = mk("forge-ledger-home-")
  const pool = mk("forge-ledger-pool-")
  mkdirSync(join(pool, ".opencode"), { recursive: true })
  writeFileSync(join(pool, ".opencode", "forge.json"), JSON.stringify({ agents: { research: { model: "openai/gpt" } } }))
  withRedirect({ FORGE_TEST_FORGE_HOME: home }, () => {
    const file = join(home, "opencode-forge", "session-anchors.jsonl")
    assert.equal(surface.sessionAnchorLedgerPath(), file, "the path follows the variable at use time (it outranks the suite's runtime-dir redirect)")
    assert.equal(existsSync(file), false, "nothing written yet")
    surface.noteLedgerBinding("ses-ledger-probe", pool)
    assert.equal(existsSync(file), true, "the bind landed in the redirected home")
    assert.match(readFileSync(file, "utf8"), /"sessionID":"ses-ledger-probe"/)
  })
})

test("ledger path: the suite's runtime-dir redirect carries the ledger along when the HOME alias is unset", () => {
  const rt = mk("forge-ledger-runtime-")
  withRedirect({ FORGE_TEST_RUNTIME_DIR: rt, FORGE_TEST_FORGE_HOME: undefined }, () => {
    assert.equal(surface.sessionAnchorLedgerPath(), join(rt, "opencode-forge", "session-anchors.jsonl"))
  })
})

test("ledger path: without either redirect variable it is the production location", () => {
  withRedirect({ FORGE_TEST_RUNTIME_DIR: undefined, FORGE_TEST_FORGE_HOME: undefined }, () => {
    assert.equal(surface.sessionAnchorLedgerPath(), join(tmpdir(), "opencode-forge", "session-anchors.jsonl"))
  })
})
