import test from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

// forge-tui-subagent-config — file identity precision RED tests.
//
// User 0.36.2 report: opencode v2.4.2 host rejects editOpen output with
// `rpc.invalid_output` "Expected an integer at identity.ino".
//
// Provenance (review of official anomalyco/opencode v2.4.2):
//   core/src/rpc139-140,215-228 validates registered method output via
//   effect 4.1.0 SchemaRepresentation.fromJsonSchemaDocument; JSON Schema
//   `{"type":"integer"}` → Schema.isInt; effect Schema.ts:7971-7975 checks
//   `Number.isSafeInteger` with issue message "expected an integer". These
//   tests call the REAL product code (snapshotRecipe / createConfigRpcStore)
//   over a REAL tempdir fs and hold it to lossless identity — no Effect
//   validator is executed here, and no in-test reimplementation of the
//   target conversion is tested against itself.
//
// Real probe (workspace .opencode/forge.json, metadata only): BigInt ino
// 27303072743618940 > 2^53; captured on this machine a fresh tempdir ino
// 56857945298643758 (BigInt) that default statSync reports as 56857945298643760
// — the value is rounded BEFORE the wire. The product contract under the
// fix design: dev/ino leave stat as exact decimal strings (BigInt-derived),
// unsafe numbers are refused explicitly (never faked as missing), and two
// adjacent IDs must never compare equal.

import { snapshotRecipe } from "../src/forge-config-edit.ts"
import { createConfigRpcStore } from "../src/config-rpc-protocol.ts"

const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex")

// The public output contract is a decimal STRING for dev/ino (BigInt does
// not survive JSON.stringify). Strict: typeof 'string' AND exactly the
// BigInt truth — a safe small Number or a BigInt on the wire both FAIL.
function assertExactStringIno(actual, truth, label) {
  assert.equal(typeof actual, "string", `${label}: ino must be a decimal string on the wire, got typeof ${typeof actual}`)
  assert.match(actual, /^\d+$/, `${label}: ino must be a plain decimal string`)
  assert.equal(actual, truth.toString(), `${label}: ino ${actual} is not exactly the BigInt truth ${truth}`)
}

// --- 1. RED: snapshotRecipe (real default stat seam) loses the ino --------

test("RED: snapshotRecipe's default stat seam must carry the ino EXACTLY as the BigInt ground truth — today it ships a rounded unsafe Number", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-ino-red-"))
  const file = path.join(dir, "forge.json")
  fs.writeFileSync(file, '{\n  "agents": {}\n}\n')
  try {
    const truth = fs.statSync(file, { bigint: true }).ino
    const snap = snapshotRecipe({ path: file })
    assert.equal(snap.exists, true)
    assert.equal(snap.stat.ino !== undefined, true, "ino must never be dropped to fake freshness")
    assertExactStringIno(snap.stat.ino, truth, "snapshotRecipe")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// --- 2. RED: real store chain editOpen→prepare→commit→receipt --------------

test("RED: the full store chain must preserve the ino losslessly into the commit receipt — today the rounded Number flows through", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "forge-ino-chain-"))
  const GLOBAL_FILE = path.join(root, "global", "forge.json")
  fs.mkdirSync(path.dirname(GLOBAL_FILE), { recursive: true })
  fs.writeFileSync(GLOBAL_FILE, '{\n  "agents": {\n    "util": { "prompt": "old prompt" }\n  }\n}\n')
  let idCounter = 0
  let now = 1_000_000
  const deps = {
    clock: () => now,
    randomId: () => `id-${++idCounter}`,
    hash: sha256,
    epoch: () => ({ epoch: "ep-1", generation: 7 }),
    resolver(req) {
      return { ok: true, target: { path: GLOBAL_FILE, observedLocation: root, anchor: null, creatable: true } }
    },
    reverify: () => true,
  }
  const store = createConfigRpcStore(deps)
  const rpc = store.handlers({ pluginID: "forge", appVersion: "2.4.2" })
  try {
    const ed = await rpc.editOpen({ scope: "global", sessionID: null })
    assert.equal(ed.ok !== false, true, `editOpen failed: ${JSON.stringify(ed)}`)
    const truthAtOpen = fs.statSync(GLOBAL_FILE, { bigint: true }).ino
    assertExactStringIno(ed.identity && ed.identity.ino, truthAtOpen, "editOpen")
    const p = await rpc.prepare({
      snapshotId: ed.snapshotId,
      scope: "global",
      sessionID: null,
      ops: [{ opId: "o1", action: "update", kind: "worker", id: "util", draft: { mode: "pinned", model: "prov/new", thoughtLevel: "high" } }],
    })
    assert.equal(p.ok !== false, true, `prepare failed: ${JSON.stringify(p)}`)
    const c = await rpc.commit({ token: p.token.token, confirm: true, scope: "global", sessionID: null })
    assert.equal(c.ok === true && c.receipt && c.receipt.outcome === "written", true, `commit failed: ${JSON.stringify(c)}`)
    const truthAfter = fs.statSync(GLOBAL_FILE, { bigint: true }).ino
    assertExactStringIno(c.receipt.savedIdentity && c.receipt.savedIdentity.ino, truthAfter, "commit receipt")
    const r = await rpc.receipt({ token: p.token.token })
    assert.equal(r.found, true)
    assertExactStringIno(r.receipt.savedIdentity && r.receipt.savedIdentity.ino, truthAfter, "receipt lookup")
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

// --- 3. PIN: adjacent file IDs must never compare equal (replacement must
//        be detected even when a Number path would round-collide) ---------

test("PIN: prepare must detect delete+recreate when the ino moves 72902018970278429 → 72902018970278430 (adjacent, Number-colliding)", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "forge-ino-adj-"))
  const GLOBAL_FILE = path.join(root, "global", "forge.json")
  fs.mkdirSync(path.dirname(GLOBAL_FILE), { recursive: true })
  fs.writeFileSync(GLOBAL_FILE, '{\n  "agents": {\n    "util": { "prompt": "old prompt" }\n  }\n}\n')
  let idCounter = 0
  let now = 1_000_000
  // Target-design seam: stat reports dev/ino as decimal strings. Adjacent
  // IDs differ ONLY in the last digit — any Number collapse must not hide
  // the recreate.
  const stats = [
    { mtimeMs: 1_000, size: fs.statSync(GLOBAL_FILE).size, dev: "1", ino: "72902018970278429" },
    { mtimeMs: 1_000, size: fs.statSync(GLOBAL_FILE).size, dev: "1", ino: "72902018970278430" },
  ]
  let turn = 0
  const deps = {
    clock: () => now,
    randomId: () => `id-${++idCounter}`,
    hash: sha256,
    epoch: () => ({ epoch: "ep-1", generation: 7 }),
    resolver() {
      return { ok: true, target: { path: GLOBAL_FILE, observedLocation: root, anchor: null, creatable: true } }
    },
    reverify: () => true,
    fs: {
      stat: () => stats[Math.min(turn, stats.length - 1)],
      // Serve the walk-up guard with REAL lstat for directories; only the
      // target file's identity comes from the seam.
      lstat: (p) =>
        p === GLOBAL_FILE
          ? { exists: true, isSymlink: false, isDirectory: false, isFile: true, mtimeMs: 1_000, size: stats[0].size }
          : (() => {
              const st = fs.lstatSync(p)
              return { exists: true, isSymlink: st.isSymbolicLink(), isDirectory: st.isDirectory(), isFile: st.isFile(), mtimeMs: st.mtimeMs, size: st.size }
            })(),
    },
  }
  const store = createConfigRpcStore(deps)
  const rpc = store.handlers({ pluginID: "forge", appVersion: "2.4.2" })
  try {
    const ed = await rpc.editOpen({ scope: "global", sessionID: null })
    assert.equal(ed.ok !== false, true, `editOpen failed: ${JSON.stringify(ed)}`)
    turn = 1 // the recreate: same mtime/size, adjacent ino
    const p = await rpc.prepare({
      snapshotId: ed.snapshotId,
      scope: "global",
      sessionID: null,
      ops: [{ opId: "o1", action: "update", kind: "worker", id: "util", draft: { mode: "pinned", model: "prov/new" } }],
    })
    assert.equal(
      p.ok === false && p.reason === "conflict-reload",
      true,
      `adjacent-ID recreate must refuse as conflict-reload, got: ${JSON.stringify({ ok: p.ok, reason: p.reason })}`,
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

// --- 4. RED: an UNSAFE Number identity from the seam must be refused
//        explicitly, never silently accepted as fresh -----------------------

test("RED: a seam stat handing an unsafe Number ino (2^53+1) must be refused by prepare — today the product accepts it silently", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "forge-ino-unsafe-"))
  const GLOBAL_FILE = path.join(root, "global", "forge.json")
  fs.mkdirSync(path.dirname(GLOBAL_FILE), { recursive: true })
  fs.writeFileSync(GLOBAL_FILE, '{\n  "agents": {\n    "util": { "prompt": "old prompt" }\n  }\n}\n')
  const size = fs.statSync(GLOBAL_FILE).size
  let idCounter = 0
  let now = 1_000_000
  const unsafe = { mtimeMs: 1_000, size, dev: 1, ino: 9007199254740993 } // 2^53 + 1
  assert.equal(Number.isSafeInteger(unsafe.ino), false, "fixture must be unsafe — the bug precondition")
  const deps = {
    clock: () => now,
    randomId: () => `id-${++idCounter}`,
    hash: sha256,
    epoch: () => ({ epoch: "ep-1", generation: 7 }),
    resolver() {
      return { ok: true, target: { path: GLOBAL_FILE, observedLocation: root, anchor: null, creatable: true } }
    },
    reverify: () => true,
    fs: {
      stat: () => unsafe,
      // Real lstat for the directory walk; the target identity comes from
      // the seam (mtime/size consistent so ONLY the unsafe ino varies).
      lstat: (p) =>
        p === GLOBAL_FILE
          ? { exists: true, isSymlink: false, isDirectory: false, isFile: true, mtimeMs: 1_000, size }
          : (() => {
              const st = fs.lstatSync(p)
              return { exists: true, isSymlink: st.isSymbolicLink(), isDirectory: st.isDirectory(), isFile: st.isFile(), mtimeMs: st.mtimeMs, size: st.size }
            })(),
    },
  }
  const store = createConfigRpcStore(deps)
  const rpc = store.handlers({ pluginID: "forge", appVersion: "2.4.2" })
  const textBefore = fs.readFileSync(GLOBAL_FILE, "utf8")
  try {
    // The unsafe identity must be refused EXPLICITLY at any stage —
    // editOpen refusing, prepare refusing, or the seam contract's explicit
    // UnsafeIdentityError throw — never silently accepted as fresh, never
    // faked as missing, and never accompanied by a write.
    let refused = false
    let how = ""
    let ed
    try {
      ed = await rpc.editOpen({ scope: "global", sessionID: null })
    } catch (err) {
      refused = true
      how = `editOpen threw: ${err instanceof Error ? err.message : String(err)}`
    }
    if (!refused) {
      assert.equal(ed.ok !== false, true, `editOpen neither refused nor threw the unsafe identity: ${JSON.stringify(ed)}`)
      let p
      try {
        p = await rpc.prepare({
          snapshotId: ed.snapshotId,
          scope: "global",
          sessionID: null,
          ops: [{ opId: "o1", action: "update", kind: "worker", id: "util", draft: { mode: "pinned", model: "prov/new", thoughtLevel: "high" } }],
        })
      } catch (err) {
        refused = true
        how = `prepare threw: ${err instanceof Error ? err.message : String(err)}`
      }
      if (!refused) {
        assert.equal(p.ok === false, true, `unsafe Number identity flowed through as fresh: ${JSON.stringify({ ok: p.ok, reason: p.reason })}`)
        refused = true
        how = `prepare refused: ${p.reason}`
      }
    }
    assert.equal(refused, true, `unsafe identity must be refused explicitly; outcome: ${how || "accepted"}`)
    // No write may accompany the refusal.
    assert.equal(fs.readFileSync(GLOBAL_FILE, "utf8"), textBefore, "a refusal path must never write the target")
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

// --- 5. RED: a stat seam returning a BigInt ino must be EXPLICITLY refused
//        — BigInt is not a wire shape and must never pass regex/stringify ---

test("RED: snapshotRecipe must explicitly refuse a stat seam handing ino 123n (BigInt) — never let it through to the wire", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-ino-bigint-"))
  const file = path.join(dir, "forge.json")
  fs.writeFileSync(file, '{\n  "agents": {}\n}\n')
  try {
    // Production does bigint stat in ONE adapter place (bigint → decimal
    // string). A raw BigInt from a seam is a contract violation: it must be
    // refused explicitly, not coerced by regex/stringify into a fake pass.
    let outcome = "returned"
    let snap
    try {
      snap = snapshotRecipe({ path: file, stat: () => ({ mtimeMs: 1, size: 1, dev: 1, ino: 123n }) })
    } catch (err) {
      outcome = "threw"
      assert.ok(err instanceof Error, `refusal must be a real Error, got: ${String(err)}`)
    }
    if (outcome === "returned") {
      // If it returns at all, the snapshot must NOT carry the BigInt to the
      // wire and must NOT pretend freshness — refusal is mandatory.
      const leaked =
        snap.exists && snap.stat !== null && (typeof snap.stat.ino === "bigint" || snap.stat.ino === "123" || snap.stat.ino === 123)
      assert.equal(
        leaked,
        false,
        `BigInt ino 123n must be refused explicitly, not leaked/coerced into the snapshot (got ${JSON.stringify(snap.stat && snap.stat.ino)})`,
      )
      assert.fail(`snapshotRecipe silently accepted a BigInt seam ino (snapshot.exists=${snap.exists}) — explicit refusal required`)
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// --- 6. RED: post-publish stat turning UNSAFE must NOT unwrite the commit --

test("RED: commit whose post-publish stat seam turns unsafe must still be written with real bytes, savedIdentity:null and an explicit unverifiable-identity message", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "forge-ino-postunsafe-"))
  const GLOBAL_FILE = path.join(root, "global", "forge.json")
  fs.mkdirSync(path.dirname(GLOBAL_FILE), { recursive: true })
  fs.writeFileSync(GLOBAL_FILE, '{\n  "agents": {\n    "util": { "prompt": "old prompt" }\n  }\n}\n')
  let idCounter = 0
  let now = 1_000_000
  // First identity: fully SAFE number (freshness holds through open/prepare).
  const SAFE_INO = 12345 // first identity: fully safe number
  assert.equal(Number.isSafeInteger(SAFE_INO), true, "fixture must start safe — the bug precondition is the POST-publish flip")
  // NO call-count guessing: the seam goes unsafe ONLY once the real publish
  // has landed, decided by READING the target's on-disk content (the new
  // text present) — equivalently, rename completed. Before that, every
  // kernel stat (freshness probe, in-lock reverify) sees the safe identity.
  const UNSAFE_INO = 9007199254740993 // 2^53 + 1
  const deps = {
    clock: () => now,
    randomId: () => `id-${++idCounter}`,
    hash: sha256,
    epoch: () => ({ epoch: "ep-1", generation: 7 }),
    resolver() {
      return { ok: true, target: { path: GLOBAL_FILE, observedLocation: root, anchor: null, creatable: true } }
    },
    reverify: () => true,
    fs: {
      stat: (p) => {
        const real = fs.statSync(p)
        let landed = false
        try {
          landed = fs.readFileSync(GLOBAL_FILE, "utf8").includes('"prov/new"')
        } catch {
          landed = false
        }
        return landed ? { mtimeMs: real.mtimeMs, size: real.size, dev: 1, ino: UNSAFE_INO } : { mtimeMs: real.mtimeMs, size: real.size, dev: 1, ino: SAFE_INO }
      },
      lstat: (p) => {
        const st = fs.lstatSync(p)
        return { exists: true, isSymlink: st.isSymbolicLink(), isDirectory: st.isDirectory(), isFile: st.isFile(), mtimeMs: st.mtimeMs, size: st.size }
      },
    },
  }
  const store = createConfigRpcStore(deps)
  const rpc = store.handlers({ pluginID: "forge", appVersion: "2.4.2" })
  try {
    const ed = await rpc.editOpen({ scope: "global", sessionID: null })
    assert.equal(ed.ok !== false, true, `editOpen failed: ${JSON.stringify(ed)}`)
    const p = await rpc.prepare({
      snapshotId: ed.snapshotId,
      scope: "global",
      sessionID: null,
      ops: [{ opId: "o1", action: "update", kind: "worker", id: "util", draft: { mode: "pinned", model: "prov/new", thoughtLevel: "high" } }],
    })
    assert.equal(p.ok !== false, true, `prepare failed: ${JSON.stringify(p)}`)
    const c = await rpc.commit({ token: p.token.token, confirm: true, scope: "global", sessionID: null })
    // The bytes ARE on disk; the commit must be reported written — never
    // thrown away, never ok:false, never a silent unexplained null.
    assert.equal(c.ok === true && c.receipt && c.receipt.outcome === "written", true, `commit must stay written, got: ${JSON.stringify({ ok: c.ok, reason: c.reason, outcome: c.receipt && c.receipt.outcome, message: c.message })}`)
    const textAfter = fs.readFileSync(GLOBAL_FILE, "utf8")
    assert.equal(textAfter.includes('"prov/new"'), true, "the write must have landed")
    assert.equal(typeof c.receipt.bytes === "number" && c.receipt.bytes > 0, true, `bytes must be the real UTF-8 length, got ${JSON.stringify(c.receipt.bytes)}`)
    assert.equal(c.receipt.bytes, Buffer.byteLength(textAfter, "utf8"), "bytes must equal the real on-disk UTF-8 length")
    // The post identity is explicitly UNCONFIRMED: null, with a message
    // that says so — not a silent null and not a fabricated identity.
    assert.equal(c.receipt.savedIdentity === null, true, `savedIdentity must be explicit null, got ${JSON.stringify(c.receipt.savedIdentity)}`)
    assert.equal(typeof c.receipt.message === "string" && /identit|verif/i.test(c.receipt.message), true, `message must state the post-write identity could not be confirmed, got: ${JSON.stringify(c.receipt.message)}`)
    const r = await rpc.receipt({ token: p.token.token })
    assert.equal(r.found, true, "receipt lookup must find the written receipt")
    assert.equal(r.receipt.savedIdentity === null && r.receipt.outcome === "written", true, "lookup must return the SAME receipt (written, savedIdentity null)")
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
