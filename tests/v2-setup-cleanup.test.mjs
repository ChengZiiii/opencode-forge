import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// doc-plugin-unload-v2 (2026-11-25): what a v2 host runs when the plugin
// unloads is the function `setup` RESOLVES to — the opencode 2.4.0 contract
// allows an async setup (packages/plugin/src/promise/plugin.ts:
// `setup: (context) => Promise<Cleanup | void> | Cleanup | void`) and the
// adapter's release step runs the resolved function. That cleanup is the one
// at the end of v2Setup. It tears down THIS instance only: no job process is
// terminated and no dispatch row is killed or terminalized. The job-clearing
// `dispose` belongs to the v1 hooks object, which a v2 host never invokes.

// No real fence watcher inside wiring tests: its stdin pipe holds the event
// loop open and the test process would never exit.
process.env.FORGE_TEST_NO_FENCE = "1"
// Sandbox the plugin's runtime-artifact home (session-anchor ledger etc.).
process.env.FORGE_TEST_FORGE_HOME = mkdtempSync(join(tmpdir(), "v2-setup-cleanup-home-"))
const { v2Setup, v2WiringSeam } = await import("../plugin.ts")
const { createV2MockContext } = await import("./lib/v2-mock-context.mjs")

test("v2 setup cleanup: setup resolves to a function — the cleanup a v2 host registers on unload", async () => {
  const mock = createV2MockContext()
  const cleanup = await v2Setup(mock.ctx)
  assert.equal(typeof cleanup, "function", "v2Setup resolves to the cleanup function (an async setup is first-class on 2.4.0)")
  cleanup()
})

test("v2 setup cleanup: tears down THIS instance's registrations and stops its event loop", async () => {
  const mock = createV2MockContext()
  const cleanup = await v2Setup(mock.ctx)
  const hookNames = mock.state.sessionHooks.map((h) => h.name)
  assert.ok(hookNames.length > 0, "premise: the setup registered session hooks")
  assert.ok(mock.state.subscriptions.length > 0, "premise: the setup subscribed to the event stream")
  assert.equal(mock.state.subscriptions.some((s) => s.closed), false, "premise: every subscription is live before the cleanup")
  cleanup()
  assert.deepEqual([...mock.state.sessionHookDisposed].sort(), [...hookNames].sort(), "every session hook of this instance is disposed")
  assert.equal(mock.state.subscriptions.every((s) => s.closed), true, "every event subscription is stopped")
  // NOT idempotent by construction, and it does not have to be: the cleanup
  // re-invokes every registration's dispose on each call, and the host runs
  // this release once per acquisition (2.4.0 adapter.ts acquireRelease). A
  // first draft of this test asserted "a second call adds nothing" — an
  // assumption nobody had checked against the code. What a repeat must not
  // do is throw or leave the instance in a different state.
  const disposedNames = () => [...new Set(mock.state.sessionHookDisposed)].sort()
  assert.doesNotThrow(() => cleanup())
  assert.deepEqual(disposedNames(), [...hookNames].sort(), "a repeated call disposes the same hooks and nothing else")
  assert.equal(mock.state.subscriptions.every((s) => s.closed), true, "every event subscription is still stopped")
})

test("v2 setup cleanup: terminates no job and no dispatch row", async () => {
  const mock = createV2MockContext()
  const cleanup = await v2Setup(mock.ctx)
  const manager = v2WiringSeam.jobManager
  const killed = []
  const row = (id, extra) =>
    manager.create({
      id,
      cmd: "row",
      worktree: "/w",
      ownerSession: "ses_v2cleanup_owner",
      logPath: `C:/nowhere/${id}.log`,
      notify: false,
      killTree: () => killed.push(id),
      ...extra,
    })
  // A process-backed job (a live local process tree) and an in-flight
  // dispatch row (a server-side child session, no local process).
  const proc = row("j-v2cleanup-proc", { pid: 424242 })
  const dispatch = row("j-v2cleanup-dispatch", {
    notify: true,
    dispatch: { agentID: "forge-x", childSessionID: "ses_v2cleanup_child", description: "row" },
  })
  const rowsBefore = manager.list().length
  cleanup()
  assert.deepEqual(killed, [], "no killTree ran")
  assert.equal(manager.get(proc.id)?.state, "running", "the process-backed job is untouched")
  assert.equal(manager.get(dispatch.id)?.state, "running", "the dispatch row is neither killed nor terminalized")
  assert.equal(manager.list().length, rowsBefore, "no row removed")
  manager.markTerminal(proc, "exited", 0)
  manager.markTerminal(dispatch, "completed", 0)
})
