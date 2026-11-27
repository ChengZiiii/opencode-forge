import test from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

// forge-tui-subagent-config — server-side commit protocol state machine
// (src/config-rpc-protocol.ts createConfigRpcStore), frozen API v1.
// Injected non-determinism: clock/randomId/hash/epoch/resolver/reverify.
// Recipe files live in a REAL tempdir until the additive snapshotDeps/
// commitDeps fs seam lands (then a memfs twin joins; API usage unchanged).
// Contract anchors: openspec forge-tui-subagent-config "Server-mediated
// commit protocol" + design D4/D7 — prepare pure read against the
// edit-start snapshot; single-use epoch-bound tokens with TTL and
// location binding for null-session home scope; per-actual-target commit
// lock shared across locations for a global target; in-memory receipts,
// UNKNOWN when missing, bytes never adjudicate an old commit.

import { createConfigRpcStore } from "../src/config-rpc-protocol.ts"

// ---------------------------------------------------------------------------
// Harness: real tempdir + fake resolver + fake clock
// ---------------------------------------------------------------------------

const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex")

const LOC_A = "C:/locA"
const LOC_B = "C:/locB"
const SESSION_A = "sess-a"
const SESSION_B = "sess-b"

function makeEnv(opts = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "forge-rpc-proto-"))
  const GLOBAL_FILE = path.join(root, "global", "forge.json")
  const WS_A = path.join(root, "wsA", ".opencode", "forge.json")
  const WS_B = path.join(root, "wsB", ".opencode", "forge.json")

  const state = {
    now: 1_000_000,
    location: LOC_A, // the server-observed location; tests may move it
    epoch: { epoch: "ep-1", generation: 7 },
    reverify: () => true,
  }
  let idCounter = 0

  const env = {
    root,
    GLOBAL_FILE,
    WS_A,
    WS_B,
    state,
    advance(ms) { state.now += ms },
    moveLocation(loc) { state.location = loc },
    rotateEpoch(next = { epoch: "ep-2", generation: 8 }) { state.epoch = next },
    failOwnership() { state.reverify = () => false },
    recipeOf: (p) => fs.readFileSync(p, "utf8"),
    identityOf: (p) => {
      const st = fs.statSync(p)
      return { mtimeMs: st.mtimeMs, size: st.size, dev: st.dev, ino: st.ino }
    },
  }

  const deps = {
    clock: () => state.now,
    randomId: () => `id-${++idCounter}`,
    hash: sha256,
    epoch: () => ({ ...state.epoch }),
    ttlMs: { snapshot: 5_000, token: 60_000, receipt: 60_000 },
    limits: opts.limits,
    resolver(req) {
      // Contradiction injection (found-but-missing review case): when set,
      // a workspace request resolves to a target the resolver CLAIMS to own
      // (creatable:false) at a path with NO file on disk.
      if (env.contradictoryWorkspaceTarget && req.scope === "workspace") {
        const t = env.contradictoryWorkspaceTarget
        return { ok: true, target: { path: t.path, observedLocation: state.location, anchor: path.dirname(path.dirname(t.path)), creatable: t.creatable === true } }
      }
      if (req.scope === "global") {
        return {
          ok: true,
          target: { path: GLOBAL_FILE, observedLocation: state.location, anchor: null, creatable: true },
        }
      }
      // workspace: session kind resolves through the session anchor (path
      // AND anchor move together); null sessionID = home scope of the
      // currently observed location — never a wildcard, never mixed.
      const isA = state.location === LOC_A
      const home = isA ? WS_A : WS_B
      if (req.sessionID === SESSION_A) {
        return { ok: true, target: { path: WS_A, observedLocation: state.location, anchor: root + "/wsA", creatable: true } }
      }
      if (req.sessionID === SESSION_B) {
        return { ok: true, target: { path: WS_B, observedLocation: state.location, anchor: root + "/wsB", creatable: true } }
      }
      return { ok: true, target: { path: home, observedLocation: state.location, anchor: isA ? root + "/wsA" : root + "/wsB", creatable: true } }
    },
    reverify: (req) => state.reverify(req),
  }

  const store = createConfigRpcStore(deps)
  env.rpc = store.handlers({ pluginID: "forge", appVersion: "2.4.2" })
  env.cleanup = () => { try { fs.rmSync(root, { recursive: true, force: true }) } catch {} }
  return env
}

// Seed the GLOBAL recipe with one existing worker "util".
function seedGlobal(env, text = '{\n  "agents": {\n    "util": { "prompt": "old prompt" }\n  }\n}\n') {
  fs.mkdirSync(path.dirname(env.GLOBAL_FILE), { recursive: true })
  fs.writeFileSync(env.GLOBAL_FILE, text, "utf8")
}

function seedWorkspaceA(env, text = '{\n  "pool": "proj",\n  "agents": {\n    "scout": { "model": "prov/old", "thoughtLevel": "low" },\n    "scribe": {}\n  }\n}\n') {
  fs.mkdirSync(path.dirname(env.WS_A), { recursive: true })
  fs.writeFileSync(env.WS_A, text, "utf8")
}

// Standard pin-util edit over the global file: editOpen → prepare → token.
async function prepareUtilPin(env, model = "prov/new", level = "high") {
  const ed = await env.rpc.editOpen({ scope: "global", sessionID: null })
  assert.equal(ed.ok !== false, true, `editOpen failed: ${JSON.stringify(ed)}`)
  const p = await env.rpc.prepare({
    snapshotId: ed.snapshotId,
    scope: "global",
    sessionID: null,
    ops: [{ opId: "o1", action: "update", kind: "worker", id: "util", draft: { mode: "pinned", model, thoughtLevel: level } }],
  })
  return { ed, p }
}

// The loser of a per-target race may surface either as ok:false or as an
// ok receipt with a non-written outcome — both are "refused as conflict";
// what is FORBIDDEN is a second written receipt.
function assertLoserRefused(loser, file, firstText, secondText) {
  const finalText = envRecipe(file)
  assert.equal(finalText.includes('"prov/new"') || finalText.includes('"prov/other"'), true, "the winner's text landed")
  assert.equal(
    finalText.includes('"prov/new"') && finalText.includes('"prov/other"'),
    false,
    "both competing texts must never merge into the file",
  )
  if (loser.ok === false) return
  assert.ok(loser.receipt, "an ok loser must carry a receipt explaining the non-write")
  assert.notEqual(loser.receipt.outcome, "written", "the stale loser must never report written")
  assert.match(String(loser.receipt.outcome ?? loser.receipt.message), /conflict|stale/i)
}

function envRecipe(file) {
  return fs.readFileSync(file, "utf8")
}

// ---------------------------------------------------------------------------
// Definition sanity (rpc.ts static export)
// ---------------------------------------------------------------------------

test("definition: id is opencode-forge-config and the method surface matches the frozen v1 contract", async () => {
  const { forgeConfigRpcDefinition } = await import("../rpc.ts")
  assert.equal(forgeConfigRpcDefinition.id, "opencode-forge-config")
  const methods = Object.keys(forgeConfigRpcDefinition.methods ?? forgeConfigRpcDefinition)
  for (const m of ["echo", "editOpen", "prepare", "commit", "receipt"]) {
    assert.ok(methods.includes(m), `definition exposes ${m}`)
  }
  // Plain JSON Schema values only (statically bundled by design): every
  // schema value must survive JSON round-trip unchanged.
  const round = JSON.parse(JSON.stringify(forgeConfigRpcDefinition))
  assert.deepEqual(round, forgeConfigRpcDefinition)
})

// ---------------------------------------------------------------------------
// echo
// ---------------------------------------------------------------------------

test("echo round-trips the nonce and identifies the plugin", async () => {
  const env = makeEnv()
  try {
    const r = await env.rpc.echo({ nonce: "n-123" })
    assert.match(JSON.stringify(r), /n-123/, "the nonce comes back")
  } finally {
    env.cleanup()
  }
})

// ---------------------------------------------------------------------------
// editOpen: pure read, snapshot identity; external edit after open
// ---------------------------------------------------------------------------

test("editOpen snapshots the file once: raw/doc/path/identity returned, zero mutation", async (t) => {
  const env = makeEnv()
  t.after(() => env.cleanup())
  seedGlobal(env)
  const before = env.recipeOf(env.GLOBAL_FILE)
  const ed = await env.rpc.editOpen({ scope: "global", sessionID: null })
  assert.equal(ed.path, env.GLOBAL_FILE)
  assert.equal(ed.raw, before, "the snapshot raw is the file's exact bytes")
  assert.ok(ed.snapshotId, "a snapshot handle is issued")
  assert.ok(ed.identity, "the snapshot carries the file identity")
  assert.equal(ed.identity.size, before.length)
  assert.equal(env.recipeOf(env.GLOBAL_FILE), before, "editOpen mutated nothing")
})

test("external edit between editOpen and commit is refused (never silently swallowed), external bytes survive", async (t) => {
  const env = makeEnv()
  t.after(() => env.cleanup())
  seedGlobal(env)
  const ed = await env.rpc.editOpen({ scope: "global", sessionID: null })
  // Another editor rewrites the file AFTER the snapshot handle was issued.
  const externalText = '{\n  "agents": {\n    "util": { "prompt": "EXTERNAL EDIT" }\n  }\n}\n'
  fs.writeFileSync(env.GLOBAL_FILE, externalText, "utf8")
  const p = await env.rpc.prepare({ snapshotId: ed.snapshotId, scope: "global", sessionID: null, ops: [{ opId: "o1", action: "update", kind: "worker", id: "util", draft: { mode: "pinned", model: "prov/new", thoughtLevel: "high" } }] })
  // The patch may be computed against the handle, but the write itself must
  // never land: commit re-verifies the edit-start snapshot and refuses.
  let loser = null
  if (p && p.outcome === "token") {
    loser = await env.rpc.commit({ token: p.token.token, confirm: true, scope: "global", sessionID: null })
  } else {
    loser = p // prepare itself refused the stale handle — equally valid
  }
  assert.ok(loser, "the save path produced a verdict")
  if (loser.ok === false) {
    assert.notEqual(loser.reason, undefined)
  } else {
    assert.notEqual(loser.receipt.outcome, "written", "a commit against a stale snapshot must never report written")
    assert.match(String(loser.receipt.outcome), /conflict/)
  }
  assert.equal(env.recipeOf(env.GLOBAL_FILE), externalText, "the external edit is intact — never overwritten")
})

test("prepare is PURE READ: no byte of any recipe file changes when a token is issued", async (t) => {
  const env = makeEnv()
  t.after(() => env.cleanup())
  seedGlobal(env)
  const before = env.recipeOf(env.GLOBAL_FILE)
  const beforeIdentity = env.identityOf(env.GLOBAL_FILE)
  const { p } = await prepareUtilPin(env)
  assert.ok(p, "prepare answered")
  assert.equal(env.recipeOf(env.GLOBAL_FILE), before, "prepare wrote nothing")
  const afterIdentity = env.identityOf(env.GLOBAL_FILE)
  assert.equal(afterIdentity.mtimeMs, beforeIdentity.mtimeMs, "prepare did not even touch the file")
})

// ---------------------------------------------------------------------------
// Strict UTF-8 / full identity binding
// ---------------------------------------------------------------------------

test("a file with undecodable bytes snapshots as unreadable — every edit refuses, bytes never touched", async (t) => {
  const env = makeEnv()
  t.after(() => env.cleanup())
  fs.mkdirSync(path.dirname(env.GLOBAL_FILE), { recursive: true })
  fs.writeFileSync(env.GLOBAL_FILE, Buffer.from([0xff, 0xfe, 0x7b, 0x7d]), "binary")
  const ed = await env.rpc.editOpen({ scope: "global", sessionID: null })
  const p = await env.rpc.prepare({
    snapshotId: ed.snapshotId, scope: "global", sessionID: null,
    ops: [{ opId: "o1", action: "update", kind: "worker", id: "util", draft: { mode: "auto" } }],
  })
  const refused = p && p.outcome === "token" ? await env.rpc.commit({ token: p.token.token, confirm: true, scope: "global", sessionID: null }) : p
  const verdict = JSON.stringify(refused)
  assert.match(verdict, /unreadable|refus|fail/i, `undecodable bytes must refuse the edit — got: ${verdict}`)
  assert.deepEqual(fs.readFileSync(env.GLOBAL_FILE), Buffer.from([0xff, 0xfe, 0x7b, 0x7d]), "the raw bytes are untouched")
})

test("full identity binding: the file deleted+recreated with identical bytes but a new identity after prepare refuses the commit", async (t) => {
  const env = makeEnv()
  t.after(() => env.cleanup())
  seedGlobal(env)
  const { ed, p } = await prepareUtilPin(env)
  assert.ok(p && p.outcome === "token", "prepare issued a token")
  // Delete + recreate with byte-identical content: bytes match, identity does not.
  const original = env.recipeOf(env.GLOBAL_FILE)
  fs.unlinkSync(env.GLOBAL_FILE)
  fs.writeFileSync(env.GLOBAL_FILE, original, "utf8")
  const c = await env.rpc.commit({ token: p.token.token, confirm: true, scope: "global", sessionID: null })
  const loser = c.ok === false ? c : c.receipt
  assert.notEqual(loser.outcome ?? loser.reason, "written", "an identity-swapped target must not commit")
  assert.match(String(loser.outcome ?? loser.reason), /conflict/)
  assert.equal(env.recipeOf(env.GLOBAL_FILE), original, "no write happened")
  void ed
})

test("identity compare is COMPLETE: same bytes, same mtime/size, DIFFERENT dev/ino refuses the commit", async (t) => {
  const env = makeEnv()
  t.after(() => env.cleanup())
  seedGlobal(env)
  const { p } = await prepareUtilPin(env)
  assert.ok(p && p.outcome === "token")
  // Swap the file for a NEW inode carrying the same bytes, then restore the
  // original mtime — bytes, size and mtime all match; only dev/ino differ.
  const original = env.recipeOf(env.GLOBAL_FILE)
  const savedMtimeMs = fs.statSync(env.GLOBAL_FILE).mtimeMs
  const originalIno = fs.statSync(env.GLOBAL_FILE).ino
  const swap = env.GLOBAL_FILE + ".swap"
  fs.writeFileSync(swap, original, "utf8")
  fs.unlinkSync(env.GLOBAL_FILE)
  fs.renameSync(swap, env.GLOBAL_FILE)
  const at = new Date(savedMtimeMs)
  fs.utimesSync(env.GLOBAL_FILE, at, at)
  const swappedIno = fs.statSync(env.GLOBAL_FILE).ino
  if (swappedIno === 0 || swappedIno === originalIno) {
    // Platform cannot produce a distinguishable ino for the number stat —
    // the dev/ino leg is untestable here; skip rather than fake a pass.
    t.skip("this platform's stat does not expose a distinguishable ino (leg covered by the injected-fs twin)")
    return
  }
  const c = await env.rpc.commit({ token: p.token.token, confirm: true, scope: "global", sessionID: null })
  const loser = c.ok === false ? c : c.receipt
  assert.notEqual(loser.outcome ?? loser.reason, "written", "an inode-swapped target at equal mtime/size must refuse")
  assert.match(String(loser.outcome ?? loser.reason), /conflict/)
  assert.equal(env.recipeOf(env.GLOBAL_FILE), original, "no write happened")
})

// ---------------------------------------------------------------------------
// Forged targets / unbound content
// ---------------------------------------------------------------------------

test("forged snapshot handle and unknown token are refused (the server never accepts un-issued state)", async (t) => {
  const env = makeEnv()
  t.after(() => env.cleanup())
  seedGlobal(env)
  const forgedPrepare = await env.rpc.prepare({ snapshotId: "forged-snapshot-id", scope: "global", sessionID: null, ops: [{ opId: "o1", action: "update", kind: "worker", id: "util", draft: { mode: "auto" } }] })
  assert.equal(forgedPrepare.ok, false, "a snapshot the server never issued is refused")
  const forgedCommit = await env.rpc.commit({ token: "forged-token", confirm: true, scope: "global", sessionID: null })
  assert.equal(forgedCommit.ok, false, "a token the server never issued is refused")
  assert.equal(forgedCommit.reason, "token-unknown")
  assert.equal(env.recipeOf(env.GLOBAL_FILE).includes("prov/"), false)
})

// ---------------------------------------------------------------------------
// TTL: fake clock, no auto-renewal, fresh prepare required
// ---------------------------------------------------------------------------

test("an expired token is refused until a fresh prepare — expiry never auto-renews", async (t) => {
  const env = makeEnv()
  t.after(() => env.cleanup())
  seedGlobal(env)
  const { p } = await prepareUtilPin(env)
  assert.ok(p && p.outcome === "token")
  assert.equal(typeof p.token.expiresAt, "number", "expiresAt is returned to the client")
  assert.equal(p.token.epoch, "ep-1")
  assert.equal(p.token.generation, 7)
  env.advance(60_001) // past expiresAt
  const c = await env.rpc.commit({ token: p.token.token, confirm: true, scope: "global", sessionID: null })
  assert.equal(c.ok, false, "the expired token is refused")
  assert.equal(c.reason, "token-expired")
  assert.equal(env.recipeOf(env.GLOBAL_FILE).includes("prov/new"), false, "no write")
  // Fresh prepare against current bytes succeeds and commits.
  const { p: p2 } = await prepareUtilPin(env, "prov/new2", "high")
  assert.ok(p2 && p2.outcome === "token")
  const c2 = await env.rpc.commit({ token: p2.token.token, confirm: true, scope: "global", sessionID: null })
  assert.equal(c2.ok, true)
  assert.equal(c2.receipt.outcome, "written")
  assert.match(env.recipeOf(env.GLOBAL_FILE), /prov\/new2/)
})

test("an expired snapshot handle is refused at prepare (no token over a stale edit-start)", async (t) => {
  const env = makeEnv()
  t.after(() => env.cleanup())
  seedGlobal(env)
  const ed = await env.rpc.editOpen({ scope: "global", sessionID: null })
  env.advance(5_001) // past snapshot ttl
  const p = await env.rpc.prepare({ snapshotId: ed.snapshotId, scope: "global", sessionID: null, ops: [{ opId: "o1", action: "update", kind: "worker", id: "util", draft: { mode: "auto" } }] })
  assert.equal(p.ok, false, "the stale snapshot refuses prepare")
  assert.equal(env.recipeOf(env.GLOBAL_FILE).includes("prov/"), false)
})

// ---------------------------------------------------------------------------
// Epoch / registration generation invalidation
// ---------------------------------------------------------------------------

test("rotateEpoch refuses every previously issued token; the receipt does not survive either", async (t) => {
  const env = makeEnv()
  t.after(() => env.cleanup())
  seedGlobal(env)
  const { p } = await prepareUtilPin(env)
  assert.ok(p && p.outcome === "token")
  env.rotateEpoch({ epoch: "ep-2", generation: 8 })
  const c = await env.rpc.commit({ token: p.token.token, confirm: true, scope: "global", sessionID: null })
  assert.equal(c.ok, false)
  assert.equal(c.reason, "epoch-stale")
  assert.equal(env.recipeOf(env.GLOBAL_FILE).includes("prov/new"), false, "no cross-epoch write")
  const r = await env.rpc.receipt({ token: p.token.token })
  assert.equal(r.found, false, "no persistent receipt store survives the epoch change")
  assert.equal(r.epoch, "ep-2", "the query reports the CURRENT epoch — the old outcome is UNKNOWN")
  assert.equal(r.generation, 8)
})

test("current bytes matching the patch never adjudicate an ambiguous old commit — the epoch-stale token stays refused", async (t) => {
  const env = makeEnv()
  t.after(() => env.cleanup())
  seedGlobal(env)
  const { p } = await prepareUtilPin(env)
  env.rotateEpoch()
  // Simulate the ambiguous world: the file's bytes HAPPEN to equal the patch
  // (an unknown actor wrote them). This must not revive anything.
  const preview = p.preview
  assert.ok(preview && preview.newText !== undefined, "the preview carries the exact new text")
  fs.writeFileSync(env.GLOBAL_FILE, preview.newText, "utf8")
  const c = await env.rpc.commit({ token: p.token.token, confirm: true, scope: "global", sessionID: null })
  assert.equal(c.ok, false, "matching bytes prove nothing — the epoch-stale token is refused, never replayed")
  assert.equal(c.reason, "epoch-stale")
})

// ---------------------------------------------------------------------------
// Null-session home scope binds the observed LOCATION, not the path
// ---------------------------------------------------------------------------

test("a token prepared under location A is refused after the observed location moves to B, even with the identical global target path", async (t) => {
  const env = makeEnv()
  t.after(() => env.cleanup())
  seedGlobal(env)
  const ed = await env.rpc.editOpen({ scope: "global", sessionID: null })
  assert.equal(ed.path, env.GLOBAL_FILE)
  const p = await env.rpc.prepare({ snapshotId: ed.snapshotId, scope: "global", sessionID: null, ops: [{ opId: "o1", action: "update", kind: "worker", id: "util", draft: { mode: "pinned", model: "prov/new", thoughtLevel: "high" } }] })
  assert.ok(p && p.outcome === "token")
  env.moveLocation(LOC_B) // target re-resolves under B — same global path
  const c = await env.rpc.commit({ token: p.token.token, confirm: true, scope: "global", sessionID: null })
  assert.equal(c.ok, false, "the binding is the location, not the server home path")
  assert.equal(c.reason, "scope-mismatch")
  assert.equal(env.recipeOf(env.GLOBAL_FILE).includes("prov/new"), false, "no write")
})

test("a session-scope token refused when the confirmed commit presents a different session (session→home)", async (t) => {
  const env = makeEnv()
  t.after(() => env.cleanup())
  seedWorkspaceA(env)
  const ed = await env.rpc.editOpen({ scope: "workspace", sessionID: SESSION_A })
  const p = await env.rpc.prepare({ snapshotId: ed.snapshotId, scope: "workspace", sessionID: SESSION_A, ops: [{ opId: "o1", action: "update", kind: "worker", id: "scout", draft: { mode: "pinned", model: "prov/new", thoughtLevel: "high" } }] })
  assert.ok(p && p.outcome === "token")
  const c = await env.rpc.commit({ token: p.token.token, confirm: true, scope: "workspace", sessionID: null })
  assert.equal(c.ok, false, "confirm-time scope must equal prepare-time scope")
  assert.equal(c.reason, "scope-mismatch")
  assert.equal(env.recipeOf(env.WS_A).includes("prov/new"), false, "no write")
  // The token is NOT spent by a refused scope-mismatch commit — the honest
  // client retry with the correct scope still works (same token, same epoch).
  const c2 = await env.rpc.commit({ token: p.token.token, confirm: true, scope: "workspace", sessionID: SESSION_A })
  assert.equal(c2.ok, true, "the refused attempt must not have consumed the token")
  assert.equal(c2.receipt.outcome, "written")
  assert.match(env.recipeOf(env.WS_A), /prov\/new/)
})

// ---------------------------------------------------------------------------
// Confirm discipline
// ---------------------------------------------------------------------------

test("commit without explicit confirm refuses with confirm-required and does NOT spend the token", async (t) => {
  const env = makeEnv()
  t.after(() => env.cleanup())
  seedGlobal(env)
  const { p } = await prepareUtilPin(env)
  assert.ok(p && p.outcome === "token")
  const c0 = await env.rpc.commit({ token: p.token.token, confirm: false, scope: "global", sessionID: null })
  assert.equal(c0.ok, false)
  assert.equal(c0.reason, "confirm-required")
  assert.equal(env.recipeOf(env.GLOBAL_FILE).includes("prov/new"), false, "an unconfirmed commit never writes")
  const c1 = await env.rpc.commit({ token: p.token.token, confirm: true, scope: "global", sessionID: null })
  assert.equal(c1.ok, true, "the token survived the confirm-required refusal")
  assert.equal(c1.receipt.outcome, "written")
})

// ---------------------------------------------------------------------------
// At-most-once + receipt independence
// ---------------------------------------------------------------------------

test("the same token commits at most once; its receipt stays queryable and is not consumed by queries", async (t) => {
  const env = makeEnv()
  t.after(() => env.cleanup())
  seedGlobal(env)
  const { p } = await prepareUtilPin(env)
  const token = p.token.token
  const c1 = await env.rpc.commit({ token, confirm: true, scope: "global", sessionID: null })
  assert.equal(c1.ok, true)
  assert.equal(c1.receipt.outcome, "written")
  assert.equal(c1.receipt.token, token, "the receipt is bound to the token")
  assert.ok(c1.receipt.commitId, "the receipt carries a commit id")
  assert.equal(c1.receipt.epoch, "ep-1")
  const after1 = env.recipeOf(env.GLOBAL_FILE)
  const c2 = await env.rpc.commit({ token, confirm: true, scope: "global", sessionID: null })
  assert.equal(c2.ok, false, "the spent token is refused")
  assert.equal(c2.reason, "token-spent")
  assert.equal(env.recipeOf(env.GLOBAL_FILE), after1, "the second commit wrote nothing")
  // Receipt queries are INDEPENDENT of the spent state: querying neither
  // consumes the receipt nor revives the token.
  const r1 = await env.rpc.receipt({ token })
  assert.equal(r1.found, true)
  assert.equal(r1.receipt.outcome, "written")
  const r2 = await env.rpc.receipt({ token })
  assert.equal(r2.found, true, "a receipt query does not consume the receipt")
  assert.equal(r2.receipt.outcome, "written")
  const c3 = await env.rpc.commit({ token, confirm: true, scope: "global", sessionID: null })
  assert.equal(c3.ok, false, "a receipt query does not revive the token")
  assert.equal(c3.reason, "token-spent")
})

// ---------------------------------------------------------------------------
// Per-actual-target serialization + competing prepares
// ---------------------------------------------------------------------------

test("competing prepares over the same original bytes: the first commit wins, the stale second is refused — exactly one write", async (t) => {
  const env = makeEnv()
  t.after(() => env.cleanup())
  seedGlobal(env)
  const ed1 = await env.rpc.editOpen({ scope: "global", sessionID: null })
  const ed2 = await env.rpc.editOpen({ scope: "global", sessionID: null })
  const p1 = await env.rpc.prepare({ snapshotId: ed1.snapshotId, scope: "global", sessionID: null, ops: [{ opId: "o1", action: "update", kind: "worker", id: "util", draft: { mode: "pinned", model: "prov/new", thoughtLevel: "high" } }] })
  const p2 = await env.rpc.prepare({ snapshotId: ed2.snapshotId, scope: "global", sessionID: null, ops: [{ opId: "o1", action: "update", kind: "worker", id: "util", draft: { mode: "pinned", model: "prov/other", thoughtLevel: "low" } }] })
  assert.ok(p1.outcome === "token" && p2.outcome === "token", "both prepares legitimately issue tokens")
  const c1 = await env.rpc.commit({ token: p1.token.token, confirm: true, scope: "global", sessionID: null })
  assert.equal(c1.ok, true)
  assert.equal(c1.receipt.outcome, "written")
  const c2 = await env.rpc.commit({ token: p2.token.token, confirm: true, scope: "global", sessionID: null })
  assertLoserRefused(c2, env.GLOBAL_FILE)
  assert.match(env.recipeOf(env.GLOBAL_FILE), /prov\/new/, "the winner's text stands")
  assert.equal(env.recipeOf(env.GLOBAL_FILE).includes("prov/other"), false, "the loser never landed")
})

test("two locations reaching the SAME global target serialize on one shared per-target lock (one winner, one stale loser)", async (t) => {
  const env = makeEnv()
  t.after(() => env.cleanup())
  seedGlobal(env)
  const ed1 = await env.rpc.editOpen({ scope: "global", sessionID: SESSION_A })
  const ed2 = await env.rpc.editOpen({ scope: "global", sessionID: SESSION_B })
  const p1 = await env.rpc.prepare({ snapshotId: ed1.snapshotId, scope: "global", sessionID: SESSION_A, ops: [{ opId: "o1", action: "update", kind: "worker", id: "util", draft: { mode: "pinned", model: "prov/new", thoughtLevel: "high" } }] })
  const p2 = await env.rpc.prepare({ snapshotId: ed2.snapshotId, scope: "global", sessionID: SESSION_B, ops: [{ opId: "o1", action: "update", kind: "worker", id: "util", draft: { mode: "pinned", model: "prov/other", thoughtLevel: "low" } }] })
  assert.ok(p1.outcome === "token" && p2.outcome === "token")
  const c1 = await env.rpc.commit({ token: p1.token.token, confirm: true, scope: "global", sessionID: SESSION_A })
  assert.equal(c1.ok, true)
  assert.equal(c1.receipt.outcome, "written")
  const c2 = await env.rpc.commit({ token: p2.token.token, confirm: true, scope: "global", sessionID: SESSION_B })
  assertLoserRefused(c2, env.GLOBAL_FILE)
})

// ---------------------------------------------------------------------------
// Ownership recheck at commit
// ---------------------------------------------------------------------------

test("a failed ownership re-verification at commit blocks the write (receipt outcome ownership-lost)", async (t) => {
  const env = makeEnv()
  t.after(() => env.cleanup())
  seedGlobal(env)
  const { p } = await prepareUtilPin(env)
  env.failOwnership()
  const c = await env.rpc.commit({ token: p.token.token, confirm: true, scope: "global", sessionID: null })
  const verdict = c.ok === false ? c : c.receipt
  assert.match(String(verdict.outcome ?? verdict.reason), /ownership-lost/)
  assert.equal(env.recipeOf(env.GLOBAL_FILE).includes("prov/new"), false, "the prior file stays intact")
})

// ---------------------------------------------------------------------------
// Multi-entry first creation: create kind per entry, rejected drafts listed
// ---------------------------------------------------------------------------

test("multi-entry first creation commits the create kind; validator-rejected entries are not written and are listed", async (t) => {
  const env = makeEnv()
  t.after(() => env.cleanup())
  const ed = await env.rpc.editOpen({ scope: "workspace", sessionID: null })
  assert.equal(ed.raw ?? null, null, "an absent file snapshots as absent")
  const p = await env.rpc.prepare({
    snapshotId: ed.snapshotId, scope: "workspace", sessionID: null,
    ops: [
      { opId: "ok1", action: "create", kind: "worker", id: "scout", pool: "proj", draft: { mode: "pinned", model: "prov/new", thoughtLevel: "high" } },
      { opId: "bad1", action: "create", kind: "worker", id: "halffoo", pool: "proj", draft: { mode: "pinned", model: "prov/new" } }, // missing thoughtLevel
    ],
  })
  assert.ok(p && p.outcome === "token", `prepare issued a token: ${JSON.stringify(p)}`)
  const previewJson = JSON.stringify(p.preview)
  assert.match(previewJson, /halffoo/, "the rejected entry is listed in the preview/rejected surface")
  const c = await env.rpc.commit({ token: p.token.token, confirm: true, scope: "workspace", sessionID: null })
  assert.equal(c.ok, true, "the commit succeeds with the valid entries")
  const receipt = c.receipt
  assert.equal(receipt.outcome, "written")
  const receiptJson = JSON.stringify(receipt)
  assert.match(receiptJson, /halffoo/, "the rejected entry is listed in the receipt")
  const text = env.recipeOf(env.WS_A)
  assert.match(text, /"pool":\s*"proj"/, "the create-file wrote the declared pool")
  assert.match(text, /prov\/new/, "the valid worker was created")
  assert.equal(/halffoo/.test(text), false, "the rejected draft never touched the file")
  assert.match(text, /"scout"/, "the created entry is present")
})

// ---------------------------------------------------------------------------
// Receipt bytes are REAL UTF-8 byte counts (never string.length)
// ---------------------------------------------------------------------------

test("receipt.bytes counts real UTF-8 bytes — a multi-byte (CJK) edit is not measured by string.length", async (t) => {
  const env = makeEnv()
  t.after(() => env.cleanup())
  seedGlobal(env)
  const ed = await env.rpc.editOpen({ scope: "global", sessionID: null })
  const cjkPrompt = "侦查提示词 αβ — émigré"
  const p = await env.rpc.prepare({
    snapshotId: ed.snapshotId, scope: "global", sessionID: null,
    ops: [{ opId: "o1", action: "update", kind: "worker", id: "util", draft: { mode: "auto", prompt: cjkPrompt } }],
  })
  assert.ok(p && p.outcome === "token", `prepare issued a token: ${JSON.stringify(p)}`)
  const c = await env.rpc.commit({ token: p.token.token, confirm: true, scope: "global", sessionID: null })
  assert.equal(c.ok, true)
  assert.equal(c.receipt.outcome, "written")
  const finalText = env.recipeOf(env.GLOBAL_FILE)
  assert.ok(finalText.includes(cjkPrompt), "the multi-byte prompt round-tripped the write")
  const byteLength = Buffer.byteLength(finalText, "utf8")
  assert.notEqual(byteLength, finalText.length, "the fixture must actually contain multi-byte chars for this test to discriminate")
  assert.equal(c.receipt.bytes, byteLength, "receipt.bytes is the real UTF-8 byte count, not the JS string length")
})

// ---------------------------------------------------------------------------
// no-op short-circuit
// ---------------------------------------------------------------------------

test("an unchanged draft yields a no-op outcome — no token, no write", async (t) => {
  const env = makeEnv()
  t.after(() => env.cleanup())
  seedGlobal(env)
  const ed = await env.rpc.editOpen({ scope: "global", sessionID: null })
  const p = await env.rpc.prepare({ snapshotId: ed.snapshotId, scope: "global", sessionID: null, ops: [{ opId: "o1", action: "update", kind: "worker", id: "util", draft: { mode: "auto" } }] })
  assert.ok(p, "prepare answered")
  assert.notEqual(p.outcome, "token", "a no-op never issues a commit token")
  assert.equal(env.recipeOf(env.GLOBAL_FILE).includes("prov/"), false, "no write")
})

// ---------------------------------------------------------------------------
// Receipt eviction (bounded in-memory store)
// ---------------------------------------------------------------------------

test("receipts are bounded: the oldest receipt is evicted (found:false = UNKNOWN), never served from a persistent store", async (t) => {
  const env = makeEnv({ limits: { receipts: 2 } })
  t.after(() => env.cleanup())
  seedGlobal(env)
  const tokens = []
  for (const model of ["prov/m1", "prov/m2", "prov/m3"]) {
    // Each round must re-prepare against current bytes (never replay).
    const { p } = await prepareUtilPin(env, model, "high")
    assert.ok(p && p.outcome === "token")
    const c = await env.rpc.commit({ token: p.token.token, confirm: true, scope: "global", sessionID: null })
    assert.equal(c.ok, true)
    assert.equal(c.receipt.outcome, "written")
    tokens.push(p.token.token)
    env.advance(1)
  }
  const oldest = await env.rpc.receipt({ token: tokens[0] })
  assert.equal(oldest.found, false, "the evicted receipt is gone — the outcome is UNKNOWN, honestly")
  const newest = await env.rpc.receipt({ token: tokens[2] })
  assert.equal(newest.found, true, "the bounded store keeps recent receipts")
})

test("sweep/size expose the bounded in-memory protocol state", async (t) => {
  const env = makeEnv()
  t.after(() => env.cleanup())
  seedGlobal(env)
  const { p } = await prepareUtilPin(env)
  const c = await env.rpc.commit({ token: p.token.token, confirm: true, scope: "global", sessionID: null })
  assert.equal(c.ok, true)
  if (typeof env.rpc.sweep === "function") {
    env.rpc.sweep() // must not throw over live state
  }
  if (typeof env.rpc.size === "function") {
    const s = env.rpc.size()
    assert.ok(s !== undefined && s !== null, "size is introspectable")
  }
})

// ---------------------------------------------------------------------------
// editOpen found-but-missing contradiction (review round, response-binding
// matrix): the resolver says a WORKSPACE target is found/owned
// (creatable:false) but the snapshot stat finds NO file — the resolver and
// the disk contradict each other. Contract: refuse ok:false
// scope-unresolved, issue NO snapshot handle (never a warn-finding + handle
// that later prepares plan against). Legal counterparts stay legal:
// global missing file (first creation) and workspace missing file with
// creatable:true (explicit creation target). Mock resolver harness —
// protocol state machine tests, NOT E2E.
// ---------------------------------------------------------------------------

test("editOpen: resolver-found workspace (creatable:false) with NO file on disk refuses scope-unresolved and issues NO handle", async () => {
  const env = makeEnv()
  try {
    const missingPath = path.join(env.root, "wsMissing", ".opencode", "forge.json")
    // Inject the contradiction: the resolver CLAIMS ownership (creatable
    // false = an owning pool file) while the disk has nothing at the path.
    env.contradictoryWorkspaceTarget = { path: missingPath, creatable: false }
    const ed = await env.rpc.editOpen({ scope: "workspace", sessionID: null })
    assert.equal(ed.ok, false, `the found-but-missing workspace target must refuse — got: ${JSON.stringify(ed).slice(0, 300)}`)
    assert.equal(ed.reason, "scope-unresolved", `the refusal reason names the unresolved target — got: ${ed.reason}`)
    assert.equal(ed.snapshotId, undefined, "NO snapshot handle may be issued for a contradictory target")
    // The refused open can never ride a later prepare: an unknown handle is
    // refused (belt against any shape drift that leaks a handle).
    if (ed.snapshotId !== undefined) return
    const p = await env.rpc.prepare({
      snapshotId: "never-issued",
      scope: "workspace",
      sessionID: null,
      ops: [],
    })
    assert.equal(p.ok, false, "a prepare against a never-issued handle refuses")
  } finally {
    env.cleanup()
  }
})

test("legal: global missing file (first creation) stays ok — exists:false, creatable:true, anchor null", async () => {
  const env = makeEnv() // GLOBAL_FILE deliberately NOT seeded
  try {
    const ed = await env.rpc.editOpen({ scope: "global", sessionID: null })
    assert.equal(ed.ok, true, `a missing global recipe is a legal first-creation target — got: ${JSON.stringify(ed).slice(0, 300)}`)
    assert.equal(ed.exists, false)
    assert.equal(ed.creatable, true)
    assert.equal(ed.anchor, null, "the global layer carries anchor:null")
    assert.ok(ed.snapshotId, "the handle IS issued for the legal creation target")
  } finally {
    env.cleanup()
  }
})

test("legal: workspace missing file with creatable:true (registered root, explicit creation) stays ok", async () => {
  const env = makeEnv() // WS_A deliberately NOT seeded
  try {
    const ed = await env.rpc.editOpen({ scope: "workspace", sessionID: SESSION_A })
    assert.equal(ed.ok, true, `a missing workspace recipe at a registered root is a legal creation target — got: ${JSON.stringify(ed).slice(0, 300)}`)
    assert.equal(ed.exists, false)
    assert.equal(ed.creatable, true)
    assert.notEqual(ed.anchor, null, "the workspace creation target keeps its anchor")
    assert.ok(ed.snapshotId, "the handle IS issued for the legal creation target")
  } finally {
    env.cleanup()
  }
})
