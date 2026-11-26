import test from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Tasks 4.2 + 4.3 (W6a field realities) — the v2 session seams and commands.
// 4.2: ctx.session.hook("prompt") busy-marking (Decision 3 topology; the
//      real SessionPrompt carries NO agent field, so family capture rides
//      the context hook's SessionContext.agent) + "context"
//      (thoughtLevel injection onto event.options + family-gated system
//      injections incl. plan/goal
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

import { resetServiceHttpDiscoveryForTests, v2Setup, v2WiringSeam, PLAN_COMMAND_TEMPLATE, GOAL_COMMAND_TEMPLATE, FORGE_COMMAND_TEMPLATE } from "../plugin.ts"

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
// plan/goal notices)
// ---------------------------------------------------------------------------

test("v2 session: prompt marks the session busy (SessionPrompt shape, no agent); context preserves ordinary system text without retired job guidance", async () => {
  const dir = mkdtempSync(join(tmpdir(), "forge-v2-sc-cap-"))
  const { prompt, context } = await setup(dir)
  try {
    // W6a: the real SessionPrompt is {sessionID, messageID, prompt,
    // delivery} — NO agent field; the prompt hook only marks busy.
    await prompt({ sessionID: "ses_f", messageID: "msg_1", prompt: { text: "go" }, delivery: "steer" })
    // Family capture rides the CONTEXT hook (SessionContext.agent).
    const out = { system: ["host system prompt"], options: {} }
    await context({ sessionID: "ses_f", agent: "forge", ...out })
    assert.deepEqual(out.system, ["host system prompt"])
    const worker = { system: [] }
    await context({ sessionID: "ses_worker", agent: "forge-global-research", ...worker })
    assert.doesNotMatch(worker.system.join(" "), /forge_shell|forge_jobs|job-guidance|run_in_background/)
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
    out1.options.reasoningEffort = "TAMPERED"
    await context({ sessionID: "ses_dep1", agent: "forge-depth-research", model: { providerID: "openai", id: "gpt" }, ...out1 })
    assert.equal(out1.options.reasoningEffort, "low", "the frozen pin overwrites tampered options")
    const fresh = { options: {} }
    await context({ sessionID: "ses_dep_fresh", agent: "forge-depth-research", model: { providerID: "openai", id: "gpt" }, ...fresh })
    assert.equal(fresh.options.reasoningEffort, "low", "a fresh session resolves the same pin")
    // Non-forge agent: no depth keys.
    const out3 = { options: {} }
    await context({ sessionID: "ses_dep2", agent: "build", model: { providerID: "openai", id: "gpt" }, ...out3 })
    assert.deepEqual(out3.options, {})
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("v2 session: depth channel fallback matrix", async (t) => {
  v2WiringSeam.resetHostAnchors()
  const dir = poolDir("matrix", {
    unknown: { model: "weird/m", thoughtLevel: "XHigh" },
    unknownlow: { model: "weird/m", thoughtLevel: "low" },
    mixed: { model: "openai/gpt", thoughtLevel: "XHigh" },
    old: { model: "anthropic/claude-4-6", thoughtLevel: "high" },
    adaptive: { model: "anthropic/claude-opus-4-7", thoughtLevel: "xhigh" },
    dead: { model: "anthropic/claude-opus-4-6", thoughtLevel: "ultra" },
  })
  try {
    const warn = t.mock.method(console, "warn", () => {})
    const { context } = await setup(dir)
    const call = async (sid, agent, providerID, id, key = "id") => {
      const options = {}
      await context({ sessionID: sid, agent: `forge-matrix-${agent}`, model: { providerID, [key]: id }, options })
      return options
    }
    assert.deepEqual(await call("matrix-u", "unknown", "weird", "m"), { reasoningEffort: "xhigh" })
    assert.deepEqual(await call("matrix-ulow", "unknownlow", "weird", "m"), { reasoningEffort: "low" })
    assert.deepEqual(await call("matrix-mixed", "mixed", "openai", "gpt"), { reasoningEffort: "xhigh" })
    assert.deepEqual(await call("matrix-old", "old", "anthropic", "claude-4-6"), { thinking: { type: "enabled", budget_tokens: 24576 } })
    assert.deepEqual(await call("matrix-new", "adaptive", "anthropic", "claude-opus-4-7"), { effort: "xhigh" })
    assert.deepEqual(await call("matrix-old-modelid", "old", "anthropic", "claude-4-6", "modelID"), { thinking: { type: "enabled", budget_tokens: 24576 } })
    assert.deepEqual(await call("matrix-new-modelid", "adaptive", "anthropic", "claude-opus-4-7", "modelID"), { effort: "xhigh" })
    assert.deepEqual(warn.mock.calls.filter(c => c.arguments.join(" ").includes("[forge:depth]")), [], "valid channels do not emit a finding")
    assert.deepEqual(await call("matrix-dead", "dead", "anthropic", "claude-opus-4-6"), {})
    assert.deepEqual(await call("matrix-dead", "dead", "openai", "gpt"), {})
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// runtime model pin (v2-runtime-model-pin)

test("v2 model pin: identity-equal rewrite preserves the host variant; a model switch derives variant from a variant-word depth and deletes it otherwise; unpinned/unparsable/missing-model payloads stay untouched", async () => {
  const dir = poolDir("pin", {
    pinned: { model: "glm-coding-worker/glm-5.3", thoughtLevel: "low" },
    deeper: { model: "glm-coding-worker/glm-5.3", thoughtLevel: "high" },
    extreme: { model: "glm-coding-worker/glm-5.3", thoughtLevel: "xhigh" },
    auto: {},
    badpin: { model: "noslash", thoughtLevel: "low" },
  })
  const { context } = await setup(dir)
  try {
    // Identity-equal pin: the rewrite is an invisible no-op — only the
    // spellings normalize and the host-resolved #variant SURVIVES
    // (fix-runtime-model-pin-variant D1).
    const m1 = { providerID: "glm-coding-worker", id: "glm-5.3", variant: "low" }
    const out1 = { options: {} }
    await context({ sessionID: "ses_pin1", agent: "forge-pin-pinned", model: m1, ...out1 })
    assert.equal(m1.providerID, "glm-coding-worker", "providerID rewritten to the pin")
    assert.equal(m1.id, "glm-5.3", "id rewritten to the pin")
    assert.equal(m1.modelID, "glm-5.3", "modelID spelling rewritten too")
    assert.equal(m1.variant, "low", "SAME identity -> the host-resolved variant survives")
    assert.equal(out1.options.reasoningEffort, "low", "thoughtLevel injection unaffected")
    // Model switch + variant-word depth: the variant is DERIVED from the
    // recipe's thoughtLevel (a stale variant of a different model never rides).
    const m2 = { providerID: "opencode", id: "tidepool-alpha-free", variant: "minimal" }
    await context({ sessionID: "ses_pin2", agent: "forge-pin-deeper", model: m2 })
    assert.equal(m2.providerID, "glm-coding-worker", "switch: providerID rewritten")
    assert.equal(m2.variant, "high", "switch + variant word -> variant derived from the recipe depth")
    // Model switch + NON-variant depth word (xhigh): the old variant is
    // deleted (the previous behavior leg).
    const m3 = { providerID: "opencode", id: "tidepool-alpha-free", variant: "minimal" }
    await context({ sessionID: "ses_pin3", agent: "forge-pin-extreme", model: m3 })
    assert.equal(m3.providerID, "glm-coding-worker", "switch: providerID rewritten")
    assert.equal("variant" in m3, false, "switch without a variant word -> source variant deleted")
    // Auto worker (no pin): payload model untouched.
    const m4 = { providerID: "opencode", id: "tidepool-alpha-free" }
    await context({ sessionID: "ses_pin4", agent: "forge-pin-auto", model: m4 })
    assert.equal(m4.providerID, "opencode", "no pin -> untouched")
    assert.equal(m4.id, "tidepool-alpha-free", "no pin -> id untouched")
    // Unparsable pin: skip silently, no throw.
    const m5 = { providerID: "opencode", id: "tidepool-alpha-free" }
    await assert.doesNotReject(context({ sessionID: "ses_pin5", agent: "forge-pin-badpin", model: m5 }))
    assert.equal(m5.providerID, "opencode", "unparsable pin -> untouched")
    // Missing payload model: no throw.
    await assert.doesNotReject(context({ sessionID: "ses_pin6", agent: "forge-pin-pinned" }))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// compaction (goal-brief reinjection)

test("v2 session: compaction reinjects the goal brief for a live-goal forge session; silent otherwise", async () => {
  const dir = mkdtempSync(join(tmpdir(), "forge-v2-sc-goal-"))
  const { state, compaction, context } = await setup(dir)
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
    // The same goal owner under a non-forge speaker must not receive the brief.
    await context({ sessionID: "ses_goal", agent: "build", system: [] })
    const switched = { context: [] }
    await compaction({ sessionID: "ses_goal", agent: "build", ...switched })
    assert.deepEqual(switched.context, [])
    await context({ sessionID: "ses_goal", agent: "forge", system: [] })
    const resumed = { context: [] }
    await compaction({ sessionID: "ses_goal", agent: "forge", ...resumed })
    assert.equal(resumed.context.length, 1)
    assert.match(resumed.context[0], /\[forge:goal-brief\]/)
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
    assert.match(notice, /wait for verified settlement of any outstanding crew rounds before advancing/)
    assert.match(notice, /without polling or sleeping/)
    assert.match(notice, /if globally blocked call goal_pause with the concrete blocker/)
    assert.match(notice, /if independent authorized work remains after a local issue continue that work/)
    assert.match(notice, /already accepted host work may finish/)
    assert.match(notice, /minute budget still runs;.*stop at either budget limit/)
    assert.match(notice, /asks the user/)
    assert.doesNotMatch(notice, /forge_shell|forge_jobs|subagent_type|run_in_background/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Commands (task 4.3)

test("v2 commands: the exact registered set is [crew, forge, goal, plan] — execute-based definitions", async () => {
  const dir = poolDir("cmds", { research: { model: "openai/gpt", thoughtLevel: "low", shape: "readonly" } })
  const { state } = await setup(dir)
  try {
    assert.deepEqual([...state.commands.keys()].sort(), ["crew", "forge", "goal", "plan"])
    for (const name of ["plan", "goal", "crew", "forge"]) {
      const def = state.commands.get(name)
      assert.equal(typeof def.description, "string", `${name} description`)
      assert.equal(typeof def.execute, "function", `${name} is EXECUTE-based (CommandDefinition.execute)`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("v2 commands: /forge stop route delivery — typed \"stop\" composes into the router and the stop lever body rides verbatim", async () => {
  const dir = poolDir("cmdstop", { research: { model: "openai/gpt", thoughtLevel: "low", shape: "readonly" } })
  const { state } = await setup(dir)
  try {
    await state.commands.get("forge").execute({ sessionID: "ses_cmdstop", prompt: { text: "stop" } })
    const sent = state.prompts.find((p) => p.sessionID === "ses_cmdstop")
    assert.ok(sent, "the /forge execute delivered a prompt into the invoking session")
    assert.match(sent.text, /forge stop receipt/)
    assert.match(sent.text, /remaining count unknown/)
    assert.doesNotMatch(sent.text, /forge_jobs|forge_shell/)
    assert.doesNotMatch(sent.text, /forge_sync|Scaffold shape|FAMILY GUARD/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("v2 commands: /plan template carries native reconnaissance and planning discipline", () => {
  const text = PLAN_COMMAND_TEMPLATE
  assert.match(text, /using read\/glob when needed for routing/)
  assert.match(text, /if draft, remain read-only and follow user review and approval below/)
  assert.match(text, /Reconnaissance and alignment \(read-only\): explore with read\/grep\/glob/)
  assert.match(text, /native subagent tool for breadth evidence from effective-readonly forge scouts both BEFORE and DURING the draft/)
  assert.match(text, /current, compatible definition and effective host permissions/)
  assert.match(text, /explicitly readonly recipe, deny all file-mutating tools \(write\/edit\/patch family\), and explicitly deny shell/)
  assert.match(text, /Respect ordinary host permissions/)
  assert.match(text, /all write tools and the builtin shell are DENIED while a draft exists/)
  assert.match(text, /Write-shaped workers, readonly workers with shell, and non-forge agents must wait for approval/)
  assert.match(text, /1-3 focused questions/)
  assert.match(text, /never implement before approval succeeds/)
  assert.match(text, /after approval succeeds, execute directly or dispatch via the native subagent tool, subject to ordinary host permissions/)
  assert.match(text, /call plan_tick with the numbered step immediately after EACH step's work is actually done — never batch ticks/)
  assert.match(text, /multiple sessions or days of multi-file change, or needing multi-round requirement review, is spec work \(e\.g\. OpenSpec\), not plan work/)
  assert.doesNotMatch(text, /\b(?:task|forge_shell|skill)\b/i)
  assert.doesNotMatch(text, /!`/)
})

test("v2 commands: invoking execute sends the byte-identical template into the invoking session", async () => {
  const dir = poolDir("cmdt", { research: { model: "openai/gpt", thoughtLevel: "low", shape: "readonly" } })
  const { ctx, state } = await setup(dir)
  try {
    assert.ok(PLAN_COMMAND_TEMPLATE.startsWith("(forge plan harness routing."), "sanity: the constant is the dist text")
    assert.ok(GOAL_COMMAND_TEMPLATE.startsWith("(forge goal harness routing."))
    // Invoke the executable: it sends the SAME constant text via the flat
    // {sessionID, text} prompt (W6a shape matrix).
    for (const sessionID of ["ses_cmd1", "ses_cmd2", "ses_cmd3"]) state.sessionRecords.set(sessionID, { agent: "forge" })
    await state.commands.get("plan").execute({ sessionID: "ses_cmd1" })
    await state.commands.get("goal").execute({ sessionID: "ses_cmd2" })
    const texts = Object.fromEntries(state.prompts.map((p) => [p.sessionID, p.text]))
    assert.equal(texts.ses_cmd1, PLAN_COMMAND_TEMPLATE.split("\n").filter(line => !line.startsWith("FAMILY GUARD")).join("\n"), "plan template byte-identical")
    assert.equal(texts.ses_cmd2, GOAL_COMMAND_TEMPLATE.split("\n").filter(line => !line.startsWith("FAMILY GUARD")).join("\n"), "goal template byte-identical")
    // Crew composes through the SAME crewOrchestrationTemplate the v1
    // config hook uses; the roster leg names the materialized worker.
    await state.commands.get("crew").execute({ sessionID: "ses_cmd3" })
    const crew = state.prompts.find((p) => p.sessionID === "ses_cmd3")?.text ?? ""
    assert.ok(crew.startsWith("(forge crew"), "roster leg of the crew template")
    assert.match(crew, /CREW ORCHESTRATION discipline/)
    assert.ok(crew.includes("forge-cmdt-research"), "the session-domain roster names the materialized worker")
    assert.match(state.commands.get("crew").description, /register a declared subtask plan.*native subagent calls/)
    assert.match(crew, /execution has NOT started.*END YOUR TURN/)
    assert.match(crew, /native `subagent` calls made together/)
    assert.match(crew, /Children work in the background; use host completion messages and available session evidence/)
    assert.match(crew, /every work round of the previous wave is verified settled/)
    assert.match(crew, /Reuse of a sessionID starts another work round/)
    assert.match(crew, /A diagnostic is not permission to launch another wave/)
    assert.match(crew, /unknown or incomplete evidence cannot establish PASS/)
    assert.match(crew, /existing approval rules/)
    assert.match(crew, /without polling or sleeping/)
    assert.match(crew, /idle or missing sessions, and unresolved outcomes do not establish settlement/)
    assert.match(crew, /A host terminal outcome alone does not establish PASS/)
    assert.match(crew, /Native fallback: when the pool offers no forge worker fitting a subtask/)
    assert.match(crew, /close evidence says it ran native/)
    assert.match(crew, /no configured forge-\* agent matches/)
    assert.doesNotMatch(crew, /non-primary|primary pool|forge_dispatch|\[forge:dispatch-complete\]/)
    for (const phrase of [
      "THE PAUSE", "may come from an approved plan, a spec change, or inline text",
      "mutually exclusive within a wave", "`computer` tool", "abandon: true",
      "optional `lineage` argument", "CONTRACT RELAY", "explicitly carry",
      "never your paraphrase", "NEVER dropped for being too long",
      "close-report evidence statement MUST name the contract",
    ]) assert.ok(crew.includes(phrase), phrase)
    assert.doesNotMatch(crew, /Proceed with the discipline: waves/)
    assert.doesNotMatch(crew, /forge_shell|forge_jobs|subagent_type|run_in_background|native `task`/)
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
    s2.sessionRecords.set("ses_empty", { agent: "forge" })
    await s2.commands.get("crew").execute({ sessionID: "ses_empty" })
    const text = s2.prompts.find((p) => p.sessionID === "ses_empty")?.text ?? ""
    assert.ok(text.includes(".opencode"), "init guidance points at the pool file")
    // Ordinary setup guidance retained from forge-subagents-wiring: no
    // host-config mutation is performed by invoking this command.
    assert.match(text, /CREW IS NOT INITIALIZED/)
    assert.match(text, /ONLY if the user explicitly asks/)
    assert.match(text, /NO host restart is needed/)
    assert.match(text, /thoughtLevel/)
    assert.match(text, /"prompt"/)
    assert.match(text, /SHORT prompt/)
    assert.match(text, /"shape"/)
    assert.match(text, /ABSENT shape defaults to WRITE/)
    assert.match(text, /EXPLICIT `shape`/)
    assert.match(text, /REQUIRED for crew-governed dispatch/)
    assert.match(text, /WITHOUT the `forge-` prefix/)
    assert.match(text, /only the ids `research` and `review` carry built-ins/)
    assert.match(text, /every pool materializes as `forge-<ns>-<id>`/)
    assert.match(text, /the global fallback materializes as `forge-global-<id>`/)
    assert.doesNotMatch(text, /non-primary|primary pool/)
  } finally {
    process.chdir(prevCwd)
    rmSync(empty, { recursive: true, force: true })
  }
})

test("v2 commands: add-only editor uses last add; post config replay wins host collisions", async () => {
  const dir = mkdtempSync(join(tmpdir(), "forge-v2-sc-cmduser-"))
  const { ctx, state } = createV2MockContext()
  const userSync = { name: "forge-sync", template: "USER LEVER", description: "user sync command" }
  state.commands.set(userSync.name, userSync)
  // The mock's add-only editor replaces an earlier same-name add. This is
  // editor-level ordering, not the final host config precedence.
  await ctx.command.transform(async (editor) => {
    editor.add({ name: "plan", description: "the user's own /plan", execute: async () => {} })
  })
  await v2Setup(ctx, { anchors: [dir] })
  try {
    assert.equal(state.commands.get("plan").description.includes("forge plan harness"), true, "forge re-adds over the user def (drift vs v1 create-only)")
    assert.equal(state.commands.get("goal").description.includes("forge goal harness"), true, "siblings still register")

    // Inert model of v2.4.0's post-plugin ConfigCommandPlugin replay: the
    // host registry uses Map.set, so config metadata replaces the collision.
    const pluginForge = state.commands.get("forge")
    assert.ok(pluginForge, "plugin /forge must register")
    assert.strictEqual(state.commands.get("forge-sync"), userSync, "retired user command remains untouched")
    assert.deepEqual(state.commands.get("forge-sync"), { name: "forge-sync", template: "USER LEVER", description: "user sync command" })
    const registry = new Map(state.commands)
    for (const name of ["plan", "goal", "crew"]) {
      assert.ok(state.commands.has(name), `${name} must be registered before host config replay`)
      const configured = { name, description: `configured /${name}`, template: "configured template", agent: "configured-agent" }
      registry.set(configured.name, configured)
      assert.deepEqual(registry.get(name), configured)
    }
    assert.equal(registry.get("forge"), pluginForge, "plugin command remains registered before host collision")
    const userForge = { name: "forge", template: "MINE", description: "user forge command" }
    registry.set(userForge.name, userForge)
    assert.deepEqual(registry.get("forge"), userForge, "host config replay wins /forge collision")
    assert.strictEqual(registry.get("forge-sync"), userSync, "host user /forge-sync survives replay")
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


test("v2 depth catalog: actual setup snapshot drives word/toggle channels, Anthropic family wins, findings are bounded", async (t) => {
  v2WiringSeam.resetHostAnchors()
  const dir = poolDir("catalog-depth", {
    ladder: { model: "zai/ladder", thoughtLevel: "XHigh" },
    matched: { model: "openai/gpt", thoughtLevel: "XHigh" },
    unmatched: { model: "openai/unmatched", thoughtLevel: "xhigh" },
    toggle: { model: "openai/toggle", thoughtLevel: "high" },
    silent: { model: "zai/silent", thoughtLevel: "high" },
    glm: { model: "zai/glm-5.3", thoughtLevel: "xhigh" },
    adaptive: { model: "anthropic/claude-opus-4-7", thoughtLevel: "xhigh" },
    adaptivehigh: { model: "anthropic/claude-opus-4-7", thoughtLevel: "high" },
    adaptivenew: { model: "anthropic/claude-opus-4-8", thoughtLevel: "xhigh" },
    glmcat: { model: "zai-coding-plan/glm-5.3", thoughtLevel: "high" },
    legacy: { model: "anthropic/claude-opus-4-6", thoughtLevel: "high" },
    legacyxhigh: { model: "anthropic/claude-opus-4-6", thoughtLevel: "xhigh" },
    legacyminimal: { model: "anthropic/claude-opus-4", thoughtLevel: "minimal" },
    auto: {},
  })
  const previous = process.env.FORGE_TEST_NO_DISPATCH_FETCH
  process.env.FORGE_TEST_NO_DISPATCH_FETCH = "0"
  t.after(() => {
    if (previous === undefined) delete process.env.FORGE_TEST_NO_DISPATCH_FETCH
    else process.env.FORGE_TEST_NO_DISPATCH_FETCH = previous
    rmSync(dir, { recursive: true, force: true })
  })
  const effort = { reasoning_options: [{ type: "effort", values: ["low", "high", "max"] }] }
  const anthropicEffort = { reasoning_options: [{ type: "effort", values: ["low", "medium", "high"] }] }
  const fetch = t.mock.method(globalThis, "fetch", async () => ({ ok: true, text: async () => JSON.stringify({
    zai: { models: { ladder: effort } },
    openai: { models: { gpt: { reasoning_options: [{ type: "effort", values: ["low", "xhigh"] }] }, unmatched: effort, toggle: { reasoning_options: [{ type: "toggle" }] } } },
    anthropic: { models: { "claude-opus-4-7": anthropicEffort, "claude-opus-4-8": anthropicEffort, "claude-opus-4-6": anthropicEffort, "claude-opus-4": anthropicEffort } },
    "zai-coding-plan": { models: { "glm-5.3": effort } },
  }) }))
  const warn = t.mock.method(console, "warn", () => {})
  const { context } = await setup(dir)
  assert.equal(fetch.mock.callCount(), 1)
  const adaptiveCatalog = v2WiringSeam.modelsDevCatalog()?.providers.anthropic?.models["claude-opus-4-7"]
  assert.equal(adaptiveCatalog?.reasoningShape, "effort")
  assert.deepEqual(adaptiveCatalog?.reasoningOptions, ["low", "medium", "high"])
  const call = async (agent, suffix = "first") => {
    const options = {}
    await context({ sessionID: `catalog-${agent}-${suffix}`, agent: `forge-catalog-depth-${agent}`, model: { providerID: "fixture", id: "fixture" }, options })
    return options
  }
  assert.deepEqual(await call("ladder"), { reasoningEffort: "xhigh" })
  assert.deepEqual(await call("matched"), { reasoningEffort: "xhigh" })
  assert.deepEqual(await call("unmatched"), { reasoningEffort: "xhigh" })
  assert.deepEqual(await call("toggle"), {})
  assert.deepEqual(await call("toggle", "second"), {})
  assert.deepEqual(await call("silent"), {})
  assert.deepEqual(await call("glm"), {})
  assert.deepEqual(await call("adaptive"), { effort: "xhigh" })
  assert.deepEqual(await call("adaptivehigh"), { effort: "high" })
  assert.deepEqual(await call("adaptivenew"), { effort: "xhigh" })
  assert.deepEqual(await call("glmcat"), { reasoningEffort: "high" })
  assert.deepEqual(await call("legacy"), { thinking: { type: "enabled", budget_tokens: 24576 } })
  assert.deepEqual(await call("legacyxhigh"), { thinking: { type: "enabled", budget_tokens: 28672 } })
  assert.deepEqual(await call("legacyminimal"), { thinking: { type: "enabled", budget_tokens: 1024 } })
  assert.deepEqual(await call("auto"), {})
  const findings = warn.mock.calls.map(c => c.arguments.join(" ")).filter(s => s.includes("[forge:depth]"))
  assert.equal(findings.length, 3)
  for (const agent of ["toggle", "silent"]) assert.ok(findings.some(s => s.includes(`forge-catalog-depth-${agent}`) && /high/.test(s) && /toggle/.test(s)))
  assert.ok(findings.some(s => s.includes("forge-catalog-depth-glm") && /xhigh/.test(s) && /toggle/.test(s)))
})

test("v2 depth freeze: hot word fix and model swap reach fresh sessions only", async (t) => {
  v2WiringSeam.resetHostAnchors()
  const legacy = "anthropic/claude-opus-4-6"
  const dir = poolDir("fresh-depth", { fix: { model: legacy, thoughtLevel: "ultra" }, swap: { model: legacy, thoughtLevel: "ultra" } })
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const warn = t.mock.method(console, "warn", () => {})
  const { context } = await setup(dir)
  const call = async (agent, suffix) => {
    const sessionID = `fresh-${agent}-${suffix}`, options = {}
    await context({ sessionID, agent: `forge-fresh-depth-${agent}`, model: { providerID: "anthropic", id: "claude-opus-4-6" }, options })
    return options
  }
  for (const agent of ["fix", "swap"]) {
    assert.deepEqual(await call(agent, "old"), {})
    assert.equal(v2WiringSeam.sessionDepths.get(`fresh-${agent}-old`).translation, null)
  }
  const file = join(dir, ".opencode", "forge.json")
  writeFileSync(file, JSON.stringify({ pool: "fresh-depth", agents: { fix: { model: legacy, thoughtLevel: "high" }, swap: { model: "openai/gpt", thoughtLevel: "ultra" } } }))
  utimesSync(file, 1700000000, 1700000000)
  for (const agent of ["fix", "swap"]) {
    assert.deepEqual(await call(agent, "old"), {})
    assert.equal(v2WiringSeam.sessionDepths.get(`fresh-${agent}-old`).translation, null)
  }
  assert.deepEqual(await call("fix", "new"), { thinking: { type: "enabled", budget_tokens: 24576 } })
  assert.deepEqual(await call("swap", "new"), { reasoningEffort: "ultra" })
  const findings = warn.mock.calls.map(c => c.arguments.join(" ")).filter(s => s.includes("[forge:depth]"))
  assert.equal(findings.length, 2)
  for (const agent of ["fix", "swap"]) assert.ok(findings.some(s => s.includes(`forge-fresh-depth-${agent}`) && /ultra/.test(s) && /budget/.test(s)))
})

test("v2 commands: fresh identity, not tools or cached speaker, gates every route", async () => {
  const dir = mkdtempSync(join(tmpdir(), "forge-command-identity-"))
  const { state, ctx } = await setup(dir)
  try {
    const sid = "ses_identity"
    const visibleTools = ["plan_write", "goal_write", "crew_begin", "forge_sync"]
    for (const [name, text] of [["plan", "resume"], ["goal", "resume"], ["crew", "objective"], ["forge", "sync"], ["forge", "init"], ["forge", "init global"]]) {
      for (const record of [{ agent: "build" }, { agent: "forge-worker" }, { agent: "forge", parentID: "parent" }, {}]) {
        state.sessionRecords.set(sid, record)
        v2WiringSeam.sessionAgents.set(sid, "forge")
        const count = state.prompts.length
        await assert.rejects(state.commands.get(name).execute({ sessionID: sid, prompt: { text }, visibleTools }), /primary forge agent/)
        assert.equal(state.prompts.length, count)
      }
      state.sessionRecords.set(sid, { agent: "forge" })
      for (const tools of [visibleTools, []]) {
        await state.commands.get(name).execute({ sessionID: sid, prompt: { text }, visibleTools: tools })
        assert.doesNotMatch(state.prompts.at(-1).text, /FAMILY GUARD/)
      }
    }
    ctx.session.get = async () => { throw new Error("unavailable") }
    await assert.rejects(state.commands.get("plan").execute({ sessionID: sid }), /primary forge agent/)
    await state.commands.get("forge").execute({ sessionID: sid, prompt: { text: "stop" } })
    assert.match(state.prompts.at(-1).text, /forge stop receipt/)
    assert.equal(state.asserts.length, 0)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// Synthetic HTTP fixture: exercise the real command and local service adapter, not a host E2E.
test("v2 stop: scoped shell DELETE precedes child interrupt and receipt; native list survives unavailable HTTP", async () => {
  const dir = poolDir("stophttp", {})
  const { ctx, state } = await setup(dir)
  const old = process.env.FORGE_SERVICE_FILE, originalFetch = globalThis.fetch
  const file = join(dir, "service.json"), base = "http://127.0.0.1:54321"
  const calls = [], root = "stop-root", child = "stop-child"
  let removed = false, interrupted = false
  const entries = [{ id: child, parentID: root }, { id: "unknown", parentID: root }]
  const list = parent => ({ data: parent === root ? entries : [], cursor: parent === root ? { next: "opaque-page" } : {} })
  ctx.session.get = async () => ({ agent: "build", location: { directory: dir } })
  ctx.session.context = async () => [{ type: "assistant", content: [{ type: "tool", name: "subagent", state: { status: "completed", metadata: { sessionID: child, status: "running" } } }] }]
  ctx.session.interrupt = async ({ sessionID }) => { calls.push(["interrupt", sessionID]); interrupted = true; return { interrupted: true } }
  ctx.session.prompt = async input => { calls.push(["prompt", input.sessionID]); state.prompts.push(input) }
  globalThis.fetch = async (url, opts) => {
    const u = new URL(url)
    assert.equal(u.origin, base)
    assert.equal(opts.headers.authorization, `Basic ${Buffer.from("opencode:test-password").toString("base64")}`)
    if (u.pathname === "/api/session") return Response.json(list(u.searchParams.get("parentID")))
    if (u.pathname === "/api/session/active") return Response.json(interrupted ? {} : { [child]: { type: "running" } })
    assert.equal(u.searchParams.get("location[directory]"), dir)
    if (u.pathname === "/api/shell" && opts.method === "GET") return Response.json(removed ? [] : [{ id: "owned", metadata: { sessionID: child } }, { id: "foreign", metadata: { sessionID: "unknown" } }])
    assert.equal(u.pathname, "/api/shell/owned")
    assert.equal(opts.method, "DELETE")
    calls.push(["delete", "owned"]); removed = true
    return new Response(null, { status: 204 })
  }
  try {
    writeFileSync(file, JSON.stringify({ url: base, password: "test-password" }))
    process.env.FORGE_SERVICE_FILE = file; resetServiceHttpDiscoveryForTests()
    await state.commands.get("forge").execute({ sessionID: root, prompt: { text: "stop" } })
    assert.deepEqual(calls, [["delete", "owned"], ["interrupt", child], ["prompt", root]])
    assert.match(state.prompts.at(-1).text, /remaining count unknown/)
    assert.match(state.prompts.at(-1).text, /confirmed no longer running/)
    calls.length = 0
    process.env.FORGE_SERVICE_FILE = join(dir, "missing.json"); resetServiceHttpDiscoveryForTests()
    ctx.session.list = async ({ parentID }) => list(parentID)
    // A pending lookup must not prevent native stop when no shell channel exists.
    ctx.session.get = async () => new Promise(() => {})
    await state.commands.get("forge").execute({ sessionID: root, prompt: { text: "stop" } })
    assert.ok(calls.some(([op, id]) => op === "interrupt" && id === child))
    assert.ok(calls.every(([op, id]) => op !== "delete" && id !== "unknown"))
    assert.deepEqual(calls.at(-1), ["prompt", root])
    assert.match(state.prompts.at(-1).text, /Shell enumeration unavailable; remaining count unknown/)
    calls.length = 0
    // With HTTP reachable, a hanging directory lookup consumes only the bounded shell phase.
    process.env.FORGE_SERVICE_FILE = file; resetServiceHttpDiscoveryForTests()
    await state.commands.get("forge").execute({ sessionID: root, prompt: { text: "stop" } })
    assert.ok(calls.some(([op, id]) => op === "interrupt" && id === child))
    assert.deepEqual(calls.at(-1), ["prompt", root])
    assert.match(state.prompts.at(-1).text, /Shell enumeration unavailable; remaining count unknown/)
  } finally {
    globalThis.fetch = originalFetch
    if (old === undefined) delete process.env.FORGE_SERVICE_FILE; else process.env.FORGE_SERVICE_FILE = old
    resetServiceHttpDiscoveryForTests(); rmSync(dir, { recursive: true, force: true })
  }
})
