import test from "node:test"
import assert from "node:assert/strict"

// Spec: openspec/changes/add-dispatch-onboarding/specs/dispatch/spec.md
//   ADDED "Dedicated forge.json configuration file" — the file is JSONC
//   (comments allowed), parsed by a string-state-machine stripper so comment
//   markers inside string values never eat data.
//
// 1.1 parseForgeJsonc: comments / trailing commas / strings containing comment
// markers / escaped quotes / bad JSON with a located error.

import { parseForgeJsonc, forgeConfigPaths, createForgeConfigLoader, SEED_AGENTS, PLACEHOLDER_IDENTITY } from "../src/forge-config.ts"

test("1.1 line and block comments are stripped", () => {
  const r = parseForgeJsonc(`{
  // dispatch agents
  "agents": {
    /* research worker */ "research": { "model": "zai/glm-5.3", "depths": ["low"] }
  }
}`)
  assert.equal(r.ok, true)
  assert.deepEqual(r.config.agents.research.model, "zai/glm-5.3")
})

test("1.1 strings containing comment markers survive verbatim", () => {
  const r = parseForgeJsonc(`{
  "agents": {
    "odd": { "model": "x/y", "depths": ["low"], "prompt": "see https://example.com // not a comment /* also not */" }
  }
}`)
  assert.equal(r.ok, true)
  assert.equal(r.config.agents.odd.prompt, "see https://example.com // not a comment /* also not */")
})

test("1.1 trailing commas are tolerated", () => {
  const r = parseForgeJsonc(`{
  "agents": {
    "research": { "model": "zai/glm-5.3", "depths": ["low", "medium",], },
  },
}`)
  assert.equal(r.ok, true)
  assert.deepEqual(r.config.agents.research.depths, ["low", "medium"])
})

test("1.1 escaped quotes inside strings do not terminate the string state", () => {
  const r = parseForgeJsonc(`{
  "agents": {
    "q": { "model": "x/y", "depths": ["low"], "prompt": "say \\"hi\\" // keep" }
  }
}`)
  assert.equal(r.ok, true)
  assert.equal(r.config.agents.q.prompt, 'say "hi" // keep')
})

test("1.1 bad JSON errors with a located message", () => {
  const r = parseForgeJsonc(`{
  "agents": {
    "research": { "model": }
  }
}`)
  assert.equal(r.ok, false)
  assert.ok(r.error.message.length > 0, "error message is non-empty")
  // Position must be reported and must point into the ORIGINAL text (comments
  // are stripped space-preserving, so offsets align 1:1).
  assert.ok(typeof r.error.line === "number" && r.error.line >= 1, "error carries a 1-based line")
  assert.ok(typeof r.error.column === "number" && r.error.column >= 1, "error carries a 1-based column")
  assert.equal(r.error.line, 3)
})

test("1.1 non-object top level is a parse error", () => {
  const r = parseForgeJsonc(`[1, 2]`)
  assert.equal(r.ok, false)
})

// ---------------------------------------------------------------------------
// 1.2 three-level cascade, single winning source, no merging.

const GLOBAL_TEXT = `{
  "agents": {
    "reviewer": { "model": "anthropic/claude-haiku-4-5", "depths": ["medium", "high"] }
  }
}`
const PROJECT_TEXT = `{
  "agents": {
    "research": { "model": "zai/glm-5.3", "depths": ["low", "high", "max"] }
  }
}`

function loaderWith(files) {
  return createForgeConfigLoader({
    projectDir: "/w",
    homeDir: "/h",
    stat: (p) => (files[p] ? { mtimeMs: files[p].mtime ?? 1, size: files[p].text.length } : null),
    readFile: (p) => files[p].text,
  })
}

test("1.2 project file wins fully — global is not merged in", () => {
  const paths = forgeConfigPaths({ projectDir: "/w", homeDir: "/h" })
  assert.equal(paths.project, "/w/.opencode/forge.json")
  assert.equal(paths.global, "/h/.config/opencode/forge.json")
  const loader = loaderWith({ "/w/.opencode/forge.json": { text: PROJECT_TEXT }, "/h/.config/opencode/forge.json": { text: GLOBAL_TEXT } })
  const loaded = loader.load()
  assert.equal(loaded.source, "project")
  assert.equal(loaded.path, "/w/.opencode/forge.json")
  assert.deepEqual(Object.keys(loaded.agents), ["research"], "global-only agents must not leak in")
})

test("1.2 global file serves when no project file exists", () => {
  const loader = loaderWith({ "/h/.config/opencode/forge.json": { text: GLOBAL_TEXT } })
  const loaded = loader.load()
  assert.equal(loaded.source, "global")
  assert.deepEqual(Object.keys(loaded.agents), ["reviewer"])
})

test("1.2 seed serves when neither file exists — research/review pinned to the placeholder", () => {
  const loader = loaderWith({})
  const loaded = loader.load()
  assert.equal(loaded.source, "seed")
  assert.equal(loaded.path, null)
  assert.deepEqual(Object.keys(loaded.agents).sort(), ["research", "review"])
  assert.equal(loaded.agents.research.model, PLACEHOLDER_IDENTITY)
  assert.equal(PLACEHOLDER_IDENTITY, "Local/GPT Luna")
  assert.deepEqual(SEED_AGENTS.research.depths, ["low", "medium"])
  assert.deepEqual(SEED_AGENTS.review.depths, ["medium", "high", "max"])
})

// ---------------------------------------------------------------------------
// 1.3 hot-apply: mtime+size cache — re-read only when the file changed; a
// broken file falls back to the seed with a config-parse-error finding.

test("1.3 unchanged file is served from cache (no re-read)", () => {
  let reads = 0
  const files = { "/w/.opencode/forge.json": { text: PROJECT_TEXT, mtime: 1 } }
  const loader = createForgeConfigLoader({
    projectDir: "/w",
    homeDir: "/h",
    stat: (p) => (files[p] ? { mtimeMs: files[p].mtime, size: files[p].text.length } : null),
    readFile: (p) => {
      reads++
      return files[p].text
    },
  })
  const a = loader.load()
  const b = loader.load()
  assert.equal(a.source, "project")
  assert.equal(reads, 1, "second load must be a cache hit")
  assert.deepEqual(Object.keys(b.agents), ["research"])
})

test("1.3 edited file is re-read and the new content applies", () => {
  const files = { "/w/.opencode/forge.json": { text: PROJECT_TEXT, mtime: 1 } }
  const loader = loaderWith(files)
  assert.deepEqual(Object.keys(loader.load().agents), ["research"])
  files["/w/.opencode/forge.json"] = { text: `{"agents": {"audit": {"model": "x/y", "depths": ["low"]}}}`, mtime: 2 }
  const next = loader.load()
  assert.deepEqual(Object.keys(next.agents), ["audit"], "changed mtime must trigger a re-read")
})

test("1.3 broken file falls back to the seed with a located config-parse-error finding", () => {
  const loader = loaderWith({ "/w/.opencode/forge.json": { text: `{ "agents": { "x": { "model": } } }` } })
  const loaded = loader.load()
  assert.equal(loaded.source, "seed")
  assert.equal(loaded.findings.length, 1)
  assert.equal(loaded.findings[0].code, "config-parse-error")
  assert.equal(loaded.findings[0].level, "error")
  assert.ok(loaded.findings[0].message.includes("/w/.opencode/forge.json"))
  assert.ok(loaded.findings[0].message.includes("line"), "finding carries the located line")
})

test("1.3 repairing the file recovers on the next load", () => {
  const files = { "/w/.opencode/forge.json": { text: `{ broken`, mtime: 1 } }
  const loader = loaderWith(files)
  assert.equal(loader.load().source, "seed")
  files["/w/.opencode/forge.json"] = { text: PROJECT_TEXT, mtime: 2 }
  const recovered = loader.load()
  assert.equal(recovered.source, "project")
  assert.deepEqual(recovered.findings, [])
})
