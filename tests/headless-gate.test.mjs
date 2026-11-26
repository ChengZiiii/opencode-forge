import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createV2MockContext } from "./lib/v2-mock-context.mjs"
import { NON_INTERACTIVE_ENV } from "../src/proc.ts"
import { v2Setup } from "../plugin.ts"

// The old exec channel and its command classifier are retired. The shared
// checker still uses non-interactive process defaults and real approval doors.
test("shared checker: exact non-interactive environment", () => {
  assert.deepEqual(NON_INTERACTIVE_ENV, {
    GIT_EDITOR: ":", EDITOR: ":", GIT_PAGER: "cat", PAGER: "cat", GIT_MERGE_AUTOEDIT: "no",
  })
})

test("native shell decisions pass through; approval doors still require a real decision", async () => {
  const dir = mkdtempSync(join(tmpdir(), "forge-native-doors-"))
  const { ctx, state } = createV2MockContext()
  const cleanup = await v2Setup(ctx, { anchors: [dir] })
  try {
    const evaluate = state.permissionHooks.find((h) => h.name === "evaluate").cb
    for (const effect of ["allow", "ask", "deny"]) {
      const input = { action: "shell", sessionID: "native", resources: ["*"], effect }
      await evaluate(input)
      assert.equal(input.effect, effect)
    }
    const toolCtx = { sessionID: "door", worktree: dir, agent: "forge" }
    await state.tools.get("plan_write").execute({ goal: "g", context: "c", approach: "a", tasks: ["t1"], risks: "r", acceptance: ["a1"] }, toolCtx)
    state.assertBehavior = "deny"
    await assert.rejects(state.tools.get("plan_approve").execute({}, toolCtx), /permission denied/)
    assert.equal(state.asserts.length, 1)
    assert.equal(state.asserts[0].action, "plan_approve")
  } finally {
    await cleanup?.()
    rmSync(dir, { recursive: true, force: true })
  }
})
