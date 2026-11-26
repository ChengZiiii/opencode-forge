import test from "node:test"
import assert from "node:assert/strict"

// Task 1.2 — the hierarchical-pools (sole-pool-ownership) matrix ported to
// the V2 harness: v2Setup with the injected fake fs + anchor/home seams
// resolves through the COMPLETE src/forge-config.ts createPoolResolver —
// the same core the v1 config hook uses. Ported key cases: workspace pool
// owns the roster / global fallback (forge-global-*) / nested subtree
// ignored / delete-file un-materializes / namespace collisions / cross-init
// id stability; plus shape permissions and provenance parity.

import { createV2MockContext } from "./lib/v2-mock-context.mjs"
import { v2Setup } from "../plugin.ts"

// Fake fs (same pattern as hierarchical-pools.test.mjs): explicit file map
// with per-path mtimes so deletions hot-apply.
function fakeFs(initialFiles = {}) {
  const files = { ...initialFiles }
  const dirs = new Map()
  const mtimes = new Map()
  const mtimeOf = (p) => mtimes.get(p) ?? 1
  return {
    files,
    stat: (p) => (files[p] !== undefined || dirs.has(p) ? { mtimeMs: mtimeOf(p), size: (files[p] ?? "").length } : null),
    readFile: (p) => files[p],
    setDir(path, entries) {
      dirs.set(path, entries.map((e) => (typeof e === "string" ? { name: e, dir: true } : e)))
    },
    writeFile(path, content) {
      files[path] = content
      mtimes.set(path, mtimeOf(path) + 1)
    },
    deleteFile(path) {
      delete files[path]
      mtimes.set(path, mtimeOf(path) + 1)
    },
  }
}

const json = (o) => JSON.stringify(o)
const MUTATING = ["write", "edit", "patch", "applypatch", "apply", "multiedit", "execute"]

// One host init: fresh mock ctx (fresh agent draft = a new host, mirroring
// the v1 wiring tests' startServer registry reset) resolving over the given
// anchors + fake fs + home.
async function hostInit(fs, anchors, home = "C:/v2home") {
  const { ctx, state } = createV2MockContext()
  // materialize:"runtime" — this suite pins the DRAFT materialization path
  // (the v2 escape hatch); the native default has its own suite
  // (tests/native-roster-wiring.test.mjs).
  await v2Setup(ctx, { anchors, homeDir: home, stat: fs.stat, readFile: fs.readFile, materialize: "runtime" })
  return state
}

const subIds = (state) => [...state.agents.keys()].filter((id) => id.startsWith("forge-")).sort()

// ---------------------------------------------------------------------------
// 1. Workspace pool owns the roster — namespaced, no plain ids

test("v2 pools: workspace pool materializes NAMESPACED with provenance, task deny (model pin is V1-only on v2)", async () => {
  const fs = fakeFs()
  fs.setDir("C:/WsA", [".opencode"])
  fs.setDir("C:/WsA/.opencode", [{ name: "forge.json", dir: false }])
  fs.writeFile("C:/WsA/.opencode/forge.json", json({ pool: "alpha", agents: { research: { model: "zai/glm", thoughtLevel: "low" }, scout: {} } }))
  const state = await hostInit(fs, ["C:/WsA"], "C:/v2home-none")
  assert.ok(state.agents.has("forge"), "the primary agent still registers")
  assert.ok(state.agents.has("forge-alpha-research"))
  assert.ok(state.agents.has("forge-alpha-scout"))
  assert.equal(state.agents.has("forge-research"), false, "no plain-id agent (all pools namespaced)")
  const r = state.agents.get("forge-alpha-research")
  assert.equal(r.mode, "subagent")
  // W6 field reality (live bisect 2026-11-19): ANY model spelling on the
  // v2 agent draft breaks the host's /api/agent encoder — the model pin is
  // NOT written on the v2 draft (documented drift; the depth pin still
  // rides the runtime chat.params pool lookup by agent id).
  assert.equal("model" in r, false, "no model key on the v2 draft (pin would 500 the agent encoder)")
  // v2-single-agent-surface field-name fix: v2 records carry `permissions`
  // as an ARRAY of {action, resource, effect} — the singular record spelling
  // never reached the host. Task deny and the shell-deny front door both
  // ride the array now.
  assert.ok(Array.isArray(r.permissions), "worker permissions are the v2 array form")
  assert.ok(r.permissions.some((p) => p.action === "task" && p.resource === "*" && p.effect === "deny"), "recursion ban always forced")
  assert.ok(!r.permissions.some((p) => p.action === "shell" && p.resource === "*" && p.effect === "deny"), "no blanket shell deny")
  assert.equal("permission" in r, false, "the singular permission key is gone")
  assert.match(r.description, /Pool 'alpha' — origin/)
  assert.ok(r.description.includes("C:/WsA/.opencode/forge.json"), "origin path rides the description")
  assert.match(r.description, /dispatchable only from sessions whose workspace pool is this file/)
  assert.equal("model" in state.agents.get("forge-alpha-scout"), false, "Auto worker carries no model key")
})

// 2. Shape permissions parity (MUTATING_TOOLS deny family / task deny always)

test("v2 pools: readonly shape denies the mutating family; absent shape defaults write", async () => {
  const fs = fakeFs()
  fs.setDir("C:/WsB", [".opencode"])
  fs.setDir("C:/WsB/.opencode", [{ name: "forge.json", dir: false }])
  fs.writeFile(
    "C:/WsB/.opencode/forge.json",
    json({ pool: "beta", agents: { reviewer: { shape: "readonly" }, coder: {} } }),
  )
  const state = await hostInit(fs, ["C:/WsB"], "C:/v2home-none")
  const ro = state.agents.get("forge-beta-reviewer").permissions
  const wr = state.agents.get("forge-beta-coder").permissions
  for (const t of MUTATING) assert.ok(ro.some((p) => p.action === t && p.effect === "deny"), `readonly denies ${t}`)
  for (const t of MUTATING) assert.equal(wr.some((p) => p.action === t), false, `write default leaves ${t} alone`)
  assert.ok(!ro.some((p) => p.action === "shell" && p.effect === "deny"), "readonly has no blanket shell deny")
  assert.ok(wr.some((p) => p.action === "task" && p.effect === "deny"), "task deny is forced on every shape")
  assert.ok(!wr.some((p) => p.action === "shell" && p.effect === "deny"), "no blanket shell deny")
})

// 3. Global fallback when the workspace has no pool

test("v2 pools: pool-less workspace falls back to the GLOBAL layer (forge-global-<id>)", async () => {
  const fs = fakeFs()
  fs.setDir("C:/v2homeG/.config/opencode", [{ name: "forge.json", dir: false }])
  fs.writeFile("C:/v2homeG/.config/opencode/forge.json", json({ agents: { research: { model: "zai/glm", thoughtLevel: "low" } } }))
  fs.setDir("C:/Bare", [])
  const state = await hostInit(fs, ["C:/Bare"], "C:/v2homeG")
  assert.ok(state.agents.has("forge-global-research"), "global fallback materializes under the FIXED global namespace")
  const g = state.agents.get("forge-global-research")
  assert.match(g.description, /Pool 'global' — origin: the global fallback layer\./)
  assert.ok(Array.isArray(g.permissions) && g.permissions.some((p) => p.action === "task" && p.effect === "deny"), "task deny rides the v2 permissions array")
})

// 4. Global fallback NON-MERGE ported analog: workspace pool + global layer
//    both materialize under their OWN namespaces — the workspace roster is
//    never merged into (or displaced by) the global family.

test("v2 pools: workspace pool + global layer coexist under distinct namespaces (no merge, no clobber)", async () => {
  const fs = fakeFs()
  fs.setDir("C:/v2homeM/.config/opencode", [{ name: "forge.json", dir: false }])
  fs.writeFile("C:/v2homeM/.config/opencode/forge.json", json({ agents: { research: { model: "zai/glm", thoughtLevel: "low" } } }))
  fs.setDir("C:/WsC", [".opencode"])
  fs.setDir("C:/WsC/.opencode", [{ name: "forge.json", dir: false }])
  fs.writeFile("C:/WsC/.opencode/forge.json", json({ pool: "gamma", agents: { research: { model: "zai/glm", thoughtLevel: "low" } } }))
  const state = await hostInit(fs, ["C:/WsC"], "C:/v2homeM")
  assert.ok(state.agents.has("forge-gamma-research"), "the workspace family's id wins its own namespace")
  assert.ok(state.agents.has("forge-global-research"), "the global family still materializes host-wide")
  assert.deepEqual(subIds(state), ["forge-gamma-research", "forge-global-research"])
})

// 5. Nested subtree ignored

test("v2 pools: nested forge.json files contribute NOTHING (no subtree scan)", async () => {
  const fs = fakeFs()
  fs.setDir("C:/WsD", [".opencode", "sub", "node_modules"])
  fs.setDir("C:/WsD/.opencode", [{ name: "forge.json", dir: false }])
  fs.writeFile("C:/WsD/.opencode/forge.json", json({ pool: "delta", agents: { research: {} } }))
  fs.setDir("C:/WsD/sub", [".opencode"])
  fs.setDir("C:/WsD/sub/.opencode", [{ name: "forge.json", dir: false }])
  fs.writeFile("C:/WsD/sub/.opencode/forge.json", json({ pool: "nested", agents: { shader: {} } }))
  fs.setDir("C:/WsD/node_modules", ["pkg"])
  fs.setDir("C:/WsD/node_modules/pkg", [".opencode"])
  fs.setDir("C:/WsD/node_modules/pkg/.opencode", [{ name: "forge.json", dir: false }])
  fs.writeFile("C:/WsD/node_modules/pkg/.opencode/forge.json", json({ agents: { trap: {} } }))
  const state = await hostInit(fs, ["C:/WsD"], "C:/v2home-none")
  assert.deepEqual(subIds(state), ["forge-delta-research"], "only the anchor's walk-up NEAREST pool materializes")
})

// 6. Delete-file un-materializes (fresh host after deletion sees no pool)

test("v2 pools: deleting the pool file un-materializes its agents (disk truth, fresh host)", async () => {
  const fs = fakeFs()
  fs.setDir("C:/WsE", [".opencode"])
  fs.setDir("C:/WsE/.opencode", [{ name: "forge.json", dir: false }])
  fs.writeFile("C:/WsE/.opencode/forge.json", json({ pool: "eps", agents: { research: {} } }))
  const before = await hostInit(fs, ["C:/WsE"], "C:/v2home-none")
  assert.ok(before.agents.has("forge-eps-research"))
  fs.deleteFile("C:/WsE/.opencode/forge.json")
  const after = await hostInit(fs, ["C:/WsE"], "C:/v2home-none")
  assert.equal(after.agents.has("forge-eps-research"), false, "no zombie pools — deletion is real")
})

// 7. Namespace collisions: two pools declaring the same `pool` ns

test("v2 pools: namespace collision disambiguates with an incrementing suffix", async () => {
  const fs = fakeFs()
  for (const ws of ["C:/Zeta", "C:/Eta"]) {
    fs.setDir(ws, [".opencode"])
    fs.setDir(`${ws}/.opencode`, [{ name: "forge.json", dir: false }])
  }
  fs.writeFile("C:/Zeta/.opencode/forge.json", json({ pool: "same", agents: { one: {} } }))
  fs.writeFile("C:/Eta/.opencode/forge.json", json({ pool: "same", agents: { two: {} } }))
  const state = await hostInit(fs, ["C:/Zeta", "C:/Eta"], "C:/v2home-none")
  const ids = subIds(state)
  assert.equal(ids.length, 2, "both families materialize")
  const nss = new Set(ids.map((id) => id.replace(/^forge-/, "").split("-").slice(0, -1).join("-")))
  assert.equal(nss.size, 2, `the colliding ns got a suffix (got ${[...nss].join(",")})`)
})

// 8. Cross-family materialized-id collision: distinct ns ("aa" vs "aa-b")
//    composing the SAME materialized id — earlier file in path order wins,
//    later skipped (deterministically). Same plain id across pools is NOT a
//    collision (namespacing) — asserted alongside.

test("v2 pools: same agent id in two pools stays collision-free; a composed id collision resolves lexicographically", async () => {
  const fs = fakeFs()
  const pools = [
    ["C:/Aaa", "aa", { "b-shader": {} }],
    ["C:/Bbb", "aa-b", { shader: {} }],
  ]
  for (const [ws, pool, agents] of pools) {
    fs.setDir(ws, [".opencode"])
    fs.setDir(`${ws}/.opencode`, [{ name: "forge.json", dir: false }])
    fs.writeFile(`${ws}/.opencode/forge.json`, json({ pool, agents }))
  }
  const state = await hostInit(fs, ["C:/Bbb", "C:/Aaa"], "C:/v2home-none")
  // Both families compose "aa-b-shader" — only the path-earlier one (C:/Aaa)
  // materializes, deterministically regardless of anchor order.
  assert.deepEqual(subIds(state), ["forge-aa-b-shader"], "composed-id collision: lexicographic winner only")

  const fs2 = fakeFs()
  fs2.setDir("C:/Cc", [".opencode"])
  fs2.setDir("C:/Cc/.opencode", [{ name: "forge.json", dir: false }])
  fs2.writeFile("C:/Cc/.opencode/forge.json", json({ pool: "cc", agents: { shared: {} } }))
  fs2.setDir("C:/Dd", [".opencode"])
  fs2.setDir("C:/Dd/.opencode", [{ name: "forge.json", dir: false }])
  fs2.writeFile("C:/Dd/.opencode/forge.json", json({ pool: "dd", agents: { shared: {} } }))
  const state2 = await hostInit(fs2, ["C:/Dd", "C:/Cc"], "C:/v2home-none")
  assert.deepEqual(subIds(state2), ["forge-cc-shared", "forge-dd-shared"], "same plain id across namespaces: no collision")
})

// 9. Cross-init id stability: reverse anchor arrival order, same ids

test("v2 pools: materialized ids are stable across init order (host-history independence)", async () => {
  const mk = () => {
    const fs = fakeFs()
    for (const ws of ["C:/Kk", "C:/Jj", "C:/Ll"]) {
      fs.setDir(ws, [".opencode"])
      fs.setDir(`${ws}/.opencode`, [{ name: "forge.json", dir: false }])
    }
    fs.writeFile("C:/Jj/.opencode/forge.json", json({ pool: "jj", agents: { a: {} } }))
    fs.writeFile("C:/Kk/.opencode/forge.json", json({ pool: "kk", agents: { b: {} } }))
    fs.writeFile("C:/Ll/.opencode/forge.json", json({ pool: "ll", agents: { c: {} } }))
    return fs
  }
  const fwd = await hostInit(mk(), ["C:/Jj", "C:/Kk", "C:/Ll"], "C:/v2home-none")
  const rev = await hostInit(mk(), ["C:/Ll", "C:/Kk", "C:/Jj"], "C:/v2home-none")
  assert.deepEqual(subIds(fwd), ["forge-jj-a", "forge-kk-b", "forge-ll-c"])
  assert.deepEqual(subIds(fwd), subIds(rev), "identical id set regardless of anchor arrival order")
})

// 10. Create-only semantics against a user-owned entry

test("v2 pools: user-owned forge-* entries are never clobbered (create-only)", async () => {
  const fs = fakeFs()
  fs.setDir("C:/WsF", [".opencode"])
  fs.setDir("C:/WsF/.opencode", [{ name: "forge.json", dir: false }])
  fs.writeFile("C:/WsF/.opencode/forge.json", json({ pool: "zeta", agents: { research: {} } }))
  const deps = { anchors: ["C:/WsF"], homeDir: "C:/v2home-none", stat: fs.stat, readFile: fs.readFile, materialize: "runtime" }
  const { ctx, state } = createV2MockContext()
  await v2Setup(ctx, deps)
  assert.ok(state.agents.has("forge-zeta-research"))
  state.agents.get("forge-zeta-research").system = "USER OWNED"
  // Same host, re-init (the draft persists): the entry must stand.
  await v2Setup(ctx, deps)
  assert.equal(state.agents.get("forge-zeta-research").system, "USER OWNED")
})

// 11. Drifted agent domain: no materialization, no throw (conventions §6)

test("v2 pools: drifted agent domain degrades to no-op, never throws", async () => {
  const fs = fakeFs()
  fs.setDir("C:/WsG", [".opencode"])
  fs.setDir("C:/WsG/.opencode", [{ name: "forge.json", dir: false }])
  fs.writeFile("C:/WsG/.opencode/forge.json", json({ pool: "eta", agents: { research: {} } }))
  for (const mode of ["missing", "not-function", "bad-shape"]) {
    const { ctx, state } = createV2MockContext({ drift: { agent: mode } })
    await assert.doesNotReject(v2Setup(ctx, { anchors: ["C:/WsG"], homeDir: "C:/v2home-none", stat: fs.stat, readFile: fs.readFile }))
    assert.equal(state.agents.size, 0, `${mode}: nothing registered`)
  }
})


test("v2 pools: malformed agent is skipped without suppressing its valid sibling", async () => {
  const fs = fakeFs()
  fs.writeFile("C:/Wire/.opencode/forge.json", json({ pool: "wire", agents: { good: { model: "p/good", thoughtLevel: "low" }, bad: { thoughtLevel: "low" } } }))
  const state = await hostInit(fs, ["C:/Wire"], "C:/v2home-none")
  assert.ok(state.agents.has("forge-wire-good"))
  assert.equal(state.agents.has("forge-wire-bad"), false)
})

test("v2 pools: prefixed ids self-heal without doubling", async () => {
  const fs = fakeFs()
  fs.writeFile("C:/Wire/.opencode/forge.json", json({ pool: "wire", agents: { "forge-coder": { model: "zai/glm", thoughtLevel: "low" } } }))
  const state = await hostInit(fs, ["C:/Wire"], "C:/v2home-none")
  assert.ok(state.agents.has("forge-wire-coder"))
  assert.equal(state.agents.has("forge-wire-forge-coder"), false)
})

test("v2 pools: shared role text materializes before the intact mandates", async () => {
  const fs = fakeFs()
  const shared = "Project X conventions: use bun; cite file:line evidence."
  fs.writeFile("C:/Wire/.opencode/forge.json", json({ pool: "wp", shared, agents: { auditor: { model: "x/y", thoughtLevel: "low", prompt: "Audit licenses." } } }))
  const state = await hostInit(fs, ["C:/Wire"], "C:/v2home-none")
  const entry = state.agents.get("forge-wp-auditor")
  assert.ok(entry)
  assert.ok(entry.system.includes(`${shared}

Audit licenses.`))
  assert.ok(entry.system.indexOf(shared) < entry.system.indexOf("Mandates"))
  assert.match(entry.system, /workspace-relative paths ONLY/)
})
