import test from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Direct-run parity with the suite preload (the second test starts a real job).
import "./lib/test-runtime-namespace.mjs"

import { server } from "../plugin.ts"
import { createJobRegistry } from "../src/job-registry.ts"

// fix-job-registry-first-run-enoent. On a host whose jobs directory does not
// exist yet (first run after an install, or after a temp cleanup) the first
// job used to die: `ensureJobLifecycle` → `registry.rescan` → `acquireLock` →
// `openSync(<jobs>/registry.json.lock, "wx")` → ENOENT, because `writeRaw`
// creates the directory only AFTER the lock was taken. And since
// `jobsLifecycleStarted` flips before the throw, the lifecycle init never
// reached the fence and the exit cleanup — for the rest of that host
// process's life every job ran unfenced. Found 2026-11-24 by a unit test that
// used a fresh runtime namespace.

process.env.FORGE_TEST_NO_FENCE = "1"

const dirs = []
const mk = (prefix) => {
  const d = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(d)
  return d
}
test.after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

test("R1: a registry whose directory does not exist yet takes its first lock without ENOENT", () => {
  const base = mk("forge-registry-firstrun-")
  const registryPath = join(base, "opencode-forge", "jobs", "registry.json")
  assert.equal(existsSync(join(base, "opencode-forge")), false, "precondition: nothing exists yet")

  const registry = createJobRegistry(registryPath)
  let split
  assert.doesNotThrow(() => {
    split = registry.rescan(() => false)
  }, "the first rescan (the first lock of this host) succeeds")
  assert.deepEqual(split, { adopted: [], dead: [] })
  assert.equal(existsSync(registryPath), true, "the registry file was written")
  assert.deepEqual(readdirSync(join(base, "opencode-forge", "jobs")), ["registry.json"], "and the lock was released")
  assert.deepEqual(registry.list(), [], "reads back empty")
})

test("R2: the first job of a host process whose jobs directory does not exist yet runs", async (t) => {
  // plugin.ts keeps the lifecycle state at module level, so the FIRST job of
  // this process is the first-run case — this file owns its own process.
  const rt = mk("forge-firstrun-")
  const prev = process.env.FORGE_TEST_RUNTIME_DIR
  process.env.FORGE_TEST_RUNTIME_DIR = rt
  t.after(() => {
    if (prev === undefined) delete process.env.FORGE_TEST_RUNTIME_DIR
    else process.env.FORGE_TEST_RUNTIME_DIR = prev
  })
  assert.equal(existsSync(join(rt, "opencode-forge")), false, "precondition: a host with no runtime directory at all")

  const h = await server(
    { client: { session: {} }, project: { id: "p" }, directory: "/w", worktree: "/w", serverUrl: new URL("http://127.0.0.1:1"), $: () => {} },
    { jobs: { mode: "forge" } },
  )
  t.after(() => h.dispose?.())
  const ctx = { sessionID: "ses-firstrun", worktree: mk("forge-firstrun-wt-"), ask: async () => ({ status: "allow" }), metadata: () => {} }
  const res = await h.tool.forge_shell.execute({ command: `node -e "console.log('first-run-ok')"`, idle_ms: 8000, max_wait_ms: 20000 }, ctx)
  const text = String(res.output)
  assert.match(text, /first-run-ok/, "the very first job ran")
  assert.doesNotMatch(text, /ENOENT/, "no first-run ENOENT")
  assert.equal(res.title, "exit 0", `the finished form; got title: ${res.title}`)
  assert.equal(existsSync(join(rt, "opencode-forge", "jobs", "registry.json")), true, "the lifecycle init ran to its registry rescan")
})
