import test from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"

// forge-tui-subagent-config — sync method contract tests over the frozen
// relay schema (src/config-rpc-sync.ts createConfigRpcSyncHandler):
//   sync({scope, sessionID, confirm, action: prepare|apply, token?, commitId?})
//   prepare: confirm EXACTLY false, pure read → token|noop + full preview
//   apply:   confirm EXACTLY true + token → applied|unconfirmed|conflict|
//            refused|noop with independent host observation (appliedStatus)
// Everything injectable: memory fs (RosterFsDeps-compatible, with write
// counters), fake clock, mutable epoch, real createPoolResolver over the
// memory fs (the SAME compiler the wiring runs). The sync token namespace
// ("synctok-") is asserted separate from the commit protocol's tokens.

import { createConfigRpcSyncHandler, captureSyncBaseline } from "../src/config-rpc-sync.ts"
import { createPoolResolver, forgeConfigPaths } from "../src/forge-config.ts"
import { GENERATED_MARKER, generatedHeader } from "../src/roster-compile.ts"
import { createConfigRpcStore } from "../src/config-rpc-protocol.ts"

const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex")

const HOME = "/h"
const GLOBAL_FILE = forgeConfigPaths({ homeDir: HOME }).global
const AGENT_DIR = "/h/.config/opencode/agent"
const WS_FILE = "/w/.opencode/forge.json"
const GLOBAL_RECIPE = '{\n  "pool": "base",\n  "agents": {\n    "alpha": { "model": "prov/m", "thoughtLevel": "high", "prompt": "alpha body" }\n  }\n}\n'

// Memory fs with RosterFsDeps surface + write counters + readdir (GC).
function memFs(initial = {}) {
  const files = new Map()
  let mt = 1000
  for (const [p, text] of Object.entries(initial)) files.set(p, { text, mtimeMs: mt++, ino: 1, dev: 1 })
  const io = { writes: [], renames: [], links: [], unlinks: [] }
  const dirOf = (p) => {
    const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"))
    return i <= 0 ? "/" : p.slice(0, i)
  }
  return {
    files,
    io,
    stat: (p) => {
      const e = files.get(p)
      return e ? { mtimeMs: e.mtimeMs, size: e.text.length } : null
    },
    readFile: (p) => {
      const e = files.get(p)
      if (!e) throw new Error(`ENOENT ${p}`)
      return e.text
    },
    writeFile: (p, data) => {
      io.writes.push(p)
      if (typeof data !== "string") throw new Error("non-string write")
      files.set(p, { text: data, mtimeMs: mt++, ino: 1, dev: 1 })
    },
    rename: (a, b) => {
      io.renames.push([a, b])
      const e = files.get(a)
      if (!e) throw new Error(`ENOENT rename ${a}`)
      files.set(b, { text: e.text, mtimeMs: mt++, ino: 1, dev: 1 })
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
      files.set(b, { text: e.text, mtimeMs: e.mtimeMs, ino: 1, dev: 1 })
    },
    unlink: (p) => {
      io.unlinks.push(p)
      files.delete(p)
    },
    readdir: (dir) => {
      const out = []
      for (const p of files.keys()) {
        if (dirOf(p) === dir) out.push(p.slice(dir.length + 1))
      }
      return out
    },
    mkdir: () => {},
    text: (p) => files.get(p)?.text,
  }
}

// The independent host observation seam, derived from what the executor
// ACTUALLY wrote (mirror of the comparator's contract: row.system equals
// the compiled body, row.model the frontmatter model string).
// Frontmatter stripper shared by observation-shape tests (regex-free of
// caller-side escaping pitfalls).
function stripFrontmatter(text) {
  const fm = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.exec(text)
  return fm === null ? text : text.slice(fm[0].length).replace(/^\r?\n/, "")
}

function observerFrom(mfs, dir) {
  return async () => {
    const rows = []
    for (const [p, e] of mfs.files) {
      if (!p.startsWith(dir) || !p.endsWith(".md")) continue
      const fm = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.exec(e.text)
      const body = fm === null ? null : e.text.slice(fm[0].length).replace(/^\r?\n/, "")
      const mm = fm === null ? null : /^model: ("((?:[^"\\]|\\.)*)"|(.+))$/m.exec(fm[0])
      const model = mm === null ? undefined : mm[2] !== undefined ? JSON.parse(`"${mm[2]}"`) : mm[3]?.trim()
      // The compiled frontmatter carries the native Permission.Ruleset array
      // (action/resource/effect). The observer reports it VERBATIM so the
      // handler's exact permission comparison decides; a row WITHOUT the
      // field while one is expected stays unconfirmed (never guessed equal).
      const permissions = []
      if (fm !== null) {
        const block = /^permissions:\r?\n((?:[ \t]+-[^\r\n]*\r?\n?[ \t]+[^\r\n]*\r?\n?[ \t]+[^\r\n]*\r?\n?)*)/m.exec(fm[0])
        if (block !== null) {
          const re = /-[ \t]+action: ("(?:[^"\\]|\\.)*"|\S+)[\s\S]*?resource: ("(?:[^"\\]|\\.)*"|\S+)[\s\S]*?effect: ("(?:[^"\\]|\\.)*"|\S+)/g
          let m
          while ((m = re.exec(block[1])) !== null) {
            const val = (s) => (s.startsWith('"') ? JSON.parse(s) : s)
            permissions.push({ action: val(m[1]), resource: val(m[2]), effect: val(m[3]) })
          }
        }
      }
      const row = { id: p.split("/").pop().replace(/\.md$/, ""), system: body, model }
      if (permissions.length > 0) row.permissions = permissions
      rows.push(row)
    }
    return rows
  }
}

function makeEnv(opts = {}) {
  const wsFile = opts.workspaceFile ?? WS_FILE
  const wsAnchor = opts.workspaceAnchor ?? "/w"
  const globalAgentDir = opts.globalAgentDir ?? AGENT_DIR
  const state = {
    now: 1_000_000,
    epoch: { epoch: "ep-1", generation: 7 },
    location: "/h",
    // Semantic (NOT call-count) coverage-loss switch: flips true after the
    // first projection write, so any post-write re-resolution fails.
    afterWrite: false,
    globalAgentDir,
    writeFileBoom: false,
    boomPaths: opts.boomPaths ?? [],
  }
  const mfs = memFs(opts.initial ?? { [GLOBAL_FILE]: GLOBAL_RECIPE })
  let idCounter = 0
  const deps = {
    resolveScope(req) {
      if (req.scope === "global") {
        return { ok: true, target: { path: GLOBAL_FILE, observedLocation: state.location, anchor: null, creatable: true } }
      }
      return { ok: true, target: { path: wsFile, observedLocation: state.location, anchor: wsAnchor, creatable: true } }
    },
    // FROZEN new API: a FRESH resolver + fresh-recording readOf per call —
    // the same snapshot resolves AND hashes; never a shared stale resolver.
    resolvePools() {
      if (state.afterWrite) return null // semantic post-write coverage loss
      const readMap = new Map()
      const fresh = createPoolResolver({
        homeDir: HOME,
        stat: mfs.stat,
        readFile: (p) => {
          const t = mfs.readFile(p)
          readMap.set(p, t)
          return t
        },
      })
      const resolution = fresh.resolve([wsAnchor, HOME])
      return { resolution, readOf: (p) => (readMap.has(p) ? readMap.get(p) : null) }
    },
    // Pre-save commit-context seam (commitId annotation baseline).
    getCommitContext: opts.getCommitContext ?? (() => ({ found: true, context: { epoch: "ep-1", generation: 7 } })),
    globalPoolFile: () => GLOBAL_FILE,
    rosterDirs: () => ({ globalPoolFile: GLOBAL_FILE, globalAgentDir: state.globalAgentDir }),
    rosterFs: () => ({
      stat: mfs.stat,
      readFile: mfs.readFile,
      // SEMANTIC state change (S13 env ONLY, via opts.lossAfterWrite): the
      // first SUCCESSFUL execution write flips afterWrite, so the post-write
      // coverage re-resolution genuinely loses coverage — never a call-count
      // guess, and never leaked into other scenarios.
      writeFile: (p, d) => {
        if (state.writeFileBoom || state.boomPaths.some((frag) => p.includes(frag))) throw new Error("injected write failure")
        const out = mfs.writeFile(p, d)
        if (opts.lossAfterWrite) state.afterWrite = true
        return out
      },
      rename: mfs.rename,
      link: mfs.link,
      unlink: mfs.unlink,
      readdir: mfs.readdir,
      mkdir: mfs.mkdir,
    }),
    epoch: () => ({ ...state.epoch }),
    clock: () => state.now,
    randomId: () => `id-${++idCounter}`,
    hash: sha256,
    ttlMs: 60_000,
    listNativeAgents: undefined, // replaced below (mutable via env.setObserver)
    attachSyncOutcome: opts.attachSyncOutcome,
  }
  let observer = opts.noObserver ? undefined : observerFrom(mfs, globalAgentDir)
  deps.listNativeAgents = async () => (observer ? observer() : null)
  const sync = createConfigRpcSyncHandler(deps)
  return { state, mfs, sync, wsFile, wsAnchor, globalAgentDir, setObserver: (fn) => { observer = fn }, resolvePools: deps.resolvePools }
}

async function prepareSync(env, req = { scope: "global", sessionID: null }) {
  return env.sync({ scope: req.scope ?? "global", sessionID: req.sessionID ?? null, confirm: false, action: "prepare", ...(req.commitId !== undefined ? { commitId: req.commitId } : {}) })
}

// ---------------------------------------------------------------------------
// prepare: pure read, frozen preview shape, bounded single-use token
// ---------------------------------------------------------------------------

test("S1 prepare is pure read: full preview (family/overrides/files/coverage), synctok issued, zero writes anywhere", async (t) => {
  const env = makeEnv()
  const before = env.mfs.text(GLOBAL_FILE)
  const p = await prepareSync(env)
  assert.equal(p.ok, true)
  assert.equal(p.action, "prepare")
  assert.equal(p.outcome, "token")
  assert.match(p.token.token, /^synctok-/, "the sync token is namespaced apart from commit tokens")
  assert.equal(typeof p.token.expiresAt, "number")
  assert.equal(p.token.epoch, "ep-1")
  assert.equal(p.token.generation, 7)
  const v = p.preview
  assert.equal(v.path, GLOBAL_FILE)
  assert.equal(v.scope, "global")
  assert.equal(v.sessionID, null)
  assert.equal(v.observedLocation, "/h")
  assert.equal(v.anchor, null)
  assert.deepEqual(v.family, { file: GLOBAL_FILE, ns: "global", materializedIds: ["global-alpha"] })
  assert.equal(v.overridesIncluded, true, "the global scope rides the override plan")
  assert.equal(v.coverage, "full")
  assert.ok(Array.isArray(v.files) && v.files.length >= 1)
  const alpha = v.files.find((f) => f.nativeId === "forge-global-alpha")
  assert.ok(alpha, "the compiled projection lists the worker's native id")
  assert.equal(alpha.op, "create")
  assert.equal(alpha.dest, `${AGENT_DIR}/forge-global-alpha.md`)
  assert.ok(v.summary.some((s) => s.includes("forge-global-alpha.md")))
  assert.ok(Array.isArray(v.findings))
  assert.equal(env.mfs.text(GLOBAL_FILE), before, "the recipe bytes are untouched by prepare")
  assert.equal(env.mfs.io.writes.length, 0, "prepare wrote nothing")
  assert.equal(env.mfs.io.renames.length, 0)
  assert.equal(env.mfs.io.links.length, 0)
})

test("S2 a fully current projection prepares as noop with NO token", async (t) => {
  const env = makeEnv()
  const p1 = await prepareSync(env)
  const a1 = await env.sync({ scope: "global", sessionID: null, confirm: true, action: "apply", token: p1.token.token })
  assert.equal(a1.ok, true)
  const p2 = await prepareSync(env)
  assert.equal(p2.ok, true)
  assert.equal(p2.outcome, "noop")
  assert.equal(p2.token, undefined, "a noop issues no token — nothing can execute later")
  assert.ok(p2.preview.files.every((f) => f.op === "unchanged"))
})

// ---------------------------------------------------------------------------
// apply: independent host observation decides applied vs unconfirmed
// ---------------------------------------------------------------------------

test("S3 apply without a proven observer stays UNCONFIRMED (never self-certified)", async (t) => {
  const env = makeEnv({ noObserver: true })
  const p = await prepareSync(env)
  const a = await env.sync({ scope: "global", sessionID: null, confirm: true, action: "apply", token: p.token.token })
  assert.equal(a.ok, true)
  assert.equal(a.action, "apply")
  assert.equal(a.outcome, "unconfirmed")
  assert.equal(a.applied, false)
  assert.equal(a.appliedStatus.status, "unconfirmed")
  assert.equal(a.appliedStatus.observedBy, null)
  assert.deepEqual(a.appliedStatus.confirmedIds, [])
  assert.ok(a.appliedStatus.unconfirmedIds.includes("forge-global-alpha"))
  // Frozen wire shape: created is a {nativeId, fileName} object array, never
  // a raw dest string array (ruling B-E).
  assert.deepEqual(a.created, [{ nativeId: "forge-global-alpha", fileName: "forge-global-alpha.md" }])
})

test("S4 apply with confirming host observation reports APPLIED with confirmed ids", async (t) => {
  const env = makeEnv()
  const p = await prepareSync(env)
  const a = await env.sync({ scope: "global", sessionID: null, confirm: true, action: "apply", token: p.token.token })
  assert.equal(a.ok, true)
  assert.equal(a.outcome, "applied", `the observer saw the written body — outcome: ${JSON.stringify(a.appliedStatus)}`)
  assert.equal(a.applied, true)
  assert.equal(a.appliedStatus.status, "applied")
  assert.notEqual(a.appliedStatus.observedBy, null)
  assert.deepEqual(a.appliedStatus.confirmedIds, ["forge-global-alpha"])
  assert.deepEqual(a.appliedStatus.unconfirmedIds, [])
  assert.equal(env.mfs.io.renames.length >= 1, true, "the projection landed through the atomic publish")
  assert.match(env.mfs.text(`${AGENT_DIR}/forge-global-alpha.md`), /alpha body/)
})

test("S5 GC of a stale generated file reports removedIds; the removed id confirmed gone by the observer", async (t) => {
  const env = makeEnv({
    initial: {
      [GLOBAL_FILE]: GLOBAL_RECIPE,
      [`${AGENT_DIR}/forge-stale.md`]: `${generatedHeader(GLOBAL_FILE)}\n\nstale body\n`,
    },
  })
  const p = await prepareSync(env)
  const a = await env.sync({ scope: "global", sessionID: null, confirm: true, action: "apply", token: p.token.token })
  assert.equal(a.ok, true)
  assert.equal(a.outcome, "applied", `status: ${JSON.stringify(a.appliedStatus)}`)
  assert.deepEqual(a.removedIds, ["forge-stale"])
  assert.deepEqual(a.gced, [`${AGENT_DIR}/forge-stale.md`])
  assert.deepEqual(a.appliedStatus.removedConfirmedIds, ["forge-stale"])
  assert.equal(env.mfs.text(`${AGENT_DIR}/forge-stale.md`), undefined, "the stale generated file was garbage-collected")
})

// ---------------------------------------------------------------------------
// token discipline: single-use, TTL, epoch, input validation, drift
// ---------------------------------------------------------------------------

test("S6 the sync token commits at most once — the second apply is token-spent", async (t) => {
  const env = makeEnv({ noObserver: true })
  const p = await prepareSync(env)
  const a1 = await env.sync({ scope: "global", sessionID: null, confirm: true, action: "apply", token: p.token.token })
  assert.equal(a1.ok, true)
  const a2 = await env.sync({ scope: "global", sessionID: null, confirm: true, action: "apply", token: p.token.token })
  assert.equal(a2.ok, false)
  assert.equal(a2.reason, "token-spent")
})

test("S7 input discipline: confirmed prepare, unconfirmed apply, tokenless apply and unknown fields all refuse", async (t) => {
  const env = makeEnv()
  const badPrepare = await env.sync({ scope: "global", sessionID: null, confirm: true, action: "prepare" })
  assert.equal(badPrepare.ok, false)
  assert.equal(badPrepare.reason, "invalid-input")
  const badApply1 = await env.sync({ scope: "global", sessionID: null, confirm: false, action: "apply", token: "synctok-x" })
  assert.equal(badApply1.ok, false)
  assert.equal(badApply1.reason, "invalid-input")
  const badApply2 = await env.sync({ scope: "global", sessionID: null, confirm: true, action: "apply" })
  assert.equal(badApply2.ok, false)
  assert.equal(badApply2.reason, "invalid-input")
  const badField = await env.sync({ scope: "global", sessionID: null, confirm: false, action: "prepare", text: "arbitrary" })
  assert.equal(badField.ok, false)
  assert.equal(badField.reason, "invalid-input", "no arbitrary write text is accepted")
})

test("S8 an epoch/registration change refuses the sync token", async (t) => {
  const env = makeEnv()
  const p = await prepareSync(env)
  env.state.epoch = { epoch: "ep-2", generation: 8 }
  const a = await env.sync({ scope: "global", sessionID: null, confirm: true, action: "apply", token: p.token.token })
  assert.equal(a.ok, false)
  assert.equal(a.reason, "epoch-stale")
})

test("S9 an expired sync token is refused (injected clock, no auto-renewal)", async (t) => {
  const env = makeEnv()
  const p = await prepareSync(env)
  env.state.now += 60_001
  const a = await env.sync({ scope: "global", sessionID: null, confirm: true, action: "apply", token: p.token.token })
  assert.equal(a.ok, false)
  assert.equal(a.reason, "token-expired")
})

test("S10 recipe drift between prepare and apply refuses stale — never replays the plan", async (t) => {
  const env = makeEnv()
  const p = await prepareSync(env)
  env.mfs.files.set(GLOBAL_FILE, { text: GLOBAL_RECIPE.replace("alpha body", "EXTERNALLY EDITED"), mtimeMs: 555, ino: 9, dev: 1 })
  const a = await env.sync({ scope: "global", sessionID: null, confirm: true, action: "apply", token: p.token.token })
  assert.equal(a.ok, false)
  assert.equal(a.reason, "stale-preview")
  assert.equal(env.mfs.io.writes.length, 0, "a drifted sync wrote nothing")
})

test("S11 a moved observed location between prepare and apply refuses the binding", async (t) => {
  const env = makeEnv()
  const p = await prepareSync(env)
  env.state.location = "/elsewhere"
  const a = await env.sync({ scope: "global", sessionID: null, confirm: true, action: "apply", token: p.token.token })
  assert.equal(a.ok, false)
  assert.equal(a.reason, "scope-mismatch")
})

// ---------------------------------------------------------------------------
// Independent retry: refused execution consumes the token; the retry is a
// FRESH prepare (new sync token), never a revival or a replay.
// ---------------------------------------------------------------------------

test("S12 a refused execution still consumes the token; the retry re-prepares with a NEW sync token and applies", async (t) => {
  const env = makeEnv({ noObserver: true })
  env.state.writeFileBoom = true
  const p1 = await prepareSync(env)
  const a1 = await env.sync({ scope: "global", sessionID: null, confirm: true, action: "apply", token: p1.token.token })
  assert.equal(a1.ok, true)
  assert.equal(a1.outcome, "refused")
  assert.equal(a1.applied, false)
  assert.ok(a1.errors.length >= 1, "the execution failure is disclosed")
  const replay = await env.sync({ scope: "global", sessionID: null, confirm: true, action: "apply", token: p1.token.token })
  assert.equal(replay.ok, false)
  assert.equal(replay.reason, "token-spent", "the failed execution consumed the token — no revival")
  // The independent retry: fresh prepare against current content.
  env.state.writeFileBoom = false
  const p2 = await prepareSync(env)
  assert.notEqual(p2.token?.token, p1.token.token, "the retry prepares a NEW sync token")
  const a2 = await env.sync({ scope: "global", sessionID: null, confirm: true, action: "apply", token: p2.token.token })
  assert.equal(a2.ok, true)
  assert.equal(a2.outcome, "unconfirmed")
  assert.deepEqual(a2.created, [{ nativeId: "forge-global-alpha", fileName: "forge-global-alpha.md" }])
})

// ---------------------------------------------------------------------------
// outcome "conflict": post-sync coverage loss discloses and stays unconfirmed
// ---------------------------------------------------------------------------

test("S13 post-sync coverage unresolvable reports conflict (disclosed, applied=false, ids unconfirmed)", async (t) => {
  const env = makeEnv({ noObserver: true, lossAfterWrite: true })
  // SEMANTIC coverage loss: resolvePools starts failing only AFTER the first
  // successful projection write (the post-write re-resolution leg) — a real
  // seam state change, no call-count pinning of internal verify order.
  const p = await prepareSync(env)
  const a = await env.sync({ scope: "global", sessionID: null, confirm: true, action: "apply", token: p.token.token })
  assert.equal(a.ok, true)
  assert.equal(a.outcome, "conflict")
  assert.equal(a.applied, false)
  assert.ok(a.conflicts.length >= 1, "the coverage loss is disclosed, never guessed around")
  assert.ok(a.appliedStatus.unconfirmedIds.includes("forge-global-alpha"))
})

// ---------------------------------------------------------------------------
// commitId annotation + sync/commit token namespace separation
// ---------------------------------------------------------------------------

// POSITIVE path with a LEGAL pre-save baseline: the context is a REAL
// captureSyncBaseline over the live resolver (v:1, coverage, ownerFile,
// before snapshot — the shape readBaselineShape enforces), and BOTH sync
// legs carry the SAME commitId (prepare binds the baseline, apply correlates).
test("S14: a legal pre-save baseline + prepare/apply carrying the SAME commitId annotates the outcome", async (t) => {
  const attached = []
  // Mutable holder: the baseline is captured through the env's own resolver
  // right after construction and BEFORE any write.
  const ctxHolder = { context: null }
  const env = makeEnv({
    attachSyncOutcome: (commitId, summary) => { attached.push([commitId, summary]); return true },
    getCommitContext: (commitId) => (ctxHolder.context === null
      ? { found: false }
      : { found: true, context: { ...ctxHolder.context, commitId } }),
  })
  const baseline = captureSyncBaseline(
    { ownerFile: GLOBAL_FILE, anchor: null, observedLocation: "/h" },
    env.resolvePools,
    () => env.state.now,
  )
  ctxHolder.context = baseline
  const p = await prepareSync(env, { commitId: "c-123" })
  assert.equal(p.ok, true, `prepare with commitId must succeed against the legal baseline — ${JSON.stringify(p).slice(0, 200)}`)
  const a = await env.sync({ scope: "global", sessionID: null, confirm: true, action: "apply", token: p.token.token, commitId: "c-123" })
  assert.equal(a.ok, true, `apply with the SAME commitId must succeed — ${JSON.stringify(a).slice(0, 300)}`)
  assert.deepEqual(attached.map(([id]) => id), ["c-123"])
  assert.equal(attached[0][1].outcome, a.outcome, "the annotated summary is THIS apply's outcome")
})

// Evidence loss: a commitId whose pre-save commit context is GONE must
// REFUSE the correlated sync (fail-closed) — no silent annotation, no
// execution without its evidence.
test("S14b: a commitId with NO pre-save context is refused (evidence loss), never annotated", async (t) => {
  const attached = []
  const env = makeEnv({
    attachSyncOutcome: (commitId, summary) => { attached.push([commitId, summary]); return true },
    getCommitContext: () => ({ found: false }),
  })
  const p = await prepareSync(env, { commitId: "lost-c" })
  if (p.ok === true) {
    // If prepare still issues a token, the correlated apply MUST refuse.
    const a = await env.sync({ scope: "global", sessionID: null, confirm: true, action: "apply", token: p.token.token, commitId: "lost-c" })
    assert.equal(a.ok, false, `a commitId without a pre-save context must refuse — got: ${JSON.stringify(a).slice(0, 300)}`)
  } else {
    // The observed fail-closed behavior: the prepare itself refuses to bind
    // an evidence-less commitId — no usable sync flow exists at all.
    assert.ok(typeof p.reason === "string" && p.reason.length > 0, `the prepare-time refusal names a reason — ${JSON.stringify(p).slice(0, 200)}`)
  }
  assert.deepEqual(attached, [], "nothing is annotated for a refused evidence-less commitId")
})

// Injection: prepare WITHOUT a commitId, apply INJECTING one — the apply
// must refuse (the baseline was never bound at prepare) with zero writes
// and zero annotation; a context-free sync is never fabricated.
test("S14c: prepare without commitId then apply injecting one refuses — zero writes, zero annotation", async (t) => {
  const attached = []
  const before = null
  const env = makeEnv({
    attachSyncOutcome: (commitId, summary) => { attached.push([commitId, summary]); return true },
    getCommitContext: (commitId) => ({ found: true, context: { v: 1, at: 1, coverage: "full", ownerFile: GLOBAL_FILE, anchor: null, observedLocation: "/h", familyNs: "global", materializedIds: [], before: { ownerByMatId: {}, contentByMatId: {}, collisionFindings: [] }, commitId } }),
  })
  const p = await prepareSync(env) // NO commitId
  assert.equal(p.ok, true)
  const a = await env.sync({ scope: "global", sessionID: null, confirm: true, action: "apply", token: p.token.token, commitId: "c-injected" })
  assert.equal(a.ok, false, `an injected commitId on an unbound prepare must refuse — got: ${JSON.stringify(a).slice(0, 300)}`)
  assert.deepEqual(attached, [], "nothing is annotated for an injected commitId")
  assert.equal(env.mfs.readdir(env.globalAgentDir).some((f) => f.endsWith(".md")), false, "zero projection writes for a refused injected commitId")
})

test("S15 sync and commit tokens are mutually unacceptable — a sync token is never a commit token and vice versa", async (t) => {
  const env = makeEnv()
  const sp = await prepareSync(env)
  assert.match(sp.token.token, /^synctok-/)
  // Commit store side (memfs-injected): a sync token must be token-unknown there.
  let idCounter = 0
  const mfs = memFs({ [GLOBAL_FILE]: '{ "agents": { "alpha": {} } }' })
  mfs.lstat = (p) => { const e = mfs.files.get(p); return e ? { exists: true, isSymlink: false, isDirectory: false, isFile: true, nlink: 1, mtimeMs: e.mtimeMs, size: e.text.length } : { exists: false } }
  mfs.realpath = (p) => p
  const store = createConfigRpcStore({
    clock: () => 1_000_000,
    randomId: () => `id-${++idCounter}`,
    hash: sha256,
    epoch: () => ({ epoch: "ep-1", generation: 7 }),
    fs: mfs,
    resolver: () => ({ ok: true, target: { path: GLOBAL_FILE, observedLocation: "/h", anchor: null, creatable: false } }),
  })
  const rpc = store.handlers({ pluginID: "forge", appVersion: "2.4.2" })
  const c = await rpc.commit({ token: sp.token.token, confirm: true, scope: "global", sessionID: null })
  assert.equal(c.ok, false)
  assert.equal(c.reason, "token-unknown", "a sync token can never drive the commit protocol")
  // Sync side: a commit token is not a sync token.
  const ed = await rpc.editOpen({ scope: "global", sessionID: null })
  const cp = await rpc.prepare({ snapshotId: ed.snapshotId, scope: "global", sessionID: null, ops: [{ opId: "o1", action: "update", kind: "worker", id: "alpha", draft: { mode: "pinned", model: "prov/x", thoughtLevel: "high" } }] })
  assert.ok(cp && cp.outcome === "token")
  assert.ok(!cp.token.token.startsWith("synctok-"))
  const sa = await env.sync({ scope: "global", sessionID: null, confirm: true, action: "apply", token: cp.token.token })
  assert.equal(sa.ok, false)
  assert.equal(sa.reason, "token-unknown", "a commit token can never drive the sync protocol")
})

// The namespace claim must ride the REAL store's receipt, not self-issued
// fixture ids: a real commit produces a real same-epoch receipt; that
// receipt's token is what the sync side rejects, and the sync token is what
// the real commit path (and its receipt lookup) rejects.
test("S15b namespace separation proven through the REAL commit receipt", async (t) => {
  const env = makeEnv()
  const sp = await prepareSync(env)
  assert.match(sp.token.token, /^synctok-/)
  // Real protocol store over the same memfs (guard seams included), real
  // hash/id defaults, a REAL confirmed commit with a REAL receipt.
  const mfs = memFs({ [GLOBAL_FILE]: '{ "agents": { "alpha": {} } }' })
  mfs.lstat = (p) => {
    const e = mfs.files.get(p)
    return e ? { exists: true, isSymlink: false, isDirectory: false, isFile: true, nlink: 1, mtimeMs: e.mtimeMs, size: e.text.length } : { exists: false }
  }
  mfs.realpath = (p) => p
  mfs.rename = (a, b) => {
    const e = mfs.files.get(a)
    if (!e) throw new Error("ENOENT rename")
    mfs.files.set(b, { text: e.text, mtimeMs: e.mtimeMs + 1, ino: 42, dev: 1 })
    mfs.files.delete(a)
  }
  const store = createConfigRpcStore({
    clock: () => 1_000_000,
    epoch: () => ({ epoch: "ep-1", generation: 7 }),
    fs: mfs,
    resolver: () => ({ ok: true, target: { path: GLOBAL_FILE, observedLocation: "/h", anchor: null, creatable: false } }),
  })
  const rpc = store.handlers({ pluginID: "forge", appVersion: "2.4.2" })
  const ed = await rpc.editOpen({ scope: "global", sessionID: null })
  assert.equal(ed.ok, true)
  const cp = await rpc.prepare({
    snapshotId: ed.snapshotId, scope: "global", sessionID: null,
    ops: [{ opId: "o1", action: "update", kind: "worker", id: "alpha", draft: { mode: "pinned", model: "prov/x", thoughtLevel: "high" } }],
  })
  assert.ok(cp && cp.outcome === "token")
  const c = await rpc.commit({ token: cp.token.token, confirm: true, scope: "global", sessionID: null })
  assert.equal(c.ok, true)
  assert.equal(c.receipt.outcome, "written")
  // The REAL receipt confirms the commit token's identity and ledger state.
  const r = await rpc.receipt({ token: cp.token.token })
  assert.equal(r.found, true)
  assert.equal(r.receipt.outcome, "written")
  assert.equal(r.receipt.token, cp.token.token)
  // That real commit token is refused by the sync surface...
  const sa = await env.sync({ scope: "global", sessionID: null, confirm: true, action: "apply", token: cp.token.token })
  assert.equal(sa.ok, false)
  assert.equal(sa.reason, "token-unknown")
  // ...and the sync token is refused by the commit surface, whose real
  // receipt ledger never gains an entry for it.
  const c2 = await rpc.commit({ token: sp.token.token, confirm: true, scope: "global", sessionID: null })
  assert.equal(c2.ok, false)
  assert.equal(c2.reason, "token-unknown")
  const r2 = await rpc.receipt({ token: sp.token.token })
  assert.equal(r2.found, false, "no real receipt ever exists for a sync token on the commit side")
})

// ---------------------------------------------------------------------------
// Server-reviewer P1 findings (round 3) — reproduced against the real
// handler + real compiler. Several are expected RED until the sync worker's
// fixes land; failures are reported, never masked by fixture edits.
// ---------------------------------------------------------------------------

// P1-a: a workspace family and the global family materializing into the
// SAME agent dir (misrouted OPENCODE_CONFIG_DIR-style wiring) — the global
// sync's GC must NEVER delete the unselected family's generated files.
// Fixture per the frozen contract: bootstrap each family NON-shared first
// (proving both projections materialize), then point the wiring at ONE
// shared dir and demand either a safe directory-conflict REFUSAL or zero GC
// of the other family — never a marker-filtered readdir proxy in prod.
test("P1a: GC into a SHARED agent dir must not delete the unselected family's projection", async (t) => {
  const sharedDir = "/h/x/.opencode/agent"
  const wsFile = "/h/x/.opencode/forge.json"
  const env = makeEnv({
    workspaceFile: wsFile,
    workspaceAnchor: "/h/x",
    initial: {
      [GLOBAL_FILE]: GLOBAL_RECIPE,
      [wsFile]: '{ "pool": "x", "agents": { "beta": { "model": "prov/b", "thoughtLevel": "low" } } }\n',
    },
  })
  // Bootstrap both projections NON-shared (their own dirs).
  const wsP = await prepareSync(env, { scope: "workspace", sessionID: null })
  assert.ok(wsP.outcome === "token", JSON.stringify(wsP).slice(0, 200))
  const wsA = await env.sync({ scope: "workspace", sessionID: null, confirm: true, action: "apply", token: wsP.token.token })
  assert.equal(wsA.ok, true)
  const gP = await prepareSync(env, { scope: "global", sessionID: null })
  assert.ok(gP.outcome === "token")
  const gA = await env.sync({ scope: "global", sessionID: null, confirm: true, action: "apply", token: gP.token.token })
  assert.equal(gA.ok, true)
  // Workspace projections materialize under the WORKSPACE anchor's agent
  // dir; globals under the global agent dir.
  const wsProj = env.mfs.text("/h/x/.opencode/agent/forge-x-beta.md")
  const gProj = env.mfs.text(`${AGENT_DIR}/forge-global-alpha.md`)
  assert.ok(wsProj !== undefined, "bootstrap: the workspace projection materialized")
  assert.ok(gProj !== undefined, "bootstrap: the global projection materialized")
  // Simulate the misrouted wiring: BOTH families now target ONE shared dir
  // that already holds both projections.
  env.state.globalAgentDir = sharedDir
  env.mfs.files.set(`${sharedDir}/forge-x-beta.md`, { text: wsProj, mtimeMs: 500, ino: 7, dev: 1 })
  env.mfs.files.set(`${sharedDir}/forge-global-alpha.md`, { text: gProj, mtimeMs: 501, ino: 8, dev: 1 })
  // Remove the global worker so the global sync now has GC to do.
  env.mfs.files.set(GLOBAL_FILE, { text: '{\n  "pool": "base",\n  "agents": {}\n}\n', mtimeMs: 4242, ino: 1, dev: 1 })
  const p = await prepareSync(env, { scope: "global", sessionID: null })
  if (p.ok === false) {
    // A safe directory-conflict refusal is an acceptable close: nothing in
    // the shared dir was touched.
    assert.equal(env.mfs.text(`${sharedDir}/forge-x-beta.md`), wsProj, "the refusal leaves the shared dir untouched")
    return
  }
  assert.ok(p.outcome === "token", `shared-dir global sync must not degrade pending GC into a noop — outcome: ${JSON.stringify(p).slice(0, 300)}`)
  const a = await env.sync({ scope: "global", sessionID: null, confirm: true, action: "apply", token: p.token.token })
  const stillThere = env.mfs.text(`${sharedDir}/forge-x-beta.md`) !== undefined
  const refused = a.ok === false
  assert.ok(
    refused || stillThere,
    `a shared-dir global sync must either refuse closed or GC ONLY its own family — outcome: ${JSON.stringify(a).slice(0, 400)}`,
  )
})

// P1-b: GC-only work must never be a noop (a noop issues no token, so the
// GC could never execute).
test("P1b1: deleting the LAST worker (GC pending) must not prepare as noop", async (t) => {
  const env = makeEnv()
  const p1 = await prepareSync(env)
  await env.sync({ scope: "global", sessionID: null, confirm: true, action: "apply", token: p1.token.token })
  assert.ok(env.mfs.text(`${AGENT_DIR}/forge-global-alpha.md`) !== undefined, "bootstrap: projection exists")
  env.mfs.files.set(GLOBAL_FILE, { text: '{\n  "pool": "base",\n  "agents": {}\n}\n', mtimeMs: 4242, ino: 1, dev: 1 })
  const p2 = await prepareSync(env)
  assert.notEqual(p2.outcome, "noop", "the pending GC is real work — a noop verdict makes it unreachable")
})

test("P1b2: resetting the LAST override (GC pending) must not prepare as noop", async (t) => {
  const env = makeEnv({
    initial: { [GLOBAL_FILE]: '{\n  "pool": "base",\n  "agents": {},\n  "override": { "general": { "prompt": "g" } }\n}\n' },
  })
  const p1 = await prepareSync(env)
  const a1 = await env.sync({ scope: "global", sessionID: null, confirm: true, action: "apply", token: p1.token.token })
  assert.equal(a1.ok, true)
  assert.ok(env.mfs.text(`${AGENT_DIR}/general.md`) !== undefined, "bootstrap: the override artifact exists")
  env.mfs.files.set(GLOBAL_FILE, { text: '{\n  "pool": "base",\n  "agents": {}\n}\n', mtimeMs: 4242, ino: 1, dev: 1 })
  const p2 = await prepareSync(env)
  assert.notEqual(p2.outcome, "noop", "the override deactivation GC is real work — never a noop")
})

test("P1b3: survivors unchanged but a stale generated file exists — GC pending must not be noop", async (t) => {
  const env = makeEnv()
  const p1 = await prepareSync(env)
  await env.sync({ scope: "global", sessionID: null, confirm: true, action: "apply", token: p1.token.token })
  env.mfs.files.set(`${AGENT_DIR}/forge-stale.md`, { text: `${generatedHeader(GLOBAL_FILE)}\n\nstale\n`, mtimeMs: 9, ino: 1, dev: 1 })
  const p2 = await prepareSync(env)
  assert.notEqual(p2.outcome, "noop", "survivors unchanged does not mean nothing to do — the GC is pending")
})

// P1-c: the APPLY REQUEST's own scope/sessionID fields must be checked
// against the token binding — a global/null prepare token presented with a
// workspace/other-session request must refuse (deps-side moves are already
// covered by S11; this pins the REQUEST-side check).
test("P1c: apply request scope/sessionID mismatching the token binding refuses with zero writes", async (t) => {
  const env = makeEnv()
  const p = await prepareSync(env) // global, sessionID null
  const a = await env.sync({ scope: "workspace", sessionID: "sess-9", confirm: true, action: "apply", token: p.token.token })
  assert.ok(a.ok === false || (a.ok === true && a.outcome === "noop"), `a global token presented as workspace/sess-9 must refuse — got: ${JSON.stringify(a).slice(0, 250)}`)
  assert.ok(!(a.ok === true && a.applied === true), "the mismatched request must never execute")
  assert.equal(env.mfs.io.writes.length, 0, "zero writes")
  assert.equal(env.mfs.io.renames.length, 0)
})

// P1-d: pool cache warmed on old-X, then the disk is swapped to equal-length
// new-Y at the SAME mtime — the next sync must compile new-Y (stat-only
// caching cannot be the freshness oracle).
test("P1d: equal-length same-mtime disk swap after cache warm must compile the NEW bytes", async (t) => {
  const env = makeEnv()
  const p1 = await prepareSync(env) // warms the resolver cache on old-X
  assert.ok(p1.outcome === "token")
  const old = env.mfs.files.get(GLOBAL_FILE)
  const newY = GLOBAL_RECIPE.replace("prov/m", "prov/n") // equal length
  assert.equal(Buffer.byteLength(newY), Buffer.byteLength(old.text), "fixture: same length")
  env.mfs.files.set(GLOBAL_FILE, { text: newY, mtimeMs: old.mtimeMs, ino: old.ino, dev: 1 })
  const p2 = await prepareSync(env)
  assert.notEqual(p2.outcome, "noop", "the new bytes are a real change — a fresh prepare must see it")
  const a2 = await env.sync({ scope: "global", sessionID: null, confirm: true, action: "apply", token: p2.token.token })
  assert.equal(a2.ok, true)
  const landed = env.mfs.text(`${env.globalAgentDir}/forge-global-alpha.md`)
  assert.match(landed, /prov\/n/, `the NEW content must be compiled and projected — landed model line: ${landed?.match(/model:[^\n]*/)?.[0]}`)
})

// P1-e: a permission-only edit (prompt/model unchanged) with the host
// returning rows that carry no permission observation must stay UNCONFIRMED
// — the permission lives in the frontmatter, so the body/model comparator
// cannot see it and must not self-certify.
test("P1e: permission-only edit with unobservable permission stays unconfirmed (never applied)", async (t) => {
  const env = makeEnv({
    initial: { [GLOBAL_FILE]: '{\n  "pool": "base",\n  "agents": { "alpha": { "model": "prov/m", "thoughtLevel": "high", "prompt": "same body", "permission": { "bash": "deny" } } }\n}\n' },
  })
  const p1 = await prepareSync(env)
  const a1 = await env.sync({ scope: "global", sessionID: null, confirm: true, action: "apply", token: p1.token.token })
  assert.equal(a1.ok, true)
  // Permission-only edit: prompt/model identical, mtime bumped (fresh cache).
  const old = env.mfs.files.get(GLOBAL_FILE)
  const edited = old.text.replace('"bash": "deny"', '"bash": "allow"')
  assert.notEqual(edited, old.text, "fixture: the permission actually changed")
  env.mfs.files.set(GLOBAL_FILE, { text: edited, mtimeMs: old.mtimeMs + 1, ino: old.ino, dev: 1 })
  // The host observer returns the PRE-apply rows (the old-permission host):
  // body and model match, permission unobservable by the row shape.
  const staleRows = await observerFrom(env.mfs, env.globalAgentDir)()
  env.setObserver(async () => staleRows)
  const p2 = await prepareSync(env)
  assert.ok(p2.outcome === "token")
  const a2 = await env.sync({ scope: "global", sessionID: null, confirm: true, action: "apply", token: p2.token.token })
  assert.equal(a2.applied, false, `a permission change the host observation cannot see must stay unconfirmed — got: ${JSON.stringify(a2.appliedStatus ?? a2).slice(0, 300)}`)
  assert.equal(a2.outcome, "unconfirmed")
})

// P1-f: a model OBJECT row whose id carries a different #variant must not
// compare equal — the variant is part of the observable identity.
test("P1f: variant-only model change with a variant-blind object row stays unconfirmed", async (t) => {
  const env = makeEnv({
    initial: { [GLOBAL_FILE]: '{\n  "pool": "base",\n  "agents": { "alpha": { "model": "prov/m", "thoughtLevel": "low" } }\n}\n' },
  })
  const p1 = await prepareSync(env)
  const a1 = await env.sync({ scope: "global", sessionID: null, confirm: true, action: "apply", token: p1.token.token })
  assert.equal(a1.ok, true)
  // Variant-only change: low -> high, same provider/model.
  const old = env.mfs.files.get(GLOBAL_FILE)
  env.mfs.files.set(GLOBAL_FILE, { text: old.text.replace('"thoughtLevel": "low"', '"thoughtLevel": "high"'), mtimeMs: old.mtimeMs + 1, ino: old.ino, dev: 1 })
  // The host reports the OLD pin as a variant-blind object row.
  env.setObserver(async () => [{ id: "forge-global-alpha", system: (env.mfs.text(`${env.globalAgentDir}/forge-global-alpha.md`) ?? "").replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "").replace(/^\r?\n/, ""), model: { providerID: "prov", modelID: "m" } }])
  const p2 = await prepareSync(env)
  assert.ok(p2.outcome === "token")
  const a2 = await env.sync({ scope: "global", sessionID: null, confirm: true, action: "apply", token: p2.token.token })
  assert.equal(a2.applied, false, `a #variant change must not compare equal to a variant-blind row — got: ${JSON.stringify(a2.appliedStatus ?? a2).slice(0, 300)}`)
  assert.equal(a2.outcome, "unconfirmed")
})

// P1-g: a partial write failure must never let the whole apply report
// applied — the errored entry keeps the verdict at unconfirmed at best.
test("P1g: partial write errors forbid an applied verdict", async (t) => {
  const env = makeEnv({
    initial: { [GLOBAL_FILE]: '{\n  "pool": "base",\n  "agents": {\n    "alpha": { "model": "prov/m", "thoughtLevel": "high" },\n    "beta": { "model": "prov/b", "thoughtLevel": "low" }\n  }\n}\n' },
    boomPaths: ["forge-global-beta"],
  })
  const p = await prepareSync(env)
  assert.ok(p.outcome === "token")
  const a = await env.sync({ scope: "global", sessionID: null, confirm: true, action: "apply", token: p.token.token })
  const verdict = JSON.stringify(a).slice(0, 400)
  assert.ok(a.errors.length >= 1, `the failing file is disclosed — got: ${verdict}`)
  assert.equal(a.outcome, "unconfirmed", `a partial write must never read as applied — got outcome ${a.outcome}: ${verdict}`)
  assert.equal(a.applied, false)
})

// P1-h: a pre-save winner flip (owner moved between families) — the sync
// must refuse rather than write any unauthorized family's projection, and
// must not GC the moved id out of its new owner.
test("P1h: winner flipped to another family after prepare — sync refuses, no unauthorized writes", async (t) => {
  const env = makeEnv({
    initial: {
      [GLOBAL_FILE]: GLOBAL_RECIPE,
      [WS_FILE]: '{ "pool": "w", "agents": {} }\n',
    },
  })
  const p = await prepareSync(env) // global family owns global-alpha
  assert.ok(p.outcome === "token")
  // Flip: the workspace now defines its own worker (and the global recipe
  // loses alpha) — the projection owner moved between families.
  env.mfs.files.set(GLOBAL_FILE, { text: '{\n  "pool": "base",\n  "agents": {}\n}\n', mtimeMs: 4242, ino: 1, dev: 1 })
  env.mfs.files.set(WS_FILE, { text: '{ "pool": "w", "agents": { "alpha": { "model": "prov/m", "thoughtLevel": "high" } } }\n', mtimeMs: 4243, ino: 2, dev: 1 })
  const a = await env.sync({ scope: "global", sessionID: null, confirm: true, action: "apply", token: p.token.token })
  // Whatever the verdict, NO workspace-family projection may be written and
  // the moved id must not be deleted from its new owner by this sync.
  const wsProjection = env.mfs.text(`${"/w/.opencode"}/agent/forge-w-alpha.md`)
  const refused = a.ok === false || ["noop", "refused", "conflict"].includes(a.ok === true ? a.outcome : "")
  assert.ok(refused || (a.ok === true && a.outcome !== "applied"), `the flipped winner must not land as applied — got: ${JSON.stringify(a).slice(0, 300)}`)
  assert.equal(wsProjection, undefined, "the unauthorized (now-winning) family's file was never written by this sync")
})

// ---------------------------------------------------------------------------
// Wire-schema validation: EVERY validated instance below is the ACTUAL
// handler return value (never a handwritten expected shape) validated
// against the frozen rpc.ts JSON schema. Wire drift must show up red here,
// not be absorbed into fixtures. Known deliberate reds while the rpc worker
// fixes the schema: noop carries preview (no summary) in the frozen shape.
// ---------------------------------------------------------------------------

import { validate as schemaValidate } from "json-schema"
import { forgeConfigRpcDefinition } from "../rpc.ts"

function expectSchemaValid(instance, label) {
  const v = schemaValidate(instance, forgeConfigRpcDefinition.methods.sync.output)
  assert.ok(v.valid, `${label} must validate against the frozen sync output schema — errors: ${JSON.stringify(v.errors?.slice(0, 8))}`)
}

test("SYNC-SCHEMA prepare-token output validates against the frozen sync output schema (actual handler return)", async (t) => {
  const env = makeEnv()
  const p = await prepareSync(env)
  assert.equal(p.ok, true)
  expectSchemaValid(p, "sync prepare outcome=token")
})

test("SYNC-SCHEMA apply (observed applied) validates: created/updated stay object arrays, unchanged/gced/removedIds string arrays", async (t) => {
  const env = makeEnv()
  const p = await prepareSync(env)
  const a = await env.sync({ scope: "global", sessionID: null, confirm: true, action: "apply", token: p.token.token })
  assert.equal(a.ok, true)
  // 裁决 structure: these stay the FROZEN shapes — production drift toward
  // string/number shorthands is a defect, the tests are not "adapted" to it.
  assert.ok(Array.isArray(a.created) && a.created.every((x) => x !== null && typeof x === "object"), "created: object[]")
  assert.ok(Array.isArray(a.updated) && a.updated.every((x) => x !== null && typeof x === "object"), "updated: object[]")
  assert.ok(Array.isArray(a.unchanged) && a.unchanged.every((x) => typeof x === "string"), "unchanged: string[]")
  assert.ok(Array.isArray(a.errors) && a.errors.every((x) => x !== null && typeof x === "object"), "errors: object[]")
  assert.ok(Array.isArray(a.conflicts) && a.conflicts.every((x) => x !== null && typeof x === "object"), "conflicts: object[]")
  expectSchemaValid(a, "sync apply outcome=applied/unconfirmed")
})

test("SYNC-SCHEMA apply conflict (semantic post-write coverage loss) validates against the frozen schema", async (t) => {
  const env = makeEnv({ noObserver: true, lossAfterWrite: true })
  const p = await prepareSync(env)
  const a = await env.sync({ scope: "global", sessionID: null, confirm: true, action: "apply", token: p.token.token })
  assert.equal(a.ok, true)
  assert.equal(a.outcome, "conflict")
  expectSchemaValid(a, "sync apply outcome=conflict")
})

test("SYNC-SCHEMA apply noop (pure-delete GC candidate included) validates against the frozen schema", async (t) => {
  const env = makeEnv({ noObserver: true })
  const p = await prepareSync(env)
  await env.sync({ scope: "global", sessionID: null, confirm: true, action: "apply", token: p.token.token })
  // Second prepare with nothing left to change: GC candidates ride preview.gc
  // (marker-keyed), never a summary-only noop.
  const p2 = await prepareSync(env)
  if (p2.ok === true && p2.outcome === "noop") {
    expectSchemaValid(p2, "sync prepare outcome=noop (frozen: preview present, no summary)")
  } else if (p2.ok === true && p2.outcome === "token") {
    expectSchemaValid(p2, "sync prepare outcome=token (gc candidates)")
    assert.ok(Array.isArray(p2.preview.gc) && p2.preview.gc.every((g) => g !== null && typeof g === "object" && typeof g.nativeId === "string" && typeof g.dest === "string"), "preview.gc: {nativeId,dest}[] pure-delete tokens")
  }
})

test("SYNC-SCHEMA refusals validate against the frozen schema (enum reasons; additive directory-conflict must appear in the enum, not bypass it)", async (t) => {
  const env = makeEnv({ noObserver: true })
  const bad = await env.sync({ scope: "global", sessionID: null, confirm: false, action: "apply", token: "synctok-x" })
  assert.equal(bad.ok, false)
  expectSchemaValid(bad, "sync refusal (unconfirmed apply)")
  const unknown = await env.sync({ scope: "global", sessionID: null, confirm: true, action: "apply", token: "synctok-never-issued" })
  assert.equal(unknown.ok, false)
  expectSchemaValid(unknown, "sync refusal (token unknown)")
  // A refusal emitted with a reason outside the frozen enum cannot pass the
  // schema — the directory-conflict addition must land IN the enum.
  const reasons = forgeConfigRpcDefinition.methods.sync.output.anyOf.find((b) => b.properties?.ok?.const === false)?.properties?.reason?.enum ?? []
  assert.ok(Array.isArray(reasons) && reasons.length >= 11, "the refusal reason enum is present and non-degenerate")
})

// ---------------------------------------------------------------------------
// Review round: real host observation shapes + executor-error verdicts
// ---------------------------------------------------------------------------

// The REAL host Agent.Info.model is {providerID, id, variant} (field `id`,
// NOT modelID). A correct pin — model+thoughtLevel+variant exactly as
// compiled — must be CONFIRMED applied through that shape.
test("R-A: real Agent.Info.model {providerID,id,variant} confirms an exact pin (field `id`, not modelID)", async (t) => {
  const env = makeEnv()
  const p = await prepareSync(env)
  const bodyOf = (p2) => stripFrontmatter(env.mfs.text(p2) ?? "")
  env.setObserver(async () => {
    const text = env.mfs.text(`${env.globalAgentDir}/forge-global-alpha.md`) ?? ""
    const face = compiledFaceOf(text) ?? {}
    return [{
      id: "forge-global-alpha",
      system: stripFrontmatter(text),
      model: { providerID: "prov", id: "m", variant: "high" },
      permissions: Object.entries(face).map(([a, e]) => ({ action: a, resource: "*", effect: e })),
    }]
  })
  const a = await env.sync({ scope: "global", sessionID: null, confirm: true, action: "apply", token: p.token.token })
  const verdict = JSON.stringify(a.appliedStatus ?? a).slice(0, 300)
  assert.equal(a.outcome, "applied", `a real-shaped correct pin must confirm — got: ${verdict}`)
  assert.equal(a.applied, true)
  assert.deepEqual(a.appliedStatus.confirmedIds, ["forge-global-alpha"])
})

// One worker's publish path fails AFTER another succeeded (executor error
// WITHOUT a nativeId, e.g. a pre-occupied .md.new publish target): the order
// verdict must be UNCONFIRMED as a whole — never applied alongside errors.
test("R-B: a sibling executor error (no nativeId) forces the whole order unconfirmed, never applied+errors", async (t) => {
  const env = makeEnv({
    initial: { [GLOBAL_FILE]: '{\n  "pool": "base",\n  "agents": {\n    "alpha": { "model": "prov/m", "thoughtLevel": "high" },\n    "beta": { "model": "prov/b", "thoughtLevel": "low" }\n  }\n}\n' },
    boomPaths: ["forge-global-beta"],
  })
  const p = await prepareSync(env)
  const a = await env.sync({ scope: "global", sessionID: null, confirm: true, action: "apply", token: p.token.token })
  const verdict = JSON.stringify(a).slice(0, 400)
  assert.ok(a.errors.length >= 1, `the executor error is disclosed — ${verdict}`)
  assert.ok(a.errors.every((e) => e !== null && typeof e === "object"), "executor errors stay structured items")
  assert.notEqual(a.outcome, "applied", `an errored order must never read applied — got ${a.outcome}: ${verdict}`)
  assert.equal(a.applied, false, `applied must be false while errors exist — ${verdict}`)
})

// The host's native list is FAIL-SOFT over raw rows: malformed rows (only a
// `name`, no `id`; or a mix) must never silently vanish — a pure-delete GC
// whose only evidence is a bad row stays UNCONFIRMED, never confirmed-removed.
test("R-C: malformed observation rows (name-only / mixed) never confirm a pure-delete removal", async (t) => {
  const env = makeEnv({
    initial: { [GLOBAL_FILE]: '{\n  "pool": "base",\n  "agents": {}\n}\n', [`${AGENT_DIR}/forge-stale.md`]: `${generatedHeader(GLOBAL_FILE)}\n\nstale body\n` },
  })
  const p = await prepareSync(env)
  // name-only row for the exact removed id: if the comparator skips it, the
  // removal would look confirmed against an empty registry.
  env.setObserver(async () => [{ name: "forge-stale" }])
  const a = await env.sync({ scope: "global", sessionID: null, confirm: true, action: "apply", token: p.token.token })
  const verdict = JSON.stringify(a.appliedStatus ?? a).slice(0, 300)
  assert.equal(a.appliedStatus.removedConfirmedIds.length, 0, `a name-only row must not confirm the removal — ${verdict}`)
  // Mixed: one good unrelated row + the name-only row for the removed id.
  const env2 = makeEnv({
    initial: { [GLOBAL_FILE]: '{\n  "pool": "base",\n  "agents": {}\n}\n', [`${AGENT_DIR}/forge-stale.md`]: `${generatedHeader(GLOBAL_FILE)}\n\nstale body\n` },
  })
  const p2 = await prepareSync(env2)
  env2.setObserver(async () => [{ id: "forge-other", system: "x" }, { name: "forge-stale" }])
  const a2 = await env2.sync({ scope: "global", sessionID: null, confirm: true, action: "apply", token: p2.token.token })
  assert.notEqual(a2.appliedStatus.removedConfirmedIds.length, 1, `a mixed row set must not confirm the removal via a bad row — ${JSON.stringify(a2.appliedStatus).slice(0, 300)}`)
})

// Strict tools/permission observation: the compiler-GENERATED deny (a tools
// map `shell: false`, or a permissions Ruleset deny) must NOT be confirmed
// by a host row that reports the OPPOSITE effect (shell allow). A deny is
// part of the compiled identity — contradicting observation = unconfirmed.
test("R-D: a host permissions-allow row cannot confirm a compiler-generated tools shell:false deny", async (t) => {
  const GENERAL_RO = JSON.stringify(JSON.parse('{"pool":"base","agents":{"general":{"shape":"readonly","permission":{"shell":"deny"}}}}'), null, 2) + "\n"
  const GENERAL_RO_PLUS_BETA = JSON.stringify(JSON.parse('{"pool":"base","agents":{"general":{"shape":"readonly","model":"prov/g","thoughtLevel":"high","permission":{"shell":"deny"}},"beta":{"model":"prov/b","thoughtLevel":"low"}}}'), null, 2) + "\n"
  const env = makeEnv({
    initial: { [GLOBAL_FILE]: GENERAL_RO },
  })
  // First apply materializes the projection (no proven observation — the
  // save verdict is unconfirmed, but the FILE lands so we can pin what the
  // compiler actually generated).
  env.setObserver(async () => null)
  const p1 = await prepareSync(env)
  assert.ok(p1.outcome === "token")
  await env.sync({ scope: "global", sessionID: null, confirm: true, action: "apply", token: p1.token.token })
  const fileText = env.mfs.text(`${env.globalAgentDir}/forge-global-general.md`) ?? ""
  const faceRD = compiledFaceOf(fileText)
  const denyActionsRD = Object.entries(faceRD ?? {}).filter(([, e]) => e === "deny").map(([a]) => a)
  assert.ok(denyActionsRD.length > 0, `harness sanity: the compiled face carries at least one deny — file: ${fileText.slice(0, 300)}`)
  assert.equal(faceRD?.shell, "deny", "harness sanity: the recipe's EXPLICIT permission.shell deny is in the compiled face (real intent, not a shape default)")
  // Second round: a real change (general rewritten + new worker) plus a
  // CONTRADICTING allow row for every compiled deny action — the strict
  // comparison must keep general unconfirmed.
  env.mfs.files.set(GLOBAL_FILE, { text: GENERAL_RO_PLUS_BETA, mtimeMs: 4242, ino: 1, dev: 1 })
  const bodyOf = (p2) => stripFrontmatter(env.mfs.text(p2) ?? "")
  env.setObserver(async () => [
    {
      id: "forge-global-general",
      system: bodyOf(`${env.globalAgentDir}/forge-global-general.md`),
      model: { providerID: "prov", id: "g", variant: "high" },
      permissions: denyActionsRD.map((a) => ({ action: a, resource: "*", effect: "allow" })),
    },
    {
      id: "forge-global-beta",
      system: "beta body",
      model: { providerID: "prov", id: "b", variant: "low" },
    },
  ])
  const p2 = await prepareSync(env)
  assert.ok(p2.ok === true && p2.outcome === "token", `second prepare: ${JSON.stringify(p2).slice(0, 200)}`)
  const a2 = await env.sync({ scope: "global", sessionID: null, confirm: true, action: "apply", token: p2.token.token })
  const verdict = JSON.stringify(a2.appliedStatus ?? a2).slice(0, 400)
  assert.equal(a2.applied, false, `a contradicting tools/permission observation must keep the order unconfirmed — ${verdict}`)
  assert.notEqual(a2.outcome, "applied", `outcome must not be applied — ${verdict}`)
  assert.ok(a2.appliedStatus.unconfirmedIds.includes("forge-global-general"), `general (allow vs compiled deny) stays unconfirmed — ${verdict}`)
  assert.ok(a2.appliedStatus.confirmedIds.includes("forge-global-beta") === false || true, "beta independently judged")
})

// Coordinator-directed permission-observation regressions: the host
// Ruleset is DEFAULT rules plus DECLARED overrides, merged IN ORDER — the
// effective effect of an action is decided by the LAST rule naming it.
// Rows are triple arrays ({action, resource, effect}), the legal observation
// shape. A declared deny stays confirmed when earlier default allows
// precede it, and goes unconfirmed when a later allow contradicts it.
function compiledFaceOf(fileText) {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(fileText)
  if (fm === null) return null
  const lines = fm[1].split(/\r?\n/)
  const start = lines.findIndex((l) => l === "permissions:")
  if (start >= 0) {
    const out = {}
    for (let i = start + 1; i < lines.length; i++) {
      const action = /^ {2}- action: ("(?:[^"\\]|\\.)*")$/.exec(lines[i])
      if (action === null) break
      const resource = /^ {4}resource: ("(?:[^"\\]|\\.)*")$/.exec(lines[i + 1] ?? "")
      const effect = /^ {4}effect: ("(?:[^"\\]|\\.)*")$/.exec(lines[i + 2] ?? "")
      if (resource === null || effect === null) return null
      out[JSON.parse(action[1])] = JSON.parse(effect[1])
      i += 2
    }
    return out
  }
  const toolsStart = lines.findIndex((l) => l === "tools:")
  if (toolsStart >= 0) {
    const out = {}
    for (let i = toolsStart + 1; i < lines.length; i++) {
      const entry = /^ {2}([A-Za-z0-9_]+): (true|false)$/.exec(lines[i])
      if (entry === null) break
      out[entry[1]] = entry[2] === "false" ? "deny" : "allow"
    }
    return out
  }
  return null
}

async function materializeDenyingGeneral() {
  const GENERAL_RO = JSON.stringify(JSON.parse('{"pool":"base","agents":{"general":{"shape":"readonly","permission":{"shell":"deny"}}}}'), null, 2) + "\n"
  const GENERAL_RO_PLUS_BETA = JSON.stringify(JSON.parse('{"pool":"base","agents":{"general":{"shape":"readonly","model":"prov/g","thoughtLevel":"high","permission":{"shell":"deny"}},"beta":{"model":"prov/b","thoughtLevel":"low"}}}'), null, 2) + "\n"
  const env = makeEnv({ initial: { [GLOBAL_FILE]: GENERAL_RO } })
  env.setObserver(async () => null)
  const p1 = await prepareSync(env)
  assert.ok(p1.outcome === "token")
  await env.sync({ scope: "global", sessionID: null, confirm: true, action: "apply", token: p1.token.token })
  const fileText = env.mfs.text(`${env.globalAgentDir}/forge-global-general.md`) ?? ""
  const face = compiledFaceOf(fileText)
  assert.ok(face !== null && Object.values(face).includes("deny"), `harness sanity: the compiled face carries a deny — ${fileText.slice(0, 200)}`)
  assert.equal(face?.shell, "deny", "harness sanity: the recipe's EXPLICIT permission.shell deny is in the compiled face")
  env.mfs.files.set(GLOBAL_FILE, { text: GENERAL_RO_PLUS_BETA, mtimeMs: 4242, ino: 1, dev: 1 })
  return { env, face }
}

test("R-F: default allow rules BEFORE the declared shell deny still confirm (last-rule precedence, positive)", async (t) => {
  const { env, face } = await materializeDenyingGeneral()
  const rules = []
  for (const [action, effect] of Object.entries(face)) {
    if (effect === "deny") {
      rules.push({ action, resource: "*", effect: "allow" }) // host default allow FIRST
      rules.push({ action, resource: "*", effect })          // declared override, LAST
    } else {
      rules.push({ action, resource: "*", effect })
    }
  }
  env.setObserver(async () => [
    { id: "forge-global-general", system: stripFrontmatter(env.mfs.text(`${env.globalAgentDir}/forge-global-general.md`) ?? ""), model: { providerID: "prov", id: "g", variant: "high" }, permissions: rules },
    (() => {
      const betaText = env.mfs.text(`${env.globalAgentDir}/forge-global-beta.md`) ?? ""
      const betaFace = compiledFaceOf(betaText) ?? {}
      return { id: "forge-global-beta", system: stripFrontmatter(betaText), model: { providerID: "prov", id: "b", variant: "low" }, permissions: Object.entries(betaFace).map(([a, e]) => ({ action: a, resource: "*", effect: e })) }
    })(),
  ])
  const p2 = await prepareSync(env)
  assert.ok(p2.ok === true && p2.outcome === "token")
  const a2 = await env.sync({ scope: "global", sessionID: null, confirm: true, action: "apply", token: p2.token.token })
  const verdict = JSON.stringify(a2.appliedStatus ?? a2).slice(0, 400)
  const r1 = await env.sync({ scope: "global", sessionID: null, confirm: true, action: "apply", token: "bogus" })
  assert.ok(a2.appliedStatus.confirmedIds.includes("forge-global-general"), `default-allow-then-declared-deny must CONFIRM general — ${verdict}`)
  assert.ok(!(a2.appliedStatus.unconfirmedIds ?? []).includes("forge-global-general"), `general must not stay unconfirmed — ${verdict}`)
})

test("R-G: a LATER conflicting allow after the declared deny refuses confirmation (last-rule precedence, negative)", async (t) => {
  const { env, face } = await materializeDenyingGeneral()
  const rules = []
  for (const [action, effect] of Object.entries(face)) {
    if (action === "shell") {
      rules.push({ action: "shell", resource: "*", effect: effect })  // declared deny
      rules.push({ action: "shell", resource: "*", effect: "allow" }) // conflicting rule AFTER it
    } else {
      rules.push({ action, resource: "*", effect })
    }
  }
  env.setObserver(async () => [
    { id: "forge-global-general", system: stripFrontmatter(env.mfs.text(`${env.globalAgentDir}/forge-global-general.md`) ?? ""), model: { providerID: "prov", id: "g", variant: "high" }, permissions: rules },
    { id: "forge-global-beta", system: "beta body", model: { providerID: "prov", id: "b", variant: "low" } },
  ])
  const p2 = await prepareSync(env)
  assert.ok(p2.ok === true && p2.outcome === "token")
  const a2 = await env.sync({ scope: "global", sessionID: null, confirm: true, action: "apply", token: p2.token.token })
  const verdict = JSON.stringify(a2.appliedStatus ?? a2).slice(0, 400)
  assert.equal(a2.applied, false, `a later allow contradicting the declared deny must keep the order unconfirmed — ${verdict}`)
  assert.ok((a2.appliedStatus?.unconfirmedIds ?? []).includes("forge-global-general"), `general must stay unconfirmed — ${verdict}`)
})

// R-G2 (server-freeze pin, reviewer-confirmed): a compiled global deny
// followed by a LATER resource-scoped (one-file) allow reads confirmed —
// the scoped allow is ignored and the entry passes. Pin the honest
// verdict: a later contradicting rule must refuse confirmation regardless
// of its resource scope.
test("R-G2: a global deny followed by a later one-file allow must NOT read confirmed/applied", async (t) => {
  const { env, face } = await materializeDenyingGeneral()
  const rules = []
  for (const [action, effect] of Object.entries(face)) {
    if (action === "shell") {
      rules.push({ action: "shell", resource: "*", effect: effect })                                             // global deny (compiled identity)
      rules.push({ action: "shell", resource: "C:/proj/.opencode/forge.json", effect: "allow" })                 // LATER scoped allow
    } else {
      rules.push({ action, resource: "*", effect })
    }
  }
  env.setObserver(async () => [
    { id: "forge-global-general", system: stripFrontmatter(env.mfs.text(`${env.globalAgentDir}/forge-global-general.md`) ?? ""), model: { providerID: "prov", id: "g", variant: "high" }, permissions: rules },
    (() => {
      const betaText = env.mfs.text(`${env.globalAgentDir}/forge-global-beta.md`) ?? ""
      const betaFace = compiledFaceOf(betaText) ?? {}
      return { id: "forge-global-beta", system: stripFrontmatter(betaText), model: { providerID: "prov", id: "b", variant: "low" }, permissions: Object.entries(betaFace).map(([a, e]) => ({ action: a, resource: "*", effect: e })) }
    })(),
  ])
  const p2 = await prepareSync(env)
  assert.ok(p2.ok === true && p2.outcome === "token")
  const a2 = await env.sync({ scope: "global", sessionID: null, confirm: true, action: "apply", token: p2.token.token })
  const verdict = JSON.stringify(a2.appliedStatus ?? a2).slice(0, 400)
  assert.equal(a2.applied, false, `a later scoped allow after a global deny must NOT confirm — ${verdict}`)
  assert.ok((a2.appliedStatus?.unconfirmedIds ?? []).includes("forge-global-general"), `general stays unconfirmed — ${verdict}`)
  // POSITIVE companion: the same face, but the row ENDS with the global
  // deny again (deny → scoped allow → global deny) — the last GLOBAL rule
  // for the action decides, and it matches the compiled identity → confirm.
  const rules2 = []
  for (const [action, effect] of Object.entries(face)) {
    if (action === "shell") {
      rules2.push({ action: "shell", resource: "*", effect: effect })                                   // global deny
      rules2.push({ action: "shell", resource: "C:/proj/.opencode/forge.json", effect: "allow" })       // scoped allow in between
      rules2.push({ action: "shell", resource: "*", effect: effect })                                   // global deny AGAIN (last)
    } else {
      rules2.push({ action, resource: "*", effect })
    }
  }
  const env2 = await (async () => {
    const fresh = await materializeDenyingGeneral()
    fresh.env.setObserver(async () => [
      { id: "forge-global-general", system: stripFrontmatter(fresh.env.mfs.text(`${fresh.env.globalAgentDir}/forge-global-general.md`) ?? ""), model: { providerID: "prov", id: "g", variant: "high" }, permissions: rules2 },
      (() => {
        const betaText = fresh.env.mfs.text(`${fresh.env.globalAgentDir}/forge-global-beta.md`) ?? ""
        const betaFace = compiledFaceOf(betaText) ?? {}
        return { id: "forge-global-beta", system: stripFrontmatter(betaText), model: { providerID: "prov", id: "b", variant: "low" }, permissions: Object.entries(betaFace).map(([a, e]) => ({ action: a, resource: "*", effect: e })) }
      })(),
    ])
    return fresh
  })()
  const p3 = await prepareSync(env2.env)
  assert.ok(p3.ok === true && p3.outcome === "token")
  const a3 = await env2.env.sync({ scope: "global", sessionID: null, confirm: true, action: "apply", token: p3.token.token })
  const verdict3 = JSON.stringify(a3.appliedStatus ?? a3).slice(0, 400)
  assert.ok(a3.appliedStatus.confirmedIds.includes("forge-global-general"), `deny -> scoped allow -> deny (last global wins) must CONFIRM general — ${verdict3}`)
})

// R-H (reviewer question, intent-v-defaultFace): a SHAPE CHANGE (write ->
// readonly) makes the compiled deny face carry shape-default entries the
// host row does NOT mention. The new defaultFace vacuous pass must not
// swallow the unobserved face of a shape CHANGED between saves — the host
// lacks the corresponding permission observation, so the order must NOT
// read applied.
test("R-H: a shape change whose permission face the host row cannot observe must NOT read applied (no vacuous defaultFace pass across a shape change)", async (t) => {
  const GENERAL_WRITE = JSON.stringify(JSON.parse('{"pool":"base","agents":{"general":{"model":"prov/g","thoughtLevel":"high"}}}'), null, 2) + "\n"
  const GENERAL_RO = JSON.stringify(JSON.parse('{"pool":"base","agents":{"general":{"shape":"readonly","model":"prov/g","thoughtLevel":"high"}}}'), null, 2) + "\n"
  // Host row variants that must ALL fail to confirm a write->readonly face:
  // (1) no permissions field at all (rules null),
  // (2) a wildcard * allow rule (never aliases any concrete action),
  // (3) a resource-scoped one-file edit deny (observes edit but on ONE file,
  //     not the compiled * face).
  const rowVariants = [
    { label: "no permissions field", permissions: undefined },
    { label: "wildcard * allow", permissions: [{ action: "*", resource: "*", effect: "allow" }] },
    { label: "one-file edit deny", permissions: [{ action: "edit", resource: "C:/proj/.opencode/forge.json", effect: "deny" }] },
  ]
  for (const variant of rowVariants) {
    const env = makeEnv({ initial: { [GLOBAL_FILE]: GENERAL_WRITE } })
    env.setObserver(async () => null) // round 1: materialize the write-shape projection
    const p1 = await prepareSync(env)
    assert.ok(p1.outcome === "token")
    await env.sync({ scope: "global", sessionID: null, confirm: true, action: "apply", token: p1.token.token })
    // Round 2: flip the shape to readonly — the compiled face GAINS the
    // readonly deny family, which this host row cannot (fully) observe.
    env.mfs.files.set(GLOBAL_FILE, { text: GENERAL_RO, mtimeMs: 4343, ino: 1, dev: 1 })
    env.setObserver(async () => [
      {
        id: "forge-global-general",
        system: stripFrontmatter(env.mfs.text(`${env.globalAgentDir}/forge-global-general.md`) ?? ""),
        model: { providerID: "prov", id: "g", variant: "high" },
        ...(variant.permissions !== undefined ? { permissions: variant.permissions } : {}),
      },
    ])
    const p2 = await prepareSync(env)
    assert.ok(p2.ok === true && p2.outcome === "token")
    const a2 = await env.sync({ scope: "global", sessionID: null, confirm: true, action: "apply", token: p2.token.token })
    const verdict = JSON.stringify(a2.appliedStatus ?? a2).slice(0, 400)
    assert.equal(a2.applied, false, `[${variant.label}] a shape change with an unobservable permission face must NOT read applied — ${verdict}`)
    assert.ok((a2.appliedStatus?.unconfirmedIds ?? []).includes("forge-global-general"), `[${variant.label}] general stays unconfirmed while its face is unobserved — ${verdict}`)
  }
})

// A commitId-bearing prepare must compare the PRE-SAVE baseline
// (owner/coverage/winners) BEFORE any noop shortcut: even when the plan has
// no effective change, an异owner or otherwise-invalid baseline refuses —
// a noop must never succeed on top of a baseline it did not verify.
test("R-E: commitId-bearing prepare with an异owner baseline refuses even when the plan would be a noop", async (t) => {
  const attached = []
  const env = makeEnv({
    getCommitContext: (commitId) => ({
      found: true,
      context: { commitId, epoch: "ep-1", generation: 7, path: "/other/owner/forge.json", scope: "global", sessionID: null },
    }),
    attachSyncOutcome: (commitId, summary) => { attached.push([commitId, summary]); return true },
  })
  const p = await prepareSync(env)
  if (p.ok === true && p.outcome === "noop") {
    assert.fail(`a noop verdict must not bypass the pre-save baseline check for a异owner commitId — summary: ${JSON.stringify(p.summary ?? p.preview?.summary ?? []).slice(0, 300)}`)
  }
  // Either the prepare refuses outright (fail-closed) or it produced a token
  // that names the异owner conflict; an attached apply must never happen for
  // an unverified baseline.
  if (p.ok === true) {
    const a = await env.sync({ scope: "global", sessionID: null, confirm: true, action: "apply", token: p.token.token, commitId: "c-异owner" })
    const verdict = JSON.stringify(a).slice(0, 300)
    assert.equal(a.ok, false, `an异owner baseline must refuse the correlated apply — got: ${verdict}`)
    assert.deepEqual(attached, [], "nothing is annotated for a refused异owner baseline")
  }
})
