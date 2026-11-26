import test from "node:test"
import assert from "node:assert/strict"
import { selectStopScope } from "../src/stop-scope.ts"

const child = (id, lineage = "confirmed", dispatch = "confirmed") => ({ id, lineage, dispatch })
const shell = (id, owner, ownership = "confirmed", backgroundShell = "confirmed") => ({ id, owner, ownership, backgroundShell })

test("both proofs required; only confirmed child-owned background shells selected", () => {
  const scope = selectStopScope("parent", [child("busy"), child("idle"), child("finished"), child("manual", "confirmed", "excluded"), child("uncertain", "confirmed", "unknown"), child("outside", "excluded"), child("parent")], "complete", [shell("busy-cmd", "busy"), shell("leftover", "finished"), shell("unrelated", "outside"), shell("parent-cmd", "parent"), shell("manual-cmd", "manual"), shell("unknown-cmd", "busy", "unknown"), shell("other-job", "busy", "confirmed", "excluded")], "complete")
  assert.deepEqual(scope.children, ["busy", "idle", "finished"])
  assert.deepEqual(scope.commands, [{ id: "busy-cmd", owner: "busy" }, { id: "leftover", owner: "finished" }])
  assert.equal(scope.unknownChildren, true)
  assert.equal(scope.unknownCommands, true)
  assert.match(scope.findings.join("\n"), /uncertain/)
  assert.match(scope.findings.join("\n"), /unknown-cmd/)
})

test("incomplete enumerations never imply empty scope or widen confirmed selection", () => {
  for (const state of ["partial", "unavailable", "truncated", "timeout"]) {
    const scope = selectStopScope("parent", [child("known"), child("new", "unknown")], state, [], state)
    assert.deepEqual(scope.children, ["known"])
    assert.deepEqual(scope.commands, [])
    assert.equal(scope.unknownChildren, true)
    assert.equal(scope.unknownCommands, true)
    assert.equal(scope.nothingToStop, false)
    assert.match(scope.findings.join("\n"), /Shell enumeration .*remaining count unknown/)
    assert.equal(selectStopScope("parent", [], state, [], "complete").nothingToStop, false)
  }
  assert.equal(selectStopScope("parent", [], "complete", [], "complete").nothingToStop, true)
  assert.equal(selectStopScope("", [], "complete", [], "complete").nothingToStop, false)
})

test("conflicting records do not authorize selection, and new observations require both proofs", () => {
  const first = selectStopScope("parent", [child("a"), child("a", "confirmed", "excluded"), child("b"), child("new", "confirmed", "unknown")], "complete", [shell("x", "b"), shell("x", "outside")], "complete")
  assert.deepEqual(first.children, ["b"])
  assert.deepEqual(first.commands, [])
  const next = selectStopScope("parent", [child("new")], "complete", [shell("y", "new"), shell("y", "new")], "complete")
  assert.deepEqual(next.children, ["new"])
  assert.deepEqual(next.commands, [{ id: "y", owner: "new" }])
})
