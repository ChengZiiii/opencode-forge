import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { randomUUID } from "node:crypto"
import { createV2MockContext } from "./lib/v2-mock-context.mjs"
import { NATIVE_TOOL_VOCAB } from "../src/roster-compile.ts"
import { v2Setup, v2WiringSeam } from "../plugin.ts"

const writes = ["write", "edit", "apply", "applypatch", "patch", "multiedit", "bash", "task", "shell", "subagent", "custom_patch"]
const reads = ["read", "grep", "glob", "question"]

test("native vocabulary preserves the transition keys and names host tools explicitly", () => {
  const v = NATIVE_TOOL_VOCAB
  assert.deepEqual([v.shell, v.dispatchTool, v.question, v.grep, v.glob], ["shell", "subagent", "question", "grep", "glob"])
  assert.equal(v.taskKey, "task")
  assert.deepEqual([...v.legacyShellKeys], ["shell", "bash"])
})

test("v2 native write classification: draft refusal and goal/crew activity", async () => {
  const root = mkdtempSync(join(tmpdir(), "forge-native-vocab-"))
  process.env.FORGE_TEST_FORGE_HOME = join(root, "home")
  process.env.OPENCODE_CONFIG_DIR = join(root, "config")
  process.env.FORGE_SERVICE_FILE = join(root, "missing-service.json")
  process.env.FORGE_TEST_NO_DISPATCH_FETCH = "1"
  process.env.FORGE_TEST_NO_FENCE = "1"
  const sessionID = `ses_native_vocab_${randomUUID()}`
  let cleanup
  try {
    const { ctx, state } = createV2MockContext()
    cleanup = await v2Setup(ctx, { anchors: [root], homeDir: join(root, "home"), materialize: "runtime" })
    const before = state.toolHooks.find(h => h.name === "execute.before").cb
    const after = state.toolHooks.find(h => h.name === "execute.after").cb
    const permission = state.permissionHooks.find(h => h.name === "evaluate").cb
    await state.tools.get("plan_write").execute(
      { goal: "classify", context: "c", approach: "a", tasks: ["t"], risks: "r", acceptance: ["a1"] },
      { sessionID, agent: "forge", worktree: root },
    )
    for (const tool of [...writes, ...reads]) {
      const event = { tool, sessionID, id: "call_1", input: {} }
      const decision = { sessionID, action: tool, resources: ["*"], effect: "allow" }
      if (writes.includes(tool)) {
        await assert.rejects(before(event), /draft/, tool)
        await permission(decision)
        assert.equal(decision.effect, "deny", tool)
      } else {
        await assert.doesNotReject(before(event), tool)
        await permission(decision)
        assert.equal(decision.effect, "allow", tool)
      }
    }
    v2WiringSeam.turnActivity.set(sessionID, { writes: 0, checks: 0 })
    v2WiringSeam.crewTurnActivity.set(sessionID, { dispatches: 0, writes: 0 })
    for (const tool of [...writes, ...reads]) {
      const result = tool === "subagent" ? { metadata: { status: "running", sessionID: "ses_accepted_child" } } : undefined
      await after({ tool, sessionID, id: `call_${tool}`, input: {}, status: "completed", result })
    }
    assert.equal(v2WiringSeam.turnActivity.get(sessionID).writes, writes.length)
    assert.equal(v2WiringSeam.turnActivity.get(sessionID).checks, 2)
    const crew = v2WiringSeam.crewTurnActivity.get(sessionID)
    assert.equal(crew.dispatches, 2, "legacy task and accepted native subagent are distinct dispatches")
    assert.equal(crew.writes, writes.length)
    assert.equal(crew.seen.size, writes.length + reads.length)
    const goal = v2WiringSeam.turnActivity.get(sessionID)
    assert.equal(goal.dispatches, 1, "only the accepted native subagent counts in the goal ledger")
    await after({ tool: "subagent", sessionID, id: "call_subagent", input: {}, status: "completed", result: { metadata: { status: "running", sessionID: "ses_accepted_child" } } })
    assert.equal(crew.dispatches, 2, "duplicate observation does not count twice")
    assert.equal(goal.dispatches, 1, "goal dispatch observation is deduplicated")
    const unknownID = `${sessionID}_unknown`
    const failedID = `${sessionID}_failed`
    try {
      for (const sid of [unknownID, failedID]) v2WiringSeam.turnActivity.set(sid, { writes: 0, checks: 0 })
      await after({ tool: "subagent", sessionID: unknownID, id: "unknown_call", input: {} })
      await after({ tool: "subagent", sessionID: failedID, id: "failed_call", input: {}, status: "error", result: { metadata: { status: "running", sessionID: "ses_failed_child" } } })
      for (const sid of [unknownID, failedID]) {
        const activity = v2WiringSeam.turnActivity.get(sid)
        assert.equal(activity.dispatches ?? 0, 0, "unknown or failed result is not an accepted dispatch")
        assert.equal(activity.writes, 0)
        assert.equal(activity.uncertain, true)
      }
    } finally {
      v2WiringSeam.turnActivity.delete(unknownID)
      v2WiringSeam.turnActivity.delete(failedID)
    }
  } finally {
    v2WiringSeam.turnActivity.delete(sessionID)
    v2WiringSeam.crewTurnActivity.delete(sessionID)
    await cleanup?.()
    rmSync(root, { recursive: true, force: true })
  }
})
