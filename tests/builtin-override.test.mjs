import test from "node:test"
import assert from "node:assert/strict"

// builtin-override (tasks 1.3 + 2.1) — compiler + resolver matrix, design
// D1/D2/D4/D5 (probe evidence: reports/probe-builtin-override.md, host
// 2.3.2, 2026-11-21): recipe key (global-only `override` node, fail-soft),
// lowercase case-locked emission, collision redline, marker-keyed GC,
// globalAgentDir host-resolution mirror (both branches), unconfigured =
// zero emission.

import { BUILTIN_OVERRIDE_IDS, createPoolResolver, validateOverrideNode } from "../src/forge-config.ts"
import { GENERATED_MARKER, compileOverrideEntry, executeRosterSync, globalAgentDirFor, planOverrideSync } from "../src/roster-compile.ts"

// ---------------------------------------------------------------------------
// Fake in-memory fs (posix-style paths; same shape as roster-compile tests)
// ---------------------------------------------------------------------------
function fakeFs() {
  const files = new Map()
  let clock = 1000
  return {
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
    mkdir: () => {},
  }
}

const HOME = "C:/home"
const GLOBAL_FILE = `${HOME}/.config/opencode/forge.json`
const GLOBAL_AGENT_DIR = `${HOME}/.config/opencode/agent`
const WS = "C:/work/proj"
const WS_FILE = `${WS}/.opencode/forge.json`

// ---------------------------------------------------------------------------
// D1 — recipe key: validateOverrideNode fail-soft matrix
// ---------------------------------------------------------------------------

test("override node: absent/null node is inert — no findings, no overrides", () => {
  for (const raw of [undefined, null]) {
    const out = validateOverrideNode(raw, "g")
    assert.deepEqual(out.overrides, {})
    assert.deepEqual(out.findings, [])
  }
})

test("override node: known lowercase ids validate like agent defs (atomic pair, prompt, shape)", () => {
  const out = validateOverrideNode(
    {
      general: { model: "p/m", thoughtLevel: "low", prompt: "my general" },
      explore: { model: "p/m", thoughtLevel: "medium", shape: "readonly", prompt: "my scout" },
    },
    "g",
  )
  assert.deepEqual(Object.keys(out.overrides).sort(), ["explore", "general"])
  assert.equal(out.overrides.general.model, "p/m")
  assert.equal(out.overrides.explore.shape, "readonly")
  assert.deepEqual(out.findings, [])
})

test("override node: unknown ids warn + skip; capitalized negative form never survives", () => {
  const out = validateOverrideNode(
    {
      build: { model: "p/m", thoughtLevel: "low" },
      plan: { model: "p/m", thoughtLevel: "low" },
      General: { model: "p/m", thoughtLevel: "low" },
    },
    "g",
  )
  assert.deepEqual(out.overrides, {}, "no override id outside the builtin set survives")
  const codes = out.findings.map((f) => f.code)
  assert.ok(codes.includes("override-id-unknown"), `unknown ids carry override-id-unknown (${codes.join(",")})`)
  // capitalized "General" fails the [a-z0-9-] id rule inside validateAgentSet
  // (entry skipped, error finding) — the case-lock is enforced upstream of
  // emission and again in compileOverrideEntry.
  assert.ok(out.findings.some((f) => f.code === "agent-id-invalid" && f.message.includes("override.General")), "capitalized key is skipped with an error finding")
})

test("override node: half-configured pair skips the entry, siblings still apply", () => {
  const out = validateOverrideNode(
    {
      general: { model: "p/m" },
      explore: { model: "p/m", thoughtLevel: "high" },
    },
    "g",
  )
  assert.deepEqual(Object.keys(out.overrides), ["explore"])
  assert.ok(out.findings.some((f) => f.code === "agent-half-configured" && f.message.includes("override.general")), "half pair names override.general")
})

test("override node: non-object node warns and is ignored", () => {
  const out = validateOverrideNode([1, 2], "g")
  assert.deepEqual(out.overrides, {})
  assert.equal(out.findings[0].code, "override-node-invalid")
})

// ---------------------------------------------------------------------------
// D1 — resolver wiring: global-only surface, workspace node ignored + warned
// ---------------------------------------------------------------------------

test("resolver: the GLOBAL file's override node surfaces on the resolution", () => {
  const fs = fakeFs()
  fs.writeFile(GLOBAL_FILE, JSON.stringify({ override: { explore: { model: "p/m", thoughtLevel: "low" } } }))
  const res = createPoolResolver({ homeDir: HOME, stat: fs.stat, readFile: fs.readFile }).resolve([])
  assert.deepEqual(Object.keys(res.overrides), ["explore"])
})

test("resolver: a WORKSPACE override node is ignored with a warn finding (global-only layer)", () => {
  const fs = fakeFs()
  fs.writeFile(WS_FILE, JSON.stringify({ pool: "p", override: { general: { model: "p/m", thoughtLevel: "low" } }, agents: {} }))
  const res = createPoolResolver({ homeDir: HOME, stat: fs.stat, readFile: fs.readFile }).resolve([WS])
  assert.deepEqual(res.overrides, {}, "workspace override entries never surface")
  assert.ok(res.findings.some((f) => f.code === "override-node-ignored-workspace" && f.message.includes(WS_FILE)), "the finding names the workspace file")
})

test("resolver: no override node anywhere — empty overrides, zero findings", () => {
  const fs = fakeFs()
  fs.writeFile(GLOBAL_FILE, JSON.stringify({ agents: { a: { model: "p/m", thoughtLevel: "low" } } }))
  const res = createPoolResolver({ homeDir: HOME, stat: fs.stat, readFile: fs.readFile }).resolve([])
  assert.deepEqual(res.overrides, {})
  assert.ok(!res.findings.some((f) => f.code.startsWith("override")))
})

// ---------------------------------------------------------------------------
// D2 — emission: case-locked lowercase stems, marker, model/variant, tools
// ---------------------------------------------------------------------------

test("compileOverrideEntry: lowercase stems emit with marker, mode:subagent, model#variant, tools face per shape", () => {
  const general = compileOverrideEntry({ id: "general", def: { model: "p/m", thoughtLevel: "low", prompt: "my general" }, recipeFile: GLOBAL_FILE })
  assert.equal(general.fileName, "general.md", "no forge- prefix — the exact builtin id stem")
  assert.ok(general.content.includes("mode: subagent"))
  assert.ok(general.content.includes('"p/m#low"'), "variant depth words ride the model string like workers")
  assert.ok(general.content.includes(GENERATED_MARKER), "GENERATED marker present (GC keys on it)")
  assert.ok(general.content.includes("my general"), "an explicit prompt is the body verbatim")
  // write face: task + legacy shell keys sealed (same rules as workers)
  assert.match(general.content, /^  task: false$/m)
  assert.match(general.content, /^  shell: false$/m)

  const explore = compileOverrideEntry({ id: "explore", def: { model: "p/m", thoughtLevel: "low", shape: "readonly" }, recipeFile: GLOBAL_FILE })
  assert.equal(explore.fileName, "explore.md")
  for (const t of ["write", "edit", "bash", "patch", "applypatch", "apply", "multiedit", "execute", "task"]) {
    assert.match(explore.content, new RegExp(`^  ${t}: false$`, "m"), `readonly override seals ${t}`)
  }
  // no prompt given → the minimal default body (never vendor text)
  assert.ok(explore.content.includes("user-overridden built-in Explore"))
})

test("compileOverrideEntry: capitalized ids are NEVER emitted (case-lock, probe negative form)", () => {
  for (const id of ["General", "Explore", "GENERAL", "coder", "build", ""]) {
    assert.equal(compileOverrideEntry({ id, def: { model: "p/m", thoughtLevel: "low" }, recipeFile: GLOBAL_FILE }), null, `id ${JSON.stringify(id)} never compiles`)
  }
})

test("compileOverrideEntry: Auto override (no pair) emits no model key", () => {
  const out = compileOverrideEntry({ id: "general", def: { prompt: "x" }, recipeFile: GLOBAL_FILE })
  assert.ok(!/^model:/m.test(out.content))
})

// ---------------------------------------------------------------------------
// D5 — globalAgentDirFor mirrors the host's resolution (both branches)
// ---------------------------------------------------------------------------

test("globalAgentDirFor: OPENCODE_CONFIG_DIR set → $CONFIG_DIR/agent; unset → <home>/.config/opencode/agent", () => {
  assert.equal(globalAgentDirFor({ homeDir: HOME, configDir: "C:/sb/config" }), "C:/sb/config/agent")
  assert.equal(globalAgentDirFor({ homeDir: HOME, configDir: "C:\\sb\\config" }), "C:\\sb\\config\\agent")
  assert.equal(globalAgentDirFor({ homeDir: HOME, configDir: "C:/sb/config/" }), "C:/sb/config/agent")
  assert.equal(globalAgentDirFor({ homeDir: HOME, configDir: undefined }), `${HOME}/.config/opencode/agent`)
  assert.equal(globalAgentDirFor({ homeDir: HOME, configDir: null }), `${HOME}/.config/opencode/agent`)
  assert.equal(globalAgentDirFor({ homeDir: HOME, configDir: "   " }), `${HOME}/.config/opencode/agent`, "a blank CONFIG_DIR counts as unset")
  assert.equal(globalAgentDirFor({ homeDir: "C:\\Users\\s", configDir: undefined }), "C:\\Users\\s\\.config\\opencode\\agent")
})

// ---------------------------------------------------------------------------
// planOverrideSync + executeRosterSync: emission, collision redline, GC
// ---------------------------------------------------------------------------

const OV = { general: { model: "p/m", thoughtLevel: "low", prompt: "mine" }, explore: { model: "p/m", thoughtLevel: "low", shape: "readonly", prompt: "scout" } }

test("planOverrideSync: no overrides → null (unconfigured = zero emission); valid → files in builtin order", () => {
  assert.equal(planOverrideSync({}, { dir: GLOBAL_AGENT_DIR, recipeFile: GLOBAL_FILE }), null)
  const plan = planOverrideSync(OV, { dir: GLOBAL_AGENT_DIR, recipeFile: GLOBAL_FILE })
  assert.equal(plan.kind, "override")
  assert.deepEqual(plan.files.map((f) => f.fileName), BUILTIN_OVERRIDE_IDS.map((id) => `${id}.md`))
})

test("executeRosterSync (override): emits lowercase files; re-plan without the entry GCs them marker-keyed", () => {
  const fs = fakeFs()
  const plan = planOverrideSync(OV, { dir: GLOBAL_AGENT_DIR, recipeFile: GLOBAL_FILE })
  const out1 = executeRosterSync([plan], fs)
  assert.deepEqual(out1.created.sort(), [`${GLOBAL_AGENT_DIR}/explore.md`, `${GLOBAL_AGENT_DIR}/general.md`])
  assert.equal(fs.text(`${GLOBAL_AGENT_DIR}/general.md`), plan.files[0].content)

  // entry re-commented/removed → the file is GC'd (marker-keyed, no prefix)
  const plan2 = planOverrideSync({ explore: OV.explore }, { dir: GLOBAL_AGENT_DIR, recipeFile: GLOBAL_FILE })
  const out2 = executeRosterSync([plan2], fs)
  assert.deepEqual(out2.gced, [`${GLOBAL_AGENT_DIR}/general.md`], "commenting the entry out GCs its file")
  assert.ok(fs.text(`${GLOBAL_AGENT_DIR}/explore.md`) !== null, "the surviving entry's file stays")
})

test("executeRosterSync (override): FULL deactivation — the empty plan (runRosterSync's always-ride pass) GCs every marker-keyed file", () => {
  const fs = fakeFs()
  const plan = planOverrideSync(OV, { dir: GLOBAL_AGENT_DIR, recipeFile: GLOBAL_FILE })
  executeRosterSync([plan], fs)
  const handWritten = "---\ndescription: HAND WRITTEN\n---\nmine\n"
  // E2E scenario-6 wiring semantic: planOverrideSync → null becomes the
  // EMPTY plan — the deactivation pass. Marker files go, hand-written stays.
  // (writeFile overwrites: general.md becomes a hand-written, marker-less file)
  fs.writeFile(`${GLOBAL_AGENT_DIR}/general.md`, handWritten)
  const out = executeRosterSync([{ kind: "override", dir: GLOBAL_AGENT_DIR, files: [] }], fs)
  assert.deepEqual(out.gced, [`${GLOBAL_AGENT_DIR}/explore.md`], "the generated explore.md is GC'd")
  assert.equal(fs.text(`${GLOBAL_AGENT_DIR}/general.md`), handWritten, "the hand-written file is never touched")
  assert.equal(out.created.length, 0, "zero emission — the pass writes nothing")
})

test("executeRosterSync (override): collision redline — a hand-written same-name file is refused, disclosed, byte-identical; siblings still apply", () => {
  const fs = fakeFs()
  const handWritten = "---\ndescription: HAND WRITTEN\nmode: subagent\n---\nuser's own general\n"
  fs.writeFile(`${GLOBAL_AGENT_DIR}/general.md`, handWritten)
  const plan = planOverrideSync(OV, { dir: GLOBAL_AGENT_DIR, recipeFile: GLOBAL_FILE })
  const out = executeRosterSync([plan], fs)
  assert.equal(fs.text(`${GLOBAL_AGENT_DIR}/general.md`), handWritten, "hand-written file untouched, byte-identical")
  assert.ok(out.errors.length === 1 && out.errors[0].includes(`${GLOBAL_AGENT_DIR}/general.md`) && out.errors[0].includes("collision refused"), "the error names the collision")
  assert.ok(out.created.includes(`${GLOBAL_AGENT_DIR}/explore.md`), "the sibling override still applies (fail-soft)")
})

test("executeRosterSync (override): a hand-written same-name file is NEVER GC'd; forge-* artifacts in the same dir are invisible to the override plan", () => {
  const fs = fakeFs()
  const handWritten = "---\ndescription: HAND WRITTEN\n---\nmine\n"
  fs.writeFile(`${GLOBAL_AGENT_DIR}/general.md`, handWritten)
  // an orphaned forge-global artifact (marker present) + a generated
  // explore.md that the recipe just dropped
  fs.writeFile(`${GLOBAL_AGENT_DIR}/forge-global-old.md`, `x\n${GENERATED_MARKER}\n`)
  fs.writeFile(`${GLOBAL_AGENT_DIR}/explore.md`, `${GENERATED_MARKER}\nold`)
  const plan = planOverrideSync({ general: OV.general }, { dir: GLOBAL_AGENT_DIR, recipeFile: GLOBAL_FILE })
  const out = executeRosterSync([plan], fs)
  assert.equal(fs.text(`${GLOBAL_AGENT_DIR}/general.md`), handWritten, "hand-written never GC'd despite the wanted set not containing it... (it IS wanted here — the GC line targets orphans)")
  assert.equal(fs.text(`${GLOBAL_AGENT_DIR}/forge-global-old.md`), `x\n${GENERATED_MARKER}\n`, "forge-* artifacts are invisible to the override plan's GC (the fallback family plan owns them)")
  assert.deepEqual(out.gced, [`${GLOBAL_AGENT_DIR}/explore.md`], "the dropped override entry is GC'd marker-keyed")
})

test("executeRosterSync (override): a marker-carrying general.md updates normally (not a collision)", () => {
  const fs = fakeFs()
  const plan1 = planOverrideSync(OV, { dir: GLOBAL_AGENT_DIR, recipeFile: GLOBAL_FILE })
  executeRosterSync([plan1], fs)
  const plan2 = planOverrideSync({ ...OV, general: { ...OV.general, prompt: "revised" } }, { dir: GLOBAL_AGENT_DIR, recipeFile: GLOBAL_FILE })
  const out = executeRosterSync([plan2], fs)
  assert.deepEqual(out.updated, [`${GLOBAL_AGENT_DIR}/general.md`])
  assert.ok(fs.text(`${GLOBAL_AGENT_DIR}/general.md`).includes("revised"))
  assert.deepEqual(out.errors, [])
})

// ---------------------------------------------------------------------------
// Schema mirror (forge.schema.json) — the override node's id enum equals
// the code's builtin id set (the same lock style as forge-schema-mirror)
// ---------------------------------------------------------------------------

test("schema mirror: the override propertyNames enum equals BUILTIN_OVERRIDE_IDS", async () => {
  const { readFileSync } = await import("node:fs")
  const { fileURLToPath } = await import("node:url")
  const { dirname, join } = await import("node:path")
  const schema = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "schema", "forge.schema.json"), "utf8"))
  assert.deepEqual(schema.properties.override.propertyNames.enum, [...BUILTIN_OVERRIDE_IDS])
  assert.match(schema.properties.override.description, /GLOBAL layer file ONLY/)
  assert.match(schema.properties.override.description, /wholesale/)
})
