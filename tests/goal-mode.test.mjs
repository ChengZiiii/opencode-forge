import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, readdirSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createV2MockContext } from "./lib/v2-mock-context.mjs"

// Debounce must be tiny BEFORE plugin.ts is imported (module-level const).
process.env.FORGE_GOAL_DEBOUNCE_MS = "10"
// Sandbox the plugin's runtime-artifact home (session-anchor ledger etc.) —
// this suite binds POOLED workspaces and must never write the real ledger.
process.env.FORGE_TEST_FORGE_HOME = mkdtempSync(join(tmpdir(), "goal-mode-home-"))
const { v2Setup, v2WiringSeam, resetServiceHttpDiscoveryForTests } = await import("../plugin.ts")
import { crewNativeView } from "./lib/crew-native-view.mjs"
const native = await crewNativeView(process.env.FORGE_TEST_FORGE_HOME, resetServiceHttpDiscoveryForTests)
test.after(() => native.close())
import { setShellRunnerForTests, runChecks } from "../src/run-check.ts"

const NOW_PREFIX = "goal-mode-test"
let sidCounter = 0
const nextSid = () => `ses_${NOW_PREFIX}-${++sidCounter}`

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const toolCtx = (sid, worktree) => ({ sessionID: sid, worktree, metadata() {}, callID: "c", agent: "forge", messageID: "m" })

function goalArgs(overrides = {}) {
  return {
    goal: "make the suite green",
    criteria: ["npm test exits 0"],
    checks: [{ shell: "npm test" }, { containsFile: "done.txt", containsText: "done" }],
    constraints: "stay in the sandbox",
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// goal_check / goal_complete
// ---------------------------------------------------------------------------

test("goal_check real-runner smoke: echo pass, exit 1 fail, contains hit and miss", async () => {
  const wt = mkdtempSync(join(tmpdir(), "goal-real-"))
  try {
    mkdirSync(join(wt, "sub"))
    writeFileSync(join(wt, "done.txt"), "all done\n")
    const { ctx, state } = createV2MockContext()
    const cleanup = await v2Setup(ctx, { anchors: [wt] })
    const sid = nextSid()
    await state.tools.get("goal_write").execute(
      {
        goal: "real runner smoke",
        criteria: ["echo works", "exit codes work", "file contract works"],
        checks: [
          { shell: "echo forge-goal-smoke" },
          { shell: "exit 1" },
          { containsFile: "done.txt", containsText: "all done" },
          { containsFile: "done.txt", containsText: "not there" },
          { containsFile: "../escape.txt", containsText: "x" },
        ],
        constraints: "sandbox only",
        arm: true,
      },
      toolCtx(sid, wt),
    )
    const out = await state.tools.get("goal_check").execute({}, toolCtx(sid, wt))
    assert.match(out.content, /#1 \[PASS\][\s\S]*forge-goal-smoke/)
    assert.match(out.content, /#2 \[FAIL\][\s\S]*exit=1/)
    assert.match(out.content, /#3 \[PASS\]/)
    assert.match(out.content, /#4 \[FAIL\][\s\S]*not found/)
    assert.match(out.content, /#5 \[FAIL\][\s\S]*escapes the workspace/)
    await cleanup()
  } finally {
    rmSync(wt, { recursive: true, force: true })
  }
})

test("goal_check real-runner smoke: shell timeout kills the command", async () => {
  const wt = mkdtempSync(join(tmpdir(), "goal-timeout-"))
  try {
    const { ctx, state } = createV2MockContext()
    const cleanup = await v2Setup(ctx, { anchors: [wt] })
    const sid = nextSid()
    await state.tools.get("goal_write").execute(
      {
        goal: "timeout smoke",
        criteria: ["command must time out"],
        checks: [{ shell: 'node -e "setTimeout(()=>{},8000)"', timeoutSec: 1 }],
        constraints: "sandbox only",
        arm: true,
      },
      toolCtx(sid, wt),
    )
    const started = Date.now()
    const out = await state.tools.get("goal_check").execute({}, toolCtx(sid, wt))
    assert.ok(Date.now() - started < 5000, "timeout must fire at ~1s")
    assert.match(out.content, /#1 \[FAIL\][\s\S]*timed out after 1s/)
    await cleanup()
  } finally {
    rmSync(wt, { recursive: true, force: true })
  }
})

// v1 autocontinue suppression has no v2 hook and is retired. The v2
// compaction brief, budget, activity, pause and persistence cases live in
// v2-goal-lifecycle and v2-session-commands; lazy seeding in v2-continuation.

test("decoupling: goal core modules import nothing from plan-file; gate tools read no plan state", async () => {
  const { readFile } = await import("node:fs/promises")
  const goalFileSrc = await readFile(new URL("../src/goal-file.ts", import.meta.url), "utf8")
  const runCheckSrc = await readFile(new URL("../src/run-check.ts", import.meta.url), "utf8")
  assert.ok(!/from\s+"\.\/plan-file/.test(goalFileSrc), "goal-file.ts must not import plan-file")
  assert.ok(!/from\s+"\.\/plan-file/.test(runCheckSrc), "run-check.ts must not import plan-file")
  const pluginSrc = await readFile(new URL("../plugin.ts", import.meta.url), "utf8")
  const seg = pluginSrc.slice(pluginSrc.indexOf("const goalCheckTool"), pluginSrc.indexOf("const goalPauseTool"))
  assert.ok(!seg.includes("resolveActivePlan") && !seg.includes("planPath"), "goal_check/goal_complete read no plan state")
})

test("v2 idle sends one goal continuation and no retired dispatch brief", async () => {
  const wt = mkdtempSync(join(tmpdir(), "forge-b36-v2-"))
  v2WiringSeam.resetHostAnchors()
  const { ctx, state } = createV2MockContext()
  const cleanup = await v2Setup(ctx, { anchors: [wt] })
  const sid = nextSid()
  try {
    await state.tools.get("goal_write").execute({ ...goalArgs(), arm: true }, toolCtx(sid, wt))
    await state.sessionHooks.find(h => h.name === "experimental.idle").cb({ sessionID: sid, background: [] })
    await sleep(100)
    assert.equal(state.prompts.filter(p => p.text.includes("[forge:goal-continue]")).length, 1)
    assert.equal(state.prompts.filter(p => p.text.includes("[forge:dispatch-complete]")).length, 0)
  } finally { await cleanup(); rmSync(wt, { recursive: true, force: true }) }
})

// align-shell-interpreter: the goal gate's REAL shell runner (no fake
// injected) executes through the host-aligned interpreter — a nonzero exit
// must propagate through the wrapper's exit-code guard on every platform.
test("align-shell-interpreter: run-check real runner propagates exit codes through the host shell", async () => {
  setShellRunnerForTests(null) // restore the real defaultShellRunner (shared shellSpawn)
  const wt = mkdtempSync(join(tmpdir(), "forge-runcheck-real-"))
  try {
    const outcomes = await runChecks([{ kind: "shell", cmd: "exit 3", timeoutSec: 60 }], wt)
    assert.equal(outcomes.length, 1)
    assert.equal(outcomes[0].ok, false, "exit 3 fails the check")
    assert.match(outcomes[0].detail, /exit=3/, "the wrapper's exit-code guard carried 3 through")
  } finally {
    rmSync(wt, { recursive: true, force: true })
  }
})

// Goal governance exercises actual registered v2 tools and permission domain.
async function crewFixture(t, compliant = true) {
  const wt = mkdtempSync(join(tmpdir(), "goal-crew-v2-"))
  mkdirSync(join(wt, ".opencode"), { recursive: true })
  writeFileSync(join(wt, ".opencode", "forge.json"), JSON.stringify({ ...(compliant ? { pool: "goalcrew" } : {}), agents: { research: { model: "zai/glm", thoughtLevel: "low" } } }))
  v2WiringSeam.resetHostAnchors()
  const { ctx, state } = createV2MockContext()
  const cleanup = await v2Setup(ctx, { anchors: [wt], materialize: "runtime" })
  const sid = nextSid()
  t.after(async () => { await cleanup(); v2WiringSeam.resetHostAnchors(); rmSync(wt, { recursive: true, force: true }) })
  return { wt, sid, state, call: (name, args) => state.tools.get(name).execute(args, toolCtx(sid, wt)) }
}

test("v2 goal-delegated crew gates stay internal through close, reshard and conversion", async t => {
  const { sid, state, call } = await crewFixture(t)
  await call("goal_write", { ...goalArgs(), arm: true })
  state.assertBehavior = "deny"
  const before = state.asserts.length
  const out = await call("crew_begin", { objective: "crew under goal", subtasks: [{ title: "one" }], execution: "waves" })
  assert.match(out.content, /born armed/)
  assert.match(out.content, /Native fallback: when the pool offers no forge worker fitting a subtask/)
  assert.match(out.content, /RECORD the fallback/)
  assert.doesNotMatch(out.content, /PENDING for this session/)
  assert.equal(v2WiringSeam.crews.get(sid).mode, "executing")
  const closed = await call("crew_close", { report: [{ title: "one", verdict: "PASS", evidence: "ok" }] })
  assert.match(closed.content, /Crew closed/)
  await call("crew_begin", { objective: "reshard", subtasks: [{ title: "two" }], execution: "waves" })
  assert.equal(v2WiringSeam.crews.get(sid).mode, "executing")
  const abandoned = await call("crew_close", { abandon: true, reason: "wrong decomposition" })
  assert.match(abandoned.content, /ABANDONED/)
  assert.equal(v2WiringSeam.crews.get(sid), undefined)
  await call("crew_begin", { objective: "c", subtasks: [{ title: "t" }] })
  assert.equal(v2WiringSeam.crews.get(sid).mode, "pending")
  await assert.rejects(call("crew_begin", { execution: "goal" }), /refused under a governing goal/)
  await call("crew_close", { abandon: true, reason: "cleanup" })
  assert.equal(state.asserts.length, before, "governing goal keeps crew gates internal")
})

test("v2 one-call crew arm refuses without an active governing goal", async t => {
  const { sid, call } = await crewFixture(t)
  const args = { objective: "o", subtasks: [{ title: "x" }], execution: "waves" }
  await assert.rejects(call("crew_begin", args), /cannot self-arm outside a governing goal/)
  await call("goal_write", { ...goalArgs(), arm: true })
  await call("goal_pause", { blocker: "waiting on the user" })
  await assert.rejects(call("crew_begin", args), /cannot self-arm outside a governing goal/)
  await call("crew_begin", { objective: "o", subtasks: [{ title: "x" }] })
  assert.equal(v2WiringSeam.crews.get(sid).mode, "pending")
})

test("v2 goal-governed born-armed crew rejects non-compliant pool without records", async t => {
  const { wt, sid, call } = await crewFixture(t, false)
  await call("goal_write", { ...goalArgs(), arm: true })
  await assert.rejects(call("crew_begin", { objective: "o", subtasks: [{ title: "x" }], execution: "waves" }), err => {
    assert.match(err.message, /Pool compliance refused/)
    assert.match(err.message, /missing top-level pool field/)
    return true
  })
  assert.equal(v2WiringSeam.crews.get(sid), undefined)
  assert.equal(existsSync(join(wt, ".opencode", "crew")), false)
})
