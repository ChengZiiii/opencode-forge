import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// sole-pool-ownership — pool resolver core (spec: forge-subagents —
// "Workspace pool ownership and global fallback") + the wiring-level
// session-domain surfaces (dispatch gate matrix, roster templates).

import { createPoolResolver, sanitizeNamespace, validatePoolField } from "../src/forge-config.ts"

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

// ---------------------------------------------------------------------------
// Sole ownership: workspace pool = the whole roster; nested files ignored

test("workspace pool keeps plain ids; nested forge.json files contribute NOTHING", () => {
  const fs = fakeFs()
  temp1Layout(fs)
  const r = resolverOn(fs).resolve(["C:/Temp1"])
  const primary = r.families.find((f) => f.primary)
  assert.ok(primary, "a primary family exists")
  assert.equal(primary.ns, null)
  assert.equal(primary.file, "C:/Temp1/.opencode/forge.json")
  assert.ok(r.agents.research && r.agents.plan, "plain ids — byte-compatible with a single-workspace host")
  assert.equal(r.families.length, 1, "exactly one family: the workspace pool")
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
  assert.ok(r.agents.root)
  assert.ok(!r.agents.deep && !r.agents["sub-deep"], "the host anchored at C:/w never materializes the nested pool")
})

// ---------------------------------------------------------------------------
// Global fallback (fallback, NOT merge)

test("poolless workspace: the global layer serves as the whole roster (plain ids, legacy byte-compat)", () => {
  const fs = fakeFs()
  fs.setDir("C:/home/.config/opencode", [{ name: "forge.json", dir: false }])
  fs.writeFile("C:/home/.config/opencode/forge.json", json({ agents: { research: pinned, universal: pinned } }))
  fs.setDir("C:/empty", [])
  const r = resolverOn(fs).resolve(["C:/empty"])
  assert.ok(r.agents.research && r.agents.universal, "the global fallback materializes as the plain-id family")
  assert.equal(r.families.length, 1)
  assert.equal(r.families[0].file, "C:/home/.config/opencode/forge.json")
  assert.equal(r.families[0].primary, true)
})

test("fallback NOT merged: a workspace with a pool never sees global agents in its family", () => {
  const fs = fakeFs()
  fs.setDir("C:/home/.config/opencode", [{ name: "forge.json", dir: false }])
  fs.writeFile("C:/home/.config/opencode/forge.json", json({ agents: { research: { model: "zai/global", thoughtLevel: "high" }, universal: pinned } }))
  temp1Layout(fs)
  fs.writeFile("C:/Temp1/.opencode/forge.json", json({ agents: { research: pinned } }))
  const r = resolverOn(fs).resolve(["C:/Temp1"])
  assert.equal(r.agents.research.file, "C:/Temp1/.opencode/forge.json", "the workspace pool's own research stands — no per-id global override merge")
  assert.equal(r.agents.research.def.model, "zai/glm")
  assert.ok(!r.agents.universal, "a global-only agent does NOT ride the workspace family (fallback, not merge)")
  const globalFamily = r.families.find((f) => f.file === "C:/home/.config/opencode/forge.json")
  assert.ok(globalFamily, "the global layer still materializes HOST-WIDE (fallback for poolless sessions)")
  assert.equal(globalFamily.ns, "global")
  assert.deepEqual(globalFamily.materializedIds.sort(), ["global-research", "global-universal"])
  assert.ok(r.agents["global-universal"], "global agents materialize namespaced under forge-global-*")
})

test("a declared pool field namespaces the global fallback family too", () => {
  const fs = fakeFs()
  fs.setDir("C:/home/.config/opencode", [{ name: "forge.json", dir: false }])
  fs.writeFile("C:/home/.config/opencode/forge.json", json({ pool: "shared", agents: { research: pinned } }))
  temp1Layout(fs)
  const r = resolverOn(fs).resolve(["C:/Temp1"])
  const globalFamily = r.families.find((f) => f.file === "C:/home/.config/opencode/forge.json")
  assert.equal(globalFamily.ns, "shared", "the pool field wins over the derived 'global' ns")
  assert.ok(r.agents["shared-research"])
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
  assert.ok(r1.agents.research, "the workspace pool materializes while the file exists")
  fs.deleteFile("C:/Temp1/.opencode/forge.json")
  const r2 = res.resolve(["C:/Temp1"])
  assert.ok(!r2.agents.research && !r2.agents.plan, "deletion hot-applies — the pool's agents are gone (no zombie pool)")
  assert.ok(r2.agents.fallback, "the now-poolless workspace falls back to the global layer as its plain-id family")
  assert.equal(r2.families.filter((f) => f.primary).length, 1)
  assert.equal(r2.families[0].file, "C:/home/.config/opencode/forge.json")
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
  assert.ok(r.agents.fresh, "creation hot-applies — the new pool materializes with plain ids (primary anchor)")
})

// ---------------------------------------------------------------------------
// Multi-workspace hosts: namespaces, collisions, deterministic order

test("same-id agents across workspaces stay collision-free (primary plain, other namespaced)", () => {
  const fs = fakeFs()
  fs.setDir("C:/a", [".opencode"])
  fs.setDir("C:/a/.opencode", [{ name: "forge.json", dir: false }])
  fs.writeFile("C:/a/.opencode/forge.json", json({ agents: { coder: pinned } }))
  fs.setDir("D:/b", [".opencode"])
  fs.setDir("D:/b/.opencode", [{ name: "forge.json", dir: false }])
  fs.writeFile("D:/b/.opencode/forge.json", json({ pool: "teamb", agents: { coder: pinned } }))
  const r = resolverOn(fs).resolve(["C:/a", "D:/b"])
  assert.ok(r.agents.coder, "the primary workspace's coder materializes as forge-coder")
  assert.equal(r.agents.coder.file, "C:/a/.opencode/forge.json")
  assert.ok(r.agents["teamb-coder"], "the other workspace's coder materializes as forge-teamb-coder — no silent overwrite")
  assert.deepEqual(r.findings, [])
})

test("undeclared non-primary pool derives its namespace from the sanitized pool-directory basename", () => {
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
  assert.ok(r.agents["dev-coder"], "C:/b (first in lex order among non-primary) keeps the short ns")
  assert.ok(r.agents["dev-2-coder"], "D:/c gets the incrementing suffix")
  assert.ok(r.findings.some((f) => f.code === "pool-namespace-collision" && f.level === "error" && /C:\/b/.test(f.message) && /D:\/c/.test(f.message)))
})

test("deterministic order: primary first, then lexicographic by absolute file path", () => {
  const fs = fakeFs()
  for (const base of ["D:/z", "D:/b"]) {
    fs.setDir(base, [".opencode"])
    fs.setDir(`${base}/.opencode`, [{ name: "forge.json", dir: false }])
    fs.writeFile(`${base}/.opencode/forge.json`, json({ agents: { coder: pinned } }))
  }
  fs.setDir("C:/a", [".opencode"])
  fs.setDir("C:/a/.opencode", [{ name: "forge.json", dir: false }])
  fs.writeFile("C:/a/.opencode/forge.json", json({ agents: { research: pinned } }))
  const r = resolverOn(fs).resolve(["C:/a", "D:/z", "D:/b"])
  assert.deepEqual(
    r.families.map((f) => f.file),
    ["C:/a/.opencode/forge.json", "D:/b/.opencode/forge.json", "D:/z/.opencode/forge.json"],
    "primary anchor's pool first, the rest sorted by path",
  )
})

test("cross-family materialized-id collision: earlier pool wins, later skipped with a finding", () => {
  const fs = fakeFs()
  fs.setDir("C:/a", [".opencode"])
  fs.setDir("C:/a/.opencode", [{ name: "forge.json", dir: false }])
  fs.writeFile("C:/a/.opencode/forge.json", json({ agents: { research: pinned } }))
  fs.setDir("D:/b", [".opencode"])
  fs.setDir("D:/b/.opencode", [{ name: "forge.json", dir: false }])
  // ns "aa" + id "shader" composes aa-shader…
  fs.writeFile("D:/b/.opencode/forge.json", json({ pool: "aa", agents: { shader: pinned } }))
  fs.setDir("E:/c", [".opencode"])
  fs.setDir("E:/c/.opencode", [{ name: "forge.json", dir: false }])
  // …which the primary pool also defines as a literal id.
  fs.writeFile("E:/c/.opencode/forge.json", json({ agents: { research: pinned, "aa-shader": pinned } }))
  const r = resolverOn(fs).resolve(["E:/c", "D:/b", "C:/a"])
  assert.ok(r.agents["aa-shader"], "the earlier pool's id materializes")
  assert.equal(r.agents["aa-shader"].file, "E:/c/.opencode/forge.json", "the pool earlier in resolution order wins")
  assert.equal(r.families.find((f) => f.file === "D:/b/.opencode/forge.json").materializedIds.length, 0, "the colliding namespaced agent is skipped")
  assert.ok(r.findings.some((f) => f.code === "materialized-id-collision" && f.level === "error"))
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
  assert.ok(r.agents.research, "the healthy pool still materializes")
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

test("wiring shared host: both workspaces' pools materialize; session-domain gate matrix", async (t) => {
  const dirA = dirWithForgeJson(t, "forge-pool-a-", { agents: { research: { model: "zai/glm", thoughtLevel: "low" } } })
  const dirB = dirWithForgeJson(t, "forge-pool-b-", { pool: "teamb", agents: { shader: { model: "zai/glm", thoughtLevel: "low" } } })
  const hA = await startServer(input(dirA), {})
  t.after(() => hA.dispose?.())
  const cfgA = emptyCfg()
  await hA.config(cfgA)
  assert.ok(cfgA.agent["forge-research"], "workspace A's pool materializes with plain ids (primary)")

  // Shared host re-initializes in workspace B — its pool JOINS the
  // materialization set (namespaced), A's survives.
  const hB = await server(input(dirB), {})
  t.after(() => hB.dispose?.())
  const cfgB = emptyCfg()
  await hB.config(cfgB)
  assert.ok(cfgB.agent["forge-research"], "workspace A's agents SURVIVE the flip")
  assert.ok(cfgB.agent["forge-teamb-shader"], "workspace B's pool materializes NAMESPACED")

  // Dispatch gate matrix.
  await bindSession(hB, "ses_a", dirA)
  await bindSession(hB, "ses_b", dirB)
  const bJson = join(dirB, ".opencode", "forge.json")
  const aJson = join(dirA, ".opencode", "forge.json")

  // own-pool dispatch passes both ways
  await hB["tool.execute.before"]({ tool: "task", sessionID: "ses_a", callID: "g1" }, taskArgs("forge-research"))
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
    () => hB["tool.execute.before"]({ tool: "task", sessionID: "ses_b", callID: "g4" }, taskArgs("forge-research")),
    (err) => {
      const m = String(err)
      assert.match(m, /not dispatchable from this session/)
      assert.ok(foldP(m).includes(foldP(aJson)))
      return true
    },
  )

  // Unknown session anchor (never observed): fail-open belt posture.
  await hB["tool.execute.before"]({ tool: "task", sessionID: "ses_unbound", callID: "g5" }, taskArgs("forge-research"))
})

test("wiring gate: a poolless session falls back to the global layer — workspace pools stay gated", async (t) => {
  const home = process.env.FORGE_TEST_FORGE_HOME
  mkdirSync(join(home, ".config", "opencode"), { recursive: true })
  writeFileSync(join(home, ".config", "opencode", "forge.json"), JSON.stringify({ agents: { universal: { model: "zai/glm", thoughtLevel: "low" } } }))
  t.after(() => {
    try {
      rmSync(join(home, ".config"), { recursive: true, force: true })
    } catch {}
  })
  const dirA = dirWithForgeJson(t, "forge-pool-fb-", { agents: { research: { model: "zai/glm", thoughtLevel: "low" } } })
  const poolless = mkdtempSync(join(tmpdir(), "forge-pool-none-"))
  t.after(() => {
    try {
      rmSync(poolless, { recursive: true, force: true })
    } catch {}
  })
  const h = await startServer(input(dirA), {})
  t.after(() => h.dispose?.())
  await h.config(emptyCfg())
  await bindSession(h, "ses_fb_none", poolless)
  // Global fallback dispatchable from the poolless session…
  await h["tool.execute.before"]({ tool: "task", sessionID: "ses_fb_none", callID: "fb1" }, taskArgs("forge-universal"))
  // …but the workspace pool is NOT (fallback, not merge — the roster is the
  // global layer, and forge-research belongs to another workspace).
  await assert.rejects(
    () => h["tool.execute.before"]({ tool: "task", sessionID: "ses_fb_none", callID: "fb2" }, taskArgs("forge-research")),
    /not dispatchable from this session/,
  )
  // The workspace session can dispatch its own pool but not the global
  // fallback family (its workspace HAS a pool — global is not merged in).
  await bindSession(h, "ses_fb_a", dirA)
  await h["tool.execute.before"]({ tool: "task", sessionID: "ses_fb_a", callID: "fb3" }, taskArgs("forge-research"))
  await assert.rejects(
    () => h["tool.execute.before"]({ tool: "task", sessionID: "ses_fb_a", callID: "fb4" }, taskArgs("forge-global-universal")),
    /not dispatchable from this session/,
  )
})

test("wiring deletion: removing a workspace pool file un-materializes it at the next config hook", async (t) => {
  const dirA = dirWithForgeJson(t, "forge-pool-del-", { agents: { research: { model: "zai/glm", thoughtLevel: "low" } } })
  const h = await startServer(input(dirA), {})
  t.after(() => h.dispose?.())
  const cfg1 = emptyCfg()
  await h.config(cfg1)
  assert.ok(cfg1.agent["forge-research"])
  rmSync(join(dirA, ".opencode", "forge.json"))
  const cfg2 = emptyCfg()
  await h.config(cfg2)
  assert.equal(cfg2.agent["forge-research"], undefined, "a deleted pool file disappears from materialization (no zombie pool)")
})

test("wiring roster: the /crew template session-scopes the roster (own pool via live injection; others NOT dispatchable)", async (t) => {
  const dirA = dirWithForgeJson(t, "forge-pool-ro-", { agents: { research: { model: "zai/glm", thoughtLevel: "low" } } })
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
  assert.ok(foldP(tpl).includes(foldP(join(dirB, ".opencode", "forge.json"))), "the other pool's origin path rides the mark")
  assert.match(tpl, /forge-research/)
  assert.match(tpl, /forge-teamb-shader/)
  assert.match(tpl, /nested deeper in the workspace subtree are ignored/, "nested-ignore strictness disclosed")
})

test("wiring crew_begin: the registration output session-scopes the dispatchable roster", async (t) => {
  const dirA = dirWithForgeJson(t, "forge-pool-cb-", { agents: { research: { model: "zai/glm", thoughtLevel: "low" } } })
  const dirB = dirWithForgeJson(t, "forge-pool-cb2-", { pool: "teamb", agents: { shader: { model: "zai/glm", thoughtLevel: "low" } } })
  const h = await startServer(input(dirA), {})
  t.after(() => h.dispose?.())
  await server(input(dirB), {})
  await h.config(emptyCfg())
  const out = await h.tool.crew_begin.execute({ objective: "o", subtasks: [{ title: "x" }] }, { ...allowCtx("ses_cb"), worktree: dirA, directory: dirA })
  assert.match(out.output, /Session roster origins — sole ownership/, "the session-scoped roster header")
  assert.match(out.output, /DISPATCHABLE from this session — workspace pool: [^\n]*forge\.json/, "the session's own pool leads, with origin path")
  assert.ok(foldP(out.output).includes(foldP(join(dirA, ".opencode", "forge.json"))))
  assert.match(out.output, /NOT dispatchable from this session — pool teamb/, "other pools marked with the verbatim anchor")
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
