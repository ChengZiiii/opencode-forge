import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, readdirSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Debounce must be tiny BEFORE plugin.ts is imported (module-level const).
process.env.FORGE_GOAL_DEBOUNCE_MS = "10"
process.env.FORGE_TEST_NO_FENCE = "1"
const { server } = await import("../plugin.ts")

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const allowAsk = async () => {}

function inputFor(wt) {
  return {
    client: { session: {} },
    project: { id: "p" },
    directory: wt,
    worktree: wt,
    serverUrl: new URL("http://127.0.0.1:1"),
    $: () => {},
    experimental_workspace: { register() {} },
  }
}

const ctx = (sid, wt) => ({ sessionID: sid, worktree: wt, ask: allowAsk, metadata() {}, callID: "c", agent: "forge", messageID: "m" })

const seed = (h, sid, agent) => h["chat.message"]({ sessionID: sid, agent }, { message: {}, parts: [] })

const ALL_FORGE_TOOLS = [
  "plan_write", "plan_tick", "plan_approve", "plan_close", "plan_discard",
  "goal_write", "goal_check", "goal_complete", "goal_pause", "goal_resume", "goal_discard",
  "crew_begin", "crew_close", "forge_shell", "forge_jobs",
]
const STATE_TOOLS = ALL_FORGE_TOOLS.filter((t) => t !== "forge_shell" && t !== "forge_jobs")

// ---------------------------------------------------------------------------
// config-side partition injections (task 3.1 / 2.4)
// ---------------------------------------------------------------------------

test("partition config: non-forge agents hide every plugin tool; explicit true is respected; nobody is disabled", async () => {
  const wt = mkdtempSync(join(tmpdir(), "part-cfg-"))
  try {
    const h = await server(inputFor(wt), {})
    const cfg = { agent: { mine: { tools: { forge_shell: true } }, plain: {} } }
    await h.config(cfg)
    for (const t of ALL_FORGE_TOOLS) {
      assert.equal(cfg.agent.plain.tools[t], false, `plain agent hides ${t}`)
      assert.equal(cfg.agent.mine.tools[t], t === "forge_shell" ? true : false, `mine respects explicit true for ${t}`)
    }
    // Native fallbacks materialized as minimal partition entries.
    for (const native of ["build", "plan", "general", "explore"]) {
      assert.ok(cfg.agent[native], `${native} materialized`)
      assert.equal(cfg.agent[native].disable, undefined, `${native} is NOT disabled`)
      for (const t of ALL_FORGE_TOOLS) assert.equal(cfg.agent[native].tools[t], false, `${native} hides ${t}`)
      assert.equal(Object.keys(cfg.agent[native]).length === 1 && cfg.agent[native].tools !== undefined, true, `${native} entry is minimal`)
    }
    // The forge family is never touched by the non-forge pass.
    assert.equal(cfg.agent.forge.tools.write, undefined)
    // Default subject (D13): coexistence must not flip the default to build.
    assert.equal(cfg.default_agent, "forge")
    await h.dispose?.()
  } finally {
    rmSync(wt, { recursive: true, force: true })
  }
})

test("partition config: an explicit user default_agent is respected", async () => {
  const wt = mkdtempSync(join(tmpdir(), "part-def-"))
  try {
    const h = await server(inputFor(wt), {})
    const cfg = { agent: {}, default_agent: "build" }
    await h.config(cfg)
    assert.equal(cfg.default_agent, "build", "the user's explicit choice stands")
    await h.dispose?.()
  } finally {
    rmSync(wt, { recursive: true, force: true })
  }
})

test("partition config: forge-* workers lose harness state tools but keep the exec pair", async () => {
  const wt = mkdtempSync(join(tmpdir(), "part-worker-"))
  try {
    mkdirSync(join(wt, ".opencode"), { recursive: true })
    writeFileSync(join(wt, ".opencode", "forge.json"), JSON.stringify({ agents: { builder: { model: "x/y", shape: "write" } } }))
    const h = await server(inputFor(wt), {})
    const cfg = { agent: {} }
    await h.config(cfg)
    const worker = cfg.agent["forge-builder"]
    assert.ok(worker, "worker materialized")
    assert.equal(worker.tools.shell, false, "builtin shell hidden at materialization")
    assert.equal(worker.tools.bash, false)
    assert.equal(worker.permission.task, "deny")
    for (const t of STATE_TOOLS) assert.equal(worker.tools[t], false, `worker hides state tool ${t}`)
    assert.equal(worker.tools.forge_shell, undefined, "worker keeps forge_shell")
    assert.equal(worker.tools.forge_jobs, undefined, "worker keeps forge_jobs")
    // The primary is not reduced.
    assert.equal(cfg.agent.forge.tools.plan_write, undefined)
    await h.dispose?.()
  } finally {
    rmSync(wt, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// runtime belts (tasks 4.4 / 4.7 / 4.9)
// ---------------------------------------------------------------------------

test("partition belt: task dispatch of forge-* is refused for non-forge speakers, open for forge/unknown", async () => {
  const wt = mkdtempSync(join(tmpdir(), "part-dispatch-"))
  try {
    const h = await server(inputFor(wt), {})
    await seed(h, "ses_b", "build")
    await seed(h, "ses_f", "forge")
    await seed(h, "ses_w", "forge-research")
    const out = () => ({ args: { subagent_type: "forge-research", prompt: "x" } })
    await assert.rejects(
      h["tool.execute.before"]({ tool: "task", sessionID: "ses_b", callID: "c1" }, out()),
      /\[forge:partition\] Dispatch refused.*forge-research.*outside the forge family/,
    )
    await h["tool.execute.before"]({ tool: "task", sessionID: "ses_f", callID: "c2" }, out())
    await h["tool.execute.before"]({ tool: "task", sessionID: "ses_w", callID: "c3" }, out())
    // Unknown speakers fail open (map is the best signal available).
    await h["tool.execute.before"]({ tool: "task", sessionID: "ses_u", callID: "c4" }, out())
    // Non-forge target is never touched.
    await h["tool.execute.before"]({ tool: "task", sessionID: "ses_b", callID: "c5" }, { args: { subagent_type: "general", prompt: "x" } })
    await h.dispose?.()
  } finally {
    rmSync(wt, { recursive: true, force: true })
  }
})

test("partition belt: non-forge writes into forge state directories are refused; others pass", async () => {
  const wt = mkdtempSync(join(tmpdir(), "part-state-"))
  try {
    const h = await server(inputFor(wt), {})
    await seed(h, "ses_b", "build")
    await seed(h, "ses_f", "forge")
    const planFile = join(wt, ".opencode", "plan", "x.md")
    const goalFile = join(wt, ".opencode", "goal", "g.md")
    await assert.rejects(
      h["tool.execute.before"]({ tool: "write", sessionID: "ses_b", callID: "c1" }, { args: { filePath: planFile } }),
      /\[forge:partition\] Write refused.*forge state directories/,
    )
    await assert.rejects(
      h["tool.execute.before"]({ tool: "edit", sessionID: "ses_b", callID: "c2" }, { args: { filePath: goalFile } }),
      /\[forge:partition\] Write refused/,
    )
    // Relative paths resolve against the session worktree.
    await assert.rejects(
      h["tool.execute.before"]({ tool: "write", sessionID: "ses_b", callID: "c3" }, { args: { filePath: ".opencode/plan/rel.md" } }),
      /\[forge:partition\] Write refused/,
    )
    // Reads, other paths, forge speakers, and unknown speakers pass.
    await h["tool.execute.before"]({ tool: "read", sessionID: "ses_b", callID: "c4" }, { args: { filePath: planFile } })
    await h["tool.execute.before"]({ tool: "write", sessionID: "ses_b", callID: "c5" }, { args: { filePath: "src/ok.ts" } })
    await h["tool.execute.before"]({ tool: "write", sessionID: "ses_f", callID: "c6" }, { args: { filePath: planFile } })
    await h["tool.execute.before"]({ tool: "write", sessionID: "ses_u", callID: "c7" }, { args: { filePath: planFile } })
    await h.dispose?.()
  } finally {
    rmSync(wt, { recursive: true, force: true })
  }
})

test("partition fallback belts: forge bash refused, non-forge forge tools refused, hatches open, unknown open", async () => {
  const wt = mkdtempSync(join(tmpdir(), "part-belt-"))
  try {
    const h = await server(inputFor(wt), {})
    await seed(h, "ses_f", "forge")
    await seed(h, "ses_b", "build")
    // Forge speaker: builtin shell hard-refused with forge_shell guidance.
    await assert.rejects(
      h["tool.execute.before"]({ tool: "bash", sessionID: "ses_f", callID: "c1" }, { args: { command: "echo x" } }),
      /\[forge:partition\] Builtin shell refused.*forge_shell/,
    )
    await assert.rejects(
      h["tool.execute.before"]({ tool: "shell", sessionID: "ses_f", callID: "c2" }, { args: { command: "echo x" } }),
      /\[forge:partition\] Builtin shell refused/,
    )
    // Non-forge speaker: any forge tool refused with partition guidance.
    await assert.rejects(
      h["tool.execute.before"]({ tool: "forge_shell", sessionID: "ses_b", callID: "c3" }, { args: { command: "echo x" } }),
      /\[forge:partition\] Tool refused: "forge_shell".*outside it/,
    )
    await assert.rejects(
      h["tool.execute.before"]({ tool: "plan_write", sessionID: "ses_b", callID: "c4" }, { args: {} }),
      /\[forge:partition\] Tool refused/,
    )
    // Escape hatch: keepBuiltinShell opens the builtin shell for the family.
    const h2 = await server(inputFor(mkdtempSync(join(tmpdir(), "part-belt2-"))), { jobs: { keepBuiltinShell: true } })
    await seed(h2, "ses_f2", "forge")
    await h2["tool.execute.before"]({ tool: "bash", sessionID: "ses_f2", callID: "c5" }, { args: { command: "echo x" } })
    // Unknown speakers fail open on both belts.
    await h["tool.execute.before"]({ tool: "bash", sessionID: "ses_u", callID: "c6" }, { args: { command: "echo x" } })
    await h["tool.execute.before"]({ tool: "forge_shell", sessionID: "ses_u", callID: "c7" }, { args: { command: "echo x" } })
    // Non-forge speaker using non-forge tools passes.
    await h["tool.execute.before"]({ tool: "write", sessionID: "ses_b", callID: "c8" }, { args: { filePath: "src/x.ts" } })
    await h.dispose?.()
    await h2.dispose?.()
  } finally {
    rmSync(wt, { recursive: true, force: true })
  }
})

test("partition: the draft write-ban message is agent-agnostic (D12, session-scoped)", async () => {
  const wt = mkdtempSync(join(tmpdir(), "part-draft-"))
  try {
    const h = await server(inputFor(wt), {})
    const sid = "ses_draft"
    await h.tool.plan_write.execute(
      { goal: "draft ban wording", context: "c", approach: "a", tasks: ["one"], risks: "none", acceptance: ["ok"] },
      ctx(sid, wt),
    )
    // Speaker switches to build; the session-scoped ban still bites.
    await seed(h, sid, "build")
    await assert.rejects(
      h["tool.execute.before"]({ tool: "write", sessionID: sid, callID: "c1" }, { args: { filePath: "src/x.ts" } }),
      /A plan is in draft.*Switch back to the forge agent.*plan_approve.*\/plan discard/,
    )
    // Draft-phase task dispatch from the non-forge speaker is also banned.
    await assert.rejects(
      h["tool.execute.before"]({ tool: "task", sessionID: sid, callID: "c2" }, { args: { subagent_type: "general", prompt: "x" } }),
      /A plan is in draft/,
    )
    await h.dispose?.()
  } finally {
    rmSync(wt, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// command templates (task 4.6)
// ---------------------------------------------------------------------------

test("partition: /plan, /goal, /crew templates lead with the family guard", async () => {
  const wt = mkdtempSync(join(tmpdir(), "part-cmd-"))
  try {
    mkdirSync(join(wt, ".opencode"), { recursive: true })
    writeFileSync(join(wt, ".opencode", "forge.json"), JSON.stringify({ agents: { research: { model: "x/y" } } }))
    const h = await server(inputFor(wt), {})
    const cfg = { agent: {} }
    await h.config(cfg)
    for (const [cmd, entryTool] of [["plan", "plan_write"], ["goal", "goal_write"]]) {
      const t = cfg.command[cmd].template
      assert.match(t, /FAMILY GUARD \(step 0/, `${cmd} carries the guard`)
      assert.ok(t.indexOf("FAMILY GUARD") < t.indexOf(entryTool), `${cmd} guard precedes the discipline (${entryTool})`)
      assert.match(t, new RegExp(entryTool), `${cmd} guard names the entry tool`)
    }
    const crew = cfg.command.crew.template
    assert.match(crew, /FAMILY GUARD \(step 0/)
    assert.ok(crew.indexOf("FAMILY GUARD") < crew.indexOf("crew_begin"), "crew guard precedes the discipline")
    // Unconfigured /crew (init-gate form) carries the same guard.
    const h2 = await server(inputFor(mkdtempSync(join(tmpdir(), "part-cmd2-"))), {})
    const cfg2 = { agent: {} }
    await h2.config(cfg2)
    assert.match(cfg2.command.crew.template, /FAMILY GUARD \(step 0/)
    await h.dispose?.()
    await h2.dispose?.()
  } finally {
    rmSync(wt, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// engine + injection gates (tasks 4.1 / 4.2 / 4.8)
// ---------------------------------------------------------------------------

test("partition: the goal loop parks under a non-forge speaker and resumes on forge", async () => {
  const wt = mkdtempSync(join(tmpdir(), "part-goal-"))
  try {
    const prompts = []
    const client = {
      session: {
        prompt: async (body) => prompts.push(body),
        get: async () => ({ directory: wt, worktree: wt }),
        status: async (o) => ({ [o.path.id]: { type: "idle" } }),
      },
    }
    const h = await server({ ...inputFor(wt), client }, {})
    const sid = "ses_goal"
    await h.tool.goal_write.execute(
      {
        goal: "family-gated loop",
        criteria: ["done"],
        checks: [{ containsFile: "done.txt", containsText: "done" }],
        constraints: "c",
        arm: true,
      },
      ctx(sid, wt),
    )
    // Speaker switches to build; idle must not continue and must not burn budget.
    await seed(h, sid, "build")
    await h.event({ event: { type: "session.idle", properties: { sessionID: sid } } })
    await sleep(80)
    assert.equal(prompts.length, 0, "no continuation under a non-forge speaker")
    const docOf = () => Number(/^turns_used: (\d+)$/m.exec(readGoal(wt))?.[1])
    assert.equal(docOf(), 0, "budget untouched while parked")
    // Switch back to forge: the loop resumes.
    await seed(h, sid, "forge")
    await h.event({ event: { type: "session.idle", properties: { sessionID: sid } } })
    await sleep(80)
    assert.equal(prompts.length, 1, "continuation resumes for the forge speaker")
    assert.match(prompts[0].body.parts[0].text, /\[forge:goal-continue\]/)
    await h.dispose?.()
  } finally {
    rmSync(wt, { recursive: true, force: true })
  }
})

function readGoal(wt) {
  const dir = join(wt, ".opencode", "goal")
  const f = join(dir, readdirSync(dir).find((x) => x.endsWith(".md")))
  return readFileSync(f, "utf8")
}

test("partition: compaction brief and auto-continue suppression follow the agent family", async () => {
  const wt = mkdtempSync(join(tmpdir(), "part-compact-"))
  try {
    const h = await server(inputFor(wt), {})
    const sid = "ses_comp"
    await h.tool.goal_write.execute(
      {
        goal: "family-gated compaction",
        criteria: ["done"],
        checks: [{ containsFile: "done.txt", containsText: "done" }],
        constraints: "c",
        arm: true,
      },
      ctx(sid, wt),
    )
    // Forge speaker: brief rides, suppression applies.
    const compacting = { context: [] }
    await h["experimental.session.compacting"]({ sessionID: sid }, compacting)
    assert.equal(compacting.context.length, 1)
    assert.match(compacting.context[0], /\[forge:goal-brief\]/)
    const ac1 = { enabled: true }
    await h["experimental.compaction.autocontinue"]({ sessionID: sid }, ac1)
    assert.equal(ac1.enabled, false)
    // Non-forge speaker: no forge text, native auto-continue restored.
    await seed(h, sid, "build")
    const compacting2 = { context: [] }
    await h["experimental.session.compacting"]({ sessionID: sid }, compacting2)
    assert.equal(compacting2.context.length, 0, "non-forge sessions carry no forge brief")
    const ac2 = { enabled: true }
    await h["experimental.compaction.autocontinue"]({ sessionID: sid }, ac2)
    assert.equal(ac2.enabled, true, "suppression is family-gated")
    await h.dispose?.()
  } finally {
    rmSync(wt, { recursive: true, force: true })
  }
})

test("partition: session.deleted evicts the family map", async () => {
  const wt = mkdtempSync(join(tmpdir(), "part-evict-"))
  try {
    const h = await server(inputFor(wt), {})
    await seed(h, "ses_x", "forge")
    const out1 = { system: [] }
    await h["experimental.chat.system.transform"]({ sessionID: "ses_x" }, out1)
    assert.ok(out1.system.some((s) => s.startsWith("[forge:job-guidance]")))
    await h.event({ event: { type: "session.deleted", properties: { info: { id: "ses_x" } } } })
    const out2 = { system: [] }
    await h["experimental.chat.system.transform"]({ sessionID: "ses_x" }, out2)
    assert.ok(!out2.system.some((s) => s.startsWith("[forge:")), "the evicted session is unknown again")
    await h.dispose?.()
  } finally {
    rmSync(wt, { recursive: true, force: true })
  }
})
