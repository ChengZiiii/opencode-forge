import test from "node:test"
import assert from "node:assert/strict"

// forge-tui-subagent-config — SESSION-ANCHOR WIRING regressions (reviewer
// skeleton, tests-owned): the ACTUAL RPC wiring must bind the FRESH host
// statement (session.get / session.moved), never a stale live-session-map
// entry. Priority under contract: session.moved record → live host
// statement → stale session map → preload seed; an old "A" in the session
// map must NEVER beat a fresh host "B", and a session.moved to "C" must
// win over an in-flight get that still answers "B".
//
// Only the FINAL path / observedLocation is asserted — never the plugin's
// internal maps. A and B both carry a VALID owning pool file, so the
// pool-less-priority exception can never shadow the decision.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const { v2Setup, v2WiringSeam } = await import("../plugin.ts")
const { createV2MockContext } = await import("./lib/v2-mock-context.mjs")

const POOL_JSON = (pool) => JSON.stringify({ pool, agents: {} })

// Fresh real-temp A/B/C roots, each with a VALID owning pool file.
function makeRoots() {
  const home = mkdtempSync(path.join(tmpdir(), "forge-sesswiring-"))
  const mk = (letter) => {
    const dir = path.join(home, letter)
    mkdirSync(path.join(dir, ".opencode"), { recursive: true })
    writeFileSync(path.join(dir, ".opencode", "forge.json"), POOL_JSON(letter))
    return dir.replace(/\\/g, "/")
  }
  const roots = { A: mk("a"), B: mk("b"), C: mk("c") }
  const cleanup = () => { try { rmSync(home, { recursive: true, force: true }) } catch {} }
  return { home, roots, cleanup }
}

// One wired registration over the real temp tree. Returns the captured
// handlers, the seam, and an all-cleanup for the test's finally.
async function wire(opts = {}) {
  const { home, roots, cleanup: rmRoots } = makeRoots()
  const prevForgeHome = process.env.FORGE_TEST_FORGE_HOME
  const prevNoFetch = process.env.FORGE_TEST_NO_DISPATCH_FETCH
  process.env.FORGE_TEST_FORGE_HOME = home
  process.env.FORGE_TEST_NO_DISPATCH_FETCH = "1"

  const ctx = createV2MockContext()
  ctx.location = { directory: roots.B, worktree: roots.A }
  let handlers = null
  let registrationDispose = null
  ctx.rpc = {
    register: (_definition, registered) => {
      handlers = registered
      return { dispose: async () => { registrationDispose = true } }
    },
  }
  ctx.session = {
    get: opts.sessionGet ?? (async ({ sessionID }) => ({ location: { directory: roots.B } })),
  }
  await v2Setup(ctx, { anchors: [roots.A, roots.B, roots.C], homeDir: path.join(home, "fg-home") })
  const seam = v2WiringSeam
  const cleanup = async () => {
    try { await registrationDispose } catch {}
    for (const sid of [opts.sid1, opts.sid2, opts.raceSID].filter(Boolean)) {
      try { seam.sessionMovedAnchors.delete(sid) } catch {}
      try { seam.sessions?.delete?.(sid) } catch {}
    }
    try { seam.resetHostAnchors?.() } catch {}
    process.env.FORGE_TEST_FORGE_HOME = prevForgeHome
    process.env.FORGE_TEST_NO_DISPATCH_FETCH = prevNoFetch
    rmRoots()
  }
  return { handlers, seam, roots, cleanup }
}

const SID = "sess-wiring-1"

test("wiring: editOpen for a workspace session with NO cache binds the FRESH host statement (B), never a stale map A", { timeout: 30_000 }, async (t) => {
  const env = await wire({ sid1: SID })
  try {
    const ed = await env.handlers.editOpen({ scope: "workspace", sessionID: SID })
    assert.equal(ed.ok, true, `editOpen refused: ${JSON.stringify(ed).slice(0, 300)}`)
    assert.equal(ed.observedLocation, env.roots.B, `the ACTUAL RPC binding is the fresh host statement B — got ${JSON.stringify({ path: ed.path, observedLocation: ed.observedLocation })}`)
    assert.ok(String(ed.path ?? "").startsWith(env.roots.B), `the resolved path lives under B — ${ed.path}`)
    assert.ok(!String(ed.path ?? "").startsWith(env.roots.A), "the stale-map root A is never the binding")
  } finally {
    await env.cleanup()
  }
})

test("wiring: a STALE live-session-map entry {worktree:A} does NOT beat the fresh host B", { timeout: 30_000 }, async (t) => {
  const env = await wire({ sid1: SID })
  try {
    // The stale map claims the session lives at A — the host's own fresh
    // statement (session.get → B) is newer truth and MUST win.
    env.seam.sessions?.set?.(SID, { sessionID: SID, worktree: env.roots.A })
    const ed = await env.handlers.editOpen({ scope: "workspace", sessionID: SID })
    assert.equal(ed.ok, true, `editOpen refused: ${JSON.stringify(ed).slice(0, 300)}`)
    assert.equal(ed.observedLocation, env.roots.B, `old-map A must never win over fresh host B — got ${JSON.stringify({ path: ed.path, observedLocation: ed.observedLocation })}`)
    assert.ok(String(ed.path ?? "").startsWith(env.roots.B), `the binding stays under B — ${ed.path}`)
  } finally {
    await env.cleanup()
  }
})

test("wiring race: session.moved to C lands while the OLD get (answering B) is in flight — the binding MUST be C", { timeout: 30_000 }, async (t) => {
  const raceSID = "sess-wiring-race"
  const rootsHolder = { B: null }
  let releaseOldGet
  let oldGetEnteredSettled = false
  const oldGetEntered = new Promise((resolve) => {
    releaseOldGet = () => { oldGetEnteredSettled = true; resolve() }
  })
  const env = await wire({
    sid2: raceSID,
    sessionGet: async ({ sessionID }) => {
      if (sessionID === raceSID) {
        await oldGetEntered // the test holds the OLD lookup open
      }
      return { location: { directory: rootsHolder.B } }
    },
  })
  rootsHolder.B = env.roots.B
  try {
    const openPromise = Promise.resolve().then(() => env.handlers.editOpen({ scope: "workspace", sessionID: raceSID }))
    // Bounded wait for the in-flight old get (never unbounded polling).
    for (let i = 0; i < 100 && !oldGetEnteredSettled; i++) {
      await new Promise((r) => setTimeout(r, 10))
    }
    // The moved statement lands while the old lookup is still open.
    env.seam.sessionMovedAnchors.set(raceSID, env.roots.C)
    releaseOldGet() // the old get now resolves B — too late, moved wins
    const ed = await openPromise
    assert.equal(ed.ok, true, `the raced editOpen refused: ${JSON.stringify(ed).slice(0, 300)}`)
    assert.equal(ed.observedLocation, env.roots.C, `the moved record C must outrank the in-flight B answer — got ${JSON.stringify({ path: ed.path, observedLocation: ed.observedLocation })}`)
    assert.ok(String(ed.path ?? "").startsWith(env.roots.C), `the binding lives under C — ${ed.path}`)
  } finally {
    await env.cleanup()
  }
})

test("wiring: two sequential lookups for the SAME session with different answers do not cross-talk", { timeout: 30_000 }, async (t) => {
  const env = await wire({ sid1: SID })
  try {
    const ed1 = await env.handlers.editOpen({ scope: "workspace", sessionID: SID })
    assert.equal(ed1.ok, true)
    assert.equal(ed1.observedLocation, env.roots.B, "the first binding is B")
    // The host moves the session to C; the NEXT lookup must bind C — the
    // first request's B must never bleed into it.
    env.seam.sessionMovedAnchors.set(SID, env.roots.C)
    const ed2 = await env.handlers.editOpen({ scope: "workspace", sessionID: SID })
    assert.equal(ed2.ok, true)
    assert.equal(ed2.observedLocation, env.roots.C, "the second binding follows the moved statement C")
    assert.ok(String(ed2.path ?? "").startsWith(env.roots.C), `the second path lives under C — ${ed2.path}`)
  } finally {
    await env.cleanup()
  }
})
