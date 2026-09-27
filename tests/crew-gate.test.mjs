import test from "node:test"
import assert from "node:assert/strict"

// Task 4.2 — crew_close gate cross-checks (pure logic, spec scenarios):
// full evidence closes; missing verdicts / dropped dispatches refuse;
// bounded retry then honest FAIL is allowed and enforced.

import { validateCrewReport } from "../src/crew-gate.ts"

const CREW = { objective: "ship it", startedAt: "2026-09-27T00:00:00.000Z", sessionID: "ses_parent" }
const row = (dispatchId, event, ts = "2026-09-27T00:01:00.000Z") => ({ ts, event, dispatchId, parentSessionID: "ses_parent" })

test("4.2: full evidence closes — every subtask verdict+evidence matches the ledger", () => {
  const rows = [row("bg-1", "completed"), row("bg-2", "completed")]
  const report = [
    { title: "a", verdict: "PASS", evidence: "dispatch bg-1 output said ok" },
    { title: "b", verdict: "PASS", evidence: "dispatch bg-2 output said ok" },
  ]
  const r = validateCrewReport(report, rows, CREW)
  assert.equal(r.ok, true, JSON.stringify(r.gaps))
})

test("4.2: missing verdict or evidence refuses, naming the gap", () => {
  const rows = [row("bg-1", "completed")]
  const noVerdict = validateCrewReport([{ title: "a", verdict: "", evidence: "bg-1" }], rows, CREW)
  assert.equal(noVerdict.ok, false)
  assert.ok(noVerdict.gaps.some((g) => g.includes("PASS or FAIL")))
  const noEvidence = validateCrewReport([{ title: "a", verdict: "PASS", evidence: "" }], rows, CREW)
  assert.equal(noEvidence.ok, false)
  assert.ok(noEvidence.gaps.some((g) => g.includes("missing evidence")))
  const empty = validateCrewReport([], rows, CREW)
  assert.equal(empty.ok, false)
})

test("4.2: a dispatched subtask with no verdict in the report refuses (nothing dropped)", () => {
  const rows = [row("bg-1", "completed"), row("bg-2", "completed", "2026-09-27T00:02:00.000Z")]
  const report = [{ title: "a", verdict: "PASS", evidence: "bg-1 only" }]
  const r = validateCrewReport(report, rows, CREW)
  assert.equal(r.ok, false)
  assert.ok(r.gaps.some((g) => g.includes("bg-2") && g.includes("silently dropped")))
})

test("4.2: evidence referencing an unknown/stale dispatch refuses", () => {
  const rows = [row("bg-1", "completed")]
  const r = validateCrewReport([{ title: "a", verdict: "PASS", evidence: "bg-9" }], rows, CREW)
  assert.equal(r.ok, false)
  assert.ok(r.gaps.some((g) => g.includes("bg-9") && g.includes("no ledger row")))
})

test("4.2: bounded retry then honest FAIL closes (with both attempts), PASS over a failed dispatch refuses", () => {
  const rows = [row("bg-1", "empty-response"), row("bg-2", "error", "2026-09-27T00:03:00.000Z")]
  const goodFail = validateCrewReport(
    [{ title: "a", verdict: "FAIL", evidence: "bg-1 then bg-2", attempts: ["bg-1: empty", "bg-2: error"] }],
    rows,
    CREW,
  )
  assert.equal(goodFail.ok, true, JSON.stringify(goodFail.gaps))
  const passOverFailure = validateCrewReport(
    [{ title: "a", verdict: "PASS", evidence: "bg-2" }],
    rows,
    CREW,
  )
  assert.equal(passOverFailure.ok, false)
  assert.ok(passOverFailure.gaps.some((g) => g.includes("must be marked FAIL")))
  const lazyFail = validateCrewReport(
    [{ title: "a", verdict: "FAIL", evidence: "bg-1", attempts: ["bg-1: empty"] }],
    rows,
    CREW,
  )
  assert.equal(lazyFail.ok, false)
  assert.ok(lazyFail.gaps.some((g) => g.includes("both failure reports")))
})

test("4.2: ledger rows from other sessions or before the crew are ignored", () => {
  const rows = [
    { ts: "2026-09-27T00:01:00.000Z", event: "completed", dispatchId: "bg-1", parentSessionID: "ses_OTHER" },
    { ts: "2025-01-01T00:00:00.000Z", event: "completed", dispatchId: "bg-2", parentSessionID: "ses_parent" },
    row("bg-3", "completed"),
  ]
  const r = validateCrewReport([{ title: "a", verdict: "PASS", evidence: "bg-3" }], rows, CREW)
  assert.equal(r.ok, true, JSON.stringify(r.gaps))
})

test("4.2: duplicate evidence across subtasks refuses (each dispatch one verdict)", () => {
  const rows = [row("bg-1", "completed")]
  const r = validateCrewReport(
    [
      { title: "a", verdict: "PASS", evidence: "bg-1" },
      { title: "b", verdict: "PASS", evidence: "bg-1" },
    ],
    rows,
    CREW,
  )
  assert.equal(r.ok, false)
  assert.ok(r.gaps.some((g) => g.includes("exactly one verdict")))
})

// fix-dispatch-transport-timeout: transport-interrupted is a non-outcome
// event (recovery follows it; a terminal row lands separately) — it must
// never demand a verdict or manufacture a gap.
test("TI: a transport-interrupted row is not an outcome — no gap, no verdict required", () => {
  const rows = [
    row("bg-1", "transport-interrupted", "2026-09-27T00:00:30.000Z"),
    row("bg-1", "completed", "2026-09-27T00:01:00.000Z"),
  ]
  const r = validateCrewReport([{ title: "a", verdict: "PASS", evidence: "bg-1" }], rows, CREW)
  assert.equal(r.ok, true, JSON.stringify(r.gaps))
})
