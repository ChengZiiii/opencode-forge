import test from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

// Direct-run parity: the suite preloads this (package.json "test"); importing
// it here keeps a bare `node --test tests/runtime-namespace.test.mjs` just as
// isolated.
import "./lib/test-runtime-namespace.mjs"

import { v2Setup, v2WiringSeam, __runtimeNamespaceTestSurface } from "../plugin.ts"
import { createV2MockContext } from "./lib/v2-mock-context.mjs"
import { modelsDevCacheDir } from "../src/models-dev.ts"

// fix-test-runtime-namespace-isolation (design D3). The plugin's runtime
// artifacts (models-dev cache and session-anchor ledger) live under
// `<os-tmp>/opencode-forge/` — the directory the REAL host plugin uses while
// a test suite runs. `<os-tmp>` is swapped by FORGE_TEST_RUNTIME_DIR, resolved
// at use time; FORGE_TEST_FORGE_HOME stays the HOME alias it always was (it
// moves the session-anchor ledger, and nothing else — as before).

const ns = __runtimeNamespaceTestSurface
const dirs = []
const mk = (prefix) => {
  const d = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(d)
  return d
}

test.after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

// Set (undefined = remove) the two redirect variables for the duration of a
// synchronous body, then restore exactly what was there.
const withEnv = (vars, body) => {
  const prev = {}
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = process.env[k]
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  try {
    return body()
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}
// Forward slashes, no trailing separator — the only normalization applied.
const slash = (p) => p.replace(/\\/g, "/").replace(/\/+$/, "")

const homes = () => ({
  tmp: ns.tmp() ?? null,
  root: slash(ns.root()),
  models: slash(ns.modelsDevCacheDir()),
  probe: slash(ns.probeTmp()),
  ledger: slash(ns.sessionAnchorLedgerPath()),
})

test("N1: `<os-tmp>` follows FORGE_TEST_RUNTIME_DIR at use time; FORGE_TEST_FORGE_HOME moves only the session-anchor ledger, as before", () => {
  const rt = mk("forge-ns-runtime-")
  const home = mk("forge-ns-home-")
  const tmp = slash(tmpdir())

  // (a) The redirect swaps the `<os-tmp>` level; the tree mirrors production
  //     (`<tmp>/opencode-forge/<artifact>`), only `<tmp>` moved.
  const a = withEnv({ FORGE_TEST_RUNTIME_DIR: rt, FORGE_TEST_FORGE_HOME: home }, homes)
  assert.deepEqual(a, {
    tmp: rt,
    root: `${slash(rt)}/opencode-forge`,
    models: `${slash(rt)}/opencode-forge/models-dev`,
    probe: slash(rt),
    ledger: `${slash(home)}/opencode-forge/session-anchors.jsonl`,
  })

  // (b) The HOME alias ALONE moves only the ledger — the behavior every
  //     existing test file was written against, unchanged.
  const b = withEnv({ FORGE_TEST_RUNTIME_DIR: undefined, FORGE_TEST_FORGE_HOME: home }, homes)
  assert.equal(b.tmp, null)
  assert.equal(b.models, `${tmp}/opencode-forge/models-dev`)
  assert.equal(b.probe, tmp)
  assert.equal(b.ledger, `${slash(home)}/opencode-forge/session-anchors.jsonl`)

  // (c) The redirect alone carries the ledger along (HOME unset).
  const c = withEnv({ FORGE_TEST_RUNTIME_DIR: rt, FORGE_TEST_FORGE_HOME: undefined }, homes)
  assert.equal(c.ledger, `${slash(rt)}/opencode-forge/session-anchors.jsonl`)

  // (d) Production: neither variable → each src helper's own default,
  //     byte-identical.
  const d = withEnv({ FORGE_TEST_RUNTIME_DIR: undefined, FORGE_TEST_FORGE_HOME: undefined }, homes)
  assert.deepEqual(d, {
    tmp: null,
    root: `${tmp}/opencode-forge`,
    models: `${tmp}/opencode-forge/models-dev`,
    probe: tmp,
    ledger: `${tmp}/opencode-forge/session-anchors.jsonl`,
  })
  assert.equal(d.models, slash(modelsDevCacheDir()), "identical to the src default the plugin used before")

  // Four different answers from one process in a row = use-time resolution.
  // (A module-load constant would have answered the same thing every time.)
  assert.equal(ns.tmp(), process.env.FORGE_TEST_RUNTIME_DIR, "restored to what the suite preload set")
})

// Run `body` with FORGE_TEST_RUNTIME_DIR = rt, restoring the variable after.
const withRuntimeDir = async (t, rt, body) => {
  const prev = process.env.FORGE_TEST_RUNTIME_DIR
  process.env.FORGE_TEST_RUNTIME_DIR = rt
  try {
    return await body()
  } finally {
    if (prev === undefined) delete process.env.FORGE_TEST_RUNTIME_DIR
    else process.env.FORGE_TEST_RUNTIME_DIR = prev
  }
}

const ROOT = fileURLToPath(new URL("..", import.meta.url))

test("N4: the preload itself redirects any process that loads it, honors an inherited redirect, and cleans up on exit", () => {
  const preload = pathToFileURL(join(ROOT, "tests", "lib", "test-runtime-namespace.mjs")).href
  const run = (extraEnv, code) => {
    const env = { ...process.env, ...extraEnv }
    if (env.FORGE_TEST_RUNTIME_DIR === undefined) delete env.FORGE_TEST_RUNTIME_DIR
    return spawnSync(process.execPath, ["--import", preload, "-e", code], { env, encoding: "utf8", windowsHide: true, timeout: 30_000 })
  }

  // No inherited redirect: the preload creates a private directory before any
  // user code runs…
  const fresh = run({ FORGE_TEST_RUNTIME_DIR: undefined }, "const d = process.env.FORGE_TEST_RUNTIME_DIR, root = process.env.FORGE_TEST_FIXTURE_ROOT, home = process.env.FORGE_TEST_FORGE_HOME; const exists = require('node:fs').existsSync; process.stdout.write(JSON.stringify({ d, root, home, owner: process.env.FORGE_TEST_FIXTURE_OWNER, pid: process.pid, exists: exists(d), rootExists: exists(root), homeExists: exists(home) }))")
  assert.equal(fresh.status, 0, fresh.stderr)
  const out = JSON.parse(fresh.stdout)
  assert.equal(typeof out.d, "string")
  assert.ok(out.d, "the variable is set before any user code runs")
  assert.equal(out.exists, true, "the directory exists by then")
  // The child owns a fresh fixture root below the parent's redirected temp.
  assert.equal(out.owner, String(out.pid), "the child owns its fixture root")
  assert.equal(out.rootExists, true)
  assert.equal(out.homeExists, true)
  assert.equal(dirname(resolve(out.root)), resolve(tmpdir()))
  assert.equal(dirname(resolve(out.d)), resolve(out.root), "runtime is inside the child fixture root")
  assert.equal(dirname(resolve(out.home)), resolve(out.root), "home is inside the child fixture root")
  // All owned namespaces are removed when the child exits.
  for (const path of [out.d, out.home, out.root]) assert.equal(existsSync(path), false, `removed on exit: ${path}`)

  // An inherited redirect is honored as-is and never removed by the preload.
  const rt = mk("forge-ns-inherited-")
  const inherited = run({ FORGE_TEST_RUNTIME_DIR: rt }, "process.stdout.write(process.env.FORGE_TEST_RUNTIME_DIR)")
  assert.equal(inherited.status, 0, inherited.stderr)
  assert.equal(inherited.stdout, rt)
  assert.equal(existsSync(rt), true, "the caller's directory survives")
})

test("N5: every canonical suite entry point goes through the preload", () => {
  const entry = "--import ./tests/lib/test-runtime-namespace.mjs --test tests/*.test.mjs"
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"))
  assert.ok(pkg.scripts.test.endsWith(entry), `package.json "test" is the isolated entry; got: ${pkg.scripts.test}`)

  // The acceptance gate measures the live unit suite itself — same preload,
  // or the gate's own run would write into the host's directories.
  const gate = readFileSync(join(ROOT, "reports", "e2e", "acceptance-gate.mjs"), "utf8")
  assert.ok(gate.includes('"--import", "./tests/lib/test-runtime-namespace.mjs"'), "the acceptance gate runs the live unit suite through the preload")

  for (const doc of ["README.md", "docs/dev-loop.md"]) {
    assert.ok(readFileSync(join(ROOT, doc), "utf8").includes(entry), `${doc} documents the isolated entry`)
  }
})

test("N6: v2 setup writes the models-dev snapshot inside the redirected namespace — exactly one `models-dev` level deep", async (t) => {
  const rt = mk("forge-ns-models-")
  const realSnapshot = join(modelsDevCacheDir(), "snapshot.json")
  const realBefore = existsSync(realSnapshot) ? statSync(realSnapshot).mtimeMs : null

  // No network: the hook's catalog fetch is answered here, with a catalog
  // only this test could have served.
  const realFetch = globalThis.fetch
  const noFetch = process.env.FORGE_TEST_NO_DISPATCH_FETCH
  process.env.FORGE_TEST_NO_DISPATCH_FETCH = "0"
  let calls = 0
  globalThis.fetch = async () => {
    calls += 1
    return { ok: true, text: async () => JSON.stringify({ "probe-ns": { models: { m1: {} } } }) }
  }
  t.after(() => {
    globalThis.fetch = realFetch
    if (noFetch === undefined) delete process.env.FORGE_TEST_NO_DISPATCH_FETCH
    else process.env.FORGE_TEST_NO_DISPATCH_FETCH = noFetch
  })

  // Everything that resolves a path is read INSIDE the redirect.
  let resolved = null
  await withRuntimeDir(t, rt, async () => {
    const { ctx } = createV2MockContext()
    const cleanup = await v2Setup(ctx, { anchors: [rt], materialize: "runtime" })
    resolved = ns.modelsDevCacheDir()
    cleanup?.()
    v2WiringSeam.resetHostAnchors()
  })

  assert.ok(calls >= 1, "the hook fetched the catalog")
  const cacheDir = join(rt, "opencode-forge", "models-dev")
  assert.equal(resolved, cacheDir, "the resolved cache dir is the redirected one")
  const file = join(cacheDir, "snapshot.json")
  assert.equal(existsSync(file), true, "the snapshot landed in the redirected namespace")
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).providers["probe-ns"].models.m1, {}, "and it is the catalog this test served")
  assert.equal(existsSync(join(cacheDir, "models-dev")), false, "exactly one models-dev level (no nesting)")
  const realAfter = existsSync(realSnapshot) ? statSync(realSnapshot).mtimeMs : null
  assert.equal(realAfter, realBefore, "the host's own snapshot was not rewritten")
})

// Legacy artifacts are fixture data, not inputs to the retired lifecycle.
test("N7: old runtime artifacts survive setup, session end and disposal untouched", async (t) => {
  const rt = mk("forge-ns-retired-")
  const root = join(rt, "opencode-forge")
  const files = [join(root, "jobs", "registry.json"), join(root, "watchdog", "log.jsonl"), join(rt, ".opencode", "forge", "dispatch-log.jsonl")]
  for (const file of files) {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, "sentinel: not a valid legacy record")
  }
  await withRuntimeDir(t, rt, async () => {
    const { ctx, state } = createV2MockContext()
    const cleanup = await v2Setup(ctx, { anchors: [rt], materialize: "runtime" })
    await state.emit("session.deleted", { sessionID: "ses-retired" })
    await new Promise(resolve => setImmediate(resolve))
    cleanup?.()
    v2WiringSeam.resetHostAnchors()
  })
  for (const file of files) {
    assert.equal(readFileSync(file, "utf8"), "sentinel: not a valid legacy record")
    assert.deepEqual(readdirSync(dirname(file)), [basename(file)])
  }
})
