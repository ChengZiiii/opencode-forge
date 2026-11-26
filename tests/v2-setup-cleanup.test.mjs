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
// Sandbox the plugin's runtime-artifact home (session-anchor ledger etc.).
process.env.FORGE_TEST_FORGE_HOME = mkdtempSync(join(tmpdir(), "v2-setup-cleanup-home-"))
process.env.FORGE_TEST_NO_DISPATCH_FETCH = "1"
const { v2Setup } = await import("../plugin.ts")
const { createV2MockContext } = await import("./lib/v2-mock-context.mjs")

test("v2 setup cleanup: setup resolves to a function — the cleanup a v2 host registers on unload", async () => {
  const mock = createV2MockContext()
  const cleanup = await v2Setup(mock.ctx)
  assert.equal(typeof cleanup, "function", "v2Setup resolves to the cleanup function (an async setup is first-class on 2.4.0)")
  await cleanup()
})

test("v2 registration transforms throw synchronously into the host replay catch", async () => {
  const mock = createV2MockContext()
  const caught = []
  for (const [domain, field] of [["agent", "get"], ["tool", "add"], ["command", "add"]]) {
    const marker = new Error(`${domain} replay marker`)
    mock.ctx[domain].transform = async (cb) => {
      const editor = { get [field]() { throw marker } }
      let result
      try {
        result = cb(editor)
      } catch (err) {
        assert.equal(err, marker)
        caught.push(domain)
      }
      // A Promise from an async callback would escape the host's synchronous
      // catch. Drain it in this fixture so a regression cannot leak rejection.
      if (result instanceof Promise) await result.catch(() => {})
    }
  }
  const cleanup = await v2Setup(mock.ctx)
  await cleanup()
  assert.deepEqual(caught, ["agent", "tool", "command"])
})

test("v2 setup cleanup: tears down THIS instance's registrations and stops its event loop", async () => {
  const mock = createV2MockContext()
  mock.state.agents.set("mine", { disable: true, prompt: "custom" })
  const cleanup = await v2Setup(mock.ctx)
  assert.deepEqual(mock.state.agents.get("mine"), { disable: true, prompt: "custom" }, "host agent fields remain untouched; disable is not a plugin switch")
  for (const name of ["goal_write", "crew_begin", "crew_close", "forge_sync"]) {
    assert.ok(mock.state.tools.has(name), `${name} registered when the host loads the plugin`)
  }
  const hookNames = mock.state.sessionHooks.map((h) => h.name)
  assert.ok(hookNames.length > 0, "premise: the setup registered session hooks")
  assert.ok(mock.state.subscriptions.length > 0, "premise: the setup subscribed to the event stream")
  assert.equal(mock.state.subscriptions.some((s) => s.closed), false, "premise: every subscription is live before the cleanup")
  await cleanup()
  assert.deepEqual([...mock.state.sessionHookDisposed].sort(), [...hookNames].sort(), "every session hook of this instance is disposed")
  assert.equal(mock.state.subscriptions.every((s) => s.closed), true, "every event subscription is stopped")
  // NOT idempotent by construction, and it does not have to be: the cleanup
  // re-invokes every registration's dispose on each call, and the host runs
  // this release once per acquisition (2.4.0 adapter.ts acquireRelease). A
  // first draft of this test asserted "a second call adds nothing" — an
  // assumption nobody had checked against the code. What a repeat must not
  // do is throw or leave the instance in a different state.
  const disposedNames = () => [...new Set(mock.state.sessionHookDisposed)].sort()
  await assert.doesNotReject(() => cleanup())
  assert.deepEqual(disposedNames(), [...hookNames].sort(), "a repeated call disposes the same hooks and nothing else")
  assert.equal(mock.state.subscriptions.every((s) => s.closed), true, "every event subscription is still stopped")
})

test("v2 setup cleanup awaits Promise registrations and best-effort async disposal", async () => {
  const mock = createV2MockContext()
  const attempted = []
  const disposed = []
  let finishDispose
  const pending = new Promise((resolve) => { finishDispose = resolve })
  mock.ctx.session.hook = async (name) => {
    attempted.push(name)
    await Promise.resolve()
    if (name === "context") throw new Error("registration rejected")
    return {
      name,
      async dispose() {
        assert.equal(this.name, name)
        if (name === "prompt") throw new Error("disposal rejected")
        if (name === "compaction") await pending
        disposed.push(name)
      },
    }
  }
  const cleanup = await v2Setup(mock.ctx)
  assert.deepEqual(attempted, ["prompt", "context", "compaction", "experimental.idle"])
  let settled = false
  const cleaning = cleanup().then(() => { settled = true })
  assert.ok(mock.state.subscriptions.every((s) => s.closed), "event abort does not wait for async hook disposal")
  await Promise.resolve()
  assert.equal(settled, false)
  finishDispose()
  await cleaning
  assert.deepEqual(disposed.sort(), ["compaction", "experimental.idle"])
})

test("event cleanup awaits iterator.return, including repeated cleanup while closing", async () => {
  const mock = createV2MockContext()
  let release
  const gate = new Promise((resolve) => { release = resolve })
  let returns = 0
  mock.ctx.event.subscribe = () => ({
    [Symbol.asyncIterator]() { return this },
    next: () => new Promise(() => {}),
    async return() {
      returns++
      await gate
      return { done: true }
    },
  })
  const cleanup = await v2Setup(mock.ctx)
  let settled = 0
  const first = cleanup().then(() => { settled++ })
  const second = cleanup().then(() => { settled++ })
  await new Promise(setImmediate)
  assert.equal(returns, 1)
  assert.equal(settled, 0)
  release()
  await Promise.all([first, second])
  assert.equal(settled, 2)
})

test("event cleanup aborts a pending next before awaiting iterator close", async () => {
  const mock = createV2MockContext()
  let signal
  let pendingRead
  let releaseClose
  let reads = 0
  let returns = 0
  let staleReads = 0
  const closeGate = new Promise((resolve) => { releaseClose = resolve })
  mock.ctx.event.subscribe = (options) => {
    signal = options.signal
    return {
      [Symbol.asyncIterator]() { return this },
      next() {
        reads++
        pendingRead = new Promise((resolve) => {
          signal.addEventListener("abort", () => resolve({ done: false, value: {
            get type() { staleReads++; return undefined },
          } }), { once: true })
        })
        return pendingRead
      },
      async return() {
        returns++
        assert.equal(signal.aborted, true)
        await pendingRead
        await closeGate
        return { done: true }
      },
    }
  }
  const cleanup = await v2Setup(mock.ctx)
  assert.equal(signal.aborted, false)
  assert.equal(reads, 1)
  let settled = false
  const cleaning = cleanup().then(() => { settled = true })
  await new Promise(setImmediate)
  assert.equal(signal.aborted, true)
  assert.equal(returns, 1)
  assert.equal(reads, 1)
  assert.equal(staleReads, 0)
  assert.equal(settled, false)
  releaseClose()
  await cleaning
  assert.equal(settled, true)
})

test("event cleanup contains asynchronous iterator.return rejection", async () => {
  const mock = createV2MockContext()
  let returns = 0
  mock.ctx.event.subscribe = () => ({
    [Symbol.asyncIterator]() { return this },
    next: () => new Promise(() => {}),
    async return() {
      returns++
      throw new Error("iterator close rejected")
    },
  })
  const cleanup = await v2Setup(mock.ctx)
  await assert.doesNotReject(cleanup)
  assert.equal(returns, 1)
  assert.equal(mock.state.sessionHookDisposed.length, mock.state.sessionHooks.length)
})

test("rejected idle registration selects existing event fallback without a session ID", async () => {
  for (const rejected of [false, true]) {
    const mock = createV2MockContext()
    const hook = mock.ctx.session.hook
    mock.ctx.session.hook = async (name, cb) => {
      if (rejected && name === "experimental.idle") throw new Error("idle registration rejected")
      return hook(name, cb)
    }
    let reads = 0
    let delivered = false
    mock.ctx.event.subscribe = () => ({
      [Symbol.asyncIterator]() { return this },
      async next() {
        if (delivered) return new Promise(() => {})
        delivered = true
        return { done: false, value: { type: "session.idle", data: {
          get sessionID() { reads++; return undefined },
        } } }
      },
      async return() { return { done: true } },
    })
    const cleanup = await v2Setup(mock.ctx)
    await new Promise(setImmediate)
    // The advisory event reader always reads once; the fallback reads again.
    // Undefined prevents either reader from starting any session work.
    assert.equal(reads, rejected ? 2 : 1)
    await cleanup()
  }
})
