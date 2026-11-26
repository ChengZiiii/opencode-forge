import test from "node:test"
import assert from "node:assert/strict"

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

// Pool/anchor/gate wiring is exercised through v2Setup in
// v2-pool-anchor-lifecycle.test.mjs; resolver-only cases remain below.

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
  for (const m of ["workspace-relative paths ONLY", "report the refusal VERBATIM", "evidence references", "run commands with the builtin shell, within your permissions"]) {
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
