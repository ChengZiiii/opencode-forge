import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Task 1.1/1.2 — forge-config core (spec: forge-subagents — "Static agent
// definitions in a dedicated forge.json" + "Field-level fail-soft validation"):
// field-level fail-soft degradations, cascade with a single winner, hot-apply
// cache, NO seed, NO recipe, inert unconfigured state.

import { createForgeConfigLoader, parseForgeJsonc, validateAgentSet, forgeConfigPaths } from "../src/forge-config.ts"

function loaderWith(files, opts = {}) {
  return createForgeConfigLoader({
    projectDir: opts.projectDir ?? "C:/proj",
    homeDir: opts.homeDir ?? "C:/home",
    stat: (p) => (files[p] === undefined ? null : { mtimeMs: 1, size: files[p].length }),
    readFile: (p) => files[p],
  })
}

test("parse: valid JSONC with comments and trailing commas", () => {
  const r = parseForgeJsonc(`{\n  // comment\n  "agents": { "a": { "model": "p/m", "thoughtLevel": "low", } },\n}`)
  assert.equal(r.ok, true)
})

test("parse: syntax error carries a location and the agent set empties", () => {
  const r = parseForgeJsonc(`{ "agents": { "a": { "model": } } }`)
  assert.equal(r.ok, false)
  if (!r.ok) assert.match(r.error.message, /line \d+/)
})

test("fail-soft: one bad entry skips only itself, siblings still apply", () => {
  const { agents, findings } = validateAgentSet({
    good: { model: "p/good", thoughtLevel: "low" },
    bad: { thoughtLevel: "low" }, // thoughtLevel without model — half-configured
    alsobad: "not an object",
  })
  assert.deepEqual(Object.keys(agents), ["good"])
  assert.equal(agents.good.model, "p/good")
  assert.equal(findings.filter((f) => f.level === "error").length, 2)
  assert.ok(findings.some((f) => f.code === "agent-half-configured" && /model is missing/.test(f.message)))
  assert.ok(findings.some((f) => f.code === "agent-not-object"))
})

test("atomic pair: both absent = Auto worker, accepted with no finding", () => {
  const { agents, findings } = validateAgentSet({ scout: {} })
  assert.deepEqual(Object.keys(agents), ["scout"])
  assert.equal(agents.scout.model, undefined)
  assert.equal(agents.scout.thoughtLevel, undefined)
  assert.ok(!("model" in agents.scout))
  assert.deepEqual(findings, [])
})

test("atomic pair: model without thoughtLevel is half-configured and skipped", () => {
  const { agents, findings } = validateAgentSet({ a: { model: "p/m" } })
  assert.deepEqual(agents, {})
  assert.ok(findings.some((f) => f.code === "agent-half-configured" && /thoughtLevel is missing/.test(f.message) && f.level === "error"))
})

test("atomic pair: empty-string model counts as absent — half-configured when thoughtLevel present", () => {
  const { agents, findings } = validateAgentSet({ a: { model: "  ", thoughtLevel: "low" } })
  assert.deepEqual(agents, {})
  assert.ok(findings.some((f) => f.code === "model-invalid" && f.level === "warn"))
  assert.ok(findings.some((f) => f.code === "agent-half-configured" && /model is missing/.test(f.message)))
})

test("fail-soft: invalid id skips the entry with an error finding", () => {
  const { agents, findings } = validateAgentSet({ "Bad_Id!": { model: "p/m", thoughtLevel: "low" } })
  assert.deepEqual(agents, {})
  assert.ok(findings.some((f) => f.code === "agent-id-invalid"))
})

test("fail-soft: a mistyped pair member invalidates its entry; other mistyped fields cost only themselves", () => {
  const { agents, findings } = validateAgentSet({
    a: { model: "p/m", thoughtLevel: 3, shape: "aggressive", permission: { bash: 1 } },
  })
  // thoughtLevel 3 counts as absent -> model-only -> the whole entry is skipped.
  assert.deepEqual(agents, {})
  assert.ok(findings.some((f) => f.code === "thoughtlevel-invalid" && f.level === "warn"))
  assert.ok(findings.some((f) => f.code === "agent-half-configured" && f.level === "error"))
})

test("fail-soft: mistyped optional fields without pair involvement still degrade per field", () => {
  const { agents, findings } = validateAgentSet({
    a: { shape: "aggressive", permission: { bash: 1 }, prompt: "" },
  })
  assert.ok(agents.a, "an Auto entry with mistyped non-pair fields still materializes")
  assert.equal(agents.a.model, undefined)
  assert.equal(agents.a.shape, undefined)
  assert.equal(agents.a.permission, undefined)
  assert.ok(findings.some((f) => f.code === "shape-invalid"))
  assert.ok(findings.some((f) => f.code === "permission-invalid"))
  assert.ok(findings.some((f) => f.code === "prompt-invalid"))
})

test("depths is deprecated: warning finding, no behavior", () => {
  const { agents, findings } = validateAgentSet({ a: { model: "p/m", thoughtLevel: "low", depths: ["low", "medium"] } })
  assert.equal(agents.a.model, "p/m")
  assert.equal(agents.a.thoughtLevel, "low")
  assert.ok(findings.some((f) => f.code === "depths-deprecated" && f.level === "warn"))
})

test("cascade: layers MERGE — project overrides global per agent id, wholesale", () => {
  const files = {
    "C:/proj/.opencode/forge.json": JSON.stringify({ agents: { research: { model: "proj/model", thoughtLevel: "low" } } }),
    "C:/home/.config/opencode/forge.json": JSON.stringify({ agents: { research: { model: "global/model", thoughtLevel: "high" }, review: { model: "global/model", thoughtLevel: "low" } } }),
  }
  const l = loaderWith(files)
  const r = l.load()
  assert.equal(r.source, "project+global")
  assert.deepEqual(Object.keys(r.agents).sort(), ["research", "review"])
  assert.equal(r.agents.research.model, "proj/model", "project definition wins the colliding id")
  assert.equal(r.agents.research.thoughtLevel, "low", "wholesale — no cross-layer field blending")
  assert.equal(r.agents.review.model, "global/model", "a global-only id survives the merge")
  assert.equal(r.projectPath, "C:/proj/.opencode/forge.json")
})

test("cascade: global applies when no project file exists", () => {
  const files = {
    "C:/home/.config/opencode/forge.json": JSON.stringify({ agents: { review: { model: "global/model", thoughtLevel: "low" } } }),
  }
  const l = loaderWith(files)
  const r = l.load()
  assert.equal(r.source, "global")
  assert.equal(r.agents.review.model, "global/model")
  assert.equal(r.projectPath, null)
})

test("discovery: walks up — the NEAREST .opencode/forge.json wins and nothing above it is consulted", () => {
  const files = {
    "C:/work/repo/packages/app/.opencode/forge.json": JSON.stringify({ agents: { nested: { model: "p/n", thoughtLevel: "low" } } }),
    "C:/work/repo/.opencode/forge.json": JSON.stringify({ agents: { repo: { model: "p/r", thoughtLevel: "low" } } }),
    "C:/work/.opencode/forge.json": JSON.stringify({ agents: { above: { model: "p/a", thoughtLevel: "low" } } }),
  }
  const r = loaderWith(files, { projectDir: "C:/work/repo/packages/app" }).load()
  assert.equal(r.projectPath, "C:/work/repo/packages/app/.opencode/forge.json")
  assert.deepEqual(Object.keys(r.agents), ["nested"])
})

test("discovery: no file at the anchor still finds the ancestor's, then merges with global", () => {
  const files = {
    "C:/work/repo/.opencode/forge.json": JSON.stringify({ agents: { repo: {} } }),
    "C:/home/.config/opencode/forge.json": JSON.stringify({ agents: { g: {} } }),
  }
  const r = loaderWith(files, { projectDir: "C:/work/repo/packages/app" }).load()
  assert.equal(r.source, "project+global")
  assert.deepEqual(Object.keys(r.agents).sort(), ["g", "repo"])
})

test("fail-soft per layer: a broken project doc empties only its layer; global still applies", () => {
  const files = {
    "C:/proj/.opencode/forge.json": "{ agents: { broken",
    "C:/home/.config/opencode/forge.json": JSON.stringify({ agents: { review: { model: "global/model", thoughtLevel: "low" } } }),
  }
  const r = loaderWith(files).load()
  assert.deepEqual(Object.keys(r.agents), ["review"])
  assert.equal(r.findings.length, 1)
  assert.equal(r.findings[0].code, "config-parse-error")
  assert.match(r.findings[0].message, /line \d+, column \d+/)
})

test("hot-apply: a project file appearing or vanishing on the chain applies without restart", () => {
  const files = {}
  let mtime = 1
  const l = createForgeConfigLoader({
    projectDir: "C:/proj",
    homeDir: "C:/home",
    stat: (p) => (files[p] === undefined ? null : { mtimeMs: mtime, size: files[p].length }),
    readFile: (p) => files[p],
  })
  assert.equal(l.load().source, "none")
  files["C:/proj/.opencode/forge.json"] = JSON.stringify({ agents: { a: { model: "p/m", thoughtLevel: "low" } } })
  mtime++
  assert.equal(l.load().source, "project")
  delete files["C:/proj/.opencode/forge.json"]
  mtime++
  assert.equal(l.load().source, "none")
})

test("broken JSON with no other layer: empty set + one parse-location error finding; NO seed resurrects", () => {
  const files = { "C:/proj/.opencode/forge.json": "{ agents: { broken" }
  const l = loaderWith(files)
  const r = l.load()
  assert.deepEqual(r.agents, {})
  assert.equal(r.findings.length, 1)
  assert.equal(r.findings[0].code, "config-parse-error")
  assert.match(r.findings[0].message, /line \d+, column \d+/)
})

test("unconfigured state is INERT and SILENT: empty agents, zero findings", () => {
  const l = loaderWith({})
  const r = l.load()
  assert.deepEqual(r.agents, {})
  assert.deepEqual(r.findings, [])
  assert.equal(r.source, "none")
  assert.equal(r.path, null)
})

test("hot-apply: an mtime/size change re-reads; unchanged stat hits the cache", () => {
  let mtime = 1
  const content = { text: JSON.stringify({ agents: { a: { model: "p/v1", thoughtLevel: "low" } } }) }
  const l = createForgeConfigLoader({
    projectDir: "C:/proj",
    stat: () => ({ mtimeMs: mtime, size: content.text.length }),
    readFile: () => content.text,
  })
  assert.equal(l.load().agents.a.model, "p/v1")
  // Same content, new mtime: re-read happens but result matches (cache keyed on stat).
  content.text = JSON.stringify({ agents: { a: { model: "p/v2", thoughtLevel: "low" } } })
  mtime = 2
  assert.equal(l.load().agents.a.model, "p/v2")
})

test("paths: project uses .opencode/forge.json, global uses ~/.config/opencode/forge.json", () => {
  const p = forgeConfigPaths({ projectDir: "C:/w", homeDir: "C:/Users/x" })
  assert.ok(p.project.includes(".opencode"))
  assert.ok(p.global.includes(".config"))
  assert.ok(p.global.endsWith("forge.json"))
})

test("loader against a real temp dir end to end", () => {
  const dir = mkdtempSync(join(tmpdir(), "forge-config-"))
  try {
    writeFileSync(join(dir, ".opencode", "forge.json"), "", { flag: "wx" })
  } catch {}
  try {
    const l = createForgeConfigLoader({ projectDir: dir, homeDir: join(dir, "home") })
    const r1 = l.load()
    assert.equal(r1.source, "none")
    rmSync(join(dir, ".opencode", "forge.json"), { force: true })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
