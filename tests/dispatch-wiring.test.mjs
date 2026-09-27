import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { server } from "../plugin.ts"
import { translateDepth } from "../src/dispatch-depth.ts"

// Spec: openspec/changes/add-dispatch-suite/specs/dispatch/spec.md
//   S9  tier agents are hidden, subagent-mode, modelless, task-denied
//   S10 a user-defined forge-<tier> entry is never clobbered
//   S11 one-knob disable removes tiers and the tool
//   S12 depth injection writes reasoningEffort on the first turn, then freezes
//   S13 unknown provider shape => nothing injected
//   S18 draft-plan interop => forge_dispatch refused while a draft is active
//   S20 worker prompt discipline (three mandates, shape-differentiated)
// add-dispatch-onboarding: agent materialization from forge.json (seed when
// unconfigured; legacy tier agents only when inline options exist).

process.env.FORGE_TEST_NO_FENCE = "1"
// Redirect the forge.json global path away from the real user home.
process.env.FORGE_TEST_FORGE_HOME = mkdtempSync(join(tmpdir(), "forge-wiring-home-"))

const worktree = mkdtempSync(join(tmpdir(), "forge-dispatch-wiring-"))
process.on("exit", () => {
  for (const d of [worktree, process.env.FORGE_TEST_FORGE_HOME]) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {}
  }
})

const input = (dir = worktree) => ({
  client: { session: {} },
  project: { id: "p" },
  directory: dir,
  worktree: dir,
  serverUrl: new URL("http://127.0.0.1:1"),
  $: () => {},
})

const allowCtx = (sessionID) => ({
  sessionID,
  ask: async () => ({ status: "allow" }),
  metadata: () => {},
  message: async () => {},
})

const emptyCfg = () => ({ agent: {}, command: {}, permission: {} })

// ---------------------------------------------------------------------------
// 4.1 agent materialization from forge.json.

const seedAgentShape = (a, label) => {
  assert.ok(a, `${label} must be injected`)
  assert.equal(a.hidden, true, `${label} must be hidden`)
  assert.equal(a.mode, "subagent", `${label} must be a subagent`)
  assert.equal("model" in a, false, `${label} must NEVER carry a model field`)
  assert.equal(a.permission.task, "deny", `${label} must deny task (physical recursion ban)`)
  assert.ok(a.description, `${label} carries a description`)
  assert.ok(a.prompt, `${label} carries a role prompt`)
}

test("4.1 unconfigured: the seed materializes research/review, readonly + task-denied, and NO legacy tier agents", async (t) => {
  const h = await server(input(), {})
  t.after(() => h.dispose?.())
  const cfg = emptyCfg()
  await h.config(cfg)

  seedAgentShape(cfg.agent["forge-research"], "forge-research")
  seedAgentShape(cfg.agent["forge-review"], "forge-review")
  assert.match(cfg.agent["forge-research"].prompt, /research/i)
  // seed is readonly: mutating tools denied
  for (const tool of ["write", "edit", "bash"]) {
    assert.equal(cfg.agent["forge-research"].permission[tool], "deny")
    assert.equal(cfg.agent["forge-review"].permission[tool], "deny")
  }
  // zero inline config => no legacy-only tier agents in the Tab cycle
  // (forge-review exists but comes from the seed, not the legacy tier map)
  for (const tier of ["scout", "build", "quick"]) {
    assert.equal(cfg.agent[`forge-${tier}`], undefined, `no legacy forge-${tier} without inline options`)
  }
})

test("4.1 a project forge.json materializes custom agents with prompt/shape/permission layers", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "forge-wiring-proj-"))
  t.after(() => {
    try { rmSync(dir, { recursive: true, force: true }) } catch {}
  })
  mkdirSync(join(dir, ".opencode"), { recursive: true })
  writeFileSync(
    join(dir, ".opencode", "forge.json"),
    `{
  "agents": {
    "auditor": {
      "model": "zai/glm-5.3",
      "depths": ["low", "medium"],
      "prompt": "You are a dependency auditor; check licenses.",
      "shape": "write",
      "permission": { "bash": "deny" }
    },
    "plain": { "model": "x/y", "depths": ["low"] }
  }
}`,
  )
  const h = await server(input(dir), {})
  t.after(() => h.dispose?.())
  const cfg = emptyCfg()
  await h.config(cfg)

  seedAgentShape(cfg.agent["forge-auditor"], "forge-auditor")
  assert.match(cfg.agent["forge-auditor"].prompt, /dependency auditor/)
  // write shape: mutating tools NOT denied by shape...
  assert.equal(cfg.agent["forge-auditor"].permission.write, undefined)
  // ...but the explicit permission override IS honored...
  assert.equal(cfg.agent["forge-auditor"].permission.bash, "deny")
  // ...and task stays denied regardless
  assert.equal(cfg.agent["forge-auditor"].permission.task, "deny")

  // a custom agent without prompt gets the generic worker prompt, defaults readonly
  seedAgentShape(cfg.agent["forge-plain"], "forge-plain")
  assert.match(cfg.agent["forge-plain"].prompt, /forge-plain/)
  assert.equal(cfg.agent["forge-plain"].permission.bash, "deny")
  // seed agents do NOT leak in when a project file exists
  assert.equal(cfg.agent["forge-research"], undefined, "single source — no seed merge")
})

test("4.1 a user-defined forge-<agent> entry is never clobbered", async (t) => {
  const h = await server(input(), {})
  t.after(() => h.dispose?.())
  const cfg = emptyCfg()
  cfg.agent["forge-research"] = { description: "mine", mode: "subagent", prompt: "keep me" }
  await h.config(cfg)
  assert.equal(cfg.agent["forge-research"].prompt, "keep me")
  assert.equal(cfg.agent["forge-research"].description, "mine")
  assert.equal(cfg.agent["forge-research"].permission, undefined)
})

test("4.1 a broken forge.json falls back to the seed agents", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "forge-wiring-broken-"))
  t.after(() => {
    try { rmSync(dir, { recursive: true, force: true }) } catch {}
  })
  mkdirSync(join(dir, ".opencode"), { recursive: true })
  writeFileSync(join(dir, ".opencode", "forge.json"), `{ broken`)
  const h = await server(input(dir), {})
  t.after(() => h.dispose?.())
  const cfg = emptyCfg()
  await h.config(cfg)
  seedAgentShape(cfg.agent["forge-research"], "forge-research (seed fallback)")
})

test("S9 (legacy): inline dispatch options materialize tier agents hidden, subagent, modelless, task-denied", async (t) => {
  const h = await server(input(), { dispatch: { roster: [{ model: "zai/glm-5.3", expose: ["low", "max"], profiles: ["scout", "build", "review", "quick"] }] } })
  t.after(() => h.dispose?.())
  const cfg = emptyCfg()
  await h.config(cfg)

  for (const tier of ["scout", "build", "review", "quick"]) {
    const id = `forge-${tier}`
    const a = cfg.agent[id]
    assert.ok(a, `${id} must be injected`)
    assert.equal(a.hidden, true, `${id} must be hidden`)
    assert.equal(a.mode, "subagent", `${id} must be a subagent`)
    assert.equal("model" in a, false, `${id} must NEVER carry a model field`)
    assert.equal(a.permission.task, "deny", `${id} must deny task (physical recursion ban)`)
    assert.ok(a.description, `${id} carries a description`)
    assert.ok(a.prompt, `${id} carries a discipline prompt`)
  }
  // shape discipline: readonly tiers deny mutating tools, build/quick deny only via task + write ban is toolset-based
  for (const tool of ["write", "edit", "bash"]) {
    assert.equal(cfg.agent["forge-scout"].permission[tool], "deny", `scout must deny ${tool}`)
    assert.equal(cfg.agent["forge-review"].permission[tool], "deny", `review must deny ${tool}`)
  }
  // build/quick are write tiers: mutating tools allowed at agent level (their
  // discipline governs use), but task stays denied
  assert.equal(cfg.agent["forge-build"].permission.write, undefined)
  assert.equal(cfg.agent["forge-build"].permission.task, "deny")
})

test("S10 (legacy): a user-defined forge-<tier> entry is never clobbered", async (t) => {
  const h = await server(input(), { dispatch: { roster: [{ model: "zai/glm-5.3", expose: ["low", "max"], profiles: ["build"] }] } })
  t.after(() => h.dispose?.())
  const cfg = emptyCfg()
  cfg.agent["forge-build"] = { description: "mine", mode: "subagent", prompt: "keep me" }
  await h.config(cfg)
  assert.equal(cfg.agent["forge-build"].prompt, "keep me")
  assert.equal(cfg.agent["forge-build"].description, "mine")
  assert.equal(cfg.agent["forge-build"].permission, undefined)
})

test("S11: agent.forge.disable removes tiers, and dispatch.disable skips tier injection", async (t) => {
  const h1 = await server(input(), {})
  t.after(() => h1.dispose?.())
  const cfg1 = emptyCfg()
  cfg1.agent.forge = { disable: true }
  await h1.config(cfg1)
  assert.equal(cfg1.agent["forge-scout"], undefined, "no tier agents when forge is disabled")
  assert.equal(h1.tool.forge_dispatch, undefined, "no dispatch tool when forge is disabled")

  const h2 = await server(input(), { dispatch: { disable: true } })
  t.after(() => h2.dispose?.())
  const cfg2 = emptyCfg()
  await h2.config(cfg2)
  assert.equal(cfg2.agent["forge-scout"], undefined, "dispatch.disable skips tier injection")
  assert.equal(h2.tool.forge_dispatch, undefined, "dispatch.disable removes the tool")
})

test("S12/S13: chat.params injects the same translation on every request of the session, frozen", async (t) => {
  const h = await server(input(), {})
  t.after(() => h.dispose?.())
  assert.ok(h["chat.params"], "chat.params hook must be registered")

  const inject = h.__forgeDispatchTest?.queueDepth
  assert.ok(inject, "test seam must exist")
  inject("ses_dp", translateDepth("low", "openai", ["low", "high", "max"]))

  // options are rebuilt by the host for EVERY LLM request; the hook must
  // re-apply the SAME translation each time (inject-once would lose the depth
  // on turn 2) — "frozen" means it never changes after registration.
  const out1 = { options: {} }
  await h["chat.params"]({ sessionID: "ses_dp", provider: { id: "openai" } }, out1)
  assert.equal(out1.options.reasoningEffort, "low", "first turn writes the effort word")
  const out2 = { options: {} }
  await h["chat.params"]({ sessionID: "ses_dp", provider: { id: "openai" } }, out2)
  assert.equal(out2.options.reasoningEffort, "low", "same translation re-applied (stable across turns)")

  // re-registering a different translation mid-session is refused (stability)
  assert.equal(inject("ses_dp", translateDepth("max", "openai", ["low", "high", "max"])), false, "translation is frozen after first registration")

  // budget family: the published tier lands as the thinking option
  inject("ses_dp4", translateDepth("high", "anthropic", null))
  const outBudget = { options: {} }
  await h["chat.params"]({ sessionID: "ses_dp4", provider: { id: "anthropic" } }, outBudget)
  assert.deepEqual(outBudget.options.thinking, { type: "enabled", budget_tokens: 24576 })

  // B23 (TUI-pollution regression): a DIFFERENT session on the same serve,
  // same provider family, must not see another session's depth — injection
  // is keyed strictly by the dispatch child's sessionID.
  inject("ses_dp3", translateDepth("low", "openai", ["low", "high", "max"]))
  const outOther = { options: {} }
  await h["chat.params"]({ sessionID: "ses_unrelated", provider: { id: "openai" } }, outOther)
  assert.equal(outOther.options.reasoningEffort, undefined, "no cross-session depth leak")
  assert.equal(outOther.options.thinking, undefined, "no cross-session depth leak (thinking)")

  // unknown provider shape: nothing injected for that session (B21 semantics)
  inject("ses_dp2", translateDepth("high", "unknown", null))
  const out3 = { options: {} }
  await h["chat.params"]({ sessionID: "ses_dp2", provider: { id: "mystery-provider" } }, out3)
  assert.equal(out3.options.reasoningEffort, undefined)
  assert.equal(out3.options.thinking, undefined)
  assert.equal(h.__forgeDispatchTest.depthState("ses_dp2").kind, "not-injected", "unknown family recorded for honest disclosure")
})

test("S20: worker prompt template carries the three mandates and differentiates shapes", async (t) => {
  const h = await server(input(), {})
  t.after(() => h.dispose?.())
  const compose = h.__forgeDispatchTest?.composePrompt
  assert.ok(compose, "test seam must exist")

  const ro = compose({ prompt: "find all TODOs", tier: "scout", shape: "readonly" })
  assert.match(ro, /find all TODOs/)
  assert.match(ro, /workspace[- ]relative/i, "relative-path mandate")
  assert.match(ro, /verbatim/i, "verbatim refusal reporting mandate")
  assert.match(ro, /evidence/i, "evidence mandate")
  assert.match(ro, /report/i, "readonly tiers are told to report, not work around")

  const wr = compose({ prompt: "fix the bug", tier: "build", shape: "write" })
  assert.match(wr, /fix the bug/)
  assert.doesNotMatch(wr, /you are a readonly/i)
  // the two shapes' templates differ
  assert.notEqual(ro, wr)
})

test("S18: forge_dispatch is refused during a plan draft and allowed after approval", async (t) => {
  const h = await server(input(), {})
  t.after(() => h.dispose?.())

  // stub engine: the ban must fire before the engine is ever reached
  let engineCalls = 0
  h.__forgeDispatchTest?.setEngine({
    dispatch: async () => {
      engineCalls++
      return { tier: "scout", requested: { profile: "scout" }, actual: { model: "x/y", depth: "low" }, sessionID: "s", durationMs: 1, tokens: {}, costUsd: null, text: "ok" }
    },
    dispose: async () => {},
  })

  // create a real draft via plan_write (writes under the temp worktree)
  await h.tool.plan_write.execute(
    {
      goal: "wiring draft",
      context: "found things (src/a.ts:1)",
      approach: "do X; rejected Y because Z",
      tasks: ["step one"],
      risks: "none notable",
      acceptance: ["file exists"],
    },
    allowCtx("ses_ban"),
  )

  const before = { tool: "forge_dispatch" }
  await assert.rejects(
    () => h["tool.execute.before"]({ tool: "forge_dispatch", sessionID: "ses_ban" }, { args: {} }),
    /plan_approve|discard/,
    "draft must refuse forge_dispatch",
  )
  await assert.rejects(() => h.tool.forge_dispatch.execute({ prompt: "p", agent: "scout", depth: "low" }, allowCtx("ses_ban")))
  assert.equal(engineCalls, 0, "engine must never be reached during draft")

  await h.tool.plan_approve.execute({}, allowCtx("ses_ban"))
  await h["tool.execute.before"]({ tool: "forge_dispatch", sessionID: "ses_ban" }, { args: {} })
  await h.tool.forge_dispatch.execute({ prompt: "p", agent: "scout", depth: "low" }, allowCtx("ses_ban"))
  assert.equal(engineCalls, 1, "engine runs after approval")
})

test("forge_dispatch result object passes through the engine report with a title", async (t) => {
  const h = await server(input(), {})
  t.after(() => h.dispose?.())
  h.__forgeDispatchTest?.setEngine({
    dispatch: async (req) => ({
      agent: req.agent,
      requested: { agent: req.agent, depth: req.depth },
      actual: { model: "zai/glm", depth: req.depth ?? "low" },
      sessionID: "ses_child",
      durationMs: 42,
      tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
      costUsd: 0.01,
      text: "worker concluded",
      depthTranslation: "verbatim",
    }),
    dispose: async () => {},
  })
  const r = await h.tool.forge_dispatch.execute({ prompt: "go", agent: "scout", depth: "low" }, allowCtx("ses_wiring"))
  assert.match(r.title, /scout/)
  assert.match(r.output, /zai\/glm/)
  assert.match(r.output, /worker concluded/)
  assert.match(r.output, /ses_child/)
  assert.match(r.output, /depthTranslation: verbatim/)
})

// ---------------------------------------------------------------------------
// 3.3/3.4 waves wiring: background tool branch, list/kill tools, coalesced
// completion wake briefs (single brief, exactly-once, parent-scoped).
// ---------------------------------------------------------------------------
import { DispatchError } from "../src/dispatch-engine.ts"

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms))

const wakeInput = (calls, status) => ({
  client: {
    session: {
      promptAsync: async (o) => calls.push({ kind: "promptAsync", o }),
      prompt: async (o) => calls.push({ kind: "prompt", o }),
      get: async () => undefined,
      status: status ?? (async () => ({})),
    },
  },
  project: { id: "p" },
  directory: worktree,
  worktree,
  serverUrl: new URL("http://127.0.0.1:1"),
  $: () => {},
})

test("3.4: forge_dispatch background:true returns the handle; the engine gets background:true", async (t) => {
  process.env.FORGE_DISPATCH_WAKE_DEBOUNCE_MS = "20"
  const h = await server(wakeInput([]), {})
  t.after(() => h.dispose?.())
  await h.config(emptyCfg())
  let seenOpts
  h.__forgeDispatchTest?.setEngine({
    dispatch: async (req, parent, opts) => {
      seenOpts = opts
      return { dispatchId: "bg-77", tier: req.profile, requested: { profile: req.profile, depth: req.depth }, resolved: "zai/glm", depth: req.depth ?? "low", queuedAt: "2026-09-27T00:00:00.000Z" }
    },
    kill: () => {},
    dispose: async () => {},
  })
  const r = await h.tool.forge_dispatch.execute({ prompt: "go", profile: "quick", depth: "low", background: true }, allowCtx("ses_bg"))
  assert.deepEqual(seenOpts, { background: true }, "the background flag must reach the engine")
  assert.match(r.output, /bg-77/)
  assert.match(r.output, /queuedAt/)
  assert.match(r.output, /forge_dispatch_list/, "the handle points at the tracking tool")
  assert.match(h.tool.forge_dispatch.description, /opencode run/, "run-mode disclosure in the tool description")
  assert.match(h.tool.forge_dispatch.description, /TUI/, "TUI targeting disclosed")
})

test("3.4: forge_dispatch_list lists in-flight and terminal entries from the registry", async (t) => {
  const h = await server(wakeInput([]), {})
  t.after(() => h.dispose?.())
  await h.config(emptyCfg())
  const reg = h.__forgeDispatchTest?.registry()
  assert.ok(reg, "registry seam must exist after the config hook")
  const tag = `lst-${Math.random().toString(36).slice(2, 7)}`
  const a = reg.submit({ sessionID: `ses_${tag}_c1`, identity: "zai/glm", depth: "low", tier: "quick", parentSessionID: `ses_${tag}` })
  reg.markRunning(a.dispatchId)
  const b = reg.submit({ sessionID: `ses_${tag}_c2`, identity: "zai/glm", depth: "low", tier: "scout", parentSessionID: `ses_${tag}` })
  reg.markCompleted(b.dispatchId, { text: `done-${tag}`, tokens: { input: 1 } })
  const r = await h.tool.forge_dispatch_list.execute({}, allowCtx(`ses_${tag}`))
  assert.match(r.output, new RegExp(a.dispatchId))
  assert.match(r.output, new RegExp(b.dispatchId))
  assert.match(r.output, new RegExp(`done-${tag}`), "terminal entries carry the full result object")
  assert.match(r.output, /In flight/)
})

test("3.4: forge_dispatch_kill routes to the engine; failures surface with their code", async (t) => {
  const h = await server(wakeInput([]), {})
  t.after(() => h.dispose?.())
  await h.config(emptyCfg())
  const killed = []
  h.__forgeDispatchTest?.setEngine({
    dispatch: async () => { throw new Error("unused") },
    kill: (id) => {
      if (id === "bg-broken") throw new DispatchError("forge_dispatch_kill refused: dispatch bg-broken already completed; use forge_dispatch_list for its result.", "kill-failed")
      killed.push(id)
    },
    dispose: async () => {},
  })
  const ok = await h.tool.forge_dispatch_kill.execute({ dispatchId: "bg-9" }, allowCtx("ses_kill"))
  assert.match(ok.output, /bg-9.*killed/)
  assert.deepEqual(killed, ["bg-9"])
  await assert.rejects(
    () => h.tool.forge_dispatch_kill.execute({ dispatchId: "bg-broken" }, allowCtx("ses_kill")),
    (err) => {
      assert.match(err.message, /forge:dispatch:kill-failed/)
      assert.match(err.message, /already completed/)
      return true
    },
  )
})

test("3.3: one idle yields ONE coalesced [forge:dispatch-complete] brief, exactly once", async (t) => {
  process.env.FORGE_DISPATCH_WAKE_DEBOUNCE_MS = "20"
  const calls = []
  const h = await server(wakeInput(calls), {})
  t.after(() => h.dispose?.())
  await h.config(emptyCfg())
  const reg = h.__forgeDispatchTest?.registry()
  const tag = `wk-${Math.random().toString(36).slice(2, 7)}`
  const parent = `ses_${tag}`
  const a = reg.submit({ sessionID: `${parent}_c1`, identity: "zai/glm", depth: "low", tier: "quick", parentSessionID: parent })
  reg.markRunning(a.dispatchId)
  reg.markCompleted(a.dispatchId, { text: `report-${tag}`, costUsd: 0 })
  const b = reg.submit({ sessionID: `${parent}_c2`, identity: "zai/glm", depth: "high", tier: "build", parentSessionID: parent })
  reg.markTimeout(b.dispatchId, { error: `timed out-${tag}` })

  await h.event({ event: { type: "session.idle", properties: { sessionID: parent } } })
  await sleepMs(150)
  const briefs = calls.filter((c) => JSON.stringify(c.o).includes("[forge:dispatch-complete]"))
  assert.equal(briefs.length, 1, "exactly one brief for the idle")
  const text = JSON.stringify(briefs[0].o)
  assert.match(text, new RegExp(a.dispatchId))
  assert.match(text, new RegExp(b.dispatchId))
  assert.match(text, new RegExp(`report-${tag}`), "full result object rides the brief")
  assert.match(text, new RegExp(`timed out-${tag}`), "timeout reports ride the brief too")

  // a second idle must not re-deliver (exactly-once)
  await h.event({ event: { type: "session.idle", properties: { sessionID: parent } } })
  await sleepMs(120)
  assert.equal(calls.filter((c) => JSON.stringify(c.o).includes("[forge:dispatch-complete]")).length, 1, "no re-delivery on the next idle")
})

test("3.3: another parent's terminals are never delivered on this session's idle", async (t) => {
  process.env.FORGE_DISPATCH_WAKE_DEBOUNCE_MS = "20"
  const calls = []
  const h = await server(wakeInput(calls), {})
  t.after(() => h.dispose?.())
  await h.config(emptyCfg())
  const reg = h.__forgeDispatchTest?.registry()
  const tag = `sc-${Math.random().toString(36).slice(2, 7)}`
  const e = reg.submit({ sessionID: `${tag}_c`, identity: "zai/glm", depth: "low", tier: "quick", parentSessionID: `ses_other_${tag}` })
  reg.markCompleted(e.dispatchId, { text: "x" })

  await h.event({ event: { type: "session.idle", properties: { sessionID: `ses_unrelated_${tag}` } } })
  await sleepMs(120)
  assert.equal(calls.filter((c) => JSON.stringify(c.o).includes("[forge:dispatch-complete]")).length, 0, "no cross-parent delivery")
  // cleanup so later drains are not polluted
  reg.takeUndelivered(`ses_other_${tag}`)
})

// B34: a completion landing while the parent's turn is still active must NOT
// be delivered mid-turn — spec: briefs "SHALL never interrupt an active turn
// (delivery waits for the next idle)". A wake firing during a busy window
// must leave the entries undelivered so the NEXT idle delivers them once.
test("B34: a brief never interrupts an active turn — busy status defers delivery to the next idle", async (t) => {
  process.env.FORGE_DISPATCH_WAKE_DEBOUNCE_MS = "20"
  const calls = []
  let busy = true
  const h = await server(wakeInput(calls, async (o) => ({ [o.path.id]: { type: busy ? "busy" : "idle" } })), {})
  t.after(() => h.dispose?.())
  await h.config(emptyCfg())
  const reg = h.__forgeDispatchTest?.registry()
  const tag = `b34-${Math.random().toString(36).slice(2, 7)}`
  const parent = `ses_${tag}`
  const e = reg.submit({ sessionID: `${parent}_c`, identity: "zai/glm", depth: "low", tier: "quick", parentSessionID: parent })
  reg.markRunning(e.dispatchId)
  reg.markCompleted(e.dispatchId, { text: `done-${tag}`, costUsd: 0 })

  await h.event({ event: { type: "session.idle", properties: { sessionID: parent } } })
  await sleepMs(150)
  assert.equal(
    calls.filter((c) => JSON.stringify(c.o).includes("[forge:dispatch-complete]")).length, 0,
    "busy session: no mid-turn delivery, entries stay undelivered",
  )

  busy = false
  await h.event({ event: { type: "session.idle", properties: { sessionID: parent } } })
  await sleepMs(150)
  const briefs = calls.filter((c) => JSON.stringify(c.o).includes("[forge:dispatch-complete]"))
  assert.equal(briefs.length, 1, "delivered exactly once, at the idle that follows")
  assert.match(JSON.stringify(briefs[0].o), new RegExp(`done-${tag}`), "the deferred result rides that brief")
})

// ---------------------------------------------------------------------------
// 4.1/4.2 crew: /crew command registration (no-clobber), crew_begin refusals
// (draft, singleton), crew_close gate (gaps refuse without asking; valid
// report asks once, appends the summary, ends the crew).
// ---------------------------------------------------------------------------
import { appendFileSync } from "node:fs"

const recordingCtx = (sessionID, asks) => ({
  sessionID,
  ask: async (o) => {
    asks.push(o)
    return { status: "allow" }
  },
  metadata: () => {},
  message: async () => {},
})

test("4.1: /crew command registers with the discipline template; a user command is never clobbered", async (t) => {
  const h = await server(input(), {})
  t.after(() => h.dispose?.())
  const cfg = emptyCfg()
  await h.config(cfg)
  assert.ok(cfg.command.crew, "/crew must be registered")
  assert.match(cfg.command.crew.template, /crew_begin/)
  assert.match(cfg.command.crew.template, /waves/i)
  assert.match(cfg.command.crew.template, /crew_close/)
  assert.match(cfg.command.crew.template, /at most once|RETRY AT MOST ONCE/i)

  const h2 = await server(input(), {})
  t.after(() => h2.dispose?.())
  const cfg2 = emptyCfg()
  cfg2.command.crew = { template: "mine", description: "user's own" }
  await h2.config(cfg2)
  assert.equal(cfg2.command.crew.template, "mine", "user command is never clobbered")
})

test("4.1: crew_begin refuses a second crew and refuses during a draft plan", async (t) => {
  // fresh worktree: plan state on disk is per-worktree, and S18 already
  // leaves an APPROVED plan in the shared module worktree
  const wt = mkdtempSync(join(tmpdir(), "forge-crew-"))
  t.after(() => { try { rmSync(wt, { recursive: true, force: true }) } catch {} })
  const crewInput = () => ({ client: { session: {} }, project: { id: "p" }, directory: wt, worktree: wt, serverUrl: new URL("http://127.0.0.1:1"), $: () => {} })
  const h = await server(crewInput(), {})
  t.after(() => h.dispose?.())
  const cfg = emptyCfg()
  await h.config(cfg)

  await h.tool.crew_begin.execute({ objective: "first crew" }, allowCtx("ses_crew"))
  await assert.rejects(
    () => h.tool.crew_begin.execute({ objective: "second crew" }, allowCtx("ses_crew")),
    (err) => {
      assert.match(err.message, /already has an active crew/)
      assert.match(err.message, /first crew/)
      return true
    },
  )

  // a DIFFERENT session is free (session-bound state)
  await h.tool.crew_begin.execute({ objective: "other session crew" }, allowCtx("ses_crew2"))

  // draft refusal: real draft via plan_write, then begin is denied
  await h.tool.plan_write.execute(
    { goal: "draft blocks crew", context: "found (src/a.ts:1)", approach: "do X; rejected Y because Z", tasks: ["s"], risks: "none", acceptance: ["file"] },
    allowCtx("ses_crew3"),
  )
  await assert.rejects(
    () => h.tool.crew_begin.execute({ objective: "during draft" }, allowCtx("ses_crew3")),
    /plan_approve|discard/,
  )
})

test("4.2: crew_close refuses gaps WITHOUT asking the user; the crew stays active", async (t) => {
  const h = await server(input(), {})
  t.after(() => h.dispose?.())
  await h.config(emptyCfg())
  const asks = []
  await h.tool.crew_begin.execute({ objective: "gappy crew" }, recordingCtx("ses_gap", asks))

  // missing verdict
  await assert.rejects(
    () => h.tool.crew_close.execute({ report: [{ title: "a", verdict: "", evidence: "bg-1" }] }, recordingCtx("ses_gap", asks)),
    (err) => { assert.match(err.message, /refused/); assert.match(err.message, /PASS or FAIL/); return true },
  )
  // dispatched-but-dropped: ledger has bg-2, report does not
  const ledgerPath = join(h.__forgeDispatchTest.dispatchLogDir(), "ledger.jsonl")
  appendFileSync(ledgerPath, JSON.stringify({ ts: new Date().toISOString(), event: "completed", dispatchId: "bg-1", parentSessionID: "ses_gap", tokens: { input: 5, output: 2, reasoning: 0, cache: { read: 0, write: 0 } }, costUsd: 0.01 }) + "\n")
  appendFileSync(ledgerPath, JSON.stringify({ ts: new Date().toISOString(), event: "completed", dispatchId: "bg-2", parentSessionID: "ses_gap", tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } }) + "\n")
  await assert.rejects(
    () => h.tool.crew_close.execute({ report: [{ title: "a", verdict: "PASS", evidence: "bg-1" }] }, recordingCtx("ses_gap", asks)),
    (err) => { assert.match(err.message, /bg-2/); assert.match(err.message, /silently dropped/); return true },
  )
  assert.equal(asks.length, 0, "refusals must not bother the user with an ask dialog")
  const crews = h.__forgeDispatchTest.crews()
  assert.ok(crews.has("ses_gap"), "the crew stays active after a refused close")
})

test("4.2: crew_close with full evidence asks once, appends the summary, ends the crew", async (t) => {
  const h = await server(input(), {})
  t.after(() => h.dispose?.())
  await h.config(emptyCfg())
  const asks = []
  const crewSession = `ses_close_${Math.random().toString(36).slice(2, 7)}`
  await h.tool.crew_begin.execute({ objective: "clean close" }, recordingCtx(crewSession, asks))
  const ledgerPath = join(h.__forgeDispatchTest.dispatchLogDir(), "ledger.jsonl")
  appendFileSync(ledgerPath, JSON.stringify({ ts: new Date().toISOString(), event: "completed", dispatchId: "bg-9", parentSessionID: crewSession, tokens: { input: 10, output: 4, reasoning: 2, cache: { read: 0, write: 0 } }, costUsd: 0.02 }) + "\n")
  const r = await h.tool.crew_close.execute(
    { report: [{ title: "only", verdict: "PASS", evidence: "dispatch bg-9 verified the file" }] },
    recordingCtx(crewSession, asks),
  )
  assert.equal(asks.length, 1, "exactly one ask-level confirmation")
  assert.match(asks[0].permission, /crew_close/)
  assert.match(r.output, /PASS 1, FAIL 0/)
  assert.match(r.output, /dispatch ledger/)
  assert.equal(h.__forgeDispatchTest.crews().has(crewSession), false, "the crew ends")
  // the summary landed in the ledger
  const { readFileSync: rf } = await import("node:fs")
  const text = rf(ledgerPath, "utf8")
  assert.match(text, /crew-summary/)
  assert.match(text, /clean close/)
  // a second close now refuses: no active crew
  await assert.rejects(
    () => h.tool.crew_close.execute({ report: [{ title: "only", verdict: "PASS", evidence: "bg-9" }] }, recordingCtx(crewSession, asks)),
    /No active crew/,
  )
})

// ---------------------------------------------------------------------------
// Battle II spot probes: B43 run-mode disclosure, B47 crew restart honesty,
// B48 wave pacing discipline.
// ---------------------------------------------------------------------------
test("B43: the tool description discloses run-mode background limits in full", async (t) => {
  const h = await server(input(), {})
  t.after(() => h.dispose?.())
  const d = h.tool.forge_dispatch.description
  assert.match(d, /Background mode targets live TUI sessions/, "background is a TUI feature")
  assert.match(d, /prefer sync|sync mode is preferred/, "run mode is pointed at sync")
  // the ledger-only facet is disclosed on the background arg (same tool surface)
  const bgDesc = String(h.tool.forge_dispatch.args?.background?.description ?? "")
  assert.match(bgDesc, /ledger-only/, "post-session completions are ledger-only")
})

test("B47: crew state dies with the process — a restart starts clean, the ledger keeps the history", async (t) => {
  const h = await server(input(), {})
  t.after(() => h.dispose?.())
  await h.config(emptyCfg())
  const crewSession = `ses_restart_${Math.random().toString(36).slice(2, 7)}`
  await h.tool.crew_begin.execute({ objective: "pre-crash crew" }, allowCtx(crewSession))
  assert.ok(h.__forgeDispatchTest.crews().has(crewSession))

  // Simulate host death: crews are process memory and nothing else — clear it.
  h.__forgeDispatchTest.crews().clear()

  // New /crew on the same session starts clean, with no memory of the old one.
  await h.tool.crew_begin.execute({ objective: "post-restart crew" }, allowCtx(crewSession))
  const c = h.__forgeDispatchTest.crews().get(crewSession)
  assert.equal(c.objective, "post-restart crew", "no residual crew state leaks across a restart")
})

test("B48: the crew discipline mandates wave pacing — never past the cap, next batch only on briefs", async (t) => {
  const h = await server(input(), {})
  t.after(() => h.dispose?.())
  const cfg = emptyCfg()
  await h.config(cfg)
  const tpl = cfg.command.crew.template
  assert.match(tpl, /WAVES, NEVER FLOODS/, "the pacing rule is named")
  assert.match(tpl, /no larger than the concurrency cap/, "batches are capped")
  assert.match(tpl, /\[forge:dispatch-complete\]/, "the next batch keys on completion briefs")
})
