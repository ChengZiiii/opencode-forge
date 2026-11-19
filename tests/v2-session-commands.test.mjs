import test from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Tasks 4.2 + 4.3 (W6a field realities) — the v2 session seams and commands.
// 4.2: ctx.session.hook("prompt") busy-marking (Decision 3 topology; the
//      real SessionPrompt carries NO agent field, so family capture rides
//      the context hook's SessionContext.agent) + "context"
//      (thoughtLevel injection onto event.options + family-gated system
//      injections incl. the forge_shell channel mandate + plan/goal
//      notices) + "compaction" (goal-brief reinjection onto event.context)
//      + "experimental.idle" (the W6a idle edge — see v2-continuation).
//      Fail-open posture: garbage events never throw, unknown sessions
//      receive nothing (fail-silent).
// 4.3: /plan /goal /crew via ctx.command.transform — W6a field reality: the
//      v2 CommandDefinition is EXECUTE-based ({name, description?,
//      execute({sessionID,...})}; the editor exposes only add()), so each
//      command sends the SAME constant template text into the invoking
//      session via the flat {sessionID, text} prompt. The v1 create-only
//      rule is not implementable (no editor.get) — documented drift.

import { createV2MockContext } from "./lib/v2-mock-context.mjs"

process.env.FORGE_TEST_NO_FENCE = "1"
process.env.FORGE_GOAL_DEBOUNCE_MS = "10"

import { v2Setup, v2WiringSeam, PLAN_COMMAND_TEMPLATE, GOAL_COMMAND_TEMPLATE } from "../plugin.ts"

const HOME = join(tmpdir(), "forge-v2-sess-home")
process.env.FORGE_TEST_FORGE_HOME = HOME

async function setup(dir) {
  const { ctx, state } = createV2MockContext()
  await v2Setup(ctx, { anchors: [dir] })
  const hook = (n) => state.sessionHooks.find((h) => h.name === n)?.cb
  return { ctx, state, prompt: hook("prompt"), context: hook("context"), compaction: hook("compaction"), idle: hook("experimental.idle") }
}

function poolDir(pool, agents) {
  const dir = mkdtempSync(join(tmpdir(), `forge-v2-sc-${pool}-`))
  mkdirSync(join(dir, ".opencode"), { recursive: true })
  writeFileSync(join(dir, ".opencode", "forge.json"), JSON.stringify({ pool, agents }))
  return dir
}

// ---------------------------------------------------------------------------
// Registration + drift

test("v2 session: prompt/context/compaction/experimental.idle hooks all register", async () => {
  const { state } = await setup(mkdtempSync(join(tmpdir(), "forge-v2-sc-empty-")))
  assert.deepEqual(state.sessionHooks.map((h) => h.name), ["prompt", "context", "compaction", "experimental.idle"])
})

test("v2 session: drift — missing/not-function register nothing; garbage events never throw (fail-open)", async () => {
  for (const mode of ["missing", "not-function"]) {
    const d = createV2MockContext({ drift: { session: mode } })
    await v2Setup(d.ctx, { anchors: [join(tmpdir(), "forge-v2-sc-none")] })
    assert.equal(d.state.sessionHooks.length, 0, mode)
  }
  const bad = createV2MockContext({ drift: { session: "bad-shape" } })
  await v2Setup(bad.ctx, { anchors: [join(tmpdir(), "forge-v2-sc-none")] })
  assert.equal(bad.state.sessionHooks.length, 4)
  for (const h of bad.state.sessionHooks) {
    for (const garbage of [5, null, "x", [], {}]) {
      await assert.doesNotReject(h.cb(garbage), `${h.name}(${JSON.stringify(garbage)}) must not throw`)
    }
  }
})

// ---------------------------------------------------------------------------
// prompt (busy marking) + context (family capture / system injections /
// channel mandate)
// ---------------------------------------------------------------------------

test("v2 session: prompt marks the session busy (SessionPrompt shape, no agent); context captures the family and injects job guidance into forge-family sessions only", async () => {
  const dir = mkdtempSync(join(tmpdir(), "forge-v2-sc-cap-"))
  const { prompt, context } = await setup(dir)
  try {
    // W6a: the real SessionPrompt is {sessionID, messageID, prompt,
    // delivery} — NO agent field; the prompt hook only marks busy.
    await prompt({ sessionID: "ses_f", messageID: "msg_1", prompt: { text: "go" }, delivery: "steer" })
    // Family capture rides the CONTEXT hook (SessionContext.agent).
    const out = { system: [], options: {} }
    await context({ sessionID: "ses_f", agent: "forge", ...out })
    assert.equal(out.system.length, 1, "guidance landed on the event's own system array")
    assert.match(out.system[0], /^\[forge:job-guidance\]/)
    // Channel mandate (default partition): the HARD wording.
    assert.match(out.system[0], /Every shell command — quick ones included/)
    assert.match(out.system[0], /refused on this agent/)
    // Unknown session: fail-silent — no forge-authored text at all.
    const out2 = { system: [] }
    await context({ sessionID: "ses_anon", agent: "build", ...out2 })
    assert.deepEqual(out2.system, [])
    // Non-forge agent captured via context: nothing either.
    const out3 = { system: [] }
    await context({ sessionID: "ses_nf", agent: "build", ...out3 })
    assert.deepEqual(out3.system, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("v2 session: the idle hook accepts the real SessionIdle shape without a throw", async () => {
  const dir = mkdtempSync(join(tmpdir(), "forge-v2-sc-idle-"))
  const { idle } = await setup(dir)
  try {
    await assert.doesNotReject(idle({ sessionID: "ses_idle1", background: [{ kind: "shell", sessionID: "ses_idle1", shellID: "sh_1", command: "npm test" }] }))
    await assert.doesNotReject(idle(null))
    await assert.doesNotReject(idle({}))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("v2 session: context carries plan-notice for a draft-bound session", async () => {
  const dir = mkdtempSync(join(tmpdir(), "forge-v2-sc-plan-"))
  const { state, context } = await setup(dir)
  try {
    await state.tools.get("plan_write").execute(
      { goal: "notice check", context: "c", approach: "a", tasks: ["t"], risks: "r", acceptance: ["a1"] },
      { sessionID: "ses_plan", agent: "forge", worktree: dir },
    )
    v2WiringSeam.sessions.set("ses_plan", { sessionID: "ses_plan", worktree: dir })
    const out = { system: [] }
    await context({ sessionID: "ses_plan", agent: "forge", ...out })
    const notice = out.system.find((s) => s.startsWith("[forge:plan-notice]"))
    assert.ok(notice, "plan notice injected")
    assert.match(notice, /status: draft/)
    assert.match(notice, /0\/1 tasks done/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// thoughtLevel injection (chat.params port)

test("v2 session: context injects the pinned thoughtLevel onto event.options; frozen per session", async () => {
  const dir = poolDir("depth", { research: { model: "openai/gpt", thoughtLevel: "low" } })
  const { context } = await setup(dir)
  try {
    const out1 = { options: {} }
    await context({ sessionID: "ses_dep1", agent: "forge-depth-research", model: { providerID: "openai", id: "gpt" }, ...out1 })
    assert.equal(out1.options.reasoningEffort, "low", "openai effort word channel applies to event.options")
    // Frozen first resolution: a later model change does not re-resolve.
    const out2 = { options: {} }
    await context({ sessionID: "ses_dep1", agent: "forge-depth-research", model: { providerID: "anthropic", id: "claude-x" }, ...out2 })
    assert.equal(out2.options.reasoningEffort, "low", "frozen translation re-applies verbatim")
    // Non-forge agent: no depth keys.
    const out3 = { options: {} }
    await context({ sessionID: "ses_dep2", agent: "build", model: { providerID: "openai", id: "gpt" }, ...out3 })
    assert.deepEqual(out3.options, {})
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// compaction (goal-brief reinjection)

test("v2 session: compaction reinjects the goal brief for a live-goal forge session; silent otherwise", async () => {
  const dir = mkdtempSync(join(tmpdir(), "forge-v2-sc-goal-"))
  const { state, compaction } = await setup(dir)
  try {
    await state.tools.get("goal_write").execute(
      { goal: "make the suite green", criteria: ["all tests pass"], checks: [{ shell: "node --test" }], constraints: "none", arm: true },
      { sessionID: "ses_goal", agent: "forge", worktree: dir, ask: async () => ({ status: "allow" }), metadata: () => {} },
    )
    v2WiringSeam.sessions.set("ses_goal", { sessionID: "ses_goal", worktree: dir })
    const ev = { context: [] }
    await compaction({ sessionID: "ses_goal", agent: "forge", ...ev })
    assert.equal(ev.context.length, 1)
    assert.match(ev.context[0], /\[forge:goal-brief\]/)
    assert.match(ev.context[0], /make the suite green/)
    assert.match(ev.context[0], /1\. all tests pass/)
    // Non-forge / unknown sessions: nothing.
    const ev2 = { context: [] }
    await compaction({ sessionID: "ses_goal_other", agent: "build", ...ev2 })
    assert.deepEqual(ev2.context, [])
    const ev3 = { context: [] }
    await compaction({ sessionID: "ses_nobody", ...ev3 })
    assert.deepEqual(ev3.context, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("v2 session: goal-notice rides the context system injections for the live-goal session", async () => {
  const dir = mkdtempSync(join(tmpdir(), "forge-v2-sc-goaln-"))
  const { state, context } = await setup(dir)
  try {
    await state.tools.get("goal_write").execute(
      { goal: "notice goal", criteria: ["c1"], checks: [{ shell: "node -v" }], constraints: "none", arm: true },
      { sessionID: "ses_gn", agent: "forge", worktree: dir, ask: async () => ({ status: "allow" }), metadata: () => {} },
    )
    v2WiringSeam.sessions.set("ses_gn", { sessionID: "ses_gn", worktree: dir })
    const out = { system: [] }
    await context({ sessionID: "ses_gn", agent: "forge", ...out })
    const notice = out.system.find((s) => s.startsWith("[forge:goal-notice]"))
    assert.ok(notice, "goal notice injected")
    assert.match(notice, /status: active/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Commands (task 4.3)

test("v2 commands: /plan /goal /crew register as execute-based definitions", async () => {
  const dir = poolDir("cmds", { research: { model: "openai/gpt", thoughtLevel: "low", shape: "readonly" } })
  const { state } = await setup(dir)
  try {
    assert.deepEqual([...state.commands.keys()].sort(), ["crew", "goal", "plan"])
    for (const name of ["plan", "goal", "crew"]) {
      const def = state.commands.get(name)
      assert.equal(typeof def.description, "string", `${name} description`)
      assert.equal(typeof def.execute, "function", `${name} is EXECUTE-based (CommandDefinition.execute)`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("v2 commands: invoking execute sends the byte-identical template into the invoking session", async () => {
  const dir = poolDir("cmdt", { research: { model: "openai/gpt", thoughtLevel: "low", shape: "readonly" } })
  const { ctx, state } = await setup(dir)
  try {
    assert.ok(PLAN_COMMAND_TEMPLATE.startsWith("(forge plan harness routing."), "sanity: the constant is the dist text")
    assert.ok(GOAL_COMMAND_TEMPLATE.startsWith("(forge goal harness routing."))
    // Invoke the executable: it sends the SAME constant text via the flat
    // {sessionID, text} prompt (W6a shape matrix).
    await state.commands.get("plan").execute({ sessionID: "ses_cmd1" })
    await state.commands.get("goal").execute({ sessionID: "ses_cmd2" })
    const texts = Object.fromEntries(state.prompts.map((p) => [p.sessionID, p.text]))
    assert.equal(texts.ses_cmd1, PLAN_COMMAND_TEMPLATE, "plan template byte-identical")
    assert.equal(texts.ses_cmd2, GOAL_COMMAND_TEMPLATE, "goal template byte-identical")
    // Crew composes through the SAME crewOrchestrationTemplate the v1
    // config hook uses; the roster leg names the materialized worker.
    await state.commands.get("crew").execute({ sessionID: "ses_cmd3" })
    const crew = state.prompts.find((p) => p.sessionID === "ses_cmd3")?.text ?? ""
    assert.ok(crew.startsWith("(forge crew"), "roster leg of the crew template")
    assert.ok(crew.includes("forge-cmdt-research"), "the session-domain roster names the materialized worker")
    assert.match(state.commands.get("crew").description, /register a declared subtask plan/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("v2 commands: empty-pool host crew shows the NOT INITIALIZED guidance; re-resolves lazily", async () => {
  // Empty-pool host: the init-guidance leg (NOT INITIALIZED). The cwd
  // candidate would walk up to THIS repo's own workspace pool, and the
  // host anchor registry accumulates earlier tests' pools — chdir into a
  // clean dir and reset the registry to simulate a fresh host process.
  // The lazy crew composition re-resolves pools at INVOCATION time, so the
  // invoke must happen INSIDE the chdir window (the invocation cwd is the
  // empty workspace, exactly like a real host serving that directory).
  const empty = mkdtempSync(join(tmpdir(), "forge-v2-sc-cmdempty-"))
  const prevCwd = process.cwd()
  v2WiringSeam.resetHostAnchors()
  process.chdir(empty)
  let s2
  try {
    const m = createV2MockContext()
    await v2Setup(m.ctx, { anchors: [empty] })
    s2 = m.state
    assert.match(s2.commands.get("crew").description, /NOT INITIALIZED/)
    await s2.commands.get("crew").execute({ sessionID: "ses_empty" })
    const text = s2.prompts.find((p) => p.sessionID === "ses_empty")?.text ?? ""
    assert.ok(text.includes(".opencode"), "init guidance points at the pool file")
  } finally {
    process.chdir(prevCwd)
    rmSync(empty, { recursive: true, force: true })
  }
})

test("v2 commands: no get on the editor — v1 create-only is NOT implementable (documented drift); forge adds last", async () => {
  const dir = mkdtempSync(join(tmpdir(), "forge-v2-sc-cmduser-"))
  const { ctx, state } = createV2MockContext()
  // The v2 editor contract: add() only. A user command registered earlier is
  // overwritten by forge's add (host-side last-wins; documented in design.md).
  await ctx.command.transform(async (editor) => {
    editor.add({ name: "plan", description: "the user's own /plan", execute: async () => {} })
  })
  await v2Setup(ctx, { anchors: [dir] })
  try {
    assert.equal(state.commands.get("plan").description.includes("forge plan harness"), true, "forge re-adds over the user def (drift vs v1 create-only)")
    assert.equal(state.commands.get("goal").description.includes("forge goal harness"), true, "siblings still register")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("v2 commands: drifted command domain — every mode is a silent no-op", async () => {
  for (const mode of ["missing", "not-function", "bad-shape"]) {
    const d = createV2MockContext({ drift: { command: mode } })
    await assert.doesNotReject(v2Setup(d.ctx, { anchors: [join(tmpdir(), "forge-v2-sc-none")] }), `command/${mode}`)
    assert.equal(d.state.commands.size, 0, `${mode}: nothing registered`)
  }
})
