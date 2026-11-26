import test from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Task 4.1 (W6a field realities) - ctx.tool.hook("execute.before"/"execute.after"):
// the REAL payload is {tool, sessionID, agent, messageID, id: Tool.CallID,
// input} (SDK 2.3.2 promise/tool.d.ts - the v1 callID field is named `id`,
// the arguments live under `input`). The ported belt (activity marking via
// the after-ledger, dispatch guards - partition /
// pool gate / crew pending / crew compliance, draft write-freeze with the
// readonly-recon carve-out, state-file boundary, readonly-exec seal,
// partition fallbacks incl. worker→STATE refusals). Refusal semantics are
// the v1 ones: the hook callback THROWS. Ported from exec-seal-wiring /
// headless-gate / hierarchical-pools / forge-subagents-wiring.

import { createV2MockContext } from "./lib/v2-mock-context.mjs"

process.env.FORGE_TEST_NO_FENCE = "1"
process.env.FORGE_GOAL_DEBOUNCE_MS = "10"

import { v2Setup, v2WiringSeam, __sessionAnchorTestSurface } from "../plugin.ts"

const HOME = join(tmpdir(), "forge-v2-toolhooks-home")
process.env.FORGE_TEST_FORGE_HOME = HOME

async function setup(dir) {
  const { ctx, state } = createV2MockContext()
  // materialize:"runtime" — the belts under test key on the RESOLVER, but
  // the crew gate suite here registers crews, and the native default would
  // route it through the roster-staleness gate instead (covered in
  // tests/native-roster-wiring.test.mjs).
  await v2Setup(ctx, { anchors: [dir], materialize: "runtime" })
  const byName = (n) => state.toolHooks.find((h) => h.name === n)?.cb
  return { ctx, state, before: byName("execute.before"), after: byName("execute.after") }
}

function poolDir(pool, agents) {
  const dir = mkdtempSync(join(tmpdir(), `forge-v2-th-${pool}-`))
  mkdirSync(join(dir, ".opencode"), { recursive: true })
  writeFileSync(join(dir, ".opencode", "forge.json"), JSON.stringify({ pool, agents }))
  return dir
}

const RO = { model: "openai/gpt", thoughtLevel: "low", shape: "readonly" }

test("v2 tool hooks: execute.before and execute.after both register", async () => {
  const { state } = await setup(mkdtempSync(join(tmpdir(), "forge-v2-th-empty-")))
  assert.deepEqual(state.toolHooks.map((h) => h.name), ["execute.before", "execute.after"])
})

test("v2 tool hooks: drift  - missing/not-function register nothing; garbage events never throw", async () => {
  const missing = createV2MockContext({ drift: { tool: "missing" } })
  await v2Setup(missing.ctx, { anchors: [join(tmpdir(), "forge-v2-th-none")] })
  assert.equal(missing.state.toolHooks.length, 0)
  const notFn = createV2MockContext({ drift: { tool: "not-function" } })
  await v2Setup(notFn.ctx, { anchors: [join(tmpdir(), "forge-v2-th-none")] })
  assert.equal(notFn.state.toolHooks.length, 0)
  const bad = createV2MockContext({ drift: { tool: "bad-shape" } })
  await v2Setup(bad.ctx, { anchors: [join(tmpdir(), "forge-v2-th-none")] })
  assert.equal(bad.state.toolHooks.length, 2, "bad-shape keeps the hook surface; drift lives in the events")
  const before = bad.state.toolHooks[0].cb
  const after = bad.state.toolHooks[1].cb
  for (const garbage of [5, null, "x", { tool: {} }, { tool: "task" }]) {
    await assert.doesNotReject(before(garbage), `before(${JSON.stringify(garbage)}) must not throw`)
    await assert.doesNotReject(after(garbage))
  }
})

test("v2 tool hooks: draft write-freeze  - write refused, read passes, readonly recon carve-out", async () => {
  const dir = mkdtempSync(join(tmpdir(), "forge-v2-th-draft-"))
  const { state, before } = await setup(dir)
  try {
    await state.tools.get("plan_write").execute(
      { goal: "belt draft", context: "c", approach: "a", tasks: ["t"], risks: "r", acceptance: ["a1"] },
      { sessionID: "ses_d", agent: "forge", worktree: dir },
    )
    await assert.rejects(before({ tool: "write", sessionID: "ses_d", messageID: "msg_1", id: "call_1", input: { filePath: "x.ts" } }), /plan is in draft; write operations are denied \(write\)/)
    await assert.doesNotReject(before({ tool: "read", sessionID: "ses_d", messageID: "msg_1", id: "call_1", input: { filePath: "x.ts" } }))
    // allow-readonly-recon: an explicit readonly target passes the task ban.
    const pool = poolDir("recon", { scout: { ...RO } })
    try {
      const { state: s2, before: b2 } = await setup(pool)
      await s2.tools.get("plan_write").execute(
        { goal: "recon draft", context: "c", approach: "a", tasks: ["t"], risks: "r", acceptance: ["a1"] },
        { sessionID: "ses_rec", agent: "forge", worktree: pool },
      )
      // Session bound to the POOL worktree, dispatching its own readonly worker.
      v2WiringSeam.sessions.set("ses_rec", { sessionID: "ses_rec", agent: "forge", worktree: pool })
      await assert.doesNotReject(b2({ tool: "task", sessionID: "ses_rec", args: { subagent_type: "forge-recon-scout" } }), "readonly recon passes during draft")
      await assert.rejects(b2({ tool: "task", sessionID: "ses_rec", args: { subagent_type: "general" } }), /dispatch is denied for this target/)
    } finally {
      rmSync(pool, { recursive: true, force: true })
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("v2 tool hooks: dispatch guards  - legacy task family restriction, native build own-pool admission; unknown session fails open", async () => {
  const dir = poolDir("guards", { research: { ...RO } })
  const { before, state } = await setup(dir)
  try {
    // Family capture via the prompt seam (Decision 3 topology).
    await assert.rejects(
      before({ tool: "task", sessionID: "ses_out", agent: "build", messageID: "msg_1", id: "call_1", input: { subagent_type: "forge-guards-research" } }),
      /Dispatch refused: "forge-guards-research" is a forge-family worker and the current agent \("build"\) is outside the forge family/,
    )
    // Native dispatch is target/session-scoped, not restricted by speaker family.
    v2WiringSeam.sessions.set("ses_out", { sessionID: "ses_out", agent: "build", worktree: dir })
    await assert.doesNotReject(
      before({ tool: "subagent", sessionID: "ses_out", agent: "build", messageID: "msg_1", id: "native_1", input: { agent: "forge-guards-research" } }),
    )
    await assert.doesNotReject(
      before({ tool: "subagent", sessionID: "ses_out", id: "native_2", input: { agent: "forge-guards-research" } }),
    )
    assert.equal(state.creates.length, 0, "native admission must not create any session through the plugin")
    // Unknown session with an ordinary target: no partition refusal.
    await assert.doesNotReject(before({ tool: "task", sessionID: "ses_unknown_g", messageID: "msg_1", id: "call_1", input: { subagent_type: "general" } }))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("v2 tool hooks: session-domain pool gate  - another workspace's pool is not dispatchable", async () => {
  // The global fallback layer rides the FILE-LEVEL home (the module-level
  // poolResolver binds homeDir at first creation  - per-test homes never
  // reach it, mirroring one host process = one home).
  mkdirSync(join(HOME, ".config", "opencode"), { recursive: true })
  writeFileSync(join(HOME, ".config", "opencode", "forge.json"), JSON.stringify({ agents: { shader: { model: "openai/gpt", thoughtLevel: "low" } } }))
  const wsA = poolDir("alpha", { research: { ...RO } })
  const { state, before } = await setup(wsA)
  try {
    v2WiringSeam.sessions.set("ses_a", { sessionID: "ses_a", worktree: wsA })
    // Own pool: passes the pool gate (no refusal).
    await assert.doesNotReject(before({ tool: "task", sessionID: "ses_a", agent: "forge", messageID: "msg_1", id: "call_1", input: { subagent_type: "forge-alpha-research" } }))
    // Native preflight must reject the same cross-pool target before execution.
    await assert.rejects(
      before({ tool: "subagent", sessionID: "ses_a", agent: "build", id: "native_cross_pool", input: { agent: "forge-global-shader" } }),
      /not dispatchable from this session/,
    )
    assert.equal(state.creates.length, 0)
    // Global-fallback target from a pooled workspace: refused with the
    // three-exits copy.
    await assert.rejects(
      before({ tool: "task", sessionID: "ses_a", agent: "forge", messageID: "msg_1", id: "call_1", input: { subagent_type: "forge-global-shader" } }),
      (err) => {
        assert.match(String(err), /not dispatchable from this session/)
        assert.match(String(err), /forge\.json/)
        assert.match(String(err), /Exits: /)
        return true
      },
    )
    void state
  } finally {
    rmSync(wsA, { recursive: true, force: true })
  }
})

test("v2 tool hooks: crew pending belt + pool-compliance belt (hot-apply unblock)", async () => {
  const dir = poolDir("crewb", { research: { ...RO } })
  const { state, before } = await setup(dir)
  try {
    // Register a PENDING crew through the same shared core (crew_begin).
    await state.tools.get("crew_begin").execute(
      { objective: "v2 belt crew", subtasks: [{ title: "scout" }] },
      { sessionID: "ses_crew", agent: "forge", worktree: dir, metadata: () => {} },
    )
    await assert.rejects(before({ tool: "task", sessionID: "ses_crew", agent: "forge", messageID: "msg_1", id: "call_1", input: { subagent_type: "general" } }), /is PENDING \(registered, not armed\)/)
    for (const agent of ["general", "forge-crewb-research"]) {
      await assert.rejects(before({ tool: "subagent", sessionID: "ses_crew", agent: "build", messageID: "msg_1", id: "native_pending", input: { agent } }), /is PENDING \(registered, not armed\)/)
    }
    assert.equal(state.creates.length, 0, "refusal must not create any session through the plugin")
    // Arm the crew (waves)  - the pending belt lifts...
    await state.tools.get("crew_begin").execute({ execution: "waves" }, { sessionID: "ses_crew", agent: "forge", worktree: dir, metadata: () => {} })
    await assert.doesNotReject(before({ tool: "task", sessionID: "ses_crew", agent: "forge", messageID: "msg_1", id: "call_1", input: { subagent_type: "forge-crewb-research" } }))
    // ...then degrade the pool file mid-crew (drop the `pool` namespace):
    // the compliance belt refuses further forge-* dispatches...
    writeFileSync(join(dir, ".opencode", "forge.json"), JSON.stringify({ agents: { research: { ...RO } } }))
    await assert.rejects(before({ tool: "task", sessionID: "ses_crew", agent: "forge", messageID: "msg_1", id: "call_1", input: { subagent_type: "forge-crewb-research" } }), (err) => {
      assert.match(String(err), /Pool compliance refused/)
      assert.ok(!String(err).includes("not dispatchable from this session"), "compliance never masks/echoes the cross-pool copy")
      return true
    })
    // ...and repairing the file hot-applies the unblock.
    writeFileSync(join(dir, ".opencode", "forge.json"), JSON.stringify({ pool: "crewb", agents: { research: { ...RO } } }))
    await assert.doesNotReject(before({ tool: "task", sessionID: "ses_crew", agent: "forge", messageID: "msg_1", id: "call_1", input: { subagent_type: "forge-crewb-research" } }))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("v2 tool hooks: state-file boundary + worker→STATE refusal + partition fallbacks", async () => {
  const dir = mkdtempSync(join(tmpdir(), "forge-v2-th-part-"))
  const { before, state } = await setup(dir)
  try {
    // Non-forge speaker writing into .opencode/plan: refused.
    await assert.rejects(
      before({ tool: "write", sessionID: "ses_np", agent: "build", messageID: "msg_1", id: "call_1", input: { filePath: ".opencode/plan/x.md", content: "y" } }),
      /inside the forge state directories/,
    )
    for (const agent of ["forge", "build", "forge-worker", undefined]) {
      for (const path of [".opencode/plan/x.md", ".opencode/goal/x.md", join(dir, ".opencode", "plan", "x.md"), join(dir, ".opencode", "goal", "x.md")]) {
        for (const tool of ["write", "edit"]) {
          await assert.rejects(before({ tool, agent, sessionID: "ses_boundary", input: { filePath: path } }), /inside the forge state directories/)
        }
        await assert.doesNotReject(before({ tool: "read", agent, sessionID: "ses_boundary", input: { filePath: path } }))
      }
    }
    // Same speaker, ordinary path: no boundary refusal.
    await assert.doesNotReject(before({ tool: "write", sessionID: "ses_np", agent: "build", messageID: "msg_1", id: "call_1", input: { filePath: "src/x.ts", content: "y" } }))
    // Retained STATE tools, not retired runtime tools, are primary-only.
    const goalDir = join(dir, ".opencode", "goal")
    mkdirSync(goalDir, { recursive: true })
    const sentinel = join(goalDir, "sentinel.md")
    writeFileSync(sentinel, "unchanged fixture")
    for (const tool of ["plan_write", "plan_tick", "plan_approve", "plan_close", "plan_reopen", "plan_discard", "goal_write", "goal_check", "goal_complete", "goal_pause", "goal_resume", "goal_discard", "crew_begin", "crew_close", "forge_sync"]) {
      await assert.rejects(before({ tool, sessionID: "ses_np", agent: "build", input: {} }), /belongs to the forge agent family/)
      await assert.rejects(before({ tool, sessionID: "ses_worker", agent: "forge-x-research", input: {} }), /reserved for the primary forge agent/)
      await assert.rejects(before({ tool, sessionID: "ses_unknown", input: {} }), /primary identity is not established/)
      await assert.doesNotReject(before({ tool, sessionID: "ses_primary", agent: "forge", input: {} }))
      const execute = state.tools.get(tool).execute
      for (const agent of ["build", "general", "forge-x-research", undefined]) {
        await assert.rejects(execute({}, { sessionID: "ses_direct", worktree: dir, agent, ask() { assert.fail("unauthorized tool reached permission gate") } }), /\[forge:partition\] Tool refused/)
      }
    }
    assert.deepEqual(readdirSync(goalDir), ["sentinel.md"])
    assert.equal(readFileSync(sentinel, "utf8"), "unchanged fixture")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("v2 tool hooks: activity marking  - the after ledger counts writes/ticks/checks and crew dispatches", async () => {
  const dir = mkdtempSync(join(tmpdir(), "forge-v2-th-act-"))
  const { after } = await setup(dir)
  try {
    v2WiringSeam.turnActivity.set("ses_act", { writes: 0, checks: 0 })
    await after({ tool: "write", sessionID: "ses_act", id: "call_write", input: {} })
    await after({ tool: "plan_tick", sessionID: "ses_act", id: "call_plan_tick", input: {} })
    await after({ tool: "goal_check", sessionID: "ses_act", id: "call_goal_check", input: {} })
    await after({ tool: "read", sessionID: "ses_act", id: "call_read", input: {} })
    assert.equal(v2WiringSeam.turnActivity.get("ses_act").writes, 2)
    assert.equal(v2WiringSeam.turnActivity.get("ses_act").checks, 1)
    v2WiringSeam.crewTurnActivity.set("ses_cact", { dispatches: 0, writes: 0 })
    await after({ tool: "task", sessionID: "ses_cact", id: "call_task", input: {} })
    await after({ tool: "edit", sessionID: "ses_cact", id: "call_edit", input: {} })
    await after({ tool: "grep", sessionID: "ses_cact", id: "call_grep", input: {} })
    // A repeated observation of the same call is not a new execution.
    await after({ tool: "edit", sessionID: "ses_cact", id: "call_edit", input: {} })
    const crewActivity = v2WiringSeam.crewTurnActivity.get("ses_cact")
    assert.equal(crewActivity.dispatches, 1)
    assert.equal(crewActivity.writes, 2)
    assert.deepEqual(crewActivity.seen, new Set(["call_task", "call_edit", "call_grep"]))
    // Inactive sessions: no-op, never a throw.
    await assert.doesNotReject(after({ tool: "write", sessionID: "ses_nobody", id: "call_1", input: {} }))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})


test("v2 native pool gate: host-visible ghost is denied for known healthy and broken pools, unknown session remains fail-open", async () => {
  const dir = poolDir("ghostgate", { real: { ...RO } })
  const sibling = poolDir("ghostsibling", { real: { ...RO } })
  v2WiringSeam.resetHostAnchors()
  __sessionAnchorTestSurface.resetInitializedDirectories()
  const { ctx, state } = createV2MockContext()
  const siblingHost = createV2MockContext()
  let cleanup, siblingCleanup
  try {
    cleanup = await v2Setup(ctx, { anchors: [dir], materialize: "runtime" })
    siblingCleanup = await v2Setup(siblingHost.ctx, { anchors: [sibling], materialize: "runtime" })
    assert.equal(__sessionAnchorTestSurface.initializedDirectories().length, 2)
    state.agents.set("forge-ghostgate-ghost", { id: "forge-ghostgate-ghost", mode: "subagent" })
    v2WiringSeam.sessions.set("ses_ghost_known", { sessionID: "ses_ghost_known", worktree: dir })
    const before = state.toolHooks.find(h => h.name === "execute.before").cb
    const dispatch = (sessionID, agent) => before({ tool: "subagent", sessionID, agent: "build", input: { agent } })
    await assert.doesNotReject(dispatch("ses_ghost_known", "forge-ghostgate-real"))
    await assert.rejects(dispatch("ses_ghost_known", "forge-ghostgate-ghost"), /not dispatchable from this session/)
    await assert.rejects(dispatch("ses_ghost_known", "forge-ghostsibling-real"), /not dispatchable from this session/)
    assert.equal(state.sessionRecords.has("ses_ghost_unknown"), false)
    assert.equal(v2WiringSeam.sessions.has("ses_ghost_unknown"), false)
    await assert.doesNotReject(dispatch("ses_ghost_unknown", "forge-ghostgate-ghost"))
    assert.equal(v2WiringSeam.sessions.has("ses_ghost_unknown"), false, "unknown must remain unbound")
    writeFileSync(join(dir, ".opencode", "forge.json"), "{ broken config")
    await assert.rejects(dispatch("ses_ghost_known", "forge-ghostgate-real"), /not dispatchable from this session/)
    await assert.rejects(dispatch("ses_ghost_known", "forge-ghostgate-ghost"), /not dispatchable from this session/)
    await assert.rejects(dispatch("ses_ghost_known", "forge-ghostsibling-real"), /not dispatchable from this session/)
  } finally {
    await siblingCleanup?.()
    await cleanup?.()
    v2WiringSeam.resetHostAnchors()
    __sessionAnchorTestSurface.resetInitializedDirectories()
    rmSync(dir, { recursive: true, force: true })
    rmSync(sibling, { recursive: true, force: true })
  }
})
