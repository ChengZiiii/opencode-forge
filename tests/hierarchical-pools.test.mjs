import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// sole-pool-ownership + pool-namespace-contract — pool resolver core (spec:
// forge-subagents — "Workspace pool ownership and global fallback") + the
// wiring-level session-domain surfaces (dispatch gate matrix, roster
// templates). Every family materializes namespaced (forge-<ns>-<id>); the
// global fallback family is forge-global-<id>; there are NO plain ids.

import { createPoolResolver, sanitizeNamespace, validatePoolField, poolFileCompliance } from "../src/forge-config.ts"
import { rolePromptFor, forgeAgentDef } from "../src/dispatch-tiers.ts"
import { materializeAgentPrompt } from "../src/dispatch-prompt.ts"

// ---------------------------------------------------------------------------
// Fake fs: explicit file/dir maps with per-path mtimes (hot-apply tests bump
// them, exactly like editing on a live host).

function fakeFs(initialFiles = {}) {
  const files = { ...initialFiles }
  const dirs = new Map() // path -> Array<{name, dir}>
  const mtimes = new Map()
  const mtimeOf = (p) => mtimes.get(p) ?? 1
  return {
    files,
    dirs,
    stat: (p) => (files[p] !== undefined || dirs.has(p) ? { mtimeMs: mtimeOf(p), size: (files[p] ?? "").length } : null),
    readFile: (p) => files[p],
    setDir(path, entries) {
      dirs.set(path, entries.map((e) => (typeof e === "string" ? { name: e, dir: true } : e)))
      mtimes.set(path, mtimeOf(path) + 1)
    },
    writeFile(path, content) {
      files[path] = content
      mtimes.set(path, mtimeOf(path) + 1)
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

// A workspace layout: root pool + a NESTED folder carrying its own
// forge.json (must be ignored) + a node_modules trap (also invisible — no
// subtree scan exists at all anymore).
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
  return createPoolResolver({ homeDir: "C:/home", stat: fs.stat, readFile: fs.readFile, ...opts })
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

test("poolFileCompliance: file-level predicate — valid declared pool iff compliant", () => {
  // valid value → compliant, no violation text
  const ok = poolFileCompliance({ pool: "aa", agents: { x: pinned } })
  assert.equal(ok.compliant, true)
  assert.equal(ok.violation, "")
  // missing field (absent, null, non-object top, undefined) → missing-violation
  for (const top of [undefined, null, {}, { agents: { x: pinned } }, "not an object", 7]) {
    const v = poolFileCompliance(top)
    assert.equal(v.compliant, false, `non-compliant for ${JSON.stringify(top)}`)
    assert.match(v.violation, /missing top-level pool field/, "missing-vs-invalid distinction")
  }
  // invalid values → invalid-violation (charset, wrong type, over-length)
  for (const bad of ["Aa Team!", 7, "a".repeat(25), true]) {
    const v = poolFileCompliance({ pool: bad })
    assert.equal(v.compliant, false, `non-compliant for pool=${JSON.stringify(bad)}`)
    assert.match(v.violation, /invalid top-level pool field/, "missing-vs-invalid distinction")
  }
  // per-agent entries never affect the predicate (file-level scope)
  assert.equal(poolFileCompliance({ pool: "aa", agents: "garbage-not-an-object" }).compliant, true)
})

// ---------------------------------------------------------------------------
// Sole ownership: workspace pool = the whole roster; nested files ignored

test("workspace pool materializes NAMESPACED (no plain ids); nested forge.json files contribute NOTHING", () => {
  const fs = fakeFs()
  temp1Layout(fs)
  const r = resolverOn(fs).resolve(["C:/Temp1"])
  assert.equal(r.families.length, 1, "exactly one family: the workspace pool")
  const fam = r.families[0]
  assert.equal(fam.file, "C:/Temp1/.opencode/forge.json")
  assert.equal(fam.ns, "temp1", "no pool field → ns = sanitized pool-dir basename")
  assert.equal(fam.primary, undefined, "the primary flag is gone from the family type")
  assert.ok(r.agents["temp1-research"] && r.agents["temp1-plan"], "ids are namespaced forge-temp1-* — no plain ids anywhere")
  assert.ok(!r.agents.research && !r.agents.plan, "no plain-id family exists")
  assert.ok(!r.agents["aa-shader"] && !r.agents.shader, "the NESTED devAa forge.json is ignored entirely (no subtree scan)")
  assert.ok(!r.agents.trap && !r.agents["pkg-trap"], "node_modules pools are never discovered either")
  assert.deepEqual(r.findings, [], "a clean layout resolves with no findings")
})

test("workspacePoolOf: nearest forge.json walking up; a subdirectory anchor resolves to the parent's pool", () => {
  const fs = fakeFs()
  temp1Layout(fs)
  const res = resolverOn(fs)
  assert.equal(res.workspacePoolOf("C:/Temp1"), "C:/Temp1/.opencode/forge.json")
  assert.equal(res.workspacePoolOf("C:/Temp1/devAb"), "C:/Temp1/.opencode/forge.json", "a nested session anchors to the OWNING workspace pool above it")
  assert.equal(res.workspacePoolOf("C:/empty"), null, "a poolless directory has no workspace pool")
  assert.equal(res.workspacePoolOf(""), null)
})

test("a session anchored deeper than a nested forge.json still resolves UP past it (nearest-first chain)", () => {
  const fs = fakeFs()
  fs.setDir("C:/w", [".opencode", "sub"])
  fs.setDir("C:/w/.opencode", [{ name: "forge.json", dir: false }])
  fs.writeFile("C:/w/.opencode/forge.json", json({ agents: { root: pinned } }))
  fs.setDir("C:/w/sub", [".opencode"])
  fs.setDir("C:/w/sub/.opencode", [{ name: "forge.json", dir: false }])
  fs.writeFile("C:/w/sub/.opencode/forge.json", json({ pool: "sub", agents: { deep: pinned } }))
  const res = resolverOn(fs)
  // The sub directory's OWN nearest file is its own — that workspace owns it
  // when a session anchors there; but from the host-wide view anchored at
  // C:/w the nested file never joins the materialization set.
  assert.equal(res.workspacePoolOf("C:/w/sub"), "C:/w/sub/.opencode/forge.json")
  const r = res.resolve(["C:/w"])
  assert.ok(r.agents["w-root"], "the root pool's agent materializes namespaced (ns from dir basename)")
  assert.ok(!r.agents.deep && !r.agents["sub-deep"], "the host anchored at C:/w never materializes the nested pool")
})

// ---------------------------------------------------------------------------
// Global fallback (fallback, NOT merge)

test("poolless workspace: the global layer serves as the whole roster under the FIXED ns 'global'", () => {
  const fs = fakeFs()
  fs.setDir("C:/home/.config/opencode", [{ name: "forge.json", dir: false }])
  fs.writeFile("C:/home/.config/opencode/forge.json", json({ agents: { research: pinned, universal: pinned } }))
  fs.setDir("C:/empty", [])
  const r = resolverOn(fs).resolve(["C:/empty"])
  assert.ok(r.agents["global-research"] && r.agents["global-universal"], "the global fallback materializes as forge-global-* — even on a global-only host")
  assert.ok(!r.agents.research && !r.agents.universal, "no plain ids for the global family (the legacy branch is dead)")
  assert.equal(r.families.length, 1)
  assert.equal(r.families[0].file, "C:/home/.config/opencode/forge.json")
  assert.equal(r.families[0].ns, "global", "the global fallback family derives the FIXED ns 'global'")
})

test("fallback NOT merged: a workspace with a pool never sees global agents in its family", () => {
  const fs = fakeFs()
  fs.setDir("C:/home/.config/opencode", [{ name: "forge.json", dir: false }])
  fs.writeFile("C:/home/.config/opencode/forge.json", json({ agents: { research: { model: "zai/global", thoughtLevel: "high" }, universal: pinned } }))
  temp1Layout(fs)
  fs.writeFile("C:/Temp1/.opencode/forge.json", json({ agents: { research: pinned } }))
  const r = resolverOn(fs).resolve(["C:/Temp1"])
  assert.equal(r.agents["temp1-research"].file, "C:/Temp1/.opencode/forge.json", "the workspace pool's own research stands — no per-id global override merge")
  assert.equal(r.agents["temp1-research"].def.model, "zai/glm")
  assert.ok(!r.agents.universal, "a global-only agent does NOT ride the workspace family (fallback, not merge)")
  const globalFamily = r.families.find((f) => f.file === "C:/home/.config/opencode/forge.json")
  assert.ok(globalFamily, "the global layer still materializes HOST-WIDE (fallback for poolless sessions)")
  assert.equal(globalFamily.ns, "global")
  assert.deepEqual(globalFamily.materializedIds.sort(), ["global-research", "global-universal"])
  assert.ok(r.agents["global-universal"], "global agents materialize namespaced under forge-global-*")
})

test("a declared pool field on the global fallback file is IGNORED — the ns stays FIXED 'global' (design D2, zero exceptions)", () => {
  const fs = fakeFs()
  fs.setDir("C:/home/.config/opencode", [{ name: "forge.json", dir: false }])
  fs.writeFile("C:/home/.config/opencode/forge.json", json({ pool: "shared", agents: { research: pinned } }))
  temp1Layout(fs)
  const r = resolverOn(fs).resolve(["C:/Temp1"])
  const globalFamily = r.families.find((f) => f.file === "C:/home/.config/opencode/forge.json")
  assert.equal(globalFamily.ns, "global", "the FIXED ns wins over any declared value (no rename, ever)")
  assert.ok(r.agents["global-research"], "the agents materialize as forge-global-* despite the declared field")
  assert.ok(!r.agents["shared-research"], "the declared value never leaks into ids")
  assert.ok(r.findings.some((f) => f.code === "pool-field-ignored-global" && f.level === "warn" && /C:\/home\/\.config\/opencode\/forge\.json/.test(f.message) && /global fallback namespace is fixed/.test(f.message)), "the ignore is disclosed with a warn finding naming the file")
})

// ---------------------------------------------------------------------------
// Deletion un-materializes (mtime hot-apply; no append-only anchor set)

test("deleting the workspace pool file un-materializes it — the session falls back to the global layer", () => {
  const fs = fakeFs()
  fs.setDir("C:/home/.config/opencode", [{ name: "forge.json", dir: false }])
  fs.writeFile("C:/home/.config/opencode/forge.json", json({ agents: { fallback: pinned } }))
  temp1Layout(fs)
  const res = resolverOn(fs)
  const r1 = res.resolve(["C:/Temp1"])
  assert.ok(r1.agents["temp1-research"], "the workspace pool materializes while the file exists")
  fs.deleteFile("C:/Temp1/.opencode/forge.json")
  const r2 = res.resolve(["C:/Temp1"])
  assert.ok(!r2.agents["temp1-research"] && !r2.agents["temp1-plan"], "deletion hot-applies — the pool's agents are gone (no zombie pool)")
  assert.ok(r2.agents["global-fallback"], "the now-poolless workspace falls back to the global layer — namespaced forge-global-*")
  assert.equal(r2.families.length, 1)
  assert.equal(r2.families[0].file, "C:/home/.config/opencode/forge.json")
  assert.equal(r2.families[0].ns, "global")
  assert.ok(!r2.agents["aa-shader"], "nested files stay invisible after the flip")
})

test("creation hot-applies: a workspace pool appearing on disk materializes without restart", () => {
  const fs = fakeFs()
  fs.setDir("C:/Temp1", [".opencode"])
  fs.setDir("C:/Temp1/.opencode", [])
  fs.setDir("C:/other", [])
  const res = resolverOn(fs)
  assert.deepEqual(res.resolve(["C:/Temp1", "C:/other"]).families, [], "unconfigured: inert and silent")
  fs.writeFile("C:/Temp1/.opencode/forge.json", json({ agents: { fresh: pinned } }))
  const r = res.resolve(["C:/Temp1", "C:/other"])
  assert.ok(r.agents["temp1-fresh"], "creation hot-applies — the new pool materializes NAMESPACED (dir-basename ns)")
})

// ---------------------------------------------------------------------------
// Multi-workspace hosts: namespaces, collisions, deterministic order

test("same-id agents across workspaces stay collision-free (each under its own namespace)", () => {
  const fs = fakeFs()
  fs.setDir("C:/a", [".opencode"])
  fs.setDir("C:/a/.opencode", [{ name: "forge.json", dir: false }])
  fs.writeFile("C:/a/.opencode/forge.json", json({ agents: { coder: pinned } }))
  fs.setDir("D:/b", [".opencode"])
  fs.setDir("D:/b/.opencode", [{ name: "forge.json", dir: false }])
  fs.writeFile("D:/b/.opencode/forge.json", json({ pool: "teamb", agents: { coder: pinned } }))
  const r = resolverOn(fs).resolve(["C:/a", "D:/b"])
  assert.ok(r.agents["a-coder"], "the undeclared pool's coder materializes as forge-a-coder (dir-basename ns)")
  assert.equal(r.agents["a-coder"].file, "C:/a/.opencode/forge.json")
  assert.ok(r.agents["teamb-coder"], "the other workspace's coder materializes as forge-teamb-coder — no silent overwrite, no plain-id privilege")
  assert.ok(!r.agents.coder, "no plain-id family exists")
  assert.deepEqual(r.findings, [])
})

test("an undeclared pool derives its namespace from the sanitized pool-directory basename", () => {
  const fs = fakeFs()
  fs.setDir("C:/a", [".opencode"])
  fs.setDir("C:/a/.opencode", [{ name: "forge.json", dir: false }])
  fs.writeFile("C:/a/.opencode/forge.json", json({ agents: { research: pinned } }))
  fs.setDir("C:/Dev Aa_2", [".opencode"])
  fs.setDir("C:/Dev Aa_2/.opencode", [{ name: "forge.json", dir: false }])
  fs.writeFile("C:/Dev Aa_2/.opencode/forge.json", json({ agents: { shader: pinned } }))
  const r = resolverOn(fs).resolve(["C:/a", "C:/Dev Aa_2"])
  assert.ok(r.agents["dev-aa-2-shader"], "ns = sanitized pool-dir basename when no pool field")
})

test("invalid pool field degrades to a warn finding + directory-name fallback", () => {
  const fs = fakeFs()
  fs.setDir("C:/a", [".opencode"])
  fs.setDir("C:/a/.opencode", [{ name: "forge.json", dir: false }])
  fs.writeFile("C:/a/.opencode/forge.json", json({ agents: { research: pinned } }))
  fs.setDir("C:/Temp1", [".opencode"])
  fs.setDir("C:/Temp1/.opencode", [{ name: "forge.json", dir: false }])
  fs.writeFile("C:/Temp1/.opencode/forge.json", json({ pool: "Aa Team!", agents: { shader: pinned } }))
  const r = resolverOn(fs).resolve(["C:/a", "C:/Temp1"])
  assert.ok(r.agents["temp1-shader"], "the family still materializes under the fallback ns")
  assert.ok(r.findings.some((f) => f.code === "pool-field-invalid" && f.level === "warn" && /Aa Team!/.test(f.message)))
})

test("namespace collision: deterministic order, incrementing suffix, finding names both files", () => {
  const fs = fakeFs()
  for (const base of ["C:/a", "C:/b"]) {
    fs.setDir(base, [".opencode"])
    fs.setDir(`${base}/.opencode`, [{ name: "forge.json", dir: false }])
  }
  fs.writeFile("C:/a/.opencode/forge.json", json({ agents: { research: pinned } }))
  fs.writeFile("C:/b/.opencode/forge.json", json({ pool: "dev", agents: { coder: pinned } }))
  fs.setDir("D:/c", [".opencode"])
  fs.setDir("D:/c/.opencode", [{ name: "forge.json", dir: false }])
  fs.writeFile("D:/c/.opencode/forge.json", json({ pool: "dev", agents: { coder: pinned } }))
  const r = resolverOn(fs).resolve(["C:/a", "C:/b", "D:/c"])
  assert.ok(r.agents["dev-coder"], "C:/b (first in lex order among the dev declarers) keeps the short ns")
  assert.ok(r.agents["dev-2-coder"], "D:/c gets the incrementing suffix")
  assert.ok(r.findings.some((f) => f.code === "pool-namespace-collision" && f.level === "error" && /C:\/b/.test(f.message) && /D:\/c/.test(f.message)))
})

test("deterministic order: PURELY lexicographic by absolute pool-file path (no primary-first anymore)", () => {
  const fs = fakeFs()
  for (const base of ["D:/z", "D:/b"]) {
    fs.setDir(base, [".opencode"])
    fs.setDir(`${base}/.opencode`, [{ name: "forge.json", dir: false }])
    fs.writeFile(`${base}/.opencode/forge.json`, json({ agents: { coder: pinned } }))
  }
  fs.setDir("C:/a", [".opencode"])
  fs.setDir("C:/a/.opencode", [{ name: "forge.json", dir: false }])
  fs.writeFile("C:/a/.opencode/forge.json", json({ agents: { research: pinned } }))
  // The FIRST anchor is C:/a — under the old primary rule it would lead;
  // pure lexicographic order puts it there anyway here, so ALSO probe the
  // inverse: leading with D:/z must not promote it.
  for (const anchors of [["C:/a", "D:/z", "D:/b"], ["D:/z", "D:/b", "C:/a"]]) {
    const r = resolverOn(fs).resolve(anchors)
    assert.deepEqual(
      r.families.map((f) => f.file),
      ["C:/a/.opencode/forge.json", "D:/b/.opencode/forge.json", "D:/z/.opencode/forge.json"],
      "family order is the path sort, identical regardless of anchor order",
    )
  }
})

test("host-history independence: opposite anchor-initialization orders produce IDENTICAL materialized id sets", () => {
  const fs = fakeFs()
  fs.setDir("C:/a", [".opencode"])
  fs.setDir("C:/a/.opencode", [{ name: "forge.json", dir: false }])
  fs.writeFile("C:/a/.opencode/forge.json", json({ pool: "nsa", agents: { coder: pinned, research: pinned } }))
  fs.setDir("D:/b", [".opencode"])
  fs.setDir("D:/b/.opencode", [{ name: "forge.json", dir: false }])
  fs.writeFile("D:/b/.opencode/forge.json", json({ pool: "nsb", agents: { coder: pinned } }))
  fs.setDir("C:/home/.config/opencode", [{ name: "forge.json", dir: false }])
  fs.writeFile("C:/home/.config/opencode/forge.json", json({ agents: { universal: pinned } }))
  // Two independent hosts (fresh resolvers) that saw the same two
  // workspaces in OPPOSITE orders — ids must be byte-identical.
  const host1 = resolverOn(fs).resolve(["C:/a", "D:/b"])
  const host2 = resolverOn(fs).resolve(["D:/b", "C:/a"])
  assert.deepEqual(Object.keys(host1.agents).sort(), Object.keys(host2.agents).sort())
  assert.deepEqual(Object.keys(host1.agents).sort(), ["global-universal", "nsa-coder", "nsa-research", "nsb-coder"])
  assert.deepEqual(
    host1.families.map((f) => `${f.ns}:${f.file}`),
    host2.families.map((f) => `${f.ns}:${f.file}`),
    "family ns assignment is order-independent too",
  )
})

test("cross-family materialized-id collision: earlier file in PATH order wins, later skipped with a finding — deterministically", () => {
  const fs = fakeFs()
  fs.setDir("C:/a", [".opencode"])
  fs.setDir("C:/a/.opencode", [{ name: "forge.json", dir: false }])
  // ns "aa" + id "b-shader" composes aa-b-shader…
  fs.writeFile("C:/a/.opencode/forge.json", json({ pool: "aa", agents: { "b-shader": pinned } }))
  fs.setDir("D:/b", [".opencode"])
  fs.setDir("D:/b/.opencode", [{ name: "forge.json", dir: false }])
  // …which D:/b ALSO produces: ns "aa-b" + id "shader". Distinct namespaces
  // ("aa" vs "aa-b" — no ns collision), one composed materialized id.
  fs.writeFile("D:/b/.opencode/forge.json", json({ pool: "aa-b", agents: { shader: pinned, research: pinned } }))
  // Path order is C:/a < D:/b, so C:/a's composed id wins and D:/b's is
  // skipped — regardless of anchor order.
  for (const anchors of [["D:/b", "C:/a"], ["C:/a", "D:/b"]]) {
    const r = resolverOn(fs).resolve(anchors)
    assert.ok(r.agents["aa-b-shader"], "the materialized id exists exactly once")
    assert.equal(r.agents["aa-b-shader"].file, "C:/a/.opencode/forge.json", "the pool earlier in LEXICOGRAPHIC PATH order wins (not anchor order)")
    const dFam = r.families.find((f) => f.file === "D:/b/.opencode/forge.json")
    assert.deepEqual(dFam.materializedIds, ["aa-b-research"], "the colliding agent is skipped; the family's sibling still applies")
    assert.ok(r.findings.some((f) => f.code === "materialized-id-collision" && f.level === "error" && /C:\/a/.test(f.message) && /D:\/b/.test(f.message)), "the finding names both files")
  }
})

test("broken pool file empties only its own family; parse location rides the finding", () => {
  const fs = fakeFs()
  fs.setDir("C:/a", [".opencode"])
  fs.setDir("C:/a/.opencode", [{ name: "forge.json", dir: false }])
  fs.writeFile("C:/a/.opencode/forge.json", json({ agents: { research: pinned } }))
  fs.setDir("D:/b", [".opencode"])
  fs.setDir("D:/b/.opencode", [{ name: "forge.json", dir: false }])
  fs.writeFile("D:/b/.opencode/forge.json", "{ broken")
  const r = resolverOn(fs).resolve(["C:/a", "D:/b"])
  assert.ok(r.agents["a-research"], "the healthy pool still materializes")
  const broken = r.families.find((f) => f.file === "D:/b/.opencode/forge.json")
  assert.deepEqual(broken.materializedIds, [], "the broken pool contributes no agents")
  assert.ok(r.findings.some((f) => f.code === "config-parse-error" && /line \d+/.test(f.message) && /D:\/b/.test(f.message)))
})

// ---------------------------------------------------------------------------
// Wiring (server-level): session-domain dispatch gate + roster surfaces

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
// shared-host test deliberately re-inits WITHOUT a reset.
let lastHost = null
async function startServer(inputArg, opts) {
  if (lastHost) lastHost.__forgeSubagentsTest.resetAnchors()
  lastHost = await server(inputArg, opts)
  return lastHost
}

const bindSession = (h, sessionID, dir) => h.event({ event: { type: "session.created", properties: { info: { id: sessionID, directory: dir, worktree: dir } } } })
const taskArgs = (target) => ({ args: { subagent_type: target, prompt: "x" } })
// Family file paths derive from the realpath-normalized anchor; raw mkdtemp
// paths may differ in case — compare folded.
const foldP = (p) => p.replaceAll("/", "\\").toLowerCase()

test("wiring shared host: both workspaces' pools materialize NAMESPACED; session-domain gate matrix", async (t) => {
  const dirA = dirWithForgeJson(t, "forge-pool-a-", { pool: "teama", agents: { research: { model: "zai/glm", thoughtLevel: "low" } } })
  const dirB = dirWithForgeJson(t, "forge-pool-b-", { pool: "teamb", agents: { shader: { model: "zai/glm", thoughtLevel: "low" } } })
  const hA = await startServer(input(dirA), {})
  t.after(() => hA.dispose?.())
  const cfgA = emptyCfg()
  await hA.config(cfgA)
  assert.ok(cfgA.agent["forge-teama-research"], "workspace A's pool materializes NAMESPACED (forge-<ns>-<id>)")
  assert.equal(cfgA.agent["forge-research"], undefined, "no plain-id agent is registered")

  // Shared host re-initializes in workspace B — its pool JOINS the
  // materialization set, A's survives with the SAME namespaced ids.
  const hB = await server(input(dirB), {})
  t.after(() => hB.dispose?.())
  const cfgB = emptyCfg()
  await hB.config(cfgB)
  assert.ok(cfgB.agent["forge-teama-research"], "workspace A's agents SURVIVE the flip with identical namespaced ids")
  assert.ok(cfgB.agent["forge-teamb-shader"], "workspace B's pool materializes NAMESPACED")

  // Dispatch gate matrix.
  await bindSession(hB, "ses_a", dirA)
  await bindSession(hB, "ses_b", dirB)
  const bJson = join(dirB, ".opencode", "forge.json")
  const aJson = join(dirA, ".opencode", "forge.json")

  // own-pool dispatch passes both ways
  await hB["tool.execute.before"]({ tool: "task", sessionID: "ses_a", callID: "g1" }, taskArgs("forge-teama-research"))
  await hB["tool.execute.before"]({ tool: "task", sessionID: "ses_b", callID: "g2" }, taskArgs("forge-teamb-shader"))

  // cross-workspace dispatch refuses with the verbatim anchor + origin path + exits
  await assert.rejects(
    () => hB["tool.execute.before"]({ tool: "task", sessionID: "ses_a", callID: "g3" }, taskArgs("forge-teamb-shader")),
    (err) => {
      const m = String(err)
      assert.match(m, /not dispatchable from this session/, "the verbatim refusal anchor")
      assert.ok(foldP(m).includes(foldP(bJson)), "names the target's origin pool path")
      assert.match(m, /open a session in that pool's workspace/, "exit 1: open a session there")
      assert.match(m, /configure the role into this workspace's pool/, "exit 2: this workspace's pool")
      assert.match(m, /global layer/, "exit 3: the global layer")
      return true
    },
  )
  await assert.rejects(
    () => hB["tool.execute.before"]({ tool: "task", sessionID: "ses_b", callID: "g4" }, taskArgs("forge-teama-research")),
    (err) => {
      const m = String(err)
      assert.match(m, /not dispatchable from this session/)
      assert.ok(foldP(m).includes(foldP(aJson)))
      return true
    },
  )

  // Unknown session anchor (never observed): fail-open belt posture + the
  // bounded disclosure (plugin.ts console.warn — the "could not be
  // established" wording). Tight console.warn stub around the call.
  const warns = []
  const origWarn = console.warn
  console.warn = (...args) => warns.push(args.map(String).join(" "))
  try {
    await hB["tool.execute.before"]({ tool: "task", sessionID: "ses_unbound", callID: "g5" }, taskArgs("forge-teama-research"))
  } finally {
    console.warn = origWarn
  }
  assert.equal(warns.length, 1, "exactly one disclosure for the unknown anchor (bounded once-per-session)")
  assert.match(warns[0], /\[forge:pool\] session ses_unbound/, "names the session")
  assert.match(warns[0], /could not be established/, "the could-not-be-established wording")
  assert.match(warns[0], /fail-open belt posture/, "the disclosed posture")
})

test("wiring gate: a poolless session falls back to the global layer (forge-global-*) — workspace pools stay gated", async (t) => {
  const home = process.env.FORGE_TEST_FORGE_HOME
  mkdirSync(join(home, ".config", "opencode"), { recursive: true })
  writeFileSync(join(home, ".config", "opencode", "forge.json"), JSON.stringify({ agents: { universal: { model: "zai/glm", thoughtLevel: "low" } } }))
  t.after(() => {
    try {
      rmSync(join(home, ".config"), { recursive: true, force: true })
    } catch {}
  })
  const dirA = dirWithForgeJson(t, "forge-pool-fb-", { pool: "fba", agents: { research: { model: "zai/glm", thoughtLevel: "low" } } })
  const poolless = mkdtempSync(join(tmpdir(), "forge-pool-none-"))
  t.after(() => {
    try {
      rmSync(poolless, { recursive: true, force: true })
    } catch {}
  })
  const h = await startServer(input(dirA), {})
  t.after(() => h.dispose?.())
  const cfg = emptyCfg()
  await h.config(cfg)
  assert.ok(cfg.agent["forge-global-universal"], "the global fallback family materializes as forge-global-*")
  await bindSession(h, "ses_fb_none", poolless)
  // Global fallback dispatchable from the poolless session…
  await h["tool.execute.before"]({ tool: "task", sessionID: "ses_fb_none", callID: "fb1" }, taskArgs("forge-global-universal"))
  // …but the workspace pool is NOT (fallback, not merge — the roster is the
  // global layer, and forge-fba-research belongs to another workspace).
  await assert.rejects(
    () => h["tool.execute.before"]({ tool: "task", sessionID: "ses_fb_none", callID: "fb2" }, taskArgs("forge-fba-research")),
    /not dispatchable from this session/,
  )
  // The workspace session can dispatch its own pool but not the global
  // fallback family (its workspace HAS a pool — global is not merged in).
  await bindSession(h, "ses_fb_a", dirA)
  await h["tool.execute.before"]({ tool: "task", sessionID: "ses_fb_a", callID: "fb3" }, taskArgs("forge-fba-research"))
  await assert.rejects(
    () => h["tool.execute.before"]({ tool: "task", sessionID: "ses_fb_a", callID: "fb4" }, taskArgs("forge-global-universal")),
    /not dispatchable from this session/,
  )
})

test("wiring deletion: removing a workspace pool file un-materializes it at the next config hook", async (t) => {
  const dirA = dirWithForgeJson(t, "forge-pool-del-", { pool: "delpool", agents: { research: { model: "zai/glm", thoughtLevel: "low" } } })
  const h = await startServer(input(dirA), {})
  t.after(() => h.dispose?.())
  const cfg1 = emptyCfg()
  await h.config(cfg1)
  assert.ok(cfg1.agent["forge-delpool-research"])
  rmSync(join(dirA, ".opencode", "forge.json"))
  const cfg2 = emptyCfg()
  await h.config(cfg2)
  assert.equal(cfg2.agent["forge-delpool-research"], undefined, "a deleted pool file disappears from materialization (no zombie pool)")
})

test("wiring roster: the /crew template session-scopes the roster (own pool via live injection; others NOT dispatchable)", async (t) => {
  const dirA = dirWithForgeJson(t, "forge-pool-ro-", { pool: "teama", agents: { research: { model: "zai/glm", thoughtLevel: "low" } } })
  const dirB = dirWithForgeJson(t, "forge-pool-ro2-", { pool: "teamb", agents: { shader: { model: "zai/glm", thoughtLevel: "low" } } })
  const h = await startServer(input(dirA), {})
  t.after(() => h.dispose?.())
  await server(input(dirB), {}) // shared host: B's pool joins
  const cfg = emptyCfg()
  await h.config(cfg)
  const tpl = h.__forgeSubagentsTest.crewCommand().template
  assert.match(tpl, /ROSTER OWNERSHIP/, "the sole-ownership roster framing")
  assert.match(tpl, /nearest \.opencode\/forge\.json walking up from this session's worktree/, "the ownership rule")
  assert.match(tpl, /global fallback/, "the global fallback layer is named with its path")
  assert.match(tpl, /NOT dispatchable from this session/, "every other host pool is marked with the verbatim anchor")
  assert.match(tpl, /pool teamb \(forge-teamb-\*\)/, "the family label renders the namespaced form (the primary-label branch is dead at runtime)")
  assert.ok(!tpl.includes("primary pool"), "no primary-pool label remains")
  assert.ok(foldP(tpl).includes(foldP(join(dirB, ".opencode", "forge.json"))), "the other pool's origin path rides the mark")
  assert.match(tpl, /forge-teama-research/)
  assert.match(tpl, /forge-teamb-shader/)
  assert.match(tpl, /nested deeper in the workspace subtree are ignored/, "nested-ignore strictness disclosed")
})

test("wiring crew_begin: the registration output session-scopes the dispatchable roster", async (t) => {
  const dirA = dirWithForgeJson(t, "forge-pool-cb-", { pool: "teama", agents: { research: { model: "zai/glm", thoughtLevel: "low" } } })
  const dirB = dirWithForgeJson(t, "forge-pool-cb2-", { pool: "teamb", agents: { shader: { model: "zai/glm", thoughtLevel: "low" } } })
  const h = await startServer(input(dirA), {})
  t.after(() => h.dispose?.())
  await server(input(dirB), {})
  await h.config(emptyCfg())
  const out = await h.tool.crew_begin.execute({ objective: "o", subtasks: [{ title: "x" }] }, { ...allowCtx("ses_cb"), worktree: dirA, directory: dirA })
  assert.match(out.output, /Session roster origins — sole ownership/, "the session-scoped roster header")
  assert.match(out.output, /DISPATCHABLE from this session — workspace pool: [^\n]*forge\.json/, "the session's own pool leads, with origin path")
  assert.ok(foldP(out.output).includes(foldP(join(dirA, ".opencode", "forge.json"))))
  assert.match(out.output, /forge-teama-research/, "own agents render with namespaced ids")
  assert.match(out.output, /NOT dispatchable from this session — pool teamb/, "other pools marked with the verbatim anchor + namespaced label")
  assert.ok(!out.output.includes("primary pool"), "no primary-pool label remains")
  assert.ok(foldP(out.output).includes(foldP(join(dirB, ".opencode", "forge.json"))), "the other pool's origin path rides the mark")
  await h.tool.crew_close.execute({ abandon: true, reason: "test" }, allowCtx("ses_cb"))
})

test("wiring anchors(): normalized, deduped; resetAnchors simulates a host restart", async (t) => {
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

// ---------------------------------------------------------------------------
// Crew-governed dispatch pool-compliance gate (change pool-namespace-contract,
// spec: crew-harness — "Crew-governed dispatch pool-compliance gate"): the 7
// spec scenarios as a wiring matrix. crew_begin pre-flight + the
// tool.execute.before belt share one predicate (poolFileCompliance) and one
// refusal copy; global-fallback sessions are exempt; per-agent fail-soft
// findings never block; the session-domain pool gate outranks the belt.

const cmCtx = (sid, dir) => ({ ...allowCtx(sid), worktree: dir, directory: dir })
const register = async (h, sid, dir, objective = "compliance matrix") =>
  h.tool.crew_begin.execute({ objective, subtasks: [{ title: "one" }] }, cmCtx(sid, dir))
const armWaves = (h, sid, dir) => h.tool.crew_begin.execute({ execution: "waves" }, cmCtx(sid, dir))

test("compliance (a): crew_begin REFUSES a pool-less-declared forge.json — no record, no PENDING crew, fix copy names file + suggested ns + hot-apply", async (t) => {
  const dir = dirWithForgeJson(t, "forge-pool-cm1-", { agents: { research: pinned } }) // NO pool field
  const h = await startServer(input(dir), {})
  t.after(() => h.dispose?.())
  await h.config(emptyCfg())
  const poolFile = join(dir, ".opencode", "forge.json")
  await assert.rejects(
    () => register(h, "ses_cm1", dir),
    (err) => {
      const m = String(err)
      assert.match(m, /Pool compliance refused/, "the compliance refusal lead")
      assert.ok(foldP(m).includes(foldP(poolFile)), "names the session's pool file path")
      assert.match(m, /missing top-level pool field/, "the violation text (missing vs invalid)")
      assert.match(m, /Minimal fix: add or repair the top-level "pool": "[a-z0-9-]+"/, "the minimal fix with a suggested namespace")
      assert.match(m, /REQUIRED for crew-governed dispatch/, "the field's crew-gate role")
      assert.match(m, /no host restart/, "the hot-apply lift")
      // crew-native-fallback D3: the REGISTRATION pre-flight copy carries NO
      // native exit — the fallback is about DISPATCH, not registration.
      assert.doesNotMatch(m, /Native exit/, "registration refusal keeps the bare fix copy")
      return true
    },
  )
  assert.equal(h.__forgeSubagentsTest.crews().get("ses_cm1"), undefined, "no PENDING crew exists")
  assert.equal(existsSync(join(dir, ".opencode", "crew")), false, "no crew record was written")
  // Hot-apply lift: repairing the file admits registration on the NEXT
  // resolve — no restart, no re-init.
  writeFileSync(poolFile, JSON.stringify({ pool: "cmone", agents: { research: pinned } }))
  const out = await register(h, "ses_cm1", dir)
  assert.match(out.output, /registered PENDING/, "repair admits registration hot-apply")
})

test("compliance (b): an INVALID pool value is refused identically (missing-vs-invalid distinction kept)", async (t) => {
  const dir = dirWithForgeJson(t, "forge-pool-cm2-", { pool: "Aa Team!", agents: { research: pinned } })
  const h = await startServer(input(dir), {})
  t.after(() => h.dispose?.())
  await h.config(emptyCfg())
  // The family still materializes (warn finding + directory-name fallback)…
  const cfg = emptyCfg()
  await h.config(cfg)
  assert.ok(Object.keys(cfg.agent).some((id) => id.startsWith("forge-") && id.endsWith("-research")), "the family materializes under the fallback ns")
  // …but crew registration waits for a valid declared value.
  await assert.rejects(
    () => register(h, "ses_cm2", dir),
    (err) => {
      const m = String(err)
      assert.match(m, /Pool compliance refused/)
      assert.ok(foldP(m).includes(foldP(join(dir, ".opencode", "forge.json"))))
      assert.match(m, /invalid top-level pool field "Aa Team!"/, "the violation text names the invalid value")
      assert.match(m, /Minimal fix: add or repair the top-level "pool": "[a-z0-9-]+"/)
      return true
    },
  )
  assert.equal(h.__forgeSubagentsTest.crews().get("ses_cm2"), undefined, "no PENDING crew exists")
})

test("compliance (c): a compliant pool registers normally (the gate does not fire again)", async (t) => {
  const dir = dirWithForgeJson(t, "forge-pool-cm3-", { pool: "plugindev", agents: { research: pinned } })
  const h = await startServer(input(dir), {})
  t.after(() => h.dispose?.())
  await h.config(emptyCfg())
  const out = await register(h, "ses_cm3", dir)
  assert.match(out.output, /registered PENDING/)
  const crew = h.__forgeSubagentsTest.crews().get("ses_cm3")
  assert.ok(crew, "record written + PENDING crew per the execution-mode gate")
  assert.equal(crew.mode, "pending")
})

test("compliance (d): mid-crew degradation blocks further crew dispatches; native tasks unaffected; repair lifts hot-apply", async (t) => {
  const dir = dirWithForgeJson(t, "forge-pool-cm4-", { pool: "midcrew", agents: { research: pinned } })
  const h = await startServer(input(dir), {})
  t.after(() => h.dispose?.())
  await h.config(emptyCfg())
  await register(h, "ses_cm4", dir)
  await armWaves(h, "ses_cm4", dir)
  assert.equal(h.__forgeSubagentsTest.crews().get("ses_cm4").mode, "executing")
  const poolFile = join(dir, ".opencode", "forge.json")
  // Degradation: the pool field is removed while the crew EXECUTES.
  writeFileSync(poolFile, JSON.stringify({ agents: { research: pinned } }))
  await assert.rejects(
    () => h["tool.execute.before"]({ tool: "task", sessionID: "ses_cm4", callID: "cm1" }, taskArgs("forge-midcrew-research")),
    (err) => {
      const m = String(err)
      assert.match(m, /Pool compliance refused/, "the belt re-runs the file-level check")
      assert.match(m, /missing top-level pool field/)
      assert.match(m, /no host restart/, "the hot-apply lift rides the belt copy")
      // crew-native-fallback D1/D4: the MID-CREW belt refusal carries the
      // native exit (fix copy intact, one sentence appended).
      assert.match(m, /Native exit: while the pool is being repaired, the affected subtask may dispatch through the NATIVE task channel with the same relay contract/, "the native exit sentence rides the belt copy")
      assert.match(m, /gates forge-\* dispatch only, never the crew's existence/, "the belt scopes itself to forge-* dispatch")
      return true
    },
  )
  // Native (non-forge) task targets from the same session are unaffected.
  await h["tool.execute.before"]({ tool: "task", sessionID: "ses_cm4", callID: "cm2" }, taskArgs("general"))
  // Repair: the next dispatch flows with no restart.
  writeFileSync(poolFile, JSON.stringify({ pool: "midcrew", agents: { research: pinned } }))
  await h["tool.execute.before"]({ tool: "task", sessionID: "ses_cm4", callID: "cm3" }, taskArgs("forge-midcrew-research"))
})

test("compliance (e): a global-fallback session is EXEMPT — the gate never fires", async (t) => {
  const home = process.env.FORGE_TEST_FORGE_HOME
  mkdirSync(join(home, ".config", "opencode"), { recursive: true })
  // The global layer deliberately declares NO pool field: the fixed `global`
  // namespace carries no rename risk and needs no declared field.
  writeFileSync(join(home, ".config", "opencode", "forge.json"), JSON.stringify({ agents: { universal: pinned } }))
  t.after(() => {
    try {
      rmSync(join(home, ".config"), { recursive: true, force: true })
    } catch {}
  })
  const poolless = mkdtempSync(join(tmpdir(), "forge-pool-cm5-"))
  t.after(() => {
    try {
      rmSync(poolless, { recursive: true, force: true })
    } catch {}
  })
  const h = await startServer(input(poolless), {})
  t.after(() => h.dispose?.())
  await h.config(emptyCfg())
  const out = await register(h, "ses_cm5", poolless)
  assert.match(out.output, /registered PENDING/, "registration proceeds — no workspace pool, no compliance check")
  await armWaves(h, "ses_cm5", poolless)
  await h["tool.execute.before"]({ tool: "task", sessionID: "ses_cm5", callID: "cm5" }, taskArgs("forge-global-universal"))
})

test("compliance (f): per-agent fail-soft findings never block — valid pool + one half-configured entry registers and dispatches", async (t) => {
  const dir = dirWithForgeJson(t, "forge-pool-cm6-", { pool: "softfail", agents: { research: pinned, broken: { thoughtLevel: "low" } } })
  const h = await startServer(input(dir), {})
  t.after(() => h.dispose?.())
  const cfg = emptyCfg()
  await h.config(cfg)
  assert.ok(cfg.agent["forge-softfail-research"], "the good entry materializes")
  assert.equal(cfg.agent["forge-softfail-broken"], undefined, "the half-configured entry is skipped (existing fail-soft semantics)")
  const out = await register(h, "ses_cm6", dir)
  assert.match(out.output, /registered PENDING/, "the FILE is compliant — the crew proceeds")
  await armWaves(h, "ses_cm6", dir)
  await h["tool.execute.before"]({ tool: "task", sessionID: "ses_cm6", callID: "cm6" }, taskArgs("forge-softfail-research"))
})

test("compliance (g): the session-domain pool gate outranks the compliance belt — cross-pool refusals keep their copy", async (t) => {
  const dirA = dirWithForgeJson(t, "forge-pool-cm7a-", { pool: "gatea", agents: { research: pinned } })
  const dirB = dirWithForgeJson(t, "forge-pool-cm7b-", { pool: "gateb", agents: { shader: pinned } })
  const h = await startServer(input(dirA), {})
  t.after(() => h.dispose?.())
  await server(input(dirB), {}) // shared host: both pools materialize
  await h.config(emptyCfg())
  await register(h, "ses_cm7", dirA) // dirA's pool is COMPLIANT
  await armWaves(h, "ses_cm7", dirA)
  await assert.rejects(
    () => h["tool.execute.before"]({ tool: "task", sessionID: "ses_cm7", callID: "cm7" }, taskArgs("forge-gateb-shader")),
    (err) => {
      const m = String(err)
      assert.match(m, /not dispatchable from this session/, "the pool-gate refusal copy")
      assert.ok(foldP(m).includes(foldP(join(dirB, ".opencode", "forge.json"))), "the target's origin pool path")
      assert.doesNotMatch(m, /Pool compliance refused/, "the compliance belt never rewrites or masks a cross-pool refusal")
      return true
    },
  )
})

// ---------------------------------------------------------------------------
// pool-gate-authoritative-anchor (0.18.0 live incident): the dispatch belts
// resolve the session anchor from the host's AUTHORITATIVE session record
// first — the in-memory map has degenerate writers (resumed-after-restart
// sessions never re-fire session.created; rootish tool contexts resolve to
// the launch directory) and a session bound pool-less loses its OWN pool's
// dispatch rights. The record is read-only input; the map is the fallback.

const recordInput = (dir, records, getImpl) => ({
  ...input(dir),
  client: { session: { get: getImpl ?? (async ({ path: { id } }) => records[id]) } },
})

test("authoritative anchor (a): a resumed session with a DEGRADED in-memory binding dispatches its OWN pool", async (t) => {
  const dirA = dirWithForgeJson(t, "forge-pool-au-", { pool: "autha", agents: { research: pinned } })
  const dirB = dirWithForgeJson(t, "forge-pool-au2-", { pool: "authb", agents: { shader: pinned } })
  const launchDir = mkdtempSync(join(tmpdir(), "forge-pool-launch-"))
  t.after(() => {
    try {
      rmSync(launchDir, { recursive: true, force: true })
    } catch {}
  })
  const h = await startServer(
    recordInput(dirA, {
      ses_resumed: { directory: dirA, worktree: dirA },
      ses_fresh: { directory: dirA, worktree: dirA },
    }),
    {},
  )
  t.after(() => h.dispose?.())
  await server(input(dirB), {}) // shared host: B joins the registry
  const cfg = emptyCfg()
  await h.config(cfg)
  assert.ok(cfg.agent["forge-autha-research"])
  assert.ok(cfg.agent["forge-authb-shader"])
  // The incident shape: the map degrades to a pool-less anchor (the host
  // launch directory seeded a resumed-after-restart session).
  await bindSession(h, "ses_resumed", launchDir)
  await h["tool.execute.before"]({ tool: "task", sessionID: "ses_resumed", callID: "au1" }, taskArgs("forge-autha-research"))
  // The record-sourced anchor scopes correctly: cross-pool still refused,
  // and the roster line now names the WORKSPACE pool (record-resolved) —
  // the exact copy branch that read "the global fallback" in the incident.
  await assert.rejects(
    () => h["tool.execute.before"]({ tool: "task", sessionID: "ses_resumed", callID: "au2" }, taskArgs("forge-authb-shader")),
    (err) => {
      const m = String(err)
      assert.match(m, /not dispatchable from this session/)
      assert.match(m, /its workspace pool/, "the roster line names the workspace pool (record-resolved, not the global fallback)")
      return true
    },
  )
  // A never-bound session resolves via the record too (no fail-open needed).
  await h["tool.execute.before"]({ tool: "task", sessionID: "ses_fresh", callID: "au3" }, taskArgs("forge-autha-research"))
})

test("authoritative anchor (b): record unavailable → the in-memory binding decides; unknown-everything keeps fail-open", async (t) => {
  const dirA = dirWithForgeJson(t, "forge-pool-af-", { pool: "authf", agents: { research: pinned } })
  const dirB = dirWithForgeJson(t, "forge-pool-af2-", { pool: "authg", agents: { shader: pinned } })
  const boom = async () => {
    throw new Error("record unavailable")
  }
  const h = await startServer(recordInput(dirA, {}, boom), {})
  t.after(() => h.dispose?.())
  await server(input(dirB), {})
  await h.config(emptyCfg())
  await bindSession(h, "ses_map_b", dirB)
  // Map says dirB: own-pool passes…
  await h["tool.execute.before"]({ tool: "task", sessionID: "ses_map_b", callID: "af1" }, taskArgs("forge-authg-shader"))
  // …cross-pool refuses with the verbatim copy (pre-change semantics intact).
  await assert.rejects(
    () => h["tool.execute.before"]({ tool: "task", sessionID: "ses_map_b", callID: "af2" }, taskArgs("forge-authf-research")),
    /not dispatchable from this session/,
  )
  // Unknown-everything (no record, no binding): fail-open + bounded disclosure.
  const warns = []
  const origWarn = console.warn
  console.warn = (...args) => warns.push(args.map(String).join(" "))
  try {
    await h["tool.execute.before"]({ tool: "task", sessionID: "ses_nowhere", callID: "af3" }, taskArgs("forge-authf-research"))
  } finally {
    console.warn = origWarn
  }
  assert.equal(warns.length, 1, "exactly one bounded disclosure")
  assert.match(warns[0], /could not be established/)
})

test("authoritative anchor (c): a degenerate re-anchor never clobbers a good in-memory binding", async (t) => {
  const dirA = dirWithForgeJson(t, "forge-pool-dg-", { pool: "dgen", agents: { research: pinned } })
  const h = await startServer(input(dirA), {}) // client without session.get → resolver is map-only
  t.after(() => h.dispose?.())
  await h.config(emptyCfg())
  await bindSession(h, "ses_dg", dirA)
  // Degenerate replay (rootish worktree, no directory) must not poison the
  // binding — the 0.18.0 clobber path.
  await h.event({ event: { type: "session.created", properties: { info: { id: "ses_dg", worktree: "/" } } } })
  await h["tool.execute.before"]({ tool: "task", sessionID: "ses_dg", callID: "dg1" }, taskArgs("forge-dgen-research"))
})

test("authoritative anchor (d): the crew compliance belt re-checks via the record (map says compliant, record does not)", async (t) => {
  const dirNC = dirWithForgeJson(t, "forge-pool-nc-", { agents: { watcher: pinned } }) // NO pool field → non-compliant
  const dirOK = dirWithForgeJson(t, "forge-pool-ok-", { pool: "okp", agents: { helper: pinned } })
  const h = await startServer(recordInput(dirNC, { ses_mix: { directory: dirNC, worktree: dirNC } }), {})
  t.after(() => h.dispose?.())
  await server(input(dirOK), {})
  await h.config(emptyCfg())
  await bindSession(h, "ses_mix", dirOK) // the map lies: a compliant anchor
  // Registration pre-flight uses the tool-context anchor (dirOK) — passes.
  await register(h, "ses_mix", dirOK)
  await armWaves(h, "ses_mix", dirOK)
  const ns = dirNC.split(/[\\/]/).pop().toLowerCase() // the derived family ns
  // Dispatching the nc agent: the POOL gate passes via the record anchor
  // (dirNC owns the entry), then the COMPLIANCE belt refuses via the record —
  // the map's compliant dirOK would have waved it through pre-change.
  await assert.rejects(
    () => h["tool.execute.before"]({ tool: "task", sessionID: "ses_mix", callID: "ad1" }, taskArgs(`forge-${ns}-watcher`)),
    (err) => {
      const m = String(err)
      assert.match(m, /Pool compliance refused/)
      assert.ok(foldP(m).includes(foldP(join(dirNC, ".opencode", "forge.json"))), "names the RECORD anchor's non-compliant file")
      assert.match(m, /missing top-level pool field/)
      return true
    },
  )
  await h.tool.crew_close.execute({ abandon: true, reason: "test" }, allowCtx("ses_mix"))
})

test("anchor pool preference (e): a POOL-LESS resume-rebound record yields to the pooled in-memory binding", async (t) => {
  const dirA = dirWithForgeJson(t, "forge-pool-rb-", { pool: "resbo", agents: { research: pinned } })
  const dirB = dirWithForgeJson(t, "forge-pool-rb2-", { pool: "resbt", agents: { shader: pinned } })
  // The launch dir (record's rebound anchor) owns NO forge.json.
  const launchDir = mkdtempSync(join(tmpdir(), "forge-pool-rblaunch-"))
  t.after(() => {
    try {
      rmSync(launchDir, { recursive: true, force: true })
    } catch {}
  })
  // The 0.20.0 evening incident shape: the RECORD carries the pool-less
  // launch directory; the MAP holds the real pooled workspace (kept fresh by
  // the session's own live activity).
  const h = await startServer(recordInput(dirA, { ses_rebound: { directory: launchDir, worktree: launchDir } }), {})
  t.after(() => h.dispose?.())
  await server(input(dirB), {}) // shared host: B joins the registry
  const cfgRB = emptyCfg()
  await h.config(cfgRB)
  assert.ok(cfgRB.agent["forge-resbo-research"], "resbo materializes")
  assert.ok(cfgRB.agent["forge-resbt-shader"], "resbt materializes")
  await bindSession(h, "ses_rebound", dirA)
  const warns = []
  const origWarn = console.warn
  console.warn = (...args) => warns.push(args.map(String).join(" "))
  try {
    // Own-pool dispatch FLOWS (was refused pre-fix with the global-fallback roster).
    await h["tool.execute.before"]({ tool: "task", sessionID: "ses_rebound", callID: "rb1" }, taskArgs("forge-resbo-research"))
    // Cross-pool target STILL refused — preference restores own-pool rights, never a leak.
    await assert.rejects(
      () => h["tool.execute.before"]({ tool: "task", sessionID: "ses_rebound", callID: "rb2" }, taskArgs("forge-resbt-shader")),
      (err) => {
        const m = String(err)
        assert.match(m, /not dispatchable from this session/)
        assert.match(m, /its workspace pool/, "the roster line names the WORKSPACE pool (pooled binding won)")
        return true
      },
    )
    // Second own-pool dispatch: the bounded disclosure fired EXACTLY once.
    await h["tool.execute.before"]({ tool: "task", sessionID: "ses_rebound", callID: "rb3" }, taskArgs("forge-resbo-research"))
  } finally {
    console.warn = origWarn
  }
  const prefWarns = warns.filter((w) => w.includes("pooled binding wins"))
  assert.equal(prefWarns.length, 1, "exactly one bounded anchor-preference disclosure")
  assert.match(prefWarns[0], /POOL-LESS/, "the copy names the record's pool-less anchor")
})

// ---------------------------------------------------------------------------
// pool-rebind-on-resume (change pool-rebind-on-resume): the BOTH-degenerate
// shape — an EMPTY in-memory map (no live activity after a host restart)
// plus a pool-less resume-rebound authoritative record — falls through the
// live chain to the global-fallback gate and locks the session out of its
// OWN pool. The persisted session-anchor ledger (pooled binds only, one
// global namespaced JSONL, fail-soft IO) is the re-bind source; disk truth
// re-checks the pool file at resolution time (deletion semantics kept);
// cross-pool isolation and fail-open are untouched.

const makeLedgerFs = (initial = "") => {
  let text = initial
  const fsx = {
    read: () => text,
    write: (x) => {
      text = x
    },
    append: (x) => {
      text += x
    },
  }
  return [fsx, () => (text = initial)]
}

test("pool-rebind (f): EMPTY map + pool-less resume record re-binds from the persisted ledger — own-pool ALLOWED, disclosure once", async (t) => {
  const dirA = dirWithForgeJson(t, "forge-pool-lf-", { pool: "ldga", agents: { research: pinned } })
  const dirB = dirWithForgeJson(t, "forge-pool-lf2-", { pool: "ldgb", agents: { shader: pinned } })
  const launchDir = mkdtempSync(join(tmpdir(), "forge-pool-lflaunch-"))
  t.after(() => {
    try {
      rmSync(launchDir, { recursive: true, force: true })
    } catch {}
  })
  const [ledgerFs] = makeLedgerFs()
  // Host life 1: the session binds to its pooled workspace — the ledger
  // persists the positive evidence.
  const h1 = await startServer(input(dirA), {})
  t.after(() => h1.dispose?.())
  h1.__forgeSubagentsTest.setSessionAnchorLedgerFs(() => ledgerFs)
  t.after(() => h1.__forgeSubagentsTest.setSessionAnchorLedgerFs(null))
  await bindSession(h1, "ses_ledger", dirA)
  const entry = ledgerFs.read().trim().split("\n").map((l) => JSON.parse(l)).find((e) => e.sessionID === "ses_ledger")
  assert.ok(entry, "the pooled bind persisted as ledger evidence")
  assert.equal(foldP(entry.worktree), foldP(dirA), "the ledger entry names the pooled worktree")
  // Host life 2 (restart): the host re-opens the SAME workspace (the pool
  // materializes), the resumed session's record carries the POOL-LESS launch
  // dir, and the in-memory map is WIPED (fresh process, no live activity).
  const h2 = await startServer(recordInput(dirA, { ses_ledger: { directory: launchDir, worktree: launchDir } }), {})
  t.after(() => h2.dispose?.())
  await server(input(dirB), {}) // shared host: dirB joins for the cross-pool leg
  h2.__forgeSubagentsTest.resetSessionBindings()
  await h2.config(emptyCfg())
  const warns = []
  const origWarn = console.warn
  console.warn = (...args) => warns.push(args.map(String).join(" "))
  try {
    // Own-pool dispatch FLOWS (was refused pre-fix with the global-fallback roster).
    await h2["tool.execute.before"]({ tool: "task", sessionID: "ses_ledger", callID: "lf1" }, taskArgs("forge-ldga-research"))
    // The re-bind seeded the map — the second dispatch flows without a new disclosure.
    await h2["tool.execute.before"]({ tool: "task", sessionID: "ses_ledger", callID: "lf2" }, taskArgs("forge-ldga-research"))
    // Cross-pool STILL refused — the ledger restores own-pool rights, never a leak.
    await assert.rejects(
      () => h2["tool.execute.before"]({ tool: "task", sessionID: "ses_ledger", callID: "lf3" }, taskArgs("forge-ldgb-shader")),
      (err) => {
        const m = String(err)
        assert.match(m, /not dispatchable from this session/)
        assert.match(m, /its workspace pool/, "the roster line names the ledger-rebound workspace pool")
        return true
      },
    )
  } finally {
    console.warn = origWarn
  }
  const ledgerWarns = warns.filter((w) => w.includes("session-anchor ledger"))
  assert.equal(ledgerWarns.length, 1, "exactly one bounded ledger-rebind disclosure")
  assert.match(ledgerWarns[0], /re-bound from the persisted session-anchor ledger/)
  assert.match(ledgerWarns[0], /restart-resume rebind shape/)
})

test("pool-rebind (g): the ledger re-bind is workspace-EXACT — a dirB-bound session regains dirB, not dirA", async (t) => {
  const dirA = dirWithForgeJson(t, "forge-pool-lh-", { pool: "ldha", agents: { research: pinned } })
  const dirB = dirWithForgeJson(t, "forge-pool-lh2-", { pool: "ldhb", agents: { shader: pinned } })
  const launchDir = mkdtempSync(join(tmpdir(), "forge-pool-lhlaunch-"))
  t.after(() => {
    try {
      rmSync(launchDir, { recursive: true, force: true })
    } catch {}
  })
  const [ledgerFs] = makeLedgerFs()
  const h1 = await startServer(input(dirB), {}) // life 1 in workspace B
  t.after(() => h1.dispose?.())
  h1.__forgeSubagentsTest.setSessionAnchorLedgerFs(() => ledgerFs)
  t.after(() => h1.__forgeSubagentsTest.setSessionAnchorLedgerFs(null))
  await bindSession(h1, "ses_ledger_b", dirB)
  // Restart: host re-opens workspace B; the record carries the pool-less
  // launch dir; the map is wiped.
  const h2 = await startServer(recordInput(dirB, { ses_ledger_b: { directory: launchDir, worktree: launchDir } }), {})
  t.after(() => h2.dispose?.())
  await server(input(dirA), {})
  h2.__forgeSubagentsTest.resetSessionBindings()
  await h2.config(emptyCfg())
  await h2["tool.execute.before"]({ tool: "task", sessionID: "ses_ledger_b", callID: "lh1" }, taskArgs("forge-ldhb-shader"))
  await assert.rejects(
    () => h2["tool.execute.before"]({ tool: "task", sessionID: "ses_ledger_b", callID: "lh2" }, taskArgs("forge-ldha-research")),
    (err) => {
      const m = String(err)
      assert.match(m, /not dispatchable from this session/)
      assert.match(m, /its workspace pool/, "the roster names dirB's pool (the ledger bind), not the global fallback")
      return true
    },
  )
})

test("pool-rebind (h): a ledger hit whose pool file was DELETED is discarded — the global-fallback gate keeps the deletion semantics", async (t) => {
  const dirA = dirWithForgeJson(t, "forge-pool-lk-", { pool: "ldkk", agents: { gone: pinned } })
  const home = process.env.FORGE_TEST_FORGE_HOME
  const globalJson = join(home, ".config", "opencode", "forge.json")
  mkdirSync(join(home, ".config", "opencode"), { recursive: true })
  writeFileSync(globalJson, JSON.stringify({ agents: { research: { model: "zai/glm", thoughtLevel: "low" } } }))
  t.after(() => {
    try {
      rmSync(globalJson, { force: true })
    } catch {}
  })
  const launchDir = mkdtempSync(join(tmpdir(), "forge-pool-lklaun-"))
  t.after(() => {
    try {
      rmSync(launchDir, { recursive: true, force: true })
    } catch {}
  })
  const [ledgerFs] = makeLedgerFs()
  const h1 = await startServer(input(dirA), {})
  t.after(() => h1.dispose?.())
  h1.__forgeSubagentsTest.setSessionAnchorLedgerFs(() => ledgerFs)
  t.after(() => h1.__forgeSubagentsTest.setSessionAnchorLedgerFs(null))
  await bindSession(h1, "ses_gone", dirA)
  // The pool file dies BEFORE the restart — 删池文件即失池, the ledger's
  // evidence must not resurrect it.
  rmSync(join(dirA, ".opencode", "forge.json"))
  const h2 = await startServer(recordInput(dirA, { ses_gone: { directory: launchDir, worktree: launchDir } }), {})
  t.after(() => h2.dispose?.())
  h2.__forgeSubagentsTest.resetSessionBindings()
  await h2.config(emptyCfg())
  const warns = []
  const origWarn = console.warn
  console.warn = (...args) => warns.push(args.map(String).join(" "))
  try {
    // The dead hit is discarded → the session stays pool-less → the GLOBAL
    // fallback roster applies: the global-layer agent is dispatchable.
    await h2["tool.execute.before"]({ tool: "task", sessionID: "ses_gone", callID: "hk1" }, taskArgs("forge-global-research"))
  } finally {
    console.warn = origWarn
  }
  assert.ok(!warns.some((w) => w.includes("session-anchor ledger")), "no ledger re-bind fired — the dead pool's evidence is discarded")
})

test("pool-rebind (i): ledger IO failures are FAIL-SOFT — binds and the gate proceed on the live chain", async (t) => {
  const dirA = dirWithForgeJson(t, "forge-pool-li-", { pool: "ldia", agents: { research: pinned } })
  const dirB = dirWithForgeJson(t, "forge-pool-li2-", { pool: "ldib", agents: { shader: pinned } })
  const boom = () => ({
    read: () => {
      throw new Error("ledger disk gone")
    },
    write: () => {
      throw new Error("ledger disk gone")
    },
    append: () => {
      throw new Error("ledger disk gone")
    },
  })
  const h1 = await startServer(input(dirA), {})
  t.after(() => h1.dispose?.())
  h1.__forgeSubagentsTest.setSessionAnchorLedgerFs(() => boom)
  t.after(() => h1.__forgeSubagentsTest.setSessionAnchorLedgerFs(null))
  const warns = []
  const origWarn = console.warn
  console.warn = (...args) => warns.push(args.map(String).join(" "))
  try {
    await bindSession(h1, "ses_ledger_io", dirA) // append throws → fail-soft, the bind proceeds
  } finally {
    console.warn = origWarn
  }
  const ledgerWarns = warns.filter((w) => w.includes("session-anchor ledger"))
  assert.equal(ledgerWarns.length, 1, "exactly ONE bounded fail-soft warn")
  assert.match(ledgerWarns[0], /fail-soft/)
  assert.equal(h1.__forgeSubagentsTest.sessionAnchorLedgerText(), null, "the read seam reports the failure as null")
  // The gate with a throwing ledger: lookup degrades to "" → the live chain
  // decides EXACTLY as before the change (today's global-fallback refusal).
  const h2 = await startServer(recordInput(dirA, { ses_ledger_io: { directory: tmpdir(), worktree: tmpdir() } }), {})
  t.after(() => h2.dispose?.())
  await server(input(dirB), {})
  h2.__forgeSubagentsTest.resetSessionBindings()
  await h2.config(emptyCfg())
  await assert.rejects(
    () => h2["tool.execute.before"]({ tool: "task", sessionID: "ses_ledger_io", callID: "ii1" }, taskArgs("forge-ldib-shader")),
    /not dispatchable from this session/,
  )
})

test("pool-rebind (j): the ledger stays BOUNDED (FIFO cap compaction) and the LAST entry per session wins", async (t) => {
  const dirA = dirWithForgeJson(t, "forge-pool-lj-", { pool: "ldja", agents: { research: pinned } })
  const dirB = dirWithForgeJson(t, "forge-pool-lj2-", { pool: "ldjb", agents: { shader: pinned } })
  const [ledgerFs] = makeLedgerFs()
  const h1 = await startServer(input(dirA), {})
  t.after(() => h1.dispose?.())
  h1.__forgeSubagentsTest.setSessionAnchorLedgerFs(() => ledgerFs)
  t.after(() => h1.__forgeSubagentsTest.setSessionAnchorLedgerFs(null))
  // Last-entry-wins: a session that MOVES between pooled worktrees re-appends.
  await bindSession(h1, "ses_mover", dirA)
  await bindSession(h1, "ses_mover", dirB)
  const early = ledgerFs.read().trim().split("\n").map((l) => JSON.parse(l))
  const mover = early.filter((e) => e.sessionID === "ses_mover")
  assert.equal(mover.length, 2, "both pooled binds appended (dedup is per worktree)")
  assert.equal(foldP(mover.at(-1).worktree), foldP(dirB), "the LAST entry names the newest pooled worktree")
  // FIFO cap: 220 distinct pooled binds → the file compacts under the cap.
  for (let i = 0; i < 220; i++) await bindSession(h1, `ses_bulk_${i}`, dirA)
  const lines = ledgerFs.read().trim().split("\n").filter(Boolean)
  assert.ok(lines.length <= 205, `the ledger compacted under the cap (${lines.length} lines)`)
  assert.ok(lines.some((l) => l.includes("ses_bulk_219")), "the newest session survived")
  assert.ok(!lines.some((l) => l.includes("ses_bulk_0")), "the oldest session dropped (FIFO)")
  for (const l of lines) JSON.parse(l) // every surviving line stays machine-readable
})

test("pool-rebind (k): the live chain OUTRANKS a stale ledger — preference and authoritative precedence intact", async (t) => {
  const dirA = dirWithForgeJson(t, "forge-pool-ll-", { pool: "ldla", agents: { research: pinned } })
  const dirB = dirWithForgeJson(t, "forge-pool-ll2-", { pool: "ldlb", agents: { shader: pinned } })
  const launchDir = mkdtempSync(join(tmpdir(), "forge-pool-lllaun-"))
  t.after(() => {
    try {
      rmSync(launchDir, { recursive: true, force: true })
    } catch {}
  })
  const [ledgerFs] = makeLedgerFs()
  const h1 = await startServer(recordInput(dirB, { ses_stale: { directory: launchDir, worktree: launchDir } }), {})
  t.after(() => h1.dispose?.())
  h1.__forgeSubagentsTest.setSessionAnchorLedgerFs(() => ledgerFs)
  t.after(() => h1.__forgeSubagentsTest.setSessionAnchorLedgerFs(null))
  await server(input(dirA), {}) // both pools materialize
  await h1.config(emptyCfg())
  // Shape 1 (the 0.20.0 preference): the LIVE pooled map binding (dirB)
  // beats the STALE ledger claim (dirA).
  await bindSession(h1, "ses_stale", dirB)
  ledgerFs.write(JSON.stringify({ sessionID: "ses_stale", worktree: dirA, ts: "2020-01-01T00:00:00.000Z" }) + "\n") // re-stale
  const warns = []
  const origWarn = console.warn
  console.warn = (...args) => warns.push(args.map(String).join(" "))
  try {
    await h1["tool.execute.before"]({ tool: "task", sessionID: "ses_stale", callID: "ll1" }, taskArgs("forge-ldlb-shader"))
    await assert.rejects(
      () => h1["tool.execute.before"]({ tool: "task", sessionID: "ses_stale", callID: "ll2" }, taskArgs("forge-ldla-research")),
      (err) => {
        const m = String(err)
        assert.match(m, /not dispatchable from this session/)
        assert.match(m, /its workspace pool/, "the roster names the LIVE pooled binding (dirB)")
        return true
      },
    )
  } finally {
    console.warn = origWarn
  }
  assert.ok(!warns.some((w) => w.includes("session-anchor ledger")), "the ledger never hijacked a live pooled binding")
  assert.ok(warns.some((w) => w.includes("pooled binding wins")), "the anchor-preference disclosure fired instead")
  // Shape 2 (authoritative precedence): a POOLED record (dirA) beats the
  // ledger claim (dirB) — no ledger consult at all.
  ledgerFs.write(
    [JSON.stringify({ sessionID: "ses_stale", worktree: dirA, ts: "2020-01-01T00:00:00.000Z" }), JSON.stringify({ sessionID: "ses_rec", worktree: dirB, ts: "2020-01-01T00:00:00.000Z" })].join("\n") + "\n",
  )
  const h2 = await startServer(recordInput(dirA, { ses_rec: { directory: dirA, worktree: dirA } }), {})
  t.after(() => h2.dispose?.())
  await server(input(dirB), {})
  h2.__forgeSubagentsTest.resetSessionBindings()
  await h2.config(emptyCfg())
  const warns2 = []
  console.warn = (...args) => warns2.push(args.map(String).join(" "))
  try {
    await h2["tool.execute.before"]({ tool: "task", sessionID: "ses_rec", callID: "ll3" }, taskArgs("forge-ldla-research"))
    await assert.rejects(
      () => h2["tool.execute.before"]({ tool: "task", sessionID: "ses_rec", callID: "ll4" }, taskArgs("forge-ldlb-shader")),
      /not dispatchable from this session/,
    )
  } finally {
    console.warn = origWarn
  }
  assert.ok(!warns2.some((w) => w.includes("session-anchor ledger")), "a pooled record needs no ledger consult")
})

// ---------------------------------------------------------------------------
// forge-prompt-shared — pool-level shared prompt segment (spec:
// forge-subagents "Pool-level shared prompt segment"; design D1-D5). One
// write-point per pool file, inherited by EVERY agent that file
// materializes; strict prepend BENEATH the unchanged three-layer chain;
// fail-soft like every other field; per-FILE scope (no cross-pool bleed);
// the global fallback file's shared INHERITS (content, not namespace).

test("shared: valid top-level shared is captured trimmed on the family and every agent entry", () => {
  const fs = fakeFs()
  fs.setDir("C:/PoolA", [".opencode"])
  fs.setDir("C:/PoolA/.opencode", [{ name: "forge.json", dir: false }])
  fs.writeFile("C:/PoolA/.opencode/forge.json", json({ pool: "aa", shared: "  Project X conventions: use bun.  ", agents: { research: pinned } }))
  const r = resolverOn(fs).resolve(["C:/PoolA"])
  assert.equal(r.families.length, 1)
  assert.equal(r.families[0].shared, "Project X conventions: use bun.", "captured TRIMMED on the family")
  assert.equal(r.agents["aa-research"].shared, "Project X conventions: use bun.", "carried on the agent entry (per-file resolution basis)")
  assert.deepEqual(r.findings, [], "a valid shared records no finding")
})

test("shared compositions: strict prepend beneath all three chain layers (D1)", () => {
  const seg = "Project X conventions: relative paths, no absolute writes."
  const def = { prompt: "You are a dependency auditor; check licenses.", model: "x/y" }
  // (a) shared + explicit prompt — the explicit prompt keeps its identity,
  // shared rides above it as the common base.
  assert.equal(rolePromptFor("auditor", def, seg), `${seg}\n\nYou are a dependency auditor; check licenses.`)
  // (b) shared + built-in role default (research without a prompt).
  const researchRole = rolePromptFor("research", { model: "x/y" })
  assert.equal(rolePromptFor("research", { model: "x/y" }, seg), `${seg}\n\n${researchRole}`, "the built-in chain is intact beneath the shared base")
  // (c) shared + generic one-liner for a prompt-less non-role id.
  const generic = rolePromptFor("summarizer", { model: "x/y" })
  assert.equal(rolePromptFor("summarizer", { model: "x/y" }, seg), `${seg}\n\n${generic}`)
  assert.match(generic, /summarizer worker/)
  // undefined shared = byte-identical chain (purely additive).
  assert.equal(rolePromptFor("auditor", def, undefined), rolePromptFor("auditor", def))
})

test("shared: materialized prompt carries shared in the ROLE slot, below the mandates", () => {
  const seg = "Project X conventions: use bun; evidence or it did not happen."
  const withShared = forgeAgentDef("auditor", { prompt: "Audit licenses.", model: "x/y" }, { ns: "aa", file: "C:/PoolA/.opencode/forge.json" }, seg)
  const without = forgeAgentDef("auditor", { prompt: "Audit licenses.", model: "x/y" }, { ns: "aa", file: "C:/PoolA/.opencode/forge.json" })
  assert.match(withShared.prompt, new RegExp(seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
  // The role block (shared + explicit prompt, blank-line joined) sits above
  // the mandate block; every mandate text is unchanged and present.
  assert.ok(withShared.prompt.indexOf(`${seg}\n\nAudit licenses.`) < withShared.prompt.indexOf("Mandates"), "shared rides inside the role slot, below the mandates")
  for (const m of ["workspace-relative paths ONLY", "report the refusal VERBATIM", "evidence references", "Run every shell command through the forge_shell tool"]) {
    assert.ok(withShared.prompt.includes(m), `mandate intact: ${m}`)
  }
  // Description/provenance/permission/tools untouched by sharedSeg.
  assert.equal(withShared.description, without.description)
  assert.deepEqual(withShared.permission, without.permission)
  assert.deepEqual(withShared.tools, without.tools)
  assert.equal(withShared.model, without.model)
})

test("shared: invalid shared (number / array / whitespace-only) → exactly ONE warn finding naming the file, ignored, agents still materialize", () => {
  for (const bad of [7, ["a", "b"], "   \t  "]) {
    const fs = fakeFs()
    fs.setDir("C:/PoolA", [".opencode"])
    fs.setDir("C:/PoolA/.opencode", [{ name: "forge.json", dir: false }])
    fs.writeFile("C:/PoolA/.opencode/forge.json", json({ pool: "aa", shared: bad, agents: { research: pinned, scout: {} } }))
    const r = resolverOn(fs).resolve(["C:/PoolA"])
    const warns = r.findings.filter((f) => f.code === "shared-invalid")
    assert.equal(warns.length, 1, `exactly one shared-invalid finding for ${JSON.stringify(bad)}`)
    assert.equal(warns[0].level, "warn")
    assert.ok(warns[0].message.includes("C:/PoolA/.opencode/forge.json"), "the finding names the file")
    assert.equal(r.findings.filter((f) => f.code !== "shared-invalid").length, 0, "no other findings — the pool stays fully usable")
    assert.ok(r.agents["aa-research"] && r.agents["aa-scout"], "every agent still materializes")
    assert.equal(r.agents["aa-research"].shared, null, "the invalid field is ignored (absent)")
    assert.equal(r.families[0].shared, null)
    // Agents materialize with the UNSHARED chain.
    assert.equal(rolePromptFor("research", r.agents["aa-research"].def, r.agents["aa-research"].shared ?? undefined), rolePromptFor("research", r.agents["aa-research"].def))
  }
})

test("shared: the GLOBAL fallback file's shared inherits to its family (D3 — pool-ignored does NOT extend to shared)", () => {
  const fs = fakeFs()
  fs.setDir("C:/empty", [])
  fs.setDir("C:/home/.config/opencode", [{ name: "forge.json", dir: false }])
  // The global file ALSO declares a pool field — ignored with a warn (fixed
  // ns "global"), while its shared segment INHERITS: content, not namespace.
  fs.writeFile("C:/home/.config/opencode/forge.json", json({ pool: "ignored", shared: "Global conventions: cite file:line.", agents: { research: pinned } }))
  const r = resolverOn(fs).resolve(["C:/empty"])
  const globalFamily = r.families.find((f) => f.file === "C:/home/.config/opencode/forge.json")
  assert.equal(globalFamily.ns, "global")
  assert.equal(globalFamily.shared, "Global conventions: cite file:line.")
  assert.equal(r.agents["global-research"].shared, "Global conventions: cite file:line.", "the global family inherits the shared segment")
  assert.ok(r.findings.some((f) => f.code === "pool-field-ignored-global"), "the namespace-ignored rule still fires for pool — the contrast is real")
  assert.ok(!r.findings.some((f) => f.code === "shared-invalid"))
})

test("shared: TWO pools — per-FILE scoping, no cross-pool bleed (D2/D5)", () => {
  const fs = fakeFs()
  fs.setDir("C:/PoolA", [".opencode"])
  fs.setDir("C:/PoolA/.opencode", [{ name: "forge.json", dir: false }])
  fs.writeFile("C:/PoolA/.opencode/forge.json", json({ pool: "aa", shared: "Pool A base: frontend repo layout.", agents: { research: pinned } }))
  fs.setDir("C:/PoolB", [".opencode"])
  fs.setDir("C:/PoolB/.opencode", [{ name: "forge.json", dir: false }])
  fs.writeFile("C:/PoolB/.opencode/forge.json", json({ pool: "bb", agents: { research: pinned } })) // NO shared
  const r = resolverOn(fs).resolve(["C:/PoolA", "C:/PoolB"])
  assert.equal(r.agents["aa-research"].shared, "Pool A base: frontend repo layout.", "agent A gets ITS file's shared")
  assert.equal(r.agents["bb-research"].shared, null, "agent B from a shared-less pool gets NONE — no cross-pool bleed")
  // Materialized prompts reflect the per-file truth (same raw def, different bases).
  const pa = forgeAgentDef("aa-research", r.agents["aa-research"].def, undefined, r.agents["aa-research"].shared ?? undefined)
  const pb = forgeAgentDef("bb-research", r.agents["bb-research"].def, undefined, r.agents["bb-research"].shared ?? undefined)
  assert.ok(pa.prompt.includes("Pool A base: frontend repo layout."))
  assert.ok(!pb.prompt.includes("Pool A base"), "pool B's prompt carries no foreign segment")
  assert.ok(!pb.prompt.includes("Pool A base: frontend repo layout."))
})

test("shared: no shared anywhere → materialized prompts BYTE-IDENTICAL to the no-shared build", () => {
  const fs = fakeFs()
  fs.setDir("C:/PoolA", [".opencode"])
  fs.setDir("C:/PoolA/.opencode", [{ name: "forge.json", dir: false }])
  fs.writeFile("C:/PoolA/.opencode/forge.json", json({ pool: "aa", agents: { research: pinned, auditor: { prompt: "Audit.", model: "x/y", thoughtLevel: "low" } } }))
  const r = resolverOn(fs).resolve(["C:/PoolA"])
  assert.deepEqual(r.findings, [], "no finding is recorded")
  for (const [id, agent] of Object.entries(r.agents)) {
    assert.equal(agent.shared, null)
    // Threading the resolver's null shared is byte-identical to not threading.
    assert.equal(
      forgeAgentDef(id, agent.def, undefined, agent.shared ?? undefined).prompt,
      forgeAgentDef(id, agent.def, undefined).prompt,
      `${id}: null shared = the pre-change prompt, byte-for-byte`,
    )
    // And the raw role chain equals the plain call.
    assert.equal(rolePromptFor(id, agent.def, undefined), rolePromptFor(id, agent.def))
  }
})

test("shared: hot-apply — editing shared re-materializes at the next resolve (mtime cache)", () => {
  const fs = fakeFs()
  fs.setDir("C:/PoolA", [".opencode"])
  fs.setDir("C:/PoolA/.opencode", [{ name: "forge.json", dir: false }])
  fs.writeFile("C:/PoolA/.opencode/forge.json", json({ pool: "aa", shared: "v1 base", agents: { research: pinned } }))
  const res = resolverOn(fs)
  assert.equal(res.resolve(["C:/PoolA"]).agents["aa-research"].shared, "v1 base")
  fs.writeFile("C:/PoolA/.opencode/forge.json", json({ pool: "aa", shared: "v2 base", agents: { research: pinned } }))
  assert.equal(res.resolve(["C:/PoolA"]).agents["aa-research"].shared, "v2 base", "the edit hot-applies like any pool edit")
  fs.writeFile("C:/PoolA/.opencode/forge.json", json({ pool: "aa", agents: { research: pinned } })) // shared REMOVED
  assert.equal(res.resolve(["C:/PoolA"]).agents["aa-research"].shared, null, "removal hot-applies too")
  // Composition sanity at the wiring boundary: the composed role stays a
  // strict prepend of the unchanged chain.
  const agent = res.resolve(["C:/PoolA"]).agents["aa-research"]
  const p = materializeAgentPrompt({ agent: "research", shape: "write", role: rolePromptFor("research", agent.def, agent.shared ?? undefined) })
  assert.equal(p, materializeAgentPrompt({ agent: "research", shape: "write", role: rolePromptFor("research", agent.def) }))
})

// ---------------------------------------------------------------------------
// fix-v2-crew-surface-drift task 3.1 (design D1): the crew gate anchor
// matrix — authoritative-first resolution (the live re-anchored-session
// incident as a regression), the no-client fallback keeping today's exact
// behavior, and the fresh-install workspace-pool-only shape.

test("crew anchor matrix (a): the authoritative pool-owning record beats a stale pool-less tool context (the live incident as a regression)", async (t) => {
  const dirA = dirWithForgeJson(t, "forge-pool-cam1-", { pool: "crewa", agents: { research: { model: "zai/glm", thoughtLevel: "low" } } })
  const launchDir = mkdtempSync(join(tmpdir(), "forge-pool-cam-launch-"))
  t.after(() => {
    try {
      rmSync(launchDir, { recursive: true, force: true })
    } catch {}
  })
  // Fresh-install axis: NO global forge.json anywhere under the home.
  const prevHome = process.env.FORGE_TEST_FORGE_HOME
  const emptyHome = mkdtempSync(join(tmpdir(), "forge-pool-cam-home-"))
  process.env.FORGE_TEST_FORGE_HOME = emptyHome
  t.after(() => {
    process.env.FORGE_TEST_FORGE_HOME = prevHome
    try {
      rmSync(emptyHome, { recursive: true, force: true })
    } catch {}
  })
  // The incident shape: the authoritative session RECORD anchors to the
  // pooled workspace; the TOOL CONTEXT still reports the launch dir
  // (pool-less). Before the fix the gate read the tool context and refused
  // ("CREW IS NOT INITIALIZED") while the dispatch belt accepted.
  const h = await startServer(recordInput(dirA, { ses_live: { directory: dirA, worktree: dirA } }), {})
  t.after(() => h.dispose?.())
  await h.config(emptyCfg())
  const out = await h.tool.crew_begin.execute(
    { objective: "moved session crew", subtasks: [{ title: "one" }] },
    { ...allowCtx("ses_live"), worktree: launchDir, directory: launchDir },
  )
  assert.match(out.output, /forge-crewa-research/, "the workspace pool's roster dispatches (authoritative record won)")
  assert.match(out.output, /DISPATCHABLE from this session — workspace pool/, "the roster line names the workspace pool")
  assert.ok(!out.output.includes("CREW IS NOT INITIALIZED"), "the stale-anchor refusal is gone")
  // The crew record path anchors to the RECORD's workspace, not the launch dir.
  assert.ok(existsSync(join(dirA, ".opencode", "crew")), "the crew record is written under the authoritative anchor's workspace")
  await h.tool.crew_close.execute({ abandon: true, reason: "anchor matrix" }, { ...allowCtx("ses_live"), worktree: launchDir, directory: launchDir })
})

test("crew anchor matrix (b): with NO client the resolution is EXACTLY today's (tool-context anchor; no rescue, no regression)", async (t) => {
  const dirA = dirWithForgeJson(t, "forge-pool-cam2-", { pool: "crewb", agents: { research: { model: "zai/glm", thoughtLevel: "low" } } })
  const launchDir = mkdtempSync(join(tmpdir(), "forge-pool-cam2-launch-"))
  t.after(() => {
    try {
      rmSync(launchDir, { recursive: true, force: true })
    } catch {}
  })
  const prevHome = process.env.FORGE_TEST_FORGE_HOME
  const emptyHome = mkdtempSync(join(tmpdir(), "forge-pool-cam2-home-"))
  process.env.FORGE_TEST_FORGE_HOME = emptyHome
  t.after(() => {
    process.env.FORGE_TEST_FORGE_HOME = prevHome
    try {
      rmSync(emptyHome, { recursive: true, force: true })
    } catch {}
  })
  // input() has NO session.get — the no-client path. Unmapped session,
  // tool context at the pool-less launch dir: today's refusal stands.
  const h = await startServer(input(dirA), {})
  t.after(() => h.dispose?.())
  await h.config(emptyCfg())
  await assert.rejects(
    () => h.tool.crew_begin.execute({ objective: "o", subtasks: [{ title: "x" }] }, { ...allowCtx("ses_nc"), worktree: launchDir, directory: launchDir }),
    (err) => {
      assert.match(String(err), /CREW IS NOT INITIALIZED/, "the honest unconfigured refusal (no client = no rescue)")
      return true
    },
  )
  // Same no-client host, tool context AT the pool: registers (today's pass).
  const out = await h.tool.crew_begin.execute({ objective: "o", subtasks: [{ title: "x" }] }, { ...allowCtx("ses_nc2"), worktree: dirA, directory: dirA })
  assert.match(out.output, /forge-crewb-research/)
  await h.tool.crew_close.execute({ abandon: true, reason: "matrix b" }, allowCtx("ses_nc2"))
})

test("crew anchor matrix (c): fresh install — ONLY a workspace pool, no global layer anywhere — passes the gate", async (t) => {
  const dirA = dirWithForgeJson(t, "forge-pool-cam3-", { pool: "crewc", agents: { scout: { model: "zai/glm", thoughtLevel: "low", shape: "readonly" } } })
  const prevHome = process.env.FORGE_TEST_FORGE_HOME
  const emptyHome = mkdtempSync(join(tmpdir(), "forge-pool-cam3-home-"))
  process.env.FORGE_TEST_FORGE_HOME = emptyHome
  t.after(() => {
    process.env.FORGE_TEST_FORGE_HOME = prevHome
    try {
      rmSync(emptyHome, { recursive: true, force: true })
    } catch {}
  })
  const h = await startServer(recordInput(dirA, { ses_fresh: { directory: dirA, worktree: dirA } }), {})
  t.after(() => h.dispose?.())
  await h.config(emptyCfg())
  const out = await h.tool.crew_begin.execute(
    { objective: "fresh install crew", subtasks: [{ title: "recon", agent: "forge-crewc-scout" }] },
    { ...allowCtx("ses_fresh"), worktree: dirA, directory: dirA },
  )
  assert.match(out.output, /forge-crewc-scout/, "the workspace pool IS the roster with zero global configuration")
  assert.ok(!existsSync(join(emptyHome, ".config", "opencode", "forge.json")), "no global layer was required (D3 acceptance shape)")
  await h.tool.crew_close.execute({ abandon: true, reason: "matrix c" }, allowCtx("ses_fresh"))
})

// ---------------------------------------------------------------------------
// fix-v2-crew-surface-drift 4.1 appendage: post-move anchor re-resolution.
// Live-probed on 2.3.2 (reports/e2e-crew-surface-drift-report.md B-2/B-3 +
// the follow-up anchor-probe run): after a REAL POST /api/session/:id/move,
// the plugin-facing session.get seam keeps reporting the PRE-MOVE location
// (REST shows the moved one). The host's `session.moved` event carries the
// new location — the resolver must prefer it over the stale record.

test("crew anchor matrix (d): after a session.move INTO the pooled workspace, the moved event beats the stale session-get record (the E2E B-2/B-3 bug as a regression)", async (t) => {
  const dirPool = dirWithForgeJson(t, "forge-pool-camd-", { pool: "crewd", agents: { research: { model: "zai/glm", thoughtLevel: "low" } } })
  const dirPlain = mkdtempSync(join(tmpdir(), "forge-pool-camd-plain-"))
  t.after(() => {
    try {
      rmSync(dirPlain, { recursive: true, force: true })
    } catch {}
  })
  const prevHome = process.env.FORGE_TEST_FORGE_HOME
  const emptyHome = mkdtempSync(join(tmpdir(), "forge-pool-camd-home-"))
  process.env.FORGE_TEST_FORGE_HOME = emptyHome
  t.after(() => {
    process.env.FORGE_TEST_FORGE_HOME = prevHome
    try {
      rmSync(emptyHome, { recursive: true, force: true })
    } catch {}
  })
  // The LIVE bug shape: the session-get record (and the tool context) still
  // report the PRE-MOVE pool-less directory; only the session.moved event
  // knows the session now lives in the pooled workspace.
  const h = await startServer(recordInput(dirPool, { ses_moved_in: { directory: dirPlain, worktree: dirPlain } }), {})
  t.after(() => h.dispose?.())
  await h.config(emptyCfg())
  await h.event({ event: { type: "session.moved", properties: { sessionID: "ses_moved_in", location: { directory: dirPool } } } })
  const out = await h.tool.crew_begin.execute(
    { objective: "moved-in crew", subtasks: [{ title: "one" }] },
    { ...allowCtx("ses_moved_in"), worktree: dirPlain, directory: dirPlain },
  )
  assert.match(out.output, /forge-crewd-research/, "the moved-into workspace's pool IS the roster")
  assert.ok(!out.output.includes("CREW IS NOT INITIALIZED"), "the stale-record refusal is gone (re-anchor after move)")
  assert.ok(existsSync(join(dirPool, ".opencode", "crew")), "the crew record is written under the MOVED workspace")
  await h.tool.crew_close.execute({ abandon: true, reason: "matrix d" }, { ...allowCtx("ses_moved_in"), worktree: dirPlain, directory: dirPlain })
})

test("crew anchor matrix (e): after a session.move OUT of the pooled workspace, the moved event wins over BOTH the stale record and the pooled in-memory binding (no pool resurrection)", async (t) => {
  const dirPool = dirWithForgeJson(t, "forge-pool-came-", { pool: "crewe", agents: { research: { model: "zai/glm", thoughtLevel: "low" } } })
  const dirPlain = mkdtempSync(join(tmpdir(), "forge-pool-came-plain-"))
  t.after(() => {
    try {
      rmSync(dirPlain, { recursive: true, force: true })
    } catch {}
  })
  const prevHome = process.env.FORGE_TEST_FORGE_HOME
  const emptyHome = mkdtempSync(join(tmpdir(), "forge-pool-came-home-"))
  process.env.FORGE_TEST_FORGE_HOME = emptyHome
  t.after(() => {
    process.env.FORGE_TEST_FORGE_HOME = prevHome
    try {
      rmSync(emptyHome, { recursive: true, force: true })
    } catch {}
  })
  // Stale record AND a pooled in-memory binding both say dirPool; the host
  // moved the session to a pool-less directory. POOLS follow workspaces: the
  // moved (pool-less) anchor wins — the pooled preference rule must NOT
  // resurrect the abandoned workspace's dispatch rights.
  const h = await startServer(recordInput(dirPool, { ses_moved_out: { directory: dirPool, worktree: dirPool } }), {})
  t.after(() => h.dispose?.())
  await h.config(emptyCfg())
  await bindSession(h, "ses_moved_out", dirPool)
  await h.event({ event: { type: "session.moved", properties: { sessionID: "ses_moved_out", location: { directory: dirPlain } } } })
  await assert.rejects(
    () => h.tool.crew_begin.execute({ objective: "o", subtasks: [{ title: "x" }] }, { ...allowCtx("ses_moved_out"), worktree: dirPool, directory: dirPool }),
    (err) => {
      assert.match(String(err), /CREW IS NOT INITIALIZED/, "the moved-out session honestly refuses (no stale pool rights)")
      assert.ok(!String(err).includes("crewe"), "the refusal does not name the abandoned pool's workspace")
      return true
    },
  )
})

test("crew anchor matrix (f): no move event — the record-first chain is EXACTLY today's (the moved-event branch never fires)", async (t) => {
  const dirPool = dirWithForgeJson(t, "forge-pool-camf-", { pool: "crewf", agents: { research: { model: "zai/glm", thoughtLevel: "low" } } })
  const launchDir = mkdtempSync(join(tmpdir(), "forge-pool-camf-launch-"))
  t.after(() => {
    try {
      rmSync(launchDir, { recursive: true, force: true })
    } catch {}
  })
  const prevHome = process.env.FORGE_TEST_FORGE_HOME
  const emptyHome = mkdtempSync(join(tmpdir(), "forge-pool-camf-home-"))
  process.env.FORGE_TEST_FORGE_HOME = emptyHome
  t.after(() => {
    process.env.FORGE_TEST_FORGE_HOME = prevHome
    try {
      rmSync(emptyHome, { recursive: true, force: true })
    } catch {}
  })
  const h = await startServer(recordInput(dirPool, { ses_nomove: { directory: dirPool, worktree: dirPool } }), {})
  t.after(() => h.dispose?.())
  await h.config(emptyCfg())
  const out = await h.tool.crew_begin.execute(
    { objective: "no-move crew", subtasks: [{ title: "one" }] },
    { ...allowCtx("ses_nomove"), worktree: launchDir, directory: launchDir },
  )
  assert.match(out.output, /forge-crewf-research/, "the record-first chain keeps matrix (a)'s semantics untouched")
  await h.tool.crew_close.execute({ abandon: true, reason: "matrix f" }, { ...allowCtx("ses_nomove"), worktree: launchDir, directory: launchDir })
})
