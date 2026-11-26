import test from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { createV2MockContext } from "./lib/v2-mock-context.mjs"

const base = join(process.cwd(), ".sandbox-isolation")
mkdirSync(base, { recursive: true })
const root = mkdtempSync(join(base, "v2-event-reconnect-"))
process.env.FORGE_TEST_FORGE_HOME = join(root, "home")
process.env.FORGE_TEST_RUNTIME_DIR = join(root, "runtime")
process.env.OPENCODE_CONFIG_DIR = join(root, "config")
process.env.FORGE_TEST_NO_DISPATCH_FETCH = "1"
const { v2Setup, v2WiringSeam, __sessionAnchorTestSurface: surface } = await import("../plugin.ts")
test.after(() => rmSync(root, { recursive: true, force: true }))

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(predicate, message) {
  const deadline = Date.now() + 4000
  while (!predicate() && Date.now() < deadline) await delay(10)
  assert.ok(predicate(), message)
}

for (const failure of ["throw", "end"]) {
  test(`v2 event stream ${failure}: reconnect routes move and deletion; cleanup stops it`, async (t) => {
    v2WiringSeam.resetHostAnchors()
    surface.resetInitializedDirectories()
    const a = join(root, `${failure}-a`), b = join(root, `${failure}-b`)
    mkdirSync(a, { recursive: true }); mkdirSync(b, { recursive: true })
    const mock = createV2MockContext()
    const sid = `reconnect-${failure}`
    mock.state.sessionRecords.set(sid, { location: { directory: a } })
    let subscriptions = 0, closed = 0, signal
    let deliver
    const queue = []
    mock.ctx.event.subscribe = (options) => {
      signal = options.signal
      const n = ++subscriptions
      return { [Symbol.asyncIterator]() { return {
        async next() {
          if (n === 1) {
            if (failure === "throw") throw new Error("stream broke")
            return { done: true }
          }
          if (queue.length) return { done: false, value: queue.shift() }
          return await new Promise((resolve) => { deliver = resolve })
        },
        async return() {
          closed++
          deliver?.({ done: true })
          return { done: true }
        },
      } } }
    }
    const cleanup = await v2Setup(mock.ctx, { anchors: [a], homeDir: process.env.FORGE_TEST_FORGE_HOME, materialize: "runtime" })
    t.after(cleanup)
    assert.equal((await surface.stateForCheck(sid, mock.ctx)).worktree, a)
    await until(() => subscriptions >= 2, "lost stream must be re-subscribed")
    const emit = (type, data) => {
      const event = { id: type, type, data }
      if (deliver) { const resolve = deliver; deliver = undefined; resolve({ done: false, value: event }) }
      else queue.push(event)
    }
    emit("session.moved", { sessionID: sid, location: { directory: b } })
    await until(() => surface.worktreeOf(sid) === b, "move on reconnected stream updates anchor")
    assert.equal(await surface.resolveSessionAnchorForPools(mock.ctx, sid), b, "move overrides stale host record")
    emit("session.deleted", { sessionID: sid })
    await until(() => !v2WiringSeam.sessionMovedAnchors.has(sid), "deletion on reconnected stream clears moved anchor")
    await cleanup()
    assert.equal(signal.aborted, true)
    assert.equal(closed, 1, "cleanup closes the current iterator")
    const count = subscriptions
    await delay(1200)
    assert.equal(subscriptions, count, "cleanup prevents late reconnect")
  })
}

test("cleanup during reconnect backoff prevents a late subscription", async () => {
  v2WiringSeam.resetHostAnchors()
  const mock = createV2MockContext()
  let subscriptions = 0
  mock.ctx.event.subscribe = () => {
    subscriptions++
    return { [Symbol.asyncIterator]() { return {
      async next() { throw new Error("stream broke") },
      async return() { return { done: true } },
    } } }
  }
  const cleanup = await v2Setup(mock.ctx, { anchors: [root], homeDir: process.env.FORGE_TEST_FORGE_HOME, materialize: "runtime" })
  assert.equal(subscriptions, 1)
  await cleanup()
  await delay(1200)
  assert.equal(subscriptions, 1, "backoff must not resubscribe after cleanup")
})
