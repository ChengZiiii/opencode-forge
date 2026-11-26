import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { createV2MockContext } from "./lib/v2-mock-context.mjs"
import { v2Setup, v2WiringSeam } from "../plugin.ts"

// Native session observation remains independent of the retired dispatch registry.
test("setup and host events never adopt or recreate legacy dispatches", async () => {
  const { ctx, state } = createV2MockContext()
  const workspace = mkdtempSync(join(tmpdir(), "forge-retired-dispatch-"))
  let storageReads = 0
  let waits = 0
  ctx.storage = {
    scan: async () => {
      storageReads++
      return { entries: [{ key: "forge-dispatch/old", value: { state: "retry-pending", workspace } }] }
    },
  }
  ctx.session.wait = async () => { waits++ }
  const cleanup = await v2Setup(ctx, { anchors: [workspace] })
  try {
    const sessionID = "ses_retired_dispatch_observation"
    await state.emit("session.created", { info: { id: sessionID, directory: workspace } })
    await state.emit("session.execution.failed", { sessionID, error: "transient" })
    await sleep(30)
    assert.ok(v2WiringSeam.sessions.has(sessionID), "ordinary session.created still seeds state")
    assert.equal(storageReads, 0)
    assert.equal(waits, 0)
    assert.deepEqual(state.creates, [])
    assert.deepEqual(state.prompts, [])
    v2WiringSeam.sessionAgents.set(sessionID, "forge-worker")
    await state.emit("session.deleted", { info: { id: sessionID } })
    await sleep(30)
    assert.equal(v2WiringSeam.sessionAgents.has(sessionID), false, "ordinary session deletion still evicts agent state")
  } finally {
    cleanup?.()
    rmSync(workspace, { recursive: true, force: true })
  }
})
