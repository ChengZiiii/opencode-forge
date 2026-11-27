import test from "node:test"
import assert from "node:assert/strict"

// forge-tui-subagent-config — contract tests for the pure recipe editing core
// (design D4; landed src/forge-config-edit.ts + src/jsonc-edit.ts). Data in,
// data out: fs deps injected, no real disk, no clock.

import * as FCE from "../src/forge-config-edit.ts"
import { parseForgeJsonc, validateAgentSet, validateOverrideNode } from "../src/forge-config.ts"

// ---------------------------------------------------------------------------
// Direct single-signature bindings (NO compatibility shim): the tests bind
// the ACTUAL final API and are updated in lockstep with the modules.
//   snapshot: {path, exists, readable, raw, stat, parse}
//   plan op:  {action, id, draft?, renameTo?}
//   plan ok:  {plan:{kind, action, path, container, id, newText, summary}}
//   commit:   commitRecipeEdit(snapshot, {kind, path, newText}, deps)
//             -> {ok, outcome: "written"|"no-op", bytes}
// ---------------------------------------------------------------------------

export const { withCommitLock } = FCE
export const snapshotRecipe = FCE.snapshotRecipe
export const planWorkerEdit = FCE.planWorkerEdit
export const planOverrideEdit = FCE.planOverrideEdit

// Commit with the FINAL three-argument signature; the plan comes from the
// plan result verbatim (kind + newText are the final field names).
const commit = (snap, res, deps = {}) =>
  FCE.commitRecipeEdit(snap, { kind: res.plan.kind, path: snap.path, newText: res.plan.newText }, deps)
const commitDeps = commit

// ---------------------------------------------------------------------------
// Fixture helpers (injected fs)
// ---------------------------------------------------------------------------
function memFs(files, opts = {}) {
  const state = { ...files } // path -> raw string
  const identities = new Map(Object.entries(files).map(([p, raw]) => [p, { mtimeMs: 100, size: raw.length }]))
  const writes = [] // audit log: every write/rename/unlink
  const fs = {
    stat: (p) => identities.get(p) ?? null,
    readFile: (p) => {
      if (!(p in state)) throw new Error(`ENOENT ${p}`)
      if (opts.unreadable?.includes(p)) throw new Error(`EACCES ${p}`)
      return state[p]
    },
    writeFile: (p, raw) => {
      writes.push({ op: "write", path: p, raw })
      state[p] = raw
      const prev = identities.get(p)
      identities.set(p, { mtimeMs: (prev?.mtimeMs ?? 100) + 1, size: raw.length })
    },
    rename: (a, b) => {
      writes.push({ op: "rename", from: a, to: b })
      state[b] = state[a]
      delete state[a]
      identities.set(b, identities.get(a) ?? { mtimeMs: 101, size: (state[b] ?? "").length })
      identities.delete(a)
    },
    unlink: (p) => {
      writes.push({ op: "unlink", path: p })
      delete state[p]
      identities.delete(p)
    },
    mkdir: () => {},
  }
  fs.writes = writes
  fs.state = state
  fs.identities = identities
  return { fs, state, writes, identities }
}


const POOL_FIXTURE = '{ "pool": "proj", "agents": { "scout": { "model": "prov/old", "thoughtLevel": "low" }, "scribe": {} } }'

// JSONC with comments, an unknown top-level key, non-ASCII content, an
// invalid sibling, AND unknown keys INSIDE the edited entry — the full
// preservation fixture (spec: "Preserve hand-edited JSONC"). A whole-entry
// serialization leak drops any of these and MUST fail here.
function richRecipe() {
  return [
    "{",
    '  // 保留此注释 — keep this comment',
    '  "pool": "proj",',
    '  "unknownFutureKey": { "x": 1 },',
    '  "agents": {',
    '    // 目标 worker',
    '    "scout": { /* inner comment */ "model": "prov/old", "thoughtLevel": "low", "prompt": "调查 — investigate", "teamChannel": "#scouts", "retryBudget": { "attempts": 3 } },',
    '    "broken": "not an object",',
    '    "auto": {},',
    "  },",
    "}",
  ].join("\n")
}

// ===========================================================================
// Snapshot
// ===========================================================================

test("snapshot: absent file is exists=false, raw=null, stat=null, parse=null", () => {
  const { fs } = memFs({})
  const snap = snapshotRecipe({ path: "C:/proj/.opencode/forge.json", ...fs })
  assert.equal(snap.exists, false)
  assert.equal(snap.raw, null)
  assert.equal(snap.stat, null)
  assert.equal(snap.parse, null)
})

test("snapshot: unreadable file is distinguished from absent (exists=true, raw=null)", () => {
  const { fs } = memFs({ "C:/p/.opencode/forge.json": POOL_FIXTURE }, { unreadable: ["C:/p/.opencode/forge.json"] })
  const snap = snapshotRecipe({ path: "C:/p/.opencode/forge.json", ...fs })
  assert.equal(snap.exists, true)
  assert.equal(snap.readable, false)
  assert.equal(snap.raw, null)
  assert.ok(snap.stat, "stat is still observed for an unreadable file")
})

test("snapshot: broken document retains raw bytes and a located parse message, never throws", () => {
  const raw = "{ // broken\n  agents: {"
  const { fs } = memFs({ "C:/p/.opencode/forge.json": raw })
  const snap = snapshotRecipe({ path: "C:/p/.opencode/forge.json", ...fs })
  assert.equal(snap.raw, raw)
  assert.equal(snap.parse.ok, false)
  assert.match(snap.parse.message, /line \d+/)
})

// ===========================================================================
// Targeted JSONC editing (spec: preserve unrelated bytes AND unknown fields
// inside the edited entry)
// ===========================================================================

test("edit: pinned update preserves comments, unknown keys, non-ASCII, invalid sibling AND unknown entry fields", () => {
  const raw = richRecipe()
  const { fs } = memFs({ "C:/p/.opencode/forge.json": raw })
  const snap = snapshotRecipe({ path: "C:/p/.opencode/forge.json", ...fs })
  const res = planWorkerEdit(snap, { action: "update", id: "scout", draft: { mode: "pinned", model: "prov/new", thoughtLevel: "high", prompt: "调查 — investigate", shape: "readonly" } }, { scope: "workspace" })
  assert.equal(res.ok, true, JSON.stringify(res.ok === false ? { reason: res.reason, message: res.message } : {}))
  const out = res.plan.newText
  for (const line of [
    "  // 保留此注释 — keep this comment",
    '  "unknownFutureKey": { "x": 1 },',
    '    "broken": "not an object",',
    '    "auto": {},',
  ]) {
    assert.ok(out.includes(line), `lost unrelated content: ${line}`)
  }
  assert.ok(out.includes('"prov/new"'), "new model missing")
  assert.ok(out.includes('"high"'), "new thoughtLevel missing")
  assert.ok(out.includes('"teamChannel"'), "UNKNOWN ENTRY FIELD dropped — whole-entry serialization leak")
  assert.ok(out.includes('"retryBudget"'), "unknown nested entry object dropped — whole-entry serialization leak")
  assert.ok(out.includes("调查 — investigate"), "non-ASCII prompt mangled")
  const parsed = parseForgeJsonc(out)
  assert.equal(parsed.ok, true, "edited document must still parse")
  const { agents } = validateAgentSet(parsed.config.agents)
  assert.equal(agents.scout.model, "prov/new")
  assert.equal(agents.scout.thoughtLevel, "high")
  assert.equal(agents.scout.shape, "readonly")
})

test("edit: unknown entry fields survive when the edit removes keys (Auto conversion)", () => {
  const raw = '{ "pool": "proj", "agents": { "scout": { "model": "prov/old", "thoughtLevel": "low", "teamChannel": "#scouts", "prompt": "p" } } }'
  const { fs } = memFs({ "C:/p/.opencode/forge.json": raw })
  const snap = snapshotRecipe({ path: "C:/p/.opencode/forge.json", ...fs })
  const res = planWorkerEdit(snap, { action: "update", id: "scout", draft: { mode: "auto", prompt: "p" } }, { scope: "workspace" })
  assert.equal(res.ok, true)
  const out = res.plan.newText
  assert.ok(!out.includes('"model"'), "model key must be removed on Auto")
  assert.ok(!out.includes('"thoughtLevel"'), "thoughtLevel key must be removed on Auto")
  assert.ok(out.includes('"teamChannel"'), "unknown entry field dropped on key removal")
  const parsed = parseForgeJsonc(out)
  assert.equal(parsed.ok, true)
  const { agents } = validateAgentSet(parsed.config.agents)
  assert.ok(!("model" in agents.scout) && !("thoughtLevel" in agents.scout), "Auto worker must carry no pin pair")
})

test("edit: newline style of the original document is preserved (CRLF stays CRLF)", () => {
  const raw = '{\r\n  "pool": "proj",\r\n  "agents": {\r\n    "scout": { "model": "prov/old", "thoughtLevel": "low" }\r\n  }\r\n}\r\n'
  const { fs } = memFs({ "C:/p/.opencode/forge.json": raw })
  const snap = snapshotRecipe({ path: "C:/p/.opencode/forge.json", ...fs })
  const res = planWorkerEdit(snap, { action: "update", id: "scout", draft: { mode: "pinned", model: "prov/new", thoughtLevel: "high" } }, { scope: "workspace" })
  assert.equal(res.ok, true)
  assert.ok(res.plan.newText.includes("\r\n"))
  assert.ok(!res.plan.newText.replace(/\r\n/g, "").includes("\n"))
})

test("edit: incomplete pin (model without thoughtLevel) is refused with reason invalid-draft", () => {
  const raw = '{ "pool": "proj", "agents": { "scout": {} } }'
  const { fs } = memFs({ "C:/p/.opencode/forge.json": raw })
  const snap = snapshotRecipe({ path: "C:/p/.opencode/forge.json", ...fs })
  const res = planWorkerEdit(snap, { action: "update", id: "scout", draft: { mode: "pinned", model: "prov/m" } }, { scope: "workspace" })
  assert.equal(res.ok, false)
  assert.equal(res.reason, "invalid-draft")
})

test("edit: normalized-id collision at creation is refused with reason duplicate (forge-coder self-heals onto coder)", () => {
  const raw = '{ "pool": "proj", "agents": { "coder": {} } }'
  const { fs } = memFs({ "C:/p/.opencode/forge.json": raw })
  const snap = snapshotRecipe({ path: "C:/p/.opencode/forge.json", ...fs })
  const res = planWorkerEdit(snap, { action: "create", id: "forge-coder", draft: { mode: "auto" } }, { scope: "workspace" })
  assert.equal(res.ok, false)
  assert.equal(res.reason, "duplicate")
})

test("edit: invalid id characters are refused with reason invalid-id at creation", () => {
  const raw = '{ "pool": "proj", "agents": {} }'
  const { fs } = memFs({ "C:/p/.opencode/forge.json": raw })
  const snap = snapshotRecipe({ path: "C:/p/.opencode/forge.json", ...fs })
  const res = planWorkerEdit(snap, { action: "create", id: "Bad_Id!", draft: { mode: "auto" } }, { scope: "workspace" })
  assert.equal(res.ok, false)
  assert.equal(res.reason, "invalid-id")
})

test("edit: renameTo is refused outright — never degraded into a delete+create write", () => {
  const raw = POOL_FIXTURE
  const { fs } = memFs({ "C:/p/.opencode/forge.json": raw })
  const snap = snapshotRecipe({ path: "C:/p/.opencode/forge.json", ...fs })
  const res = planWorkerEdit(snap, { action: "update", id: "scout", renameTo: "scout2", draft: { mode: "auto" } }, { scope: "workspace" })
  assert.equal(res.ok, false, "an existing id is immutable — the plan must refuse")
  assert.equal(res.reason, "invalid-id")
  assert.equal(fs.writes.length, 0)
})

test("edit: update of an unknown target id is refused with reason not-found", () => {
  const raw = '{ "pool": "proj", "agents": { "scout": {} } }'
  const { fs } = memFs({ "C:/p/.opencode/forge.json": raw })
  const snap = snapshotRecipe({ path: "C:/p/.opencode/forge.json", ...fs })
  const res = planWorkerEdit(snap, { action: "update", id: "ghost", draft: { mode: "auto" } }, { scope: "workspace" })
  assert.equal(res.ok, false)
  assert.equal(res.reason, "not-found")
})

test("edit: broken document blocks planning with reason unparseable", () => {
  const raw = "{ agents: {"
  const { fs } = memFs({ "C:/p/.opencode/forge.json": raw })
  const snap = snapshotRecipe({ path: "C:/p/.opencode/forge.json", ...fs })
  const res = planWorkerEdit(snap, { action: "update", id: "a", draft: { mode: "auto" } }, { scope: "workspace" })
  assert.equal(res.ok, false)
  assert.equal(res.reason, "unparseable")
})

test("edit: unchanged draft yields a no-op plan; commit performs zero writes", () => {
  const raw = POOL_FIXTURE
  const { fs } = memFs({ "C:/p/.opencode/forge.json": raw })
  const snap = snapshotRecipe({ path: "C:/p/.opencode/forge.json", ...fs })
  const res = planWorkerEdit(snap, { action: "update", id: "scout", draft: { mode: "pinned", model: "prov/old", thoughtLevel: "low" } }, { scope: "workspace" })
  assert.equal(res.ok, true)
  assert.equal(res.plan.kind, "no-op")
  assert.deepEqual(res.plan.summary, ["no field changes"])
  const done = commit(snap, res, fs)
  assert.equal(done.ok, true)
  assert.equal(done.outcome === "written", false)
  assert.equal(done.bytes, 0)
  assert.equal(fs.writes.length, 0)
})

test("edit: delete produces a remove plan that removes only the entry, never the file", () => {
  const raw = POOL_FIXTURE
  const { fs } = memFs({ "C:/p/.opencode/forge.json": raw })
  const snap = snapshotRecipe({ path: "C:/p/.opencode/forge.json", ...fs })
  const res = planWorkerEdit(snap, { action: "delete", id: "scout" }, { scope: "workspace" })
  assert.equal(res.ok, true)
  assert.equal(res.plan.kind, "remove")
  const out = res.plan.newText
  assert.ok(!out.includes('"scout"'))
  assert.ok(out.includes('"scribe"'), "sibling must survive delete")
  assert.equal(parseForgeJsonc(out).ok, true)
  const done = commit(snap, res, fs)
  assert.equal(done.ok, true)
  assert.ok(!fs.writes.some((w) => w.op === "unlink" && w.path === snap.path), "the recipe file itself is never deleted")
})

// ===========================================================================
// Missing-file creation (explicit, pool-gated)
// ===========================================================================

test("create-file: absent workspace file requires a valid pool name", () => {
  const { fs } = memFs({})
  const snap = snapshotRecipe({ path: "C:/p/.opencode/forge.json", ...fs })
  const noPool = planWorkerEdit(snap, { action: "create", id: "scout", draft: { mode: "auto" } }, { scope: "workspace" })
  assert.equal(noPool.ok, false)
  assert.equal(noPool.reason, "invalid-pool")
  const badPool = planWorkerEdit(snap, { action: "create", id: "scout", draft: { mode: "auto" } }, { scope: "workspace", pool: "Bad Pool!" })
  assert.equal(badPool.ok, false)
  assert.equal(badPool.reason, "invalid-pool")
  assert.equal(fs.writes.length, 0)
})

test("create-file: explicit creation writes the pool field and the entry, parseable, with fallback warning", () => {
  const { fs } = memFs({})
  const snap = snapshotRecipe({ path: "C:/p/.opencode/forge.json", ...fs })
  const res = planWorkerEdit(snap, { action: "create", id: "scout", draft: { mode: "pinned", model: "prov/m", thoughtLevel: "low" } }, { scope: "workspace", pool: "proj" })
  assert.equal(res.ok, true)
  assert.equal(res.plan.kind, "create-file")
  const parsed = parseForgeJsonc(res.plan.newText)
  assert.equal(parsed.ok, true)
  assert.equal(parsed.config.pool, "proj")
  const { agents } = validateAgentSet(parsed.config.agents)
  assert.equal(agents.scout.model, "prov/m")
  // Spec: creation of a missing workspace recipe warns that it replaces the
  // global fallback — the create-file path carries the same consequence.
  assert.ok(res.findings.some((f) => f.code === "tui-fallback-replaced" && f.level === "warn"),
    "create-file must disclose the global-fallback replacement (spec: create warns)")
})

test("create-file: non-create ops on an absent file are refused with not-found", () => {
  const { fs } = memFs({})
  const snap = snapshotRecipe({ path: "C:/p/.opencode/forge.json", ...fs })
  const res = planWorkerEdit(snap, { action: "delete", id: "scout" }, { scope: "workspace" })
  assert.equal(res.ok, false)
  assert.equal(res.reason, "not-found")
})

// ===========================================================================
// Override editing (global layer only; general/explore)
// ===========================================================================

test("override edit: add first override to global recipe preserves siblings and comments", () => {
  const raw = '{\n  // global\n  "agents": { "util": {} },\n}'
  const { fs } = memFs({ "C:/home/.config/opencode/forge.json": raw })
  const snap = snapshotRecipe({ path: "C:/home/.config/opencode/forge.json", ...fs })
  const res = planOverrideEdit(snap, { action: "create", id: "general", draft: { mode: "pinned", model: "prov/g", thoughtLevel: "medium" } }, { scope: "global" })
  assert.equal(res.ok, true, JSON.stringify(res.ok === false ? { reason: res.reason, message: res.message } : {}))
  const out = res.plan.newText
  assert.ok(out.includes('"general"'))
  assert.ok(out.includes("// global"))
  assert.ok(out.includes('"util"'))
  const parsed = parseForgeJsonc(out)
  assert.equal(parsed.ok, true)
  const { overrides } = validateOverrideNode(parsed.config.override, "global")
  assert.equal(overrides.general.model, "prov/g")
})

test("override edit: non-builtin override id is refused (only general/explore)", () => {
  const raw = '{ "agents": {} }'
  const { fs } = memFs({ "C:/home/.config/opencode/forge.json": raw })
  const snap = snapshotRecipe({ path: "C:/home/.config/opencode/forge.json", ...fs })
  const res = planOverrideEdit(snap, { action: "create", id: "custom", draft: { mode: "auto" } }, { scope: "global" })
  assert.equal(res.ok, false)
})

test("override edit: workspace scope is refused with invalid-scope (global layer only)", () => {
  const raw = POOL_FIXTURE
  const { fs } = memFs({ "C:/p/.opencode/forge.json": raw })
  const snap = snapshotRecipe({ path: "C:/p/.opencode/forge.json", ...fs })
  const res = planOverrideEdit(snap, { action: "create", id: "general", draft: { mode: "auto" } }, { scope: "workspace" })
  assert.equal(res.ok, false)
  assert.equal(res.reason, "invalid-scope")
})

test("override edit: duplicate existing override id is refused with duplicate", () => {
  const raw = '{ "override": { "general": {} } }'
  const { fs } = memFs({ "C:/home/.config/opencode/forge.json": raw })
  const snap = snapshotRecipe({ path: "C:/home/.config/opencode/forge.json", ...fs })
  const res = planOverrideEdit(snap, { action: "create", id: "general", draft: { mode: "auto" } }, { scope: "global" })
  assert.equal(res.ok, false)
  assert.equal(res.reason, "duplicate")
})

test("override edit: removing an override deletes only that entry", () => {
  const raw = '{ "override": { "general": { "model": "prov/g", "thoughtLevel": "low" }, "explore": { "model": "prov/e", "thoughtLevel": "high" } } }'
  const { fs } = memFs({ "C:/home/.config/opencode/forge.json": raw })
  const snap = snapshotRecipe({ path: "C:/home/.config/opencode/forge.json", ...fs })
  const res = planOverrideEdit(snap, { action: "delete", id: "general" }, { scope: "global" })
  assert.equal(res.ok, true)
  const parsed = parseForgeJsonc(res.plan.newText)
  assert.equal(parsed.ok, true)
  const { overrides } = validateOverrideNode(parsed.config.override, "global")
  assert.deepEqual(Object.keys(overrides), ["explore"])
})

// ===========================================================================
// Commit boundary (conflict detection, atomicity, no-op zero write)
// ===========================================================================

test("commit: write failure leaves prior bytes intact and reports reason write-failed", () => {
  const raw = POOL_FIXTURE
  const { fs } = memFs({ "C:/p/.opencode/forge.json": raw })
  const snap = snapshotRecipe({ path: "C:/p/.opencode/forge.json", ...fs })
  const res = planWorkerEdit(snap, { action: "update", id: "scout", draft: { mode: "pinned", model: "prov/new", thoughtLevel: "high" } }, { scope: "workspace" })
  assert.equal(res.ok, true)
  const failing = { ...fs, writeFile: (p, d) => { if (p === snap.path || p.endsWith(".tmp")) throw new Error("ENOSPC"); fs.writeFile(p, d) } }
  const done = commit(snap, res, failing)
  assert.equal(done.ok, false)
  assert.equal(done.reason, "write-failed")
  assert.equal(fs.readFile("C:/p/.opencode/forge.json"), raw, "prior bytes must stay intact")
})

test("commit: external change since snapshot (identity mismatch) is refused as conflict, newer contents survive", () => {
  const raw = POOL_FIXTURE
  const { fs } = memFs({ "C:/p/.opencode/forge.json": raw })
  const snap = snapshotRecipe({ path: "C:/p/.opencode/forge.json", ...fs })
  const newer = '{ "pool": "proj", "agents": { "scout": { "model": "prov/other", "thoughtLevel": "low" } } }'
  fs.writeFile("C:/p/.opencode/forge.json", newer) // bumps identity AND bytes
  const res = planWorkerEdit(snap, { action: "update", id: "scout", draft: { mode: "pinned", model: "prov/new", thoughtLevel: "high" } }, { scope: "workspace" })
  assert.equal(res.ok, true)
  const done = commit(snap, res, fs)
  assert.equal(done.ok, false)
  assert.equal(done.reason, "conflict")
  assert.equal(fs.state["C:/p/.opencode/forge.json"], newer, "newer external contents must survive")
})

test("commit: external byte change with SAME mtime and size is refused — raw compare, not just stat", () => {
  const raw = POOL_FIXTURE
  const { fs } = memFs({ "C:/p/.opencode/forge.json": raw })
  const snap = snapshotRecipe({ path: "C:/p/.opencode/forge.json", ...fs })
  // An external editor rewrites content to the same length without an mtime bump.
  const tampered = '{ "pool": "proj", "agents": { "scout": { "model": "prov/other", "thoughtLevel": "low" }, "scribe": {}}}'
  assert.equal(tampered.length, raw.length, "fixture must keep the same byte length")
  fs.state["C:/p/.opencode/forge.json"] = tampered // stat still {mtimeMs:100, size:len}
  const res = planWorkerEdit(snap, { action: "update", id: "scout", draft: { mode: "pinned", model: "prov/new", thoughtLevel: "high" } }, { scope: "workspace" })
  assert.equal(res.ok, true)
  const done = commit(snap, res, fs)
  assert.equal(done.ok, false, "same-stat but different raw bytes must refuse (raw compare)")
  assert.equal(done.reason, "conflict")
  assert.equal(fs.state["C:/p/.opencode/forge.json"], tampered, "external tampered bytes must survive")
})

test("commit: missing file since snapshot is refused (reason missing), nothing created", () => {
  const raw = POOL_FIXTURE
  const { fs } = memFs({ "C:/p/.opencode/forge.json": raw })
  const snap = snapshotRecipe({ path: "C:/p/.opencode/forge.json", ...fs })
  fs.identities.delete("C:/p/.opencode/forge.json")
  delete fs.state["C:/p/.opencode/forge.json"]
  const res = planWorkerEdit(snap, { action: "update", id: "scout", draft: { mode: "pinned", model: "prov/new", thoughtLevel: "high" } }, { scope: "workspace" })
  assert.equal(res.ok, true)
  const done = commit(snap, res, fs)
  assert.equal(done.ok, false)
  assert.equal(done.reason, "missing")
})

test("commit: successful save reports outcome written with exactly the planned bytes", () => {
  const raw = POOL_FIXTURE
  const { fs } = memFs({ "C:/p/.opencode/forge.json": raw })
  const snap = snapshotRecipe({ path: "C:/p/.opencode/forge.json", ...fs })
  const res = planWorkerEdit(snap, { action: "update", id: "scout", draft: { mode: "pinned", model: "prov/new", thoughtLevel: "high" } }, { scope: "workspace" })
  assert.equal(res.ok, true)
  const done = commit(snap, res, fs)
  assert.equal(done.ok, true)
  assert.equal(done.outcome === "written", true)
  assert.equal(done.bytes, res.plan.newText.length)
  assert.equal(fs.state["C:/p/.opencode/forge.json"], res.plan.newText)
})

test("commit: ownership recheck failure blocks the write (fail closed)", () => {
  const raw = POOL_FIXTURE
  const { fs } = memFs({ "C:/p/.opencode/forge.json": raw })
  const snap = snapshotRecipe({ path: "C:/p/.opencode/forge.json", ...fs })
  const res = planWorkerEdit(snap, { action: "update", id: "scout", draft: { mode: "pinned", model: "prov/new", thoughtLevel: "high" } }, { scope: "workspace" })
  assert.equal(res.ok, true)
  const done = commitDeps(snap, res, { ...fs, recheckOwnership: () => false })
  assert.equal(done.ok, false)
  assert.equal(done.reason, "ownership-lost")
  assert.equal(fs.state["C:/p/.opencode/forge.json"], raw)
})

test("commit: creation commit refuses when the file appeared since the snapshot (no-clobber)", () => {
  const { fs } = memFs({})
  const snap = snapshotRecipe({ path: "C:/p/.opencode/forge.json", ...fs })
  const res = planWorkerEdit(snap, { action: "create", id: "scout", draft: { mode: "auto" } }, { scope: "workspace", pool: "proj" })
  assert.equal(res.ok, true)
  fs.writeFile("C:/p/.opencode/forge.json", "{ }") // a competing creator wins
  const done = commit(snap, res, fs)
  assert.equal(done.ok, false)
  assert.equal(done.reason, "conflict")
  assert.equal(fs.state["C:/p/.opencode/forge.json"], "{ }", "competing creation must survive")
})

// ===========================================================================
// Cooperating-save serialization
// ===========================================================================

test("withCommitLock: same-path commits serialize in submission order", async () => {
  const order = []
  const first = withCommitLock("C:/p/.opencode/forge.json", async () => {
    await new Promise((r) => setTimeout(r, 20))
    order.push("first-done")
  })
  const second = withCommitLock("C:/p/.opencode/forge.json", () => { order.push("second-done") })
  await Promise.all([first, second])
  assert.deepEqual(order, ["first-done", "second-done"], "same-path commits must run strictly in submission order")
})

// ===========================================================================
// Regression batch 2026-11-27 (early-review findings; coordinator directives)
// ===========================================================================

test("auto draft carrying stray pin fields is refused, never half-pinned", () => {
  const raw = POOL_FIXTURE
  const { fs } = memFs({ "C:/p/.opencode/forge.json": raw })
  const snap = snapshotRecipe({ path: "C:/p/.opencode/forge.json", ...fs })
  for (const stray of [{ model: "prov/x" }, { thoughtLevel: "low" }, { model: "prov/x", thoughtLevel: "low" }]) {
    const res = planWorkerEdit(snap, { action: "update", id: "scout", draft: { mode: "auto", ...stray } }, { scope: "workspace" })
    assert.equal(res.ok, false, `auto draft with stray ${Object.keys(stray).join("+")} must refuse (never half-pin)`)
    assert.equal(fs.writes.length, 0, "refused draft must not write")
  }
})

test("auto conversion keeps shape, permission and prompt untouched", () => {
  const raw = '{ "pool": "proj", "agents": { "scout": { "model": "prov/old", "thoughtLevel": "low", "shape": "readonly", "permission": { "bash": "deny" }, "prompt": "p" } } }'
  const { fs } = memFs({ "C:/p/.opencode/forge.json": raw })
  const snap = snapshotRecipe({ path: "C:/p/.opencode/forge.json", ...fs })
  const res = planWorkerEdit(snap, { action: "update", id: "scout", draft: { mode: "auto" } }, { scope: "workspace" })
  assert.equal(res.ok, true)
  const out = res.plan.newText
  assert.ok(!out.includes('"model"') && !out.includes('"thoughtLevel"'))
  assert.ok(out.includes('"readonly"'), "shape must survive Auto conversion")
  assert.ok(out.includes('"bash"'), "permission must survive Auto conversion")
  assert.ok(out.includes('"prompt"'), "prompt must survive Auto conversion")
  const parsed = parseForgeJsonc(out)
  const { agents } = validateAgentSet(parsed.config.agents)
  assert.equal(agents.scout.shape, "readonly")
  assert.deepEqual(agents.scout.permission, { bash: "deny" })
})

test("pinned draft with an empty pair is refused, never silently downgraded to Auto", () => {
  const raw = POOL_FIXTURE
  const { fs } = memFs({ "C:/p/.opencode/forge.json": raw })
  const snap = snapshotRecipe({ path: "C:/p/.opencode/forge.json", ...fs })
  const res = planWorkerEdit(snap, { action: "update", id: "scribe", draft: { mode: "pinned" } }, { scope: "workspace" })
  assert.equal(res.ok, false, "mode pinned with neither model nor thoughtLevel must refuse")
  assert.equal(fs.writes.length, 0)
})

test("new entry in an existing empty agents container preserves the container's comment", () => {
  const raw = '{ "pool": "proj", "agents": { /* future workers land here */ } }'
  const { fs } = memFs({ "C:/p/.opencode/forge.json": raw })
  const snap = snapshotRecipe({ path: "C:/p/.opencode/forge.json", ...fs })
  const res = planWorkerEdit(snap, { action: "create", id: "scout", draft: { mode: "auto" } }, { scope: "workspace" })
  assert.equal(res.ok, true, JSON.stringify(res.ok === false ? { reason: res.reason, message: res.message } : {}))
  assert.ok(res.plan.newText.includes("/* future workers land here */"), "container comment lost")
  assert.equal(parseForgeJsonc(res.plan.newText).ok, true)
})

test("first entry into a bare {} document is legal", () => {
  const { fs } = memFs({ "C:/p/.opencode/forge.json": "{}" })
  const snap = snapshotRecipe({ path: "C:/p/.opencode/forge.json", ...fs })
  const res = planWorkerEdit(snap, { action: "create", id: "scout", draft: { mode: "auto" } }, { scope: "workspace" })
  assert.equal(res.ok, true, JSON.stringify(res.ok === false ? { reason: res.reason, message: res.message } : {}))
  const parsed = parseForgeJsonc(res.plan.newText)
  assert.equal(parsed.ok, true)
  const { agents } = validateAgentSet(parsed.config.agents)
  assert.deepEqual(Object.keys(agents), ["scout"])
})

test("existing-but-unreadable file plans nothing (reason unreadable), never a create", () => {
  const { fs } = memFs({ "C:/p/.opencode/forge.json": POOL_FIXTURE }, { unreadable: ["C:/p/.opencode/forge.json"] })
  const snap = snapshotRecipe({ path: "C:/p/.opencode/forge.json", ...fs })
  const update = planWorkerEdit(snap, { action: "update", id: "scout", draft: { mode: "auto" } }, { scope: "workspace" })
  assert.equal(update.ok, false)
  assert.equal(update.reason, "unreadable")
  const create = planWorkerEdit(snap, { action: "create", id: "newguy", draft: { mode: "auto" } }, { scope: "workspace" })
  assert.equal(create.ok, false, "an existing unreadable file must not be silently created over")
  assert.equal(fs.writes.length, 0)
})

test("atomic temp discipline: failure cleans its own temp, never the recipe or foreign files", () => {
  const raw = POOL_FIXTURE
  const { fs } = memFs({ "C:/p/.opencode/forge.json": raw, "C:/p/.opencode/foreign.tmp": "foreign bytes" })
  const snap = snapshotRecipe({ path: "C:/p/.opencode/forge.json", ...fs })
  const res = planWorkerEdit(snap, { action: "update", id: "scout", draft: { mode: "pinned", model: "prov/new", thoughtLevel: "high" } }, { scope: "workspace" })
  assert.equal(res.ok, true)
  const failing = { ...fs, writeFile: (p, d) => { if (p === snap.path || p.endsWith(".tmp")) throw new Error("ENOSPC"); fs.writeFile(p, d) } }
  const done = commitDeps(snap, res, failing)
  assert.equal(done.ok, false)
  assert.equal(done.reason, "write-failed")
  const unlinks = fs.writes.filter((w) => w.op === "unlink")
  assert.ok(unlinks.every((u) => u.path !== snap.path), "must never unlink the recipe")
  assert.ok(unlinks.every((u) => u.path !== "C:/p/.opencode/foreign.tmp"), "must never unlink foreign files")
  assert.equal(fs.state["C:/p/.opencode/foreign.tmp"], "foreign bytes", "foreign temp content untouched")
})

test("external change to the original between temp write and rename is caught (second check)", () => {
  const raw = POOL_FIXTURE
  const { fs } = memFs({ "C:/p/.opencode/forge.json": raw })
  const snap = snapshotRecipe({ path: "C:/p/.opencode/forge.json", ...fs })
  const res = planWorkerEdit(snap, { action: "update", id: "scout", draft: { mode: "pinned", model: "prov/new", thoughtLevel: "high" } }, { scope: "workspace" })
  assert.equal(res.ok, true)
  // The write-surface callback simulates a competing editor landing its
  // bytes after the save's own write but before the commit verifies what
  // landed — the commit must detect the divergence and refuse.
  const competing = '{ "pool": "proj", "agents": { "scout": { "model": "prov/other", "thoughtLevel": "low" }, "scribe": {} } }'
  const racing = {
    ...fs,
    writeFile: (p, d) => {
      fs.writeFile(p, d)
      if (p === snap.path || p.endsWith(".tmp")) {
        fs.state[snap.path] = competing
      }
    },
  }
  const done = commitDeps(snap, res, racing)
  if (done.ok) {
    assert.ok(fs.state[snap.path].includes('"prov/other"'), "competing edit clobbered without a second check")
  } else {
    assert.ok(["conflict", "write-failed"].includes(done.reason), `unexpected reason ${done.reason}`)
    assert.ok(fs.state[snap.path].includes('"prov/other"'), "competing edit must survive a refused commit")
  }
})

test("invalid UTF-8 (lone surrogate) makes the file unreadable — edits refuse, bytes never touched", () => {
  const raw = '{ "pool": "proj", "agents": { "scout": { "model": "prov/old", "thoughtLevel": "low" } } }'
  const { fs } = memFs({ "C:/p/.opencode/forge.json": raw })
  // A lossy upstream decode hands the snapshot a lone surrogate: strict
  // decoding must reject it (readable=false), never rewrite the file.
  const lossy = { ...fs, readFile: (p) => (p === "C:/p/.opencode/forge.json" ? '{ "pool": "proj", "agents": { "scout": { "model": "prov/\uD800", "thoughtLevel": "low" } } }' : fs.readFile(p)) }
  const snap = snapshotRecipe({ path: "C:/p/.opencode/forge.json", ...lossy })
  assert.equal(snap.exists, true)
  assert.equal(snap.readable, false, "lossy-decoded content must not be treated as readable")
  const res = planWorkerEdit(snap, { action: "update", id: "scout", draft: { mode: "pinned", model: "prov/new", thoughtLevel: "high" } }, { scope: "workspace" })
  assert.equal(res.ok, false)
  assert.equal(res.reason, "unreadable")
  assert.equal(fs.state["C:/p/.opencode/forge.json"], raw, "undecodable original must stay untouched")
})

test("commit refuses when the CURRENT bytes became undecodable after a clean snapshot (unreadable, prior intact)", () => {
  const raw = POOL_FIXTURE
  const { fs } = memFs({ "C:/p/.opencode/forge.json": raw })
  const snap = snapshotRecipe({ path: "C:/p/.opencode/forge.json", ...fs })
  const res = planWorkerEdit(snap, { action: "update", id: "scout", draft: { mode: "pinned", model: "prov/new", thoughtLevel: "high" } }, { scope: "workspace" })
  assert.equal(res.ok, true)
  // Between snapshot and commit the bytes turn undecodable.
  const lossy = { ...fs, readFile: (p) => (p === snap.path ? '{ "pool": "proj", "agents": { "scout": { "model": "prov/\uD800", "thoughtLevel": "low" } } }' : fs.readFile(p)) }
  const done = commitDeps(snap, res, lossy)
  assert.equal(done.ok, false, "undecodable current content must refuse the replace")
  assert.equal(done.reason, "unreadable")
  assert.ok(!fs.writes.some((w) => w.path === snap.path), "the undecodable original must stay untouched")
})

test("prompt-only edit in an entry whose permission carries an inner comment is not ambiguous", () => {
  const raw = '{ "pool": "proj", "agents": { "scout": { "permission": { "bash": "deny" /* keep */ }, "prompt": "old" } } }'
  const { fs } = memFs({ "C:/p/.opencode/forge.json": raw })
  const snap = snapshotRecipe({ path: "C:/p/.opencode/forge.json", ...fs })
  const res = planWorkerEdit(snap, { action: "update", id: "scout", draft: { mode: "auto", prompt: "new" } }, { scope: "workspace" })
  assert.equal(res.ok, true, JSON.stringify(res.ok === false ? { reason: res.reason, message: res.message } : {}))
  assert.ok(res.plan.newText.includes("/* keep */"), "permission inner comment lost")
  assert.ok(res.plan.newText.includes('"new"'))
  assert.ok(!res.plan.newText.includes('"old"'))
  assert.equal(parseForgeJsonc(res.plan.newText).ok, true)
})

test("unknown top-level key with an inner comment does not break the entry scan", () => {
  const raw = '{ "unknown": { "x": 1 /* odd */ }, "pool": "proj", "agents": { "scout": {} } }'
  const { fs } = memFs({ "C:/p/.opencode/forge.json": raw })
  const snap = snapshotRecipe({ path: "C:/p/.opencode/forge.json", ...fs })
  const create = planWorkerEdit(snap, { action: "create", id: "scribe", draft: { mode: "auto" } }, { scope: "workspace" })
  assert.equal(create.ok, true, JSON.stringify(create.ok === false ? { reason: create.reason, message: create.message } : {}))
  assert.ok(create.plan.newText.includes("/* odd */"))
  const snap2 = snapshotRecipe({ path: "C:/p/.opencode/forge.json", ...fs, readFile: () => create.plan.newText, stat: () => ({ mtimeMs: 200, size: create.plan.newText.length }) })
  const update = planWorkerEdit(snap2, { action: "update", id: "scout", draft: { mode: "pinned", model: "prov/m", thoughtLevel: "low" } }, { scope: "workspace" })
  assert.equal(update.ok, true, JSON.stringify(update.ok === false ? { reason: update.reason, message: update.message } : {}))
  assert.ok(update.plan.newText.includes("/* odd */"))
})

test("Auto removal of a commented, comma-trailing member keeps surrounding comments and parses", () => {
  const raw = '{ "pool": "proj", "agents": { "scout": { /* the pin */ "model": "prov/old", "thoughtLevel": "low", // depth\n "prompt": "p", "shape": "write" } } }'
  const { fs } = memFs({ "C:/p/.opencode/forge.json": raw })
  const snap = snapshotRecipe({ path: "C:/p/.opencode/forge.json", ...fs })
  const res = planWorkerEdit(snap, { action: "update", id: "scout", draft: { mode: "auto", prompt: "p", shape: "write" } }, { scope: "workspace" })
  assert.equal(res.ok, true, JSON.stringify(res.ok === false ? { reason: res.reason, message: res.message } : {}))
  assert.ok(!res.plan.newText.includes('"prov/old"'))
  assert.ok(res.plan.newText.includes('"prompt"') && res.plan.newText.includes('"write"'))
  assert.equal(parseForgeJsonc(res.plan.newText).ok, true, "document must still parse after member removal")
})

test("first worker creation on the GLOBAL file requires no pool field", () => {
  const { fs } = memFs({})
  const snap = snapshotRecipe({ path: "C:/home/.config/opencode/forge.json", ...fs })
  const res = planWorkerEdit(snap, { action: "create", id: "helper", draft: { mode: "auto" } }, { scope: "global" })
  assert.equal(res.ok, true, JSON.stringify(res.ok === false ? { reason: res.reason, message: res.message } : {}))
  assert.equal(res.plan.kind, "create-file")
  const parsed = parseForgeJsonc(res.plan.newText)
  assert.equal(parsed.ok, true)
  assert.equal(parsed.config.pool, undefined, "the global file carries no pool field")
})

test("override forge-general is refused against existing general (normalized collision)", () => {
  const raw = '{ "override": { "general": {} } }'
  const { fs } = memFs({ "C:/home/.config/opencode/forge.json": raw })
  const snap = snapshotRecipe({ path: "C:/home/.config/opencode/forge.json", ...fs })
  const res = planOverrideEdit(snap, { action: "create", id: "forge-general", draft: { mode: "auto" } }, { scope: "global" })
  assert.equal(res.ok, false, "a key that self-heals onto an existing override must refuse")
  assert.equal(fs.state["C:/home/.config/opencode/forge.json"], raw)
})

test("delete of a non-builtin override id (override.future) is refused, not silently removed", () => {
  const raw = '{ "override": { "general": {}, "future": { "prompt": "x" } } }'
  const { fs } = memFs({ "C:/home/.config/opencode/forge.json": raw })
  const snap = snapshotRecipe({ path: "C:/home/.config/opencode/forge.json", ...fs })
  const res = planOverrideEdit(snap, { action: "delete", id: "future" }, { scope: "global" })
  assert.equal(res.ok, false, "override deletes are limited to the built-in ids general/explore")
  assert.equal(fs.state["C:/home/.config/opencode/forge.json"], raw)
})

// ===========================================================================
// Regression batch 2 (second early-review findings; coordinator directives)
// ===========================================================================

test("unchanged draft refuses to commit when snapshot raw was externally tampered at equal stat (expectIdentity.raw compare before no-op)", () => {
  const raw = POOL_FIXTURE
  const { fs } = memFs({ "C:/p/.opencode/forge.json": raw })
  const snap = snapshotRecipe({ path: "C:/p/.opencode/forge.json", ...fs })
  const res = planWorkerEdit(snap, { action: "update", id: "scout", draft: { mode: "pinned", model: "prov/old", thoughtLevel: "low" } }, { scope: "workspace" })
  assert.equal(res.ok, true)
  assert.equal(res.plan.kind, "no-op")
  // Same stat identity, different bytes: even a no-op plan must not be
  // committed blindly — expectIdentity.raw must be re-verified first.
  fs.state["C:/p/.opencode/forge.json"] = '{ "pool": "proj", "agents": { "scout": { "model": "prov/other", "thoughtLevel": "low" }, "scribe": {} } }'
  const done = commit(snap, res, fs)
  assert.equal(done.ok, false, "tampered bytes at equal stat must refuse even a no-op plan")
  assert.equal(done.outcome !== "written", true)
})

test("value-replacing the model keeps a comment sitting between value and comma", () => {
  const raw = '{ "pool": "proj", "agents": { "scout": { "model": "prov/old" /* pinned on purpose */, "thoughtLevel": "low" } } }'
  const { fs } = memFs({ "C:/p/.opencode/forge.json": raw })
  const snap = snapshotRecipe({ path: "C:/p/.opencode/forge.json", ...fs })
  const res = planWorkerEdit(snap, { action: "update", id: "scout", draft: { mode: "pinned", model: "prov/new", thoughtLevel: "low" } }, { scope: "workspace" })
  assert.equal(res.ok, true)
  assert.ok(res.plan.newText.includes("/* pinned on purpose */"), "the intra-line comment after the replaced value was lost")
  assert.ok(res.plan.newText.includes('"prov/new"'))
  assert.equal(parseForgeJsonc(res.plan.newText).ok, true)
})

test("changing one permission sub-entry keeps the sibling entries' comments", () => {
  const raw = '{ "pool": "proj", "agents": { "scout": { "permission": { "bash": "deny", /* edits here are audited */ "webfetch": "allow" }, "prompt": "p" } } }'
  const { fs } = memFs({ "C:/p/.opencode/forge.json": raw })
  const snap = snapshotRecipe({ path: "C:/p/.opencode/forge.json", ...fs })
  const res = planWorkerEdit(snap, { action: "update", id: "scout", draft: { mode: "auto", prompt: "p", permission: { bash: "allow", webfetch: "allow" } } }, { scope: "workspace" })
  assert.equal(res.ok, true)
  assert.ok(res.plan.newText.includes("/* edits here are audited */"), "sibling permission comment lost")
  assert.ok(res.plan.newText.includes('"allow"'))
  assert.equal(parseForgeJsonc(res.plan.newText).ok, true)
})

test("a raw level already written as CuStOm stays a no-op (no silent lowercase rewrite of preserved values)", () => {
  const raw = '{ "pool": "proj", "agents": { "scout": { "model": "prov/m", "thoughtLevel": "CuStOm" } } }'
  const { fs } = memFs({ "C:/p/.opencode/forge.json": raw })
  const snap = snapshotRecipe({ path: "C:/p/.opencode/forge.json", ...fs })
  const res = planWorkerEdit(snap, { action: "update", id: "scout", draft: { mode: "pinned", model: "prov/m", thoughtLevel: "CuStOm" } }, { scope: "workspace" })
  assert.equal(res.ok, true)
  assert.equal(res.plan.kind, "no-op", "an existing raw value preserved verbatim must not be rewritten (spec: preserve raw unknown values)")
  const done = commit(snap, res, fs)
  assert.equal(done.ok, true)
  assert.equal(done.outcome === "written", false)
  assert.equal(fs.writes.length, 0)
})

test("an existing pinned entry with a broken draft refuses instead of degrading to no-op", () => {
  const raw = '{ "pool": "proj", "agents": { "scout": { "model": "prov/old", "thoughtLevel": "low" } } }'
  const { fs } = memFs({ "C:/p/.opencode/forge.json": raw })
  const snap = snapshotRecipe({ path: "C:/p/.opencode/forge.json", ...fs })
  const res = planWorkerEdit(snap, { action: "update", id: "scout", draft: { mode: "pinned", model: "prov/new" } }, { scope: "workspace" })
  assert.equal(res.ok, false, "half pin on an existing entry must refuse, never no-op or partial write")
  const res2 = planWorkerEdit(snap, { action: "update", id: "scout", draft: { mode: "pinned", model: "prov/new", thoughtLevel: 7 } }, { scope: "workspace" })
  assert.equal(res2.ok, false, "a mistyped level must refuse")
  assert.equal(fs.writes.length, 0)
})

test("override create with a half pin on an existing empty override container is refused", () => {
  const raw = '{ "override": {} }'
  const { fs } = memFs({ "C:/home/.config/opencode/forge.json": raw })
  const snap = snapshotRecipe({ path: "C:/home/.config/opencode/forge.json", ...fs })
  const res = planOverrideEdit(snap, { action: "create", id: "general", draft: { mode: "pinned", model: "prov/g" } }, { scope: "global" })
  assert.equal(res.ok, false)
  assert.equal(fs.writes.length, 0)
})


// Real-fs leg (realpath/symlink semantics only exist on a real filesystem;
// a throwaway temp dir under the OS tmpdir, removed afterwards).
import { mkdtempSync, writeFileSync, symlinkSync, readFileSync, rmSync, statSync, lstatSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

test("real-fs: a symlinked recipe destination refuses the atomic write (unsafe target)", () => {
  let dir
  try {
    dir = mkdtempSync(join(tmpdir(), "forge-edit-test-"))
  } catch {
    return test.skip("temp dir unavailable")
  }
  try {
    const real = join(dir, "real-forge.json")
    const link = join(dir, "link-forge.json")
    writeFileSync(real, POOL_FIXTURE)
    try {
      symlinkSync(real, link)
    } catch {
      return test.skip("symlinks unavailable on this platform/session")
    }
    const st = statSync(link)
    const snap = snapshotRecipe({ path: link, stat: () => ({ mtimeMs: st.mtimeMs, size: st.size }), readFile: (p) => readFileSync(p, "utf8") })
    assert.equal(snap.readable, true)
    const res = planWorkerEdit(snap, { action: "update", id: "scout", draft: { mode: "pinned", model: "prov/new", thoughtLevel: "high" } }, { scope: "workspace" })
    assert.equal(res.ok, true)
    const done = commitDeps(snap, res, {})
    assert.equal(done.ok, false, "a symlinked destination must refuse (replace the real file's owner instead)")
    assert.equal(done.reason, "write-failed")
    assert.equal(readFileSync(real, "utf8"), POOL_FIXTURE, "the real file must stay intact")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("commit refuses when the target was replaced by a DIFFERENT file at the same stat (device/inode change)", () => {
  const raw = POOL_FIXTURE
  const { fs } = memFs({ "C:/p/.opencode/forge.json": raw })
  const snap = snapshotRecipe({ path: "C:/p/.opencode/forge.json", ...fs })
  const res = planWorkerEdit(snap, { action: "update", id: "scout", draft: { mode: "pinned", model: "prov/new", thoughtLevel: "high" } }, { scope: "workspace" })
  assert.equal(res.ok, true)
  // An external editor replaced the file (delete + recreate): same
  // mtime/size, different inode. The raw bytes differ, so the content
  // compare must catch it even though stat is identical.
  const replaced = '{ "pool": "proj", "agents": { "scout": { "model": "prov/other", "thoughtLevel": "low" }, "scribe": {} } }'
  fs.state["C:/p/.opencode/forge.json"] = replaced
  const done = commit(snap, res, fs)
  assert.equal(done.ok, false, "a swapped-out file must refuse (content compare covers inode swaps at equal stat)")
  assert.equal(done.reason, "conflict")
  assert.equal(fs.state["C:/p/.opencode/forge.json"], replaced)
})

// ===========================================================================
// Injected ATOMIC PROTOCOL (final contract): writeFile is a TEMP WRITER
// ONLY — the destination path is NEVER handed to it; rename is the
// REQUIRED exclusive publisher; writeFile-without-rename fails closed;
// the create absence re-check runs between the temp write and the publish.
// ===========================================================================

const TARGET = "C:/p/.opencode/forge.json"

test("injected protocol: writeFile never receives the destination path — a partial write corrupts only the owned temp", () => {
  const raw = POOL_FIXTURE
  const { fs } = memFs({ [TARGET]: raw })
  const snap = snapshotRecipe({ path: TARGET, ...fs })
  const res = planWorkerEdit(snap, { action: "update", id: "scout", draft: { mode: "pinned", model: "prov/new", thoughtLevel: "high" } }, { scope: "workspace" })
  assert.equal(res.ok, true)
  const writtenPaths = []
  const partial = {
    ...fs,
    writeFile: (p, d) => {
      writtenPaths.push(p)
      fs.writeFile(p, d.slice(0, Math.floor(d.length / 2))) // PARTIAL write
    },
  }
  const done = commit(snap, res, partial)
  assert.ok(writtenPaths.length >= 1)
  for (const p of writtenPaths) {
    assert.notEqual(p, TARGET, "writeFile must never be handed the destination")
    assert.ok(p.endsWith(".tmp") && p.startsWith(TARGET), "the temp lives in the SAME directory (rename stays atomic)")
  }
  assert.equal(done.ok, false, "a corrupt publish must be refused by the landed-bytes verification")
  assert.equal(done.reason, "conflict")
  // The abort path (ownership re-check fires before the publish) leaves the
  // target with its ORIGINAL bytes — the partial write only ever touched the
  // owned temp.
  const fresh = memFs({ [TARGET]: raw })
  const snapFresh = snapshotRecipe({ path: TARGET, ...fresh.fs })
  const resFresh = planWorkerEdit(snapFresh, { action: "update", id: "scout", draft: { mode: "pinned", model: "prov/new", thoughtLevel: "high" } }, { scope: "workspace" })
  assert.equal(resFresh.ok, true)
  const aborted = commit(snapFresh, resFresh, {
    ...fresh.fs,
    writeFile: (p, d) => fresh.fs.writeFile(p, d.slice(0, 3)),
    recheckOwnership: () => false,
  })
  assert.equal(aborted.ok, false)
  assert.equal(aborted.reason, "ownership-lost")
  assert.equal(fresh.fs.state[TARGET], raw, "the target kept its original bytes — only the owned temp was corrupted")
})

test("injected protocol: writeFile WITHOUT rename fails closed with zero target writes", () => {
  const { fs } = memFs({ [TARGET]: POOL_FIXTURE })
  const snap = snapshotRecipe({ path: TARGET, ...fs })
  const res = planWorkerEdit(snap, { action: "update", id: "scout", draft: { mode: "pinned", model: "prov/new", thoughtLevel: "high" } }, { scope: "workspace" })
  assert.equal(res.ok, true)
  const noRename = { ...fs, rename: undefined }
  const done = commit(snap, res, noRename)
  assert.equal(done.ok, false, "no atomic publish surface → refuse (fail closed)")
  assert.equal(done.reason, "write-failed")
  assert.match(done.message, /rename|atomic/)
  for (const w of fs.writes) assert.notEqual(w.path, TARGET, "nothing ever touched the destination")
  assert.equal(fs.state[TARGET], POOL_FIXTURE)
})

test("create (injected): the target appearing between the snapshot and the publish refuses (no-clobber) — the publish is never invoked", () => {
  const { fs } = memFs({})
  const snap = snapshotRecipe({ path: TARGET, ...fs })
  const res = planWorkerEdit(snap, { action: "create", id: "scout", draft: { mode: "auto" } }, { scope: "workspace", pool: "proj" })
  assert.equal(res.ok, true)
  assert.equal(res.plan.kind, "create-file")
  // A competing creator lands AFTER the temp write but BEFORE the publish:
  // the injected stat is stateful (absent at the first check, present at
  // the re-verify). link is the exclusive create publisher.
  let seen = 0
  const racing = {
    ...fs,
    stat: (p) => {
      if (p === TARGET) {
        seen++
        return seen >= 2 ? { mtimeMs: 999, size: 42 } : null // present at the re-verify
      }
      return fs.stat(p)
    },
    link: () => { throw new Error("link must not run when the target re-appears") },
  }
  const done = commit(snap, res, racing)
  assert.equal(done.ok, false, "a competing creation must refuse the publish")
  assert.equal(done.reason, "conflict")
  assert.match(done.message, /no-clobber|appeared/)
  assert.equal(fs.state[TARGET], undefined, "the target was never written by us")
  assert.ok(!fs.writes.some((w) => w.op === "rename"), "rename must not cover a competing creation")
})

// ===========================================================================
// CREATE publish EXCLUSIVITY (P1, review 2026-11-27): a plain rename
// publish for a CREATION can cover a competing creator (the rename callback
// may even wx-plant and then blindly rename). The creation publish must be
// EXCLUSIVE (link/EEXIST or an exclusive-rename seam): a lost race keeps
// the COMPETING bytes, and an fs without an exclusive surface refuses with
// ZERO target writes — never a rename fallback.
// ===========================================================================

test("create P1: the exclusive link surface reports EEXIST on a lost race — conflict, competing bytes intact, no rename", () => {
  const { fs } = memFs({})
  const snap = snapshotRecipe({ path: TARGET, ...fs })
  const res = planWorkerEdit(snap, { action: "create", id: "scout", draft: { mode: "auto" } }, { scope: "workspace", pool: "proj" })
  assert.equal(res.ok, true)
  const linkCalls = []
  const done = commit(snap, res, {
    ...fs,
    // Exclusive-publish seam contract: MUST throw (ideally EEXIST) when the
    // destination already exists — never overwrite it. Models the rival
    // winning the race between the re-verify and the publish.
    link: (from, to) => {
      linkCalls.push({ from, to })
      const err = new Error(`EEXIST: file already exists: ${to}`)
      err.code = "EEXIST"
      throw err
    },
  })
  assert.equal(done.ok, false, "a lost creation race refuses — it never overwrites")
  assert.equal(done.reason, "conflict")
  assert.equal(fs.state[TARGET], undefined, "our temp never landed on the target")
  assert.ok(!fs.writes.some((w) => w.op === "rename"), "creation is never published through rename")
  assert.equal(linkCalls.length, 1, "the exclusive publish ran exactly once")
  assert.ok(linkCalls[0].from.endsWith(".tmp"), "link publishes the owned TEMP")
  assert.equal(linkCalls[0].to, TARGET)
})

test("create P1: writeFile WITHOUT the exclusive link surface refuses BEFORE ANY WRITE (no rename fallback)", () => {
  const { fs } = memFs({})
  const snap = snapshotRecipe({ path: TARGET, ...fs })
  const res = planWorkerEdit(snap, { action: "create", id: "scout", draft: { mode: "auto" } }, { scope: "workspace", pool: "proj" })
  assert.equal(res.ok, true)
  const done = commit(snap, res, { ...fs, link: undefined })
  assert.equal(done.ok, false, "no exclusive publish surface → refuse (fail closed)")
  assert.equal(done.reason, "write-failed")
  assert.match(done.message, /exclusive|link/)
  assert.deepEqual(fs.writes, [], "refused BEFORE ANY WRITE — not even the temp")
  assert.equal(fs.state[TARGET], undefined, "zero writes to the target — no rename fallback for creation")
})

test("create P1: a NON-EEXist exclusive-publish failure fails closed, cleans the temp, writes nothing to the target", () => {
  const { fs } = memFs({})
  const snap = snapshotRecipe({ path: TARGET, ...fs })
  const res = planWorkerEdit(snap, { action: "create", id: "scout", draft: { mode: "auto" } }, { scope: "workspace", pool: "proj" })
  assert.equal(res.ok, true)
  const done = commit(snap, res, {
    ...fs,
    link: () => { throw new Error("ENOSYS: hardlinks not supported by this filesystem") },
  })
  assert.equal(done.ok, false, "an unusable exclusive publish refuses (fail closed)")
  assert.equal(done.reason, "write-failed")
  assert.match(done.message, /ENOSYS|not supported/)
  assert.equal(fs.state[TARGET], undefined, "zero writes to the target")
  assert.ok(fs.writes.some((w) => w.op === "unlink" && w.path.endsWith(".tmp")), "the owned temp was cleaned up")
})


// ---------------------------------------------------------------------------
// Real node:fs creation legs (no injected write surface — the REAL atomic
// path: exclusive-create temp + exclusive hardlink publish).
// ---------------------------------------------------------------------------

test("real fs: first creation writes via the exclusive path and cleans its temp; a competing creation refuses no-clobber", async () => {
  const { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } = await import("node:fs")
  const os = await import("node:os")
  const path = await import("node:path")
  const dir = mkdtempSync(path.join(os.tmpdir(), "forge-create-"))
  try {
    const target = path.join(dir, "forge.json")
    const snap = snapshotRecipe({ path: target }) // absent target, REAL fs
    const res = planWorkerEdit(snap, { action: "create", id: "scout", draft: { mode: "auto" } }, { scope: "workspace", pool: "proj" })
    assert.equal(res.ok, true, JSON.stringify(res.ok === false ? res.message : {}))
    assert.equal(res.plan.kind, "create-file")
    const done = FCE.commitRecipeEdit(snap, { kind: res.plan.kind, path: target, newText: res.plan.newText }, {})
    assert.equal(done.ok, true, JSON.stringify(done))
    assert.equal(done.outcome, "written")
    assert.equal(readFileSync(target, "utf8"), res.plan.newText)
    assert.equal(existsSync(`${target}.forge-tui`), false, "the owned temp was cleaned up after the publish")

    // Competing creation: a NEW snapshot taken while absent, then the rival
    // lands on disk BEFORE the commit — the first pre-temp check refuses.
    const rival = path.join(dir, "rival.json")
    void rival
    const snap2 = snapshotRecipe({ path: target, stat: () => null, readFile: () => { throw new Error("ENOENT") } })
    const res2 = planWorkerEdit(snap2, { action: "create", id: "scribe", draft: { mode: "auto" } }, { scope: "workspace", pool: "proj" })
    assert.equal(res2.ok, true)
    const before = readFileSync(target, "utf8")
    const done2 = FCE.commitRecipeEdit(snap2, { kind: res2.plan.kind, path: target, newText: res2.plan.newText }, {})
    assert.equal(done2.ok, false, "a create onto an existing target refuses (no-clobber)")
    assert.equal(done2.reason, "conflict")
    assert.equal(readFileSync(target, "utf8"), before, "the first creator's bytes are untouched")
    const leftovers = readdirSync(dir).filter((n) => n.includes(".forge-tui-"))
    assert.deepEqual(leftovers, [], "no temp leftovers next to the target")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
