import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// hierarchical-pool-materialization — pool resolver core (spec:
// forge-subagents — "Hierarchical pool materialization on shared hosts") +
// the wiring-level freeze regression (the 14:24/14:26 tear).

import { createPoolResolver, sanitizeNamespace, validatePoolField } from "../src/forge-config.ts"

// ---------------------------------------------------------------------------
// Fake fs: explicit file/dir maps with per-path mtimes (hot-apply tests bump
// them, exactly like editing on a live host).

function fakeFs(initialFiles = {}) {
  const files = { ...initialFiles }
  const dirs = new Map() // path -> Array<{name, dir}> (keep insertion order; resolver sorts)
  const mtimes = new Map()
  const mtimeOf = (p) => mtimes.get(p) ?? 1
  return {
    files,
    dirs,
    stat: (p) => (files[p] !== undefined || dirs.has(p) ? { mtimeMs: mtimeOf(p), size: (files[p] ?? "").length } : null),
    readFile: (p) => files[p],
    readdir: (d) => dirs.get(d) ?? null,
    setDir(path, entries) {
      dirs.set(path, entries.map((e) => (typeof e === "string" ? { name: e, dir: true } : e)))
      mtimes.set(path, mtimeOf(path) + 1)
    },
    writeFile(path, content) {
      files[path] = content
      mtimes.set(path, mtimeOf(path) + 1)
      // Real fs: creating/deleting a file bumps the PARENT dir's mtime —
      // that is what invalidates the resolver's cached poolFile check.
      const parent = path.replace(/[\\/][^\\/]+$/, "")
      if (dirs.has(parent)) mtimes.set(parent, mtimeOf(parent) + 1)
    },
    deleteFile(path) {
      delete files[path]
      mtimes.set(path, mtimeOf(path) + 1)
      const parent = path.replace(/[\\/][^\\/]+$/, "")
      if (dirs.has(parent)) mtimes.set(parent, mtimeOf(parent) + 1)
    },
  }
}

const json = (o) => JSON.stringify(o)
const pinned = { model: "zai/glm", thoughtLevel: "low" }

// The canonical Temp1 layout: root 总管 pool + devAa sub-pool (declared ns
// "aa") + devAb (no pool file) + a node_modules trap.
function temp1Layout(fs) {
  fs.setDir("C:/Temp1", [".opencode", "devAa", "devAb", "node_modules", "docs"])
  fs.setDir("C:/Temp1/.opencode", [{ name: "forge.json", dir: false }])
  fs.writeFile("C:/Temp1/.opencode/forge.json", json({ agents: { research: pinned, plan: pinned } }))
  fs.setDir("C:/Temp1/devAa", [".opencode"])
  fs.setDir("C:/Temp1/devAa/.opencode", [{ name: "forge.json", dir: false }])
  fs.writeFile("C:/Temp1/devAa/.opencode/forge.json", json({ pool: "aa", agents: { shader: pinned } }))
  fs.setDir("C:/Temp1/devAb", ["notes.txt"])
  fs.files["C:/Temp1/devAb/notes.txt"] = "x"
  fs.setDir("C:/Temp1/node_modules", ["pkg"])
  fs.setDir("C:/Temp1/node_modules/pkg", [".opencode"])
  fs.setDir("C:/Temp1/node_modules/pkg/.opencode", [{ name: "forge.json", dir: false }])
  fs.writeFile("C:/Temp1/node_modules/pkg/.opencode/forge.json", json({ agents: { trap: pinned } }))
  fs.setDir("C:/Temp1/docs", [])
}

function resolverOn(fs, opts = {}) {
  return createPoolResolver({ homeDir: "C:/home", stat: fs.stat, readFile: fs.readFile, readdir: fs.readdir, ...opts })
}

// ---------------------------------------------------------------------------
// Namespace primitives

test("sanitizeNamespace: lowercase, charset-run collapse, trim, pool fallback", () => {
  assert.equal(sanitizeNamespace("devAa"), "devaa")
  assert.equal(sanitizeNamespace("Dev Aa_2"), "dev-aa-2")
  assert.equal(sanitizeNamespace("--__--"), "pool")
  assert.equal(sanitizeNamespace("Trailing-"), "trailing")
})

test("validatePoolField: [a-z0-9-] 1..24, trimmed; everything else invalid", () => {
  assert.deepEqual(validatePoolField("aa"), { ok: true, ns: "aa" })
  assert.equal(validatePoolField("Aa").ok, false)
  assert.equal(validatePoolField("aa team").ok, false)
  assert.equal(validatePoolField(7).ok, false)
  assert.equal(validatePoolField(null).ok, false)
  assert.equal(validatePoolField("a".repeat(25)).ok, false)
  assert.equal(validatePoolField("a".repeat(24)).ok, true)
})

// ---------------------------------------------------------------------------
// Single-anchor resolution: root pool plain ids + sub-pools namespaced

test("single anchor: root pool keeps plain ids; sub-pool materializes namespaced; skip-list holds", () => {
  const fs = fakeFs()
  temp1Layout(fs)
  const r = resolverOn(fs).resolve(["C:/Temp1"])
  const primary = r.families.find((f) => f.primary)
  assert.ok(primary, "a primary family exists")
  assert.equal(primary.ns, null)
  assert.equal(primary.file, "C:/Temp1/.opencode/forge.json")
  assert.ok(r.agents.research, "plain id — byte-compatible with a single-anchor host")
  assert.ok(r.agents.plan)
  const sub = r.families.find((f) => f.ns === "aa")
  assert.ok(sub, "the devAa sub-pool family exists under its DECLARED namespace")
  assert.equal(sub.file, "C:/Temp1/devAa/.opencode/forge.json")
  assert.ok(r.agents["aa-shader"], "sub-pool agent materializes as <ns>-<id>")
  assert.equal(r.agents["aa-shader"].def.model, "zai/glm")
  assert.ok(!r.agents.trap && !r.agents["pkg-trap"], "node_modules pools are never discovered")
  assert.deepEqual(r.findings, [], "a clean layout resolves with no findings")
})

test("undeclared sub-pool derives its namespace from the sanitized directory basename", () => {
  const fs = fakeFs()
  fs.setDir("C:/Temp1", ["devAa", ".opencode"])
  fs.setDir("C:/Temp1/.opencode", [{ name: "forge.json", dir: false }])
  fs.writeFile("C:/Temp1/.opencode/forge.json", json({ agents: { research: pinned } }))
  fs.setDir("C:/Temp1/devAa", [".opencode"])
  fs.setDir("C:/Temp1/devAa/.opencode", [{ name: "forge.json", dir: false }])
  fs.writeFile("C:/Temp1/devAa/.opencode/forge.json", json({ agents: { shader: pinned } }))
  const r = resolverOn(fs).resolve(["C:/Temp1"])
  assert.ok(r.agents["devaa-shader"], "ns = sanitized basename when no pool field")
})

test("invalid pool field degrades to a warn finding + directory-name fallback", () => {
  const fs = fakeFs()
  temp1Layout(fs)
  fs.writeFile("C:/Temp1/devAa/.opencode/forge.json", json({ pool: "Aa Team!", agents: { shader: pinned } }))
  const r = resolverOn(fs).resolve(["C:/Temp1"])
  assert.ok(r.agents["devaa-shader"], "the family still materializes under the fallback ns")
  assert.ok(r.findings.some((f) => f.code === "pool-field-invalid" && f.level === "warn" && /Aa Team!/.test(f.message)))
})

// ---------------------------------------------------------------------------
// Deterministic order, budgets, collisions

test("namespace collision: deterministic order, incrementing suffix, finding names both files", () => {
  const fs = fakeFs()
  for (const base of ["C:/a", "C:/b"]) {
    fs.setDir(base, ["dev", ".opencode"])
    fs.setDir(`${base}/dev`, [".opencode"])
    fs.setDir(`${base}/dev/.opencode`, [{ name: "forge.json", dir: false }])
    fs.writeFile(`${base}/dev/.opencode/forge.json`, json({ agents: { coder: pinned } }))
    fs.setDir(`${base}/.opencode`, [{ name: "forge.json", dir: false }])
    fs.writeFile(`${base}/.opencode/forge.json`, json({ agents: { research: pinned } }))
  }
  const r = resolverOn(fs).resolve(["C:/a", "C:/b"])
  assert.ok(r.agents["dev-coder"], "C:/a/dev (first in lex order) keeps the short ns")
  assert.ok(r.agents["dev-2-coder"], "C:/b/dev gets the incrementing suffix")
  assert.ok(r.findings.some((f) => f.code === "pool-namespace-collision" && f.level === "error" && /C:\/a\/dev/.test(f.message) && /C:\/b\/dev/.test(f.message)))
})

test("cross-family materialized-id collision: earlier pool wins, later skipped with a finding", () => {
  const fs = fakeFs()
  fs.setDir("C:/Temp1", ["aa", ".opencode"])
  fs.setDir("C:/Temp1/.opencode", [{ name: "forge.json", dir: false }])
  // Primary pool defines the id "aa-shader" → materializes forge-aa-shader.
  fs.writeFile("C:/Temp1/.opencode/forge.json", json({ agents: { "aa-shader": pinned } }))
  fs.setDir("C:/Temp1/aa", [".opencode"])
  fs.setDir("C:/Temp1/aa/.opencode", [{ name: "forge.json", dir: false }])
  // Sub-pool ns "aa" defines "shader" → would ALSO compose forge-aa-shader.
  fs.writeFile("C:/Temp1/aa/.opencode/forge.json", json({ pool: "aa", agents: { shader: pinned } }))
  const r = resolverOn(fs).resolve(["C:/Temp1"])
  assert.ok(r.agents["aa-shader"], "the primary plain id materializes")
  assert.equal(r.agents["aa-shader"].file, "C:/Temp1/.opencode/forge.json", "the PRIMARY pool's agent wins")
  assert.equal(r.families.find((f) => f.ns === "aa").materializedIds.length, 0, "the colliding namespaced agent is skipped")
  assert.ok(r.findings.some((f) => f.code === "materialized-id-collision" && f.level === "error"))
})

test("scan budget: BFS + lexicographic sibling order decide which pools survive the cap", () => {
  const fs = fakeFs()
  // Children z-first would find deep pools under z if the traversal were
  // readdir-order/DFS; BFS+lex must open b before z, so a budget of 3
  // (anchor + b + b/pool) finds ONLY the b pool.
  fs.setDir("C:/Temp1", ["z", "b", ".opencode"])
  fs.setDir("C:/Temp1/.opencode", [{ name: "forge.json", dir: false }])
  fs.writeFile("C:/Temp1/.opencode/forge.json", json({ agents: { research: pinned } }))
  fs.setDir("C:/Temp1/z", ["deep"])
  fs.setDir("C:/Temp1/z/deep", [".opencode"])
  fs.setDir("C:/Temp1/z/deep/.opencode", [{ name: "forge.json", dir: false }])
  fs.writeFile("C:/Temp1/z/deep/.opencode/forge.json", json({ agents: { zed: pinned } }))
  fs.setDir("C:/Temp1/b", [".opencode"])
  fs.setDir("C:/Temp1/b/.opencode", [{ name: "forge.json", dir: false }])
  fs.writeFile("C:/Temp1/b/.opencode/forge.json", json({ agents: { bee: pinned } }))
  const r = resolverOn(fs, { scanBudget: 3 }).resolve(["C:/Temp1"])
  assert.ok(r.agents["b-bee"], "the lexicographically-first subtree's pool survives the cap")
  assert.ok(!r.agents["deep-zed"] && !r.agents["z-zed"], "over-budget pools contribute nothing — deterministically")
})

// ---------------------------------------------------------------------------
// Multi-anchor hosts

test("anchor accumulation: the second anchor's root pool is a NAMESPACED family; same file dedups", () => {
  const fs = fakeFs()
  temp1Layout(fs)
  // A devAc line anchored INSIDE Temp1: its walk-up root IS Temp1's file.
  // (The root listing is re-set — real fs would show the new child.)
  fs.setDir("C:/Temp1", [".opencode", "devAa", "devAb", "devAc", "node_modules", "docs"])
  fs.setDir("C:/Temp1/devAc", [".opencode"])
  fs.setDir("C:/Temp1/devAc/.opencode", [{ name: "forge.json", dir: false }])
  fs.writeFile("C:/Temp1/devAc/.opencode/forge.json", json({ agents: { tool: pinned } }))
  fs.setDir("D:/Other", [".opencode"])
  fs.setDir("D:/Other/.opencode", [{ name: "forge.json", dir: false }])
  fs.writeFile("D:/Other/.opencode/forge.json", json({ agents: { research: pinned, extra: pinned } }))
  const r = resolverOn(fs).resolve(["C:/Temp1", "D:/Other"])
  assert.ok(r.agents.research && r.agents.research.file === "C:/Temp1/.opencode/forge.json", "primary root keeps the plain id")
  assert.ok(r.agents["other-research"], "the second anchor's root pool is namespaced — no silent shadowing")
  assert.ok(r.agents["aa-shader"], "sub-pools of the first anchor ride along")
  assert.ok(r.agents["devac-tool"], "devAc's sub-pool (seen via Temp1's scan) materializes")
  const devAcCount = r.families.filter((f) => f.file === "C:/Temp1/devAc/.opencode/forge.json").length
  assert.equal(devAcCount, 1, "the same file reached through two anchors materializes exactly once")
  assert.equal(r.families.filter((f) => f.primary).length, 1, "exactly one primary family")
})

test("global layer: base of every family; global-only host keeps plain ids", () => {
  const fs = fakeFs()
  fs.setDir("C:/home/.config/opencode", [{ name: "forge.json", dir: false }])
  fs.writeFile("C:/home/.config/opencode/forge.json", json({ agents: { research: pinned, universal: pinned } }))
  temp1Layout(fs)
  fs.writeFile("C:/Temp1/.opencode/forge.json", json({ agents: { research: { model: "zai/other", thoughtLevel: "high" } } }))
  const r = resolverOn(fs).resolve(["C:/Temp1"])
  assert.equal(r.agents.research.def.model, "zai/other", "family file overrides global per id, wholesale")
  assert.ok(r.agents.universal, "global-only agent rides the primary family with a plain id")
  assert.equal(r.agents["aa-universal"].def.model, "zai/glm", "global base merges into EVERY family")
  // Global-only host: no project file anywhere.
  const fs2 = fakeFs()
  fs2.setDir("C:/home/.config/opencode", [{ name: "forge.json", dir: false }])
  fs2.writeFile("C:/home/.config/opencode/forge.json", json({ agents: { research: pinned } }))
  fs2.setDir("C:/empty", [])
  const r2 = resolverOn(fs2).resolve(["C:/empty"])
  assert.ok(r2.agents.research, "global-only host materializes the global layer as the plain-id family")
  assert.equal(r2.families[0].file, "C:/home/.config/opencode/forge.json")
  assert.equal(r2.families[0].primary, true)
})

test("unconfigured: zero pools across the anchor set, inert and silent", () => {
  const fs = fakeFs()
  fs.setDir("C:/Temp1", [])
  const r = resolverOn(fs).resolve(["C:/Temp1"])
  assert.deepEqual(r.families, [])
  assert.deepEqual(r.agents, {})
  assert.deepEqual(r.findings, [])
})

test("broken pool file empties only its own family; parse location rides the finding", () => {
  const fs = fakeFs()
  temp1Layout(fs)
  fs.writeFile("C:/Temp1/devAa/.opencode/forge.json", "{ broken")
  const r = resolverOn(fs).resolve(["C:/Temp1"])
  assert.ok(r.agents.research, "the root pool still materializes")
  const sub = r.families.find((f) => f.file === "C:/Temp1/devAa/.opencode/forge.json")
  assert.deepEqual(sub.materializedIds, [], "the broken pool contributes no agents (its ns falls back — the file is unparseable)")
  assert.ok(r.findings.some((f) => f.code === "config-parse-error" && /line \d+/.test(f.message) && /C:\/Temp1\/devAa/.test(f.message)))
})

test("file-hot: a new sub-pool appears and a deleted one disappears without any restart", () => {
  const fs = fakeFs()
  temp1Layout(fs)
  const resolver = resolverOn(fs)
  assert.ok(resolver.resolve(["C:/Temp1"]).agents["aa-shader"])
  fs.deleteFile("C:/Temp1/devAa/.opencode/forge.json")
  // (The root listing is re-set — real fs would show the new child.)
  fs.setDir("C:/Temp1", [".opencode", "devAa", "devAb", "devNew", "node_modules", "docs"])
  fs.setDir("C:/Temp1/devNew", [".opencode"])
  fs.setDir("C:/Temp1/devNew/.opencode", [{ name: "forge.json", dir: false }])
  fs.writeFile("C:/Temp1/devNew/.opencode/forge.json", json({ pool: "new", agents: { fresh: pinned } }))
  const r2 = resolver.resolve(["C:/Temp1"])
  assert.ok(!r2.agents["aa-shader"], "deletion hot-applies — the family is gone")
  assert.ok(r2.agents["new-fresh"], "creation hot-applies — the new family materializes")
})

// ---------------------------------------------------------------------------
// Wiring (server-level): the freeze regression + roster surfaces

process.env.FORGE_TEST_NO_FENCE = "1"
process.env.FORGE_TEST_FORGE_HOME = mkdtempSync(join(tmpdir(), "forge-pools-home-"))
process.env.FORGE_TEST_NO_DISPATCH_FETCH = "1"

const { server } = await import("../plugin.ts")

const input = (dir) => ({
  client: { session: {} },
  project: { id: "p" },
  directory: dir,
  worktree: dir,
  serverUrl: new URL("http://127.0.0.1:1"),
  $: () => {},
})
const allowCtx = (sessionID) => ({ sessionID, ask: async () => ({ status: "allow" }), metadata: () => {}, message: async () => {} })
const emptyCfg = () => ({ agent: {}, command: {}, permission: {} })

function dirWithForgeJson(t, prefix, obj) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  t.after(() => {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {}
  })
  mkdirSync(join(dir, ".opencode"), { recursive: true })
  writeFileSync(join(dir, ".opencode", "forge.json"), JSON.stringify(obj))
  return dir
}

// Host-lifetime simulation: fresh host per test (reset before the call); the
// freeze test deliberately re-inits WITHOUT a reset to emulate a shared host.
let lastHost = null
async function startServer(inputArg, opts) {
  if (lastHost) lastHost.__forgeSubagentsTest.resetAnchors()
  lastHost = await server(inputArg, opts)
  return lastHost
}

test("wiring freeze: a re-initialization with another directory only ADDS pools (tear regression)", async (t) => {
  const dirA = dirWithForgeJson(t, "forge-pool-a-", { agents: { research: { model: "zai/glm", thoughtLevel: "low" } } })
  const hA = await startServer(input(dirA), {})
  t.after(() => hA.dispose?.())
  const cfgA = emptyCfg()
  await hA.config(cfgA)
  assert.ok(cfgA.agent["forge-research"], "anchor A materializes")

  // Shared host re-initializes with dir B — the 14:24→14:26 scenario. The
  // RAW server() call (no reset) appends the anchor like a real shared host.
  const dirB = dirWithForgeJson(t, "forge-pool-b-", { agents: { shader: { model: "zai/glm", thoughtLevel: "low" } } })
  const hB = await server(input(dirB), {})
  t.after(() => hB.dispose?.())
  const cfgB = emptyCfg()
  await hB.config(cfgB)
  assert.ok(cfgB.agent["forge-research"], "anchor A's agents SURVIVE the flip — no tear")
  assert.ok(
    Object.keys(cfgB.agent).some((id) => id.startsWith("forge-") && id.endsWith("-shader")),
    "anchor B's root pool materializes NAMESPACED under the anchor set",
  )
  // The gate that refused on the torn host now passes and names both pools.
  const out = await hB.tool.crew_begin.execute({ objective: "o", subtasks: [{ title: "x" }] }, allowCtx("ses_freeze"))
  assert.match(out.output, /root pool \(PRIMARY, plain ids\)/)
  assert.match(out.output, /forge-research/)
  assert.match(out.output, /pool /)
  await hB.tool.crew_close.execute({ abandon: true, reason: "test" }, allowCtx("ses_freeze"))
})

test("wiring roster: the /crew template groups the dispatchable roster by pool with origins", async (t) => {
  const dirA = dirWithForgeJson(t, "forge-pool-ro-", { agents: { research: { model: "zai/glm", thoughtLevel: "low" } } })
  mkdirSync(join(dirA, "devAa", ".opencode"), { recursive: true })
  writeFileSync(join(dirA, "devAa", ".opencode", "forge.json"), JSON.stringify({ pool: "aa", agents: { shader: { model: "zai/glm", thoughtLevel: "low" } } }))
  const h = await startServer(input(dirA), {})
  t.after(() => h.dispose?.())
  const cfg = emptyCfg()
  await h.config(cfg)
  const tpl = h.__forgeSubagentsTest.crewCommand().template
  assert.match(tpl, /grouped by pool/)
  assert.match(tpl, /root pool \(PRIMARY, plain ids\)/)
  assert.match(tpl, /forge-research/)
  assert.match(tpl, /pool aa \(forge-aa-\*\)/)
  assert.match(tpl, /forge-aa-shader/)
  assert.ok(cfg.agent["forge-aa-shader"], "the namespaced agent materializes with identical entry shape")
  const entry = cfg.agent["forge-aa-shader"]
  assert.equal(entry.mode, "subagent")
  assert.equal(entry.permission.task, "deny", "worker semantics are identical for namespaced agents")
  assert.equal(entry.model, "zai/glm", "pinned model rides the namespaced id")
})

test("wiring anchors(): normalized, append-only, deduped; resetAnchors simulates a host restart", async (t) => {
  const dirA = dirWithForgeJson(t, "forge-pool-norm-", { agents: {} })
  const h = await startServer(input(dirA), {})
  t.after(() => h.dispose?.())
  const anchors1 = h.__forgeSubagentsTest.anchors()
  assert.equal(anchors1.length, 1)
  // Same directory, different case + slashes → dedup, not a second anchor.
  await server({ ...input(dirA.toUpperCase()), worktree: dirA.toUpperCase() }, {})
  assert.equal(h.__forgeSubagentsTest.anchors().length, 1, "case/slash variants fold into one anchor")
  h.__forgeSubagentsTest.resetAnchors()
  assert.equal(h.__forgeSubagentsTest.anchors().length, 0, "reset = honest host restart")
})
