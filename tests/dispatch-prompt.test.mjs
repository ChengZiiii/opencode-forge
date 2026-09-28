import test from "node:test"
import assert from "node:assert/strict"

// Task 2.1 — materialization prompt + agent def (spec: forge-subagents —
// "Materialization as native subagents with a pinned model"): the standing
// prompt carries the three mandates around the role text; the agent entry
// pins `model`, drops `hidden`, keeps the task recursion ban, and its
// description is the task-tool vocabulary entry.

import { materializeAgentPrompt, WORKER_MANDATES } from "../src/dispatch-prompt.ts"
import { rolePromptFor, forgeAgentDef, agentDescriptionFor } from "../src/dispatch-tiers.ts"

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
  const def = forgeAgentDef("research", { model: "prov/x", thoughtLevel: "low" })
  assert.equal(def.model, "prov/x")
  assert.equal(def.mode, "subagent")
  assert.equal(def.hidden, undefined, "agents must stay in the task-tool vocabulary")
  const permission = def.permission
  assert.equal(permission.task, "deny")
  assert.equal(permission.write, "deny")
  assert.equal(permission.edit, "deny")
  assert.equal(permission.bash, "deny")
})

test("forgeAgentDef: a write shape drops the mutating denies; an override never lifts the task ban", () => {
  const w = forgeAgentDef("builder", { model: "prov/x", shape: "write" })
  assert.equal(w.permission.write, undefined)
  assert.equal(w.permission.task, "deny")

  const o = forgeAgentDef("ops", { model: "prov/x", shape: "write", permission: { bash: "deny" } })
  assert.equal(o.permission.bash, "deny")
  assert.equal(o.permission.task, "deny")
})

test("agent description names the role, shape, and pinned brain for the task vocabulary", () => {
  const d = agentDescriptionFor("research", { model: "prov/x" })
  assert.match(d, /research/)
  assert.match(d, /prov\/x/)
  assert.match(d, /task tool/)
  assert.match(d, /forge-research/)
})

test("an Auto worker's description names inheritance instead of a pinned brain", () => {
  const d = agentDescriptionFor("scout", {})
  assert.match(d, /auto — inherits the parent session's model at dispatch/)
  assert.doesNotMatch(d, /pinned/)
})
