import test from "node:test"
import assert from "node:assert/strict"

// Task 4.2 — crew_close gate cross-checks against the DECLARED SUBTASK PLAN
// (spec: crew-harness — "crew_close completion gate", change
// simplify-dispatch-to-static-agents). Refusal classes:
//   1. declared subtask missing a verdict or evidence,
//   2. renegade undeclared subtask in the report,
//   3. FAIL without both attempt reports.
// Honest FAILs close; full evidence closes.

import { validateCrewReport } from "../src/crew-gate.ts"

const PLAN = [
  { title: "alpha", agent: "forge-research" },
  { title: "beta" },
]

test("gate: full evidence against the declared plan closes", () => {
  const report = [
    { title: "alpha", verdict: "PASS", evidence: "result text contained the auth flow summary" },
    { title: "beta", verdict: "PASS", evidence: "diff applied and tests output green" },
  ]
  const check = validateCrewReport(report, PLAN)
  assert.equal(check.ok, true)
  assert.equal(check.gaps.length, 0)
})

test("gate: empty report refuses", () => {
  const check = validateCrewReport([], PLAN)
  assert.equal(check.ok, false)
  assert.match(check.gaps[0], /no subtasks/)
})

test("gate: declared subtask missing a verdict refuses", () => {
  const report = [
    { title: "alpha", verdict: "PASS", evidence: "ok" },
    { title: "beta", verdict: "", evidence: "ok" },
  ]
  const check = validateCrewReport(report, PLAN)
  assert.equal(check.ok, false)
  assert.ok(check.gaps.some((g) => g.includes("beta") && g.includes("verdict must be PASS or FAIL")))
})

test("gate: declared subtask missing evidence refuses", () => {
  const report = [
    { title: "alpha", verdict: "PASS", evidence: "ok" },
    { title: "beta", verdict: "PASS", evidence: "   " },
  ]
  const check = validateCrewReport(report, PLAN)
  assert.equal(check.ok, false)
  assert.ok(check.gaps.some((g) => g.includes("beta") && g.includes("missing evidence")))
})

test("gate: a declared subtask silently dropped refuses", () => {
  const report = [{ title: "alpha", verdict: "PASS", evidence: "ok" }]
  const check = validateCrewReport(report, PLAN)
  assert.equal(check.ok, false)
  assert.ok(check.gaps.some((g) => g.includes("beta") && g.includes("silently dropped")))
})

test("gate: renegade undeclared subtask refuses", () => {
  const report = [
    { title: "alpha", verdict: "PASS", evidence: "ok" },
    { title: "beta", verdict: "PASS", evidence: "ok" },
    { title: "gamma-improvised", verdict: "PASS", evidence: "looked useful" },
  ]
  const check = validateCrewReport(report, PLAN)
  assert.equal(check.ok, false)
  assert.ok(check.gaps.some((g) => g.includes("gamma-improvised") && g.includes("renegade")))
})

test("gate: FAIL requires both failure reports", () => {
  const one = validateCrewReport(
    [
      { title: "alpha", verdict: "PASS", evidence: "ok" },
      { title: "beta", verdict: "FAIL", evidence: "still broken", attempts: ["first failure only"] },
    ],
    PLAN,
  )
  assert.equal(one.ok, false)
  assert.ok(one.gaps.some((g) => g.includes("beta") && g.includes("both failure reports")))

  const two = validateCrewReport(
    [
      { title: "alpha", verdict: "PASS", evidence: "ok" },
      { title: "beta", verdict: "FAIL", evidence: "still broken", attempts: ["attempt failed: x", "retry failed: y"] },
    ],
    PLAN,
  )
  assert.equal(two.ok, true, "honest FAIL with both reports closes")
})

test("gate: title matching is case-insensitive trim", () => {
  const check = validateCrewReport(
    [
      { title: "  Alpha ", verdict: "PASS", evidence: "ok" },
      { title: "BETA", verdict: "PASS", evidence: "ok" },
    ],
    PLAN,
  )
  assert.equal(check.ok, true)
})

test("gate: duplicate report entries refuse", () => {
  const check = validateCrewReport(
    [
      { title: "alpha", verdict: "PASS", evidence: "ok" },
      { title: "alpha", verdict: "PASS", evidence: "ok again" },
      { title: "beta", verdict: "PASS", evidence: "ok" },
    ],
    PLAN,
  )
  assert.equal(check.ok, false)
  assert.ok(check.gaps.some((g) => g.includes("duplicate")))
})

test("gate: PASS/FAIL verdict vocabulary is enforced", () => {
  const check = validateCrewReport(
    [
      { title: "alpha", verdict: "DONE", evidence: "ok" },
      { title: "beta", verdict: "PASS", evidence: "ok" },
    ],
    PLAN,
  )
  assert.equal(check.ok, false)
  assert.ok(check.gaps.some((g) => g.includes("DONE")))
})
