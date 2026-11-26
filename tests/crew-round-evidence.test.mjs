import test from "node:test"
import assert from "node:assert/strict"
import { crewAcceptedRound, crossCheckCrewEvidence } from "../src/crew-gate.ts"
const plan = [{ title: "alpha" }]
const dispatch = (id, agent = "forge-test-worker") => ({ id, childID: "ses_child", agent, description: "alpha", prompt: "test" })
const receipt = r => ({ type: "assistant", content: [{ type: "tool", name: "subagent", id: r.id, state: { status: "completed", metadata: { sessionID: r.childID, status: "running" } } }] })
const result = (r, state, text) => ({ type: "synthetic", metadata: { source: "subagent", childID: r.childID, state }, text: `<background-result kind="subagent" sessionID="${r.childID}" state="${state}" description="alpha">\n${text}\n</background-result>` })
const view = (rounds, context, outcome = "succeeded") => ({ rounds, context, readable: true, inFlight: [], settled: [{ childID: "ses_child", outcome }] })
const check = (report, evidence) => crossCheckCrewEvidence([{ title: "alpha", ...report }], plan, evidence)
const pass = { verdict: "PASS", evidence: "verified revised tests" }
const r1 = dispatch("call1"), r2 = dispatch("call2")
test("only completed tool receipts count as accepted dispatch", () => {
  const args = { agent: "general", description: "alpha", prompt: "work" }
  assert.equal(crewAcceptedRound("a", args, { status: "error" }), null)
  assert.equal(crewAcceptedRound("a", args, { status: "completed", result: { metadata: { sessionID: "ses_child", status: "running" } } }).childID, "ses_child")
})
test("local verification summaries remain compatible; unknown listing refuses", () => {
  const local = { rounds: [], context: [], readable: true, inFlight: [], settled: [] }
  assert.deepEqual(check({ ...pass, evidence: "local native API checks" }, local), [])
  assert.notEqual(check(pass, { ...local, readable: false }).length, 0)
})
test("failed attempt cannot pass; terminal state without result cannot pass", () => {
  assert.notEqual(check(pass, view([r1], [receipt(r1), result(r1, "error", "failed")], "failed")).length, 0)
  assert.notEqual(check(pass, view([r1], [receipt(r1)])).length, 0)
})
test("reused session retry requires both attempts and its own successful result", () => {
  const first = [receipt(r1), result(r1, "error", "first failed"), receipt(r2)]
  assert.notEqual(check({ ...pass, attempts: ["first", "retry"] }, view([r1, r2], first)).length, 0)
  const both = [...first, result(r2, "completed", "negative test FAIL expected; all checks green")]
  assert.notEqual(check(pass, view([r1, r2], both)).length, 0)
  assert.deepEqual(check({ ...pass, attempts: ["first failed", "retry verified"] }, view([r1, r2], both)), [])
  const newestFirst = both.map((m, i) => ({ ...m, time: { created: i } })).reverse()
  assert.deepEqual(check({ ...pass, attempts: ["first failed", "retry verified"] }, view([r1, r2], newestFirst)), [])
})
test("duplicate notification or overlapping reuse cannot prove a fresh successful retry", () => {
  const old = { ...result(r1, "completed", "old result"), id: "msg_old" }
  const report = { ...pass, attempts: ["first", "retry"] }
  assert.notEqual(check(report, view([r1, r2], [receipt(r1), old, receipt(r2), old])).length, 0)
  assert.notEqual(check(report, view([r1, r2], [receipt(r1), receipt(r2), old, result(r2, "completed", "new result")])).length, 0)
})
test("historical dispatch outside current registration blocks late completion on reused child", () => {
  const old = { ...result(r1, "completed", "old result"), id: "msg_old" }
  const fresh = { ...result(r2, "completed", "new result"), id: "msg_new" }
  // Only the new registration's round is in memory, but the old receipt
  // remains in the host transcript and its notification arrives late.
  assert.notEqual(check(pass, view([r2], [receipt(r1), receipt(r2), old])).length, 0)
  assert.notEqual(check(pass, view([r2], [receipt(r1), receipt(r2), old, fresh])).length, 0)
  // A verified old settlement before the reuse permits a fresh result.
  assert.deepEqual(check(pass, view([r2], [receipt(r1), old, receipt(r2), fresh])), [])
  assert.notEqual(check(pass, view([r2], [receipt(r1), old, receipt(r2), old])).length, 0)
})
test("honest FAIL may disclose unknown outcome, but not unresolved in-flight work", () => {
  const report = { verdict: "FAIL", evidence: "retry outcome unverified", attempts: ["first failed", "retry unverified"] }
  const evidence = view([r1, r2], [receipt(r1), result(r1, "error", "first failed"), receipt(r2)], null)
  assert.deepEqual(check(report, evidence), [])
  assert.notEqual(check(report, { ...evidence, inFlight: [r2.childID] }).length, 0)
})
test("fallback association is disclosed; optional round references are validated", () => {
  const r = { ...dispatch("fallback", "general"), description: "a different label" }
  const evidence = view([r], [receipt(r), result(r, "completed", "tests green")])
  assert.notEqual(check(pass, evidence).length, 0)
  assert.deepEqual(check({ ...pass, rounds: [r.id], evidence: "native fallback verified tests" }, evidence), [])
  assert.notEqual(check({ ...pass, rounds: [r.id, "invented"], evidence: "native fallback verified tests" }, evidence).length, 0)
})
