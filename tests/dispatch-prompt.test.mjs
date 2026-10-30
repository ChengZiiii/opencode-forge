import test from "node:test"
import assert from "node:assert/strict"

// Task 2.1 — materialization prompt + agent def (spec: forge-subagents —
// "Materialization as native subagents with a pinned model"): the standing
// prompt carries the three mandates around the role text; the agent entry
// pins `model`, drops `hidden`, keeps the task recursion ban, and its
// description is the task-tool vocabulary entry.

import { materializeAgentPrompt, WORKER_MANDATES } from "../src/dispatch-prompt.ts"
import { rolePromptFor, forgeAgentDef, agentDescriptionFor, effectiveReadonlyShape, poolProvenanceLine } from "../src/dispatch-tiers.ts"

test("role prompt layer 1: an explicit def.prompt overrides everything", () => {
  const role = rolePromptFor("auditor", { prompt: "You are a dependency auditor; check licenses.", model: "x/y" })
  assert.equal(role, "You are a dependency auditor; check licenses.")
})

test("role prompt layer 2: built-in roles (research/review) have curated defaults", () => {
  const research = rolePromptFor("research", { model: "x/y" })
  assert.match(research, /research/i)
  assert.match(research, /report/i)
  const review = rolePromptFor("review", { model: "x/y" })
  assert.match(review, /review/i)
  assert.match(review, /file:line/i)
})

test("role prompt layer 3: a custom agent without a prompt gets the generic worker role", () => {
  const generic = rolePromptFor("summarizer", { model: "x/y" })
  assert.match(generic, /summarizer/)
  assert.match(generic, /task/i)
})

test("the materialized prompt embeds the mandates (never replaceable)", () => {
  const p = materializeAgentPrompt({ agent: "research", shape: "readonly", role: "ROLE TEXT" })
  assert.match(p, /workspace-relative paths ONLY/)
  assert.match(p, /report the refusal VERBATIM/)
  assert.match(p, /evidence references/)
  assert.match(p, /Run every shell command through the forge_shell tool/, "exec-partition mandate present")
  assert.match(p, /builtin shell is not part of your toolset/, "the hide is stated as the design")
  assert.match(p, /ROLE TEXT/, "the role text rides inside the frame")
  // The mandates sit AFTER the role text (outermost discipline at the bottom).
  assert.ok(p.indexOf("ROLE TEXT") < p.indexOf("Mandates"))
})

test("the frame differs by shape: readonly reports, write executes", () => {
  const ro = materializeAgentPrompt({ agent: "x", shape: "readonly", role: "r" })
  const wr = materializeAgentPrompt({ agent: "x", shape: "write", role: "r" })
  assert.match(ro, /readonly worker.*REPORT/s)
  assert.match(wr, /executing scoped tasks/)
})

test("forgeAgentDef pins the model, drops hidden, and always denies task", () => {
  const def = forgeAgentDef("research", { model: "prov/x", thoughtLevel: "low", shape: "readonly" })
  assert.equal(def.model, "prov/x")
  assert.equal(def.mode, "subagent")
  assert.equal(def.hidden, undefined, "agents must stay in the task-tool vocabulary")
  const permission = def.permission
  assert.equal(permission.task, "deny")
  assert.equal(permission.write, "deny")
  assert.equal(permission.edit, "deny")
  assert.equal(permission.bash, "deny")
})

// shape-default-open: an ABSENT shape defaults to WRITE (open permissions) —
// readonly is a restriction the pool author must ask for explicitly.
test("forgeAgentDef: an absent shape defaults to OPEN write permissions; task stays denied", () => {
  const def = forgeAgentDef("ta-tool", { model: "prov/x", thoughtLevel: "low" })
  for (const tool of ["write", "edit", "bash", "patch", "applypatch", "apply", "multiedit"]) {
    assert.equal(def.permission[tool], undefined, `absent shape leaves ${tool} open (write default)`)
  }
  assert.equal(def.permission.task, "deny", "the recursion ban survives the absent shape")
})

test("forgeAgentDef: a write shape drops the mutating denies; an override never lifts the task ban", () => {
  const w = forgeAgentDef("builder", { model: "prov/x", shape: "write" })
  assert.equal(w.permission.write, undefined)
  assert.equal(w.permission.task, "deny")

  const o = forgeAgentDef("ops", { model: "prov/x", shape: "write", permission: { bash: "deny" } })
  assert.equal(o.permission.bash, "deny")
  assert.equal(o.permission.task, "deny")
})

// allow-readonly-recon-during-plan-draft + shape-default-open: the
// effectiveness matrix the draft dispatch gate keys on. The exemption keys
// on an EXPLICIT readonly shape (absent defaults to write — not exempt);
// any override lifting a mutating tool off "deny" breaks it.
test("effectiveReadonlyShape: effectiveness matrix (explicit readonly only; fail-closed on overrides)", () => {
  // 1. absent shape -> write default -> NOT effective
  assert.equal(effectiveReadonlyShape({ model: "prov/x" }), false)
  // 2. explicit readonly -> effective
  assert.equal(effectiveReadonlyShape({ model: "prov/x", shape: "readonly" }), true)
  // 3. explicit write shape -> never effective
  assert.equal(effectiveReadonlyShape({ model: "prov/x", shape: "write" }), false)
  // 4. a permission override allowing ANY mutating tool breaks it
  assert.equal(effectiveReadonlyShape({ model: "prov/x", shape: "readonly", permission: { write: "allow" } }), false)
  assert.equal(effectiveReadonlyShape({ model: "prov/x", shape: "readonly", permission: { edit: "allow" } }), false)
  assert.equal(effectiveReadonlyShape({ model: "prov/x", shape: "readonly", permission: { bash: "allow" } }), false)
  // 5. "ask" counts as lifted (fail closed — the user gate could approve)
  assert.equal(effectiveReadonlyShape({ model: "prov/x", shape: "readonly", permission: { bash: "ask" } }), false)
  // 6. overrides on irrelevant tools change nothing
  assert.equal(effectiveReadonlyShape({ model: "prov/x", shape: "readonly", permission: { forge_shell: "allow", task: "allow" } }), true)
  // 7. explicit deny on a mutating tool is confirmation, not a lift
  assert.equal(effectiveReadonlyShape({ model: "prov/x", shape: "readonly", permission: { write: "deny" } }), true)
})

test("agent description names the role, shape, and pinned brain for the task vocabulary", () => {
  const d = agentDescriptionFor("research", { model: "prov/x" })
  assert.match(d, /research/)
  assert.match(d, /prov\/x/)
  assert.match(d, /task tool/)
  assert.match(d, /forge-research/)
  assert.match(d, /write/, "an absent shape is described as the write default")
})

test("an Auto worker's description names inheritance instead of a pinned brain", () => {
  const d = agentDescriptionFor("scout", {})
  assert.match(d, /auto — inherits the parent session's model at dispatch/)
  assert.doesNotMatch(d, /pinned/)
})

// postrelease-hardening task 5.2 (spec scenario "The readonly deny face
// covers the patch family"): the deny face covers the host's patch family —
// patch/applypatch/apply/multiedit — from the SAME MUTATING_TOOLS constant
// that feeds the draft gate's lifting test, so the two faces cannot drift.

test("forgeAgentDef: the readonly deny face covers the patch family; task stays denied", () => {
  const def = forgeAgentDef("auditor", { model: "prov/x", shape: "readonly" })
  const permission = def.permission
  for (const tool of ["patch", "applypatch", "apply", "multiedit"]) {
    assert.equal(permission[tool], "deny", `readonly denies the patch-family tool ${tool}`)
  }
  assert.equal(permission.write, "deny")
  assert.equal(permission.edit, "deny")
  assert.equal(permission.bash, "deny")
  assert.equal(permission.task, "deny", "the recursion ban survives every shape")
})

test("forgeAgentDef: a write shape drops the patch family too; an override never lifts the task ban", () => {
  const w = forgeAgentDef("builder", { model: "prov/x", shape: "write" })
  for (const tool of ["patch", "applypatch", "apply", "multiedit"]) {
    assert.equal(w.permission[tool], undefined, `write shape drops ${tool} alongside the original trio`)
  }
  assert.equal(w.permission.task, "deny")

  const o = forgeAgentDef("ops", { model: "prov/x", shape: "write", permission: { apply: "allow" } })
  assert.equal(o.permission.apply, "allow", "the patch-family override is honored verbatim")
  assert.equal(o.permission.task, "deny")
})

test("effectiveReadonlyShape: every patch-family member lifts effectiveness like the original trio (allow AND ask)", () => {
  for (const tool of ["patch", "applypatch", "apply", "multiedit"]) {
    assert.equal(effectiveReadonlyShape({ model: "prov/x", shape: "readonly", permission: { [tool]: "allow" } }), false, `${tool}: allow lifts the readonly effectiveness`)
    assert.equal(effectiveReadonlyShape({ model: "prov/x", shape: "readonly", permission: { [tool]: "ask" } }), false, `${tool}: ask counts as lifted (fail closed)`)
    assert.equal(effectiveReadonlyShape({ model: "prov/x", shape: "readonly", permission: { [tool]: "deny" } }), true, `${tool}: explicit deny is confirmation, not a lift`)
  }
})

// pool-namespace-contract task 2.1 (spec scenario "The description carries
// pool provenance"; design D3): the task-vocabulary description names the
// family namespace, the ORIGIN forge.json path (verbatim), and — for every
// family except the global fallback — the dispatchability restriction. The
// provenance line is STATIC host-wide truth: identical in every session, no
// per-session branching.
test("description provenance: a workspace family names the namespace, origin file, and dispatchability clause", () => {
  const file = "C:/work/repo/.opencode/forge.json"
  const d = agentDescriptionFor("coder", { model: "prov/x" }, { ns: "plugindev", file })
  assert.match(d, /Pool 'plugindev'/, "names the family namespace")
  assert.match(d, new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "carries the origin forge.json path verbatim")
  assert.match(d, /dispatchable only from sessions whose workspace pool is this file/, "the dispatchability restriction is stated")
  // The provenance sentence rides AFTER the base description (one appended
  // sentence — compact per design D3's vocabulary-surface budget).
  assert.ok(d.startsWith('forge subagent "coder"'), "the base description is untouched")
})

test("description provenance: the global fallback family names the global fallback layer as origin", () => {
  const d = agentDescriptionFor("coder", {}, { global: true })
  assert.match(d, /Pool 'global' — origin: the global fallback layer\./)
  assert.doesNotMatch(d, /dispatchable only from sessions/, "the global family carries no workspace-restriction clause")
})

test("description provenance: ABSENT provenance leaves the description byte-identical (backward compat)", () => {
  const def = { model: "prov/x", thoughtLevel: "low", shape: "readonly" }
  assert.equal(
    agentDescriptionFor("research", def),
    agentDescriptionFor("research", def, undefined),
    "explicit undefined is the same as omitted",
  )
  assert.equal(
    agentDescriptionFor("research", def),
    `forge subagent "research" (readonly, pinned prov/x) — dispatch via the task tool with subagent_type "forge-research".`,
    "no provenance sentence is appended",
  )
  // The materialization path is equally inert without provenance.
  assert.equal(
    forgeAgentDef("research", def).description,
    forgeAgentDef("research", def, undefined).description,
  )
})

test("description provenance: forgeAgentDef bakes the provenance line into the materialized description", () => {
  const def = forgeAgentDef("coder", { model: "prov/x" }, { ns: "aa", file: "F:/pools/aa/.opencode/forge.json" })
  assert.match(def.description, /Pool 'aa'/)
  assert.match(def.description, /F:\/pools\/aa\/\.opencode\/forge\.json/)
  assert.match(def.description, /dispatchable only from sessions whose workspace pool is this file/)
  const g = forgeAgentDef("scout", {}, { global: true })
  assert.match(g.description, /origin: the global fallback layer/)
})

test("poolProvenanceLine: exact sentence formats for both variants", () => {
  assert.equal(
    poolProvenanceLine({ ns: "plugindev", file: "C:/x/.opencode/forge.json" }),
    "Pool 'plugindev' — origin C:/x/.opencode/forge.json; dispatchable only from sessions whose workspace pool is this file.",
  )
  assert.equal(
    poolProvenanceLine({ global: true }),
    "Pool 'global' — origin: the global fallback layer.",
  )
})
