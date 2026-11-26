import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { v2Setup, v2WiringSeam } from "../plugin.ts"
import { createV2MockContext } from "./lib/v2-mock-context.mjs"

// Task 5.2 — forge-subagents wiring suite (spec: forge-subagents +
// crew-harness delta; change simplify-dispatch-to-static-agents). Covers:
//   - materialization WITH a pinned model, NOT hidden, task denied (3.1)
//   - no-clobber of user-defined forge-<id> entries; disable knob silence
//   - the task surface (task-shadow): task is our implementation, no
//     forge_dispatch tool registered
//   - chat.params keyed by agent name: injection, freeze, no-mapping finding
//   - production-catalog P0-1 regression: catalog effort claims never pick
//     the anthropic channel; dead-end freeze survives mid-session config
//     fixes (postrelease-hardening task 5)
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

const allowCtx = (sessionID) => ({
  sessionID, agent: "forge",
  metadata: () => {},
  message: async () => {},
})

async function startV2(dir, existing = {}) {
  v2WiringSeam.resetHostAnchors()
  const mock = createV2MockContext()
  for (const [id, value] of Object.entries(existing)) mock.state.agents.set(id, value)
  await v2Setup(mock.ctx, { anchors: [dir], materialize: "runtime" })
  return mock.state
}

const draftEntry = (state, id) => {
  const entry = state.agents.get(id)
  if (!entry) return undefined
  return { ...entry, prompt: entry.system, permission: Object.fromEntries(entry.permissions.map(({ action, effect }) => [action, effect])) }
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

test("materialization: forge.json agents materialize NAMESPACED with a model, not hidden, task denied, provenance in the description", async (t) => {
  const dir = projectWithForgeJson(
    t,
    JSON.stringify({
      pool: "wire",
      agents: {
        research: { model: "zai/glm-5.3", thoughtLevel: "low", shape: "readonly" },
        builder: { model: "x/y", thoughtLevel: "low", shape: "write", prompt: "You are a build worker." },
        "ta-tool": { model: "x/y2", thoughtLevel: "low" }, // absent shape — shape-default-open
      },
    }),
  )
  const state = await startV2(dir)

  const research = draftEntry(state, "forge-wire-research")
  assert.ok(research, "forge-wire-research must be injected (namespaced forge-<ns>-<id>)")
  assert.equal(draftEntry(state, "forge-research"), undefined, "no plain-id agent exists")
  assert.equal(research.model, undefined, "v2 drafts do not accept a model pin")
  await state.tools.get("forge_sync").execute({}, { sessionID: "ses_compile", agent: "forge", worktree: dir, directory: dir, metadata: () => {} })
  const compiled = readFileSync(join(dir, ".opencode", "agent", "forge-wire-research.md"), "utf8")
  assert.match(compiled, /model: "zai\/glm-5\.3#low"/)
  assert.equal(research.mode, "subagent")
  assert.equal(research.hidden, undefined, "agents stay in the task-tool vocabulary")
  assert.equal(research.permission.task, "deny")
  for (const tool of ["write", "edit", "patch", "applypatch", "apply", "multiedit", "execute"]) assert.equal(research.permission[tool], "deny", `readonly denies ${tool}`)
  assert.equal(research.permission.shell, undefined, "readonly has no blanket shell deny")
  // Provenance (pool-namespace-contract D3): the description names the family
  // namespace, the origin forge.json path, and the dispatchability restriction.
  assert.match(research.description, /Pool 'wire' — origin/)
  assert.ok(research.description.toLowerCase().includes(join(dir, ".opencode", "forge.json").toLowerCase()), "the origin forge.json path rides the description")
  assert.match(research.description, /dispatchable only from sessions whose workspace pool is this file/)

  // shape-default-open: an absent shape materializes with OPEN write
  // permissions (readonly is never a surprise default); only task stays denied.
  const ta = draftEntry(state, "forge-wire-ta-tool")
  assert.ok(ta, "forge-wire-ta-tool must be injected (namespaced)")
  assert.equal(ta.permission.task, "deny")
  for (const tool of ["write", "edit", "patch", "applypatch", "apply", "multiedit", "execute"]) {
    assert.equal(ta.permission[tool], undefined, `absent shape leaves ${tool} open (write default)`)
  }
  assert.match(ta.description, /write/, "the description names the write default")
  assert.match(research.prompt, /research/i)
  assert.match(research.prompt, /workspace-relative paths ONLY/, "discipline mandate present")
  assert.match(research.prompt, /report the refusal VERBATIM/, "verbatim-refusal mandate present")
  assert.match(research.prompt, /evidence references/, "evidence mandate present")

  const builder = draftEntry(state, "forge-wire-builder")
  assert.equal(builder.model, undefined, "v2 drafts omit model pins")
  assert.match(readFileSync(join(dir, ".opencode", "agent", "forge-wire-builder.md"), "utf8"), /model: "x\/y#low"/)
  assert.equal(builder.permission.write, undefined, "write shape drops the mutating denies")
  assert.equal(builder.permission.task, "deny", "task ban survives the shape")
  // D2: workers retain native shell; recursion and harness tools remain denied.
  for (const entry of [research, builder]) {
    assert.equal(entry.permission.shell, undefined, "no blanket shell deny")
    assert.equal(entry.permission.subagent, "deny", "native recursion is denied")
    assert.equal(entry.permission.question, "deny", "questions are denied by default")
    for (const t of ["plan_write", "plan_tick", "plan_approve", "plan_close", "plan_reopen", "plan_discard", "goal_write", "goal_check", "goal_complete", "goal_pause", "goal_resume", "goal_discard", "crew_begin", "crew_close", "forge_sync"]) {
      assert.equal(entry.permission[t], "deny", `harness tool ${t} is primary-only`)
    }
  }
  assert.match(builder.prompt, /build worker/, "explicit prompt overrides the role default")
})

test("materialization: a user-defined forge-<ns>-<id> entry is never clobbered", async (t) => {
  const dir = projectWithForgeJson(t, JSON.stringify({ pool: "wire", agents: { research: { model: "zai/glm", thoughtLevel: "low" } } }))
  const user = { description: "mine", mode: "subagent", system: "keep me", custom: "untouched" }
  const state = await startV2(dir, { "forge-wire-research": user })
  assert.deepEqual(state.agents.get("forge-wire-research"), user)
})

test("materialization: fail-soft — one broken entry does not disable its siblings", async (t) => {
  const dir = projectWithForgeJson(
    t,
    JSON.stringify({ pool: "wire", agents: { good: { model: "p/good", thoughtLevel: "low" }, bad: { thoughtLevel: "low" } } }),
  )
  const state = await startV2(dir)
  assert.ok(draftEntry(state, "forge-wire-good"), "the valid agent still materializes (namespaced)")
  assert.equal(draftEntry(state, "forge-wire-bad"), undefined, "the half-configured entry is skipped")
})

test("materialization: an Auto worker carries no model key and describes inheritance", async (t) => {
  const dir = projectWithForgeJson(t, JSON.stringify({ pool: "wire", agents: { scout: {} } }))
  const state = await startV2(dir)
  const scout = draftEntry(state, "forge-wire-scout")
  assert.ok(scout, "the Auto worker materializes (namespaced)")
  assert.equal(false, "model" in scout, "no model key at all — the host inherits the parent's model")
  assert.equal(scout.mode, "subagent")
  assert.equal(scout.permission.task, "deny", "recursion ban intact")
  assert.match(scout.description, /auto — inherits the parent session's model at dispatch/, "the description names inheritance, not a pinned brain")
  assert.doesNotMatch(scout.description, /pinned/, "no pinned claim for an Auto worker")
  assert.match(scout.description, /Pool 'wire' — origin/, "Auto workers carry the provenance line too")
  assert.equal(scout.permission.shell, undefined, "Auto workers have no blanket shell deny")
  assert.equal(scout.permission.subagent, "deny", "native recursion ban applies to Auto workers too")
  assert.match(scout.prompt, /workspace-relative paths ONLY/, "discipline mandate present")
})

test("materialization: a broken forge.json empties the set (no seed resurrection)", async (t) => {
  const dir = projectWithForgeJson(t, "{ broken")
  const state = await startV2(dir)
  assert.equal(draftEntry(state, "forge-wire-research"), undefined, "no seed exists to fall back to")
})

test("materialization: host agent disable metadata does not disable plugin registrations", async (t) => {
  const dir = projectWithForgeJson(t, JSON.stringify({ pool: "wire", agents: { research: { model: "zai/glm", thoughtLevel: "low" } } }))
  const state = await startV2(dir, { forge: { disable: true } })
  assert.ok(state.tools.has("crew_begin"))
  assert.ok(state.tools.has("plan_write"))
  assert.ok(state.agents.has("forge-wire-research"))
})

test("materialization: a forge--prefixed id self-heals — single-prefix agent, no doubling", async (t) => {
  const dir = projectWithForgeJson(t, JSON.stringify({ pool: "wire", agents: { "forge-coder": { model: "zai/glm", thoughtLevel: "low" } } }))
  const state = await startV2(dir)
  assert.ok(state.agents.get("forge-wire-coder"), "materialized under the single-prefix namespaced name")
  assert.ok(!state.agents.get("forge-wire-forge-coder"), "no doubled prefix")
  state.sessionRecords.set("ses_prefix", { agent: "forge" })
  await state.commands.get("crew").execute({ sessionID: "ses_prefix" })
  const template = state.prompts.find((p) => p.sessionID === "ses_prefix")?.text ?? ""
  assert.match(template, /forge-wire-coder/, "the roster lists the healed name")
  assert.doesNotMatch(template, /forge-wire-forge-coder/)
})



// ---------------------------------------------------------------------------
// crew_begin / crew_close wiring (spec: crew-harness — "crew_close completion
// gate" + declared-plan registration)



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






// ---------------------------------------------------------------------------
// Crew execution-mode gate (change add-crew-execution-mode-gate): two-phase
// lifecycle (register PENDING -> arm), the pending dispatch belt, the goal
// conversion path, the abandon path, origin disclosure, the crew record.

const poolJson = JSON.stringify({ pool: "wire", agents: { research: { model: "zai/glm", thoughtLevel: "low" } } })

test("crew lifecycle: registration PENDS — three-choice surface, dispatch belt, arm call", async (t) => {
  const dir = projectWithForgeJson(t, poolJson)
  v2WiringSeam.resetHostAnchors()
  const { ctx, state } = createV2MockContext()
  const cleanup = await v2Setup(ctx, { anchors: [dir], materialize: "runtime" })
  t.after(async () => { await cleanup?.(); v2WiringSeam.resetHostAnchors() })
  const begin = (args, sessionID) => state.tools.get("crew_begin").execute(args, { sessionID, agent: "forge", worktree: dir })
  const before = state.toolHooks.find(hook => hook.name === "execute.before").cb

  const out = await begin({ objective: "gate it", subtasks: [{ title: "one" }] }, "ses_lifecycle")
  assert.match(out.content, /registered PENDING/, "registration announces the pending state")
  const recLine = out.content.indexOf("Crew record (inspectable history")
  const objLine = out.content.indexOf("registered PENDING")
  const planLine = out.content.indexOf("Declared plan (")
  assert.ok(recLine !== -1 && objLine !== -1 && planLine !== -1 && recLine < objLine && objLine < planLine, "the record path line leads the output, before the objective summary and the declared plan (4.1)")
  assert.match(out.content, /RELAY FIRST: tell the user the crew record path/, "the PENDING pause text mandates relaying the record path to the user (4.2)")
  assert.match(out.content, /supervised waves NOW/, "three-choice surface: waves")
  assert.match(out.content, /convert to a goal contract/, "three-choice surface: goal")
  assert.match(out.content, /standby/, "three-choice surface: standby")
  assert.match(out.content, /END YOUR TURN/, "the stop mandate")
  assert.match(out.content, /Session roster origins — sole ownership/, "the session-scoped roster disclosure")
  assert.match(out.content, /DISPATCHABLE from this session — workspace pool: [^\n]*forge\.json/, "the session's own pool leads with its origin path")
  assert.doesNotMatch(out.content, /Proceed with the discipline/, "registration no longer orders immediate execution")
  assert.equal(v2WiringSeam.crews.get("ses_lifecycle").mode, "pending")

  // Belt: every task dispatch refuses while the crew pends.
  await assert.rejects(
    () => before({ tool: "subagent", sessionID: "ses_lifecycle", agent: "forge", messageID: "m", id: "cb1", input: { agent: "general" } }),
    /PENDING/,
  )

  // Arm call (shape-disjoint: execution only, no plan payload).
  const armed = await begin({ execution: "waves" }, "ses_lifecycle")
  assert.match(armed.content, /ARMED for supervised waves/)
  // crew-native-fallback 1.2: the waves-arming output teaches the fallback lane.
  assert.match(armed.content, /Native fallback: when the pool offers no forge worker fitting a subtask/, "the arming output carries the fallback rule")
  assert.match(armed.content, /RECORD the fallback/, "the recording duty (wave notes + close evidence says it ran native)")
  assert.match(armed.content, /native `subagent` calls made together/)
  assert.match(armed.content, /every work round of the previous wave is verified settled/)
  assert.match(armed.content, /existing user approval rules/)
  assert.equal(v2WiringSeam.crews.get("ses_lifecycle").mode, "executing")
  await before({ tool: "subagent", sessionID: "ses_lifecycle", agent: "forge", messageID: "m", id: "cb2", input: { agent: "general" } })

  // Re-arm refuses; arm without a crew refuses; bogus execution value refuses.
  await assert.rejects(() => begin({ execution: "waves" }, "ses_lifecycle"), /already armed/)
  await assert.rejects(() => begin({ execution: "waves" }, "ses_noarm"), /No active crew to arm/)
  await assert.rejects(() => begin({ execution: "fast" }, "ses_noarm"), /execution must be/)
})

test("crew lifecycle: goal conversion ends the crew and directs goal_write(arm)", async (t) => {
  const dir = projectWithForgeJson(t, poolJson)
  v2WiringSeam.resetHostAnchors()
  const { ctx, state } = createV2MockContext()
  const cleanup = await v2Setup(ctx, { anchors: [dir], materialize: "runtime" })
  t.after(async () => { await cleanup?.(); v2WiringSeam.resetHostAnchors() })
  const begin = (args, sessionID) => state.tools.get("crew_begin").execute(args, { sessionID, agent: "forge", worktree: dir })
  const before = state.toolHooks.find(hook => hook.name === "execute.before").cb
  await begin({ objective: "convert me", subtasks: [{ title: "one" }, { title: "two", agent: "forge-research" }] }, "ses_conv")
  const recordPath = v2WiringSeam.crews.get("ses_conv").recordPath
  const out = await begin({ execution: "goal" }, "ses_conv")
  assert.match(out.content, /CONVERSION record/)
  assert.match(out.content, /goal_write with arm=true/)
  assert.match(out.content, /1\. one/, "the declared plan rides along for folding")
  // crew-goal-conversion-relay 1.1: the conversion output relays the crew layer
  // into the goal loop — relay, structure-preservation directive, and a
  // ready-to-adapt born-armed sketch the first post-arming turn can act on.
  assert.match(out.content, /BORN-ARMED crew in ONE call/, "the relay states the goal loop may re-register the plan born-armed in ONE call")
  assert.match(out.content, /Preserve the subtask STRUCTURE/, "the structure-preservation directive keeps subtask titles and forge-* agent assignments intact inside the goal contract")
  assert.match(out.content, /Born-armed registration sketch/, "a ready-to-adapt born-armed registration sketch rides along (naming the declared subtasks)")
  assert.equal(v2WiringSeam.crews.get("ses_conv"), undefined, "conversion ends the crew")
  assert.match(readFileSync(recordPath, "utf8"), /converted to goal/, "the record carries the conversion")
  // The belt is gone with the crew: task dispatch no longer refuses.
  await before({ tool: "subagent", sessionID: "ses_conv", agent: "forge", messageID: "m", id: "cb3", input: { agent: "general" } })
})

test("v2 crew record failure at an existing file anchor remains fail-soft", async (t) => {
  const ws = workspaceWithForgeJson(t, poolJson)
  v2WiringSeam.resetHostAnchors()
  const { ctx, state } = createV2MockContext()
  const cleanup = await v2Setup(ctx, { anchors: [ws], materialize: "runtime" })
  t.after(async () => { await cleanup?.(); v2WiringSeam.resetHostAnchors() })
  const asFile = join(ws, "notdir.txt")
  writeFileSync(asFile, "i am a file, not a directory")
  state.sessionRecords.set("ses_soft_v2", { location: { directory: asFile } })
  const soft = await state.tools.get("crew_begin").execute({ objective: "no record", subtasks: [{ title: "x" }] }, { sessionID: "ses_soft_v2", agent: "forge" })
  assert.match(soft.content, /could not be written \(fail-soft/)
  const softCrew = v2WiringSeam.crews.get("ses_soft_v2")
  assert.equal(softCrew.recordPath, null)
  assert.equal(softCrew.mode, "pending")
})


// ---------------------------------------------------------------------------
// Crew-harness template rewrite (change add-crew-execution-mode-gate): the
// pause step, GUI-wave mutex, computer-tool preference, abandon exit, and the
// source-agnostic framing.


// ---------------------------------------------------------------------------
// plan-supersession-and-lineage wiring (task 5.2): registration output
// ordering, lineage recording, the PENDING relay mandate, the draft-gate
// exits, and the crew record's dated close section.

test("crew registration output order: record path leads, then the objective, then the declared plan; explicit lineage is disclosed", async (t) => {
  const dir = projectWithForgeJson(t, poolJson)
  v2WiringSeam.resetHostAnchors()
  const { ctx, state } = createV2MockContext()
  const cleanup = await v2Setup(ctx, { anchors: [dir], materialize: "runtime" })
  t.after(async () => { await cleanup?.(); v2WiringSeam.resetHostAnchors() })
  const begin = (args, sessionID) => state.tools.get("crew_begin").execute(args, { ...allowCtx(sessionID), worktree: dir, directory: dir })
  const out = await begin(
    { objective: "descend from a plan", subtasks: [{ title: "one" }], lineage: ".opencode/plan/2026-10-01-my-plan.md" },
    "ses_order",
  )
  const recLine = out.content.indexOf("Crew record (inspectable history")
  const objLine = out.content.indexOf("Objective: descend from a plan")
  const planLine = out.content.indexOf("Declared plan (")
  assert.ok(recLine !== -1 && objLine !== -1 && planLine !== -1, "all three blocks are present")
  assert.ok(recLine < objLine, "the crew record path line leads the output (4.1)")
  assert.ok(objLine < planLine, "the objective summary precedes the declared plan (4.1)")
  assert.match(out.content, /Lineage: \.opencode\/plan\/2026-10-01-my-plan\.md/, "an explicit lineage is disclosed in the registration output (4.3)")
})

// crew-contract-relay task 3: the registration output reminds the session AI
// of the relay rule whenever lineage is present — and stays silent without it.
test("crew registration relay rule: the reminder line appears with lineage and is absent without it", async (t) => {
  const dir = projectWithForgeJson(t, poolJson)
  v2WiringSeam.resetHostAnchors()
  const { ctx, state } = createV2MockContext()
  const cleanup = await v2Setup(ctx, { anchors: [dir], materialize: "runtime" })
  t.after(async () => { await cleanup?.(); v2WiringSeam.resetHostAnchors() })
  const begin = (args, sessionID) => state.tools.get("crew_begin").execute(args, { ...allowCtx(sessionID), worktree: dir, directory: dir })
  const withLin = await begin(
    { objective: "relay the contract", subtasks: [{ title: "one" }], lineage: ".opencode/plan/2026-10-01-src.md" },
    "ses_relay_rule_yes",
  )
  assert.match(
    withLin.content,
    /RELAY RULE: this crew descends from \.opencode\/plan\/2026-10-01-src\.md — every dispatch prompt must explicitly carry the artifact path \(or its exact slice\), and every close-report evidence statement must name the contract it worked against\./,
    "lineage present → the relay-rule reminder line spells out both halves (crew-contract-relay 2)",
  )
  const linAt = withLin.content.indexOf("Lineage: .opencode/plan/2026-10-01-src.md")
  const ruleAt = withLin.content.indexOf("RELAY RULE:")
  assert.ok(linAt !== -1 && ruleAt !== -1 && linAt < ruleAt, "the reminder follows the lineage disclosure line")
  const withoutLin = await begin({ objective: "no contract artifact", subtasks: [{ title: "one" }] }, "ses_relay_rule_no")
  assert.doesNotMatch(withoutLin.content, /RELAY RULE/, "no lineage → no relay-rule reminder (never inferred)")
  assert.doesNotMatch(withoutLin.content, /Lineage: /, "no lineage → no lineage disclosure line")
})

test("crew record header: an explicit lineage lands as a sibling header line; without the argument there is none", async (t) => {
  const dir = projectWithForgeJson(t, poolJson)
  v2WiringSeam.resetHostAnchors()
  const { ctx, state } = createV2MockContext()
  const cleanup = await v2Setup(ctx, { anchors: [dir], materialize: "runtime" })
  t.after(async () => { await cleanup?.(); v2WiringSeam.resetHostAnchors() })
  const begin = (args, sessionID) => state.tools.get("crew_begin").execute(args, { ...allowCtx(sessionID), worktree: dir, directory: dir })
  await begin(
    { objective: "lineage present", subtasks: [{ title: "one" }], lineage: ".opencode/plan/2026-10-01-src.md" },
    "ses_lin_yes",
  )
  const withLin = readFileSync(v2WiringSeam.crews.get("ses_lin_yes").recordPath, "utf8")
  const header = withLin.slice(0, withLin.indexOf("## Declared plan"))
  const regAt = header.indexOf("- registered: ")
  const anchorAt = header.indexOf("- anchor: ")
  const linAt = header.indexOf("- lineage: .opencode/plan/2026-10-01-src.md")
  assert.ok(regAt !== -1 && anchorAt !== -1 && linAt !== -1, "lineage is a header sibling of registered/anchor (4.3)")
  assert.ok(regAt < anchorAt && anchorAt < linAt, "the lineage line sits in the header block after the anchor line")
  // Explicit-only (negative): registration without the argument leaves no lineage line.
  await begin({ objective: "lineage absent", subtasks: [{ title: "one" }] }, "ses_lin_no")
  const withoutLin = readFileSync(v2WiringSeam.crews.get("ses_lin_no").recordPath, "utf8")
  assert.doesNotMatch(withoutLin, /^- lineage:/m, "no lineage line without an explicit argument (never inferred)")
  assert.match(withoutLin, /^- registered: /m)
})

test("PENDING pause: the relay-first mandate names the crew record path and precedes the three choices", async (t) => {
  const dir = projectWithForgeJson(t, poolJson)
  v2WiringSeam.resetHostAnchors()
  const { ctx, state } = createV2MockContext()
  const cleanup = await v2Setup(ctx, { anchors: [dir], materialize: "runtime" })
  t.after(async () => { await cleanup?.(); v2WiringSeam.resetHostAnchors() })
  const begin = (args, sessionID) => state.tools.get("crew_begin").execute(args, { ...allowCtx(sessionID), worktree: dir, directory: dir })
  const out = await begin({ objective: "relay the path", subtasks: [{ title: "one" }] }, "ses_relay")
  assert.match(out.content, /RELAY FIRST: tell the user the crew record path/, "the PENDING text mandates relaying the record path (4.2)")
  const relayAt = out.content.indexOf("RELAY FIRST")
  const choiceAt = out.content.indexOf("1. supervised waves NOW")
  assert.ok(relayAt !== -1 && choiceAt !== -1 && relayAt < choiceAt, "the relay mandate precedes the execution-mode choices")
})


// ---------------------------------------------------------------------------
// Forge agent routing hint (task 3.6, D9: prompt-level discipline)

test("forge agent prompt carries the routing hint", async (t) => {
  const state = await startV2(worktree)
  const prompt = state.agents.get("forge").system
  assert.match(prompt, /forge-\*.*subagent|subagent.*forge-\*/s)
  assert.match(prompt, /native `subagent` tool/)
  assert.match(prompt, /host shell when permitted/)
  assert.match(prompt, /`background` and host completion notifications/)
  assert.doesNotMatch(prompt, /forge_shell|forge_jobs|run_in_background|task tool/)
})

// ---------------------------------------------------------------------------
// forge-prompt-shared wiring (design D4): v2 setup materialization
// passes each agent's ORIGIN-file `shared` segment into forgeAgentDef — the
// materialized prompt carries shared in the role slot beneath the mandates;
// without shared the prompt is byte-identical to the legacy build.

test("materialization: a pool's shared segment rides every materialized prompt beneath the mandates (fail-soft on invalid)", async (t) => {
  const seg = "Project X conventions: use bun; cite file:line evidence."
  const mk = (extra) => JSON.stringify({
    pool: "wp",
    ...extra,
    agents: {
      research: { model: "zai/glm", thoughtLevel: "low" },
      auditor: { model: "x/y", thoughtLevel: "low", prompt: "Audit licenses." },
    },
  })
  const dir = projectWithForgeJson(t, mk({ shared: seg }))
  const state = await startV2(dir)
  for (const [id, roleLine] of [
    ["forge-wp-research", /research worker/i],
    ["forge-wp-auditor", /Audit licenses\./],
  ]) {
    const entry = draftEntry(state, id)
    assert.ok(entry, `${id} materializes`)
    assert.ok(entry.prompt.includes(seg), `${id}: the shared segment rides the prompt`)
    // Strict prepend: shared + blank line + the chain layer (role default or
    // explicit prompt), all still INSIDE the role slot above the mandates.
    assert.ok(entry.prompt.indexOf(seg) < entry.prompt.indexOf("Mandates"), `${id}: shared sits below the mandates in composition order`)
    assert.match(entry.prompt, roleLine)
    assert.match(entry.prompt, /workspace-relative paths ONLY/, `${id}: mandate frame untouched`)
  }

  // Invalid shared (a number): ONE warn finding surfaces through the config
  // diagnostics, the field is ignored, agents still materialize UNSHARED.
  const dirBad = projectWithForgeJson(t, mk({ shared: 42 }))
  let state2
  const warns = []
  const origWarn = console.warn
  console.warn = (...args) => warns.push(args.map(String).join(" "))
  try {
    state2 = await startV2(dirBad)
  } finally {
    console.warn = origWarn
  }
  const sharedWarns = warns.filter((w) => w.includes('the top-level "shared" field must be a non-empty string'))
  assert.equal(sharedWarns.length, 1, "exactly one shared-invalid diagnostics line")
  assert.ok(sharedWarns[0].toLowerCase().includes(join(dirBad, ".opencode", "forge.json").toLowerCase()), "the finding names the file")
  const bad = draftEntry(state2, "forge-wp-research")
  assert.ok(bad, "agents materialize despite the invalid shared")
  assert.ok(!bad.prompt.includes(seg), "the invalid field is ignored — no segment rides the prompt")
  assert.match(bad.prompt, /research worker/i, "the unshared chain materializes normally")
})
