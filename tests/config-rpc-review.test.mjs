import test from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

// forge-tui-subagent-config — independent-review boundary tests for the
// config RPC protocol (createConfigRpcStore, frozen v1). These tests PIN
// review findings; several are expected RED until the protocol worker's
// fixes land. Existing asserts in config-rpc-protocol.test.mjs are NOT
// relaxed to track defects — failures here are reported as-is.
//
// Coverage:
//   R1  creatable flipped to false after prepare (path/loc/anchor equal)
//       → commit must refuse, zero write (first creation)
//   R2  actual handler outputs validate against the REAL JSON Schemas in
//       rpc.ts (receipt.sync null vs {type:"object"}; preview.rejected
//       extra kind/action fields) — validator: node_modules/json-schema,
//       test-only
//   R3  a bounds-evicted unspent token must never write (in-process the
//       lock body is synchronous, so "queued-then-evicted" is not
//       constructible without product changes; eviction-before-commit is
//       the observable contract)
//   R4  token-unknown must NOT assert "nothing was written" (receipt
//       missing stays UNKNOWN — the server cannot prove a non-write)
//   R5  null-session resolver reporting observedLocation:null must fail
//       closed: no token, no write
//   R6  a no-op batch that also carries rejected ops must DISCLOSE the
//       rejections (outcome no-op must not swallow them)
//   R7  editOpen through a SYMLINK target must refuse and leak no raw
//       bytes (skipped when the platform cannot create symlinks)
//   M   memfs twin (injected ConfigRpcFsSeams): full-identity (same
//       bytes/mtime/size, different ino) refusal with write counters,
//       injected update/creation publish protocol, zero-write proofs

import { createConfigRpcStore } from "../src/config-rpc-protocol.ts"
import { forgeConfigRpcDefinition } from "../rpc.ts"
import { validate as schemaValidate } from "json-schema"

const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex")

// ---------------------------------------------------------------------------
// memfs twin (ConfigRpcFsSeams shapes; stable identity per file state)
// ---------------------------------------------------------------------------

function memFs(initial = {}) {
  const files = new Map()
  let mt = 1000
  let ino = 1
  for (const [p, text] of Object.entries(initial)) files.set(p, { text, mtimeMs: mt++, ino: ino++, dev: 1 })
  const io = { writes: [], renames: [], links: [], unlinks: [] }
  const makeEntry = (text, identity) => ({ text, mtimeMs: identity?.mtimeMs ?? mt++, ino: identity?.ino ?? ino++, dev: 1 })
  return {
    files,
    io,
    stat: (p) => {
      const e = files.get(p)
      return e ? { mtimeMs: e.mtimeMs, size: e.text.length, dev: e.dev, ino: e.ino } : null
    },
    readFile: (p) => {
      const e = files.get(p)
      if (!e) throw new Error(`ENOENT ${p}`)
      return e.text
    },
    writeFile: (p, data) => {
      io.writes.push(p)
      files.set(p, makeEntry(data))
    },
    rename: (a, b) => {
      io.renames.push([a, b])
      const e = files.get(a)
      if (!e) throw new Error(`ENOENT rename ${a}`)
      files.set(b, makeEntry(e.text))
      files.delete(a)
    },
    link: (a, b) => {
      io.links.push([a, b])
      const e = files.get(a)
      if (!e) throw new Error(`ENOENT link ${a}`)
      if (files.has(b)) {
        const err = new Error("EEXIST")
        err.code = "EEXIST"
        throw err
      }
      files.set(b, { text: e.text, mtimeMs: e.mtimeMs, ino: e.ino, dev: e.dev })
    },
    unlink: (p) => {
      io.unlinks.push(p)
      files.delete(p)
    },
    mkdir: () => {},
    // Read-guard seams: ENOENT -> { exists:false }, anything present is a
    // plain regular file (nlink 1); realpath folds to the request verbatim.
    lstat: (p) => {
      const e = files.get(p)
      if (!e) return { exists: false }
      return { exists: true, isSymlink: false, isDirectory: false, isFile: true, nlink: 1, mtimeMs: e.mtimeMs, size: e.text.length }
    },
    realpath: (p) => p,
    text: (p) => files.get(p)?.text,
  }
}

// Store env over memfs with a scripted authoritative resolver.
function memEnv(opts = {}) {
  const state = { now: 1_000_000, creatable: opts.creatable ?? true, location: "C:/locA", reverify: () => true, unresolved: null }
  const mfs = memFs(opts.initial)
  const GLOBAL_FILE = "/global/forge.json"
  let idCounter = 0
  const deps = {
    clock: () => state.now,
    randomId: () => `id-${++idCounter}`,
    hash: sha256,
    epoch: () => ({ epoch: "ep-1", generation: 7 }),
    ttlMs: { snapshot: 5_000, token: 60_000, receipt: 60_000 },
    limits: opts.limits,
    fs: mfs,
    resolver(req) {
      if (state.unresolved) return { ok: false, reason: "scope-unresolved", message: state.unresolved }
      const observed = opts.nullObservedLocation && req.sessionID === null ? null : state.location
      return {
        ok: true,
        target: { path: GLOBAL_FILE, observedLocation: observed, anchor: req.sessionID === null ? null : state.location, creatable: state.creatable },
      }
    },
    reverify: (req) => state.reverify(req),
    beforeCommit: opts.beforeCommit,
    maxContextBytes: opts.maxContextBytes,
  }
  const store = createConfigRpcStore(deps)
  return {
    state,
    mfs,
    GLOBAL_FILE,
    rpc: store.handlers({ pluginID: "forge", appVersion: "2.4.2" }),
    rotateEpoch: (n) => store.rotateEpoch(n),
    getCommitContext: (commitId) => store.getCommitContext(commitId),
    advance: (ms) => { state.now += ms },
  }
}

function seed(mfs, p, text) {
  mfs.files.set(p, { text, mtimeMs: 100, ino: 42, dev: 1 })
}

async function preparePin(env, model = "prov/new", level = "high") {
  const ed = await env.rpc.editOpen({ scope: "global", sessionID: null })
  const p = await env.rpc.prepare({
    snapshotId: ed.snapshotId, scope: "global", sessionID: null,
    ops: [{ opId: "o1", action: "update", kind: "worker", id: "util", draft: { mode: "pinned", model, thoughtLevel: level } }],
  })
  return { ed, p }
}

// ---------------------------------------------------------------------------
// R1 — creatable flipped to false after prepare: first creation must not write
// ---------------------------------------------------------------------------

test("R1: creatable true at prepare then false at commit — the creation must refuse with zero writes", async (t) => {
  const env = memEnv({ creatable: true }) // absent target
  const ed = await env.rpc.editOpen({ scope: "global", sessionID: null })
  assert.equal(ed.exists, false, "fixture: the target starts absent")
  const p = await env.rpc.prepare({
    snapshotId: ed.snapshotId, scope: "global", sessionID: null,
    ops: [{ opId: "o1", action: "create", kind: "worker", id: "scout", draft: { mode: "auto" } }],
  })
  assert.ok(p && p.outcome === "token", "prepare legitimately issues a token while creation is anchored")
  env.state.creatable = false // the authoritative anchor is withdrawn; path/loc/anchor unchanged
  const c = await env.rpc.commit({ token: p.token.token, confirm: true, scope: "global", sessionID: null })
  const verdict = c.ok === false ? c : c.receipt
  assert.notEqual(verdict.outcome ?? verdict.reason, "written", "an unanchored creation must never commit")
  assert.equal(env.mfs.files.has(env.GLOBAL_FILE), false, "zero writes — the file must still be absent")
})

// ---------------------------------------------------------------------------
// R2 — actual outputs vs the REAL schemas
// ---------------------------------------------------------------------------

function expectSchemaValid(instance, schema, label) {
  const v = schemaValidate(instance, schema)
  assert.ok(v.valid, `${label} must validate against the rpc.ts output schema — errors: ${JSON.stringify(v.errors?.slice(0, 6))}`)
}

function expectSchemaInvalid(instance, schema, label) {
  const v = schemaValidate(instance, schema)
  assert.equal(v.valid, false, `${label} was expected to FAIL schema validation (review finding) but validated`)
}

test("R2a: a real commit receipt validates against the commit output schema (sync slot nullability)", async (t) => {
  const env = memEnv({ initial: { "/global/forge.json": '{ "agents": { "util": {} } }' } })
  const { p } = await preparePin(env)
  const c = await env.rpc.commit({ token: p.token.token, confirm: true, scope: "global", sessionID: null })
  assert.equal(c.ok, true)
  expectSchemaValid(c, forgeConfigRpcDefinition.methods.commit.output, "commit ok receipt")
})

test("R2b: a mixed prepare preview (valid + renameTo-rejected) validates against the prepare output schema", async (t) => {
  const env = memEnv({ initial: { "/global/forge.json": '{ "agents": { "util": {} } }' } })
  const ed = await env.rpc.editOpen({ scope: "global", sessionID: null })
  const p = await env.rpc.prepare({
    snapshotId: ed.snapshotId, scope: "global", sessionID: null,
    ops: [
      { opId: "ok", action: "update", kind: "worker", id: "util", draft: { mode: "pinned", model: "prov/new", thoughtLevel: "high" } },
      { opId: "bad", action: "update", kind: "worker", id: "util", renameTo: "other", draft: { mode: "auto" } },
    ],
  })
  assert.ok(p && p.outcome === "token", "the valid sibling still gets a token")
  expectSchemaValid(p, forgeConfigRpcDefinition.methods.prepare.output, "prepare token output with rejected entries")
})

test("R2c: positive control — a plain token output and a no-op output validate against the schemas", async (t) => {
  const env = memEnv({ initial: { "/global/forge.json": '{ "agents": { "util": {} } }' } })
  const { p } = await preparePin(env)
  expectSchemaValid(p, forgeConfigRpcDefinition.methods.prepare.output, "plain prepare token output")
  const ed2 = await env.rpc.editOpen({ scope: "global", sessionID: null })
  const noop = await env.rpc.prepare({
    snapshotId: ed2.snapshotId, scope: "global", sessionID: null,
    ops: [{ opId: "o1", action: "update", kind: "worker", id: "util", draft: { mode: "auto" } }],
  })
  expectSchemaValid(noop, forgeConfigRpcDefinition.methods.prepare.output, "no-op output")
  const forged = await env.rpc.commit({ token: "nope", confirm: true, scope: "global", sessionID: null })
  expectSchemaValid(forged, forgeConfigRpcDefinition.methods.commit.output, "commit reject output")
})

// ---------------------------------------------------------------------------
// R3 — a bounds-evicted unspent token must never write
// ---------------------------------------------------------------------------

test("R3: the token evicted by bounds before its commit is refused (token-unknown) and never writes", async (t) => {
  const env = memEnv({ initial: { "/global/forge.json": '{ "agents": { "util": {} } }' }, limits: { tokens: 1 } })
  const { p: p1 } = await preparePin(env, "prov/m1", "low")
  const { p: p2 } = await preparePin(env, "prov/m2", "high") // evicts p1's token (limit 1)
  const cEvicted = await env.rpc.commit({ token: p1.token.token, confirm: true, scope: "global", sessionID: null })
  assert.equal(cEvicted.ok, false, "the evicted token is unknown — fail closed")
  assert.equal(cEvicted.reason, "token-unknown")
  const before = env.mfs.text(env.GLOBAL_FILE)
  const cSurvivor = await env.rpc.commit({ token: p2.token.token, confirm: true, scope: "global", sessionID: null })
  assert.equal(cSurvivor.ok, true)
  assert.equal(cSurvivor.receipt.outcome, "written")
  assert.notEqual(env.mfs.text(env.GLOBAL_FILE), before)
  void p1
})

// ---------------------------------------------------------------------------
// R3b — the REAL queued-then-evicted race: a commit queued behind a held
// per-target lock, its token bounds-evicted while queued, lock released.
// The released commit must refuse (unknown) and never write.
// Reproduction of the reviewer finding via a deferred-held withCommitLock
// (the store's commit serializes on the SAME lock surface).
// ---------------------------------------------------------------------------

test("R3b: queued behind the lock, evicted while queued, released — the commit refuses and never writes", async (t) => {
  const { withCommitLock } = await import("../src/forge-config-edit.ts")
  const env = memEnv({ initial: { "/global/forge.json": '{ "agents": { "util": {} } }' }, limits: { tokens: 1 } })
  // Occupy the per-target lock with a deferred.
  let release
  const gate = withCommitLock(env.GLOBAL_FILE, () => new Promise((resolve) => { release = resolve }))
  await new Promise((r) => setTimeout(r, 20)) // the gate now holds the lock
  const { p } = await preparePin(env, "prov/queued", "high")
  const queued = env.rpc.commit({ token: p.token.token, confirm: true, scope: "global", sessionID: null })
  await new Promise((r) => setTimeout(r, 20)) // the commit is now queued behind the gate
  // Evict the queued token while it waits (limit 1): a fresh prepare takes the slot.
  const { p: p2 } = await preparePin(env, "prov/newcomer", "low")
  assert.notEqual(p2.token.token, p.token.token, "the fresh prepare holds a different token (the queued one was bounds-evicted)")
  release()
  await gate
  const c = await queued
  assert.equal(c.ok, false, "the released commit must discover its token is gone")
  assert.equal(c.reason, "token-unknown")
  assert.equal(env.mfs.io.renames.length, 0, "zero writes from the evicted commit")
  assert.equal(env.mfs.io.links.length, 0, "zero links from the evicted commit")
  assert.equal(env.mfs.text(env.GLOBAL_FILE).includes("prov/queued"), false, "the queued text never landed")
  // The newcomer token still commits normally afterwards.
  const c2 = await env.rpc.commit({ token: p2.token.token, confirm: true, scope: "global", sessionID: null })
  assert.equal(c2.ok, true)
  assert.equal(c2.receipt.outcome, "written")
})

// ---------------------------------------------------------------------------
// R4 — token-unknown must not assert "nothing was written"
// ---------------------------------------------------------------------------

test("R4: token-unknown response carries no zero-write claim; a missing receipt stays UNKNOWN", async (t) => {
  const env = memEnv({ initial: { "/global/forge.json": '{ "agents": { "util": {} } }' } })
  const c = await env.rpc.commit({ token: "never-issued", confirm: true, scope: "global", sessionID: null })
  assert.equal(c.ok, false)
  assert.equal(c.reason, "token-unknown")
  assert.ok(!/nothing was written|nothing written|not been written|zero writes/i.test(c.message ?? ""), `an unknown token must not claim a proven non-write — message: ${c.message}`)
  const r = await env.rpc.receipt({ token: "never-issued" })
  assert.equal(r.found, false, "UNKNOWN — never 'not written'")
  assert.ok(!/written/i.test(JSON.stringify(r)), "the UNKNOWN answer asserts nothing about writtenness")
})

// ---------------------------------------------------------------------------
// R5 — null-session resolver reporting observedLocation:null fails closed
// ---------------------------------------------------------------------------

test("R5: null sessionID with observedLocation:null must fail closed — no token, no write", async (t) => {
  const env = memEnv({ initial: {}, nullObservedLocation: true, creatable: true })
  const ed = await env.rpc.editOpen({ scope: "global", sessionID: null })
  const p = await env.rpc.prepare({
    snapshotId: ed.snapshotId, scope: "global", sessionID: null,
    ops: [{ opId: "o1", action: "create", kind: "worker", id: "scout", draft: { mode: "auto" } }],
  })
  const noToken = p.ok === false || p.outcome !== "token"
  assert.ok(noToken, `an unlocatable null-session target must not yield a preview token — got: ${JSON.stringify(p).slice(0, 200)}`)
  assert.equal(env.mfs.files.has(env.GLOBAL_FILE), false, "zero writes")
  if (p.ok === false) return
  const c = await env.rpc.commit({ token: p.token.token, confirm: true, scope: "global", sessionID: null })
  const verdict = c.ok === false ? c : c.receipt
  assert.notEqual(verdict.outcome ?? verdict.reason, "written", "no write may follow from a null-observed-location binding")
  assert.equal(env.mfs.files.has(env.GLOBAL_FILE), false)
})

// ---------------------------------------------------------------------------
// R6 — a no-op verdict must not swallow rejected ops
// ---------------------------------------------------------------------------

test("R6: no-op outcome with a rejected sibling discloses the rejection", async (t) => {
  const env = memEnv({ initial: { "/global/forge.json": '{ "agents": { "util": { "prompt": "same" } } }' } })
  const ed = await env.rpc.editOpen({ scope: "global", sessionID: null })
  const p = await env.rpc.prepare({
    snapshotId: ed.snapshotId, scope: "global", sessionID: null,
    ops: [
      { opId: "noop", action: "update", kind: "worker", id: "util", draft: { mode: "auto", prompt: "same" } },
      { opId: "renamed", action: "update", kind: "worker", id: "util", renameTo: "other", draft: { mode: "auto" } },
    ],
  })
  assert.ok(p && p.outcome === "no-op", "the batch is a no-op overall")
  const disclosed = JSON.stringify(p)
  assert.ok(disclosed.includes("renamed"), `the rejected op must be disclosed in the no-op response — response: ${disclosed.slice(0, 300)}`)
})

// ---------------------------------------------------------------------------
// R7 — symlinked target: refuse, leak nothing (platform-gated)
// ---------------------------------------------------------------------------

test("R7: editOpen on a symlinked recipe path refuses and leaks no raw bytes", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "forge-rpc-symlink-"))
  try {
    const realFile = path.join(root, "real-forge.json")
    const linkPath = path.join(root, "forge.json")
    fs.writeFileSync(realFile, '{ "agents": { "util": { "prompt": "SECRET-BYTES" } } }', "utf8")
    try {
      fs.symlinkSync(realFile, linkPath, "file")
    } catch {
      t.skip("this platform cannot create file symlinks (unprivileged Windows) — leg runs where links exist")
      return
    }
    let idCounter = 0
    const deps = {
      clock: () => 1_000_000,
      randomId: () => `id-${++idCounter}`,
      hash: sha256,
      epoch: () => ({ epoch: "ep-1", generation: 7 }),
      resolver: () => ({ ok: true, target: { path: linkPath, observedLocation: root, anchor: root, creatable: false } }),
    }
    const store = createConfigRpcStore(deps)
    const rpc = store.handlers({ pluginID: "forge", appVersion: "2.4.2" })
    const ed = await rpc.editOpen({ scope: "global", sessionID: null })
    const leak = JSON.stringify(ed)
    const refused = ed.ok === false || ed.raw === null || ed.readable === false
    if (refused) {
      assert.ok(!leak.includes("SECRET-BYTES"), "a refused open leaks no target bytes")
      assert.match(leak, /symlink|link|unsafe|refus|not/i, "the refusal names the unsafe target")
    } else {
      assert.fail(`a symlinked recipe path must refuse editOpen (no raw passthrough) — output: ${leak.slice(0, 300)}`)
    }
  } finally {
    try { fs.rmSync(root, { recursive: true, force: true }) } catch {}
  }
})

// ---------------------------------------------------------------------------
// M — memfs twin: full identity + injected publish protocol + zero-write proof
// ---------------------------------------------------------------------------

test("M1: memfs full-identity twin — same bytes/mtime/size, DIFFERENT ino refuses; write counters prove zero target writes", async (t) => {
  const env = memEnv({ initial: { "/global/forge.json": '{ "agents": { "util": {} } }' } })
  const { p } = await preparePin(env)
  assert.ok(p && p.outcome === "token")
  // Swap the file state: same bytes, same mtimeMs, new ino.
  const before = env.mfs.files.get(env.GLOBAL_FILE)
  env.mfs.files.set(env.GLOBAL_FILE, { text: before.text, mtimeMs: before.mtimeMs, ino: before.ino + 1000, dev: 1 })
  const c = await env.rpc.commit({ token: p.token.token, confirm: true, scope: "global", sessionID: null })
  const verdict = c.ok === false ? c : c.receipt
  assert.notEqual(verdict.outcome ?? verdict.reason, "written", "an inode swap at equal bytes/mtime/size must refuse")
  assert.match(String(verdict.outcome ?? verdict.reason), /conflict/)
  assert.equal(env.mfs.io.renames.length, 0, "zero renames — the publish never ran")
  assert.equal(env.mfs.io.links.length, 0, "zero links")
  assert.equal(env.mfs.text(env.GLOBAL_FILE), before.text, "the competing bytes stay intact")
})

test("M2: injected update publishes through temp+rename only; a creation publishes through the exclusive link", async (t) => {
  const env = memEnv({ initial: { "/global/forge.json": '{ "agents": { "util": {} } }' } })
  const { p } = await preparePin(env)
  const c = await env.rpc.commit({ token: p.token.token, confirm: true, scope: "global", sessionID: null })
  assert.equal(c.ok, true)
  assert.equal(c.receipt.outcome, "written")
  assert.ok(env.mfs.io.renames.length >= 1, "the injected update went through the rename publisher")
  assert.match(env.mfs.text(env.GLOBAL_FILE), /prov\/new/)
  assert.ok(env.mfs.io.writes.every((w) => w !== env.GLOBAL_FILE), "writeFile never receives the destination path")
  // Creation twin.
  const env2 = memEnv({ creatable: true }) // absent target
  const ed = await env2.rpc.editOpen({ scope: "global", sessionID: null })
  const p2 = await env2.rpc.prepare({
    snapshotId: ed.snapshotId, scope: "global", sessionID: null,
    ops: [{ opId: "o1", action: "create", kind: "worker", id: "scout", draft: { mode: "auto" } }],
  })
  assert.ok(p2 && p2.outcome === "token")
  const c2 = await env2.rpc.commit({ token: p2.token.token, confirm: true, scope: "global", sessionID: null })
  assert.equal(c2.ok, true)
  assert.equal(c2.receipt.outcome, "written")
  assert.ok(env2.mfs.io.links.length >= 1, "the creation published through the exclusive link seam")
  assert.equal(env2.mfs.text(env2.GLOBAL_FILE).includes("scout"), true)
})

test("M3: zero-write proof via counters — external edit after editOpen leaves the injected fs untouched", async (t) => {
  const env = memEnv({ initial: { "/global/forge.json": '{ "agents": { "util": {} } }' } })
  const ed = await env.rpc.editOpen({ scope: "global", sessionID: null })
  env.mfs.files.set(env.GLOBAL_FILE, { text: '{ "agents": { "util": { "prompt": "EXTERNAL" } } }', mtimeMs: 999, ino: 7, dev: 1 })
  const p = await env.rpc.prepare({
    snapshotId: ed.snapshotId, scope: "global", sessionID: null,
    ops: [{ opId: "o1", action: "update", kind: "worker", id: "util", draft: { mode: "pinned", model: "prov/new", thoughtLevel: "high" } }],
  })
  if (p && p.outcome === "token") {
    const c = await env.rpc.commit({ token: p.token.token, confirm: true, scope: "global", sessionID: null })
    const verdict = c.ok === false ? c : c.receipt
    assert.notEqual(verdict.outcome ?? verdict.reason, "written")
  }
  assert.equal(env.mfs.io.writes.length, 0, "zero writeFile calls anywhere in the flow")
  assert.equal(env.mfs.io.renames.length, 0, "zero renames")
  assert.equal(env.mfs.io.links.length, 0, "zero links")
  assert.equal(env.mfs.text(env.GLOBAL_FILE), '{ "agents": { "util": { "prompt": "EXTERNAL" } } }', "the external edit survives byte-for-byte")
})

// ---------------------------------------------------------------------------
// Round-2 review — REAL fs regressions (Windows guard + receipt honesty +
// creation safe-path refusals). These run against node:fs in a tempdir,
// never memfs-only.
// ---------------------------------------------------------------------------

import { lstatSync, mkdtempSync, mkdirSync, realpathSync, symlinkSync, writeFileSync, existsSync, readFileSync } from "node:fs"

function realEnv(opts = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "forge-rpc-review2-"))
  const GLOBAL_FILE = path.join(root, "global", "forge.json")
  const state = { now: 1_000_000, creatable: opts.creatable ?? true, location: root, reverify: () => true, unresolved: null, epoch: { epoch: "ep-1", generation: 7 } }
  let idCounter = 0
  const deps = {
    clock: () => state.now,
    randomId: () => `id-${++idCounter}`,
    hash: sha256,
    epoch: () => ({ ...state.epoch }),
    ttlMs: { snapshot: 5_000, token: 60_000, receipt: 600_000 },
    limits: opts.limits,
    resolver(req) {
      if (state.unresolved) return { ok: false, reason: "scope-unresolved", message: state.unresolved }
      return { ok: true, target: { path: GLOBAL_FILE, observedLocation: state.location, anchor: null, creatable: state.creatable } }
    },
    reverify: (req) => state.reverify(req),
  }
  const store = createConfigRpcStore(deps)
  return {
    root,
    state,
    GLOBAL_FILE,
    rpc: store.handlers({ pluginID: "forge", appVersion: "2.4.2" }),
    cleanup: () => { try { fs.rmSync(root, { recursive: true, force: true }) } catch {} },
  }
}

test("N1 real-fs regression (Windows): an EXISTING normal recipe edits end to end — editOpen ok, prepare token, commit written receipt", async (t) => {
  const env = realEnv()
  t.after(() => env.cleanup())
  fs.mkdirSync(path.dirname(env.GLOBAL_FILE), { recursive: true })
  fs.writeFileSync(env.GLOBAL_FILE, '{\n  "agents": {\n    "util": { "prompt": "old" }\n  }\n}\n', "utf8")
  const ed = await env.rpc.editOpen({ scope: "global", sessionID: null })
  assert.equal(ed.ok, true, `editOpen on a normal existing recipe must succeed — got: ${JSON.stringify(ed).slice(0, 300)}`)
  assert.equal(ed.raw.includes("old"), true, "the raw bytes came back")
  const p = await env.rpc.prepare({
    snapshotId: ed.snapshotId, scope: "global", sessionID: null,
    ops: [{ opId: "o1", action: "update", kind: "worker", id: "util", draft: { mode: "pinned", model: "prov/new", thoughtLevel: "high" } }],
  })
  assert.ok(p && p.outcome === "token", `prepare must succeed on a normal recipe — got: ${JSON.stringify(p).slice(0, 300)}`)
  const c = await env.rpc.commit({ token: p.token.token, confirm: true, scope: "global", sessionID: null })
  assert.equal(c.ok, true, `commit must succeed on a normal recipe — got: ${JSON.stringify(c).slice(0, 300)}`)
  assert.equal(c.receipt.outcome, "written")
  assert.ok(c.receipt.bytes > 0)
  assert.match(readFileSync(env.GLOBAL_FILE, "utf8"), /prov\/new/)
})

test("N2 a spent WRITTEN token re-presented after TTL must not negate the receipt's written state", async (t) => {
  const env = realEnv()
  t.after(() => env.cleanup())
  fs.mkdirSync(path.dirname(env.GLOBAL_FILE), { recursive: true })
  fs.writeFileSync(env.GLOBAL_FILE, '{ "agents": { "util": {} } }', "utf8")
  const ed = await env.rpc.editOpen({ scope: "global", sessionID: null })
  const p = await env.rpc.prepare({
    snapshotId: ed.snapshotId, scope: "global", sessionID: null,
    ops: [{ opId: "o1", action: "update", kind: "worker", id: "util", draft: { mode: "pinned", model: "prov/new", thoughtLevel: "high" } }],
  })
  const c1 = await env.rpc.commit({ token: p.token.token, confirm: true, scope: "global", sessionID: null })
  assert.equal(c1.ok, true)
  assert.equal(c1.receipt.outcome, "written")
  env.state.now += 60_001 // past the token TTL (receipt TTL still live)
  const c2 = await env.rpc.commit({ token: p.token.token, confirm: true, scope: "global", sessionID: null })
  assert.equal(c2.ok, false)
  const text = JSON.stringify(c2)
  assert.ok(!/nothing was written|nothing written/i.test(text), `the refusal must not claim a proven non-write against a WRITTEN receipt — response: ${text}`)
  const r = await env.rpc.receipt({ token: p.token.token })
  assert.equal(r.found, true, "the same-epoch receipt still answers")
  assert.equal(r.receipt.outcome, "written", "the written state is NOT negated by the later expiry refusal")
})

test("N4 creation safe-path guards refuse on the REAL fs: file-as-ancestor, junction ancestor, broken junction", async (t) => {
  const env = realEnv({ creatable: true })
  t.after(() => env.cleanup())
  // (a) an ancestor component is a FILE.
  const fileAsDir = path.join(env.root, "afile")
  writeFileSync(fileAsDir, "x", "utf8")
  const target1 = path.join(env.root, "afile", "sub", "forge.json")
  {
    let idCounter = 100
    const depsResolver = () => ({ ok: true, target: { path: target1, observedLocation: env.root, anchor: null, creatable: true } })
    const s = createConfigRpcStore({ clock: () => 1_000_000, randomId: () => `id-${++idCounter}`, hash: sha256, epoch: () => ({ epoch: "ep-1", generation: 7 }), resolver: depsResolver })
    const rpc = s.handlers({ pluginID: "forge", appVersion: "2.4.2" })
    const ed = await rpc.editOpen({ scope: "global", sessionID: null })
    const verdict = JSON.stringify(ed)
    assert.match(verdict, /not a directory|unsafe|unresolved|refus/i, `a file-as-ancestor target must refuse — got: ${verdict.slice(0, 300)}`)
  }
  // (b) a junction ancestor pointing at a REAL directory.
  const realDir = path.join(env.root, "realdir")
  fs.mkdirSync(realDir, { recursive: true })
  const junction = path.join(env.root, "linkdir")
  let junctionOk = true
  try {
    symlinkSync(realDir, junction, "junction")
  } catch {
    junctionOk = false
  }
  if (junctionOk) {
    const target2 = path.join(junction, "forge.json")
    let idCounter = 200
    const s = createConfigRpcStore({ clock: () => 1_000_000, randomId: () => `id-${++idCounter}`, hash: sha256, epoch: () => ({ epoch: "ep-1", generation: 7 }), resolver: () => ({ ok: true, target: { path: target2, observedLocation: env.root, anchor: null, creatable: true } }) })
    const rpc = s.handlers({ pluginID: "forge", appVersion: "2.4.2" })
    const ed = await rpc.editOpen({ scope: "global", sessionID: null })
    const verdict = JSON.stringify(ed)
    assert.match(verdict, /symlink|unsafe|unresolved|refus/i, `a junction-ancestor target must refuse — got: ${verdict.slice(0, 300)}`)
    assert.ok(!verdict.includes('"raw":"{'), "no bytes leak through the junction")
    // (c) a BROKEN junction — realpath fails; the refusal must not become a pass.
    const broken = path.join(env.root, "brokenlink")
    symlinkSync(path.join(env.root, "does-not-exist"), broken, "junction")
    const target3 = path.join(broken, "forge.json")
    let idCounter3 = 300
    const s3 = createConfigRpcStore({ clock: () => 1_000_000, randomId: () => `id-${++idCounter3}`, hash: sha256, epoch: () => ({ epoch: "ep-1", generation: 7 }), resolver: () => ({ ok: true, target: { path: target3, observedLocation: env.root, anchor: null, creatable: true } }) })
    const rpc3 = s3.handlers({ pluginID: "forge", appVersion: "2.4.2" })
    const ed3 = await rpc3.editOpen({ scope: "global", sessionID: null })
    const verdict3 = JSON.stringify(ed3)
    assert.match(verdict3, /unsafe|symlink|unresolved|refus|error/i, `a broken-junction target must refuse — got: ${verdict3.slice(0, 300)}`)
    assert.equal(existsSync(target3), false, "nothing was created through the broken junction")
  } else {
    t.skip("junction creation unavailable on this platform/host")
  }
  // No creation ever landed under the real directory either.
  assert.equal(existsSync(path.join(realDir, "forge.json")), false)
})

// ---------------------------------------------------------------------------
// H — beforeCommit capture hook + getCommitContext (additive interface)
// ---------------------------------------------------------------------------

test("H1: beforeCommit reads the PRE-WRITE bytes; getCommitContext returns the captured baseline for a written receipt", async (t) => {
  let captured = null
  const env = memEnv({
    initial: { "/global/forge.json": '{ "agents": { "util": {} } }' },
    beforeCommit: (req) => {
      captured = {
        preBytes: env.mfs.readFile(req.path),
        newTextLen: req.newText.length,
        binding: req.binding,
        scope: req.scope,
        sessionID: req.sessionID,
      }
      return { baseline: captured.preBytes, host: "captured" }
    },
  })
  const { p } = await preparePin(env)
  const c = await env.rpc.commit({ token: p.token.token, confirm: true, scope: "global", sessionID: null })
  assert.equal(c.ok, true)
  assert.equal(c.receipt.outcome, "written")
  assert.ok(captured, "the hook ran inside the lock, before the publish")
  assert.ok(captured.preBytes.includes('"util"'), "the hook saw the PRE-WRITE disk bytes")
  assert.equal(captured.binding.path, env.GLOBAL_FILE)
  assert.ok(captured.binding.targetIdentity, "the server-issued target identity rides the binding")
  assert.equal(captured.newTextLen, c.receipt.bytes)
  const lookup = env.getCommitContext(c.receipt.commitId)
  assert.equal(lookup.found, true)
  assert.equal(lookup.commitId, c.receipt.commitId)
  assert.equal(lookup.token, c.receipt.token)
  assert.deepEqual(lookup.context, { baseline: captured.preBytes, host: "captured" })
  assert.equal(lookup.epoch, "ep-1")
})

test("H2: a throwing beforeCommit fails the commit closed — write-failed receipt, token spent, ZERO publish, no usable context", async (t) => {
  const env = memEnv({
    initial: { "/global/forge.json": '{ "agents": { "util": {} } }' },
    beforeCommit: () => { throw new Error("host capture exploded") },
  })
  const { p } = await preparePin(env)
  const c = await env.rpc.commit({ token: p.token.token, confirm: true, scope: "global", sessionID: null })
  assert.equal(c.ok, true)
  assert.equal(c.receipt.outcome, "write-failed")
  assert.match(c.receipt.message, /host capture exploded/)
  assert.equal(env.mfs.io.renames.length, 0, "zero renames — nothing was published")
  assert.equal(env.mfs.io.links.length, 0, "zero links")
  assert.equal(env.mfs.text(env.GLOBAL_FILE).includes("prov/new"), false, "the file is untouched")
  const c2 = await env.rpc.commit({ token: p.token.token, confirm: true, scope: "global", sessionID: null })
  assert.equal(c2.ok, false)
  assert.equal(c2.reason, "token-spent", "the attempt reached the write stage — the token is consumed")
  assert.equal(env.getCommitContext(c.receipt.commitId).found, false, "a failed capture never provides a usable context")
})

test("H3: an oversized context fails the commit closed (bounded maxContextBytes, zero publish)", async (t) => {
  const env = memEnv({
    initial: { "/global/forge.json": '{ "agents": { "util": {} } }' },
    maxContextBytes: 50,
    beforeCommit: () => ({ blob: "x".repeat(500) }),
  })
  const { p } = await preparePin(env)
  const c = await env.rpc.commit({ token: p.token.token, confirm: true, scope: "global", sessionID: null })
  assert.equal(c.ok, true)
  assert.equal(c.receipt.outcome, "write-failed")
  assert.match(c.receipt.message, /bounded context size/)
  assert.equal(env.mfs.io.renames.length, 0)
  assert.equal(env.mfs.text(env.GLOBAL_FILE).includes("prov/new"), false)
})

test("H4: a non-object beforeCommit return (null / array / scalar) fails the commit closed", async (t) => {
  for (const bad of [null, [1, 2], "text", 42]) {
    const env = memEnv({
      initial: { "/global/forge.json": '{ "agents": { "util": {} } }' },
      beforeCommit: () => bad,
    })
    const { p } = await preparePin(env)
    const c = await env.rpc.commit({ token: p.token.token, confirm: true, scope: "global", sessionID: null })
    assert.equal(c.ok, true)
    assert.equal(c.receipt.outcome, "write-failed", `return ${JSON.stringify(bad)} must fail closed`)
    assert.equal(env.mfs.io.renames.length, 0)
  }
})

test("H5: the context shares the receipt's fate — epoch rotation, TTL expiry and bounds eviction all refuse it", async (t) => {
  const env = memEnv({
    initial: { "/global/forge.json": '{ "agents": { "util": {} } }' },
    beforeCommit: () => ({ baseline: "b" }),
  })
  const { p } = await preparePin(env)
  const c = await env.rpc.commit({ token: p.token.token, confirm: true, scope: "global", sessionID: null })
  assert.equal(c.receipt.outcome, "written")
  assert.equal(env.getCommitContext(c.receipt.commitId).found, true)
  env.rotateEpoch({ epoch: "ep-2", generation: 8 })
  assert.equal(env.getCommitContext(c.receipt.commitId).found, false, "epoch-stale contexts are refused — never reconstructed after the write")
  const { p: p2 } = await preparePin(env, "prov/m2", "high")
  const c2 = await env.rpc.commit({ token: p2.token.token, confirm: true, scope: "global", sessionID: null })
  assert.equal(c2.receipt.outcome, "written")
  env.advance(600_001) // past the receipt TTL
  assert.equal(env.getCommitContext(c2.receipt.commitId).found, false, "an expired context is gone — dependent syncs must refuse")
  const env2 = memEnv({
    initial: { "/global/forge.json": '{ "agents": { "util": {} } }' },
    limits: { receipts: 1 },
    beforeCommit: () => ({ baseline: "b" }),
  })
  const r1 = await preparePin(env2, "prov/m1", "low")
  const cA = await env2.rpc.commit({ token: r1.p.token.token, confirm: true, scope: "global", sessionID: null })
  assert.equal(cA.receipt.outcome, "written")
  const r2 = await preparePin(env2, "prov/m2", "high")
  const cB = await env2.rpc.commit({ token: r2.p.token.token, confirm: true, scope: "global", sessionID: null })
  assert.equal(cB.receipt.outcome, "written")
  assert.equal(env2.getCommitContext(cA.receipt.commitId).found, false, "the evicted context is honestly gone")
  assert.equal(env2.getCommitContext(cB.receipt.commitId).found, true, "the surviving context still answers")
})

test("H6: refusal receipts never expose a context (conflict / publish-failure) — dependent syncs must refuse", async (t) => {
  const env = memEnv({
    initial: { "/global/forge.json": '{ "agents": { "util": {} } }' },
    beforeCommit: () => ({ baseline: "b" }),
  })
  const { p } = await preparePin(env)
  env.mfs.files.set(env.GLOBAL_FILE, { text: '{ "agents": { "util": { "prompt": "EXTERNAL" } } }', mtimeMs: 999, ino: 7, dev: 1 })
  const c = await env.rpc.commit({ token: p.token.token, confirm: true, scope: "global", sessionID: null })
  assert.equal(c.ok, true)
  assert.equal(c.receipt.outcome, "conflict")
  assert.equal(env.getCommitContext(c.receipt.commitId).found, false, "a conflict receipt never carries a usable baseline")
  // Publish-failure path: the kernel write itself fails after a good capture.
  const env2 = memEnv({
    initial: { "/global/forge.json": '{ "agents": { "util": {} } }' },
    beforeCommit: () => ({ baseline: "b" }),
  })
  const { p: p2 } = await preparePin(env2)
  env2.mfs.rename = () => { throw new Error("rename exploded") }
  const c2 = await env2.rpc.commit({ token: p2.token.token, confirm: true, scope: "global", sessionID: null })
  assert.equal(c2.ok, true)
  assert.equal(c2.receipt.outcome, "write-failed")
  assert.equal(env2.getCommitContext(c2.receipt.commitId).found, false, "a failed publish provides no usable context — re-prepare instead")
})
