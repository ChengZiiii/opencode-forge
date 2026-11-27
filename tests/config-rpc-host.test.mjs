import test from "node:test"
import assert from "node:assert/strict"

// forge-tui-subagent-config — HOST-LEVEL regression tests for the REAL host
// adapter (src/config-rpc-host.ts): the authoritative resolver, the in-lock
// reverify, and the assembled ConfigRpcStoreDeps are exercised through the
// REAL createConfigRpcStore over a REAL tempdir fs — no fake resolver stands
// in for the host (a fake would bypass exactly the bug class these tests
// pin: the global first-creation reverify refusing every creation because
// the global binding's anchor is null and the gate checked
// knownWorkspaceRoot(t.anchor ?? "") unscoped).
//
// rpcLocation discipline (contract): observedLocation comes ONLY from the
// wiring's opts.observedLocation (ctx.location.directory of THIS server
// registration); deps.anchors (the host anchor registry) never preempts it.
// A missing observedLocation fails closed for null-session scopes; anchors
// registered for OTHER roots do not affect this registration's domain.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createConfigRpcHostDeps, resolveConfigTarget, reverifyConfigTarget, resetConfigRpcEpochForTests } from "../src/config-rpc-host.ts"
import { createConfigRpcStore } from "../src/config-rpc-protocol.ts"

const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex")
import { createHash } from "node:crypto"

function fold(p) {
  return p.replace(/[\\/]+/g, "/").toLowerCase()
}

// Synchronous authoritative accessors over a real tempdir (the plugin's
// in-process state shape, minus any network seam).
function makeAccessors(root, opts = {}) {
  const state = {
    sessionAnchors: opts.sessionAnchors ?? new Map(),
    knownRoots: opts.knownRoots ?? new Set(),
  }
  return {
    sessionAnchorOf: (sessionID) => state.sessionAnchors.get(sessionID) ?? null,
    workspacePoolOf: (anchor) => {
      // Real walk-up nearest pool file over the tempdir tree.
      let dir = anchor
      for (;;) {
        const candidate = path.join(dir, ".opencode", "forge.json")
        if (existsSync(candidate)) return candidate
        const parent = path.dirname(dir)
        if (parent === dir) return null
        dir = parent
      }
    },
    globalPoolPath: () => path.join(root, "home", ".config", "opencode", "forge.jsonc"),
    knownWorkspaceRoot: (anchor) => state.knownRoots.has(fold(anchor)),
    samePath: (a, b) => fold(a) === fold(b),
    pathExists: (p) => existsSync(p),
    _state: state,
  }
}

function makeHost(opts = {}) {
  resetConfigRpcEpochForTests({ epoch: "ep-host", generation: 0 })
  const root = mkdtempSync(path.join(tmpdir(), "forge-host-"))
  mkdirSync(path.join(root, "home", ".config", "opencode"), { recursive: true })
  // null is a MEANINGFUL wiring value (fail-closed missing location) — only
  // undefined falls back to the default registration location.
  const observedLocation = opts.observedLocation !== undefined ? opts.observedLocation : path.join(root, "reg-A")
  if (observedLocation !== null) mkdirSync(observedLocation, { recursive: true })
  const acc = makeAccessors(root, opts)
  const deps = createConfigRpcHostDeps(acc, {
    observedLocation,
    clock: () => 1_000_000,
    randomId: () => `id-${++makeHost.seq}`,
    hash: sha256,
    ttlMs: { snapshot: 600_000, token: 60_000, receipt: 60_000 },
    fs: {
      ...opts.fsOverride,
      stat: (p) => {
        try {
          const st = statSync(p)
          return { mtimeMs: st.mtimeMs, size: st.size, dev: st.dev, ino: st.ino }
        } catch {
          return null
        }
      },
      readFile: (p) => readFileSync(p, "utf8"),
      // Write seams deliberately omitted — the kernel's real-fs publication.
    },
  })
  const rpc = createConfigRpcStore(deps).handlers({ pluginID: "forge", appVersion: "2.4.2" })
  return {
    root, acc, deps, rpc, observedLocation,
    globalFile: path.join(root, "home", ".config", "opencode", "forge.jsonc"),
    cleanup: () => { try { rmSync(root, { recursive: true, force: true }) } catch {} },
  }
}
makeHost.seq = 0

// ---------------------------------------------------------------------------
// GLOBAL first creation through the REAL host resolver + reverify + store
// ---------------------------------------------------------------------------

test("HOST global missing file: editOpen resolves creatable with anchor=null", (t) => {
  const env = makeHost()
  try {
    const ed = env.rpc.editOpen({ scope: "global", sessionID: null })
    assert.equal(ed.ok, true, `editOpen refused: ${JSON.stringify(ed)}`)
    assert.equal(ed.creatable, true, "an absent global file is the explicit-creation candidate")
    assert.equal(ed.anchor, null, "the global layer has no workspace anchor of its own")
    assert.equal(existsSync(env.globalFile), false, "editOpen is a pure read — nothing created")
  } finally {
    env.cleanup()
  }
})

test("HOST global first creation commits through reverify: anchor=null must NOT fail the creatable gate", async (t) => {
  const env = makeHost()
  try {
    const ed = env.rpc.editOpen({ scope: "global", sessionID: null })
    assert.equal(ed.ok, true)
    const p = env.rpc.prepare({
      snapshotId: ed.snapshotId, scope: "global", sessionID: null,
      ops: [{ opId: "o1", action: "create", kind: "worker", id: "util", draft: { mode: "pinned", model: "prov/x", thoughtLevel: "high" } }],
    })
    assert.equal(p.ok, true, `prepare refused: ${JSON.stringify(p).slice(0, 300)}`)
    const c = await env.rpc.commit({ token: p.token.token, confirm: true, scope: "global", sessionID: null })
    const dump = JSON.stringify(c, (_k, v) => (typeof v === "bigint" ? String(v) : v))
    assert.equal(c.ok, true, `the in-lock reverify must not refuse a global creation for anchor=null — got: ${dump.slice(0, 400)}`)
    assert.equal(c.receipt.outcome, "written", `receipt: ${dump.slice(0, 400)}`)
    assert.ok(existsSync(env.globalFile), "the file was actually created")
  } finally {
    env.cleanup()
  }
})

test("HOST reverifyConfigTarget directly: a global creatable binding re-verifies true (anchor=null)", (t) => {
  const env = makeHost()
  try {
    const r = resolveConfigTarget(env.acc, env.observedLocation, { scope: "global", sessionID: null })
    assert.equal(r.ok, true)
    const ok = reverifyConfigTarget(env.acc, env.observedLocation, {
      scope: "global", sessionID: null,
      path: r.target.path, observedLocation: r.target.observedLocation, anchor: r.target.anchor,
    })
    assert.equal(ok, true, `reverify must accept its own resolver's global binding — target: ${JSON.stringify(r.target)}`)
  } finally {
    env.cleanup()
  }
})

// ---------------------------------------------------------------------------
// rpcLocation discipline: observedLocation comes ONLY from the wiring opts
// ---------------------------------------------------------------------------

test("HOST null-session home binds THIS registration's observedLocation, never a registry root", (t) => {
  const env = makeHost()  // own location is a registered workspace root
  env.acc._state.knownRoots.add(fold(env.observedLocation))
  env.acc._state.knownRoots.add(fold("/somewhere/registered-by-someone-else"))
  try {
    const ed = env.rpc.editOpen({ scope: "workspace", sessionID: null })
    assert.equal(ed.ok, true)
    assert.equal(ed.observedLocation, env.observedLocation, "the binding location is the registration's observed location")
    assert.ok(!fold(ed.observedLocation).includes("registered-by-someone"), "deps.anchors must not preempt the wiring's rpcLocation")
  } finally {
    env.cleanup()
  }
})

test("HOST missing observedLocation fails closed for null-session scopes (zero reads/writes)", (t) => {
  const env = makeHost({ observedLocation: null })
  try {
    const ed = env.rpc.editOpen({ scope: "global", sessionID: null })
    assert.equal(ed.ok, false)
    assert.equal(ed.reason, "scope-unresolved")
    const edWs = env.rpc.editOpen({ scope: "workspace", sessionID: null })
    assert.equal(edWs.ok, false)
    assert.equal(edWs.reason, "scope-unresolved")
    assert.equal(existsSync(env.globalFile), false, "nothing was created")
  } finally {
    env.cleanup()
  }
})

test("HOST anchors of unrelated roots do not affect this domain's global creation or its own-root workspace creation", (t) => {
  const env = makeHost()
  try {
    env.acc._state.knownRoots.add(fold(env.observedLocation)) // our own registered root
    env.acc._state.knownRoots.add(fold("/unrelated/root-a"))
    env.acc._state.knownRoots.add(fold("/unrelated/root-b"))
    // Global first creation still resolves + re-verifies.
    const g = resolveConfigTarget(env.acc, env.observedLocation, { scope: "global", sessionID: null })
    assert.equal(g.ok, true)
    assert.equal(
      reverifyConfigTarget(env.acc, env.observedLocation, { scope: "global", sessionID: null, path: g.target.path, observedLocation: g.target.observedLocation, anchor: g.target.anchor }),
      true,
      "unrelated registry entries must not disturb the global binding",
    )
    // A session anchored at the registration's own location resolves there.
    env.acc._state.sessionAnchors.set("sess-1", env.observedLocation)
    const ws = resolveConfigTarget(env.acc, env.observedLocation, { scope: "workspace", sessionID: "sess-1" })
    assert.equal(ws.ok, true, `own-root workspace resolution refused: ${JSON.stringify(ws)}`)
    assert.equal(ws.target.observedLocation, env.observedLocation)
    // An UNREGISTERED foreign root stays refused even if some anchor entry exists elsewhere.
    env.acc._state.sessionAnchors.set("sess-2", "/unrelated/unknown-root")
    const foreign = resolveConfigTarget(env.acc, env.observedLocation, { scope: "workspace", sessionID: "sess-2" })
    if (foreign.ok) {
      assert.equal(
        reverifyConfigTarget(env.acc, env.observedLocation, { scope: "workspace", sessionID: "sess-2", path: foreign.target.path, observedLocation: foreign.target.observedLocation, anchor: foreign.target.anchor }),
        foreign.target.creatable ? false : true,
        "an unregistered root's creation binding must fail the reverify gate",
      )
    }
  } finally {
    env.cleanup()
  }
})
