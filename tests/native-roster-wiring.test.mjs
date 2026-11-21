import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, utimesSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// native-first-roster task 5.1 — wiring suite (design D4/D5): the v2
// materialize knob matrix (native default, runtime escape hatch), the
// forge_sync tool round-trip (write → gate clears), the crew staleness
// gate with its one-step in-band recovery, the plain-dispatch sync hint,
// and the sync:"auto" session-start regeneration. The V1 path is
// untouched by the change (runtime-pinned, byte-equal) — its net is the
// pre-existing 788-test baseline.

import { v2Setup, v2WiringSeam } from "../plugin.ts"
import { createV2MockContext } from "./lib/v2-mock-context.mjs"
import { parseTopLevelKnobs } from "../src/forge-config.ts"

process.env.FORGE_TEST_NO_DISPATCH_FETCH = "1"

const home = mkdtempSync(join(tmpdir(), "forge-native-home-"))
process.env.FORGE_TEST_FORGE_HOME = home
process.on("exit", () => {
  try {
    rmSync(home, { recursive: true, force: true })
  } catch {}
})

function ws(name, top) {
  const dir = mkdtempSync(join(tmpdir(), `forge-native-${name}-`))
  mkdirSync(join(dir, ".opencode"), { recursive: true })
  writeFileSync(join(dir, ".opencode", "forge.json"), JSON.stringify(top))
  process.on("exit", () => {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {}
  })
  return dir
}

const RECIPE = (pool, agents = { research: { model: "zai/glm", thoughtLevel: "low" } }) => ({ pool, agents })

async function boot(dir, deps = {}) {
  v2WiringSeam.resetHostAnchors()
  const mock = createV2MockContext()
  await v2Setup(mock.ctx, { anchors: [dir], ...deps })
  return mock
}

const ctxExec = (dir, sessionID) => ({ sessionID, worktree: dir, directory: dir, metadata: () => {} })

// ---------------------------------------------------------------------------
// Knob matrix (D5)
// ---------------------------------------------------------------------------

test("knobs: parseTopLevelKnobs is fail-soft (bad values warn + count absent)", () => {
  const ok = parseTopLevelKnobs({ materialize: "runtime", sync: "auto" }, "test")
  assert.equal(ok.materialize, "runtime")
  assert.equal(ok.syncAuto, true)
  assert.deepEqual(ok.findings, [])
  const bad = parseTopLevelKnobs({ materialize: "sometimes", sync: "fast" }, "test")
  assert.equal(bad.materialize, undefined, "bad materialize → default applies")
  assert.equal(bad.syncAuto, false, "bad sync → default posture applies")
  assert.equal(bad.findings.length, 2)
  assert.equal(bad.findings[0].code, "materialize-invalid")
  assert.equal(bad.findings[1].code, "sync-invalid")
  assert.deepEqual(parseTopLevelKnobs(undefined, "test").findings, [])
})

test("knob matrix: v2 DEFAULTS to native — no forge-* worker draft materialization, forge_sync registered", async () => {
  const dir = ws("default", RECIPE("nf"))
  const { state } = await boot(dir)
  assert.ok(state.agents.has("forge"), "the primary agent still registers")
  assert.equal([...state.agents.keys()].some((id) => id.startsWith("forge-")), false, "native mode materializes NO worker drafts — identity comes from compiled .opencode/agent files")
  assert.ok(state.tools.has("forge_sync"), "the sync tool registers on the v2 tool domain")
})

test("knob matrix: runtime escape hatch keeps the draft materialization path", async () => {
  const dir = ws("runtime", RECIPE("rt"))
  const { state } = await boot(dir, { materialize: "runtime" })
  assert.ok(state.agents.has("forge-rt-research"), "runtime mode materializes the worker draft exactly as before")
})

// ---------------------------------------------------------------------------
// Staleness gate + sync round-trip (D4)
// ---------------------------------------------------------------------------

test("gate round-trip: crew_begin refuses stale, forge_sync regenerates, retry passes", async () => {
  const dir = ws("gate", RECIPE("gate"))
  const { state } = await boot(dir)
  const crewArgs = { objective: "gate round trip", subtasks: [{ title: "scout it", agent: "forge-gate-research" }] }
  // 1. Stale (recipe present, no artifacts): refuse with the one-step fix.
  await assert.rejects(
    state.tools.get("crew_begin").execute(crewArgs, ctxExec(dir, "ses_gate")),
    (err) => {
      assert.match(String(err), /Roster stale refused/)
      assert.match(String(err), /forge_sync/)
      return true
    },
  )
  assert.equal(v2WiringSeam.crews.has("ses_gate"), false, "no crew was registered behind the gate")
  // 2. In-band recovery: the sync tool compiles + writes atomically.
  const res = await state.tools.get("forge_sync").execute({}, ctxExec(dir, "ses_gate"))
  const artifact = join(dir, ".opencode", "agent", "forge-gate-research.md")
  assert.match(String(res.content ?? res.output), /created:/)
  assert.ok(existsSync(artifact), "the native file landed")
  const text = readFileSync(artifact, "utf8")
  assert.match(text, /^---\n/)
  assert.match(text, /mode: subagent/)
  assert.match(text, /model: "zai\/glm#low"/)
  assert.match(text, /GENERATED BY \/forge sync/)
  // 3. The gate lifts: registration now succeeds and pends.
  const reg = await state.tools.get("crew_begin").execute(crewArgs, ctxExec(dir, "ses_gate"))
  assert.match(String(reg.content ?? reg.output), /PENDING|registered/i)
  assert.ok(v2WiringSeam.crews.has("ses_gate"))
})

test("gate: recipe edit flips staleness back on, sync clears it again; a pure touch does not", async () => {
  const dir = ws("restale", RECIPE("rs"))
  const { state } = await boot(dir)
  await state.tools.get("forge_sync").execute({}, ctxExec(dir, "ses_rs"))
  const recipePath = join(dir, ".opencode", "forge.json")
  // A pure touch (mtime moves, content identical) is NOT stale — the
  // verdict is content-based, so a sync round-trip can always clear it.
  const future = new Date(Date.now() + 60_000)
  utimesSync(recipePath, future, future)
  await assert.doesNotReject(state.tools.get("crew_begin").execute({ objective: "touch check", subtasks: [{ title: "t0" }] }, ctxExec(dir, "ses_rs0")))
  // A real edit (new agent) flips staleness on...
  writeFileSync(recipePath, JSON.stringify({ pool: "rs", agents: { research: {}, second: {} } }))
  await assert.rejects(
    state.tools.get("crew_begin").execute({ objective: "recheck", subtasks: [{ title: "t" }] }, ctxExec(dir, "ses_rs")),
    (err) => {
      assert.match(String(err), /Roster stale refused/)
      assert.match(String(err), /missing artifact/)
      return true
    },
  )
  // ...and one in-band sync clears it.
  await state.tools.get("forge_sync").execute({}, ctxExec(dir, "ses_rs"))
  await assert.doesNotReject(state.tools.get("crew_begin").execute({ objective: "recheck", subtasks: [{ title: "t" }] }, ctxExec(dir, "ses_rs")))
})

test("gate: GC — an entry removed from the recipe has its file collected on the next sync", async () => {
  const dir = ws("gc", RECIPE("gc", { research: {}, gone: {} }))
  const { state } = await boot(dir)
  await state.tools.get("forge_sync").execute({}, ctxExec(dir, "ses_gc"))
  const artifact = join(dir, ".opencode", "agent", "forge-gc-gone.md")
  assert.ok(existsSync(artifact))
  writeFileSync(join(dir, ".opencode", "forge.json"), JSON.stringify({ pool: "gc", agents: { research: {} } }))
  const res = await state.tools.get("forge_sync").execute({}, ctxExec(dir, "ses_gc"))
  assert.match(String(res.content ?? res.output), /gc'd/)
  assert.equal(existsSync(artifact), false, "the orphaned generated file is collected")
})

test("dispatch hint: an unknown forge target on a stale native roster surfaces the sync guidance", async () => {
  const dir = ws("hint", RECIPE("hint"))
  const { state } = await boot(dir)
  await assert.rejects(
    state.tools.get("task").execute({ subagent_type: "forge-hint-ghost", prompt: "x" }, ctxExec(dir, "ses_hint")),
    (err) => {
      assert.match(String(err), /not a materialized forge subagent/)
      assert.match(String(err), /Native-roster hint:/)
      assert.match(String(err), /forge_sync/)
      return true
    },
  )
})

// ---------------------------------------------------------------------------
// sync:"auto" (D4) — opt-in silent regeneration with a disclosed finding
// ---------------------------------------------------------------------------

test("sync auto: a stale pool declaring sync:'auto' regenerates at session start; without the knob nothing is written uninvited", async () => {
  const autoDir = ws("auto", { ...RECIPE("auto"), sync: "auto" })
  const quietDir = ws("quiet", RECIPE("quiet"))
  await boot(autoDir)
  assert.ok(existsSync(join(autoDir, ".opencode", "agent", "forge-auto-research.md")), "auto pool regenerated its stale roster at setup")
  await boot(quietDir)
  assert.equal(existsSync(join(quietDir, ".opencode", "agent")), false, "default posture: the plugin writes NOTHING uninvited")
})
