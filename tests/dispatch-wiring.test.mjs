import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { server } from "../plugin.ts"

// Spec: openspec/changes/add-dispatch-suite/specs/dispatch/spec.md
//   S9  tier agents are hidden, subagent-mode, modelless, task-denied
//   S10 a user-defined forge-<tier> entry is never clobbered
//   S11 one-knob disable removes tiers and the tool
//   S12 depth injection writes reasoningEffort on the first turn, then freezes
//   S13 unknown provider shape => nothing injected
//   S18 draft-plan interop => forge_dispatch refused while a draft is active
//   S20 worker prompt discipline (three mandates, shape-differentiated)

process.env.FORGE_TEST_NO_FENCE = "1"

const worktree = mkdtempSync(join(tmpdir(), "forge-dispatch-wiring-"))
process.on("exit", () => {
  try {
    rmSync(worktree, { recursive: true, force: true })
  } catch {}
})

const input = () => ({
  client: { session: {} },
  project: { id: "p" },
  directory: worktree,
  worktree,
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

test("S9: config hook materializes forge-<tier> agents hidden, subagent, modelless, task-denied", async (t) => {
  const h = await server(input(), {})
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

test("S10: a user-defined forge-<tier> entry is never clobbered", async (t) => {
  const h = await server(input(), {})
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

test("S12/S13: chat.params injects the same depth on every request of the session, level frozen", async (t) => {
  const h = await server(input(), {})
  t.after(() => h.dispose?.())
  assert.ok(h["chat.params"], "chat.params hook must be registered")

  const inject = h.__forgeDispatchTest?.queueDepth
  assert.ok(inject, "test seam must exist")
  inject("ses_dp", "low", "openai")

  // options are rebuilt by the host for EVERY LLM request; the hook must
  // re-apply the SAME level each time (inject-once would lose the depth on
  // turn 2) — "frozen" means the level never changes after registration.
  const out1 = { options: {} }
  await h["chat.params"]({ sessionID: "ses_dp", provider: { id: "openai" } }, out1)
  assert.equal(out1.options.reasoningEffort, "low", "first turn writes the level")
  const out2 = { options: {} }
  await h["chat.params"]({ sessionID: "ses_dp", provider: { id: "openai" } }, out2)
  assert.equal(out2.options.reasoningEffort, "low", "same level re-applied (stable across turns)")

  // re-registering a different level mid-session is refused (stability)
  assert.equal(inject("ses_dp", "max", "openai"), false, "level is frozen after first registration")

  // unknown provider family: nothing injected for that session's shape
  inject("ses_dp2", "high", "mystery-provider")
  const out3 = { options: {} }
  await h["chat.params"]({ sessionID: "ses_dp2", provider: { id: "mystery-provider" } }, out3)
  assert.equal(out3.options.reasoningEffort, undefined)
  assert.equal(out3.options.thinking, undefined)
  assert.equal(h.__forgeDispatchTest.depthState("ses_dp2").family, "unknown", "unknown family recorded for honest disclosure")
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
  await assert.rejects(() => h.tool.forge_dispatch.execute({ prompt: "p", profile: "scout", depth: "low" }, allowCtx("ses_ban")))
  assert.equal(engineCalls, 0, "engine must never be reached during draft")

  await h.tool.plan_approve.execute({}, allowCtx("ses_ban"))
  await h["tool.execute.before"]({ tool: "forge_dispatch", sessionID: "ses_ban" }, { args: {} })
  await h.tool.forge_dispatch.execute({ prompt: "p", profile: "scout", depth: "low" }, allowCtx("ses_ban"))
  assert.equal(engineCalls, 1, "engine runs after approval")
})

test("forge_dispatch result object passes through the engine report with a title", async (t) => {
  const h = await server(input(), {})
  t.after(() => h.dispose?.())
  h.__forgeDispatchTest?.setEngine({
    dispatch: async (req) => ({
      tier: req.profile,
      requested: { profile: req.profile, depth: req.depth },
      actual: { model: "zai/glm", depth: req.depth ?? "low" },
      sessionID: "ses_child",
      durationMs: 42,
      tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
      costUsd: 0.01,
      text: "worker concluded",
    }),
    dispose: async () => {},
  })
  const r = await h.tool.forge_dispatch.execute({ prompt: "go", profile: "scout", depth: "low" }, allowCtx("ses_wiring"))
  assert.match(r.title, /scout/)
  assert.match(r.output, /zai\/glm/)
  assert.match(r.output, /worker concluded/)
  assert.match(r.output, /sessionID|ses_child/)
})
