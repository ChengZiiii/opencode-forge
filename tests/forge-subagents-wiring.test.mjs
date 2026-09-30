import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { server } from "../plugin.ts"

// Task 5.2 — forge-subagents wiring suite (spec: forge-subagents +
// crew-harness delta; change simplify-dispatch-to-static-agents). Covers:
//   - materialization WITH a pinned model, NOT hidden, task denied (3.1)
//   - no-clobber of user-defined forge-<id> entries; disable knob silence
//   - the native-task surface: no forge_dispatch tools registered
//   - chat.params keyed by agent name: injection, freeze, no-mapping finding
//   - /crew command composition: orchestration roster vs init hard gate (4.5)
//   - crew_begin declared plan + crew_close gate wiring (4.1-4.4)

process.env.FORGE_TEST_NO_FENCE = "1"
// Redirect the forge.json global path away from the real user home.
process.env.FORGE_TEST_FORGE_HOME = mkdtempSync(join(tmpdir(), "forge-wiring-home-"))
// No models.dev fetch: catalog null -> openai-family depths pass verbatim.
process.env.FORGE_TEST_NO_DISPATCH_FETCH = "1"

const worktree = mkdtempSync(join(tmpdir(), "forge-wiring-"))
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
// Host-lifetime simulation (hierarchical-pool-materialization): the anchor
// set is host-level state that only grows within one host process. Each test
// simulates a FRESH HOST by resetting the anchors before its server() call.
let lastHost = null
async function startServer(inputArg, opts) {
  if (lastHost) lastHost.__forgeSubagentsTest.resetAnchors()
  lastHost = await server(inputArg, opts) // replaced calls below use startServer
  return lastHost
}

function projectWithForgeJson(t, json) {
  const dir = mkdtempSync(join(tmpdir(), "forge-wiring-proj-"))
  t.after(() => {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {}
  })
  mkdirSync(join(dir, ".opencode"), { recursive: true })
  writeFileSync(join(dir, ".opencode", "forge.json"), json)
  return dir
}

// ---------------------------------------------------------------------------
// Materialization (spec: forge-subagents — "Materialization as native
// subagents with a pinned model")

test("materialization: forge.json agents materialize WITH a model, not hidden, task denied", async (t) => {
  const dir = projectWithForgeJson(
    t,
    JSON.stringify({
      agents: {
        research: { model: "zai/glm-5.3", thoughtLevel: "low" },
        builder: { model: "x/y", thoughtLevel: "low", shape: "write", prompt: "You are a build worker." },
      },
    }),
  )
  const h = await startServer(input(dir), {})
  t.after(() => h.dispose?.())
  const cfg = emptyCfg()
  await h.config(cfg)

  const research = cfg.agent["forge-research"]
  assert.ok(research, "forge-research must be injected")
  assert.equal(research.model, "zai/glm-5.3", "the pinned model IS written into the agent")
  assert.equal(research.mode, "subagent")
  assert.equal(research.hidden, undefined, "agents stay in the task-tool vocabulary")
  assert.equal(research.permission.task, "deny")
  for (const tool of ["write", "edit", "bash"]) assert.equal(research.permission[tool], "deny", "readonly default denies mutating tools")
  assert.match(research.prompt, /research/i)
  assert.match(research.prompt, /workspace-relative paths ONLY/, "discipline mandate present")
  assert.match(research.prompt, /report the refusal VERBATIM/, "verbatim-refusal mandate present")
  assert.match(research.prompt, /evidence references/, "evidence mandate present")

  const builder = cfg.agent["forge-builder"]
  assert.equal(builder.model, "x/y")
  assert.equal(builder.permission.write, undefined, "write shape drops the mutating denies")
  assert.equal(builder.permission.task, "deny", "task ban survives the shape")
  // Exec partition (tool-partition): the builtin shell is hidden at
  // materialization regardless of shape; after the config pass the harness
  // STATE tools are primary-only (the worker keeps the exec pair).
  for (const entry of [research, builder]) {
    assert.equal(entry.tools.shell, false, "builtin shell hidden on every worker")
    assert.equal(entry.tools.bash, false, "builtin bash hidden on every worker")
    for (const t of ["plan_write", "plan_tick", "plan_approve", "plan_close", "plan_discard", "goal_write", "goal_check", "goal_complete", "goal_pause", "goal_resume", "goal_discard", "crew_begin", "crew_close"]) {
      assert.equal(entry.tools[t], false, `harness state tool ${t} is primary-only`)
    }
    assert.equal(entry.tools.forge_shell, undefined, "worker keeps forge_shell")
    assert.equal(entry.tools.forge_jobs, undefined, "worker keeps forge_jobs")
  }
  assert.match(builder.prompt, /build worker/, "explicit prompt overrides the role default")
})

test("materialization: a user-defined forge-<id> entry is never clobbered", async (t) => {
  const dir = projectWithForgeJson(t, JSON.stringify({ agents: { research: { model: "zai/glm", thoughtLevel: "low" } } }))
  const h = await startServer(input(dir), {})
  t.after(() => h.dispose?.())
  const cfg = emptyCfg()
  cfg.agent["forge-research"] = { description: "mine", mode: "subagent", prompt: "keep me" }
  await h.config(cfg)
  assert.equal(cfg.agent["forge-research"].prompt, "keep me")
  assert.equal(cfg.agent["forge-research"].description, "mine")
  assert.equal(cfg.agent["forge-research"].model, undefined)
})

test("materialization: fail-soft — one broken entry does not disable its siblings", async (t) => {
  const dir = projectWithForgeJson(
    t,
    JSON.stringify({ agents: { good: { model: "p/good", thoughtLevel: "low" }, bad: { thoughtLevel: "low" } } }),
  )
  const h = await startServer(input(dir), {})
  t.after(() => h.dispose?.())
  const cfg = emptyCfg()
  await h.config(cfg)
  assert.ok(cfg.agent["forge-good"], "the valid agent still materializes")
  assert.equal(cfg.agent["forge-bad"], undefined, "the half-configured entry is skipped")
})

test("materialization: an Auto worker carries no model key and describes inheritance", async (t) => {
  const dir = projectWithForgeJson(t, JSON.stringify({ agents: { scout: {} } }))
  const h = await startServer(input(dir), {})
  t.after(() => h.dispose?.())
  const cfg = emptyCfg()
  await h.config(cfg)
  const scout = cfg.agent["forge-scout"]
  assert.ok(scout, "the Auto worker materializes")
  assert.equal(false, "model" in scout, "no model key at all — the host inherits the parent's model")
  assert.equal(scout.mode, "subagent")
  assert.equal(scout.permission.task, "deny", "recursion ban intact")
  assert.match(scout.description, /auto — inherits the parent session's model at dispatch/, "the description names inheritance, not a pinned brain")
  assert.doesNotMatch(scout.description, /pinned/, "no pinned claim for an Auto worker")
  assert.equal(scout.tools.shell, false, "exec partition applies to Auto workers too")
  assert.match(scout.prompt, /workspace-relative paths ONLY/, "discipline mandate present")
})

test("materialization: a broken forge.json empties the set (no seed resurrection)", async (t) => {
  const dir = projectWithForgeJson(t, "{ broken")
  const h = await startServer(input(dir), {})
  t.after(() => h.dispose?.())
  const cfg = emptyCfg()
  await h.config(cfg)
  assert.equal(cfg.agent["forge-research"], undefined, "no seed exists to fall back to")
})

test("materialization: agent.forge.disable registers nothing", async (t) => {
  const dir = projectWithForgeJson(t, JSON.stringify({ agents: { research: { model: "zai/glm", thoughtLevel: "low" } } }))
  const h = await startServer(input(dir), {})
  t.after(() => h.dispose?.())
  const cfg = emptyCfg()
  cfg.agent.forge = { disable: true }
  await h.config(cfg)
  assert.equal(cfg.agent["forge-research"], undefined, "no subagents when forge is disabled")
  assert.equal(h.tool.crew_begin, undefined, "no crew tools when forge is disabled")
  assert.equal(h.tool.plan_write, undefined, "no harness tools at all when disabled")
})

test("native-task surface: no forge_dispatch family is registered anywhere", async (t) => {
  const h = await startServer(input(), {})
  t.after(() => h.dispose?.())
  const cfg = emptyCfg()
  await h.config(cfg)
  const tools = h.tool
  assert.equal(tools.forge_dispatch, undefined)
  assert.equal(tools.forge_dispatch_config, undefined)
  assert.equal(tools.forge_dispatch_list, undefined)
  assert.equal(tools.forge_dispatch_kill, undefined)
  assert.ok(tools.crew_begin, "crew tools remain")
  assert.ok(tools.crew_close, "crew tools remain")
  assert.ok(tools.plan_write, "plan tools remain")
  assert.ok(tools.forge_shell, "job tools remain")
})

// ---------------------------------------------------------------------------
// Depth injection (spec: forge-subagents — "Pinned thoughtLevel injection
// keyed by agent name")

test("depth: a forge agent session gets its pinned word on the wire, frozen for the session", async (t) => {
  const dir = projectWithForgeJson(t, JSON.stringify({ agents: { research: { model: "openai/gpt", thoughtLevel: "low" } } }))
  const h = await startServer(input(dir), {})
  t.after(() => h.dispose?.())
  await h.config(emptyCfg())

  const out1 = { options: {} }
  await h["chat.params"]({ sessionID: "ses_d1", agent: "forge-research", model: { providerID: "openai", modelID: "gpt" } }, out1)
  assert.equal(out1.options.reasoningEffort, "low", "the pinned word rides the wire")

  out1.options.reasoningEffort = "TAMPERED"
  await h["chat.params"]({ sessionID: "ses_d1", agent: "forge-research", model: { providerID: "openai", modelID: "gpt" } }, out1)
  assert.equal(out1.options.reasoningEffort, "low", "the frozen value is re-applied verbatim each request")

  // A different session is a fresh freeze.
  const out2 = { options: {} }
  await h["chat.params"]({ sessionID: "ses_d2", agent: "forge-research", model: { providerID: "openai", modelID: "gpt" } }, out2)
  assert.equal(out2.options.reasoningEffort, "low")
})

test("depth: non-forge agents and agents without thoughtLevel get nothing", async (t) => {
  const dir = projectWithForgeJson(t, JSON.stringify({ agents: { plain: {} } }))
  const h = await startServer(input(dir), {})
  t.after(() => h.dispose?.())
  await h.config(emptyCfg())

  const out = { options: {} }
  await h["chat.params"]({ sessionID: "ses_p", agent: "forge-plain", model: { providerID: "openai", modelID: "gpt" } }, out)
  assert.equal(out.options.reasoningEffort, undefined, "no thoughtLevel -> nothing injected")

  const out2 = { options: {} }
  await h["chat.params"]({ sessionID: "ses_q", agent: "build", model: { providerID: "openai", modelID: "gpt" } }, out2)
  assert.equal(out2.options.reasoningEffort, undefined, "non-forge agents are untouched")
})

test("depth: unknown provider family injects nothing, silently", async (t) => {
  const dir = projectWithForgeJson(t, JSON.stringify({ agents: { research: { model: "weird/m", thoughtLevel: "low" } } }))
  const h = await startServer(input(dir), {})
  t.after(() => h.dispose?.())
  await h.config(emptyCfg())
  const out = { options: {} }
  await h["chat.params"]({ sessionID: "ses_u", agent: "forge-research", model: { providerID: "weird", modelID: "m" } }, out)
  assert.deepEqual(out.options, {}, "unknown family -> no injection, no crash")
})

test("depth: a no-mapping word injects nothing and records a bounded once-per-agent finding", async (t) => {
  const dir = projectWithForgeJson(t, JSON.stringify({ agents: { picky: { model: "openai/gpt", thoughtLevel: "medium" } } }))
  const h = await startServer(input(dir), {})
  t.after(() => h.dispose?.())
  await h.config(emptyCfg())
  // Catalog knows the model's native ladder: low/high/max only (no medium).
  h.__forgeSubagentsTest.setCatalog({ providers: { openai: { models: { gpt: { reasoningOptions: ["low", "high", "max"] } } } } })

  const out = { options: {} }
  await h["chat.params"]({ sessionID: "ses_n1", agent: "forge-picky", model: { providerID: "openai", modelID: "gpt" } }, out)
  assert.equal(out.options.reasoningEffort, undefined, "nothing is injected — the session is never broken")
  assert.match(h.__forgeSubagentsTest.depthFinding("picky") ?? "", /medium/, "a finding names the word")

  // Bounded: a second session with the same agent does not duplicate it.
  await h["chat.params"]({ sessionID: "ses_n2", agent: "forge-picky", model: { providerID: "openai", modelID: "gpt" } }, { options: {} })
  assert.match(h.__forgeSubagentsTest.depthFinding("picky") ?? "", /medium/)
})

// ---------------------------------------------------------------------------
// /crew command composition (spec: crew-harness — "/crew command discipline" +
// "Unconfigured crew initialization gate")

test("crew command: with agents it carries the orchestration rulebook and the roster", async (t) => {
  const dir = projectWithForgeJson(t, JSON.stringify({ agents: { research: { model: "zai/glm", thoughtLevel: "low" }, review: { model: "zai/glm", thoughtLevel: "low" } } }))
  const h = await startServer(input(dir), {})
  t.after(() => h.dispose?.())
  const cfg = emptyCfg()
  await h.config(cfg)
  const cmd = cfg.command["crew"]
  assert.ok(cmd, "the /crew command is registered")
  assert.match(cmd.template, /CREW ORCHESTRATION discipline/)
  assert.match(cmd.template, /forge-research/, "the live roster is listed")
  assert.match(cmd.template, /crew_begin/, "the declared-plan registration step is present")
  assert.match(cmd.template, /native\s+`?task`?\s+calls/, "waves ride the native task channel")
  assert.match(cmd.template, /no configured forge-\* agent matches/, "missing-role fallback discipline present")
  assert.doesNotMatch(cmd.template, /forge_dispatch|background|\[forge:dispatch-complete\]/, "no dispatch-era vocabulary remains")
})

test("crew command: unconfigured is a HARD gate with initialization guidance", async (t) => {
  const h = await startServer(input(), {})
  t.after(() => h.dispose?.())
  const cfg = emptyCfg()
  await h.config(cfg)
  const cmd = cfg.command["crew"]
  assert.ok(cmd, "the /crew command is still registered")
  assert.match(cmd.template, /CREW IS NOT INITIALIZED/, "the hard-gate refusal text")
  assert.match(cmd.template, /\.opencode\/forge\.json|forge\.json/, "names the config file paths")
  assert.match(cmd.template, /ONLY if the user explicitly asks/, "the AI-assist consent rule")
  assert.match(cmd.template, /host restart/, "the restart expectation")
  assert.match(cmd.template, /thoughtLevel/, "the hot-apply note")
  assert.match(cmd.template, /"prompt"/, "the embedded example shows the prompt field")
  assert.match(cmd.template, /SHORT prompt/, "the AI-assist short-prompt mandate")
  assert.match(cmd.template, /WITHOUT the `forge-` prefix/, "the plain-role-word naming rule")
  assert.match(cmd.template, /research.*review.*built-in|built-in.*research/is, "discloses which ids carry built-in roles")
  assert.match(cmd.description, /NOT INITIALIZED/)
})

test("materialization: a forge--prefixed id self-heals — single-prefix agent, no doubling", async (t) => {
  const dir = projectWithForgeJson(t, JSON.stringify({ agents: { "forge-coder": { model: "zai/glm", thoughtLevel: "low" } } }))
  const h = await startServer(input(dir), {})
  t.after(() => h.dispose?.())
  const cfg = emptyCfg()
  await h.config(cfg)
  assert.ok(cfg.agent["forge-coder"], "materialized under the single-prefix name")
  assert.ok(!cfg.agent["forge-forge-coder"], "no doubled prefix")
  assert.match(cfg.command["crew"].template, /forge-coder/, "the roster lists the healed name")
  assert.doesNotMatch(cfg.command["crew"].template, /forge-forge-coder/)
})

test("crew command: a user-defined /crew command is never clobbered", async (t) => {
  const h = await startServer(input(), {})
  t.after(() => h.dispose?.())
  const cfg = emptyCfg()
  cfg.command["crew"] = { template: "MINE", description: "user owned" }
  await h.config(cfg)
  assert.equal(cfg.command["crew"].template, "MINE")
})

// ---------------------------------------------------------------------------
// crew_begin / crew_close wiring (spec: crew-harness — "crew_close completion
// gate" + declared-plan registration)

test("crew_begin: registers the declared plan; refuses duplicates within the plan", async (t) => {
  const dir = projectWithForgeJson(t, JSON.stringify({ agents: { research: { model: "zai/glm", thoughtLevel: "low" } } }))
  const h = await startServer(input(dir), {})
  t.after(() => h.dispose?.())
  await h.config(emptyCfg())

  await h.tool.crew_begin.execute(
    { objective: "ship it", subtasks: [{ title: "alpha", agent: "forge-research" }, { title: "beta" }] },
    allowCtx("ses_c1"),
  )
  const crew = h.__forgeSubagentsTest.crews().get("ses_c1")
  assert.ok(crew, "the crew is registered")
  assert.deepEqual(crew.subtasks, [{ title: "alpha", agent: "forge-research" }, { title: "beta" }])

  await assert.rejects(
    () => h.tool.crew_begin.execute({ objective: "another", subtasks: [{ title: "x" }] }, allowCtx("ses_c1")),
    /already has an active crew/,
  )
  await assert.rejects(
    () => h.tool.crew_begin.execute({ objective: "o", subtasks: [] }, allowCtx("ses_c2")),
    /subtasks/,
  )
  await assert.rejects(
    () => h.tool.crew_begin.execute({ objective: "o", subtasks: [{ title: "same" }, { title: "same" }] }, allowCtx("ses_c2")),
    /unique/,
  )
})

test("crew_begin: HARD initialization gate — empty agent set refuses with guidance", async (t) => {
  const h = await startServer(input(), {})
  t.after(() => h.dispose?.())
  await h.config(emptyCfg())
  await assert.rejects(
    () => h.tool.crew_begin.execute({ objective: "o", subtasks: [{ title: "x" }] }, allowCtx("ses_gate")),
    (err) => {
      const m = String(err)
      assert.match(m, /CREW IS NOT INITIALIZED/)
      assert.match(m, /forge\.json/)
      assert.match(m, /restart/)
      assert.match(m, /MERGED/, "the guidance states the merge semantics")
      assert.match(m, /"prompt"/, "the refusal template shows the prompt field")
      assert.match(m, /SHORT prompt/, "the refusal carries the short-prompt mandate")
      assert.match(m, /WITHOUT the `forge-` prefix/, "the refusal carries the naming rule")
      return true
    },
  )
})

// ---------------------------------------------------------------------------
// Session-anchored discovery + workspace-mismatch disclosure (change
// align-forge-config-discovery)

function workspaceWithForgeJson(t, json) {
  const dir = mkdtempSync(join(tmpdir(), "forge-wiring-ws-"))
  t.after(() => {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {}
  })
  mkdirSync(join(dir, ".opencode"), { recursive: true })
  writeFileSync(join(dir, ".opencode", "forge.json"), json)
  return dir
}

test("crew_begin: a workspace forge.json the host cannot see is DISCLOSED, not masked", async (t) => {
  // Host launched with its own pool; the session works in another directory
  // whose forge.json defines an agent the host never materialized.
  const hostDir = projectWithForgeJson(t, JSON.stringify({ agents: { research: { model: "zai/glm", thoughtLevel: "low" } } }))
  const ws = workspaceWithForgeJson(t, JSON.stringify({ agents: { localtool: { model: "zai/glm", thoughtLevel: "low" } } }))
  const h = await startServer(input(hostDir), {})
  t.after(() => h.dispose?.())
  await h.config(emptyCfg())
  const out = await h.tool.crew_begin.execute(
    { objective: "o", subtasks: [{ title: "x", agent: "forge-research" }] },
    { ...allowCtx("ses_ws1"), worktree: ws, directory: ws },
  )
  const text = typeof out === "string" ? out : out.output
  assert.match(text, /NOT dispatchable on this host/)
  assert.match(text, /forge-<ns>-localtool/)
  assert.match(text, /A host initialization in that workspace adds its pools/)
})

test("crew_begin: empty host set + usable workspace file → mismatch-explaining refusal", async (t) => {
  const hostDir = mkdtempSync(join(tmpdir(), "forge-wiring-host-"))
  t.after(() => {
    try {
      rmSync(hostDir, { recursive: true, force: true })
    } catch {}
  })
  const ws = workspaceWithForgeJson(t, JSON.stringify({ agents: { research: { model: "zai/glm", thoughtLevel: "low" } } }))
  const h = await startServer(input(hostDir), {})
  t.after(() => h.dispose?.())
  await h.config(emptyCfg())
  await assert.rejects(
    () => h.tool.crew_begin.execute({ objective: "o", subtasks: [{ title: "x" }] }, { ...allowCtx("ses_ws2"), worktree: ws, directory: ws }),
    (err) => {
      const m = String(err)
      assert.match(m, /CREW IS NOT INITIALIZED/)
      assert.match(m, /this session's workspace DOES have a forge\.json/)
      assert.match(m, /NO host anchor covers it/)
      return true
    },
  )
})

test("sessionAnchor: a degenerate worktree with a distinct session directory anchors plans under the session directory", async (t) => {
  const hostDir = mkdtempSync(join(tmpdir(), "forge-wiring-launch-"))
  t.after(() => {
    try {
      rmSync(hostDir, { recursive: true, force: true })
    } catch {}
  })
  const ws = mkdtempSync(join(tmpdir(), "forge-wiring-anchor-"))
  t.after(() => {
    try {
      rmSync(ws, { recursive: true, force: true })
    } catch {}
  })
  const h = await startServer(input(hostDir), {})
  t.after(() => h.dispose?.())
  await h.config(emptyCfg())
  await h.tool.plan_write.execute(
    { goal: "anchor check", context: "c", approach: "a", tasks: ["t1"], risks: "r", acceptance: ["ac"] },
    { ...allowCtx("ses_anchor"), worktree: "/", directory: ws },
  )
  assert.ok(existsSync(join(ws, ".opencode", "plan")), "the plan landed under the SESSION directory, not the launch dir")
  assert.ok(!existsSync(join(hostDir, ".opencode", "plan")), "nothing leaked to the launch directory")
})

test("crew_begin: refuses during a plan draft", async (t) => {
  // Own worktree: the leftover draft must not poison the other tests.
  const dir = mkdtempSync(join(tmpdir(), "forge-wiring-draft-"))
  t.after(() => {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {}
  })
  const h = await startServer(input(dir), {})
  t.after(() => h.dispose?.())
  const cfg = emptyCfg()
  await h.config(cfg)
  await h.tool.plan_write.execute(
    {
      goal: "planning",
      context: "c",
      approach: "a",
      tasks: ["t1"],
      risks: "r",
      acceptance: ["a1"],
    },
    allowCtx("ses_draft"),
  )
  await assert.rejects(
    () => h.tool.crew_begin.execute({ objective: "o", subtasks: [{ title: "x" }] }, allowCtx("ses_draft")),
    (err) => {
      const m = String(err)
      assert.match(m, /plan is in draft/)
      assert.match(m, /plan_approve/, "exit 1 named: approval")
      assert.match(m, /an APPROVED plan does not block \/crew/, "the approved-plan note")
      assert.match(m, /\/plan discard abandons the plan outright/, "exit 2 named: outright discard")
      assert.match(m, /\/plan discard \{supersede/, "exit 3 named: the supersede exit into the crew")
      return true
    },
  )
})

test("crew_close: incomplete, renegade, and honest-FAIL reports behave per spec", async (t) => {
  const dir = projectWithForgeJson(t, JSON.stringify({ agents: { research: { model: "zai/glm", thoughtLevel: "low" } } }))
  const h = await startServer(input(dir), {})
  t.after(() => h.dispose?.())
  await h.config(emptyCfg())

  await h.tool.crew_begin.execute({ objective: "ship", subtasks: [{ title: "alpha" }, { title: "beta" }] }, allowCtx("ses_cc"))

  // Incomplete: beta missing.
  await assert.rejects(
    () => h.tool.crew_close.execute({ report: [{ title: "alpha", verdict: "PASS", evidence: "ok" }] }, allowCtx("ses_cc")),
    /declared plan|silently dropped/,
  )
  // Renegade: gamma was never declared.
  await assert.rejects(
    () =>
      h.tool.crew_close.execute(
        {
          report: [
            { title: "alpha", verdict: "PASS", evidence: "ok" },
            { title: "beta", verdict: "PASS", evidence: "ok" },
            { title: "gamma", verdict: "PASS", evidence: "improvised" },
          ],
        },
        allowCtx("ses_cc"),
      ),
    /renegade|declared plan/,
  )
  // Honest FAIL with both attempts closes (ask gate auto-allows here).
  const r = await h.tool.crew_close.execute(
    {
      report: [
        { title: "alpha", verdict: "PASS", evidence: "ok" },
        { title: "beta", verdict: "FAIL", evidence: "still broken", attempts: ["attempt: x", "retry: y"] },
      ],
    },
    allowCtx("ses_cc"),
  )
  assert.match(r.output, /FAIL 1/)
  assert.equal(h.__forgeSubagentsTest.crews().get("ses_cc"), undefined, "the crew ends on success")
})

test("crew_close: no active crew refuses", async (t) => {
  const h = await startServer(input(), {})
  t.after(() => h.dispose?.())
  await h.config(emptyCfg())
  await assert.rejects(() => h.tool.crew_close.execute({ report: [{ title: "a", verdict: "PASS", evidence: "e" }] }, allowCtx("ses_none")), /No active crew/)
})

// ---------------------------------------------------------------------------
// Crew execution-mode gate (change add-crew-execution-mode-gate): two-phase
// lifecycle (register PENDING -> arm), the pending dispatch belt, the goal
// conversion path, the abandon path, origin disclosure, the crew record.

const poolJson = JSON.stringify({ agents: { research: { model: "zai/glm", thoughtLevel: "low" } } })
const beltArgs = () => ({ args: { subagent_type: "general", prompt: "x" } })

test("crew lifecycle: registration PENDS — three-choice surface, dispatch belt, arm call", async (t) => {
  const dir = projectWithForgeJson(t, poolJson)
  const h = await startServer(input(dir), {})
  t.after(() => h.dispose?.())
  await h.config(emptyCfg())

  const out = await h.tool.crew_begin.execute({ objective: "gate it", subtasks: [{ title: "one" }] }, allowCtx("ses_lifecycle"))
  assert.match(out.output, /registered PENDING/, "registration announces the pending state")
  const recLine = out.output.indexOf("Crew record (inspectable history")
  const objLine = out.output.indexOf("registered PENDING")
  const planLine = out.output.indexOf("Declared plan (")
  assert.ok(recLine !== -1 && objLine !== -1 && planLine !== -1 && recLine < objLine && objLine < planLine, "the record path line leads the output, before the objective summary and the declared plan (4.1)")
  assert.match(out.output, /RELAY FIRST: tell the user the crew record path/, "the PENDING pause text mandates relaying the record path to the user (4.2)")
  assert.match(out.output, /supervised waves NOW/, "three-choice surface: waves")
  assert.match(out.output, /convert to a goal contract/, "three-choice surface: goal")
  assert.match(out.output, /standby/, "three-choice surface: standby")
  assert.match(out.output, /END YOUR TURN/, "the stop mandate")
  assert.match(out.output, /Dispatchable roster origin — 1 pool across the host anchor set/, "origin disclosure enumerates pools")
  assert.match(out.output, /root pool \(PRIMARY, plain ids\)/, "the primary root pool is marked (D8)")
  assert.doesNotMatch(out.output, /Proceed with the discipline/, "registration no longer orders immediate execution")
  assert.equal(h.__forgeSubagentsTest.crews().get("ses_lifecycle").mode, "pending")

  // Belt: every task dispatch refuses while the crew pends.
  await assert.rejects(
    () => h["tool.execute.before"]({ tool: "task", sessionID: "ses_lifecycle", callID: "cb1" }, beltArgs()),
    /PENDING/,
  )

  // Arm call (shape-disjoint: execution only, no plan payload).
  const armed = await h.tool.crew_begin.execute({ execution: "waves" }, allowCtx("ses_lifecycle"))
  assert.match(armed.output, /ARMED for supervised waves/)
  assert.equal(h.__forgeSubagentsTest.crews().get("ses_lifecycle").mode, "executing")
  await h["tool.execute.before"]({ tool: "task", sessionID: "ses_lifecycle", callID: "cb2" }, beltArgs())

  // Re-arm refuses; arm without a crew refuses; bogus execution value refuses.
  await assert.rejects(() => h.tool.crew_begin.execute({ execution: "waves" }, allowCtx("ses_lifecycle")), /already armed/)
  await assert.rejects(() => h.tool.crew_begin.execute({ execution: "waves" }, allowCtx("ses_noarm")), /No active crew to arm/)
  await assert.rejects(() => h.tool.crew_begin.execute({ execution: "fast" }, allowCtx("ses_noarm")), /execution must be/)
})

test("crew lifecycle: goal conversion ends the crew and directs goal_write(arm)", async (t) => {
  const dir = projectWithForgeJson(t, poolJson)
  const h = await startServer(input(dir), {})
  t.after(() => h.dispose?.())
  await h.config(emptyCfg())
  await h.tool.crew_begin.execute({ objective: "convert me", subtasks: [{ title: "one" }, { title: "two", agent: "forge-research" }] }, allowCtx("ses_conv"))
  const recordPath = h.__forgeSubagentsTest.crews().get("ses_conv").recordPath
  const out = await h.tool.crew_begin.execute({ execution: "goal" }, allowCtx("ses_conv"))
  assert.match(out.output, /CONVERSION record/)
  assert.match(out.output, /goal_write with arm=true/)
  assert.match(out.output, /1\. one/, "the declared plan rides along for folding")
  assert.equal(h.__forgeSubagentsTest.crews().get("ses_conv"), undefined, "conversion ends the crew")
  assert.match(readFileSync(recordPath, "utf8"), /converted to goal/, "the record carries the conversion")
  // The belt is gone with the crew: task dispatch no longer refuses.
  await h["tool.execute.before"]({ tool: "task", sessionID: "ses_conv", callID: "cb3" }, beltArgs())
})

test("crew registration: an execution payload without a governing goal refuses", async (t) => {
  const dir = projectWithForgeJson(t, poolJson)
  const h = await startServer(input(dir), {})
  t.after(() => h.dispose?.())
  await h.config(emptyCfg())
  await assert.rejects(
    () => h.tool.crew_begin.execute({ objective: "o", subtasks: [{ title: "x" }], execution: "waves" }, allowCtx("ses_nogoal")),
    /cannot self-arm outside a governing goal/,
  )
  await assert.rejects(
    () => h.tool.crew_begin.execute({ objective: "o", subtasks: [{ title: "x" }], execution: "goal" }, allowCtx("ses_nogoal")),
    /converts an already-registered/,
  )
  assert.equal(h.__forgeSubagentsTest.crews().get("ses_nogoal"), undefined, "nothing was registered")
})

test("crew abandon: ask retained, no verdict demands, fresh begin after, works from pending AND executing", async (t) => {
  const dir = projectWithForgeJson(t, poolJson)
  const h = await startServer(input(dir), {})
  t.after(() => h.dispose?.())
  await h.config(emptyCfg())
  await h.tool.crew_begin.execute({ objective: "wrong shape", subtasks: [{ title: "a" }] }, allowCtx("ses_ab"))
  const denied = { ...allowCtx("ses_ab"), ask: async () => { throw new Error("denied by user (test)") } }
  await assert.rejects(() => h.tool.crew_close.execute({ abandon: true, reason: "bad plan" }, denied), /denied/i)
  assert.ok(h.__forgeSubagentsTest.crews().get("ses_ab"), "a denied abandon keeps the crew")
  const out = await h.tool.crew_close.execute({ abandon: true, reason: "bad plan" }, allowCtx("ses_ab"))
  assert.match(out.output, /ABANDONED/)
  assert.match(out.output, /mode at abandon: pending/)
  assert.equal(h.__forgeSubagentsTest.crews().get("ses_ab"), undefined)
  // The freed session registers fresh; abandon also works from EXECUTING.
  await h.tool.crew_begin.execute({ objective: "reshard", subtasks: [{ title: "b" }] }, allowCtx("ses_ab"))
  await h.tool.crew_begin.execute({ execution: "waves" }, allowCtx("ses_ab"))
  const out2 = await h.tool.crew_close.execute({ abandon: true, reason: "mid-flight re-shard" }, allowCtx("ses_ab"))
  assert.match(out2.output, /mode at abandon: executing/)
  assert.equal(h.__forgeSubagentsTest.crews().get("ses_ab"), undefined)
})

test("crew record: registration writes it under the session anchor; arm/close append; fail-soft on an unwritable anchor", async (t) => {
  const dir = projectWithForgeJson(t, poolJson)
  const h = await startServer(input(dir), {})
  t.after(() => h.dispose?.())
  await h.config(emptyCfg())
  const ws = workspaceWithForgeJson(t, poolJson)
  const recCtx = (sid) => ({ ...allowCtx(sid), worktree: ws, directory: ws })

  await h.tool.crew_begin.execute({ objective: "keep records", subtasks: [{ title: "one" }] }, recCtx("ses_rec"))
  const crew = h.__forgeSubagentsTest.crews().get("ses_rec")
  assert.ok(crew.recordPath?.startsWith(join(ws, ".opencode", "crew")), "the record lives under the session anchor")
  assert.match(crew.recordPath, /\.md$/)
  const rec = readFileSync(crew.recordPath, "utf8")
  assert.match(rec, /# Crew Record: keep records/)
  assert.match(rec, /1\. one/)
  await h.tool.crew_begin.execute({ execution: "waves" }, recCtx("ses_rec"))
  assert.match(readFileSync(crew.recordPath, "utf8"), /armed \(waves\)/)
  await h.tool.crew_close.execute({ report: [{ title: "one", verdict: "PASS", evidence: "ok" }] }, recCtx("ses_rec"))
  const closed = readFileSync(crew.recordPath, "utf8")
  assert.match(closed, /— closed/)
  assert.match(closed, /one: PASS/)

  // Fail-soft: an anchor that cannot host the file degrades to a note; the crew still runs.
  const asFile = join(tmpdir(), `forge-wiring-notdir-${Date.now()}.txt`)
  writeFileSync(asFile, "i am a file, not a directory")
  const soft = await h.tool.crew_begin.execute({ objective: "no record", subtasks: [{ title: "x" }] }, { ...allowCtx("ses_soft"), worktree: asFile, directory: asFile })
  assert.match(soft.output, /could not be written \(fail-soft/, "unwritable anchor degrades to a note")
  const softCrew = h.__forgeSubagentsTest.crews().get("ses_soft")
  assert.equal(softCrew.recordPath, null)
  assert.equal(softCrew.mode, "pending", "the crew still runs")
})

test("crew_begin origin disclosure: a global-layer host names the global path", async (t) => {
  const home = process.env.FORGE_TEST_FORGE_HOME
  mkdirSync(join(home, ".config", "opencode"), { recursive: true })
  writeFileSync(join(home, ".config", "opencode", "forge.json"), poolJson)
  t.after(() => {
    try {
      rmSync(join(home, ".config"), { recursive: true, force: true })
    } catch {}
  })
  const dir = mkdtempSync(join(tmpdir(), "forge-wiring-nocfg-"))
  t.after(() => {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {}
  })
  const h = await startServer(input(dir), {})
  t.after(() => h.dispose?.())
  await h.config(emptyCfg())
  const out = await h.tool.crew_begin.execute({ objective: "o", subtasks: [{ title: "x" }] }, allowCtx("ses_origin"))
  assert.match(out.output, /Dispatchable roster origin — 1 pool across the host anchor set/, "the global fallback pool is the origin")
  assert.match(out.output, /root pool \(PRIMARY, plain ids\): [^\n]*\.config[\\/]opencode[\\/]forge\.json/, "the global path is spelled out as the plain-id family")
  assert.doesNotMatch(out.output, /workspace has its own forge\.json/, "no mismatch disclosure without a session-side file")
})

// ---------------------------------------------------------------------------
// Crew-harness template rewrite (change add-crew-execution-mode-gate): the
// pause step, GUI-wave mutex, computer-tool preference, abandon exit, and the
// source-agnostic framing.

test("crew command template: the pause, GUI mutex, computer preference, abandon exit, source-agnostic framing", async (t) => {
  const dir = projectWithForgeJson(t, poolJson)
  const h = await startServer(input(dir), {})
  t.after(() => h.dispose?.())
  const cfg = emptyCfg()
  await h.config(cfg)
  const tpl = cfg.command["crew"].template
  assert.match(tpl, /THE PAUSE/, "the pause step exists")
  assert.match(tpl, /END YOUR TURN/, "registration stops the turn")
  assert.match(tpl, /may come from an approved plan, a spec change, or inline text/, "source-agnostic framing (no plan precedence)")
  assert.match(tpl, /mutually exclusive within a wave/, "GUI/computer-use subtasks are serialized per wave")
  assert.match(tpl, /`computer` tool/, "GUI walkthroughs prefer the computer tool")
  assert.match(tpl, /abandon: true/, "the abandon exit is taught in the template")
  assert.match(tpl, /optional `lineage` argument/, "the REGISTER step teaches lineage when descending from a plan artifact (4.5)")
  assert.doesNotMatch(tpl, /Proceed with the discipline: waves/, "the immediate-execution order is gone")
})

// ---------------------------------------------------------------------------
// plan-supersession-and-lineage wiring (task 5.2): registration output
// ordering, lineage recording, the PENDING relay mandate, the draft-gate
// exits, and the crew record's dated close section.

test("crew registration output order: record path leads, then the objective, then the declared plan; explicit lineage is disclosed", async (t) => {
  const dir = projectWithForgeJson(t, poolJson)
  const h = await startServer(input(dir), {})
  t.after(() => h.dispose?.())
  await h.config(emptyCfg())
  const out = await h.tool.crew_begin.execute(
    { objective: "descend from a plan", subtasks: [{ title: "one" }], lineage: ".opencode/plan/2026-10-01-my-plan.md" },
    allowCtx("ses_order"),
  )
  const recLine = out.output.indexOf("Crew record (inspectable history")
  const objLine = out.output.indexOf("Objective: descend from a plan")
  const planLine = out.output.indexOf("Declared plan (")
  assert.ok(recLine !== -1 && objLine !== -1 && planLine !== -1, "all three blocks are present")
  assert.ok(recLine < objLine, "the crew record path line leads the output (4.1)")
  assert.ok(objLine < planLine, "the objective summary precedes the declared plan (4.1)")
  assert.match(out.output, /Lineage: \.opencode\/plan\/2026-10-01-my-plan\.md/, "an explicit lineage is disclosed in the registration output (4.3)")
})

test("crew record header: an explicit lineage lands as a sibling header line; without the argument there is none", async (t) => {
  const dir = projectWithForgeJson(t, poolJson)
  const h = await startServer(input(dir), {})
  t.after(() => h.dispose?.())
  await h.config(emptyCfg())
  await h.tool.crew_begin.execute(
    { objective: "lineage present", subtasks: [{ title: "one" }], lineage: ".opencode/plan/2026-10-01-src.md" },
    allowCtx("ses_lin_yes"),
  )
  const withLin = readFileSync(h.__forgeSubagentsTest.crews().get("ses_lin_yes").recordPath, "utf8")
  const header = withLin.slice(0, withLin.indexOf("## Declared plan"))
  const regAt = header.indexOf("- registered: ")
  const anchorAt = header.indexOf("- anchor: ")
  const linAt = header.indexOf("- lineage: .opencode/plan/2026-10-01-src.md")
  assert.ok(regAt !== -1 && anchorAt !== -1 && linAt !== -1, "lineage is a header sibling of registered/anchor (4.3)")
  assert.ok(regAt < anchorAt && anchorAt < linAt, "the lineage line sits in the header block after the anchor line")
  // Explicit-only (negative): registration without the argument leaves no lineage line.
  await h.tool.crew_begin.execute({ objective: "lineage absent", subtasks: [{ title: "one" }] }, allowCtx("ses_lin_no"))
  const withoutLin = readFileSync(h.__forgeSubagentsTest.crews().get("ses_lin_no").recordPath, "utf8")
  assert.doesNotMatch(withoutLin, /^- lineage:/m, "no lineage line without an explicit argument (never inferred)")
  assert.match(withoutLin, /^- registered: /m)
})

test("PENDING pause: the relay-first mandate names the crew record path and precedes the three choices", async (t) => {
  const dir = projectWithForgeJson(t, poolJson)
  const h = await startServer(input(dir), {})
  t.after(() => h.dispose?.())
  await h.config(emptyCfg())
  const out = await h.tool.crew_begin.execute({ objective: "relay the path", subtasks: [{ title: "one" }] }, allowCtx("ses_relay"))
  assert.match(out.output, /RELAY FIRST: tell the user the crew record path/, "the PENDING text mandates relaying the record path (4.2)")
  const relayAt = out.output.indexOf("RELAY FIRST")
  const choiceAt = out.output.indexOf("1. supervised waves NOW")
  assert.ok(relayAt !== -1 && choiceAt !== -1 && relayAt < choiceAt, "the relay mandate precedes the execution-mode choices")
})

test("draft gate: the refusal names all three exits; an APPROVED plan really does not block registration", async (t) => {
  // Own worktree: the leftover approved plan must not poison the other tests.
  const dir = projectWithForgeJson(t, poolJson)
  const h = await startServer(input(dir), {})
  t.after(() => h.dispose?.())
  await h.config(emptyCfg())
  await h.tool.plan_write.execute(
    { goal: "gate exits", context: "c", approach: "a", tasks: ["t1"], risks: "r", acceptance: ["a1"] },
    allowCtx("ses_gate3"),
  )
  await assert.rejects(
    () => h.tool.crew_begin.execute({ objective: "blocked while drafting", subtasks: [{ title: "x" }] }, allowCtx("ses_gate3")),
    (err) => {
      const m = String(err)
      assert.match(m, /plan_approve/, "exit 1: approval")
      assert.match(m, /an APPROVED plan does not block \/crew/, "the approved-plan note rides the refusal (4.4)")
      assert.match(m, /\/plan discard abandons the plan outright/, "exit 2: outright discard")
      assert.match(m, /\/plan discard \{supersede:/, "exit 3: the supersede exit into the crew")
      return true
    },
  )
  // The note is behavior, not wording: after approval the registration goes through.
  await h.tool.plan_approve.execute({}, allowCtx("ses_gate3"))
  const out = await h.tool.crew_begin.execute({ objective: "unblocked after approval", subtasks: [{ title: "x" }] }, allowCtx("ses_gate3"))
  assert.match(out.output, /registered PENDING/)
})

test("crew record: close appends a dated section carrying per-subtask verdicts (PASS and normalized FAIL)", async (t) => {
  const dir = projectWithForgeJson(t, poolJson)
  const h = await startServer(input(dir), {})
  t.after(() => h.dispose?.())
  await h.config(emptyCfg())
  await h.tool.crew_begin.execute(
    { objective: "close the record", subtasks: [{ title: "alpha" }, { title: "beta" }] },
    allowCtx("ses_closerec"),
  )
  const recPath = h.__forgeSubagentsTest.crews().get("ses_closerec").recordPath
  const out = await h.tool.crew_close.execute(
    {
      report: [
        { title: "alpha", verdict: "PASS", evidence: "tests green" },
        { title: "beta", verdict: "fail", evidence: "both attempts blew up", attempts: ["attempt one", "retry one"] },
      ],
    },
    allowCtx("ses_closerec"),
  )
  assert.match(out.output, /PASS 1, FAIL 1/)
  const rec = readFileSync(recPath, "utf8")
  assert.match(rec, /^## \S+ — closed$/m, "a dated close section is appended to the record")
  assert.match(rec, /subtasks: 2 \(PASS 1, FAIL 1\)/)
  assert.match(rec, /- alpha: PASS — tests green/)
  assert.match(rec, /- beta: FAIL — both attempts blew up/, "a lowercase verdict is normalized to FAIL in the record")
})
// ---------------------------------------------------------------------------
// Forge agent routing hint (task 3.6, D9: prompt-level discipline)

test("forge agent prompt carries the routing hint", async (t) => {
  const h = await startServer(input(), {})
  t.after(() => h.dispose?.())
  const cfg = emptyCfg()
  await h.config(cfg)
  assert.match(cfg.agent.forge.prompt, /forge-\*.*subagent|subagent.*forge-\*/s)
  assert.match(cfg.agent.forge.prompt, /native task channel/)
})
