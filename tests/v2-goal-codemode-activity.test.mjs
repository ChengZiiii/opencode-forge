import test from "node:test"
import assert from "node:assert/strict"
import { classifyGoalActivity, observeGoalActivity } from "../src/goal-activity.ts"

// Reduced from the observed CodeMode execute -> goal_check notifications.
function turn({ evidence = "check-1-pass", items = [1], mutate = () => {}, extra = false } = {}) {
  const text = `Host verification ${evidence}`
  const input = { items }
  const act = { writes: 0, checks: 0, goalChecks: [{ output: text, evidence }] }
  const calls = [{ tool: "goal_check", status: "completed", input }]
  const inner = { content: [{ type: "text", text }] }
  const outer = { output: { output: text, toolCalls: structuredClone(calls), files: [] }, content: [{ type: "text", text }], metadata: { toolCalls: structuredClone(calls) } }
  const ctx = { messageID: "msg-1", status: "completed", codemode: true }
  const outerCtx = { ...ctx, codemode: false }
  mutate({ inner, outer, calls, input, ctx, outerCtx })
  observeGoalActivity(act, "goal_check", false, "inner-1", input, inner, ctx)
  if (extra) observeGoalActivity(act, "read", false, "read-1", { filePath: "notes" }, { output: "new" }, ctx)
  observeGoalActivity(act, "execute", false, "outer-1", { code: "return await tools.goal_check({items:[1]})" }, outer, outerCtx)
  return act
}

test("CodeMode activity distinguishes changed checks and real activity", () => {
  const first = turn()
  const initial = classifyGoalActivity(first, undefined)
  assert.equal(initial.activity, true)
  assert.equal(first.checks, 1)
  assert.equal(classifyGoalActivity(turn(), initial.evidence).repeated, true)
  assert.equal(classifyGoalActivity(turn({ evidence: "check-2-pass", items: [2] }), initial.evidence).activity, true)
  assert.equal(classifyGoalActivity(turn({ evidence: "check-1-fail" }), initial.evidence).activity, true)
  assert.equal(classifyGoalActivity(turn({ extra: true }), initial.evidence).activity, true)
  assert.equal(classifyGoalActivity(turn({ mutate: ({ outer }) => {
    const call = { tool: "read", status: "completed", input: { filePath: "notes" } }
    outer.output.toolCalls.push(call); outer.metadata.toolCalls.push(call)
  } }), initial.evidence).activity, true)
})

test("incomplete bare checks are uncertain while complete string checks stay comparable", () => {
  // D11 forbids treating unknown or truncated output as either progress or repetition;
  // preserve the legacy bare-string adapter when its host-run evidence is complete.
  const bare = (evidence) => {
    const act = { writes: 0, checks: 0, goalChecks: [{ output: "verification", evidence }] }
    observeGoalActivity(act, "goal_check", false, "bare", {}, { content: "verification" })
    return act
  }
  const previous = classifyGoalActivity(bare("complete"), undefined).evidence
  assert.equal(classifyGoalActivity(bare("complete"), previous).repeated, true)
  const incomplete = classifyGoalActivity(bare(undefined), previous)
  assert.equal(incomplete.repeated, false)
  assert.equal(incomplete.uncertain, true)
  const shell = { writes: 0, checks: 0 }
  observeGoalActivity(shell, "shell", false, "shell", { command: "npm test" }, { output: "partial", metadata: { exitCode: 0, truncated: true } })
  assert.equal(classifyGoalActivity(shell, previous).uncertain, true)
})

test("CodeMode inner without its outer remains unknown, not repeated", () => {
  const previous = classifyGoalActivity(turn(), undefined).evidence
  const act = { writes: 0, checks: 0, goalChecks: [{ output: "same", evidence: "check-1-pass" }] }
  observeGoalActivity(act, "goal_check", false, "inner", { items: [1] }, { content: [{ type: "text", text: "same" }] }, { messageID: "msg", status: "completed", codemode: true })
  const result = classifyGoalActivity(act, previous)
  assert.equal(result.repeated, false)
  assert.equal(result.uncertain, true)
})

test("CodeMode same call ID cannot hide mixed activity or another message", () => {
  const previous = classifyGoalActivity(turn(), undefined).evidence
  const act = { writes: 0, checks: 0, goalChecks: [{ output: "same", evidence: "check-1-pass" }] }
  const ctx = { messageID: "msg", status: "completed", codemode: true }
  observeGoalActivity(act, "goal_check", false, "same-id", { items: [1] }, { content: [{ type: "text", text: "same" }] }, ctx)
  const calls = [{ tool: "goal_check", status: "completed", input: { items: [1] } }, { tool: "read", status: "completed", input: {} }]
  observeGoalActivity(act, "execute", false, "same-id", {}, { output: { output: "same", toolCalls: calls, files: [] }, content: [{ type: "text", text: "same" }], metadata: { toolCalls: calls } }, ctx)
  assert.equal(classifyGoalActivity(act, previous).activity, true)
})

test("CodeMode call IDs in different messages are distinct observations", () => {
  const other = { writes: 0, checks: 0 }
  observeGoalActivity(other, "read", false, "same-id", {}, {}, { messageID: "one", status: "completed" })
  observeGoalActivity(other, "shell", false, "same-id", { command: "npm test" }, { output: "ok", metadata: { exitCode: 0, truncated: false } }, { messageID: "two", status: "completed" })
  assert.equal(other.checks, 1)
})

test("CodeMode explicit errors contradict completed status", () => {
  const previous = classifyGoalActivity(turn(), undefined).evidence
  for (const mutate of [
    ({ inner }) => { inner.error = true },
    ({ inner }) => { inner.metadata = { error: true } },
    ({ outer }) => { outer.error = true },
    ({ outer }) => { outer.metadata.error = true },
    ({ outer }) => { outer.output.error = true },
  ]) assert.equal(classifyGoalActivity(turn({ mutate }), previous).repeated, false)
})

test("CodeMode activity never infers repetition from incomplete or unrelated wrappers", () => {
  const previous = classifyGoalActivity(turn(), undefined).evidence
  const cases = [
    ({ outer }) => { outer.metadata.truncated = true },
    ({ outer }) => { outer.output.truncated = true },
    ({ outer }) => { outer.output.output = "truncated" },
    ({ outerCtx }) => { outerCtx.status = "error" },
    ({ outer }) => { outer.output.toolCalls[0].status = "running" },
    ({ outer }) => { delete outer.metadata.toolCalls },
    ({ outer }) => { outer.output.files = [{ path: "changed" }] },
    ({ outerCtx }) => { outerCtx.messageID = "different" },
    ({ outerCtx }) => { delete outerCtx.messageID },
    ({ outer }) => { outer.metadata.toolCalls[0].input = { items: [2] } },
    ({ inner }) => { inner.content.push({ type: "text", text: "extra" }) },
    ({ outer }) => { outer.content.push({ type: "text", text: "extra" }) },
  ]
  for (const mutate of cases) {
    const result = classifyGoalActivity(turn({ mutate }), previous)
    assert.equal(result.repeated, false)
  }
  const act = { writes: 0, checks: 0 }
  observeGoalActivity(act, "execute", false, "unrelated", {}, { output: [] }, { messageID: "msg", status: "completed", codemode: false })
  const result = classifyGoalActivity(act, previous)
  assert.equal(result.repeated, false)
  assert.equal(result.uncertain, true)
})
