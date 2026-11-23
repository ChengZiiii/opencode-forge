import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Task 2.1 — the v2 tool surface: ALL tools (forge_shell, forge_jobs,
// 5 plan_*, 6 goal_*, 2 crew_*, task, forge_grep, forge_glob) register via
// ctx.tool.transform against the mock harness, each with a JSON Schema
// input contract translated from the tool.schema.* chains by the shared
// builder, reusing the exact v1 execute cores (one code path). Results
// wrap in { content } (SANDBOX-PENDING shape). Drifted tool domain = no
// registration, no throw. Partition/family hiding is W4 — out of scope.

import { createV2MockContext } from "./lib/v2-mock-context.mjs"

// Execute-core hygiene (same as every wiring suite): the forge_jobs core
// lazily starts the job lifecycle — without the no-fence knob its stdin
// watcher holds the test process's event loop open. Must precede the
// plugin import (goal debounce knob same discipline).
process.env.FORGE_TEST_NO_FENCE = "1"
process.env.FORGE_GOAL_DEBOUNCE_MS = "10"

import { v2Setup } from "../plugin.ts"

// The full W2 registration surface (20 tools — forge_sync joined with
// native-first-roster; plan_reopen joined with plan-close-verified D5).
const EXPECTED_TOOLS = [
  "forge_shell",
  "forge_jobs",
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
  "task",
  "forge_grep",
  "forge_glob",
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

test("v2 tools: ALL 20 tools register with descriptions and object input schemas", async () => {
  const state = await setupTools()
  assert.deepEqual([...state.tools.keys()].sort(), [...EXPECTED_TOOLS].sort())
  for (const name of EXPECTED_TOOLS) {
    const def = state.tools.get(name)
    assert.equal(typeof def.description, "string", `${name} carries a description`)
    assert.ok(def.description.length > 10, `${name} description is the v1 text`)
    assert.equal(def.input.type, "object", `${name} input is a JSON Schema object`)
    assert.ok(def.input.properties && typeof def.input.properties === "object", `${name} declares properties`)
    assert.equal(typeof def.execute, "function", `${name} wires an execute`)
  }
})

test("v2 tools: schema translation — required vs optional, ints, arrays, describes (plan_write / forge_shell / plan_tick)", async () => {
  const state = await setupTools()
  const pw = state.tools.get("plan_write").input
  // plan_write: goal/context/approach/tasks/risks/acceptance required; nonGoals optional
  for (const req of ["goal", "context", "approach", "tasks", "risks", "acceptance"]) assert.ok(pw.required.includes(req), `plan_write.${req} required`)
  assert.equal(pw.required.includes("nonGoals"), false, "optional args stay out of required")
  assert.equal(pw.properties.goal.type, "string")
  assert.equal(pw.properties.tasks.type, "array")
  assert.equal(pw.properties.tasks.items.type, "string")
  assert.ok(pw.properties.goal.description?.length > 0, ".describe() text rides the schema")
  const fs2 = state.tools.get("forge_shell").input
  assert.ok(fs2.required.includes("command"))
  for (const opt of ["workdir", "run_in_background", "idle_ms", "max_wait_ms", "success_pattern", "keep_alive", "notify", "survive"]) {
    assert.equal(fs2.required.includes(opt), false, `forge_shell.${opt} optional`)
  }
  assert.equal(fs2.properties.run_in_background.type, "boolean")
  assert.equal(fs2.properties.idle_ms.type, "integer", ".int() translates to integer")
  const pt = state.tools.get("plan_tick").input
  assert.equal(pt.properties.n.type, "integer", "int().positive() -> integer with exclusiveMinimum")
  assert.ok(pt.properties.n.exclusiveMinimum !== undefined)
  assert.deepEqual(pt.required, ["n"])
  const gj = state.tools.get("forge_jobs").input
  assert.deepEqual(gj.required, ["action"])
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
  // forge_jobs list: harmless, registry empty on a fresh process.
  const jobs = await state.tools.get("forge_jobs").execute({ action: "list" }, {})
  assert.ok(typeof jobs.content === "string", "result wrapped as { content }")
  assert.match(jobs.content, /\(no jobs\)/)
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
      { sessionID: "s-v2", worktree: dir },
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
    await assert.rejects(state.tools.get("plan_tick").execute({ n: 1 }, { sessionID: "s-v2-tick", worktree: tickDir }))
  } finally {
    rmSync(tickDir, { recursive: true, force: true })
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

test("v2 task dispatch (fix-v2-crew-surface-drift D2): the 2.3.2 promise-layer create seam adapts — FLAT create input, bare record resolved, anchored parent directory", async (t) => {
  process.env.FORGE_DISPATCH_POLL_INTERVAL_MS = "5"
  process.env.FORGE_DISPATCH_POLL_SLICE_MS = "10"
  // Hermetic tracker teardown (service-discovery-hermetic): on a v2 client the
  // background tracker is an infinite slice loop — no status reader, and the
  // HTTP messages reader reports capability-pending when no service is
  // discovered. It used to end only because the user's REAL host answered 404
  // to the leaked reads (view-loss). It now ends through the public lever
  // (`forge_jobs stop` from the owner session); the reconcile floor is dropped
  // so the tracker observes the kill at its next (10 ms) slice, not 10 s later.
  process.env.FORGE_DISPATCH_RECONCILE_FLOOR_MS = "0"
  const state = await setupTools()
  const dir = mkdtempSync(join(tmpdir(), "forge-v2-task-seam-"))
  t.after(async () => {
    await state.tools.get("forge_jobs").execute({ action: "stop" }, { sessionID: "s-v2-task", worktree: dir, directory: dir, metadata: () => {}, message: async () => {} })
    rmSync(dir, { recursive: true, force: true })
    delete process.env.FORGE_DISPATCH_POLL_INTERVAL_MS
    delete process.env.FORGE_DISPATCH_POLL_SLICE_MS
    delete process.env.FORGE_DISPATCH_RECONCILE_FLOOR_MS
  })
  // The authoritative record for the calling session anchors the child
  // (design D2 2.3): a record pointing at the tool-context workspace makes
  // the flat create's directory resolve from the authoritative chain.
  state.sessionRecords.set("s-v2-task", { sessionID: "s-v2-task", directory: dir, worktree: dir })
  const res = await state.tools.get("task").execute(
    { subagent_type: "general", prompt: "probe dispatch", description: "seam probe", run_in_background: true },
    { sessionID: "s-v2-task", worktree: dir, directory: dir, metadata: () => {}, message: async () => {} },
  )  // The moved-seam adaptation (D2): the dispatch engine's v1 {body,query}
  // call is translated to the FLAT single-object param the 2.3.2
  // promise-layer create accepts, and the BARE record response resolves.
  assert.ok(state.creates.length >= 1, "the flat create seam was called")
  const flat = state.creates[0]
  assert.equal(flat.parentID, "s-v2-task", "flat param: parentID rides the root object")
  assert.ok(typeof flat.title === "string" && flat.title.includes("(@general subagent)"), "flat param: the native child title format")
  assert.ok(!("body" in flat) && !("query" in flat), "the v1 {body,query} envelope is NOT handed to the 2.3.2 create seam")
  assert.equal(flat.directory, dir, "the parent directory anchors the child (authoritative-first chain, tool-context fallback here)")
  assert.ok(/task id|dispatched/i.test(String(res.content ?? res)), "an async handle returns")
})
