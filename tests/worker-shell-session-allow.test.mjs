import test from "node:test"
import assert from "node:assert/strict"
import { v2Setup } from "../plugin.ts"
import { createV2MockContext } from "./lib/v2-mock-context.mjs"

// The old tool's session rescue is retired. Native permissions are owned
// by the host; loading Forge must not write session permission rules.
test("v2 context does not seed a session permission rescue rule", async () => {
  const { ctx, state } = createV2MockContext()
  const existing = [{ action: "shell", resource: "*", effect: "deny" }]
  const updates = []
  ctx.session.get = async ({ sessionID }) => ({ id: sessionID, permissions: structuredClone(existing) })
  ctx.session.update = async (input) => updates.push(input)
  const cleanup = await v2Setup(ctx, { anchors: [], readFile: () => null, stat: () => null })
  try {
    const hook = state.sessionHooks.find((h) => h.name === "context")
    assert.ok(hook)
    for (const agent of ["forge", "forge-pool-worker", "general"]) {
      await hook.cb({ sessionID: `ses-${agent}`, agent })
    }
    assert.deepEqual(updates, [], "no session permission overrides injected")
    assert.deepEqual(existing, [{ action: "shell", resource: "*", effect: "deny" }])
    assert.equal(state.tools.has("forge_shell"), false)
  } finally {
    await cleanup?.()
  }
})
