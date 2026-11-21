import test from "node:test"
import assert from "node:assert/strict"

// native-first-roster task 5.1 — compiler core suite (design D2/D3/D6 +
// the test plan): namespacing, mode stamping, variant mapping, tools
// vocabulary, mandate baking, GENERATED header, GC, atomicity, staleness,
// and the NATIVE_TOOL_VOCAB drift mirror locked to the probe evidence
// (reports/probe-native-agent-surface.md, host 2.3.2, 2026-11-21).

import { createPoolResolver } from "../src/forge-config.ts"
import { MUTATING_TOOLS } from "../src/dispatch-tiers.ts"
import {
  NATIVE_TOOL_VOCAB,
  VARIANT_DEPTH_WORDS,
  GENERATED_MARKER,
  agentDirFor,
  compileRosterEntry,
  executeRosterSync,
  modelStringFor,
  planRosterSync,
  staleCheckForPool,
  toolsFaceFor,
} from "../src/roster-compile.ts"

// ---------------------------------------------------------------------------
// Fake in-memory fs (posix-style paths; mtime clock is manually steppable).
// ---------------------------------------------------------------------------
function fakeFs() {
  const files = new Map() // path -> { content, mtimeMs }
  const dirs = new Set()
  let clock = 1000
  return {
    setMtime: (p, mtimeMs) => {
      const f = files.get(p)
      if (f) f.mtimeMs = mtimeMs
    },
    text: (p) => files.get(p)?.content ?? null,
    paths: () => [...files.keys()],
    stat: (p) => (files.has(p) ? { mtimeMs: files.get(p).mtimeMs, size: files.get(p).content.length } : null),
    readFile: (p) => {
      if (!files.has(p)) throw new Error(`ENOENT: ${p}`)
      return files.get(p).content
    },
    writeFile: (p, d) => {
      files.set(p, { content: d, mtimeMs: ++clock })
    },
    rename: (from, to) => {
      if (!files.has(from)) throw new Error(`ENOENT: ${from}`)
      files.set(to, { content: files.get(from).content, mtimeMs: ++clock })
      files.delete(from)
    },
    unlink: (p) => {
      if (!files.has(p)) throw new Error(`ENOENT: ${p}`)
      files.delete(p)
    },
    readdir: (p) => [...files.keys()].filter((f) => f.startsWith(`${p}/`)).map((f) => f.slice(p.length + 1)),
    mkdir: (p) => {
      dirs.add(p)
    },
  }
}

const GLOBAL = "C:/home/.config/opencode/forge.json"

function seedPool(fs, file, top) {
  fs.writeFile(file, JSON.stringify(top))
}

function resolveOver(fs, anchors, home = "C:/home") {
  const resolver = createPoolResolver({ homeDir: home, stat: fs.stat, readFile: fs.readFile })
  return resolver.resolve(anchors)
}

// ---------------------------------------------------------------------------
// D6 — vocabulary drift mirror (locked to the probe evidence verbatim)
// ---------------------------------------------------------------------------

test("vocab mirror: NATIVE_TOOL_VOCAB is locked to the probe evidence (host 2.3.2)", () => {
  // Probe §1/§5: the dispatch tool's REAL name is `subagent`; the
  // frontmatter key `task` is host-mapped onto it (task:false → subagent deny).
  assert.equal(NATIVE_TOOL_VOCAB.dispatchTool, "subagent")
  assert.equal(NATIVE_TOOL_VOCAB.taskKey, "task")
  // Probe §5: the shell channel is the Code Mode runtime `execute`; the
  // legacy bash:false → shell-deny mapping does not cover it.
  assert.equal(NATIVE_TOOL_VOCAB.shellChannel, "execute")
  assert.deepEqual([...NATIVE_TOOL_VOCAB.legacyShellKeys], ["shell", "bash"])
  // The readonly face feeds from the SAME mutating family as the v1
  // materialization (one constant, zero drift — postrelease-hardening D3).
  assert.deepEqual([...NATIVE_TOOL_VOCAB.mutatingFamily], [...MUTATING_TOOLS])
})

test("depth split: exactly low/medium/high compile into the variant channel", () => {
  assert.deepEqual([...VARIANT_DEPTH_WORDS], ["low", "medium", "high"])
})

// ---------------------------------------------------------------------------
// Compile matrix (D2/D3)
// ---------------------------------------------------------------------------

test("compile: namespaced file per entry, mode ALWAYS stamped, GENERATED header names the recipe", () => {
  const fs = fakeFs()
  seedPool(fs, "C:/WsA/.opencode/forge.json", {
    pool: "alpha",
    agents: { research: { model: "zai/glm", thoughtLevel: "low", prompt: "Research role." } },
  })
  const resolution = resolveOver(fs, ["C:/WsA"])
  const plans = planRosterSync(resolution, { globalPoolFile: GLOBAL })
  assert.equal(plans.length, 1)
  assert.equal(plans[0].dir, "C:/WsA/.opencode/agent")
  assert.equal(plans[0].files.length, 1)
  const f = plans[0].files[0]
  assert.equal(f.fileName, "forge-alpha-research.md")
  const lines = f.content.split("\n")
  assert.equal(lines[0], "---")
  assert.ok(lines.includes("mode: subagent"), "mode: subagent is stamped")
  assert.ok(f.content.includes(GENERATED_MARKER), "GENERATED header present")
  assert.ok(f.content.includes("edit the recipe (C:/WsA/.opencode/forge.json)"), "header names the recipe file")
})

test("compile: variant words ride the model string; non-variant words leave it bare; Auto workers emit no model key", () => {
  assert.equal(modelStringFor({ model: "zai/glm", thoughtLevel: "low" }), "zai/glm#low")
  assert.equal(modelStringFor({ model: "zai/glm", thoughtLevel: "medium" }), "zai/glm#medium")
  assert.equal(modelStringFor({ model: "zai/glm", thoughtLevel: "high" }), "zai/glm#high")
  // none/minimal/xhigh/max keep the per-spawn chat.params path (design D3)
  for (const w of ["none", "minimal", "xhigh", "max"]) {
    assert.equal(modelStringFor({ model: "zai/glm", thoughtLevel: w }), "zai/glm", `${w} stays out of the variant channel`)
  }
  assert.equal(modelStringFor({}), undefined, "Auto worker — no model key")
})

test("compile: tools face per shape in probe vocabulary", () => {
  const ro = toolsFaceFor("readonly")
  assert.equal(ro.task, false, "task:false (host maps to its real dispatch tool `subagent`)")
  for (const t of MUTATING_TOOLS) assert.equal(ro[t], false, `readonly seals ${t}`)
  assert.equal(ro.execute, false, "readonly seals the Code-Mode shell channel `execute`")
  for (const k of ["shell", "bash"]) assert.equal(ro[k], false, `legacy ${k} hidden`)
  const wr = toolsFaceFor("write")
  assert.equal(wr.task, false)
  for (const k of ["shell", "bash"]) assert.equal(wr[k], false, "write workers hide the builtin shell — forge_shell owns execution")
  assert.equal(wr.execute, undefined, "write workers keep the execute channel (forge_shell partition keys on the forge- prefix)")
  for (const t of MUTATING_TOOLS) {
    if (NATIVE_TOOL_VOCAB.legacyShellKeys.includes(t)) continue // bash is hidden for every worker
    assert.equal(wr[t], undefined, `write shape leaves ${t} open (shape-default-open)`)
  }
})

test("compile: mandates + shape frame + role prompt + shared segment are baked into the body", () => {
  const fs = fakeFs()
  seedPool(fs, "C:/WsB/.opencode/forge.json", {
    pool: "beta",
    shared: "Shared pool preamble.",
    agents: {
      scout: { shape: "readonly", prompt: "Scout role text." },
      coder: { model: "zai/glm", thoughtLevel: "high" },
    },
  })
  const resolution = resolveOver(fs, ["C:/WsB"])
  const plans = planRosterSync(resolution, { globalPoolFile: GLOBAL })
  const byName = Object.fromEntries(plans[0].files.map((f) => [f.fileName, f.content]))
  const scout = byName["forge-beta-scout.md"]
  assert.ok(scout.includes("Mandates (non-negotiable):"), "standing mandates baked")
  assert.ok(scout.includes("a readonly worker"), "readonly shape frame baked")
  assert.ok(scout.includes("Scout role text."), "explicit role prompt baked")
  assert.ok(scout.includes("Shared pool preamble."), "pool-level shared segment rides beneath the role chain")
  assert.ok(scout.includes('mode: subagent'))
  const coder = byName["forge-beta-coder.md"]
  assert.ok(coder.includes('model: "zai/glm#high"'), "variant word compiles into the model string")
  assert.ok(coder.includes("beta-coder worker"), "generic role default for a prompt-less entry")
})

test("compile: description carries the pool provenance (workspace + global fallback)", () => {
  const fs = fakeFs()
  seedPool(fs, "C:/WsC/.opencode/forge.json", { pool: "gamma", agents: { research: {} } })
  seedPool(fs, GLOBAL, { agents: { helper: {} } })
  const resolution = resolveOver(fs, ["C:/WsC", "C:/NoPoolDir"])
  const plans = planRosterSync(resolution, { globalPoolFile: GLOBAL })
  const ws = plans.find((p) => p.family.ns === "gamma")
  assert.ok(ws.files[0].content.includes("Pool 'gamma' — origin C:/WsC/.opencode/forge.json"))
  assert.ok(ws.files[0].content.includes("dispatchable only from sessions whose workspace pool is this file"))
  const g = plans.find((p) => p.family.ns === "global")
  assert.equal(g.dir, "C:/home/.config/opencode/agent", "the global fallback family compiles into the host's global agent layer")
  assert.ok(g.files[0].content.includes("origin: the global fallback layer"))
  assert.equal(g.files[0].fileName, "forge-global-helper.md")
})

test("compile: frontmatter emits ONLY probe-proven keys (no permissions, no depth keys)", () => {
  const compiled = compileRosterEntry({
    matId: "alpha-research",
    def: { model: "zai/glm", thoughtLevel: "low", shape: "readonly" },
    provenance: { ns: "alpha", file: "C:/WsA/.opencode/forge.json" },
  })
  const fm = compiled.content.split("---")[1]
  const keys = fm.split("\n").filter((l) => l && !l.startsWith(" ")).map((l) => l.split(":")[0])
  assert.deepEqual(keys.sort(), ["description", "mode", "model", "tools"])
})

// ---------------------------------------------------------------------------
// Execute: write / update / GC / atomicity (D4)
// ---------------------------------------------------------------------------

test("execute: creates, then reports unchanged on a byte-equal rerun", () => {
  const fs = fakeFs()
  seedPool(fs, "C:/WsD/.opencode/forge.json", { pool: "delta", agents: { research: {} } })
  const plan = () => planRosterSync(resolveOver(fs, ["C:/WsD"]), { globalPoolFile: GLOBAL })
  const first = executeRosterSync(plan(), fs)
  assert.equal(first.created.length, 1)
  assert.equal(fs.text("C:/WsD/.opencode/agent/forge-delta-research.md") !== null, true)
  const second = executeRosterSync(plan(), fs)
  assert.equal(second.created.length, 0)
  assert.equal(second.updated.length, 0)
  assert.equal(second.unchanged.length, 1)
})

test("execute: GC removes orphaned GENERATED forge files, never hand-written ones", () => {
  const fs = fakeFs()
  const recipe = { pool: "eps", agents: { research: {} } }
  seedPool(fs, "C:/WsE/.opencode/forge.json", recipe)
  // A stale generated artifact for an entry that left the recipe...
  fs.writeFile("C:/WsE/.opencode/agent/forge-eps-gone.md", `${GENERATED_MARKER} — edit the recipe, not this file. -->\nold\n`)
  // ...a hand-written forge file (no marker)... and a non-forge file.
  fs.writeFile("C:/WsE/.opencode/agent/forge-eps-handwritten.md", "---\ndescription: hand-written\n---\n")
  fs.writeFile("C:/WsE/.opencode/agent/other-agent.md", "---\ndescription: someone else's\n---\n")
  const outcome = executeRosterSync(planRosterSync(resolveOver(fs, ["C:/WsE"]), { globalPoolFile: GLOBAL }), fs)
  assert.deepEqual(outcome.gced, ["C:/WsE/.opencode/agent/forge-eps-gone.md"])
  assert.notEqual(fs.text("C:/WsE/.opencode/agent/forge-eps-handwritten.md"), null, "hand-written forge file survives GC")
  assert.notEqual(fs.text("C:/WsE/.opencode/agent/other-agent.md"), null, "non-forge file survives GC")
  assert.notEqual(fs.text("C:/WsE/.opencode/agent/forge-eps-research.md"), null, "current entry still written")
})

test("execute: a failing write leaves NO half file at the destination (atomicity)", () => {
  const fs = fakeFs()
  seedPool(fs, "C:/WsF/.opencode/forge.json", { pool: "zeta", agents: { research: {} } })
  const plan = planRosterSync(resolveOver(fs, ["C:/WsF"]), { globalPoolFile: GLOBAL })
  const breaking = {
    ...fs,
    writeFile: (p) => {
      if (p.endsWith(".new")) throw new Error("disk full")
      return fs.writeFile(p)
    },
  }
  const outcome = executeRosterSync(plan, breaking)
  assert.equal(outcome.errors.length, 1)
  assert.match(outcome.errors[0], /disk full/)
  assert.equal(fs.text("C:/WsF/.opencode/agent/forge-zeta-research.md"), null, "no artifact landed")
  assert.equal(fs.paths().some((p) => p.endsWith(".new")), false, "no temp residue")
})

test("execute: rename refuses an existing destination → unlink+rename fallback lands the new content", () => {
  const fs = fakeFs()
  seedPool(fs, "C:/WsG/.opencode/forge.json", { pool: "eta", agents: { research: {} } })
  const plan = () => planRosterSync(resolveOver(fs, ["C:/WsG"]), { globalPoolFile: GLOBAL })
  executeRosterSync(plan(), fs) // creates the artifact
  fs.writeFile("C:/WsG/.opencode/forge.json", JSON.stringify({ pool: "eta", agents: { research: { prompt: "NEW ROLE" } } }))
  const refusing = {
    ...fs,
    rename: (from, to) => {
      if (fs.stat(to) !== null) throw new Error("EPERM: destination exists")
      return fs.rename(from, to)
    },
  }
  const outcome = executeRosterSync(plan(), refusing)
  assert.equal(outcome.updated.length, 1)
  assert.ok(fs.text("C:/WsG/.opencode/agent/forge-eta-research.md").includes("NEW ROLE"))
})

// ---------------------------------------------------------------------------
// Staleness (D4)
// ---------------------------------------------------------------------------

test("staleness: fresh passes; recipe-newer and missing-artifact refuse; empty recipe never stale", () => {
  const fs = fakeFs()
  seedPool(fs, "C:/WsH/.opencode/forge.json", { pool: "theta", agents: { research: {} } })
  const ids = ["theta-research"]
  // Artifacts missing while the recipe has agents → stale.
  assert.equal(staleCheckForPool("C:/WsH/.opencode/forge.json", ids, fs).stale, true)
  executeRosterSync(planRosterSync(resolveOver(fs, ["C:/WsH"]), { globalPoolFile: GLOBAL }), fs)
  // Fresh after sync.
  assert.equal(staleCheckForPool("C:/WsH/.opencode/forge.json", ids, fs).stale, false)
  // Recipe newer than the newest artifact → stale (the sync round-trip gate).
  fs.setMtime("C:/WsH/.opencode/forge.json", Date.now() + 10_000)
  const verdict = staleCheckForPool("C:/WsH/.opencode/forge.json", ids, fs)
  assert.equal(verdict.stale, true)
  assert.match(verdict.reason, /newer/)
  // Empty recipe / no pool → never stale (exempt posture).
  assert.equal(staleCheckForPool("C:/WsH/.opencode/forge.json", [], fs).stale, false)
  assert.equal(staleCheckForPool(null, ids, fs).stale, false)
})

test("staleness: content-based verdict — an mtime-newer recipe with identical compiled output is NOT stale", () => {
  const fs = fakeFs()
  seedPool(fs, "C:/WsI/.opencode/forge.json", { pool: "iota", agents: { research: {} } })
  const resolution = resolveOver(fs, ["C:/WsI"])
  const plans = planRosterSync(resolution, { globalPoolFile: GLOBAL })
  executeRosterSync(plans, fs)
  // Recipe mtime jumps into the future (touch / checkout skew)...
  fs.setMtime("C:/WsI/.opencode/forge.json", Date.now() + 60_000)
  // The oracle compiles from the CURRENT recipe on every call (the same
  // freshness the plugin's rosterContentOf has — it re-resolves per gate).
  const contentOf = (matId) =>
    planRosterSync(resolveOver(fs, ["C:/WsI"]), { globalPoolFile: GLOBAL })[0].files.find((f) => f.matId === matId).content
  // ...but content identical → fresh.
  assert.equal(staleCheckForPool("C:/WsI/.opencode/forge.json", ["iota-research"], fs, contentOf).stale, false)
  // A real edit → the compiled output differs → stale, with the honest reason.
  seedPool(fs, "C:/WsI/.opencode/forge.json", { pool: "iota", agents: { research: { prompt: "CHANGED" } } })
  fs.setMtime("C:/WsI/.opencode/forge.json", Date.now() + 120_000)
  const verdict = staleCheckForPool("C:/WsI/.opencode/forge.json", ["iota-research"], fs, contentOf)
  assert.equal(verdict.stale, true)
  assert.match(verdict.reason, /differs from what it compiles to/)
})

test("agentDirFor: workspace pools and the global layer both target their sibling agent directory", () => {
  assert.equal(agentDirFor("C:/Ws/.opencode/forge.json"), "C:/Ws/.opencode/agent")
  assert.equal(agentDirFor("C:/home/.config/opencode/forge.json"), "C:/home/.config/opencode/agent")
  assert.equal(agentDirFor("C:\\Ws\\.opencode\\forge.json"), "C:\\Ws\\.opencode\\agent")
})
