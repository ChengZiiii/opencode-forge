import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

// forge-config-json-schema (design D1/D3/D4): the hand-written schema is a
// MIRROR of the imperative fail-soft validator — these tests are the lock
// that fails CI when either side drifts (enum/pattern/atomic-pair vs code
// constants), plus the `$schema`-key tolerance regression and the
// shape-invalid finding-text fix (write default — shape-default-open).

import { validateAgentSet, validatePoolField, parseForgeJsonc, createForgeConfigLoader } from "../src/forge-config.ts"

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..")
const schema = JSON.parse(readFileSync(join(repoRoot, "schema", "forge.schema.json"), "utf8"))
const agentSchema = schema.definitions.agent

test("mirror: shape enum equals the code's accepted shape set (both directions)", () => {
  const enumValues = agentSchema.properties.shape.enum
  assert.deepEqual([...enumValues].sort(), ["readonly", "write"])
  // code direction: validateAgentSet keeps the shape iff it is an enum member
  for (const probe of ["readonly", "write", "Readonly", "READ-ONLY", 1, null, "read-only", ""]) {
    const { agents } = validateAgentSet({ a: { shape: probe } })
    const kept = agents.a !== undefined && agents.a.shape !== undefined
    assert.equal(kept, enumValues.includes(probe), `shape ${JSON.stringify(probe)}: schema=${enumValues.includes(probe)} code=${kept}`)
  }
})

test("mirror: agent-id propertyNames pattern accepts exactly what the id rule accepts", () => {
  const re = new RegExp(schema.properties.agents.propertyNames.pattern)
  // ("forge-" alone is an ambiguous edge — schema-pattern accepts it as a
  // literal id, code strips the prefix and rejects the empty remainder — so
  // it is deliberately not probed here; every real-world shape mirrors.)
  for (const id of ["a", "scout", "research-2", "UPPER", "under_score", "sp ace", "forge-x", "forge-forge-x", "a.b", ""]) {
    const { agents, findings } = validateAgentSet({ [id]: {} })
    const codeAccepts = agents[id] !== undefined || agents[id.replace(/^(forge-)+/, "")] !== undefined
    assert.equal(codeAccepts, re.test(id), `id ${JSON.stringify(id)}: schema=${re.test(id)} code=${codeAccepts} (${findings.map((f) => f.code).join(",")})`)
  }
})

test("mirror: pool pattern equals validatePoolField's accept set (unpadded values)", () => {
  const re = new RegExp(schema.properties.pool.pattern)
  for (const probe of ["aa", "a", "team-blue", "x".repeat(24), "x".repeat(25), "UPPER", "sp ace", "under_score", ""]) {
    assert.equal(validatePoolField(probe).ok, re.test(probe), `pool ${JSON.stringify(probe)}: schema=${re.test(probe)} code=${validatePoolField(probe).ok}`)
  }
  // documented asymmetry (design D1 / explore Q1.3): the plugin trims before
  // validating, the schema pattern sees the raw string — padded values pass
  // code and fail the schema; write unpadded.
  assert.equal(validatePoolField(" aa ").ok, true)
  assert.equal(re.test(" aa "), false)
})

test("mirror: atomic pair constraint is expressed as both-or-neither (anyOf/not)", () => {
  assert.deepEqual(agentSchema.anyOf, [
    { required: ["model", "thoughtLevel"] },
    { not: { anyOf: [{ required: ["model"] }, { required: ["thoughtLevel"] }] } },
  ])
  // code direction: both = pinned, neither = Auto, exactly one = skipped error
  const pinned = validateAgentSet({ a: { model: "p/m", thoughtLevel: "low" } })
  assert.equal(pinned.agents.a.model, "p/m")
  const auto = validateAgentSet({ a: {} })
  assert.equal(auto.agents.a.model, undefined)
  for (const half of [{ model: "p/m" }, { thoughtLevel: "low" }]) {
    const r = validateAgentSet({ a: half })
    assert.equal(r.agents.a, undefined)
    assert.ok(r.findings.some((f) => f.code === "agent-half-configured"))
  }
})

test("finding text: shape-invalid states the WRITE default (shape-default-open)", () => {
  const { agents, findings } = validateAgentSet({ a: { shape: "read-only" } })
  const f = findings.find((x) => x.code === "shape-invalid")
  assert.ok(f)
  assert.match(f.message, /defaulting to write/)
  assert.doesNotMatch(f.message, /defaulting to readonly/)
  assert.equal(agents.a.shape, undefined) // downstream def.shape ?? "write"
})

test("tolerance: a $schema top-level key parses clean in both consumption paths", () => {
  const doc = `{\n  "$schema": "https://unpkg.com/@sorenllm/opencode-forge@latest/dist/forge.schema.json",\n  "agents": { "scout": {} }\n}`
  // parse path
  const parsed = parseForgeJsonc(doc)
  assert.equal(parsed.ok, true)
  if (parsed.ok) {
    const { agents, findings } = validateAgentSet(parsed.config.agents)
    assert.deepEqual(Object.keys(agents), ["scout"])
    assert.equal(findings.length, 0)
  }
  // cascade loader path (fake fs): zero findings, roster intact
  const file = "C:/proj/.opencode/forge.json"
  const loader = createForgeConfigLoader({
    projectDir: "C:/proj",
    homeDir: "C:/home",
    stat: (p) => (p === file ? { mtimeMs: 1, size: doc.length } : null),
    readFile: () => doc,
  })
  const loaded = loader.load()
  assert.deepEqual(Object.keys(loaded.agents), ["scout"])
  assert.equal(loaded.findings.length, 0)
})
