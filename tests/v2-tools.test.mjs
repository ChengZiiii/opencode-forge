import test from "node:test"
import assert from "node:assert/strict"
import fs, { mkdtempSync, rmSync, existsSync, readdirSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { syncBuiltinESMExports } from "node:module"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

// V2 tool surface after shell/jobs/task retirement (tasks 4.2, 5.1): retained tools (
// 6 plan_*, 6 goal_*, 2 crew_*, forge_sync) register via
// ctx.tool.transform against the mock harness, each with a JSON Schema
// input contract translated from the tool.schema.* chains by the shared
// builder, reusing the exact v1 execute cores (one code path). Results
// wrap in { content } (SANDBOX-PENDING shape). Drifted tool domain = no
// registration, no throw. Partition/family hiding is W4 — out of scope.

import { createV2MockContext } from "./lib/v2-mock-context.mjs"

// Execute-core hygiene (same as every wiring suite): the dispatch core
// lazily starts the job lifecycle — without the no-fence knob its stdin
// watcher holds the test process's event loop open. Must precede the
// plugin import (goal debounce knob same discipline).
process.env.FORGE_TEST_NO_FENCE = "1"
process.env.FORGE_GOAL_DEBOUNCE_MS = "10"

import { v2Setup } from "../plugin.ts"
import { NATIVE_TOOL_VOCAB } from "../src/roster-compile.ts"
import { renderPlan, tickTask, transitionStatus } from "../src/plan-file.ts"

// Source mirror: retire-plugin-runtime design D6 records these host v2.4.0
// names. setupTools observes plugin registrations only, not the host registry.
test("native tool vocabulary mirrors recorded v2.4.0 names (registry probe pending)", () => {
  assert.deepEqual([
    NATIVE_TOOL_VOCAB.shell,
    NATIVE_TOOL_VOCAB.dispatchTool,
    NATIVE_TOOL_VOCAB.question,
    NATIVE_TOOL_VOCAB.grep,
    NATIVE_TOOL_VOCAB.glob,
  ], ["shell", "subagent", "question", "grep", "glob"])
})

// The full W2 registration surface (15 tools — forge_sync joined with
// native-first-roster; plan_reopen joined with plan-close-verified D5).
const EXPECTED_TOOLS = [
  "plan_write",
  "plan_tick",
  "plan_approve",
  "plan_close",
  "plan_discard",
  "plan_reopen",
  "goal_write",
  "goal_check",
  "goal_complete",
  "goal_pause",
  "goal_resume",
  "goal_discard",
  "crew_begin",
  "crew_close",
  "forge_sync",
]

async function setupTools() {
  const { ctx, state } = createV2MockContext()
  const prevHome = process.env.FORGE_TEST_FORGE_HOME
  process.env.FORGE_TEST_FORGE_HOME = join(tmpdir(), "forge-v2-tools-home")
  try {
    await v2Setup(ctx, { anchors: [join(tmpdir(), "forge-v2-tools-empty-ws")] })
  } finally {
    if (prevHome === undefined) delete process.env.FORGE_TEST_FORGE_HOME
    else process.env.FORGE_TEST_FORGE_HOME = prevHome
  }
  return state
}

test("v2 tools: ALL 15 tools register with descriptions and object input schemas", async () => {
  const state = await setupTools()
  assert.deepEqual([...state.tools.keys()].sort(), [...EXPECTED_TOOLS].sort())
  assert.equal(state.tools.has("forge_shell"), false, "retired shell tool is absent")
  assert.equal(state.tools.has("forge_jobs"), false, "retired jobs tool is absent")
  assert.equal(state.tools.has("forge_grep"), false, "retired search alias is absent")
  assert.equal(state.tools.has("forge_glob"), false, "retired search alias is absent")
  for (const name of EXPECTED_TOOLS) {
    const def = state.tools.get(name)
    assert.equal(typeof def.description, "string", `${name} carries a description`)
    assert.ok(def.description.length > 10, `${name} description is the v1 text`)
    assert.equal(def.input.type, "object", `${name} input is a JSON Schema object`)
    assert.ok(def.input.properties && typeof def.input.properties === "object", `${name} declares properties`)
    assert.equal(typeof def.execute, "function", `${name} wires an execute`)
  }
})

test("v2 tools: schema translation — required vs optional, ints, arrays, describes (plan_write / plan_tick)", async () => {
  const state = await setupTools()
  const pw = state.tools.get("plan_write").input
  // plan_write: goal/context/approach/tasks/risks/acceptance required; nonGoals optional
  for (const req of ["goal", "context", "approach", "tasks", "risks", "acceptance"]) assert.ok(pw.required.includes(req), `plan_write.${req} required`)
  assert.equal(pw.required.includes("nonGoals"), false, "optional args stay out of required")
  assert.equal(pw.properties.goal.type, "string")
  assert.equal(pw.properties.tasks.type, "array")
  assert.equal(pw.properties.tasks.items.type, "string")
  assert.ok(pw.properties.goal.description?.length > 0, ".describe() text rides the schema")
  const pt = state.tools.get("plan_tick").input
  assert.equal(pt.properties.n.type, "integer", "int().positive() -> integer with exclusiveMinimum")
  assert.ok(pt.properties.n.exclusiveMinimum !== undefined)
  assert.deepEqual(pt.required, ["n"])
})

test("v2 tools: crew_begin schema — subtasks is OPTIONAL (the arm-only {execution} call passes parameter validation)", async () => {
  // fix-v2-crew-surface-drift 4.1 bug 1, live-proved on 2.3.2 (E2E A-2): the
  // arm-only call crew_begin {execution:"waves"} was refused by the HOST
  // schema validator ("subtasks: Missing key") because subtasks lacked
  // .optional() — contradicting the tool's own description ("called with
  // {execution} ONLY (no objective/subtasks) it ARMS the pending crew").
  // The v2 input translation is the exact schema the host validates against.
  const state = await setupTools()
  const cb = state.tools.get("crew_begin").input
  const req = Array.isArray(cb.required) ? cb.required : []
  assert.equal(cb.properties.subtasks.type, "array", "subtasks stays an array arg")
  assert.equal(req.includes("subtasks"), false, "subtasks is OPTIONAL — the arm call omits it")
  for (const opt of ["objective", "execution", "lineage"]) {
    assert.equal(req.includes(opt), false, `crew_begin.${opt} optional`)
  }
  assert.equal(req.length, 0, "no crew_begin argument is required (registration enforces objective+subtasks in execute, not the schema)")
})

test("v2 tools: execute reuses the shared cores — results wrap in { content } (SANDBOX-PENDING shape)", async () => {
  const state = await setupTools()
  // plan_write through the adapter: a real plan file lands in the worktree.
  const dir = mkdtempSync(join(tmpdir(), "forge-v2-tool-plan-"))
  try {
    const res = await state.tools.get("plan_write").execute(
      {
        goal: "v2 tool wiring check",
        context: "found the v2 tool domain",
        approach: "register via ctx.tool.transform",
        tasks: ["wire", "verify"],
        risks: "shape drift",
        acceptance: ["tools register"],
      },
      { sessionID: "s-v2", agent: "forge", worktree: dir },
    )
    assert.ok(typeof res.content === "string")
    assert.match(res.content, /Plan created/)
    const planDir = join(dir, ".opencode", "plan")
    assert.ok(existsSync(planDir) && readdirSync(planDir).length === 1, "the shared core wrote the plan file")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  // plan_tick without an approved plan: the core's error propagates.
  const tickDir = mkdtempSync(join(tmpdir(), "forge-v2-tool-x-"))
  try {
    await assert.rejects(state.tools.get("plan_tick").execute({ n: 1 }, { sessionID: "s-v2-tick", agent: "forge", worktree: tickDir }))
  } finally {
    rmSync(tickDir, { recursive: true, force: true })
  }
})

test("v2 tools: plan_tick preserves approved plan bytes on rename failure", async (t) => {
  const state = await setupTools()
  const dir = mkdtempSync(join(tmpdir(), "forge-v2-tick-atomic-"))
  try {
    const planDir = join(dir, ".opencode", "plan")
    const file = join(planDir, "2026-11-26-tick.md")
    mkdirSync(planDir, { recursive: true })
    const now = "2026-11-26T12:00:00Z"
    const draft = renderPlan({
      goal: "Atomic tick fixture", context: "Existing plan", approach: "Fixture only",
      tasks: ["first", "second"], risks: "rename failure", acceptance: ["bytes preserved"],
    }, now)
    const original = Buffer.from(tickTask(transitionStatus(draft, "approved", now), 1, now))
    writeFileSync(file, original)
    const metadata = t.mock.fn()
    const context = { sessionID: "s-v2-tick-atomic", agent: "forge", worktree: dir, metadata }
    const execute = state.tools.get("plan_tick").execute
    const failure = new Error("forced plan tick rename failure")
    const realRename = fs.renameSync
    const rename = t.mock.method(fs, "renameSync", (temp, target) => {
      if (resolve(target) !== resolve(file)) return realRename(temp, target)
      assert.notEqual(resolve(temp), resolve(file))
      assert.match(readFileSync(temp, "utf8"), /- \[x\] 2\. second/)
      throw failure
    })
    syncBuiltinESMExports()
    try {
      await assert.rejects(execute({ n: 2 }, context), (err) => err === failure)
      assert.equal(rename.mock.callCount(), 1)
      assert.deepEqual(readFileSync(file), original)
      assert.deepEqual(readdirSync(planDir), ["2026-11-26-tick.md"])
      assert.equal(metadata.mock.callCount(), 0)
      await assert.rejects(execute({ n: 7 }, context), /Task number 7 does not exist/)
      assert.deepEqual(readFileSync(file), original)
      await assert.rejects(execute({ n: 1 }, context), /already ticked/)
      assert.deepEqual(readFileSync(file), original)
      assert.equal(rename.mock.callCount(), 1)
      assert.equal(metadata.mock.callCount(), 0)
    } finally {
      rename.mock.restore()
      syncBuiltinESMExports()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("v2 tools: plan revision, approval and discard preserve the draft on rename failure", async (t) => {
  const state = await setupTools()
  const dir = mkdtempSync(join(tmpdir(), "forge-v2-plan-atomic-"))
  try {
    const args = { goal: "Atomic plan fixture", context: "test", approach: "test", tasks: ["first"], risks: "none", acceptance: ["preserved"] }
    const metadata = t.mock.fn()
    const context = { sessionID: "s-v2-plan-atomic", agent: "forge", worktree: dir, metadata }
    const call = (name, input) => state.tools.get(name).execute(input, context)
    await call("plan_write", args)
    const planDir = join(dir, ".opencode", "plan")
    const [name] = readdirSync(planDir)
    const file = join(planDir, name)
    const original = readFileSync(file)
    metadata.mock.resetCalls()
    const failure = new Error("forced plan rename failure")
    const realRename = fs.renameSync
    const rename = t.mock.method(fs, "renameSync", (temp, target) => {
      if (resolve(target) !== resolve(file)) return realRename(temp, target)
      assert.notEqual(resolve(temp), resolve(file))
      throw failure
    })
    syncBuiltinESMExports()
    try {
      for (const [tool, input] of [["plan_write", { ...args, tasks: ["revised"] }], ["plan_approve", {}], ["plan_discard", { reason: "cancel" }], ["plan_discard", { supersede: "successor.md" }]]) {
        await assert.rejects(call(tool, input), (err) => err === failure, tool)
        assert.deepEqual(readFileSync(file), original, tool)
        assert.deepEqual(readdirSync(planDir), [name], tool)
        assert.equal(metadata.mock.callCount(), 0, tool)
      }
      assert.equal(rename.mock.callCount(), 4)
      assert.equal(state.asserts.length, 1, "approval still requests confirmation")
    } finally {
      rename.mock.restore()
      syncBuiltinESMExports()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("v2 tools: drifted tool domain — every mode is a silent no-op", async () => {
  for (const mode of ["missing", "not-function", "bad-shape"]) {
    const { ctx, state } = createV2MockContext({ drift: { tool: mode } })
    const prevHome = process.env.FORGE_TEST_FORGE_HOME
    process.env.FORGE_TEST_FORGE_HOME = join(tmpdir(), "forge-v2-tools-home")
    try {
      await assert.doesNotReject(v2Setup(ctx, { anchors: [join(tmpdir(), "forge-v2-tools-empty-ws")] }), `tool/${mode}`)
    } finally {
      if (prevHome === undefined) delete process.env.FORGE_TEST_FORGE_HOME
      else process.env.FORGE_TEST_FORGE_HOME = prevHome
    }
    assert.equal(state.tools.size, 0, `${mode}: nothing registered`)
  }
})

test("v2 tools: agent materialization and tool registration are independent slices", async () => {
  // tool wired + agent drifted: tools still land; and vice versa.
  const t1 = createV2MockContext({ drift: { agent: "bad-shape" } })
  await v2Setup(t1.ctx, { anchors: [join(tmpdir(), "no-such-ws-v2")] })
  assert.ok(t1.state.tools.size === EXPECTED_TOOLS.length, "tools register regardless of the agent domain")
  const t2 = createV2MockContext({ drift: { tool: "missing" } })
  await v2Setup(t2.ctx, { anchors: [join(tmpdir(), "no-such-ws-v2")] })
  assert.ok(t2.state.agents.has("forge"), "the agent registers regardless of the tool domain")
})

test("v2 tools: no plugin-provided child-session creation tool registers", async () => {
  const state = await setupTools()
  for (const name of ["task", "subagent", "forge_dispatch", "forge_dispatch_config", "forge_dispatch_list", "forge_dispatch_kill"]) {
    assert.equal(state.tools.has(name), false, name + " is not a plugin registration")
  }
  assert.equal(state.creates.length, 0, "setup does not create children in an empty workspace")
})
